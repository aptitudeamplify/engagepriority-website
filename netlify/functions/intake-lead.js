const { google } = require("googleapis");
const twilio = require("twilio");
const { randomUUID } = require("crypto");
const {
  buildIntakeAuditRecord,
  deriveIntakeLifecycleEventId,
  projectCommittedIntake,
  withBoundedRetry
} = require("./_shared/intake-post-commit-projection");
const {
  createNetlifyIntakeObligationStore
} = require("./_shared/netlify-intake-obligation-store");
const {
  createLifecycleIdentity,
  createAssignmentIdentity,
  createGatewayIdentity,
  identityValues
} = require("./_shared/lifecycle-identity");
const {
  CONTRACTS,
  DECISION_TYPES,
  buildSemanticRequest,
  normalizeSourceEventId,
  routingStateFingerprint
} = require("./_shared/routing-coordination-contract");
const {
  createRoutingCoordinationClient,
  loadRoutingCoordinationConfig
} = require("./_shared/routing-coordination-client");
const {
  createRoutingCoordinationObligationStore
} = require("./_shared/routing-coordination-obligation-store");
const {
  coordinateRoutingCommit,
  isSmsDownstreamAuthorized,
  routingCoordinationMode,
  routingOperationKey,
  validateRoutingObligation
} = require("./_shared/routing-coordination");
const {
  inspectUniqueRows,
  reconcileCreateStep,
  runAtMostOnceDispatch
} = require("./_shared/routing-continuation");

const SHEET_ID = "18x83a1VZIZoXrjASqTNfKdzYi1gDKLQD4fgx5WbyoWQ";
const ACTION_LINK_MAP_SHEET_ID = "1xNhypMirxoz9IjMWxO0H8gxNSqqavs2W17pzx8HiZfw";
const MAKE_INTAKE_HANDOFF_WEBHOOK_URL = process.env.MAKE_INTAKE_HANDOFF_WEBHOOK_URL;
const INTAKE_PROJECTION_MODE = String(
  process.env.EP_INTAKE_PROJECTION_MODE || "LEGACY_MAKE"
).trim().toUpperCase();
const INTAKE_AUDIT_SPREADSHEET_ID = String(
  process.env.EP_NETLIFY_INTAKE_AUDIT_SPREADSHEET_ID || ""
).trim();
const INTAKE_OBLIGATION_PHASE = Object.freeze({
  // Nonterminal records contain correlation identifiers only and never
  // authorize lifecycle or audit projection.
  PRE_COMMIT: "PRE_COMMIT",
  CORE_COMMITTED_SMS_READY: "CORE_COMMITTED_SMS_READY",
  // This terminal phase alone may contain the complete repair evidence.
  PROJECTION_READY: "PROJECTION_READY"
});

let intakeObligationStorePromise = null;
let intakeTestRuntime = null;


exports.handler = async (event, context) => {
if (event.httpMethod !== "POST") {
return {
statusCode: 405,
body: JSON.stringify({ error: "Method not allowed" })
};
}

const rawBody = event.body || "";

if (rawBody.length > 10000) {
console.log("intake_validation_error", {
reason: "oversized_payload"
});
return {
statusCode: 413,
body: JSON.stringify({ error: "Invalid request" })
};
}

const startTotal = Date.now();
const routingStateMode = routingCoordinationMode();

const timing = {
total_ms: 0,
parse_payload_ms: 0,
sheets_read_clients_ms: 0,
sheets_read_agents_ms: 0,
sheets_read_pointer_ms: 0,
assignment_compute_ms: 0,
sheets_write_pointer_ms: 0,
sheets_write_leadlog_ms: 0,
sheets_write_reminderqueue_ms: 0
};

try {
let t0 = Date.now();

const leadPayload = parseLeadPayload(event);

if (routingStateMode === "GAS_COORDINATED") {
  try {
    normalizeSourceEventId(leadPayload.source_event_id);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "INVALID_SOURCE_EVENT_ID" }) };
  }
}

let trace_id = randomUUID();
console.log("trace_id:", trace_id);

const intakeClientRef = (leadPayload.intake_client_reference || "").trim();

if (!intakeClientRef) {
console.log("intake_validation_error", {
trace_id,
reason: "missing_intake_client_reference"
});
return {
statusCode: 400,
body: JSON.stringify({ error: "Invalid request" })
};
}


timing.parse_payload_ms = Date.now() - t0;

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});

const sheets = intakeTestRuntime?.sheets || google.sheets({ version: "v4", auth });
let leadId = generateLeadId();
let lifecycleIdentity = createLifecycleIdentity({ leadId });

t0 = Date.now();
const registryRes = await withSheetsReadRetry(() => sheets.spreadsheets.values.batchGet({
  spreadsheetId: SHEET_ID,
  ranges: [
    "Clients!A1:AC1000",
    "Agents!A1:Z1000",
    "RoutingState!A1:Z1000",
    "IntakeSourceMap!A1:Z1000"
  ]
}));
const registryReadMs = Date.now() - t0;
timing.sheets_read_clients_ms = registryReadMs;
timing.sheets_read_agents_ms = 0;
timing.sheets_read_pointer_ms = 0;

const registryValueRanges = registryRes.data.valueRanges || [];
const clientsRows = registryValueRanges[0]?.values || [];
const agentsRows = registryValueRanges[1]?.values || [];
const routingRows = registryValueRanges[2]?.values || [];
const intakeSourceMapRows = registryValueRanges[3]?.values || [];

if (clientsRows.length < 2) {
  throw new Error("Clients tab must contain a header row and at least one client row.");
}

if (agentsRows.length < 2) {
  throw new Error("Agents tab must contain a header row and at least one agent row.");
}

if (routingRows.length < 2) {
  throw new Error("RoutingState tab must contain a header row and at least one routing state row.");
}

const clients = rowsToObjects(clientsRows);
const agents = rowsToObjects(agentsRows);
const routingStates = rowsToObjects(routingRows);
const intakeSourceMap = rowsToObjects(intakeSourceMapRows);

const source_system = String(leadPayload.source_system || "WEBSITE").trim().toUpperCase();
if (routingStateMode === "GAS_COORDINATED" && source_system !== "WEBSITE") {
  return { statusCode: 400, body: JSON.stringify({ error: "INVALID_COORDINATED_SOURCE" }) };
}
const source_primary_key_type = "source_detail";
const source_primary_key_value = intakeClientRef;

console.log("intake_source_detection", {
trace_id,
source_system,
source_primary_key_type,
source_primary_key_value
});

const matchingSourceRows = intakeSourceMap.filter(row => {
return String(row.source_system || "").trim().toUpperCase() === source_system &&
String(row.source_primary_key_type || "").trim() === source_primary_key_type &&
String(row.source_primary_key_value || "").trim() === source_primary_key_value &&
String(row.status || "").trim().toUpperCase() === "ACTIVE";
});

console.log("intake_source_map_lookup", {
trace_id,
match_count: matchingSourceRows.length
});

if (matchingSourceRows.length === 0) {
console.log("intake_validation_error", {
trace_id,
reason: "UNRESOLVED_CLIENT"
});
return {
statusCode: 400,
body: JSON.stringify({ error: "UNRESOLVED_CLIENT" })
};
}

if (matchingSourceRows.length > 1) {
console.log("intake_validation_error", {
trace_id,
reason: "AMBIGUOUS_CLIENT_MAPPING"
});
return {
statusCode: 400,
body: JSON.stringify({ error: "AMBIGUOUS_CLIENT_MAPPING" })
};
}

const mappedClientId = matchingSourceRows[0].client_id;

const client = clients.find(row => {
return String(row.client_id || "").trim() === String(mappedClientId || "").trim();
});


if (!client) {
console.log("intake_validation_error", {
trace_id,
reason: "INVALID_CLIENT_CONFIG"
});
return {
statusCode: 400,
body: JSON.stringify({ error: "Invalid request" })
};
}

if (String(client.client_status || "").trim().toUpperCase() !== "ACTIVE") {
console.log("intake_validation_error", {
trace_id,
reason: "inactive_client",
client_id: client.client_id
});
return {
statusCode: 400,
body: JSON.stringify({ error: "Invalid request" })
};
}

if (!client.lead_data_spreadsheet_id) {
console.log("intake_validation_error", {
trace_id,
reason: "missing_lead_data_spreadsheet_id",
client_id: client.client_id
});
return {
statusCode: 400,
body: JSON.stringify({ error: "Invalid request" })
};
}

const normalizedLead = normalizeWebsiteLead(leadPayload);

if (!normalizedLead.phone) {
console.log("intake_validation_error", {
trace_id,
reason: "missing_phone",
client_id: client.client_id
});
return {
statusCode: 400,
body: JSON.stringify({ error: "Invalid request" })
};
}

Object.assign(leadPayload, normalizedLead);

const serviceWindowStatus =
  getClientServiceWindowStatus(client);

console.log("intake_service_window_status", {
  trace_id,
  client_id: client.client_id,
  is_open: serviceWindowStatus.is_open,
  release_mode: serviceWindowStatus.release_mode,
  timezone: serviceWindowStatus.timezone,
  local_day: serviceWindowStatus.local_day,
  local_time: serviceWindowStatus.local_time,
  business_day_start_time: serviceWindowStatus.business_day_start_time,
  business_day_end_time: serviceWindowStatus.business_day_end_time,
  business_days_active: serviceWindowStatus.business_days_active
});

const intakeValidation = validateWebsiteLeadForIntake(leadPayload);

if (intakeValidation.hard_reject) {
console.log("intake_validation_error", {
trace_id,
reason: intakeValidation.validation_reason,
spam_score: intakeValidation.spam_score,
client_id: client.client_id
});
return {
statusCode: 400,
body: JSON.stringify({ error: "Invalid request" })
};
}

const idempotencyKey = buildIdempotencyKey(
  client.client_id,
  leadPayload.email,
  leadPayload.phone
);

const sourceToken = [
  source_system,
  source_primary_key_value
].join("|");

const idempotencyRows = await readSheetRows(
  sheets,
  client.lead_data_spreadsheet_id,
  "Idempotency!A1:H10000"
);

const duplicateRowIndex = findRowIndexByColumnValue(
  idempotencyRows,
  "idempotency_key",
  idempotencyKey
);

let routingContinuationContext = null;
let coordinatedRetryEvidence = false;
if (routingStateMode === "GAS_COORDINATED") {
  const logicalReference = {
    logical_reference_contract: CONTRACTS.initialIntake,
    client_id: client.client_id,
    source_system: "WEBSITE",
    source_path: "website-lead-form-v1",
    source_event_id: normalizeSourceEventId(leadPayload.source_event_id)
  };
  const config = intakeTestRuntime?.routingCoordinationConfig || loadRoutingCoordinationConfig();
  const obligationStore = intakeTestRuntime?.routingCoordinationObligationStore || createRoutingCoordinationObligationStore();
  const operationKey = routingOperationKey(config.environment, logicalReference);
  coordinatedRetryEvidence = Boolean(await obligationStore.read(operationKey));
  routingContinuationContext = { config, logicalReference, obligationStore, operationKey };
}

if (duplicateRowIndex !== -1 && !coordinatedRetryEvidence) {
  console.log("intake_duplicate_lead", {
    trace_id,
    client_id: client.client_id,
    reason: "DUPLICATE_LEAD"
  });

  const duplicateHeaders = idempotencyRows[0] || [];
const duplicateLeadIdColumn = duplicateHeaders.indexOf("lead_id");

const duplicateLeadId =
  duplicateLeadIdColumn !== -1
    ? (idempotencyRows[duplicateRowIndex][duplicateLeadIdColumn] || "")
    : "";

let duplicateProjection = null;

if (INTAKE_PROJECTION_MODE === "NETLIFY_DIRECT" && duplicateLeadId) {
  try {
    const repairContext = await loadCommittedIntakeByLeadId({
      sheets,
      spreadsheetId: client.lead_data_spreadsheet_id,
      lead_id: duplicateLeadId
    });

    if (!repairContext) {
      duplicateProjection = projectionRepairRequired("COMMITTED_INTAKE_NOT_FOUND");
    } else if (!repairContext.projection_applicable) {
      duplicateProjection = projectionNotApplicable(repairContext.reason);
    } else {
      const obligationStore = await getIntakeObligationStore();
      const eventId = deriveIntakeLifecycleEventId(repairContext.committed_intake);
      const obligation = await obligationStore.get(eventId);
      const recovery = recoverProjectionReadyIntake(obligation);

      if (obligation && !recovery.recoverable) {
        duplicateProjection = projectionRepairRequired(recovery.error_code, {
          lifecycle: { status: "NOT_ATTEMPTED" },
          audit: { status: "NOT_ATTEMPTED" }
        });
      } else {
        duplicateProjection = await runDirectIntakeProjection({
          sheets,
          committedIntake: recovery.committed_intake || repairContext.committed_intake,
          leadDataSpreadsheetId: client.lead_data_spreadsheet_id,
          obligationStore
        });
      }
    }
  } catch (error) {
    duplicateProjection = projectionRepairRequired(
      error?.code || "DUPLICATE_REPAIR_LOOKUP_FAILED"
    );
  }

  logProjectionResult({
    trace_id,
    lead_id: duplicateLeadId,
    result: duplicateProjection,
    invocation: "DUPLICATE_REPAIR"
  });

  await recordProjectionRepairEvent({
    sheets,
    client_id: client.client_id,
    lead_id: duplicateLeadId,
    trace_id,
    result: duplicateProjection
  });
}

await appendSystemEvent({
  sheets,
  event_id: randomUUID(),
  event_timestamp: new Date().toISOString(),
  client_id: client.client_id,
  event_type: "DUPLICATE_LEAD",
  reference_id: duplicateLeadId,
  severity: "INFO",
  message: "Duplicate lead blocked by Netlify intake idempotency check",
  source_module: "netlify-intake-lead",
  processed_flag: "FALSE",
  trace_id
});

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "DUPLICATE_LEAD",
      trace_id,
      client: {
        client_id: client.client_id
      },
      post_commit_projection: duplicateProjection,
      message: "Duplicate lead detected. Intake processing stopped."
    })
  };
}

if (
  !serviceWindowStatus.is_open &&
  serviceWindowStatus.release_mode === "AT_OPEN" &&
  !coordinatedRetryEvidence
) {
  const nowUtc =
    new Date().toISOString();

  const leadDataSpreadsheetId =
    client.lead_data_spreadsheet_id;

  const row = [
    leadId,                                // lead_id
    client.client_id,                      // client_id
    nowUtc,                                // created_timestamp
    leadPayload.source_system || "",       // source_system
    leadPayload.source_detail || "",       // source_detail
    leadPayload.full_name || "",           // full_name
    leadPayload.email || "",               // email
    leadPayload.phone || "",               // phone
    JSON.stringify(leadPayload),           // inbound_payload_json
    "",                                    // normalized_payload_json
    "",                                    // hardening_status
    "",                                    // idempotency_status
    intakeValidation.validation_status,    // validation_status
    client.routing_strategy,               // routing_decision
    "OFF_HOURS_HOLD",                      // routing_reason
    "",                                    // assigned_agent_id
    "",                                    // assigned_timestamp
    "FALSE",                               // contacted_flag
    "",                                    // contact_timestamp
    "PENDING_RELEASE",                     // lead_status
    nowUtc,                                // last_updated_timestamp
    "Held by Netlify intake because client service window is closed.", // notes
    trace_id,                              // trace_id
    "",                                    // reminder_claimed_ts_utc
    intakeValidation.validation_reason,    // validation_reason
    String(intakeValidation.spam_score),   // spam_score
    "",                                    // token_call_now
    "",                                    // token_ack_later
    "",                                    // token_reassign
    "",                                    // token_outcome_contacted
    "",                                    // token_outcome_no_answer
    "",                                    // token_outcome_reassign
    "FALSE",                               // tokens_active
    "FALSE",                               // acknowledged
    "",                                    // ack_timestamp
    "",                                    // ack_agent_id
    "FALSE",                               // contact_attempt_started
    "",                                    // contact_attempt_started_ts
    "",                                    // contact_outcome
    "FALSE",                               // reassign_requested
    "",                                    // reassign_requested_ts
    "",                                    // token_invalidated_ts
    "",                                    // attempted_agent_ids
    "0",                                   // reassignment_count
    "0",                                   // assignment_attempt_count
    "FALSE",                               // reassignment_pending
    "",                                    // reassignment_reason
    "",                                    // reassignment_requested_ts_utc
    "",                                    // reassigned_from_agent_id
    "",                                    // last_reassignment_ts_utc
    "",                                    // assignment_ts_utc
    "",                                    // reassignment_status
    "FALSE",                               // admin_escalation_required
    "",                                    // admin_escalation_ts_utc
    "",                                    // last_reassignment_reason
    "0",                                   // non_response_reassignment_count
    "",                                    // admin_escalation_reason
    "",                                    // token_contacted_appt_set
    "",                                    // token_contacted_not_interested
    "0",                                   // no_answer_attempt_count
    nowUtc,                                // scenario_started_ts_utc
    nowUtc,                                // scenario_ended_ts_utc
    lifecycleIdentity.lifecycle_id,        // lifecycle_id
    "",                                    // assignment_id (created at release)
    "",                                    // assignment_sequence (created at release)
    "",                                    // owner_epoch_id (created at release)
    "",                                    // agent_id_snapshot (created at release)
    lifecycleIdentity.policy_snapshot_id   // policy_snapshot_id
  ];

  const leadLogAppendResult =
    await sheets.spreadsheets.values.append({
      spreadsheetId: leadDataSpreadsheetId,
      range: "LeadLog_Active!A1",
      valueInputOption: "RAW",
      requestBody: {
        values: [row]
      }
    });

  const leadLogUpdatedRange =
    leadLogAppendResult.data.updates?.updatedRange || "";

  const leadLogRowMatch =
    leadLogUpdatedRange.match(/![A-Z]+(\d+):/);

  const leadLogRowNumber =
    leadLogRowMatch ? leadLogRowMatch[1] : "";

  await appendLeadIndexRow({
    sheets,
    spreadsheetId: leadDataSpreadsheetId,
    lead_id: leadId,
    leadlog_row: leadLogRowNumber,
    client_id: client.client_id,
    created_timestamp: nowUtc,
    last_updated_timestamp: nowUtc
  });

  await appendReleaseQueueRow({
    sheets,
    release_id: randomUUID(),
    client_id: client.client_id,
    lead_id: leadId,
    release_due_ts_utc: nowUtc,
    release_reason: "OFF_HOURS_CLIENT_CLOSED",
    created_ts_utc: nowUtc,
    notes: `Held at intake. Local service window status: ${serviceWindowStatus.local_day} ${serviceWindowStatus.local_time} ${serviceWindowStatus.timezone}.`,
    lifecycle_identity: lifecycleIdentity
  });

  await appendLeadLifecycleEvent({
    sheets,
    spreadsheetId: leadDataSpreadsheetId,
    event_id: randomUUID(),
    event_ts_utc: nowUtc,
    client_id: client.client_id,
    lead_id: leadId,
    trace_id,
    event_type: "LEAD_HELD_AFTER_HOURS",
    event_stage: "INTAKE",
    event_source: "NETLIFY",
    assigned_agent_id: "",
    gateway_context: "",
    selected_action: "",
    notes: "Held after hours; release queued"
  });

  await appendIdempotencyRow({
    sheets,
    spreadsheetId: leadDataSpreadsheetId,
    idempotency_key: idempotencyKey,
    client_id: client.client_id,
    source_token: sourceToken,
    first_seen_timestamp: nowUtc,
    lead_id: leadId
  });

  timing.total_ms =
    Date.now() - startTotal;

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "INTAKE_HELD_FOR_RELEASE",
      trace_id,
      timing,
      client: {
        client_id: client.client_id,
        routing_strategy: client.routing_strategy
      },
      lead_preview: {
        lead_id: leadId,
        full_name: leadPayload.full_name || null,
        phone: leadPayload.phone || null,
        email: leadPayload.email || null
      },
      service_window: serviceWindowStatus,
      lead_status: "PENDING_RELEASE",
      release_queue_created: true,
      lifecycle_event_created: true,
      lifecycle_event_type: "LEAD_HELD_AFTER_HOURS",
      routing_state_updated: false,
      action_links_created: false,
      reminder_created: false,
      sms_sent: false,
      message: "Lead held for release because client service window is closed."
    })
  };
}

const eligibleAgents = agents.filter(agent => {
return String(agent.client_id || "").trim() === client.client_id &&
String(agent.agent_status || "").trim().toUpperCase() === "ACTIVE";
});

if (eligibleAgents.length === 0 && !coordinatedRetryEvidence) {
console.log("intake_validation_error", {
trace_id,
reason: "no_active_agents",
client_id: client.client_id
});
return {
statusCode: 400,
body: JSON.stringify({ error: "Invalid request" })
};
}

for (const agent of coordinatedRetryEvidence ? [] : eligibleAgents) {
const assignmentWeight = parseInt(agent.assignment_weight, 10);
const prioritySlot = parseInt(agent.priority_slot, 10);

if (!Number.isFinite(assignmentWeight) || assignmentWeight <= 0 || !Number.isFinite(prioritySlot) || !agent.agent_phone) {
console.log("intake_validation_error", {
trace_id,
reason: "invalid_agent_pool",
client_id: client.client_id,
agent_id: agent.agent_id
});
return {
statusCode: 400,
body: JSON.stringify({ error: "Invalid request" })
};
}
}

const routingStrategy = String(client.routing_strategy || "").trim();

if (!routingStrategy && !coordinatedRetryEvidence) {
  throw new Error(`Missing routing_strategy for client_id: ${client.client_id}`);
}

let assignmentResult;
let assignmentIdentity;
let routingState;

if (routingStateMode === "GAS_COORDINATED") {
  const { logicalReference, config, obligationStore } = routingContinuationContext;
  const coordinationClient = intakeTestRuntime?.routingCoordinationClient || createRoutingCoordinationClient({ config });

  const buildAttempt = async ({ reason }) => {
    let attemptRoutingRows = routingRows;
    let attemptAgents = agents;
    if (reason === "STALE") {
      const refresh = await withSheetsReadRetry(() => sheets.spreadsheets.values.batchGet({
        spreadsheetId: SHEET_ID,
        ranges: ["Agents!A1:Z1000", "RoutingState!A1:Z1000"]
      }));
      attemptAgents = rowsToObjects(refresh.data.valueRanges?.[0]?.values || []);
      attemptRoutingRows = refresh.data.valueRanges?.[1]?.values || [];
    }
    const attemptRoutingObjects = rowsToObjects(attemptRoutingRows);
    const currentState = getCoordinatedRoutingState({
      headers: attemptRoutingRows[0] || [],
      routingStates: attemptRoutingObjects,
      clientId: client.client_id
    });
    const currentAgents = attemptAgents.filter(agent =>
      String(agent.client_id || "").trim() === client.client_id &&
      String(agent.agent_status || "").trim().toUpperCase() === "ACTIVE"
    );
    const result = executeAssignment({
      routing_strategy: routingStrategy,
      agents: currentAgents,
      routing_pointer: currentState.routing_pointer
    });
    const candidateAssignmentIdentity = createAssignmentIdentity({
      lifecycleIdentity,
      assignedAgentId: result.assigned_agent_id
    });
    const gatewayIdentity = createGatewayIdentity(candidateAssignmentIdentity);
    const createdTsUtc = new Date().toISOString();
    const reminderDelay = parseInt(client.reminder_1_delay_minutes, 10);
    if (!Number.isFinite(reminderDelay) || reminderDelay <= 0) throw new Error("Invalid coordinated reminder delay.");
    const stateFingerprint = routingStateFingerprint(currentState).fingerprint;
    const request = buildSemanticRequest({
      environment: config.environment,
      decision_type: DECISION_TYPES.INITIAL_INTAKE,
      client_id: client.client_id,
      logical_reference: logicalReference,
      expected_state: {
        routing_state_version: currentState.routing_state_version,
        routing_pointer: currentState.routing_pointer,
        routing_state_fingerprint: stateFingerprint
      },
      proposal: {
        selected_agent_id: result.assigned_agent_id,
        routing_pointer_after: result.routing_pointer_after,
        total_assignments_today_after: currentState.total_assignments_today + 1,
        notes_after: currentState.notes
      },
      semantic_evidence: {}
    });
    return {
      request,
      continuation: {
        operation_kind: DECISION_TYPES.INITIAL_INTAKE,
        client_id: client.client_id,
        lead_id: leadId,
        lifecycle_identity: lifecycleIdentity,
        assignment_identity: candidateAssignmentIdentity,
        assignment_result: result,
        plan: {
          trace_id,
          created_ts_utc: createdTsUtc,
          reminder_due_ts_utc: new Date(new Date(createdTsUtc).getTime() + reminderDelay * 60000).toISOString(),
          lifecycle_event_id: randomUUID(),
          gateway_id: gatewayIdentity.gateway_id
        }
      }
    };
  };

  t0 = Date.now();
  const coordinated = await coordinateRoutingCommit({
    logicalReference,
    environment: config.environment,
    buildAttempt,
    obligationStore,
    client: coordinationClient
  });
  timing.assignment_compute_ms = Date.now() - t0;
  leadId = coordinated.continuation.lead_id;
  trace_id = coordinated.continuation.plan.trace_id;
  lifecycleIdentity = coordinated.continuation.lifecycle_identity;
  assignmentIdentity = coordinated.continuation.assignment_identity;
  assignmentResult = coordinated.continuation.assignment_result;
  routingState = coordinated.response.result_payload;
  routingContinuationContext = {
    ...routingContinuationContext,
    coordinationClient,
    continuation: coordinated.continuation,
    obligation: coordinated.obligation
  };
} else {
  routingState = routingStates[0];
  const routingPointer = parseInt(routingState.routing_pointer || "0", 10);
  if (!Number.isFinite(routingPointer) || routingPointer < 0) throw new Error(`Invalid routing_pointer: ${routingState.routing_pointer}`);
  t0 = Date.now();
  assignmentResult = executeAssignment({
    routing_strategy: routingStrategy,
    agents: eligibleAgents,
    routing_pointer: routingPointer
  });
  timing.assignment_compute_ms = Date.now() - t0;
  assignmentIdentity = createAssignmentIdentity({ lifecycleIdentity, assignedAgentId: assignmentResult.assigned_agent_id });
}

console.log("intake_after_assignment", {
  trace_id,
  lead_id: leadId,
  assigned_agent_id: assignmentResult.assigned_agent_id,
  routing_pointer_before: assignmentResult.routing_pointer_before,
  routing_pointer_after: assignmentResult.routing_pointer_after,
  cycle_length: assignmentResult.cycle_length,
  routing_state_mode: routingStateMode
});

let assignedAgentPool = agents;
if (routingStateMode === "GAS_COORDINATED") {
  const assignedAgentRefresh = await withSheetsReadRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Agents!A1:Z1000"
  }));
  assignedAgentPool = rowsToObjects(assignedAgentRefresh.data.values || []);
}
const assignedAgent = assignedAgentPool.find(agent => agent.agent_id === assignmentResult.assigned_agent_id);
const intakeSmsState = routingContinuationContext?.obligation?.consequence_state?.SMS?.status || "";
const intakeSmsSettled = ["COMPLETED", "AMBIGUOUS", "MANUAL_RECONCILIATION"].includes(intakeSmsState);
if (!assignedAgent && !intakeSmsSettled) throw new Error(`Assigned agent not found after routing: ${assignmentResult.assigned_agent_id}`);

const nowUtc = routingContinuationContext?.continuation?.plan?.created_ts_utc || new Date().toISOString();
const leadDataSpreadsheetId = client.lead_data_spreadsheet_id;

if (!leadDataSpreadsheetId) {
  throw new Error(`Missing lead_data_spreadsheet_id for client_id: ${client.client_id}`);
}

const reminderDelayMinutes = parseInt(client.reminder_1_delay_minutes, 10);

if (!Number.isFinite(reminderDelayMinutes) || reminderDelayMinutes <= 0) {
  throw new Error(`Invalid reminder_1_delay_minutes for client_id: ${client.client_id}`);
}

const nextActionDue = routingContinuationContext?.continuation?.plan?.reminder_due_ts_utc ||
  new Date(Date.now() + reminderDelayMinutes * 60000).toISOString();
let directObligationStore = null;
let directCommittedIntake = null;
let directProjectionIdentity = null;

if (INTAKE_PROJECTION_MODE === "NETLIFY_DIRECT") {
  directObligationStore = await getIntakeObligationStore();
  directProjectionIdentity = {
    trace_id,
    lead_id: leadId,
    client_id: client.client_id,
    ...assignmentIdentity
  };
  await persistIntakeProjectionObligation({
    obligationStore: directObligationStore,
    identity: directProjectionIdentity,
    phase: INTAKE_OBLIGATION_PHASE.PRE_COMMIT
  });
}

t0 = Date.now();

if (routingStateMode === "LEGACY_DIRECT") {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: "RoutingState!B2",
    valueInputOption: "RAW",
    requestBody: { values: [[assignmentResult.routing_pointer_after]] }
  });
}

timing.sheets_write_pointer_ms = Date.now() - t0;

t0 = Date.now();

const row = [
  leadId,                                // lead_id
  client.client_id,                      // client_id
  nowUtc,                                // created_timestamp
  leadPayload.source_system || "",       // source_system
  leadPayload.source_detail || "",       // source_detail
  leadPayload.full_name || "",           // full_name
  leadPayload.email || "",               // email
  leadPayload.phone || "",               // phone
  JSON.stringify(leadPayload),           // inbound_payload_json
  "",                                    // normalized_payload_json
  "",                                    // hardening_status
  "",                                    // idempotency_status
  intakeValidation.validation_status,    // validation_status
  client.routing_strategy,               // routing_decision
  "WEIGHTED_INTERLEAVED",                // routing_reason
  assignmentResult.assigned_agent_id,    // assigned_agent_id
  nowUtc,                                // assigned_timestamp
  "FALSE",                               // contacted_flag
  "",                                    // contact_timestamp
  "NEW",                                 // lead_status
  nowUtc,                                // last_updated_timestamp
  "",                                    // notes
  trace_id,                              // trace_id
  "",                                    // reminder_claimed_ts_utc
  intakeValidation.validation_reason,    // validation_reason
  String(intakeValidation.spam_score),   // spam_score
  "",                                    // token_call_now
  "",                                    // token_ack_later
  "",                                    // token_reassign
  "",                                    // token_outcome_contacted
  "",                                    // token_outcome_no_answer
  "",                                    // token_outcome_reassign
  "TRUE",                                // tokens_active
  "FALSE",                               // acknowledged
  "",                                    // ack_timestamp
  "",                                    // ack_agent_id
  "FALSE",                               // contact_attempt_started
  "",                                    // contact_attempt_started_ts
  "",                                    // contact_outcome
  "FALSE",                               // reassign_requested
  "",                                    // reassign_requested_ts
  "",                                    // token_invalidated_ts
  "",                                    // attempted_agent_ids
  "0",                                   // reassignment_count
  "1",                                   // assignment_attempt_count
  "FALSE",                               // reassignment_pending
  "",                                    // reassignment_reason
  "",                                    // reassignment_requested_ts_utc
  "",                                    // reassigned_from_agent_id
  "",                                    // last_reassignment_ts_utc
  nowUtc,                                // assignment_ts_utc
  "",                                    // reassignment_status
  "FALSE",                               // admin_escalation_required
  "",                                    // admin_escalation_ts_utc
  "",                                    // last_reassignment_reason
  "0",                                   // non_response_reassignment_count
  "",                                    // admin_escalation_reason
  "",                                    // token_contacted_appt_set
  "",                                    // token_contacted_not_interested
  "0",                                   // no_answer_attempt_count
  nowUtc,                                // scenario_started_ts_utc
  "",                                    // scenario_ended_ts_utc
  ...identityValues(assignmentIdentity)
];

const leadLogObserved = await reconcileIntakeCreate({
  context: routingContinuationContext,
  step: "LEAD_LOG",
  sheets,
  spreadsheetId: leadDataSpreadsheetId,
  range: "LeadLog_Active!A1:BO10000",
  match: value => value.lead_id === leadId,
  exact: value => value.client_id === client.client_id &&
    value.assigned_agent_id === assignmentResult.assigned_agent_id &&
    value.lead_status === "NEW" && value.trace_id === trace_id &&
    value.lifecycle_id === assignmentIdentity.lifecycle_id &&
    value.assignment_id === assignmentIdentity.assignment_id &&
    value.owner_epoch_id === assignmentIdentity.owner_epoch_id &&
    value.policy_snapshot_id === assignmentIdentity.policy_snapshot_id,
  evidence: value => ({ lead_id: value.lead_id, row_number: value._row_number }),
  create: async () => sheets.spreadsheets.values.append({
    spreadsheetId: leadDataSpreadsheetId,
    range: "LeadLog_Active!A1",
    valueInputOption: "RAW",
    requestBody: { values: [row] }
  })
});
const leadLogRowNumber = leadLogObserved?.evidence?.row_number || "";

await reconcileIntakeCreate({
  context: routingContinuationContext,
  step: "LEAD_INDEX",
  sheets,
  spreadsheetId: leadDataSpreadsheetId,
  range: "LeadIndex!A1:F10000",
  match: value => value.lead_id === leadId,
  exact: value => value.client_id === client.client_id && String(value.leadlog_row || "") === String(leadLogRowNumber),
  evidence: value => ({ lead_id: value.lead_id, row_number: value._row_number }),
  create: () => appendLeadIndexRow({
    sheets,
    spreadsheetId: leadDataSpreadsheetId,
    lead_id: leadId,
    leadlog_row: leadLogRowNumber,
    client_id: client.client_id,
    created_timestamp: nowUtc,
    last_updated_timestamp: nowUtc
  })
});

timing.sheets_write_leadlog_ms = Date.now() - t0;

t0 = Date.now();

const reminderRow = [
  trace_id,
  client.client_id,
  leadId,
  "", // token (not used at intake)
  client.lead_data_spreadsheet_id,
  assignmentResult.assigned_agent_id,
  "TRUE",
  nextActionDue,
  "REMINDER_1",
  "", // last_processed_ts_utc
  "", // notes
  "", // dispatch_claimed_ts_utc
  ...identityValues(assignmentIdentity)
];

await reconcileIntakeCreate({
  context: routingContinuationContext,
  step: "REMINDER",
  sheets,
  spreadsheetId: SHEET_ID,
  range: "ReminderQueue!A1:Z10000",
  match: value => value.lead_id === leadId && value.assignment_id === assignmentIdentity.assignment_id,
  exact: value => value.client_id === client.client_id &&
    value.assigned_agent_id === assignmentResult.assigned_agent_id &&
    value.next_action_due_ts_utc === nextActionDue && value.active_monitoring === "TRUE" &&
    value.trace_id === trace_id && value.lifecycle_id === assignmentIdentity.lifecycle_id,
  evidence: value => ({ assignment_id: value.assignment_id, row_number: value._row_number }),
  create: () => sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "ReminderQueue!A1",
    valueInputOption: "RAW",
    requestBody: { values: [reminderRow] }
  })
});

const actionLinks = await createInitialActionLinks({
  sheets,
  lead_id: leadId,
  client,
  assigned_agent_id: assignmentResult.assigned_agent_id,
  trace_id,
  assignment_identity: assignmentIdentity,
  planned_gateway: routingContinuationContext?.continuation?.plan,
  continuation_context: routingContinuationContext
});

await reconcileIntakeCreate({
  context: routingContinuationContext,
  step: "IDEMPOTENCY",
  sheets,
  spreadsheetId: leadDataSpreadsheetId,
  range: "Idempotency!A1:H10000",
  match: value => value.idempotency_key === idempotencyKey,
  exact: value => value.client_id === client.client_id && value.lead_id === leadId && value.source_token === sourceToken,
  evidence: value => ({ lead_id: value.lead_id, row_number: value._row_number }),
  create: () => appendIdempotencyRow({
    sheets,
    spreadsheetId: leadDataSpreadsheetId,
    idempotency_key: idempotencyKey,
    client_id: client.client_id,
    source_token: sourceToken,
    first_seen_timestamp: nowUtc,
    lead_id: leadId
  })
});

timing.sheets_write_reminderqueue_ms = Date.now() - t0;

const smsPayload = {
  to: assignedAgent?.agent_phone || "",
  message:
    `New EngagePriority lead assigned.\n\n` +
    `${actionLinks.INITIAL_RESPONSE_GATEWAY.public_url}`
};

console.log("intake_before_sms_send", {
  trace_id,
  lead_id: leadId,
  assigned_agent_id: assignmentResult.assigned_agent_id,
  phone: assignedAgent?.agent_phone || ""
});

if (directObligationStore) {
  directCommittedIntake = buildDirectCommittedIntake({
    leadPayload,
    trace_id,
    lead_id: leadId,
    client_id: client.client_id,
    assigned_agent_id: assignmentResult.assigned_agent_id,
    source_system,
    source_detail: source_primary_key_value,
    created_ts_utc: nowUtc,
    assignment_ts_utc: nowUtc,
    reminder_due_ts_utc: nextActionDue,
    sms_status: "NOT_ATTEMPTED",
    lifecycle_identity: assignmentIdentity
  });
  directCommittedIntake = {
    ...directCommittedIntake,
    action_link_count: Object.keys(actionLinks).length,
    sms_status: "NOT_ATTEMPTED",
    sms_error_code: "",
    sms_error_message: ""
  };
  await persistIntakeProjectionObligationBestEffort({
    obligationStore: directObligationStore,
    identity: directProjectionIdentity,
    phase: INTAKE_OBLIGATION_PHASE.CORE_COMMITTED_SMS_READY,
    trace_id,
    lead_id: leadId
  });
}

let smsResult;
try {
  if (routingContinuationContext) {
    const dispatched = await runAtMostOnceDispatch({
      store: routingContinuationContext.obligationStore,
      key: routingContinuationContext.operationKey,
      validate: createIntakeObligationValidator(routingContinuationContext),
      step: "SMS",
      dispatch: () => sendSmsIfEnabled(smsPayload),
      disabled: String(process.env.ENABLE_SMS_SEND || "").toLowerCase() !== "true"
    });
    if (dispatched.status === "AMBIGUOUS") {
      return { statusCode: 202, body: JSON.stringify({ status: "SMS_MANUAL_RECONCILIATION_REQUIRED", trace_id, lead_id: leadId }) };
    }
    smsResult = dispatched.result || { sent: false, reason: dispatched.evidence.provider_status };
  } else {
    smsResult = await sendSmsIfEnabled(smsPayload);
  }
} catch (error) {
  if (directCommittedIntake) {
    directCommittedIntake = {
      ...directCommittedIntake,
      sms_status: "FAILED",
      sms_error_code: String(error?.code || "SMS_PROVIDER_ERROR"),
      sms_error_message: String(error?.message || "SMS provider call failed")
    };
    await persistIntakeProjectionObligationBestEffort({
      obligationStore: directObligationStore,
      committedIntake: directCommittedIntake,
      phase: INTAKE_OBLIGATION_PHASE.PROJECTION_READY,
      trace_id,
      lead_id: leadId
    });
  }
  throw error;
}

const projectionTimestamp = new Date().toISOString();
const legacyCommittedIntake = {
  intake_commit_id: "",
  audit_evidence_complete: true,
  event_type: "NETLIFY_INTAKE_COMPLETED",
  trace_id,
  lead_id: leadId,
  client_id: client.client_id,
  assigned_agent_id: assignmentResult.assigned_agent_id,
  source_system,
  source_detail: source_primary_key_value,
  submitted_ts_utc: leadPayload.submitted_ts_utc || projectionTimestamp,
  created_ts_utc: projectionTimestamp,
  assignment_ts_utc: projectionTimestamp,
  leadlog_created: true,
  action_link_count: 3,
  reminder_created: true,
  reminder_next_action_type: "REMINDER_1",
  reminder_due_ts_utc: nextActionDue,
  sms_status: "ATTEMPTED",
  sms_sent_ts_utc: smsResult?.sent ? projectionTimestamp : null,
  sms_error_code: smsResult?.reason || null,
  sms_error_message: smsResult?.reason || null,
  status: "INTAKE_COMPLETED",
  lead_preview_full_name: leadPayload.full_name,
  lead_preview_phone_last4: (leadPayload.phone || "").slice(-4),
  lead_preview_email: leadPayload.email || "",
  ...assignmentIdentity
};

if (directCommittedIntake) {
  directCommittedIntake = {
    ...directCommittedIntake,
    sms_status: smsResult?.sent ? "SENT" : "NOT_ATTEMPTED",
    sms_sent_ts_utc: smsResult?.sent ? projectionTimestamp : "",
    sms_error_code: smsResult?.sent ? "" : "SMS_DISABLED",
    sms_error_message: smsResult?.reason || ""
  };
  await persistIntakeProjectionObligationBestEffort({
    obligationStore: directObligationStore,
    committedIntake: directCommittedIntake,
    phase: INTAKE_OBLIGATION_PHASE.PROJECTION_READY,
    trace_id,
    lead_id: leadId
  });
}

let postCommitProjection = null;

if (INTAKE_PROJECTION_MODE === "NETLIFY_DIRECT") {
  postCommitProjection = await runDirectIntakeProjection({
    sheets,
    committedIntake: directCommittedIntake,
    leadDataSpreadsheetId,
    obligationStore: directObligationStore
  });
} else if (INTAKE_PROJECTION_MODE === "LEGACY_MAKE") {
  if (routingContinuationContext) {
    const projectionDispatch = await runAtMostOnceDispatch({
      store: routingContinuationContext.obligationStore,
      key: routingContinuationContext.operationKey,
      validate: createIntakeObligationValidator(routingContinuationContext),
      step: "LEGACY_PROJECTION",
      dispatch: async () => {
        const result = await runLegacyMakeIntakeHandoff(legacyCommittedIntake);
        if (result?.repair_required) {
          const code = result?.error?.code || "LEGACY_MAKE_REJECTED";
          const error = new Error(code);
          error.code = code;
          error.result = result;
          error.safeToRetry = code !== "LEGACY_MAKE_SUBMISSION_FAILED";
          throw error;
        }
        return result;
      },
      evidenceFromResult: result => ({ status: result?.status || "UNKNOWN" }),
      establishGuard: isSmsDownstreamAuthorized,
      disabled: false
    });
    postCommitProjection = projectionDispatch.status === "PREREQUISITE_BLOCKED"
      ? projectionRepairRequired("LEGACY_MAKE_DOWNSTREAM_NOT_AUTHORIZED")
      : projectionDispatch.status === "AMBIGUOUS"
      ? projectionRepairRequired("LEGACY_MAKE_HANDOFF_AMBIGUOUS")
      : (projectionDispatch.result || { status: projectionDispatch.evidence.status });
  } else {
    postCommitProjection = await runLegacyMakeIntakeHandoff(legacyCommittedIntake);
  }
} else {
  postCommitProjection = projectionRepairRequired("INVALID_PROJECTION_MODE");
}

logProjectionResult({
  trace_id,
  lead_id: leadId,
  result: postCommitProjection,
  invocation: "POST_COMMIT"
});

await recordProjectionRepairEvent({
  sheets,
  client_id: client.client_id,
  lead_id: leadId,
  trace_id,
  result: postCommitProjection
});


timing.total_ms = Date.now() - startTotal;

return {
  statusCode: 200,
  body: JSON.stringify({
    status: "INTAKE_TEST_SUCCESS",
    trace_id,
    timing,
    client: {
      client_id: client.client_id,
      routing_strategy: routingStrategy
    },
    lead_preview: {
      lead_id: leadId,
      full_name: leadPayload.full_name || null,
      phone: leadPayload.phone || null,
      email: leadPayload.email || null
    },
    assignment: {
      assigned_agent_id: assignmentResult.assigned_agent_id,
      ...assignmentIdentity,
      routing_pointer_before: assignmentResult.routing_pointer_before,
      routing_pointer_after: assignmentResult.routing_pointer_after,
      cycle_length: assignmentResult.cycle_length,
      cycle_preview: assignmentResult.cycle_preview
    },
    action_links_preview: actionLinks,
    sms_payload_preview: smsPayload,
    sms_send_result: smsResult,
    post_commit_projection: postCommitProjection,
    message: smsResult.sent
  ? "Lead intake path completed. SMS was sent."
  : "Lead intake path completed. SMS was not sent."
  })
};

} catch (error) {
return {
statusCode: 500,
body: JSON.stringify({
status: "INTAKE_TEST_ERROR",
error: error.message,
stack: error.stack
})
};
}
};

function parseLeadPayload(event) {
if (!event.body) {
return {};
}

try {
return JSON.parse(event.body);
} catch (error) {
throw new Error("Invalid JSON payload received by intake-lead function.");
}
}

function rowsToObjects(rows) {
const headers = rows[0] || [];

return rows.slice(1).map(row => {
const obj = {};
headers.forEach((header, index) => {
obj[header] = row[index];
});
return obj;
});
}

function getCoordinatedRoutingState({ headers, routingStates, clientId }) {
  const required = [
    "client_id", "routing_state_version", "routing_pointer", "last_assigned_agent_id",
    "last_assignment_timestamp", "total_assignments_today", "notes", "updated_ts_utc"
  ];
  const missing = required.filter(header => !headers.includes(header));
  if (missing.length) throw new Error(`RoutingState is missing required coordinated headers: ${missing.join(", ")}`);
  const matches = routingStates.filter(row => String(row.client_id || "").trim() === String(clientId).trim());
  if (matches.length !== 1) throw new Error(`RoutingState must contain exactly one row for client_id ${clientId}; found ${matches.length}.`);
  const row = { ...matches[0] };
  for (const field of ["routing_state_version", "routing_pointer", "total_assignments_today"]) {
    if (!/^\d+$/.test(String(row[field] ?? ""))) throw new Error(`RoutingState ${field} must be a nonnegative integer.`);
    row[field] = Number(row[field]);
    if (!Number.isSafeInteger(row[field])) throw new Error(`RoutingState ${field} exceeds the safe integer range.`);
  }
  // Run the normative projection validator before the row is used for a decision.
  routingStateFingerprint(row);
  return row;
}

function getClientServiceWindowStatus(client, now = new Date()) {
  const timezone =
    String(client.primary_timezone || "").trim();

  const businessStart =
    String(client.business_day_start_time || "").trim();

  const businessEnd =
    String(client.business_day_end_time || "").trim();

  const activeDays =
    String(client.business_days_active || "").trim().toUpperCase();

  const offHoursReleaseMode =
    String(client.off_hours_release_mode || "").trim().toUpperCase();

  if (!timezone) {
    throw new Error(`Missing primary_timezone for client_id: ${client.client_id}`);
  }

  if (!businessStart || !businessEnd) {
    throw new Error(`Missing business hours for client_id: ${client.client_id}`);
  }

  if (!activeDays) {
    throw new Error(`Missing business_days_active for client_id: ${client.client_id}`);
  }

  const localParts =
    getLocalDateTimeParts(now, timezone);

  const currentDayToken =
    localParts.weekday.toUpperCase().slice(0, 3);

  const activeDayTokens =
    activeDays
      .split("|")
      .map(day => day.trim().toUpperCase())
      .filter(Boolean);

  const isActiveDay =
    activeDayTokens.includes(currentDayToken);

  const currentMinutes =
    localParts.hour * 60 + localParts.minute;

  const startMinutes =
    parseBusinessTimeToMinutes(businessStart);

  const endMinutes =
    parseBusinessTimeToMinutes(businessEnd);

  const isWithinTimeWindow =
    startMinutes <= endMinutes
      ? currentMinutes >= startMinutes && currentMinutes < endMinutes
      : currentMinutes >= startMinutes || currentMinutes < endMinutes;

  const isOpen =
    isActiveDay && isWithinTimeWindow;

  return {
    is_open: isOpen,
    release_mode: offHoursReleaseMode,
    timezone,
    local_day: currentDayToken,
    local_time: `${String(localParts.hour).padStart(2, "0")}:${String(localParts.minute).padStart(2, "0")}`,
    business_day_start_time: businessStart,
    business_day_end_time: businessEnd,
    business_days_active: activeDays
  };
}

function getLocalDateTimeParts(date, timezone) {
  const formatter =
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });

  const parts =
    formatter.formatToParts(date);

  const values = {};

  parts.forEach(part => {
    values[part.type] = part.value;
  });

  return {
    weekday: values.weekday,
    hour: parseInt(values.hour, 10),
    minute: parseInt(values.minute, 10)
  };
}

function parseBusinessTimeToMinutes(value) {
  const raw =
    String(value || "").trim();

  const match =
    raw.match(/^(\d{1,2}):(\d{2})$/);

  if (!match) {
    throw new Error(`Invalid business time format: ${value}`);
  }

  const hour =
    parseInt(match[1], 10);

  const minute =
    parseInt(match[2], 10);

  if (
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new Error(`Invalid business time value: ${value}`);
  }

  return hour * 60 + minute;
}

function routeByStrategy({ routing_strategy, agents, routing_pointer }) {
const normalizedStrategy = String(routing_strategy || "").trim();

if (normalizedStrategy === "WEIGHTED_INTERLEAVED") {
return routeWeightedInterleaved({
agents,
routing_pointer
});
}

throw new Error(`Unsupported routing_strategy: ${normalizedStrategy}`);
}

function executeAssignment(args) {
  if (intakeTestRuntime?.onAssignmentExecution) {
    intakeTestRuntime.onAssignmentExecution(args);
  }
  return routeByStrategy(args);
}

function routeWeightedInterleaved({ agents, routing_pointer }) {
const activeAgents = agents.filter(agent => {
return String(agent.agent_status || "").trim() === "ACTIVE";
});

if (activeAgents.length === 0) {
throw new Error("No ACTIVE agents available for WEIGHTED_INTERLEAVED routing.");
}

const sortedAgents = [...activeAgents].sort((a, b) => {
return parseInt(a.priority_slot, 10) - parseInt(b.priority_slot, 10);
});

const weights = sortedAgents.map(agent => {
const weight = parseInt(agent.assignment_weight, 10);

if (!Number.isFinite(weight) || weight <= 0) {
  throw new Error(`Invalid assignment_weight for agent_id ${agent.agent_id}: ${agent.assignment_weight}`);
}

return weight;

});

const reducedDivisor = weights.reduce((currentGcd, weight) => {
return gcd(currentGcd, weight);
});

const remainingCounts = sortedAgents.map((agent, index) => {
return {
agent,
remaining: weights[index] / reducedDivisor
};
});

const cycle = [];

while (remainingCounts.some(item => item.remaining > 0)) {
for (const item of remainingCounts) {
if (item.remaining > 0) {
cycle.push(item.agent);
item.remaining -= 1;
}
}
}

const routingPointerBefore = routing_pointer % cycle.length;
const assignedAgent = cycle[routingPointerBefore];
const routingPointerAfter = routingPointerBefore + 1 >= cycle.length ? 0 : routingPointerBefore + 1;

return {
assigned_agent_id: assignedAgent.agent_id,
routing_pointer_before: routingPointerBefore,
routing_pointer_after: routingPointerAfter,
cycle_length: cycle.length,
cycle_preview: cycle.map(agent => agent.agent_id),
active_agents_count: activeAgents.length
};
}

function gcd(a, b) {
let x = Math.abs(a);
let y = Math.abs(b);

while (y !== 0) {
const temp = y;
y = x % y;
x = temp;
}

return x;
}

const SMS_COMPLIANCE_FOOTER =
  "\n\nReply STOP to opt out. Reply HELP for help.";

function appendSmsComplianceFooter(message) {
  const normalizedMessage =
    String(message || "");

  if (
    normalizedMessage.includes("Reply STOP to opt out.") ||
    normalizedMessage.includes("Reply HELP for help.")
  ) {
    return normalizedMessage;
  }

  return `${normalizedMessage}${SMS_COMPLIANCE_FOOTER}`;
}

async function sendSmsIfEnabled({ to, message }) {
  const enabled = isSmsSendingEnabled();

  const finalMessage =
    appendSmsComplianceFooter(message);

  if (!enabled) {
    return {
      sent: false,
      reason: "SMS sending disabled (ENABLE_SMS_SEND != true)",
      final_message: finalMessage
    };
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_PHONE;

  if (!accountSid || !authToken || !from) {
    if (!intakeTestRuntime?.smsSender) {
      throw new Error("Missing Twilio environment variables.");
    }
  }

  if (intakeTestRuntime?.smsSender) {
    return intakeTestRuntime.smsSender({
      body: finalMessage,
      from,
      to
    });
  }

  const client = twilio(accountSid, authToken);

  const result = await client.messages.create({
    body: finalMessage,
    from,
    to
  });

  return {
    sent: true,
    sid: result.sid,
    final_message: finalMessage
  };
}

function isSmsSendingEnabled() {
  return String(process.env.ENABLE_SMS_SEND || "").toLowerCase() === "true";
}

function generateLeadId() {
  const timestampPart = Date.now().toString(36).toUpperCase();
  const randomPart = randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();

  return `L-${timestampPart}-${randomPart}`;
}

function generateShortCode() {
  return randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase();
}

async function getIntakeObligationStore() {
  if (intakeTestRuntime?.obligationStore) {
    return intakeTestRuntime.obligationStore;
  }
  if (!intakeObligationStorePromise) {
    intakeObligationStorePromise = createNetlifyIntakeObligationStore();
  }
  return intakeObligationStorePromise;
}

function buildDirectCommittedIntake({
  leadPayload,
  trace_id,
  lead_id,
  client_id,
  assigned_agent_id,
  source_system,
  source_detail,
  created_ts_utc,
  assignment_ts_utc,
  reminder_due_ts_utc,
  sms_status,
  lifecycle_identity
}) {
  return {
    intake_commit_id: "",
    audit_evidence_complete: true,
    event_type: "NETLIFY_INTAKE_COMPLETED",
    trace_id,
    lead_id,
    client_id,
    assigned_agent_id,
    source_system,
    source_detail,
    submitted_ts_utc: leadPayload.submitted_ts_utc || "",
    created_ts_utc,
    assignment_ts_utc,
    leadlog_created: true,
    action_link_count: 1,
    reminder_created: true,
    reminder_next_action_type: "REMINDER_1",
    reminder_due_ts_utc,
    sms_status,
    sms_sent_ts_utc: "",
    sms_error_code: "",
    sms_error_message: "",
    status: "INTAKE_COMPLETED",
    lead_preview_full_name: leadPayload.full_name || "",
    lead_preview_phone_last4: String(leadPayload.phone || "").slice(-4),
    lead_preview_email: leadPayload.email || "",
    ...(lifecycle_identity || {})
  };
}

async function persistIntakeProjectionObligation({
  obligationStore,
  identity,
  committedIntake,
  phase
}) {
  if (!Object.values(INTAKE_OBLIGATION_PHASE).includes(phase)) {
    const error = new Error(`Unsupported intake obligation phase: ${phase}`);
    error.code = "INVALID_INTAKE_OBLIGATION_PHASE";
    throw error;
  }

  const evidence = committedIntake || identity;
  const eventId = deriveIntakeLifecycleEventId(evidence);
  const isProjectionReady = phase === INTAKE_OBLIGATION_PHASE.PROJECTION_READY;

  if (isProjectionReady && committedIntake?.audit_evidence_complete !== true) {
    const error = new Error("Projection-ready obligation requires complete audit evidence.");
    error.code = "INVALID_PROJECTION_READY_EVIDENCE";
    throw error;
  }

  const obligation = {
    schema_version: 2,
    event_id: eventId,
    phase,
    client_id: String(evidence.client_id || ""),
    lead_id: String(evidence.lead_id || ""),
    trace_id: String(evidence.trace_id || ""),
    updated_ts_utc: new Date().toISOString(),
    lifecycle_id: String(evidence.lifecycle_id || ""),
    assignment_id: String(evidence.assignment_id || ""),
    assignment_sequence: evidence.assignment_sequence || "",
    owner_epoch_id: String(evidence.owner_epoch_id || ""),
    agent_id_snapshot: String(evidence.agent_id_snapshot || ""),
    policy_snapshot_id: String(evidence.policy_snapshot_id || "")
  };

  if (isProjectionReady) {
    obligation.committed_intake = committedIntake;
  }

  await withBoundedRetry(
    () => obligationStore.set(eventId, obligation),
    { maxRetries: 2, baseDelayMs: 25 }
  );
  return obligation;
}

async function persistIntakeProjectionObligationBestEffort({
  obligationStore,
  identity,
  committedIntake,
  phase,
  trace_id,
  lead_id
}) {
  try {
    return await persistIntakeProjectionObligation({
      obligationStore,
      identity,
      committedIntake,
      phase
    });
  } catch (error) {
    console.log("intake_projection_obligation_update_error", {
      trace_id,
      lead_id,
      phase,
      error_code: error?.code || "OBLIGATION_UPDATE_FAILED"
    });
    return null;
  }
}

function recoverProjectionReadyIntake(obligation) {
  if (!obligation) {
    return { recoverable: false, committed_intake: null, error_code: "" };
  }

  if (obligation.phase !== INTAKE_OBLIGATION_PHASE.PROJECTION_READY) {
    return {
      recoverable: false,
      committed_intake: null,
      error_code: "OBLIGATION_PHASE_NOT_PROJECTION_READY"
    };
  }

  if (obligation.schema_version !== 2) {
    return {
      recoverable: false,
      committed_intake: null,
      error_code: "PROJECTION_READY_SCHEMA_INVALID"
    };
  }

  if (
    !obligation.committed_intake ||
    obligation.committed_intake.audit_evidence_complete !== true
  ) {
    return {
      recoverable: false,
      committed_intake: null,
      error_code: "PROJECTION_READY_EVIDENCE_INVALID"
    };
  }

  return {
    recoverable: true,
    committed_intake: obligation.committed_intake,
    error_code: ""
  };
}

function projectionNotApplicable(reason) {
  return {
    core_intake_status: "COMMITTED",
    status: "PROJECTION_NOT_APPLICABLE",
    repair_required: false,
    lifecycle: { status: "NOT_APPLICABLE" },
    audit: { status: "NOT_APPLICABLE" },
    reason
  };
}

function projectionRepairRequired(code, details = {}) {
  return {
    core_intake_status: "COMMITTED",
    status: "PROJECTION_REPAIR_REQUIRED",
    repair_required: true,
    lifecycle: details.lifecycle || { status: "UNKNOWN" },
    audit: details.audit || { status: "UNKNOWN" },
    error: {
      code: String(code || "PROJECTION_ERROR")
    }
  };
}

function logProjectionResult({ trace_id, lead_id, result, invocation }) {
  console.log("intake_post_commit_projection", {
    trace_id,
    lead_id,
    invocation,
    mode: INTAKE_PROJECTION_MODE,
    status: result?.status || "UNKNOWN",
    repair_required: Boolean(result?.repair_required),
    lifecycle_status: result?.lifecycle?.status || "UNKNOWN",
    audit_status: result?.audit?.status || "UNKNOWN",
    error_code:
      result?.error?.code ||
      result?.lifecycle?.error?.code ||
      result?.audit?.error?.code ||
      ""
  });
}

async function recordProjectionRepairEvent({
  sheets,
  client_id,
  lead_id,
  trace_id,
  result
}) {
  if (!result?.repair_required) {
    return;
  }

  const repairCode =
    result?.error?.code ||
    result?.lifecycle?.error?.code ||
    result?.audit?.error?.code ||
    "PROJECTION_REPAIR_REQUIRED";

  try {
    await appendSystemEvent({
      sheets,
      event_id: randomUUID(),
      event_timestamp: new Date().toISOString(),
      client_id,
      event_type: "INTAKE_PROJECTION_REPAIR_REQUIRED",
      reference_id: lead_id,
      severity: "WARN",
      message: `Post-commit intake projection requires repair: ${repairCode}`,
      source_module: "netlify-intake-lead",
      processed_flag: "FALSE",
      trace_id
    });
  } catch (error) {
    console.log("intake_projection_repair_event_error", {
      trace_id,
      lead_id,
      error_code: error?.code || "SYSTEM_EVENT_WRITE_FAILED"
    });
  }
}

async function runLegacyMakeIntakeHandoff(committedIntake) {
  if (!MAKE_INTAKE_HANDOFF_WEBHOOK_URL) {
    return projectionRepairRequired("LEGACY_MAKE_WEBHOOK_NOT_CONFIGURED", {
      lifecycle: { status: "LEGACY_MAKE_NOT_SUBMITTED" },
      audit: { status: "LEGACY_MAKE_NOT_SUBMITTED" }
    });
  }

  const payload = {
    event_type: committedIntake.event_type,
    trace_id: committedIntake.trace_id,
    lead_id: committedIntake.lead_id,
    client_id: committedIntake.client_id,
    assigned_agent_id: committedIntake.assigned_agent_id,
    lifecycle_id: committedIntake.lifecycle_id || "",
    assignment_id: committedIntake.assignment_id || "",
    assignment_sequence: committedIntake.assignment_sequence || "",
    owner_epoch_id: committedIntake.owner_epoch_id || "",
    agent_id_snapshot: committedIntake.agent_id_snapshot || "",
    policy_snapshot_id: committedIntake.policy_snapshot_id || "",
    source_system: committedIntake.source_system,
    source_detail: committedIntake.source_detail,
    submitted_ts_utc: committedIntake.submitted_ts_utc,
    created_ts_utc: committedIntake.created_ts_utc,
    assignment_ts_utc: committedIntake.assignment_ts_utc,
    leadlog_created: committedIntake.leadlog_created,
    action_link_count: committedIntake.action_link_count,
    reminder_created: committedIntake.reminder_created,
    reminder_next_action_type: committedIntake.reminder_next_action_type,
    reminder_due_ts_utc: committedIntake.reminder_due_ts_utc,
    sms_status: committedIntake.sms_status,
    sms_sent_ts_utc: committedIntake.sms_sent_ts_utc,
    sms_error_code: committedIntake.sms_error_code,
    sms_error_message: committedIntake.sms_error_message,
    status: committedIntake.status,
    lead_preview: {
      full_name: committedIntake.lead_preview_full_name,
      phone_last4: committedIntake.lead_preview_phone_last4,
      email: committedIntake.lead_preview_email
    }
  };

  try {
    const response = await fetch(MAKE_INTAKE_HANDOFF_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      return projectionRepairRequired(`LEGACY_MAKE_HTTP_${response.status}`, {
        lifecycle: { status: "LEGACY_MAKE_SUBMISSION_UNCONFIRMED" },
        audit: { status: "LEGACY_MAKE_SUBMISSION_UNCONFIRMED" }
      });
    }

    return {
      core_intake_status: "COMMITTED",
      status: "LEGACY_MAKE_SUBMITTED",
      repair_required: false,
      lifecycle: { status: "DELEGATED_TO_LEGACY_MAKE" },
      audit: { status: "DELEGATED_TO_LEGACY_MAKE" }
    };
  } catch (error) {
    return projectionRepairRequired("LEGACY_MAKE_SUBMISSION_FAILED", {
      lifecycle: { status: "LEGACY_MAKE_SUBMISSION_UNCONFIRMED" },
      audit: { status: "LEGACY_MAKE_SUBMISSION_UNCONFIRMED" }
    });
  }
}

function findObjectByField(rows, field, value) {
  if (!rows.length) {
    return null;
  }

  const objects = rowsToObjects(rows);
  const expected = String(value || "").trim();
  return objects.find(row => String(row[field] || "").trim() === expected) || null;
}

async function loadCommittedIntakeByLeadId({ sheets, spreadsheetId, lead_id }) {
  const rows = await readSheetRows(
    sheets,
    spreadsheetId,
    "LeadLog_Active!A1:ZZ10000"
  );
  const lead = findObjectByField(rows, "lead_id", lead_id);

  if (!lead) {
    return null;
  }

  const leadStatus = String(lead.lead_status || "").trim().toUpperCase();
  const assignedAgentId = String(lead.assigned_agent_id || "").trim();

  if (leadStatus === "PENDING_RELEASE" || !assignedAgentId) {
    return {
      projection_applicable: false,
      reason: "AFTER_HOURS_HELD_LEAD"
    };
  }

  return {
    projection_applicable: true,
    committed_intake: {
      intake_commit_id: "",
      audit_evidence_complete: false,
      event_type: "NETLIFY_INTAKE_COMPLETED",
      trace_id: lead.trace_id,
      lead_id: lead.lead_id,
      client_id: lead.client_id,
      assigned_agent_id: lead.assigned_agent_id,
      lifecycle_id: lead.lifecycle_id || "",
      assignment_id: lead.assignment_id || "",
      assignment_sequence: lead.assignment_sequence || "",
      owner_epoch_id: lead.owner_epoch_id || "",
      agent_id_snapshot: lead.agent_id_snapshot || "",
      policy_snapshot_id: lead.policy_snapshot_id || "",
      source_system: lead.source_system,
      source_detail: lead.source_detail,
      submitted_ts_utc: "",
      created_ts_utc: lead.created_timestamp,
      assignment_ts_utc: lead.assignment_ts_utc || lead.assigned_timestamp,
      leadlog_created: true,
      action_link_count: 0,
      reminder_created: false,
      reminder_next_action_type: "",
      reminder_due_ts_utc: "",
      sms_status: "",
      sms_sent_ts_utc: "",
      sms_error_code: "",
      sms_error_message: "",
      status: "INTAKE_COMPLETED",
      lead_preview_full_name: lead.full_name,
      lead_preview_phone_last4: String(lead.phone || "").slice(-4),
      lead_preview_email: lead.email
    }
  };
}

async function runDirectIntakeProjection({
  sheets,
  committedIntake,
  leadDataSpreadsheetId,
  obligationStore
}) {
  const lifecycleStore = {
    async findByEventId(eventId) {
      const rows = await readSheetRows(
        sheets,
        leadDataSpreadsheetId,
        "LeadLifecycleLog!A1:L10000"
      );
      return findObjectByField(rows, "event_id", eventId);
    },
    async append(eventRecord) {
      await appendLeadLifecycleEvent({
        sheets,
        spreadsheetId: leadDataSpreadsheetId,
        ...eventRecord
      });
    }
  };

  const auditStore = INTAKE_AUDIT_SPREADSHEET_ID ? {
    async findByLogicalIdentity(auditRecord) {
      const rows = await readSheetRows(
        sheets,
        INTAKE_AUDIT_SPREADSHEET_ID,
        "NetlifyIntakeAudit!A1:X10000"
      );

      if (!rows.length) {
        return null;
      }

      return rowsToObjects(rows).find(row =>
        String(row.event_type || "").trim() === auditRecord.event_type &&
        String(row.trace_id || "").trim() === auditRecord.trace_id &&
        String(row.lead_id || "").trim() === auditRecord.lead_id
      ) || null;
    },
    async append(auditRecord) {
      const orderedRecord = buildIntakeAuditRecord(auditRecord);
      await sheets.spreadsheets.values.append({
        spreadsheetId: INTAKE_AUDIT_SPREADSHEET_ID,
        range: "NetlifyIntakeAudit!A1",
        valueInputOption: "RAW",
        requestBody: {
          values: [[
            orderedRecord.event_type,
            orderedRecord.trace_id,
            orderedRecord.lead_id,
            orderedRecord.client_id,
            orderedRecord.assigned_agent_id,
            orderedRecord.source_system,
            orderedRecord.source_detail,
            orderedRecord.submitted_ts_utc,
            orderedRecord.created_ts_utc,
            orderedRecord.assignment_ts_utc,
            orderedRecord.leadlog_created,
            orderedRecord.action_link_count,
            orderedRecord.reminder_created,
            orderedRecord.reminder_next_action_type,
            orderedRecord.reminder_due_ts_utc,
            orderedRecord.sms_status,
            orderedRecord.sms_sent_ts_utc,
            orderedRecord.sms_error_code,
            orderedRecord.sms_error_message,
            orderedRecord.status,
            orderedRecord.lead_preview_full_name,
            orderedRecord.lead_preview_phone_last4,
            orderedRecord.lead_preview_email,
            orderedRecord.ingested_by_make_ts_utc
          ]]
        }
      });
    }
  } : null;

  try {
    const auditEvidenceComplete = committedIntake.audit_evidence_complete !== false;

    if (!auditEvidenceComplete) {
      const lifecycleOnlyResult = await projectCommittedIntake({
        committedIntake,
        lifecycleStore,
        auditStore: null,
        auditRequired: false
      });

      if (lifecycleOnlyResult.lifecycle.status === "REPAIR_REQUIRED") {
        return lifecycleOnlyResult;
      }

      if (auditStore) {
        const existingAudit = await auditStore.findByLogicalIdentity(
          buildIntakeAuditRecord(committedIntake)
        );
        if (existingAudit) {
          return {
            ...lifecycleOnlyResult,
            status: "PROJECTION_ALREADY_COMMITTED",
            repair_required: false,
            audit: { status: "ALREADY_COMMITTED" }
          };
        }
      }

      return projectionRepairRequired("AUDIT_REPAIR_EVIDENCE_INCOMPLETE", {
        lifecycle: lifecycleOnlyResult.lifecycle,
        audit: { status: "REPAIR_REQUIRED" }
      });
    }

    const result = await projectCommittedIntake({
      committedIntake,
      lifecycleStore,
      auditStore,
      auditRequired: true
    });

    if (!result.repair_required && obligationStore) {
      try {
        await obligationStore.delete(result.event_id);
      } catch (error) {
        console.log("intake_projection_obligation_delete_error", {
          trace_id: committedIntake.trace_id,
          lead_id: committedIntake.lead_id,
          error_code: error?.code || "OBLIGATION_DELETE_FAILED"
        });
      }
    }

    return result;
  } catch (error) {
    return projectionRepairRequired(error?.code || "DIRECT_PROJECTION_FAILED");
  }
}

function isRetryableSheetsReadError(error) {
  const status = error?.response?.status || error?.code || error?.status;
  const message = String(error?.message || "").toLowerCase();

  return status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    message.includes("quota exceeded") ||
    message.includes("rate limit") ||
    message.includes("read requests per minute");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withSheetsReadRetry(operation, { maxRetries = 2, baseDelayMs = 250 } = {}) {
  let attempt = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxRetries || !isRetryableSheetsReadError(error)) {
        throw error;
      }

      await sleep(baseDelayMs * Math.pow(2, attempt));
      attempt++;
    }
  }
}

async function createInitialActionLinks({
  sheets,
  lead_id,
  client,
  assigned_agent_id,
  trace_id,
  assignment_identity,
  planned_gateway,
  continuation_context
}) {
  const gatewayContexts = ["INITIAL_RESPONSE_GATEWAY"];

  const created_ts_utc = planned_gateway?.created_ts_utc || new Date().toISOString();

  const results = {};
  const rowsToInsert = [];

  for (const gateway_context of gatewayContexts) {
    const short_code = generateShortCode();
    const public_url = `https://engagepriority.com/a/${short_code}`;
    const gatewayIdentity = planned_gateway?.gateway_id
      ? { ...assignment_identity, gateway_id: planned_gateway.gateway_id }
      : createGatewayIdentity(assignment_identity);

    results[gateway_context] = {
      short_code,
      token: short_code,
      public_url,
      gateway_id: gatewayIdentity.gateway_id
    };

    rowsToInsert.push([
      short_code,
      public_url,
      gateway_context,
      "",
      lead_id,
      client.client_id,
      client.lead_data_spreadsheet_id,
      assigned_agent_id,
      "", // expires_ts_utc
      "TRUE",
      created_ts_utc,
      "", // used_ts_utc
      "", // notes
      "", // deactivated_ts_utc
      "",  // deactivation_reason
      trace_id, // trace_id
      ...identityValues(gatewayIdentity),
      gatewayIdentity.gateway_id,
      "", // action_attempt_id (created on a fresh gateway action)
      ""  // operational_action_record_id (Make-owned)
    ]);
  }

  console.log("intake_before_actionlinkmap_write", {
    trace_id,
    lead_id,
    client_id: client.client_id,
    assigned_agent_id,
    action_count: gatewayContexts.length
  });

  const observed = await reconcileIntakeCreate({
    context: continuation_context,
    step: "ACTION_LINK",
    sheets,
    spreadsheetId: ACTION_LINK_MAP_SHEET_ID,
    range: "ActionLinkMap!A1:Y10000",
    match: value => value.gateway_id === results.INITIAL_RESPONSE_GATEWAY.gateway_id ||
      value.short_code === results.INITIAL_RESPONSE_GATEWAY.short_code,
    exact: value => value.lead_id === lead_id && value.client_id === client.client_id &&
      value.assigned_agent_id === assigned_agent_id &&
      value.gateway_id === results.INITIAL_RESPONSE_GATEWAY.gateway_id && value.assignment_id === assignment_identity.assignment_id,
    evidence: value => ({ gateway_id: value.gateway_id, row_number: value._row_number }),
    create: () => sheets.spreadsheets.values.append({
      spreadsheetId: ACTION_LINK_MAP_SHEET_ID,
      range: "ActionLinkMap!A:Y",
      valueInputOption: "RAW",
      requestBody: { values: rowsToInsert }
    })
  });

  if (observed?.row) {
    results.INITIAL_RESPONSE_GATEWAY.short_code = observed.row.short_code;
    results.INITIAL_RESPONSE_GATEWAY.token = observed.row.short_code;
    results.INITIAL_RESPONSE_GATEWAY.public_url = observed.row.public_url;
  }

  return results;
}

function createIntakeObligationValidator(context) {
  return (record, key) => validateRoutingObligation({
    record,
    key,
    environment: context.config.environment,
    logicalReference: context.logicalReference,
    verifyResponse: context.coordinationClient.verify
  });
}

async function reconcileIntakeCreate({ context, step, sheets, spreadsheetId, range, match, exact, evidence, create }) {
  if (!context) {
    const result = await create();
    const updatedRange = result?.data?.updates?.updatedRange || "";
    const rowMatch = updatedRange.match(/![A-Z]+(\d+):/);
    return { state: "EXACT", evidence: { row_number: rowMatch ? Number(rowMatch[1]) : 0 } };
  }
  const inspect = async () => {
    const rows = await readSheetRows(sheets, spreadsheetId, range);
    const objects = rowsToObjects(rows);
    return inspectUniqueRows(objects, {
      match,
      exact,
      evidence: value => evidence
        ? evidence({ ...value, _row_number: objects.indexOf(value) + 2 })
        : { row_number: objects.indexOf(value) + 2 }
    });
  };
  return reconcileCreateStep({
    store: context.obligationStore,
    key: context.operationKey,
    validate: createIntakeObligationValidator(context),
    step,
    inspect,
    create,
    afterCreate: intakeTestRuntime?.afterRoutingConsequenceCreate
  });
}

function buildIdempotencyKey(clientId, email, phone) {
  return [
    String(clientId || "").trim(),
    String(email || "").trim().toLowerCase(),
    String(phone || "").trim()
  ].join("|");
}

function findRowIndexByColumnValue(rows, columnName, value) {
  const headers = rows[0] || [];
  const columnIndex = headers.indexOf(columnName);

  if (columnIndex === -1) {
    throw new Error(`Missing required column: ${columnName}`);
  }

  return rows.findIndex((row, index) => {
    return index > 0 && String(row[columnIndex] || "").trim() === String(value || "").trim();
  });
}

async function readSheetRows(sheets, spreadsheetId, range) {
  const res = await withSheetsReadRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId,
    range
  }));

  return res.data.values || [];
}

async function appendLeadLifecycleEvent({
  sheets,
  spreadsheetId,
  event_id,
  event_ts_utc,
  client_id,
  lead_id,
  trace_id,
  event_type,
  event_stage,
  event_source,
  assigned_agent_id,
  gateway_context,
  selected_action,
  notes
}) {
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "LeadLifecycleLog!A1",
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        event_id,
        event_ts_utc,
        client_id,
        lead_id,
        trace_id,
        event_type,
        event_stage,
        event_source,
        assigned_agent_id || "",
        gateway_context || "",
        selected_action || "",
        notes || ""
      ]]
    }
  });
}

async function appendIdempotencyRow({ sheets, spreadsheetId, idempotency_key, client_id, source_token, first_seen_timestamp, lead_id }) {
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "Idempotency!A1",
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        idempotency_key,
        client_id,
        source_token,
        first_seen_timestamp,
        "",
        lead_id,
        "ACTIVE",
        ""
      ]]
    }
  });
}

async function appendLeadIndexRow({ sheets, spreadsheetId, lead_id, leadlog_row, client_id, created_timestamp, last_updated_timestamp }) {
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "LeadIndex!A1",
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        lead_id,
        leadlog_row,
        client_id,
        created_timestamp,
        last_updated_timestamp,
        "ACTIVE"
      ]]
    }
  });
}

async function appendReleaseQueueRow({
  sheets,
  release_id,
  client_id,
  lead_id,
  release_due_ts_utc,
  release_reason,
  created_ts_utc,
  notes,
  lifecycle_identity
}) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "ReleaseQueue!A1",
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        release_id,          // release_id
        client_id,           // client_id
        lead_id,             // lead_id
        "",                  // agent_id
        release_due_ts_utc,  // release_due_ts_utc
        release_reason,      // release_reason
        "FALSE",             // contacted_flag
        "",                  // contact_timestamp
        "0",                 // followup_attempts
        "0",                 // escalation_level
        "",                  // last_notification_timestamp
        "PENDING",           // status
        created_ts_utc,      // created_ts_utc
        "",                  // released_ts_utc
        "0",                 // release_attempts
        "",                  // release_result
        "",                  // assigned_agent_id
        notes || "",         // notes
        "",                  // dispatch_claimed_ts_utc
        lifecycle_identity?.lifecycle_id || "",
        lifecycle_identity?.policy_snapshot_id || ""
      ]]
    }
  });
}

function normalizeWebsiteLead(payload) {
const fullNameRaw = String(payload.full_name || "").trim();
const full_name = fullNameRaw || "New Lead";

const nameParts = full_name.split(/\s+/).filter(Boolean);
const first_name = nameParts[0] || "";
const last_name = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "";

const email = String(payload.email || "").trim().toLowerCase();

const phoneRaw = String(payload.phone || "").trim();
const digits = phoneRaw.replace(/\D/g, "");

let phone = "";

if (digits.length === 10) {
phone = `+1${digits}`;
} else if (digits.length === 11 && digits.startsWith("1")) {
phone = `+${digits}`;
} else if (phoneRaw.startsWith("+") && digits.length >= 10) {
phone = `+${digits}`;
}

return {
...payload,
full_name,
first_name,
last_name,
email,
phone
};
}

function validateWebsiteLeadForIntake(lead) {
const name = String(lead.full_name || "").trim().toLowerCase();
const email = String(lead.email || "").trim().toLowerCase();
const phone = String(lead.phone || "").trim().toLowerCase();
const source = String(lead.source_system || "").trim().toLowerCase();
const sourceDetail = String(lead.source_detail || lead.intake_client_reference || "").trim().toLowerCase();

let spam_score = 0;
const reasons = [];
let hard_reject = false;

const digits = phone.replace(/\D/g, "");
const nationalDigits = digits.length === 11 && digits.startsWith("1")
  ? digits.slice(1)
  : digits;
let phone_usable = false;

if (nationalDigits && nationalDigits.length === 10) {
phone_usable = true;

if (/^(\d)\1+$/.test(nationalDigits)) {
  spam_score += 35;
  reasons.push("repeated_digit_phone");
  hard_reject = true;
}

if (
  nationalDigits === "1234567890" ||
  nationalDigits === "0123456789" ||
  nationalDigits === "1111111111" ||
  nationalDigits === "2222222222" ||
  nationalDigits === "5555555555"
) {
  spam_score += 35;
  reasons.push("fake_phone_pattern");
  hard_reject = true;
}
}

const fakeNamePatterns = ["test", "asdf", "qwerty", "demo", "fake", "sample", "na", "n/a", "unknown"];

if (name && name.length >= 3 && fakeNamePatterns.some(p => name.includes(p))) {
spam_score += 25;
reasons.push("fake_or_test_name");
}

const disposableEmailPatterns = ["mailinator", "tempmail", "10minutemail", "guerrillamail", "trashmail"];

let email_usable = false;

if (email && email.includes("@")) {
email_usable = true;

if (disposableEmailPatterns.some(p => email.includes(p))) {
  spam_score += 35;
  reasons.push("disposable_email");
}

if (email.startsWith("test@") || email.includes("+test")) {
  spam_score += 20;
  reasons.push("test_email_pattern");
}

}

if (!email_usable && !phone_usable) {
spam_score += 100;
reasons.push("no_usable_contact");
hard_reject = true;
}

const spamTerms = ["crypto", "bitcoin", "seo", "backlink", "casino", "loan", "viagra", "forex"];
const combinedText = `${name} ${email} ${source} ${sourceDetail}`.toLowerCase();

if (/https?:\/\//.test(combinedText) || combinedText.includes("www.")) {
spam_score += 25;
reasons.push("url_detected");
}

if (spamTerms.some(term => combinedText.includes(term))) {
spam_score += 25;
reasons.push("spam_keyword");
}

if (/(.)\1{4,}/.test(combinedText)) {
spam_score += 15;
reasons.push("repeated_characters");
}

let validation_status = "VALID";

if (spam_score >= 61) {
validation_status = "INVALID";
} else if (spam_score >= 31) {
validation_status = "SUSPECT";
}

const validation_reason =
reasons.length > 0 ? reasons.slice(0, 3).join("|") : "passed_validation_checks";

return {
validation_status,
validation_reason,
spam_score,
hard_reject
};
}

async function appendSystemEvent({ sheets, event_id, event_timestamp, client_id, event_type, reference_id, severity, message, source_module, processed_flag, trace_id }) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "SystemEvents!A1",
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        event_id,
        event_timestamp,
        client_id,
        event_type,
        reference_id,
        severity,
        message,
        source_module,
        processed_flag,
        trace_id
      ]]
    }
  });
}

exports._test = {
  INTAKE_OBLIGATION_PHASE,
  buildDirectCommittedIntake,
  loadCommittedIntakeByLeadId,
  persistIntakeProjectionObligation,
  projectionNotApplicable,
  recoverProjectionReadyIntake,
  recordProjectionRepairEvent,
  appendReleaseQueueRow,
  createInitialActionLinks,
  runDirectIntakeProjection,
  runLegacyMakeIntakeHandoff,
  setRuntime(runtime) {
    intakeTestRuntime = runtime;
    intakeObligationStorePromise = null;
  }
};
