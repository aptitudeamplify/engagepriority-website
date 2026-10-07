const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  CONTRACTS,
  DECISION_TYPES,
  buildSemanticRequest,
  canonicalJson,
  fingerprint,
  hmacHex,
  routingStateFingerprint
} = require("../netlify/functions/_shared/routing-coordination-contract");
const {
  createAuthenticatedEnvelope,
  createRoutingCoordinationClient,
  verifyCoordinatorResponse
} = require("../netlify/functions/_shared/routing-coordination-client");
const {
  coordinateRoutingCommit,
  routingCoordinationMode,
  routingOperationKey,
  validateRoutingObligation
} = require("../netlify/functions/_shared/routing-coordination");
const producer = require("../assets/initial-intake-delivery");

const fixture = require("./fixtures/routing-state-fingerprint-v1.json");
const config = {
  endpoint: "https://example.test/coord",
  environment: "TEST",
  issuer: "NETLIFY_TEST",
  requestKeyId: "request-key-1",
  requestSecret: "request-secret",
  responseKeyId: "response-key-1",
  responseSecret: "response-secret"
};

function sampleRequest(overrides = {}) {
  return buildSemanticRequest({
    environment: "TEST",
    decision_type: DECISION_TYPES.INITIAL_INTAKE,
    client_id: "C-001",
    logical_reference: {
      logical_reference_contract: CONTRACTS.initialIntake,
      client_id: "C-001",
      source_system: "WEBSITE",
      source_path: "website-lead-form-v1",
      source_event_id: "0f4a3b30-41dc-4d28-8fc9-f69197cfc7c4"
    },
    expected_state: {
      routing_state_version: 4,
      routing_pointer: 1,
      routing_state_fingerprint: "sha256:" + "a".repeat(64)
    },
    proposal: {
      selected_agent_id: "A-2",
      routing_pointer_after: 2,
      total_assignments_today_after: 5,
      notes_after: "preserved\nnotes"
    },
    semantic_evidence: {},
    ...overrides
  });
}

function signedResponse(request, overrides = {}) {
  const result_payload = overrides.result_payload || {
    routing_commit_id: request.routing_commit_id,
    client_id: request.client_id,
    selected_agent_id: request.proposal.selected_agent_id,
    committed_routing_state_version: request.expected_state.routing_state_version + 1,
    committed_routing_pointer: request.proposal.routing_pointer_after,
    committed_routing_state_fingerprint: "sha256:" + "b".repeat(64),
    committed_ts_utc: "2026-10-07T12:00:00.000Z"
  };
  const response = {
    response_contract: CONTRACTS.responseSigning,
    environment: request.environment,
    action_contract: request.action_contract,
    request_identity: request.request_fingerprint,
    routing_commit_id: request.routing_commit_id,
    result_status: "COMMITTED",
    result_payload,
    result_fingerprint: fingerprint(result_payload),
    issued_ts_utc: "2026-10-07T12:00:00.000Z",
    key_id: config.responseKeyId,
    ...overrides
  };
  delete response.signature;
  response.signature = hmacHex(config.responseSecret, response);
  return response;
}

function validContinuation(request, { leadId = "L-1", releaseId = "release-001" } = {}) {
  const assignment = {
    lifecycle_id: leadId,
    policy_snapshot_id: "ps-1",
    assignment_id: "as-1",
    assignment_sequence: 1,
    owner_epoch_id: "oe-1",
    agent_id_snapshot: request.proposal.selected_agent_id
  };
  return {
    operation_kind: request.decision_type,
    ...(request.decision_type === DECISION_TYPES.AFTER_HOURS_RELEASE ? { release_id: releaseId } : {}),
    lead_id: leadId,
    lifecycle_identity: { lifecycle_id: leadId, policy_snapshot_id: "ps-1" },
    assignment_identity: assignment,
    assignment_result: {
      assigned_agent_id: request.proposal.selected_agent_id,
      routing_pointer_before: request.expected_state.routing_pointer,
      routing_pointer_after: request.proposal.routing_pointer_after,
      cycle_length: 3,
      cycle_preview: [request.proposal.selected_agent_id],
      active_agents_count: 1
    },
    plan: {
      trace_id: "trace-1",
      created_ts_utc: "2026-10-07T12:00:00.000Z",
      reminder_due_ts_utc: "2026-10-07T12:15:00.000Z",
      lifecycle_event_id: "event-1",
      gateway_id: "gw-1"
    }
  };
}

function verifiedClient(commit) {
  return { commit, verify: response => response };
}

function memoryStore() {
  const map = new Map();
  let version = 0;
  return {
    async read(key) { return map.has(key) ? { record: structuredClone(map.get(key).record), etag: map.get(key).etag } : null; },
    async create(key, record) {
      if (map.has(key)) return { created: false, record: structuredClone(map.get(key).record), etag: map.get(key).etag };
      const etag = String(++version); map.set(key, { record: structuredClone(record), etag });
      return { created: true, record: structuredClone(record), etag };
    },
    async replace(key, record, etag) {
      const old = map.get(key);
      if (!old || old.etag !== etag) return { replaced: false, record: structuredClone(old.record), etag: old.etag };
      const next = String(++version); map.set(key, { record: structuredClone(record), etag: next });
      return { replaced: true, record: structuredClone(record), etag: next };
    },
    map
  };
}

test("GAS fingerprint fixture remains byte-for-byte compatible", () => {
  for (const vector of fixture) {
    const actual = routingStateFingerprint(vector.raw);
    assert.deepEqual(actual.projection, vector.normalized, vector.name);
    assert.equal(actual.canonical_json, vector.canonical_json, vector.name);
    assert.equal(actual.fingerprint, vector.fingerprint, vector.name);
  }
});

test("canonicalization normalizes Unicode, integers, notes, and timestamps and rejects invalid values", () => {
  const actual = routingStateFingerprint(fixture[1].raw).projection;
  assert.equal(actual.client_id, "C-É");
  assert.equal(actual.notes, " Café\nnext ");
  assert.equal(actual.updated_ts_utc, "2026-10-06T19:45:13.000Z");
  assert.equal(routingStateFingerprint(fixture[0].raw).projection.routing_pointer, 1);
  assert.throws(() => routingStateFingerprint({ ...fixture[0].raw, routing_pointer: -1 }));
  assert.throws(() => routingStateFingerprint({ ...fixture[0].raw, client_id: "x\ud800" }));
  assert.throws(() => canonicalJson({ value: Infinity }));
});

test("commit and request identity are deterministic and semantic evidence is exact", () => {
  const first = sampleRequest();
  const second = sampleRequest();
  assert.match(first.routing_commit_id, /^rc1_[a-f0-9]{64}$/);
  assert.equal(first.routing_commit_id, second.routing_commit_id);
  assert.equal(first.request_fingerprint, second.request_fingerprint);
  assert.throws(() => sampleRequest({ semantic_evidence: { extra: true } }));
});

test("fresh authentication changes only nonce/time, not semantic identities", () => {
  const request = sampleRequest();
  const first = createAuthenticatedEnvelope(request, config, { now: new Date("2026-10-07T12:00:00Z"), nonce: "nonce-1" });
  const second = createAuthenticatedEnvelope(request, config, { now: new Date("2026-10-07T12:00:01Z"), nonce: "nonce-2" });
  assert.notEqual(first.auth.signature, second.auth.signature);
  assert.equal(first.request.routing_commit_id, second.request.routing_commit_id);
  assert.equal(first.request.request_fingerprint, second.request.request_fingerprint);
  assert.equal(first.auth.algorithm, "HMAC-SHA256");
});

test("signed response verifies and every bound identity fails closed on mismatch", () => {
  const request = sampleRequest();
  const valid = signedResponse(request);
  assert.equal(verifyCoordinatorResponse(valid, request, config), valid);
  for (const mutation of [
    { environment: "OTHER" }, { action_contract: "OTHER" }, { key_id: "other-key" },
    { request_identity: "sha256:" + "c".repeat(64) }, { routing_commit_id: "rc1_" + "d".repeat(64) },
    { signature: "e".repeat(64) }, { result_fingerprint: "sha256:" + "f".repeat(64) }
  ]) assert.throws(() => verifyCoordinatorResponse({ ...valid, ...mutation }, request, config));
  assert.throws(() => verifyCoordinatorResponse({ unsigned: true }, request, config));
});

test("client treats transport and malformed response as ambiguous and verifies signed non-2xx results", async () => {
  const request = sampleRequest();
  const transportClient = createRoutingCoordinationClient({
    config,
    fetchImpl: async () => { throw new Error("network lost"); }
  });
  await assert.rejects(() => transportClient.commit(request), error => error.code === "ROUTING_COORDINATOR_AMBIGUOUS");
  const malformedClient = createRoutingCoordinationClient({
    config,
    fetchImpl: async () => ({ json: async () => { throw new Error("bad json"); } })
  });
  await assert.rejects(() => malformedClient.commit(request), error => error.code === "ROUTING_COORDINATOR_AMBIGUOUS");
  const signedFailure = signedResponse(request, { result_status: "ROUTING_STATE_STALE", result_payload: { current: true } });
  const authoritativeClient = createRoutingCoordinationClient({
    config,
    fetchImpl: async () => ({ ok: false, status: 409, json: async () => signedFailure })
  });
  assert.equal((await authoritativeClient.commit(request)).result_status, "ROUTING_STATE_STALE");
});

test("ambiguous result survives a fresh invocation and replays the exact semantic request", async () => {
  const store = memoryStore();
  const request = sampleRequest();
  const logicalReference = request.logical_reference;
  const seen = [];
  await assert.rejects(() => coordinateRoutingCommit({
    logicalReference,
    environment: "TEST",
    buildAttempt: async () => ({ request, continuation: validContinuation(request) }),
    obligationStore: store,
    client: verifiedClient(async value => { seen.push(structuredClone(value)); const error = new Error("timeout"); error.code = "ROUTING_COORDINATOR_AMBIGUOUS"; throw error; }),
    maxSameRequestAttempts: 1
  }), /transport|timeout/i);
  const result = await coordinateRoutingCommit({
    logicalReference,
    environment: "TEST",
    buildAttempt: async () => { throw new Error("must use stored attempt"); },
    obligationStore: store,
    client: verifiedClient(async value => { seen.push(structuredClone(value)); return signedResponse(value, { result_status: "ALREADY_COMMITTED" }); })
  });
  assert.deepEqual(seen[0], seen[1]);
  assert.equal(result.continuation.lead_id, "L-1");
  assert.equal(result.response.result_status, "ALREADY_COMMITTED");
});

test("accepted response persisted before a simulated Netlify crash prevents a second commit", async () => {
  const store = memoryStore();
  const request = sampleRequest();
  let calls = 0;
  await assert.rejects(() => coordinateRoutingCommit({
    logicalReference: request.logical_reference,
    environment: "TEST",
    buildAttempt: async () => ({ request, continuation: validContinuation(request) }),
    obligationStore: store,
    client: verifiedClient(async value => { calls += 1; return signedResponse(value); }),
    onAccepted: async () => { throw new Error("simulated crash"); }
  }), /simulated crash/);
  const replay = await coordinateRoutingCommit({
    logicalReference: request.logical_reference,
    environment: "TEST",
    buildAttempt: async () => { throw new Error("not called"); },
    obligationStore: store,
    client: verifiedClient(async () => { calls += 1; throw new Error("not called"); })
  });
  assert.equal(calls, 1);
  assert.equal(replay.continuation.assignment_identity.assignment_id, "as-1");
  assert.equal(replay.replayed, true);
});

test("signed stale result permits bounded recomputation; busy and inconsistent never fall back", async () => {
  const store = memoryStore();
  const initial = sampleRequest();
  const revised = sampleRequest({
    expected_state: { ...initial.expected_state, routing_state_version: 5, routing_pointer: 2 },
    proposal: { ...initial.proposal, selected_agent_id: "A-3", routing_pointer_after: 0 }
  });
  const sent = [];
  const result = await coordinateRoutingCommit({
    logicalReference: initial.logical_reference,
    environment: "TEST",
    buildAttempt: async ({ reason }) => reason === "INITIAL"
      ? { request: initial, continuation: validContinuation(initial) }
      : { request: revised, continuation: validContinuation(revised) },
    obligationStore: store,
    client: verifiedClient(async request => {
      sent.push(request.routing_commit_id);
      return sent.length === 1
        ? signedResponse(request, { result_status: "ROUTING_STATE_STALE", result_payload: { current: true } })
        : signedResponse(request);
    })
  });
  assert.notEqual(sent[0], sent[1]);
  assert.equal(result.continuation.assignment_result.assigned_agent_id, "A-3");

  for (const status of ["ROUTING_BUSY_REASSIGNMENT_RECOVERY", "ROUTING_RECOVERY_INCONSISTENT"]) {
    const isolated = memoryStore();
    await assert.rejects(() => coordinateRoutingCommit({
      logicalReference: initial.logical_reference,
      environment: "TEST",
      buildAttempt: async () => ({ request: initial, continuation: validContinuation(initial) }),
      obligationStore: isolated,
      client: verifiedClient(async request => signedResponse(request, { result_status: status, result_payload: {} })),
      maxSameRequestAttempts: 1
    }));
  }
});

test("lock timeout retries the exact request only within the bounded budget", async () => {
  const store = memoryStore();
  const request = sampleRequest();
  const sent = [];
  const result = await coordinateRoutingCommit({
    logicalReference: request.logical_reference,
    environment: "TEST",
    buildAttempt: async () => ({ request, continuation: validContinuation(request) }),
    obligationStore: store,
    client: verifiedClient(async value => {
      sent.push(structuredClone(value));
      return sent.length < 3
        ? signedResponse(value, { result_status: "ROUTING_LOCK_TIMEOUT", result_payload: { retryable: true } })
        : signedResponse(value);
    }),
    retryDelayMs: 0
  });
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[0], sent[1]);
  assert.deepEqual(sent[1], sent[2]);
  assert.equal(result.continuation.lead_id, "L-1");
});

test("after-hours release ambiguity survives a fresh invocation with stable identity continuation", async () => {
  const request = buildSemanticRequest({
    environment: "TEST",
    decision_type: DECISION_TYPES.AFTER_HOURS_RELEASE,
    client_id: "C-001",
    logical_reference: {
      logical_reference_contract: CONTRACTS.afterHoursRelease,
      client_id: "C-001",
      release_id: "release-001"
    },
    expected_state: { routing_state_version: 4, routing_pointer: 1, routing_state_fingerprint: "sha256:" + "a".repeat(64) },
    proposal: { selected_agent_id: "A-2", routing_pointer_after: 2, total_assignments_today_after: 5, notes_after: "" },
    semantic_evidence: {}
  });
  const store = memoryStore();
  let first = true;
  await assert.rejects(() => coordinateRoutingCommit({
    logicalReference: request.logical_reference,
    environment: "TEST",
    buildAttempt: async () => ({ request, continuation: validContinuation(request) }),
    obligationStore: store,
    client: verifiedClient(async () => { const error = new Error("lost"); error.code = "ROUTING_COORDINATOR_AMBIGUOUS"; throw error; }),
    maxSameRequestAttempts: 1
  }));
  const replay = await coordinateRoutingCommit({
    logicalReference: request.logical_reference,
    environment: "TEST",
    buildAttempt: async () => { throw new Error("not called"); },
    obligationStore: store,
    client: verifiedClient(async value => { assert.deepEqual(value, request); first = false; return signedResponse(value, { result_status: "ALREADY_COMMITTED" }); })
  });
  assert.equal(first, false);
  assert.equal(replay.continuation.assignment_identity.assignment_id, "as-1");
});

test("concurrent claimed-release recovery persists one semantic winner and reuses it", async () => {
  const request = buildSemanticRequest({
    environment: "TEST",
    decision_type: DECISION_TYPES.AFTER_HOURS_RELEASE,
    client_id: "C-001",
    logical_reference: { logical_reference_contract: CONTRACTS.afterHoursRelease, client_id: "C-001", release_id: "release-race" },
    expected_state: { routing_state_version: 4, routing_pointer: 1, routing_state_fingerprint: `sha256:${"a".repeat(64)}` },
    proposal: { selected_agent_id: "A-2", routing_pointer_after: 2, total_assignments_today_after: 5, notes_after: "" },
    semantic_evidence: {}
  });
  const store = memoryStore();
  const sent = [];
  const run = () => coordinateRoutingCommit({
    logicalReference: request.logical_reference,
    environment: "TEST",
    buildAttempt: async () => ({ request, continuation: validContinuation(request, { releaseId: "release-race" }) }),
    obligationStore: store,
    client: verifiedClient(async value => { sent.push(value.routing_commit_id); return signedResponse(value); })
  });
  const results = await Promise.all([run(), run()]);
  assert.ok(sent.length >= 1);
  assert.equal(new Set(sent).size, 1);
  assert.equal(results[0].continuation.assignment_identity.assignment_id, results[1].continuation.assignment_identity.assignment_id);
  const replay = await run();
  assert.equal(replay.replayed, true);
  assert.equal(sent.length <= 2, true, "GAS idempotency may observe concurrent exact retries but never a different semantic request");
});

test("coordinated intake rejects a missing source event and never fabricates one", async () => {
  const previous = process.env.EP_ROUTING_STATE_MODE;
  process.env.EP_ROUTING_STATE_MODE = "GAS_COORDINATED";
  const intake = require("../netlify/functions/intake-lead");
  try {
    const response = await intake.handler({ httpMethod: "POST", body: JSON.stringify({ intake_client_reference: "test" }) }, {});
    assert.equal(response.statusCode, 400);
    assert.equal(JSON.parse(response.body).error, "INVALID_SOURCE_EVENT_ID");
  } finally {
    if (previous === undefined) delete process.env.EP_ROUTING_STATE_MODE;
    else process.env.EP_ROUTING_STATE_MODE = previous;
  }
});

test("coordinated intake commits through the client and performs no direct RoutingState write", async () => {
  const previousMode = process.env.EP_ROUTING_STATE_MODE;
  const previousSms = process.env.ENABLE_SMS_SEND;
  const previousGoogle = process.env.GOOGLE_SERVICE_ACCOUNT;
  process.env.EP_ROUTING_STATE_MODE = "GAS_COORDINATED";
  process.env.ENABLE_SMS_SEND = "false";
  process.env.GOOGLE_SERVICE_ACCOUNT = "{}";
  const intake = require("../netlify/functions/intake-lead");
  const updates = [];
  const appends = [];
  const clients = [["client_id", "client_status", "lead_data_spreadsheet_id", "primary_timezone", "business_day_start_time", "business_day_end_time", "business_days_active", "off_hours_release_mode", "routing_strategy", "reminder_1_delay_minutes"], ["C-001", "ACTIVE", "LEADS", "UTC", "00:00", "23:59", "SUN|MON|TUE|WED|THU|FRI|SAT", "AT_OPEN", "WEIGHTED_INTERLEAVED", "15"]];
  const agents = [["agent_id", "client_id", "agent_status", "assignment_weight", "priority_slot", "agent_phone"], ["A-1", "C-001", "ACTIVE", "1", "1", "+15555550100"]];
  const routing = [["client_id", "routing_state_version", "routing_pointer", "last_assigned_agent_id", "last_assignment_timestamp", "total_assignments_today", "notes", "updated_ts_utc"], ["C-001", "4", "0", "", "", "7", "keep", ""]];
  const sourceMap = [["source_system", "source_primary_key_type", "source_primary_key_value", "client_id", "status"], ["WEBSITE", "source_detail", "test-form", "C-001", "ACTIVE"]];
  const tables = {
    LeadLog_Active: [["lead_id", "client_id", "assigned_agent_id", "lead_status", "trace_id", "lifecycle_id", "assignment_id", "owner_epoch_id", "policy_snapshot_id"]],
    LeadIndex: [["lead_id", "leadlog_row", "client_id"]],
    ReminderQueue: [["trace_id", "client_id", "lead_id", "token", "lead_data_spreadsheet_id", "assigned_agent_id", "active_monitoring", "next_action_due_ts_utc", "next_action_type", "last_processed_ts_utc", "notes", "dispatch_claimed_ts_utc", "lifecycle_id", "assignment_id"]],
    ActionLinkMap: [["short_code", "public_url", "gateway_context", "selected_action", "lead_id", "client_id", "lead_data_spreadsheet_id", "assigned_agent_id", "expires_ts_utc", "active", "created_ts_utc", "used_ts_utc", "notes", "deactivated_ts_utc", "deactivation_reason", "trace_id", "lifecycle_id", "assignment_id", "assignment_sequence", "owner_epoch_id", "agent_id_snapshot", "policy_snapshot_id", "gateway_id"]],
    Idempotency: [["idempotency_key", "client_id", "source_token", "first_seen_timestamp", "last_seen_timestamp", "lead_id", "status", "notes"]]
  };
  const sheets = { spreadsheets: { values: {
    async batchGet() { return { data: { valueRanges: [{ values: clients }, { values: agents }, { values: routing }, { values: sourceMap }] } }; },
    async get({ range }) {
      for (const [name, values] of Object.entries(tables)) if (range.startsWith(`${name}!`)) return { data: { values } };
      if (range.startsWith("Agents!")) return { data: { values: agents } };
      throw new Error(`Unexpected coordinated intake read: ${range}`);
    },
    async update(args) { updates.push(args); return { data: {} }; },
    async append(args) {
      appends.push(args);
      const name = args.range.split("!")[0];
      const raw = args.requestBody.values[0];
      if (name === "LeadLog_Active") tables[name].push([raw[0], raw[1], raw[15], raw[19], raw[22], raw.at(-6), raw.at(-5), raw.at(-3), raw.at(-1)]);
      else if (tables[name]) tables[name].push(raw);
      return { data: { updates: { updatedRange: name === "LeadLog_Active" ? "LeadLog_Active!A2:BL2" : `${name}!A2:Z2` } } };
    }
  } } };
  const store = memoryStore();
  const sent = [];
  intake._test.setRuntime({
    sheets,
    routingCoordinationConfig: { ...config, environment: "TEST" },
    routingCoordinationObligationStore: store,
    routingCoordinationClient: verifiedClient(async request => { sent.push(request); return signedResponse(request); })
  });
  try {
    const response = await intake.handler({ httpMethod: "POST", body: JSON.stringify({
      intake_client_reference: "test-form", source_system: "WEBSITE", source_detail: "test-form",
      source_event_id: "evt-001", full_name: "Synthetic", email: "synthetic@example.invalid", phone: "+15555550100"
    }) }, {});
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].decision_type, "INITIAL_INTAKE");
    assert.equal(sent[0].logical_reference.source_path, "website-lead-form-v1");
    assert.equal(sent[0].proposal.total_assignments_today_after, 8);
    assert.equal(sent[0].proposal.notes_after, "keep");
    assert.equal(updates.some(call => String(call.range).startsWith("RoutingState!")), false);
    assert.ok(appends.some(call => call.range.startsWith("LeadLog_Active!")));
  } finally {
    intake._test.setRuntime(null);
    if (previousMode === undefined) delete process.env.EP_ROUTING_STATE_MODE; else process.env.EP_ROUTING_STATE_MODE = previousMode;
    if (previousSms === undefined) delete process.env.ENABLE_SMS_SEND; else process.env.ENABLE_SMS_SEND = previousSms;
    if (previousGoogle === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT; else process.env.GOOGLE_SERVICE_ACCOUNT = previousGoogle;
  }
});

test("claimed coordinated release with no obligation reconstructs pre-GAS and never directly writes RoutingState", async () => {
  const previousMode = process.env.EP_ROUTING_STATE_MODE;
  const previousSecret = process.env.EP_RELEASE_SHARED_SECRET;
  const previousGoogle = process.env.GOOGLE_SERVICE_ACCOUNT;
  process.env.EP_ROUTING_STATE_MODE = "GAS_COORDINATED";
  process.env.EP_RELEASE_SHARED_SECRET = "release-secret";
  process.env.GOOGLE_SERVICE_ACCOUNT = "{}";
  const release = require("../netlify/functions/release-lead");
  const releaseRows = [["release_id", "client_id", "lead_id", "status", "released_ts_utc", "dispatch_claimed_ts_utc", "release_attempts", "notes"], ["REL-1", "C-001", "L-1", "PROCESSING", "", "2026-10-07T11:59:00.000Z", "1", "claimed"]];
  const clientRows = [["client_id", "lead_data_spreadsheet_id", "routing_strategy", "reminder_1_delay_minutes"], ["C-001", "LEADS", "WEIGHTED_INTERLEAVED", "15"]];
  const leadRows = [["lead_id", "client_id", "lead_status", "trace_id", "lifecycle_id", "policy_snapshot_id"], ["L-1", "C-001", "PENDING_RELEASE", "TRACE-1", "L-1", "ps-1"]];
  const agentRows = [["agent_id", "client_id", "agent_status", "assignment_weight", "priority_slot", "agent_phone"], ["A-1", "C-001", "ACTIVE", "1", "1", "+15555550100"]];
  const routingRows = [["client_id", "routing_state_version", "routing_pointer", "last_assigned_agent_id", "last_assignment_timestamp", "total_assignments_today", "notes", "updated_ts_utc"], ["C-001", "4", "0", "", "", "7", "keep", ""]];
  const updates = [];
  const sheets = { spreadsheets: { values: {
    async get({ range }) {
      if (range.startsWith("ReleaseQueue!")) return { data: { values: releaseRows } };
      if (range.startsWith("Clients!")) return { data: { values: clientRows } };
      if (range.startsWith("LeadLog_Active!")) return { data: { values: leadRows } };
      if (range.startsWith("Agents!")) return { data: { values: agentRows } };
      if (range.startsWith("RoutingState!")) return { data: { values: routingRows } };
      throw new Error(`Unexpected coordinated release read: ${range}`);
    },
    async update(args) { updates.push(args); return { data: {} }; },
    async append() { throw new Error("downstream append must not run"); }
  } } };
  release._test.setRuntime({
    sheets,
    routingCoordinationConfig: { ...config, environment: "TEST" },
    routingCoordinationObligationStore: memoryStore(),
    routingCoordinationClient: verifiedClient(async request => signedResponse(request, { result_status: "ROUTING_RECOVERY_INCONSISTENT", result_payload: { retryable: false } }))
  });
  try {
    await assert.rejects(() => release.handler({
      httpMethod: "POST",
      headers: { "x-ep-release-secret": "release-secret" },
      body: JSON.stringify({ release_id: "REL-1" })
    }, {}), /inconsistent recovery/i);
    assert.equal(updates.some(call => String(call.range).startsWith("ReleaseQueue!")), false, "existing release claim is reused");
    assert.equal(updates.some(call => String(call.range).startsWith("RoutingState!")), false);
  } finally {
    release._test.setRuntime(null);
    if (previousMode === undefined) delete process.env.EP_ROUTING_STATE_MODE; else process.env.EP_ROUTING_STATE_MODE = previousMode;
    if (previousSecret === undefined) delete process.env.EP_RELEASE_SHARED_SECRET; else process.env.EP_RELEASE_SHARED_SECRET = previousSecret;
    if (previousGoogle === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT; else process.env.GOOGLE_SERVICE_ACCOUNT = previousGoogle;
  }
});

test("obligation validation rejects unsupported schema, corrupt accepted proof, and logical binding mismatch", async () => {
  const store = memoryStore();
  const request = sampleRequest();
  await coordinateRoutingCommit({
    logicalReference: request.logical_reference,
    environment: "TEST",
    buildAttempt: async () => ({ request, continuation: validContinuation(request) }),
    obligationStore: store,
    client: verifiedClient(async value => signedResponse(value))
  });
  const key = routingOperationKey("TEST", request.logical_reference);
  const baseline = store.map.get(key).record;
  const verifyResponse = (response, semanticRequest) => verifyCoordinatorResponse(response, semanticRequest, config);
  assert.doesNotThrow(() => validateRoutingObligation({ record: baseline, key, environment: "TEST", logicalReference: request.logical_reference, verifyResponse }));
  for (const mutation of [
    record => ({ ...record, schema_version: 99 }),
    record => ({ ...record, coordinator_response: { ...record.coordinator_response, signature: "0".repeat(64) } }),
    record => ({ ...record, logical_reference: { ...record.logical_reference, source_event_id: "other-event" } }),
    record => ({ ...record, semantic_request: { ...record.semantic_request, routing_commit_id: `rc1_${"0".repeat(64)}` } })
  ]) {
    assert.throws(() => validateRoutingObligation({ record: mutation(structuredClone(baseline)), key, environment: "TEST", logicalReference: request.logical_reference, verifyResponse }));
  }
});

test("producer persists before send, reuses ambiguous identity, retires definitive identity, and separates edited/new content", async () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  let counter = 0;
  const cryptoImpl = { subtle: globalThis.crypto.subtle, randomUUID: () => `event-${++counter}` };
  const payload = { full_name: "Synthetic", phone: "+15555550100" };
  const first = await producer.prepareSubmission(payload, { storage, cryptoImpl });
  assert.ok(producer.readPending(storage));
  const retry = await producer.prepareSubmission(payload, { storage, cryptoImpl });
  assert.equal(retry.source_event_id, first.source_event_id);
  assert.equal(producer.recordResult(503, { storage }), false);
  assert.ok(producer.readPending(storage));
  const edited = await producer.prepareSubmission({ ...payload, full_name: "Edited" }, { storage, cryptoImpl });
  assert.notEqual(edited.source_event_id, first.source_event_id);
  assert.equal(producer.recordResult(200, { storage }), true);
  assert.equal(producer.readPending(storage), null);
  const newSubmission = await producer.prepareSubmission(payload, { storage, cryptoImpl });
  assert.notEqual(newSubmission.source_event_id, first.source_event_id);
});

test("mode defaults to legacy, rejects unknown values, and source contains no coordinated direct-write fallback", () => {
  assert.equal(routingCoordinationMode({}), "LEGACY_DIRECT");
  assert.equal(routingCoordinationMode({ EP_ROUTING_STATE_MODE: "gas_coordinated" }), "GAS_COORDINATED");
  assert.throws(() => routingCoordinationMode({ EP_ROUTING_STATE_MODE: "mixed" }));
  const root = path.join(__dirname, "..", "netlify", "functions");
  const performance = fs.readFileSync(path.join(root, "intake-performance-test.js"), "utf8");
  assert.doesNotMatch(performance, /spreadsheets\.values\.update/);
  for (const file of ["intake-lead.js", "release-lead.js"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(source, /routingStateMode === "LEGACY_DIRECT"/);
    assert.doesNotMatch(source, /GAS_COORDINATED[\s\S]{0,200}(?:updateRoutingStateAfterReleaseAssignment|RoutingState!B2)/);
  }
});
