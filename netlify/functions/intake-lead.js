const { google } = require("googleapis");
const twilio = require("twilio");
const { randomUUID } = require("crypto");

const SHEET_ID = "18x83a1VZIZoXrjASqTNfKdzYi1gDKLQD4fgx5WbyoWQ";
const ACTION_LINK_MAP_SHEET_ID = "1xNhypMirxoz9IjMWxO0H8gxNSqqavs2W17pzx8HiZfw";
const MAKE_INTAKE_HANDOFF_WEBHOOK_URL = process.env.MAKE_INTAKE_HANDOFF_WEBHOOK_URL;


exports.handler = async (event, context) => {
if (event.httpMethod !== "POST") {
return {
statusCode: 405,
body: JSON.stringify({ error: "Method not allowed" })
};
}

const rawBody = event.body || "";

if (rawBody.length > 10000) {
console.log("intake_validation_error", {
reason: "oversized_payload"
});
return {
statusCode: 413,
body: JSON.stringify({ error: "Invalid request" })
};
}

const startTotal = Date.now();

const timing = {
total_ms: 0,
parse_payload_ms: 0,
sheets_read_clients_ms: 0,
sheets_read_agents_ms: 0,
sheets_read_pointer_ms: 0,
assignment_compute_ms: 0,
sheets_write_pointer_ms: 0,
sheets_write_leadlog_ms: 0,
sheets_write_reminderqueue_ms: 0
};

try {
let t0 = Date.now();

const leadPayload = parseLeadPayload(event);

const trace_id = randomUUID();
console.log("trace_id:", trace_id);

const intakeClientRef = (leadPayload.intake_client_reference || "").trim();

if (!intakeClientRef) {
console.log("intake_validation_error", {
trace_id,
reason: "missing_intake_client_reference"
});
return {
statusCode: 400,
body: JSON.stringify({ error: "Invalid request" })
};
}


timing.parse_payload_ms = Date.now() - t0;

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});

const sheets = google.sheets({ version: "v4", auth });
const leadId = await generateLeadId(sheets);

t0 = Date.now();
const clientsRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: "Clients!A1:AC1000"
});
timing.sheets_read_clients_ms = Date.now() - t0;

t0 = Date.now();
const agentsRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: "Agents!A1:Z1000"
});
timing.sheets_read_agents_ms = Date.now() - t0;

t0 = Date.now();
const routingRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: "RoutingState!A1:Z1000"
});
timing.sheets_read_pointer_ms = Date.now() - t0;

const intakeSourceMapRes = await sheets.spreadsheets.values.get({
spreadsheetId: SHEET_ID,
range: "IntakeSourceMap!A1:Z1000"
});

const clientsRows = clientsRes.data.values || [];
const agentsRows = agentsRes.data.values || [];
const routingRows = routingRes.data.values || [];

if (clientsRows.length < 2) {
  throw new Error("Clients tab must contain a header row and at least one client row.");
}

if (agentsRows.length < 2) {
  throw new Error("Agents tab must contain a header row and at least one agent row.");
}

if (routingRows.length < 2) {
  throw new Error("RoutingState tab must contain a header row and at least one routing state row.");
}

const clients = rowsToObjects(clientsRows);
const agents = rowsToObjects(agentsRows);
const routingStates = rowsToObjects(routingRows);
const intakeSourceMap = rowsToObjects(intakeSourceMapRes.data.values || []);

const source_system = String(leadPayload.source_system || "WEBSITE").trim().toUpperCase();
const source_primary_key_type = "source_detail";
const source_primary_key_value = intakeClientRef;

console.log("intake_source_detection", {
trace_id,
source_system,
source_primary_key_type,
source_primary_key_value
});

const matchingSourceRows = intakeSourceMap.filter(row => {
return String(row.source_system || "").trim().toUpperCase() === source_system &&
String(row.source_primary_key_type || "").trim() === source_primary_key_type &&
String(row.source_primary_key_value || "").trim() === source_primary_key_value &&
String(row.status || "").trim().toUpperCase() === "ACTIVE";
});

console.log("intake_source_map_lookup", {
trace_id,
match_count: matchingSourceRows.length
});

if (matchingSourceRows.length === 0) {
console.log("intake_validation_error", {
trace_id,
reason: "UNRESOLVED_CLIENT"
});
return {
statusCode: 400,
body: JSON.stringify({ error: "UNRESOLVED_CLIENT" })
};
}

if (matchingSourceRows.length > 1) {
console.log("intake_validation_error", {
trace_id,
reason: "AMBIGUOUS_CLIENT_MAPPING"
});
return {
statusCode: 400,
body: JSON.stringify({ error: "AMBIGUOUS_CLIENT_MAPPING" })
};
}

const mappedClientId = matchingSourceRows[0].client_id;

const client = clients.find(row => {
return String(row.client_id || "").trim() === String(mappedClientId || "").trim();
});


if (!client) {
console.log("intake_validation_error", {
trace_id,
reason: "INVALID_CLIENT_CONFIG"
});
return {
statusCode: 400,
body: JSON.stringify({ error: "Invalid request" })
};
}

if (String(client.client_status || "").trim().toUpperCase() !== "ACTIVE") {
console.log("intake_validation_error", {
trace_id,
reason: "inactive_client",
client_id: client.client_id
});
return {
statusCode: 400,
body: JSON.stringify({ error: "Invalid request" })
};
}

if (!client.lead_data_spreadsheet_id) {
console.log("intake_validation_error", {
trace_id,
reason: "missing_lead_data_spreadsheet_id",
client_id: client.client_id
});
return {
statusCode: 400,
body: JSON.stringify({ error: "Invalid request" })
};
}

const normalizedLead = normalizeWebsiteLead(leadPayload);

if (!normalizedLead.phone) {
console.log("intake_validation_error", {
trace_id,
reason: "missing_phone",
client_id: client.client_id
});
return {
statusCode: 400,
body: JSON.stringify({ error: "Invalid request" })
};
}

Object.assign(leadPayload, normalizedLead);

const serviceWindowStatus =
  getClientServiceWindowStatus(client);

console.log("intake_service_window_status", {
  trace_id,
  client_id: client.client_id,
  is_open: serviceWindowStatus.is_open,
  release_mode: serviceWindowStatus.release_mode,
  timezone: serviceWindowStatus.timezone,
  local_day: serviceWindowStatus.local_day,
  local_time: serviceWindowStatus.local_time,
  business_day_start_time: serviceWindowStatus.business_day_start_time,
  business_day_end_time: serviceWindowStatus.business_day_end_time,
  business_days_active: serviceWindowStatus.business_days_active
});

const intakeValidation = validateWebsiteLeadForIntake(leadPayload);

if (intakeValidation.hard_reject) {
console.log("intake_validation_error", {
trace_id,
reason: intakeValidation.validation_reason,
spam_score: intakeValidation.spam_score,
client_id: client.client_id
});
return {
statusCode: 400,
body: JSON.stringify({ error: "Invalid request" })
};
}

const idempotencyKey = buildIdempotencyKey(
  client.client_id,
  leadPayload.email,
  leadPayload.phone
);

const sourceToken = [
  source_system,
  source_primary_key_value
].join("|");

const idempotencyRows = await readSheetRows(
  sheets,
  client.lead_data_spreadsheet_id,
  "Idempotency!A1:H10000"
);

const duplicateRowIndex = findRowIndexByColumnValue(
  idempotencyRows,
  "idempotency_key",
  idempotencyKey
);

if (duplicateRowIndex !== -1) {
  console.log("intake_duplicate_lead", {
    trace_id,
    client_id: client.client_id,
    reason: "DUPLICATE_LEAD"
  });

  const duplicateHeaders = idempotencyRows[0] || [];
const duplicateLeadIdColumn = duplicateHeaders.indexOf("lead_id");

const duplicateLeadId =
  duplicateLeadIdColumn !== -1
    ? (idempotencyRows[duplicateRowIndex][duplicateLeadIdColumn] || "")
    : "";

await appendSystemEvent({
  sheets,
  event_id: randomUUID(),
  event_timestamp: new Date().toISOString(),
  client_id: client.client_id,
  event_type: "DUPLICATE_LEAD",
  reference_id: duplicateLeadId,
  severity: "INFO",
  message: "Duplicate lead blocked by Netlify intake idempotency check",
  source_module: "netlify-intake-lead",
  processed_flag: "FALSE",
  trace_id
});

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "DUPLICATE_LEAD",
      trace_id,
      client: {
        client_id: client.client_id
      },
      message: "Duplicate lead detected. Intake processing stopped."
    })
  };
}

if (
  !serviceWindowStatus.is_open &&
  serviceWindowStatus.release_mode === "AT_OPEN"
) {
  const nowUtc =
    new Date().toISOString();

  const leadDataSpreadsheetId =
    client.lead_data_spreadsheet_id;

  const row = [
    leadId,                                // lead_id
    client.client_id,                      // client_id
    nowUtc,                                // created_timestamp
    leadPayload.source_system || "",       // source_system
    leadPayload.source_detail || "",       // source_detail
    leadPayload.full_name || "",           // full_name
    leadPayload.email || "",               // email
    leadPayload.phone || "",               // phone
    JSON.stringify(leadPayload),           // inbound_payload_json
    "",                                    // normalized_payload_json
    "",                                    // hardening_status
    "",                                    // idempotency_status
    intakeValidation.validation_status,    // validation_status
    client.routing_strategy,               // routing_decision
    "OFF_HOURS_HOLD",                      // routing_reason
    "",                                    // assigned_agent_id
    "",                                    // assigned_timestamp
    "FALSE",                               // contacted_flag
    "",                                    // contact_timestamp
    "PENDING_RELEASE",                     // lead_status
    nowUtc,                                // last_updated_timestamp
    "Held by Netlify intake because client service window is closed.", // notes
    trace_id,                              // trace_id
    "",                                    // reminder_claimed_ts_utc
    intakeValidation.validation_reason,    // validation_reason
    String(intakeValidation.spam_score),   // spam_score
    "",                                    // token_call_now
    "",                                    // token_ack_later
    "",                                    // token_reassign
    "",                                    // token_outcome_contacted
    "",                                    // token_outcome_no_answer
    "",                                    // token_outcome_reassign
    "FALSE",                               // tokens_active
    "FALSE",                               // acknowledged
    "",                                    // ack_timestamp
    "",                                    // ack_agent_id
    "FALSE",                               // contact_attempt_started
    "",                                    // contact_attempt_started_ts
    "",                                    // contact_outcome
    "FALSE",                               // reassign_requested
    "",                                    // reassign_requested_ts
    "",                                    // token_invalidated_ts
    "",                                    // attempted_agent_ids
    "0",                                   // reassignment_count
    "0",                                   // assignment_attempt_count
    "FALSE",                               // reassignment_pending
    "",                                    // reassignment_reason
    "",                                    // reassignment_requested_ts_utc
    "",                                    // reassigned_from_agent_id
    "",                                    // last_reassignment_ts_utc
    "",                                    // assignment_ts_utc
    "",                                    // reassignment_status
    "FALSE",                               // admin_escalation_required
    "",                                    // admin_escalation_ts_utc
    "",                                    // last_reassignment_reason
    "0",                                   // non_response_reassignment_count
    "",                                    // admin_escalation_reason
    "",                                    // token_contacted_appt_set
    "",                                    // token_contacted_not_interested
    "0",                                   // no_answer_attempt_count
    nowUtc,                                // scenario_started_ts_utc
    nowUtc                                 // scenario_ended_ts_utc
  ];

  const leadLogAppendResult =
    await sheets.spreadsheets.values.append({
      spreadsheetId: leadDataSpreadsheetId,
      range: "LeadLog_Active!A1",
      valueInputOption: "RAW",
      requestBody: {
        values: [row]
      }
    });

  const leadLogUpdatedRange =
    leadLogAppendResult.data.updates?.updatedRange || "";

  const leadLogRowMatch =
    leadLogUpdatedRange.match(/![A-Z]+(\d+):/);

  const leadLogRowNumber =
    leadLogRowMatch ? leadLogRowMatch[1] : "";

  await appendLeadIndexRow({
    sheets,
    spreadsheetId: leadDataSpreadsheetId,
    lead_id: leadId,
    leadlog_row: leadLogRowNumber,
    client_id: client.client_id,
    created_timestamp: nowUtc,
    last_updated_timestamp: nowUtc
  });

  await appendReleaseQueueRow({
    sheets,
    release_id: randomUUID(),
    client_id: client.client_id,
    lead_id: leadId,
    release_due_ts_utc: nowUtc,
    release_reason: "OFF_HOURS_CLIENT_CLOSED",
    created_ts_utc: nowUtc,
    notes: `Held at intake. Local service window status: ${serviceWindowStatus.local_day} ${serviceWindowStatus.local_time} ${serviceWindowStatus.timezone}.`
  });

  await appendLeadLifecycleEvent({
    sheets,
    spreadsheetId: leadDataSpreadsheetId,
    event_id: randomUUID(),
    event_ts_utc: nowUtc,
    client_id: client.client_id,
    lead_id: leadId,
    trace_id,
    event_type: "LEAD_HELD_AFTER_HOURS",
    event_stage: "INTAKE",
    event_source: "NETLIFY",
    assigned_agent_id: "",
    gateway_context: "",
    selected_action: "",
    notes: "Held after hours; release queued"
  });

  await appendIdempotencyRow({
    sheets,
    spreadsheetId: leadDataSpreadsheetId,
    idempotency_key: idempotencyKey,
    client_id: client.client_id,
    source_token: sourceToken,
    first_seen_timestamp: nowUtc,
    lead_id: leadId
  });

  timing.total_ms =
    Date.now() - startTotal;

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "INTAKE_HELD_FOR_RELEASE",
      trace_id,
      timing,
      client: {
        client_id: client.client_id,
        routing_strategy: client.routing_strategy
      },
      lead_preview: {
        lead_id: leadId,
        full_name: leadPayload.full_name || null,
        phone: leadPayload.phone || null,
        email: leadPayload.email || null
      },
      service_window: serviceWindowStatus,
      lead_status: "PENDING_RELEASE",
      release_queue_created: true,
      lifecycle_event_created: true,
      lifecycle_event_type: "LEAD_HELD_AFTER_HOURS",
      routing_state_updated: false,
      action_links_created: false,
      reminder_created: false,
      sms_sent: false,
      message: "Lead held for release because client service window is closed."
    })
  };
}

const eligibleAgents = agents.filter(agent => {
return String(agent.client_id || "").trim() === client.client_id &&
String(agent.agent_status || "").trim().toUpperCase() === "ACTIVE";
});

if (eligibleAgents.length === 0) {
console.log("intake_validation_error", {
trace_id,
reason: "no_active_agents",
client_id: client.client_id
});
return {
statusCode: 400,
body: JSON.stringify({ error: "Invalid request" })
};
}

for (const agent of eligibleAgents) {
const assignmentWeight = parseInt(agent.assignment_weight, 10);
const prioritySlot = parseInt(agent.priority_slot, 10);

if (!Number.isFinite(assignmentWeight) || assignmentWeight <= 0 || !Number.isFinite(prioritySlot) || !agent.agent_phone) {
console.log("intake_validation_error", {
trace_id,
reason: "invalid_agent_pool",
client_id: client.client_id,
agent_id: agent.agent_id
});
return {
statusCode: 400,
body: JSON.stringify({ error: "Invalid request" })
};
}
}

const routingState = routingStates[0];

const routingStrategy = String(client.routing_strategy || "").trim();

if (!routingStrategy) {
  throw new Error(`Missing routing_strategy for client_id: ${client.client_id}`);
}

const routingPointer = parseInt(routingState.routing_pointer || "0", 10);

if (!Number.isFinite(routingPointer) || routingPointer < 0) {
  throw new Error(`Invalid routing_pointer: ${routingState.routing_pointer}`);
}

t0 = Date.now();

console.log("intake_before_routing", {
  trace_id,
  lead_id: leadId,
  client_id: client.client_id,
  routing_strategy: routingStrategy
});

const assignmentResult = routeByStrategy({
  routing_strategy: routingStrategy,
  agents: eligibleAgents,
  routing_pointer: routingPointer
});

timing.assignment_compute_ms = Date.now() - t0;

console.log("intake_after_assignment", {
  trace_id,
  lead_id: leadId,
  assigned_agent_id: assignmentResult.assigned_agent_id,
  routing_pointer_before: assignmentResult.routing_pointer_before,
  routing_pointer_after: assignmentResult.routing_pointer_after,
  cycle_length: assignmentResult.cycle_length
});

t0 = Date.now();

await sheets.spreadsheets.values.update({
  spreadsheetId: SHEET_ID,
  range: "RoutingState!B2",
  valueInputOption: "RAW",
  requestBody: {
    values: [[assignmentResult.routing_pointer_after]]
  }
});

timing.sheets_write_pointer_ms = Date.now() - t0;

const assignedAgent = agents.find(agent => {
  return agent.agent_id === assignmentResult.assigned_agent_id;
});

if (!assignedAgent) {
  throw new Error(`Assigned agent not found after routing: ${assignmentResult.assigned_agent_id}`);
}

const actionLinks = await createInitialActionLinks({
  sheets,
  lead_id: leadId,
  client,
  assigned_agent_id: assignmentResult.assigned_agent_id,
  trace_id
});

t0 = Date.now();

const nowUtc = new Date().toISOString();

const leadDataSpreadsheetId = client.lead_data_spreadsheet_id;

if (!leadDataSpreadsheetId) {
  throw new Error(`Missing lead_data_spreadsheet_id for client_id: ${client.client_id}`);
}

const row = [
  leadId,                                // lead_id
  client.client_id,                      // client_id
  nowUtc,                                // created_timestamp
  leadPayload.source_system || "",       // source_system
  leadPayload.source_detail || "",       // source_detail
  leadPayload.full_name || "",           // full_name
  leadPayload.email || "",               // email
  leadPayload.phone || "",               // phone
  JSON.stringify(leadPayload),           // inbound_payload_json
  "",                                    // normalized_payload_json
  "",                                    // hardening_status
  "",                                    // idempotency_status
  intakeValidation.validation_status,    // validation_status
  client.routing_strategy,               // routing_decision
  "WEIGHTED_INTERLEAVED",                // routing_reason
  assignmentResult.assigned_agent_id,    // assigned_agent_id
  nowUtc,                                // assigned_timestamp
  "FALSE",                               // contacted_flag
  "",                                    // contact_timestamp
  "NEW",                                 // lead_status
  nowUtc,                                // last_updated_timestamp
  "",                                    // notes
  trace_id,                              // trace_id
  "",                                    // reminder_claimed_ts_utc
  intakeValidation.validation_reason,    // validation_reason
  String(intakeValidation.spam_score),   // spam_score
  "",                                    // token_call_now
  "",                                    // token_ack_later
  "",                                    // token_reassign
  "",                                    // token_outcome_contacted
  "",                                    // token_outcome_no_answer
  "",                                    // token_outcome_reassign
  "TRUE",                                // tokens_active
  "FALSE",                               // acknowledged
  "",                                    // ack_timestamp
  "",                                    // ack_agent_id
  "FALSE",                               // contact_attempt_started
  "",                                    // contact_attempt_started_ts
  "",                                    // contact_outcome
  "FALSE",                               // reassign_requested
  "",                                    // reassign_requested_ts
  "",                                    // token_invalidated_ts
  "",                                    // attempted_agent_ids
  "0",                                   // reassignment_count
  "1",                                   // assignment_attempt_count
  "FALSE",                               // reassignment_pending
  "",                                    // reassignment_reason
  "",                                    // reassignment_requested_ts_utc
  "",                                    // reassigned_from_agent_id
  "",                                    // last_reassignment_ts_utc
  nowUtc,                                // assignment_ts_utc
  "",                                    // reassignment_status
  "FALSE",                               // admin_escalation_required
  "",                                    // admin_escalation_ts_utc
  "",                                    // last_reassignment_reason
  "0",                                   // non_response_reassignment_count
  "",                                    // admin_escalation_reason
  "",                                    // token_contacted_appt_set
  "",                                    // token_contacted_not_interested
  "0",                                   // no_answer_attempt_count
  nowUtc,                                // scenario_started_ts_utc
  ""                                     // scenario_ended_ts_utc
];

const leadLogAppendResult = await sheets.spreadsheets.values.append({
  spreadsheetId: leadDataSpreadsheetId,
  range: "LeadLog_Active!A1",
  valueInputOption: "RAW",
  requestBody: {
    values: [row]
  }
});

const leadLogUpdatedRange = leadLogAppendResult.data.updates?.updatedRange || "";
const leadLogRowMatch = leadLogUpdatedRange.match(/![A-Z]+(\d+):/);
const leadLogRowNumber = leadLogRowMatch ? leadLogRowMatch[1] : "";

await appendLeadIndexRow({
  sheets,
  spreadsheetId: leadDataSpreadsheetId,
  lead_id: leadId,
  leadlog_row: leadLogRowNumber,
  client_id: client.client_id,
  created_timestamp: nowUtc,
  last_updated_timestamp: nowUtc
});

timing.sheets_write_leadlog_ms = Date.now() - t0;

t0 = Date.now();

const reminderDelayMinutes = parseInt(client.reminder_1_delay_minutes, 10);

if (!Number.isFinite(reminderDelayMinutes) || reminderDelayMinutes <= 0) {
  throw new Error(`Invalid reminder_1_delay_minutes for client_id: ${client.client_id}`);
}

const nextActionDue = new Date(Date.now() + reminderDelayMinutes * 60000).toISOString();

const reminderRow = [
  trace_id,
  client.client_id,
  leadId,
  "", // token (not used at intake)
  client.lead_data_spreadsheet_id,
  assignmentResult.assigned_agent_id,
  "TRUE",
  nextActionDue,
  "REMINDER_1",
  "", // last_processed_ts_utc
  "", // notes
  ""  // dispatch_claimed_ts_utc
];

await sheets.spreadsheets.values.append({
  spreadsheetId: SHEET_ID,
  range: "ReminderQueue!A1",
  valueInputOption: "RAW",
  requestBody: {
    values: [reminderRow]
  }
});

await appendIdempotencyRow({
  sheets,
  spreadsheetId: leadDataSpreadsheetId,
  idempotency_key: idempotencyKey,
  client_id: client.client_id,
  source_token: sourceToken,
  first_seen_timestamp: nowUtc,
  lead_id: leadId
});

timing.sheets_write_reminderqueue_ms = Date.now() - t0;

const smsPayload = {
  to: assignedAgent.agent_phone,
  message:
    `New EngagePriority lead assigned.\n\n` +
    `${actionLinks.INITIAL_RESPONSE_GATEWAY.public_url}`
};

console.log("intake_before_sms_send", {
  trace_id,
  lead_id: leadId,
  assigned_agent_id: assignmentResult.assigned_agent_id,
  phone: assignedAgent.agent_phone
});

const smsResult = await sendSmsIfEnabled(smsPayload);

try {
if (MAKE_INTAKE_HANDOFF_WEBHOOK_URL) {
const nowUtc = new Date().toISOString();

const handoffPayload = {
  event_type: "NETLIFY_INTAKE_COMPLETED",
  trace_id,
  lead_id: leadId,
  client_id: client.client_id,
  assigned_agent_id: assignmentResult.assigned_agent_id,
  source_system,
  source_detail: source_primary_key_value,
  submitted_ts_utc: leadPayload.submitted_ts_utc || nowUtc,
  created_ts_utc: nowUtc,
  assignment_ts_utc: nowUtc,
  leadlog_created: true,
  action_link_count: 3,
  reminder_created: true,
  reminder_next_action_type: "REMINDER_1",
  reminder_due_ts_utc: nextActionDue,
  sms_status: "ATTEMPTED",
  sms_sent_ts_utc: smsResult?.sent ? nowUtc : null,
  sms_error_code: smsResult?.reason || null,
  sms_error_message: smsResult?.reason || null,
  status: "INTAKE_COMPLETED",
  lead_preview: {
    full_name: leadPayload.full_name,
    phone_last4: (leadPayload.phone || "").slice(-4),
    email: leadPayload.email || ""
  }
};

await fetch(MAKE_INTAKE_HANDOFF_WEBHOOK_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(handoffPayload)
});

}
} catch (err) {
console.log("intake_handoff_error", { trace_id });
}


timing.total_ms = Date.now() - startTotal;

return {
  statusCode: 200,
  body: JSON.stringify({
    status: "INTAKE_TEST_SUCCESS",
    trace_id,
    timing,
    client: {
      client_id: client.client_id,
      routing_strategy: routingStrategy
    },
    lead_preview: {
      lead_id: leadId,
      full_name: leadPayload.full_name || null,
      phone: leadPayload.phone || null,
      email: leadPayload.email || null
    },
    assignment: {
      assigned_agent_id: assignmentResult.assigned_agent_id,
      routing_pointer_before: assignmentResult.routing_pointer_before,
      routing_pointer_after: assignmentResult.routing_pointer_after,
      cycle_length: assignmentResult.cycle_length,
      cycle_preview: assignmentResult.cycle_preview
    },
    action_links_preview: actionLinks,
    sms_payload_preview: smsPayload,
    sms_send_result: smsResult,
    message: smsResult.sent
  ? "Lead intake path completed. SMS was sent."
  : "Lead intake path completed. SMS was not sent."
  })
};

} catch (error) {
return {
statusCode: 500,
body: JSON.stringify({
status: "INTAKE_TEST_ERROR",
error: error.message,
stack: error.stack
})
};
}
};

function parseLeadPayload(event) {
if (!event.body) {
return {};
}

try {
return JSON.parse(event.body);
} catch (error) {
throw new Error("Invalid JSON payload received by intake-lead function.");
}
}

function rowsToObjects(rows) {
const headers = rows[0];

return rows.slice(1).map(row => {
const obj = {};
headers.forEach((header, index) => {
obj[header] = row[index];
});
return obj;
});
}

function getClientServiceWindowStatus(client, now = new Date()) {
  const timezone =
    String(client.primary_timezone || "").trim();

  const businessStart =
    String(client.business_day_start_time || "").trim();

  const businessEnd =
    String(client.business_day_end_time || "").trim();

  const activeDays =
    String(client.business_days_active || "").trim().toUpperCase();

  const offHoursReleaseMode =
    String(client.off_hours_release_mode || "").trim().toUpperCase();

  if (!timezone) {
    throw new Error(`Missing primary_timezone for client_id: ${client.client_id}`);
  }

  if (!businessStart || !businessEnd) {
    throw new Error(`Missing business hours for client_id: ${client.client_id}`);
  }

  if (!activeDays) {
    throw new Error(`Missing business_days_active for client_id: ${client.client_id}`);
  }

  const localParts =
    getLocalDateTimeParts(now, timezone);

  const currentDayToken =
    localParts.weekday.toUpperCase().slice(0, 3);

  const activeDayTokens =
    activeDays
      .split("|")
      .map(day => day.trim().toUpperCase())
      .filter(Boolean);

  const isActiveDay =
    activeDayTokens.includes(currentDayToken);

  const currentMinutes =
    localParts.hour * 60 + localParts.minute;

  const startMinutes =
    parseBusinessTimeToMinutes(businessStart);

  const endMinutes =
    parseBusinessTimeToMinutes(businessEnd);

  const isWithinTimeWindow =
    startMinutes <= endMinutes
      ? currentMinutes >= startMinutes && currentMinutes < endMinutes
      : currentMinutes >= startMinutes || currentMinutes < endMinutes;

  const isOpen =
    isActiveDay && isWithinTimeWindow;

  return {
    is_open: isOpen,
    release_mode: offHoursReleaseMode,
    timezone,
    local_day: currentDayToken,
    local_time: `${String(localParts.hour).padStart(2, "0")}:${String(localParts.minute).padStart(2, "0")}`,
    business_day_start_time: businessStart,
    business_day_end_time: businessEnd,
    business_days_active: activeDays
  };
}

function getLocalDateTimeParts(date, timezone) {
  const formatter =
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });

  const parts =
    formatter.formatToParts(date);

  const values = {};

  parts.forEach(part => {
    values[part.type] = part.value;
  });

  return {
    weekday: values.weekday,
    hour: parseInt(values.hour, 10),
    minute: parseInt(values.minute, 10)
  };
}

function parseBusinessTimeToMinutes(value) {
  const raw =
    String(value || "").trim();

  const match =
    raw.match(/^(\d{1,2}):(\d{2})$/);

  if (!match) {
    throw new Error(`Invalid business time format: ${value}`);
  }

  const hour =
    parseInt(match[1], 10);

  const minute =
    parseInt(match[2], 10);

  if (
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new Error(`Invalid business time value: ${value}`);
  }

  return hour * 60 + minute;
}

function routeByStrategy({ routing_strategy, agents, routing_pointer }) {
const normalizedStrategy = String(routing_strategy || "").trim();

if (normalizedStrategy === "WEIGHTED_INTERLEAVED") {
return routeWeightedInterleaved({
agents,
routing_pointer
});
}

throw new Error(`Unsupported routing_strategy: ${normalizedStrategy}`);
}

function routeWeightedInterleaved({ agents, routing_pointer }) {
const activeAgents = agents.filter(agent => {
return String(agent.agent_status || "").trim() === "ACTIVE";
});

if (activeAgents.length === 0) {
throw new Error("No ACTIVE agents available for WEIGHTED_INTERLEAVED routing.");
}

const sortedAgents = [...activeAgents].sort((a, b) => {
return parseInt(a.priority_slot, 10) - parseInt(b.priority_slot, 10);
});

const weights = sortedAgents.map(agent => {
const weight = parseInt(agent.assignment_weight, 10);

if (!Number.isFinite(weight) || weight <= 0) {
  throw new Error(`Invalid assignment_weight for agent_id ${agent.agent_id}: ${agent.assignment_weight}`);
}

return weight;

});

const reducedDivisor = weights.reduce((currentGcd, weight) => {
return gcd(currentGcd, weight);
});

const remainingCounts = sortedAgents.map((agent, index) => {
return {
agent,
remaining: weights[index] / reducedDivisor
};
});

const cycle = [];

while (remainingCounts.some(item => item.remaining > 0)) {
for (const item of remainingCounts) {
if (item.remaining > 0) {
cycle.push(item.agent);
item.remaining -= 1;
}
}
}

const routingPointerBefore = routing_pointer % cycle.length;
const assignedAgent = cycle[routingPointerBefore];
const routingPointerAfter = routingPointerBefore + 1 >= cycle.length ? 0 : routingPointerBefore + 1;

return {
assigned_agent_id: assignedAgent.agent_id,
routing_pointer_before: routingPointerBefore,
routing_pointer_after: routingPointerAfter,
cycle_length: cycle.length,
cycle_preview: cycle.map(agent => agent.agent_id),
active_agents_count: activeAgents.length
};
}

function gcd(a, b) {
let x = Math.abs(a);
let y = Math.abs(b);

while (y !== 0) {
const temp = y;
y = x % y;
x = temp;
}

return x;
}

const SMS_COMPLIANCE_FOOTER =
  "\n\nReply STOP to opt out. Reply HELP for help.";

function appendSmsComplianceFooter(message) {
  const normalizedMessage =
    String(message || "");

  if (
    normalizedMessage.includes("Reply STOP to opt out.") ||
    normalizedMessage.includes("Reply HELP for help.")
  ) {
    return normalizedMessage;
  }

  return `${normalizedMessage}${SMS_COMPLIANCE_FOOTER}`;
}

async function sendSmsIfEnabled({ to, message }) {
  const enabled = String(process.env.ENABLE_SMS_SEND || "").toLowerCase() === "true";

  const finalMessage =
    appendSmsComplianceFooter(message);

  if (!enabled) {
    return {
      sent: false,
      reason: "SMS sending disabled (ENABLE_SMS_SEND != true)",
      final_message: finalMessage
    };
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_PHONE;

  if (!accountSid || !authToken || !from) {
    throw new Error("Missing Twilio environment variables.");
  }

  const client = twilio(accountSid, authToken);

  const result = await client.messages.create({
    body: finalMessage,
    from,
    to
  });

  return {
    sent: true,
    sid: result.sid,
    final_message: finalMessage
  };
}

async function generateLeadId(sheets) {
  const counterRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "SystemCounters!A1:D1000"
  });

  const rows = counterRes.data.values || [];

  if (rows.length < 2) {
    throw new Error("SystemCounters tab must contain a lead_id counter row.");
  }

  const headers = rows[0];
  const counterNameIndex = headers.indexOf("counter_name");
  const currentValueIndex = headers.indexOf("current_value");
  const updatedTsIndex = headers.indexOf("updated_ts_utc");

  const leadCounterRowIndex = rows.findIndex((row, index) => {
    return index > 0 && String(row[counterNameIndex] || "").trim() === "lead_id";
  });

  if (leadCounterRowIndex === -1) {
    throw new Error("SystemCounters lead_id counter row not found.");
  }

  const currentValue = parseInt(rows[leadCounterRowIndex][currentValueIndex] || "0", 10);

  if (!Number.isFinite(currentValue) || currentValue < 0) {
    throw new Error(`Invalid lead_id counter current_value: ${rows[leadCounterRowIndex][currentValueIndex]}`);
  }

  const nextValue = currentValue + 1;
  const leadId = `L-${String(nextValue).padStart(6, "0")}`;

  const sheetRowNumber = leadCounterRowIndex + 1;
  const updatedTsUtc = new Date().toISOString();

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `SystemCounters!B${sheetRowNumber}:C${sheetRowNumber}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[nextValue, updatedTsUtc]]
    }
  });

  return leadId;
}

async function createInitialActionLinks({ sheets, lead_id, client, assigned_agent_id, trace_id }) {
  const gatewayContexts = ["INITIAL_RESPONSE_GATEWAY"];

  const created_ts_utc = new Date().toISOString();

  const existingRes = await sheets.spreadsheets.values.get({
    spreadsheetId: ACTION_LINK_MAP_SHEET_ID,
    range: "ActionLinkMap!A1:N1000"
  });

  const existingRows = existingRes.data.values || [];

  const existingShortCodes = new Set(
    existingRows.slice(1).map(row => row[0])
  );

  function generateShortCode() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < 6; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  const results = {};
  const rowsToInsert = [];

  for (const gateway_context of gatewayContexts) {
    let short_code;
    let attempts = 0;

    while (attempts < 3) {
      const candidate = generateShortCode();

      if (!existingShortCodes.has(candidate)) {
        short_code = candidate;
        existingShortCodes.add(candidate);
        break;
      }

      attempts++;
    }

    if (!short_code) {
      throw new Error(`Failed to generate unique short_code for ${gateway_context} after 3 attempts`);
    }

    const public_url = `https://engagepriority.com/a/${short_code}`;

    results[gateway_context] = {
      short_code,
      token: short_code,
      public_url
    };

    rowsToInsert.push([
      short_code,
      public_url,
      gateway_context,
      "",
      lead_id,
      client.client_id,
      client.lead_data_spreadsheet_id,
      assigned_agent_id,
      "", // expires_ts_utc
      "TRUE",
      created_ts_utc,
      "", // used_ts_utc
      "", // notes
      "", // deactivated_ts_utc
      "",  // deactivation_reason
      trace_id  // trace_id
    ]);
  }

  console.log("intake_before_actionlinkmap_write", {
    trace_id,
    lead_id,
    client_id: client.client_id,
    assigned_agent_id,
    action_count: gatewayContexts.length
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId: ACTION_LINK_MAP_SHEET_ID,
    range: "ActionLinkMap!A:P",
    valueInputOption: "RAW",
    requestBody: {
      values: rowsToInsert
    }
  });

  return results;
}

function buildIdempotencyKey(clientId, email, phone) {
  return [
    String(clientId || "").trim(),
    String(email || "").trim().toLowerCase(),
    String(phone || "").trim()
  ].join("|");
}

function findRowIndexByColumnValue(rows, columnName, value) {
  const headers = rows[0] || [];
  const columnIndex = headers.indexOf(columnName);

  if (columnIndex === -1) {
    throw new Error(`Missing required column: ${columnName}`);
  }

  return rows.findIndex((row, index) => {
    return index > 0 && String(row[columnIndex] || "").trim() === String(value || "").trim();
  });
}

async function readSheetRows(sheets, spreadsheetId, range) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range
  });

  return res.data.values || [];
}

async function appendLeadLifecycleEvent({
  sheets,
  spreadsheetId,
  event_id,
  event_ts_utc,
  client_id,
  lead_id,
  trace_id,
  event_type,
  event_stage,
  event_source,
  assigned_agent_id,
  gateway_context,
  selected_action,
  notes
}) {
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "LeadLifecycleLog!A1",
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        event_id,
        event_ts_utc,
        client_id,
        lead_id,
        trace_id,
        event_type,
        event_stage,
        event_source,
        assigned_agent_id || "",
        gateway_context || "",
        selected_action || "",
        notes || ""
      ]]
    }
  });
}

async function appendIdempotencyRow({ sheets, spreadsheetId, idempotency_key, client_id, source_token, first_seen_timestamp, lead_id }) {
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "Idempotency!A1",
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        idempotency_key,
        client_id,
        source_token,
        first_seen_timestamp,
        "",
        lead_id,
        "ACTIVE",
        ""
      ]]
    }
  });
}

async function appendLeadIndexRow({ sheets, spreadsheetId, lead_id, leadlog_row, client_id, created_timestamp, last_updated_timestamp }) {
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "LeadIndex!A1",
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        lead_id,
        leadlog_row,
        client_id,
        created_timestamp,
        last_updated_timestamp,
        "ACTIVE"
      ]]
    }
  });
}

async function appendReleaseQueueRow({
  sheets,
  release_id,
  client_id,
  lead_id,
  release_due_ts_utc,
  release_reason,
  created_ts_utc,
  notes
}) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "ReleaseQueue!A1",
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        release_id,          // release_id
        client_id,           // client_id
        lead_id,             // lead_id
        "",                  // agent_id
        release_due_ts_utc,  // release_due_ts_utc
        release_reason,      // release_reason
        "FALSE",             // contacted_flag
        "",                  // contact_timestamp
        "0",                 // followup_attempts
        "0",                 // escalation_level
        "",                  // last_notification_timestamp
        "PENDING",           // status
        created_ts_utc,      // created_ts_utc
        "",                  // released_ts_utc
        "0",                 // release_attempts
        "",                  // release_result
        "",                  // assigned_agent_id
        notes || "",         // notes
        ""                   // dispatch_claimed_ts_utc
      ]]
    }
  });
}

function normalizeWebsiteLead(payload) {
const fullNameRaw = String(payload.full_name || "").trim();
const full_name = fullNameRaw || "New Lead";

const nameParts = full_name.split(/\s+/).filter(Boolean);
const first_name = nameParts[0] || "";
const last_name = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "";

const email = String(payload.email || "").trim().toLowerCase();

const phoneRaw = String(payload.phone || "").trim();
const digits = phoneRaw.replace(/\D/g, "");

let phone = "";

if (digits.length === 10) {
phone = `+1${digits}`;
} else if (digits.length === 11 && digits.startsWith("1")) {
phone = `+${digits}`;
} else if (phoneRaw.startsWith("+") && digits.length >= 10) {
phone = `+${digits}`;
}

return {
...payload,
full_name,
first_name,
last_name,
email,
phone
};
}

function validateWebsiteLeadForIntake(lead) {
const name = String(lead.full_name || "").trim().toLowerCase();
const email = String(lead.email || "").trim().toLowerCase();
const phone = String(lead.phone || "").trim().toLowerCase();
const source = String(lead.source_system || "").trim().toLowerCase();
const sourceDetail = String(lead.source_detail || lead.intake_client_reference || "").trim().toLowerCase();

let spam_score = 0;
const reasons = [];
let hard_reject = false;

const digits = phone.replace(/\D/g, "");
const nationalDigits = digits.length === 11 && digits.startsWith("1")
  ? digits.slice(1)
  : digits;
let phone_usable = false;

if (nationalDigits && nationalDigits.length === 10) {
phone_usable = true;

if (/^(\d)\1+$/.test(nationalDigits)) {
  spam_score += 35;
  reasons.push("repeated_digit_phone");
  hard_reject = true;
}

if (
  nationalDigits === "1234567890" ||
  nationalDigits === "0123456789" ||
  nationalDigits === "1111111111" ||
  nationalDigits === "2222222222" ||
  nationalDigits === "5555555555"
) {
  spam_score += 35;
  reasons.push("fake_phone_pattern");
  hard_reject = true;
}
}

const fakeNamePatterns = ["test", "asdf", "qwerty", "demo", "fake", "sample", "na", "n/a", "unknown"];

if (name && name.length >= 3 && fakeNamePatterns.some(p => name.includes(p))) {
spam_score += 25;
reasons.push("fake_or_test_name");
}

const disposableEmailPatterns = ["mailinator", "tempmail", "10minutemail", "guerrillamail", "trashmail"];

let email_usable = false;

if (email && email.includes("@")) {
email_usable = true;

if (disposableEmailPatterns.some(p => email.includes(p))) {
  spam_score += 35;
  reasons.push("disposable_email");
}

if (email.startsWith("test@") || email.includes("+test")) {
  spam_score += 20;
  reasons.push("test_email_pattern");
}

}

if (!email_usable && !phone_usable) {
spam_score += 100;
reasons.push("no_usable_contact");
hard_reject = true;
}

const spamTerms = ["crypto", "bitcoin", "seo", "backlink", "casino", "loan", "viagra", "forex"];
const combinedText = `${name} ${email} ${source} ${sourceDetail}`.toLowerCase();

if (/https?:\/\//.test(combinedText) || combinedText.includes("www.")) {
spam_score += 25;
reasons.push("url_detected");
}

if (spamTerms.some(term => combinedText.includes(term))) {
spam_score += 25;
reasons.push("spam_keyword");
}

if (/(.)\1{4,}/.test(combinedText)) {
spam_score += 15;
reasons.push("repeated_characters");
}

let validation_status = "VALID";

if (spam_score >= 61) {
validation_status = "INVALID";
} else if (spam_score >= 31) {
validation_status = "SUSPECT";
}

const validation_reason =
reasons.length > 0 ? reasons.slice(0, 3).join("|") : "passed_validation_checks";

return {
validation_status,
validation_reason,
spam_score,
hard_reject
};
}

async function appendSystemEvent({ sheets, event_id, event_timestamp, client_id, event_type, reference_id, severity, message, source_module, processed_flag, trace_id }) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "SystemEvents!A1",
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        event_id,
        event_timestamp,
        client_id,
        event_type,
        reference_id,
        severity,
        message,
        source_module,
        processed_flag,
        trace_id
      ]]
    }
  });
}
