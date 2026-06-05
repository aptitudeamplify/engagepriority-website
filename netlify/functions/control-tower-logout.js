const {
  buildClearSessionCookie,
  getCentralRegistrySpreadsheetId,
  getCookieValue,
  getSheetsClient,
  hashValue,
  jsonResponse,
  methodNotAllowedResponse,
  nowIso,
  readCentralRegistryTab,
  requireFields,
  rowsToObjectsByHeader,
  safeErrorResponse
} = require("./control-tower-utils");

const TAB_SESSIONS = "ControlTowerSessions";
const SESSION_STATUS_REVOKED = "REVOKED";

exports.handler = async function handler(event) {
  const method = String(event.httpMethod || "").toUpperCase();

  if (method !== "POST") {
    return methodNotAllowedResponse();
  }

  console.log("control_tower_logout_received", {
    method,
    event_ts_utc: nowIso()
  });

  try {
    const sessionToken = getCookieValue(event);

    if (!sessionToken) {
      console.log("control_tower_logout_no_session_cookie", {
        event_ts_utc: nowIso()
      });

      return logoutSuccessResponse();
    }

    const sessionIdHash = hashValue(sessionToken, "control_tower_session");
    const sheets = await getSheetsClient();
    const registrySpreadsheetId = getCentralRegistrySpreadsheetId();

    const sessionTable = rowsToObjectsByHeader(
      await readCentralRegistryTab(sheets, TAB_SESSIONS)
    );

    requireFields(sessionTable.headerIndex, [
      "session_id_hash",
      "revoked_ts_utc",
      "status"
    ], TAB_SESSIONS);

    const matchingSession = sessionTable.rows.find(row => {
      return String(row.session_id_hash || "") === sessionIdHash;
    });

    if (!matchingSession) {
      console.log("control_tower_logout_session_not_found", {
        event_ts_utc: nowIso()
      });

      return logoutSuccessResponse();
    }

    const revokedTsUtc = String(matchingSession.revoked_ts_utc || "").trim();
    const status = String(matchingSession.status || "").trim().toUpperCase();

    if (status !== SESSION_STATUS_REVOKED || !revokedTsUtc) {
      await revokeSessionRow({
        sheets,
        registrySpreadsheetId,
        sessionTable,
        sessionRowNumber: matchingSession._sheet_row_number,
        revokedTsUtc: nowIso()
      });

      console.log("control_tower_logout_session_revoked", {
        event_ts_utc: nowIso()
      });
    } else {
      console.log("control_tower_logout_session_already_revoked", {
        event_ts_utc: nowIso()
      });
    }

    return logoutSuccessResponse();
  } catch (error) {
    console.error("control_tower_logout_error", {
      safe_error: "LOGOUT_FAILED",
      message: error.message,
      event_ts_utc: nowIso()
    });

    return safeErrorResponse();
  }
};

async function revokeSessionRow({
  sheets,
  registrySpreadsheetId,
  sessionTable,
  sessionRowNumber,
  revokedTsUtc
}) {
  const statusColumnIndex = sessionTable.headerIndex.status;
  const revokedColumnIndex = sessionTable.headerIndex.revoked_ts_utc;

  if (!sessionRowNumber || sessionRowNumber < 2) {
    throw new Error("Invalid ControlTowerSessions row number for logout.");
  }

  await Promise.all([
    sheets.spreadsheets.values.update({
      spreadsheetId: registrySpreadsheetId,
      range: `${TAB_SESSIONS}!${columnLetter(statusColumnIndex + 1)}${sessionRowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[SESSION_STATUS_REVOKED]]
      }
    }),
    sheets.spreadsheets.values.update({
      spreadsheetId: registrySpreadsheetId,
      range: `${TAB_SESSIONS}!${columnLetter(revokedColumnIndex + 1)}${sessionRowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[revokedTsUtc]]
      }
    })
  ]);
}

function logoutSuccessResponse() {
  return jsonResponse(200, {
    ok: true,
    signed_out: true,
    redirect_to: "/login?status=signed_out"
  }, {
    "Set-Cookie": buildClearSessionCookie()
  });
}

function columnLetter(columnNumber) {
  let number = Number(columnNumber);
  let result = "";

  while (number > 0) {
    const remainder = (number - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    number = Math.floor((number - 1) / 26);
  }

  return result;
}

module.exports = {
  handler: exports.handler
};
