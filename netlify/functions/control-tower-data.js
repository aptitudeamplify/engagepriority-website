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
const TAB_AGENTS = "Agents";
const TAB_REMINDER_QUEUE = "ReminderQueue";
const TAB_RELEASE_QUEUE = "ReleaseQueue";
const TAB_ACTION_LINK_MAP = "ActionLinkMap";
const TAB_LEAD_LOG_ACTIVE = "LeadLog_Active";
const TAB_LEAD_LIFECYCLE_LOG = "LeadLifecycleLog";

const DEFAULT_ACTION_LINK_MAP_SPREADSHEET_ID =
  "1xNhypMirxoz9IjMWxO0H8gxNSqqavs2W17pzx8HiZfw";

const SESSION_STATUS_ACTIVE = "ACTIVE";
const CONTACT_STATUS_ACTIVE = "ACTIVE";
const CONTACT_ROLE_ADMIN = "ADMIN";
const CLIENT_STATUS_ACTIVE = "ACTIVE";

const VALID_TIME_FILTERS = new Set(["today", "last_7_days", "active_only"]);
const VALID_SUMMARY_FILTERS = new Set([
  "awaiting_agent_action",
  "reminder_active",
  "reassignment_active",
  "escalated_to_admin",
  "closed"
]);

const RECORD_LIMIT = 20;

const STATUS_PRIORITY = {
  "Escalated to Admin": 1,
  "Reassignment Pending": 2,
  "Pending Release": 3,
  "Closed": 4,
  "Agent Action Started": 5,
  "No Answer Follow-up": 6,
  "Reminder Active": 7,
  "Awaiting Agent Action": 8
};

exports.handler = async function handler(event) {
  const method = String(event.httpMethod || "").toUpperCase();

  if (method !== "GET") {
    return methodNotAllowedResponse();
  }

  const eventTsUtc = nowIso();
  const query = event.queryStringParameters || {};
  const timeFilter = normalizeTimeFilter(query.time_filter);
  const summaryFilter = normalizeSummaryFilter(query.summary_filter);

  console.log("control_tower_data_request_received", {
    method,
    time_filter: timeFilter,
    summary_filter: summaryFilter || "",
    event_ts_utc: eventTsUtc
  });

  try {
    const authContext = await validateSession(event);
    const { sheets, registrySpreadsheetId, clientId, clientRow } = authContext;
    const clientSpreadsheetId = String(clientRow.lead_data_spreadsheet_id || "").trim();
    const clientTimezone = String(clientRow.primary_timezone || "").trim();

    const [
      agentsTable,
      reminderQueueTable,
      releaseQueueTable,
      actionLinkMapTable,
      leadLogTable,
      lifecycleTable
    ] = await Promise.all([
      readCentralTable(sheets, TAB_AGENTS, [
        "agent_id",
        "client_id",
        "agent_name",
        "agent_status"
      ]),
      readCentralTable(sheets, TAB_REMINDER_QUEUE, [
        "trace_id",
        "client_id",
        "lead_id",
        "assigned_agent_id",
        "active_monitoring",
        "next_action_due_ts_utc",
        "next_action_type"
      ]),
      readCentralTable(sheets, TAB_RELEASE_QUEUE, [
        "release_id",
        "client_id",
        "lead_id",
        "release_due_ts_utc",
        "status",
        "released_ts_utc",
        "release_result",
        "assigned_agent_id"
      ]),
      readActionLinkMapTable(sheets),
      readClientTable(sheets, clientSpreadsheetId, TAB_LEAD_LOG_ACTIVE, [
        "lead_id",
        "client_id",
        "created_timestamp",
        "source_system",
        "source_detail",
        "full_name",
        "assigned_agent_id",
        "contacted_flag",
        "contact_timestamp",
        "lead_status",
        "last_updated_timestamp",
        "trace_id",
        "contact_outcome",
        "reassignment_count",
        "assignment_attempt_count",
        "reassignment_pending",
        "reassignment_status",
        "admin_escalation_required",
        "admin_escalation_ts_utc",
        "admin_escalation_reason",
        "no_answer_attempt_count",
        "deferral_count",
        "last_agent_action",
        "last_agent_action_ts_utc",
        "contact_attempt_started",
        "contact_attempt_started_ts"
      ]),
      readClientTable(sheets, clientSpreadsheetId, TAB_LEAD_LIFECYCLE_LOG, [
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
      ])
    ]);

    const agentsById = buildAgentsById(agentsTable.rows, clientId);
    const remindersByLeadId = groupByLeadId(
      reminderQueueTable.rows.filter(row => sameClient(row, clientId))
    );
    const releasesByLeadId = groupByLeadId(
      releaseQueueTable.rows.filter(row => sameClient(row, clientId))
    );
    const actionLinksByLeadId = groupByLeadId(
      actionLinkMapTable.rows.filter(row => sameClient(row, clientId))
    );
    const lifecycleByLeadId = groupByLeadId(
      lifecycleTable.rows.filter(row => sameClient(row, clientId))
    );

    const nowMs = Date.now();
    const todayKey = localDateKey(new Date(nowMs), clientTimezone);
    const sevenDaysAgoMs = nowMs - 7 * 24 * 60 * 60 * 1000;

    let derivedLeads = leadLogTable.rows
      .filter(row => sameClient(row, clientId))
      .map(row => deriveLeadRecord({
        leadRow: row,
        agentsById,
        reminders: remindersByLeadId.get(String(row.lead_id || "").trim()) || [],
        releases: releasesByLeadId.get(String(row.lead_id || "").trim()) || [],
        actionLinks: actionLinksByLeadId.get(String(row.lead_id || "").trim()) || [],
        lifecycleEvents: lifecycleByLeadId.get(String(row.lead_id || "").trim()) || [],
        clientTimezone,
        todayKey,
        nowMs
      }))
      .filter(record => passesTimeFilter(record, timeFilter, todayKey, sevenDaysAgoMs, clientTimezone))
      .filter(record => passesSummaryFilter(record, summaryFilter));

    const summary = buildSummary(derivedLeads);
    const sortedPublicLeads = sortLeadRecords(derivedLeads);
    const visibleLeads = sortedPublicLeads.slice(0, RECORD_LIMIT);

    console.log("control_tower_data_response_ready", {
      client_id: clientId,
      time_filter: timeFilter,
      summary_filter: summaryFilter || "",
      total_filtered_count: derivedLeads.length,
      visible_record_count: visibleLeads.length,
      event_ts_utc: nowIso()
    });

    return jsonResponse(200, {
      ok: true,
      meta: {
        last_updated_ts_utc: nowIso(),
        time_filter: timeFilter,
        summary_filter: summaryFilter,
        record_limit: RECORD_LIMIT,
        visible_record_count: visibleLeads.length
      },
      summary,
      leads: visibleLeads
    });
  } catch (error) {
    if (error && error.code === "SESSION_REQUIRED") {
      console.log("control_tower_data_denied", {
        reason: error.reason || "SESSION_REQUIRED",
        event_ts_utc: nowIso()
      });

      return unauthorizedResponse();
    }

    console.error("control_tower_data_error", {
      safe_error: "CONTROL_TOWER_DATA_FAILED",
      message: error.message,
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

  const sessionRow = sessionTable.rows.find(row => {
    return String(row.session_id_hash || "") === sessionIdHash;
  });

  if (!sessionRow) {
    throwSessionRequired("SESSION_NOT_FOUND");
  }

  const sessionStatus = upper(sessionRow.status);
  const revokedTsUtc = trimmed(sessionRow.revoked_ts_utc);
  const expiresMs = parseDateMs(sessionRow.expires_ts_utc);
  const nowMs = Date.now();

  if (sessionStatus !== SESSION_STATUS_ACTIVE) {
    throwSessionRequired("SESSION_NOT_ACTIVE");
  }

  if (revokedTsUtc) {
    throwSessionRequired("SESSION_REVOKED");
  }

  if (!expiresMs || expiresMs <= nowMs) {
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

  const contactRow = contactsTable.rows.find(row => {
    return trimmed(row.approved_contact_key) === approvedContactKey;
  });

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

  const clientRow = clientsTable.rows.find(row => {
    return trimmed(row.client_id) === clientId;
  });

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

async function readCentralTable(sheets, tabName, requiredFields) {
  const table = rowsToObjectsByHeader(
    await readCentralRegistryTab(sheets, tabName)
  );

  requireFields(table.headerIndex, requiredFields, tabName);
  return table;
}

function getActionLinkMapSpreadsheetId() {
  return (
    process.env.CONTROL_TOWER_ACTION_LINK_MAP_SPREADSHEET_ID ||
    process.env.EP_ACTION_LINKS_SPREADSHEET_ID ||
    process.env.ACTION_LINK_MAP_SPREADSHEET_ID ||
    DEFAULT_ACTION_LINK_MAP_SPREADSHEET_ID
  );
}

async function readActionLinkMapTable(sheets) {
  const table = rowsToObjectsByHeader(
    await readSheetValues(
      sheets,
      getActionLinkMapSpreadsheetId(),
      `${TAB_ACTION_LINK_MAP}!A1:ZZ10000`
    )
  );

  requireFields(table.headerIndex, [
    "short_code",
    "token",
    "gateway_context",
    "selected_action",
    "lead_id",
    "client_id",
    "assigned_agent_id",
    "expires_ts_utc",
    "is_active",
    "created_ts_utc",
    "used_ts_utc",
    "deactivated_ts_utc",
    "deactivation_reason",
    "trace_id"
  ], TAB_ACTION_LINK_MAP);

  return table;
}

async function readClientTable(sheets, spreadsheetId, tabName, requiredFields) {
  const table = rowsToObjectsByHeader(
    await readSheetValues(sheets, spreadsheetId, `${tabName}!A1:ZZ10000`)
  );

  requireFields(table.headerIndex, requiredFields, tabName);
  return table;
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

function deriveLeadRecord({
  leadRow,
  agentsById,
  reminders,
  releases,
  actionLinks,
  lifecycleEvents,
  clientTimezone,
  todayKey,
  nowMs
}) {
  const leadId = trimmed(leadRow.lead_id);
  const traceId = trimmed(leadRow.trace_id);
  const assignedAgentId = trimmed(leadRow.assigned_agent_id);
  const receivedTsUtc = firstNonBlank(leadRow.created_timestamp, leadRow.assignment_ts_utc);
  const receivedMs = parseDateMs(receivedTsUtc) || 0;
  const contactTsUtc = trimmed(leadRow.contact_timestamp);
  const isClosedRecord = isClosedLead(leadRow);
  const activeReminder = newestActiveReminder(reminders);
  const pendingRelease = newestPendingRelease(releases);
  const latestRelease = newestByDate(releases, "released_ts_utc") || newestByDate(releases, "created_ts_utc");
  const activeActionLink = newestActiveActionLink(actionLinks, nowMs);
  const latestActionLink = activeActionLink || newestByDate(actionLinks, "created_ts_utc");
  const activeLifecycleEvents = lifecycleEvents
    .slice()
    .sort((left, right) => (parseDateMs(right.event_ts_utc) || 0) - (parseDateMs(left.event_ts_utc) || 0));

  const statusPrimary = deriveStatus({
    leadRow,
    isClosedRecord,
    activeReminder,
    pendingRelease
  });

  const nextAction = deriveNextAction({
    statusPrimary,
    activeReminder,
    pendingRelease,
    nowMs,
    clientTimezone
  });

  const riskLabel = deriveRiskLabel({
    statusPrimary,
    nextActionDueTsUtc: nextAction.due_ts_utc,
    nowMs
  });

  const agentName = agentsById.get(assignedAgentId) || "Unassigned";
  const sourceSystem = sanitizedText(leadRow.source_system);
  const sourceDetail = sanitizedText(leadRow.source_detail);

  return {
    _sort: {
      status_priority: STATUS_PRIORITY[statusPrimary] || 99,
      received_ms: receivedMs,
      due_ms: parseDateMs(nextAction.due_ts_utc) || Number.MAX_SAFE_INTEGER
    },
    _filter: {
      status_primary: statusPrimary,
      summary_key: summaryKeyForStatus(statusPrimary),
      is_closed: isClosedRecord,
      closed_today: isClosedRecord && isLocalToday(contactTsUtc || leadRow.last_updated_timestamp, todayKey, clientTimezone),
      received_ms: receivedMs
    },
    lead_id: leadId,
    trace_id: traceId,
    received_ts_utc: receivedTsUtc || null,
    received_display: formatTimeDisplay(receivedTsUtc, clientTimezone),
    lead_name: sanitizedText(leadRow.full_name) || "Lead",
    source: {
      source_system: sourceSystem || null,
      source_detail: sourceDetail || null
    },
    assigned_agent: {
      agent_id: assignedAgentId || null,
      agent_name: agentName
    },
    status: {
      primary: statusPrimary,
      badges: buildBadges({ activeActionLink, pendingRelease, activeReminder, leadRow })
    },
    next_action: nextAction,
    risk: {
      label: riskLabel
    },
    counts: {
      reminder_count: safeNumber(leadRow.deferral_count),
      reassignment_count: safeNumber(leadRow.reassignment_count),
      no_answer_attempt_count: safeNumber(leadRow.no_answer_attempt_count)
    },
    drawer: {
      current_assigned_agent_id: assignedAgentId || null,
      release_time_assigned_agent_id: trimmed(latestRelease?.assigned_agent_id) || null,
      gateway_context: trimmed(latestActionLink?.gateway_context) || null,
      selected_action: trimmed(latestActionLink?.selected_action) || trimmed(leadRow.last_agent_action) || null,
      active_gateway_state: activeActionLink ? "Active" : "None",
      escalation_state: truthy(leadRow.admin_escalation_required) ? "Escalated" : "None",
      final_outcome: trimmed(leadRow.contact_outcome) || null,
      recent_lifecycle_events: activeLifecycleEvents.slice(0, 5).map(event => ({
        event_ts_utc: trimmed(event.event_ts_utc) || null,
        event_label: eventLabel(event),
        event_stage: trimmed(event.event_stage) || null,
        selected_action: trimmed(event.selected_action) || null
      }))
    }
  };
}

function deriveStatus({ leadRow, isClosedRecord, activeReminder, pendingRelease }) {
  if (truthy(leadRow.admin_escalation_required)) {
    return "Escalated to Admin";
  }

  if (truthy(leadRow.reassignment_pending) || upper(leadRow.reassignment_status) === "PENDING") {
    return "Reassignment Pending";
  }

  if (pendingRelease) {
    return "Pending Release";
  }

  if (isClosedRecord) {
    return "Closed";
  }

  if (truthy(leadRow.contact_attempt_started) || upper(leadRow.last_agent_action) === "CALL_NOW") {
    return "Agent Action Started";
  }

  if (safeNumber(leadRow.no_answer_attempt_count) > 0) {
    return "No Answer Follow-up";
  }

  if (activeReminder) {
    return "Reminder Active";
  }

  return "Awaiting Agent Action";
}

function deriveNextAction({ statusPrimary, activeReminder, pendingRelease, nowMs, clientTimezone }) {
  if (statusPrimary === "Closed") {
    return {
      label: "Complete",
      next_action_type: null,
      due_ts_utc: null,
      due_display: null,
      due_in_label: null
    };
  }

  if (pendingRelease) {
    const dueTs = trimmed(pendingRelease.release_due_ts_utc);

    return {
      label: "Release",
      next_action_type: "RELEASE",
      due_ts_utc: dueTs || null,
      due_display: formatTimeDisplay(dueTs, clientTimezone),
      due_in_label: dueInLabel(dueTs, nowMs)
    };
  }

  if (activeReminder) {
    const dueTs = trimmed(activeReminder.next_action_due_ts_utc);

    return {
      label: "Reminder",
      next_action_type: trimmed(activeReminder.next_action_type) || null,
      due_ts_utc: dueTs || null,
      due_display: formatTimeDisplay(dueTs, clientTimezone),
      due_in_label: dueInLabel(dueTs, nowMs)
    };
  }

  if (statusPrimary === "Escalated to Admin") {
    return {
      label: "Admin review",
      next_action_type: "ADMIN_ESCALATION",
      due_ts_utc: null,
      due_display: null,
      due_in_label: null
    };
  }

  if (statusPrimary === "Reassignment Pending") {
    return {
      label: "Reassignment",
      next_action_type: "REASSIGNMENT",
      due_ts_utc: null,
      due_display: null,
      due_in_label: null
    };
  }

  return {
    label: "Agent action",
    next_action_type: "INITIAL_RESPONSE",
    due_ts_utc: null,
    due_display: null,
    due_in_label: null
  };
}

function deriveRiskLabel({ statusPrimary, nextActionDueTsUtc, nowMs }) {
  if (statusPrimary === "Closed") {
    return "Closed";
  }

  if (statusPrimary === "Escalated to Admin") {
    return "Escalated";
  }

  const dueMs = parseDateMs(nextActionDueTsUtc);

  if (dueMs && dueMs < nowMs) {
    return "Overdue";
  }

  if (
    statusPrimary === "Awaiting Agent Action" ||
    statusPrimary === "Reminder Active" ||
    statusPrimary === "No Answer Follow-up" ||
    statusPrimary === "Reassignment Pending"
  ) {
    return "Needs Action";
  }

  return "On Track";
}

function passesTimeFilter(record, timeFilter, todayKey, sevenDaysAgoMs, clientTimezone) {
  if (timeFilter === "active_only") {
    return !record._filter.is_closed;
  }

  if (timeFilter === "last_7_days") {
    return !record._filter.is_closed || record._filter.received_ms >= sevenDaysAgoMs;
  }

  return !record._filter.is_closed || record._filter.closed_today;
}

function passesSummaryFilter(record, summaryFilter) {
  if (!summaryFilter) {
    return true;
  }

  return record._filter.summary_key === summaryFilter;
}

function summaryKeyForStatus(statusPrimary) {
  if (statusPrimary === "Escalated to Admin") {
    return "escalated_to_admin";
  }

  if (statusPrimary === "Reassignment Pending") {
    return "reassignment_active";
  }

  if (statusPrimary === "Reminder Active" || statusPrimary === "No Answer Follow-up") {
    return "reminder_active";
  }

  if (statusPrimary === "Closed") {
    return "closed";
  }

  return "awaiting_agent_action";
}

function buildSummary(records) {
  const summary = {
    awaiting_agent_action: 0,
    reminder_active: 0,
    reassignment_active: 0,
    escalated_to_admin: 0,
    closed_outcome_recorded: 0
  };

  records.forEach(record => {
    const key = record._filter.summary_key;

    if (key === "closed") {
      summary.closed_outcome_recorded += 1;
      return;
    }

    if (Object.prototype.hasOwnProperty.call(summary, key)) {
      summary[key] += 1;
    }
  });

  return summary;
}

function sortLeadRecords(records) {
  return records
    .slice()
    .sort((left, right) => {
      if (left._sort.status_priority !== right._sort.status_priority) {
        return left._sort.status_priority - right._sort.status_priority;
      }

      if (left._sort.due_ms !== right._sort.due_ms) {
        return left._sort.due_ms - right._sort.due_ms;
      }

      return right._sort.received_ms - left._sort.received_ms;
    })
    .map(record => {
      const { _sort, _filter, ...publicRecord } = record;
      return publicRecord;
    });
}

function buildAgentsById(agentRows, clientId) {
  const map = new Map();

  agentRows
    .filter(row => sameClient(row, clientId))
    .forEach(row => {
      const agentId = trimmed(row.agent_id);
      const agentName = sanitizedText(row.agent_name);

      if (agentId && agentName) {
        map.set(agentId, agentName);
      }
    });

  return map;
}

function groupByLeadId(rows) {
  const map = new Map();

  rows.forEach(row => {
    const leadId = trimmed(row.lead_id);

    if (!leadId) {
      return;
    }

    if (!map.has(leadId)) {
      map.set(leadId, []);
    }

    map.get(leadId).push(row);
  });

  return map;
}

function newestActiveReminder(reminders) {
  return reminders
    .filter(row => truthy(row.active_monitoring))
    .sort((left, right) => (parseDateMs(right.next_action_due_ts_utc) || 0) - (parseDateMs(left.next_action_due_ts_utc) || 0))[0] || null;
}

function newestPendingRelease(releases) {
  return releases
    .filter(row => {
      const status = upper(row.status);
      const releasedTs = trimmed(row.released_ts_utc);

      return !releasedTs && ["PENDING", "QUEUED", "ACTIVE", "READY"].includes(status);
    })
    .sort((left, right) => (parseDateMs(left.release_due_ts_utc) || Number.MAX_SAFE_INTEGER) - (parseDateMs(right.release_due_ts_utc) || Number.MAX_SAFE_INTEGER))[0] || null;
}

function newestActiveActionLink(actionLinks, nowMs) {
  return actionLinks
    .filter(row => truthy(row.is_active) && !trimmed(row.used_ts_utc) && !trimmed(row.deactivated_ts_utc))
    .filter(row => {
      const expiresMs = parseDateMs(row.expires_ts_utc);
      return !expiresMs || expiresMs > nowMs;
    })
    .sort((left, right) => (parseDateMs(right.created_ts_utc) || 0) - (parseDateMs(left.created_ts_utc) || 0))[0] || null;
}

function newestByDate(rows, fieldName) {
  return rows
    .slice()
    .sort((left, right) => (parseDateMs(right[fieldName]) || 0) - (parseDateMs(left[fieldName]) || 0))[0] || null;
}

function isClosedLead(leadRow) {
  const leadStatus = upper(leadRow.lead_status);
  const outcome = upper(leadRow.contact_outcome);

  if (truthy(leadRow.contacted_flag)) {
    return true;
  }

  if (outcome && outcome !== "NO_ANSWER") {
    return true;
  }

  return [
    "CLOSED",
    "COMPLETE",
    "COMPLETED",
    "OUTCOME_RECORDED",
    "CONTACTED_SET_APPOINTMENT",
    "CONTACTED_NOT_INTERESTED"
  ].includes(leadStatus);
}

function buildBadges({ activeActionLink, pendingRelease, activeReminder, leadRow }) {
  const badges = [];

  if (activeActionLink) {
    badges.push("Active Gateway");
  }

  if (pendingRelease) {
    badges.push("Release Pending");
  }

  if (activeReminder) {
    badges.push("Reminder Active");
  }

  if (truthy(leadRow.admin_escalation_required)) {
    badges.push("Admin Escalation");
  }

  return badges;
}

function eventLabel(event) {
  const eventType = sanitizedText(event.event_type);
  const eventStage = sanitizedText(event.event_stage);
  const selectedAction = sanitizedText(event.selected_action);

  if (selectedAction) {
    return selectedAction;
  }

  if (eventStage) {
    return eventStage;
  }

  return eventType || "Lifecycle event";
}

function dueInLabel(value, nowMs = Date.now()) {
  const dueMs = parseDateMs(value);

  if (!dueMs) {
    return null;
  }

  const diffMs = dueMs - nowMs;
  const absMinutes = Math.max(0, Math.round(Math.abs(diffMs) / 60000));

  if (diffMs < 0) {
    return `Overdue by ${absMinutes} min`;
  }

  if (absMinutes === 0) {
    return "Due now";
  }

  return `Due in ${absMinutes} min`;
}

function formatTimeDisplay(value, timeZone) {
  const ms = parseDateMs(value);

  if (!ms) {
    return null;
  }

  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || "UTC",
      hour: "numeric",
      minute: "2-digit"
    }).format(new Date(ms));
  } catch (error) {
    return new Date(ms).toISOString();
  }
}

function isLocalToday(value, todayKey, timeZone) {
  const ms = parseDateMs(value);

  if (!ms) {
    return false;
  }

  return localDateKey(new Date(ms), timeZone) === todayKey;
}

function localDateKey(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);

    const year = parts.find(part => part.type === "year")?.value;
    const month = parts.find(part => part.type === "month")?.value;
    const day = parts.find(part => part.type === "day")?.value;

    return `${year}-${month}-${day}`;
  } catch (error) {
    return date.toISOString().slice(0, 10);
  }
}

function normalizeTimeFilter(value) {
  const normalized = String(value || "today").trim().toLowerCase();
  return VALID_TIME_FILTERS.has(normalized) ? normalized : "today";
}

function normalizeSummaryFilter(value) {
  const normalized = String(value || "").trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  return VALID_SUMMARY_FILTERS.has(normalized) ? normalized : null;
}

function sameClient(row, clientId) {
  return trimmed(row.client_id) === clientId;
}

function firstNonBlank(...values) {
  for (const value of values) {
    const text = trimmed(value);

    if (text) {
      return text;
    }
  }

  return "";
}

function safeNumber(value) {
  const parsed = Number(String(value || "").trim());

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return parsed;
}

function truthy(value) {
  const text = String(value || "").trim().toUpperCase();
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

module.exports = {
  handler: exports.handler
};
