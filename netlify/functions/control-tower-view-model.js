"use strict";

const ACTIVE_LIFECYCLE = Object.freeze({
  ESCALATED_TO_ADMIN: { label: "Escalated to Admin", order: 1, color: "#FFD6D6" },
  WAITING_FOR_BUSINESS_HOURS: { label: "Waiting for Business Hours", order: 2, color: "#1F3A5F" },
  NEW: { label: "New", order: 3, color: "#BFFBB6" },
  REMINDER_SENT: { label: "Reminder Sent", order: 4, color: "#D9EEFF" },
  WAITING_FOR_OUTCOME_RESPONSE: { label: "Waiting for Outcome Response", order: 5, color: "#E8E0FF" },
  AT_RISK: { label: "At Risk", order: 6, color: "#FFF0B8" }
});

const RESOLVED_PRESENTATION = Object.freeze({
  key: "RESOLVED",
  label: "Resolved",
  order: 99,
  color: "#E9EDF2",
  is_active: false,
  presentation_ready: true,
  presentation_reason: null
});

const QUALIFYING_RESPONSE_ACTIONS = new Set([
  "CALL_NOW",
  "REMIND_ME_5_MIN",
  "REASSIGN"
]);

const EXPLICIT_REASSIGN_ACTIONS = new Set([
  "REASSIGN",
  "OUTCOME_REASSIGN"
]);

const ASSIGNMENT_START_EVENT_TYPES = new Set([
  "LEAD_RELEASED",
  "LEAD_REASSIGNED"
]);

function deriveLifecyclePresentation({
  leadRow,
  activeReminder,
  pendingRelease,
  isClosed,
  nowMs = Date.now()
}) {
  if (truthy(leadRow.admin_escalation_required)) {
    return activeLifecycle("ESCALATED_TO_ADMIN");
  }

  if (truthy(leadRow.reassignment_pending) || upper(leadRow.reassignment_status) === "PENDING") {
    return {
      key: null,
      label: null,
      order: null,
      color: null,
      is_active: true,
      presentation_ready: false,
      presentation_reason: "AWAITING_AUTHORITATIVE_REASSIGNMENT"
    };
  }

  if (pendingRelease) {
    return activeLifecycle("WAITING_FOR_BUSINESS_HOURS");
  }

  if (isClosed) {
    return { ...RESOLVED_PRESENTATION };
  }

  const reminderType = upper(activeReminder?.next_action_type);
  // NO_ANSWER supersedes contact-attempt remnants and starts a fresh initial
  // response presentation cycle for the same authoritative assignment.
  if (safeNumber(leadRow.no_answer_attempt_count) > 0 && reminderType === "REMINDER_1") {
    return activeLifecycle("NEW");
  }

  if (
    truthy(leadRow.contact_attempt_started) ||
    upper(leadRow.last_agent_action) === "CALL_NOW" ||
    reminderType === "OUTCOME_FOLLOW_UP"
  ) {
    return activeLifecycle("WAITING_FOR_OUTCOME_RESPONSE");
  }

  if (["REMINDER_3", "ESCALATION"].includes(reminderType)) {
    return activeLifecycle("AT_RISK");
  }

  if (reminderType === "REMINDER_2") {
    return activeLifecycle("REMINDER_SENT");
  }

  // A due REMINDER_1 is still the initial-response cycle until the reminder
  // handler advances the durable queue row to REMINDER_2.
  void nowMs;
  return activeLifecycle("NEW");
}

function activeLifecycle(key) {
  return {
    key,
    ...ACTIVE_LIFECYCLE[key],
    is_active: true,
    presentation_ready: true,
    presentation_reason: null
  };
}

function getServiceWindowStatus(client, now = new Date()) {
  const timezone = trimmed(client.primary_timezone);
  const businessStart = trimmed(client.business_day_start_time);
  const businessEnd = trimmed(client.business_day_end_time);
  const activeDays = upper(client.business_days_active);
  const releaseMode = upper(client.off_hours_release_mode);

  if (!timezone || !businessStart || !businessEnd || !activeDays) {
    throw new Error("Client service-window configuration is incomplete.");
  }

  const local = getLocalDateTimeParts(now, timezone);
  const dayToken = upper(local.weekday).slice(0, 3);
  const activeDayTokens = activeDays.split("|").map(upper).filter(Boolean);
  const currentMinutes = local.hour * 60 + local.minute;
  const startMinutes = parseBusinessTimeToMinutes(businessStart);
  const endMinutes = parseBusinessTimeToMinutes(businessEnd);
  const withinWindow = startMinutes <= endMinutes
    ? currentMinutes >= startMinutes && currentMinutes < endMinutes
    : currentMinutes >= startMinutes || currentMinutes < endMinutes;

  return {
    is_open: activeDayTokens.includes(dayToken) && withinWindow,
    release_mode: releaseMode || null,
    timezone,
    local_day: dayToken,
    local_time: `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`,
    business_day_start_time: businessStart,
    business_day_end_time: businessEnd,
    business_days_active: activeDays
  };
}

function getLocalDateTimeParts(date, timezone) {
  const values = {};
  new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date).forEach(part => {
    values[part.type] = part.value;
  });

  return {
    weekday: values.weekday,
    hour: Number(values.hour),
    minute: Number(values.minute)
  };
}

function parseBusinessTimeToMinutes(value) {
  const match = trimmed(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid business time format: ${value}`);
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid business time value: ${value}`);
  }

  return hour * 60 + minute;
}

function buildResponseTimeSamples({ leadRows, lifecycleEvents, timeZone, todayKey }) {
  const rowsByLead = new Map(leadRows.map(row => [trimmed(row.lead_id), row]));
  const eventsByLead = groupByLeadId(lifecycleEvents);
  const samples = [];

  rowsByLead.forEach((leadRow, leadId) => {
    const events = (eventsByLead.get(leadId) || [])
      .slice()
      .sort((a, b) => dateMs(a.event_ts_utc) - dateMs(b.event_ts_utc));
    const assignmentStarts = events
      .filter(event => ASSIGNMENT_START_EVENT_TYPES.has(upper(event.event_type)))
      .filter(event => dateMs(event.event_ts_utc) && trimmed(event.assigned_agent_id))
      .map(event => ({
        start_ts_utc: trimmed(event.event_ts_utc),
        start_ms: dateMs(event.event_ts_utc),
        agent_id: trimmed(event.assigned_agent_id),
        source: upper(event.event_type)
      }));

    const seenCycles = new Set();
    events
      .filter(isQualifyingResponseEvent)
      .forEach(event => {
        const actionMs = dateMs(event.event_ts_utc);
        const agentId = trimmed(event.assigned_agent_id);
        if (!actionMs || !agentId) {
          return;
        }

        let start = assignmentStarts
          .filter(candidate => candidate.agent_id === agentId && candidate.start_ms <= actionMs)
          .sort((a, b) => b.start_ms - a.start_ms)[0] || null;

        if (!start) {
          start = initialAssignmentStart(leadRow, assignmentStarts, agentId, actionMs);
        }

        if (!start || localDateKey(new Date(start.start_ms), timeZone) !== todayKey) {
          return;
        }

        const cycleKey = `${leadId}|${agentId}|${start.start_ts_utc}`;
        if (seenCycles.has(cycleKey)) {
          return;
        }
        seenCycles.add(cycleKey);

        samples.push({
          lead_id: leadId,
          agent_id: agentId,
          assignment_cycle_start_ts_utc: start.start_ts_utc,
          assignment_cycle_start_source: start.source,
          response_action: upper(event.selected_action),
          response_ts_utc: trimmed(event.event_ts_utc),
          elapsed_ms: Math.max(0, actionMs - start.start_ms)
        });
      });
  });

  return samples.sort((a, b) => dateMs(a.assignment_cycle_start_ts_utc) - dateMs(b.assignment_cycle_start_ts_utc));
}

function initialAssignmentStart(leadRow, assignmentStarts, agentId, actionMs) {
  const hasPriorAssignmentEvent = assignmentStarts.some(candidate => candidate.start_ms <= actionMs);
  if (hasPriorAssignmentEvent) {
    return null;
  }

  const currentAgentId = trimmed(leadRow.assigned_agent_id);
  const currentStart = firstNonBlank(leadRow.assignment_ts_utc, leadRow.assigned_timestamp);
  const currentStartMs = dateMs(currentStart);
  if (currentAgentId === agentId && currentStartMs && currentStartMs <= actionMs) {
    return {
      start_ts_utc: currentStart,
      start_ms: currentStartMs,
      agent_id: agentId,
      source: "LEADLOG_ASSIGNMENT_TS_UTC"
    };
  }

  // The current Production in-hours intake writes created_timestamp and the
  // first assignment timestamps from the same nowUtc value. After a later
  // reassignment overwrites current assignment fields, created_timestamp is
  // the durable first-cycle start. Held leads instead have LEAD_RELEASED.
  const created = trimmed(leadRow.created_timestamp);
  const createdMs = dateMs(created);
  if (createdMs && createdMs <= actionMs) {
    return {
      start_ts_utc: created,
      start_ms: createdMs,
      agent_id: agentId,
      source: "LEADLOG_CREATED_TIMESTAMP_INITIAL_ASSIGNMENT"
    };
  }

  return null;
}

function isQualifyingResponseEvent(event) {
  return (
    upper(event.gateway_context) === "INITIAL_RESPONSE_GATEWAY" &&
    normalizedStage(event.event_stage) === "INITIAL_RESPONSE" &&
    QUALIFYING_RESPONSE_ACTIONS.has(upper(event.selected_action))
  );
}

function aggregateResponseTimes(samples) {
  const byAgent = new Map();
  samples.forEach(sample => {
    if (!byAgent.has(sample.agent_id)) {
      byAgent.set(sample.agent_id, []);
    }
    byAgent.get(sample.agent_id).push(sample.elapsed_ms);
  });

  const perAgent = new Map();
  byAgent.forEach((values, agentId) => {
    perAgent.set(agentId, metricFromValues(values));
  });

  return {
    team: metricFromValues(samples.map(sample => sample.elapsed_ms)),
    per_agent: perAgent
  };
}

function buildExplicitReassignmentCounts(lifecycleEvents, timeZone, todayKey) {
  const counts = new Map();
  lifecycleEvents.forEach(event => {
    const action = upper(event.selected_action);
    const agentId = trimmed(event.assigned_agent_id);
    const eventMs = dateMs(event.event_ts_utc);
    const expectedGateway = action === "REASSIGN"
      ? "INITIAL_RESPONSE_GATEWAY"
      : "OUTCOME_GATEWAY";
    const expectedStage = action === "REASSIGN"
      ? "INITIAL_RESPONSE"
      : "OUTCOME_RESPONSE";

    if (
      !EXPLICIT_REASSIGN_ACTIONS.has(action) ||
      upper(event.gateway_context) !== expectedGateway ||
      normalizedStage(event.event_stage) !== expectedStage ||
      !agentId ||
      !eventMs ||
      localDateKey(new Date(eventMs), timeZone) !== todayKey
    ) {
      return;
    }

    counts.set(agentId, (counts.get(agentId) || 0) + 1);
  });
  return counts;
}

function metricFromValues(values) {
  if (!values.length) {
    return { average_ms: null, completed_cycle_count: 0 };
  }
  return {
    average_ms: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    completed_cycle_count: values.length
  };
}

function initialsForName(name) {
  const words = trimmed(name).split(/\s+/).filter(Boolean);
  if (!words.length) {
    return "--";
  }
  return `${words[0][0]}${words.length > 1 ? words[words.length - 1][0] : ""}`.toUpperCase();
}

function localDateKey(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = type => parts.find(part => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function groupByLeadId(rows) {
  const map = new Map();
  rows.forEach(row => {
    const leadId = trimmed(row.lead_id);
    if (!leadId) return;
    if (!map.has(leadId)) map.set(leadId, []);
    map.get(leadId).push(row);
  });
  return map;
}

function dateMs(value) {
  const parsed = Date.parse(trimmed(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeNumber(value) {
  const number = Number(trimmed(value));
  return Number.isFinite(number) ? number : 0;
}

function truthy(value) {
  return ["TRUE", "YES", "Y", "1"].includes(upper(value));
}

function upper(value) {
  return trimmed(value).toUpperCase();
}

function normalizedStage(value) {
  return upper(value).replace(/[^A-Z0-9]+/g, "_");
}

function trimmed(value) {
  return String(value || "").trim();
}

function firstNonBlank(...values) {
  return values.map(trimmed).find(Boolean) || "";
}

module.exports = {
  ACTIVE_LIFECYCLE,
  QUALIFYING_RESPONSE_ACTIONS,
  aggregateResponseTimes,
  buildExplicitReassignmentCounts,
  buildResponseTimeSamples,
  deriveLifecyclePresentation,
  getServiceWindowStatus,
  initialsForName,
  localDateKey
};
