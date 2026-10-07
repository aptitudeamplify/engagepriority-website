(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.EPInitialIntakeDelivery = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const STORAGE_KEY = "ep.initial-intake-delivery.v1";

  function stableJson(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }

  async function semanticDigest(payload, cryptoImpl) {
    const semantic = { ...payload };
    delete semantic.source_event_id;
    const bytes = new TextEncoder().encode(stableJson(semantic));
    const digest = await cryptoImpl.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function readPending(storage) {
    try {
      const value = JSON.parse(storage.getItem(STORAGE_KEY) || "null");
      return value && value.version === 1 && value.source_event_id && value.semantic_digest ? value : null;
    } catch { return null; }
  }

  async function prepareSubmission(payload, { storage = localStorage, cryptoImpl = crypto } = {}) {
    const digest = await semanticDigest(payload, cryptoImpl);
    const pending = readPending(storage);
    if (pending && pending.semantic_digest === digest) {
      return { ...payload, source_event_id: pending.source_event_id };
    }
    const record = { version: 1, source_event_id: cryptoImpl.randomUUID(), semantic_digest: digest };
    // Persist before the caller is allowed to begin the first HTTP attempt.
    storage.setItem(STORAGE_KEY, JSON.stringify(record));
    return { ...payload, source_event_id: record.source_event_id };
  }

  function recordResult(status, { storage = localStorage } = {}) {
    const definitive = (status >= 200 && status < 400) || (status >= 400 && status < 500 && status !== 408 && status !== 429);
    if (definitive) storage.removeItem(STORAGE_KEY);
    return definitive;
  }

  function abandon({ storage = localStorage } = {}) {
    storage.removeItem(STORAGE_KEY);
  }

  return { STORAGE_KEY, abandon, prepareSubmission, readPending, recordResult, semanticDigest, stableJson };
});
