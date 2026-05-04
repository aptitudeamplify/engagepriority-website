const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

exports.handler = async (event, context) => {
const startTotal = Date.now();

const SHEET_ID = "18x83a1VZIZoXrjASqTNfKdzYi1gDKLQD4fgx5WbyoWQ";

const keyPath = path.join(process.cwd(), "service-account.json");
const auth = new google.auth.GoogleAuth({
keyFile: keyPath,
scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

const timing = {
total_ms: 0,
sheets_read_clients_ms: 0,
sheets_read_agents_ms: 0,
sheets_read_pointer_ms: 0,
wrr_compute_ms: 0,
sheets_write_pointer_ms: 0,
};

try {
// STEP 1 — Read Clients
let t0 = Date.now();
const clientsRes = await sheets.spreadsheets.values.get({
spreadsheetId: SHEET_ID,
range: "Clients!A1:Z1000",
});
timing.sheets_read_clients_ms = Date.now() - t0;

// STEP 2 — Read Agents
t0 = Date.now();
const agentsRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: "Agents!A1:Z1000",
});
timing.sheets_read_agents_ms = Date.now() - t0;

// STEP 3 — Read RoutingState
t0 = Date.now();
const routingRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: "RoutingState!A1:Z1000",
});
timing.sheets_read_pointer_ms = Date.now() - t0;

const agentsRows = agentsRes.data.values;
const routingRows = routingRes.data.values;

const agentHeaders = agentsRows[0];
const routingHeaders = routingRows[0];

const agents = agentsRows.slice(1).map(row => {
  const obj = {};
  agentHeaders.forEach((h, i) => obj[h] = row[i]);
  return obj;
}).filter(a => a.agent_status === "ACTIVE");

const routing = routingRows.slice(1)[0];
const routingObj = {};
routingHeaders.forEach((h, i) => routingObj[h] = routing[i]);

let pointer = parseInt(routingObj.routing_pointer || "0", 10);

// STEP 4 — WRR COMPUTE
t0 = Date.now();

const sortedAgents = agents.sort((a, b) => {
  return parseInt(a.priority_slot) - parseInt(b.priority_slot);
});

const expanded = [];
sortedAgents.forEach(agent => {
  const weight = parseInt(agent.assignment_weight || "1", 10);
  for (let i = 0; i < weight; i++) {
    expanded.push(agent);
  }
});

const assigned = expanded[pointer % expanded.length];
const newPointer = (pointer + 1) % expanded.length;

timing.wrr_compute_ms = Date.now() - t0;

// STEP 5 — Write pointer back
t0 = Date.now();

await sheets.spreadsheets.values.update({
  spreadsheetId: SHEET_ID,
  range: "RoutingState!B2",
  valueInputOption: "RAW",
  requestBody: {
    values: [[newPointer]],
  },
});

timing.sheets_write_pointer_ms = Date.now() - t0;

const totalTime = Date.now() - startTotal;
timing.total_ms = totalTime;

return {
  statusCode: 200,
  body: JSON.stringify({
    timing,
    assignment: {
      assigned_agent_id: assigned.agent_id,
      routing_pointer_before: pointer,
      routing_pointer_after: newPointer,
    },
    agents_considered: agents.length,
    message: "Test completed"
  }),
};

} catch (error) {
return {
statusCode: 500,
body: JSON.stringify({
error: error.message,
stack: error.stack
}),
};
}
};
