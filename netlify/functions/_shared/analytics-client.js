const { randomUUID } = require("crypto");
const { CONTRACT_VERSION, SCHEMA_VERSION, sha256Hex } = require("./analytics-contract");
const { signRequest, verifyResponse } = require("./analytics-auth");

const DEFAULT_TIMEOUT_MS = 1500;

function analyticsConfig(env = process.env) {
  return {
    enabled: String(env.ANALYTICS_INSTRUMENTATION_ENABLED || "").toLowerCase() === "true",
    url: String(env.ANALYTICS_GAS_WRITER_URL || "").trim(),
    environment: String(env.ANALYTICS_ENVIRONMENT || "").trim().toUpperCase(),
    issuer: String(env.ANALYTICS_ISSUER || "").trim(),
    sourceId: String(env.ANALYTICS_SOURCE_ID || "").trim(),
    requestKeyId: String(env.ANALYTICS_REQUEST_KEY_ID || "").trim(),
    requestSecret: String(env.ANALYTICS_REQUEST_HMAC_SECRET || ""),
    responseKeyId: String(env.ANALYTICS_RESPONSE_KEY_ID || "").trim(),
    responseSecret: String(env.ANALYTICS_RESPONSE_HMAC_SECRET || ""),
    timeoutMs: Number(env.ANALYTICS_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
  };
}

function assertReady(config) {
  const required = ["url", "environment", "issuer", "sourceId", "requestKeyId", "requestSecret", "responseKeyId", "responseSecret"];
  const missing = required.filter(field => !config[field]);
  if (missing.length) throw new Error(`ANALYTICS_CONFIGURATION_INCOMPLETE:${missing.join(",")}`);
}

function createRequestEnvelope({ config, clientId, coverageEpochId, batchId, requestId = randomUUID(), firstSourceSequence, records, now = new Date() }) {
  assertReady(config);
  if (!records.length) throw new Error("EMPTY_BATCH");
  const payload = { records };
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
  const unsigned = {
    auth: { algorithm: "HMAC-SHA256", key_id: config.requestKeyId, issuer: config.issuer, environment: config.environment, issued_at_utc: issuedAt, expires_at_utc: expiresAt, nonce: randomUUID() },
    request: { contract_version: CONTRACT_VERSION, schema_version: SCHEMA_VERSION, request_id: requestId, batch_id: batchId, batch_count: records.length, client_id: clientId, coverage_epoch_id: coverageEpochId, source_id: config.sourceId, first_source_sequence: firstSourceSequence, last_source_sequence: firstSourceSequence + records.length - 1, payload_sha256: sha256Hex(payload), payload }
  };
  return signRequest(unsigned, config.requestSecret);
}

async function submitBatch(options, dependencies = {}) {
  const config = options.config || analyticsConfig();
  if (!config.enabled) return { status: "DISABLED" };
  try {
    const envelope = createRequestEnvelope({ ...options, config });
    const fetchImpl = dependencies.fetchImpl || fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    let response;
    try {
      response = await fetchImpl(config.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope), signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    const body = await response.json();
    verifyResponse(body, envelope, scope => scope.environment === config.environment && scope.intended_issuer === config.issuer && scope.source_id === config.sourceId && scope.response_key_id === config.responseKeyId ? config.responseSecret : null);
    return { status: body.result, receiptId: body.receipt_id, response: body };
  } catch (error) {
    return { status: "UNKNOWN_RESULT", errorCode: safeErrorCode(error) };
  }
}

function instrumentAnalyticsBoundary(context, observation, dependencies = {}) {
  const config = dependencies.config || analyticsConfig();
  if (!config.enabled) return { status: "DISABLED" };
  const task = Promise.resolve().then(() => dependencies.onObservation ? dependencies.onObservation(observation) : { status: "BINDING_PENDING" }).catch(() => ({ status: "UNKNOWN_RESULT" }));
  if (context && typeof context.waitUntil === "function") context.waitUntil(task);
  return { status: "SCHEDULED" };
}

async function preserveOperationalOutcome(operation, analyticsTask) {
  const outcome = await operation();
  Promise.resolve().then(analyticsTask).catch(() => undefined);
  return outcome;
}

function safeErrorCode(error) {
  return String(error?.name === "AbortError" ? "TIMEOUT" : error?.message || "UNKNOWN_RESULT").replace(/[^A-Z0-9_:,-]/gi, "_").slice(0, 160);
}

module.exports = { DEFAULT_TIMEOUT_MS, analyticsConfig, createRequestEnvelope, submitBatch, instrumentAnalyticsBoundary, preserveOperationalOutcome };
