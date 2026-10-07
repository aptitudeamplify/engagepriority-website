const { getStore } = require("@netlify/blobs");

const STORE_NAME = "ep-routing-coordination-obligations";

function createRoutingCoordinationObligationStore({ store = getStore({ name: STORE_NAME, consistency: "strong" }) } = {}) {
  async function read(key) {
    const result = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
    return result ? { record: result.data, etag: result.etag } : null;
  }
  async function create(key, record) {
    const result = await store.setJSON(key, record, { onlyIfNew: true });
    if (result.modified) return { created: true, record, etag: result.etag };
    const existing = await read(key);
    return { created: false, ...existing };
  }
  async function replace(key, record, etag) {
    const result = await store.setJSON(key, record, { onlyIfMatch: etag });
    if (!result.modified) return { replaced: false, ...(await read(key)) };
    return { replaced: true, record, etag: result.etag };
  }
  return { read, create, replace };
}

module.exports = { STORE_NAME, createRoutingCoordinationObligationStore };
