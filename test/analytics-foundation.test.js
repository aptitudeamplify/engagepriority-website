const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  CONTRACT_VERSION, SCHEMA_VERSION, ENUMS, PHYSICAL_HEADERS, DISPATCH_REQUIRED,
  PROCESSING_REQUIRED, canonicalize, sha256Hex, buildEvent
} = require("../netlify/functions/analytics-contract");
const {
  base64UrlHmac, requestSigningObject, signRequest, responseFactHashObject,
  responseSigningObject, verifyResponse
} = require("../netlify/functions/analytics-auth");
const {
  analyticsConfig, createRequestEnvelope, submitBatch, instrumentAnalyticsBoundary,
  preserveOperationalOutcome
} = require("../netlify/functions/analytics-client");

const REQUEST_SECRET = "test-request-secret";
const RESPONSE_SECRET = "test-response-secret";

function config(overrides = {}) {
  return {
    enabled: true,
    url: "https://example.invalid/analytics",
    environment: "UAT",
    issuer: "engagepriority-netlify",
    sourceId: "NETLIFY_INTAKE",
    requestKeyId: "request-v1",
    requestSecret: REQUEST_SECRET,
    responseKeyId: "response-v1",
    responseSecret: RESPONSE_SECRET,
    timeoutMs: 20,
    ...overrides
  };
}

function leadAccepted(sequence = 1) {
  return buildEvent({
    record_type: "LEAD_ACCEPTED",
    event_ts_utc: "2026-08-14T00:00:00.000Z",
    environment: "UAT",
    client_id: "C-TEST-001",
    coverage_epoch_id: "epoch-1",
    source_id: "NETLIFY_INTAKE",
    source_sequence: sequence,
    source_correlation_id: "trace-1",
    lifecycle_id: "life-1",
    lead_id: "lead-1",
    policy_snapshot_id: "policy-1",
    actor_type: "SYSTEM",
    event_payload: {
      accepted_ts_utc: "2026-08-14T00:00:00.000Z",
      intake_source_reference: "source-ref-hash",
      authoritative_acceptance_record_id: "lead-1"
    }
  });
}

function envelope() {
  return createRequestEnvelope({
    config: config(),
    clientId: "C-TEST-001",
    coverageEpochId: "epoch-1",
    batchId: "batch-1",
    requestId: "request-1",
    firstSourceSequence: 1,
    records: [leadAccepted()],
    now: new Date("2026-08-14T00:00:00.000Z")
  });
}

function signedResponse(request, overrides = {}, secret = RESPONSE_SECRET) {
  const response = {
    contract_version: CONTRACT_VERSION,
    schema_version: SCHEMA_VERSION,
    environment: request.auth.environment,
    intended_issuer: request.auth.issuer,
    request_id: request.request.request_id,
    batch_id: request.request.batch_id,
    client_id: request.request.client_id,
    coverage_epoch_id: request.request.coverage_epoch_id,
    source_id: request.request.source_id,
    first_source_sequence: request.request.first_source_sequence,
    last_source_sequence: request.request.last_source_sequence,
    result: "COMMITTED",
    receipt_id: "receipt-1",
    committed_batch_count: 1,
    first_ledger_sequence_no: 10,
    last_ledger_sequence_no: 11,
    committed_source_watermark: 1,
    duplicate: false,
    retryable: false,
    error_code: null,
    server_ts_utc: "2026-08-14T00:00:01.000Z",
    response_fact_hash: "",
    response_key_id: "response-v1",
    response_signature: "",
    ...overrides
  };
  response.response_fact_hash = sha256Hex(responseFactHashObject(response));
  response.response_signature = base64UrlHmac(secret, responseSigningObject(response));
  return response;
}

test("exports exact physical schemas and closed event enumerations", () => {
  assert.equal(PHYSICAL_HEADERS.AnalyticsLedger.length, 38);
  assert.deepEqual(PHYSICAL_HEADERS.AnalyticsLedger.slice(0, 5), ["schema_version", "contract_version", "record_type", "event_id", "event_key"]);
  assert.equal(new Set(ENUMS.record_type).size, ENUMS.record_type.length);
  assert.ok(ENUMS.disposition_code.includes("CONTACTED_SET_APPOINTMENT"));
  assert.ok(ENUMS.disposition_code.includes("ADMIN_NO_ACTION"));
  assert.throws(() => buildEvent({ ...leadAccepted(), record_type: "UNKNOWN" }), /UNKNOWN_ENUM_VALUE/);
});

test("canonicalization is deterministic and rejects floats and non-NFC strings", () => {
  assert.equal(canonicalize({ z: 1, a: { y: true, x: null } }), '{"a":{"x":null,"y":true},"z":1}');
  assert.throws(() => canonicalize({ value: 1.5 }), /NON_INTEGER_NUMBER/);
  assert.throws(() => canonicalize({ value: "e\u0301" }), /NON_NFC_STRING/);
});

test("event builder produces scoped deterministic key and stable fact hash", () => {
  const first = leadAccepted();
  const second = leadAccepted();
  assert.equal(first.event_key, "v1|UAT|C-TEST-001|epoch-1|LEAD_ACCEPTED|life-1|lead_accepted");
  assert.equal(first.event_id, second.event_id);
  assert.equal(first.fact_hash, second.fact_hash);
  assert.match(first.fact_hash, /^[a-f0-9]{64}$/);
});

test("conditional dispatch and processing matrices are closed", () => {
  assert.deepEqual(Object.keys(DISPATCH_REQUIRED), ENUMS.dispatch_kind);
  assert.deepEqual(Object.keys(PROCESSING_REQUIRED), ENUMS.processing_stage);
});

test("request signature binds every authentication and request field", () => {
  const original = envelope();
  const originalSignature = original.auth.signature;
  const mutations = [
    copy => { copy.auth.key_id = "other"; },
    copy => { copy.auth.issuer = "other"; },
    copy => { copy.auth.environment = "PRODUCTION"; },
    copy => { copy.auth.issued_at_utc = "2026-08-14T00:00:01.000Z"; },
    copy => { copy.auth.expires_at_utc = "2026-08-14T00:04:59.000Z"; },
    copy => { copy.auth.nonce = "other"; },
    copy => { copy.request.contract_version = "other"; },
    copy => { copy.request.schema_version = "other"; },
    copy => { copy.request.request_id = "other"; },
    copy => { copy.request.batch_id = "other"; },
    copy => { copy.request.batch_count = 2; },
    copy => { copy.request.client_id = "other"; },
    copy => { copy.request.coverage_epoch_id = "other"; },
    copy => { copy.request.source_id = "other"; },
    copy => { copy.request.first_source_sequence = 2; },
    copy => { copy.request.last_source_sequence = 2; },
    copy => { copy.request.payload_sha256 = "other"; },
    copy => { copy.request.payload.records[0].lead_id = "other"; }
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(original);
    mutate(copy);
    assert.notEqual(base64UrlHmac(REQUEST_SECRET, requestSigningObject(copy)), originalSignature);
  }
});

test("response verification binds all returned fields and scoped response key", () => {
  const request = envelope();
  const response = signedResponse(request);
  const resolver = scope => scope.environment === "UAT" && scope.intended_issuer === "engagepriority-netlify" && scope.source_id === "NETLIFY_INTAKE" && scope.response_key_id === "response-v1" ? RESPONSE_SECRET : null;
  assert.equal(verifyResponse(response, request, resolver), true);
  assert.throws(() => verifyResponse(signedResponse(request, { source_id: "OTHER" }), request, resolver), /RESPONSE_CORRELATION_MISMATCH/);
  assert.throws(() => verifyResponse(signedResponse(request, { intended_issuer: "other" }), request, resolver), /RESPONSE_CORRELATION_MISMATCH/);
  assert.throws(() => verifyResponse(signedResponse(request, { response_key_id: "other" }), request, resolver), /RESPONSE_KEY_NOT_AUTHORIZED/);
});

test("instrumentation is disabled by default and schedules without awaiting when enabled", () => {
  assert.equal(analyticsConfig({}).enabled, false);
  let waited = false;
  const result = instrumentAnalyticsBoundary({ waitUntil() { waited = true; } }, { boundary: "INTAKE" }, { config: config(), onObservation: async () => ({ status: "OK" }) });
  assert.deepEqual(result, { status: "SCHEDULED" });
  assert.equal(waited, true);
});

test("disabled, rejection, failure, and timeout cannot change operational outcomes", async () => {
  let fetchCalled = false;
  const disabled = await submitBatch({ config: config({ enabled: false }) }, { fetchImpl: async () => { fetchCalled = true; } });
  assert.equal(disabled.status, "DISABLED");
  assert.equal(fetchCalled, false);

  const expected = { statusCode: 200, body: "operational-success" };
  assert.deepEqual(await preserveOperationalOutcome(async () => expected, async () => { throw new Error("analytics failure"); }), expected);

  const request = envelope();
  const rejected = signedResponse(request, { result: "REJECTED", receipt_id: null, committed_batch_count: null, first_ledger_sequence_no: null, last_ledger_sequence_no: null, committed_source_watermark: null, retryable: true, error_code: "LOCK_UNAVAILABLE" });
  const rejectedResult = await submitBatch({ config: config(), clientId: "C-TEST-001", coverageEpochId: "epoch-1", batchId: "batch-1", requestId: "request-1", firstSourceSequence: 1, records: [leadAccepted()], now: new Date("2026-08-14T00:00:00.000Z") }, { fetchImpl: async () => ({ json: async () => rejected }) });
  assert.equal(rejectedResult.status, "REJECTED");

  const timeoutResult = await submitBatch({ config: config(), clientId: "C-TEST-001", coverageEpochId: "epoch-1", batchId: "batch-1", requestId: "request-1", firstSourceSequence: 1, records: [leadAccepted()], now: new Date("2026-08-14T00:00:00.000Z") }, { fetchImpl: async () => { const error = new Error("timeout"); error.name = "AbortError"; throw error; } });
  assert.equal(timeoutResult.status, "UNKNOWN_RESULT");
  assert.equal(timeoutResult.errorCode, "TIMEOUT");
});

test("dormant hooks cover each approved Netlify producer boundary", () => {
  const root = path.join(__dirname, "..", "netlify", "functions");
  const expected = {
    "intake-lead.js": ["INTAKE_HELD_AFTER_HOURS_COMMITTED", "INTAKE_OPERATIONALLY_COMMITTED"],
    "release-lead.js": ["AFTER_HOURS_RELEASE_DISPATCH_CLAIMED", "AFTER_HOURS_RELEASE_OPERATIONALLY_COMMITTED"],
    "handle-action.js": ["ACTION_DISPATCH_CLAIMED", "ACTION_ATTEMPT_REJECTED", "ACTION_PROCESSING_FAILED"],
    "control-tower-resolve-escalation.js": ["ADMIN_RESOLUTION_OPERATIONALLY_COMMITTED"]
  };
  for (const [file, boundaries] of Object.entries(expected)) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    for (const boundary of boundaries) assert.match(source, new RegExp(boundary));
  }
});
