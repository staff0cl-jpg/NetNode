import crypto from "crypto";

/** In-memory credential: plaintext if no key, else AES-256-GCM sealed. */
export type PasswordMaterial =
  | { kind: "plain"; value: string }
  | { kind: "sealed"; payload: string };

const KDF_SALT = "netnode-cred-v1";

function deriveKey(): Buffer | null {
  const key = process.env.NETNODE_CREDENTIALS_KEY?.trim();
  if (!key || key.length < 8) return null;
  return crypto.scryptSync(key, KDF_SALT, 32);
}

/** Store operator-supplied password for later SSH use (memory only in current design). */
export function materialFromUserPassword(plain: string): PasswordMaterial {
  const dk = deriveKey();
  if (!dk) return { kind: "plain", value: plain };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", dk, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, enc]).toString("base64");
  return { kind: "sealed", payload: `g1:${payload}` };
}

export function readPasswordMaterial(m: PasswordMaterial): string {
  if (m.kind === "plain") return m.value;
  const dk = deriveKey();
  if (!dk) {
    throw new Error("NETNODE_CREDENTIALS_KEY is missing or too short; cannot decrypt sealed credentials");
  }
  const b64 = m.payload.startsWith("g1:") ? m.payload.slice(3) : m.payload;
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 12 + 16) throw new Error("Invalid sealed credential payload");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", dk, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
