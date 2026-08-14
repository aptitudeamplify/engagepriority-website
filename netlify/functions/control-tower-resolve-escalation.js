const {
  getCentralRegistrySpreadsheetId,
  getCookieValue,
  getSheetsClient,
  hashValue,
  jsonResponse,
  methodNotAllowedResponse,
  normalizeHeaderName,
  parseDateMs,
  readCentralRegistryTab,
  readSheetValues,
  requireFields,
  rowsToObjectsByHeader,
  safeErrorResponse,
  unauthorizedResponse,
  nowIso
} = require("./control-tower-utils");
const { instrumentAnalyticsBoundary } = require("./analytics-client");

const TAB_SESSIONS = "ControlTowerSessions";
const TAB_APPROVED_ADMIN_CONTACTS = "ApprovedAdminContacts";
const TAB_CLIENTS = "Clients";
const TAB_ACTION_LINK_MAP = "ActionLinkMap";
const TAB_LEAD_LOG_ACTIVE = "LeadLog_Active";
const TAB_LEAD_LIFECYCLE_LOG = "LeadLifecycleLog";

const DEFAULT_ACTION_LINK_MAP_SPREADSHEET_ID =
  "1xNhypMirxoz9IjMWxO0H8gxNSqqavs2W17pzx8HiZfw";

const SESSION_STATUS_ACTIVE = "ACTIVE";
const CONTACT_STATUS_ACTIVE = "ACTIVE";
const CONTACT_ROLE_ADMIN = "ADMIN";
const CLIENT_STATUS_ACTIVE = "ACTIVE";

const ADMIN_ESCALATION_GATEWAY = "ADMIN_ESCALATION_GATEWAY";
const ADMIN_ESCALATION_DEACTIVATION_REASON = "ADMIN_ESCALATION_RESOLVED_CONTROL_TOWER";

const VALID_ADMIN_RESOLUTION_STATUSES = new Set([
  "ADMIN_CONTACTED_APPOINTMENT_SET",
  "ADMIN_CONTACTED_NOT_INTERESTED",
  "ADMIN_NO_ANSWER",
  "ADMIN_NO_ACTION"
]);

const CONTACTED_ADMIN_STATUSES = new Set([
  "ADMIN_CONTACTED_APPOINTMENT_SET",
  "ADMIN_CONTACTED_NOT_INTERESTED"
]);

exports.handler = async function handler(event, context) {
  const method = String(event.httpMethod || "").toUpperCase();

  if (method !== "POST") {
    return methodNotAllowedResponse();
  }

  let body;

  try {
    body = parseJsonBody(event.body);
  } catch (error) {
    return safeErrorResponse(400, "INVALID_REQUEST", "Invalid request.");
  }

  const leadId = trimmed(body.lead_id);
  const adminResolutionStatus = upper(body.admin_resolution_status);

  console.log("control_tower_resolve_escalation_received", {
    has_lead_id: Boolean(leadId),
    has_resolution_status: Boolean(adminResolutionStatus),
    event_ts_utc: nowIso()
  });

  if (!leadId || !VALID_ADMIN_RESOLUTION_STATUSES.has(adminResolutionStatus)) {
    return safeErrorResponse(400, "INVALID_REQUEST", "Invalid escalation resolution request.");
  }

  try {
    const authContext = await validateSession(event);
    const { sheets, clientId, clientRow, contactRow } = authContext;
    const clientSpreadsheetId = trimmed(clientRow.lead_data_spreadsheet_id);
    const actionLinkMapSpreadsheetId = getActionLinkMapSpreadsheetId();
    const resolvedTsUtc = nowIso();

    const leadTable = await readClientTable(sheets, clientSpreadsheetId, TAB_LEAD_LOG_ACTIVE, [
      "lead_id",
      "client_id",
      "assigned_agent_id",
      "contacted_flag",
      "contact_timestamp",
      "lead_status",
      "last_updated_timestamp",
      "trace_id",
      "admin_escalation_required",
      "admin_resolution_status",
      "admin_resolution_ts_utc",
      "admin_resolution_by_contact",
      "admin_resolution_source"
    ]);

    const leadRow = leadTable.rows.find(row => trimmed(row.lead_id) === leadId);

    if (!isEligibleEscalatedLead(leadRow, clientId)) {
      console.log("control_tower_resolve_escalation_denied", {
        client_id: clientId,
        reason: "LEAD_NOT_ELIGIBLE",
        event_ts_utc: nowIso()
      });

      return safeErrorResponse(409, "LEAD_NOT_ELIGIBLE", "This lead is no longer eligible for admin resolution.");
    }

    const leadUpdates = {
      admin_resolution_status: adminResolutionStatus,
      admin_resolution_ts_utc: resolvedTsUtc,
      admin_resolution_by_contact: trimmed(contactRow.approved_contact_key),
      admin_resolution_source: "CONTROL_TOWER",
      lead_status: "CLOSED",
      admin_escalation_required: "FALSE",
      last_updated_timestamp: resolvedTsUtc
    };

    if (CONTACTED_ADMIN_STATUSES.has(adminResolutionStatus)) {
      leadUpdates.contacted_flag = "TRUE";
      leadUpdates.contact_timestamp = resolvedTsUtc;
    }

    await updateObjectFields({
      sheets,
      spreadsheetId: clientSpreadsheetId,
      tabName: TAB_LEAD_LOG_ACTIVE,
      table: leadTable,
      rowNumber: leadRow._sheet_row_number,
      values: leadUpdates
    });

    const lifecycleTable = await readClientTable(sheets, clientSpreadsheetId, TAB_LEAD_LIFECYCLE_LOG, [
      "event_id",
      "event_ts_utc",
      "client_id",
      "lead_id",
      "trace_id",
      "event_type",
      "event_stage",
      "event_source",
      "assigned_agent_id",
      "gateway_context",
      "selected_action",
      "notes"
    ]);

    await appendObjectRow({
      sheets,
      spreadsheetId: clientSpreadsheetId,
      tabName: TAB_LEAD_LIFECYCLE_LOG,
      headers: lifecycleTable.headers,
      object: {
        event_id: cryptoRandomUuid(),
        event_ts_utc: resolvedTsUtc,
        client_id: clientId,
        lead_id: leadId,
        trace_id: trimmed(leadRow.trace_id),
        event_type: "ADMIN_ESCALATION_RESOLVED",
        event_stage: "ADMIN_ESCALATION",
        event_source: "CONTROL_TOWER",
        assigned_agent_id: trimmed(leadRow.assigned_agent_id),
        gateway_context: "",
        selected_action: adminResolutionStatus,
        notes: "Admin escalation resolved from Control Tower"
      }
    });

    const deactivatedAdminLinks = await deactivateAdminEscalationLinks({
      sheets,
      spreadsheetId: actionLinkMapSpreadsheetId,
      leadId,
      clientId,
      deactivatedTsUtc: resolvedTsUtc
    });

    console.log("control_tower_resolve_escalation_success", {
      client_id: clientId,
      admin_resolution_status: adminResolutionStatus,
      deactivated_admin_link_count: deactivatedAdminLinks,
      event_ts_utc: nowIso()
    });

    instrumentAnalyticsBoundary(context, {
      boundary: "ADMIN_RESOLUTION_OPERATIONALLY_COMMITTED",
      candidate_record_types: ["ADMIN_RESOLUTION_ACCEPTED", "DISPOSITION_RECORDED", "LIFECYCLE_CLOSED"],
      source_correlation_id: trimmed(leadRow.trace_id),
      client_id: clientId,
      lead_id: leadId,
      administrator_snapshot_ref_hash: hashValue(trimmed(contactRow.approved_contact_key), "analytics_admin_actor"),
      admin_resolution_status: adminResolutionStatus,
      operational_committed_ts_utc: resolvedTsUtc,
      provider_binding_status: "PENDING_LIFECYCLE_ADMIN_RESOLUTION_SEQUENCE_BINDING"
    });

    return jsonResponse(200, {
      ok: true,
      resolved: true,
      lead_id: leadId,
      admin_resolution_status: adminResolutionStatus,
      admin_resolution_ts_utc: resolvedTsUtc,
      deactivated_admin_link_count: deactivatedAdminLinks
    });
  } catch (error) {
    if (error && error.code === "SESSION_REQUIRED") {
      console.log("control_tower_resolve_escalation_session_denied", {
        reason: error.reason || "SESSION_REQUIRED",
        event_ts_utc: nowIso()
      });

      return unauthorizedResponse();
    }

    console.error("control_tower_resolve_escalation_error", {
      safe_error: "CONTROL_TOWER_RESOLVE_ESCALATION_FAILED",
      message: safeLogMessage(error),
      event_ts_utc: nowIso()
    });

    return safeErrorResponse();
  }
};

function parseJsonBody(body) {
  if (!body) {
    return {};
  }

  const parsed = JSON.parse(body);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid JSON body");
  }

  return parsed;
}

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

function getActionLinkMapSpreadsheetId() {
  return (
    process.env.CONTROL_TOWER_ACTION_LINK_MAP_SPREADSHEET_ID ||
    process.env.EP_ACTION_LINKS_SPREADSHEET_ID ||
    process.env.ACTION_LINK_MAP_SPREADSHEET_ID ||
    DEFAULT_ACTION_LINK_MAP_SPREADSHEET_ID
  );
}

async function readClientTable(sheets, spreadsheetId, tabName, requiredFields) {
  const table = rowsToObjectsByHeader(
    await readSheetValues(sheets, spreadsheetId, `${tabName}!A1:ZZ10000`)
  );

  requireFields(table.headerIndex, requiredFields, tabName);
  return table;
}

async function readActionLinkMapTable(sheets, spreadsheetId) {
  const table = rowsToObjectsByHeader(
    await readSheetValues(sheets, spreadsheetId, `${TAB_ACTION_LINK_MAP}!A1:ZZ10000`)
  );

  requireFields(table.headerIndex, [
    "gateway_context",
    "lead_id",
    "client_id",
    "is_active",
    "deactivated_ts_utc",
    "deactivation_reason"
  ], TAB_ACTION_LINK_MAP);

  return table;
}

async function deactivateAdminEscalationLinks({ sheets, spreadsheetId, leadId, clientId, deactivatedTsUtc }) {
  const actionLinkTable = await readActionLinkMapTable(sheets, spreadsheetId);

  const matchingRows = actionLinkTable.rows.filter(row => {
    return (
      trimmed(row.lead_id) === leadId &&
      trimmed(row.client_id) === clientId &&
      upper(row.gateway_context) === ADMIN_ESCALATION_GATEWAY &&
      truthy(row.is_active)
    );
  });

  if (matchingRows.length === 0) {
    return 0;
  }

  const data = [];
  const updateFields = {
    is_active: "FALSE",
    deactivated_ts_utc: deactivatedTsUtc,
    deactivation_reason: ADMIN_ESCALATION_DEACTIVATION_REASON
  };

  matchingRows.forEach(row => {
    Object.keys(updateFields).forEach(fieldName => {
      const columnIndex = actionLinkTable.headerIndex[normalizeHeaderName(fieldName)];

      if (!Number.isInteger(columnIndex)) {
        throw new Error(`Missing ${TAB_ACTION_LINK_MAP} field for update: ${fieldName}`);
      }

      data.push({
        range: `${TAB_ACTION_LINK_MAP}!${columnIndexToLetter(columnIndex + 1)}${row._sheet_row_number}`,
        values: [[updateFields[fieldName]]]
      });
    });
  });

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data
    }
  });

  return matchingRows.length;
}

async function appendObjectRow({ sheets, spreadsheetId, tabName, headers, object }) {
  const values = headers.map(header => {
    const key = normalizeHeaderName(header);
    return Object.prototype.hasOwnProperty.call(object, key) ? object[key] : "";
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tabName}!A:ZZ`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [values]
    }
  });
}

async function updateObjectFields({ sheets, spreadsheetId, tabName, table, rowNumber, values }) {
  const data = [];

  Object.keys(values).forEach(fieldName => {
    const normalized = normalizeHeaderName(fieldName);
    const columnIndex = table.headerIndex[normalized];

    if (!Number.isInteger(columnIndex)) {
      throw new Error(`Missing ${tabName} field for update: ${fieldName}`);
    }

    data.push({
      range: `${tabName}!${columnIndexToLetter(columnIndex + 1)}${rowNumber}`,
      values: [[values[fieldName]]]
    });
  });

  if (data.length === 0) {
    return;
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data
    }
  });
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

function columnIndexToLetter(columnNumber) {
  let number = Number(columnNumber);
  let result = "";

  while (number > 0) {
    const remainder = (number - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    number = Math.floor((number - 1) / 26);
  }

  return result;
}

function cryptoRandomUuid() {
  const crypto = require("crypto");

  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return [
    crypto.randomBytes(4).toString("hex"),
    crypto.randomBytes(2).toString("hex"),
    crypto.randomBytes(2).toString("hex"),
    crypto.randomBytes(2).toString("hex"),
    crypto.randomBytes(6).toString("hex")
  ].join("-");
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
