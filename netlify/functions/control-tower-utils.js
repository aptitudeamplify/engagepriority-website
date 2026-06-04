const { google } = require("googleapis");
const crypto = require("crypto");

const DEFAULT_CENTRAL_REGISTRY_SPREADSHEET_ID =
  "18x83a1VZIZoXrjASqTNfKdzYi1gDKLQD4fgx5WbyoWQ";

const DEFAULT_COOKIE_NAME = "ep_ct_session";
const DEFAULT_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
  "Pragma": "no-cache",
  "Expires": "0",
  "Surrogate-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow"
};

function getCentralRegistrySpreadsheetId() {
  return (
    process.env.CONTROL_TOWER_CENTRAL_REGISTRY_SPREADSHEET_ID ||
    process.env.CENTRAL_REGISTRY_SPREADSHEET_ID ||
    DEFAULT_CENTRAL_REGISTRY_SPREADSHEET_ID
  );
}

function requireEnv(name) {
  const value = String(process.env[name] || "").trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

async function getSheetsClient() {
  const credentials = JSON.parse(requireEnv("GOOGLE_SERVICE_ACCOUNT"));

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  return google.sheets({ version: "v4", auth });
}

async function readSheetValues(sheets, spreadsheetId, range) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range
  });

  return response.data.values || [];
}

async function readCentralRegistryTab(sheets, tabName, rangeSuffix = "A1:ZZ10000") {
  return readSheetValues(
    sheets,
    getCentralRegistrySpreadsheetId(),
    `${tabName}!${rangeSuffix}`
  );
}

function normalizeHeaderName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "_")
    .toLowerCase();
}

function buildHeaderIndex(headers = []) {
  const index = {};
  const originalByNormalized = {};
  const duplicateHeaders = [];

  headers.forEach((header, columnIndex) => {
    const normalized = normalizeHeaderName(header);

    if (!normalized) {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(index, normalized)) {
      duplicateHeaders.push(normalized);
      return;
    }

    index[normalized] = columnIndex;
    originalByNormalized[normalized] = String(header || "").trim();
  });

  if (duplicateHeaders.length > 0) {
    throw new Error(
      `Duplicate sheet headers found: ${Array.from(new Set(duplicateHeaders)).join(", ")}`
    );
  }

  return {
    index,
    originalByNormalized
  };
}

function rowsToObjectsByHeader(rows = [], options = {}) {
  const includeSheetRowNumber = options.includeSheetRowNumber !== false;

  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      headers: [],
      headerIndex: {},
      rows: []
    };
  }

  const headers = rows[0] || [];
  const { index: headerIndex, originalByNormalized } = buildHeaderIndex(headers);
  const normalizedHeaders = Object.keys(headerIndex);

  const mappedRows = rows.slice(1).map((row, rowIndex) => {
    const object = {};

    normalizedHeaders.forEach(headerName => {
      const columnIndex = headerIndex[headerName];
      object[headerName] = row[columnIndex] || "";
    });

    if (includeSheetRowNumber) {
      object._sheet_row_number = rowIndex + 2;
    }

    return object;
  });

  return {
    headers,
    headerIndex,
    originalByNormalized,
    rows: mappedRows
  };
}

function requireFields(headerIndex, requiredFields = [], context = "sheet") {
  const missing = requiredFields.filter(field => {
    return !Object.prototype.hasOwnProperty.call(
      headerIndex,
      normalizeHeaderName(field)
    );
  });

  if (missing.length > 0) {
    throw new Error(`Missing required ${context} fields: ${missing.join(", ")}`);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function addMinutesIso(baseDate, minutes) {
  const date = baseDate instanceof Date ? baseDate : new Date(baseDate || Date.now());
  return new Date(date.getTime() + Number(minutes || 0) * 60 * 1000).toISOString();
}

function parseDateMs(value) {
  const trimmed = String(value || "").trim();

  if (!trimmed) {
    return null;
  }

  const parsed = new Date(trimmed).getTime();

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

function isPastIso(value, now = Date.now()) {
  const parsed = parseDateMs(value);

  if (parsed === null) {
    return false;
  }

  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  return parsed <= nowMs;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");

  if (!digits) {
    return "";
  }

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  return `+${digits}`;
}

function detectIdentifierType(value) {
  const trimmed = String(value || "").trim();

  if (!trimmed) {
    return null;
  }

  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return "EMAIL";
  }

  const digits = trimmed.replace(/\D/g, "");

  if (digits.length >= 10) {
    return "PHONE";
  }

  return null;
}

function normalizeIdentifier(value) {
  const type = detectIdentifierType(value);

  if (type === "EMAIL") {
    const normalized = normalizeEmail(value);

    return {
      type,
      normalized,
      masked: maskEmail(normalized)
    };
  }

  if (type === "PHONE") {
    const normalized = normalizePhone(value);

    return {
      type,
      normalized,
      masked: maskPhone(normalized)
    };
  }

  return {
    type: null,
    normalized: "",
    masked: ""
  };
}

function maskEmail(value) {
  const email = normalizeEmail(value);
  const atIndex = email.indexOf("@");

  if (atIndex <= 0) {
    return "";
  }

  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  const first = local.charAt(0) || "*";

  return `${first}***@${domain}`;
}

function maskPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");

  if (digits.length < 4) {
    return "";
  }

  return `***-***-${digits.slice(-4)}`;
}

function timingSafeEqualStrings(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function hashValue(value, purpose = "general") {
  const secret = requireEnv("CONTROL_TOWER_AUTH_SECRET");

  return crypto
    .createHmac("sha256", secret)
    .update(`${purpose}:${String(value || "")}`)
    .digest("hex");
}

function generateRandomToken(byteLength = 32) {
  return crypto.randomBytes(byteLength).toString("base64url");
}

function generateOtpCode(length = 6) {
  const digits = "0123456789";
  let code = "";

  for (let index = 0; index < length; index++) {
    code += digits[crypto.randomInt(0, digits.length)];
  }

  return code;
}

function parseCookies(cookieHeader = "") {
  return String(cookieHeader || "")
    .split(";")
    .map(part => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separatorIndex = part.indexOf("=");

      if (separatorIndex === -1) {
        return cookies;
      }

      const name = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();

      if (name) {
        cookies[name] = decodeURIComponent(value || "");
      }

      return cookies;
    }, {});
}

function getCookieValue(event, cookieName = DEFAULT_COOKIE_NAME) {
  const header =
    event?.headers?.cookie ||
    event?.headers?.Cookie ||
    "";

  const cookies = parseCookies(header);
  return cookies[cookieName] || "";
}

function buildCookie(name, value, options = {}) {
  const parts = [
    `${name}=${encodeURIComponent(String(value || ""))}`,
    `Path=${options.path || "/"}`,
    `SameSite=${options.sameSite || "Lax"}`
  ];

  if (options.httpOnly !== false) {
    parts.push("HttpOnly");
  }

  if (options.secure !== false) {
    parts.push("Secure");
  }

  if (Number.isFinite(options.maxAge)) {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  if (options.expires) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }

  return parts.join("; ");
}

function buildSessionCookie(sessionToken, maxAgeSeconds = DEFAULT_SESSION_MAX_AGE_SECONDS) {
  return buildCookie(DEFAULT_COOKIE_NAME, sessionToken, {
    maxAge: maxAgeSeconds,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/"
  });
}

function buildClearSessionCookie() {
  return buildCookie(DEFAULT_COOKIE_NAME, "", {
    maxAge: 0,
    expires: new Date(0),
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/"
  });
}

function jsonResponse(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      ...JSON_HEADERS,
      ...extraHeaders
    },
    body: JSON.stringify(payload)
  };
}

function safeErrorResponse(statusCode = 500, code = "CONTROL_TOWER_UNAVAILABLE", message) {
  const safeMessage = message || "The Control Tower is temporarily unavailable. Please try again later.";

  return jsonResponse(statusCode, {
    ok: false,
    error: {
      code,
      message: safeMessage
    }
  });
}

function methodNotAllowedResponse() {
  return safeErrorResponse(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
}

function invalidRequestResponse() {
  return safeErrorResponse(400, "INVALID_REQUEST", "Invalid request.");
}

function unauthorizedResponse() {
  return safeErrorResponse(401, "SESSION_REQUIRED", "Please sign in to access the Control Tower.");
}

module.exports = {
  DEFAULT_COOKIE_NAME,
  DEFAULT_SESSION_MAX_AGE_SECONDS,
  JSON_HEADERS,
  getCentralRegistrySpreadsheetId,
  requireEnv,
  getSheetsClient,
  readSheetValues,
  readCentralRegistryTab,
  normalizeHeaderName,
  buildHeaderIndex,
  rowsToObjectsByHeader,
  requireFields,
  nowIso,
  addMinutesIso,
  parseDateMs,
  isPastIso,
  normalizeEmail,
  normalizePhone,
  detectIdentifierType,
  normalizeIdentifier,
  maskEmail,
  maskPhone,
  timingSafeEqualStrings,
  hashValue,
  generateRandomToken,
  generateOtpCode,
  parseCookies,
  getCookieValue,
  buildCookie,
  buildSessionCookie,
  buildClearSessionCookie,
  jsonResponse,
  safeErrorResponse,
  methodNotAllowedResponse,
  invalidRequestResponse,
  unauthorizedResponse
};
