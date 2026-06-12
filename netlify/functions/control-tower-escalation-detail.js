const {
  getCentralRegistrySpreadsheetId,
  getCookieValue,
  getSheetsClient,
  hashValue,
  jsonResponse,
  methodNotAllowedResponse,
  parseDateMs,
  readCentralRegistryTab,
  readSheetValues,
  requireFields,
  rowsToObjectsByHeader,
  safeErrorResponse,
  unauthorizedResponse,
  nowIso
} = require("./control-tower-utils");

const TAB_SESSIONS = "ControlTowerSessions";
const TAB_APPROVED_ADMIN_CONTACTS = "ApprovedAdminContacts";
const TAB_CLIENTS = "Clients";
const TAB_LEAD_LOG_ACTIVE = "LeadLog_Active";

const SESSION_STATUS_ACTIVE = "ACTIVE";
const CONTACT_STATUS_ACTIVE = "ACTIVE";
const CONTACT_ROLE_ADMIN = "ADMIN";
const CLIENT_STATUS_ACTIVE = "ACTIVE";

exports.handler = async function handler(event) {
  const method = String(event.httpMethod || "").toUpperCase();

  if (method !== "GET") {
    return methodNotAllowedResponse();
  }

  const leadId = trimmed(event.queryStringParameters?.lead_id);

  console.log("control_tower_escalation_detail_received", {
    has_lead_id: Boolean(leadId),
    event_ts_utc: nowIso()
  });

  if (!leadId) {
    return safeErrorResponse(400, "INVALID_REQUEST", "Missing lead id.");
  }

  try {
    const authContext = await validateSession(event);
    const { sheets, clientId, clientRow } = authContext;
    const clientSpreadsheetId = trimmed(clientRow.lead_data_spreadsheet_id);

    const leadTable = await readClientTable(sheets, clientSpreadsheetId, TAB_LEAD_LOG_ACTIVE, [
      "lead_id",
      "client_id",
      "full_name",
      "email",
      "phone",
      "lead_status",
      "admin_escalation_required",
      "admin_resolution_status"
    ]);

    const leadRow = leadTable.rows.find(row => trimmed(row.lead_id) === leadId);

    if (!isEligibleEscalatedLead(leadRow, clientId)) {
      console.log("control_tower_escalation_detail_denied", {
        client_id: clientId,
        reason: "LEAD_NOT_ELIGIBLE",
        event_ts_utc: nowIso()
      });

      return safeErrorResponse(404, "LEAD_NOT_ELIGIBLE", "Resolution details are not available for this lead.");
    }

    console.log("control_tower_escalation_detail_returned", {
      client_id: clientId,
      event_ts_utc: nowIso()
    });

    return jsonResponse(200, {
      ok: true,
      lead: {
        lead_id: leadId,
        lead_name: sanitizedText(leadRow.full_name) || "Lead",
        email: trimmed(leadRow.email) || null,
        phone: trimmed(leadRow.phone) || null,
        admin_resolution_eligible: true
      }
    });
  } catch (error) {
    if (error && error.code === "SESSION_REQUIRED") {
      console.log("control_tower_escalation_detail_session_denied", {
        reason: error.reason || "SESSION_REQUIRED",
        event_ts_utc: nowIso()
      });

      return unauthorizedResponse();
    }

    console.error("control_tower_escalation_detail_error", {
      safe_error: "CONTROL_TOWER_ESCALATION_DETAIL_FAILED",
      message: safeLogMessage(error),
      event_ts_utc: nowIso()
    });

    return safeErrorResponse();
  }
};

async function validateSession(event) {
  const sessionToken = getCookieValue(event);

  if (!sessionToken) {
    throwSessionRequired("MISSING_SESSION_COOKIE");
  }

  const sessionIdHash = hashValue(sessionToken, "control_tower_session");
  const sheets = await getSheetsClient();
  const registrySpreadsheetId = getCentralRegistrySpreadsheetId();

  const sessionTable = rowsToObjectsByHeader(
    await readCentralRegistryTab(sheets, TAB_SESSIONS)
  );

  requireFields(sessionTable.headerIndex, [
    "session_id_hash",
    "expires_ts_utc",
    "revoked_ts_utc",
    "approved_contact_key",
    "client_id",
    "role",
    "status"
  ], TAB_SESSIONS);

  const sessionRow = sessionTable.rows.find(row => trimmed(row.session_id_hash) === sessionIdHash);

  if (!sessionRow) {
    throwSessionRequired("SESSION_NOT_FOUND");
  }

  const sessionStatus = upper(sessionRow.status);
  const revokedTsUtc = trimmed(sessionRow.revoked_ts_utc);
  const expiresMs = parseDateMs(sessionRow.expires_ts_utc);

  if (sessionStatus !== SESSION_STATUS_ACTIVE) {
    throwSessionRequired("SESSION_NOT_ACTIVE");
  }

  if (revokedTsUtc) {
    throwSessionRequired("SESSION_REVOKED");
  }

  if (!expiresMs || expiresMs <= Date.now()) {
    throwSessionRequired("SESSION_EXPIRED");
  }

  const approvedContactKey = trimmed(sessionRow.approved_contact_key);
  const clientId = trimmed(sessionRow.client_id);
  const role = upper(sessionRow.role);

  if (!approvedContactKey || !clientId || role !== CONTACT_ROLE_ADMIN) {
    throwSessionRequired("SESSION_SCOPE_INVALID");
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

  const contactRow = contactsTable.rows.find(row => trimmed(row.approved_contact_key) === approvedContactKey);

  if (!isActiveAdminContactForClient(contactRow, clientId)) {
    throwSessionRequired("APPROVED_CONTACT_INVALID");
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

  const clientRow = clientsTable.rows.find(row => trimmed(row.client_id) === clientId);

  if (!isActiveClient(clientRow)) {
    throwSessionRequired("CLIENT_INVALID");
  }

  return {
    sheets,
    registrySpreadsheetId,
    sessionRow,
    contactRow,
    clientRow,
    clientId
  };
}

function throwSessionRequired(reason) {
  const error = new Error("Control Tower session required.");
  error.code = "SESSION_REQUIRED";
  error.reason = reason;
  throw error;
}

async function readClientTable(sheets, spreadsheetId, tabName, requiredFields) {
  const table = rowsToObjectsByHeader(
    await readSheetValues(sheets, spreadsheetId, `${tabName}!A1:ZZ10000`)
  );

  requireFields(table.headerIndex, requiredFields, tabName);
  return table;
}

function isEligibleEscalatedLead(leadRow, clientId) {
  if (!leadRow || trimmed(leadRow.client_id) !== clientId) {
    return false;
  }

  if (!truthy(leadRow.admin_escalation_required)) {
    return false;
  }

  if (trimmed(leadRow.admin_resolution_status)) {
    return false;
  }

  return !isClosedLead(leadRow);
}

function isClosedLead(leadRow) {
  const leadStatus = upper(leadRow.lead_status);

  return [
    "CLOSED",
    "COMPLETE",
    "COMPLETED",
    "OUTCOME_RECORDED",
    "CONTACTED_SET_APPOINTMENT",
    "CONTACTED_NOT_INTERESTED"
  ].includes(leadStatus);
}

function isActiveAdminContactForClient(contactRow, clientId) {
  if (!contactRow) {
    return false;
  }

  return (
    trimmed(contactRow.client_id) === clientId &&
    upper(contactRow.status) === CONTACT_STATUS_ACTIVE &&
    upper(contactRow.role) === CONTACT_ROLE_ADMIN &&
    Boolean(trimmed(contactRow.email)) &&
    Boolean(trimmed(contactRow.phone))
  );
}

function isActiveClient(clientRow) {
  if (!clientRow) {
    return false;
  }

  return (
    upper(clientRow.client_status) === CLIENT_STATUS_ACTIVE &&
    Boolean(trimmed(clientRow.lead_data_spreadsheet_id)) &&
    Boolean(trimmed(clientRow.primary_timezone))
  );
}

function truthy(value) {
  const text = upper(value);
  return ["TRUE", "YES", "Y", "1"].includes(text);
}

function upper(value) {
  return String(value || "").trim().toUpperCase();
}

function trimmed(value) {
  return String(value || "").trim();
}

function sanitizedText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function safeLogMessage(error) {
  const message = String(error?.message || "");

  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]")
    .slice(0, 180);
}

module.exports = {
  handler: exports.handler
};
