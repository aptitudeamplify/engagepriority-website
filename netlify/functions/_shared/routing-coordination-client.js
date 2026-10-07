const { randomUUID } = require("crypto");
const {
  CONTRACTS,
  canonicalJson,
  fingerprint,
  hmacHex,
  normalizeTimestamp,
  requestSigningProjection,
  safeEqualHex
} = require("./routing-coordination-contract");

const REQUIRED_CONFIG = Object.freeze([
  "endpoint", "environment", "issuer", "requestKeyId", "requestSecret",
  "responseKeyId", "responseSecret"
]);

// Dormant source contract only. A later activation gate must provision:
// EP_ROUTING_COORDINATION_ENDPOINT, EP_ROUTING_COORDINATION_ENVIRONMENT,
// EP_ROUTING_COORDINATION_ISSUER, EP_ROUTING_COORDINATION_REQUEST_KEY_ID,
// EP_ROUTING_COORDINATION_REQUEST_SECRET,
// EP_ROUTING_COORDINATION_RESPONSE_KEY_ID, and
// EP_ROUTING_COORDINATION_RESPONSE_SECRET.

function loadRoutingCoordinationConfig(env = process.env) {
  const config = {
    endpoint: String(env.EP_ROUTING_COORDINATION_ENDPOINT || "").trim(),
    environment: String(env.EP_ROUTING_COORDINATION_ENVIRONMENT || "").trim(),
    issuer: String(env.EP_ROUTING_COORDINATION_ISSUER || "").trim(),
    requestKeyId: String(env.EP_ROUTING_COORDINATION_REQUEST_KEY_ID || "").trim(),
    requestSecret: String(env.EP_ROUTING_COORDINATION_REQUEST_SECRET || ""),
    responseKeyId: String(env.EP_ROUTING_COORDINATION_RESPONSE_KEY_ID || "").trim(),
    responseSecret: String(env.EP_ROUTING_COORDINATION_RESPONSE_SECRET || "")
  };
  const missing = REQUIRED_CONFIG.filter(key => !config[key]);
  if (missing.length) throw new Error(`Routing coordination configuration is incomplete: ${missing.join(", ")}`);
  let endpoint;
  try { endpoint = new URL(config.endpoint); } catch { throw new Error("Routing coordination endpoint is invalid."); }
  if (endpoint.protocol !== "https:") throw new Error("Routing coordination endpoint must use HTTPS.");
  return config;
}

function createAuthenticatedEnvelope(request, config, { now = new Date(), nonce = randomUUID(), lifetimeSeconds = 120 } = {}) {
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > 300) {
    throw new Error("Routing coordination authentication lifetime must be between 1 and 300 seconds.");
  }
  const issued = new Date(now);
  if (!Number.isFinite(issued.getTime())) throw new Error("Authentication issue time is invalid.");
  const auth = {
    algorithm: "HMAC-SHA256",
    issuer: config.issuer,
    key_id: config.requestKeyId,
    nonce,
    issued_ts_utc: issued.toISOString(),
    expires_ts_utc: new Date(issued.getTime() + lifetimeSeconds * 1000).toISOString()
  };
  auth.signature = hmacHex(config.requestSecret, requestSigningProjection(request, auth));
  return { auth, request };
}

function verifyCoordinatorResponse(response, request, config) {
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("Coordinator response is malformed.");
  if (response.response_contract !== CONTRACTS.responseSigning) throw new Error("Coordinator response contract mismatch.");
  if (response.environment !== request.environment || response.environment !== config.environment) throw new Error("Coordinator response environment mismatch.");
  if (response.action_contract !== request.action_contract) throw new Error("Coordinator response action mismatch.");
  if (response.key_id !== config.responseKeyId) throw new Error("Coordinator response key mismatch.");
  if (response.request_identity !== request.request_fingerprint) throw new Error("Coordinator response request identity mismatch.");
  if (response.routing_commit_id !== request.routing_commit_id) throw new Error("Coordinator response commit ID mismatch.");
  normalizeTimestamp(response.issued_ts_utc, "response issued_ts_utc");
  if (response.result_fingerprint !== fingerprint(response.result_payload)) throw new Error("Coordinator response payload fingerprint mismatch.");
  const signature = response.signature;
  const signed = { ...response };
  delete signed.signature;
  const expected = hmacHex(config.responseSecret, signed);
  if (!safeEqualHex(signature, expected)) throw new Error("Coordinator response signature mismatch.");
  return response;
}

function createRoutingCoordinationClient({ config = loadRoutingCoordinationConfig(), fetchImpl = global.fetch, now, nonce } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");
  async function commit(request) {
    if (request.environment !== config.environment) throw new Error("Routing request environment does not match client configuration.");
    const envelope = createAuthenticatedEnvelope(request, config, {
      now: now ? now() : new Date(),
      nonce: nonce ? nonce() : randomUUID()
    });
    let response;
    try {
      response = await fetchImpl(config.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: canonicalJson(envelope)
      });
    } catch (error) {
      const ambiguous = new Error(`Routing coordinator transport failure: ${error.message}`);
      ambiguous.code = "ROUTING_COORDINATOR_AMBIGUOUS";
      ambiguous.cause = error;
      throw ambiguous;
    }
    let payload;
    try { payload = await response.json(); } catch (error) {
      const ambiguous = new Error("Routing coordinator returned a malformed response.");
      ambiguous.code = "ROUTING_COORDINATOR_AMBIGUOUS";
      ambiguous.cause = error;
      throw ambiguous;
    }
    // A signed response is authoritative regardless of HTTP transport status.
    return verifyCoordinatorResponse(payload, request, config);
  }
  return { commit, config: { ...config, requestSecret: undefined, responseSecret: undefined } };
}

module.exports = {
  createAuthenticatedEnvelope,
  createRoutingCoordinationClient,
  loadRoutingCoordinationConfig,
  verifyCoordinatorResponse
};
