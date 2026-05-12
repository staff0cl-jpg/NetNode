import assert from "node:assert/strict";
import test from "node:test";
import {
  materialFromUserPassword,
  materialFromUserPasswordSync,
  readPasswordMaterial,
  readPasswordMaterialSync,
} from "./credentialMaterial.js";

const STRONG_KEY = "k".repeat(32);

test("plain material when NETNODE_CREDENTIALS_KEY is unset", async () => {
  delete process.env.NETNODE_CREDENTIALS_KEY;
  const m = await materialFromUserPassword("secret");
  assert.equal(m.kind, "plain");
  assert.equal(await readPasswordMaterial(m), "secret");
});

test("g2 round-trip when NETNODE_CREDENTIALS_KEY is strong (>= 32 bytes)", async () => {
  process.env.NETNODE_CREDENTIALS_KEY = STRONG_KEY;
  try {
    const m = await materialFromUserPassword("p@ss w0rd!");
    assert.equal(m.kind, "sealed");
    assert.ok(m.payload.startsWith("g2:"));
    assert.equal(await readPasswordMaterial(m), "p@ss w0rd!");
    assert.equal(readPasswordMaterialSync(m), "p@ss w0rd!");
  } finally {
    delete process.env.NETNODE_CREDENTIALS_KEY;
  }
});

test("materialFromUserPasswordSync matches async for strong key", async () => {
  process.env.NETNODE_CREDENTIALS_KEY = STRONG_KEY;
  try {
    const a = await materialFromUserPassword("x");
    const b = materialFromUserPasswordSync("x");
    assert.equal(a.kind, "sealed");
    assert.equal(b.kind, "sealed");
    assert.equal(await readPasswordMaterial(a), "x");
    assert.equal(readPasswordMaterialSync(b), "x");
  } finally {
    delete process.env.NETNODE_CREDENTIALS_KEY;
  }
});

test("short key (8–31 bytes) does not seal new material — stays plain", async () => {
  process.env.NETNODE_CREDENTIALS_KEY = "legacy-8-chars-min";
  try {
    const m = await materialFromUserPassword("secret");
    assert.equal(m.kind, "plain");
    assert.equal(await readPasswordMaterial(m), "secret");
    const s = materialFromUserPasswordSync("x");
    assert.equal(s.kind, "plain");
  } finally {
    delete process.env.NETNODE_CREDENTIALS_KEY;
  }
});
