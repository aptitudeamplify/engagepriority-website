"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "control-tower.html"), "utf8");

test("whole-card interaction opens one shared lead workspace from every accepted view", () => {
  assert.equal((html.match(/function openLeadWorkspace\(/g) || []).length, 1);
  assert.match(html, /card\.addEventListener\("click", \(\) => openLeadWorkspace\(lead\.lead_id, card\)\)/);
  assert.match(html, /row\.items\.map\(lead => renderLeadCard\(lead, row, "agent"\)\)/);
  assert.match(html, /row\.items\.map\(lead => renderLeadCard\(lead, row\)\)/);
  assert.match(html, /renderLifecycleModel\(lifecycleStack, model\.lifecycle_rows\)/);
  assert.match(html, /renderAgentModel\(agentStack, model\.agent_view\)/);
});

test("right-side drawer presentation is replaced by a centered desktop workspace", () => {
  assert.match(html, /\.workspace-backdrop \{[^}]*place-items: center/);
  assert.match(html, /\.lead-workspace \{[^}]*width: min\(82vw,1280px\)[^}]*max-height: 84vh[^}]*border-radius: 30px/);
  assert.equal(html.includes("justify-content: flex-end; background: rgba(2,6,23,.58)"), false);
  assert.equal(html.includes("openLeadDrawer"), false);
  assert.equal(html.includes("detailDrawerOverlay"), false);
});

test("workspace has dialog semantics, clear title, focus containment, Escape, Close, and focus return", () => {
  assert.match(html, /id="leadWorkspaceOverlay"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="workspaceLeadName"/);
  assert.match(html, /id="workspaceCloseButton"[^>]*aria-label="Close lead workspace"/);
  assert.match(html, /document\.querySelector\("main"\)\.inert = true/);
  assert.match(html, /addEventListener\("keydown", trapWorkspaceFocus\)/);
  assert.match(html, /event\.key === "Escape"[^\n]*closeLeadWorkspace\(\)/);
  assert.match(html, /returnTarget\?\.isConnected[^\n]*returnTarget\.focus\(\)/);
});

test("normal summary uses masked phone and contains no raw contact before explicit reveal", () => {
  assert.match(html, /detailItem\("Masked phone", lead\.phone_display\)/);
  assert.match(html, /elements\.workspaceResolutionPhone\.textContent = "-"/);
  assert.match(html, /elements\.workspaceResolutionEmail\.textContent = "-"/);
  assert.match(html, /fetch\(`\/\.netlify\/functions\/control-tower-escalation-detail\?\$\{params\}`/);
  assert.match(html, /workspaceResolutionPhone\.textContent = textOrFallback\(result\.lead\.phone/);
  assert.match(html, /workspaceResolutionEmail\.textContent = textOrFallback\(result\.lead\.email/);
});

test("non-escalated leads stay read-only while eligible escalations receive explicit reveal", () => {
  assert.match(html, /elements\.adminResolutionSection\.classList\.add\("hidden"\)/);
  assert.match(html, /else if \(drawer\.admin_resolution_eligible === true\) \{\s*elements\.adminResolutionSection\.classList\.remove\("hidden"\)/);
  assert.match(html, /Contact details are hidden until explicitly revealed for resolution\./);
  assert.match(html, /id="showResolutionDetailsButton"[^>]*>Show resolution details<\/button>/);
});

test("administrator resolution retains exactly the four approved outcomes", () => {
  const outcomes = [...html.matchAll(/<option value="(ADMIN_[A-Z_]+)"/g)].map(match => match[1]);
  assert.deepEqual(outcomes, [
    "ADMIN_CONTACTED_APPOINTMENT_SET",
    "ADMIN_CONTACTED_NOT_INTERESTED",
    "ADMIN_NO_ANSWER",
    "ADMIN_NO_ACTION"
  ]);
});

test("resolution uses the protected endpoint and preserves the successful refresh path", () => {
  assert.equal((html.match(/fetch\("\/\.netlify\/functions\/control-tower-resolve-escalation"/g) || []).length, 1);
  assert.match(html, /JSON\.stringify\(\{ lead_id: activeWorkspaceLead\.lead_id, admin_resolution_status: status \}\)/);
  assert.match(html, /Escalation resolved\. Refreshing dashboard\.\.\.[\s\S]*await loadDashboardData\(\)/);
});

test("workspace presents authoritative sections and lifecycle events chronologically", () => {
  for (const heading of ["Lead Summary", "Current Status", "Assigned Agent / Response Context", "Lifecycle History", "Administrator Resolution"]) {
    assert.ok(html.includes(`>${heading}<`));
  }
  assert.match(html, /safeEvents\.slice\(\)\.reverse\(\)\.map\(event =>/);
  assert.match(html, /detailItem\("Reassignments", lead\.counts\?\.reassignment_count\)/);
  assert.match(html, /detailItem\("Release-time agent", lead\.drawer\?\.release_time_assigned_agent_id\)/);
});

test("mobile uses a full-screen stacked workspace without horizontal overflow affordances", () => {
  assert.ok(html.includes(".workspace-backdrop { padding: 0; } .lead-workspace { width: 100%; height: 100%; max-height: none; border: 0; border-radius: 0; } .workspace-columns { grid-template-columns: 1fr; }"));
  assert.match(html, /\.lead-workspace \{[^}]*overflow-x: hidden; overflow-y: auto/);
});

test("centered workspace introduces no Analytics or historical filters", () => {
  assert.equal(html.includes("data-time-filter"), false);
  assert.equal(html.includes("Last 7 Days"), false);
  assert.equal(html.includes("Last 30 Days"), false);
  assert.equal(html.includes("Analytics View"), false);
});
