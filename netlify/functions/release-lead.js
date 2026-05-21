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
      trace_id: traceId
    })
  };
};