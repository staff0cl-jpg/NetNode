import assert from "node:assert/strict";
import crypto from "crypto";
import test from "node:test";
import {
  LEGACY_G1_KDF_SALT,
  isLegacyG1SealedMaterial,
  materialFromUserPassword,
  materialFromUserPasswordSync,
  readPasswordMaterial,
  readPasswordMaterialSync,
  reSealCredentialMaterialIfLegacyG1,
  type PasswordMaterial,
} from "./credentialMaterial.js";

const STRONG_KEY = "k".repeat(32);
const LEGACY_KEY = "legacy-8-chars-min";

function sealLegacyG1Payload(key: string, plain: string): PasswordMaterial {
  const dk = crypto.scryptSync(key, LEGACY_G1_KDF_SALT, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", dk, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const raw = Buffer.concat([iv, tag, enc]);
  return { kind: "sealed", payload: raw.toString("base64") };
}

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
  process.env.NETNODE_CREDENTIALS_KEY = LEGACY_KEY;
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

test("legacy g1 sealed material migrates to g2 when key is strong", async () => {
  process.env.NETNODE_CREDENTIALS_KEY = STRONG_KEY;
  try {
    const g1 = sealLegacyG1Payload(STRONG_KEY, "old-secret");
    assert.ok(isLegacyG1SealedMaterial(g1));
    assert.equal(await readPasswordMaterial(g1), "old-secret");
    const upgraded = await reSealCredentialMaterialIfLegacyG1(g1);
    assert.ok(upgraded.kind === "sealed" && upgraded.payload.startsWith("g2:"));
    assert.equal(await readPasswordMaterial(upgraded), "old-secret");
    assert.equal(isLegacyG1SealedMaterial(upgraded), false);
  } finally {
    delete process.env.NETNODE_CREDENTIALS_KEY;
  }
});
