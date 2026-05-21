const { google } = require("googleapis");

const SHEET_ID = "18x83a1VZIZoXrjASqTNfKdzYi1gDKLQD4fgx5WbyoWQ";

exports.handler = async (event, context) => {

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({
        error: "Method not allowed"
      })
    };
  }

  const providedSecret =
    event.headers["x-ep-release-secret"];

  if (
    !providedSecret ||
    providedSecret !== process.env.EP_RELEASE_SHARED_SECRET
  ) {
    console.log("release_auth_failed");

    return {
      statusCode: 403,
      body: JSON.stringify({
        error: "Forbidden"
      })
    };
  }

  let payload = {};

  try {
    payload = JSON.parse(event.body || "{}");
  } catch (err) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: "Invalid JSON payload"
      })
    };
  }

  const release_id =
    String(payload.release_id || "").trim();

  if (!release_id) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: "Missing release_id"
      })
    };
  }

  console.log("release_request_received", {
    release_id
  });

  const credentials = JSON.parse(
    process.env.GOOGLE_SERVICE_ACCOUNT
  );

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets"
    ]
  });

  const sheets = google.sheets({
    version: "v4",
    auth
  });

  const releaseQueueRes =
    await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "ReleaseQueue!A1:Z10000"
    });

  const rows = releaseQueueRes.data.values || [];

  if (rows.length < 2) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "ReleaseQueue empty"
      })
    };
  }

  const headers = rows[0];

  const releaseIdIndex =
    headers.indexOf("release_id");

  if (releaseIdIndex === -1) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Missing release_id column"
      })
    };
  }

  let matchedRow = null;
  let matchedRowNumber = null;

  for (let index = 1; index < rows.length; index++) {
    const row = rows[index];

    if (
      String(row[releaseIdIndex] || "").trim() === release_id
    ) {
      matchedRow = row;
      matchedRowNumber = index + 1;
      break;
    }
  }

  if (!matchedRow) {
    return {
      statusCode: 404,
      body: JSON.stringify({
        error: "ReleaseQueue row not found"
      })
    };
  }

  console.log("release_row_found", {
    release_id,
    matched_row_number: matchedRowNumber
  });

  const clientIdIndex =
    headers.indexOf("client_id");

  const leadIdIndex =
    headers.indexOf("lead_id");

  const statusIndex =
    headers.indexOf("status");

  const releasedTsIndex =
    headers.indexOf("released_ts_utc");

  if (statusIndex === -1) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Missing status column"
      })
    };
  }

  if (releasedTsIndex === -1) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Missing released_ts_utc column"
      })
    };
  }

  if (clientIdIndex === -1) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Missing client_id column"
      })
    };
  }

  if (leadIdIndex === -1) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Missing lead_id column"
      })
    };
  }
  
  const status =
    String(matchedRow[statusIndex] || "").trim().toUpperCase();

  const releasedTsUtc =
    String(matchedRow[releasedTsIndex] || "").trim();

  const clientId =
    String(matchedRow[clientIdIndex] || "").trim();

  const leadId =
    String(matchedRow[leadIdIndex] || "").trim();

  if (!clientId || !leadId) {
    return {
      statusCode: 409,
      body: JSON.stringify({
        error: "ReleaseQueue row missing client_id or lead_id"
      })
    };
  }

  if (releasedTsUtc || status === "RELEASED") {
    return {
      statusCode: 409,
      body: JSON.stringify({
        error: "ReleaseQueue row already released"
      })
    };
  }

  if (
    status !== "PENDING" &&
    status !== "ACTIVE"
  ) {
    return {
      statusCode: 409,
      body: JSON.stringify({
        error: "ReleaseQueue row is not eligible for release",
        status
      })
    };
  }

  const clientsRes =
    await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Clients!A1:Z10000"
    });

  const clientRows = clientsRes.data.values || [];

  if (clientRows.length < 2) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Clients table empty"
      })
    };
  }

  const clientHeaders = clientRows[0];

  const clientIdClientIndex =
    clientHeaders.indexOf("client_id");

  const leadDataSpreadsheetIdIndex =
    clientHeaders.indexOf("lead_data_spreadsheet_id");

  if (clientIdClientIndex === -1) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Clients table missing client_id column"
      })
    };
  }

  if (leadDataSpreadsheetIdIndex === -1) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Clients table missing lead_data_spreadsheet_id column"
      })
    };
  }

  const clientRow =
    clientRows.slice(1).find(row => {
      return (
        String(row[clientIdClientIndex] || "").trim() === clientId
      );
    });

  if (!clientRow) {
    return {
      statusCode: 404,
      body: JSON.stringify({
        error: "Client not found"
      })
    };
  }

  const leadDataSpreadsheetId =
    String(
      clientRow[leadDataSpreadsheetIdIndex] || ""
    ).trim();

  if (!leadDataSpreadsheetId) {
    return {
      statusCode: 409,
      body: JSON.stringify({
        error: "Client missing lead_data_spreadsheet_id"
      })
    };
  }

  console.log("release_client_resolved", {
    release_id,
    client_id: clientId
  });

  const leadLogRes =
    await sheets.spreadsheets.values.get({
      spreadsheetId: leadDataSpreadsheetId,
      range: "LeadLog_Active!A1:BI10000"
    });

  const leadLogRows = leadLogRes.data.values || [];

  if (leadLogRows.length < 2) {
    return {
      statusCode: 404,
      body: JSON.stringify({
        error: "LeadLog_Active empty"
      })
    };
  }

  const leadLogHeaders = leadLogRows[0];

  const leadLogLeadIdIndex =
    leadLogHeaders.indexOf("lead_id");

  const leadLogClientIdIndex =
    leadLogHeaders.indexOf("client_id");

  const leadStatusIndex =
    leadLogHeaders.indexOf("lead_status");

  const traceIdIndex =
    leadLogHeaders.indexOf("trace_id");

  if (
    leadLogLeadIdIndex === -1 ||
    leadLogClientIdIndex === -1 ||
    leadStatusIndex === -1 ||
    traceIdIndex === -1
  ) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "LeadLog_Active missing required release columns"
      })
    };
  }

  let leadLogRow = null;
  let leadLogRowNumber = null;

  for (let index = 1; index < leadLogRows.length; index++) {
    const row = leadLogRows[index];

    if (
      String(row[leadLogLeadIdIndex] || "").trim() === leadId &&
      String(row[leadLogClientIdIndex] || "").trim() === clientId
    ) {
      leadLogRow = row;
      leadLogRowNumber = index + 1;
      break;
    }
  }

  if (!leadLogRow) {
    return {
      statusCode: 404,
      body: JSON.stringify({
        error: "Held lead not found in LeadLog_Active"
      })
    };
  }

  const leadStatus =
    String(leadLogRow[leadStatusIndex] || "").trim().toUpperCase();

  const traceId =
    String(leadLogRow[traceIdIndex] || "").trim();

  if (leadStatus !== "PENDING_RELEASE") {
    return {
      statusCode: 409,
      body: JSON.stringify({
        error: "Lead is not pending release",
        lead_status: leadStatus
      })
    };
  }

  console.log("release_held_lead_found", {
    release_id,
    client_id: clientId,
    lead_id: leadId,
    leadlog_row_number: leadLogRowNumber
  });

  const agentsRes =
    await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Agents!A1:Z10000"
    });

  const routingRes =
    await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "RoutingState!A1:Z10000"
    });

  const agents =
    rowsToObjects(agentsRes.data.values || []);

  const routingStates =
    rowsToObjects(routingRes.data.values || []);

  const eligibleAgents =
    agents.filter(agent => {
      return (
        String(agent.client_id || "").trim() === clientId &&
        String(agent.agent_status || "").trim().toUpperCase() === "ACTIVE"
      );
    });

  if (eligibleAgents.length === 0) {
    return {
      statusCode: 409,
      body: JSON.stringify({
        error: "No active agents available for release"
      })
    };
  }

const routingState =
  routingStates.find(row => {
    return String(row.client_id || "").trim() === clientId;
  });

if (!routingState) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "RoutingState missing for client"
      })
    };
  }

  const routingStrategy =
    String(clientRow[clientHeaders.indexOf("routing_strategy")] || "").trim();

  if (!routingStrategy) {
    return {
      statusCode: 409,
      body: JSON.stringify({
        error: "Client missing routing_strategy"
      })
    };
  }

  const routingPointer =
    parseInt(routingState.routing_pointer || "0", 10);

  if (!Number.isFinite(routingPointer) || routingPointer < 0) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Invalid routing_pointer"
      })
    };
  }

  const assignmentResult =
    routeByStrategy({
      routing_strategy: routingStrategy,
      agents: eligibleAgents,
      routing_pointer: routingPointer
    });

  console.log("release_assignment_computed", {
    release_id,
    client_id: clientId,
    lead_id: leadId,
    assigned_agent_id: assignmentResult.assigned_agent_id,
    routing_pointer_before: assignmentResult.routing_pointer_before,
    routing_pointer_after: assignmentResult.routing_pointer_after
  });

  console.log("release_row_eligible", {
    release_id,
    status
  });

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "RELEASE_ROW_ELIGIBLE",
      release_id,
      client_id: clientId,
      lead_id: leadId,
      matched_row_number: matchedRowNumber,
      release_status: status,
      lead_status: leadStatus,
      leadlog_row_number: leadLogRowNumber,
      trace_id: traceId,
      assignment: assignmentResult
    })
  };
};

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
  const routingPointerAfter =
    routingPointerBefore + 1 >= cycle.length
      ? 0
      : routingPointerBefore + 1;

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

function rowsToObjects(rows) {
  const headers = rows[0] || [];

  return rows.slice(1).map(row => {
    const obj = {};

    headers.forEach((header, index) => {
      obj[header] = row[index];
    });

    return obj;
  });
}