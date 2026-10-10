const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CONTRACTS,
  DECISION_TYPES,
  buildSemanticRequest
} = require("../netlify/functions/_shared/routing-coordination-contract");
const {
  STEP_STATUS,
  reconcileCreateStep,
  reconcileMutationStep,
  runAtMostOnceDispatch
} = require("../netlify/functions/_shared/routing-continuation");
const {
  isCompletedConsequence,
  isSmsDownstreamAuthorized
} = require("../netlify/functions/_shared/routing-coordination");

function storeWith(record) {
  let version = 1;
  let current = structuredClone(record);
  return {
    async read() { return { record: structuredClone(current), etag: String(version) }; },
    async replace(key, next, etag) {
      if (etag !== String(version)) return { replaced: false, record: structuredClone(current), etag: String(version) };
      current = structuredClone(next);
      version += 1;
      return { replaced: true, record: structuredClone(current), etag: String(version) };
    },
    value() { return structuredClone(current); },
    forceCasLoss() { version += 1; }
  };
}

function acceptedRecord(kind = DECISION_TYPES.INITIAL_INTAKE) {
  return {
    schema_version: 2,
    phase: "ACCEPTED",
    consequence_state: {},
    continuation: {
      operation_kind: kind,
      client_id: "C-1",
      lead_id: "L-1",
      lifecycle_identity: { lifecycle_id: "L-1", policy_snapshot_id: "ps-1" },
      assignment_identity: { lifecycle_id: "L-1", policy_snapshot_id: "ps-1", assignment_id: "as-1", assignment_sequence: 1, owner_epoch_id: "oe-1", agent_id_snapshot: "A-1" },
      assignment_result: { assigned_agent_id: "A-1", routing_pointer_before: 0, routing_pointer_after: 1, cycle_length: 1, cycle_preview: ["A-1"], active_agents_count: 1 },
      plan: { trace_id: "T-1", created_ts_utc: "2026-10-07T12:00:00.000Z", reminder_due_ts_utc: "2026-10-07T12:15:00.000Z", lifecycle_event_id: "EV-1", gateway_id: "GW-1" }
    }
  };
}

function dispatchState(status, evidence) {
  return { status, evidence, updated_ts_utc: "2026-10-07T12:00:00.000Z" };
}

function definitiveSmsPending(record) {
  record.consequence_state.SMS = dispatchState(STEP_STATUS.PENDING, {
    reason: "DEFINITIVE_NO_ACCEPTANCE",
    error_code: "HTTP_503"
  });
  return record;
}

test("unknown top-level semantic input is rejected instead of ignored", () => {
  const input = {
    environment: "TEST",
    decision_type: DECISION_TYPES.INITIAL_INTAKE,
    client_id: "C-1",
    logical_reference: { logical_reference_contract: CONTRACTS.initialIntake, client_id: "C-1", source_system: "WEBSITE", source_path: "website-lead-form-v1", source_event_id: "evt-1" },
    expected_state: { routing_state_version: 1, routing_pointer: 0, routing_state_fingerprint: `sha256:${"a".repeat(64)}` },
    proposal: { selected_agent_id: "A-1", routing_pointer_after: 1, total_assignments_today_after: 1, notes_after: "" },
    semantic_evidence: {},
    ignored_extra: true
  };
  assert.throws(() => buildSemanticRequest(input), /unknown or missing keys/i);
});

for (const step of ["LEAD_LOG", "LEAD_INDEX", "REMINDER", "ACTION_LINK", "IDEMPOTENCY"]) {
  test(`intake crash after ${step} write resumes without a duplicate`, async () => {
    const store = storeWith(acceptedRecord());
    const targets = new Map();
    let creates = 0;
    const options = {
      store,
      key: "operation",
      validate() {},
      step,
      inspect: async () => targets.has(step) ? { state: "EXACT", evidence: targets.get(step) } : { state: "ABSENT" },
      create: async () => { creates += 1; targets.set(step, { lead_id: "L-1", assignment_id: "as-1", gateway_id: "GW-1" }); },
      afterCreate: async () => { throw new Error("simulated process death"); }
    };
    await assert.rejects(() => reconcileCreateStep(options), /process death/);
    await reconcileCreateStep({ ...options, afterCreate: null });
    assert.equal(creates, 1);
    assert.equal(store.value().consequence_state[step].status, STEP_STATUS.COMPLETED);
    assert.equal(store.value().continuation.assignment_identity.assignment_id, "as-1");
    assert.equal(store.value().continuation.plan.gateway_id, "GW-1");
  });
}

test("provider ambiguity is durable and never auto-redispatches", async () => {
  const store = storeWith(acceptedRecord());
  let dispatches = 0;
  const first = await runAtMostOnceDispatch({
    store,
    key: "operation",
    validate() {},
    step: "SMS",
    dispatch: async () => { dispatches += 1; throw Object.assign(new Error("transport lost"), { code: "ETIMEDOUT" }); },
    disabled: false
  });
  const retry = await runAtMostOnceDispatch({
    store,
    key: "operation",
    validate() {},
    step: "SMS",
    dispatch: async () => { dispatches += 1; return { sent: true }; },
    disabled: false
  });
  assert.equal(first.status, "AMBIGUOUS");
  assert.equal(retry.status, "AMBIGUOUS");
  assert.equal(dispatches, 1);
  assert.equal(store.value().consequence_state.SMS.status, STEP_STATUS.AMBIGUOUS);
});

test("release provider ambiguity remains manual-reconciliation state on retry", async () => {
  const record = acceptedRecord(DECISION_TYPES.AFTER_HOURS_RELEASE);
  record.continuation.release_id = "REL-1";
  const store = storeWith(record);
  let dispatches = 0;
  const invoke = () => runAtMostOnceDispatch({
    store,
    key: "operation",
    validate() {},
    step: "SMS",
    dispatch: async () => { dispatches += 1; throw new Error("ambiguous provider result"); },
    disabled: false
  });
  assert.equal((await invoke()).status, "AMBIGUOUS");
  assert.equal((await invoke()).status, "AMBIGUOUS");
  assert.equal(dispatches, 1);
});

test("definitive downstream rejection remains retryable while ambiguous transport does not", async () => {
  const store = storeWith(acceptedRecord());
  let dispatches = 0;
  const first = await runAtMostOnceDispatch({
    store,
    key: "operation",
    validate() {},
    step: "LEGACY_PROJECTION",
    dispatch: async () => {
      dispatches += 1;
      const error = Object.assign(new Error("HTTP 503"), { code: "HTTP_503", safeToRetry: true, result: { repair_required: true } });
      throw error;
    },
    disabled: false
  });
  const second = await runAtMostOnceDispatch({
    store,
    key: "operation",
    validate() {},
    step: "LEGACY_PROJECTION",
    dispatch: async () => { dispatches += 1; return { status: "SUBMITTED" }; },
    evidenceFromResult: result => ({ status: result.status }),
    disabled: false
  });
  assert.equal(first.status, "RETRYABLE_FAILURE");
  assert.equal(second.status, "COMPLETED");
  assert.equal(dispatches, 2);
});

for (const step of ["LEAD_LOG", "ACTION_LINK", "REMINDER", "RELEASE_QUEUE", "LIFECYCLE_EVENT"]) {
  test(`release ${step} partial state reconciles without repeating the consequence`, async () => {
    const record = acceptedRecord(DECISION_TYPES.AFTER_HOURS_RELEASE);
    record.continuation.release_id = "REL-1";
    const store = storeWith(record);
    let state = "NEEDS_APPLY";
    let applies = 0;
    const mutation = step === "LEAD_LOG" || step === "RELEASE_QUEUE";
    const common = { store, key: "operation", validate() {}, step };
    if (mutation) {
      await assert.rejects(() => reconcileMutationStep({
        ...common,
        inspect: async () => ({ state }),
        apply: async () => { applies += 1; state = "EXACT"; },
        afterApply: async () => { throw new Error("simulated process death"); }
      }));
      await reconcileMutationStep({ ...common, inspect: async () => ({ state }), apply: async () => { applies += 1; } });
    } else {
      state = "ABSENT";
      await assert.rejects(() => reconcileCreateStep({
        ...common,
        inspect: async () => ({ state }),
        create: async () => { applies += 1; state = "EXACT"; },
        afterCreate: async () => { throw new Error("simulated process death"); }
      }));
      await reconcileCreateStep({ ...common, inspect: async () => ({ state }), create: async () => { applies += 1; } });
    }
    assert.equal(applies, 1);
    assert.equal(store.value().consequence_state[step].status, STEP_STATUS.COMPLETED);
  });
}

test("explicit CAS loss rereads the durable winner instead of overwriting it", async () => {
  const store = storeWith(acceptedRecord());
  const originalReplace = store.replace.bind(store);
  let first = true;
  store.replace = async (...args) => {
    if (first) {
      first = false;
      store.forceCasLoss();
      return { replaced: false, ...(await store.read(args[0])) };
    }
    return originalReplace(...args);
  };
  let target = false;
  await reconcileCreateStep({
    store,
    key: "operation",
    validate() {},
    step: "LEAD_LOG",
    inspect: async () => target ? { state: "EXACT" } : { state: "ABSENT" },
    create: async () => { target = true; }
  });
  assert.equal(store.value().consequence_state.LEAD_LOG.status, STEP_STATUS.COMPLETED);
});

test("two independent create continuations have one durable owner and one create", async () => {
  const store = storeWith(acceptedRecord());
  let target = false;
  let creates = 0;
  let inspected = 0;
  let releaseInitialInspections;
  const initialInspections = new Promise(resolve => { releaseInitialInspections = resolve; });
  const inspect = async () => {
    inspected += 1;
    if (inspected === 2) releaseInitialInspections();
    if (inspected <= 2) await initialInspections;
    return target ? { state: "EXACT", evidence: { lead_id: "L-1", row_number: 2 } } : { state: "ABSENT" };
  };
  const run = claimId => reconcileCreateStep({
    store,
    key: "operation",
    validate() {},
    step: "LEAD_LOG",
    inspect,
    claimId,
    create: async () => { creates += 1; target = true; }
  });
  const results = await Promise.allSettled([run("claim-a"), run("claim-b")]);
  assert.equal(creates, 1);
  assert.equal(results.filter(result => result.status === "fulfilled").length >= 1, true);
  assert.equal(store.value().consequence_state.LEAD_LOG.status, STEP_STATUS.COMPLETED);
  assert.equal(store.value().consequence_state.LEAD_LOG.evidence.lead_id, "L-1");
});

for (const [kind, steps] of [
  ["intake", ["LEAD_INDEX", "REMINDER", "ACTION_LINK", "IDEMPOTENCY"]],
  ["release", ["ACTION_LINK", "REMINDER", "LIFECYCLE_EVENT"]]
]) {
  test(`simultaneous ${kind} continuation creates one consequence per step`, async () => {
    for (const step of steps) {
      const record = acceptedRecord(kind === "release" ? DECISION_TYPES.AFTER_HOURS_RELEASE : DECISION_TYPES.INITIAL_INTAKE);
      if (kind === "release") record.continuation.release_id = "REL-1";
      const store = storeWith(record);
      let target = false;
      let creates = 0;
      let firstInspections = 0;
      let release;
      const barrier = new Promise(resolve => { release = resolve; });
      const inspect = async () => {
        firstInspections += 1;
        if (firstInspections === 2) release();
        if (firstInspections <= 2) await barrier;
        return target ? { state: "EXACT", evidence: { target: step } } : { state: "ABSENT" };
      };
      const run = claimId => reconcileCreateStep({
        store, key: "operation", validate() {}, step, inspect, claimId,
        create: async () => { creates += 1; target = true; }
      });
      await Promise.allSettled([run(`${step}-a`), run(`${step}-b`)]);
      assert.equal(creates, 1, step);
      assert.equal(store.value().consequence_state[step].status, STEP_STATUS.COMPLETED, step);
    }
  });
}

test("CAS loser observes the durable winner and never creates", async () => {
  const store = storeWith(acceptedRecord());
  let target = false;
  let creates = 0;
  const first = reconcileCreateStep({
    store, key: "operation", validate() {}, step: "LEAD_LOG", claimId: "winner",
    inspect: async () => target ? { state: "EXACT", evidence: { lead_id: "L-1", row_number: 2 } } : { state: "ABSENT" },
    create: async () => { creates += 1; target = true; }
  });
  await first;
  await reconcileCreateStep({
    store, key: "operation", validate() {}, step: "LEAD_LOG", claimId: "loser",
    inspect: async () => ({ state: "EXACT", evidence: { lead_id: "L-1", row_number: 2 } }),
    create: async () => { creates += 1; }
  });
  assert.equal(creates, 1);
});

test("abandoned create ownership recovers exact target but never takes over an absent target", async () => {
  const record = acceptedRecord();
  record.consequence_state.LEAD_LOG = {
    status: STEP_STATUS.CREATING,
    evidence: { claim_id: "abandoned" },
    updated_ts_utc: "2026-10-07T12:00:00.000Z"
  };
  const exactStore = storeWith(record);
  let creates = 0;
  await reconcileCreateStep({
    store: exactStore, key: "operation", validate() {}, step: "LEAD_LOG",
    inspect: async () => ({ state: "EXACT", evidence: { lead_id: "L-1", row_number: 2 } }),
    create: async () => { creates += 1; }
  });
  assert.equal(exactStore.value().consequence_state.LEAD_LOG.status, STEP_STATUS.COMPLETED);

  const absentStore = storeWith(record);
  await assert.rejects(() => reconcileCreateStep({
    store: absentStore, key: "operation", validate() {}, step: "LEAD_LOG",
    inspect: async () => ({ state: "ABSENT" }),
    create: async () => { creates += 1; }
  }), /ownership is unresolved/i);
  assert.equal(creates, 0);
  assert.equal(absentStore.value().consequence_state.LEAD_LOG.status, STEP_STATUS.CREATING);
});

test("abandoned create ownership with a conflicting target fails closed", async () => {
  const record = acceptedRecord();
  record.consequence_state.ACTION_LINK = {
    status: STEP_STATUS.CREATING,
    evidence: { claim_id: "abandoned" },
    updated_ts_utc: "2026-10-07T12:00:00.000Z"
  };
  let creates = 0;
  await assert.rejects(() => reconcileCreateStep({
    store: storeWith(record), key: "operation", validate() {}, step: "ACTION_LINK",
    inspect: async () => ({ state: "CONFLICT" }),
    create: async () => { creates += 1; }
  }), /conflicting/i);
  assert.equal(creates, 0);
});

function delayOneCas(store, matches) {
  const originalReplace = store.replace.bind(store);
  let release;
  let signal;
  let delayed = false;
  const reached = new Promise(resolve => { signal = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  store.replace = async (...args) => {
    if (!delayed && matches(args[1])) {
      delayed = true;
      signal();
      await gate;
    }
    return originalReplace(...args);
  };
  return { reached, release };
}

test("intake projection and SMS retry serialize on one durable CAS when projection wins", async () => {
  const store = storeWith(definitiveSmsPending(acceptedRecord()));
  const delayedSms = delayOneCas(store, next => next.consequence_state.SMS?.status === STEP_STATUS.DISPATCHING);
  let smsDispatches = 0;
  let projectionDispatches = 0;
  const sms = runAtMostOnceDispatch({
    store, key: "operation", validate() {}, step: "SMS", disabled: false,
    dispatch: async () => { smsDispatches += 1; return { sent: true, sid: "SM-1" }; }
  });
  await delayedSms.reached;
  const projection = await runAtMostOnceDispatch({
    store, key: "operation", validate() {}, step: "LEGACY_PROJECTION", disabled: false,
    establishGuard: isSmsDownstreamAuthorized,
    dispatch: async () => { projectionDispatches += 1; return { status: "LEGACY_MAKE_SUBMITTED" }; },
    evidenceFromResult: result => ({ status: result.status })
  });
  delayedSms.release();
  const smsResult = await sms;
  assert.equal(projection.status, "COMPLETED");
  assert.equal(smsResult.status, "COMPLETED");
  assert.equal(projectionDispatches, 1);
  assert.equal(smsDispatches, 1);
  assert.equal(store.value().consequence_state.LEGACY_PROJECTION.status, STEP_STATUS.COMPLETED);
  assert.equal(store.value().consequence_state.SMS.evidence.provider_message_id, "SM-1");
});

test("intake projection loses to SMS retry, rereads, and performs no external dispatch", async () => {
  const store = storeWith(definitiveSmsPending(acceptedRecord()));
  const delayedProjection = delayOneCas(store, next => next.consequence_state.LEGACY_PROJECTION?.status === STEP_STATUS.DISPATCHING);
  let smsDispatches = 0;
  let projectionDispatches = 0;
  const projection = runAtMostOnceDispatch({
    store, key: "operation", validate() {}, step: "LEGACY_PROJECTION", disabled: false,
    establishGuard: isSmsDownstreamAuthorized,
    dispatch: async () => { projectionDispatches += 1; return { status: "LEGACY_MAKE_SUBMITTED" }; }
  });
  await delayedProjection.reached;
  let releaseSmsDispatch;
  let signalSmsDispatch;
  const smsDispatchReached = new Promise(resolve => { signalSmsDispatch = resolve; });
  const smsDispatchGate = new Promise(resolve => { releaseSmsDispatch = resolve; });
  const smsPromise = runAtMostOnceDispatch({
    store, key: "operation", validate() {}, step: "SMS", disabled: false,
    dispatch: async () => { smsDispatches += 1; signalSmsDispatch(); await smsDispatchGate; return { sent: true, sid: "SM-2" }; }
  });
  await smsDispatchReached;
  delayedProjection.release();
  const projectionResult = await projection;
  assert.equal(projectionResult.status, "PREREQUISITE_BLOCKED");
  releaseSmsDispatch();
  const sms = await smsPromise;
  assert.equal(sms.status, "COMPLETED");
  assert.equal(smsDispatches, 1);
  assert.equal(projectionDispatches, 0);
  assert.equal(store.value().consequence_state.LEGACY_PROJECTION, undefined);
});

test("release SMS retry is blocked until ReleaseQueue completion is durable", async () => {
  const record = definitiveSmsPending(acceptedRecord(DECISION_TYPES.AFTER_HOURS_RELEASE));
  record.continuation.release_id = "REL-1";
  const store = storeWith(record);
  let dispatches = 0;
  const run = () => runAtMostOnceDispatch({
    store, key: "operation", validate() {}, step: "SMS", disabled: false,
    retryGuard: current => isCompletedConsequence(current, "RELEASE_QUEUE"),
    dispatch: async () => { dispatches += 1; return { sent: true, sid: "SM-R" }; }
  });
  assert.equal((await run()).status, "PREREQUISITE_BLOCKED");
  assert.equal(dispatches, 0);
  await reconcileMutationStep({
    store, key: "operation", validate() {}, step: "RELEASE_QUEUE",
    inspect: async () => ({ state: "EXACT", evidence: { release_id: "REL-1" } }),
    apply: async () => { throw new Error("must reuse exact target"); }
  });
  assert.equal((await run()).status, "COMPLETED");
  assert.equal(dispatches, 1);
  assert.equal(store.value().consequence_state.SMS.evidence.provider_message_id, "SM-R");
});

test("competing ReleaseQueue progression wins before an SMS retry can dispatch", async () => {
  const record = definitiveSmsPending(acceptedRecord(DECISION_TYPES.AFTER_HOURS_RELEASE));
  record.continuation.release_id = "REL-1";
  const store = storeWith(record);
  let externalCommitted = false;
  let releaseApply;
  let signalApply;
  const applyReached = new Promise(resolve => { signalApply = resolve; });
  const applyGate = new Promise(resolve => { releaseApply = resolve; });
  const queue = reconcileMutationStep({
    store, key: "operation", validate() {}, step: "RELEASE_QUEUE",
    authorizeBeforeApply: isSmsDownstreamAuthorized,
    inspect: async () => externalCommitted
      ? { state: "EXACT", evidence: { release_id: "REL-1" } }
      : { state: "NEEDS_APPLY" },
    apply: async () => { externalCommitted = true; signalApply(); await applyGate; }
  });
  await applyReached;
  let dispatches = 0;
  const blocked = await runAtMostOnceDispatch({
    store, key: "operation", validate() {}, step: "SMS", disabled: false,
    retryGuard: current => isCompletedConsequence(current, "RELEASE_QUEUE"),
    dispatch: async () => { dispatches += 1; return { sent: true }; }
  });
  assert.equal(blocked.status, "PREREQUISITE_BLOCKED");
  assert.equal(dispatches, 0);
  releaseApply();
  await queue;
  assert.equal(store.value().consequence_state.RELEASE_QUEUE.status, STEP_STATUS.COMPLETED);
});

test("ReleaseQueue external-commit crash blocks SMS retry until exact-state reconciliation", async () => {
  const record = definitiveSmsPending(acceptedRecord(DECISION_TYPES.AFTER_HOURS_RELEASE));
  record.continuation.release_id = "REL-1";
  const store = storeWith(record);
  let externalCommitted = false;
  let applies = 0;
  const options = {
    store, key: "operation", validate() {}, step: "RELEASE_QUEUE",
    authorizeBeforeApply: isSmsDownstreamAuthorized,
    inspect: async () => externalCommitted
      ? { state: "EXACT", evidence: { release_id: "REL-1" } }
      : { state: "NEEDS_APPLY" },
    apply: async () => { applies += 1; externalCommitted = true; }
  };
  await assert.rejects(() => reconcileMutationStep({ ...options, afterApply: async () => { throw new Error("crash"); } }), /crash/);
  let dispatches = 0;
  const retry = () => runAtMostOnceDispatch({
    store, key: "operation", validate() {}, step: "SMS", disabled: false,
    retryGuard: current => isCompletedConsequence(current, "RELEASE_QUEUE"),
    dispatch: async () => { dispatches += 1; return { sent: true, sid: "SM-AFTER" }; }
  });
  assert.equal((await retry()).status, "PREREQUISITE_BLOCKED");
  await reconcileMutationStep(options);
  assert.equal(applies, 1);
  assert.equal((await retry()).status, "COMPLETED");
  assert.equal(dispatches, 1);
});

for (const status of [STEP_STATUS.DISPATCHING, STEP_STATUS.AMBIGUOUS, STEP_STATUS.MANUAL_RECONCILIATION]) {
  test(`lifecycle recovery remains eligible with retry-lineage SMS ${status}`, async () => {
    const record = acceptedRecord(DECISION_TYPES.AFTER_HOURS_RELEASE);
    record.continuation.release_id = "REL-1";
    record.consequence_state.SMS = dispatchState(status, status === STEP_STATUS.DISPATCHING
      ? { dispatch_started: true, retry_provenance: "DEFINITIVE_NO_ACCEPTANCE" }
      : { reason: "UNKNOWN", retry_provenance: "DEFINITIVE_NO_ACCEPTANCE" });
    record.consequence_state.RELEASE_QUEUE = dispatchState(STEP_STATUS.COMPLETED, { release_id: "REL-1" });
    const store = storeWith(record);
    let lifecycleExists = false;
    let creates = 0;
    await reconcileCreateStep({
      store, key: "operation", validate() {}, step: "LIFECYCLE_EVENT",
      inspect: async () => lifecycleExists
        ? { state: "EXACT", evidence: { event_id: "EV-1", lead_id: "L-1", row_number: 2 } }
        : { state: "ABSENT" },
      create: async () => { creates += 1; lifecycleExists = true; }
    });
    await reconcileCreateStep({
      store, key: "operation", validate() {}, step: "LIFECYCLE_EVENT",
      inspect: async () => ({ state: "EXACT", evidence: { event_id: "EV-1", lead_id: "L-1", row_number: 2 } }),
      create: async () => { creates += 1; }
    });
    assert.equal(creates, 1);
    assert.equal(store.value().consequence_state.LIFECYCLE_EVENT.status, STEP_STATUS.COMPLETED);
  });
}
