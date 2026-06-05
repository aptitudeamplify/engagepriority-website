const {
  getCentralRegistrySpreadsheetId,
  getCookieValue,
  getSheetsClient,
  hashValue,
  jsonResponse,
  methodNotAllowedResponse,
  parseDateMs,
  readCentralRegistryTab,
  requireFields,
  rowsToObjectsByHeader,
  safeErrorResponse,
  unauthorizedResponse,
  nowIso
} = require("./control-tower-utils");

const TAB_SESSIONS = "ControlTowerSessions";
const TAB_APPROVED_ADMIN_CONTACTS = "ApprovedAdminContacts";
const TAB_CLIENTS = "Clients";

const SESSION_STATUS_ACTIVE = "ACTIVE";
const CONTACT_STATUS_ACTIVE = "ACTIVE";
const CONTACT_ROLE_ADMIN = "ADMIN";
const CLIENT_STATUS_ACTIVE = "ACTIVE";

exports.handler = async function handler(event) {
  const method = String(event.httpMethod || "").toUpperCase();

  if (method !== "GET") {
    return methodNotAllowedResponse();
  }

  const eventTsUtc = nowIso();

  console.log("control_tower_session_check_received", {
    method,
    event_ts_utc: eventTsUtc
  });

  try {
    const sessionToken = getCookieValue(event);

    if (!sessionToken) {
      console.log("control_tower_session_check_denied", {
        reason: "MISSING_SESSION_COOKIE",
        event_ts_utc: nowIso()
      });

      return unauthorizedResponse();
    }

    const sessionIdHash = hashValue(sessionToken, "control_tower_session");
    const sheets = await getSheetsClient();
    const registrySpreadsheetId = getCentralRegistrySpreadsheetId();

    const sessionTable = rowsToObjectsByHeader(
      await readCentralRegistryTab(sheets, TAB_SESSIONS)
    );

    requireFields(sessionTable.headerIndex, [
      "session_id_hash",
      "created_ts_utc",
      "expires_ts_utc",
      "revoked_ts_utc",
      "approved_contact_key",
      "client_id",
      "role",
      "login_channel",
      "status"
    ], TAB_SESSIONS);

    const sessionRow = sessionTable.rows.find(row => {
      return String(row.session_id_hash || "") === sessionIdHash;
    });

    if (!sessionRow) {
      console.log("control_tower_session_check_denied", {
        reason: "SESSION_NOT_FOUND",
        event_ts_utc: nowIso()
      });

      return unauthorizedResponse();
    }

    const sessionStatus = String(sessionRow.status || "").trim().toUpperCase();
    const revokedTsUtc = String(sessionRow.revoked_ts_utc || "").trim();
    const expiresTsUtc = String(sessionRow.expires_ts_utc || "").trim();
    const expiresMs = parseDateMs(expiresTsUtc);
    const nowMs = Date.now();

    if (sessionStatus !== SESSION_STATUS_ACTIVE) {
      console.log("control_tower_session_check_denied", {
        reason: "SESSION_NOT_ACTIVE",
        event_ts_utc: nowIso()
      });

      return unauthorizedResponse();
    }

    if (revokedTsUtc) {
      console.log("control_tower_session_check_denied", {
        reason: "SESSION_REVOKED",
        event_ts_utc: nowIso()
      });

      return unauthorizedResponse();
    }

    if (!expiresMs || expiresMs <= nowMs) {
      console.log("control_tower_session_check_denied", {
        reason: "SESSION_EXPIRED",
        event_ts_utc: nowIso()
      });

      return unauthorizedResponse();
    }

    const approvedContactKey = String(sessionRow.approved_contact_key || "").trim();
    const clientId = String(sessionRow.client_id || "").trim();
    const role = String(sessionRow.role || "").trim().toUpperCase();
    const loginChannel = String(sessionRow.login_channel || "").trim().toUpperCase();

    if (!approvedContactKey || !clientId || role !== CONTACT_ROLE_ADMIN) {
      console.log("control_tower_session_check_denied", {
        reason: "SESSION_SCOPE_INVALID",
        event_ts_utc: nowIso()
      });

      return unauthorizedResponse();
    }

    const contactsTable = rowsToObjectsByHeader(
      await readCentralRegistryTab(sheets, TAB_APPROVED_ADMIN_CONTACTS)
    );

    requireFields(contactsTable.headerIndex, [
      "approved_contact_key",
      "client_id",
      "email",
      "phone",
      "role",
      "status"
    ], TAB_APPROVED_ADMIN_CONTACTS);

    const contactRow = contactsTable.rows.find(row => {
      return String(row.approved_contact_key || "").trim() === approvedContactKey;
    });

    if (!isActiveAdminContactForClient(contactRow, clientId)) {
      console.log("control_tower_session_check_denied", {
        reason: "APPROVED_CONTACT_INVALID",
        client_id: clientId,
        event_ts_utc: nowIso()
      });

      return unauthorizedResponse();
    }

    const clientsTable = rowsToObjectsByHeader(
      await readCentralRegistryTab(sheets, TAB_CLIENTS)
    );

    requireFields(clientsTable.headerIndex, [
      "client_id",
      "client_status",
      "primary_timezone",
      "lead_data_spreadsheet_id"
    ], TAB_CLIENTS);

    const clientRow = clientsTable.rows.find(row => {
      return String(row.client_id || "").trim() === clientId;
    });

    if (!isActiveClient(clientRow)) {
      console.log("control_tower_session_check_denied", {
        reason: "CLIENT_INVALID",
        client_id: clientId,
        event_ts_utc: nowIso()
      });

      return unauthorizedResponse();
    }

    console.log("control_tower_session_check_ok", {
      client_id: clientId,
      role,
      login_channel: loginChannel,
      event_ts_utc: nowIso()
    });

    return jsonResponse(200, {
      ok: true,
      authenticated: true,
      session: {
        role,
        login_channel: loginChannel,
        expires_ts_utc: expiresTsUtc
      }
    });
  } catch (error) {
    console.error("control_tower_session_check_error", {
      safe_error: "SESSION_CHECK_FAILED",
      message: error.message,
      event_ts_utc: nowIso()
    });

    return safeErrorResponse();
  }
};

function isActiveAdminContactForClient(contactRow, clientId) {
  if (!contactRow) {
    return false;
  }

  const rowClientId = String(contactRow.client_id || "").trim();
  const status = String(contactRow.status || "").trim().toUpperCase();
  const role = String(contactRow.role || "").trim().toUpperCase();
  const email = String(contactRow.email || "").trim();
  const phone = String(contactRow.phone || "").trim();

  return (
    rowClientId === clientId &&
    status === CONTACT_STATUS_ACTIVE &&
    role === CONTACT_ROLE_ADMIN &&
    Boolean(email) &&
    Boolean(phone)
  );
}

function isActiveClient(clientRow) {
  if (!clientRow) {
    return false;
  }

  const status = String(clientRow.client_status || "").trim().toUpperCase();
  const spreadsheetId = String(clientRow.lead_data_spreadsheet_id || "").trim();
  const timezone = String(clientRow.primary_timezone || "").trim();

  return (
    status === CLIENT_STATUS_ACTIVE &&
    Boolean(spreadsheetId) &&
    Boolean(timezone)
  );
}

module.exports = {
  handler: exports.handler
};
