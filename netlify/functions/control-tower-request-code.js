const twilio = require("twilio");
const {
  getCentralRegistrySpreadsheetId,
  requireEnv,
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
  generateOtpCode,
  jsonResponse,
  safeErrorResponse,
  methodNotAllowedResponse,
  invalidRequestResponse
} = require("./control-tower-utils");

const NEUTRAL_MESSAGE = "If this contact is approved, we will send a verification code.";

const OTP_EXPIRES_IN_MINUTES = 5;
const OTP_CODE_HASH_VERSION = "v1";

const RATE_LIMIT_IDENTIFIER_MAX = 3;
const RATE_LIMIT_IDENTIFIER_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_IP_MAX = 10;
const RATE_LIMIT_IP_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_CONTACT_MAX = 6;
const RATE_LIMIT_CONTACT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_IDENTIFIER_MIN_INTERVAL_MS = 60 * 1000;

const TAB_APPROVED_ADMIN_CONTACTS = "ApprovedAdminContacts";
const TAB_CLIENTS = "Clients";
const TAB_OTP_REQUESTS = "ControlTowerOtpRequests";

exports.handler = async function handler(event) {
  if (event.httpMethod !== "POST") {
    return methodNotAllowedResponse();
  }

  const eventTsUtc = nowIso();
  const requestIp = getRequestIp(event);
  const userAgent = getHeader(event, "user-agent");
  const requestIpHash = hashValue(requestIp || "unknown", "control_tower_request_ip");
  const userAgentHash = hashValue(userAgent || "unknown", "control_tower_user_agent");

  let body;

  try {
    body = parseJsonBody(event.body);
  } catch (error) {
    return invalidRequestResponse();
  }

  const identifier = normalizeIdentifier(body.identifier);

  console.log("control_tower_request_code_received", {
    identifier_type: identifier.type || "UNKNOWN",
    identifier_display_masked: identifier.masked || "",
    event_ts_utc: eventTsUtc
  });

  try {
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

    const nowMs = Date.now();

    const ipLimit = evaluateRecentCountLimit({
      rows: otpTable.rows,
      timestampField: "requested_ts_utc",
      filter: row => String(row.request_ip_hash || "") === requestIpHash,
      nowMs,
      windowMs: RATE_LIMIT_IP_WINDOW_MS,
      maxCount: RATE_LIMIT_IP_MAX
    });

    if (ipLimit.limited) {
      console.log("control_tower_request_code_rate_limited", {
        reason: "IP_RATE_LIMIT",
        identifier_type: identifier.type || "UNKNOWN",
        identifier_display_masked: identifier.masked || "",
        event_ts_utc: nowIso()
      });

      return rateLimitedResponse();
    }

    if (!identifier.type || !identifier.normalized) {
      return neutralResponse();
    }

    const identifierHash = hashValue(
      identifier.normalized,
      `control_tower_identifier_${identifier.type.toLowerCase()}`
    );

    const identifierLimit = evaluateRecentCountLimit({
      rows: otpTable.rows,
      timestampField: "requested_ts_utc",
      filter: row => String(row.identifier_hash || "") === identifierHash,
      nowMs,
      windowMs: RATE_LIMIT_IDENTIFIER_WINDOW_MS,
      maxCount: RATE_LIMIT_IDENTIFIER_MAX
    });

    if (identifierLimit.limited) {
      console.log("control_tower_request_code_rate_limited", {
        reason: "IDENTIFIER_RATE_LIMIT",
        identifier_type: identifier.type,
        identifier_display_masked: identifier.masked,
        event_ts_utc: nowIso()
      });

      return rateLimitedResponse();
    }

    const resendLimit = evaluateMinimumIntervalLimit({
      rows: otpTable.rows,
      timestampField: "requested_ts_utc",
      filter: row => String(row.identifier_hash || "") === identifierHash,
      nowMs,
      minimumIntervalMs: RATE_LIMIT_IDENTIFIER_MIN_INTERVAL_MS
    });

    if (resendLimit.limited) {
      console.log("control_tower_request_code_rate_limited", {
        reason: "IDENTIFIER_MIN_INTERVAL",
        identifier_type: identifier.type,
        identifier_display_masked: identifier.masked,
        event_ts_utc: nowIso()
      });

      return rateLimitedResponse();
    }

    const approvedContactMatch = await findApprovedAdminContact({
      sheets,
      identifier,
      identifierHash
    });

    if (!approvedContactMatch.ok) {
      console.log("control_tower_request_code_neutral_not_approved", {
        identifier_type: identifier.type,
        identifier_display_masked: identifier.masked,
        event_ts_utc: nowIso()
      });

      return neutralResponse();
    }

    const { approvedContact, client } = approvedContactMatch;

    const contactLimit = evaluateRecentCountLimit({
      rows: otpTable.rows,
      timestampField: "requested_ts_utc",
      filter: row => String(row.approved_contact_key || "") === String(approvedContact.approved_contact_key || ""),
      nowMs,
      windowMs: RATE_LIMIT_CONTACT_WINDOW_MS,
      maxCount: RATE_LIMIT_CONTACT_MAX
    });

    if (contactLimit.limited) {
      console.log("control_tower_request_code_rate_limited", {
        reason: "APPROVED_CONTACT_RATE_LIMIT",
        identifier_type: identifier.type,
        identifier_display_masked: identifier.masked,
        client_id: client.client_id,
        event_ts_utc: nowIso()
      });

      return rateLimitedResponse();
    }

    await invalidatePendingOtpsForIdentifier({
      sheets,
      registrySpreadsheetId,
      otpTable,
      identifierHash
    });

    const otpRequestId = cryptoRandomUuid();
    const code = generateOtpCode(6);
    const codeHash = hashValue(code, "control_tower_otp_code");
    const requestedTsUtc = nowIso();
    const expiresTsUtc = addMinutesIso(requestedTsUtc, OTP_EXPIRES_IN_MINUTES);
    const deliveryChannel = identifier.type === "EMAIL" ? "EMAIL" : "SMS";

    const otpRow = {
      otp_request_id: otpRequestId,
      requested_ts_utc: requestedTsUtc,
      expires_ts_utc: expiresTsUtc,
      used_ts_utc: "",
      identifier_type: identifier.type,
      identifier_hash: identifierHash,
      identifier_display_masked: identifier.masked,
      approved_contact_key: approvedContact.approved_contact_key,
      client_id: client.client_id,
      delivery_channel: deliveryChannel,
      otp_code_hash: codeHash,
      otp_code_hash_version: OTP_CODE_HASH_VERSION,
      attempt_count: "0",
      status: "PENDING",
      request_ip_hash: requestIpHash,
      user_agent_hash: userAgentHash,
      last_attempt_ts_utc: "",
      notes: ""
    };

    await appendObjectRow({
      sheets,
      spreadsheetId: registrySpreadsheetId,
      tabName: TAB_OTP_REQUESTS,
      headers: otpTable.headers,
      object: otpRow
    });

    const sendResult =
      deliveryChannel === "EMAIL"
        ? await sendEmailOtp({
            toEmail: approvedContact.email,
            code,
            requestId: otpRequestId
          })
        : await sendSmsOtp({
            toPhone: approvedContact.phone,
            code
          });

    if (!sendResult.ok) {
      await updateLatestOtpStatus({
        sheets,
        registrySpreadsheetId,
        otpTable,
        otpRequestId,
        status: "DELIVERY_FAILED",
        notes: sendResult.safe_error || "DELIVERY_FAILED"
      });

      console.error("control_tower_request_code_delivery_failed", {
        otp_request_id: otpRequestId,
        identifier_type: identifier.type,
        identifier_display_masked: identifier.masked,
        delivery_channel: deliveryChannel,
        safe_error: sendResult.safe_error || "DELIVERY_FAILED",
        event_ts_utc: nowIso()
      });

      return neutralResponse();
    }

    console.log("control_tower_request_code_delivery_accepted", {
      otp_request_id: otpRequestId,
      identifier_type: identifier.type,
      identifier_display_masked: identifier.masked,
      delivery_channel: deliveryChannel,
      client_id: client.client_id,
      event_ts_utc: nowIso()
    });

    return neutralResponse();
  } catch (error) {
    console.error("control_tower_request_code_error", {
      safe_error: "CONTROL_TOWER_REQUEST_CODE_FAILED",
      identifier_type: identifier.type || "UNKNOWN",
      identifier_display_masked: identifier.masked || "",
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

function neutralResponse() {
  return jsonResponse(200, {
    ok: true,
    message: NEUTRAL_MESSAGE
  });
}

function rateLimitedResponse() {
  return jsonResponse(429, {
    ok: false,
    error: {
      code: "RATE_LIMITED",
      message: "Too many code requests. Please try again later."
    }
  });
}

async function readTableFromCentralRegistry(sheets, tabName, requiredFields) {
  const values = await readCentralRegistryTab(sheets, tabName);
  const table = rowsToObjectsByHeader(values);

  requireFields(table.headerIndex, requiredFields, tabName);

  return table;
}

async function findApprovedAdminContact({ sheets, identifier }) {
  const contactsTable = await readTableFromCentralRegistry(sheets, TAB_APPROVED_ADMIN_CONTACTS, [
    "approved_contact_key",
    "client_id",
    "contact_name",
    "email",
    "phone",
    "role",
    "status"
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
      String(client.client_id || "").trim() === String(matchingContact.client_id || "").trim() &&
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
    client: matchingClient
  };
}

function evaluateRecentCountLimit({ rows, timestampField, filter, nowMs, windowMs, maxCount }) {
  const count = rows.filter(row => {
    if (!filter(row)) {
      return false;
    }

    const timestampMs = parseDateMs(row[timestampField]);

    if (timestampMs === null) {
      return false;
    }

    return nowMs - timestampMs <= windowMs;
  }).length;

  return {
    limited: count >= maxCount,
    count
  };
}

function evaluateMinimumIntervalLimit({ rows, timestampField, filter, nowMs, minimumIntervalMs }) {
  const latestTimestampMs = rows.reduce((latest, row) => {
    if (!filter(row)) {
      return latest;
    }

    const timestampMs = parseDateMs(row[timestampField]);

    if (timestampMs === null) {
      return latest;
    }

    return Math.max(latest, timestampMs);
  }, 0);

  if (!latestTimestampMs) {
    return {
      limited: false
    };
  }

  return {
    limited: nowMs - latestTimestampMs < minimumIntervalMs,
    latestTimestampMs
  };
}

async function invalidatePendingOtpsForIdentifier({ sheets, registrySpreadsheetId, otpTable, identifierHash }) {
  const statusColumnIndex = otpTable.headerIndex.status;
  const notesColumnIndex = otpTable.headerIndex.notes;

  const pendingRows = otpTable.rows.filter(row => {
    return (
      String(row.identifier_hash || "") === identifierHash &&
      String(row.status || "").trim().toUpperCase() === "PENDING" &&
      !String(row.used_ts_utc || "").trim()
    );
  });

  for (const row of pendingRows) {
    await updateSheetCell({
      sheets,
      spreadsheetId: registrySpreadsheetId,
      tabName: TAB_OTP_REQUESTS,
      rowNumber: row._sheet_row_number,
      columnIndex: statusColumnIndex,
      value: "INVALIDATED"
    });

    if (Number.isInteger(notesColumnIndex)) {
      await updateSheetCell({
        sheets,
        spreadsheetId: registrySpreadsheetId,
        tabName: TAB_OTP_REQUESTS,
        rowNumber: row._sheet_row_number,
        columnIndex: notesColumnIndex,
        value: "Superseded by a newer OTP request."
      });
    }
  }
}

async function updateLatestOtpStatus({ sheets, registrySpreadsheetId, otpTable, otpRequestId, status, notes }) {
  const statusColumnIndex = otpTable.headerIndex.status;
  const notesColumnIndex = otpTable.headerIndex.notes;

  const rows = await readCentralRegistryTab(sheets, TAB_OTP_REQUESTS);
  const refreshedTable = rowsToObjectsByHeader(rows);
  const matchingRow = refreshedTable.rows.find(row => String(row.otp_request_id || "") === otpRequestId);

  if (!matchingRow) {
    return;
  }

  await updateSheetCell({
    sheets,
    spreadsheetId: registrySpreadsheetId,
    tabName: TAB_OTP_REQUESTS,
    rowNumber: matchingRow._sheet_row_number,
    columnIndex: statusColumnIndex,
    value: status
  });

  if (Number.isInteger(notesColumnIndex)) {
    await updateSheetCell({
      sheets,
      spreadsheetId: registrySpreadsheetId,
      tabName: TAB_OTP_REQUESTS,
      rowNumber: matchingRow._sheet_row_number,
      columnIndex: notesColumnIndex,
      value: notes || ""
    });
  }
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

async function updateSheetCell({ sheets, spreadsheetId, tabName, rowNumber, columnIndex, value }) {
  const columnLetter = columnIndexToLetter(columnIndex + 1);

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabName}!${columnLetter}${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[value]]
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

async function sendEmailOtp({ toEmail, code, requestId }) {
  const endpoint = requireEnv("CONTROL_TOWER_EMAIL_ENDPOINT");
  const emailSecret = requireEnv("CONTROL_TOWER_EMAIL_SECRET");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      event_type: "CONTROL_TOWER_EMAIL_OTP",
      request_id: requestId,
      to_email: toEmail,
      code,
      expires_in_minutes: OTP_EXPIRES_IN_MINUTES,
      email_secret: emailSecret
    })
  });

  let result = null;

  try {
    result = await response.json();
  } catch (error) {
    result = null;
  }

  if (!response.ok || !result || result.ok !== true || result.status !== "SENT") {
    return {
      ok: false,
      safe_error: result?.safe_error || "EMAIL_SEND_FAILED"
    };
  }

  return {
    ok: true
  };
}

async function sendSmsOtp({ toPhone, code }) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_PHONE;

  if (!accountSid || !authToken || !from) {
    return {
      ok: false,
      safe_error: "SMS_NOT_CONFIGURED"
    };
  }

  const client = twilio(accountSid, authToken);

  await client.messages.create({
    body: `Your EngagePriority verification code is ${code}. This code expires in 5 minutes.`,
    from,
    to: normalizePhone(toPhone)
  });

  return {
    ok: true
  };
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

function safeLogMessage(error) {
  const message = String(error?.message || "");

  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]")
    .slice(0, 180);
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
