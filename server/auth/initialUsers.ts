import { hashPassword } from "./password.js";
import type { LocalUser } from "./types.js";

/**
 * Bootstrap local users before PostgreSQL hydrate.
 * - Prefer `NETNODE_INITIAL_ADMIN_PASSWORD` for any automated or production bootstrap.
 * - Without `DATABASE_URL`, the first-run wizard creates the admin (empty array here).
 * - Well-known dev accounts exist only when `NETNODE_ALLOW_INSECURE_DEV_USERS=1` and not production.
 */
export function createInitialUsers(): LocalUser[] {
  const users: LocalUser[] = [];
  const initialAdminPassword = process.env.NETNODE_INITIAL_ADMIN_PASSWORD?.trim();
  if (initialAdminPassword) {
    users.push({
      id: "1",
      username: process.env.NETNODE_INITIAL_ADMIN_USERNAME?.trim() || "admin",
      role: "admin",
      lastLogin: "-",
      passwordHash: hashPassword(initialAdminPassword),
    });
    return users;
  }

  if (!process.env.DATABASE_URL?.trim()) {
    console.warn(
      "[Security] No DATABASE_URL: complete the web first-run setup wizard, or set DATABASE_URL and NETNODE_INITIAL_ADMIN_PASSWORD."
    );
    return users;
  }

  const allowInsecureDev =
    process.env.NETNODE_ALLOW_INSECURE_DEV_USERS === "1" && process.env.NODE_ENV !== "production";
  if (allowInsecureDev) {
    console.warn(
      "[Security] NETNODE_ALLOW_INSECURE_DEV_USERS=1 — creating well-known dev accounts (admin/admin, operator_01/password). Remove for shared or staging systems."
    );
    users.push(
      { id: "1", username: "admin", role: "admin", lastLogin: "-", passwordHash: hashPassword("admin") },
      { id: "2", username: "operator_01", role: "operator", lastLogin: "-", passwordHash: hashPassword("password") }
    );
    return users;
  }

  console.warn(
    "[Security] DATABASE_URL is set without NETNODE_INITIAL_ADMIN_PASSWORD. Local users load from PostgreSQL after hydrate; for an empty DB set NETNODE_INITIAL_ADMIN_PASSWORD once, or unset DATABASE_URL and use the setup wizard."
  );
  return users;
}
