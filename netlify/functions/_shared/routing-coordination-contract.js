const { createHash, createHmac, timingSafeEqual } = require("crypto");

const CONTRACTS = Object.freeze({
  action: "COMMIT_ROUTING_STATE_V1",
  stateFingerprint: "EP_ROUTING_STATE_FINGERPRINT_V1",
  commitId: "EP_ROUTING_COMMIT_ID_V1",
  requestFingerprint: "EP_ROUTING_REQUEST_FINGERPRINT_V1",
  requestSigning: "EP_ROUTING_COORDINATION_HMAC_REQUEST_V1",
  responseSigning: "EP_ROUTING_COORDINATION_HMAC_RESPONSE_V1",
  initialIntake: "INITIAL_INTAKE_V1",
  afterHoursRelease: "AFTER_HOURS_RELEASE_V1"
});

const DECISION_TYPES = Object.freeze({
  INITIAL_INTAKE: "INITIAL_INTAKE",
  AFTER_HOURS_RELEASE: "AFTER_HOURS_RELEASE"
});

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object.`);
  }
  return value;
}

function rejectLoneSurrogates(value, label) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(`${label} contains a lone surrogate.`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`${label} contains a lone surrogate.`);
    }
  }
}

function normalizeIdentifier(value, label, { allowBlank = false } = {}) {
  if (value === null || value === undefined) value = "";
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const text = value.replace(/^[\u0009\u000A\u000D\u0020]+|[\u0009\u000A\u000D\u0020]+$/g, "");
  rejectLoneSurrogates(text, label);
  const normalized = text.normalize("NFC");
  if (!allowBlank && !normalized) throw new Error(`${label} is required.`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(normalized)) {
    throw new Error(`${label} contains a control character.`);
  }
  return normalized;
}

function normalizeCanonicalIdentifier(value, label) {
  const normalized = normalizeIdentifier(value, label);
  if (value !== normalized) throw new Error(`${label} must already be canonical.`);
  return normalized;
}

function normalizeNotes(value) {
  if (value === null || value === undefined) value = "";
  if (typeof value !== "string") throw new Error("notes must be text.");
  const text = value.replace(/\r\n?/g, "\n");
  rejectLoneSurrogates(text, "notes");
  return text.normalize("NFC");
}

function normalizeNonnegativeInteger(value, label) {
  if (typeof value === "string") {
    const normalized = value.replace(/^[\u0009\u000A\u000D\u0020]+|[\u0009\u000A\u000D\u0020]+$/g, "");
    if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be a nonnegative integer.`);
    value = Number(normalized);
  }
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a safe nonnegative integer.`);
  return value;
}

const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function normalizeTimestamp(value, label, { allowBlank = false } = {}) {
  if (value && typeof value === "object" && typeof value.getTime === "function" && typeof value.toISOString === "function") {
    if (!Number.isFinite(value.getTime())) throw new Error(`${label} is not a valid timestamp.`);
    return value.toISOString();
  }
  const text = normalizeIdentifier(value, label, { allowBlank });
  if (allowBlank && !text) return "";
  const match = text.match(TIMESTAMP_PATTERN);
  if (!match) throw new Error(`${label} must be a strict ISO-8601 timestamp.`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", zone, sign, offsetHourText = "0", offsetMinuteText = "0"] = match;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    [yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText].map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    throw new Error(`${label} is not a valid timestamp.`);
  }
  const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute, second, Number(fraction.padEnd(3, "0"))));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
    throw new Error(`${label} is not a valid calendar timestamp.`);
  }
  const offset = zone === "Z" ? 0 : (offsetHour * 60 + offsetMinute) * (sign === "+" ? 1 : -1);
  return new Date(calendar.getTime() - offset * 60000).toISOString();
}

function normalizeSemanticTree(value, label = "value") {
  if (value === undefined) throw new Error(`${label} cannot be undefined.`);
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string") rejectLoneSurrogates(value, label);
    return typeof value === "string" ? value.normalize("NFC") : value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer.`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => normalizeSemanticTree(item, `${label}[${index}]`));
  assertPlainObject(value, label);
  const result = {};
  for (const key of Object.keys(value)) {
    rejectLoneSurrogates(key, `${label} key`);
    result[key.normalize("NFC")] = normalizeSemanticTree(value[key], `${label}.${key}`);
  }
  return result;
}

function canonicalJson(value) {
  assertCanonicalValue(value);
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function assertCanonicalValue(value, label = "value") {
  if (value === undefined) throw new Error(`${label} cannot be undefined.`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") { rejectLoneSurrogates(value, label); return; }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
    return;
  }
  if (Array.isArray(value)) { value.forEach((item, index) => assertCanonicalValue(item, `${label}[${index}]`)); return; }
  assertPlainObject(value, label);
  for (const key of Object.keys(value)) {
    rejectLoneSurrogates(key, `${label} key`);
    assertCanonicalValue(value[key], `${label}.${key}`);
  }
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value), "utf8").digest("hex");
}

function fingerprint(value) {
  return `sha256:${sha256(value)}`;
}

function projectRoutingState(state) {
  assertPlainObject(state, "routing_state");
  return {
    client_id: normalizeIdentifier(state.client_id, "client_id"),
    routing_pointer: normalizeNonnegativeInteger(state.routing_pointer, "routing_pointer"),
    last_assigned_agent_id: normalizeIdentifier(state.last_assigned_agent_id, "last_assigned_agent_id", { allowBlank: true }),
    last_assignment_timestamp: normalizeTimestamp(state.last_assignment_timestamp, "last_assignment_timestamp", { allowBlank: true }),
    total_assignments_today: normalizeNonnegativeInteger(state.total_assignments_today, "total_assignments_today"),
    notes: normalizeNotes(state.notes),
    updated_ts_utc: normalizeTimestamp(state.updated_ts_utc, "updated_ts_utc", { allowBlank: true })
  };
}

function routingStateFingerprint(state) {
  const projection = projectRoutingState(state);
  return { projection, canonical_json: canonicalJson(projection), fingerprint: fingerprint(projection) };
}

function normalizeSourceSystem(value) {
  const result = normalizeCanonicalIdentifier(value, "source_system");
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(result)) throw new Error("source_system is invalid.");
  return result;
}

function normalizeSourcePath(value) {
  const result = normalizeCanonicalIdentifier(value, "source_path");
  if (!/^[a-z0-9]+(?:[-_/][a-z0-9]+)*$/.test(result)) throw new Error("source_path is invalid.");
  return result;
}

function normalizeSourceEventId(value) {
  const result = normalizeCanonicalIdentifier(value, "source_event_id");
  if (result.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) throw new Error("source_event_id is invalid.");
  return result;
}

function exactKeys(value, expected, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unknown or missing keys.`);
  }
}

function normalizeLogicalReference(decisionType, value) {
  if (decisionType === DECISION_TYPES.INITIAL_INTAKE) {
    exactKeys(value, ["logical_reference_contract", "client_id", "source_system", "source_path", "source_event_id"], "logical_reference");
    if (value.logical_reference_contract !== CONTRACTS.initialIntake) throw new Error("Invalid initial-intake logical reference contract.");
    return {
      logical_reference_contract: CONTRACTS.initialIntake,
      client_id: normalizeCanonicalIdentifier(value.client_id, "client_id"),
      source_system: normalizeSourceSystem(value.source_system),
      source_path: normalizeSourcePath(value.source_path),
      source_event_id: normalizeSourceEventId(value.source_event_id)
    };
  }
  if (decisionType === DECISION_TYPES.AFTER_HOURS_RELEASE) {
    exactKeys(value, ["logical_reference_contract", "client_id", "release_id"], "logical_reference");
    if (value.logical_reference_contract !== CONTRACTS.afterHoursRelease) throw new Error("Invalid release logical reference contract.");
    return {
      logical_reference_contract: CONTRACTS.afterHoursRelease,
      client_id: normalizeCanonicalIdentifier(value.client_id, "client_id"),
      release_id: normalizeCanonicalIdentifier(value.release_id, "release_id")
    };
  }
  throw new Error("Unsupported routing decision type.");
}

function buildSemanticRequest(input) {
  assertPlainObject(input, "routing request");
  const decisionType = normalizeIdentifier(input.decision_type, "decision_type");
  if (!Object.values(DECISION_TYPES).includes(decisionType)) throw new Error("Unsupported routing decision type.");
  exactKeys(input.semantic_evidence || {}, [], "semantic_evidence");
  const expected = input.expected_state || {};
  const proposal = input.proposal || {};
  exactKeys(expected, ["routing_state_version", "routing_pointer", "routing_state_fingerprint"], "expected_state");
  exactKeys(proposal, ["selected_agent_id", "routing_pointer_after", "total_assignments_today_after", "notes_after"], "proposal");
  const base = {
    environment: normalizeCanonicalIdentifier(input.environment, "environment"),
    action_contract: CONTRACTS.action,
    decision_type: decisionType,
    client_id: normalizeCanonicalIdentifier(input.client_id, "client_id"),
    logical_reference: normalizeLogicalReference(decisionType, input.logical_reference),
    expected_state: {
      routing_state_version: normalizeNonnegativeInteger(expected.routing_state_version, "routing_state_version"),
      routing_pointer: normalizeNonnegativeInteger(expected.routing_pointer, "routing_pointer"),
      routing_state_fingerprint: normalizeCanonicalIdentifier(expected.routing_state_fingerprint, "routing_state_fingerprint")
    },
    proposal: {
      selected_agent_id: normalizeCanonicalIdentifier(proposal.selected_agent_id, "selected_agent_id"),
      routing_pointer_after: normalizeNonnegativeInteger(proposal.routing_pointer_after, "routing_pointer_after"),
      total_assignments_today_after: normalizeNonnegativeInteger(proposal.total_assignments_today_after, "total_assignments_today_after"),
      notes_after: normalizeNotes(proposal.notes_after)
    },
    semantic_evidence: {}
  };
  if (!/^sha256:[0-9a-f]{64}$/.test(base.expected_state.routing_state_fingerprint)) {
    throw new Error("routing_state_fingerprint is invalid.");
  }
  if (base.logical_reference.client_id !== base.client_id) throw new Error("Logical-reference client_id mismatch.");
  const commitProjection = {
    id_contract: CONTRACTS.commitId,
    environment: base.environment,
    action_contract: base.action_contract,
    decision_type: base.decision_type,
    client_id: base.client_id,
    logical_reference: base.logical_reference,
    expected_state: base.expected_state,
    proposal: base.proposal
  };
  const routing_commit_id = `rc1_${sha256(commitProjection)}`;
  const requestProjection = {
    fingerprint_contract: CONTRACTS.requestFingerprint,
    environment: base.environment,
    action_contract: base.action_contract,
    routing_commit_id,
    decision_type: base.decision_type,
    client_id: base.client_id,
    logical_reference: base.logical_reference,
    expected_state: base.expected_state,
    proposal: base.proposal,
    semantic_evidence: base.semantic_evidence
  };
  return { ...base, routing_commit_id, request_fingerprint: fingerprint(requestProjection) };
}

function requestSigningProjection(request, auth) {
  return {
    signing_contract: CONTRACTS.requestSigning,
    environment: request.environment,
    issuer: normalizeIdentifier(auth.issuer, "issuer"),
    key_id: normalizeIdentifier(auth.key_id, "key_id"),
    nonce: normalizeIdentifier(auth.nonce, "nonce"),
    issued_ts_utc: normalizeTimestamp(auth.issued_ts_utc, "issued_ts_utc"),
    expires_ts_utc: normalizeTimestamp(auth.expires_ts_utc, "expires_ts_utc"),
    action_contract: request.action_contract,
    routing_commit_id: request.routing_commit_id,
    request_fingerprint: request.request_fingerprint
  };
}

function hmacHex(secret, value) {
  return createHmac("sha256", secret).update(canonicalJson(value), "utf8").digest("hex");
}

function safeEqualHex(left, right) {
  if (!/^[a-f0-9]{64}$/.test(String(left)) || !/^[a-f0-9]{64}$/.test(String(right))) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

module.exports = {
  CONTRACTS, DECISION_TYPES, canonicalJson, fingerprint, hmacHex, normalizeNonnegativeInteger,
  normalizeSourceEventId, normalizeTimestamp, projectRoutingState, requestSigningProjection,
  routingStateFingerprint, safeEqualHex, buildSemanticRequest, normalizeSemanticTree
};
