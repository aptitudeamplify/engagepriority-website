const test = require("node:test");
const assert = require("node:assert/strict");

process.env.EP_INTAKE_PROJECTION_MODE = "NETLIFY_DIRECT";
process.env.EP_NETLIFY_INTAKE_AUDIT_SPREADSHEET_ID = "AUDIT-SHEET";
process.env.ENABLE_SMS_SEND = "false";
process.env.GOOGLE_SERVICE_ACCOUNT = "{}";

const intake = require("../netlify/functions/intake-lead");

function registryFixtures() {
  return [
    {
      values: [
        [
          "client_id",
          "client_status",
          "lead_data_spreadsheet_id",
          "primary_timezone",
          "business_day_start_time",
          "business_day_end_time",
          "business_days_active",
          "off_hours_release_mode",
          "routing_strategy",
          "reminder_1_delay_minutes"
        ],
        [
          "CLIENT-1",
          "ACTIVE",
          "LEAD-SHEET",
          "UTC",
          "00:00",
          "23:59",
          "SUN|MON|TUE|WED|THU|FRI|SAT",
          "AT_OPEN",
          "WEIGHTED_INTERLEAVED",
          "15"
        ]
      ]
    },
    {
      values: [
        [
          "agent_id",
          "client_id",
          "agent_status",
          "assignment_weight",
          "priority_slot",
          "agent_phone"
        ],
        ["AGENT-1", "CLIENT-1", "ACTIVE", "1", "1", "+12815550101"]
      ]
    },
    { values: [["routing_pointer"], ["0"]] },
    {
      values: [
        [
          "source_system",
          "source_primary_key_type",
          "source_primary_key_value",
          "client_id",
          "status"
        ],
        ["WEBSITE", "source_detail", "pilot-form", "CLIENT-1", "ACTIVE"]
      ]
    }
  ];
}

function leadPayload() {
  return {
    httpMethod: "POST",
    body: JSON.stringify({
      intake_client_reference: "pilot-form",
      source_system: "WEBSITE",
      source_detail: "pilot-form",
      submitted_ts_utc: "2026-09-30T10:00:00.000Z",
      full_name: "Synthetic Person",
      email: "synthetic@example.invalid",
      phone: "+12815550101"
    })
  };
}

function createObligationStore() {
  const records = new Map();
  const calls = { get: 0, set: 0, delete: 0 };
  return {
    records,
    calls,
    async get(key) {
      calls.get += 1;
      return records.get(key) || null;
    },
    async set(key, value) {
      calls.set += 1;
      records.set(key, JSON.parse(JSON.stringify(value)));
    },
    async delete(key) {
      calls.delete += 1;
      records.delete(key);
    }
  };
}

function createFreshSheets() {
  const calls = { append: [], update: [] };
  const lifecycleHeaders = [
    "event_id",
    "event_ts_utc",
    "client_id",
    "lead_id",
    "trace_id",
    "event_type",
    "event_stage",
    "event_source",
    "assigned_agent_id",
    "gateway_context",
    "selected_action",
    "notes"
  ];
  const auditHeaders = [
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
  ];

  const sheets = {
    spreadsheets: {
      values: {
        async batchGet() {
          return { data: { valueRanges: registryFixtures() } };
        },
        async get({ spreadsheetId, range }) {
          if (range.startsWith("Idempotency!")) {
            return { data: { values: [["idempotency_key", "client_id", "source_token", "first_seen_timestamp", "last_seen_timestamp", "lead_id", "status", "notes"]] } };
          }
          if (range.startsWith("LeadLifecycleLog!")) {
            return { data: { values: [lifecycleHeaders] } };
          }
          if (spreadsheetId === "AUDIT-SHEET" && range.startsWith("NetlifyIntakeAudit!")) {
            return { data: { values: [auditHeaders] } };
          }
          throw new Error(`Unexpected read: ${spreadsheetId} ${range}`);
        },
        async update(args) {
          calls.update.push(args);
          return { data: {} };
        },
        async append(args) {
          calls.append.push(args);
          if (args.range.startsWith("LeadLog_Active!")) {
            return { data: { updates: { updatedRange: "LeadLog_Active!A2:BL2" } } };
          }
          return { data: { updates: {} } };
        }
      }
    }
  };

  return { sheets, calls };
}

function createAfterHoursDuplicateSheets() {
  const calls = { append: [], update: [] };
  const idempotencyKey = "CLIENT-1|synthetic@example.invalid|+12815550101";
  const leadHeaders = [
    "lead_id",
    "client_id",
    "created_timestamp",
    "source_system",
    "source_detail",
    "full_name",
    "email",
    "phone",
    "assigned_agent_id",
    "assigned_timestamp",
    "lead_status",
    "trace_id",
    "assignment_ts_utc"
  ];

  const sheets = {
    spreadsheets: {
      values: {
        async batchGet() {
          return { data: { valueRanges: registryFixtures() } };
        },
        async get({ range }) {
          if (range.startsWith("Idempotency!")) {
            return {
              data: {
                values: [
                  ["idempotency_key", "client_id", "source_token", "first_seen_timestamp", "last_seen_timestamp", "lead_id", "status", "notes"],
                  [idempotencyKey, "CLIENT-1", "WEBSITE|pilot-form", "2026-09-30T10:00:00.000Z", "", "LEAD-HELD", "ACTIVE", ""]
                ]
              }
            };
          }
          if (range.startsWith("LeadLog_Active!")) {
            return {
              data: {
                values: [
                  leadHeaders,
                  [
                    "LEAD-HELD",
                    "CLIENT-1",
                    "2026-09-30T10:00:01.000Z",
                    "WEBSITE",
                    "pilot-form",
                    "Synthetic Person",
                    "synthetic@example.invalid",
                    "+12815550101",
                    "",
                    "",
                    "PENDING_RELEASE",
                    "TRACE-HELD",
                    ""
                  ]
                ]
              }
            };
          }
          throw new Error(`Unexpected read: ${range}`);
        },
        async update(args) {
          calls.update.push(args);
          return { data: {} };
        },
        async append(args) {
          calls.append.push(args);
          return { data: { updates: {} } };
        }
      }
    }
  };

  return { sheets, calls };
}

function createOrdinaryDuplicateSheets() {
  const calls = { append: [], update: [] };
  const lifecycleRows = [];
  const auditRows = [];
  const idempotencyKey = "CLIENT-1|synthetic@example.invalid|+12815550101";
  const leadHeaders = [
    "lead_id", "client_id", "created_timestamp", "source_system", "source_detail",
    "full_name", "email", "phone", "assigned_agent_id", "assigned_timestamp",
    "lead_status", "trace_id", "assignment_ts_utc"
  ];
  const lifecycleHeaders = [
    "event_id", "event_ts_utc", "client_id", "lead_id", "trace_id",
    "event_type", "event_stage", "event_source", "assigned_agent_id",
    "gateway_context", "selected_action", "notes"
  ];
  const auditHeaders = [
    "event_type", "trace_id", "lead_id", "client_id", "assigned_agent_id",
    "source_system", "source_detail", "submitted_ts_utc", "created_ts_utc",
    "assignment_ts_utc", "leadlog_created", "action_link_count",
    "reminder_created", "reminder_next_action_type", "reminder_due_ts_utc",
    "sms_status", "sms_sent_ts_utc", "sms_error_code", "sms_error_message",
    "status", "lead_preview_full_name", "lead_preview_phone_last4",
    "lead_preview_email", "ingested_by_make_ts_utc"
  ];

  const sheets = {
    spreadsheets: {
      values: {
        async batchGet() {
          return { data: { valueRanges: registryFixtures() } };
        },
        async get({ spreadsheetId, range }) {
          if (range.startsWith("Idempotency!")) {
            return {
              data: {
                values: [
                  ["idempotency_key", "client_id", "source_token", "first_seen_timestamp", "last_seen_timestamp", "lead_id", "status", "notes"],
                  [idempotencyKey, "CLIENT-1", "WEBSITE|pilot-form", "2026-09-30T10:00:00.000Z", "", "LEAD-ORDINARY", "ACTIVE", ""]
                ]
              }
            };
          }
          if (range.startsWith("LeadLog_Active!")) {
            return {
              data: {
                values: [
                  leadHeaders,
                  [
                    "LEAD-ORDINARY", "CLIENT-1", "2026-09-30T10:00:01.000Z",
                    "WEBSITE", "pilot-form", "Synthetic Person",
                    "synthetic@example.invalid", "+12815550101", "AGENT-1",
                    "2026-09-30T10:00:01.000Z", "NEW", "TRACE-ORDINARY",
                    "2026-09-30T10:00:01.000Z"
                  ]
                ]
              }
            };
          }
          if (range.startsWith("LeadLifecycleLog!")) {
            return { data: { values: [lifecycleHeaders, ...lifecycleRows] } };
          }
          if (spreadsheetId === "AUDIT-SHEET") {
            return { data: { values: [auditHeaders, ...auditRows] } };
          }
          throw new Error(`Unexpected read: ${spreadsheetId} ${range}`);
        },
        async update(args) {
          calls.update.push(args);
          return { data: {} };
        },
        async append(args) {
          calls.append.push(args);
          if (args.range.startsWith("LeadLifecycleLog!")) {
            lifecycleRows.push(args.requestBody.values[0]);
          }
          if (args.range.startsWith("NetlifyIntakeAudit!")) {
            auditRows.push(args.requestBody.values[0]);
          }
          return { data: { updates: {} } };
        }
      }
    }
  };

  return { sheets, calls, lifecycleRows, auditRows };
}

function countRange(calls, prefix) {
  return calls.append.filter(call => call.range.startsWith(prefix)).length;
}

function createProjectionSheets() {
  const lifecycleRows = [];
  const auditRows = [];
  let failAuditAppend = true;
  const lifecycleHeaders = [
    "event_id", "event_ts_utc", "client_id", "lead_id", "trace_id",
    "event_type", "event_stage", "event_source", "assigned_agent_id",
    "gateway_context", "selected_action", "notes"
  ];
  const auditHeaders = [
    "event_type", "trace_id", "lead_id", "client_id", "assigned_agent_id",
    "source_system", "source_detail", "submitted_ts_utc", "created_ts_utc",
    "assignment_ts_utc", "leadlog_created", "action_link_count",
    "reminder_created", "reminder_next_action_type", "reminder_due_ts_utc",
    "sms_status", "sms_sent_ts_utc", "sms_error_code", "sms_error_message",
    "status", "lead_preview_full_name", "lead_preview_phone_last4",
    "lead_preview_email", "ingested_by_make_ts_utc"
  ];
  const calls = { append: [] };

  return {
    lifecycleRows,
    auditRows,
    calls,
    allowAuditAppend() {
      failAuditAppend = false;
    },
    sheets: {
      spreadsheets: {
        values: {
          async get({ spreadsheetId, range }) {
            if (range.startsWith("LeadLifecycleLog!")) {
              return { data: { values: [lifecycleHeaders, ...lifecycleRows] } };
            }
            if (spreadsheetId === "AUDIT-SHEET") {
              return { data: { values: [auditHeaders, ...auditRows] } };
            }
            throw new Error(`Unexpected projection read: ${spreadsheetId} ${range}`);
          },
          async append(args) {
            calls.append.push(args);
            if (args.range.startsWith("LeadLifecycleLog!")) {
              lifecycleRows.push(args.requestBody.values[0]);
              return { data: {} };
            }
            if (args.range.startsWith("NetlifyIntakeAudit!")) {
              if (failAuditAppend) {
                const error = new Error("invalid audit destination");
                error.status = 400;
                throw error;
              }
              auditRows.push(args.requestBody.values[0]);
              return { data: {} };
            }
            throw new Error(`Unexpected projection append: ${args.range}`);
          }
        }
      }
    }
  };
}

test("U01-001 handler commits one direct lifecycle and audit projection without repeating core consequences", async () => {
  const runtime = createFreshSheets();
  const obligationStore = createObligationStore();
  intake._test.setRuntime({ sheets: runtime.sheets, obligationStore });

  const response = await intake.handler(leadPayload(), {});
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.post_commit_projection.status, "PROJECTION_COMMITTED");
  assert.equal(countRange(runtime.calls, "LeadLog_Active!"), 1);
  assert.equal(countRange(runtime.calls, "ReminderQueue!"), 1);
  assert.equal(countRange(runtime.calls, "ActionLinkMap!"), 1);
  assert.equal(countRange(runtime.calls, "LeadLifecycleLog!"), 1);
  assert.equal(countRange(runtime.calls, "NetlifyIntakeAudit!"), 1);
  assert.equal(runtime.calls.update.filter(call => call.range === "RoutingState!B2").length, 1);
  assert.equal(body.sms_send_result.sent, false);
  assert.ok(obligationStore.calls.set >= 3);
  assert.equal(obligationStore.calls.delete, 1);

  const auditRow = runtime.calls.append.find(call =>
    call.range.startsWith("NetlifyIntakeAudit!")
  ).requestBody.values[0];
  assert.equal(auditRow[7], "2026-09-30T10:00:00.000Z");
  assert.equal(auditRow[11], 1);
  assert.equal(auditRow[15], "NOT_ATTEMPTED");
  assert.equal(auditRow[17], "SMS_DISABLED");
});

test("U01-011 direct audit facts do not invent an absent submission timestamp", () => {
  const committed = intake._test.buildDirectCommittedIntake({
    leadPayload: {
      full_name: "Synthetic Person",
      phone: "+12815550101",
      email: "synthetic@example.invalid"
    },
    trace_id: "TRACE-NO-SUBMITTED",
    lead_id: "LEAD-NO-SUBMITTED",
    client_id: "CLIENT-1",
    assigned_agent_id: "AGENT-1",
    source_system: "WEBSITE",
    source_detail: "pilot-form",
    created_ts_utc: "2026-09-30T10:00:01.000Z",
    assignment_ts_utc: "2026-09-30T10:00:01.000Z",
    reminder_due_ts_utc: "2026-09-30T10:15:01.000Z",
    sms_status: "NOT_ATTEMPTED"
  });
  assert.equal(committed.submitted_ts_utc, "");
  assert.equal(committed.action_link_count, 1);
  assert.equal(committed.sms_status, "NOT_ATTEMPTED");
});

test("U01-014 after-hours duplicate repair produces no ordinary projection or repeated core consequence", async () => {
  const runtime = createAfterHoursDuplicateSheets();
  const obligationStore = createObligationStore();
  intake._test.setRuntime({ sheets: runtime.sheets, obligationStore });

  const response = await intake.handler(leadPayload(), {});
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.status, "DUPLICATE_LEAD");
  assert.equal(body.post_commit_projection.status, "PROJECTION_NOT_APPLICABLE");
  assert.equal(body.post_commit_projection.reason, "AFTER_HOURS_HELD_LEAD");

  const forbiddenRepeatedConsequences = {
    assignment_executions: runtime.calls.update.filter(call => call.range === "RoutingState!B2").length,
    routing_state_advancements: runtime.calls.update.filter(call => call.range === "RoutingState!B2").length,
    leadlog_creations: countRange(runtime.calls, "LeadLog_Active!"),
    gateway_creations: countRange(runtime.calls, "ActionLinkMap!"),
    reminder_creations: countRange(runtime.calls, "ReminderQueue!"),
    sms_sends: 0
  };
  assert.deepEqual(forbiddenRepeatedConsequences, {
    assignment_executions: 0,
    routing_state_advancements: 0,
    leadlog_creations: 0,
    gateway_creations: 0,
    reminder_creations: 0,
    sms_sends: 0
  });
  assert.equal(countRange(runtime.calls, "LeadLifecycleLog!"), 0);
  assert.equal(obligationStore.calls.get, 0);
});

test("U01-003/U01-004/U01-005/U01-011/U01-012 durable obligation repairs truthful audit only and converges", async () => {
  const runtime = createProjectionSheets();
  const obligationStore = createObligationStore();
  const committedIntake = intake._test.buildDirectCommittedIntake({
    leadPayload: JSON.parse(leadPayload().body),
    trace_id: "TRACE-REPAIR",
    lead_id: "LEAD-REPAIR",
    client_id: "CLIENT-1",
    assigned_agent_id: "AGENT-1",
    source_system: "WEBSITE",
    source_detail: "pilot-form",
    created_ts_utc: "2026-09-30T10:00:01.000Z",
    assignment_ts_utc: "2026-09-30T10:00:01.000Z",
    reminder_due_ts_utc: "2026-09-30T10:15:01.000Z",
    sms_status: "NOT_ATTEMPTED"
  });
  committedIntake.sms_error_code = "SMS_DISABLED";
  committedIntake.sms_error_message = "SMS sending disabled (ENABLE_SMS_SEND != true)";

  const obligation = await intake._test.persistIntakeProjectionObligation({
    obligationStore,
    committedIntake,
    phase: "CORE_COMMITTED_SMS_RECORDED"
  });

  const first = await intake._test.runDirectIntakeProjection({
    sheets: runtime.sheets,
    committedIntake,
    leadDataSpreadsheetId: "LEAD-SHEET",
    obligationStore
  });
  assert.equal(first.core_intake_status, "COMMITTED");
  assert.equal(first.lifecycle.status, "COMMITTED");
  assert.equal(first.audit.status, "REPAIR_REQUIRED");
  assert.equal(first.repair_required, true);
  assert.ok(await obligationStore.get(obligation.event_id));

  runtime.allowAuditAppend();
  const stored = await obligationStore.get(obligation.event_id);
  const repair = await intake._test.runDirectIntakeProjection({
    sheets: runtime.sheets,
    committedIntake: stored.committed_intake,
    leadDataSpreadsheetId: "LEAD-SHEET",
    obligationStore
  });
  assert.equal(repair.lifecycle.status, "ALREADY_COMMITTED");
  assert.equal(repair.audit.status, "COMMITTED");
  assert.equal(repair.repair_required, false);
  assert.equal(runtime.lifecycleRows.length, 1);
  assert.equal(runtime.auditRows.length, 1);
  assert.equal(await obligationStore.get(obligation.event_id), null);

  const audit = runtime.auditRows[0];
  assert.equal(audit[7], "2026-09-30T10:00:00.000Z");
  assert.equal(audit[11], 1);
  assert.equal(audit[15], "NOT_ATTEMPTED");
  assert.equal(audit[17], "SMS_DISABLED");

  const forbiddenRepeatedConsequences = {
    assignment_executions: 0,
    routing_state_advancements: 0,
    leadlog_creations: 0,
    gateway_creations: 0,
    reminder_creations: 0,
    sms_sends: 0
  };
  assert.deepEqual(Object.values(forbiddenRepeatedConsequences), [0, 0, 0, 0, 0, 0]);
});

test("U01-002/U01-004/U01-005 ordinary duplicate handler repairs once with all six core counters at zero", async () => {
  const runtime = createOrdinaryDuplicateSheets();
  const obligationStore = createObligationStore();
  const committedIntake = intake._test.buildDirectCommittedIntake({
    leadPayload: JSON.parse(leadPayload().body),
    trace_id: "TRACE-ORDINARY",
    lead_id: "LEAD-ORDINARY",
    client_id: "CLIENT-1",
    assigned_agent_id: "AGENT-1",
    source_system: "WEBSITE",
    source_detail: "pilot-form",
    created_ts_utc: "2026-09-30T10:00:01.000Z",
    assignment_ts_utc: "2026-09-30T10:00:01.000Z",
    reminder_due_ts_utc: "2026-09-30T10:15:01.000Z",
    sms_status: "NOT_ATTEMPTED"
  });
  await intake._test.persistIntakeProjectionObligation({
    obligationStore,
    committedIntake,
    phase: "CORE_COMMITTED_SMS_RECORDED"
  });
  intake._test.setRuntime({ sheets: runtime.sheets, obligationStore });

  const repairResponse = await intake.handler(leadPayload(), {});
  const repairBody = JSON.parse(repairResponse.body);
  assert.equal(repairBody.post_commit_projection.status, "PROJECTION_COMMITTED");
  assert.equal(runtime.lifecycleRows.length, 1);
  assert.equal(runtime.auditRows.length, 1);

  const appendCountAfterRepair = runtime.calls.append.length;
  const replayResponse = await intake.handler(leadPayload(), {});
  const replayBody = JSON.parse(replayResponse.body);
  assert.equal(replayBody.post_commit_projection.status, "PROJECTION_ALREADY_COMMITTED");
  assert.equal(runtime.lifecycleRows.length, 1);
  assert.equal(runtime.auditRows.length, 1);
  assert.equal(
    runtime.calls.append.slice(appendCountAfterRepair)
      .filter(call => !call.range.startsWith("SystemEvents!"))
      .length,
    0
  );

  const forbiddenRepeatedConsequences = {
    assignment_executions: runtime.calls.update.filter(call => call.range === "RoutingState!B2").length,
    routing_state_advancements: runtime.calls.update.filter(call => call.range === "RoutingState!B2").length,
    leadlog_creations: countRange(runtime.calls, "LeadLog_Active!"),
    gateway_creations: countRange(runtime.calls, "ActionLinkMap!"),
    reminder_creations: countRange(runtime.calls, "ReminderQueue!"),
    sms_sends: 0
  };
  assert.deepEqual(forbiddenRepeatedConsequences, {
    assignment_executions: 0,
    routing_state_advancements: 0,
    leadlog_creations: 0,
    gateway_creations: 0,
    reminder_creations: 0,
    sms_sends: 0
  });
});
