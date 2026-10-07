const { createHash } = require("crypto");
const { canonicalJson, normalizeTimestamp } = require("./routing-coordination-contract");

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
      schema_version: 1,
      phase: "PENDING",
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
    if (record.phase === "ACCEPTED") {
      return { key, response: record.coordinator_response, continuation: record.continuation, replayed: true };
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
      const accepted = {
        ...record,
        phase: "ACCEPTED",
        coordinator_response: response,
        accepted_ts_utc: now(),
        updated_ts_utc: now()
      };
      const replaced = await obligationStore.replace(key, accepted, stored.etag);
      if (!replaced.replaced) {
        stored = { record: replaced.record, etag: replaced.etag };
        continue;
      }
      if (onAccepted) await onAccepted({ key, response, continuation: accepted.continuation });
      return { key, response, continuation: accepted.continuation, replayed: false };
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
  routingCoordinationMode,
  routingOperationKey
};
