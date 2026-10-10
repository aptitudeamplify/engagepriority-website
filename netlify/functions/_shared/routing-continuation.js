const { randomUUID } = require("crypto");

const STEP_STATUS = Object.freeze({
  PENDING: "PENDING",
  CREATING: "CREATING",
  COMPLETED: "COMPLETED",
  DISPATCHING: "DISPATCHING",
  AMBIGUOUS: "AMBIGUOUS",
  MANUAL_RECONCILIATION: "MANUAL_RECONCILIATION"
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stepState(record, step) {
  return record.consequence_state?.[step] || { status: STEP_STATUS.PENDING };
}

async function casMutate({ store, key, validate, mutate, maxAttempts = 8 }) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const stored = await store.read(key);
    if (!stored) throw new Error("Routing coordination obligation disappeared.");
    validate(stored.record, key);
    const next = mutate(clone(stored.record));
    if (!next) return { record: stored.record, etag: stored.etag, changed: false };
    const replaced = await store.replace(key, next, stored.etag);
    if (replaced.replaced) return { record: replaced.record, etag: replaced.etag, changed: true };
    // CAS loss is never overwritten. Loop and reconcile the durable winner.
  }
  throw new Error("Routing continuation CAS reconciliation budget exhausted.");
}

async function setStepState({ store, key, validate, step, status, evidence = {}, now = () => new Date().toISOString() }) {
  return casMutate({
    store,
    key,
    validate,
    mutate(record) {
      const current = stepState(record, step);
      if (current.status === STEP_STATUS.COMPLETED && status !== STEP_STATUS.COMPLETED) {
        throw new Error(`Completed routing continuation step cannot regress: ${step}`);
      }
      record.consequence_state = record.consequence_state || {};
      record.consequence_state[step] = { status, evidence, updated_ts_utc: now() };
      record.updated_ts_utc = now();
      return record;
    }
  });
}

async function reconcileCreateStep({
  store,
  key,
  validate,
  step,
  inspect,
  create,
  exactEvidence = value => value?.evidence || {},
  afterCreate,
  now,
  claimId = randomUUID()
}) {
  let stored = await store.read(key);
  if (!stored) throw new Error("Routing coordination obligation disappeared.");
  validate(stored.record, key);
  let observed = await inspect();
  if (observed.state === "CONFLICT") throw new Error(`Conflicting continuation target: ${step}`);
  if (observed.state === "EXACT") {
    await setStepState({ store, key, validate, step, status: STEP_STATUS.COMPLETED, evidence: exactEvidence(observed), now });
    return observed;
  }

  const current = stepState(stored.record, step);
  if (current.status === STEP_STATUS.COMPLETED) {
    throw new Error(`Completed continuation target no longer matches: ${step}`);
  }
  if (current.status === STEP_STATUS.CREATING) {
    throw new Error(`Routing continuation create ownership is unresolved: ${step}`);
  }
  if (current.status !== STEP_STATUS.PENDING) {
    throw new Error(`Routing continuation create step is not eligible: ${step}`);
  }

  const claim = await casMutate({
    store,
    key,
    validate,
    mutate(record) {
      const winner = stepState(record, step);
      if (winner.status !== STEP_STATUS.PENDING) return null;
      record.consequence_state = record.consequence_state || {};
      const timestamp = (now || (() => new Date().toISOString()))();
      record.consequence_state[step] = {
        status: STEP_STATUS.CREATING,
        evidence: { claim_id: claimId },
        updated_ts_utc: timestamp
      };
      record.updated_ts_utc = timestamp;
      return record;
    }
  });
  const winner = stepState(claim.record, step);
  if (!claim.changed || winner.status !== STEP_STATUS.CREATING || winner.evidence?.claim_id !== claimId) {
    observed = await inspect();
    if (observed.state === "EXACT") {
      await setStepState({ store, key, validate, step, status: STEP_STATUS.COMPLETED, evidence: exactEvidence(observed), now });
      return observed;
    }
    if (observed.state === "CONFLICT") throw new Error(`Conflicting continuation target: ${step}`);
    throw new Error(`Routing continuation create ownership is unresolved: ${step}`);
  }

  // Re-read immediately before the non-idempotent create. A caller may create
  // only while its exact durable claim remains authoritative.
  stored = await store.read(key);
  if (!stored) throw new Error("Routing coordination obligation disappeared.");
  validate(stored.record, key);
  const durableClaim = stepState(stored.record, step);
  if (durableClaim.status !== STEP_STATUS.CREATING || durableClaim.evidence?.claim_id !== claimId) {
    throw new Error(`Routing continuation create ownership was lost: ${step}`);
  }

  await create();
  if (afterCreate) await afterCreate(step);
  observed = await inspect();
  if (observed.state === "CONFLICT") throw new Error(`Conflicting continuation target: ${step}`);
  if (observed.state !== "EXACT") throw new Error(`Continuation target was not durably established: ${step}`);
  await setStepState({ store, key, validate, step, status: STEP_STATUS.COMPLETED, evidence: exactEvidence(observed), now });
  return observed;
}

async function reconcileMutationStep({ store, key, validate, step, inspect, apply, afterApply, now }) {
  const stored = await store.read(key);
  if (!stored) throw new Error("Routing coordination obligation disappeared.");
  validate(stored.record, key);
  let observed = await inspect();
  if (observed.state === "CONFLICT") throw new Error(`Conflicting continuation target: ${step}`);
  if (observed.state === "NEEDS_APPLY") {
    await apply();
    if (afterApply) await afterApply(step);
    observed = await inspect();
  }
  if (observed.state !== "EXACT") throw new Error(`Continuation target was not durably established: ${step}`);
  await setStepState({ store, key, validate, step, status: STEP_STATUS.COMPLETED, evidence: observed.evidence || {}, now });
  return observed;
}

function inspectUniqueRows(rows, { match, exact, evidence }) {
  const matches = rows.filter(match);
  if (matches.length === 0) return { state: "ABSENT" };
  if (matches.length !== 1 || !exact(matches[0])) return { state: "CONFLICT" };
  return { state: "EXACT", row: matches[0], evidence: evidence ? evidence(matches[0]) : {} };
}

async function runAtMostOnceDispatch({
  store,
  key,
  validate,
  step,
  dispatch,
  evidenceFromResult,
  disabled,
  now
}) {
  let stored = await store.read(key);
  if (!stored) throw new Error("Routing coordination obligation disappeared.");
  validate(stored.record, key);
  let current = stepState(stored.record, step);
  if (current.status === STEP_STATUS.COMPLETED) return { status: "COMPLETED", evidence: current.evidence || {} };
  if (current.status === STEP_STATUS.DISPATCHING || current.status === STEP_STATUS.AMBIGUOUS || current.status === STEP_STATUS.MANUAL_RECONCILIATION) {
    if (current.status === STEP_STATUS.DISPATCHING) {
      await setStepState({ store, key, validate, step, status: STEP_STATUS.AMBIGUOUS, evidence: { reason: "DISPATCH_OUTCOME_UNKNOWN" }, now });
    }
    return { status: "AMBIGUOUS", evidence: current.evidence || {} };
  }
  if (disabled) {
    await setStepState({ store, key, validate, step, status: STEP_STATUS.COMPLETED, evidence: { dispatched: false, reason: "DISABLED" }, now });
    return { status: "COMPLETED", evidence: { dispatched: false, reason: "DISABLED" } };
  }

  const claim = await casMutate({
    store,
    key,
    validate,
    mutate(record) {
      const winner = stepState(record, step);
      if (winner.status !== STEP_STATUS.PENDING) return null;
      record.consequence_state = record.consequence_state || {};
      record.consequence_state[step] = {
        status: STEP_STATUS.DISPATCHING,
        evidence: { dispatch_started: true },
        updated_ts_utc: (now || (() => new Date().toISOString()))()
      };
      return record;
    }
  });
  current = stepState(claim.record, step);
  if (!claim.changed || current.status !== STEP_STATUS.DISPATCHING) {
    return runAtMostOnceDispatch({ store, key, validate, step, dispatch, evidenceFromResult, disabled, now });
  }

  try {
    const result = await dispatch();
    const evidence = evidenceFromResult ? evidenceFromResult(result) : {
      dispatched: Boolean(result?.sent),
      provider_message_id: String(result?.sid || ""),
      provider_status: result?.sent ? "SUBMITTED" : String(result?.reason || "NOT_SENT")
    };
    await setStepState({ store, key, validate, step, status: STEP_STATUS.COMPLETED, evidence, now });
    return { status: "COMPLETED", evidence, result };
  } catch (error) {
    if (error?.safeToRetry === true) {
      const evidence = { reason: "DEFINITIVE_NO_ACCEPTANCE", error_code: String(error.code || "DISPATCH_REJECTED") };
      await setStepState({ store, key, validate, step, status: STEP_STATUS.PENDING, evidence, now });
      return { status: "RETRYABLE_FAILURE", evidence, result: error.result };
    }
    const evidence = { reason: "PROVIDER_RESULT_AMBIGUOUS", error_code: String(error?.code || "PROVIDER_ERROR") };
    await setStepState({ store, key, validate, step, status: STEP_STATUS.AMBIGUOUS, evidence, now });
    return { status: "AMBIGUOUS", evidence };
  }
}

module.exports = {
  STEP_STATUS,
  casMutate,
  inspectUniqueRows,
  reconcileCreateStep,
  reconcileMutationStep,
  runAtMostOnceDispatch,
  setStepState,
  stepState
};
