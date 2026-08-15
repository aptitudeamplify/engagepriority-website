const { createHash } = require("crypto");

const CONTRACT_VERSION = "EP-ANALYTICS-V1";
const SCHEMA_VERSION = "1.0.0";

const ENUMS = Object.freeze({
  environment: ["UAT", "PRODUCTION"],
  actor_type: ["SYSTEM", "AGENT", "ADMINISTRATOR", "PROVIDER", "ANALYTICS_PROCESSOR", "GOVERNANCE"],
  registry_state: ["DISABLED", "SHADOW", "READY", "ACTIVE", "PAUSED"],
  section_code: [
    "CLIENT_OVERVIEW_INTAKE", "CLIENT_OVERVIEW_RESPONSE", "CLIENT_OVERVIEW_INTERVENTION",
    "CLIENT_OVERVIEW_PATHWAYS", "CLIENT_OVERVIEW_DISPOSITIONS", "AGENT_ASSIGNED_LEADS",
    "AGENT_RESPONSE", "ALL"
  ],
  record_type: [
    "LEAD_ACCEPTED", "LIFECYCLE_OPENED", "POLICY_SNAPSHOT_CAPTURED", "AGENT_SNAPSHOT_CAPTURED",
    "ASSIGNMENT_CREATED", "GATEWAY_CREATED", "NOTIFICATION_REQUESTED",
    "NOTIFICATION_PROVIDER_ACCEPTED", "NOTIFICATION_PROVIDER_REJECTED", "DISPATCH_CLAIMED",
    "PROCESSING_FAILED", "ASSIGNMENT_ACTIONABLE", "CLIENT_RESPONSE_ASSIGNMENT_BOUND",
    "ACTION_ATTEMPT_REJECTED", "AGENT_ACTION_ACCEPTED", "INITIAL_RESPONSE_CLASSIFIED",
    "NO_RESPONSE_CLASSIFIED", "REASSIGNMENT_REQUESTED", "REASSIGNMENT_COMPLETED",
    "ASSIGNMENT_ENDED", "OWNERSHIP_TRANSFERRED", "ADMIN_ESCALATION_REACHED",
    "ADMIN_RESOLUTION_ACCEPTED", "DISPOSITION_RECORDED", "DISPOSITION_SUPERSEDED",
    "LIFECYCLE_CLOSED", "BATCH_COMMIT"
  ],
  notification_kind: ["INITIAL", "REMINDER_1", "REMINDER_2", "REMINDER_3", "OUTCOME_FOLLOW_UP", "ADMIN_ESCALATION_NOTICE"],
  intervention_position: ["INITIAL_NOTIFICATION", "AFTER_REMINDER_1", "AFTER_REMINDER_2", "AFTER_REMINDER_3", "AFTER_ADMIN_ESCALATION", "NOT_APPLICABLE"],
  gateway_type: ["INITIAL_RESPONSE_GATEWAY", "OUTCOME_GATEWAY"],
  dispatch_kind: ["NOTIFICATION", "ACTION", "REASSIGNMENT", "ESCALATION"],
  processing_stage: ["INTAKE", "ASSIGNMENT", "GATEWAY_CREATION", "NOTIFICATION", "ACTION_VALIDATION", "ACTION_PROCESSING", "REASSIGNMENT", "ESCALATION", "ADMIN_RESOLUTION", "LIFECYCLE_CLOSURE", "ANALYTICS_SUBMISSION"],
  action_type: ["CALL_NOW", "REMIND_ME_5_MIN", "REASSIGN", "NO_ANSWER", "CONTACTED_SET_APPOINTMENT", "CONTACTED_NOT_INTERESTED"],
  action_rejection_code: ["INVALID_GATEWAY", "EXPIRED_GATEWAY", "WRONG_ASSIGNMENT", "WRONG_OWNER_EPOCH", "ASSIGNMENT_NOT_ACTIONABLE", "ASSIGNMENT_ENDED", "DUPLICATE_ACTION", "INVALID_ACTION", "UNAUTHORIZED_ACTOR", "CORRELATION_FAILURE"],
  response_classification: ["ACCEPTED_INITIAL_RESPONSE", "NO_ACCEPTED_RESPONSE"],
  assignment_created_reason: ["INITIAL_ASSIGNMENT", "REASSIGNMENT"],
  assignment_end_reason: ["REASSIGNED", "LIFECYCLE_CLOSED", "ADMINISTRATIVE_TERMINATION"],
  disposition_origin: ["AGENT", "ADMINISTRATOR"],
  disposition_code: ["CONTACTED_SET_APPOINTMENT", "CONTACTED_NOT_INTERESTED", "ADMIN_CONTACTED_APPOINTMENT_SET", "ADMIN_CONTACTED_NOT_INTERESTED", "ADMIN_NO_ANSWER", "ADMIN_NO_ACTION"],
  lifecycle_close_reason: ["APPOINTMENT_SET", "CONTACTED_NOT_INTERESTED", "CLOSED_WITHOUT_RECORDED_CONTACT_OUTCOME"],
  registry_record_type: ["DEPLOYMENT_APPROVED", "WRITER_SCHEMA_FROZEN", "CUTOVER_COMMITTED", "STATE_TRANSITION", "VISIBILITY_APPROVED", "VISIBILITY_REVOKED", "COVERAGE_EPOCH_OPENED", "COVERAGE_EPOCH_CLOSED", "CAPACITY_GATE_PASSED", "CAPACITY_GATE_FAILED"],
  authorization_type: ["UAT_DEPLOYMENT", "PRODUCTION_DEPLOYMENT", "SCHEMA_FREEZE", "READINESS_ACCEPTANCE", "MEASUREMENT_ACTIVATION", "CLIENT_VISIBILITY", "ROLLBACK", "RECOVERY", "KEY_ROTATION", "CAPACITY_GATE"],
  integrity_code: ["SOURCE_SEQUENCE_GAP", "SOURCE_SEQUENCE_CONFLICT", "OBLIGATION_UNCONFIRMED", "RETRY_EXHAUSTED", "UNKNOWN_SUBMISSION_RESULT", "EVENT_KEY_CONFLICT", "FACT_HASH_CONFLICT", "INCOMPLETE_BATCH", "BATCH_MEMBER_CONFLICT", "BATCH_COUNT_CONFLICT", "BATCH_COMMIT_CONFLICT", "UNVERIFIED_PRODUCER_AUTHORITY", "MISSING_PROVIDER_ACCEPTANCE", "MISSING_POLICY_SNAPSHOT", "MISSING_AGENT_SNAPSHOT", "MISSING_ASSIGNMENT_REFERENCE", "AMBIGUOUS_FIRST_ACTIONABLE_ASSIGNMENT", "MISSING_CLIENT_RESPONSE_BINDING", "INVALID_OWNER_EPOCH", "DISPOSITION_CONFLICT", "CROSS_CLIENT_REFERENCE", "CROSS_ENVIRONMENT_REFERENCE", "UNSUPPORTED_SCHEMA_VERSION", "UNKNOWN_ENUM_VALUE", "COVERAGE_EPOCH_CONFLICT", "PAUSED_INTERVAL_GAP", "REPLAY_ATTEMPT", "AUTHENTICATION_FAILURE", "NONCE_STORE_UNAVAILABLE", "CAPACITY_GATE_FAILURE", "PROHIBITED_DATA_DETECTED", "PRODUCER_FAILURE_UNDETECTABLE"],
  severity: ["INFO", "WARNING", "ERROR", "CRITICAL"],
  resolution_type: ["OPEN", "RESOLVED_AUTHORITATIVE_REPLAY", "RESOLVED_COMMITTED_DUPLICATE", "RESOLVED_CONFIGURATION", "RESOLVED_SCHEMA_CORRECTION", "RESOLVED_SECURITY_ACTION", "RESOLVED_NEW_COVERAGE_EPOCH", "CLOSED_NOT_RECONSTRUCTABLE"],
  obligation_record_type: ["OBLIGATION_OPENED", "SUBMISSION_OBSERVED", "RECEIPT_CONFIRMED", "RETRY_EXHAUSTED", "REPLAY_CONFIRMED", "OBLIGATION_CONFLICT"],
  transport_result: ["RESPONSE_RECEIVED", "TIMEOUT", "CONNECTION_FAILURE", "MALFORMED_RESPONSE", "INVALID_RESPONSE_SIGNATURE"],
  writer_result: ["COMMITTED", "DUPLICATE_COMMITTED", "REJECTED", "UNKNOWN_RESULT"],
  coverage_record_type: ["COVERAGE_CHECKPOINT", "COVERAGE_GAP_OPENED", "COVERAGE_GAP_RESOLVED", "COVERAGE_EPOCH_SEALED"]
});

const LEDGER_HEADERS = Object.freeze([
  "schema_version", "contract_version", "record_type", "event_id", "event_key", "event_ts_utc",
  "observed_ts_utc", "ingested_ts_utc", "environment", "client_id", "coverage_epoch_id", "source_id",
  "source_sequence", "source_correlation_id", "lifecycle_id", "lead_id", "assignment_id",
  "assignment_sequence", "client_response_assignment_id", "owner_epoch_id", "agent_id_snapshot", "actor_type",
  "actor_id_snapshot", "policy_snapshot_id", "gateway_id", "notification_attempt_id", "action_attempt_id",
  "reassignment_id", "escalation_id", "admin_resolution_id", "event_payload_json", "fact_hash", "batch_id",
  "batch_index", "batch_count", "sequence_no", "writer_version", "writer_deployment_id"
]);

const PHYSICAL_HEADERS = Object.freeze({
  AnalyticsLedger: LEDGER_HEADERS,
  AnalyticsMeasurementRegistry: ["schema_version", "registry_record_id", "registry_record_type", "event_ts_utc", "environment", "client_id", "coverage_epoch_id", "cutover_id", "from_state", "to_state", "measurement_eligible", "client_visibility_enabled", "eligible_from_ts_utc", "visibility_from_ts_utc", "writer_version", "ledger_schema_version", "contract_version", "authorization_type", "authorized_by", "authority_role", "authorization_ref", "reason_code", "related_integrity_event_id", "prior_registry_record_id", "record_payload_json", "fact_hash", "created_ts_utc"],
  AnalyticsIntegrityEvents: ["schema_version", "integrity_event_id", "detected_ts_utc", "environment", "client_id", "coverage_epoch_id", "section_code", "source_id", "source_sequence_from", "source_sequence_to", "event_key", "batch_id", "integrity_code", "severity", "withhold_section", "pause_measurement", "first_affected_ts_utc", "last_affected_ts_utc", "evidence_json", "detector_version", "related_integrity_event_id", "resolution_type", "resolved_ts_utc", "fact_hash"],
  AnalyticsSubmissionObligations: ["schema_version", "obligation_record_id", "obligation_id", "obligation_record_type", "event_ts_utc", "environment", "client_id", "coverage_epoch_id", "source_id", "source_sequence", "source_correlation_id", "event_key", "fact_hash", "batch_id", "obligation_created_ts_utc", "next_attempt_not_before_ts_utc", "receipt_id", "ledger_sequence_no", "failure_code", "record_payload_json", "created_ts_utc"],
  AnalyticsRetryAttempts: ["schema_version", "retry_attempt_id", "obligation_id", "attempt_number", "attempt_started_ts_utc", "attempt_finished_ts_utc", "environment", "client_id", "coverage_epoch_id", "source_id", "source_sequence", "request_id", "batch_id", "transport_result", "writer_result", "http_observation", "error_code", "retryable", "next_attempt_not_before_ts_utc", "receipt_id", "response_fact_hash", "created_ts_utc"],
  AnalyticsSourceCoverage: ["schema_version", "coverage_record_id", "coverage_record_type", "event_ts_utc", "environment", "client_id", "coverage_epoch_id", "source_id", "section_code", "first_source_sequence", "committed_through_source_sequence", "committed_through_event_ts_utc", "expected_next_source_sequence", "ledger_sequence_no", "open_gap_count", "oldest_open_gap_ts_utc", "applicable_producer_set_hash", "coverage_complete", "coverage_proof_json", "writer_version", "fact_hash", "created_ts_utc"],
  AnalyticsReplayNonces: ["schema_version", "nonce_record_id", "record_type", "environment", "issuer", "key_id", "nonce_hash", "request_id", "batch_id", "client_id", "coverage_epoch_id", "source_id", "accepted_ts_utc", "expires_ts_utc", "retention_until_ts_utc", "request_signing_hash", "created_ts_utc"]
});

const COMMON_REQUIRED = ["record_type", "event_ts_utc", "environment", "client_id", "coverage_epoch_id", "source_id", "source_sequence", "source_correlation_id", "actor_type", "event_payload"];
const RECORD_REQUIRED = Object.freeze({
  LEAD_ACCEPTED: ["lifecycle_id", "lead_id", "policy_snapshot_id"],
  LIFECYCLE_OPENED: ["lifecycle_id", "lead_id", "policy_snapshot_id"],
  POLICY_SNAPSHOT_CAPTURED: ["policy_snapshot_id"],
  AGENT_SNAPSHOT_CAPTURED: ["lifecycle_id", "assignment_id", "agent_id_snapshot"],
  ASSIGNMENT_CREATED: ["lifecycle_id", "lead_id", "assignment_id", "assignment_sequence", "owner_epoch_id", "agent_id_snapshot", "policy_snapshot_id"],
  GATEWAY_CREATED: ["lifecycle_id", "assignment_id", "owner_epoch_id", "gateway_id"],
  NOTIFICATION_REQUESTED: ["lifecycle_id", "notification_attempt_id", "policy_snapshot_id"],
  NOTIFICATION_PROVIDER_ACCEPTED: ["lifecycle_id", "notification_attempt_id"],
  NOTIFICATION_PROVIDER_REJECTED: ["lifecycle_id", "notification_attempt_id"],
  DISPATCH_CLAIMED: ["lifecycle_id"],
  PROCESSING_FAILED: [],
  ASSIGNMENT_ACTIONABLE: ["lifecycle_id", "assignment_id", "assignment_sequence", "owner_epoch_id", "agent_id_snapshot", "policy_snapshot_id", "notification_attempt_id"],
  CLIENT_RESPONSE_ASSIGNMENT_BOUND: ["lifecycle_id", "assignment_id", "assignment_sequence", "client_response_assignment_id", "owner_epoch_id", "agent_id_snapshot"],
  ACTION_ATTEMPT_REJECTED: ["action_attempt_id"],
  AGENT_ACTION_ACCEPTED: ["lifecycle_id", "assignment_id", "assignment_sequence", "owner_epoch_id", "agent_id_snapshot", "gateway_id", "action_attempt_id", "policy_snapshot_id"],
  INITIAL_RESPONSE_CLASSIFIED: ["lifecycle_id", "assignment_id", "assignment_sequence", "owner_epoch_id", "agent_id_snapshot", "policy_snapshot_id", "action_attempt_id"],
  NO_RESPONSE_CLASSIFIED: ["lifecycle_id", "assignment_id", "assignment_sequence", "owner_epoch_id", "agent_id_snapshot", "policy_snapshot_id"],
  REASSIGNMENT_REQUESTED: ["lifecycle_id", "assignment_id", "owner_epoch_id", "agent_id_snapshot", "reassignment_id"],
  REASSIGNMENT_COMPLETED: ["lifecycle_id", "assignment_id", "owner_epoch_id", "reassignment_id"],
  ASSIGNMENT_ENDED: ["lifecycle_id", "assignment_id", "assignment_sequence", "owner_epoch_id", "agent_id_snapshot"],
  OWNERSHIP_TRANSFERRED: ["lifecycle_id", "assignment_id", "owner_epoch_id", "reassignment_id"],
  ADMIN_ESCALATION_REACHED: ["lifecycle_id", "escalation_id"],
  ADMIN_RESOLUTION_ACCEPTED: ["lifecycle_id", "admin_resolution_id", "actor_id_snapshot"],
  DISPOSITION_RECORDED: ["lifecycle_id"],
  DISPOSITION_SUPERSEDED: ["lifecycle_id"],
  LIFECYCLE_CLOSED: ["lifecycle_id", "lead_id"],
  BATCH_COMMIT: []
});

const EVENT_KEY_FIELDS = Object.freeze({
  LEAD_ACCEPTED: ["lifecycle_id", "lead_accepted"], LIFECYCLE_OPENED: ["lifecycle_id", "lifecycle_opened"],
  POLICY_SNAPSHOT_CAPTURED: ["policy_snapshot_id", "captured"], AGENT_SNAPSHOT_CAPTURED: ["agent_id_snapshot", "captured"],
  ASSIGNMENT_CREATED: ["assignment_id", "created"], GATEWAY_CREATED: ["gateway_id", "created"],
  NOTIFICATION_REQUESTED: ["notification_attempt_id", "requested"], NOTIFICATION_PROVIDER_ACCEPTED: ["notification_attempt_id", "provider_accepted"],
  NOTIFICATION_PROVIDER_REJECTED: ["notification_attempt_id", "provider_rejected"], ASSIGNMENT_ACTIONABLE: ["assignment_id", "actionable"],
  CLIENT_RESPONSE_ASSIGNMENT_BOUND: ["lifecycle_id", "client_response_assignment_bound"], ACTION_ATTEMPT_REJECTED: ["action_attempt_id", "rejected"],
  AGENT_ACTION_ACCEPTED: ["action_attempt_id", "accepted"], INITIAL_RESPONSE_CLASSIFIED: ["assignment_id", "initial_response_classified"],
  NO_RESPONSE_CLASSIFIED: ["assignment_id", "no_response_classified"], REASSIGNMENT_REQUESTED: ["reassignment_id", "requested"],
  REASSIGNMENT_COMPLETED: ["reassignment_id", "completed"], ASSIGNMENT_ENDED: ["assignment_id", "ended"],
  OWNERSHIP_TRANSFERRED: ["owner_epoch_id", "transferred"], ADMIN_ESCALATION_REACHED: ["escalation_id", "reached"],
  ADMIN_RESOLUTION_ACCEPTED: ["admin_resolution_id", "accepted"], LIFECYCLE_CLOSED: ["lifecycle_id", "closed"],
  BATCH_COMMIT: ["batch_id", "commit"]
});

const RECORD_PAYLOAD_REQUIRED = Object.freeze({
  LEAD_ACCEPTED: ["accepted_ts_utc", "intake_source_reference", "authoritative_acceptance_record_id"],
  LIFECYCLE_OPENED: ["lifecycle_opened_ts_utc", "authoritative_lifecycle_record_id"],
  POLICY_SNAPSHOT_CAPTURED: ["policy_version", "policy_effective_ts_utc", "business_timezone", "initial_response_deadline_ms", "intervention_schedule_json", "policy_hash"],
  AGENT_SNAPSHOT_CAPTURED: ["agent_id", "agent_display_name", "snapshot_effective_ts_utc", "agent_identity_hash"],
  ASSIGNMENT_CREATED: ["assignment_created_ts_utc", "assignment_created_reason", "assigned_agent_id", "owner_epoch_started_ts_utc"],
  GATEWAY_CREATED: ["gateway_type", "gateway_created_ts_utc", "gateway_expires_ts_utc", "gateway_correlation_hash"],
  NOTIFICATION_REQUESTED: ["notification_kind", "intervention_position", "channel", "provider_name", "requested_ts_utc", "request_correlation_hash"],
  NOTIFICATION_PROVIDER_ACCEPTED: ["notification_kind", "intervention_position", "provider_name", "provider_message_id", "provider_accepted_ts_utc", "provider_status"],
  NOTIFICATION_PROVIDER_REJECTED: ["notification_kind", "intervention_position", "provider_name", "provider_rejected_ts_utc", "provider_error_code", "provider_status"],
  DISPATCH_CLAIMED: ["dispatch_kind", "dispatch_claim_id", "dispatch_claimed_ts_utc", "claimed_operational_record_id"],
  PROCESSING_FAILED: ["processing_stage", "failure_occurrence_id", "failure_code", "failed_ts_utc", "retryable", "authoritative_state_unchanged"],
  ASSIGNMENT_ACTIONABLE: ["actionable_ts_utc", "actionability_basis", "provider_acceptance_event_key"],
  CLIENT_RESPONSE_ASSIGNMENT_BOUND: ["bound_ts_utc", "assignment_actionable_event_key", "binding_rule_version"],
  ACTION_ATTEMPT_REJECTED: ["attempted_action_type", "rejected_ts_utc", "action_rejection_code", "operational_state_changed"],
  AGENT_ACTION_ACCEPTED: ["action_type", "accepted_ts_utc", "operational_action_record_id", "qualifies_as_initial_response"],
  INITIAL_RESPONSE_CLASSIFIED: ["response_classification", "assignment_actionable_ts_utc", "accepted_action_ts_utc", "response_time_ms", "action_type", "intervention_position", "accepted_action_event_key"],
  NO_RESPONSE_CLASSIFIED: ["response_classification", "assignment_actionable_ts_utc", "response_deadline_ts_utc", "assignment_ended_ts_utc", "classified_ts_utc", "assignment_ended_event_key", "coverage_proof_record_ids", "applicable_source_set_hash", "unresolved_dispatch_claim_count", "unresolved_action_attempt_count", "missing_notification_evidence_count", "missing_intervention_evidence_count", "intervention_position"],
  REASSIGNMENT_REQUESTED: ["requested_ts_utc", "request_origin", "originating_action_event_key"],
  REASSIGNMENT_COMPLETED: ["completed_ts_utc", "prior_assignment_id", "replacement_assignment_id", "replacement_assignment_sequence", "replacement_owner_epoch_id"],
  ASSIGNMENT_ENDED: ["assignment_ended_ts_utc", "assignment_end_reason"],
  OWNERSHIP_TRANSFERRED: ["transferred_ts_utc", "prior_owner_epoch_id", "replacement_assignment_id", "replacement_owner_epoch_id"],
  ADMIN_ESCALATION_REACHED: ["escalation_reached_ts_utc", "escalation_basis", "intervention_position"],
  ADMIN_RESOLUTION_ACCEPTED: ["resolution_accepted_ts_utc", "resolution_action", "authorized_admin_scope_ref"],
  DISPOSITION_RECORDED: ["disposition_origin", "disposition_code", "disposition_recorded_ts_utc", "accepted_origin_event_key", "supersedes_disposition_event_key"],
  DISPOSITION_SUPERSEDED: ["prior_disposition_event_key", "replacement_disposition_event_key", "prior_disposition_origin", "replacement_disposition_origin", "replacement_origin_id", "superseded_ts_utc", "supersession_authorization_ref"],
  LIFECYCLE_CLOSED: ["lifecycle_closed_ts_utc", "lifecycle_close_reason", "effective_disposition_event_key"],
  BATCH_COMMIT: ["batch_id", "batch_count", "first_sequence_no", "last_member_sequence_no", "commit_sequence_no", "first_source_sequence", "last_source_sequence", "member_digest", "member_event_keys", "member_fact_hashes"]
});

const DISPATCH_REQUIRED = Object.freeze({
  NOTIFICATION: ["lifecycle_id", "assignment_id", "assignment_sequence", "owner_epoch_id", "agent_id_snapshot", "notification_attempt_id"],
  ACTION: ["lifecycle_id", "assignment_id", "assignment_sequence", "owner_epoch_id", "agent_id_snapshot", "gateway_id", "action_attempt_id"],
  REASSIGNMENT: ["lifecycle_id", "assignment_id", "assignment_sequence", "owner_epoch_id", "agent_id_snapshot", "reassignment_id"],
  ESCALATION: ["lifecycle_id", "assignment_id", "assignment_sequence", "owner_epoch_id", "agent_id_snapshot", "escalation_id"]
});

const PROCESSING_REQUIRED = Object.freeze({
  INTAKE: [], ASSIGNMENT: ["lifecycle_id", "lead_id"],
  GATEWAY_CREATION: ["lifecycle_id", "assignment_id", "assignment_sequence", "owner_epoch_id", "agent_id_snapshot"],
  NOTIFICATION: ["lifecycle_id", "assignment_id", "assignment_sequence", "owner_epoch_id", "agent_id_snapshot", "notification_attempt_id"],
  ACTION_VALIDATION: ["action_attempt_id"],
  ACTION_PROCESSING: ["lifecycle_id", "assignment_id", "assignment_sequence", "owner_epoch_id", "agent_id_snapshot", "gateway_id", "action_attempt_id"],
  REASSIGNMENT: ["lifecycle_id", "assignment_id", "assignment_sequence", "owner_epoch_id", "agent_id_snapshot", "reassignment_id"],
  ESCALATION: ["lifecycle_id", "assignment_id", "assignment_sequence", "owner_epoch_id", "agent_id_snapshot", "escalation_id"],
  ADMIN_RESOLUTION: ["lifecycle_id", "admin_resolution_id", "actor_id_snapshot"],
  LIFECYCLE_CLOSURE: ["lifecycle_id", "lead_id"], ANALYTICS_SUBMISSION: []
});

const RECORD_ACTORS = Object.freeze({
  LEAD_ACCEPTED: ["SYSTEM"], LIFECYCLE_OPENED: ["SYSTEM"], POLICY_SNAPSHOT_CAPTURED: ["SYSTEM"],
  AGENT_SNAPSHOT_CAPTURED: ["SYSTEM"], ASSIGNMENT_CREATED: ["SYSTEM"], GATEWAY_CREATED: ["SYSTEM"],
  NOTIFICATION_REQUESTED: ["SYSTEM"], NOTIFICATION_PROVIDER_ACCEPTED: ["PROVIDER"], NOTIFICATION_PROVIDER_REJECTED: ["PROVIDER"],
  DISPATCH_CLAIMED: ["SYSTEM"], PROCESSING_FAILED: ["SYSTEM"], ASSIGNMENT_ACTIONABLE: ["SYSTEM"],
  CLIENT_RESPONSE_ASSIGNMENT_BOUND: ["ANALYTICS_PROCESSOR"], ACTION_ATTEMPT_REJECTED: ["AGENT", "SYSTEM"],
  AGENT_ACTION_ACCEPTED: ["AGENT"], INITIAL_RESPONSE_CLASSIFIED: ["ANALYTICS_PROCESSOR"], NO_RESPONSE_CLASSIFIED: ["ANALYTICS_PROCESSOR"],
  REASSIGNMENT_REQUESTED: ["AGENT", "ADMINISTRATOR", "SYSTEM"], REASSIGNMENT_COMPLETED: ["SYSTEM"],
  ASSIGNMENT_ENDED: ["SYSTEM", "ADMINISTRATOR"], OWNERSHIP_TRANSFERRED: ["SYSTEM"], ADMIN_ESCALATION_REACHED: ["SYSTEM"],
  ADMIN_RESOLUTION_ACCEPTED: ["ADMINISTRATOR"], DISPOSITION_RECORDED: ["AGENT", "ADMINISTRATOR"],
  DISPOSITION_SUPERSEDED: ["AGENT", "ADMINISTRATOR"], LIFECYCLE_CLOSED: ["SYSTEM", "ADMINISTRATOR"], BATCH_COMMIT: ["ANALYTICS_PROCESSOR"]
});

const PROHIBITED_KEYS = new Set(["full_name", "phone", "email", "message", "message_body", "short_code", "token", "auth_token", "signature", "secret"]);

function canonicalize(value) {
  assertCanonicalValue(value);
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

function assertCanonicalValue(value, path = "$") {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value !== value.normalize("NFC")) throw new Error(`NON_NFC_STRING:${path}`);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`NON_INTEGER_NUMBER:${path}`);
    return;
  }
  if (Array.isArray(value)) return value.forEach((item, index) => assertCanonicalValue(item, `${path}[${index}]`));
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`UNSUPPORTED_CANONICAL_VALUE:${path}`);
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) throw new Error(`UNDEFINED_VALUE:${path}.${key}`);
    assertCanonicalValue(item, `${path}.${key}`);
  }
}

function sha256Hex(value) {
  const bytes = typeof value === "string" ? value : canonicalize(value);
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

function validateEnum(name, value) {
  if (!ENUMS[name] || !ENUMS[name].includes(value)) throw new Error(`UNKNOWN_ENUM_VALUE:${name}:${value}`);
  return value;
}

function validateNoProhibitedData(value, path = "$") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) return value.forEach((item, index) => validateNoProhibitedData(item, `${path}[${index}]`));
  for (const [key, item] of Object.entries(value)) {
    if (PROHIBITED_KEYS.has(key.toLowerCase())) throw new Error(`PROHIBITED_DATA:${path}.${key}`);
    validateNoProhibitedData(item, `${path}.${key}`);
  }
}

function validateSourceSequence(record) {
  if (!Number.isSafeInteger(record.source_sequence) || record.source_sequence < 1) throw new Error("INVALID_SOURCE_SEQUENCE");
  return `${record.environment}|${record.client_id}|${record.coverage_epoch_id}|${record.source_id}|${record.source_sequence}`;
}

function deterministicEventKey(record) {
  const type = validateEnum("record_type", record.record_type);
  let parts;
  if (type === "DISPATCH_CLAIMED") parts = [record.event_payload.dispatch_kind, record.source_correlation_id, "claimed"];
  else if (type === "PROCESSING_FAILED") parts = [record.event_payload.processing_stage, record.source_correlation_id, record.event_payload.failure_occurrence_id];
  else if (type === "DISPOSITION_RECORDED") parts = [record.event_payload.disposition_origin === "AGENT" ? record.action_attempt_id : record.admin_resolution_id, "disposition_recorded"];
  else if (type === "DISPOSITION_SUPERSEDED") parts = [record.event_payload.replacement_origin_id, sha256Hex(record.event_payload.prior_disposition_event_key), "superseded"];
  else parts = (EVENT_KEY_FIELDS[type] || []).map(item => Object.prototype.hasOwnProperty.call(record, item) ? record[item] : item);
  if (!parts.length || parts.some(item => item === null || item === undefined || item === "")) throw new Error(`EVENT_KEY_FIELDS_MISSING:${type}`);
  return ["v1", record.environment, record.client_id, record.coverage_epoch_id, type, ...parts].join("|");
}

function validateConditionalRecord(record) {
  const payload = record.event_payload;
  if (!(RECORD_ACTORS[record.record_type] || []).includes(record.actor_type)) throw new Error(`INVALID_ACTOR:${record.record_type}:${record.actor_type}`);
  (RECORD_PAYLOAD_REQUIRED[record.record_type] || []).forEach(field => {
    if (!Object.prototype.hasOwnProperty.call(payload, field) || payload[field] === undefined) throw new Error(`REQUIRED_PAYLOAD_FIELD:${record.record_type}:${field}`);
  });
  if (record.record_type === "DISPATCH_CLAIMED") {
    validateEnum("dispatch_kind", payload.dispatch_kind);
    requireFields(record, DISPATCH_REQUIRED[payload.dispatch_kind], record.record_type);
  }
  if (record.record_type === "PROCESSING_FAILED") {
    validateEnum("processing_stage", payload.processing_stage);
    requireFields(record, PROCESSING_REQUIRED[payload.processing_stage], record.record_type);
  }
  if (record.record_type === "DISPOSITION_RECORDED") {
    validateEnum("disposition_origin", payload.disposition_origin);
    validateEnum("disposition_code", payload.disposition_code);
    const agent = payload.disposition_origin === "AGENT";
    const required = agent ? ["assignment_id", "assignment_sequence", "owner_epoch_id", "agent_id_snapshot", "action_attempt_id"] : ["admin_resolution_id", "actor_id_snapshot"];
    required.forEach(field => { if (record[field] === null || record[field] === undefined || record[field] === "") throw new Error(`REQUIRED_FIELD:${record.record_type}:${field}`); });
    if (agent && record.actor_type !== "AGENT") throw new Error("INVALID_DISPOSITION_ACTOR");
    if (!agent && record.actor_type !== "ADMINISTRATOR") throw new Error("INVALID_DISPOSITION_ACTOR");
  }
  if (record.record_type === "NO_RESPONSE_CLASSIFIED") {
    ["assignment_ended_event_key", "assignment_ended_ts_utc", "coverage_proof_record_ids", "applicable_source_set_hash"].forEach(field => {
      if (payload[field] === null || payload[field] === undefined || payload[field] === "") throw new Error(`REQUIRED_PAYLOAD_FIELD:NO_RESPONSE_CLASSIFIED:${field}`);
    });
    ["unresolved_dispatch_claim_count", "unresolved_action_attempt_count", "missing_notification_evidence_count", "missing_intervention_evidence_count"].forEach(field => {
      if (payload[field] !== 0) throw new Error(`NO_RESPONSE_PROOF_INCOMPLETE:${field}`);
    });
  }
  const enumPayloads = {
    ASSIGNMENT_CREATED: [["assignment_created_reason", "assignment_created_reason"]],
    GATEWAY_CREATED: [["gateway_type", "gateway_type"]],
    NOTIFICATION_REQUESTED: [["notification_kind", "notification_kind"], ["intervention_position", "intervention_position"]],
    NOTIFICATION_PROVIDER_ACCEPTED: [["notification_kind", "notification_kind"], ["intervention_position", "intervention_position"]],
    NOTIFICATION_PROVIDER_REJECTED: [["notification_kind", "notification_kind"], ["intervention_position", "intervention_position"]],
    ACTION_ATTEMPT_REJECTED: [["attempted_action_type", "action_type"], ["action_rejection_code", "action_rejection_code"]],
    AGENT_ACTION_ACCEPTED: [["action_type", "action_type"]],
    INITIAL_RESPONSE_CLASSIFIED: [["response_classification", "response_classification"], ["action_type", "action_type"], ["intervention_position", "intervention_position"]],
    NO_RESPONSE_CLASSIFIED: [["response_classification", "response_classification"], ["intervention_position", "intervention_position"]],
    ASSIGNMENT_ENDED: [["assignment_end_reason", "assignment_end_reason"]],
    ADMIN_ESCALATION_REACHED: [["intervention_position", "intervention_position"]],
    LIFECYCLE_CLOSED: [["lifecycle_close_reason", "lifecycle_close_reason"]]
  };
  for (const [field, enumName] of enumPayloads[record.record_type] || []) validateEnum(enumName, payload[field]);
}

function requireFields(value, fields, label) {
  fields.forEach(field => {
    if (value[field] === null || value[field] === undefined || value[field] === "") throw new Error(`REQUIRED_FIELD:${label}:${field}`);
  });
}

function buildEvent(input) {
  const record = { schema_version: SCHEMA_VERSION, contract_version: CONTRACT_VERSION, ...input };
  COMMON_REQUIRED.concat(RECORD_REQUIRED[record.record_type] || []).forEach(field => {
    if (record[field] === null || record[field] === undefined || record[field] === "") throw new Error(`REQUIRED_FIELD:${record.record_type || "UNKNOWN"}:${field}`);
  });
  validateEnum("environment", record.environment);
  validateEnum("record_type", record.record_type);
  validateEnum("actor_type", record.actor_type);
  validateSourceSequence(record);
  validateNoProhibitedData(record.event_payload);
  validateConditionalRecord(record);
  record.event_key = deterministicEventKey(record);
  record.event_id = record.event_id || `evt_${sha256Hex(record.event_key).slice(0, 32)}`;
  const semanticFact = {};
  for (const header of LEDGER_HEADERS.slice(0, 31)) {
    if (["event_id", "observed_ts_utc", "ingested_ts_utc"].includes(header)) continue;
    semanticFact[header === "event_payload_json" ? "event_payload" : header] = header === "event_payload_json" ? record.event_payload : (record[header] ?? null);
  }
  record.fact_hash = sha256Hex(semanticFact);
  return Object.freeze(record);
}

module.exports = {
  CONTRACT_VERSION,
  SCHEMA_VERSION,
  ENUMS,
  PHYSICAL_HEADERS,
  RECORD_REQUIRED,
  RECORD_PAYLOAD_REQUIRED,
  DISPATCH_REQUIRED,
  PROCESSING_REQUIRED,
  RECORD_ACTORS,
  canonicalize,
  sha256Hex,
  validateEnum,
  validateSourceSequence,
  deterministicEventKey,
  buildEvent
};
