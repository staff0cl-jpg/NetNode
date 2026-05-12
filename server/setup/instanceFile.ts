import fs from "fs";
import path from "path";
import { promises as fsp } from "fs";

export const INSTANCE_FILE_VERSION = 1 as const;

export type NetNodePostgresConfig = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
};

export type NetNodeInstanceFile = {
  version: typeof INSTANCE_FILE_VERSION;
  setupComplete: boolean;
  postgres: NetNodePostgresConfig;
  /** Optional RabbitMQ / AMQP URL (e.g. amqp://user:pass@host:5672/) */
  amqpUrl?: string;
};

export function instanceFilePath(): string {
  return path.join(process.cwd(), "data", "netnode-instance.json");
}

export function buildPostgresUrl(p: NetNodePostgresConfig): string {
  const host = String(p.host || "").trim();
  const port = Number.isFinite(Number(p.port)) ? Math.max(1, Math.min(65535, Number(p.port))) : 5432;
  const database = String(p.database || "").trim();
  const user = String(p.user || "").trim();
  const password = String(p.password ?? "");
  const userEnc = encodeURIComponent(user);
  const auth = password === "" ? `${userEnc}` : `${userEnc}:${encodeURIComponent(password)}`;
  return `postgres://${auth}@${host}:${port}/${encodeURIComponent(database)}`;
}

/**
 * Apply DATABASE_URL / AMQP_URL from the persisted instance file when env does not already define them.
 * Must run synchronously after `dotenv.config()` and before the first `connectPostgres()` / user bootstrap.
 */
export function hydrateProcessEnvFromInstanceFileSync(): void {
  try {
    const fp = instanceFilePath();
    if (!fs.existsSync(fp)) return;
    const raw = fs.readFileSync(fp, "utf8");
    const j = JSON.parse(raw) as Partial<NetNodeInstanceFile>;
    if (!j?.setupComplete || !j.postgres) return;
    const url = buildPostgresUrl(j.postgres as NetNodePostgresConfig);
    if (!process.env.DATABASE_URL?.trim()) process.env.DATABASE_URL = url;
    const amqp = String(j.amqpUrl || "").trim();
    if (amqp && !process.env.AMQP_URL?.trim() && !process.env.RABBITMQ_URL?.trim()) {
      process.env.AMQP_URL = amqp;
    }
  } catch {
    /* ignore malformed file */
  }
}

export function isFirstRunWizardNeeded(): boolean {
  if (process.env.NETNODE_SKIP_SETUP === "1") return false;
  return !process.env.DATABASE_URL?.trim();
}

export async function writeInstanceFile(data: NetNodeInstanceFile): Promise<void> {
  const fp = instanceFilePath();
  await fsp.mkdir(path.dirname(fp), { recursive: true });
  await fsp.writeFile(fp, JSON.stringify(data, null, 2), "utf8");
}
