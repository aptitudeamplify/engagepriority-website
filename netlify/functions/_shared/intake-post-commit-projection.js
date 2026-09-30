const { createHash } = require("crypto");

const INTAKE_EVENT_TYPE = "NETLIFY_INTAKE_COMPLETED";
const INTAKE_EVENT_STAGE = "NEW_LEAD_RECEIVED";
const INTAKE_EVENT_SOURCE = "NETLIFY_INTAKE_LEAD";
const INTAKE_GATEWAY_CONTEXT = "INITIAL_RESPONSE_GATEWAY";
const INTAKE_SELECTED_ACTION = "NEW_LEAD_SUBMITTED";

function normalize(value) {
  return String(value == null ? "" : value).trim();
}

function requireValue(record, field) {
  const value = normalize(record[field]);
  if (!value) {
    const error = new Error(`Missing committed intake field: ${field}`);
    error.code = "INVALID_COMMITTED_INTAKE";
    throw error;
  }
  return value;
}

function deriveIntakeLifecycleEventId(committedIntake) {
  const intakeCommitId = normalize(committedIntake.intake_commit_id);
  const identity = intakeCommitId
    ? ["intake_commit_id", intakeCommitId]
    : [
        "legacy_intake",
        requireValue(committedIntake, "client_id"),
        requireValue(committedIntake, "lead_id"),
        requireValue(committedIntake, "trace_id"),
        INTAKE_EVENT_TYPE
      ];

  return `EP-INTAKE-${createHash("sha256")
    .update(JSON.stringify(identity), "utf8")
    .digest("hex")}`;
}

function buildIntakeLifecycleEvent(committedIntake) {
  const eventTimestamp =
    normalize(committedIntake.created_ts_utc) ||
    normalize(committedIntake.assignment_ts_utc);

  if (!eventTimestamp) {
    const error = new Error(
      "Missing committed intake field: created_ts_utc or assignment_ts_utc"
    );
    error.code = "INVALID_COMMITTED_INTAKE";
    throw error;
  }

  return {
    event_id: deriveIntakeLifecycleEventId(committedIntake),
    event_ts_utc: eventTimestamp,
    client_id: requireValue(committedIntake, "client_id"),
    lead_id: requireValue(committedIntake, "lead_id"),
    trace_id: requireValue(committedIntake, "trace_id"),
    event_type: INTAKE_EVENT_TYPE,
    event_stage: INTAKE_EVENT_STAGE,
    event_source: INTAKE_EVENT_SOURCE,
    assigned_agent_id: normalize(committedIntake.assigned_agent_id),
    gateway_context: INTAKE_GATEWAY_CONTEXT,
    selected_action: INTAKE_SELECTED_ACTION,
    notes: `Committed intake projection from ${normalize(committedIntake.source_system) || "UNKNOWN"}`
  };
}

function buildIntakeAuditRecord(committedIntake) {
  return {
    event_type: INTAKE_EVENT_TYPE,
    trace_id: requireValue(committedIntake, "trace_id"),
    lead_id: requireValue(committedIntake, "lead_id"),
    client_id: requireValue(committedIntake, "client_id"),
    assigned_agent_id: normalize(committedIntake.assigned_agent_id),
    source_system: normalize(committedIntake.source_system),
    source_detail: normalize(committedIntake.source_detail),
    submitted_ts_utc: normalize(committedIntake.submitted_ts_utc),
    created_ts_utc: normalize(committedIntake.created_ts_utc),
    assignment_ts_utc: normalize(committedIntake.assignment_ts_utc),
    leadlog_created: true,
    action_link_count: Number(committedIntake.action_link_count || 0),
    reminder_created: Boolean(committedIntake.reminder_created),
    reminder_next_action_type: normalize(committedIntake.reminder_next_action_type),
    reminder_due_ts_utc: normalize(committedIntake.reminder_due_ts_utc),
    sms_status: normalize(committedIntake.sms_status),
    sms_sent_ts_utc: normalize(committedIntake.sms_sent_ts_utc),
    sms_error_code: normalize(committedIntake.sms_error_code),
    sms_error_message: normalize(committedIntake.sms_error_message),
    status: normalize(committedIntake.status) || "INTAKE_COMPLETED",
    lead_preview_full_name: normalize(committedIntake.lead_preview_full_name),
    lead_preview_phone_last4: normalize(committedIntake.lead_preview_phone_last4),
    lead_preview_email: normalize(committedIntake.lead_preview_email),
    ingested_by_make_ts_utc: ""
  };
}

function isRetryableProjectionError(error) {
  const status = Number(error?.response?.status || error?.status || error?.code);
  const message = normalize(error?.message).toLowerCase();
  return (
    status === 408 ||
    status === 429 ||
    status >= 500 ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("rate limit") ||
    message.includes("temporarily unavailable")
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withBoundedRetry(
  operation,
  { maxRetries = 2, baseDelayMs = 25, sleepFn = sleep } = {}
) {
  let attempt = 0;
  while (true) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= maxRetries || !isRetryableProjectionError(error)) {
        error.projection_attempts = attempt + 1;
        throw error;
      }
      await sleepFn(baseDelayMs * Math.pow(2, attempt));
      attempt += 1;
    }
  }
}

function safeError(error) {
  return {
    code: normalize(error?.code) || "PROJECTION_ERROR",
    retryable: isRetryableProjectionError(error),
    attempts: Number(error?.projection_attempts || 1)
  };
}

async function projectCommittedIntake({
  committedIntake,
  lifecycleStore,
  auditStore,
  auditRequired = true,
  retryOptions = {}
}) {
  const event = buildIntakeLifecycleEvent(committedIntake);
  const auditRecord = buildIntakeAuditRecord(committedIntake);
  const result = {
    core_intake_status: "COMMITTED",
    status: "PROJECTION_REPAIR_REQUIRED",
    event_id: event.event_id,
    repair_required: true,
    lifecycle: { status: "PENDING" },
    audit: { status: auditRequired ? "PENDING" : "NOT_REQUIRED" }
  };

  try {
    const existing = await withBoundedRetry(
      () => lifecycleStore.findByEventId(event.event_id),
      retryOptions
    );

    if (existing) {
      result.lifecycle = { status: "ALREADY_COMMITTED" };
    } else {
      await withBoundedRetry(() => lifecycleStore.append(event), retryOptions);
      result.lifecycle = { status: "COMMITTED" };
    }
  } catch (error) {
    result.lifecycle = { status: "REPAIR_REQUIRED", error: safeError(error) };
    return result;
  }

  if (auditRequired) {
    if (!auditStore) {
      result.audit = {
        status: "REPAIR_REQUIRED",
        error: { code: "AUDIT_STORE_NOT_CONFIGURED", retryable: false, attempts: 1 }
      };
      return result;
    }

    try {
      const existingAudit = await withBoundedRetry(
        () => auditStore.findByLogicalIdentity(auditRecord),
        retryOptions
      );

      if (existingAudit) {
        result.audit = { status: "ALREADY_COMMITTED" };
      } else {
        await withBoundedRetry(() => auditStore.append(auditRecord), retryOptions);
        result.audit = { status: "COMMITTED" };
      }
    } catch (error) {
      result.audit = { status: "REPAIR_REQUIRED", error: safeError(error) };
      return result;
    }
  }

  const wasReplay =
    result.lifecycle.status === "ALREADY_COMMITTED" &&
    (!auditRequired || result.audit.status === "ALREADY_COMMITTED");

  result.status = wasReplay
    ? "PROJECTION_ALREADY_COMMITTED"
    : "PROJECTION_COMMITTED";
  result.repair_required = false;
  return result;
}

module.exports = {
  INTAKE_EVENT_TYPE,
  buildIntakeAuditRecord,
  buildIntakeLifecycleEvent,
  deriveIntakeLifecycleEventId,
  isRetryableProjectionError,
  projectCommittedIntake,
  withBoundedRetry
};
