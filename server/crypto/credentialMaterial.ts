import crypto from "crypto";
import { promisify } from "util";

/** In-memory credential: plaintext if no key, else AES-256-GCM sealed. */
export type PasswordMaterial =
  | { kind: "plain"; value: string }
  | { kind: "sealed"; payload: string };

const scryptAsync = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions
) => Promise<Buffer>;

const KDF_SALT_LEGACY = Buffer.from("netnode-cred-v1", "utf8");

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

function envCredentialsKey(): string {
  return process.env.NETNODE_CREDENTIALS_KEY?.trim() ?? "";
}

/** True if sealed or non-empty plaintext (does not decrypt sealed payloads). */
export function materialHasValue(m: PasswordMaterial): boolean {
  if (m.kind === "sealed") return m.payload.length > 0;
  return Boolean(m.value);
}

/** Minimum UTF-8 length for NETNODE_CREDENTIALS_KEY to enable strong (g2) sealing. */
const CREDENTIALS_KEY_MIN_STRONG_BYTES = 32;

/** Legacy minimum for g1 **decrypt only** (old sealed blobs). New credentials are never sealed with g1. */
const CREDENTIALS_KEY_MIN_LEGACY_BYTES = 8;

function keyMeetsStrong(): boolean {
  const key = envCredentialsKey();
  return Buffer.byteLength(key, "utf8") >= CREDENTIALS_KEY_MIN_STRONG_BYTES;
}

function keyMeetsLegacy(): boolean {
  const key = envCredentialsKey();
  return Buffer.byteLength(key, "utf8") >= CREDENTIALS_KEY_MIN_LEGACY_BYTES;
}

function deriveKeyG1Sync(): Buffer | null {
  const key = envCredentialsKey();
  if (!keyMeetsLegacy()) return null;
  return crypto.scryptSync(key, KDF_SALT_LEGACY, 32, SCRYPT_PARAMS);
}

async function deriveKeyG2(secret: string, salt: Buffer): Promise<Buffer> {
  return (await scryptAsync(secret, salt, 32, SCRYPT_PARAMS)) as Buffer;
}

async function sealG2(plain: string): Promise<PasswordMaterial> {
  const secret = envCredentialsKey();
  if (!keyMeetsStrong()) return { kind: "plain", value: plain };
  const salt = crypto.randomBytes(16);
  const dk = await deriveKeyG2(secret, salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", dk, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const raw = Buffer.concat([salt, iv, tag, enc]);
  return { kind: "sealed", payload: `g2:${raw.toString("base64")}` };
}

/**
 * Seals with per-payload scrypt salt + AES-GCM only when NETNODE_CREDENTIALS_KEY is ≥32 UTF-8 bytes (g2).
 * Shorter keys leave plaintext in RAM (no new fixed-salt g1 wrapping).
 */
export async function materialFromUserPassword(plain: string): Promise<PasswordMaterial> {
  if (keyMeetsStrong()) return sealG2(plain);
  return { kind: "plain", value: plain };
}

/** Sync seal for startup paths that cannot await (g2 only when key is strong). */
export function materialFromUserPasswordSync(plain: string): PasswordMaterial {
  if (keyMeetsStrong()) {
    const secret = envCredentialsKey();
    const salt = crypto.randomBytes(16);
    const dk = crypto.scryptSync(secret, salt, 32, SCRYPT_PARAMS);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", dk, iv);
    const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const raw = Buffer.concat([salt, iv, tag, enc]);
    return { kind: "sealed", payload: `g2:${raw.toString("base64")}` };
  }
  return { kind: "plain", value: plain };
}

function decryptG1Payload(b64: string): string {
  const dk = deriveKeyG1Sync();
  if (!dk) {
    throw new Error("NETNODE_CREDENTIALS_KEY is missing or too short; cannot decrypt legacy sealed credentials");
  }
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 12 + 16) throw new Error("Invalid sealed credential payload");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", dk, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

async function decryptG2Payload(b64: string): Promise<string> {
  const secret = envCredentialsKey();
  if (!keyMeetsStrong()) {
    throw new Error("NETNODE_CREDENTIALS_KEY must be at least 32 UTF-8 bytes to decrypt g2 sealed credentials");
  }
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 16 + 12 + 16) throw new Error("Invalid sealed credential payload");
  const salt = buf.subarray(0, 16);
  const iv = buf.subarray(16, 28);
  const tag = buf.subarray(28, 44);
  const enc = buf.subarray(44);
  const dk = await deriveKeyG2(secret, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", dk, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

export async function readPasswordMaterial(m: PasswordMaterial): Promise<string> {
  if (m.kind === "plain") return m.value;
  const p = m.payload;
  if (p.startsWith("g2:")) return decryptG2Payload(p.slice(3));
  const b64 = p.startsWith("g1:") ? p.slice(3) : p;
  return decryptG1Payload(b64);
}

/** Sync read for legacy g1 and g2 blobs (uses scryptSync for g2 — avoid on hot paths when possible). */
export function readPasswordMaterialSync(m: PasswordMaterial): string {
  if (m.kind === "plain") return m.value;
  const p = m.payload;
  if (p.startsWith("g2:")) {
    const secret = envCredentialsKey();
    if (!keyMeetsStrong()) {
      throw new Error("NETNODE_CREDENTIALS_KEY must be at least 32 UTF-8 bytes to decrypt g2 sealed credentials");
    }
    const buf = Buffer.from(p.slice(3), "base64");
    if (buf.length < 16 + 12 + 16) throw new Error("Invalid sealed credential payload");
    const salt = buf.subarray(0, 16);
    const iv = buf.subarray(16, 28);
    const tag = buf.subarray(28, 44);
    const enc = buf.subarray(44);
    const dk = crypto.scryptSync(secret, salt, 32, SCRYPT_PARAMS);
    const decipher = crypto.createDecipheriv("aes-256-gcm", dk, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  }
  const b64 = p.startsWith("g1:") ? p.slice(3) : p;
  return decryptG1Payload(b64);
}
