const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.GOOGLE_SERVICE_ACCOUNT = "{}";
process.env.MAKE_INITIAL_RESPONSE_WEBHOOK_URL = "https://example.invalid/initial";
process.env.MAKE_OUTCOME_RESPONSE_WEBHOOK_URL = "https://example.invalid/outcome";

const identity = require("../netlify/functions/_shared/lifecycle-identity");
const intake = require("../netlify/functions/intake-lead");
const handleAction = require("../netlify/functions/handle-action");
const releaseLead = require("../netlify/functions/release-lead");

function uuids(...values) {
  let index = 0;
  return () => values[index++];
}

function assignmentFixture() {
  return {
    lifecycle_id: "L-IDENTITY-1",
    assignment_id: "as_assignment-1",
    assignment_sequence: 1,
    owner_epoch_id: "oe_owner-1",
    agent_id_snapshot: "AGENT-1",
    policy_snapshot_id: "ps_policy-1"
  };
}

function actionRowFixture(overrides = {}) {
  return {
    short_code: "SHORT1",
    gateway_context: "INITIAL_RESPONSE_GATEWAY",
    selected_action: "CALL_NOW",
    lead_id: "L-IDENTITY-1",
    client_id: "CLIENT-1",
    trace_id: "TRACE-1",
    notes: "",
    is_active: "TRUE",
    used_ts_utc: "",
    _sheet_row_number: 2,
    _headers: [
      "short_code", "public_url", "gateway_context", "selected_action",
      "lead_id", "client_id", "lead_data_spreadsheet_id", "assigned_agent_id",
      "expires_ts_utc", "is_active", "created_ts_utc", "used_ts_utc", "notes",
      "deactivated_ts_utc", "deactivation_reason", "trace_id", "lifecycle_id",
      "assignment_id", "assignment_sequence", "owner_epoch_id", "agent_id_snapshot",
      "policy_snapshot_id", "gateway_id", "action_attempt_id",
      "operational_action_record_id"
    ],
    ...assignmentFixture(),
    gateway_id: "gw_gateway-1",
    action_attempt_id: "",
    ...overrides
  };
}

test("fresh lifecycle, assignment, gateway, and attempt identities retain approved semantics", () => {
  const lifecycle = identity.createLifecycleIdentity({
    leadId: "L-IDENTITY-1",
    uuidFactory: uuids("policy-1")
  });
  const assignment = identity.createAssignmentIdentity({
    lifecycleIdentity: lifecycle,
    assignedAgentId: "AGENT-1",
    uuidFactory: uuids("assignment-1", "owner-1")
  });
  const firstGateway = identity.createGatewayIdentity(assignment, uuids("gateway-1"));
  const secondGateway = identity.createGatewayIdentity(assignment, uuids("gateway-2"));

  assert.equal(lifecycle.lifecycle_id, "L-IDENTITY-1");
  assert.equal(lifecycle.policy_snapshot_id, "ps_policy-1");
  assert.equal(assignment.assignment_sequence, 1);
  assert.equal(assignment.agent_id_snapshot, "AGENT-1");
  assert.equal(firstGateway.gateway_id, "gw_gateway-1");
  assert.notEqual(firstGateway.gateway_id, secondGateway.gateway_id);
  assert.equal(identity.createActionAttemptId(uuids("attempt-1")), "aa_attempt-1");
  assert.equal("operational_action_record_id" in firstGateway, false);
});

test("new intake gateway persists complete identity while leaving Make-owned identity blank", async () => {
  const appends = [];
  const sheets = {
    spreadsheets: { values: { async append(args) { appends.push(args); } } }
  };
  const result = await intake._test.createInitialActionLinks({
    sheets,
    lead_id: "L-IDENTITY-1",
    client: { client_id: "CLIENT-1", lead_data_spreadsheet_id: "LEAD-SHEET" },
    assigned_agent_id: "AGENT-1",
    trace_id: "TRACE-1",
    assignment_identity: assignmentFixture()
  });
  const row = appends[0].requestBody.values[0];

  assert.equal(appends[0].range, "ActionLinkMap!A:Y");
  assert.deepEqual(row.slice(16, 22), identity.identityValues(assignmentFixture()));
  assert.match(row[22], /^gw_/);
  assert.equal(row[23], "");
  assert.equal(row[24], "");
  assert.equal(result.INITIAL_RESPONSE_GATEWAY.gateway_id, row[22]);
});

test("direct obligation evidence carries identities without changing projection semantics", async () => {
  const committed = intake._test.buildDirectCommittedIntake({
    leadPayload: { full_name: "Synthetic", phone: "+12815550101", email: "test@example.invalid" },
    trace_id: "TRACE-1",
    lead_id: "L-IDENTITY-1",
    client_id: "CLIENT-1",
    assigned_agent_id: "AGENT-1",
    source_system: "WEBSITE",
    source_detail: "pilot-form",
    created_ts_utc: "2026-10-03T10:00:00.000Z",
    assignment_ts_utc: "2026-10-03T10:00:00.000Z",
    reminder_due_ts_utc: "2026-10-03T10:15:00.000Z",
    sms_status: "NOT_ATTEMPTED",
    lifecycle_identity: assignmentFixture()
  });
  let stored;
  await intake._test.persistIntakeProjectionObligation({
    obligationStore: { async set(key, value) { stored = { key, value }; } },
    committedIntake: committed,
    phase: intake._test.INTAKE_OBLIGATION_PHASE.PROJECTION_READY
  });

  assert.equal(committed.assignment_id, "as_assignment-1");
  assert.equal(stored.value.assignment_id, "as_assignment-1");
  assert.equal(stored.value.committed_intake.gateway_id, undefined);
});

test("one durable action-attempt identity is reused and claim records attempt evidence", async () => {
  const updates = [];
  const batches = [];
  const sheets = {
    spreadsheets: { values: {
      async update(args) { updates.push(args); },
      async batchUpdate(args) { batches.push(args); }
    } }
  };
  const row = actionRowFixture();
  const first = await handleAction._test.ensureActionAttemptId(sheets, row);
  const second = await handleAction._test.ensureActionAttemptId(sheets, row);
  await handleAction._test.claimActionLinkForDispatch(
    sheets,
    row,
    "2026-10-03T10:00:00.000Z",
    "CALL_NOW",
    first
  );

  assert.match(first, /^aa_/);
  assert.equal(second, first);
  assert.equal(updates.length, 1);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].requestBody.data[0].range, "ActionLinkMap!L2");
  assert.match(batches[0].requestBody.data[1].values[0][0], /state=DISPATCH_ATTEMPTED/);
  assert.match(batches[0].requestBody.data[1].values[0][0], new RegExp(first));
});

test("identity-complete and legacy action payloads preserve the operational five fields", async () => {
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    requests.push({ url, payload: JSON.parse(options.body) });
    return { ok: true, status: 200, async text() { return "accepted"; } };
  };
  try {
    await handleAction._test.processAction({
      shortCode: "SHORT1",
      selectedAction: "CALL_NOW",
      gatewayContext: "INITIAL_RESPONSE_GATEWAY",
      actionRow: actionRowFixture(),
      actionAttemptId: "aa_attempt-1"
    });
    await handleAction._test.processAction({
      shortCode: "LEGACY1",
      selectedAction: "CONTACTED_SET_APPOINTMENT",
      gatewayContext: "OUTCOME_GATEWAY",
      actionRow: {},
      actionAttemptId: ""
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.deepEqual(
    Object.fromEntries([
      "short_code", "gateway_context", "selected_action",
      "action_trigger_source", "agent_action_ts_utc"
    ].map(field => [field, requests[0].payload[field]])),
    {
      short_code: "SHORT1",
      gateway_context: "INITIAL_RESPONSE_GATEWAY",
      selected_action: "CALL_NOW",
      action_trigger_source: "ACTION_GATEWAY_BUTTON",
      agent_action_ts_utc: requests[0].payload.agent_action_ts_utc
    }
  );
  assert.equal(requests[0].payload.lifecycle_id, "L-IDENTITY-1");
  assert.equal(requests[0].payload.action_attempt_id, "aa_attempt-1");
  for (const field of [
    "lifecycle_id", "assignment_id", "assignment_sequence", "owner_epoch_id",
    "agent_id_snapshot", "policy_snapshot_id", "gateway_id", "action_attempt_id"
  ]) {
    assert.equal(requests[1].payload[field], "");
  }
});

test("Make non-2xx retains claim evidence and creates actionable failure evidence", async () => {
  const updates = [];
  const appends = [];
  const sheets = {
    spreadsheets: { values: {
      async update(args) { updates.push(args); },
      async append(args) { appends.push(args); }
    } }
  };
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 503,
    async text() { return "unavailable"; }
  });
  try {
    const result = await handleAction._test.dispatchClaimedAction({
      sheets,
      shortCode: "SHORT1",
      selectedAction: "CALL_NOW",
      gatewayContext: "INITIAL_RESPONSE_GATEWAY",
      actionRow: actionRowFixture({ action_attempt_id: "aa_attempt-1" }),
      actionAttemptId: "aa_attempt-1"
    });
    assert.equal(result.ok, false);
  } finally {
    global.fetch = originalFetch;
  }

  assert.match(updates[0].requestBody.values[0][0], /state=MAKE_HANDOFF_FAILED/);
  assert.match(updates[0].requestBody.values[0][0], /HTTP_503/);
  assert.equal(appends[0].range, "SystemEvents!A1");
  assert.equal(appends[0].requestBody.values[0][3], "GATEWAY_MAKE_HANDOFF_FAILED");
  assert.equal(appends[0].requestBody.values[0][4], "aa_attempt-1");
});

test("failure evidence falls back to SystemEvents when the ActionLinkMap note write fails", async () => {
  const appends = [];
  const sheets = {
    spreadsheets: { values: {
      async update() { throw new Error("ActionLinkMap unavailable"); },
      async append(args) { appends.push(args); }
    } }
  };
  await assert.doesNotReject(() => handleAction._test.recordGatewayDispatchResult({
    sheets,
    actionRow: actionRowFixture({ action_attempt_id: "aa_attempt-1" }),
    selectedAction: "CALL_NOW",
    actionAttemptId: "aa_attempt-1",
    state: "MAKE_HANDOFF_FAILED",
    detail: "HTTP_503"
  }));
  assert.equal(appends[0].requestBody.values[0][3], "GATEWAY_MAKE_HANDOFF_FAILED");
});

test("stored-action branch transports its persisted action identity context", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../netlify/functions/handle-action.js"),
    "utf8"
  );
  const storedBranch = source.slice(
    source.indexOf("const storedSelectedAction"),
    source.indexOf("if (!validateActiveGatewayRow(actionRow))")
  );
  assert.match(storedBranch, /ensureActionAttemptId\(sheets, actionRow\)/);
  assert.match(storedBranch, /dispatchClaimedAction\(\{/);
  assert.match(storedBranch, /actionRow: freshActionRow/);
  assert.match(storedBranch, /actionAttemptId/);
});

test("after-hours release propagates identity and legacy held rows remain blank-compatible", async () => {
  const appends = [];
  const sheets = {
    spreadsheets: { values: {
      async get() { return { data: { values: [["short_code"]] } }; },
      async append(args) { appends.push(args); }
    } }
  };
  const complete = await releaseLead._test.createReleaseInitialActionLink({
    sheets,
    lead_id: "L-IDENTITY-1",
    client: { client_id: "CLIENT-1", lead_data_spreadsheet_id: "LEAD-SHEET" },
    assigned_agent_id: "AGENT-1",
    trace_id: "TRACE-1",
    nowUtc: "2026-10-03T10:00:00.000Z",
    assignment_identity: assignmentFixture()
  });
  await releaseLead._test.createReleaseInitialActionLink({
    sheets,
    lead_id: "L-LEGACY",
    client: { client_id: "CLIENT-1", lead_data_spreadsheet_id: "LEAD-SHEET" },
    assigned_agent_id: "AGENT-1",
    trace_id: "TRACE-LEGACY",
    nowUtc: "2026-10-03T10:00:00.000Z",
    assignment_identity: null
  });

  const completeRow = appends[0].requestBody.values[0];
  const legacyRow = appends[1].requestBody.values[0];
  assert.deepEqual(completeRow.slice(16, 22), identity.identityValues(assignmentFixture()));
  assert.equal(complete.INITIAL_RESPONSE_GATEWAY.gateway_id, completeRow[22]);
  assert.deepEqual(legacyRow.slice(16, 25), ["", "", "", "", "", "", "", "", ""]);
});

test("after-hours hold writes only lifecycle and policy identity into ReleaseQueue", async () => {
  let append;
  const sheets = {
    spreadsheets: { values: { async append(args) { append = args; } } }
  };
  await intake._test.appendReleaseQueueRow({
    sheets,
    release_id: "RELEASE-1",
    client_id: "CLIENT-1",
    lead_id: "L-IDENTITY-1",
    release_due_ts_utc: "2026-10-03T10:00:00.000Z",
    release_reason: "OFF_HOURS_CLIENT_CLOSED",
    created_ts_utc: "2026-10-03T10:00:00.000Z",
    notes: "Synthetic hold",
    lifecycle_identity: {
      lifecycle_id: "L-IDENTITY-1",
      policy_snapshot_id: "ps_policy-1"
    }
  });
  const row = append.requestBody.values[0];
  assert.equal(append.range, "ReleaseQueue!A1");
  assert.deepEqual(row.slice(-2), ["L-IDENTITY-1", "ps_policy-1"]);
  assert.equal(row.includes("as_assignment-1"), false);
});

test("foundation does not introduce Analytics activation or event submission", () => {
  for (const file of [
    "netlify/functions/_shared/lifecycle-identity.js",
    "netlify/functions/intake-lead.js",
    "netlify/functions/handle-action.js",
    "netlify/functions/release-lead.js"
  ]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.doesNotMatch(source, /instrumentAnalyticsBoundary|ANALYTICS_ACTIVE|analytics-client/);
  }
});
