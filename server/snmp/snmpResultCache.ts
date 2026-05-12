import type { SnmpProbe } from "./snmpClient.js";

const MAX_ENTRIES = 4096;

function readTtlMs(): number {
  const raw = String(process.env.NETNODE_SNMP_RESULT_CACHE_TTL_MS || "").trim();
  if (raw === "0" || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(300_000, Math.floor(n));
}

/** When >0, successful SNMP walks/gets/probes may be reused briefly (same host + params). */
export function readSnmpResultCacheTtlMs(): number {
  return readTtlMs();
}

function prune<K, V extends { exp: number }>(map: Map<K, V>): void {
  while (map.size > MAX_ENTRIES) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    map.delete(first);
  }
}

const walkCache = new Map<string, { exp: number; val: Record<string, string> }>();
const getMapCache = new Map<string, { exp: number; val: Record<string, number | string> }>();
const probeCache = new Map<string, { exp: number; val: SnmpProbe }>();

export function clearSnmpResultCaches(): void {
  walkCache.clear();
  getMapCache.clear();
  probeCache.clear();
}

export async function cachedSnmpWalk(
  ttlMs: number,
  key: string,
  run: () => Promise<Record<string, string>>
): Promise<Record<string, string>> {
  if (ttlMs <= 0) return run();
  const now = Date.now();
  const hit = walkCache.get(key);
  if (hit && hit.exp > now) return { ...hit.val };
  const val = await run();
  if (Object.keys(val).length > 0) {
    walkCache.set(key, { exp: now + ttlMs, val: { ...val } });
    prune(walkCache);
  }
  return val;
}

export async function cachedSnmpGetMap(
  ttlMs: number,
  key: string,
  run: () => Promise<Record<string, number | string>>
): Promise<Record<string, number | string>> {
  if (ttlMs <= 0) return run();
  const now = Date.now();
  const hit = getMapCache.get(key);
  if (hit && hit.exp > now) return { ...hit.val };
  const val = await run();
  if (Object.keys(val).length > 0) {
    getMapCache.set(key, { exp: now + ttlMs, val: { ...val } });
    prune(getMapCache);
  }
  return val;
}

export async function cachedSnmpProbe(ttlMs: number, key: string, run: () => Promise<SnmpProbe>): Promise<SnmpProbe> {
  if (ttlMs <= 0) return run();
  const now = Date.now();
  const hit = probeCache.get(key);
  if (hit && hit.exp > now) return { ...hit.val };
  const val = await run();
  if (val.ok) {
    probeCache.set(key, { exp: now + ttlMs, val: { ...val } });
    prune(probeCache);
  }
  return val;
}
