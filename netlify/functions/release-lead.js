const { google } = require("googleapis");
const { randomBytes } = require("crypto");

const SHEET_ID = "18x83a1VZIZoXrjASqTNfKdzYi1gDKLQD4fgx5WbyoWQ";
const ACTION_LINK_MAP_SHEET_ID = "1xNhypMirxoz9IjMWxO0H8gxNSqqavs2W17pzx8HiZfw";

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

  const nowUtc =
    new Date().toISOString();

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

  const claimResult =
    await claimReleaseQueueByReleaseId({
      sheets,
      spreadsheetId: SHEET_ID,
      release_id,
      nowUtc
    });

  if (!claimResult.claimed) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        status: claimResult.status,
        release_id,
        client_id: clientId,
        lead_id: leadId,
        routing_state_updated: false,
        downstream_writes_enabled: false,
        message: claimResult.message
      })
    };
  }

  console.log("release_queue_claimed", {
    release_id,
    client_id: clientId,
    lead_id: leadId,
    dispatch_claimed_ts_utc: claimResult.dispatch_claimed_ts_utc,
    release_attempts: claimResult.release_attempts
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

  const routingValues =
    routingRes.data.values || [];

  const routingHeaders =
    routingValues[0] || [];

  const routingStates =
    routingValues.slice(1).map((row, index) => {
      const obj = {};

      routingHeaders.forEach((header, headerIndex) => {
        obj[header] = row[headerIndex];
      });

      obj._row_number = index + 2;
      obj._row_values = row;

      return obj;
    });

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

  await updateRoutingStateAfterReleaseAssignment({
    sheets,
    spreadsheetId: SHEET_ID,
    routingHeaders,
    routingState,
    routingPointerAfter: assignmentResult.routing_pointer_after,
    assignedAgentId: assignmentResult.assigned_agent_id,
    nowUtc
  });

  await updateLeadLogAfterReleaseAssignment({
    sheets,
    spreadsheetId: leadDataSpreadsheetId,
    leadLogHeaders,
    leadLogRow,
    leadLogRowNumber,
    assignedAgentId: assignmentResult.assigned_agent_id,
    nowUtc
  });

  const actionLinks =
    await createReleaseInitialActionLink({
      sheets,
      lead_id: leadId,
      client,
      assigned_agent_id: assignmentResult.assigned_agent_id,
      trace_id: traceId,
      nowUtc
    });

  const reminderQueue =
    await createReleaseReminderQueueRow({
      sheets,
      client,
      lead_id: leadId,
      assigned_agent_id: assignmentResult.assigned_agent_id,
      trace_id: traceId,
      nowUtc
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
      status: "RELEASE_CLAIMED_ROUTINGSTATE_UPDATED",
      release_id,
      client_id: clientId,
      lead_id: leadId,
      matched_row_number: matchedRowNumber,
      release_status_before_claim: status,
      release_claim: {
        status: claimResult.status,
        dispatch_claimed_ts_utc: claimResult.dispatch_claimed_ts_utc,
        release_attempts: claimResult.release_attempts
      },
      lead_status: leadStatus,
      leadlog_row_number: leadLogRowNumber,
      trace_id: traceId,
      assignment: assignmentResult,
      routing_state_updated: true,
      downstream_writes_enabled: false,
      leadlog_updated: true,
      leadlog_update: {
        lead_status: "NEW",
        assigned_agent_id: assignmentResult.assigned_agent_id,
        assigned_timestamp: nowUtc,
        assignment_ts_utc: nowUtc,
        assignment_attempt_count: 1,
        last_updated_timestamp: nowUtc,
        routing_reason: leadLogHeaders.includes("routing_reason")
          ? "RELEASE_FROM_HOLD"
          : null
      },
      actionlink_created: true,
      action_links: actionLinks,
      reminderqueue_created: true,
      reminder_queue: reminderQueue
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

function getRequiredHeaderIndex(headers, headerName) {
  const index = headers.indexOf(headerName);

  if (index === -1) {
    throw new Error(`Missing required header: ${headerName}`);
  }

  return index;
}

function columnNumberToLetter(columnNumber) {
  let temp = columnNumber;
  let letter = "";

  while (temp > 0) {
    const remainder = (temp - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    temp = Math.floor((temp - 1) / 26);
  }

  return letter;
}

async function claimReleaseQueueByReleaseId({
  sheets,
  spreadsheetId,
  release_id,
  nowUtc
}) {
  const releaseRes =
    await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "ReleaseQueue!A1:Z10000"
    });

  const values = releaseRes.data.values || [];
  const headers = values[0] || [];
  const rows = values.slice(1);

  const releaseIdIndex =
    getRequiredHeaderIndex(headers, "release_id");

  const statusIndex =
    getRequiredHeaderIndex(headers, "status");

  const releasedTsIndex =
    getRequiredHeaderIndex(headers, "released_ts_utc");

  const dispatchClaimedTsIndex =
    getRequiredHeaderIndex(headers, "dispatch_claimed_ts_utc");

  const releaseAttemptsIndex =
    headers.indexOf("release_attempts");

  const notesIndex =
    headers.indexOf("notes");

  const matchedIndex =
    rows.findIndex(row => {
      return (
        String(row[releaseIdIndex] || "").trim() ===
        String(release_id || "").trim()
      );
    });

  if (matchedIndex === -1) {
    throw new Error(`ReleaseQueue row not found for release_id: ${release_id}`);
  }

  const rowNumber = matchedIndex + 2;
  const row = [...rows[matchedIndex]];

  while (row.length < headers.length) {
    row.push("");
  }

  const currentStatus =
    String(row[statusIndex] || "").trim().toUpperCase();

  const releasedTsUtc =
    String(row[releasedTsIndex] || "").trim();

  const dispatchClaimedTsUtc =
    String(row[dispatchClaimedTsIndex] || "").trim();

  if (releasedTsUtc || currentStatus === "RELEASED") {
    return {
      claimed: false,
      status: "RELEASE_ALREADY_PROCESSED",
      message: "ReleaseQueue row is already released."
    };
  }

  if (dispatchClaimedTsUtc || currentStatus === "PROCESSING") {
    return {
      claimed: false,
      status: "RELEASE_ALREADY_CLAIMED",
      message: "ReleaseQueue row is already claimed for processing."
    };
  }

  if (
    currentStatus !== "PENDING" &&
    currentStatus !== "ACTIVE"
  ) {
    return {
      claimed: false,
      status: "RELEASE_NOT_ELIGIBLE",
      message: `ReleaseQueue row is not eligible for claim. Current status: ${currentStatus || "BLANK"}`
    };
  }

  row[dispatchClaimedTsIndex] = nowUtc;
  row[statusIndex] = "PROCESSING";

  let releaseAttempts = null;

  if (releaseAttemptsIndex !== -1) {
    const previousAttempts =
      parseInt(row[releaseAttemptsIndex] || "0", 10);

    releaseAttempts =
      Number.isFinite(previousAttempts)
        ? previousAttempts + 1
        : 1;

    row[releaseAttemptsIndex] = releaseAttempts;
  }

  if (notesIndex !== -1) {
    const existingNotes =
      String(row[notesIndex] || "").trim();

    const claimNote =
      `[${nowUtc}] Netlify release claim accepted; RoutingState milestone only.`;

    row[notesIndex] =
      existingNotes
        ? `${existingNotes}\n${claimNote}`
        : claimNote;
  }

  const endColumn =
    columnNumberToLetter(headers.length);

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `ReleaseQueue!A${rowNumber}:${endColumn}${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [row]
    }
  });

  return {
    claimed: true,
    status: "RELEASE_CLAIMED",
    dispatch_claimed_ts_utc: nowUtc,
    release_attempts: releaseAttempts
  };
}

async function updateRoutingStateAfterReleaseAssignment({
  sheets,
  spreadsheetId,
  routingHeaders,
  routingState,
  routingPointerAfter,
  assignedAgentId,
  nowUtc
}) {
  const routingPointerIndex =
    getRequiredHeaderIndex(routingHeaders, "routing_pointer");

  const updatedTsIndex =
    getRequiredHeaderIndex(routingHeaders, "updated_ts_utc");

  const lastAssignedAgentIndex =
    getRequiredHeaderIndex(routingHeaders, "last_assigned_agent_id");

  const lastAssignmentTimestampIndex =
    getRequiredHeaderIndex(routingHeaders, "last_assignment_timestamp");

  const rowNumber =
    routingState._row_number;

  if (!rowNumber) {
    throw new Error("RoutingState row number missing for update.");
  }

  const row =
    [...routingState._row_values];

  while (row.length < routingHeaders.length) {
    row.push("");
  }

  row[routingPointerIndex] =
    routingPointerAfter;

  row[updatedTsIndex] =
    nowUtc;

  row[lastAssignedAgentIndex] =
    assignedAgentId;

  row[lastAssignmentTimestampIndex] =
    nowUtc;

  const endColumn =
    columnNumberToLetter(routingHeaders.length);

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `RoutingState!A${rowNumber}:${endColumn}${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [row]
    }
  });
}

async function updateLeadLogAfterReleaseAssignment({
  sheets,
  spreadsheetId,
  leadLogHeaders,
  leadLogRow,
  leadLogRowNumber,
  assignedAgentId,
  nowUtc
}) {
  const leadStatusIndex =
    getRequiredHeaderIndex(leadLogHeaders, "lead_status");

  const assignedAgentIdIndex =
    getRequiredHeaderIndex(leadLogHeaders, "assigned_agent_id");

  const assignedTimestampIndex =
    getRequiredHeaderIndex(leadLogHeaders, "assigned_timestamp");

  const assignmentTsUtcIndex =
    getRequiredHeaderIndex(leadLogHeaders, "assignment_ts_utc");

  const assignmentAttemptCountIndex =
    getRequiredHeaderIndex(leadLogHeaders, "assignment_attempt_count");

  const lastUpdatedTimestampIndex =
    getRequiredHeaderIndex(leadLogHeaders, "last_updated_timestamp");

  const routingReasonIndex =
    leadLogHeaders.indexOf("routing_reason");

  const row =
    [...leadLogRow];

  while (row.length < leadLogHeaders.length) {
    row.push("");
  }

  row[leadStatusIndex] =
    "NEW";

  row[assignedAgentIdIndex] =
    assignedAgentId;

  row[assignedTimestampIndex] =
    nowUtc;

  row[assignmentTsUtcIndex] =
    nowUtc;

  row[assignmentAttemptCountIndex] =
    "1";

  row[lastUpdatedTimestampIndex] =
    nowUtc;

  if (routingReasonIndex !== -1) {
    row[routingReasonIndex] =
      "RELEASE_FROM_HOLD";
  }

  const endColumn =
    columnNumberToLetter(leadLogHeaders.length);

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `LeadLog_Active!A${leadLogRowNumber}:${endColumn}${leadLogRowNumber}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [row]
    }
  });
}

function generateShortCode(length = 6) {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

  const bytes =
    randomBytes(length);

  let shortCode =
    "";

  for (let i = 0; i < length; i++) {
    shortCode +=
      alphabet[bytes[i] % alphabet.length];
  }

  return shortCode;
}

async function createReleaseInitialActionLink({
  sheets,
  lead_id,
  client,
  assigned_agent_id,
  trace_id,
  nowUtc
}) {
  const gateway_context =
    "INITIAL_RESPONSE_GATEWAY";

  const created_ts_utc =
    nowUtc;

  const existingRes =
    await sheets.spreadsheets.values.get({
      spreadsheetId: ACTION_LINK_MAP_SHEET_ID,
      range: "ActionLinkMap!A1:N1000"
    });

  const existingRows =
    existingRes.data.values || [];

  const existingShortCodes =
    new Set(existingRows.slice(1).map(row => row[0]));

  let short_code;
  let attempts = 0;

  while (attempts < 3) {
    const candidate =
      generateShortCode();

    if (!existingShortCodes.has(candidate)) {
      short_code =
        candidate;
      break;
    }

    attempts++;
  }

  if (!short_code) {
    throw new Error("Failed to generate unique short_code for release INITIAL_RESPONSE_GATEWAY after 3 attempts");
  }

  const public_url =
    `https://engagepriority.com/a/${short_code}`;

  await sheets.spreadsheets.values.append({
    spreadsheetId: ACTION_LINK_MAP_SHEET_ID,
    range: "ActionLinkMap!A:P",
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        short_code,
        public_url,
        gateway_context,
        "",
        lead_id,
        client.client_id,
        client.lead_data_spreadsheet_id,
        assigned_agent_id,
        "",
        "TRUE",
        created_ts_utc,
        "",
        "",
        "",
        "",
        trace_id
      ]]
    }
  });

  return {
    INITIAL_RESPONSE_GATEWAY: {
      short_code,
      token: short_code,
      public_url
    }
  };
}

async function createReleaseReminderQueueRow({
  sheets,
  client,
  lead_id,
  assigned_agent_id,
  trace_id,
  nowUtc
}) {
  const reminderDelayMinutes =
    parseInt(client.reminder_1_delay_minutes, 10);

  if (!Number.isFinite(reminderDelayMinutes) || reminderDelayMinutes <= 0) {
    throw new Error(`Invalid reminder_1_delay_minutes for client_id: ${client.client_id}`);
  }

  const nextActionDue =
    new Date(new Date(nowUtc).getTime() + reminderDelayMinutes * 60000).toISOString();

  const reminderRow = [
    trace_id,
    client.client_id,
    lead_id,
    "",
    client.lead_data_spreadsheet_id,
    assigned_agent_id,
    "TRUE",
    nextActionDue,
    "REMINDER_1",
    "",
    "",
    ""
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "ReminderQueue!A1",
    valueInputOption: "RAW",
    requestBody: {
      values: [reminderRow]
    }
  });

  return {
    active_monitoring: true,
    next_action_due_ts_utc: nextActionDue,
    next_action_type: "REMINDER_1"
  };
}
