"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const view = require("../control-tower-lifecycle-view");

const html = fs.readFileSync(path.join(__dirname, "..", "control-tower.html"), "utf8");

function lead(id, key, agentId, received, ready = true) {
  return {
    lead_id: id,
    lead_name: `Lead ${id}`,
    phone_display: "(713) ***-0142",
    received_ts_utc: received,
    assigned_agent: agentId ? { agent_id: agentId, agent_name: "Maya Torres" } : null,
    lifecycle: { key, label: key === "NEW" ? "New" : key, is_active: true, presentation_ready: ready }
  };
}

const agents = [{
  agent_id: "A-1",
  agent_name: "Maya Torres",
  initials: "MT",
  photo_url: null,
  avg_response_time: { display: "4m 20s" },
  explicit_reassignments_today: 2
}];

test("Lifecycle remains default and Side-by-Side is the third selectable view", () => {
  assert.equal(view.DEFAULT_VIEW, "lifecycle");
  assert.match(html, /data-view="lifecycle" aria-pressed="true">Lifecycle View/);
  assert.match(html, /data-view="agent" aria-pressed="false">Agent View/);
  assert.match(html, /data-view="side-by-side" aria-pressed="false">Side-by-Side View/);
  assert.match(html, /\["agent", "side-by-side"\]\.includes\(button\.dataset\.view\)/);
});

test("Side-by-Side composes both accepted models from one active dataset", () => {
  const leads = [
    lead("NEW", "NEW", "A-1", "2026-08-09T09:00:00Z"),
    lead("ESC", "ESCALATED_TO_ADMIN", "A-1", "2026-08-09T08:00:00Z")
  ];
  const model = view.buildSideBySideView(leads, agents, { is_open: true });

  assert.deepEqual(model.lifecycle_rows.flatMap(row => row.items).map(item => item.lead_id), ["ESC", "NEW"]);
  assert.deepEqual(model.agent_view.rows.flatMap(row => row.items).map(item => item.lead_id), ["ESC", "NEW"]);
  assert.equal(model.lifecycle_rows.find(row => row.key === "NEW").items[0], leads[0]);
  assert.equal(model.agent_view.rows.find(row => row.key === "A-1").items[0], leads[0]);
});

test("Lifecycle pane preserves row order and active-record exclusions", () => {
  const model = view.buildSideBySideView([
    lead("PENDING", "NEW", "A-1", "2026-08-09T07:00:00Z", false),
    lead("RESOLVED", "RESOLVED", "A-1", "2026-08-09T08:00:00Z"),
    lead("NO-ANSWER-FRESH", "NEW", "A-1", "2026-08-09T09:00:00Z")
  ], agents, { is_open: true });

  assert.deepEqual(model.lifecycle_rows.map(row => row.key), [
    "ESCALATED_TO_ADMIN",
    "WAITING_FOR_BUSINESS_HOURS",
    "NEW",
    "REMINDER_SENT",
    "WAITING_FOR_OUTCOME_RESPONSE",
    "AT_RISK"
  ]);
  assert.deepEqual(model.lifecycle_rows.flatMap(row => row.items).map(item => item.lead_id), ["NO-ANSWER-FRESH"]);
  assert.deepEqual(model.agent_view.rows.flatMap(row => row.items).map(item => item.lead_id), ["NO-ANSWER-FRESH"]);
});

test("Agent pane preserves business-hours behavior", () => {
  const model = view.buildSideBySideView([
    lead("ESC", "ESCALATED_TO_ADMIN", "A-1", "2026-08-09T08:00:00Z"),
    lead("NEW", "NEW", "A-1", "2026-08-09T09:00:00Z"),
    lead("HELD", "WAITING_FOR_BUSINESS_HOURS", null, "2026-08-09T07:00:00Z")
  ], agents, { is_open: true });

  assert.deepEqual(model.agent_view.rows.map(row => row.key), ["ADMINISTRATOR", "A-1"]);
  assert.equal(model.agent_view.waiting_indicator, "Waiting for Business Hours: empty");
});

test("Agent pane preserves outside-hours behavior", () => {
  const model = view.buildSideBySideView([
    lead("ESC", "ESCALATED_TO_ADMIN", "A-1", "2026-08-09T08:00:00Z"),
    lead("NEW", "NEW", "A-1", "2026-08-09T09:00:00Z"),
    lead("HELD", "WAITING_FOR_BUSINESS_HOURS", null, "2026-08-09T07:00:00Z")
  ], agents, { is_open: false });

  assert.deepEqual(model.agent_view.rows.map(row => row.key), ["ADMINISTRATOR", "WAITING_FOR_BUSINESS_HOURS"]);
  assert.equal(model.agent_view.rows.some(row => row.type === "AGENT"), false);
});

test("Side-by-Side renders semantic panes and reuses independent accessible carousels", () => {
  assert.match(html, /perspectivePane\("sideLifecyclePane", "Lifecycle perspective"/);
  assert.match(html, /perspectivePane\("sideAgentPane", "Agent perspective"/);
  assert.match(html, /aria-labelledby/);
  assert.match(html, /data-carousel/);
  assert.match(html, /setAttribute\("aria-label", `Scroll \$\{direction\}`\)/);
});

test("intrinsic pane sizing targets three readable cards and stacks only when pane width is insufficient", () => {
  assert.match(html, /grid-template-columns: repeat\(auto-fit,minmax\(min\(100%,560px\),1fr\)\)/);
  assert.match(html, /\.perspective-pane \.cards-track \{ grid-auto-columns: clamp\(180px,31%,225px\); \}/);
  assert.match(html, /\.side-by-side \{[^}]*align-items: start/);
  assert.equal(/@media[^{}]*side-by-side/.test(html), false);
});

test("Side-by-Side introduces no historical filters or independent data fetch", () => {
  assert.equal(html.includes("Last 7 Days"), false);
  assert.equal(html.includes("Last 30 Days"), false);
  assert.equal(html.includes("data-time-filter"), false);
  assert.equal((html.match(/fetch\("\/\.netlify\/functions\/control-tower-data"/g) || []).length, 1);
  assert.match(html, /renderSideBySide\(currentLeads, currentAgents, currentServiceWindow\)/);
});
