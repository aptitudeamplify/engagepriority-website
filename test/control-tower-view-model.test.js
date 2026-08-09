"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  aggregateResponseTimes,
  buildExplicitReassignmentCounts,
  buildResponseTimeSamples,
  deriveLifecyclePresentation,
  getServiceWindowStatus,
  initialsForName
} = require("../netlify/functions/control-tower-view-model");

const TIME_ZONE = "America/Chicago";
const TODAY = "2026-08-09";

function presentation(overrides = {}) {
  return deriveLifecyclePresentation({
    leadRow: {},
    activeReminder: null,
    pendingRelease: null,
    isClosed: false,
    nowMs: Date.parse("2026-08-09T15:00:00Z"),
    ...overrides
  });
}

test("maps all approved active lifecycle rows without adding backend transients", () => {
  assert.equal(presentation({ leadRow: { admin_escalation_required: "TRUE" } }).key, "ESCALATED_TO_ADMIN");
  assert.equal(presentation({ pendingRelease: { status: "PENDING" } }).key, "WAITING_FOR_BUSINESS_HOURS");
  assert.equal(presentation({ activeReminder: { next_action_type: "REMINDER_1" } }).key, "NEW");
  assert.equal(presentation({ activeReminder: { next_action_type: "REMINDER_2" } }).key, "REMINDER_SENT");
  assert.equal(presentation({ activeReminder: { next_action_type: "OUTCOME_FOLLOW_UP" } }).key, "WAITING_FOR_OUTCOME_RESPONSE");
  assert.equal(presentation({ activeReminder: { next_action_type: "REMINDER_3" } }).key, "AT_RISK");

  const pending = presentation({ leadRow: { reassignment_pending: "TRUE", assigned_agent_id: "A-OLD" } });
  assert.equal(pending.key, null);
  assert.equal(pending.presentation_ready, false);
  assert.equal(pending.presentation_reason, "AWAITING_AUTHORITATIVE_REASSIGNMENT");
});

test("maps No Answer fresh initial-response work to New", () => {
  const result = presentation({
    leadRow: { no_answer_attempt_count: "1", contact_attempt_started: "TRUE", last_agent_action: "CALL_NOW" },
    activeReminder: { next_action_type: "REMINDER_1" }
  });
  assert.equal(result.label, "New");
});

test("waits through reassignment pending and renders New only after replacement authority", () => {
  const pendingRow = { reassignment_pending: "TRUE", assigned_agent_id: "A-OLD" };
  const pending = presentation({ leadRow: pendingRow });
  assert.equal(pending.presentation_ready, false);
  assert.equal(pending.label, null);
  assert.equal(pendingRow.assigned_agent_id, "A-OLD");

  const authoritativeReplacementRow = {
    reassignment_pending: "FALSE",
    reassignment_status: "NONE",
    assigned_agent_id: "A-NEW",
    assignment_ts_utc: "2026-08-09T15:00:00Z"
  };
  const replacement = presentation({
    leadRow: authoritativeReplacementRow,
    activeReminder: { next_action_type: "REMINDER_1" }
  });
  assert.equal(replacement.label, "New");
  assert.equal(authoritativeReplacementRow.assigned_agent_id, "A-NEW");
});

test("derives service-window open and closed state in the client timezone", () => {
  const client = {
    primary_timezone: TIME_ZONE,
    business_day_start_time: "08:00",
    business_day_end_time: "17:00",
    business_days_active: "MON|TUE|WED|THU|FRI",
    off_hours_release_mode: "NEXT_OPEN"
  };

  assert.equal(getServiceWindowStatus(client, new Date("2026-08-10T15:00:00Z")).is_open, true);
  assert.equal(getServiceWindowStatus(client, new Date("2026-08-10T23:00:00Z")).is_open, false);
  assert.equal(getServiceWindowStatus(client, new Date("2026-08-09T15:00:00Z")).is_open, false);
});

test("includes Waiting for Business Hours only from durable pending-release evidence", () => {
  assert.equal(presentation({ pendingRelease: { status: "PENDING" } }).label, "Waiting for Business Hours");
  assert.equal(presentation().label, "New");
});

test("uses initials fallback and never invents a photo", () => {
  assert.equal(initialsForName("Maya Torres"), "MT");
  assert.equal(initialsForName("Prince"), "P");
});

test("attributes first qualifying responses to separate reassignment cycles", () => {
  const leadRows = [{
    lead_id: "L-1",
    client_id: "C-1",
    created_timestamp: "2026-08-09T14:00:00Z",
    assigned_agent_id: "A-2",
    assigned_timestamp: "2026-08-09T14:10:00Z",
    assignment_ts_utc: "2026-08-09T14:10:00Z"
  }];
  const lifecycleEvents = [
    { lead_id: "L-1", event_ts_utc: "2026-08-09T14:05:00Z", event_stage: "INITIAL RESPONSE", gateway_context: "INITIAL_RESPONSE_GATEWAY", assigned_agent_id: "A-1", selected_action: "REASSIGN" },
    { lead_id: "L-1", event_ts_utc: "2026-08-09T14:10:00Z", event_type: "LEAD_REASSIGNED", event_stage: "REASSIGNMENT", gateway_context: "INITIAL_RESPONSE_GATEWAY", assigned_agent_id: "A-2", selected_action: "REASSIGN" },
    { lead_id: "L-1", event_ts_utc: "2026-08-09T14:12:00Z", event_stage: "INITIAL RESPONSE", gateway_context: "INITIAL_RESPONSE_GATEWAY", assigned_agent_id: "A-2", selected_action: "CALL_NOW" },
    { lead_id: "L-1", event_ts_utc: "2026-08-09T14:13:00Z", event_stage: "INITIAL RESPONSE", gateway_context: "INITIAL_RESPONSE_GATEWAY", assigned_agent_id: "A-2", selected_action: "REMIND_ME_5_MIN" }
  ];

  const samples = buildResponseTimeSamples({ leadRows, lifecycleEvents, timeZone: TIME_ZONE, todayKey: TODAY });
  assert.deepEqual(samples.map(sample => [sample.agent_id, sample.response_action, sample.elapsed_ms]), [
    ["A-1", "REASSIGN", 300000],
    ["A-2", "CALL_NOW", 120000]
  ]);

  const aggregate = aggregateResponseTimes(samples);
  assert.deepEqual(aggregate.per_agent.get("A-1"), { average_ms: 300000, completed_cycle_count: 1 });
  assert.deepEqual(aggregate.per_agent.get("A-2"), { average_ms: 120000, completed_cycle_count: 1 });
  assert.deepEqual(aggregate.team, { average_ms: 210000, completed_cycle_count: 2 });
});

test("excludes unresolved cycles, non-qualifying actions, and cycles that did not start today", () => {
  const leadRows = [
    { lead_id: "L-UNRESOLVED", created_timestamp: "2026-08-09T15:00:00Z", assigned_agent_id: "A-1", assignment_ts_utc: "2026-08-09T15:00:00Z" },
    { lead_id: "L-YESTERDAY", created_timestamp: "2026-08-08T15:00:00Z", assigned_agent_id: "A-1", assignment_ts_utc: "2026-08-08T15:00:00Z" },
    { lead_id: "L-SYSTEM", created_timestamp: "2026-08-09T16:00:00Z", assigned_agent_id: "A-2", assignment_ts_utc: "2026-08-09T16:00:00Z" }
  ];
  const lifecycleEvents = [
    { lead_id: "L-YESTERDAY", event_ts_utc: "2026-08-09T14:00:00Z", event_stage: "INITIAL RESPONSE", gateway_context: "INITIAL_RESPONSE_GATEWAY", assigned_agent_id: "A-1", selected_action: "CALL_NOW" },
    { lead_id: "L-SYSTEM", event_ts_utc: "2026-08-09T16:01:00Z", event_stage: "REMINDER", gateway_context: "INITIAL_RESPONSE_GATEWAY", assigned_agent_id: "A-2", selected_action: "REMINDER_SENT" }
  ];
  assert.deepEqual(buildResponseTimeSamples({ leadRows, lifecycleEvents, timeZone: TIME_ZONE, todayKey: TODAY }), []);
});

test("counts only durable agent-selected reassignments and excludes processor automation", () => {
  const events = [
    { event_ts_utc: "2026-08-09T14:00:00Z", event_stage: "INITIAL RESPONSE", gateway_context: "INITIAL_RESPONSE_GATEWAY", assigned_agent_id: "A-1", selected_action: "REASSIGN" },
    { event_ts_utc: "2026-08-09T14:01:00Z", event_stage: "REASSIGNMENT", gateway_context: "INITIAL_RESPONSE_GATEWAY", assigned_agent_id: "A-2", selected_action: "REASSIGN" },
    { event_ts_utc: "2026-08-09T15:00:00Z", event_stage: "OUTCOME RESPONSE", gateway_context: "OUTCOME_GATEWAY", assigned_agent_id: "A-1", selected_action: "OUTCOME_REASSIGN" },
    { event_ts_utc: "2026-08-09T16:00:00Z", event_stage: "REASSIGNMENT", gateway_context: "", assigned_agent_id: "A-1", selected_action: "" }
  ];
  const counts = buildExplicitReassignmentCounts(events, TIME_ZONE, TODAY);
  assert.equal(counts.get("A-1"), 2);
  assert.equal(counts.has("A-2"), false);
});
