"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { handler, _test } = require("../netlify/functions/control-tower-data");

test("preserves authentication by rejecting a request without a session cookie", async () => {
  const response = await handler({ httpMethod: "GET", headers: {}, queryStringParameters: {} });
  assert.equal(response.statusCode, 401);
});

test("preserves exact client-scope comparison", () => {
  assert.equal(_test.sameClient({ client_id: "C-1" }, "C-1"), true);
  assert.equal(_test.sameClient({ client_id: "C-2" }, "C-1"), false);
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
