import express from "express";
import { createServer as createViteServer } from "vite";
import { Server } from "socket.io";
import http from "http";
import net from "net";
import path from "path";
import { Client } from "ssh2";
import * as dotenv from "dotenv";
import ldap from "ldapjs";
import snmp from "net-snmp";
import crypto from "crypto";

// Load environment variables
dotenv.config();

type InventoryItem = {
  id: string;
  name: string;
  vendor: string;
  model: string;
  category?: string;
  subcategory?: string;
  branch?: string;
  snmpTemplateId?: string;
  customOids?: string[];
  city: string;
  zone: string;
  ip: string;
  status: "online" | "offline" | "warning";
  uptime: string;
  uptimeSeconds?: number;
};

// In-memory state (empty by default; devices come from discovery or manual registration)
let inventory: InventoryItem[] = [];

type DiscoveryProtocol = "snmp";
type DiscoveryScanInput = {
  subnets: string;
  protocol?: string;
  city?: string;
  zone?: string;
  branch?: string;
  actor?: string;
  reason?: "manual" | "scheduled" | "watch_manual";
};
type DiscoveryScanSummary = {
  success: true;
  protocol: DiscoveryProtocol;
  scanned: number;
  skippedExisting: number;
  snmpFound: number;
  sshOpen: number;
  bothFound: number;
  added: number;
  foundIps: string[];
  city: string;
  zone: string;
  branch: string;
};
type DiscoveryWatchProfile = {
  id: string;
  name: string;
  subnets: string;
  protocol: DiscoveryProtocol;
  city: string;
  zone: string;
  branch: string;
  enabled: boolean;
  intervalHours: number;
  lastRunAt: string | null;
  lastResult: DiscoveryScanSummary | { success: false; error: string } | null;
};

let discoveryWatchProfiles: DiscoveryWatchProfile[] = [];
let discoveryScheduler: NodeJS.Timeout | null = null;
let discoveryRunLock = false;
let discoverySchedulerLastTickAt: string | null = null;
let discoverySchedulerLastProcessed = 0;
type ManualDiscoveryJob = {
  id: string;
  actor: string;
  status: "running" | "done" | "error";
  createdAt: string;
  startedAt: string;
  finishedAt?: string;
  input: {
    subnets: string;
    protocol?: string;
    city?: string;
    zone?: string;
    branch?: string;
  };
  summary?: DiscoveryScanSummary;
  error?: string;
};
let manualDiscoveryJobs = new Map<string, ManualDiscoveryJob>();
let activeManualDiscoveryJobId: string | null = null;

function trimManualDiscoveryJobs(max = 30) {
  if (manualDiscoveryJobs.size <= max) return;
  const oldest = Array.from(manualDiscoveryJobs.values())
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .slice(0, manualDiscoveryJobs.size - max);
  oldest.forEach((j) => manualDiscoveryJobs.delete(j.id));
}
type SshReadonlyProfile = {
  username: string;
  password: string;
  port: number;
  allowMetricsFallback: boolean;
  expiresAt: number;
};
let sshReadonlyProfile: SshReadonlyProfile | null = null;

const LEGACY_SSH_ALGORITHMS = {
  // Required by older HP/HPE 1910/1810 firmware and similar legacy stacks.
  kex: ["diffie-hellman-group14-sha1", "diffie-hellman-group1-sha1"],
  serverHostKey: ["ssh-rsa", "ssh-dss"],
  cipher: ["aes128-cbc", "3des-cbc", "aes192-cbc", "aes256-cbc"],
  hmac: ["hmac-sha1", "hmac-md5"],
};

function legacySshConnectOptions() {
  return {
    algorithms: LEGACY_SSH_ALGORITHMS,
  };
}

type TopologyLink = {
  id?: string;
  source: string;
  target: string;
  portA: string;
  portB: string;
  manual?: boolean; // created by user
  renamed?: boolean; // ports were edited by user
};
let topologyLinks: TopologyLink[] = [];
let topologyLayout: Record<string, { x: number; y: number }> = {};

let users = [
  { id: '1', username: 'admin', role: 'admin', lastLogin: '2024-05-04 10:15', password: 'admin' },
  { id: '2', username: 'operator_01', role: 'operator', lastLogin: '2024-05-03 16:45', password: 'password' },
];

type AuthUser = { id: string; username: string; role: string };
type SessionRecord = { user: AuthUser; expiresAt: number };
const SESSION_COOKIE_NAME = "netnode_sid";
const SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8 hours
const sessionStore = new Map<string, SessionRecord>();

interface AuditLog {
  id: string;
  timestamp: string;
  user: string;
  action: string;
  details: string;
  category: 'auth' | 'inventory' | 'config' | 'user_mgmt' | 'system';
}

let auditLogs: AuditLog[] = [];

// System Config State
let systemConfig = {
  defaultLanguage: 'ru',
  siteLabel: 'UNSET',
  dashboardUi: {
    trunkThroughputTitle: 'Trunk Throughput (Mbps)',
    trunkLoadTitle: 'Trunk Load (Mbps)',
    trunkMonitorTitle: 'Trunk Monitor',
    showTrunkMonitor: true,
  },
};

let snmpConfig = {
  community: "public",
  communities: ["public"],
  version: "SNMP v2c",
  port: 161,
  timeoutMs: 1200,
  retries: 0,
};

let inventoryMeta = {
  categories: ["Switch", "Router", "FC Switch", "UPS", "Firewall", "Other"],
  subcategories: ["Core", "Distribution", "Access"],
  branches: ["ULN", "NCH", "VRN", "VLG", "VLD", "SMR", "KRD"],
  cities: ["Ульяновск", "Набережные Челны", "Краснодар", "Воронеж", "Волгоград", "Владимир", "Самара"],
  zones: ["Core", "Distribution", "Access"],
  vendors: ["Cisco", "Juniper", "HPE", "Aruba", "MikroTik", "APC", "Eaton", "Vertiv", "Riello", "Huawei", "Arista", "Unknown"],
  models: {
    Cisco: ["Catalyst 9300", "Catalyst 9200", "Nexus 93180YC", "ASR 1001-X"],
    Juniper: ["EX4300", "EX2300", "MX204", "QFX5120"],
    HPE: ["HP 1910", "HP 1810", "HP SN3600B", "Aruba 2530", "Aruba CX6000", "Aruba 2930F", "Aruba 5406R", "FlexFabric 5940", "Aruba 6300M"],
    Aruba: ["Aruba 2530", "Aruba CX6000", "Aruba 2930F", "Aruba 5406R", "Aruba 6300M"],
    MikroTik: ["CCR2004", "CRS326", "RB5009", "CCR2116"],
    APC: ["Smart-UPS", "Easy UPS", "Symmetra"],
    Eaton: ["9PX", "9SX", "93PM"],
    Vertiv: ["Liebert GXT", "Liebert EXM"],
    Riello: ["Sentinel", "Vision"],
    Huawei: ["CloudEngine S5735", "S6730", "NetEngine AR6121"],
    Arista: ["7050SX3", "7280SR3", "7010T"],
    Unknown: ["Discovered (SNMP)", "Generic L2"],
  } as Record<string, string[]>,
};

async function forEachWithLimit<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>) {
  let cursor = 0;
  const safeLimit = Math.max(1, Math.min(limit, items.length || 1));
  const jobs = Array.from({ length: safeLimit }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(jobs);
}

function isLikelyTrunkPort(name: string, alias: string, descr: string, ifType?: string): boolean {
  const v = `${name} ${alias} ${descr}`.trim().toLowerCase();
  const t = Number(ifType || 0);
  if (t === 161) return true; // ieee8023adLag
  if (!v) return false;
  return /(^|\s)(trunk|trk|lag|port-channel|po\d+|etherchannel|bond|bridge-aggregation|ae\d+|lacp)\b/.test(v);
}

function parseCiscoIfIndexFromSuffix(suffix: string): string {
  const parts = String(suffix || "").split(".").filter(Boolean);
  if (!parts.length) return "";
  // Cisco tables can have composite indexes; last numeric token is typically ifIndex.
  return parts[parts.length - 1] || "";
}

async function getCiscoTrunkPortHints(host: string): Promise<Set<string>> {
  try {
    // CISCO-VTP-MIB trunk-related tables.
    // vmVlanTrunkPortDynamicStatus: 1=trunking, 2=notTrunking
    const dynStatus = await snmpWalk(host, "1.3.6.1.4.1.9.9.46.1.6.1.1.14");
    // vmVlanTrunkPortDynamicState: mode hints (on/desirable/auto/etc)
    const dynState = await snmpWalk(host, "1.3.6.1.4.1.9.9.46.1.6.1.1.13");
    const out = new Set<string>();
    Object.entries(dynStatus).forEach(([suffix, raw]) => {
      const ifIndex = parseCiscoIfIndexFromSuffix(suffix);
      const status = Number(raw || 0);
      if (!ifIndex) return;
      if (status === 1) out.add(ifIndex);
    });
    Object.entries(dynState).forEach(([suffix, raw]) => {
      const ifIndex = parseCiscoIfIndexFromSuffix(suffix);
      const mode = Number(raw || 0);
      if (!ifIndex) return;
      // on(1), desirable(3), onNoNegotiate(5) are strong trunk mode hints.
      if (mode === 1 || mode === 3 || mode === 5) out.add(ifIndex);
    });
    return out;
  } catch {
    return new Set<string>();
  }
}

async function getTrunkPortCountFromSnmp(host: string): Promise<number> {
  try {
    const [ifNames, ifAlias, ifDescr, ifType, ciscoHints] = await Promise.all([
      snmpWalk(host, "1.3.6.1.2.1.31.1.1.1.1"),
      snmpWalk(host, "1.3.6.1.2.1.31.1.1.1.18"),
      snmpWalk(host, "1.3.6.1.2.1.2.2.1.2"),
      snmpWalk(host, "1.3.6.1.2.1.2.2.1.3"),
      getCiscoTrunkPortHints(host),
    ]);
    const indexes = new Set([...Object.keys(ifNames), ...Object.keys(ifAlias), ...Object.keys(ifDescr)]);
    let count = 0;
    for (const ifIndex of indexes) {
      const ifName = String(ifNames[ifIndex] || `if${ifIndex}`).trim();
      const alias = String(ifAlias[ifIndex] || "").trim();
      const descr = String(ifDescr[ifIndex] || "").trim();
      if (isLikelyTrunkPort(ifName, alias, descr, ifType[ifIndex]) || ciscoHints.has(ifIndex)) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

async function classifyInventorySubcategoriesBySnmp(branch?: string) {
  const filterBranch = String(branch || "").trim();
  const targets = filterBranch ? inventory.filter((i) => String(i.branch || "").trim() === filterBranch) : inventory;
  const touched: Array<{ id: string; trunkCount: number; subcategory: string }> = [];
  await forEachWithLimit(targets, 16, async (item) => {
    const category = String(item.category || "").toLowerCase();
    if (category === "fc switch" || category === "fibre channel switch" || category === "fiber channel switch") {
      const subcategory = deriveFcSubcategoryByName(item.name || "");
      if ((item.subcategory || "") !== subcategory) {
        item.subcategory = subcategory;
        touched.push({ id: item.id, trunkCount: 0, subcategory });
      }
      return;
    }
    const trunkCount = await getTrunkPortCountFromSnmp(item.ip);
    const subcategory = trunkCount >= 2 ? "Core" : trunkCount === 1 ? "Distribution" : "Access";
    if ((item.subcategory || "") !== subcategory) {
      item.subcategory = subcategory;
      touched.push({ id: item.id, trunkCount, subcategory });
    }
  });
  // ensure dictionary contains the expected values
  inventoryMeta.subcategories = Array.from(new Set([...(inventoryMeta.subcategories || []), "Core", "Distribution", "Access"]));
  return { updated: touched.length, devices: touched };
}

type SnmpOidDef = {
  key: string;
  oid: string;
  scale?: number;
  unit?: string;
};

type SnmpTemplate = {
  id: string;
  name: string;
  vendorHint?: string;
  metrics: SnmpOidDef[];
};

let snmpTemplates: SnmpTemplate[] = [
  {
    id: "zbx-switch-basic",
    name: "Zabbix-like Switch Basic",
    vendorHint: "Any",
    metrics: [
      { key: "uptime", oid: "1.3.6.1.2.1.1.3.0", scale: 0.01, unit: "s" },
    ],
  },
  {
    id: "zbx-ups-basic",
    name: "Zabbix-like UPS Basic",
    vendorHint: "UPS",
    metrics: [
      { key: "ups_uptime", oid: "1.3.6.1.2.1.1.3.0", scale: 0.01, unit: "s" },
    ],
  },
  {
    id: "zbx-fc-sn3600b",
    name: "FC Switch SN3600B",
    vendorHint: "HPE",
    metrics: [
      { key: "fc_uptime", oid: "1.3.6.1.2.1.1.3.0", scale: 0.01, unit: "s" },
      { key: "fc_ports_total", oid: "1.3.6.1.2.1.2.1.0", scale: 1, unit: "count" },
    ],
  },
];

type TrunkMetric = {
  ifIndex: string;
  ifName: string;
  description: string;
  operStatus: number;
  inBps: number;
  outBps: number;
};

const trunkCounterCache = new Map<string, { inOctets: bigint; outOctets: bigint; ts: number; bits: 32 | 64 }>();

interface LdapRoleProfile {
  enabled: boolean;
  url: string;
  bindDn: string;
  bindPassword: string;
  searchBase: string;
  searchFilter: string;
  tlsRejectUnauthorized: boolean;
}

const defaultLdapProfile = (): LdapRoleProfile => ({
  enabled: false,
  url: "ldap://127.0.0.1:389",
  bindDn: "",
  bindPassword: "",
  searchBase: "dc=example,dc=com",
  searchFilter: "(sAMAccountName={{username}})",
  tlsRejectUnauthorized: true,
});

let ldapConfig: { admin: LdapRoleProfile; operator: LdapRoleProfile } = {
  admin: defaultLdapProfile(),
  operator: defaultLdapProfile(),
};

function maskLdapForClient() {
  const mask = (p: LdapRoleProfile) => ({
    ...p,
    bindPassword: p.bindPassword ? "********" : "",
  });
  return { admin: mask(ldapConfig.admin), operator: mask(ldapConfig.operator) };
}

function mergeLdapPasswords(incoming: { admin?: Partial<LdapRoleProfile>; operator?: Partial<LdapRoleProfile> }) {
  const pick = (key: "admin" | "operator", patch?: Partial<LdapRoleProfile>) => {
    const cur = ldapConfig[key];
    const next = { ...cur, ...patch } as LdapRoleProfile;
    if (!patch?.bindPassword || patch.bindPassword === "********") {
      next.bindPassword = cur.bindPassword;
    }
    return next;
  };
  ldapConfig = {
    admin: pick("admin", incoming.admin),
    operator: pick("operator", incoming.operator),
  };
}

function ldapEntryDn(entry: unknown): string | null {
  const e = entry as { pname?: string; objectName?: string; dn?: string | Buffer };
  if (typeof e.pname === "string" && e.pname) return e.pname;
  if (typeof e.objectName === "string" && e.objectName) return e.objectName;
  if (e.dn != null) return Buffer.isBuffer(e.dn) ? e.dn.toString("utf8") : String(e.dn);
  return null;
}

function escapeLdapFilterValue(value: string): string {
  const esc =
    typeof (ldap as unknown as { escapeFilterValue?: (s: string) => string }).escapeFilterValue === "function"
      ? (ldap as unknown as { escapeFilterValue: (s: string) => string }).escapeFilterValue
      : (s: string) =>
          s.replace(/[\\*()\0]/g, (ch) => {
            if (ch === "\0") return "\\00";
            return `\\${ch}`;
          });
  return esc(value);
}

function verifyLdapLogin(profile: LdapRoleProfile, username: string, password: string): Promise<boolean> {
  if (!profile.enabled || !profile.url || !profile.bindDn || !profile.searchBase || !username || !password) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const safeUser = escapeLdapFilterValue(username);
    const filter = (profile.searchFilter || "(uid={{username}})").replace(/\{\{username\}\}/g, safeUser);

    const client = ldap.createClient({
      url: profile.url,
      timeout: 15000,
      connectTimeout: 15000,
      tlsOptions: { rejectUnauthorized: profile.tlsRejectUnauthorized },
    });

    const done = (ok: boolean) => {
      try {
        client.unbind();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };

    client.on("error", () => done(false));

    client.bind(profile.bindDn, profile.bindPassword, (bindErr) => {
      if (bindErr) return done(false);

      client.search(
        profile.searchBase,
        { filter, scope: "sub", attributes: ["dn"], sizeLimit: 1 },
        (searchErr, res) => {
          if (searchErr || !res) {
            try {
              client.unbind();
            } catch {
              /* ignore */
            }
            return done(false);
          }

          let userDn: string | null = null;
          res.on("searchEntry", (entry) => {
            userDn = ldapEntryDn(entry);
          });
          res.on("error", () => done(false));
          res.on("end", () => {
            if (!userDn) return done(false);
            client.bind(userDn, password, (userBindErr) => {
              done(!userBindErr);
            });
          });
        }
      );
    });
  });
}

function ipv4ToInt(ip: string): number | null {
  const p = ip.trim().split(".").map((x) => parseInt(x, 10));
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
  return (((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0);
}

function intToIpv4(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

function expandCidrIpv4(cidr: string, maxHosts: number): string[] {
  const t = cidr.trim();
  if (!t.includes("/")) {
    return ipv4ToInt(t) !== null ? [t] : [];
  }
  const [ipStr, prefStr] = t.split("/");
  const prefix = parseInt(prefStr, 10);
  const base = ipv4ToInt(ipStr.trim());
  if (base === null || !Number.isFinite(prefix) || prefix < 8 || prefix > 32) return [];
  if (prefix === 32) return [ipStr.trim()];
  const hostBits = 32 - prefix;
  const maxAddrs = (1 << hostBits) - 2;
  if (maxAddrs <= 0) return [intToIpv4(base)];
  const count = Math.min(maxAddrs, maxHosts);
  const mask = (~((1 << hostBits) - 1)) >>> 0;
  const network = base & mask;
  const out: string[] = [];
  for (let h = 1; h <= maxAddrs && out.length < count; h++) {
    out.push(intToIpv4(network + h));
  }
  return out;
}

function parseSubnetList(spec: string, capTotal: number): string[] {
  const parts = spec
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const ips: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    if (ips.length >= capTotal) break;
    const block = expandCidrIpv4(p, capTotal - ips.length);
    for (const ip of block) {
      if (seen.has(ip)) continue;
      seen.add(ip);
      ips.push(ip);
      if (ips.length >= capTotal) break;
    }
  }
  return ips;
}

function normalizeProtocol(_mode?: string): DiscoveryProtocol {
  return "snmp";
}

function upsertInventoryMetaFromItem(item: Partial<InventoryItem>) {
  const pushUnique = (arr: string[], value?: string) => {
    const v = String(value || "").trim();
    if (!v || arr.includes(v)) return;
    arr.push(v);
  };
  pushUnique(inventoryMeta.categories, item.category);
  pushUnique(inventoryMeta.branches, item.branch);
  pushUnique(inventoryMeta.cities, item.city);
  pushUnique(inventoryMeta.zones, item.zone);
}

function checkTcpPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.connect(port, host);
  });
}

async function runDiscoveryScan(input: DiscoveryScanInput): Promise<DiscoveryScanSummary> {
  const MAX_TOTAL = 1024;
  const CONCURRENCY = 32;
  const protocol = normalizeProtocol(input.protocol);
  const city = String(input.city || "Ульяновск").trim() || "Ульяновск";
  const zone = String(input.zone || "Core").trim() || "Core";
  const branch = String(input.branch || "ULN").trim() || "ULN";
  const actor = input.actor || "unknown";

  const ips = parseSubnetList(String(input.subnets || ""), MAX_TOTAL);
  if (ips.length === 0) {
    throw new Error("Не удалось разобрать подсети. Формат: 10.0.0.0/24 или 192.168.1.5");
  }

  const snmpEnabled = true;
  const existingIps = new Set(inventory.map((s) => s.ip));
  const toScan = ips.filter((ip) => !existingIps.has(ip));
  const foundIps: string[] = [];
  let sshOpen = 0;
  let snmpFound = 0;
  let bothFound = 0;
  const discovered: InventoryItem[] = [];
  let idx = 0;

  logAction(actor, "Start Discovery", `Сканирование ${ips.length} адресов (mode: ${protocol})`, "inventory");

  const worker = async () => {
    while (idx < toScan.length) {
      const current = idx++;
      const ip = toScan[current];
      const probe = await (snmpEnabled ? getSnmpProbe(ip, snmpConfig.timeoutMs || 900) : Promise.resolve({ ok: false } as SnmpProbe));
      if (probe.ok) snmpFound++;
      if (!probe.ok) continue;
      foundIps.push(ip);
      const vendor = probe.sysDescr ? detectVendorFromSnmp(probe.sysDescr, probe.sysObjectId || "") : "Unknown";
      const model = detectModelFromSnmp(probe.sysDescr || "", probe.sysObjectId || "", probe.sysName || "");
      const category = detectCategoryFromSnmp(probe.sysDescr || "", probe.sysObjectId || "", probe.sysName || "");
      const subcategory = category === "FC Switch"
        ? deriveFcSubcategoryByName(probe.sysName || model || "")
        : "Access";
      const uptimeSeconds = probe.uptimeSeconds ?? 0;
      discovered.push({
        id: `d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: probe.sysName?.trim() || `${vendor}-SNMP-${ip.replace(/\./g, "-")}`,
        vendor,
        model,
        category,
        subcategory,
        branch,
        city,
        zone,
        ip,
        status: "online",
        uptimeSeconds,
        uptime: formatDuration(uptimeSeconds),
      });
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  discovered.forEach((d) => upsertInventoryMetaFromItem(d));
  inventory.push(...discovered);
  rebuildTopologyFromInventory();
  // Keep discovery fast: run expensive SNMP trunk-role classification in background.
  void classifyInventorySubcategoriesBySnmp(branch).catch(() => {
    /* ignore async classification errors */
  });
  const summary: DiscoveryScanSummary = {
    success: true,
    protocol,
    scanned: ips.length,
    skippedExisting: ips.length - toScan.length,
    snmpFound,
    sshOpen,
    bothFound,
    added: discovered.length,
    foundIps,
    city,
    zone,
    branch,
  };
  logAction(
    actor,
    "Discovery Complete",
    `Проверено: ${ips.length}, SNMP найдено: ${foundIps.length}, новых в инвентаре: ${summary.added}`,
    "inventory"
  );
  return summary;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0d 0h 0m";
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

function makeTopologyLinkId(): string {
  return `lnk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ensureTopologyLinkId(link: TopologyLink): TopologyLink {
  if (link.id) return link;
  return { ...link, id: makeTopologyLinkId() };
}

function detectVendorFromSnmp(sysDescr: string, sysObjectId: string): string {
  const d = (sysDescr || "").toLowerCase();
  const oid = (sysObjectId || "").toLowerCase();
  // UPS vendor detection has priority over network-vendor branches.
  if (oid.startsWith("1.3.6.1.4.1.318") || d.includes("apc")) return "APC";
  if (oid.startsWith("1.3.6.1.4.1.534") || d.includes("eaton") || d.includes("powerware")) return "Eaton";
  if (d.includes("vertiv") || d.includes("liebert")) return "Vertiv";
  if (d.includes("riello")) return "Riello";
  if (oid.startsWith("1.3.6.1.4.1.9")) return "Cisco";
  if (oid.startsWith("1.3.6.1.4.1.14988")) return "MikroTik";
  if (oid.startsWith("1.3.6.1.4.1.2636")) return "Juniper";
  if (oid.startsWith("1.3.6.1.4.1.2011")) return "Huawei";
  if (oid.startsWith("1.3.6.1.4.1.30065")) return "Arista";
  if (oid.startsWith("1.3.6.1.4.1.11")) return "HPE";
  if (oid.startsWith("1.3.6.1.4.1.14823")) return "Aruba";
  return detectVendorFromDescr(sysDescr);
}

function detectVendorFromDescr(descr: string): string {
  const d = descr.toLowerCase();
  if (d.includes("apc")) return "APC";
  if (d.includes("eaton") || d.includes("powerware")) return "Eaton";
  if (d.includes("vertiv") || d.includes("liebert")) return "Vertiv";
  if (d.includes("riello")) return "Riello";
  if (d.includes("cisco")) return "Cisco";
  if (d.includes("juniper")) return "Juniper";
  if (d.includes("aruba")) return "HPE";
  if (d.includes("hewlett") || d.includes("procurve") || d.includes("hpe")) return "HPE";
  if (/\bhp\b/.test(d) || d.includes("officeconnect")) return "HPE";
  if (d.includes("mikrotik")) return "MikroTik";
  if (d.includes("routeros") || d.includes("routerboard")) return "MikroTik";
  if (d.includes("huawei")) return "Huawei";
  if (d.includes("arista")) return "Arista";
  if (d.includes("brocade") || d.includes("fibre channel") || d.includes("fiber channel") || d.includes("fabric os")) return "HPE";
  return "Unknown";
}

function parseModelFromDescr(descr: string): string {
  const trimmed = descr.trim();
  if (!trimmed) return "Unknown";
  return trimmed.split("\n")[0].trim().slice(0, 80);
}

function detectModelFromSnmp(sysDescr: string, sysObjectId = "", sysName = ""): string {
  const d = (sysDescr || "").toLowerCase();
  const oid = (sysObjectId || "").toLowerCase();
  const n = (sysName || "").toLowerCase();
  const join = `${sysDescr || ""} ${sysName || ""}`;
  const mikrotikModel = join.match(/\b(CCR(?:\s|-)?\d{4}[A-Z0-9\/-]*|CRS(?:\s|-)?\d{3}[A-Z0-9\/-]*|RB\d+[A-Z0-9\/-]*|CSS\d+[A-Z0-9\/-]*)\b/i);
  if (mikrotikModel?.[1]) {
    return mikrotikModel[1].replace(/\s+/g, "").toUpperCase();
  }
  if (oid.startsWith("1.3.6.1.4.1.14988") || d.includes("mikrotik") || d.includes("routeros") || d.includes("routerboard") || n.includes("mikrotik")) {
    return "MikroTik Device";
  }
  if (!d.trim()) return "Unknown";
  if (d.includes("sn3600b") || n.includes("sn3600b")) return "HP SN3600B";
  if (d.includes("brocade") && (d.includes("6510") || d.includes("6520"))) {
    return d.includes("6520") ? "HP SN3600B" : "HP SN3600B";
  }
  if (/\b1910\b/.test(d) || d.includes("v1910") || d.includes("jg538a")) return "HP 1910";
  if (/\b1810\b/.test(d) || d.includes("j9450a") || d.includes("j9660a")) return "HP 1810";
  if (/\b2530\b/.test(d) || d.includes("j9772a") || d.includes("j9773a") || d.includes("j9780a")) return "Aruba 2530";
  if (d.includes("cx 6000") || d.includes("cx6000") || d.includes("6000 ") || d.includes("jl")) return "Aruba CX6000";
  if (d.includes("routerboard") || d.includes("routeros")) {
    const rb = sysDescr.match(/\b(CRS\d+[A-Z0-9\-+]*|CCR\d+[A-Z0-9\-+]*|RB\d+[A-Z0-9\-+]*|CSS\d+[A-Z0-9\-+]*)\b/i);
    if (rb?.[1]) return rb[1].toUpperCase();
    return "MikroTik RouterOS";
  }
  if (d.includes("cisco ios") || d.includes("catalyst")) {
    const cat = sysDescr.match(/\b(Catalyst\s+\d{3,4}[A-Z0-9\-]*)\b/i);
    if (cat?.[1]) return cat[1];
  }
  return parseModelFromDescr(sysDescr);
}

function snmpVersionsFromConfig(): snmp.Version[] {
  const preferred = snmpConfig.version.includes("v1") ? snmp.Version1 : snmp.Version2c;
  const fallback = preferred === snmp.Version1 ? snmp.Version2c : snmp.Version1;
  return [preferred, fallback];
}

function snmpCommunities(): string[] {
  const fromList = (snmpConfig.communities || []).map((s) => s.trim()).filter(Boolean);
  const direct = snmpConfig.community?.trim() ? [snmpConfig.community.trim()] : [];
  return [...new Set([...fromList, ...direct])];
}

type SnmpProbe = {
  ok: boolean;
  sysName?: string;
  sysDescr?: string;
  sysObjectId?: string;
  uptimeSeconds?: number;
};

const uptimeOidProfiles: Array<{ oid: string; multiplier: number }> = [
  // RFC1213-MIB::sysUpTimeInstance (TimeTicks, 1/100 sec)
  { oid: "1.3.6.1.2.1.1.3.0", multiplier: 0.01 },
  // HOST-RESOURCES-MIB::hrSystemUptime (TimeTicks, 1/100 sec)
  { oid: "1.3.6.1.2.1.25.1.1.0", multiplier: 0.01 },
];

function detectCategoryFromSnmp(sysDescr: string, sysObjectId: string, sysName = ""): string {
  const d = (sysDescr || "").toLowerCase();
  const oid = (sysObjectId || "").toLowerCase();
  const model = detectModelFromSnmp(sysDescr, sysObjectId, sysName).toLowerCase();
  if (d.includes("ups") || d.includes("apc") || d.includes("eaton") || oid.startsWith("1.3.6.1.4.1.318")) {
    return "UPS";
  }
  if (oid.startsWith("1.3.6.1.4.1.14988")) {
    if (model.startsWith("crs") || model.startsWith("css")) return "Switch";
    return "Router";
  }
  if (
    model.includes("sn3600b") ||
    d.includes("fibre channel") ||
    d.includes("fiber channel") ||
    d.includes("fabric os") ||
    oid.startsWith("1.3.6.1.4.1.1588")
  ) {
    return "FC Switch";
  }
  if (d.includes("router")) return "Router";
  if (d.includes("firewall") || d.includes("fortigate") || d.includes("palo alto")) return "Firewall";
  if (d.includes("switch") || d.includes("catalyst") || d.includes("aruba") || d.includes("nexus")) return "Switch";
  return "Other";
}

function deriveFcSubcategoryByName(name: string): "Core" | "Access" {
  const n = String(name || "").toLowerCase();
  if (/(^|[\s\-_])(core|san-core|fc-core|director)([\s\-_]|$)/.test(n)) return "Core";
  if (/(^|[\s\-_])(edge|leaf|access|san-edge)([\s\-_]|$)/.test(n)) return "Access";
  return "Access";
}

function getSnmpProbe(host: string, timeout = snmpConfig.timeoutMs): Promise<SnmpProbe> {
  return new Promise((resolve) => {
    const communities = snmpCommunities();
    const oids = ["1.3.6.1.2.1.1.5.0", "1.3.6.1.2.1.1.1.0", "1.3.6.1.2.1.1.2.0", ...uptimeOidProfiles.map((p) => p.oid)];
    const baseOids = ["1.3.6.1.2.1.1.5.0", "1.3.6.1.2.1.1.1.0", "1.3.6.1.2.1.1.2.0"];
    const versions = snmpVersionsFromConfig();
    let idx = 0;
    let versionIdx = 0;
    const fallbackProbeSingle = (community: string, version: snmp.Version) => {
      const session = snmp.createSession(host, community, {
        timeout: Math.max(timeout, 1200),
        retries: Math.max(snmpConfig.retries, 0),
        version,
        port: snmpConfig.port,
      });
      const readOne = (oid: string) =>
        new Promise<string>((r) => {
          session.get([oid], (e, vars) => {
            if (e || !vars?.length) return r("");
            const value = vars[0]?.value;
            r(value === undefined || value === null ? "" : String(value));
          });
        });
      (async () => {
        try {
          const sysName = await readOne(baseOids[0]);
          const sysDescr = await readOne(baseOids[1]);
          const sysObjectId = await readOne(baseOids[2]);
          let uptimeSeconds = 0;
          for (const profile of uptimeOidProfiles) {
            const raw = Number(await readOne(profile.oid));
            if (!uptimeSeconds && Number.isFinite(raw) && raw > 0) {
              uptimeSeconds = Math.floor(raw * profile.multiplier);
            }
          }
          if (sysName || sysDescr || sysObjectId) {
            return resolve({ ok: true, sysName, sysDescr, sysObjectId, uptimeSeconds });
          }
          return tryNext();
        } catch {
          return tryNext();
        } finally {
          try {
            session.close();
          } catch {
            /* ignore */
          }
        }
      })();
    };
    const tryNext = () => {
      if (versionIdx >= versions.length) return resolve({ ok: false });
      if (idx >= communities.length) {
        idx = 0;
        versionIdx++;
        return tryNext();
      }
      const community = communities[idx++];
      const session = snmp.createSession(host, community, {
        timeout,
        retries: snmpConfig.retries,
        version: versions[versionIdx],
        port: snmpConfig.port,
      });
      session.get(oids, (err, varbinds) => {
        try {
          session.close();
        } catch {
          /* ignore */
        }
        if (err || !varbinds?.length) {
          // Do not fallback on plain timeout, otherwise scans become very slow on /24.
          // Fallback is reserved for non-timeout SNMP agent quirks.
          const errMsg = String((err as any)?.message || "").toLowerCase();
          const isTimeout = errMsg.includes("timeout");
          if (isTimeout || !err) return tryNext();
          return fallbackProbeSingle(community, versions[versionIdx]);
        }
        const sysName = varbinds[0]?.value ? String(varbinds[0].value) : "";
        const sysDescr = varbinds[1]?.value ? String(varbinds[1].value) : "";
        const sysObjectId = varbinds[2]?.value ? String(varbinds[2].value) : "";
        let uptimeSeconds = 0;
        uptimeOidProfiles.forEach((profile, i) => {
          const raw = Number(varbinds[3 + i]?.value ?? 0);
          if (!uptimeSeconds && Number.isFinite(raw) && raw > 0) {
            uptimeSeconds = Math.floor(raw * profile.multiplier);
          }
        });
        return resolve({ ok: true, sysName, sysDescr, sysObjectId, uptimeSeconds });
      });
    };
    tryNext();
  });
}

function pickTemplate(item: InventoryItem): SnmpTemplate | undefined {
  if (item.snmpTemplateId) {
    return snmpTemplates.find((t) => t.id === item.snmpTemplateId);
  }
  const category = (item.category || "").toLowerCase();
  const model = (item.model || "").toLowerCase();
  if (category === "fc switch" || model.includes("sn3600b")) {
    return snmpTemplates.find((t) => t.id === "zbx-fc-sn3600b");
  }
  if ((item.category || "").toLowerCase() === "ups") {
    return snmpTemplates.find((t) => t.id === "zbx-ups-basic");
  }
  return snmpTemplates.find((t) => t.id === "zbx-switch-basic");
}

function snmpGetMap(host: string, oids: string[], timeout = snmpConfig.timeoutMs): Promise<Record<string, number | string>> {
  return new Promise((resolve) => {
    const communities = snmpCommunities();
    const versions = snmpVersionsFromConfig();
    let idx = 0;
    let versionIdx = 0;
    const tryNext = () => {
      if (versionIdx >= versions.length) return resolve({});
      if (idx >= communities.length) {
        idx = 0;
        versionIdx++;
        return tryNext();
      }
      const session = snmp.createSession(host, communities[idx++], {
        timeout,
        retries: snmpConfig.retries,
        version: versions[versionIdx],
        port: snmpConfig.port,
      });
      session.get(oids, (err, vars) => {
        try {
          session.close();
        } catch {
          /* ignore */
        }
        if (err || !vars?.length) return tryNext();
        const out: Record<string, number | string> = {};
        vars.forEach((v, i) => {
          const raw = v?.value;
          out[oids[i]] = typeof raw === "number" ? raw : String(raw ?? "");
        });
        resolve(out);
      });
    };
    tryNext();
  });
}

function snmpWalk(host: string, baseOid: string, timeout = snmpConfig.timeoutMs): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    const communities = snmpCommunities();
    const versions = snmpVersionsFromConfig();
    let idx = 0;
    let versionIdx = 0;
    const tryNext = () => {
      if (versionIdx >= versions.length) return resolve({});
      if (idx >= communities.length) {
        idx = 0;
        versionIdx++;
        return tryNext();
      }
      const session = snmp.createSession(host, communities[idx++], {
        timeout,
        retries: snmpConfig.retries,
        version: versions[versionIdx],
        port: snmpConfig.port,
      });
      const out: Record<string, string> = {};
      session.subtree(
        baseOid,
        (varbinds) => {
          for (const vb of varbinds) {
            const suffix = vb.oid.startsWith(`${baseOid}.`) ? vb.oid.slice(baseOid.length + 1) : vb.oid;
            out[suffix] = String(vb.value ?? "");
          }
        },
        (err) => {
          try {
            session.close();
          } catch {
            /* ignore */
          }
          if (err) return tryNext();
          resolve(out);
        }
      );
    };
    tryNext();
  });
}

async function collectTrunkMetrics(host: string): Promise<TrunkMetric[]> {
  const [ifNames, ifAlias, ifDescr, ifType, ifOper, ifSpeed, hcInOctets, hcOutOctets, inOctets32, outOctets32, ciscoHints] = await Promise.all([
    snmpWalk(host, "1.3.6.1.2.1.31.1.1.1.1"),
    snmpWalk(host, "1.3.6.1.2.1.31.1.1.1.18"),
    snmpWalk(host, "1.3.6.1.2.1.2.2.1.2"),
    snmpWalk(host, "1.3.6.1.2.1.2.2.1.3"),
    snmpWalk(host, "1.3.6.1.2.1.2.2.1.8"),
    snmpWalk(host, "1.3.6.1.2.1.2.2.1.5"),
    snmpWalk(host, "1.3.6.1.2.1.31.1.1.1.6"),
    snmpWalk(host, "1.3.6.1.2.1.31.1.1.1.10"),
    snmpWalk(host, "1.3.6.1.2.1.2.2.1.10"),
    snmpWalk(host, "1.3.6.1.2.1.2.2.1.16"),
    getCiscoTrunkPortHints(host),
  ]);
  const now = Date.now();
  const indexes = Array.from(
    new Set([
      ...Object.keys(ifAlias),
      ...Object.keys(ifDescr),
      ...Object.keys(ifNames),
      ...Object.keys(hcInOctets),
      ...Object.keys(inOctets32),
    ])
  );
  const trunks: TrunkMetric[] = [];
  const parseCounter = (value: unknown): bigint | null => {
    if (value === undefined || value === null) return null;
    const s = String(value).trim();
    if (!s) return null;
    try {
      return BigInt(s);
    } catch {
      return null;
    }
  };
  for (const idx of indexes) {
    const alias = String(ifAlias[idx] || "").trim();
    const descr = String(ifDescr[idx] || "").trim();
    const ifName = String(ifNames[idx] || `if${idx}`).trim();
    if (!isLikelyTrunkPort(ifName, alias, descr, ifType[idx]) && !ciscoHints.has(idx)) continue;
    const desc = alias || descr || ifName;
    const in64 = parseCounter(hcInOctets[idx]);
    const out64 = parseCounter(hcOutOctets[idx]);
    const in32 = parseCounter(inOctets32[idx]);
    const out32 = parseCounter(outOctets32[idx]);
    const use64 = in64 !== null && out64 !== null;
    const inNow = use64 ? in64 : in32;
    const outNow = use64 ? out64 : out32;
    if (inNow === null || outNow === null) continue;
    const bits: 32 | 64 = use64 ? 64 : 32;
    const key = `${host}:${idx}`;
    const prev = trunkCounterCache.get(key);
    let inBps = 0;
    let outBps = 0;
    if (prev && now > prev.ts && prev.bits === bits) {
      const dt = (now - prev.ts) / 1000;
      // Ignore too short/long sample windows to avoid bursty "random" rates.
      if (dt >= 5 && dt <= 120) {
        const wrapAt = bits === 64 ? (1n << 64n) : (1n << 32n);
        const inDelta = inNow >= prev.inOctets ? (inNow - prev.inOctets) : ((wrapAt - prev.inOctets) + inNow);
        const outDelta = outNow >= prev.outOctets ? (outNow - prev.outOctets) : ((wrapAt - prev.outOctets) + outNow);
        inBps = Math.max(0, Math.round((Number(inDelta) * 8) / Math.max(dt, 1)));
        outBps = Math.max(0, Math.round((Number(outDelta) * 8) / Math.max(dt, 1)));
        const speed = Number(ifSpeed[idx] || 0);
        // Drop physically impossible rates (counter glitches/resets).
        if (Number.isFinite(speed) && speed > 0) {
          const hardCap = speed * 1.2;
          if (inBps > hardCap) inBps = 0;
          if (outBps > hardCap) outBps = 0;
        }
      }
    }
    trunkCounterCache.set(key, { inOctets: inNow, outOctets: outNow, ts: now, bits });
    trunks.push({
      ifIndex: idx,
      ifName,
      description: desc,
      operStatus: Number(ifOper[idx] || 2),
      inBps,
      outBps,
    });
  }
  return trunks;
}

function getActiveSshReadonlyProfile(): SshReadonlyProfile | null {
  if (!sshReadonlyProfile) return null;
  if (sshReadonlyProfile.expiresAt <= Date.now()) {
    sshReadonlyProfile = null;
    return null;
  }
  return sshReadonlyProfile;
}

function sshCommandsForModel(model: string): string[] {
  const m = (model || "").toLowerCase();
  if (m.includes("cx6000") || m.includes("cx 6000")) return ["show lacp interfaces", "show interfaces brief"];
  if (m.includes("2530")) return ["show trunks", "show interfaces brief"];
  if (m.includes("1910") || m.includes("1810")) return ["display link-aggregation summary", "display interface brief"];
  return ["show trunks", "show interfaces brief"];
}

function runSshReadonlyCommands(host: string, username: string, password: string, port: number, commands: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const chunks: string[] = [];
    client
      .on("ready", () => {
        const runNext = (idx: number) => {
          if (idx >= commands.length) {
            client.end();
            return resolve(chunks.join("\n"));
          }
          const cmd = commands[idx];
          client.exec(cmd, (err, stream) => {
            if (err) return reject(err);
            let out = "";
            stream.on("data", (d: Buffer) => {
              out += d.toString("utf8");
            });
            stream.stderr.on("data", (d: Buffer) => {
              out += d.toString("utf8");
            });
            stream.on("close", () => {
              chunks.push(`\n# ${cmd}\n${out}`);
              runNext(idx + 1);
            });
          });
        };
        runNext(0);
      })
      .on("error", (e) => reject(e))
      .connect({
        host,
        port,
        username,
        password,
        readyTimeout: 10000,
        tryKeyboard: true,
        ...legacySshConnectOptions(),
      });
  });
}

function parseTrunksFromSshText(text: string): TrunkMetric[] {
  const lines = text.split(/\r?\n/);
  const out: TrunkMetric[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!/(trunk|trk|lag|bridge-aggregation|port-channel)/i.test(line)) continue;
    const ifMatch = line.match(/(bridge-aggregation\d+|port-channel\d+|trunk\s*\d+|trk\d+|lag\d+)/i);
    const ifName = ifMatch ? ifMatch[1].replace(/\s+/g, "") : line.split(/\s+/)[0];
    const isUp = /\bup\b|forward|selected|active/i.test(line) && !/\bdown\b|disabled|inactive/i.test(line);
    out.push({
      ifIndex: String(out.length + 1),
      ifName,
      description: "ssh-readonly",
      operStatus: isUp ? 1 : 2,
      inBps: 0,
      outBps: 0,
    });
  }
  return out;
}

async function collectTrunkMetricsWithFallback(item: InventoryItem): Promise<TrunkMetric[]> {
  const snmpTrunks = await collectTrunkMetrics(item.ip);
  if (snmpTrunks.length > 0) return snmpTrunks;
  const profile = getActiveSshReadonlyProfile();
  if (!profile || !profile.allowMetricsFallback) return [];
  try {
    const output = await runSshReadonlyCommands(
      item.ip,
      profile.username,
      profile.password,
      profile.port,
      sshCommandsForModel(item.model)
    );
    return parseTrunksFromSshText(output);
  } catch {
    return [];
  }
}

async function inferTopologyLinksFromTrunkDescriptions(branch?: string): Promise<TopologyLink[]> {
  const branchFilter = String(branch || "").trim();
  const devices = branchFilter
    ? inventory.filter((item) => String(item.branch || "").trim() === branchFilter)
    : inventory;
  if (devices.length < 2) return [];

  const byId = new Map(devices.map((d) => [d.id, d]));
  const directed: Array<{ source: string; target: string; portA: string; raw: string }> = [];
  const isFcSwitch = (item: InventoryItem) => {
    const category = String(item.category || "").toLowerCase();
    return category === "fc switch" || category === "fibre channel switch" || category === "fiber channel switch";
  };
  const detectFcRole = (item: InventoryItem): "core" | "edge" | "unknown" => {
    const n = String(item.name || "").toLowerCase();
    if (/(^|[\s\-_])(core|san-core|fc-core|director)([\s\-_]|$)/.test(n)) return "core";
    if (/(^|[\s\-_])(edge|leaf|access|san-edge)([\s\-_]|$)/.test(n)) return "edge";
    const s = String(item.subcategory || "").toLowerCase();
    if (s === "core") return "core";
    if (s === "access") return "edge";
    return "unknown";
  };
  const looksLikeFcPort = (ifName: string, alias: string, descr: string): boolean => {
    const v = `${ifName} ${alias} ${descr}`.toLowerCase();
    return /\b(fc\d+\/\d+|fc\d+|\d+\/\d+|fibre|fiber|san|port\s*\d+|port\d+|sfp)\b/.test(v);
  };
  const norm = (v: string) => v.toLowerCase().replace(/\s+/g, " ").trim();
  const genericDevices = devices.filter((d) => !isFcSwitch(d));
  const findDeviceByNameHint = (hint: string, selfId: string): InventoryItem | undefined => {
    const h = norm(hint);
    if (!h) return undefined;
    const candidates = devices
      .filter((d) => d.id !== selfId)
      .map((d) => {
        const n = norm(d.name);
        const ip = d.ip.toLowerCase();
        const host = d.ip.split(".").join("-");
        const score =
          (n && (h.includes(n) || n.includes(h)) ? Math.min(n.length, h.length) * 3 : 0) +
          (ip && h.includes(ip) ? ip.length * 2 : 0) +
          (host && h.includes(host) ? host.length : 0);
        return { d, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return candidates[0]?.d;
  };

  await forEachWithLimit(genericDevices, 12, async (dev) => {
    try {
      const [ifNameMap, ifAliasMap, ifDescrMap, ifTypeMap, ciscoHints] = await Promise.all([
        snmpWalk(dev.ip, "1.3.6.1.2.1.31.1.1.1.1"), // ifName
        snmpWalk(dev.ip, "1.3.6.1.2.1.31.1.1.1.18"), // ifAlias/Description
        snmpWalk(dev.ip, "1.3.6.1.2.1.2.2.1.2"), // ifDescr (fallback for old gear)
        snmpWalk(dev.ip, "1.3.6.1.2.1.2.2.1.3"), // ifType
        getCiscoTrunkPortHints(dev.ip),
      ]);
      const indexes = new Set([...Object.keys(ifAliasMap), ...Object.keys(ifDescrMap)]);
      for (const ifIndex of indexes) {
        const alias = String(ifAliasMap[ifIndex] || "").trim();
        const descr = String(ifDescrMap[ifIndex] || "").trim();
        const ifName = String(ifNameMap[ifIndex] || `if${ifIndex}`).trim();
        const trunkHint = alias || descr;
        if (!isLikelyTrunkPort(ifName, alias, descr, ifTypeMap[ifIndex]) && !ciscoHints.has(ifIndex)) continue;
        const aliasNorm = norm(trunkHint);
        const peer = findDeviceByNameHint(aliasNorm, dev.id);
        if (!peer) continue;
        directed.push({ source: dev.id, target: peer.id, portA: ifName, raw: trunkHint });
      }
    } catch {
      // Skip device-level parsing errors, keep building topology from others.
    }
  });

  // Fallback path: LLDP neighbor correlation for trunk-like local ports.
  await forEachWithLimit(genericDevices, 10, async (dev) => {
    try {
      const [ifNameMap, ifAliasMap, ifDescrMap, ifTypeMap, basePortIfIndex, lldpLocPortId, lldpRemSysName, ciscoHints] = await Promise.all([
        snmpWalk(dev.ip, "1.3.6.1.2.1.31.1.1.1.1"), // ifName
        snmpWalk(dev.ip, "1.3.6.1.2.1.31.1.1.1.18"), // ifAlias
        snmpWalk(dev.ip, "1.3.6.1.2.1.2.2.1.2"), // ifDescr
        snmpWalk(dev.ip, "1.3.6.1.2.1.2.2.1.3"), // ifType
        snmpWalk(dev.ip, "1.3.6.1.2.1.17.1.4.1.2"), // dot1dBasePortIfIndex
        snmpWalk(dev.ip, "1.0.8802.1.1.2.1.3.7.1.3"), // lldpLocPortId
        snmpWalk(dev.ip, "1.0.8802.1.1.2.1.4.1.1.9"), // lldpRemSysName
        getCiscoTrunkPortHints(dev.ip),
      ]);

      const trunkIfIndexes = new Set<string>();
      const allIf = new Set([...Object.keys(ifNameMap), ...Object.keys(ifAliasMap), ...Object.keys(ifDescrMap)]);
      for (const ifIndex of allIf) {
        const ifName = String(ifNameMap[ifIndex] || `if${ifIndex}`).trim();
        const alias = String(ifAliasMap[ifIndex] || "").trim();
        const descr = String(ifDescrMap[ifIndex] || "").trim();
        if (isLikelyTrunkPort(ifName, alias, descr, ifTypeMap[ifIndex]) || ciscoHints.has(ifIndex)) trunkIfIndexes.add(ifIndex);
      }

      for (const [suffix, sysNameRaw] of Object.entries(lldpRemSysName)) {
        const sysName = String(sysNameRaw || "").trim();
        if (!sysName) continue;
        const parts = suffix.split(".").filter(Boolean);
        if (parts.length < 3) continue;
        const localPortNum = parts[1];
        const ifIndexFromBridge = String(basePortIfIndex[localPortNum] || "").trim();
        const ifIndex = ifIndexFromBridge || "";

        let localIfName = "";
        if (ifIndex) {
          localIfName = String(ifNameMap[ifIndex] || `if${ifIndex}`).trim();
        } else {
          const localPortId = String(lldpLocPortId[localPortNum] || "").trim().toLowerCase();
          if (localPortId) {
            const matched = Object.entries(ifNameMap).find(([, name]) => String(name || "").trim().toLowerCase() === localPortId);
            if (matched) {
              localIfName = String(matched[1] || "").trim();
            }
          }
        }
        if (!localIfName) continue;
        // If trunk-like interfaces were identified on device, prefer LLDP edges on those ports.
        // If not, allow all LLDP neighbors as fallback (some vendors don't mark trunk in ifAlias/ifDescr).
        if (ifIndex && trunkIfIndexes.size > 0 && !trunkIfIndexes.has(ifIndex)) continue;
        const peer = findDeviceByNameHint(sysName, dev.id);
        if (!peer) continue;
        directed.push({ source: dev.id, target: peer.id, portA: localIfName, raw: `LLDP:${sysName}` });
      }
    } catch {
      // Skip device-level LLDP errors and continue.
    }
  });

  // Generic fallback: infer links from interface comments/aliases that mention peer devices.
  // Useful for MikroTik and other platforms where trunk keywords are absent but comments are present.
  await forEachWithLimit(genericDevices, 12, async (dev) => {
    try {
      const [ifNameMap, ifAliasMap, ifDescrMap] = await Promise.all([
        snmpWalk(dev.ip, "1.3.6.1.2.1.31.1.1.1.1"), // ifName
        snmpWalk(dev.ip, "1.3.6.1.2.1.31.1.1.1.18"), // ifAlias / comment
        snmpWalk(dev.ip, "1.3.6.1.2.1.2.2.1.2"), // ifDescr
      ]);
      const indexes = new Set([...Object.keys(ifNameMap), ...Object.keys(ifAliasMap), ...Object.keys(ifDescrMap)]);
      for (const ifIndex of indexes) {
        const ifName = String(ifNameMap[ifIndex] || `if${ifIndex}`).trim();
        const alias = String(ifAliasMap[ifIndex] || "").trim();
        const descr = String(ifDescrMap[ifIndex] || "").trim();
        const hintRaw = `${alias} ${descr}`.trim();
        if (!hintRaw || hintRaw.length < 3) continue;
        const peer = findDeviceByNameHint(hintRaw, dev.id);
        if (!peer || isFcSwitch(peer)) continue;
        directed.push({ source: dev.id, target: peer.id, portA: ifName || `if${ifIndex}`, raw: `IF-COMMENT:${hintRaw}` });
      }
    } catch {
      // continue
    }
  });

  // FC-specific path: LLDP correlation with CORE<->EDGE pairing by switch naming.
  const fcDevices = devices.filter((d) => isFcSwitch(d));
  await forEachWithLimit(fcDevices, 10, async (dev) => {
    try {
      const [ifNameMap, basePortIfIndex, lldpLocPortId, lldpRemSysName] = await Promise.all([
        snmpWalk(dev.ip, "1.3.6.1.2.1.31.1.1.1.1"), // ifName
        snmpWalk(dev.ip, "1.3.6.1.2.1.17.1.4.1.2"), // dot1dBasePortIfIndex
        snmpWalk(dev.ip, "1.0.8802.1.1.2.1.3.7.1.3"), // lldpLocPortId
        snmpWalk(dev.ip, "1.0.8802.1.1.2.1.4.1.1.9"), // lldpRemSysName
      ]);
      const selfRole = detectFcRole(dev);
      for (const [suffix, sysNameRaw] of Object.entries(lldpRemSysName)) {
        const sysName = String(sysNameRaw || "").trim();
        if (!sysName) continue;
        const peer = findDeviceByNameHint(sysName, dev.id);
        if (!peer || !isFcSwitch(peer)) continue;
        const peerRole = detectFcRole(peer);
        const roleCompatible =
          (selfRole === "core" && peerRole === "edge") ||
          (selfRole === "edge" && peerRole === "core") ||
          selfRole === "unknown" ||
          peerRole === "unknown";
        if (roleCompatible) {
          const parts = suffix.split(".").filter(Boolean);
          if (parts.length < 3) continue;
          const localPortNum = parts[1];
          const ifIndex = String(basePortIfIndex[localPortNum] || "").trim();
          let localIfName = ifIndex ? String(ifNameMap[ifIndex] || `if${ifIndex}`).trim() : "";
          if (!localIfName) {
            const localPortId = String(lldpLocPortId[localPortNum] || "").trim().toLowerCase();
            if (localPortId) {
              const matched = Object.entries(ifNameMap).find(([, name]) => String(name || "").trim().toLowerCase() === localPortId);
              if (matched) localIfName = String(matched[1] || "").trim();
            }
          }
          directed.push({ source: dev.id, target: peer.id, portA: localIfName || "fc-port", raw: `FC-LLDP:${sysName}` });
        }
      }
    } catch {
      // continue
    }
  });

  // FC fallback path: infer links from FC port descriptions/aliases when LLDP is absent.
  await forEachWithLimit(fcDevices, 10, async (dev) => {
    try {
      const [ifNameMap, ifAliasMap, ifDescrMap] = await Promise.all([
        snmpWalk(dev.ip, "1.3.6.1.2.1.31.1.1.1.1"), // ifName
        snmpWalk(dev.ip, "1.3.6.1.2.1.31.1.1.1.18"), // ifAlias
        snmpWalk(dev.ip, "1.3.6.1.2.1.2.2.1.2"), // ifDescr
      ]);
      const selfRole = detectFcRole(dev);
      const indexes = new Set([...Object.keys(ifNameMap), ...Object.keys(ifAliasMap), ...Object.keys(ifDescrMap)]);
      for (const ifIndex of indexes) {
        const ifName = String(ifNameMap[ifIndex] || `if${ifIndex}`).trim();
        const alias = String(ifAliasMap[ifIndex] || "").trim();
        const descr = String(ifDescrMap[ifIndex] || "").trim();
        const hintRaw = `${alias} ${descr}`.trim();
        if (!hintRaw && !looksLikeFcPort(ifName, alias, descr)) continue;
        const hint = norm(hintRaw || ifName);
        const peer = findDeviceByNameHint(hint, dev.id);
        if (!peer || !isFcSwitch(peer)) continue;
        const peerRole = detectFcRole(peer);
        const roleCompatible =
          (selfRole === "core" && peerRole === "edge") ||
          (selfRole === "edge" && peerRole === "core") ||
          selfRole === "unknown" ||
          peerRole === "unknown";
        if (!roleCompatible) continue;
        directed.push({ source: dev.id, target: peer.id, portA: ifName || "fc-port", raw: `FC-ALIAS:${alias || descr}` });
      }
    } catch {
      // continue
    }
  });

  // FC hard fallback: if peer hints are absent, still build CORE<->EDGE links using active FC-like ports.
  // This is intentionally simple to provide a visible SAN topology even on devices without LLDP/comments.
  const existingFcPair = new Set(
    directed
      .filter((d) => {
        const s = byId.get(d.source);
        const t = byId.get(d.target);
        return !!s && !!t && isFcSwitch(s) && isFcSwitch(t);
      })
      .map((d) => [d.source, d.target].sort().join("::"))
  );
  const getActiveFcPorts = async (dev: InventoryItem): Promise<string[]> => {
    try {
      const [ifNameMap, ifAliasMap, ifDescrMap, ifOperMap] = await Promise.all([
        snmpWalk(dev.ip, "1.3.6.1.2.1.31.1.1.1.1"), // ifName
        snmpWalk(dev.ip, "1.3.6.1.2.1.31.1.1.1.18"), // ifAlias
        snmpWalk(dev.ip, "1.3.6.1.2.1.2.2.1.2"), // ifDescr
        snmpWalk(dev.ip, "1.3.6.1.2.1.2.2.1.8"), // ifOperStatus
      ]);
      const indexes = new Set([...Object.keys(ifNameMap), ...Object.keys(ifAliasMap), ...Object.keys(ifDescrMap), ...Object.keys(ifOperMap)]);
      const ports: string[] = [];
      for (const ifIndex of indexes) {
        const ifName = String(ifNameMap[ifIndex] || `if${ifIndex}`).trim();
        const alias = String(ifAliasMap[ifIndex] || "").trim();
        const descr = String(ifDescrMap[ifIndex] || "").trim();
        const oper = Number(ifOperMap[ifIndex] || 0);
        if (oper !== 1) continue;
        if (!looksLikeFcPort(ifName, alias, descr)) continue;
        ports.push(ifName || `if${ifIndex}`);
      }
      return ports;
    } catch {
      return [];
    }
  };
  if (fcDevices.length >= 2) {
    const cores = fcDevices.filter((d) => detectFcRole(d) === "core");
    const edges = fcDevices.filter((d) => detectFcRole(d) === "edge");
    if (cores.length > 0 && edges.length > 0) {
      const portsByDevice = new Map<string, string[]>();
      await forEachWithLimit([...cores, ...edges], 8, async (d) => {
        portsByDevice.set(d.id, await getActiveFcPorts(d));
      });
      const usedPort = new Set<string>();
      const pickPort = (devId: string) => {
        const ports = portsByDevice.get(devId) || [];
        const p = ports.find((x) => !usedPort.has(`${devId}:${x}`));
        if (!p) return "fc-port";
        usedPort.add(`${devId}:${p}`);
        return p;
      };
      for (const edge of edges) {
        // Prefer at least one core link for each edge.
        const preferredCores = [...cores];
        for (const core of preferredCores) {
          const pairKey = [core.id, edge.id].sort().join("::");
          if (existingFcPair.has(pairKey)) continue;
          const corePort = pickPort(core.id);
          const edgePort = pickPort(edge.id);
          directed.push({ source: core.id, target: edge.id, portA: corePort, raw: "FC-SYNTHETIC" });
          directed.push({ source: edge.id, target: core.id, portA: edgePort, raw: "FC-SYNTHETIC" });
          existingFcPair.add(pairKey);
          break;
        }
      }
    }
  }

  const used = new Set<string>();
  const out: TopologyLink[] = [];
  for (const d of directed) {
    const key = [d.source, d.target].sort().join("::");
    if (used.has(key)) continue;
    const reverse = directed.find((x) => x.source === d.target && x.target === d.source);
    const portA = d.portA;
    const portB = reverse?.portA || (reverse ? reverse.raw : "Trunk");
    if (!byId.has(d.source) || !byId.has(d.target)) continue;
    out.push({ source: d.source, target: d.target, portA, portB });
    used.add(key);
  }
  return out;
}

function rebuildTopologyFromInventory() {
  const existing = new Set(inventory.map((i) => i.id));
  topologyLinks = topologyLinks
    .filter((l) => existing.has(l.source) && existing.has(l.target))
    .map((l) => ensureTopologyLinkId(l));
}

function testLdapServiceBind(profile: LdapRoleProfile): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    if (!profile.url?.trim()) return resolve({ ok: false, message: "Укажите URL сервера LDAP" });
    if (!profile.bindDn?.trim()) return resolve({ ok: false, message: "Укажите Bind DN" });
    if (!profile.searchBase?.trim()) return resolve({ ok: false, message: "Укажите Search Base" });

    const client = ldap.createClient({
      url: profile.url,
      timeout: 12000,
      connectTimeout: 12000,
      tlsOptions: { rejectUnauthorized: profile.tlsRejectUnauthorized },
    });
    const done = (ok: boolean, message: string) => {
      try {
        client.unbind();
      } catch {
        /* ignore */
      }
      resolve({ ok, message });
    };
    client.on("error", (err: Error) => done(false, err.message));
    client.bind(profile.bindDn, profile.bindPassword, (bindErr: Error | null) => {
      if (bindErr) return done(false, bindErr.message);
      client.search(
        profile.searchBase,
        { filter: "(objectClass=*)", scope: "base", sizeLimit: 1 },
        (sErr, res) => {
          if (sErr || !res) return done(false, sErr?.message || "Ошибка LDAP search");
          res.on("searchEntry", () => {});
          res.on("error", (e: Error) => done(false, e.message));
          res.on("end", () => done(true, "Соединение и bind успешны, база поиска доступна"));
        }
      );
    });
  });
}

const logAction = (user: string, action: string, details: string, category: AuditLog['category']) => {
  const log: AuditLog = {
    id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
    timestamp: new Date().toISOString(),
    user,
    action,
    details,
    category
  };
  auditLogs.unshift(log); // Newest first
  if (auditLogs.length > 500) auditLogs.pop(); // Keep last 500 logs
  console.log(`[Audit] [${category.toUpperCase()}] ${user}: ${action} - ${details}`);
};

function parseCookies(req: express.Request): Record<string, string> {
  const src = req.headers.cookie || "";
  return src
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, entry) => {
      const idx = entry.indexOf("=");
      if (idx <= 0) return acc;
      const key = entry.slice(0, idx).trim();
      const value = decodeURIComponent(entry.slice(idx + 1).trim());
      acc[key] = value;
      return acc;
    }, {});
}

function writeSessionCookie(res: express.Response, sessionId: string, secure: boolean) {
  res.cookie(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

function clearSessionCookie(res: express.Response, secure: boolean) {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
  });
}

function makeSession(user: AuthUser): string {
  const sid = crypto.randomBytes(32).toString("hex");
  sessionStore.set(sid, { user, expiresAt: Date.now() + SESSION_TTL_MS });
  return sid;
}

function readSession(req: express.Request): { sid?: string; user: AuthUser | null } {
  const sid = parseCookies(req)[SESSION_COOKIE_NAME];
  if (!sid) return { user: null };
  const record = sessionStore.get(sid);
  if (!record) return { sid, user: null };
  if (record.expiresAt <= Date.now()) {
    sessionStore.delete(sid);
    return { sid, user: null };
  }
  return { sid, user: record.user };
}

function authFromRequest(req: express.Request): AuthUser {
  const session = readSession(req).user;
  if (session) return session;
  return {
    id: String(req.headers["x-user-id"] || "header-user"),
    username: String(req.headers["x-user-name"] || "unknown"),
    role: String(req.headers["x-user-role"] || "viewer"),
  };
}

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  const PORT = process.env.PORT || 3000;
  const isProd = process.env.NODE_ENV === "production";
  const useSecureCookie = isProd;

  console.log(`Starting server on port ${PORT} (NODE_ENV=${process.env.NODE_ENV})`);

  app.use(express.json());
  
  // Helper: Role Check Middleware (Simulated)
  const checkRole = (roles: string[]) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const userRole = authFromRequest(req).role || "viewer";
    if (roles.includes(userRole)) {
      next();
    } else {
      res.status(403).json({ error: "Access Denied: Insufficient permissions." });
    }
  };

  if (discoveryScheduler) clearInterval(discoveryScheduler);
  discoveryScheduler = setInterval(async () => {
    try {
      discoverySchedulerLastTickAt = new Date().toISOString();
      const enabled = discoveryWatchProfiles.some((p) => p.enabled);
      if (!enabled) return;
      const out = await (async () => {
        if (discoveryRunLock) return { started: false };
        return { started: true };
      })();
      if (!out.started) return;
      // Trigger only due profiles; actor is system scheduler
      const actor = "system-scheduler";
      if (discoveryRunLock) return;
      discoveryRunLock = true;
      try {
        const now = Date.now();
        let processed = 0;
        for (const p of discoveryWatchProfiles) {
          if (!p.enabled) continue;
          const intervalMs = Math.max(1, Number(p.intervalHours || 3)) * 60 * 60 * 1000;
          if (p.lastRunAt && now - new Date(p.lastRunAt).getTime() < intervalMs) continue;
          try {
            const summary = await runDiscoveryScan({
              subnets: p.subnets,
              protocol: p.protocol,
              city: p.city,
              zone: p.zone,
              branch: p.branch,
              actor,
              reason: "scheduled",
            });
            p.lastRunAt = new Date().toISOString();
            p.lastResult = summary;
          } catch (e) {
            p.lastRunAt = new Date().toISOString();
            p.lastResult = { success: false, error: e instanceof Error ? e.message : String(e) };
          }
          processed++;
        }
        if (processed > 0) {
          discoverySchedulerLastProcessed = processed;
          logAction(actor, "Discovery Watch Scheduled Run", `Profiles processed: ${processed}`, "inventory");
        }
      } finally {
        discoveryRunLock = false;
      }
    } catch {
      /* ignore scheduler errors */
    }
  }, 60 * 1000);
  logAction("system", "Discovery Watch Scheduler Start", "Scheduler initialized (1-minute tick, per-profile interval)", "system");

  // API: Audit Logs
  app.get("/api/audit-logs", checkRole(['admin']), (req, res) => {
    res.json(auditLogs);
  });

  // API: System Configuration
  app.get("/api/config/system", checkRole(['admin', 'operator']), (req, res) => {
    res.json({ config: systemConfig });
  });

  app.post("/api/config/system", checkRole(['admin']), (req, res) => {
    const actor = req.headers["x-user-name"] as string || "unknown";
    systemConfig = { ...systemConfig, ...req.body };
    logAction(actor, 'System Config Update', `Updated system settings`, 'config');
    res.json({ success: true, config: systemConfig });
  });

  app.get("/api/system/banner", checkRole(['admin', 'operator', 'viewer']), (_req, res) => {
    res.json({
      siteLabel: systemConfig.siteLabel || "UNSET",
      appUptime: formatDuration(process.uptime()),
    });
  });

  app.get("/api/config/ldap", checkRole(['admin']), (_req, res) => {
    res.json({ ldap: maskLdapForClient() });
  });

  app.post("/api/config/ldap", checkRole(['admin']), (req, res) => {
    const actor = req.headers["x-user-name"] as string || "unknown";
    const body = req.body as { admin?: Partial<LdapRoleProfile>; operator?: Partial<LdapRoleProfile> };
    mergeLdapPasswords(body || {});
    logAction(actor, 'LDAP Config Update', 'Updated LDAP authentication profiles', 'config');
    res.json({ success: true, ldap: maskLdapForClient() });
  });

  app.post("/api/config/ldap/test", checkRole(["admin"]), async (req, res) => {
    const body = req.body as {
      profile?: "admin" | "operator";
      draft?: Partial<LdapRoleProfile>;
      testUsername?: string;
      testPassword?: string;
    };
    const key = body.profile === "operator" ? "operator" : "admin";
    let p: LdapRoleProfile = { ...ldapConfig[key] };
    if (body.draft && typeof body.draft === "object") {
      p = { ...p, ...body.draft } as LdapRoleProfile;
      const bp = body.draft.bindPassword;
      if (!bp?.trim() || bp === "********") {
        p.bindPassword = ldapConfig[key].bindPassword;
      }
    }

    if (body.testUsername && body.testPassword) {
      const ok = await verifyLdapLogin({ ...p, enabled: true }, body.testUsername, body.testPassword);
      return res.json({
        ok,
        message: ok
          ? "Учётная запись найдена, пароль принят каталогом"
          : "Проверка не пройдена: пользователь/пароль или фильтр поиска",
      });
    }

    const bindRes = await testLdapServiceBind(p);
    logAction(
      (req.headers["x-user-name"] as string) || "unknown",
      "LDAP Test",
      `${key}: ${bindRes.message}`,
      "config"
    );
    return res.json(bindRes);
  });

  // API: Inventory Bulk Actions
  app.get("/api/inventory/meta", checkRole(['admin', 'operator', 'viewer']), (_req, res) => {
    res.json(inventoryMeta);
  });

  app.post("/api/inventory/meta", checkRole(['admin', 'operator']), (req, res) => {
    const body = req.body as {
      categories?: string[];
      subcategories?: string[];
      branches?: string[];
      cities?: string[];
      zones?: string[];
      vendors?: string[];
      models?: Record<string, string[]>;
    };
    if (Array.isArray(body.categories)) {
      inventoryMeta.categories = [...new Set(body.categories.map((v) => String(v).trim()).filter(Boolean))];
    }
    if (Array.isArray(body.subcategories)) {
      inventoryMeta.subcategories = [...new Set(body.subcategories.map((v) => String(v).trim()).filter(Boolean))];
    }
    if (Array.isArray(body.branches)) {
      inventoryMeta.branches = [...new Set(body.branches.map((v) => String(v).trim()).filter(Boolean))];
    }
    if (Array.isArray(body.cities)) {
      inventoryMeta.cities = [...new Set(body.cities.map((v) => String(v).trim()).filter(Boolean))];
    }
    if (Array.isArray(body.zones)) {
      inventoryMeta.zones = [...new Set(body.zones.map((v) => String(v).trim()).filter(Boolean))];
    }
    if (Array.isArray(body.vendors)) {
      inventoryMeta.vendors = [...new Set(body.vendors.map((v) => String(v).trim()).filter(Boolean))];
    }
    if (body.models && typeof body.models === "object") {
      const next: Record<string, string[]> = {};
      for (const [vendor, list] of Object.entries(body.models)) {
        next[vendor] = [...new Set((list || []).map((v) => String(v).trim()).filter(Boolean))];
      }
      inventoryMeta.models = next;
    }
    res.json({ success: true, meta: inventoryMeta });
  });

  app.post("/api/inventory/bulk", checkRole(['admin', 'operator']), (req, res) => {
    const { ids, action, value } = req.body;
    const actor = req.headers["x-user-name"] as string || "unknown";

    if (!Array.isArray(ids)) return res.status(400).json({ error: 'Invalid IDs' });

    if (action === "delete") {
      if ((req.headers["x-user-role"] as string) !== "admin") {
        return res.status(403).json({ error: "Access Denied: Insufficient permissions." });
      }
      inventory = inventory.filter((item) => !ids.includes(item.id));
      Object.keys(topologyLayout).forEach((id) => {
        if (ids.includes(id)) delete topologyLayout[id];
      });
    } else {
      inventory = inventory.map(item => {
        if (ids.includes(item.id)) {
          if (action === 'reboot') return { ...item, status: 'offline', uptime: '0d 0h', uptimeSeconds: 0 };
        }
        return item;
      });
    }

    logAction(actor, 'Bulk Action', `Performed ${action} on ${ids.length} devices`, 'inventory');
    res.json({ success: true, count: ids.length });
  });

  // API: Health Check
  app.get("/api/health", (req, res) => {
    res.json({ status: "online", version: "pro", timestamp: new Date().toISOString() });
  });

  // API: Get Inventory
  app.get("/api/inventory", (_req, res) => {
    Promise.all(
      inventory.map(async (item) => {
        const probe = await getSnmpProbe(item.ip, 900);
        if (!probe.ok) {
          return {
            ...item,
            status: "offline" as const,
          };
        }
        const nextVendor = probe.sysDescr ? detectVendorFromSnmp(probe.sysDescr, probe.sysObjectId || "") : item.vendor;
        const nextModel = detectModelFromSnmp(probe.sysDescr || "", probe.sysObjectId || "", probe.sysName || "") || item.model;
        const nextName = probe.sysName?.trim() ? probe.sysName.trim() : item.name;
        const nextCategory = detectCategoryFromSnmp(probe.sysDescr || "", probe.sysObjectId || "", probe.sysName || "");
        const uptimeSeconds = probe.uptimeSeconds ?? item.uptimeSeconds ?? 0;
        return {
          ...item,
          name: nextName,
          vendor: nextVendor,
          model: nextModel,
          category: item.category || nextCategory,
          branch: item.branch || "ULN",
          status: "online" as const,
          uptimeSeconds,
          uptime: formatDuration(uptimeSeconds),
        };
      })
    )
      .then((next) => res.json(next))
      .catch(() =>
        res.json(
          inventory.map((item) => ({
            ...item,
            status: item.status ?? ("offline" as const),
          }))
        )
      );
  });

  app.post("/api/inventory", checkRole(['admin', 'operator']), (req, res) => {
    const sw = req.body;
    const actor = req.headers["x-user-name"] as string || "unknown";
    const category = String(sw.category || "Switch");
    const normalizedCategory = category.toLowerCase();
    const fcSubcategory = (
      normalizedCategory === "fc switch" ||
      normalizedCategory === "fibre channel switch" ||
      normalizedCategory === "fiber channel switch"
    ) ? deriveFcSubcategoryByName(String(sw.name || "")) : undefined;
    const newSwitch = {
      ...sw,
      id: Date.now().toString(),
      category,
      subcategory: fcSubcategory || sw.subcategory || "Core",
      branch: sw.branch || "ULN",
      city: sw.city || "Ульяновск",
      zone: sw.zone || "Core",
    } as InventoryItem;
    upsertInventoryMetaFromItem(newSwitch);
    inventory.push(newSwitch);
    rebuildTopologyFromInventory();
    logAction(actor, 'Add Device', `Registered new switch: ${newSwitch.name} (${newSwitch.ip})`, 'inventory');
    res.json(newSwitch);
  });

  app.patch("/api/inventory/:id", checkRole(['admin', 'operator']), (req, res) => {
    const actor = req.headers["x-user-name"] as string || "unknown";
    const index = inventory.findIndex(s => s.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: "Device not found" });
    
    const oldName = inventory[index].name;
    inventory[index] = { ...inventory[index], ...req.body } as InventoryItem;
    const category = String(inventory[index].category || "").toLowerCase();
    if (category === "fc switch" || category === "fibre channel switch" || category === "fiber channel switch") {
      inventory[index].subcategory = deriveFcSubcategoryByName(inventory[index].name || "");
    }
    upsertInventoryMetaFromItem(inventory[index]);
    rebuildTopologyFromInventory();
    logAction(actor, 'Update Device', `Updated device configurations for: ${oldName}`, 'inventory');
    res.json(inventory[index]);
  });

  app.delete("/api/inventory/:id", checkRole(['admin']), (req, res) => {
    const actor = req.headers["x-user-name"] as string || "unknown";
    const sw = inventory.find(s => s.id === req.params.id);
    if (sw) {
      logAction(actor, 'Remove Device', `Deleted switch: ${sw.name} (${sw.ip})`, 'inventory');
      inventory = inventory.filter(s => s.id !== req.params.id);
      rebuildTopologyFromInventory();
      res.json({ success: true });
    } else {
      res.status(404).json({ error: "Device not found" });
    }
  });

  // API: User Management
  app.get("/api/users", checkRole(['admin']), (req, res) => {
    // Don't send passwords to frontend
    res.json(users.map(({ password, ...u }) => u));
  });

  app.post("/api/auth/login", async (req, res) => {
    const { username, password } = req.body as { username?: string; password?: string };

    const user = users.find((u) => u.username === username && u.password === password);
    if (user) {
      const authUser = { id: user.id, username: user.username, role: user.role };
      const sid = makeSession(authUser);
      writeSessionCookie(res, sid, useSecureCookie);
      logAction(username || "unknown", "Login Success", "User authenticated successfully", "auth");
      return res.json({ success: true, user: authUser });
    }

    if (username && password) {
      const adminOk = await verifyLdapLogin(ldapConfig.admin, username, password);
      if (adminOk) {
        const authUser = { id: `ldap-admin:${username}`, username, role: "admin" };
        const sid = makeSession(authUser);
        writeSessionCookie(res, sid, useSecureCookie);
        logAction(username, "Login Success", "LDAP (administrators profile)", "auth");
        return res.json({ success: true, user: authUser });
      }
      const operatorOk = await verifyLdapLogin(ldapConfig.operator, username, password);
      if (operatorOk) {
        const authUser = { id: `ldap-operator:${username}`, username, role: "operator" };
        const sid = makeSession(authUser);
        writeSessionCookie(res, sid, useSecureCookie);
        logAction(username, "Login Success", "LDAP (operators profile)", "auth");
        return res.json({ success: true, user: authUser });
      }
    }

    logAction(username || "unknown", "Login Failure", `Failed login attempt for username: ${username || "unknown"}`, "auth");
    res.status(401).json({ success: false, message: "Invalid credentials" });
  });

  app.get("/api/auth/session", (req, res) => {
    const { sid, user } = readSession(req);
    if (!user) {
      if (sid) clearSessionCookie(res, useSecureCookie);
      return res.status(401).json({ success: false, message: "Session expired or invalid" });
    }
    return res.json({ success: true, user });
  });

  app.post("/api/auth/logout", (req, res) => {
    const { sid, user } = readSession(req);
    if (sid) sessionStore.delete(sid);
    clearSessionCookie(res, useSecureCookie);
    if (user?.username) {
      logAction(user.username, "Logout", "User logged out", "auth");
    }
    return res.json({ success: true });
  });

  app.post("/api/users", checkRole(['admin']), (req, res) => {
    const { username, password, role } = req.body;
    const actor = req.headers["x-user-name"] as string || "unknown";
    if (!username || !password) return res.status(400).json({ error: "Missing fields" });
    
    const newUser = {
      id: Date.now().toString(),
      username,
      password,
      role: role || 'operator',
      lastLogin: '-'
    };
    users.push(newUser);
    logAction(actor, 'Create User', `Created new user: ${username} with role ${role}`, 'user_mgmt');
    res.json({ success: true, user: newUser });
  });

  app.patch("/api/users/:id", checkRole(['admin']), (req, res) => {
    const { role } = req.body;
    const actor = req.headers["x-user-name"] as string || "unknown";
    const user = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    
    const oldRole = user.role;
    if (role) user.role = role;
    logAction(actor, 'Update User Role', `Updated user ${user.username} role from ${oldRole} to ${role}`, 'user_mgmt');
    res.json({ success: true });
  });

  app.post("/api/users/:id/password", checkRole(['admin']), (req, res) => {
    const { password } = req.body;
    const actor = req.headers["x-user-name"] as string || "unknown";
    const user = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    
    if (password) user.password = password;
    logAction(actor, 'Reset Password', `Reset password for user: ${user.username}`, 'user_mgmt');
    res.json({ success: true, message: "Password updated successfully" });
  });

  app.delete("/api/users/:id", checkRole(['admin']), (req, res) => {
    const actor = req.headers["x-user-name"] as string || "unknown";
    const user = users.find(u => u.id === req.params.id);
    if (user) {
      logAction(actor, 'Delete User', `Deleted user: ${user.username}`, 'user_mgmt');
    }
    users = users.filter(u => u.id !== req.params.id);
    res.json({ success: true });
  });

  const runWatchProfiles = async (actor: string, trigger: "scheduled" | "manual", profileIds?: string[]) => {
    if (discoveryRunLock) return { started: false, reason: "already-running", runs: [] as any[] };
    discoveryRunLock = true;
    try {
      const now = Date.now();
      const selected = discoveryWatchProfiles.filter((p) => {
        if (!p.enabled) return false;
        if (profileIds?.length) return profileIds.includes(p.id);
        if (trigger === "manual") return true;
        if (!p.lastRunAt) return true;
        const intervalMs = Math.max(1, Number(p.intervalHours || 3)) * 60 * 60 * 1000;
        return now - new Date(p.lastRunAt).getTime() >= intervalMs;
      });
      const runs: Array<{ profileId: string; profileName: string; result: DiscoveryWatchProfile["lastResult"] }> = [];
      for (const p of selected) {
        try {
          const summary = await runDiscoveryScan({
            subnets: p.subnets,
            protocol: p.protocol,
            city: p.city,
            zone: p.zone,
            branch: p.branch,
            actor,
            reason: trigger === "manual" ? "watch_manual" : "scheduled",
          });
          p.lastRunAt = new Date().toISOString();
          p.lastResult = summary;
          runs.push({ profileId: p.id, profileName: p.name, result: summary });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          p.lastRunAt = new Date().toISOString();
          p.lastResult = { success: false, error: msg };
          runs.push({ profileId: p.id, profileName: p.name, result: p.lastResult });
        }
      }
      logAction(actor, trigger === "manual" ? "Discovery Watch Manual Run" : "Discovery Watch Scheduled Run", `Profiles processed: ${runs.length}`, "inventory");
      return { started: true, runs };
    } finally {
      discoveryRunLock = false;
    }
  };

  app.post("/api/discovery/start", checkRole(["admin", "operator"]), async (req, res) => {
    const { subnets, protocol, city, zone, branch } = req.body as {
      subnets?: string; protocol?: string; city?: string; zone?: string; branch?: string;
    };
    const actor = (req.headers["x-user-name"] as string) || "unknown";
    if (!subnets || typeof subnets !== "string") {
      return res.status(400).json({ error: "Укажите подсети, например 192.168.1.0/24" });
    }
    if (discoveryRunLock) {
      return res.status(409).json({
        success: false,
        error: "Discovery run is already in progress",
        runningJobId: activeManualDiscoveryJobId,
      });
    }

    const jobId = `md-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const nowIso = new Date().toISOString();
    const job: ManualDiscoveryJob = {
      id: jobId,
      actor,
      status: "running",
      createdAt: nowIso,
      startedAt: nowIso,
      input: { subnets, protocol, city, zone, branch },
    };
    manualDiscoveryJobs.set(jobId, job);
    trimManualDiscoveryJobs();
    activeManualDiscoveryJobId = jobId;

    // Non-blocking run to avoid reverse-proxy timeouts on long subnets.
    (async () => {
      discoveryRunLock = true;
      try {
        const summary = await runDiscoveryScan({ subnets, protocol, city, zone, branch, actor, reason: "manual" });
        const current = manualDiscoveryJobs.get(jobId);
        if (current) {
          current.status = "done";
          current.summary = summary;
          current.finishedAt = new Date().toISOString();
          manualDiscoveryJobs.set(jobId, current);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const current = manualDiscoveryJobs.get(jobId);
        if (current) {
          current.status = "error";
          current.error = msg;
          current.finishedAt = new Date().toISOString();
          manualDiscoveryJobs.set(jobId, current);
        }
        logAction(actor, "Discovery Failed", msg, "inventory");
      } finally {
        discoveryRunLock = false;
        if (activeManualDiscoveryJobId === jobId) activeManualDiscoveryJobId = null;
      }
    })();

    return res.status(202).json({
      success: true,
      accepted: true,
      jobId,
      status: "running",
      statusEndpoint: `/api/discovery/start/status/${jobId}`,
    });
  });

  app.get("/api/discovery/start/status/:jobId", checkRole(["admin", "operator"]), (req, res) => {
    const jobId = String(req.params.jobId || "").trim();
    const job = manualDiscoveryJobs.get(jobId);
    if (!job) return res.status(404).json({ success: false, error: "Discovery job not found" });
    return res.json({
      success: true,
      jobId: job.id,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt || null,
      error: job.error || null,
      summary: job.summary || null,
      input: job.input,
    });
  });

  app.get("/api/discovery/watch", checkRole(["admin", "operator"]), (_req, res) => {
    res.json({ profiles: discoveryWatchProfiles });
  });

  app.get("/api/discovery/watch/status", checkRole(["admin", "operator"]), (_req, res) => {
    const now = Date.now();
    const entries = discoveryWatchProfiles
      .filter((p) => p.enabled)
      .map((p) => {
        const intervalMs = Math.max(1, Number(p.intervalHours || 3)) * 60 * 60 * 1000;
        const base = p.lastRunAt ? new Date(p.lastRunAt).getTime() : now - intervalMs;
        const nextRunAt = new Date(base + intervalMs).toISOString();
        const dueInMs = Math.max(0, new Date(nextRunAt).getTime() - now);
        return { id: p.id, name: p.name, nextRunAt, dueInMs };
      })
      .sort((a, b) => a.dueInMs - b.dueInMs);
    res.json({
      schedulerActive: !!discoveryScheduler,
      tickIntervalSec: 60,
      lastTickAt: discoverySchedulerLastTickAt,
      lastProcessedProfiles: discoverySchedulerLastProcessed,
      currentlyRunning: discoveryRunLock,
      activeManualDiscoveryJobId,
      enabledProfiles: entries.length,
      nextRuns: entries.slice(0, 20),
      serverNow: new Date(now).toISOString(),
    });
  });

  app.post("/api/discovery/watch", checkRole(["admin", "operator"]), (req, res) => {
    const incoming = (req.body?.profiles || []) as Partial<DiscoveryWatchProfile>[];
    if (!Array.isArray(incoming)) return res.status(400).json({ error: "profiles must be an array" });
    discoveryWatchProfiles = incoming
      .map((p, idx) => {
        const id = String(p.id || `dw-${Date.now()}-${idx}`).trim();
        const subnets = String(p.subnets || "").trim();
        if (!subnets) return null;
        return {
          id,
          name: String(p.name || `Profile ${idx + 1}`).trim() || `Profile ${idx + 1}`,
          subnets,
          protocol: normalizeProtocol(p.protocol),
          city: String(p.city || "Ульяновск").trim() || "Ульяновск",
          zone: String(p.zone || "Core").trim() || "Core",
          branch: String(p.branch || "ULN").trim() || "ULN",
          enabled: p.enabled !== false,
          intervalHours: Math.max(1, Number(p.intervalHours || 3)),
          lastRunAt: typeof p.lastRunAt === "string" ? p.lastRunAt : null,
          lastResult: p.lastResult || null,
        } as DiscoveryWatchProfile;
      })
      .filter(Boolean) as DiscoveryWatchProfile[];
    const actor = (req.headers["x-user-name"] as string) || "unknown";
    logAction(actor, "Discovery Watch Update", `Profiles saved: ${discoveryWatchProfiles.length}`, "inventory");
    res.json({ success: true, profiles: discoveryWatchProfiles });
  });

  app.post("/api/discovery/watch/run", checkRole(["admin", "operator"]), async (req, res) => {
    const actor = (req.headers["x-user-name"] as string) || "unknown";
    const profileIds = Array.isArray(req.body?.profileIds) ? req.body.profileIds.map((x: unknown) => String(x)) : undefined;
    const out = await runWatchProfiles(actor, "manual", profileIds);
    if (!out.started) return res.status(409).json({ success: false, error: out.reason });
    return res.json({ success: true, runs: out.runs, profiles: discoveryWatchProfiles });
  });

  app.get("/api/topology/links", (_req, res) => {
    topologyLinks = topologyLinks.map((l) => ensureTopologyLinkId(l));
    res.json({ links: topologyLinks, layout: topologyLayout });
  });

  app.post("/api/topology/links/rebuild", checkRole(["admin", "operator"]), async (req, res) => {
    try {
      const branch = String(req.body?.branch || "").trim();
      const links = await inferTopologyLinksFromTrunkDescriptions(branch || undefined);
      if (branch) {
        const branchDeviceIds = new Set(
          inventory
            .filter((item) => String(item.branch || "").trim() === branch)
            .map((item) => item.id)
        );
        const externalLinks = topologyLinks.filter((l) => !branchDeviceIds.has(l.source) || !branchDeviceIds.has(l.target));
        const existingBranchLinks = topologyLinks.filter((l) => branchDeviceIds.has(l.source) && branchDeviceIds.has(l.target));

        const keyOf = (l: { source: string; target: string }) => [l.source, l.target].sort().join("::");

        // Build inferred links map (by undirected pair key).
        const inferredByPair = new Map<string, TopologyLink>();
        (links || []).forEach((l) => inferredByPair.set(keyOf(l), { ...l, manual: false }));

        // 1) Preserve user-renamed port labels by overriding inferred labels.
        existingBranchLinks
          .filter((l) => l.renamed)
          .forEach((l) => {
            const k = keyOf(l);
            const inf = inferredByPair.get(k);
            if (inf) {
              inferredByPair.set(k, { ...inf, portA: l.portA, portB: l.portB, renamed: true });
            }
          });

        // 2) Preserve truly manual links (not removed by rebuild).
        const manualLinks = existingBranchLinks.filter((l) => l.manual);

        // Avoid exact duplicates.
        const dedupe = new Set<string>();
        const outBranch: TopologyLink[] = [];
        Array.from(inferredByPair.values()).forEach((l) => {
          const dk = `${l.source}::${l.target}::${l.portA}::${l.portB}`;
          if (dedupe.has(dk)) return;
          dedupe.add(dk);
          outBranch.push(l);
        });
        manualLinks.forEach((l) => {
          const dk = `${l.source}::${l.target}::${l.portA}::${l.portB}`;
          if (dedupe.has(dk)) return;
          dedupe.add(dk);
          outBranch.push(l);
        });

        topologyLinks = [...externalLinks, ...outBranch];
      } else {
        // Global rebuild: keep all manual links + keep renamed labels where possible.
        const keyOf = (l: { source: string; target: string }) => [l.source, l.target].sort().join("::");
        const inferredByPair = new Map<string, TopologyLink>();
        (links || []).forEach((l) => inferredByPair.set(keyOf(l), { ...l, manual: false }));

        topologyLinks
          .filter((l) => l.renamed)
          .forEach((l) => {
            const inf = inferredByPair.get(keyOf(l));
            if (inf) inferredByPair.set(keyOf(l), { ...inf, portA: l.portA, portB: l.portB, renamed: true });
          });

        const manualLinks = topologyLinks.filter((l) => l.manual);
        const dedupe = new Set<string>();
        const out: TopologyLink[] = [];
        Array.from(inferredByPair.values()).forEach((l) => {
          const dk = `${l.source}::${l.target}::${l.portA}::${l.portB}`;
          if (dedupe.has(dk)) return;
          dedupe.add(dk);
          out.push(l);
        });
        manualLinks.forEach((l) => {
          const dk = `${l.source}::${l.target}::${l.portA}::${l.portB}`;
          if (dedupe.has(dk)) return;
          dedupe.add(dk);
          out.push(l);
        });
        topologyLinks = out;
      }
      rebuildTopologyFromInventory();
      const actor = (req.headers["x-user-name"] as string) || "unknown";
      logAction(
        actor,
        "Rebuild Topology",
        `Auto-built ${links.length} links from Trunk descriptions${branch ? ` (branch: ${branch})` : ""}`,
        "inventory"
      );
      return res.json({ success: true, links: topologyLinks, layout: topologyLayout });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return res.status(500).json({ success: false, error: msg });
    }
  });

  app.post("/api/topology/classify-subcategories", checkRole(["admin", "operator"]), async (req, res) => {
    try {
      const branch = String(req.body?.branch || "").trim();
      const out = await classifyInventorySubcategoriesBySnmp(branch || undefined);
      const actor = (req.headers["x-user-name"] as string) || "unknown";
      logAction(
        actor,
        "Classify Subcategories",
        `Updated: ${out.updated}${branch ? ` (branch: ${branch})` : ""}`,
        "inventory"
      );
      return res.json({ success: true, ...out });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return res.status(500).json({ success: false, error: msg });
    }
  });

  app.post("/api/inventory/branches/rename", checkRole(["admin", "operator"]), (req, res) => {
    const from = String(req.body?.from || "").trim();
    const to = String(req.body?.to || "").trim();
    if (!from || !to) return res.status(400).json({ error: "from/to are required" });
    if (from === to) return res.json({ success: true, renamed: 0 });

    let renamed = 0;
    inventory = inventory.map((item) => {
      if (String(item.branch || "").trim() !== from) return item;
      renamed += 1;
      return { ...item, branch: to };
    });

    inventoryMeta.branches = Array.from(
      new Set(
        inventoryMeta.branches
          .map((x) => (String(x).trim() === from ? to : String(x).trim()))
          .concat(to)
          .filter(Boolean)
      )
    );
    discoveryWatchProfiles = discoveryWatchProfiles.map((profile) =>
      String(profile.branch || "").trim() === from ? { ...profile, branch: to } : profile
    );

    const actor = (req.headers["x-user-name"] as string) || "unknown";
    logAction(actor, "Rename Branch", `${from} -> ${to}, affected: ${renamed}`, "inventory");
    return res.json({ success: true, renamed, from, to, branches: inventoryMeta.branches });
  });

  app.post("/api/topology/links", checkRole(["admin", "operator"]), (req, res) => {
    const body = req.body as { source?: string; target?: string; portA?: string; portB?: string };
    const source = String(body.source || "").trim();
    const target = String(body.target || "").trim();
    const portA = String(body.portA || "").trim();
    const portB = String(body.portB || "").trim();
    if (!source || !target || source === target) {
      return res.status(400).json({ error: "Invalid link endpoints" });
    }
    const exists = topologyLinks.some(
      (l) =>
        (l.source === source && l.target === target && l.portA === portA && l.portB === portB) ||
        (l.source === target && l.target === source && l.portA === portB && l.portB === portA)
    );
    if (!exists) {
      topologyLinks.push(ensureTopologyLinkId({ source, target, portA: portA || "N/A", portB: portB || "N/A", manual: true }));
    }
    res.json({ success: true, links: topologyLinks });
  });

  app.post("/api/topology/links/rename", checkRole(["admin", "operator"]), (req, res) => {
    const body = req.body as {
      id?: string;
      source?: string;
      target?: string;
      portA?: string;
      portB?: string;
      newPortA?: string;
      newPortB?: string;
    };
    const source = String(body.source || "").trim();
    const target = String(body.target || "").trim();
    const id = String(body.id || "").trim();
    const portA = String(body.portA || "").trim();
    const portB = String(body.portB || "").trim();
    const newPortA = String(body.newPortA || "").trim();
    const newPortB = String(body.newPortB || "").trim();
    if (!source || !target || !portA || !portB) return res.status(400).json({ error: "Invalid link" });
    if (!newPortA && !newPortB) return res.status(400).json({ error: "newPortA/newPortB required" });

    const idx = id
      ? topologyLinks.findIndex((l) => l.id === id)
      : topologyLinks.findIndex(
          (l) => l.source === source && l.target === target && l.portA === portA && l.portB === portB
        );
    const revIdx = idx >= 0 || id
      ? -1
      : topologyLinks.findIndex(
          (l) => l.source === target && l.target === source && l.portA === portB && l.portB === portA
        );
    const pick = idx >= 0 ? idx : revIdx;
    if (pick < 0) return res.status(404).json({ error: "Link not found" });

    const cur = topologyLinks[pick];
    topologyLinks[pick] = ensureTopologyLinkId({
      ...cur,
      portA: newPortA || cur.portA,
      portB: newPortB || cur.portB,
      renamed: true,
    });
    return res.json({ success: true, links: topologyLinks });
  });

  app.delete("/api/topology/links", checkRole(["admin", "operator"]), (req, res) => {
    const body = req.body as { id?: string; source?: string; target?: string; portA?: string; portB?: string };
    const id = String(body.id || "").trim();
    const source = String(body.source || "").trim();
    const target = String(body.target || "").trim();
    const portA = String(body.portA || "").trim();
    const portB = String(body.portB || "").trim();
    const before = topologyLinks.length;
    topologyLinks = topologyLinks.filter((l) => {
      if (id) return l.id !== id;
      return !(
        l.source === source &&
        l.target === target &&
        l.portA === portA &&
        l.portB === portB
      );
    });
    res.json({ success: true, removed: before - topologyLinks.length, links: topologyLinks });
  });

  app.post("/api/topology/layout", checkRole(["admin", "operator"]), (req, res) => {
    const body = req.body as { positions?: Record<string, { x: number; y: number }> };
    const positions = body?.positions || {};
    for (const [id, pos] of Object.entries(positions)) {
      if (Number.isFinite(pos?.x) && Number.isFinite(pos?.y)) {
        topologyLayout[id] = { x: Number(pos.x), y: Number(pos.y) };
      }
    }
    res.json({ success: true, layout: topologyLayout });
  });

  app.get("/api/config/snmp", checkRole(['admin', 'operator']), (_req, res) => {
    res.json({ snmp: snmpConfig });
  });

  app.get("/api/snmp/templates", checkRole(['admin', 'operator', 'viewer']), (_req, res) => {
    res.json({ templates: snmpTemplates });
  });

  app.post("/api/snmp/templates", checkRole(['admin']), (req, res) => {
    const tpl = req.body as SnmpTemplate;
    if (!tpl?.id || !tpl?.name || !Array.isArray(tpl.metrics)) {
      return res.status(400).json({ error: "Invalid template payload" });
    }
    snmpTemplates = [...snmpTemplates.filter((t) => t.id !== tpl.id), tpl];
    res.json({ success: true, templates: snmpTemplates });
  });

  app.delete("/api/snmp/templates/:id", checkRole(['admin']), (req, res) => {
    const id = String(req.params.id || "");
    const before = snmpTemplates.length;
    snmpTemplates = snmpTemplates.filter((t) => t.id !== id);
    if (snmpTemplates.length === before) {
      return res.status(404).json({ success: false, error: "Template not found" });
    }
    inventory = inventory.map((item) =>
      item.snmpTemplateId === id ? { ...item, snmpTemplateId: undefined } : item
    );
    return res.json({ success: true, templates: snmpTemplates });
  });

  app.get("/api/metrics/dashboard", checkRole(['admin', 'operator', 'viewer']), async (_req, res) => {
    const sample = await Promise.all(
      inventory.map(async (item) => {
        const template = pickTemplate(item);
        const metricOids = (template?.metrics || []).map((m) => m.oid);
        const customDefs = (item.customOids || []).map((o, i) => ({ key: `custom_${i + 1}`, oid: o, scale: 1 }));
        const allDefs = [...(template?.metrics || []), ...customDefs];
        const map = metricOids.length || customDefs.length
          ? await snmpGetMap(item.ip, allDefs.map((m) => m.oid))
          : {};
        const custom: Record<string, number | string> = {};
        allDefs.forEach((def) => {
          const v = map[def.oid];
          if (v === undefined) return;
          const n = Number(v);
          custom[def.key] = Number.isFinite(n) ? n * (def.scale ?? 1) : String(v);
        });
        const trunks = await collectTrunkMetricsWithFallback(item);
        return {
          id: item.id,
          name: item.name,
          ip: item.ip,
          branch: item.branch || "ULN",
          category: item.category || "Switch",
          trunks,
          metrics: custom,
        };
      })
    );

    const trunkFlat = sample.flatMap((d) => d.trunks.map((t) => ({ ...t, deviceId: d.id, deviceName: d.name, branch: d.branch })));
    res.json({
      generatedAt: new Date().toISOString(),
      devices: sample,
      trunkSummary: {
        total: trunkFlat.length,
        down: trunkFlat.filter((t) => t.operStatus !== 1).length,
        topByTraffic: trunkFlat
          .map((t) => ({ ...t, totalBps: t.inBps + t.outBps }))
          .sort((a, b) => b.totalBps - a.totalBps)
          .slice(0, 10),
      },
    });
  });

  // API: SNMP Configuration
  app.post("/api/config/snmp", checkRole(['admin']), (req, res) => {
    const { community, version, communities, timeoutMs, retries, port } = req.body;
    const actor = req.headers["x-user-name"] as string || "unknown";
    if (typeof community === "string" && community.trim()) snmpConfig.community = community.trim();
    if (Array.isArray(communities)) {
      snmpConfig.communities = communities.map((v) => String(v).trim()).filter(Boolean);
    }
    if (typeof version === "string" && version.trim()) snmpConfig.version = version.trim();
    if (Number.isFinite(Number(timeoutMs))) snmpConfig.timeoutMs = Math.max(300, Math.min(5000, Number(timeoutMs)));
    if (Number.isFinite(Number(retries))) snmpConfig.retries = Math.max(0, Math.min(3, Number(retries)));
    if (Number.isFinite(Number(port))) snmpConfig.port = Math.max(1, Math.min(65535, Number(port)));
    logAction(actor, 'SNMP Config Update', `Changed SNMP settings (Version: ${version})`, 'config');
    res.json({ success: true, message: "SNMP configuration saved.", snmp: snmpConfig });
  });

  app.get("/api/config/ssh-readonly", checkRole(["admin", "operator"]), (_req, res) => {
    const cur = getActiveSshReadonlyProfile();
    if (!cur) return res.json({ enabled: false, hasPassword: false });
    return res.json({
      enabled: true,
      username: cur.username,
      port: cur.port,
      allowMetricsFallback: cur.allowMetricsFallback,
      hasPassword: true,
      expiresAt: new Date(cur.expiresAt).toISOString(),
    });
  });

  app.post("/api/config/ssh-readonly", checkRole(["admin", "operator"]), (req, res) => {
    const body = req.body as {
      username?: string;
      password?: string;
      port?: number;
      allowMetricsFallback?: boolean;
      ttlHours?: number;
    };
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const port = Number(body.port || 22);
    const ttlHours = Math.max(1, Math.min(24, Number(body.ttlHours || 3)));
    if (!username || !password) return res.status(400).json({ error: "username/password required" });
    sshReadonlyProfile = {
      username,
      password,
      port: Number.isFinite(port) && port > 0 && port <= 65535 ? port : 22,
      allowMetricsFallback: body.allowMetricsFallback !== false,
      expiresAt: Date.now() + ttlHours * 60 * 60 * 1000,
    };
    logAction(
      (req.headers["x-user-name"] as string) || "unknown",
      "SSH Readonly Profile Set",
      `TTL ${ttlHours}h, metrics fallback: ${sshReadonlyProfile.allowMetricsFallback ? "on" : "off"}`,
      "config"
    );
    return res.json({ success: true, expiresAt: new Date(sshReadonlyProfile.expiresAt).toISOString() });
  });

  // API: Trap Receiver Configuration
  app.post("/api/config/trap-receiver", checkRole(['admin']), (req, res) => {
    const { ip, port } = req.body;
    const actor = req.headers["x-user-name"] as string || "unknown";
    logAction(actor, 'Trap Receiver Update', `Updated trap receiver to ${ip}:${port}`, 'config');
    res.json({ success: true, message: "Trap receiver configuration saved." });
  });

  // Socket.io for Terminal (SSH)
  io.on("connection", (socket) => {
    const sessions = new Map<string, { client: Client, stream?: any }>();

    socket.on("ssh:connect", ({ sessionId, host, username, password, port }) => {
      // Clean up existing session if it exists for this ID
      if (sessions.has(sessionId)) {
        sessions.get(sessionId)?.client.end();
      }

      const sshClient = new Client();
      sessions.set(sessionId, { client: sshClient });
      const sshPort = typeof port === "number" && port > 0 && port < 65536 ? port : 22;
      const pwd = typeof password === "string" ? password : "";

      sshClient
        .on("keyboard-interactive", (_name, _instr, _lang, prompts, finish) => {
          if (pwd && prompts?.length) {
            finish(prompts.map(() => pwd));
          } else {
            finish([]);
          }
        })
        .on("ready", () => {
          socket.emit("ssh:status", { sessionId, status: "connected" });
          sshClient.shell(
            {
              term: "xterm-256color",
              cols: 160,
              rows: 40,
            },
            (err, stream) => {
            if (err) return socket.emit("ssh:data", { sessionId, data: `\r\n*** SSH Shell Error: ${err.message} ***\r\n` });
            
            const session = sessions.get(sessionId);
            if (session) session.stream = stream;

            stream.on("data", (data: Buffer) => {
              socket.emit("ssh:data", { sessionId, data: data.toString() });
            });
            
            stream.on("close", () => {
              sshClient.end();
              sessions.delete(sessionId);
              socket.emit("ssh:status", { sessionId, status: "disconnected" });
            });
            }
          );
        })
        .on("error", (err) => {
          socket.emit("ssh:data", { sessionId, data: `\r\n*** SSH Error: ${err.message} ***\r\n` });
          sessions.delete(sessionId);
        })
        .connect({
          host,
          port: sshPort,
          username,
          password: pwd || undefined,
          tryKeyboard: true,
          readyTimeout: 30000,
          keepaliveInterval: 10000,
          keepaliveCountMax: 6,
          ...legacySshConnectOptions(),
        });
    });

    socket.on("ssh:input", ({ sessionId, input }) => {
      const session = sessions.get(sessionId);
      if (session && session.stream) {
        session.stream.write(input);
      }
    });

    socket.on("ssh:disconnect", ({ sessionId }) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.client.end();
        sessions.delete(sessionId);
      }
    });

    socket.on("disconnect", () => {
      sessions.forEach(session => session.client.end());
      sessions.clear();
    });
  });

  // Vite integration
  if (!isProd) {
    console.log("Running in development mode (Vite Middleware)");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log("Running in production mode (Serving static files)");
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const listenPort = process.env.PORT || PORT;
  server.listen(Number(listenPort), "0.0.0.0", () => {
    console.log(`\n================================================`);
    console.log(`NETNODE Backend running on http://0.0.0.0:${listenPort}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`================================================\n`);
  });
}

startServer();
