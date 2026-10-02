const test = require("node:test");
const assert = require("node:assert/strict");

process.env.EP_INTAKE_PROJECTION_MODE = "NETLIFY_DIRECT";
delete process.env.EP_NETLIFY_INTAKE_AUDIT_SPREADSHEET_ID;
process.env.GOOGLE_SERVICE_ACCOUNT = "{}";

const intake = require("../netlify/functions/intake-lead");

test("U01-015 missing audit destination does not prevent required lifecycle projection", async () => {
  const lifecycleRows = [];
  const sheets = {
    spreadsheets: {
      values: {
        async get({ range }) {
          assert.match(range, /^LeadLifecycleLog!/);
          return {
            data: {
              values: [
                [
                  "event_id", "event_ts_utc", "client_id", "lead_id", "trace_id",
                  "event_type", "event_stage", "event_source", "assigned_agent_id",
                  "gateway_context", "selected_action", "notes"
                ],
                ...lifecycleRows
              ]
            }
          };
        },
        async append({ range, requestBody }) {
          assert.match(range, /^LeadLifecycleLog!/);
          lifecycleRows.push(requestBody.values[0]);
          return { data: {} };
        }
      }
    }
  };
  const obligationStore = {
    async get() { return null; },
    async set() {},
    async delete() {
      assert.fail("repair-required obligation must not be deleted");
    }
  };
  const committedIntake = intake._test.buildDirectCommittedIntake({
    leadPayload: {
      submitted_ts_utc: "2026-09-30T10:00:00.000Z",
      full_name: "Synthetic Person",
      phone: "+12815550101",
      email: "synthetic@example.invalid"
    },
    trace_id: "TRACE-NO-AUDIT",
    lead_id: "LEAD-NO-AUDIT",
    client_id: "CLIENT-1",
    assigned_agent_id: "AGENT-1",
    source_system: "WEBSITE",
    source_detail: "pilot-form",
    created_ts_utc: "2026-09-30T10:00:01.000Z",
    assignment_ts_utc: "2026-09-30T10:00:01.000Z",
    reminder_due_ts_utc: "2026-09-30T10:15:01.000Z",
    sms_status: "NOT_ATTEMPTED"
  });

  const result = await intake._test.runDirectIntakeProjection({
    sheets,
    committedIntake,
    leadDataSpreadsheetId: "LEAD-SHEET",
    obligationStore
  });

  assert.equal(result.core_intake_status, "COMMITTED");
  assert.equal(result.lifecycle.status, "COMMITTED");
  assert.equal(result.audit.status, "REPAIR_REQUIRED");
  assert.equal(result.audit.error.code, "AUDIT_STORE_NOT_CONFIGURED");
  assert.equal(result.repair_required, true);
  assert.equal(lifecycleRows.length, 1);
});

test("legacy Make mode classifies an absent webhook without throwing", async () => {
  const result = await intake._test.runLegacyMakeIntakeHandoff({});
  assert.equal(result.core_intake_status, "COMMITTED");
  assert.equal(result.status, "PROJECTION_REPAIR_REQUIRED");
  assert.equal(result.error.code, "LEGACY_MAKE_WEBHOOK_NOT_CONFIGURED");
});

test("repair-marker write failure remains isolated from the committed intake result", async () => {
  const sheets = {
    spreadsheets: {
      values: {
        async append() {
          const error = new Error("Sheets unavailable");
          error.status = 503;
          throw error;
        }
      }
    }
  };

  await assert.doesNotReject(() => intake._test.recordProjectionRepairEvent({
    sheets,
    centralRegistrySpreadsheetId: "UAT-CENTRAL-REGISTRY",
    client_id: "CLIENT-1",
    lead_id: "LEAD-1",
    trace_id: "TRACE-1",
    result: {
      core_intake_status: "COMMITTED",
      repair_required: true,
      error: { code: "AUDIT_STORE_NOT_CONFIGURED" }
    }
  }));
});
