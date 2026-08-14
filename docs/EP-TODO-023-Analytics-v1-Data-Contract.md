# EP-TODO-023 Analytics v1 Data Foundation Contract

Status: Gate 1 repository authority. Runtime measurement and client visibility are disabled.

This contract consolidates the approved corrected historical-data architecture, correction reattempt 2, and the accepted four-item delta. It governs repository-controlled schemas, event construction, signing, transport, and dormant Netlify boundary instrumentation. It does not activate Analytics, create Sheets, modify Make or GAS, or authorize a cutover.

## Product semantics

Client Overview uses the distinct-lead intake cohort. Its response metrics use only the lead's first actionable assignment. Actionability begins at synchronous provider acceptance of the actionable initial notification. The binding is immutable. A qualifying accepted `REASSIGN` remains that assignment's accepted response. Replacement assignments never replace this Client Overview result.

Lifecycle pathways count distinct affected leads independently for reassignment requested, reassignment completed, and administrator escalation reached. Indicators may overlap.

Agent Analytics includes every actionable assignment according to its own actionability timestamp. Activity is attributed only inside that assignment's ownership interval. Replacement assignments may appear. Administrator outcomes are never agent-attributed, and Agent Analytics contains no disposition or appointment attribution.

Client Overview dispositions are exactly:

- Appointment set: `CONTACTED_SET_APPOINTMENT`, `ADMIN_CONTACTED_APPOINTMENT_SET`
- Contacted, not interested: `CONTACTED_NOT_INTERESTED`, `ADMIN_CONTACTED_NOT_INTERESTED`
- Closed without a recorded contact outcome: `ADMIN_NO_ANSWER`, `ADMIN_NO_ACTION`
- Still active: affirmative open-lifecycle evidence only

Missing or conflicting evidence withholds the affected section. It cannot reduce a denominator, create a business category, or be approximated.

## Operational independence

Analytics cannot reject, roll back, alter, or delay an otherwise authoritative operational outcome. Replayable authoritative operational evidence is preferred. If an independent Analytics outbox cannot be persisted, the operational outcome still succeeds, but coverage cannot advance. The smallest available durable internal failure signal is required. Affected sections are withheld, and measurement enters `PAUSED` when an eligible interval is affected. Activation is prohibited for any producer whose loss cannot be detected or reconstructed from complete immutable authoritative evidence.

Netlify boundary hooks in Gate 1 are disabled by default. Enabling the switch without all provider bindings results in an Analytics-only failure and cannot affect the operational response.

## Physical structures

The exact ordered headers are exported as `PHYSICAL_HEADERS` from `netlify/functions/_shared/analytics-contract.js` for:

- Per-client `AnalyticsLedger`
- Central `AnalyticsMeasurementRegistry`
- Central `AnalyticsIntegrityEvents`
- Central `AnalyticsSubmissionObligations`
- Central `AnalyticsRetryAttempts`
- Central `AnalyticsSourceCoverage`
- Central `AnalyticsReplayNonces`

All structures except `AnalyticsReplayNonces` are protected and append-only with no deletion or in-place correction. The nonce tab permits owner-executed locked TTL cleanup only after its seven-day post-expiry retention boundary. Only the environment-specific GAS writer identity may write Analytics facts. UAT and Production are isolated.

The source-sequence uniqueness scope is exclusively:

```text
(environment, client_id, coverage_epoch_id, source_id, source_sequence)
```

A watermark is the highest contiguous committed sequence in this scope. It cannot advance over a gap, unknown result, unconfirmed obligation, exhausted retry, invalid reference, conflicting hash, incomplete batch, unverified producer, or paused interval.

## Canonical formats and closed values

The implementation uses UTF-8, Unicode NFC, UTC RFC 3339 timestamps with three fractional digits, integer durations, and RFC 8785-compatible key ordering for the approved integer-only JSON domain. Floating-point values, undefined members, duplicate JSON keys at transport parsing, and unknown enumeration values fail closed.

All closed enumerations are exported as `ENUMS`. The complete ledger `record_type` set is:

```text
LEAD_ACCEPTED
LIFECYCLE_OPENED
POLICY_SNAPSHOT_CAPTURED
AGENT_SNAPSHOT_CAPTURED
ASSIGNMENT_CREATED
GATEWAY_CREATED
NOTIFICATION_REQUESTED
NOTIFICATION_PROVIDER_ACCEPTED
NOTIFICATION_PROVIDER_REJECTED
DISPATCH_CLAIMED
PROCESSING_FAILED
ASSIGNMENT_ACTIONABLE
CLIENT_RESPONSE_ASSIGNMENT_BOUND
ACTION_ATTEMPT_REJECTED
AGENT_ACTION_ACCEPTED
INITIAL_RESPONSE_CLASSIFIED
NO_RESPONSE_CLASSIFIED
REASSIGNMENT_REQUESTED
REASSIGNMENT_COMPLETED
ASSIGNMENT_ENDED
OWNERSHIP_TRANSFERRED
ADMIN_ESCALATION_REACHED
ADMIN_RESOLUTION_ACCEPTED
DISPOSITION_RECORDED
DISPOSITION_SUPERSEDED
LIFECYCLE_CLOSED
BATCH_COMMIT
```

Unknown values require a later governed schema version; they are not mapped to generic categories.

## Identity, event keys, and facts

Immutable identities include environment, client, lifecycle, lead, assignment, assignment sequence, Client Overview response assignment, owner epoch, agent snapshot, policy snapshot, gateway, notification attempt, action attempt, reassignment, escalation, administrator resolution, source, source sequence, event, batch, coverage epoch, and cutover.

Event keys use:

```text
v1|environment|client_id|coverage_epoch_id|record_type|record-specific-transition
```

`netlify/functions/_shared/analytics-contract.js` provides the deterministic construction, required identifier validation, prohibited-data scan, scoped sequence validation, canonicalization, and SHA-256 fact hashing. A retry reuses the same event key, event time, source sequence, semantic payload, and fact hash.

The fact hash binds the semantic ledger fields and canonical payload. It excludes transport observation, ingestion time, batch placement, ledger sequence, and writer deployment metadata.

## Exclusive event authority

| Record family | Exclusive logical owner and durability boundary |
|---|---|
| Intake and lifecycle opening | Component that durably accepts the lead or opens the lifecycle |
| Policy and agent snapshots | Component that durably establishes the immutable snapshot association |
| Assignment and ownership | Component that durably creates, ends, or transfers the assignment/epoch |
| Gateway | Component that durably creates the gateway correlation |
| Notification request and synchronous result | Component making the Twilio request, after durable attempt creation and durable preservation of the synchronous provider result |
| Dispatch claim | Component that durably claims the operational queue or gateway row; never an accepted outcome |
| Rejected attempt | Action validator after durable rejection evidence |
| Accepted agent action | Make action processor only after operational effects are durably committed |
| Reassignment | Component durably requesting it; reassignment processor durably completing it |
| Escalation | Escalation processor after durable escalation state |
| Administrator resolution | Administrator outcome processor after authorization and durable acceptance |
| Agent disposition | Component durably accepting and applying the agent terminal outcome |
| Administrator disposition | Administrator outcome processor |
| Classification and immutable Client Overview binding | Analytics processor after all references and coverage prove the result |
| Batch commit | GAS Analytics writer after every declared member is valid and durable |

Physical bindings that cannot be proven from repository evidence remain pending the authorized Make/GAS/Twilio evidence package. The integrity reconciler may report or replay authoritative evidence but cannot invent it.

## Dispositions

`DISPOSITION_RECORDED` requires `disposition_origin`.

Agent origin requires the action attempt, assignment, assignment sequence, owner epoch, agent snapshot, `actor_type=AGENT`, and a reference to the matching `AGENT_ACTION_ACCEPTED`. Administrator origin requires the administrator resolution ID, administrator snapshot, `actor_type=ADMINISTRATOR`, and a reference to the matching `ADMIN_RESOLUTION_ACCEPTED`; all agent-attribution identifiers must be null.

Supersession is append-only and preserves both disposition facts and origins. Lifecycle closure references the effective nonsuperseded disposition.

## No-response proof

`NO_RESPONSE_CLASSIFIED` requires a committed `ASSIGNMENT_ENDED`, complete applicable producer coverage through its timestamp, no qualifying accepted action, no unresolved dispatch claim or action attempt, complete notification and intervention evidence, and valid assignment, owner-epoch, agent, and policy references. An open assignment remains pending even after a response deadline.

## Signed GAS transport

The canonical request body contains `auth` and the complete `request`. The signing object is the entire envelope except `auth.signature`. Consequently the signature binds every authentication field and the complete request, including contract/schema versions, request and batch identities, client, epoch, source, sequence bounds, payload hash, and payload.

```text
signature = BASE64URL_NO_PADDING(HMAC_SHA256(request_secret, JCS(signing_object)))
```

The complete response except `response_signature` is signed. Its fact hash binds the complete response except the signature and fact-hash fields. Response keys are uniquely scoped by:

```text
(environment, intended_issuer, authorized_source_id, response_key_id)
```

Cross-environment, cross-issuer, and cross-source response-secret sharing is prohibited. The client verifies the signature, response hash, key authorization, and every correlated request identifier. Invalid or ambiguous responses are `UNKNOWN_RESULT`.

Retries retain the request, batch, event, and source identities but use fresh authentication timestamps, nonce, and signature.

## Replay protection

GAS must atomically persist a hashed nonce under its environment-global lock before committing facts. Uniqueness is `(environment, issuer, key_id, nonce_hash)`. Auth-invalid or expired requests do not consume nonces. An accepted nonce remains consumed if later fact insertion fails. The nonce store fails closed. Key rotation does not shorten retention.

## Batch and coverage

One batch contains one environment, client, epoch, source, and contiguous source-sequence range. `batch_count` equals the range size. The GAS global lock covers nonce acceptance, duplicate/conflict lookup, sequence validation, ledger allocation, bulk append, reread, commit verification, and receipt construction. No external request occurs under the lock.

Readers consume only batches whose `BATCH_COMMIT` member count, ordered keys, ordered hashes, source bounds, ledger bounds, and member digest validate. Partial writes cannot advance coverage. An unresolved earlier partial batch blocks later client batches.

Each section requires complete coverage from every applicable producer through the reporting boundary. Exhausted retry, unknown result, or incomplete evidence withholds the section and may pause measurement. Reconciliation cannot manufacture history.

## Authentication and deployment

UAT and Production require separate GAS writer deployments, controlled owners, issuer allowlists, source authorizations, request/response keys, nonce stores, ledgers, control workbooks, and secrets. Requests are fail-closed for signature, issuer, environment, source, timestamp, nonce, schema, hash, reference, or batch failures. Secrets may exist only in approved Netlify, Make, or GAS secret facilities and are never committed.

## State and visibility governance

Allowed states are `DISABLED`, `SHADOW`, `READY`, `ACTIVE`, and `PAUSED`. Allowed transitions are:

- `DISABLED -> SHADOW`
- `SHADOW -> READY | DISABLED`
- `READY -> ACTIVE | SHADOW | DISABLED`
- `ACTIVE -> PAUSED`
- `PAUSED -> SHADOW`, or `READY` only with proven same-epoch continuity

Production activation order is mandatory:

1. Complete the READY evidence package.
2. Pass Max governance review.
3. Luis approves measurement activation and its effective boundary.
4. An authenticated governance request carrying both references atomically commits the cutover and `READY -> ACTIVE`.
5. Eligibility begins at that boundary.
6. Client visibility remains disabled until separate later Luis approval.

A material gap closes the prior coverage epoch and requires a new epoch, governed boundary, and cutover ID. Evidence remains preserved. Coverage is never inferred across a pause.

## Capacity activation gates

Google Sheets remains the proposed v1 store. Activation requires a measured 12-month forecast and these conservative limits: no more than 6,000,000 cells or 150,000 rows per client ledger; at least 40 percent forecast headroom; lock wait p95 at most 500 ms and p99 at most 2 seconds; writer p95 at most 2 seconds and p99 at most 5 seconds; committed receipt p95 at most 3 seconds and p99 at most 8 seconds; no exhausted retry; no incomplete batch older than five minutes; aggregation p95 at most five seconds and p99 at most ten seconds; deterministic pagination beyond 10,000 rows with pages no larger than 1,000; and a full integrity scan within 30 minutes at forecast volume.

Failure blocks activation and may trigger evaluation, but not implementation, of an external transactional store.

## Netlify Gate 1 configuration

Runtime instrumentation is disabled unless:

```text
ANALYTICS_INSTRUMENTATION_ENABLED=true
```

Later activation also requires all of:

```text
ANALYTICS_GAS_WRITER_URL
ANALYTICS_ENVIRONMENT
ANALYTICS_ISSUER
ANALYTICS_SOURCE_ID
ANALYTICS_REQUEST_KEY_ID
ANALYTICS_REQUEST_HMAC_SECRET
ANALYTICS_RESPONSE_KEY_ID
ANALYTICS_RESPONSE_HMAC_SECRET
ANALYTICS_TIMEOUT_MS (optional; default 1500)
```

Gate 1 does not add these variables or secrets to Production or UAT.

## Integration handoffs

Kayce must implement the exact physical tabs, protected-write rules, nonce transaction, complete request verification, scoped source sequence, batch commit/recovery, signed response, coverage and integrity structures, and state registry. Fixtures are in `test/fixtures/analytics/gas`.

Rip must bind each Make-owned canonical fact only after its documented operational durability boundary, provide complete immutable identifiers, allocate durable scoped source sequences, preserve submission obligations or replayable evidence, and reuse event identities on retry. Fixtures are in `test/fixtures/analytics/make`.

Provider identities, deployed scenario versions, GAS deployment IDs, Twilio synchronous fields, durable retries, exact source sequence allocation, and UAT/Production differences remain live-evidence bindings. Nothing in Gate 1 infers them.
