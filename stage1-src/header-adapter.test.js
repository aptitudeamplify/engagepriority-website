"use strict";

const assert = require("assert");
const {
  Stage1SchemaError,
  buildHeaderIndex,
  rowToObject
} = require("./header-adapter");

const cases = [];
function test(id, fn) {
  try {
    fn();
    cases.push({ id, result: "PASS" });
  } catch (error) {
    cases.push({ id, result: "FAIL", error: error.message });
  }
}

test("HA-001 resolves reordered fields by name", () => {
  const mapped = rowToObject(
    ["client_id", "lead_id", "response_stage"],
    ["C-TEST-001", "L-TEST-001", "INITIAL_RESPONSE"],
    { required: ["lead_id", "client_id", "response_stage"] }
  );
  assert.strictEqual(mapped.lead_id, "L-TEST-001");
});

test("HA-002 rejects duplicate headers", () => {
  assert.throws(
    () => buildHeaderIndex(["lead_id", "lead_id"]),
    (error) => error instanceof Stage1SchemaError && error.code === "SCHEMA_DUPLICATE_HEADER"
  );
});

test("HA-003 rejects missing required headers", () => {
  assert.throws(
    () => buildHeaderIndex(["lead_id"], { required: ["client_id"] }),
    (error) => error.code === "SCHEMA_REQUIRED_HEADER_MISSING"
  );
});

test("HA-004 rejects unknown closed-schema headers", () => {
  assert.throws(
    () => buildHeaderIndex(["lead_id", "unknown"], { allowed: ["lead_id"] }),
    (error) => error.code === "SCHEMA_UNKNOWN_HEADER"
  );
});

test("HA-005 rejects blank headers", () => {
  assert.throws(
    () => buildHeaderIndex(["lead_id", ""]),
    (error) => error.code === "SCHEMA_BLANK_HEADER"
  );
});

const failed = cases.filter((item) => item.result === "FAIL");
const result = {
  result_schema_id: "EP020_STAGE1_NETLIFY_HEADER_ADAPTER_TEST_V1",
  total: cases.length,
  passed: cases.length - failed.length,
  failed: failed.length,
  final_status: failed.length ? "FAIL" : "PASS",
  cases
};

process.stdout.write(JSON.stringify(result, null, 2) + "\n");
if (failed.length) process.exit(1);
