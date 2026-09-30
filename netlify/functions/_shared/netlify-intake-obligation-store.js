const STORE_NAME = "ep-intake-projection-obligations";

async function createNetlifyIntakeObligationStore() {
  const { getStore } = await import("@netlify/blobs");
  const store = getStore({ name: STORE_NAME, consistency: "strong" });

  return {
    async get(eventId) {
      return store.get(eventId, { type: "json" });
    },
    async set(eventId, obligation) {
      await store.setJSON(eventId, obligation);
    },
    async delete(eventId) {
      await store.delete(eventId);
    }
  };
}

module.exports = {
  STORE_NAME,
  createNetlifyIntakeObligationStore
};
