import assert from "node:assert/strict";
import test from "node:test";
import { evaluateInventoryWarnings } from "./warnings.js";

test("unreachable device yields critical warning", () => {
  const w = evaluateInventoryWarnings({ isReachable: false, cpuLoad: 10, trunkDownCount: 0 });
  assert.equal(w.severity, "critical");
});

test("healthy device has no warning", () => {
  const w = evaluateInventoryWarnings({ isReachable: true, cpuLoad: 10, trunkDownCount: 0 });
  assert.equal(w.severity, "none");
});
