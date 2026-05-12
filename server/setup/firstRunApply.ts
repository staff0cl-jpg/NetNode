import { Pool } from "pg";
import { ensureSchema, upsertAppKv, APP_KV_KEYS } from "../persistence/postgres.js";
import type { NetNodeInstanceFile, NetNodePostgresConfig } from "./instanceFile.js";
import { buildPostgresUrl, writeInstanceFile, INSTANCE_FILE_VERSION } from "./instanceFile.js";
import { hashPasswordForSetup } from "./setupPassword.js";
import {
  DEFAULT_DISCOVERY_PROFILES_FOR_SETUP,
  DEFAULT_SNMP_TEMPLATES_FOR_SETUP,
  DEFAULT_SYSTEM_CONFIG_FOR_SETUP,
} from "./firstRunDefaults.js";

export type FirstRunApplyBody = {
  siteLabel?: string;
  productName?: string;
  postgres?: Partial<NetNodePostgresConfig>;
  amqpUrl?: string;
  adminUsername?: string;
  adminPassword?: string;
};

function validatePostgres(p: NetNodePostgresConfig): string | null {
  if (!String(p.host || "").trim()) return "PostgreSQL host is required.";
  if (!String(p.database || "").trim()) return "PostgreSQL database name is required.";
  if (!String(p.user || "").trim()) return "PostgreSQL user is required.";
  const port = Number(p.port);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return "PostgreSQL port must be between 1 and 65535.";
  return null;
}

export async function testPostgresConnection(postgres: NetNodePostgresConfig): Promise<{ ok: true } | { ok: false; error: string }> {
  const err = validatePostgres(postgres);
  if (err) return { ok: false, error: err };
  const url = buildPostgresUrl(postgres);
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 8000 });
  try {
    const c = await pool.connect();
    try {
      await c.query("SELECT 1");
    } finally {
      c.release();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await pool.end().catch(() => {});
  }
}

export async function executeFirstRunApply(body: FirstRunApplyBody): Promise<{ ok: true } | { ok: false; error: string }> {
  const postgres: NetNodePostgresConfig = {
    host: String(body.postgres?.host || "").trim(),
    port: Number(body.postgres?.port || 5432),
    database: String(body.postgres?.database || "").trim(),
    user: String(body.postgres?.user || "").trim(),
    password: String(body.postgres?.password ?? ""),
  };
  const v = validatePostgres(postgres);
  if (v) return { ok: false, error: v };
  const adminUsername = String(body.adminUsername || "").trim().slice(0, 64);
  const adminPassword = String(body.adminPassword || "");
  if (!adminUsername) return { ok: false, error: "Administrator username is required." };
  if (adminPassword.length < 10) return { ok: false, error: "Administrator password must be at least 10 characters." };

  const siteLabel = String(body.siteLabel || "UNSET").trim().slice(0, 128) || "UNSET";
  const productName = String(body.productName || "NETNODE").trim().slice(0, 64) || "NETNODE";
  const amqpUrl = String(body.amqpUrl || "").trim() || undefined;

  const url = buildPostgresUrl(postgres);
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 12000 });
  try {
    await ensureSchema(pool);
    const adminUser = {
      id: "1",
      username: adminUsername,
      role: "admin",
      lastLogin: "-",
      passwordHash: hashPasswordForSetup(adminPassword),
    };
    const systemConf = {
      ...DEFAULT_SYSTEM_CONFIG_FOR_SETUP,
      siteLabel,
      productName,
    };
    await upsertAppKv(pool, APP_KV_KEYS.users, [adminUser]);
    await upsertAppKv(pool, APP_KV_KEYS.system_config, systemConf);
    await upsertAppKv(pool, APP_KV_KEYS.snmp_templates, DEFAULT_SNMP_TEMPLATES_FOR_SETUP);
    await upsertAppKv(pool, APP_KV_KEYS.discovery_profiles, DEFAULT_DISCOVERY_PROFILES_FOR_SETUP);
    const instance: NetNodeInstanceFile = {
      version: INSTANCE_FILE_VERSION,
      setupComplete: true,
      postgres,
      amqpUrl,
    };
    await writeInstanceFile(instance);
    process.env.DATABASE_URL = url;
    if (amqpUrl) process.env.AMQP_URL = amqpUrl;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await pool.end().catch(() => {});
  }
}
