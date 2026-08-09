"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const view = require("../control-tower-lifecycle-view");

function lead(id, key, received, ready = true) {
  return {
    lead_id: id,
    received_ts_utc: received,
    lifecycle: { key, is_active: true, presentation_ready: ready }
  };
}

test("uses the approved lifecycle row order with escalation first and no Resolved row", () => {
  assert.deepEqual(view.ROWS.map(row => row.key), [
    "ESCALATED_TO_ADMIN",
    "WAITING_FOR_BUSINESS_HOURS",
    "NEW",
    "REMINDER_SENT",
    "WAITING_FOR_OUTCOME_RESPONSE",
    "AT_RISK"
  ]);
  assert.equal(view.ROWS.some(row => row.key === "RESOLVED"), false);
  assert.equal(view.ROWS[0].title, "Exceptions / Escalated-to-Admin");
});

test("excludes presentation-not-ready and resolved records while preserving No Answer-derived New", () => {
  const rows = view.buildLifecycleRows([
    lead("L-PENDING", null, "2026-08-09T13:00:00Z", false),
    lead("L-RESOLVED", "RESOLVED", "2026-08-09T13:01:00Z"),
    lead("L-NO-ANSWER", "NEW", "2026-08-09T13:02:00Z")
  ], { is_open: false });
  assert.deepEqual(rows.flatMap(row => row.items.map(item => item.lead_id)), ["L-NO-ANSWER"]);
  assert.equal(rows.find(row => row.key === "NEW").items[0].lead_id, "L-NO-ANSWER");
});

test("Waiting for Business Hours is empty while open and populated while closed", () => {
  const held = lead("L-HELD", "WAITING_FOR_BUSINESS_HOURS", "2026-08-09T05:00:00Z");
  const open = view.buildLifecycleRows([held], { is_open: true });
  const closed = view.buildLifecycleRows([held], { is_open: false });
  assert.equal(open[1].items.length, 0);
  assert.match(open[1].empty_text, /Business hours are open/);
  assert.deepEqual(closed[1].items.map(item => item.lead_id), ["L-HELD"]);
});

test("orders cards oldest first and maps the approved card classes", () => {
  const rows = view.buildLifecycleRows([
    lead("L-NEWER", "NEW", "2026-08-09T15:00:00Z"),
    lead("L-OLDER", "NEW", "2026-08-09T14:00:00Z")
  ], { is_open: true });
  assert.deepEqual(rows[2].items.map(item => item.lead_id), ["L-OLDER", "L-NEWER"]);
  assert.equal(view.cardClassFor("NEW"), "lead-card lifecycle-new");
  assert.equal(view.cardClassFor("WAITING_FOR_BUSINESS_HOURS"), "lead-card lifecycle-waiting-for-business-hours");
  assert.deepEqual(Object.fromEntries(view.ROWS.map(row => [row.key, row.color])), {
    ESCALATED_TO_ADMIN: "#FFD6D6",
    WAITING_FOR_BUSINESS_HOURS: "#1F3A5F",
    NEW: "#BFFBB6",
    REMINDER_SENT: "#D9EEFF",
    WAITING_FOR_OUTCOME_RESPONSE: "#E8E0FF",
    AT_RISK: "#FFF0B8"
  });
});

test("renders operational summary values directly from the contract", () => {
  assert.deepEqual(view.summaryItems({
    active_leads: 9,
    at_risk: 2,
    escalated_to_admin: 1,
    avg_response_time: { display: "3m 30s" }
  }), [
    ["Active Leads", 9],
    ["At Risk", 2],
    ["Escalated to Admin", 1],
    ["Avg. Response Time", "3m 30s"]
  ]);
});

test("carousel arrows appear only when further scrolling is possible", () => {
  assert.deepEqual(view.carouselState({ scrollLeft: 0, clientWidth: 600, scrollWidth: 1000 }), { show_left: false, show_right: true });
  assert.deepEqual(view.carouselState({ scrollLeft: 200, clientWidth: 600, scrollWidth: 1000 }), { show_left: true, show_right: true });
  assert.deepEqual(view.carouselState({ scrollLeft: 400, clientWidth: 600, scrollWidth: 1000 }), { show_left: true, show_right: false });
  assert.deepEqual(view.carouselState({ scrollLeft: 0, clientWidth: 600, scrollWidth: 600 }), { show_left: false, show_right: false });
});

test("operational HTML contains no historical time filters", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "control-tower.html"), "utf8");
  assert.equal(html.includes("data-time-filter"), false);
  assert.equal(html.includes("Last 7 Days"), false);
  assert.equal(html.includes("Last 30 Days"), false);
  assert.equal(html.includes("Active Only"), false);
});
