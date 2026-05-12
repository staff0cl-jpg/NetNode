import crypto from "crypto";

/** Same format as `hashPassword` in server.ts (scrypt). */
export function hashPasswordForSetup(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}
