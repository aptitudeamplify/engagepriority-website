const { randomUUID } = require("crypto");

const LIFECYCLE_IDENTITY_FIELDS = Object.freeze([
  "lifecycle_id",
  "assignment_id",
  "assignment_sequence",
  "owner_epoch_id",
  "agent_id_snapshot",
  "policy_snapshot_id"
]);

const GATEWAY_IDENTITY_FIELDS = Object.freeze([
  ...LIFECYCLE_IDENTITY_FIELDS,
  "gateway_id",
  "action_attempt_id",
  "operational_action_record_id"
]);

function newDurableId(prefix, uuidFactory = randomUUID) {
  return `${prefix}_${uuidFactory()}`;
}

function createLifecycleIdentity({ leadId, uuidFactory = randomUUID }) {
  const lifecycleId = String(leadId || "").trim();
  if (!lifecycleId) throw new Error("leadId is required for lifecycle identity");
  return {
    lifecycle_id: lifecycleId,
    policy_snapshot_id: newDurableId("ps", uuidFactory)
  };
}

function createAssignmentIdentity({ lifecycleIdentity, assignedAgentId, assignmentSequence = 1, uuidFactory = randomUUID }) {
  const sequence = Number(assignmentSequence);
  const agentId = String(assignedAgentId || "").trim();
  if (!lifecycleIdentity?.lifecycle_id || !lifecycleIdentity?.policy_snapshot_id) {
    throw new Error("complete lifecycle identity is required for assignment creation");
  }
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error("assignmentSequence must be a positive integer");
  if (!agentId) throw new Error("assignedAgentId is required for assignment creation");
  return {
    ...lifecycleIdentity,
    assignment_id: newDurableId("as", uuidFactory),
    assignment_sequence: sequence,
    owner_epoch_id: newDurableId("oe", uuidFactory),
    // Canonical meaning: the immutable value of the assigned canonical agent_id,
    // not a new snapshot-record identifier and not a mutable lookup reference.
    agent_id_snapshot: agentId
  };
}

function createReplacementAssignmentIdentity({ currentIdentity, assignedAgentId, uuidFactory = randomUUID }) {
  const currentSequence = Number(currentIdentity?.assignment_sequence);
  if (!Number.isInteger(currentSequence) || currentSequence < 1) {
    throw new Error("current assignment_sequence is required for replacement assignment");
  }
  return createAssignmentIdentity({
    lifecycleIdentity: {
      lifecycle_id: currentIdentity.lifecycle_id,
      policy_snapshot_id: currentIdentity.policy_snapshot_id
    },
    assignedAgentId,
    assignmentSequence: currentSequence + 1,
    uuidFactory
  });
}

function createGatewayIdentity(assignmentIdentity, uuidFactory = randomUUID) {
  requireCompleteAssignmentIdentity(assignmentIdentity);
  return {
    ...assignmentIdentity,
    gateway_id: newDurableId("gw", uuidFactory)
  };
}

function createActionAttemptId(uuidFactory = randomUUID) {
  return newDurableId("aa", uuidFactory);
}

function requireCompleteAssignmentIdentity(identity) {
  for (const field of LIFECYCLE_IDENTITY_FIELDS) {
    if (identity?.[field] === undefined || identity?.[field] === null || String(identity[field]).trim() === "") {
      throw new Error(`missing lifecycle identity field: ${field}`);
    }
  }
  const sequence = Number(identity.assignment_sequence);
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error("invalid assignment_sequence");
  return identity;
}

function identityValues(identity, fields = LIFECYCLE_IDENTITY_FIELDS) {
  return fields.map(field => identity?.[field] ?? "");
}

module.exports = {
  LIFECYCLE_IDENTITY_FIELDS,
  GATEWAY_IDENTITY_FIELDS,
  createLifecycleIdentity,
  createAssignmentIdentity,
  createReplacementAssignmentIdentity,
  createGatewayIdentity,
  createActionAttemptId,
  requireCompleteAssignmentIdentity,
  identityValues
};
