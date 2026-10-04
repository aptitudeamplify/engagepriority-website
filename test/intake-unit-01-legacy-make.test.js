const test = require("node:test");
const assert = require("node:assert/strict");

process.env.MAKE_INTAKE_HANDOFF_WEBHOOK_URL = "https://example.invalid/make-intake";
process.env.GOOGLE_SERVICE_ACCOUNT = "{}";

const intake = require("../netlify/functions/intake-lead");

function legacyRecord() {
  return {
    event_type: "NETLIFY_INTAKE_COMPLETED",
    trace_id: "TRACE-LEGACY",
    lead_id: "LEAD-LEGACY",
    client_id: "CLIENT-1",
    assigned_agent_id: "AGENT-1",
    source_system: "WEBSITE",
    source_detail: "pilot-form",
    submitted_ts_utc: "2026-09-30T10:00:02.000Z",
    created_ts_utc: "2026-09-30T10:00:02.000Z",
    assignment_ts_utc: "2026-09-30T10:00:02.000Z",
    leadlog_created: true,
    action_link_count: 3,
    reminder_created: true,
    reminder_next_action_type: "REMINDER_1",
    reminder_due_ts_utc: "2026-09-30T10:15:01.000Z",
    sms_status: "ATTEMPTED",
    sms_sent_ts_utc: "",
    sms_error_code: "SMS disabled",
    sms_error_message: "SMS disabled",
    status: "INTAKE_COMPLETED",
    lead_preview_full_name: "Synthetic Person",
    lead_preview_phone_last4: "0101",
    lead_preview_email: "synthetic@example.invalid"
  };
}

test("Legacy Make regression preserves the established request contract", async () => {
  let request;
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200 };
  };

  try {
    const result = await intake._test.runLegacyMakeIntakeHandoff(legacyRecord());
    assert.equal(result.status, "LEGACY_MAKE_SUBMITTED");
    assert.equal(request.url, "https://example.invalid/make-intake");
    assert.equal(request.options.method, "POST");
    assert.equal(request.options.headers["content-type"], "application/json");
    const payload = JSON.parse(request.options.body);
    assert.equal(payload.action_link_count, 3);
    assert.equal(payload.sms_status, "ATTEMPTED");
    assert.deepEqual(payload.lead_preview, {
      full_name: "Synthetic Person",
      phone_last4: "0101",
      email: "synthetic@example.invalid"
    });
    assert.equal(payload.created_ts_utc, "2026-09-30T10:00:02.000Z");
    assert.equal(payload.lifecycle_id, "");
    assert.equal(payload.assignment_id, "");
  } finally {
    global.fetch = originalFetch;
  }
});

test("Legacy Make intake accepts additive lifecycle identity context", async () => {
  let payload;
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, status: 200 };
  };
  try {
    const result = await intake._test.runLegacyMakeIntakeHandoff({
      ...legacyRecord(),
      lifecycle_id: "LEAD-LEGACY",
      assignment_id: "as_assignment-1",
      assignment_sequence: 1,
      owner_epoch_id: "oe_owner-1",
      agent_id_snapshot: "AGENT-1",
      policy_snapshot_id: "ps_policy-1"
    });
    assert.equal(result.status, "LEGACY_MAKE_SUBMITTED");
    assert.equal(payload.lifecycle_id, "LEAD-LEGACY");
    assert.equal(payload.assignment_sequence, 1);
    assert.equal(payload.agent_id_snapshot, "AGENT-1");
  } finally {
    global.fetch = originalFetch;
  }
});

test("Legacy Make regression makes non-2xx response observable without failing core intake", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503 });
  try {
    const result = await intake._test.runLegacyMakeIntakeHandoff(legacyRecord());
    assert.equal(result.core_intake_status, "COMMITTED");
    assert.equal(result.error.code, "LEGACY_MAKE_HTTP_503");
    assert.equal(result.repair_required, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Legacy Make regression makes network failure observable without failing core intake", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("network unavailable");
  };
  try {
    const result = await intake._test.runLegacyMakeIntakeHandoff(legacyRecord());
    assert.equal(result.core_intake_status, "COMMITTED");
    assert.equal(result.error.code, "LEGACY_MAKE_SUBMISSION_FAILED");
    assert.equal(result.repair_required, true);
  } finally {
    global.fetch = originalFetch;
  }
});
