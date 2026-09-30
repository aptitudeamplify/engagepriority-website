const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildIntakeAuditRecord,
  buildIntakeLifecycleEvent,
  deriveIntakeLifecycleEventId,
  projectCommittedIntake,
  withBoundedRetry
} = require("../netlify/functions/_shared/intake-post-commit-projection");

function committedIntake(overrides = {}) {
  return {
    intake_commit_id: "IC-001",
    trace_id: "TRACE-001",
    lead_id: "LEAD-001",
    client_id: "CLIENT-001",
    assigned_agent_id: "AGENT-001",
    source_system: "WEBSITE",
    source_detail: "landing-page",
    submitted_ts_utc: "2026-09-29T12:00:00.000Z",
    created_ts_utc: "2026-09-29T12:00:01.000Z",
    assignment_ts_utc: "2026-09-29T12:00:01.000Z",
    action_link_count: 3,
    reminder_created: true,
    reminder_next_action_type: "REMINDER_1",
    reminder_due_ts_utc: "2026-09-29T12:15:01.000Z",
    sms_status: "ATTEMPTED",
    sms_sent_ts_utc: "2026-09-29T12:00:02.000Z",
    sms_error_code: "",
    sms_error_message: "",
    status: "INTAKE_COMPLETED",
    lead_preview_full_name: "Synthetic Lead",
    lead_preview_phone_last4: "0101",
    lead_preview_email: "synthetic@example.invalid",
    ...overrides
  };
}

function memoryStores({ lifecycle = [], audit = [] } = {}) {
  return {
    lifecycle,
    audit,
    lifecycleStore: {
      async findByEventId(eventId) {
        return lifecycle.find(record => record.event_id === eventId) || null;
      },
      async append(record) {
        lifecycle.push({ ...record });
      }
    },
    auditStore: {
      async findByLogicalIdentity(record) {
        return audit.find(candidate =>
          candidate.event_type === record.event_type &&
          candidate.trace_id === record.trace_id &&
          candidate.lead_id === record.lead_id
        ) || null;
      },
      async append(record) {
        audit.push({ ...record });
      }
    }
  };
}

test("U01-001 fresh committed intake writes one lifecycle event and one audit row", async () => {
  const stores = memoryStores();
  const result = await projectCommittedIntake({
    committedIntake: committedIntake(),
    lifecycleStore: stores.lifecycleStore,
    auditStore: stores.auditStore
  });

  assert.equal(result.status, "PROJECTION_COMMITTED");
  assert.equal(result.repair_required, false);
  assert.equal(stores.lifecycle.length, 1);
  assert.equal(stores.audit.length, 1);
});

test("U01-002 replay performs no duplicate append", async () => {
  const stores = memoryStores();
  const args = {
    committedIntake: committedIntake(),
    lifecycleStore: stores.lifecycleStore,
    auditStore: stores.auditStore
  };

  await projectCommittedIntake(args);
  const replay = await projectCommittedIntake(args);

  assert.equal(replay.status, "PROJECTION_ALREADY_COMMITTED");
  assert.equal(stores.lifecycle.length, 1);
  assert.equal(stores.audit.length, 1);
});

test("U01-003 durable intake commit identity yields a stable event id", () => {
  const first = deriveIntakeLifecycleEventId(committedIntake());
  const second = deriveIntakeLifecycleEventId(
    committedIntake({ trace_id: "A-DIFFERENT-TRACE" })
  );
  assert.equal(first, second);
});

test("U01-004 legacy identity tuple yields a stable event id", () => {
  const input = committedIntake({ intake_commit_id: "" });
  assert.equal(
    deriveIntakeLifecycleEventId(input),
    deriveIntakeLifecycleEventId({ ...input })
  );
});

test("U01-005 lifecycle event uses accepted intake semantics", () => {
  const event = buildIntakeLifecycleEvent(committedIntake());
  assert.deepEqual(
    {
      type: event.event_type,
      stage: event.event_stage,
      source: event.event_source,
      gateway: event.gateway_context,
      action: event.selected_action
    },
    {
      type: "NETLIFY_INTAKE_COMPLETED",
      stage: "NEW_LEAD_RECEIVED",
      source: "NETLIFY_INTAKE_LEAD",
      gateway: "INITIAL_RESPONSE_GATEWAY",
      action: "NEW_LEAD_SUBMITTED"
    }
  );
});

test("U01-006 audit projection preserves the complete 24-field disposition", () => {
  const audit = buildIntakeAuditRecord(committedIntake());
  assert.deepEqual(Object.keys(audit), [
    "event_type",
    "trace_id",
    "lead_id",
    "client_id",
    "assigned_agent_id",
    "source_system",
    "source_detail",
    "submitted_ts_utc",
    "created_ts_utc",
    "assignment_ts_utc",
    "leadlog_created",
    "action_link_count",
    "reminder_created",
    "reminder_next_action_type",
    "reminder_due_ts_utc",
    "sms_status",
    "sms_sent_ts_utc",
    "sms_error_code",
    "sms_error_message",
    "status",
    "lead_preview_full_name",
    "lead_preview_phone_last4",
    "lead_preview_email",
    "ingested_by_make_ts_utc"
  ]);
});

test("U01-007 projection does not mutate committed intake facts", async () => {
  const input = Object.freeze(committedIntake());
  const before = JSON.stringify(input);
  const stores = memoryStores();
  await projectCommittedIntake({
    committedIntake: input,
    lifecycleStore: stores.lifecycleStore,
    auditStore: stores.auditStore
  });
  assert.equal(JSON.stringify(input), before);
});

test("U01-008 missing durable identity fails closed before writes", async () => {
  const stores = memoryStores();
  await assert.rejects(
    projectCommittedIntake({
      committedIntake: committedIntake({ lead_id: "" }),
      lifecycleStore: stores.lifecycleStore,
      auditStore: stores.auditStore
    }),
    error => error.code === "INVALID_COMMITTED_INTAKE"
  );
  assert.equal(stores.lifecycle.length, 0);
  assert.equal(stores.audit.length, 0);
});

test("U01-009 transient reads retry and then succeed", async () => {
  let attempts = 0;
  const value = await withBoundedRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("temporarily unavailable");
        error.status = 503;
        throw error;
      }
      return "ok";
    },
    { maxRetries: 2, sleepFn: async () => {} }
  );
  assert.equal(value, "ok");
  assert.equal(attempts, 3);
});

test("U01-010 transient failures stop at the configured retry bound", async () => {
  let attempts = 0;
  await assert.rejects(
    withBoundedRetry(
      async () => {
        attempts += 1;
        const error = new Error("timeout");
        error.status = 503;
        throw error;
      },
      { maxRetries: 2, sleepFn: async () => {} }
    ),
    error => error.projection_attempts === 3
  );
  assert.equal(attempts, 3);
});

test("U01-011 permanent failures are not retried", async () => {
  let attempts = 0;
  await assert.rejects(
    withBoundedRetry(async () => {
      attempts += 1;
      const error = new Error("invalid schema");
      error.status = 400;
      throw error;
    }),
    error => error.projection_attempts === 1
  );
  assert.equal(attempts, 1);
});

test("U01-012 lifecycle failure records repair state and does not write audit", async () => {
  let auditWrites = 0;
  const result = await projectCommittedIntake({
    committedIntake: committedIntake(),
    lifecycleStore: {
      async findByEventId() { return null; },
      async append() {
        const error = new Error("invalid schema");
        error.status = 400;
        throw error;
      }
    },
    auditStore: {
      async findByLogicalIdentity() { return null; },
      async append() { auditWrites += 1; }
    }
  });
  assert.equal(result.lifecycle.status, "REPAIR_REQUIRED");
  assert.equal(result.repair_required, true);
  assert.equal(auditWrites, 0);
});

test("U01-013 audit failure preserves committed lifecycle and records repair state", async () => {
  const stores = memoryStores();
  stores.auditStore.append = async () => {
    const error = new Error("invalid audit schema");
    error.status = 400;
    throw error;
  };
  const result = await projectCommittedIntake({
    committedIntake: committedIntake(),
    lifecycleStore: stores.lifecycleStore,
    auditStore: stores.auditStore
  });
  assert.equal(result.lifecycle.status, "COMMITTED");
  assert.equal(result.audit.status, "REPAIR_REQUIRED");
  assert.equal(result.core_intake_status, "COMMITTED");
});

test("U01-014 replay repairs only the missing audit projection", async () => {
  const input = committedIntake();
  const event = buildIntakeLifecycleEvent(input);
  const stores = memoryStores({ lifecycle: [event] });
  const result = await projectCommittedIntake({
    committedIntake: input,
    lifecycleStore: stores.lifecycleStore,
    auditStore: stores.auditStore
  });
  assert.equal(result.lifecycle.status, "ALREADY_COMMITTED");
  assert.equal(result.audit.status, "COMMITTED");
  assert.equal(stores.lifecycle.length, 1);
  assert.equal(stores.audit.length, 1);
});

test("U01-015 missing required audit store fails safely after lifecycle", async () => {
  const stores = memoryStores();
  const result = await projectCommittedIntake({
    committedIntake: committedIntake(),
    lifecycleStore: stores.lifecycleStore,
    auditStore: null
  });
  assert.equal(result.core_intake_status, "COMMITTED");
  assert.equal(result.audit.error.code, "AUDIT_STORE_NOT_CONFIGURED");
  assert.equal(result.repair_required, true);
});

test("U01-016 concurrent appends retain one logical lifecycle identity", async () => {
  const lifecycle = [];
  const stores = memoryStores({ lifecycle });
  const input = committedIntake();
  await Promise.all([
    projectCommittedIntake({
      committedIntake: input,
      lifecycleStore: stores.lifecycleStore,
      auditStore: stores.auditStore
    }),
    projectCommittedIntake({
      committedIntake: input,
      lifecycleStore: stores.lifecycleStore,
      auditStore: stores.auditStore
    })
  ]);
  assert.equal(new Set(lifecycle.map(record => record.event_id)).size, 1);
});

test("U01-017 projection accepts only lifecycle and audit store capabilities", async () => {
  const calls = [];
  await projectCommittedIntake({
    committedIntake: committedIntake(),
    lifecycleStore: {
      async findByEventId() { calls.push("lifecycle.find"); return null; },
      async append() { calls.push("lifecycle.append"); }
    },
    auditStore: {
      async findByLogicalIdentity() { calls.push("audit.find"); return null; },
      async append() { calls.push("audit.append"); }
    }
  });
  assert.deepEqual(calls, [
    "lifecycle.find",
    "lifecycle.append",
    "audit.find",
    "audit.append"
  ]);
});

test("U01-018 repository timing harness verifies bounded backoff; real p95 remains UAT evidence", async () => {
  const delays = [];
  let attempts = 0;
  await withBoundedRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("rate limit");
        error.status = 429;
        throw error;
      }
    },
    {
      maxRetries: 2,
      baseDelayMs: 25,
      sleepFn: async delay => { delays.push(delay); }
    }
  );
  assert.deepEqual(delays, [25, 50]);
});

test("rollback guard keeps legacy Make as the default projection mode", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../netlify/functions/intake-lead.js"),
    "utf8"
  );
  assert.match(
    source,
    /process\.env\.EP_INTAKE_PROJECTION_MODE \|\| "LEGACY_MAKE"/
  );
  assert.match(source, /event_type: "INTAKE_PROJECTION_REPAIR_REQUIRED"/);
});
