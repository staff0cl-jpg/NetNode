import assert from "node:assert/strict";
import test from "node:test";
import { discoveryStartBodySchema } from "./discovery.js";

test("discovery start body accepts valid payload", () => {
  const r = discoveryStartBodySchema.safeParse({
    subnets: "10.0.0.0/24",
    protocol: "snmp",
    city: "City",
    zone: "Core",
    branch: "ULN",
  });
  assert.equal(r.success, true);
  if (r.success) assert.equal(r.data.subnets, "10.0.0.0/24");
});

test("discovery start body rejects empty subnets", () => {
  const r = discoveryStartBodySchema.safeParse({ subnets: "   " });
  assert.equal(r.success, false);
});

test("discovery start body rejects invalid subnet tokens", () => {
  const r = discoveryStartBodySchema.safeParse({ subnets: "not-a-cidr" });
  assert.equal(r.success, false);
});

test("discovery start body accepts single host ipv4", () => {
  const r = discoveryStartBodySchema.safeParse({ subnets: "10.0.0.1" });
  assert.equal(r.success, true);
});
