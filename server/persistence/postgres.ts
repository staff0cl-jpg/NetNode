import { Pool } from "pg";

/** Row payload mirrors `InventoryItem` from the main server module (stored as JSONB). */
export type InventoryRowPayload = Record<string, unknown>;

export type TopologyPersistDoc = {
  links: unknown[];
  layout: Record<string, { x: number; y: number }>;
  layoutScopes: Record<string, Record<string, Record<string, { x: number; y: number }>>>;
  zoneLabelOverridesScopes: Record<string, Record<string, Record<string, string>>>;
  snapshots: unknown[];
};

export const APP_KV_KEYS = {
  topology: "topology",
  system_config: "system_config",
  snmp_config: "snmp_config",
  ldap_config: "ldap_config",
  backup_config: "backup_config",
  backup_history: "backup_history",
  discovery_profiles: "discovery_profiles",
  snmp_templates: "snmp_templates",
  users: "users",
  inventory_meta: "inventory_meta",
  automation_plans: "automation_plans",
  automation_jobs: "automation_jobs",
  manual_discovery_jobs: "manual_discovery_jobs",
  discovery_watch_run_jobs: "discovery_watch_run_jobs",
} as const;

export function databaseUrl(): string | undefined {
  const u = process.env.DATABASE_URL?.trim();
  return u || undefined;
}

export async function connectPostgres(): Promise<Pool | null> {
  const url = databaseUrl();
  if (!url) {
    console.warn("[db] DATABASE_URL is not set — durable state stays in process memory only.");
    return null;
  }
  const pool = new Pool({ connectionString: url, max: 12, idleTimeoutMillis: 30_000 });
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
  } finally {
    client.release();
  }
  console.log("[db] PostgreSQL pool ready.");
  return pool;
}

export async function ensureSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory_device (
      id TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS app_kv (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      username TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT NOT NULL,
      category TEXT NOT NULL,
      ip_address TEXT
    );
    CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log (ts DESC);
  `);
}

export async function persistInventoryDevices(pool: Pool, items: InventoryRowPayload[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ids: string[] = [];
    for (const row of items) {
      const id = String(row.id || "").trim();
      if (!id) continue;
      ids.push(id);
      await client.query(
        `INSERT INTO inventory_device (id, payload, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
        [id, JSON.stringify(row)]
      );
    }
    if (ids.length === 0) {
      await client.query("DELETE FROM inventory_device");
    } else {
      await client.query(`DELETE FROM inventory_device WHERE NOT (id = ANY($1::text[]))`, [ids]);
    }
    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
}

export async function upsertAppKv(pool: Pool, key: string, value: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO app_kv (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value ?? null)]
  );
}

export async function readAppKv(pool: Pool, key: string): Promise<unknown | null> {
  const { rows } = await pool.query<{ value: unknown }>(`SELECT value FROM app_kv WHERE key = $1`, [key]);
  return rows[0]?.value ?? null;
}

export async function appendAuditLog(
  pool: Pool,
  row: { id: string; timestamp: string; user: string; action: string; details: string; category: string; ipAddress?: string }
): Promise<void> {
  await pool.query(
    `INSERT INTO audit_log (id, ts, username, action, details, category, ip_address)
     VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7)`,
    [row.id, row.timestamp, row.user, row.action, row.details, row.category, row.ipAddress ?? null]
  );
}

export async function loadAuditLogs(pool: Pool, limit = 500): Promise<
  Array<{ id: string; timestamp: string; user: string; action: string; details: string; category: string; ipAddress?: string }>
> {
  const { rows } = await pool.query<{
    id: string;
    ts: Date;
    username: string;
    action: string;
    details: string;
    category: string;
    ip_address: string | null;
  }>(
    `SELECT id, ts, username, action, details, category, ip_address
     FROM audit_log ORDER BY ts DESC LIMIT $1`,
    [limit]
  );
  return rows.map((r) => ({
    id: r.id,
    timestamp: r.ts.toISOString(),
    user: r.username,
    action: r.action,
    details: r.details,
    category: r.category as "auth" | "inventory" | "config" | "user_mgmt" | "system" | "automation",
    ipAddress: r.ip_address || undefined,
  }));
}

export type HydrateHandlers = {
  onInventory?: (items: InventoryRowPayload[]) => void;
  onKv?: (key: string, value: unknown) => void;
  onAuditLogs?: (
    logs: Array<{ id: string; timestamp: string; user: string; action: string; details: string; category: string; ipAddress?: string }>
  ) => void;
};

export async function hydrateFromDatabase(pool: Pool, handlers: HydrateHandlers): Promise<void> {
  const { rows: invRows } = await pool.query<{ id: string; payload: InventoryRowPayload }>(
    `SELECT id, payload FROM inventory_device ORDER BY id`
  );
  if (invRows.length && handlers.onInventory) {
    handlers.onInventory(invRows.map((r) => ({ ...r.payload, id: r.id })));
  }

  const { rows: kvRows } = await pool.query<{ key: string; value: unknown }>(`SELECT key, value FROM app_kv`);
  for (const r of kvRows) {
    handlers.onKv?.(r.key, r.value);
  }

  try {
    const logs = await loadAuditLogs(pool, 500);
    if (logs.length) handlers.onAuditLogs?.(logs);
  } catch {
    /* ignore */
  }
}

export async function shutdownPool(pool: Pool | null): Promise<void> {
  if (!pool) return;
  await pool.end();
}
