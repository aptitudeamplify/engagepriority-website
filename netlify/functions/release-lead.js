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

  const status =
    String(matchedRow[statusIndex] || "").trim().toUpperCase();

  const releasedTsUtc =
    String(matchedRow[releasedTsIndex] || "").trim();

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

  console.log("release_row_eligible", {
    release_id,
    status
  });

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "RELEASE_ROW_ELIGIBLE",
      release_id,
      matched_row_number: matchedRowNumber,
      release_status: status
    })
  };
};