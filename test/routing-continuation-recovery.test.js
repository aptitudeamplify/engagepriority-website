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
      lead_id: "L-1",
      lifecycle_identity: { lifecycle_id: "L-1", policy_snapshot_id: "ps-1" },
      assignment_identity: { lifecycle_id: "L-1", policy_snapshot_id: "ps-1", assignment_id: "as-1", assignment_sequence: 1, owner_epoch_id: "oe-1", agent_id_snapshot: "A-1" },
      assignment_result: { assigned_agent_id: "A-1", routing_pointer_before: 0, routing_pointer_after: 1, cycle_length: 1, cycle_preview: ["A-1"], active_agents_count: 1 },
      plan: { trace_id: "T-1", created_ts_utc: "2026-10-07T12:00:00.000Z", reminder_due_ts_utc: "2026-10-07T12:15:00.000Z", lifecycle_event_id: "EV-1", gateway_id: "GW-1" }
    }
  };
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
