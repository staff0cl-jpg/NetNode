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

type TopologyLink = { source: string; target: string; portA: string; portB: string };
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
  categories: ["Switch", "Router", "UPS", "Firewall", "Other"],
  subcategories: ["Core", "Distribution", "Access"],
  branches: ["HQ"],
  cities: ["Moscow"],
  zones: ["DC-East"],
  vendors: ["Cisco", "Juniper", "HPE", "MikroTik", "Huawei", "Arista", "Unknown"],
  models: {
    Cisco: ["Catalyst 9300", "Catalyst 9200", "Nexus 93180YC", "ASR 1001-X"],
    Juniper: ["EX4300", "EX2300", "MX204", "QFX5120"],
    HPE: ["Aruba 2930F", "Aruba 5406R", "FlexFabric 5940", "Aruba 6300M"],
    MikroTik: ["CCR2004", "CRS326", "RB5009", "CCR2116"],
    Huawei: ["CloudEngine S5735", "S6730", "NetEngine AR6121"],
    Arista: ["7050SX3", "7280SR3", "7010T"],
    Unknown: ["Discovered (SNMP/SSH)", "Generic L2"],
  } as Record<string, string[]>,
};

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
];

type TrunkMetric = {
  ifIndex: string;
  ifName: string;
  description: string;
  operStatus: number;
  inBps: number;
  outBps: number;
};

const trunkCounterCache = new Map<string, { inOctets: number; outOctets: number; ts: number }>();

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

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0d 0h 0m";
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

function detectVendorFromDescr(descr: string): string {
  const d = descr.toLowerCase();
  if (d.includes("cisco")) return "Cisco";
  if (d.includes("juniper")) return "Juniper";
  if (d.includes("aruba")) return "HPE";
  if (d.includes("hewlett") || d.includes("procurve") || d.includes("hpe")) return "HPE";
  if (d.includes("mikrotik")) return "MikroTik";
  if (d.includes("huawei")) return "Huawei";
  if (d.includes("arista")) return "Arista";
  return "Unknown";
}

function parseModelFromDescr(descr: string): string {
  const trimmed = descr.trim();
  if (!trimmed) return "Unknown";
  return trimmed.split("\n")[0].trim().slice(0, 80);
}

function snmpVersionFromConfig(): snmp.Version {
  if (snmpConfig.version.includes("v1")) return snmp.Version1;
  return snmp.Version2c;
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

function detectCategoryFromSnmp(sysDescr: string, sysObjectId: string): string {
  const d = (sysDescr || "").toLowerCase();
  const oid = (sysObjectId || "").toLowerCase();
  if (d.includes("ups") || d.includes("apc") || d.includes("eaton") || oid.startsWith("1.3.6.1.4.1.318")) {
    return "UPS";
  }
  if (d.includes("router")) return "Router";
  if (d.includes("firewall") || d.includes("fortigate") || d.includes("palo alto")) return "Firewall";
  if (d.includes("switch") || d.includes("catalyst") || d.includes("aruba") || d.includes("nexus")) return "Switch";
  return "Other";
}

function getSnmpProbe(host: string, timeout = snmpConfig.timeoutMs): Promise<SnmpProbe> {
  return new Promise((resolve) => {
    const communities = snmpCommunities();
    const oids = ["1.3.6.1.2.1.1.5.0", "1.3.6.1.2.1.1.1.0", "1.3.6.1.2.1.1.2.0", ...uptimeOidProfiles.map((p) => p.oid)];
    let idx = 0;
    const tryNext = () => {
      if (idx >= communities.length) return resolve({ ok: false });
      const community = communities[idx++];
      const session = snmp.createSession(host, community, {
        timeout,
        retries: snmpConfig.retries,
        version: snmpVersionFromConfig(),
        port: snmpConfig.port,
      });
      session.get(oids, (err, varbinds) => {
        try {
          session.close();
        } catch {
          /* ignore */
        }
        if (err || !varbinds?.length) return tryNext();
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
  if ((item.category || "").toLowerCase() === "ups") {
    return snmpTemplates.find((t) => t.id === "zbx-ups-basic");
  }
  return snmpTemplates.find((t) => t.id === "zbx-switch-basic");
}

function snmpGetMap(host: string, oids: string[], timeout = snmpConfig.timeoutMs): Promise<Record<string, number | string>> {
  return new Promise((resolve) => {
    const communities = snmpCommunities();
    let idx = 0;
    const tryNext = () => {
      if (idx >= communities.length) return resolve({});
      const session = snmp.createSession(host, communities[idx++], {
        timeout,
        retries: snmpConfig.retries,
        version: snmpVersionFromConfig(),
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
    let idx = 0;
    const tryNext = () => {
      if (idx >= communities.length) return resolve({});
      const session = snmp.createSession(host, communities[idx++], {
        timeout,
        retries: snmpConfig.retries,
        version: snmpVersionFromConfig(),
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
  const [ifNames, ifAlias, ifOper, inOctets, outOctets] = await Promise.all([
    snmpWalk(host, "1.3.6.1.2.1.31.1.1.1.1"),
    snmpWalk(host, "1.3.6.1.2.1.31.1.1.1.18"),
    snmpWalk(host, "1.3.6.1.2.1.2.2.1.8"),
    snmpWalk(host, "1.3.6.1.2.1.31.1.1.1.6"),
    snmpWalk(host, "1.3.6.1.2.1.31.1.1.1.10"),
  ]);
  const now = Date.now();
  const indexes = Object.keys(ifAlias);
  const trunks: TrunkMetric[] = [];
  for (const idx of indexes) {
    const desc = ifAlias[idx] || "";
    if (!/^trunk\b/i.test(desc.trim())) continue;
    const inNow = Number(inOctets[idx] || 0);
    const outNow = Number(outOctets[idx] || 0);
    const key = `${host}:${idx}`;
    const prev = trunkCounterCache.get(key);
    let inBps = 0;
    let outBps = 0;
    if (prev && now > prev.ts && inNow >= prev.inOctets && outNow >= prev.outOctets) {
      const dt = (now - prev.ts) / 1000;
      inBps = Math.max(0, Math.round(((inNow - prev.inOctets) * 8) / Math.max(dt, 1)));
      outBps = Math.max(0, Math.round(((outNow - prev.outOctets) * 8) / Math.max(dt, 1)));
    }
    trunkCounterCache.set(key, { inOctets: inNow, outOctets: outNow, ts: now });
    trunks.push({
      ifIndex: idx,
      ifName: ifNames[idx] || `if${idx}`,
      description: desc,
      operStatus: Number(ifOper[idx] || 2),
      inBps,
      outBps,
    });
  }
  return trunks;
}

function rebuildTopologyFromInventory() {
  const existing = new Set(inventory.map((i) => i.id));
  topologyLinks = topologyLinks.filter((l) => existing.has(l.source) && existing.has(l.target));
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
  app.get("/api/inventory", (req, res) => {
    Promise.all(
      inventory.map(async (item) => {
        const probe = await getSnmpProbe(item.ip, 900);
        if (!probe.ok) return item;
        const nextVendor = probe.sysDescr ? detectVendorFromDescr(probe.sysDescr) : item.vendor;
        const nextModel = probe.sysDescr ? parseModelFromDescr(probe.sysDescr) : item.model;
        const nextName = probe.sysName?.trim() ? probe.sysName.trim() : item.name;
        const nextCategory = detectCategoryFromSnmp(probe.sysDescr || "", probe.sysObjectId || "");
        const uptimeSeconds = probe.uptimeSeconds ?? item.uptimeSeconds ?? 0;
        return {
          ...item,
          name: nextName,
          vendor: nextVendor,
          model: nextModel,
          category: item.category || nextCategory,
          branch: item.branch || "HQ",
          status: "online" as const,
          uptimeSeconds,
          uptime: formatDuration(uptimeSeconds),
        };
      })
    )
      .then((next) => {
        inventory = next;
        res.json(inventory);
      })
      .catch(() => res.json(inventory));
  });

  app.post("/api/inventory", checkRole(['admin', 'operator']), (req, res) => {
    const sw = req.body;
    const actor = req.headers["x-user-name"] as string || "unknown";
    const newSwitch = {
      ...sw,
      id: Date.now().toString(),
      category: sw.category || "Switch",
      branch: sw.branch || "HQ",
    } as InventoryItem;
    if (newSwitch.category && !inventoryMeta.categories.includes(newSwitch.category)) {
      inventoryMeta.categories.push(newSwitch.category);
    }
    if (newSwitch.branch && !inventoryMeta.branches.includes(newSwitch.branch)) {
      inventoryMeta.branches.push(newSwitch.branch);
    }
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
    if (inventory[index].category && !inventoryMeta.categories.includes(inventory[index].category!)) {
      inventoryMeta.categories.push(inventory[index].category!);
    }
    if (inventory[index].branch && !inventoryMeta.branches.includes(inventory[index].branch!)) {
      inventoryMeta.branches.push(inventory[index].branch!);
    }
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

  // API: Auto-Discovery — SNMP-first with SSH fallback
  app.post("/api/discovery/start", checkRole(["admin", "operator"]), async (req, res) => {
    const { subnets, protocol } = req.body as { subnets?: string; username?: string; password?: string; protocol?: string };
    const actor = (req.headers["x-user-name"] as string) || "unknown";
    if (!subnets || typeof subnets !== "string") {
      return res.status(400).json({ error: "Укажите подсети, например 192.168.1.0/24" });
    }

    const MAX_TOTAL = 1024;
    const SSH_PORT = 22;
    const TIMEOUT_MS = 900;
    const CONCURRENCY = 32;

    try {
      const ips = parseSubnetList(subnets, MAX_TOTAL);
      if (ips.length === 0) {
        return res.status(400).json({ error: "Не удалось разобрать подсети. Формат: 10.0.0.0/24 или 192.168.1.5" });
      }

      const mode = (protocol || "snmp+ssh").toLowerCase();
      const snmpEnabled = mode === "snmp" || mode === "snmp+ssh";
      const sshEnabled = mode === "ssh" || mode === "snmp+ssh";
      logAction(actor, "Start Discovery", `Сканирование ${ips.length} адресов (mode: ${mode})`, "inventory");
      const existingIps = new Set(inventory.map((s) => s.ip));
      const toScan = ips.filter((ip) => !existingIps.has(ip));
      const foundIps: string[] = [];
      let sshOpen = 0;
      const discovered: InventoryItem[] = [];
      let idx = 0;
      const worker = async () => {
        while (idx < toScan.length) {
          const current = idx++;
          const ip = toScan[current];
          const [probe, hasSsh] = await Promise.all([
            snmpEnabled ? getSnmpProbe(ip, snmpConfig.timeoutMs || 900) : Promise.resolve({ ok: false } as any),
            sshEnabled ? checkTcpPort(ip, SSH_PORT, TIMEOUT_MS) : Promise.resolve(false),
          ]);
          if (hasSsh) sshOpen++;
          if (!probe.ok && !hasSsh) continue;
          foundIps.push(ip);
          const vendor = probe.sysDescr ? detectVendorFromDescr(probe.sysDescr) : "Unknown";
          const model = probe.sysDescr ? parseModelFromDescr(probe.sysDescr) : `SSH:${SSH_PORT}`;
          const category = detectCategoryFromSnmp(probe.sysDescr || "", probe.sysObjectId || "");
          const uptimeSeconds = probe.uptimeSeconds ?? 0;
          discovered.push({
            id: `d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: probe.sysName?.trim() || `${vendor}-SW-${ip.replace(/\./g, "-")}`,
            vendor,
            model,
            category,
            branch: "HQ",
            city: "Auto",
            zone: "Discovery",
            ip,
            status: "online",
            uptimeSeconds,
            uptime: formatDuration(uptimeSeconds),
          });
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
      inventory.push(...discovered);
      const added = discovered.length;
      rebuildTopologyFromInventory();
      logAction(
        actor,
        "Discovery Complete",
        `Проверено: ${ips.length}, SNMP/SSH найдено: ${foundIps.length}, новых в инвентаре: ${added}`,
        "inventory"
      );
      return res.json({
        success: true,
        protocol: mode,
        scanned: ips.length,
        sshOpen,
        added,
        foundIps,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logAction(actor, "Discovery Failed", msg, "inventory");
      return res.status(500).json({ success: false, error: msg });
    }
  });

  app.get("/api/topology/links", (_req, res) => {
    res.json({ links: topologyLinks, layout: topologyLayout });
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
      topologyLinks.push({ source, target, portA: portA || "N/A", portB: portB || "N/A" });
    }
    res.json({ success: true, links: topologyLinks });
  });

  app.delete("/api/topology/links", checkRole(["admin", "operator"]), (req, res) => {
    const body = req.body as { source?: string; target?: string; portA?: string; portB?: string };
    const source = String(body.source || "").trim();
    const target = String(body.target || "").trim();
    const portA = String(body.portA || "").trim();
    const portB = String(body.portB || "").trim();
    const before = topologyLinks.length;
    topologyLinks = topologyLinks.filter(
      (l) =>
        !(
          l.source === source &&
          l.target === target &&
          l.portA === portA &&
          l.portB === portB
        )
    );
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
        const trunks = await collectTrunkMetrics(item.ip);
        return {
          id: item.id,
          name: item.name,
          ip: item.ip,
          branch: item.branch || "HQ",
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
