import assert from "node:assert/strict";
import test from "node:test";
import { createUserBodySchema, loginBodySchema } from "./auth.js";

test("login body schema", () => {
  assert.equal(loginBodySchema.safeParse({ username: "a", password: "b" }).success, true);
  assert.equal(loginBodySchema.safeParse({ username: "", password: "b" }).success, false);
});

test("create user body schema", () => {
  const r = createUserBodySchema.safeParse({ username: "u", password: "p", role: "operator" });
  assert.equal(r.success, true);
});
