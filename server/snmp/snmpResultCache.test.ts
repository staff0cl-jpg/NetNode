import test from "node:test";
import assert from "node:assert/strict";
import { cachedSnmpWalk, clearSnmpResultCaches, readSnmpResultCacheTtlMs } from "./snmpResultCache.js";

test("readSnmpResultCacheTtlMs is 0 when unset", () => {
  const prev = process.env.NETNODE_SNMP_RESULT_CACHE_TTL_MS;
  delete process.env.NETNODE_SNMP_RESULT_CACHE_TTL_MS;
  assert.equal(readSnmpResultCacheTtlMs(), 0);
  process.env.NETNODE_SNMP_RESULT_CACHE_TTL_MS = prev;
});

test("cachedSnmpWalk returns cached value within TTL", async () => {
  clearSnmpResultCaches();
  const prev = process.env.NETNODE_SNMP_RESULT_CACHE_TTL_MS;
  process.env.NETNODE_SNMP_RESULT_CACHE_TTL_MS = "60000";
  let runs = 0;
  const v1 = await cachedSnmpWalk(60_000, "k1", async () => {
    runs += 1;
    return { a: "1" };
  });
  const v2 = await cachedSnmpWalk(60_000, "k1", async () => {
    runs += 1;
    return { a: "2" };
  });
  assert.equal(v1.a, "1");
  assert.equal(v2.a, "1");
  assert.equal(runs, 1);
  process.env.NETNODE_SNMP_RESULT_CACHE_TTL_MS = prev;
  clearSnmpResultCaches();
});

test("cachedSnmpWalk does not cache empty walks", async () => {
  clearSnmpResultCaches();
  let runs = 0;
  await cachedSnmpWalk(60_000, "k-empty", async () => {
    runs += 1;
    return {};
  });
  await cachedSnmpWalk(60_000, "k-empty", async () => {
    runs += 1;
    return {};
  });
  assert.equal(runs, 2);
});
