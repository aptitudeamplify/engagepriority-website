const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createLifecycleIdentity,
  createAssignmentIdentity,
  createReplacementAssignmentIdentity,
  createGatewayIdentity,
  createActionAttemptId,
  identityValues
} = require("../netlify/functions/_shared/lifecycle-identity");

function uuids(...values) {
  let index = 0;
  return () => values[index++];
}

test("initial assignment creates stable lifecycle, policy, assignment, owner epoch, and immutable agent value", () => {
  const lifecycle = createLifecycleIdentity({ leadId: "L-1", uuidFactory: uuids("p-1") });
  const assignment = createAssignmentIdentity({
    lifecycleIdentity: lifecycle,
    assignedAgentId: "AGENT-7",
    uuidFactory: uuids("a-1", "o-1")
  });
  assert.deepEqual(assignment, {
    lifecycle_id: "L-1",
    policy_snapshot_id: "ps_p-1",
    assignment_id: "as_a-1",
    assignment_sequence: 1,
    owner_epoch_id: "oe_o-1",
    agent_id_snapshot: "AGENT-7"
  });
  assert.equal(identityValues(assignment).length, 6);
});

test("reminder and outcome gateway creation preserve assignment identity and each gateway is independent of short code", () => {
  const assignment = createAssignmentIdentity({
    lifecycleIdentity: createLifecycleIdentity({ leadId: "L-1", uuidFactory: uuids("p-1") }),
    assignedAgentId: "AGENT-7",
    uuidFactory: uuids("a-1", "o-1")
  });
  const reminderGateway = createGatewayIdentity(assignment, uuids("g-1"));
  const outcomeGateway = createGatewayIdentity(assignment, uuids("g-2"));
  for (const field of Object.keys(assignment)) {
    assert.equal(reminderGateway[field], assignment[field]);
    assert.equal(outcomeGateway[field], assignment[field]);
  }
  assert.equal(reminderGateway.gateway_id, "gw_g-1");
  assert.equal(outcomeGateway.gateway_id, "gw_g-2");
  assert.notEqual(reminderGateway.gateway_id, "ABC123");
  assert.notEqual(reminderGateway.gateway_id, outcomeGateway.gateway_id);
});

test("replacement assignment increments once and preserves lifecycle and policy", () => {
  const current = {
    lifecycle_id: "L-1", policy_snapshot_id: "PS-1", assignment_id: "AS-1",
    assignment_sequence: 4, owner_epoch_id: "OE-1", agent_id_snapshot: "AGENT-1"
  };
  const replacement = createReplacementAssignmentIdentity({
    currentIdentity: current,
    assignedAgentId: "AGENT-2",
    uuidFactory: uuids("a-2", "o-2")
  });
  assert.equal(replacement.assignment_sequence, 5);
  assert.equal(replacement.lifecycle_id, current.lifecycle_id);
  assert.equal(replacement.policy_snapshot_id, current.policy_snapshot_id);
  assert.equal(replacement.agent_id_snapshot, "AGENT-2");
  assert.notEqual(replacement.assignment_id, current.assignment_id);
  assert.notEqual(replacement.owner_epoch_id, current.owner_epoch_id);
});

test("action validation creates a durable attempt id and propagates all identity fields to Make", () => {
  assert.equal(createActionAttemptId(uuids("try-1")), "aa_try-1");
  const source = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "handle-action.js"), "utf8");
  for (const field of [
    "lifecycle_id", "assignment_id", "assignment_sequence", "owner_epoch_id",
    "agent_id_snapshot", "policy_snapshot_id", "gateway_id", "action_attempt_id"
  ]) assert.match(source, new RegExp(`${field}:`));
  assert.doesNotMatch(source, /operational_action_record_id:\s*(createActionAttemptId|randomUUID)/);
});

test("after-hours release and legacy fail-closed paths are explicit and operational responses are unchanged", () => {
  const release = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "release-lead.js"), "utf8");
  assert.match(release, /createAssignmentIdentity/);
  assert.match(release, /LEGACY_IDENTITY_INCOMPLETE_ANALYTICS_WITHHELD/);
  assert.match(release, /status: "RELEASE_CLAIMED_ROUTINGSTATE_UPDATED"/);
  const analytics = fs.readFileSync(path.join(__dirname, "analytics-foundation.test.js"), "utf8");
  assert.match(analytics, /instrumentation is disabled by default/);
});

test("repository fixtures contain no secrets or protected client data", () => {
  const fixtureRoot = path.join(__dirname, "fixtures", "analytics");
  for (const file of fs.readdirSync(path.join(fixtureRoot, "make"))) {
    const text = fs.readFileSync(path.join(fixtureRoot, "make", file), "utf8");
    assert.doesNotMatch(text, /@|\+1\d{10}|BEGIN PRIVATE KEY|short_code|auth_token/i);
  }
});
