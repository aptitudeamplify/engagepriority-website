const { createHmac, timingSafeEqual } = require("crypto");
const { canonicalize, sha256Hex, ENUMS } = require("./analytics-contract");

function base64UrlHmac(secret, value) {
  return createHmac("sha256", secret).update(canonicalize(value), "utf8").digest("base64url");
}

function requestSigningObject(envelope) {
  const { signature, ...auth } = envelope.auth || {};
  return { auth, request: envelope.request };
}

function signRequest(envelope, secret) {
  if (!envelope || !envelope.auth || !envelope.request) throw new Error("MALFORMED_REQUEST");
  const payloadHash = sha256Hex(envelope.request.payload);
  if (envelope.request.payload_sha256 !== payloadHash) throw new Error("PAYLOAD_HASH_MISMATCH");
  return { ...envelope, auth: { ...envelope.auth, signature: base64UrlHmac(secret, requestSigningObject(envelope)) } };
}

function responseFactHashObject(response) {
  const { response_signature, response_fact_hash, ...fact } = response;
  return fact;
}

function responseSigningObject(response) {
  const { response_signature, ...signed } = response;
  return signed;
}

function verifyResponse(response, requestEnvelope, resolveKey) {
  if (!response || typeof response !== "object") throw new Error("MALFORMED_RESPONSE");
  const required = ["contract_version", "schema_version", "environment", "intended_issuer", "request_id", "batch_id", "client_id", "coverage_epoch_id", "source_id", "first_source_sequence", "last_source_sequence", "result", "receipt_id", "committed_batch_count", "first_ledger_sequence_no", "last_ledger_sequence_no", "committed_source_watermark", "duplicate", "retryable", "error_code", "server_ts_utc", "response_fact_hash", "response_key_id", "response_signature"];
  required.forEach(field => { if (!Object.prototype.hasOwnProperty.call(response, field)) throw new Error(`MALFORMED_RESPONSE:${field}`); });
  if (!ENUMS.writer_result.includes(response.result)) throw new Error("UNKNOWN_RESULT");
  const expected = requestEnvelope.request;
  const correlated = response.environment === requestEnvelope.auth.environment && response.intended_issuer === requestEnvelope.auth.issuer && response.request_id === expected.request_id && response.batch_id === expected.batch_id && response.client_id === expected.client_id && response.coverage_epoch_id === expected.coverage_epoch_id && response.source_id === expected.source_id && response.first_source_sequence === expected.first_source_sequence && response.last_source_sequence === expected.last_source_sequence;
  if (!correlated) throw new Error("RESPONSE_CORRELATION_MISMATCH");
  const secret = resolveKey({ environment: response.environment, intended_issuer: response.intended_issuer, source_id: response.source_id, response_key_id: response.response_key_id });
  if (!secret) throw new Error("RESPONSE_KEY_NOT_AUTHORIZED");
  const expectedHash = sha256Hex(responseFactHashObject(response));
  if (!safeEqual(response.response_fact_hash, expectedHash)) throw new Error("RESPONSE_FACT_HASH_MISMATCH");
  const expectedSignature = base64UrlHmac(secret, responseSigningObject(response));
  if (!safeEqual(response.response_signature, expectedSignature)) throw new Error("INVALID_RESPONSE_SIGNATURE");
  return true;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

module.exports = { base64UrlHmac, requestSigningObject, signRequest, responseFactHashObject, responseSigningObject, verifyResponse };
