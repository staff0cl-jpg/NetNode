import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, verifyLocalPassword } from "./password.js";
import type { LocalUser } from "./types.js";

test("local password hash verifies", () => {
  const h = hashPassword("secret123");
  const user: LocalUser = { id: "1", username: "u", role: "admin", lastLogin: "-", passwordHash: h };
  assert.equal(verifyLocalPassword(user, "secret123"), true);
  assert.equal(verifyLocalPassword(user, "wrong"), false);
});
