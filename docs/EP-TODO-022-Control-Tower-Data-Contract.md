# EP-TODO-022 Control Tower data contract

**Status:** Approved implementation contract

**Scope:** Current operational Control Tower presentation
**Analytics:** Deferred; the future reporting-period rule below is preserved

## Average Agent Response Time

Average Agent Response Time is the average elapsed time from the beginning of an agent assignment cycle to that agent's first valid explicit response action.

Qualifying explicit response actions are:

- `CALL_NOW`
- `REMIND_ME_5_MIN`
- `REASSIGN`

System-generated reminders and automated or system-driven reassignments are not agent response actions. `OUTCOME_REASSIGN` is an explicit reassignment for the Reassignments metric, but it is not an initial-response action and therefore does not start or complete an Avg. Response Time sample.

Each assignment begins a separate measurement cycle. A replacement agent starts a new clock when that replacement assignment becomes authoritative. Time from a prior agent's cycle is never attributed to the replacement agent.

Unresolved cycles are excluded until a qualifying action occurs. They are not treated as zero and their continuously increasing elapsed time is not included in the average.

### Operational populations

- Agent View: qualifying completed assignment cycles whose assignment-cycle start falls on the authenticated client's current local date, grouped by the agent that owned each cycle.
- Operational summary: all qualifying completed assignment cycles whose assignment-cycle start falls on the authenticated client's current local date.
- Analytics, when separately implemented: qualifying completed assignment cycles whose assignment-cycle start falls within the user-selected reporting period.

### Durable start and response evidence

The calculation uses durable assignment evidence, not notification delivery language:

- The current assignment cycle uses `LeadLog_Active.assignment_ts_utc`, with `assigned_timestamp` as the legacy-equivalent fallback.
- A lead released from the after-hours queue starts an assignment cycle at the `LeadLifecycleLog` `LEAD_RELEASED` event.
- A replacement assignment starts at the `LeadLifecycleLog` `LEAD_REASSIGNED` event, which is written with the replacement `assigned_agent_id` after the replacement assignment becomes authoritative.
- The initial in-hours intake writes `created_timestamp`, `assigned_timestamp`, and `assignment_ts_utc` from the same durable `nowUtc`. If later reassignment overwrites the current assignment fields, `created_timestamp` remains the durable first-cycle start for that established intake path.
- The first qualifying `LeadLifecycleLog` event from `INITIAL_RESPONSE_GATEWAY` and lifecycle stage `INITIAL RESPONSE` supplies the response action, responding agent, and response timestamp.

The client-facing label remains **Avg. Response Time**. The implementation does not claim that the start timestamp proves SMS receipt or delivery.

## Explicit Reassignments metric

Reassignments are counted from durable `LeadLifecycleLog` action events attributable to the selecting agent:

- `REASSIGN` from `INITIAL_RESPONSE_GATEWAY` and stage `INITIAL RESPONSE`
- `OUTCOME_REASSIGN` from `OUTCOME_GATEWAY` and stage `OUTCOME RESPONSE`

Processor events, reminder events, and automated/system-driven reassignment are excluded. The operational Agent View aggregation uses events on the authenticated client's current local date.

## Active lifecycle presentation mapping

The read-only presentation values are derived views and do not alter lifecycle authority.

| Durable condition | Active presentation |
|---|---|
| `admin_escalation_required` | Escalated to Admin |
| Pending `ReleaseQueue` row | Waiting for Business Hours |
| Initial cycle or `REMINDER_1`, including a fresh cycle after `NO_ANSWER` | New |
| `REMINDER_2` | Reminder Sent |
| Contact attempt started, `CALL_NOW`, or `OUTCOME_FOLLOW_UP` | Waiting for Outcome Response |
| `REMINDER_3` or `ESCALATION` queue work | At Risk |
| Closed record | Resolved, for history/detail only |

`No Answer Follow-up` and `Reassignment Pending` are not Control Tower lifecycle stages.

## Reassignment-pending transition evidence

The established Initial Response and Outcome Response scenarios set `reassignment_pending=TRUE` while retaining the prior `assigned_agent_id`. They deactivate the prior agent's actionable link and monitoring work. The Reassignment Processor later selects a replacement and performs one LeadLog update that writes the replacement `assigned_agent_id`, writes the new `assignment_ts_utc`, and clears `reassignment_pending` and the pending reassignment status.

Therefore, while the flag is true:

- the recorded agent is the prior, non-actionable agent;
- no replacement agent is yet authoritative;
- a Control Tower read can observe the interval because it reads the same durable LeadLog independently;
- the nominal interval is the next one-minute reassignment dispatch cycle plus Make processing time, with failures able to extend it;
- the response retains the active record for completeness but returns `lifecycle.presentation_ready=false`, a null lifecycle key/label, and `presentation_reason=AWAITING_AUTHORITATIVE_REASSIGNMENT`;
- presentation waits for the authoritative replacement and then renders the lead as New under that agent. No temporary or permanent lifecycle stage is introduced.

## Privacy and authority boundaries

The contract remains authenticated and client-scoped. It returns agent identity, initials fallback, active lead references, operational metrics, lifecycle presentation fields, and current service-window state. It does not add agent photos, expose broader contact information, or change administrator-resolution behavior.
