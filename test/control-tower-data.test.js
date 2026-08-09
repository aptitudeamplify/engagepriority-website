"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { handler, _test } = require("../netlify/functions/control-tower-data");
const escalationDetail = require("../netlify/functions/control-tower-escalation-detail");

test("preserves authentication by rejecting a request without a session cookie", async () => {
  const response = await handler({ httpMethod: "GET", headers: {}, queryStringParameters: {} });
  assert.equal(response.statusCode, 401);
});

test("preserves exact client-scope comparison", () => {
  assert.equal(_test.sameClient({ client_id: "C-1" }, "C-1"), true);
  assert.equal(_test.sameClient({ client_id: "C-2" }, "C-1"), false);
});

test("returns only a masked phone presentation value", () => {
  assert.equal(_test.maskPhoneDisplay("+1 (713) 555-0142"), "(713) ***-0142");
  assert.equal(_test.maskPhoneDisplay(""), null);
  assert.equal(_test.maskPhoneDisplay("not-a-phone"), null);
  assert.equal(_test.maskPhoneDisplay("713-0142"), null);
  assert.equal(_test.maskPhoneDisplay("call 713-555-0142"), null);
});

test("public lead record never returns the complete raw phone", () => {
  const rawPhone = "+1 (713) 555-0142";
  const record = _test.deriveLeadRecord({
    leadRow: {
      lead_id: "L-PRIVATE",
      client_id: "C-1",
      created_timestamp: "2026-08-09T14:00:00.000Z",
      full_name: "Private Lead",
      phone: rawPhone
    },
    agentsById: new Map(),
    reminders: [],
    releases: [],
    actionLinks: [],
    lifecycleEvents: [],
    clientTimezone: "America/Chicago",
    nowMs: Date.parse("2026-08-09T15:00:00.000Z")
  });

  assert.equal(record.phone_display, "(713) ***-0142");
  assert.equal(Object.hasOwn(record, "phone"), false);
  assert.equal(JSON.stringify(record).includes(rawPhone), false);
});

test("protected escalation detail remains authenticated", async () => {
  const response = await escalationDetail.handler({
    httpMethod: "GET",
    headers: {},
    queryStringParameters: { lead_id: "L-PRIVATE" }
  });
  assert.equal(response.statusCode, 401);
});

test("returns complete active work beyond 20 records and orders oldest first within lifecycle", () => {
  const records = Array.from({ length: 25 }, (_, index) => ({
    _sort: { lifecycle_order: 3, received_ms: 25 - index, due_ms: 0 },
    _filter: { is_closed: false },
    lead_id: `L-${index}`
  }));
  const result = _test.sortLeadRecords(records);
  assert.equal(result.length, 25);
  assert.equal(result[0].lead_id, "L-24");
  assert.equal(result[24].lead_id, "L-0");
});
