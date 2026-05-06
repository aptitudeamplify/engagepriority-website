const { google } = require("googleapis");
const twilio = require("twilio");
const { randomUUID } = require("crypto");

const SHEET_ID = "18x83a1VZIZoXrjASqTNfKdzYi1gDKLQD4fgx5WbyoWQ";
const ACTION_LINK_MAP_SHEET_ID = "1xNhypMirxoz9IjMWxO0H8gxNSqqavs2W17pzx8HiZfw";

exports.handler = async (event, context) => {
if (event.httpMethod !== "POST") {
return {
statusCode: 405,
body: JSON.stringify({ error: "Method not allowed" })
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
  range: "Clients!A1:Z1000"
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

const client = clients.find(row => {
return String(row.intake_client_reference || "").trim() === intakeClientRef;
});

if (!client) {
console.log("intake_validation_error", {
trace_id,
reason: "unknown_client_reference"
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
  "",                                    // validation_status
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
  "",                                    // validation_reason
  "",                                    // spam_score
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

await sheets.spreadsheets.values.append({
  spreadsheetId: leadDataSpreadsheetId,
  range: "LeadLog_Active!A1",
  valueInputOption: "RAW",
  requestBody: {
    values: [row]
  }
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

timing.sheets_write_reminderqueue_ms = Date.now() - t0;

const smsPayload = {
  to: assignedAgent.agent_phone,
  message:
    `New EngagePriority lead assigned: ${leadPayload.full_name || "Unknown Lead"}\n\n` +
    `Call now: ${actionLinks.CALL_NOW.public_url}\n` +
    `Call later: ${actionLinks.ACK_LATER.public_url}\n` +
    `Reassign: ${actionLinks.REASSIGN.public_url}`
};

console.log("intake_before_sms_send", {
  trace_id,
  lead_id: leadId,
  assigned_agent_id: assignmentResult.assigned_agent_id,
  phone: assignedAgent.agent_phone
});

const smsResult = await sendSmsIfEnabled(smsPayload);

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

async function sendSmsIfEnabled({ to, message }) {
  const enabled = String(process.env.ENABLE_SMS_SEND || "").toLowerCase() === "true";

  if (!enabled) {
    return {
      sent: false,
      reason: "SMS sending disabled (ENABLE_SMS_SEND != true)"
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
    body: message,
    from,
    to
  });

  return {
    sent: true,
    sid: result.sid
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
  const actionTypes = ["CALL_NOW", "ACK_LATER", "REASSIGN"];

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

  for (const action_type of actionTypes) {
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
      throw new Error(`Failed to generate unique short_code for ${action_type} after 3 attempts`);
    }

    const public_url = `https://engagepriority.com/a/${short_code}`;

    results[action_type] = {
      short_code,
      token: short_code,
      public_url
    };

    rowsToInsert.push([
      short_code,
      public_url,
      action_type,
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
    action_count: actionTypes.length
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId: ACTION_LINK_MAP_SHEET_ID,
    range: "ActionLinkMap!A:O",
    valueInputOption: "RAW",
    requestBody: {
      values: rowsToInsert
    }
  });

  return results;
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

