"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const view = require("../control-tower-lifecycle-view");

function lead(id, key, agentId, received, ready = true) {
  const labels = {
    ESCALATED_TO_ADMIN: "Escalated to Admin",
    WAITING_FOR_BUSINESS_HOURS: "Waiting for Business Hours",
    NEW: "New",
    REMINDER_SENT: "Reminder Sent",
    WAITING_FOR_OUTCOME_RESPONSE: "Waiting for Outcome Response",
    AT_RISK: "At Risk"
  };
  return {
    lead_id: id,
    lead_name: `Lead ${id}`,
    phone_display: "(713) ***-0142",
    received_ts_utc: received,
    received_display: "Aug 9, 9:00 AM",
    assigned_agent: agentId ? { agent_id: agentId, agent_name: agentId === "A-1" ? "Maya Torres" : "Jordan Lee" } : null,
    lifecycle: { key, label: labels[key], is_active: true, presentation_ready: ready }
  };
}

const agents = [
  {
    agent_id: "A-1",
    agent_name: "Maya Torres",
    initials: "MT",
    photo_url: null,
    avg_response_time: { display: "4m 20s" },
    explicit_reassignments_today: 2
  },
  {
    agent_id: "A-2",
    agent_name: "Jordan Lee",
    initials: "JL",
    photo_url: null,
    avg_response_time: { display: "7m 10s" },
    explicit_reassignments_today: 1
  }
];

test("Lifecycle View remains the default and Agent View remains selectable", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "control-tower.html"), "utf8");
  assert.equal(view.DEFAULT_VIEW, "lifecycle");
  assert.match(html, /data-view="lifecycle" aria-pressed="true">Lifecycle View/);
  assert.match(html, /data-view="agent" aria-pressed="false">Agent View/);
});

test("business-hours Agent View shows Administrator and only real agents with active normal leads", () => {
  const model = view.buildAgentView([
    lead("ESC", "ESCALATED_TO_ADMIN", "A-1", "2026-08-09T08:00:00Z"),
    lead("NEW", "NEW", "A-1", "2026-08-09T09:00:00Z"),
    lead("HELD", "WAITING_FOR_BUSINESS_HOURS", null, "2026-08-09T07:00:00Z")
  ], agents, { is_open: true });

  assert.deepEqual(model.rows.map(row => row.key), ["ADMINISTRATOR", "A-1"]);
  assert.equal(model.waiting_indicator, "Waiting for Business Hours: empty");
  assert.deepEqual(model.rows[1].items.map(item => item.lead_id), ["NEW"]);
  assert.equal(model.rows.some(row => row.key === "A-2"), false);
});

test("outside-hours Agent View suppresses normal agents and retains only populated operational queues", () => {
  const model = view.buildAgentView([
    lead("ESC", "ESCALATED_TO_ADMIN", "A-1", "2026-08-09T08:00:00Z"),
    lead("NEW", "NEW", "A-1", "2026-08-09T09:00:00Z"),
    lead("HELD", "WAITING_FOR_BUSINESS_HOURS", null, "2026-08-09T07:00:00Z")
  ], agents, { is_open: false });

  assert.deepEqual(model.rows.map(row => row.key), ["ADMINISTRATOR", "WAITING_FOR_BUSINESS_HOURS"]);
  assert.equal(model.waiting_indicator, null);
  assert.equal(model.rows.some(row => row.type === "AGENT"), false);
  assert.equal(model.rows.some(row => /service window hold/i.test(row.title)), false);
});

test("Agent View uses contract metrics, initials fallback, and oldest-first cards", () => {
  const model = view.buildAgentView([
    lead("NEWER", "NEW", "A-1", "2026-08-09T10:00:00Z"),
    lead("OLDER", "REMINDER_SENT", "A-1", "2026-08-09T09:00:00Z")
  ], agents, { is_open: true });
  const row = model.rows.find(item => item.key === "A-1");

  assert.equal(row.initials, "MT");
  assert.equal(row.photo_url, null);
  assert.equal(row.avg_response_time, "4m 20s");
  assert.equal(row.explicit_reassignments_today, 2);
  assert.deepEqual(row.items.map(item => item.lead_id), ["OLDER", "NEWER"]);
});

test("Administrator row receives only its special escalated metric", () => {
  const model = view.buildAgentView([
    lead("ESC", "ESCALATED_TO_ADMIN", "A-1", "2026-08-09T08:00:00Z")
  ], agents, { is_open: true });
  const admin = model.rows[0];

  assert.deepEqual(admin.metric, { label: "Escalated Leads", value: 1 });
  assert.equal(Object.hasOwn(admin, "avg_response_time"), false);
  assert.equal(Object.hasOwn(admin, "explicit_reassignments_today"), false);
});

test("Agent cards use masked phone and lifecycle identity without repeating agent ownership", () => {
  const item = lead("NEW", "NEW", "A-1", "2026-08-09T09:00:00Z");
  const card = view.cardPresentation(item, "agent");

  assert.equal(card.phone_display, "(713) ***-0142");
  assert.equal(card.lifecycle_label, "New");
  assert.equal(card.assigned_agent_name, null);
  assert.equal(view.cardPresentation(item, "lifecycle").assigned_agent_name, "Maya Torres");
});

test("presentation-not-ready records remain hidden and No Answer fresh-cycle New remains under the authoritative agent", () => {
  const model = view.buildAgentView([
    lead("PENDING", "NEW", "A-2", "2026-08-09T08:00:00Z", false),
    lead("NO-ANSWER-FRESH", "NEW", "A-1", "2026-08-09T09:00:00Z")
  ], agents, { is_open: true });

  assert.deepEqual(model.rows.map(row => row.key), ["A-1"]);
  assert.deepEqual(model.rows[0].items.map(item => item.lead_id), ["NO-ANSWER-FRESH"]);
  assert.equal(model.rows.flatMap(row => row.items).some(item => item.lead_id === "PENDING"), false);
});

test("Agent View does not add historical filters or a service-window control", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "control-tower.html"), "utf8");
  assert.equal(html.includes("data-window="), false);
  assert.equal(html.includes("Last 7 Days"), false);
  assert.equal(html.includes("Last 30 Days"), false);
  assert.equal(html.includes("data-time-filter"), false);
});
