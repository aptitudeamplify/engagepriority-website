const { createHash } = require("crypto");
const {
  DECISION_TYPES,
  canonicalJson,
  normalizeTimestamp,
  validateSemanticRequest
} = require("./routing-coordination-contract");

const ACCEPTED = new Set(["COMMITTED", "ALREADY_COMMITTED"]);
const SAME_REQUEST_RETRY = new Set([
  "ROUTING_LOCK_TIMEOUT",
  "ROUTING_BUSY_REASSIGNMENT_RECOVERY"
]);

function isSameRequestRetry(response) {
  return SAME_REQUEST_RETRY.has(response.result_status) || response.result_payload?.retryable === true;
}

function assertAcceptedResult(response, request) {
  const payload = response.result_payload;
  if (!payload ||
      payload.routing_commit_id !== request.routing_commit_id ||
      payload.client_id !== request.client_id ||
      payload.selected_agent_id !== request.proposal.selected_agent_id ||
      payload.committed_routing_state_version !== request.expected_state.routing_state_version + 1 ||
      payload.committed_routing_pointer !== request.proposal.routing_pointer_after ||
      !/^sha256:[0-9a-f]{64}$/.test(String(payload.committed_routing_state_fingerprint || "")) ||
      typeof payload.committed_ts_utc !== "string") {
    throw new Error("Routing coordinator accepted-result payload does not match the submitted transition.");
  }
  normalizeTimestamp(payload.committed_ts_utc, "committed_ts_utc");
}

function routingOperationKey(environment, logicalReference) {
  return `routing-operation-${createHash("sha256").update(canonicalJson({ environment, logical_reference: logicalReference })).digest("hex")}`;
}

function routingCoordinationMode(env = process.env) {
  const mode = String(env.EP_ROUTING_STATE_MODE || "LEGACY_DIRECT").trim().toUpperCase();
  if (!new Set(["LEGACY_DIRECT", "GAS_COORDINATED"]).has(mode)) {
    throw new Error(`Unknown EP_ROUTING_STATE_MODE: ${mode || "BLANK"}`);
  }
  return mode;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function assertAttempt(attempt) {
  if (!attempt || !attempt.request || !attempt.continuation) throw new Error("Routing coordination attempt is incomplete.");
  return attempt;
}

const VALID_STEP_STATUS = new Set(["PENDING", "CREATING", "COMPLETED", "DISPATCHING", "AMBIGUOUS", "MANUAL_RECONCILIATION"]);
const DISPATCH_STEPS = new Set(["SMS", "LEGACY_PROJECTION"]);
const CREATE_STEPS = Object.freeze({
  [DECISION_TYPES.INITIAL_INTAKE]: new Set(["LEAD_LOG", "LEAD_INDEX", "REMINDER", "ACTION_LINK", "IDEMPOTENCY"]),
  [DECISION_TYPES.AFTER_HOURS_RELEASE]: new Set(["ACTION_LINK", "REMINDER", "LIFECYCLE_EVENT"])
});
const PREDECESSORS = Object.freeze({
  [DECISION_TYPES.INITIAL_INTAKE]: Object.freeze({
    LEAD_INDEX: "LEAD_LOG",
    REMINDER: "LEAD_INDEX",
    ACTION_LINK: "REMINDER",
    IDEMPOTENCY: "ACTION_LINK",
    SMS: "IDEMPOTENCY"
  }),
  [DECISION_TYPES.AFTER_HOURS_RELEASE]: Object.freeze({
    ACTION_LINK: "LEAD_LOG",
    REMINDER: "ACTION_LINK",
    SMS: "REMINDER",
    LIFECYCLE_EVENT: "RELEASE_QUEUE"
  })
});

function assertText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid routing obligation field: ${field}`);
}

function assertExactKeys(value, allowed, label) {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unknown or missing keys.`);
  }
}

function validateContinuation(continuation, decisionType) {
  if (!continuation || typeof continuation !== "object" || Array.isArray(continuation)) throw new Error("Routing obligation continuation is invalid.");
  assertExactKeys(continuation, decisionType === DECISION_TYPES.INITIAL_INTAKE
    ? ["operation_kind", "client_id", "lead_id", "lifecycle_identity", "assignment_identity", "assignment_result", "plan"]
    : ["operation_kind", "client_id", "release_id", "lead_id", "lifecycle_identity", "assignment_identity", "assignment_result", "plan"], "Routing obligation continuation");
  if (continuation.operation_kind !== decisionType) throw new Error("Routing obligation continuation decision mismatch.");
  assertText(continuation.client_id, "continuation.client_id");
  assertText(continuation.lead_id, "continuation.lead_id");
  if (decisionType === DECISION_TYPES.INITIAL_INTAKE &&
      (!continuation.lifecycle_identity || continuation.lifecycle_identity.lifecycle_id !== continuation.lead_id)) {
    throw new Error("Routing obligation lifecycle identity mismatch.");
  }
  if (continuation.lifecycle_identity) {
    assertExactKeys(continuation.lifecycle_identity, ["lifecycle_id", "policy_snapshot_id"], "Routing obligation lifecycle identity");
    if (continuation.lifecycle_identity.lifecycle_id !== continuation.lead_id) throw new Error("Routing obligation lifecycle identity mismatch.");
    assertText(continuation.lifecycle_identity.policy_snapshot_id, "continuation.policy_snapshot_id");
  }
  if (decisionType === DECISION_TYPES.INITIAL_INTAKE && !continuation.assignment_identity) {
    throw new Error("Routing obligation initial intake assignment identity is required.");
  }
  if (continuation.assignment_identity !== null) {
    assertExactKeys(continuation.assignment_identity, ["lifecycle_id", "assignment_id", "assignment_sequence", "owner_epoch_id", "agent_id_snapshot", "policy_snapshot_id"], "Routing obligation assignment identity");
    for (const field of ["lifecycle_id", "policy_snapshot_id", "assignment_id", "owner_epoch_id", "agent_id_snapshot"]) {
      assertText(continuation.assignment_identity?.[field], `continuation.assignment_identity.${field}`);
    }
    if (!Number.isInteger(Number(continuation.assignment_identity.assignment_sequence)) || Number(continuation.assignment_identity.assignment_sequence) < 1) {
      throw new Error("Routing obligation assignment sequence is invalid.");
    }
    if (continuation.assignment_identity.lifecycle_id !== continuation.lead_id) throw new Error("Routing obligation assignment lifecycle mismatch.");
  }
  assertExactKeys(continuation.assignment_result, ["assigned_agent_id", "routing_pointer_before", "routing_pointer_after", "cycle_length", "cycle_preview", "active_agents_count"], "Routing obligation assignment result");
  assertText(continuation.assignment_result?.assigned_agent_id, "continuation.assignment_result.assigned_agent_id");
  for (const field of ["routing_pointer_before", "routing_pointer_after", "cycle_length", "active_agents_count"]) {
    if (!Number.isSafeInteger(continuation.assignment_result[field]) || continuation.assignment_result[field] < 0) {
      throw new Error(`Routing obligation assignment result is invalid: ${field}`);
    }
  }
  if (!Array.isArray(continuation.assignment_result.cycle_preview) ||
      continuation.assignment_result.cycle_preview.some(value => typeof value !== "string" || !value)) {
    throw new Error("Routing obligation assignment cycle is invalid.");
  }
  if (continuation.assignment_identity && continuation.assignment_identity.agent_id_snapshot !== continuation.assignment_result.assigned_agent_id) {
    throw new Error("Routing obligation assignment winner mismatch.");
  }
  if (decisionType === DECISION_TYPES.AFTER_HOURS_RELEASE) assertText(continuation.release_id, "continuation.release_id");
  if (!continuation.plan || typeof continuation.plan !== "object" || Array.isArray(continuation.plan)) throw new Error("Routing obligation continuation plan is missing.");
  const planKeys = ["trace_id", "created_ts_utc", "reminder_due_ts_utc", "lifecycle_event_id", ...(continuation.assignment_identity ? ["gateway_id"] : [])];
  assertExactKeys(continuation.plan, planKeys, "Routing obligation continuation plan");
  assertText(continuation.plan.trace_id, "continuation.plan.trace_id");
  assertText(continuation.plan.created_ts_utc, "continuation.plan.created_ts_utc");
  assertText(continuation.plan.lifecycle_event_id, "continuation.plan.lifecycle_event_id");
  assertText(continuation.plan.reminder_due_ts_utc, "continuation.plan.reminder_due_ts_utc");
  normalizeTimestamp(continuation.plan.created_ts_utc, "continuation.plan.created_ts_utc");
  normalizeTimestamp(continuation.plan.reminder_due_ts_utc, "continuation.plan.reminder_due_ts_utc");
  if (continuation.assignment_identity) {
    assertText(continuation.plan.gateway_id, "continuation.plan.gateway_id");
  }
  return continuation;
}

function assertRowEvidence(evidence, keys, step) {
  assertExactKeys(evidence, keys, `Routing obligation consequence evidence: ${step}`);
  if (!Number.isSafeInteger(evidence.row_number) || evidence.row_number < 2) {
    throw new Error(`Routing obligation consequence row evidence is invalid: ${step}`);
  }
}

function isDefinitiveNoAcceptanceState(state) {
  return state?.status === "PENDING" &&
    state.evidence?.reason === "DEFINITIVE_NO_ACCEPTANCE" &&
    typeof state.evidence?.error_code === "string" &&
    Boolean(state.evidence.error_code.trim()) &&
    Object.keys(state.evidence).length === 2;
}

function isRetryLineageDispatchState(state) {
  return new Set(["DISPATCHING", "AMBIGUOUS", "MANUAL_RECONCILIATION"]).has(state?.status) &&
    state.evidence?.retry_provenance === "DEFINITIVE_NO_ACCEPTANCE";
}

function isCompletedConsequence(record, step) {
  return record?.consequence_state?.[step]?.status === "COMPLETED";
}

function isSmsDownstreamAuthorized(record) {
  const state = record?.consequence_state?.SMS;
  return state?.status === "COMPLETED" || isDefinitiveNoAcceptanceState(state);
}

function validateConsequenceEvidence(step, state, decisionType, continuation) {
  const evidence = state.evidence;
  if (state.status === "PENDING") {
    if (!DISPATCH_STEPS.has(step)) throw new Error(`Routing obligation retryable pending state is invalid: ${step}`);
    assertExactKeys(evidence, ["reason", "error_code"], `Routing obligation consequence evidence: ${step}`);
    if (evidence.reason !== "DEFINITIVE_NO_ACCEPTANCE") throw new Error(`Routing obligation pending evidence is invalid: ${step}`);
    assertText(evidence.error_code, `consequence_state.${step}.evidence.error_code`);
    return;
  }
  if (state.status === "CREATING") {
    if (!CREATE_STEPS[decisionType].has(step)) {
      throw new Error(`Routing obligation create ownership is invalid for step: ${step}`);
    }
    assertExactKeys(evidence, ["claim_id"], `Routing obligation consequence evidence: ${step}`);
    assertText(evidence.claim_id, `consequence_state.${step}.evidence.claim_id`);
    return;
  }
  if (state.status === "DISPATCHING") {
    if (!DISPATCH_STEPS.has(step)) throw new Error(`Routing obligation dispatch state is invalid: ${step}`);
    const retry = Object.prototype.hasOwnProperty.call(evidence, "retry_provenance");
    assertExactKeys(evidence, retry ? ["dispatch_started", "retry_provenance"] : ["dispatch_started"], `Routing obligation consequence evidence: ${step}`);
    if (evidence.dispatch_started !== true) throw new Error(`Routing obligation dispatch evidence is invalid: ${step}`);
    if (retry && evidence.retry_provenance !== "DEFINITIVE_NO_ACCEPTANCE") throw new Error(`Routing obligation dispatch retry provenance is invalid: ${step}`);
    return;
  }
  if (state.status === "AMBIGUOUS" || state.status === "MANUAL_RECONCILIATION") {
    if (!DISPATCH_STEPS.has(step)) throw new Error(`Routing obligation dispatch state is invalid: ${step}`);
    const keys = Object.keys(evidence).sort();
    const keyShape = keys.join(",");
    if (!["reason", "error_code,reason", "reason,retry_provenance", "error_code,reason,retry_provenance"].includes(keyShape)) {
      throw new Error(`Routing obligation ambiguous evidence is invalid: ${step}`);
    }
    assertText(evidence.reason, `consequence_state.${step}.evidence.reason`);
    if (evidence.error_code !== undefined) assertText(evidence.error_code, `consequence_state.${step}.evidence.error_code`);
    if (evidence.retry_provenance !== undefined && evidence.retry_provenance !== "DEFINITIVE_NO_ACCEPTANCE") {
      throw new Error(`Routing obligation ambiguous retry provenance is invalid: ${step}`);
    }
    return;
  }
  if (state.status !== "COMPLETED") return;

  if (step === "SMS") {
    if (evidence.dispatched === false) {
      assertExactKeys(evidence, ["dispatched", "reason"], "Routing obligation consequence evidence: SMS");
      if (evidence.reason !== "DISABLED") throw new Error("Routing obligation completed SMS evidence is not definitive.");
      return;
    }
    assertExactKeys(evidence, ["dispatched", "provider_message_id", "provider_status"], "Routing obligation consequence evidence: SMS");
    if (evidence.dispatched !== true || evidence.provider_status !== "SUBMITTED") throw new Error("Routing obligation completed SMS evidence is not definitive.");
    assertText(evidence.provider_message_id, "consequence_state.SMS.evidence.provider_message_id");
    return;
  }
  if (step === "LEGACY_PROJECTION") {
    assertExactKeys(evidence, ["status"], "Routing obligation consequence evidence: LEGACY_PROJECTION");
    if (evidence.status !== "LEGACY_MAKE_SUBMITTED") throw new Error("Routing obligation completed legacy projection evidence is invalid.");
    return;
  }
  const rowEvidence = decisionType === DECISION_TYPES.INITIAL_INTAKE
    ? {
        LEAD_LOG: ["lead_id", "row_number"],
        LEAD_INDEX: ["lead_id", "row_number"],
        REMINDER: ["assignment_id", "row_number"],
        ACTION_LINK: ["gateway_id", "row_number"],
        IDEMPOTENCY: ["lead_id", "row_number"]
      }
    : {
        ACTION_LINK: ["gateway_id", "lead_id", "row_number"],
        REMINDER: ["assignment_id", "lead_id", "row_number"],
        LIFECYCLE_EVENT: ["event_id", "lead_id", "row_number"]
      };
  if (rowEvidence[step]) {
    assertRowEvidence(evidence, rowEvidence[step], step);
    const expected = {
      lead_id: continuation.lead_id,
      assignment_id: continuation.assignment_identity?.assignment_id,
      gateway_id: continuation.plan.gateway_id,
      event_id: continuation.plan.lifecycle_event_id
    };
    for (const field of rowEvidence[step].filter(field => field !== "row_number")) {
      const legacyBlankAllowed = decisionType === DECISION_TYPES.AFTER_HOURS_RELEASE &&
        continuation.assignment_identity === null && new Set(["assignment_id", "gateway_id"]).has(field);
      if (!legacyBlankAllowed) assertText(evidence[field], `consequence_state.${step}.evidence.${field}`);
      if (!legacyBlankAllowed && evidence[field] !== expected[field]) {
        throw new Error(`Routing obligation consequence identity mismatch: ${step}.${field}`);
      }
      if (legacyBlankAllowed && typeof evidence[field] !== "string") {
        throw new Error(`Routing obligation legacy consequence identity is invalid: ${step}.${field}`);
      }
    }
    return;
  }
  const mutationEvidence = { LEAD_LOG: ["lead_id"], RELEASE_QUEUE: ["release_id"] };
  if (decisionType === DECISION_TYPES.AFTER_HOURS_RELEASE && mutationEvidence[step]) {
    assertExactKeys(evidence, mutationEvidence[step], `Routing obligation consequence evidence: ${step}`);
    const field = mutationEvidence[step][0];
    assertText(evidence[field], `consequence_state.${step}.evidence.${field}`);
    const expected = field === "lead_id" ? continuation.lead_id : continuation.release_id;
    if (evidence[field] !== expected) throw new Error(`Routing obligation consequence identity mismatch: ${step}.${field}`);
    return;
  }
  throw new Error(`Routing obligation completed evidence is invalid: ${step}`);
}

function validateConsequenceState(value, decisionType, continuation) {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Routing obligation consequence state is invalid.");
  const allowedSteps = decisionType === DECISION_TYPES.INITIAL_INTAKE
    ? new Set(["LEAD_LOG", "LEAD_INDEX", "REMINDER", "ACTION_LINK", "IDEMPOTENCY", "SMS", "LEGACY_PROJECTION"])
    : new Set(["LEAD_LOG", "ACTION_LINK", "REMINDER", "SMS", "RELEASE_QUEUE", "LIFECYCLE_EVENT"]);
  for (const [step, state] of Object.entries(value)) {
    assertText(step, "consequence step");
    if (!allowedSteps.has(step)) throw new Error(`Unknown routing continuation step: ${step}`);
    if (!state || typeof state !== "object" || !VALID_STEP_STATUS.has(state.status)) {
      throw new Error(`Routing obligation consequence state is invalid: ${step}`);
    }
    assertExactKeys(state, ["status", "evidence", "updated_ts_utc"], `Routing obligation consequence state: ${step}`);
    if (!state.evidence || typeof state.evidence !== "object" || Array.isArray(state.evidence)) throw new Error(`Routing obligation consequence evidence is invalid: ${step}`);
    if (state.updated_ts_utc) normalizeTimestamp(state.updated_ts_utc, `consequence_state.${step}.updated_ts_utc`);
    validateConsequenceEvidence(step, state, decisionType, continuation);
  }
  for (const [step, predecessor] of Object.entries(PREDECESSORS[decisionType])) {
    if (value[step] !== undefined && value[predecessor]?.status !== "COMPLETED") {
      throw new Error(`Routing obligation consequence predecessor is incomplete: ${step} requires ${predecessor}`);
    }
  }
  const downstreamStep = decisionType === DECISION_TYPES.INITIAL_INTAKE ? "LEGACY_PROJECTION" : "RELEASE_QUEUE";
  if (value[downstreamStep] !== undefined && value[downstreamStep].status !== "COMPLETED" &&
      !isSmsDownstreamAuthorized({ consequence_state: value }) && !isRetryLineageDispatchState(value.SMS)) {
    throw new Error(`Routing obligation downstream consequence is not authorized: ${downstreamStep}`);
  }
}

function validateRoutingObligation({ record, key, environment, logicalReference, verifyResponse }) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Routing coordination obligation is malformed.");
  const commonKeys = ["schema_version", "phase", "environment", "operation_key", "logical_reference", "semantic_request", "continuation", "created_ts_utc", "updated_ts_utc"];
  if (record.stale_recomputations !== undefined) commonKeys.push("stale_recomputations");
  const phaseKeys = record.phase === "ACCEPTED"
    ? [...commonKeys, "coordinator_response", "accepted_ts_utc", "consequence_state"]
    : [...commonKeys, ...(record.consequence_state === undefined ? [] : ["consequence_state"])];
  assertExactKeys(record, phaseKeys, "Routing coordination obligation");
  if (record.schema_version !== 2) throw new Error("Unsupported routing coordination obligation schema version.");
  if (record.stale_recomputations !== undefined &&
      (!Number.isSafeInteger(record.stale_recomputations) || record.stale_recomputations < 1)) {
    throw new Error("Routing coordination obligation stale recomputation count is invalid.");
  }
  if (!new Set(["PENDING", "ACCEPTED"]).has(record.phase)) throw new Error("Unsupported routing coordination obligation phase.");
  if (record.environment !== environment) throw new Error("Routing coordination obligation environment mismatch.");
  if (record.operation_key !== key || routingOperationKey(environment, logicalReference) !== key) {
    throw new Error("Routing coordination obligation logical key mismatch.");
  }
  if (canonicalJson(record.logical_reference) !== canonicalJson(logicalReference)) {
    throw new Error("Routing coordination obligation logical reference mismatch.");
  }
  const request = validateSemanticRequest(record.semantic_request);
  if (request.environment !== environment || request.client_id !== logicalReference.client_id ||
      canonicalJson(request.logical_reference) !== canonicalJson(logicalReference)) {
    throw new Error("Routing coordination obligation request binding mismatch.");
  }
  validateContinuation(record.continuation, request.decision_type);
  if (record.continuation.client_id !== request.client_id) throw new Error("Routing obligation continuation client mismatch.");
  if (request.decision_type === DECISION_TYPES.AFTER_HOURS_RELEASE &&
      record.continuation.release_id !== request.logical_reference.release_id) {
    throw new Error("Routing obligation continuation release mismatch.");
  }
  if (record.continuation.assignment_result.assigned_agent_id !== request.proposal.selected_agent_id) {
    throw new Error("Routing obligation continuation does not match the semantic routing winner.");
  }
  if (record.continuation.assignment_result.routing_pointer_after !== request.proposal.routing_pointer_after) {
    throw new Error("Routing obligation continuation does not match the semantic routing pointer.");
  }
  validateConsequenceState(record.consequence_state, request.decision_type, record.continuation);
  normalizeTimestamp(record.created_ts_utc, "created_ts_utc");
  normalizeTimestamp(record.updated_ts_utc, "updated_ts_utc");
  if (record.phase === "PENDING") {
    if (record.coordinator_response || record.accepted_ts_utc || Object.keys(record.consequence_state || {}).length) {
      throw new Error("Pending routing obligation has impossible accepted state.");
    }
  } else {
    if (typeof verifyResponse !== "function") throw new Error("Accepted routing obligation cannot be verified.");
    const verified = verifyResponse(record.coordinator_response, request);
    if (!ACCEPTED.has(verified.result_status)) throw new Error("Accepted routing obligation has a non-accepted result.");
    assertAcceptedResult(verified, request);
    assertText(record.accepted_ts_utc, "accepted_ts_utc");
    normalizeTimestamp(record.accepted_ts_utc, "accepted_ts_utc");
  }
  return record;
}

async function coordinateRoutingCommit({
  logicalReference,
  environment,
  buildAttempt,
  obligationStore,
  client,
  maxSameRequestAttempts = 3,
  maxStaleRecomputations = 2,
  retryDelayMs = 25,
  now = () => new Date().toISOString(),
  onAccepted
}) {
  if (typeof buildAttempt !== "function") throw new Error("buildAttempt is required.");
  if (!environment) throw new Error("Routing coordination environment is required.");
  const key = routingOperationKey(environment, logicalReference);
  let stored = await obligationStore.read(key);
  if (!stored) {
    const attempt = assertAttempt(await buildAttempt({ reason: "INITIAL" }));
    const candidate = {
      schema_version: 2,
      phase: "PENDING",
      environment,
      operation_key: key,
      logical_reference: logicalReference,
      semantic_request: attempt.request,
      continuation: attempt.continuation,
      created_ts_utc: now(),
      updated_ts_utc: now()
    };
    const created = await obligationStore.create(key, candidate);
    stored = { record: created.record, etag: created.etag };
  }

  let staleCount = 0;
  while (true) {
    const record = stored.record;
    validateRoutingObligation({
      record,
      key,
      environment,
      logicalReference,
      verifyResponse: client.verify
    });
    if (record.phase === "ACCEPTED") {
      return { key, response: record.coordinator_response, continuation: record.continuation, obligation: record, replayed: true };
    }
    if (record.phase !== "PENDING" || !record.semantic_request) throw new Error("Routing coordination obligation is invalid.");

    let response = null;
    let ambiguousError = null;
    for (let attemptNumber = 1; attemptNumber <= maxSameRequestAttempts; attemptNumber += 1) {
      try {
        response = await client.commit(record.semantic_request);
        ambiguousError = null;
      } catch (error) {
        if (error.code !== "ROUTING_COORDINATOR_AMBIGUOUS") throw error;
        ambiguousError = error;
        if (attemptNumber < maxSameRequestAttempts) await delay(retryDelayMs * attemptNumber);
        continue;
      }
      if (isSameRequestRetry(response) && attemptNumber < maxSameRequestAttempts) {
        await delay(retryDelayMs * attemptNumber);
        response = null;
        continue;
      }
      break;
    }
    if (ambiguousError && !response) throw ambiguousError;
    if (!response) throw new Error("Routing coordinator retry budget exhausted.");

    if (ACCEPTED.has(response.result_status)) {
      assertAcceptedResult(response, record.semantic_request);
      if (typeof client.verify !== "function") throw new Error("Coordinator client cannot verify accepted responses.");
      client.verify(response, record.semantic_request);
      const accepted = {
        ...record,
        phase: "ACCEPTED",
        coordinator_response: response,
        consequence_state: record.consequence_state || {},
        accepted_ts_utc: now(),
        updated_ts_utc: now()
      };
      const replaced = await obligationStore.replace(key, accepted, stored.etag);
      if (!replaced.replaced) {
        stored = { record: replaced.record, etag: replaced.etag };
        continue;
      }
      if (onAccepted) await onAccepted({ key, response, continuation: accepted.continuation });
      return { key, response, continuation: accepted.continuation, obligation: accepted, replayed: false };
    }

    if (response.result_status === "ROUTING_STATE_STALE") {
      if (staleCount >= maxStaleRecomputations) throw new Error("Routing coordination stale-state retry budget exhausted.");
      staleCount += 1;
      const next = assertAttempt(await buildAttempt({ reason: "STALE", result: response.result_payload, previous: record }));
      if (next.request.routing_commit_id === record.semantic_request.routing_commit_id) {
        throw new Error("Stale-state recomputation did not produce a new routing commit ID.");
      }
      const pending = {
        ...record,
        semantic_request: next.request,
        continuation: next.continuation,
        stale_recomputations: (record.stale_recomputations || 0) + 1,
        updated_ts_utc: now()
      };
      const replaced = await obligationStore.replace(key, pending, stored.etag);
      stored = { record: replaced.record, etag: replaced.etag };
      continue;
    }

    if (response.result_status === "ROUTING_RECOVERY_INCONSISTENT") {
      throw new Error("Routing coordinator reported inconsistent recovery state.");
    }
    if (isSameRequestRetry(response)) {
      throw new Error(`Routing coordinator retry budget exhausted: ${response.result_status}`);
    }
    throw new Error(`Routing coordinator rejected request: ${response.result_status || "UNKNOWN"}`);
  }
}

module.exports = {
  coordinateRoutingCommit,
  isCompletedConsequence,
  isRetryLineageDispatchState,
  isSmsDownstreamAuthorized,
  routingCoordinationMode,
  routingOperationKey,
  validateRoutingObligation
};
