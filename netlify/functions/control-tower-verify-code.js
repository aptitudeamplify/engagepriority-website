const {
  DEFAULT_SESSION_MAX_AGE_SECONDS,
  getCentralRegistrySpreadsheetId,
  getSheetsClient,
  readCentralRegistryTab,
  normalizeHeaderName,
  rowsToObjectsByHeader,
  requireFields,
  nowIso,
  addMinutesIso,
  parseDateMs,
  normalizeEmail,
  normalizePhone,
  normalizeIdentifier,
  hashValue,
  timingSafeEqualStrings,
  generateRandomToken,
  buildSessionCookie,
  jsonResponse,
  safeErrorResponse,
  methodNotAllowedResponse,
  invalidRequestResponse
} = require("./control-tower-utils");

const OTP_MAX_ATTEMPTS = 5;
const SESSION_EXPIRES_IN_MINUTES = DEFAULT_SESSION_MAX_AGE_SECONDS / 60;

const TAB_APPROVED_ADMIN_CONTACTS = "ApprovedAdminContacts";
const TAB_CLIENTS = "Clients";
const TAB_OTP_REQUESTS = "ControlTowerOtpRequests";
const TAB_SESSIONS = "ControlTowerSessions";

exports.handler = async function handler(event) {
  if (event.httpMethod !== "POST") {
    return methodNotAllowedResponse();
  }

  try {
    const body = parseJsonBody(event.body);
    const identifier = normalizeIdentifier(body.identifier);
    const code = normalizeCode(body.code);

    console.log("control_tower_verify_code_received", {
      identifier_type: identifier.type || "UNKNOWN",
      identifier_display_masked: identifier.masked || "",
      event_ts_utc: nowIso()
    });

    if (!identifier.type || !identifier.normalized || !code) {
      return invalidRequestResponse();
    }

    const identifierHash = hashValue(
      identifier.normalized,
      `control_tower_identifier_${identifier.type.toLowerCase()}`
    );

    const requestIp = getRequestIp(event);
    const userAgent = getHeader(event, "user-agent");
    const requestIpHash = hashValue(requestIp || "unknown", "control_tower_request_ip");
    const userAgentHash = hashValue(userAgent || "unknown", "control_tower_user_agent");

    const sheets = await getSheetsClient();
    const registrySpreadsheetId = getCentralRegistrySpreadsheetId();

    const otpTable = await readTableFromCentralRegistry(sheets, TAB_OTP_REQUESTS, [
      "otp_request_id",
      "requested_ts_utc",
      "expires_ts_utc",
      "used_ts_utc",
      "identifier_type",
      "identifier_hash",
      "identifier_display_masked",
      "approved_contact_key",
      "client_id",
      "delivery_channel",
      "otp_code_hash",
      "otp_code_hash_version",
      "attempt_count",
      "status",
      "request_ip_hash",
      "user_agent_hash",
      "last_attempt_ts_utc",
      "notes"
    ]);

    const otpRow = findLatestPendingOtp({
      rows: otpTable.rows,
      identifierHash,
      identifierType: identifier.type
    });

    if (!otpRow) {
      console.log("control_tower_verify_code_no_pending_otp", {
        identifier_type: identifier.type,
        identifier_display_masked: identifier.masked,
        event_ts_utc: nowIso()
      });

      return invalidOrExpiredCodeResponse();
    }

    const nowMs = Date.now();
    const expiresMs = parseDateMs(otpRow.expires_ts_utc);

    if (!expiresMs || expiresMs <= nowMs) {
      await updateOtpFields({
        sheets,
        registrySpreadsheetId,
        otpTable,
        otpRow,
        values: {
          status: "EXPIRED",
          notes: "OTP expired before verification."
        }
      });

      console.log("control_tower_verify_code_expired", {
        otp_request_id: otpRow.otp_request_id,
        identifier_type: identifier.type,
        identifier_display_masked: identifier.masked,
        event_ts_utc: nowIso()
      });

      return invalidOrExpiredCodeResponse();
    }

    const currentAttempts = parseInteger(otpRow.attempt_count);

    if (currentAttempts >= OTP_MAX_ATTEMPTS) {
      await updateOtpFields({
        sheets,
        registrySpreadsheetId,
        otpTable,
        otpRow,
        values: {
          status: "INVALIDATED",
          notes: "Too many failed verification attempts."
        }
      });

      return tooManyAttemptsResponse();
    }

    const expectedCodeHash = String(otpRow.otp_code_hash || "").trim();
    const submittedCodeHash = hashValue(code, "control_tower_otp_code");
    const codeMatches = timingSafeEqualStrings(submittedCodeHash, expectedCodeHash);

    if (!codeMatches) {
      const nextAttempts = currentAttempts + 1;
      const nextStatus = nextAttempts >= OTP_MAX_ATTEMPTS ? "INVALIDATED" : "PENDING";
      const nextNotes = nextAttempts >= OTP_MAX_ATTEMPTS
        ? "Too many failed verification attempts."
        : "Failed verification attempt.";

      await updateOtpFields({
        sheets,
        registrySpreadsheetId,
        otpTable,
        otpRow,
        values: {
          attempt_count: String(nextAttempts),
          last_attempt_ts_utc: nowIso(),
          status: nextStatus,
          notes: nextNotes
        }
      });

      console.log("control_tower_verify_code_failed_attempt", {
        otp_request_id: otpRow.otp_request_id,
        identifier_type: identifier.type,
        identifier_display_masked: identifier.masked,
        attempt_count: nextAttempts,
        status: nextStatus,
        event_ts_utc: nowIso()
      });

      if (nextAttempts >= OTP_MAX_ATTEMPTS) {
        return tooManyAttemptsResponse();
      }

      return invalidOrExpiredCodeResponse();
    }

    const approvedContext = await findActiveApprovedContactContext({
      sheets,
      approvedContactKey: otpRow.approved_contact_key,
      clientId: otpRow.client_id,
      identifier
    });

    if (!approvedContext.ok) {
      await updateOtpFields({
        sheets,
        registrySpreadsheetId,
        otpTable,
        otpRow,
        values: {
          status: "INVALIDATED",
          notes: "Approved contact or client became invalid before verification."
        }
      });

      console.log("control_tower_verify_code_contact_invalid", {
        otp_request_id: otpRow.otp_request_id,
        identifier_type: identifier.type,
        identifier_display_masked: identifier.masked,
        event_ts_utc: nowIso()
      });

      return invalidOrExpiredCodeResponse();
    }

    const { approvedContact, clientsTable, contactsTable } = approvedContext;
    const sessionToken = generateRandomToken(32);
    const sessionIdHash = hashValue(sessionToken, "control_tower_session");
    const createdTsUtc = nowIso();
    const expiresTsUtc = addMinutesIso(createdTsUtc, SESSION_EXPIRES_IN_MINUTES);
    const loginChannel = String(otpRow.delivery_channel || identifier.type).trim().toUpperCase();

    const sessionsTable = await readTableFromCentralRegistry(sheets, TAB_SESSIONS, [
      "session_id_hash",
      "created_ts_utc",
      "expires_ts_utc",
      "revoked_ts_utc",
      "approved_contact_key",
      "client_id",
      "role",
      "login_channel",
      "last_seen_ts_utc",
      "request_ip_hash",
      "user_agent_hash",
      "status",
      "notes"
    ]);

    await appendObjectRow({
      sheets,
      spreadsheetId: registrySpreadsheetId,
      tabName: TAB_SESSIONS,
      headers: sessionsTable.headers,
      object: {
        session_id_hash: sessionIdHash,
        created_ts_utc: createdTsUtc,
        expires_ts_utc: expiresTsUtc,
        revoked_ts_utc: "",
        approved_contact_key: approvedContact.approved_contact_key,
        client_id: approvedContact.client_id,
        role: "ADMIN",
        login_channel: loginChannel,
        last_seen_ts_utc: createdTsUtc,
        request_ip_hash: requestIpHash,
        user_agent_hash: userAgentHash,
        status: "ACTIVE",
        notes: ""
      }
    });

    await updateOtpFields({
      sheets,
      registrySpreadsheetId,
      otpTable,
      otpRow,
      values: {
        used_ts_utc: createdTsUtc,
        status: "USED",
        last_attempt_ts_utc: createdTsUtc,
        notes: "OTP verified and session created."
      }
    });

    await updateApprovedContactLoginFields({
      sheets,
      registrySpreadsheetId,
      contactsTable,
      approvedContact,
      lastLoginTsUtc: createdTsUtc,
      lastLoginChannel: loginChannel
    });

    console.log("control_tower_verify_code_success", {
      otp_request_id: otpRow.otp_request_id,
      client_id: approvedContact.client_id,
      login_channel: loginChannel,
      event_ts_utc: nowIso()
    });

    return jsonResponse(200, {
      ok: true,
      message: "Verification successful.",
      redirect_to: "/control-tower"
    }, {
      "Set-Cookie": buildSessionCookie(sessionToken)
    });
  } catch (error) {
    console.error("control_tower_verify_code_error", {
      safe_error: safeLogMessage(error),
      event_ts_utc: nowIso()
    });

    return safeErrorResponse();
  }
};

function parseJsonBody(rawBody) {
  if (!rawBody) {
    return {};
  }

  return JSON.parse(rawBody);
}

function normalizeCode(value) {
  const digits = String(value || "").replace(/\D/g, "");

  if (digits.length !== 6) {
    return "";
  }

  return digits;
}

function invalidOrExpiredCodeResponse() {
  return jsonResponse(400, {
    ok: false,
    error: {
      code: "INVALID_OR_EXPIRED_CODE",
      message: "The code is invalid or expired. Please request a new code."
    }
  });
}

function tooManyAttemptsResponse() {
  return jsonResponse(429, {
    ok: false,
    error: {
      code: "TOO_MANY_ATTEMPTS",
      message: "Too many incorrect attempts. Please request a new code."
    }
  });
}

async function readTableFromCentralRegistry(sheets, tabName, requiredFields) {
  const values = await readCentralRegistryTab(sheets, tabName);
  const table = rowsToObjectsByHeader(values);

  requireFields(table.headerIndex, requiredFields, tabName);

  return table;
}

function findLatestPendingOtp({ rows, identifierHash, identifierType }) {
  return rows
    .filter(row => {
      return (
        String(row.identifier_hash || "") === identifierHash &&
        String(row.identifier_type || "").trim().toUpperCase() === identifierType &&
        String(row.status || "").trim().toUpperCase() === "PENDING" &&
        !String(row.used_ts_utc || "").trim()
      );
    })
    .sort((left, right) => {
      return (parseDateMs(right.requested_ts_utc) || 0) - (parseDateMs(left.requested_ts_utc) || 0);
    })[0] || null;
}

async function findActiveApprovedContactContext({ sheets, approvedContactKey, clientId, identifier }) {
  const contactsTable = await readTableFromCentralRegistry(sheets, TAB_APPROVED_ADMIN_CONTACTS, [
    "approved_contact_key",
    "client_id",
    "email",
    "phone",
    "role",
    "status",
    "last_login_ts_utc",
    "last_login_channel"
  ]);

  const clientsTable = await readTableFromCentralRegistry(sheets, TAB_CLIENTS, [
    "client_id",
    "client_status",
    "lead_data_spreadsheet_id"
  ]);

  const matchingContact = contactsTable.rows.find(contact => {
    const email = normalizeEmail(contact.email);
    const phone = normalizePhone(contact.phone);
    const status = String(contact.status || "").trim().toUpperCase();
    const role = String(contact.role || "").trim().toUpperCase();

    if (String(contact.approved_contact_key || "") !== String(approvedContactKey || "")) {
      return false;
    }

    if (String(contact.client_id || "") !== String(clientId || "")) {
      return false;
    }

    if (status !== "ACTIVE" || role !== "ADMIN") {
      return false;
    }

    if (!email || !phone) {
      return false;
    }

    if (identifier.type === "EMAIL") {
      return email === identifier.normalized;
    }

    if (identifier.type === "PHONE") {
      return phone === identifier.normalized;
    }

    return false;
  });

  if (!matchingContact) {
    return { ok: false };
  }

  const matchingClient = clientsTable.rows.find(client => {
    return (
      String(client.client_id || "").trim() === String(clientId || "").trim() &&
      String(client.client_status || "").trim().toUpperCase() === "ACTIVE" &&
      String(client.lead_data_spreadsheet_id || "").trim()
    );
  });

  if (!matchingClient) {
    return { ok: false };
  }

  return {
    ok: true,
    approvedContact: matchingContact,
    clientsTable,
    contactsTable,
    client: matchingClient
  };
}

async function updateOtpFields({ sheets, registrySpreadsheetId, otpTable, otpRow, values }) {
  await updateObjectFields({
    sheets,
    spreadsheetId: registrySpreadsheetId,
    tabName: TAB_OTP_REQUESTS,
    table: otpTable,
    rowNumber: otpRow._sheet_row_number,
    values
  });
}

async function updateApprovedContactLoginFields({
  sheets,
  registrySpreadsheetId,
  contactsTable,
  approvedContact,
  lastLoginTsUtc,
  lastLoginChannel
}) {
  await updateObjectFields({
    sheets,
    spreadsheetId: registrySpreadsheetId,
    tabName: TAB_APPROVED_ADMIN_CONTACTS,
    table: contactsTable,
    rowNumber: approvedContact._sheet_row_number,
    values: {
      last_login_ts_utc: lastLoginTsUtc,
      last_login_channel: lastLoginChannel
    }
  });
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

    const columnLetter = columnIndexToLetter(columnIndex + 1);

    data.push({
      range: `${tabName}!${columnLetter}${rowNumber}`,
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

function columnIndexToLetter(columnNumber) {
  let number = columnNumber;
  let letters = "";

  while (number > 0) {
    const remainder = (number - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    number = Math.floor((number - 1) / 26);
  }

  return letters;
}

function getHeader(event, headerName) {
  const headers = event?.headers || {};
  const lowerName = String(headerName || "").toLowerCase();

  return (
    headers[headerName] ||
    headers[lowerName] ||
    Object.keys(headers).find(key => key.toLowerCase() === lowerName && headers[key]) &&
      headers[Object.keys(headers).find(key => key.toLowerCase() === lowerName)] ||
    ""
  );
}

function getRequestIp(event) {
  const forwardedFor = getHeader(event, "x-forwarded-for");

  if (forwardedFor) {
    return String(forwardedFor).split(",")[0].trim();
  }

  return (
    getHeader(event, "x-nf-client-connection-ip") ||
    getHeader(event, "client-ip") ||
    "unknown"
  );
}

function parseInteger(value) {
  const parsed = Number.parseInt(String(value || "0"), 10);

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return parsed;
}

function safeLogMessage(error) {
  const message = String(error?.message || "");

  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]")
    .slice(0, 180);
}
