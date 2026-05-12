import assert from "node:assert/strict";
import test from "node:test";
import { materialFromUserPassword, readPasswordMaterial } from "./credentialMaterial.js";

test("plain material when NETNODE_CREDENTIALS_KEY is unset", () => {
  delete process.env.NETNODE_CREDENTIALS_KEY;
  const m = materialFromUserPassword("secret");
  assert.equal(m.kind, "plain");
  assert.equal(readPasswordMaterial(m), "secret");
});

test("sealed round-trip when NETNODE_CREDENTIALS_KEY is set", () => {
  process.env.NETNODE_CREDENTIALS_KEY = "test-secret-at-least-8-chars";
  try {
    const m = materialFromUserPassword("p@ss w0rd!");
    assert.equal(m.kind, "sealed");
    assert.equal(readPasswordMaterial(m), "p@ss w0rd!");
  } finally {
    delete process.env.NETNODE_CREDENTIALS_KEY;
  }
});
