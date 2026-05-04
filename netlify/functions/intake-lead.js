const { google } = require("googleapis");
const twilio = require("twilio");

const SHEET_ID = "18x83a1VZIZoXrjASqTNfKdzYi1gDKLQD4fgx5WbyoWQ";

exports.handler = async (event, context) => {
const startTotal = Date.now();

const timing = {
total_ms: 0,
parse_payload_ms: 0,
sheets_read_clients_ms: 0,
sheets_read_agents_ms: 0,
sheets_read_pointer_ms: 0,
assignment_compute_ms: 0,
sheets_write_pointer_ms: 0
};

try {
let t0 = Date.now();

const leadPayload = parseLeadPayload(event);
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

const client = clients[0];
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

const assignmentResult = routeByStrategy({
  routing_strategy: routingStrategy,
  agents,
  routing_pointer: routingPointer
});

timing.assignment_compute_ms = Date.now() - t0;

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

const smsPayload = {
  to: assignedAgent.agent_phone,
  message: `New EngagePriority lead assigned: ${leadPayload.full_name || "Unknown Lead"}`
};

const smsResult = await sendSmsIfEnabled(smsPayload);

timing.total_ms = Date.now() - startTotal;

return {
  statusCode: 200,
  body: JSON.stringify({
    status: "INTAKE_TEST_SUCCESS",
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