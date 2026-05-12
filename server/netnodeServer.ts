import express from "express";
/// <reference path="./types/express-netnode.d.ts" />
import { createServer as createViteServer } from "vite";
import { Server } from "socket.io";
import http from "http";
import type { Duplex } from "node:stream";
import net from "net";
import { promises as fs } from "fs";
import path from "path";
import { Client } from "ssh2";
import ldap from "ldapjs";
import snmp from "net-snmp";
import type { Pool } from "pg";
import type { InventoryRowPayload } from "./persistence/postgres.js";
import {
  APP_KV_KEYS,
  appendAuditLog as pgAppendAuditLog,
  connectPostgres,
  ensureSchema,
  hydrateFromDatabase,
  persistInventoryDevices,
  shutdownPool,
  upsertAppKv,
  upsertAppKvMany,
} from "./persistence/postgres.js";
import { closeAmqp, publishAmqpJson } from "./messaging/broker.js";
import { hydrateProcessEnvFromInstanceFileSync } from "./setup/instanceFile.js";
import { registerFirstRunSetupRoutes } from "./setup/setupRoutes.js";
import { createInitialUsers } from "./auth/initialUsers.js";
import { hashPassword, verifyLocalPassword } from "./auth/password.js";
import type { AuthUser, LocalUser } from "./auth/types.js";
import {
  materialFromUserPassword,
  readPasswordMaterial,
  materialHasValue,
  type PasswordMaterial,
} from "./crypto/credentialMaterial.js";
import type { InventoryItem } from "./inventory/inventoryTypes.js";
import { evaluateInventoryWarnings } from "./inventory/warnings.js";
import { applySecurityMiddleware, createLoginRateLimiter } from "./middleware/security.js";
import { csrfProtectionMiddleware } from "./middleware/csrf.js";
import { registerInventoryHttpRoutes } from "./routes/inventoryHttp.js";
import { discoveryStartBodySchema, discoveryWatchSaveBodySchema } from "./validation/discovery.js";
import { createUserBodySchema, loginBodySchema, patchUserBodySchema, resetPasswordBodySchema } from "./validation/auth.js";
import {
  clearSessionCookie,
  createSession,
  pruneExpiredSessions,
  readSession,
  readSessionFromCookieHeader,
  revokeSession,
  shouldUseSecureCookie,
  writeSessionCookie,
} from "./session/cookieSession.js";
import { attachNetnodeSession } from "./session/sessionMiddleware.js";
import { initSessionRuntime, shutdownSessionRuntime } from "./session/sessionRuntime.js";

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

const DEFAULT_DISCOVERY_WATCH_PROFILE: DiscoveryWatchProfile = {
  id: "default-uln-10-0-94-0-24",
  name: "ULN Default Discovery",
  subnets: "10.0.94.0/24",
  protocol: "snmp",
  city: "Ульяновск",
  zone: "Core",
  branch: "ULN",
  enabled: true,
  intervalHours: 3,
  lastRunAt: null,
  lastResult: null,
};

let discoveryWatchProfiles: DiscoveryWatchProfile[] = [{ ...DEFAULT_DISCOVERY_WATCH_PROFILE }];
let discoveryScheduler: NodeJS.Timeout | null = null;
let discoveryRunLock = false;
let discoverySchedulerLastTickAt: string | null = null;
let discoverySchedulerLastProcessed = 0;
let inventoryMetricsScheduler: NodeJS.Timeout | null = null;
let inventoryMetricsRunLock = false;
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
type DiscoveryWatchRunResult = {
  profileId: string;
  profileName: string;
  result: DiscoveryWatchProfile["lastResult"];
};
type DiscoveryWatchRunJob = {
  id: string;
  actor: string;
  status: "running" | "done" | "error";
  createdAt: string;
  startedAt: string;
  finishedAt?: string;
  profileIds: string[] | null;
  progress: {
    completed: number;
    total: number;
  };
  runs: DiscoveryWatchRunResult[];
  error?: string;
};
let discoveryWatchRunJobs = new Map<string, DiscoveryWatchRunJob>();
let activeManualWatchRunJobId: string | null = null;

function trimManualDiscoveryJobs(max = 30) {
  if (manualDiscoveryJobs.size <= max) return;
  const oldest = Array.from(manualDiscoveryJobs.values())
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .slice(0, manualDiscoveryJobs.size - max);
  oldest.forEach((j) => manualDiscoveryJobs.delete(j.id));
}
function trimDiscoveryWatchRunJobs(max = 50) {
  if (discoveryWatchRunJobs.size <= max) return;
  const oldest = Array.from(discoveryWatchRunJobs.values())
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .slice(0, discoveryWatchRunJobs.size - max);
  oldest.forEach((j) => discoveryWatchRunJobs.delete(j.id));
}
type SshReadonlyProfile = {
  username: string;
  passwordMaterial: PasswordMaterial;
  port: number;
  allowMetricsFallback: boolean;
  expiresAt: number;
};
let sshReadonlyProfile: SshReadonlyProfile | null = null;

async function sshReadonlyPassword(profile: SshReadonlyProfile): Promise<string> {
  return readPasswordMaterial(profile.passwordMaterial);
}

const LEGACY_SSH_ALGORITHMS = {
  // Prefer modern algorithms but keep legacy fallbacks for older Cisco/HP/HPE stacks.
  kex: [
    "curve25519-sha256",
    "curve25519-sha256@libssh.org",
    "ecdh-sha2-nistp256",
    "ecdh-sha2-nistp384",
    "ecdh-sha2-nistp521",
    "diffie-hellman-group-exchange-sha256",
    "diffie-hellman-group14-sha256",
    "diffie-hellman-group14-sha1",
    "diffie-hellman-group-exchange-sha1",
    "diffie-hellman-group1-sha1",
  ],
  serverHostKey: ["rsa-sha2-512", "rsa-sha2-256", "ssh-ed25519", "ecdsa-sha2-nistp521", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp256", "ssh-rsa", "ssh-dss"],
  cipher: [
    "chacha20-poly1305@openssh.com",
    "aes128-gcm@openssh.com",
    "aes256-gcm@openssh.com",
    "aes128-ctr",
    "aes192-ctr",
    "aes256-ctr",
    "aes128-cbc",
    "aes192-cbc",
    "aes256-cbc",
    "3des-cbc",
  ],
  hmac: ["hmac-sha2-256", "hmac-sha2-512", "hmac-sha1", "hmac-md5"],
};

function legacySshConnectOptions() {
  return {
    algorithms: LEGACY_SSH_ALGORITHMS,
  };
}

type SshErrorLike = {
  message?: string;
  code?: string;
  level?: string;
  description?: string;
  reason?: string;
};

function sshErrorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  const e = err as SshErrorLike | null | undefined;
  return e?.message || e?.description || e?.reason || "Unknown SSH error";
}

function normalizeSshErrorForClient(err: unknown): string {
  const e = err as SshErrorLike | null | undefined;
  const message = sshErrorText(err);
  const raw = [message, e?.code, e?.level, e?.description, e?.reason].filter(Boolean).join(" ");

  if (/All configured authentication methods failed|Authentication failed|Permission denied/i.test(raw)) {
    return "SSH authentication failed. Check the username/password and whether the device allows password or keyboard-interactive login.";
  }

  if (/Timed out while waiting for handshake|readyTimeout|client-timeout|ETIMEDOUT|EHOSTUNREACH/i.test(raw)) {
    return "SSH connection timed out. Check reachability, the SSH port, device CPU load, and whether an ACL/firewall is blocking the session.";
  }

  if (/ECONNREFUSED/i.test(raw)) {
    return "SSH connection refused. Confirm SSH is enabled on the device and the selected port is correct.";
  }

  if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) {
    return "SSH host could not be resolved. Check the hostname or use the device IP address.";
  }

  if (/Cannot parse privateKey|Bad passphrase|Encrypted private key detected/i.test(raw)) {
    return "SSH key authentication failed. Check the private key format and passphrase.";
  }

  if (/no matching (?:key exchange|cipher|MAC|host key)|Handshake failed/i.test(raw)) {
    return `SSH handshake failed because no compatible algorithms were negotiated. On older Cisco firmware, enable a supported KEX/cipher/host-key pair such as diffie-hellman-group14-sha256 or group14-sha1 with aes*-ctr and rsa-sha2/ssh-rsa. Original error: ${message}`;
  }

  if (/error:0{8}:lib\(0\)::reason\(0\)|lib\(0\).*reason\(0\)/i.test(raw)) {
    return `SSH handshake failed during encryption negotiation. This usually means the device and proxy could not agree on a usable cipher/KEX/host-key algorithm; update device SSH settings or firmware if it only offers very old algorithms. Original OpenSSL error: ${message}`;
  }

  return message;
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
type TopologyMode = "ip" | "fc";
type TopologyLayout = Record<string, { x: number; y: number }>;
type TopologyZoneLabelOverrides = Record<string, string>;
let topologyLinks: TopologyLink[] = [];
let topologyLayout: TopologyLayout = {};
let topologyLayoutScopes: Record<TopologyMode, Record<string, TopologyLayout>> = { ip: {}, fc: {} };
let topologyZoneLabelOverridesScopes: Record<TopologyMode, Record<string, TopologyZoneLabelOverrides>> = { ip: {}, fc: {} };
type TopologySnapshot = {
  id: string;
  createdAt: string;
  actor: string;
  reason: string;
  branch?: string;
  links: TopologyLink[];
  layout: TopologyLayout;
  layoutScopes?: Record<TopologyMode, Record<string, TopologyLayout>>;
  zoneLabelOverridesScopes?: Record<TopologyMode, Record<string, TopologyZoneLabelOverrides>>;
};
let topologySnapshots: TopologySnapshot[] = [];

function cloneTopologyLinks(links: TopologyLink[]): TopologyLink[] {
  return links.map((l) => ({ ...l }));
}

function cloneTopologyLayout(layout: TopologyLayout): TopologyLayout {
  const out: TopologyLayout = {};
  Object.entries(layout || {}).forEach(([id, p]) => {
    out[id] = { x: Number(p.x), y: Number(p.y) };
  });
  return out;
}

function cloneTopologyLayoutScopes(
  scopes: Record<TopologyMode, Record<string, TopologyLayout>>
): Record<TopologyMode, Record<string, TopologyLayout>> {
  return {
    ip: Object.fromEntries(Object.entries(scopes.ip || {}).map(([branch, layout]) => [branch, cloneTopologyLayout(layout)])),
    fc: Object.fromEntries(Object.entries(scopes.fc || {}).map(([branch, layout]) => [branch, cloneTopologyLayout(layout)])),
  };
}

function cloneTopologyZoneLabelOverrides(overrides: TopologyZoneLabelOverrides): TopologyZoneLabelOverrides {
  return { ...(overrides || {}) };
}

function cloneTopologyZoneLabelOverrideScopes(
  scopes: Record<TopologyMode, Record<string, TopologyZoneLabelOverrides>>
): Record<TopologyMode, Record<string, TopologyZoneLabelOverrides>> {
  return {
    ip: Object.fromEntries(Object.entries(scopes.ip || {}).map(([branch, overrides]) => [branch, cloneTopologyZoneLabelOverrides(overrides)])),
    fc: Object.fromEntries(Object.entries(scopes.fc || {}).map(([branch, overrides]) => [branch, cloneTopologyZoneLabelOverrides(overrides)])),
  };
}

function normalizeTopologyMode(value: unknown): TopologyMode {
  return String(value || "").trim().toLowerCase() === "fc" ? "fc" : "ip";
}

function topologyLayoutBranchKey(branch?: string): string {
  return String(branch || "").trim();
}

function scopedTopologyLayout(
  layout: TopologyLayout,
  branch?: string
): TopologyLayout {
  const branchName = String(branch || "").trim();
  if (!branchName) return cloneTopologyLayout(layout);
  const ids = branchDeviceIdSet(branchName);
  const scoped: TopologyLayout = {};
  Object.entries(layout || {}).forEach(([id, p]) => {
    if (ids.has(id)) scoped[id] = { x: Number(p.x), y: Number(p.y) };
  });
  return scoped;
}

function getTopologyLayoutForScope(mode: TopologyMode, branch?: string): TopologyLayout {
  const key = topologyLayoutBranchKey(branch);
  const scoped = topologyLayoutScopes[mode]?.[key];
  if (scoped) return cloneTopologyLayout(scoped);
  return scopedTopologyLayout(topologyLayout, branch);
}

function getTopologyZoneLabelOverridesForScope(mode: TopologyMode, branch?: string): TopologyZoneLabelOverrides {
  const key = topologyLayoutBranchKey(branch);
  return cloneTopologyZoneLabelOverrides(topologyZoneLabelOverridesScopes[mode]?.[key] || {});
}

function getSnapshotLayoutForScope(snapshot: TopologySnapshot, mode: TopologyMode, branch?: string): TopologyLayout {
  const key = topologyLayoutBranchKey(branch);
  const scoped = snapshot.layoutScopes?.[mode]?.[key];
  if (scoped) return cloneTopologyLayout(scoped);
  return scopedTopologyLayout(snapshot.layout, branch);
}

function setTopologyLayoutForScope(mode: TopologyMode, branch: string | undefined, layout: TopologyLayout) {
  const key = topologyLayoutBranchKey(branch);
  topologyLayoutScopes[mode][key] = cloneTopologyLayout(layout);
}

function mergeTopologyLayoutForScope(mode: TopologyMode, branch: string | undefined, positions: TopologyLayout, replace = false) {
  const key = topologyLayoutBranchKey(branch);
  const next = replace ? {} : getTopologyLayoutForScope(mode, branch);
  Object.entries(positions || {}).forEach(([id, pos]) => {
    if (Number.isFinite(pos?.x) && Number.isFinite(pos?.y)) {
      next[id] = { x: Number(pos.x), y: Number(pos.y) };
    }
  });
  topologyLayoutScopes[mode][key] = next;
  return cloneTopologyLayout(next);
}

function deleteTopologyLayoutIds(ids: string[]) {
  Object.keys(topologyLayout).forEach((id) => {
    if (ids.includes(id)) delete topologyLayout[id];
  });
  (Object.keys(topologyLayoutScopes) as TopologyMode[]).forEach((mode) => {
    Object.values(topologyLayoutScopes[mode]).forEach((layout) => {
      Object.keys(layout).forEach((id) => {
        if (ids.includes(id)) delete layout[id];
      });
    });
  });
}

function renameTopologyLayoutBranchScopes(from: string, to: string) {
  (Object.keys(topologyLayoutScopes) as TopologyMode[]).forEach((mode) => {
    const scoped = topologyLayoutScopes[mode];
    if (!scoped[from]) return;
    scoped[to] = { ...cloneTopologyLayout(scoped[to] || {}), ...cloneTopologyLayout(scoped[from]) };
    delete scoped[from];
  });
}

function renameTopologyZoneLabelBranchScopes(from: string, to: string) {
  (Object.keys(topologyZoneLabelOverridesScopes) as TopologyMode[]).forEach((mode) => {
    const scoped = topologyZoneLabelOverridesScopes[mode];
    if (!scoped[from]) return;
    scoped[to] = { ...cloneTopologyZoneLabelOverrides(scoped[to] || {}), ...cloneTopologyZoneLabelOverrides(scoped[from]) };
    delete scoped[from];
  });
}

function saveTopologySnapshot(actor: string, reason: string, branch?: string) {
  const snapshot: TopologySnapshot = {
    id: `topo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    actor,
    reason,
    branch: branch || undefined,
    links: cloneTopologyLinks(topologyLinks),
    layout: cloneTopologyLayout(topologyLayout),
    layoutScopes: cloneTopologyLayoutScopes(topologyLayoutScopes),
    zoneLabelOverridesScopes: cloneTopologyZoneLabelOverrideScopes(topologyZoneLabelOverridesScopes),
  };
  topologySnapshots.push(snapshot);
  if (topologySnapshots.length > 60) {
    topologySnapshots = topologySnapshots.slice(topologySnapshots.length - 60);
  }
}

function topologyPairKey(source: string, target: string): string {
  return [source, target].sort().join("::");
}

function topologyLinkSignature(link: TopologyLink): string {
  return `${topologyPairKey(link.source, link.target)}::${String(link.portA || "").trim()}::${String(link.portB || "").trim()}`;
}

function branchDeviceIdSet(branch: string): Set<string> {
  return new Set(
    inventory
      .filter((item) => String(item.branch || "").trim() === branch)
      .map((item) => item.id)
  );
}

function filterTopologyByBranch(
  links: TopologyLink[],
  layout: TopologyLayout,
  branch?: string
) {
  if (!branch) {
    return {
      links: cloneTopologyLinks(links),
      layout: cloneTopologyLayout(layout),
    };
  }
  const ids = branchDeviceIdSet(branch);
  const scopedLinks = links.filter((l) => ids.has(l.source) && ids.has(l.target));
  const scopedLayout: Record<string, { x: number; y: number }> = {};
  Object.entries(layout || {}).forEach(([id, p]) => {
    if (ids.has(id)) scopedLayout[id] = { x: Number(p.x), y: Number(p.y) };
  });
  return { links: cloneTopologyLinks(scopedLinks), layout: scopedLayout };
}

function diffTopologyState(
  current: { links: TopologyLink[]; layout: Record<string, { x: number; y: number }> },
  target: { links: TopologyLink[]; layout: Record<string, { x: number; y: number }> }
) {
  const curSet = new Set(current.links.map((l) => topologyLinkSignature(l)));
  const tgtSet = new Set(target.links.map((l) => topologyLinkSignature(l)));
  const addedLinks = Array.from(tgtSet).filter((k) => !curSet.has(k)).length;
  const removedLinks = Array.from(curSet).filter((k) => !tgtSet.has(k)).length;

  const curByPair = new Map<string, TopologyLink>();
  current.links.forEach((l) => curByPair.set(topologyPairKey(l.source, l.target), l));
  const tgtByPair = new Map<string, TopologyLink>();
  target.links.forEach((l) => tgtByPair.set(topologyPairKey(l.source, l.target), l));
  let changedLinkLabels = 0;
  tgtByPair.forEach((t, k) => {
    const c = curByPair.get(k);
    if (!c) return;
    if (String(c.portA || "") !== String(t.portA || "") || String(c.portB || "") !== String(t.portB || "")) changedLinkLabels += 1;
  });

  const allNodeIds = new Set<string>([...Object.keys(current.layout || {}), ...Object.keys(target.layout || {})]);
  let movedNodes = 0;
  allNodeIds.forEach((id) => {
    const c = current.layout[id];
    const t = target.layout[id];
    if (!c || !t) return;
    if (Math.abs(Number(c.x) - Number(t.x)) > 0.5 || Math.abs(Number(c.y) - Number(t.y)) > 0.5) movedNodes += 1;
  });

  return {
    addedLinks,
    removedLinks,
    changedLinkLabels,
    movedNodes,
    totalCurrentLinks: current.links.length,
    totalTargetLinks: target.links.length,
  };
}

let users: LocalUser[] = createInitialUsers();

function migratePlaintextPasswords() {
  users.forEach((user) => {
    if (user.password && !user.passwordHash) {
      user.passwordHash = hashPassword(user.password);
      delete user.password;
      console.warn(`[Security] Migrated plaintext password for local user ${user.username}.`);
    }
  });
}
migratePlaintextPasswords();

interface AuditLog {
  id: string;
  timestamp: string;
  user: string;
  action: string;
  details: string;
  category: 'auth' | 'inventory' | 'config' | 'user_mgmt' | 'system' | 'automation';
  ipAddress?: string;
}

let auditLogs: AuditLog[] = [];

// System Config State
let systemConfig = {
  defaultLanguage: 'ru',
  siteLabel: 'UNSET',
  productName: 'NETNODE',
  theme: 'dark' as 'dark' | 'light',
  logoDataUrl: '',
  automationDefaults: {
    batchSize: 10,
    timeoutMs: 15000,
    retry: 1,
    concurrency: 10,
    errorThreshold: 20,
  },
  dashboardUi: {
    trunkThroughputTitle: 'Trunk Throughput (Mbps)',
    trunkLoadTitle: 'Trunk Load (Mbps)',
    trunkMonitorTitle: 'Trunk Monitor',
    showTrunkMonitor: true,
  },
};

const SNMP_SECRET_MASK = "********";

function defaultSnmpMacSearch() {
  return {
    dot1dTpFdbPortOid: "1.3.6.1.2.1.17.4.3.1.2",
    dot1dBasePortIfIndexOid: "1.3.6.1.2.1.17.1.4.1.2",
    dot1qTpFdbPortOid: "1.3.6.1.2.1.17.7.1.2.2.1.2",
    voiceVlanMacOid: "1.3.6.1.4.1.9.9.315.1.2.3.1.1",
    voiceOuiPrefixes: [] as string[],
    voiceOuiEntries: [] as Array<{ ouiAddress: string; mask: string; description: string }>,
  };
}

type SnmpMacSearchConfig = ReturnType<typeof defaultSnmpMacSearch>;

type SnmpRuntimeConfig = {
  communityMaterial: PasswordMaterial;
  communitiesMaterials: PasswordMaterial[];
  version: string;
  port: number;
  timeoutMs: number;
  retries: number;
  macSearch: SnmpMacSearchConfig;
};

function defaultSnmpRuntime(): SnmpRuntimeConfig {
  return {
    communityMaterial: { kind: "plain", value: "public" },
    communitiesMaterials: [{ kind: "plain", value: "public" }],
    version: "SNMP v2c",
    port: 161,
    timeoutMs: 1200,
    retries: 0,
    macSearch: defaultSnmpMacSearch(),
  };
}

let snmpConfig: SnmpRuntimeConfig = defaultSnmpRuntime();

function hydrateSnmpFromKv(value: unknown): SnmpRuntimeConfig {
  const base = defaultSnmpRuntime();
  if (!value || typeof value !== "object") return base;
  const v = value as Record<string, unknown>;
  const mac =
    v.macSearch && typeof v.macSearch === "object" ? { ...base.macSearch, ...(v.macSearch as object) } : base.macSearch;
  let communityMaterial = base.communityMaterial;
  const cm = v.communityMaterial;
  if (cm && typeof cm === "object" && cm !== null && "kind" in cm) {
    communityMaterial = cm as PasswordMaterial;
  } else if (typeof v.community === "string") {
    communityMaterial = { kind: "plain", value: v.community };
  }
  let communitiesMaterials = base.communitiesMaterials;
  const cms = v.communitiesMaterials;
  if (Array.isArray(cms) && cms.every((x) => x && typeof x === "object" && x !== null && "kind" in x)) {
    communitiesMaterials = cms as PasswordMaterial[];
  } else if (Array.isArray(v.communities)) {
    communitiesMaterials = (v.communities as unknown[]).map((s) =>
      typeof s === "string" ? ({ kind: "plain", value: s } as PasswordMaterial) : ({ kind: "plain", value: "" } as PasswordMaterial)
    );
  }
  return {
    communityMaterial,
    communitiesMaterials,
    version: typeof v.version === "string" ? v.version : base.version,
    port: typeof v.port === "number" && Number.isFinite(v.port) ? v.port : base.port,
    timeoutMs: typeof v.timeoutMs === "number" && Number.isFinite(v.timeoutMs) ? v.timeoutMs : base.timeoutMs,
    retries: typeof v.retries === "number" && Number.isFinite(v.retries) ? v.retries : base.retries,
    macSearch: mac as SnmpRuntimeConfig["macSearch"],
  };
}

function snmpConfigForClient(): Record<string, unknown> {
  return {
    community: materialHasValue(snmpConfig.communityMaterial) ? SNMP_SECRET_MASK : "",
    communities: snmpConfig.communitiesMaterials.map((m) => (materialHasValue(m) ? SNMP_SECRET_MASK : "")),
    version: snmpConfig.version,
    port: snmpConfig.port,
    timeoutMs: snmpConfig.timeoutMs,
    retries: snmpConfig.retries,
    macSearch: snmpConfig.macSearch,
  };
}

async function mergeSnmpCredentialsFromBody(
  body: Record<string, unknown>,
  prev: SnmpRuntimeConfig
): Promise<{ communityMaterial: PasswordMaterial; communitiesMaterials: PasswordMaterial[] }> {
  let communityMaterial = prev.communityMaterial;
  if (typeof body.community === "string") {
    const s = body.community.trim();
    if (s && s !== SNMP_SECRET_MASK) communityMaterial = await materialFromUserPassword(s);
  }
  let communitiesMaterials = prev.communitiesMaterials;
  if (Array.isArray(body.communities)) {
    const inc = body.communities as unknown[];
    communitiesMaterials = await Promise.all(
      inc.map(async (raw, i) => {
        const token = typeof raw === "string" ? raw.trim() : "";
        if (!token || token === SNMP_SECRET_MASK) {
          return prev.communitiesMaterials[i] ?? ({ kind: "plain", value: "" } as PasswordMaterial);
        }
        return materialFromUserPassword(token);
      })
    );
  }
  return { communityMaterial, communitiesMaterials };
}

async function sealVolatileCredentialMaterialsAfterHydrate() {
  const upgrade = async (m: PasswordMaterial): Promise<PasswordMaterial> => {
    if (m.kind !== "plain") return m;
    return materialFromUserPassword(m.value);
  };
  snmpConfig.communityMaterial = await upgrade(snmpConfig.communityMaterial);
  snmpConfig.communitiesMaterials = await Promise.all(snmpConfig.communitiesMaterials.map(upgrade));
  ldapConfig = {
    admin: { ...ldapConfig.admin, bindPasswordMaterial: await upgrade(ldapConfig.admin.bindPasswordMaterial) },
    operator: { ...ldapConfig.operator, bindPasswordMaterial: await upgrade(ldapConfig.operator.bindPasswordMaterial) },
  };
  if (sshReadonlyProfile) {
    sshReadonlyProfile = {
      ...sshReadonlyProfile,
      passwordMaterial: await upgrade(sshReadonlyProfile.passwordMaterial),
    };
  }
}

type BackupScope = {
  mode: "all" | "filtered";
  deviceIds?: string[];
  vendors?: string[];
  branches?: string[];
};

type BackupConfig = {
  enabled: boolean;
  intervalHours: number;
  networkSharePath: string;
  scope: BackupScope;
  credentials?: {
    username?: string;
    password?: string;
    domain?: string;
  };
};

type BackupHistoryItem = {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "completed" | "failed";
  actor: string;
  summary: {
    total: number;
    success: number;
    failed: number;
  };
  details: Array<{
    deviceId: string;
    deviceName: string;
    ip: string;
    status: "success" | "failed";
    filePath?: string;
    error?: string;
  }>;
  error?: string;
};

let backupConfig: BackupConfig = {
  enabled: false,
  intervalHours: 6,
  networkSharePath: "",
  scope: { mode: "all" },
  credentials: { username: "", password: "", domain: "" },
};
let backupHistory: BackupHistoryItem[] = [];
let backupScheduler: NodeJS.Timeout | null = null;
let backupRunLock = false;
let backupSchedulerLastTickAt: string | null = null;

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

async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const safeLimit = Math.max(1, Math.min(limit, items.length || 1));
  const jobs = Array.from({ length: safeLimit }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]!, index);
    }
  });
  await Promise.all(jobs);
  return results;
}

function safeErrorDetail(error: unknown, fallback = "Unknown error"): string {
  const raw = error instanceof Error ? error.message : String(error || fallback);
  return raw
    .replace(/(password|community|secret|token|passphrase)\s*[:=]\s*[^,\s;]+/gi, "$1=<redacted>")
    .replace(/(ssh:\/\/[^:\s]+:)[^@\s]+@/gi, "$1<redacted>@")
    .slice(0, 500);
}

function clientErrorPayload(source: string, error: unknown, extra: Record<string, unknown> = {}) {
  return {
    success: false,
    source,
    error: safeErrorDetail(error),
    ...extra,
  };
}

function isPlaceholderTrunkName(value: string): boolean {
  const raw = String(value || "").trim();
  if (!raw) return false;
  if (/^\s*trk(?:[\s_-]*\d+)?\s*$/i.test(raw)) return true;
  // Ignore auto-generated LAG labels like Bridge-Aggregation4 / Bridge-Aggregation4 Interface.
  const normalized = raw.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return /^bridge aggregation\s*\d+$/.test(normalized) || /^bridge aggregation\s*\d+\s+interface$/.test(normalized);
}

function hasDescriptiveTrunkLabel(...values: string[]): boolean {
  return values.some((value) => {
    const trimmed = String(value || "").trim();
    return Boolean(trimmed) && !isPlaceholderTrunkName(trimmed);
  });
}

function isLikelyTrunkPort(name: string, alias: string, descr: string, ifType?: string): boolean {
  const v = `${name} ${alias} ${descr}`.trim().toLowerCase();
  const t = Number(ifType || 0);
  if (t === 161) return true; // ieee8023adLag
  if (!hasDescriptiveTrunkLabel(name, alias, descr)) return false;
  if (!v) return false;
  return /\b(trunk|trk[\s_-]*\d*|lag[\s_-]*\d*|port[\s_-]*channel[\s_-]*\d*|po[\s_-]*\d+|bundle[\s_-]*ether[\s_-]*\d+|be[\s_-]*\d+|etherchannel|bond[\s_-]*\d*|bridge[\s_-]*aggregation[\s_-]*\d*|ae[\s_-]*\d+|lacp)\b/.test(v);
}

function isLikelyLagInterface(name: string, alias: string, descr: string, ifType?: string): boolean {
  const v = `${name} ${alias} ${descr}`.trim().toLowerCase();
  const t = Number(ifType || 0);
  if (t === 161) return true; // ieee8023adLag
  if (!hasDescriptiveTrunkLabel(name, alias, descr)) return false;
  return /\b(trk[\s_-]*\d*|lag[\s_-]*\d*|port[\s_-]*channel[\s_-]*\d*|po[\s_-]*\d+|bundle[\s_-]*ether[\s_-]*\d+|be[\s_-]*\d+|etherchannel|bond[\s_-]*\d*|bridge[\s_-]*aggregation[\s_-]*\d*|ae[\s_-]*\d+|lacp)\b/.test(v);
}

function parseCiscoIfIndexFromSuffix(suffix: string): string {
  const parts = String(suffix || "").split(".").filter(Boolean);
  if (!parts.length) return "";
  // Cisco tables can have composite indexes; last numeric token is typically ifIndex.
  return parts[parts.length - 1] || "";
}

function buildInterfaceIndexSet(
  maps: Array<Record<string, string> | undefined>,
  extraIndexes: Iterable<string> = []
): Set<string> {
  const out = new Set<string>();
  for (const map of maps) {
    if (!map) continue;
    Object.keys(map).forEach((k) => {
      const idx = String(k || "").trim();
      if (idx) out.add(idx);
    });
  }
  for (const raw of extraIndexes) {
    const idx = String(raw || "").trim();
    if (idx) out.add(idx);
  }
  return out;
}

type LagMembership = {
  memberToAgg: Map<string, string>;
  aggToMembers: Map<string, Set<string>>;
  aggIndexes: Set<string>;
};

function emptyLagMembership(): LagMembership {
  return { memberToAgg: new Map(), aggToMembers: new Map(), aggIndexes: new Set() };
}

async function getLagMembership(host: string): Promise<LagMembership> {
  try {
    const [attachedAgg, ifStackStatus, ifNames, ifAlias, ifDescr, ifType] = await Promise.all([
      // IEEE8023-LAG-MIB maps member ifIndex values to the active logical aggregator ifIndex.
      snmpWalk(host, "1.2.840.10006.300.43.1.2.1.1.13"),
      // IF-MIB ifStackStatus often exposes Cisco EtherChannel as Port-Channel -> physical member.
      // Some platforms report the inverse orientation, so resolve the aggregate side by interface identity.
      snmpWalk(host, "1.3.6.1.2.1.31.1.2.1.3"),
      snmpWalk(host, "1.3.6.1.2.1.31.1.1.1.1"),
      snmpWalk(host, "1.3.6.1.2.1.31.1.1.1.18"),
      snmpWalk(host, "1.3.6.1.2.1.2.2.1.2"),
      snmpWalk(host, "1.3.6.1.2.1.2.2.1.3"),
    ]);
    const out = emptyLagMembership();
    const addMembership = (memberRaw: string, aggRaw: string) => {
      const member = String(memberRaw || "").trim();
      const agg = String(aggRaw || "").trim();
      if (!member || !agg || agg === "0" || member === "0" || agg === member) return;
      out.memberToAgg.set(member, agg);
      out.aggIndexes.add(agg);
      const members = out.aggToMembers.get(agg) || new Set<string>();
      members.add(member);
      out.aggToMembers.set(agg, members);
    };
    for (const [memberRaw, aggRaw] of Object.entries(attachedAgg)) {
      addMembership(memberRaw, aggRaw);
    }
    for (const [suffix, rawStatus] of Object.entries(ifStackStatus)) {
      if (Number(rawStatus || 0) !== 1) continue; // active
      const [higher, lower] = String(suffix || "").split(".").filter(Boolean);
      if (!higher || !lower) continue;
      const higherLooksLag =
        out.aggIndexes.has(higher) ||
        isLikelyLagInterface(
          String(ifNames[higher] || "").trim(),
          String(ifAlias[higher] || "").trim(),
          String(ifDescr[higher] || "").trim(),
          ifType[higher]
        );
      const lowerLooksLag =
        out.aggIndexes.has(lower) ||
        isLikelyLagInterface(
          String(ifNames[lower] || "").trim(),
          String(ifAlias[lower] || "").trim(),
          String(ifDescr[lower] || "").trim(),
          ifType[lower]
        );
      if (higherLooksLag && !lowerLooksLag) addMembership(lower, higher);
      if (lowerLooksLag && !higherLooksLag) addMembership(higher, lower);
    }
    return out;
  } catch {
    return emptyLagMembership();
  }
}

function getCiscoAggregateHints(ciscoHints: Set<string>, lag: LagMembership): Set<string> {
  const out = new Set<string>();
  ciscoHints.forEach((idx) => {
    const agg = lag.memberToAgg.get(idx);
    if (agg) out.add(agg);
  });
  return out;
}

function resolveTrunkState(
  ifIndex: string,
  ifOper: Record<string, string>,
  ifAdmin: Record<string, string>,
  lag: LagMembership = emptyLagMembership(),
  hasCounters = false,
  hasCiscoTrunkHint = false
): { operStatus: number; adminStatus?: number; isActive: boolean; isDown: boolean; stateSource: string } {
  const operRaw = ifOper[ifIndex];
  const adminRaw = ifAdmin[ifIndex];
  const oper = operRaw === undefined ? undefined : Number(operRaw);
  const admin = adminRaw === undefined ? undefined : Number(adminRaw);
  if (oper === 1) return { operStatus: 1, adminStatus: admin, isActive: true, isDown: false, stateSource: "ifOperStatus" };

  const members = Array.from(lag.aggToMembers.get(ifIndex) || []);
  const activeMember = members.some((member) => Number(ifOper[member] || 0) === 1 && Number(ifAdmin[member] || 1) !== 2);
  if (activeMember) {
    // Cisco bundles can have reliable member state while the Port-Channel ifOper/admin status is absent or stale.
    return { operStatus: 1, adminStatus: admin, isActive: true, isDown: false, stateSource: "active-lag-member" };
  }
  if (hasCiscoTrunkHint && admin !== 2) {
    return { operStatus: 1, adminStatus: admin, isActive: true, isDown: false, stateSource: "cisco-vtp-trunk" };
  }
  if (admin === 2) return { operStatus: oper || 2, adminStatus: admin, isActive: false, isDown: false, stateSource: "admin-down" };
  if ((oper === undefined || !Number.isFinite(oper)) && admin === 1 && hasCounters) {
    return { operStatus: 1, adminStatus: admin, isActive: true, isDown: false, stateSource: "admin-up-counters" };
  }
  const resolvedOper = Number.isFinite(oper) && oper ? Number(oper) : 0;
  const down = admin !== 2 && (resolvedOper === 2 || resolvedOper === 7);
  return { operStatus: resolvedOper, adminStatus: admin, isActive: false, isDown: down, stateSource: resolvedOper ? "ifOperStatus" : "unknown" };
}

type TopologyTrunkDecisionFlags = {
  nameMatch: boolean;
  explicitTrunkKeyword: boolean;
  operUp: boolean;
  adminDown: boolean;
  lagInterface: boolean;
  lagMembersUp: boolean;
  lldpPeerPresent: boolean;
  lldpPeerInventoryMatch: boolean;
  lldpPeerNetworkDevice: boolean;
  cdpPeerPresent: boolean;
  cdpPeerInventoryMatch: boolean;
  cdpPeerNetworkDevice: boolean;
  peerNetworkDevice: boolean;
  ciscoVtpHint: boolean;
  ciscoAggHint: boolean;
  explicitHostHint: boolean;
};

type TopologyTrunkDiagnostic = {
  deviceId: string;
  deviceName: string;
  deviceIp: string;
  ifIndex: string;
  ifName: string;
  rawIfName?: string;
  candidateSource: string;
  isTrunk: boolean;
  reason: string;
  flags: TopologyTrunkDecisionFlags;
  operStatus: number;
  adminStatus?: number;
  stateSource: string;
  memberIfIndexes: string[];
  lldpPeerName?: string;
  cdpPeerName?: string;
  matchedPeerId?: string;
  matchedPeerName?: string;
};

type TopologyTrunkDiagnosticsSnapshot = {
  generatedAt: string;
  branch: string | null;
  devices: number;
  candidates: TopologyTrunkDiagnostic[];
  summary: Record<string, number>;
};

let lastTopologyTrunkDiagnostics: TopologyTrunkDiagnosticsSnapshot = {
  generatedAt: "",
  branch: null,
  devices: 0,
  candidates: [],
  summary: {},
};

function hasExplicitTrunkKeyword(name: string, alias: string, descr: string): boolean {
  const v = `${name} ${alias} ${descr}`.trim().toLowerCase();
  return /\b(trunk|uplink|backbone|core[-_\s]*link|switch[-_\s]*link|router[-_\s]*link)\b/.test(v);
}

function hasExplicitHostHint(name: string, alias: string, descr: string): boolean {
  const v = `${name} ${alias} ${descr}`.trim().toLowerCase();
  return /\b(host|workstation|desktop|laptop|printer|camera|phone|user|endpoint|server|pc)\b/.test(v);
}

function isLikelyHostInventoryItem(item?: InventoryItem): boolean {
  if (!item) return false;
  const v = `${item.name} ${item.vendor} ${item.model} ${item.category || ""} ${item.subcategory || ""}`.toLowerCase();
  return /\b(host|server|workstation|desktop|laptop|printer|camera|phone|endpoint|pc)\b/.test(v);
}

function decideTopologyTrunkCandidate(input: {
  ifName: string;
  alias: string;
  descr: string;
  rawName?: string;
  rawAlias?: string;
  rawDescr?: string;
  ifType?: string;
  isLag: boolean;
  state: ReturnType<typeof resolveTrunkState>;
  lagMembersUp: boolean;
  lldpPeerPresent?: boolean;
  lldpPeerInventoryMatch?: boolean;
  lldpPeerNetworkDevice?: boolean;
  cdpPeerName?: string;
  cdpPeerPresent?: boolean;
  cdpPeerInventoryMatch?: boolean;
  cdpPeerNetworkDevice?: boolean;
  peerNetworkDevice?: boolean;
  ciscoVtpHint?: boolean;
  ciscoAggHint?: boolean;
}): { isTrunk: boolean; reason: string; flags: TopologyTrunkDecisionFlags } {
  const hasDescriptiveLabel = hasDescriptiveTrunkLabel(
    input.ifName,
    input.alias,
    input.descr,
    input.rawName || "",
    input.rawAlias || "",
    input.rawDescr || ""
  );
  const logicalNameMatch = isLikelyTrunkPort(input.ifName, input.alias, input.descr, input.ifType);
  const rawNameMatch = isLikelyTrunkPort(input.rawName || "", input.rawAlias || "", input.rawDescr || "", input.ifType);
  const explicitTrunkKeyword =
    hasExplicitTrunkKeyword(input.ifName, input.alias, input.descr) ||
    hasExplicitTrunkKeyword(input.rawName || "", input.rawAlias || "", input.rawDescr || "");
  const explicitHostHint =
    hasExplicitHostHint(input.ifName, input.alias, input.descr) ||
    hasExplicitHostHint(input.rawName || "", input.rawAlias || "", input.rawDescr || "");
  const peerNetworkDevice = Boolean(input.peerNetworkDevice || input.lldpPeerNetworkDevice || input.cdpPeerNetworkDevice);
  const flags: TopologyTrunkDecisionFlags = {
    nameMatch: logicalNameMatch || rawNameMatch,
    explicitTrunkKeyword,
    operUp: input.state.isActive || input.state.operStatus === 1,
    adminDown: input.state.adminStatus === 2 || input.state.stateSource === "admin-down",
    lagInterface: input.isLag,
    lagMembersUp: input.lagMembersUp,
    lldpPeerPresent: Boolean(input.lldpPeerPresent),
    lldpPeerInventoryMatch: Boolean(input.lldpPeerInventoryMatch),
    lldpPeerNetworkDevice: Boolean(input.lldpPeerNetworkDevice),
    cdpPeerPresent: Boolean(input.cdpPeerPresent),
    cdpPeerInventoryMatch: Boolean(input.cdpPeerInventoryMatch),
    cdpPeerNetworkDevice: Boolean(input.cdpPeerNetworkDevice),
    peerNetworkDevice,
    ciscoVtpHint: Boolean(input.ciscoVtpHint),
    ciscoAggHint: Boolean(input.ciscoAggHint),
    explicitHostHint,
  };

  if (!hasDescriptiveLabel) return { isTrunk: false, reason: "placeholderTrunkName", flags };
  if (flags.adminDown) return { isTrunk: false, reason: "adminDown", flags };
  if (flags.ciscoVtpHint) return { isTrunk: true, reason: "ciscoVtpHint", flags };
  if (flags.ciscoAggHint) return { isTrunk: true, reason: "ciscoAggregateVtpHint", flags };
  if (flags.explicitTrunkKeyword) return { isTrunk: true, reason: "explicitTrunkKeyword", flags };
  if (flags.peerNetworkDevice && (flags.operUp || flags.lagMembersUp) && !flags.explicitHostHint) {
    return { isTrunk: true, reason: flags.lagInterface ? "lagNetworkPeer" : "networkPeer", flags };
  }
  if (flags.lagInterface && flags.lldpPeerPresent && !flags.peerNetworkDevice) {
    return { isTrunk: false, reason: "lagPeerNotNetworkDevice", flags };
  }
  if (flags.nameMatch && !flags.lagInterface && (flags.operUp || !input.state.isDown)) {
    return { isTrunk: true, reason: "nameMatch", flags };
  }
  if (flags.explicitHostHint && !flags.peerNetworkDevice) return { isTrunk: false, reason: "explicitHostHint", flags };
  return { isTrunk: false, reason: "insufficientEvidence", flags };
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

type CiscoCdpNeighbor = {
  localIfIndex: string;
  cacheIndex: string;
  peerName: string;
  peerPort: string;
  platform: string;
  capabilities: string;
};

async function getCiscoCdpNeighbors(host: string): Promise<CiscoCdpNeighbor[]> {
  try {
    const [deviceId, devicePort, platform, capabilities, sysName] = await Promise.all([
      snmpWalk(host, "1.3.6.1.4.1.9.9.23.1.2.1.1.6"), // cdpCacheDeviceId
      snmpWalk(host, "1.3.6.1.4.1.9.9.23.1.2.1.1.7"), // cdpCacheDevicePort
      snmpWalk(host, "1.3.6.1.4.1.9.9.23.1.2.1.1.8"), // cdpCachePlatform
      snmpWalk(host, "1.3.6.1.4.1.9.9.23.1.2.1.1.9"), // cdpCacheCapabilities
      snmpWalk(host, "1.3.6.1.4.1.9.9.23.1.2.1.1.17"), // cdpCacheSysName, when implemented
    ]);
    const suffixes = new Set([
      ...Object.keys(deviceId),
      ...Object.keys(devicePort),
      ...Object.keys(platform),
      ...Object.keys(capabilities),
      ...Object.keys(sysName),
    ]);
    const out: CiscoCdpNeighbor[] = [];
    for (const suffix of suffixes) {
      const [localIfIndex, cacheIndex = ""] = String(suffix || "").split(".").filter(Boolean);
      const peerName = String(sysName[suffix] || deviceId[suffix] || platform[suffix] || "").trim();
      if (!localIfIndex || !peerName) continue;
      out.push({
        localIfIndex,
        cacheIndex,
        peerName,
        peerPort: String(devicePort[suffix] || "").trim(),
        platform: String(platform[suffix] || "").trim(),
        capabilities: String(capabilities[suffix] || "").trim(),
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function getTrunkPortCountFromSnmp(host: string): Promise<number> {
  try {
    const [ifNames, ifAlias, ifDescr, ifType, ciscoHints, lag] = await Promise.all([
      snmpWalk(host, "1.3.6.1.2.1.31.1.1.1.1"),
      snmpWalk(host, "1.3.6.1.2.1.31.1.1.1.18"),
      snmpWalk(host, "1.3.6.1.2.1.2.2.1.2"),
      snmpWalk(host, "1.3.6.1.2.1.2.2.1.3"),
      getCiscoTrunkPortHints(host),
      getLagMembership(host),
    ]);
    const ciscoAggHints = getCiscoAggregateHints(ciscoHints, lag);
    const indexes = buildInterfaceIndexSet([ifNames, ifAlias, ifDescr], new Set([...ciscoHints, ...ciscoAggHints, ...lag.aggIndexes]));
    let count = 0;
    for (const ifIndex of indexes) {
      const aggIndex = lag.memberToAgg.get(ifIndex);
      if (aggIndex && indexes.has(aggIndex)) continue;
      const ifName = String(ifNames[ifIndex] || `if${ifIndex}`).trim();
      const alias = String(ifAlias[ifIndex] || "").trim();
      const descr = String(ifDescr[ifIndex] || "").trim();
      if (!hasDescriptiveTrunkLabel(ifName, alias, descr)) continue;
      const isLag = isLikelyLagInterface(ifName, alias, descr, ifType[ifIndex]) || lag.aggIndexes.has(ifIndex);
      if (isLikelyTrunkPort(ifName, alias, descr, ifType[ifIndex]) || isLag || ciscoHints.has(ifIndex) || ciscoAggHints.has(ifIndex)) count += 1;
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
  await persistPgInventoryAndTopology("snmp-subcategory-classify");
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
      { key: "cpu_load", oid: "1.3.6.1.2.1.25.3.3.1.2", scale: 1, unit: "%" },
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
  adminStatus?: number;
  isActive?: boolean;
  isDown?: boolean;
  memberIfIndexes?: string[];
  stateSource?: string;
  inBps: number;
  outBps: number;
};

const trunkCounterCache = new Map<string, { inOctets: bigint; outOctets: bigint; ts: number; bits: 32 | 64 }>();

type AutomationScenario = "create-vlan" | "allow-vlan-on-trunk";
type AutomationTargetScope = "selectedIds" | "filters" | "all";
type AutomationAllowMode = "add" | "replace";
type AutomationTarget = {
  scope: AutomationTargetScope;
  selectedIds?: string[];
  selectedDeviceIds?: string[]; // backward-compatible alias
  filters?: {
    vendor?: string[];
    model?: string[];
    branch?: string[];
    category?: string[];
    subcategory?: string[];
  };
  portConditions?: {
    isTrunk?: boolean;
    trunkOnly?: boolean; // backward-compatible alias
    ifNameRegex?: string;
    operStatusUp?: boolean;
    descriptionContains?: string;
  };
};
type AutomationPlan = {
  scenario: AutomationScenario;
  vlanId: number;
  vlanName?: string;
  mode?: AutomationAllowMode;
  target: AutomationTarget;
  options?: {
    dryRun?: boolean;
    batchSize?: number;
    retry?: number;
    errorThreshold?: number;
    timeoutMs?: number;
    concurrency?: number;
  };
};
type AutomationStepStatus = "pending" | "dry-run" | "applied" | "noop" | "error" | "unsupported" | "cancelled";
type AutomationStepResult = {
  id: string;
  jobId: string;
  deviceId: string;
  deviceName: string;
  deviceIp: string;
  vendor: string;
  port?: string;
  scenario: AutomationScenario;
  status: AutomationStepStatus;
  message: string;
  commandPreview: string[];
  commandResult?: string;
  retries: number;
  createdAt: string;
  updatedAt: string;
};
type AutomationJob = {
  id: string;
  planId: string;
  actor: string;
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  startedAt: string;
  finishedAt?: string;
  cancelledAt?: string;
  summary: {
    total: number;
    applied: number;
    noop: number;
    errors: number;
    unsupported: number;
    cancelled: number;
  };
  progress: {
    done: number;
    total: number;
  };
  meta: {
    batchSize: number;
    retry: number;
    errorThreshold: number;
    timeoutMs: number;
    concurrency: number;
  };
  plan: AutomationPlan;
  steps: AutomationStepResult[];
  error?: string;
};

const automationPlans = new Map<string, { id: string; createdAt: string; actor: string; plan: AutomationPlan }>();
const automationJobs = new Map<string, AutomationJob>();
const automationCancellation = new Set<string>();

let pgPool: Pool | null = null;

interface LdapRoleProfile {
  enabled: boolean;
  url: string;
  bindDn: string;
  bindPasswordMaterial: PasswordMaterial;
  searchBase: string;
  searchFilter: string;
  tlsRejectUnauthorized: boolean;
}

type LdapClientPatch = Partial<{
  enabled: boolean;
  url: string;
  bindDn: string;
  bindPassword: string;
  searchBase: string;
  searchFilter: string;
  tlsRejectUnauthorized: boolean;
}>;

const defaultLdapProfile = (): LdapRoleProfile => ({
  enabled: false,
  url: "ldap://127.0.0.1:389",
  bindDn: "",
  bindPasswordMaterial: { kind: "plain", value: "" },
  searchBase: "dc=example,dc=com",
  searchFilter: "(sAMAccountName={{username}})",
  tlsRejectUnauthorized: true,
});

function hydrateLdapRole(raw: unknown): LdapRoleProfile {
  const d = defaultLdapProfile();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  let bindPasswordMaterial = d.bindPasswordMaterial;
  const mat = r.bindPasswordMaterial;
  if (mat && typeof mat === "object" && mat !== null && "kind" in mat) {
    bindPasswordMaterial = mat as PasswordMaterial;
  } else if (typeof r.bindPassword === "string") {
    bindPasswordMaterial = { kind: "plain", value: r.bindPassword };
  }
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    url: typeof r.url === "string" ? r.url : d.url,
    bindDn: typeof r.bindDn === "string" ? r.bindDn : d.bindDn,
    bindPasswordMaterial,
    searchBase: typeof r.searchBase === "string" ? r.searchBase : d.searchBase,
    searchFilter: typeof r.searchFilter === "string" ? r.searchFilter : d.searchFilter,
    tlsRejectUnauthorized:
      typeof r.tlsRejectUnauthorized === "boolean" ? r.tlsRejectUnauthorized : d.tlsRejectUnauthorized,
  };
}

let ldapConfig: { admin: LdapRoleProfile; operator: LdapRoleProfile } = {
  admin: defaultLdapProfile(),
  operator: defaultLdapProfile(),
};

function maskLdapForClient() {
  const mask = (p: LdapRoleProfile) => ({
    enabled: p.enabled,
    url: p.url,
    bindDn: p.bindDn,
    bindPassword: materialHasValue(p.bindPasswordMaterial) ? "********" : "",
    searchBase: p.searchBase,
    searchFilter: p.searchFilter,
    tlsRejectUnauthorized: p.tlsRejectUnauthorized,
  });
  return { admin: mask(ldapConfig.admin), operator: mask(ldapConfig.operator) };
}

async function mergeLdapPasswords(incoming: { admin?: LdapClientPatch; operator?: LdapClientPatch }) {
  const pick = async (key: "admin" | "operator", patch?: LdapClientPatch) => {
    const cur = ldapConfig[key];
    const { bindPassword: bpIn, ...rest } = patch || {};
    const next: LdapRoleProfile = { ...cur, ...rest };
    let bindPasswordMaterial = cur.bindPasswordMaterial;
    if (typeof bpIn === "string") {
      const bp = bpIn.trim();
      if (bp && bp !== "********") bindPasswordMaterial = await materialFromUserPassword(bp);
    }
    next.bindPasswordMaterial = bindPasswordMaterial;
    return next;
  };
  ldapConfig = {
    admin: await pick("admin", incoming.admin),
    operator: await pick("operator", incoming.operator),
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

  return (async () => {
    let bindSecret: string;
    try {
      bindSecret = await readPasswordMaterial(profile.bindPasswordMaterial);
    } catch {
      return false;
    }
    if (!bindSecret) return false;

    return await new Promise<boolean>((resolve) => {
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

      client.bind(profile.bindDn, bindSecret, (bindErr) => {
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
  })();
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

function deriveZoneKeyFromDeviceName(deviceName: string): string {
  const trimmed = String(deviceName || "").trim();
  if (!trimmed) return "";
  const normalized = trimmed
    .replace(/(?:[\s._-]*\d+)+$/, "")
    .replace(/[\s._-]+$/, "")
    .trim();
  return normalized || trimmed;
}

function resolveDeviceZone(name: string, fallback?: string): string {
  const zoneKey = deriveZoneKeyFromDeviceName(name);
  const fallbackValue = String(fallback || "").trim();
  return zoneKey || fallbackValue || "Core";
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
  const MAX_TOTAL = Math.max(64, Math.min(16_384, Number(process.env.NETNODE_DISCOVERY_MAX_IPS) || 1024));
  const CONCURRENCY = Math.max(4, Math.min(128, Number(process.env.NETNODE_DISCOVERY_CONCURRENCY) || 32));
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
        zoneKey: deriveZoneKeyFromDeviceName(probe.sysName?.trim() || `${vendor}-SNMP-${ip.replace(/\./g, "-")}`),
        vendor,
        model,
        category,
        subcategory,
        branch,
        city,
        zone: resolveDeviceZone(probe.sysName?.trim() || `${vendor}-SNMP-${ip.replace(/\./g, "-")}`, zone),
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
  await persistPgInventoryAndTopology("discovery-scan");
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

async function snmpCommunities(): Promise<string[]> {
  const directStr = (await readPasswordMaterial(snmpConfig.communityMaterial)).trim();
  const direct = directStr ? [directStr] : [];
  const fromList = (
    await Promise.all(snmpConfig.communitiesMaterials.map((m) => readPasswordMaterial(m)))
  )
    .map((s) => s.trim())
    .filter(Boolean);
  const merged = [...direct, ...fromList];
  const uniq: string[] = [];
  const seen = new Set<string>();
  for (const c of merged) {
    if (!seen.has(c)) {
      seen.add(c);
      uniq.push(c);
    }
  }
  return uniq;
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

function parseSnmpTimeTicksSeconds(value: unknown, multiplier = 0.01): number {
  const rawText = String(value ?? "").trim();
  const rawNumber = typeof value === "number"
    ? value
    : Number(rawText.match(/\((\d+)\)/)?.[1] ?? rawText.replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(rawNumber) || rawNumber <= 0) return 0;
  return Math.max(0, Math.floor(rawNumber * multiplier));
}

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
  return (async () => {
    const communities = await snmpCommunities();
    return await new Promise<SnmpProbe>((resolve) => {
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
            uptimeSeconds ||= parseSnmpTimeTicksSeconds(await readOne(profile.oid), profile.multiplier);
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
          uptimeSeconds ||= parseSnmpTimeTicksSeconds(varbinds[3 + i]?.value, profile.multiplier);
        });
        return resolve({ ok: true, sysName, sysDescr, sysObjectId, uptimeSeconds });
      });
    };
    tryNext();
  });
  })();
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
  return (async () => {
    const communities = await snmpCommunities();
    return await new Promise<Record<string, number | string>>((resolve) => {
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
  })();
}

function snmpWalk(host: string, baseOid: string, timeout = snmpConfig.timeoutMs): Promise<Record<string, string>> {
  return (async () => {
    const communities = await snmpCommunities();
    return await new Promise<Record<string, string>>((resolve) => {
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
  })();
}

function normalizeMac(raw: string): string {
  const hex = String(raw || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length !== 12) return "";
  return hex.match(/.{1,2}/g)?.join(":") || "";
}

function normalizeMacLoose(raw: string): string {
  return String(raw || "").toLowerCase().replace(/[^0-9a-f]/g, "");
}

function normalizeOuiPrefix(raw: string): string {
  const hex = normalizeMacLoose(raw);
  if (hex.length < 6 || hex.length > 12 || hex.length % 2 !== 0) return "";
  return hex;
}

function normalizeOuiPrefixList(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : String(raw || "").split(/[\s,;]+/);
  return Array.from(
    new Set(
      values
        .map((value) => normalizeOuiPrefix(String(value)))
        .filter(Boolean)
    )
  );
}

function formatOuiPrefix(prefix: string): string {
  const hex = normalizeOuiPrefix(prefix);
  return hex ? hex.match(/.{1,2}/g)?.join(":") || hex : "";
}

type VoiceOuiEntry = { ouiAddress: string; mask: string; description: string };
type NormalizedVoiceOuiEntry = {
  ouiAddressHex: string;
  maskHex: string;
  description: string;
  ouiAddressDisplay: string;
  maskDisplay: string;
};

function hexToColonHex(hex: string): string {
  const normalized = String(hex || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (!normalized || normalized.length % 2 !== 0) return "";
  return normalized.match(/.{1,2}/g)?.join(":") || "";
}

function normalizeOuiAddressHex12(raw: string): string {
  const hex = normalizeMacLoose(raw);
  if (!hex || hex.length > 12 || hex.length % 2 !== 0) return "";
  return hex.padEnd(12, "0");
}

function normalizeOuiMaskHex12(raw: string, fallbackLengthBytes = 0): string {
  const hex = normalizeMacLoose(raw);
  if (hex && hex.length <= 12 && hex.length % 2 === 0) return hex.padEnd(12, "0");
  if (fallbackLengthBytes <= 0 || fallbackLengthBytes > 6) return "";
  return `${"ff".repeat(fallbackLengthBytes)}${"00".repeat(6 - fallbackLengthBytes)}`;
}

function normalizeVoiceOuiEntry(raw: unknown): NormalizedVoiceOuiEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as { ouiAddress?: unknown; mask?: unknown; description?: unknown };
  const rawOui = String(source.ouiAddress || "").trim();
  const rawMask = String(source.mask || "").trim();
  const rawDescription = String(source.description || "").trim();
  const ouiHex = normalizeOuiAddressHex12(rawOui);
  const ouiBytes = normalizeMacLoose(rawOui).length / 2;
  const maskHex = normalizeOuiMaskHex12(rawMask, Number.isFinite(ouiBytes) ? ouiBytes : 0);
  if (!ouiHex || !maskHex) return null;
  return {
    ouiAddressHex: ouiHex,
    maskHex,
    description: rawDescription,
    ouiAddressDisplay: hexToColonHex(ouiHex),
    maskDisplay: hexToColonHex(maskHex),
  };
}

function normalizeVoiceOuiEntries(raw: unknown): VoiceOuiEntry[] {
  if (!Array.isArray(raw)) return [];
  const unique = new Map<string, VoiceOuiEntry>();
  raw.forEach((item) => {
    const normalized = normalizeVoiceOuiEntry(item);
    if (!normalized) return;
    const key = `${normalized.ouiAddressHex}|${normalized.maskHex}|${normalized.description.toLowerCase()}`;
    if (unique.has(key)) return;
    unique.set(key, {
      ouiAddress: normalized.ouiAddressDisplay,
      mask: normalized.maskDisplay,
      description: normalized.description,
    });
  });
  return Array.from(unique.values());
}

function buildVoiceOuiEntriesFromPrefixes(prefixesRaw: unknown): VoiceOuiEntry[] {
  const prefixes = normalizeOuiPrefixList(prefixesRaw);
  return prefixes.map((prefix) => {
    const bytes = prefix.length / 2;
    const ouiAddressHex = prefix.padEnd(12, "0");
    const maskHex = `${"ff".repeat(bytes)}${"00".repeat(6 - bytes)}`;
    return {
      ouiAddress: hexToColonHex(ouiAddressHex),
      mask: hexToColonHex(maskHex),
      description: "",
    };
  });
}

function getNormalizedVoiceOuiEntries(macSearch = snmpConfig.macSearch): NormalizedVoiceOuiEntry[] {
  const explicitEntries = normalizeVoiceOuiEntries(macSearch?.voiceOuiEntries).map((entry) => normalizeVoiceOuiEntry(entry)).filter(Boolean) as NormalizedVoiceOuiEntry[];
  const compatEntries = buildVoiceOuiEntriesFromPrefixes(macSearch?.voiceOuiPrefixes).map((entry) => normalizeVoiceOuiEntry(entry)).filter(Boolean) as NormalizedVoiceOuiEntry[];
  const merged = [...explicitEntries, ...compatEntries];
  const unique = new Map<string, NormalizedVoiceOuiEntry>();
  merged.forEach((entry) => {
    const key = `${entry.ouiAddressHex}|${entry.maskHex}|${entry.description.toLowerCase()}`;
    if (!unique.has(key)) unique.set(key, entry);
  });
  return Array.from(unique.values()).sort((a, b) => b.maskHex.localeCompare(a.maskHex));
}

function isMacMatchingOuiMask(macHex: string, ouiHex: string, maskHex: string): boolean {
  const normalizedMac = normalizeMacLoose(macHex);
  if (normalizedMac.length !== 12) return false;
  if (ouiHex.length !== 12 || maskHex.length !== 12) return false;
  try {
    const macValue = BigInt(`0x${normalizedMac}`);
    const ouiValue = BigInt(`0x${ouiHex}`);
    const maskValue = BigInt(`0x${maskHex}`);
    return (macValue & maskValue) === (ouiValue & maskValue);
  } catch {
    return false;
  }
}

function findMatchedOui(mac: string): { matchedOuiAddress: string; matchedMask: string; matchedDescription?: string; matchedOui: string } | undefined {
  const normalizedMac = normalizeMacLoose(mac);
  if (!normalizedMac) return undefined;
  const match = getNormalizedVoiceOuiEntries()
    .find((entry) => isMacMatchingOuiMask(normalizedMac, entry.ouiAddressHex, entry.maskHex));
  if (!match) return undefined;
  return {
    matchedOuiAddress: match.ouiAddressDisplay,
    matchedMask: match.maskDisplay,
    matchedDescription: match.description || undefined,
    matchedOui: match.ouiAddressDisplay,
  };
}

function macFromOidSuffix(suffix: string): string {
  const parts = String(suffix || "")
    .split(".")
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 255);
  if (parts.length < 6) return "";
  const macParts = parts.slice(parts.length - 6).map((n) => n.toString(16).padStart(2, "0"));
  return normalizeMac(macParts.join(""));
}

function parseQBridgeSuffix(suffix: string): { vlan?: number; mac: string } {
  const parts = String(suffix || "")
    .split(".")
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n));
  if (parts.length < 7) return { mac: "" };
  const vlan = parts[0];
  const mac = normalizeMac(parts.slice(parts.length - 6).map((n) => n.toString(16).padStart(2, "0")).join(""));
  return { vlan: Number.isFinite(vlan) ? vlan : undefined, mac };
}

async function collectVoiceVlanMap(host: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const voiceOid = String(snmpConfig.macSearch?.voiceVlanMacOid || "").trim();
  if (!voiceOid) return out;
  try {
    const walked = await snmpWalk(host, voiceOid);
    Object.entries(walked).forEach(([suffix, value]) => {
      const vlan = Number(value);
      if (!Number.isFinite(vlan) || vlan <= 0 || vlan > 4094) return;
      const tokens = String(suffix || "").split(".").filter(Boolean);
      const ifIndex = tokens[tokens.length - 1];
      if (!ifIndex) return;
      out[ifIndex] = vlan;
    });
  } catch {
    /* ignore vendor-specific failures */
  }
  return out;
}

function sanitizeFileNamePart(src: string): string {
  return String(src || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80) || "device";
}

function timestampForFile(date = new Date()): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p2(date.getMonth() + 1)}${p2(date.getDate())}-${p2(date.getHours())}${p2(date.getMinutes())}${p2(date.getSeconds())}`;
}

function parseNumericMetric(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isCpuMetricDef(def: SnmpOidDef): boolean {
  const key = String(def.key || "").toLowerCase();
  const oid = String(def.oid || "");
  return (
    key.includes("cpu") ||
    oid.startsWith("1.3.6.1.2.1.25.3.3.1.2") || // hrProcessorLoad
    oid.startsWith("1.3.6.1.4.1.9.2.1.58") || // Cisco old CPU avg 5 sec
    oid.startsWith("1.3.6.1.4.1.9.2.1.57") || // Cisco old CPU avg 1 min
    oid.startsWith("1.3.6.1.4.1.14988.1.1.3.10.0") // MikroTik CPU load
  );
}

async function resolveMetricValue(host: string, def: SnmpOidDef, scalarMap: Record<string, number | string>): Promise<number | string | null> {
  const direct = scalarMap[def.oid];
  if (direct !== undefined) {
    const numeric = parseNumericMetric(direct);
    if (numeric !== null) return numeric * (def.scale ?? 1);
    return String(direct);
  }
  // For table-like CPU OIDs (e.g., hrProcessorLoad), calculate arithmetic mean.
  if (isCpuMetricDef(def) && !String(def.oid || "").endsWith(".0")) {
    const walked = await snmpWalk(host, def.oid);
    const samples = Object.values(walked)
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n));
    if (samples.length) {
      const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
      return avg * (def.scale ?? 1);
    }
  }
  return null;
}

async function collectTrunkMetrics(host: string): Promise<TrunkMetric[]> {
  const [ifNames, ifAlias, ifDescr, ifType, ifOper, ifAdmin, ifSpeed, hcInOctets, hcOutOctets, inOctets32, outOctets32, ciscoHints, lag] = await Promise.all([
    snmpWalk(host, "1.3.6.1.2.1.31.1.1.1.1"),
    snmpWalk(host, "1.3.6.1.2.1.31.1.1.1.18"),
    snmpWalk(host, "1.3.6.1.2.1.2.2.1.2"),
    snmpWalk(host, "1.3.6.1.2.1.2.2.1.3"),
    snmpWalk(host, "1.3.6.1.2.1.2.2.1.8"),
    snmpWalk(host, "1.3.6.1.2.1.2.2.1.7"),
    snmpWalk(host, "1.3.6.1.2.1.2.2.1.5"),
    snmpWalk(host, "1.3.6.1.2.1.31.1.1.1.6"),
    snmpWalk(host, "1.3.6.1.2.1.31.1.1.1.10"),
    snmpWalk(host, "1.3.6.1.2.1.2.2.1.10"),
    snmpWalk(host, "1.3.6.1.2.1.2.2.1.16"),
    getCiscoTrunkPortHints(host),
    getLagMembership(host),
  ]);
  const now = Date.now();
  const ciscoAggHints = getCiscoAggregateHints(ciscoHints, lag);
  const indexes = Array.from(buildInterfaceIndexSet([ifAlias, ifDescr, ifNames, hcInOctets, inOctets32, ifOper, ifAdmin], new Set([...ciscoHints, ...ciscoAggHints, ...lag.aggIndexes])));
  const indexSet = new Set(indexes);
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
    const aggIndex = lag.memberToAgg.get(idx);
    if (aggIndex && indexSet.has(aggIndex)) continue;
    const alias = String(ifAlias[idx] || "").trim();
    const descr = String(ifDescr[idx] || "").trim();
    const ifName = String(ifNames[idx] || `if${idx}`).trim();
    if (!hasDescriptiveTrunkLabel(ifName, alias, descr)) continue;
    const isLag = isLikelyLagInterface(ifName, alias, descr, ifType[idx]) || lag.aggIndexes.has(idx);
    if (!isLikelyTrunkPort(ifName, alias, descr, ifType[idx]) && !isLag && !ciscoHints.has(idx) && !ciscoAggHints.has(idx)) continue;
    const desc = alias || descr || ifName;
    const in64 = parseCounter(hcInOctets[idx]);
    const out64 = parseCounter(hcOutOctets[idx]);
    const in32 = parseCounter(inOctets32[idx]);
    const out32 = parseCounter(outOctets32[idx]);
    const use64 = in64 !== null && out64 !== null;
    const inNow = use64 ? in64 : in32;
    const outNow = use64 ? out64 : out32;
    let inBps = 0;
    let outBps = 0;
    const hasCounters = inNow !== null && outNow !== null;
    if (hasCounters) {
      const bits: 32 | 64 = use64 ? 64 : 32;
      const key = `${host}:${idx}`;
      const prev = trunkCounterCache.get(key);
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
    }
    const hasCiscoTrunkHint = ciscoHints.has(idx) || ciscoAggHints.has(idx);
    const state = resolveTrunkState(idx, ifOper, ifAdmin, lag, hasCounters, hasCiscoTrunkHint);
    trunks.push({
      ifIndex: idx,
      ifName,
      description: desc,
      operStatus: state.operStatus,
      adminStatus: state.adminStatus,
      isActive: state.isActive,
      isDown: state.isDown,
      memberIfIndexes: Array.from(lag.aggToMembers.get(idx) || []),
      stateSource: state.stateSource,
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
      .on("error", (e) => reject(new Error(normalizeSshErrorForClient(e))))
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

function backupCommandsForVendor(vendor: string): string[] {
  const v = String(vendor || "").toLowerCase();
  if (v.includes("cisco")) return ["terminal length 0", "show running-config"];
  if (v.includes("hpe") || v.includes("aruba")) return ["show running-config", "display current-configuration"];
  return ["show running-config"];
}

function resolveBackupTargets(config: BackupConfig): InventoryItem[] {
  if (config.scope.mode !== "filtered") return [...inventory];
  const ids = new Set((config.scope.deviceIds || []).map((x) => String(x)));
  const vendors = new Set((config.scope.vendors || []).map((x) => String(x).toLowerCase()));
  const branches = new Set((config.scope.branches || []).map((x) => String(x).toLowerCase()));
  return inventory.filter((d) => {
    if (ids.size && !ids.has(d.id)) return false;
    if (vendors.size && !vendors.has(String(d.vendor || "").toLowerCase())) return false;
    if (branches.size && !branches.has(String(d.branch || "").toLowerCase())) return false;
    return true;
  });
}

function validateBackupRunReadiness():
  | { ok: true; targetCount: number }
  | { ok: false; status: number; error: string; remediation: string; targetCount?: number } {
  const profile = getActiveSshReadonlyProfile();
  if (!profile) {
    return {
      ok: false,
      status: 400,
      error: "SSH readonly profile is not configured for backups.",
      remediation: "Configure a temporary SSH readonly profile before running backups.",
    };
  }
  const root = String(backupConfig.networkSharePath || "").trim();
  if (!root) {
    return {
      ok: false,
      status: 400,
      error: "Backup network share path is not configured.",
      remediation: "Set a writable backup path in Automation > Backup before starting a run.",
    };
  }
  const targets = resolveBackupTargets(backupConfig);
  if (targets.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "Backup scope matched 0 devices.",
      remediation: "Adjust the backup scope or add inventory devices before starting a run.",
      targetCount: 0,
    };
  }
  return { ok: true, targetCount: targets.length };
}

async function runBackupJob(actor: string): Promise<BackupHistoryItem> {
  if (backupRunLock) {
    throw new Error("Backup job is already running");
  }
  backupRunLock = true;
  const entry: BackupHistoryItem = {
    id: `backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: new Date().toISOString(),
    status: "running",
    actor,
    summary: { total: 0, success: 0, failed: 0 },
    details: [],
  };
  backupHistory.unshift(entry);
  if (backupHistory.length > 100) backupHistory = backupHistory.slice(0, 100);
  try {
    const profile = getActiveSshReadonlyProfile();
    if (!profile) {
      throw new Error("SSH readonly profile is required for backups");
    }
    const root = String(backupConfig.networkSharePath || "").trim();
    if (!root) {
      throw new Error("Network share path is not configured");
    }
    await fs.mkdir(root, { recursive: true });
    const targets = resolveBackupTargets(backupConfig);
    entry.summary.total = targets.length;
    await forEachWithLimit(targets, 3, async (device) => {
      try {
        const output = await runSshReadonlyCommands(
          device.ip,
          profile.username,
          await sshReadonlyPassword(profile),
          profile.port,
          backupCommandsForVendor(device.vendor)
        );
        const stamp = timestampForFile();
        const fileName = `${sanitizeFileNamePart(device.name)}_${sanitizeFileNamePart(device.ip)}_${stamp}.cfg`;
        const filePath = path.join(root, fileName);
        const content = `# NetNode backup\n# device=${device.name}\n# ip=${device.ip}\n# vendor=${device.vendor}\n# timestamp=${new Date().toISOString()}\n\n${output}`;
        await fs.writeFile(filePath, content, "utf8");
        entry.details.push({
          deviceId: device.id,
          deviceName: device.name,
          ip: device.ip,
          status: "success",
          filePath,
        });
        entry.summary.success += 1;
      } catch (e) {
        entry.details.push({
          deviceId: device.id,
          deviceName: device.name,
          ip: device.ip,
          status: "failed",
          error: e instanceof Error ? e.message : String(e),
        });
        entry.summary.failed += 1;
      }
    });
    entry.status = entry.summary.failed > 0 ? "failed" : "completed";
    entry.finishedAt = new Date().toISOString();
    logAction(actor, "Backup Run", `Backup ${entry.id}: success ${entry.summary.success}, failed ${entry.summary.failed}`, "system");
    return entry;
  } catch (e) {
    entry.status = "failed";
    entry.error = e instanceof Error ? e.message : String(e);
    entry.finishedAt = new Date().toISOString();
    logAction(actor, "Backup Run Failed", entry.error, "system");
    return entry;
  } finally {
    await persistPgBackupHistory();
    backupRunLock = false;
  }
}

function parseTrunksFromSshText(text: string): TrunkMetric[] {
  const lines = text.split(/\r?\n/);
  const out: TrunkMetric[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!/(trunk|trk|lag|bridge-aggregation|port-channel|\bpo\d+\b)/i.test(line)) continue;
    const ifMatch = line.match(/(bridge-aggregation\d+|port-channel\d+|\bpo\d+\b|trunk\s*\d+|trk\d+|lag\d+)/i);
    const ifName = ifMatch ? ifMatch[1].replace(/\s+/g, "") : line.split(/\s+/)[0];
    if (isPlaceholderTrunkName(ifName)) continue;
    const isUp = /\bup\b|forward|selected|active/i.test(line) && !/\bdown\b|disabled|inactive/i.test(line);
    out.push({
      ifIndex: String(out.length + 1),
      ifName,
      description: "ssh-readonly",
      operStatus: isUp ? 1 : 2,
      adminStatus: 1,
      isActive: isUp,
      isDown: !isUp,
      stateSource: "ssh-readonly",
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
      await sshReadonlyPassword(profile),
      profile.port,
      sshCommandsForModel(item.model)
    );
    return parseTrunksFromSshText(output);
  } catch {
    return [];
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function uniqueById(items: InventoryItem[]): InventoryItem[] {
  const seen = new Set<string>();
  const out: InventoryItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function normalizeAutomationPlan(body: Partial<AutomationPlan> | undefined): AutomationPlan {
  const rawTarget = body?.target || ({ scope: "all" } as AutomationTarget);
  const rawScope = String((rawTarget as { scope?: string }).scope || "all");
  const normalizedScope: AutomationTargetScope = rawScope === "selectedIds" || rawScope === "selected" ? "selectedIds" : rawScope === "filters" || rawScope === "filter" ? "filters" : "all";
  const mode: AutomationAllowMode = body?.mode === "replace" ? "replace" : "add";
  return {
    scenario: body?.scenario === "allow-vlan-on-trunk" ? "allow-vlan-on-trunk" : "create-vlan",
    vlanId: clampNumber(body?.vlanId, 1, 4094, 1),
    vlanName: String(body?.vlanName || "").trim() || undefined,
    mode,
    target: {
      ...rawTarget,
      scope: normalizedScope,
      selectedIds: rawTarget.selectedIds || rawTarget.selectedDeviceIds || [],
      filters: rawTarget.filters || {},
      portConditions: {
        ...(rawTarget.portConditions || {}),
        isTrunk: rawTarget.portConditions?.isTrunk ?? rawTarget.portConditions?.trunkOnly ?? true,
      },
    },
    options: body?.options || {},
  };
}

async function resolveAutomationTargets(plan: AutomationPlan): Promise<Array<{ device: InventoryItem; ports: TrunkMetric[] }>> {
  const target = plan.target || { scope: "all" as const };
  let devices: InventoryItem[] = [];
  if (target.scope === "selectedIds") {
    const set = new Set((target.selectedIds || target.selectedDeviceIds || []).map((v) => String(v)));
    devices = inventory.filter((d) => set.has(d.id));
  } else if (target.scope === "filters") {
    const f = target.filters || {};
    const inList = (v: string | undefined, list?: string[]) => !list?.length || list.map((x) => String(x).toLowerCase()).includes(String(v || "").toLowerCase());
    devices = inventory.filter((d) =>
      inList(d.vendor, f.vendor) &&
      inList(d.model, f.model) &&
      inList(d.branch, f.branch) &&
      inList(d.category, f.category) &&
      inList(d.subcategory, f.subcategory)
    );
  } else {
    devices = [...inventory];
  }
  devices = uniqueById(devices);
  if (plan.scenario === "create-vlan") {
    return devices.map((device) => ({ device, ports: [] }));
  }
  const cond = target.portConditions || {};
  let re: RegExp;
  try {
    re = new RegExp(cond.ifNameRegex || ".*", "i");
  } catch {
    re = /.*/i;
  }
  const mustBeTrunk = cond.isTrunk ?? cond.trunkOnly ?? true;
  const resolved = await Promise.all(
    devices.map(async (device) => {
      const trunks = await collectTrunkMetricsWithFallback(device);
      const ports = trunks.filter((t) => {
        if (mustBeTrunk && t.operStatus <= 0) return false;
        if (!re.test(t.ifName || "")) return false;
        if (cond.operStatusUp && t.operStatus !== 1) return false;
        if (cond.descriptionContains && !String(t.description || "").toLowerCase().includes(cond.descriptionContains.toLowerCase())) return false;
        return true;
      });
      return { device, ports };
    })
  );
  return resolved.filter((x) => x.ports.length > 0);
}

function buildVendorCommands(
  vendor: string,
  scenario: AutomationScenario,
  vlanId: number,
  vlanName: string | undefined,
  port?: string,
  mode: AutomationAllowMode = "add"
): { unsupported?: boolean; warning?: string; precheck: string[]; apply: string[] } {
  const v = String(vendor || "").toLowerCase();
  if (v.includes("cisco")) {
    if (scenario === "create-vlan") {
      return { precheck: [`show vlan id ${vlanId}`], apply: ["configure terminal", `vlan ${vlanId}`, vlanName ? `name ${vlanName}` : "", "end", "write memory"].filter(Boolean) };
    }
    return {
      precheck: [`show running-config interface ${port}`],
      apply: ["configure terminal", `interface ${port}`, mode === "replace" ? `switchport trunk allowed vlan ${vlanId}` : `switchport trunk allowed vlan add ${vlanId}`, "end", "write memory"],
    };
  }
  if (v.includes("hpe") || v.includes("aruba")) {
    if (scenario === "create-vlan") {
      return { precheck: [`show vlan ${vlanId}`], apply: ["configure terminal", `vlan ${vlanId}`, vlanName ? `name ${vlanName}` : "", "exit", "write memory"].filter(Boolean) };
    }
    return {
      warning: "HPE/Aruba trunk syntax may vary by model; using safe add-style command",
      precheck: [`show running-config interface ${port}`],
      apply: ["configure terminal", `interface ${port}`, mode === "replace" ? `vlan trunk allowed ${vlanId}` : `vlan trunk allowed add ${vlanId}`, "exit", "write memory"],
    };
  }
  if (v.includes("mikrotik")) {
    if (scenario === "create-vlan") {
      return { precheck: [`/interface vlan print where vlan-id=${vlanId}`], apply: [`/interface vlan add name=vlan${vlanId} vlan-id=${vlanId} interface=bridge`] };
    }
    return {
      warning: "MikroTik fallback adds bridge vlan row; validate bridge/interface mapping",
      precheck: [`/interface bridge vlan print where vlan-ids=${vlanId}`],
      apply: [`/interface bridge vlan add vlan-ids=${vlanId} tagged=${port}`],
    };
  }
  return { unsupported: true, warning: `Vendor '${vendor}' is unsupported by automation adapter`, precheck: [], apply: [] };
}

function detectNoopFromOutput(output: string, scenario: AutomationScenario, vlanId: number, port?: string): boolean {
  const low = String(output || "").toLowerCase();
  if (scenario === "create-vlan") {
    return low.includes(` ${vlanId} `) || low.includes(`vlan${vlanId}`) || low.includes(`id ${vlanId}`);
  }
  return (!!port && low.includes(String(port).toLowerCase()) && low.includes(String(vlanId)));
}

async function runSshCommandBatch(device: InventoryItem, commands: string[], timeoutMs: number): Promise<string> {
  const profile = getActiveSshReadonlyProfile();
  if (!profile) throw new Error("SSH readonly profile is not configured");
  const pwd = await sshReadonlyPassword(profile);
  const timeout = new Promise<string>((_r, reject) => setTimeout(() => reject(new Error("SSH command timeout")), timeoutMs));
  return Promise.race([
    runSshReadonlyCommands(device.ip, profile.username, pwd, profile.port, commands),
    timeout,
  ]);
}

async function executeAutomationStep(job: AutomationJob, step: AutomationStepResult, retryLimit: number): Promise<void> {
  const device = inventory.find((d) => d.id === step.deviceId);
  if (!device) {
    step.status = "error";
    step.message = "Device not found";
    step.updatedAt = new Date().toISOString();
    return;
  }
  const cmds = buildVendorCommands(device.vendor, step.scenario, job.plan.vlanId, job.plan.vlanName, step.port, job.plan.mode || "add");
  if (cmds.unsupported) {
    step.status = "unsupported";
    step.message = cmds.warning || `Unsupported vendor: ${device.vendor}`;
    step.updatedAt = new Date().toISOString();
    return;
  }
  step.commandPreview = cmds.apply;
  let attempt = 0;
  while (attempt <= retryLimit) {
    try {
      const pre = await runSshCommandBatch(device, cmds.precheck, job.meta.timeoutMs);
      if (detectNoopFromOutput(pre, step.scenario, job.plan.vlanId, step.port)) {
        step.status = "noop";
        step.message = "Already configured (idempotent no-op)";
        step.commandResult = pre;
        step.updatedAt = new Date().toISOString();
        return;
      }
      const out = await runSshCommandBatch(device, cmds.apply, job.meta.timeoutMs);
      step.status = "applied";
      step.message = cmds.warning ? `Commands applied (${cmds.warning})` : "Commands applied";
      step.commandResult = out;
      step.updatedAt = new Date().toISOString();
      return;
    } catch (e) {
      attempt += 1;
      step.retries = attempt;
      if (attempt > retryLimit) {
        step.status = "error";
        step.message = e instanceof Error ? e.message : String(e);
        step.updatedAt = new Date().toISOString();
        return;
      }
    }
  }
}

async function inferTopologyLinksFromTrunkDescriptions(branch?: string): Promise<TopologyLink[]> {
  const branchFilter = String(branch || "").trim();
  const devices = branchFilter
    ? inventory.filter((item) => String(item.branch || "").trim() === branchFilter)
    : inventory;
  if (devices.length < 2) {
    lastTopologyTrunkDiagnostics = {
      generatedAt: new Date().toISOString(),
      branch: branchFilter || null,
      devices: devices.length,
      candidates: [],
      summary: { notEnoughDevices: 1 },
    };
    return [];
  }

  const byId = new Map(devices.map((d) => [d.id, d]));
  type DirectedTopologyCandidate = { source: string; target: string; portA: string; raw: string; isFc?: boolean; isLag?: boolean; sourceRank?: number };
  const directed: DirectedTopologyCandidate[] = [];
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
  const normalizeIfNameHint = (v: string) =>
    String(v || "")
      .trim()
      .toLowerCase()
      .replace(/[\s_\-]+/g, "")
      .replace(/portchannel/g, "po")
      .replace(/bundleether/g, "be")
      .replace(/hundredgigabitethernet/g, "hu")
      .replace(/fortygigabitethernet/g, "fo")
      .replace(/tengigabitethernet/g, "te")
      .replace(/gigabitethernet/g, "gi")
      .replace(/fastethernet/g, "fa")
      .replace(/ethernet/g, "eth");
  const shouldUseTopologyPort = (ifIndex: string, ifOperMap: Record<string, string>, ifAdminMap: Record<string, string>, lag: LagMembership) => {
    if (!ifIndex || (ifOperMap[ifIndex] === undefined && ifAdminMap[ifIndex] === undefined)) return true;
    const state = resolveTrunkState(ifIndex, ifOperMap, ifAdminMap, lag);
    return !state.isDown;
  };
  const findIfIndexByNameHint = (hint: string, maps: Array<Record<string, string>>) => {
    const wanted = normalizeIfNameHint(hint);
    if (!wanted) return "";
    for (const map of maps) {
      const matched = Object.entries(map).find(([, value]) => normalizeIfNameHint(value) === wanted);
      if (matched) return matched[0];
    }
    return "";
  };
  const resolveLogicalPort = (
    ifIndex: string,
    ifNameMap: Record<string, string>,
    ifAliasMap: Record<string, string>,
    ifDescrMap: Record<string, string>,
    ifTypeMap: Record<string, string>,
    lag: LagMembership
  ) => {
    const logicalIndex = lag.memberToAgg.get(ifIndex) || ifIndex;
    const rawName = String(ifNameMap[ifIndex] || `if${ifIndex}`).trim();
    const rawAlias = String(ifAliasMap[ifIndex] || "").trim();
    const rawDescr = String(ifDescrMap[ifIndex] || "").trim();
    const logicalName = String(ifNameMap[logicalIndex] || (logicalIndex === ifIndex ? rawName : `if${logicalIndex}`)).trim();
    const logicalAlias = String(ifAliasMap[logicalIndex] || "").trim();
    const logicalDescr = String(ifDescrMap[logicalIndex] || "").trim();
    const alias = logicalAlias || rawAlias;
    const descr = logicalDescr || rawDescr;
    const isLag =
      logicalIndex !== ifIndex ||
      lag.aggIndexes.has(logicalIndex) ||
      isLikelyLagInterface(logicalName, alias, descr, ifTypeMap[logicalIndex] || ifTypeMap[ifIndex]);
    return { ifIndex: logicalIndex, ifName: logicalName || rawName, alias, descr, rawName, rawAlias, rawDescr, isLag };
  };
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
  const diagnostics: TopologyTrunkDiagnostic[] = [];
  const diagnosticSeen = new Set<string>();
  const isNetworkPeer = (peer?: InventoryItem) => Boolean(peer && !isFcSwitch(peer) && !isLikelyHostInventoryItem(peer));
  const summarizeDiagnostics = () =>
    diagnostics.reduce<Record<string, number>>((acc, d) => {
      const key = d.isTrunk ? `trunk:${d.reason}` : `notTrunk:${d.reason}`;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
  const evaluateTopologyPort = (
    dev: InventoryItem,
    port: ReturnType<typeof resolveLogicalPort>,
    sourceIfIndex: string,
    maps: {
      ifTypeMap: Record<string, string>;
      ifOperMap: Record<string, string>;
      ifAdminMap: Record<string, string>;
      ciscoHints: Set<string>;
      ciscoAggHints: Set<string>;
      lag: LagMembership;
    },
    context: {
      candidateSource: string;
      peer?: InventoryItem;
      lldpPeerName?: string;
      lldpPeerPresent?: boolean;
      cdpPeerName?: string;
      cdpPeerPresent?: boolean;
    }
  ) => {
    const memberIfIndexes = Array.from(maps.lag.aggToMembers.get(port.ifIndex) || []);
    const activeMembers = memberIfIndexes.filter(
      (member) => Number(maps.ifOperMap[member] || 0) === 1 && Number(maps.ifAdminMap[member] || 1) !== 2
    );
    const hasCiscoTrunkHint = maps.ciscoHints.has(sourceIfIndex) || maps.ciscoHints.has(port.ifIndex) || maps.ciscoAggHints.has(port.ifIndex);
    const state = resolveTrunkState(port.ifIndex, maps.ifOperMap, maps.ifAdminMap, maps.lag, false, hasCiscoTrunkHint);
    const peerNetworkDevice = isNetworkPeer(context.peer);
    const decision = decideTopologyTrunkCandidate({
      ifName: port.ifName,
      alias: port.alias,
      descr: port.descr,
      rawName: port.rawName,
      rawAlias: port.rawAlias,
      rawDescr: port.rawDescr,
      ifType: maps.ifTypeMap[port.ifIndex] || maps.ifTypeMap[sourceIfIndex],
      isLag: port.isLag,
      state,
      lagMembersUp: activeMembers.length > 0,
      lldpPeerPresent: context.lldpPeerPresent,
      lldpPeerInventoryMatch: Boolean(context.lldpPeerName && context.peer),
      lldpPeerNetworkDevice: Boolean(context.lldpPeerName && peerNetworkDevice),
      cdpPeerName: context.cdpPeerName,
      cdpPeerPresent: context.cdpPeerPresent,
      cdpPeerInventoryMatch: Boolean(context.cdpPeerName && context.peer),
      cdpPeerNetworkDevice: Boolean(context.cdpPeerName && peerNetworkDevice),
      peerNetworkDevice,
      ciscoVtpHint: maps.ciscoHints.has(sourceIfIndex) || maps.ciscoHints.has(port.ifIndex),
      ciscoAggHint: maps.ciscoAggHints.has(port.ifIndex),
    });
    const diagnosticKey = `${dev.id}:${port.ifIndex}:${context.candidateSource}:${context.lldpPeerName || context.cdpPeerName || ""}`;
    if (!diagnosticSeen.has(diagnosticKey)) {
      diagnosticSeen.add(diagnosticKey);
      diagnostics.push({
        deviceId: dev.id,
        deviceName: dev.name,
        deviceIp: dev.ip,
        ifIndex: port.ifIndex,
        ifName: port.ifName,
        rawIfName: port.rawName,
        candidateSource: context.candidateSource,
        isTrunk: decision.isTrunk,
        reason: decision.reason,
        flags: decision.flags,
        operStatus: state.operStatus,
        adminStatus: state.adminStatus,
        stateSource: state.stateSource,
        memberIfIndexes,
        lldpPeerName: context.lldpPeerName,
        cdpPeerName: context.cdpPeerName,
        matchedPeerId: context.peer?.id,
        matchedPeerName: context.peer?.name,
      });
    }
    return decision;
  };

  await forEachWithLimit(genericDevices, 12, async (dev) => {
    try {
      const [ifNameMap, ifAliasMap, ifDescrMap, ifTypeMap, ifOperMap, ifAdminMap, ciscoHints, lag] = await Promise.all([
        snmpWalk(dev.ip, "1.3.6.1.2.1.31.1.1.1.1"), // ifName
        snmpWalk(dev.ip, "1.3.6.1.2.1.31.1.1.1.18"), // ifAlias/Description
        snmpWalk(dev.ip, "1.3.6.1.2.1.2.2.1.2"), // ifDescr (fallback for old gear)
        snmpWalk(dev.ip, "1.3.6.1.2.1.2.2.1.3"), // ifType
        snmpWalk(dev.ip, "1.3.6.1.2.1.2.2.1.8"), // ifOperStatus
        snmpWalk(dev.ip, "1.3.6.1.2.1.2.2.1.7"), // ifAdminStatus
        getCiscoTrunkPortHints(dev.ip),
        getLagMembership(dev.ip),
      ]);
      const ciscoAggHints = getCiscoAggregateHints(ciscoHints, lag);
      const indexes = buildInterfaceIndexSet([ifAliasMap, ifDescrMap, ifNameMap], new Set([...ciscoHints, ...ciscoAggHints, ...lag.aggIndexes]));
      for (const ifIndex of indexes) {
        const port = resolveLogicalPort(ifIndex, ifNameMap, ifAliasMap, ifDescrMap, ifTypeMap, lag);
        const { alias, descr, ifName } = port;
        const trunkHint = `${alias} ${descr} ${port.rawAlias} ${port.rawDescr}`.trim();
        const aliasNorm = norm(trunkHint);
        const peer = findDeviceByNameHint(aliasNorm, dev.id);
        const candidateLike =
          port.isLag ||
          isLikelyTrunkPort(port.rawName, port.rawAlias, port.rawDescr, ifTypeMap[ifIndex]) ||
          isLikelyTrunkPort(ifName, alias, descr, ifTypeMap[port.ifIndex] || ifTypeMap[ifIndex]) ||
          ciscoHints.has(ifIndex) ||
          ciscoHints.has(port.ifIndex) ||
          ciscoAggHints.has(port.ifIndex) ||
          Boolean(peer);
        if (!candidateLike) continue;
        const decision = evaluateTopologyPort(
          dev,
          port,
          ifIndex,
          { ifTypeMap, ifOperMap, ifAdminMap, ciscoHints, ciscoAggHints, lag },
          { candidateSource: "description", peer }
        );
        if (!decision.isTrunk) continue;
        if (!shouldUseTopologyPort(port.ifIndex, ifOperMap, ifAdminMap, lag)) continue;
        if (!peer) continue;
        directed.push({ source: dev.id, target: peer.id, portA: ifName, raw: trunkHint, isLag: port.isLag, sourceRank: 90 });
      }
    } catch {
      // Skip device-level parsing errors, keep building topology from others.
    }
  });

  // Fallback path: LLDP neighbor correlation for trunk-like local ports.
  await forEachWithLimit(genericDevices, 10, async (dev) => {
    try {
      const [ifNameMap, ifAliasMap, ifDescrMap, ifTypeMap, ifOperMap, ifAdminMap, basePortIfIndex, lldpLocPortId, lldpRemSysName, ciscoHints, lag] = await Promise.all([
        snmpWalk(dev.ip, "1.3.6.1.2.1.31.1.1.1.1"), // ifName
        snmpWalk(dev.ip, "1.3.6.1.2.1.31.1.1.1.18"), // ifAlias
        snmpWalk(dev.ip, "1.3.6.1.2.1.2.2.1.2"), // ifDescr
        snmpWalk(dev.ip, "1.3.6.1.2.1.2.2.1.3"), // ifType
        snmpWalk(dev.ip, "1.3.6.1.2.1.2.2.1.8"), // ifOperStatus
        snmpWalk(dev.ip, "1.3.6.1.2.1.2.2.1.7"), // ifAdminStatus
        snmpWalk(dev.ip, "1.3.6.1.2.1.17.1.4.1.2"), // dot1dBasePortIfIndex
        snmpWalk(dev.ip, "1.0.8802.1.1.2.1.3.7.1.3"), // lldpLocPortId
        snmpWalk(dev.ip, "1.0.8802.1.1.2.1.4.1.1.9"), // lldpRemSysName
        getCiscoTrunkPortHints(dev.ip),
        getLagMembership(dev.ip),
      ]);

      const ciscoAggHints = getCiscoAggregateHints(ciscoHints, lag);
      const allIf = buildInterfaceIndexSet([ifNameMap, ifAliasMap, ifDescrMap], new Set([...ciscoHints, ...ciscoAggHints, ...lag.aggIndexes]));

      for (const [suffix, sysNameRaw] of Object.entries(lldpRemSysName)) {
        const sysName = String(sysNameRaw || "").trim();
        if (!sysName) continue;
        const parts = suffix.split(".").filter(Boolean);
        if (parts.length < 3) continue;
        const localPortNum = parts[1];
        const ifIndexFromBridge = String(basePortIfIndex[localPortNum] || "").trim();
        let ifIndex = ifIndexFromBridge || "";
        let localIfName = "";
        if (!ifIndex) {
          const localPortId = String(lldpLocPortId[localPortNum] || "").trim().toLowerCase();
          if (localPortId) {
            ifIndex = findIfIndexByNameHint(localPortId, [ifNameMap, ifDescrMap, ifAliasMap]);
          }
        }
        const aggregateIfIndex = ifIndex ? lag.memberToAgg.get(ifIndex) : undefined;
        if (aggregateIfIndex && allIf.has(aggregateIfIndex)) ifIndex = aggregateIfIndex;
        if (ifIndex) {
          localIfName = String(ifNameMap[ifIndex] || `if${ifIndex}`).trim();
        }
        if (!localIfName) continue;
        const peer = findDeviceByNameHint(sysName, dev.id);
        const port = resolveLogicalPort(ifIndex, ifNameMap, ifAliasMap, ifDescrMap, ifTypeMap, lag);
        const decision = evaluateTopologyPort(
          dev,
          port,
          ifIndex,
          { ifTypeMap, ifOperMap, ifAdminMap, ciscoHints, ciscoAggHints, lag },
          { candidateSource: "lldp", peer, lldpPeerName: sysName, lldpPeerPresent: true }
        );
        if (!decision.isTrunk) continue;
        if (ifIndex && !shouldUseTopologyPort(ifIndex, ifOperMap, ifAdminMap, lag)) continue;
        if (!peer) continue;
        directed.push({ source: dev.id, target: peer.id, portA: port.ifName || localIfName, raw: `LLDP:${sysName}`, isLag: port.isLag || !!aggregateIfIndex || lag.aggIndexes.has(ifIndex), sourceRank: 70 });
      }
    } catch {
      // Skip device-level LLDP errors and continue.
    }
  });

  // Cisco fallback: CDP is often enabled when LLDP is disabled. The cdpCache table is
  // indexed by local ifIndex, so member links can be lifted to their logical Po.
  await forEachWithLimit(genericDevices, 10, async (dev) => {
    try {
      const [ifNameMap, ifAliasMap, ifDescrMap, ifTypeMap, ifOperMap, ifAdminMap, cdpNeighbors, ciscoHints, lag] = await Promise.all([
        snmpWalk(dev.ip, "1.3.6.1.2.1.31.1.1.1.1"), // ifName
        snmpWalk(dev.ip, "1.3.6.1.2.1.31.1.1.1.18"), // ifAlias
        snmpWalk(dev.ip, "1.3.6.1.2.1.2.2.1.2"), // ifDescr
        snmpWalk(dev.ip, "1.3.6.1.2.1.2.2.1.3"), // ifType
        snmpWalk(dev.ip, "1.3.6.1.2.1.2.2.1.8"), // ifOperStatus
        snmpWalk(dev.ip, "1.3.6.1.2.1.2.2.1.7"), // ifAdminStatus
        getCiscoCdpNeighbors(dev.ip),
        getCiscoTrunkPortHints(dev.ip),
        getLagMembership(dev.ip),
      ]);
      const ciscoAggHints = getCiscoAggregateHints(ciscoHints, lag);
      const allIf = buildInterfaceIndexSet([ifNameMap, ifAliasMap, ifDescrMap], new Set([...ciscoHints, ...ciscoAggHints, ...lag.aggIndexes]));

      for (const neighbor of cdpNeighbors) {
        let ifIndex = neighbor.localIfIndex;
        const aggregateIfIndex = lag.memberToAgg.get(ifIndex);
        if (aggregateIfIndex && allIf.has(aggregateIfIndex)) ifIndex = aggregateIfIndex;
        const port = resolveLogicalPort(ifIndex, ifNameMap, ifAliasMap, ifDescrMap, ifTypeMap, lag);
        const peer = findDeviceByNameHint(`${neighbor.peerName} ${neighbor.platform}`.trim(), dev.id);
        const decision = evaluateTopologyPort(
          dev,
          port,
          neighbor.localIfIndex,
          { ifTypeMap, ifOperMap, ifAdminMap, ciscoHints, ciscoAggHints, lag },
          { candidateSource: "cdp", peer, cdpPeerName: neighbor.peerName, cdpPeerPresent: true }
        );
        if (!decision.isTrunk) continue;
        if (!shouldUseTopologyPort(port.ifIndex, ifOperMap, ifAdminMap, lag)) continue;
        if (!peer) continue;
        directed.push({
          source: dev.id,
          target: peer.id,
          portA: port.ifName || String(ifNameMap[ifIndex] || `if${ifIndex}`).trim(),
          raw: `CDP:${neighbor.peerName}${neighbor.peerPort ? `:${neighbor.peerPort}` : ""}`,
          isLag: port.isLag || !!aggregateIfIndex || lag.aggIndexes.has(ifIndex),
          sourceRank: 85,
        });
      }
    } catch {
      // Skip device-level CDP errors and keep LLDP/comment fallbacks available.
    }
  });

  // Generic fallback: infer links from interface comments/aliases that mention peer devices.
  // Useful for MikroTik and other platforms where trunk keywords are absent but comments are present.
  await forEachWithLimit(genericDevices, 12, async (dev) => {
    try {
      const [ifNameMap, ifAliasMap, ifDescrMap, ifTypeMap, ifOperMap, ifAdminMap, ciscoHints, lag] = await Promise.all([
        snmpWalk(dev.ip, "1.3.6.1.2.1.31.1.1.1.1"), // ifName
        snmpWalk(dev.ip, "1.3.6.1.2.1.31.1.1.1.18"), // ifAlias / comment
        snmpWalk(dev.ip, "1.3.6.1.2.1.2.2.1.2"), // ifDescr
        snmpWalk(dev.ip, "1.3.6.1.2.1.2.2.1.3"), // ifType
        snmpWalk(dev.ip, "1.3.6.1.2.1.2.2.1.8"), // ifOperStatus
        snmpWalk(dev.ip, "1.3.6.1.2.1.2.2.1.7"), // ifAdminStatus
        getCiscoTrunkPortHints(dev.ip),
        getLagMembership(dev.ip),
      ]);
      const ciscoAggHints = getCiscoAggregateHints(ciscoHints, lag);
      const indexes = buildInterfaceIndexSet([ifNameMap, ifAliasMap, ifDescrMap], new Set([...ciscoHints, ...ciscoAggHints, ...lag.aggIndexes]));
      for (const ifIndex of indexes) {
        const port = resolveLogicalPort(ifIndex, ifNameMap, ifAliasMap, ifDescrMap, ifTypeMap, lag);
        const { ifName, alias, descr } = port;
        const hintRaw = `${alias} ${descr} ${port.rawAlias} ${port.rawDescr}`.trim();
        if (!hintRaw || hintRaw.length < 3) continue;
        const peer = findDeviceByNameHint(hintRaw, dev.id);
        const decision = evaluateTopologyPort(
          dev,
          port,
          ifIndex,
          { ifTypeMap, ifOperMap, ifAdminMap, ciscoHints, ciscoAggHints, lag },
          { candidateSource: "comment", peer }
        );
        if (!decision.isTrunk) continue;
        if (!shouldUseTopologyPort(port.ifIndex, ifOperMap, ifAdminMap, lag)) continue;
        if (!peer || isFcSwitch(peer)) continue;
        directed.push({ source: dev.id, target: peer.id, portA: ifName || `if${ifIndex}`, raw: `IF-COMMENT:${hintRaw}`, isLag: port.isLag, sourceRank: 30 });
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
          directed.push({ source: dev.id, target: peer.id, portA: localIfName || "fc-port", raw: `FC-LLDP:${sysName}`, isFc: true, sourceRank: 80 });
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
        directed.push({ source: dev.id, target: peer.id, portA: ifName || "fc-port", raw: `FC-ALIAS:${alias || descr}`, isFc: true, sourceRank: 50 });
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
          directed.push({ source: core.id, target: edge.id, portA: corePort, raw: "FC-SYNTHETIC", isFc: true, sourceRank: 10 });
          directed.push({ source: edge.id, target: core.id, portA: edgePort, raw: "FC-SYNTHETIC", isFc: true, sourceRank: 10 });
          existingFcPair.add(pairKey);
          break;
        }
      }
    }
  }

  const pairKeyOf = (d: { source: string; target: string }) => [d.source, d.target].sort().join("::");
  const candidateScore = (d: DirectedTopologyCandidate) => {
    const raw = String(d.raw || "").toUpperCase();
    const lagScore = d.isLag || isLikelyLagInterface(d.portA, "", d.raw) ? 1000 : 0;
    const sourceScore = d.sourceRank ?? (raw.startsWith("LLDP:") ? 70 : raw.startsWith("IF-COMMENT:") ? 30 : 0);
    return lagScore + sourceScore;
  };
  const sortedDirected = [...directed].sort((a, b) => {
    const score = candidateScore(b) - candidateScore(a);
    if (score !== 0) return score;
    const pair = pairKeyOf(a).localeCompare(pairKeyOf(b));
    if (pair !== 0) return pair;
    const pa = String(a.portA || "");
    const pb = String(b.portA || "");
    return pa.localeCompare(pb);
  });
  const directedEdgeBest = new Map<string, DirectedTopologyCandidate>();
  for (const d of sortedDirected) {
    const dk = `${d.source}::${d.target}`;
    if (!directedEdgeBest.has(dk)) directedEdgeBest.set(dk, d);
  }
  const used = new Set<string>();
  const out: TopologyLink[] = [];
  for (const d of sortedDirected) {
    const pairKey = pairKeyOf(d);
    const sourceDevice = byId.get(d.source);
    const targetDevice = byId.get(d.target);
    if (!sourceDevice || !targetDevice) continue;
    const isFcPair = d.isFc || (isFcSwitch(sourceDevice) && isFcSwitch(targetDevice));
    const reverse = directedEdgeBest.get(`${d.target}::${d.source}`);
    const portAForKey = d.source <= d.target ? d.portA : reverse?.portA || "";
    const portBForKey = d.source <= d.target ? reverse?.portA || "" : d.portA;
    // IP topology is intentionally one logical edge per pair; FC mode can keep real parallel port links.
    const key = isFcPair ? `${pairKey}::${portAForKey}::${portBForKey}` : pairKey;
    if (used.has(key)) continue;
    const portA = d.portA;
    const portB = reverse?.portA || (reverse ? reverse.raw : "Trunk");
    out.push({ source: d.source, target: d.target, portA, portB });
    used.add(key);
  }
  lastTopologyTrunkDiagnostics = {
    generatedAt: new Date().toISOString(),
    branch: branchFilter || null,
    devices: genericDevices.length,
    candidates: diagnostics.sort((a, b) =>
      `${a.deviceName}:${a.ifName}:${a.candidateSource}:${a.lldpPeerName || a.cdpPeerName || ""}`.localeCompare(
        `${b.deviceName}:${b.ifName}:${b.candidateSource}:${b.lldpPeerName || b.cdpPeerName || ""}`
      )
    ),
    summary: summarizeDiagnostics(),
  };
  return out;
}

function rebuildTopologyFromInventory() {
  const existing = new Set(inventory.map((i) => i.id));
  topologyLinks = topologyLinks
    .filter((l) => existing.has(l.source) && existing.has(l.target))
    .map((l) => ensureTopologyLinkId(l));
}

function testLdapServiceBind(profile: LdapRoleProfile): Promise<{ ok: boolean; message: string }> {
  return (async () => {
    let bindSecret: string;
    try {
      bindSecret = await readPasswordMaterial(profile.bindPasswordMaterial);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "Bind password unavailable" };
    }
    return await new Promise((resolve) => {
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
      client.bind(profile.bindDn, bindSecret, (bindErr: Error | null) => {
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
  })();
}

function getRequestIp(req: express.Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const forwardedFirst = Array.isArray(forwarded)
    ? forwarded[0]
    : typeof forwarded === "string"
      ? forwarded.split(",")[0]
      : "";
  const rawIp = (forwardedFirst || req.socket?.remoteAddress || req.ip || "").trim();
  if (!rawIp) return "-";
  return rawIp.startsWith("::ffff:") ? rawIp.slice(7) : rawIp;
}

const logAction = (
  user: string,
  action: string,
  details: string,
  category: AuditLog['category'],
  ipAddress?: string
) => {
  const log: AuditLog = {
    id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
    timestamp: new Date().toISOString(),
    user,
    action,
    details,
    category,
    ipAddress: ipAddress || undefined
  };
  auditLogs.unshift(log); // Newest first
  if (auditLogs.length > 500) auditLogs.pop(); // Keep last 500 logs
  const suffix = ipAddress ? ` [ip=${ipAddress}]` : "";
  console.log(`[Audit] [${category.toUpperCase()}] ${user}: ${action} - ${details}${suffix}`);
  if (pgPool) {
    void pgAppendAuditLog(pgPool, {
      id: log.id,
      timestamp: log.timestamp,
      user: log.user,
      action: log.action,
      details: log.details,
      category: log.category,
      ipAddress: log.ipAddress,
    }).catch((err) => console.error("[db] audit insert failed:", err instanceof Error ? err.message : err));
  }
  void publishAmqpJson(`audit.${log.category}`, {
    id: log.id,
    user: log.user,
    action: log.action,
    category: log.category,
  }).catch(() => {});
};

function authFromRequest(req: express.Request): AuthUser | null {
  return readSession(req).user;
}

function actorName(req: express.Request): string {
  return authFromRequest(req)?.username || "unknown";
}

function actorRole(req: express.Request): string {
  return authFromRequest(req)?.role || "viewer";
}

function buildTopologyDoc() {
  return {
    links: topologyLinks,
    layout: topologyLayout,
    layoutScopes: topologyLayoutScopes,
    zoneLabelOverridesScopes: topologyZoneLabelOverridesScopes,
    snapshots: topologySnapshots,
  };
}

function applyPgKv(key: string, value: unknown) {
  if (value === undefined || value === null) return;
  try {
    switch (key) {
      case APP_KV_KEYS.topology: {
        const doc = value as {
          links?: TopologyLink[];
          layout?: TopologyLayout;
          layoutScopes?: Record<TopologyMode, Record<string, TopologyLayout>>;
          zoneLabelOverridesScopes?: Record<TopologyMode, Record<string, TopologyZoneLabelOverrides>>;
          snapshots?: TopologySnapshot[];
        };
        if (Array.isArray(doc.links)) topologyLinks = doc.links;
        if (doc.layout && typeof doc.layout === "object") topologyLayout = doc.layout;
        if (doc.layoutScopes && typeof doc.layoutScopes === "object")
          topologyLayoutScopes = doc.layoutScopes as Record<TopologyMode, Record<string, TopologyLayout>>;
        if (doc.zoneLabelOverridesScopes && typeof doc.zoneLabelOverridesScopes === "object")
          topologyZoneLabelOverridesScopes = doc.zoneLabelOverridesScopes as Record<
            TopologyMode,
            Record<string, TopologyZoneLabelOverrides>
          >;
        if (Array.isArray(doc.snapshots)) topologySnapshots = doc.snapshots as TopologySnapshot[];
        break;
      }
      case APP_KV_KEYS.system_config:
        if (typeof value === "object") systemConfig = { ...systemConfig, ...(value as typeof systemConfig) };
        break;
      case APP_KV_KEYS.snmp_config:
        if (value && typeof value === "object") snmpConfig = hydrateSnmpFromKv(value);
        break;
      case APP_KV_KEYS.ldap_config:
        if (value && typeof value === "object" && "admin" in value && "operator" in value) {
          const v = value as { admin?: unknown; operator?: unknown };
          ldapConfig = {
            admin: hydrateLdapRole(v.admin),
            operator: hydrateLdapRole(v.operator),
          };
        }
        break;
      case APP_KV_KEYS.backup_config:
        if (typeof value === "object") backupConfig = { ...backupConfig, ...(value as typeof backupConfig) };
        break;
      case APP_KV_KEYS.backup_history:
        if (Array.isArray(value)) backupHistory = value as BackupHistoryItem[];
        break;
      case APP_KV_KEYS.discovery_profiles:
        if (Array.isArray(value) && value.length) discoveryWatchProfiles = value as DiscoveryWatchProfile[];
        break;
      case APP_KV_KEYS.snmp_templates:
        if (Array.isArray(value) && value.length) snmpTemplates = value as SnmpTemplate[];
        break;
      case APP_KV_KEYS.users:
        if (Array.isArray(value) && value.length) {
          users = value as LocalUser[];
          migratePlaintextPasswords();
        }
        break;
      case APP_KV_KEYS.inventory_meta:
        if (typeof value === "object" && value) Object.assign(inventoryMeta, value as typeof inventoryMeta);
        break;
      case APP_KV_KEYS.automation_plans:
        if (value && typeof value === "object") {
          automationPlans.clear();
          for (const [k, v] of Object.entries(value as Record<string, { id: string; createdAt: string; actor: string; plan: AutomationPlan }>)) {
            automationPlans.set(k, v);
          }
        }
        break;
      case APP_KV_KEYS.automation_jobs:
        if (value && typeof value === "object") {
          automationJobs.clear();
          for (const [k, v] of Object.entries(value as Record<string, AutomationJob>)) {
            automationJobs.set(k, v);
          }
        }
        break;
      case APP_KV_KEYS.manual_discovery_jobs:
        if (value && typeof value === "object") {
          manualDiscoveryJobs.clear();
          for (const [k, v] of Object.entries(value as Record<string, ManualDiscoveryJob>)) {
            manualDiscoveryJobs.set(k, v);
          }
        }
        break;
      case APP_KV_KEYS.discovery_watch_run_jobs:
        if (value && typeof value === "object") {
          discoveryWatchRunJobs.clear();
          for (const [k, v] of Object.entries(value as Record<string, DiscoveryWatchRunJob>)) {
            discoveryWatchRunJobs.set(k, v);
          }
        }
        break;
      default:
        break;
    }
  } catch (e) {
    console.error(`[db] hydrate key=${key} failed:`, e instanceof Error ? e.message : e);
  }
}

async function persistPgInventoryAndTopology(reason: string) {
  if (!pgPool) return;
  try {
    await persistInventoryDevices(pgPool, inventory as InventoryRowPayload[]);
    await upsertAppKvMany(pgPool, [
      { key: APP_KV_KEYS.inventory_meta, value: inventoryMeta },
      { key: APP_KV_KEYS.topology, value: buildTopologyDoc() },
    ]);
    await publishAmqpJson("inventory.persisted", { reason, deviceCount: inventory.length });
  } catch (e) {
    console.error("[db] persist inventory/topology failed:", e instanceof Error ? e.message : e);
  }
}

async function persistPgTopologyOnly(reason: string) {
  if (!pgPool) return;
  try {
    await upsertAppKv(pgPool, APP_KV_KEYS.topology, buildTopologyDoc());
    await publishAmqpJson("topology.persisted", { reason });
  } catch (e) {
    console.error("[db] persist topology failed:", e instanceof Error ? e.message : e);
  }
}

async function persistPgConfigs(reason: string) {
  if (!pgPool) return;
  try {
    await upsertAppKvMany(pgPool, [
      { key: APP_KV_KEYS.system_config, value: systemConfig },
      { key: APP_KV_KEYS.snmp_config, value: snmpConfig },
      { key: APP_KV_KEYS.ldap_config, value: ldapConfig },
      { key: APP_KV_KEYS.backup_config, value: backupConfig },
    ]);
    await publishAmqpJson("config.persisted", { reason });
  } catch (e) {
    console.error("[db] persist config bundle failed:", e instanceof Error ? e.message : e);
  }
}

async function persistPgBackupHistory() {
  if (!pgPool) return;
  try {
    await upsertAppKv(pgPool, APP_KV_KEYS.backup_history, backupHistory);
  } catch (e) {
    console.error("[db] persist backup history failed:", e instanceof Error ? e.message : e);
  }
}

async function persistPgDiscoveryProfiles(reason: string) {
  if (!pgPool) return;
  try {
    await upsertAppKv(pgPool, APP_KV_KEYS.discovery_profiles, discoveryWatchProfiles);
    await publishAmqpJson("discovery.profiles.persisted", { reason });
  } catch (e) {
    console.error("[db] persist discovery profiles failed:", e instanceof Error ? e.message : e);
  }
}

async function persistPgDiscoveryJobMaps() {
  if (!pgPool) return;
  try {
    await upsertAppKvMany(pgPool, [
      { key: APP_KV_KEYS.manual_discovery_jobs, value: Object.fromEntries(manualDiscoveryJobs) },
      { key: APP_KV_KEYS.discovery_watch_run_jobs, value: Object.fromEntries(discoveryWatchRunJobs) },
    ]);
  } catch (e) {
    console.error("[db] persist discovery job maps failed:", e instanceof Error ? e.message : e);
  }
}

async function persistPgSnmpTemplates() {
  if (!pgPool) return;
  try {
    await upsertAppKv(pgPool, APP_KV_KEYS.snmp_templates, snmpTemplates);
  } catch (e) {
    console.error("[db] persist snmp templates failed:", e instanceof Error ? e.message : e);
  }
}

async function persistPgUsers() {
  if (!pgPool) return;
  try {
    const safe = users.map(({ password, ...rest }) => {
      void password;
      return rest;
    });
    await upsertAppKv(pgPool, APP_KV_KEYS.users, safe);
  } catch (e) {
    console.error("[db] persist users failed:", e instanceof Error ? e.message : e);
  }
}

async function persistPgAutomationMaps() {
  if (!pgPool) return;
  try {
    await upsertAppKvMany(pgPool, [
      { key: APP_KV_KEYS.automation_plans, value: Object.fromEntries(automationPlans) },
      { key: APP_KV_KEYS.automation_jobs, value: Object.fromEntries(automationJobs) },
    ]);
    await publishAmqpJson("automation.state.persisted", { plans: automationPlans.size, jobs: automationJobs.size });
  } catch (e) {
    console.error("[db] persist automation maps failed:", e instanceof Error ? e.message : e);
  }
}

async function refreshInventorySnmpMetrics(): Promise<void> {
  if (!inventory.length || inventoryMetricsRunLock) return;
  inventoryMetricsRunLock = true;
  try {
    const conc = Math.max(1, Math.min(64, Number(process.env.NETNODE_INVENTORY_SNMP_CONCURRENCY) || 16));
    const next = await mapWithConcurrency(inventory, conc, async (item) => {
        const probe = await getSnmpProbe(item.ip, 900);
        if (!probe.ok) {
          const warning = evaluateInventoryWarnings({
            isReachable: false,
            cpuLoad: null,
            trunkDownCount: 0,
          });
          return {
            ...item,
            status: "offline" as const,
            warningScore: warning.score,
            warningSeverity: warning.severity,
            warningReasons: warning.reasons,
            warningReasonDetails: warning.reasonDetails,
            cpuLoad: null,
            trunkDownCount: 0,
          };
        }
        const nextVendor = probe.sysDescr ? detectVendorFromSnmp(probe.sysDescr, probe.sysObjectId || "") : item.vendor;
        const nextModel = detectModelFromSnmp(probe.sysDescr || "", probe.sysObjectId || "", probe.sysName || "") || item.model;
        const nextName = probe.sysName?.trim() ? probe.sysName.trim() : item.name;
        const nextCategory = detectCategoryFromSnmp(probe.sysDescr || "", probe.sysObjectId || "", probe.sysName || "");
        const uptimeSeconds = probe.uptimeSeconds ?? item.uptimeSeconds ?? 0;
        const template = pickTemplate(item);
        const defs = template?.metrics || [];
        let cpuLoad: number | null = null;
        try {
          if (defs.length > 0) {
            const map = await snmpGetMap(item.ip, defs.map((d) => d.oid));
            const cpuCandidates: number[] = [];
            for (const def of defs) {
              if (!isCpuMetricDef(def)) continue;
              const value = await resolveMetricValue(item.ip, def, map);
              const numeric = Number(value);
              if (Number.isFinite(numeric)) cpuCandidates.push(numeric);
            }
            if (cpuCandidates.length > 0) {
              cpuLoad = Math.round((cpuCandidates.reduce((a, b) => a + b, 0) / cpuCandidates.length) * 100) / 100;
            }
          }
        } catch {
          cpuLoad = null;
        }
        let trunkDownCount = 0;
        try {
          const trunks = await collectTrunkMetrics(item.ip);
          trunkDownCount = trunks.filter((t) => t.isDown === true).length;
        } catch {
          trunkDownCount = 0;
        }
        const warning = evaluateInventoryWarnings({
          isReachable: true,
          cpuLoad,
          trunkDownCount,
        });
        return {
          ...item,
          name: nextName,
          zoneKey: deriveZoneKeyFromDeviceName(nextName),
          vendor: nextVendor,
          model: nextModel,
          category: item.category || nextCategory,
          branch: item.branch || "ULN",
          zone: resolveDeviceZone(nextName, item.zone),
          status: warning.severity === "warning" ? ("warning" as const) : ("online" as const),
          uptimeSeconds,
          uptime: formatDuration(uptimeSeconds),
          warningScore: warning.score,
          warningSeverity: warning.severity,
          warningReasons: warning.reasons,
          warningReasonDetails: warning.reasonDetails,
          cpuLoad,
          trunkDownCount,
        };
    });
    const prev = inventory;
    let dirty = next.length !== prev.length;
    if (!dirty) {
      for (let i = 0; i < next.length; i++) {
        const a = prev[i];
        const b = next[i];
        if (
          !a ||
          !b ||
          a.id !== b.id ||
          a.status !== b.status ||
          a.warningScore !== b.warningScore ||
          a.warningSeverity !== b.warningSeverity ||
          a.cpuLoad !== b.cpuLoad ||
          a.trunkDownCount !== b.trunkDownCount ||
          a.name !== b.name
        ) {
          dirty = true;
          break;
        }
      }
    }
    inventory = next;
    if (dirty) await persistPgInventoryAndTopology("inventory-snmp-refresh");
  } catch (e) {
    console.warn("[inventory] SNMP metrics refresh failed:", e instanceof Error ? e.message : e);
  } finally {
    inventoryMetricsRunLock = false;
  }
}

async function connectAndHydratePostgres() {
  pgPool = await connectPostgres();
  if (!pgPool) return;
  await ensureSchema(pgPool);
  await hydrateFromDatabase(pgPool, {
    onInventory: (rows) => {
      inventory = rows as InventoryItem[];
    },
    onKv: (key, value) => applyPgKv(key, value),
    onAuditLogs: (logs) => {
      auditLogs = logs as AuditLog[];
    },
  });
  await sealVolatileCredentialMaterialsAfterHydrate();
}

async function reloadPersistenceAfterSetup() {
  hydrateProcessEnvFromInstanceFileSync();
  await shutdownPool(pgPool);
  pgPool = null;
  await connectAndHydratePostgres();
}

export async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  const PORT = process.env.PORT || 3000;
  const isProd = process.env.NODE_ENV === "production";

  applySecurityMiddleware(app, { isProd });
  const loginLimiter = createLoginRateLimiter();

  await connectAndHydratePostgres();
  await initSessionRuntime();

  console.log(`Starting server on port ${PORT} (NODE_ENV=${process.env.NODE_ENV})`);

  const jsonBodyLimitMb = Math.max(0.25, Math.min(5, Number(process.env.NETNODE_JSON_BODY_LIMIT_MB) || 1));
  app.use(express.json({ limit: `${jsonBodyLimitMb}mb` }));

  registerFirstRunSetupRoutes(app, { reloadPersistenceAfterSetup });
  app.use(attachNetnodeSession());
  app.use(csrfProtectionMiddleware());
  // Helper: Role Check Middleware (server-side session only)
  const checkRole = (roles: string[]) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const user = authFromRequest(req);
    if (!user) {
      return res.status(401).json({ error: "Authentication required." });
    }
    const userRole = user.role || "viewer";
    if (roles.includes(userRole)) {
      next();
    } else {
      res.status(403).json({ error: "Access Denied: Insufficient permissions." });
    }
  };

  if (discoveryScheduler) clearInterval(discoveryScheduler);
  discoveryScheduler = setInterval(() => {
    void (async () => {
      let acquired = false;
      try {
        discoverySchedulerLastTickAt = new Date().toISOString();
        const enabled = discoveryWatchProfiles.some((p) => p.enabled);
        if (!enabled) return;
        if (discoveryRunLock) return;
        discoveryRunLock = true;
        acquired = true;
        const now = Date.now();
        let processed = 0;
        const actor = "system-scheduler";
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
          await persistPgDiscoveryProfiles("scheduler-tick");
        }
      } catch {
        /* ignore scheduler errors */
      } finally {
        if (acquired) discoveryRunLock = false;
      }
    })();
  }, 60 * 1000);
  logAction("system", "Discovery Watch Scheduler Start", "Scheduler initialized (1-minute tick, per-profile interval)", "system");

  if (backupScheduler) clearInterval(backupScheduler);
  backupScheduler = setInterval(async () => {
    try {
      backupSchedulerLastTickAt = new Date().toISOString();
      if (!backupConfig.enabled) return;
      if (backupRunLock) return;
      const lastDone = backupHistory.find((x) => x.finishedAt);
      const intervalMs = Math.max(1, Number(backupConfig.intervalHours || 6)) * 60 * 60 * 1000;
      if (lastDone?.finishedAt && Date.now() - new Date(lastDone.finishedAt).getTime() < intervalMs) return;
      await runBackupJob("system-scheduler");
    } catch {
      /* ignore scheduler errors */
    }
  }, 60 * 1000);
  logAction("system", "Backup Scheduler Start", "Scheduler initialized (1-minute tick)", "system");

  const inventorySnmpIntervalMs = Math.max(
    30_000,
    Math.min(600_000, Number(process.env.NETNODE_INVENTORY_SNMP_INTERVAL_MS) || 90_000)
  );
  if (inventoryMetricsScheduler) clearInterval(inventoryMetricsScheduler);
  inventoryMetricsScheduler = setInterval(() => {
    void refreshInventorySnmpMetrics();
  }, inventorySnmpIntervalMs);
  console.log(`[inventory] SNMP metrics background refresh every ${inventorySnmpIntervalMs}ms (NETNODE_INVENTORY_SNMP_INTERVAL_MS)`);

  setInterval(() => {
    void pruneExpiredSessions().then((n) => {
      if (n > 0) console.log(`[session] pruned ${n} expired session(s)`);
    });
  }, 60_000);

  // API: Audit Logs
  app.get("/api/audit-logs", checkRole(['admin']), (req, res) => {
    res.json(auditLogs);
  });

  app.post("/api/automation/plans/dry-run", checkRole(["admin", "operator"]), async (req, res) => {
    const actor = actorName(req);
    const body = req.body as Partial<AutomationPlan>;
    const plan = normalizeAutomationPlan(body);
    const resolved = await resolveAutomationTargets(plan);
    const previewSteps: AutomationStepResult[] = [];
    for (const entry of resolved) {
      if (plan.scenario === "create-vlan") {
        const commands = buildVendorCommands(entry.device.vendor, plan.scenario, plan.vlanId, plan.vlanName, undefined, plan.mode || "add");
        previewSteps.push({
          id: `st-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          jobId: "dry-run",
          deviceId: entry.device.id,
          deviceName: entry.device.name,
          deviceIp: entry.device.ip,
          vendor: entry.device.vendor,
          scenario: plan.scenario,
          status: commands.unsupported ? "unsupported" : "dry-run",
          message: commands.unsupported ? (commands.warning || "Unsupported vendor") : (commands.warning || "Ready for apply"),
          commandPreview: commands.apply,
          retries: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      } else {
        for (const p of entry.ports) {
          const commands = buildVendorCommands(entry.device.vendor, plan.scenario, plan.vlanId, plan.vlanName, p.ifName, plan.mode || "add");
          previewSteps.push({
            id: `st-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            jobId: "dry-run",
            deviceId: entry.device.id,
            deviceName: entry.device.name,
            deviceIp: entry.device.ip,
            vendor: entry.device.vendor,
            port: p.ifName,
            scenario: plan.scenario,
            status: commands.unsupported ? "unsupported" : "dry-run",
            message: commands.unsupported ? (commands.warning || "Unsupported vendor") : (commands.warning || "Ready for apply"),
            commandPreview: commands.apply,
            retries: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }
    const planId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    automationPlans.set(planId, { id: planId, createdAt: new Date().toISOString(), actor, plan });
    await persistPgAutomationMaps();
    logAction(actor, "AUTOMATION_PLAN", `Dry-run prepared ${previewSteps.length} step(s) for ${plan.scenario}`, "system");
    return res.json({ success: true, planId, summary: { total: previewSteps.length, unsupported: previewSteps.filter((s) => s.status === "unsupported").length }, steps: previewSteps });
  });

  app.post("/api/automation/plans/apply", checkRole(["admin", "operator"]), async (req, res) => {
    const actor = actorName(req);
    const body = req.body as { planId?: string; plan?: Partial<AutomationPlan> };
    let plan = body?.plan ? normalizeAutomationPlan(body.plan) : undefined;
    if (!plan && body?.planId && automationPlans.has(body.planId)) {
      const existing = automationPlans.get(body.planId)?.plan;
      plan = existing ? normalizeAutomationPlan(existing) : undefined;
    }
    if (!plan) return res.status(400).json({ error: "plan or planId is required" });
    const resolved = await resolveAutomationTargets(plan);
    const batchSize = clampNumber(plan.options?.batchSize ?? systemConfig.automationDefaults.batchSize, 1, 100, 10);
    const retry = clampNumber(plan.options?.retry ?? systemConfig.automationDefaults.retry, 0, 5, 1);
    const errorThreshold = clampNumber(plan.options?.errorThreshold ?? systemConfig.automationDefaults.errorThreshold, 1, 10000, 20);
    const timeoutMs = clampNumber(plan.options?.timeoutMs ?? systemConfig.automationDefaults.timeoutMs, 1000, 60000, 15000);
    const concurrency = clampNumber(plan.options?.concurrency ?? systemConfig.automationDefaults.concurrency, 1, 100, batchSize);
    const steps: AutomationStepResult[] = [];
    for (const entry of resolved) {
      if (plan.scenario === "create-vlan") {
        steps.push({
          id: `st-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          jobId: "",
          deviceId: entry.device.id,
          deviceName: entry.device.name,
          deviceIp: entry.device.ip,
          vendor: entry.device.vendor,
          scenario: plan.scenario,
          status: "pending",
          message: "Pending",
          commandPreview: [],
          retries: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      } else {
        for (const p of entry.ports) {
          steps.push({
            id: `st-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            jobId: "",
            deviceId: entry.device.id,
            deviceName: entry.device.name,
            deviceIp: entry.device.ip,
            vendor: entry.device.vendor,
            port: p.ifName,
            scenario: plan.scenario,
            status: "pending",
            message: "Pending",
            commandPreview: [],
            retries: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }
    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    steps.forEach((s) => (s.jobId = jobId));
    const job: AutomationJob = {
      id: jobId,
      planId: body?.planId || `plan-${Date.now()}`,
      actor,
      status: "running",
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      summary: { total: steps.length, applied: 0, noop: 0, errors: 0, unsupported: 0, cancelled: 0 },
      progress: { done: 0, total: steps.length },
      meta: { batchSize, retry, errorThreshold, timeoutMs, concurrency },
      plan,
      steps,
    };
    automationJobs.set(jobId, job);
    logAction(actor, "AUTOMATION_APPLY", `Job ${jobId} created (${steps.length} step(s))`, "system");
    await persistPgAutomationMaps();

    void (async () => {
      try {
        let index = 0;
        while (index < job.steps.length) {
          if (automationCancellation.has(job.id)) {
            job.status = "cancelled";
            job.cancelledAt = new Date().toISOString();
            job.finishedAt = new Date().toISOString();
            for (let i = index; i < job.steps.length; i += 1) {
              if (job.steps[i].status === "pending") {
                job.steps[i].status = "cancelled";
                job.steps[i].message = "Cancelled by user";
                job.steps[i].updatedAt = new Date().toISOString();
                job.summary.cancelled += 1;
              }
            }
            break;
          }
          const chunk = job.steps.slice(index, index + Math.max(1, Math.min(batchSize, concurrency)));
          await Promise.all(chunk.map(async (s) => executeAutomationStep(job, s, retry)));
          index += chunk.length;
          job.summary.applied = job.steps.filter((s) => s.status === "applied").length;
          job.summary.noop = job.steps.filter((s) => s.status === "noop").length;
          job.summary.errors = job.steps.filter((s) => s.status === "error").length;
          job.summary.unsupported = job.steps.filter((s) => s.status === "unsupported").length;
          job.progress.done = job.steps.filter((s) => s.status !== "pending").length;
          if (job.summary.errors >= errorThreshold) {
            job.status = "failed";
            job.error = `Error threshold exceeded (${job.summary.errors})`;
            job.finishedAt = new Date().toISOString();
            break;
          }
        }
        if (!job.finishedAt) {
          job.finishedAt = new Date().toISOString();
          if (job.status === "running") {
            job.status = job.summary.errors > 0 ? "failed" : "completed";
          }
        }
      } finally {
        automationCancellation.delete(job.id);
        await persistPgAutomationMaps();
      }
    })();

    return res.json({ success: true, jobId });
  });

  app.get("/api/automation/jobs", checkRole(["admin", "operator", "viewer"]), (_req, res) => {
    const jobs = Array.from(automationJobs.values()).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.json({ jobs });
  });

  app.get("/api/automation/jobs/:id", checkRole(["admin", "operator", "viewer"]), (req, res) => {
    const id = String(req.params.id || "");
    const job = automationJobs.get(id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    return res.json({ job });
  });

  app.post("/api/automation/jobs/:id/cancel", checkRole(["admin", "operator"]), async (req, res) => {
    const id = String(req.params.id || "");
    const job = automationJobs.get(id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.status !== "running") return res.json({ success: true, status: job.status });
    automationCancellation.add(id);
    logAction(actorName(req), "AUTOMATION_CANCEL", `Cancel requested for ${id}`, "system");
    await persistPgAutomationMaps();
    return res.json({ success: true });
  });

  type MacHit = {
    deviceId: string;
    deviceName: string;
    ip: string;
    vendor: string;
    mac: string;
    matchType: "exact" | "suffix";
    interface?: string;
    ifIndex?: string;
    vlan?: number;
    voiceVlan?: number;
    voiceCandidate: boolean;
    matchedOui?: string;
    matchedOuiAddress?: string;
    matchedMask?: string;
    matchedDescription?: string;
    portVoiceVlan?: number;
    portDetectedVoiceVlan?: number;
    expectedVoiceVlan?: number;
    detectedVoiceVlan?: number;
    voiceVlanMatch: "match" | "mismatch" | "unknown" | "not_voice_candidate";
    source: string;
    timestamp: string;
  };

  type MacTraceStatus = "found_access" | "transit_last_seen" | "not_found" | "ambiguous" | "loop_detected" | "depth_limit";
  type MacTraceHop = {
    device: string;
    ip: string;
    inPort: string;
    outPort?: string;
    portType: "access" | "trunk" | "lag" | "unknown";
    vlan?: number;
    reason: string;
  };
type MacSearchEvent = {
  stage: "request" | "device" | "trace";
  status: "info" | "success" | "warning" | "error";
  message: string;
  timestamp: string;
  deviceId?: string;
  deviceName?: string;
  ip?: string;
};

  function normalizeIfToken(value: string): string {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/^ethernet/i, "eth")
      .replace(/^gigabitethernet/i, "gi")
      .replace(/^tengigabitethernet/i, "te");
  }

  function sortMacHitsDeterministically(hits: MacHit[]): MacHit[] {
    return [...hits].sort((a, b) => {
      const keyA = `${a.deviceName}|${a.ip}|${a.interface || ""}|${a.ifIndex || ""}|${a.vlan || 0}`;
      const keyB = `${b.deviceName}|${b.ip}|${b.interface || ""}|${b.ifIndex || ""}|${b.vlan || 0}`;
      return keyA.localeCompare(keyB);
    });
  }

  function buildMacSearchMatcher(rawMac: string): {
    ok: true;
    matchType: "exact" | "suffix";
    normalizedInput: string;
    displayMac: string;
    matcher: (mac: string) => boolean;
    matchesNormalizedMac: (normalizedMac: string) => boolean;
  } | { ok: false; error: string } {
    const normalizedInput = normalizeMacLoose(rawMac);
    if (!normalizedInput) {
      return { ok: false, error: "Invalid MAC format" };
    }
    if (normalizedInput.length === 12) {
      const displayMac = normalizeMac(normalizedInput);
      return {
        ok: true,
        matchType: "exact",
        normalizedInput,
        displayMac,
        matcher: (mac: string) => normalizeMacLoose(mac) === normalizedInput,
        matchesNormalizedMac: (normalizedMac: string) => String(normalizedMac || "") === normalizedInput,
      };
    }
    if (normalizedInput.length < 4 || normalizedInput.length % 2 !== 0) {
      return { ok: false, error: "MAC suffix must be at least 2 octets (4 hex chars)" };
    }
    const suffix = normalizedInput;
    const displayMac = suffix.match(/.{1,2}/g)?.join(":") || suffix;
    return {
      ok: true,
      matchType: "suffix",
      normalizedInput: suffix,
      displayMac,
      matcher: (mac: string) => normalizeMacLoose(mac).endsWith(suffix),
      matchesNormalizedMac: (normalizedMac: string) => String(normalizedMac || "").endsWith(suffix),
    };
  }

  async function collectMacHitsForDevices(
    matcher: (mac: string) => boolean,
    matchType: "exact" | "suffix",
    targets: InventoryItem[],
    onEvent?: (event: Omit<MacSearchEvent, "timestamp">) => void
  ): Promise<MacHit[]> {
    const results: MacHit[] = [];
    await forEachWithLimit(targets, 8, async (device) => {
      const beforeCount = results.length;
      onEvent?.({
        stage: "device",
        status: "info",
        message: `Querying ${device.name} (${device.ip})`,
        deviceId: device.id,
        deviceName: device.name,
        ip: device.ip,
      });
      try {
        const dot1dPortOid = String(snmpConfig.macSearch?.dot1dTpFdbPortOid || "1.3.6.1.2.1.17.4.3.1.2").trim();
        const basePortIfIndexOid = String(snmpConfig.macSearch?.dot1dBasePortIfIndexOid || "1.3.6.1.2.1.17.1.4.1.2").trim();
        const dot1qPortOid = String(snmpConfig.macSearch?.dot1qTpFdbPortOid || "1.3.6.1.2.1.17.7.1.2.2.1.2").trim();
        const [dot1dPorts, basePortIfIndex, ifNames, ifAlias, ifDescr, ifType, qBridgePorts, voiceMap, ciscoHints, lag] = await Promise.all([
          snmpWalk(device.ip, dot1dPortOid),
          snmpWalk(device.ip, basePortIfIndexOid),
          snmpWalk(device.ip, "1.3.6.1.2.1.31.1.1.1.1"),
          snmpWalk(device.ip, "1.3.6.1.2.1.31.1.1.1.18"),
          snmpWalk(device.ip, "1.3.6.1.2.1.2.2.1.2"),
          snmpWalk(device.ip, "1.3.6.1.2.1.2.2.1.3"),
          snmpWalk(device.ip, dot1qPortOid),
          collectVoiceVlanMap(device.ip),
          getCiscoTrunkPortHints(device.ip),
          getLagMembership(device.ip),
        ]);
        const ciscoAggHints = getCiscoAggregateHints(ciscoHints, lag);
        const qBridgeByNormalizedMac = new Map<string, number[]>();
        Object.entries(qBridgePorts).forEach(([qSuffix]) => {
          const parsed = parseQBridgeSuffix(qSuffix);
          const normalized = normalizeMacLoose(parsed.mac);
          if (!normalized) return;
          if (!qBridgeByNormalizedMac.has(normalized)) qBridgeByNormalizedMac.set(normalized, []);
          if (parsed.vlan !== undefined) qBridgeByNormalizedMac.get(normalized)!.push(parsed.vlan);
        });
        Object.entries(dot1dPorts).forEach(([suffix, bridgePortRaw]) => {
          const mac = macFromOidSuffix(suffix);
          if (!mac || !matcher(mac)) return;
          const normalizedMac = normalizeMacLoose(mac);
          const bridgePort = String(bridgePortRaw || "").trim();
          const ifIndex = String(basePortIfIndex[bridgePort] || "").trim();
          const ifName = String(ifNames[ifIndex] || ifDescr[ifIndex] || `if${ifIndex || "?"}`).trim();
          const alias = String(ifAlias[ifIndex] || "").trim();
          const descr = String(ifDescr[ifIndex] || "").trim();
          const isLag = lag.aggIndexes.has(ifIndex) || isLikelyLagInterface(ifName, alias, descr, ifType[ifIndex]);
          const isTrunk = isLikelyTrunkPort(ifName, alias, descr, ifType[ifIndex]) || ciscoHints.has(ifIndex) || ciscoAggHints.has(ifIndex);
          const source = isLag ? "dot1dTpFdbPort:lag" : isTrunk ? "dot1dTpFdbPort:trunk" : "dot1dTpFdbPort:access";
          const qbridgeVlans = normalizedMac ? qBridgeByNormalizedMac.get(normalizedMac) || [] : [];
          const vlan = qbridgeVlans.length ? qbridgeVlans[0] : undefined;
          const matchedOuiInfo = findMatchedOui(mac);
          const expectedVoiceVlan = voiceMap[ifIndex];
          const detectedVoiceVlan = vlan;
          const voiceCandidate = Boolean(matchedOuiInfo);
          const voiceVlanMatch = !voiceCandidate
            ? "not_voice_candidate"
            : expectedVoiceVlan === undefined || detectedVoiceVlan === undefined
              ? "unknown"
              : expectedVoiceVlan === detectedVoiceVlan
                ? "match"
                : "mismatch";
          results.push({
            deviceId: device.id,
            deviceName: device.name,
            ip: device.ip,
            vendor: device.vendor,
            mac,
            matchType,
            interface: ifName,
            ifIndex,
            vlan,
            voiceVlan: expectedVoiceVlan,
            voiceCandidate,
            matchedOui: matchedOuiInfo?.matchedOui,
            matchedOuiAddress: matchedOuiInfo?.matchedOuiAddress,
            matchedMask: matchedOuiInfo?.matchedMask,
            matchedDescription: matchedOuiInfo?.matchedDescription,
            portVoiceVlan: expectedVoiceVlan,
            portDetectedVoiceVlan: detectedVoiceVlan,
            expectedVoiceVlan,
            detectedVoiceVlan,
            voiceVlanMatch,
            source,
            timestamp: new Date().toISOString(),
          });
        });
        const deviceMatches = results.length - beforeCount;
        onEvent?.({
          stage: "device",
          status: deviceMatches > 0 ? "success" : "warning",
          message: deviceMatches > 0
            ? `Matched ${deviceMatches} entr${deviceMatches === 1 ? "y" : "ies"} on ${device.name}`
            : `No match on ${device.name}`,
          deviceId: device.id,
          deviceName: device.name,
          ip: device.ip,
        });
      } catch {
        onEvent?.({
          stage: "device",
          status: "error",
          message: `SNMP query failed on ${device.name}`,
          deviceId: device.id,
          deviceName: device.name,
          ip: device.ip,
        });
      }
    });
    return sortMacHitsDeterministically(results);
  }

  function detectPortType(hit: MacHit): "access" | "trunk" | "lag" | "unknown" {
    const src = String(hit.source || "").toLowerCase();
    if (src.includes(":lag")) return "lag";
    if (src.includes(":trunk")) return "trunk";
    if (src.includes(":access")) return "access";
    if (hit.interface && isLikelyLagInterface(hit.interface, "", "")) return "lag";
    if (hit.interface && isLikelyTrunkPort(hit.interface, "", "")) return "trunk";
    return "unknown";
  }

  function findTopologyNeighbors(deviceId: string, ifName: string): Array<{ neighborId: string; localPort: string; remotePort: string }> {
    const localNorm = normalizeIfToken(ifName);
    if (!localNorm) return [];
    const neighbors: Array<{ neighborId: string; localPort: string; remotePort: string }> = [];
    for (const link of topologyLinks) {
      const src = String(link.source || "").trim();
      const dst = String(link.target || "").trim();
      const portA = String(link.portA || "").trim();
      const portB = String(link.portB || "").trim();
      if (src === deviceId && normalizeIfToken(portA) === localNorm) {
        neighbors.push({ neighborId: dst, localPort: portA || ifName, remotePort: portB });
      }
      if (dst === deviceId && normalizeIfToken(portB) === localNorm) {
        neighbors.push({ neighborId: src, localPort: portB || ifName, remotePort: portA });
      }
    }
    return neighbors.sort((a, b) => `${a.neighborId}|${a.localPort}|${a.remotePort}`.localeCompare(`${b.neighborId}|${b.localPort}|${b.remotePort}`));
  }

  function normalizeBranchCode(value: unknown): string {
    return String(value || "").trim().toUpperCase();
  }

  function traceCandidatePriority(
    hit: MacHit,
    options?: {
      preferDeviceIds?: Set<string>;
      hasTransitCandidate?: boolean;
    }
  ): number {
    const portType = detectPortType(hit);
    const preferDeviceIds = options?.preferDeviceIds;
    const hasTransitCandidate = options?.hasTransitCandidate === true;
    const onPreferredDevice = Boolean(preferDeviceIds && preferDeviceIds.has(hit.deviceId));
    const neighbors = findTopologyNeighbors(hit.deviceId, String(hit.interface || ""));
    const hasTopologyNeighbor = neighbors.length > 0;

    let score = 0;
    // If transit candidates exist, bias away from immediate edge termination without topology evidence.
    if (hasTransitCandidate) {
      if (portType === "trunk") score += 520;
      else if (portType === "lag") score += 480;
      else if (portType === "access") score += 340;
      else score += 160;
    } else {
      if (portType === "access") score += 620;
      else if (portType === "trunk") score += 360;
      else if (portType === "lag") score += 320;
      else score += 160;
    }
    if (onPreferredDevice) score += 220;
    if (hasTopologyNeighbor) score += 120;
    if (hit.vlan !== undefined && hit.vlan !== null) score += 20;
    return score;
  }

  function rankTraceCandidates(
    hits: MacHit[],
    options?: {
      preferDeviceIds?: Set<string>;
    }
  ): MacHit[] {
    const hasTransitCandidate = hits.some((hit) => {
      const portType = detectPortType(hit);
      return portType === "trunk" || portType === "lag";
    });
    return [...hits].sort((a, b) => {
      const priorityDiff = traceCandidatePriority(b, {
        preferDeviceIds: options?.preferDeviceIds,
        hasTransitCandidate,
      }) - traceCandidatePriority(a, {
        preferDeviceIds: options?.preferDeviceIds,
        hasTransitCandidate,
      });
      if (priorityDiff !== 0) return priorityDiff;
      const aPortType = detectPortType(a);
      const bPortType = detectPortType(b);
      const deterministicA = `${a.deviceName}|${a.ip}|${a.interface || ""}|${a.ifIndex || ""}|${a.vlan || 0}|${aPortType}`;
      const deterministicB = `${b.deviceName}|${b.ip}|${b.interface || ""}|${b.ifIndex || ""}|${b.vlan || 0}|${bPortType}`;
      return deterministicA.localeCompare(deterministicB);
    });
  }

  async function traceMacPathFromCandidate(input: {
    start: MacHit;
    macMatcher: { matcher: (mac: string) => boolean; matchType: "exact" | "suffix" };
    maxHops: number;
    addEvent: (event: Omit<MacSearchEvent, "timestamp">) => void;
  }): Promise<{ finalStatus: MacTraceStatus; hops: MacTraceHop[]; ambiguityNotes: string[] }> {
    const { start, macMatcher, maxHops, addEvent } = input;
    const hops: MacTraceHop[] = [];
    const ambiguityNotes: string[] = [];
    let finalStatus: MacTraceStatus = "transit_last_seen";
    let current = start;
    const visitedDevicePort = new Set<string>();
    const visitedDevices = new Set<string>();

    for (let depth = 0; depth < maxHops; depth += 1) {
      const inPort = String(current.interface || "").trim() || "unknown";
      const devicePortKey = `${current.deviceId}::${normalizeIfToken(inPort)}`;
      if (visitedDevicePort.has(devicePortKey) || visitedDevices.has(current.deviceId)) {
        finalStatus = "loop_detected";
        addEvent({
          stage: "trace",
          status: "warning",
          message:
            `Trace stopped: loop guard triggered on ${current.deviceName} ${inPort}. ` +
            `Трассировка остановлена: обнаружен цикл на ${current.deviceName} ${inPort}.`,
          deviceId: current.deviceId,
          deviceName: current.deviceName,
          ip: current.ip,
        });
        hops.push({
          device: current.deviceName,
          ip: current.ip,
          inPort,
          portType: detectPortType(current),
          vlan: current.vlan,
          reason: "Traversal stopped due to loop guard (visited device/port).",
        });
        break;
      }
      visitedDevicePort.add(devicePortKey);
      visitedDevices.add(current.deviceId);

      const portType = detectPortType(current);
      const baseHop: MacTraceHop = {
        device: current.deviceName,
        ip: current.ip,
        inPort,
        portType,
        vlan: current.vlan,
        reason: "",
      };

      if (portType === "access") {
        finalStatus = "found_access";
        addEvent({
          stage: "trace",
          status: "success",
          message:
            `Trace ended on access/edge port ${current.deviceName} ${inPort}. ` +
            `Трассировка завершена на access/edge порту ${current.deviceName} ${inPort}.`,
          deviceId: current.deviceId,
          deviceName: current.deviceName,
          ip: current.ip,
        });
        baseHop.reason = "MAC terminates on access/edge port.";
        hops.push(baseHop);
        break;
      }

      const neighbors = findTopologyNeighbors(current.deviceId, inPort);
      if (!neighbors.length) {
        finalStatus = "transit_last_seen";
        addEvent({
          stage: "trace",
          status: "warning",
          message:
            `Trace stopped: no topology neighbor evidence for transit port ${current.deviceName} ${inPort} (${portType}). ` +
            `Трассировка остановлена: нет данных о соседе в топологии для транзитного порта ${current.deviceName} ${inPort} (${portType}).`,
          deviceId: current.deviceId,
          deviceName: current.deviceName,
          ip: current.ip,
        });
        baseHop.reason = `Transit ${portType} port without neighbor evidence in topology.`;
        hops.push(baseHop);
        break;
      }

      const nextLink = neighbors[0];
      if (neighbors.length > 1) {
        finalStatus = "ambiguous";
        ambiguityNotes.push(`Multiple neighbor links from ${current.deviceName} ${inPort}; deterministic first link selected.`);
        addEvent({
          stage: "trace",
          status: "warning",
          message: `Multiple neighbors from ${current.deviceName} ${inPort}; using first candidate.`,
          deviceId: current.deviceId,
          deviceName: current.deviceName,
          ip: current.ip,
        });
      }
      baseHop.outPort = nextLink.localPort;
      baseHop.reason = `Transit via ${portType} toward neighbor interface ${nextLink.remotePort || "unknown"}.`;
      hops.push(baseHop);

      const neighbor = inventory.find((d) => d.id === nextLink.neighborId);
      if (!neighbor) {
        finalStatus = "transit_last_seen";
        ambiguityNotes.push(`Neighbor device ${nextLink.neighborId} is missing from inventory.`);
        addEvent({
          stage: "trace",
          status: "error",
          message: `Neighbor ${nextLink.neighborId} is missing from inventory.`,
        });
        break;
      }

      addEvent({
        stage: "trace",
        status: "info",
        message: `Traversing to neighbor ${neighbor.name} via ${nextLink.remotePort || "unknown"}...`,
        deviceId: neighbor.id,
        deviceName: neighbor.name,
        ip: neighbor.ip,
      });
      const nextHits = await collectMacHitsForDevices(macMatcher.matcher, macMatcher.matchType, [neighbor], addEvent);
      if (!nextHits.length) {
        finalStatus = "transit_last_seen";
        ambiguityNotes.push(`No MAC entry on neighbor ${neighbor.name} (${neighbor.ip}); trace ends at last transit point.`);
        addEvent({
          stage: "trace",
          status: "warning",
          message: `No MAC entry on neighbor ${neighbor.name}; trace ended.`,
          deviceId: neighbor.id,
          deviceName: neighbor.name,
          ip: neighbor.ip,
        });
        break;
      }
      if (nextHits.length > 1) {
        finalStatus = "ambiguous";
        ambiguityNotes.push(`Neighbor ${neighbor.name} returned ${nextHits.length} candidate ports; deterministic first candidate selected.`);
      }
      const edgePreferred = nextHits.filter((hit) => {
        const type = detectPortType(hit);
        return type === "access";
      });
      const nextPool = edgePreferred.length ? edgePreferred : nextHits;
      current = rankTraceCandidates(nextPool)[0];

      if (depth === maxHops - 1) {
        finalStatus = "depth_limit";
        addEvent({
          stage: "trace",
          status: "warning",
          message:
            `Trace stopped: reached max hops limit (${maxHops}). ` +
            `Трассировка остановлена: достигнут лимит переходов (${maxHops}).`,
        });
      }
    }

    return { finalStatus, hops, ambiguityNotes };
  }

  app.post("/api/automation/mac-search", checkRole(["admin", "operator", "viewer"]), async (req, res) => {
    const rawMac = String(req.body?.mac || "");
    const macMatcher = buildMacSearchMatcher(rawMac);
    if (macMatcher.ok === false) {
      return res.status(400).json({ error: macMatcher.error });
    }
    const requestedIds = Array.isArray(req.body?.deviceIds)
      ? new Set<string>(req.body.deviceIds.map((x: unknown) => String(x)))
      : null;
    const baseTargets = requestedIds ? inventory.filter((d) => requestedIds.has(d.id)) : [...inventory];
    const branchCode = normalizeBranchCode(req.body?.branch || req.body?.regionPrefix);
    const isStrictSingleSelected = Boolean(requestedIds && requestedIds.size === 1 && baseTargets.length === 1);
    const targets = branchCode && !isStrictSingleSelected
      ? baseTargets.filter((d) => normalizeBranchCode(d.branch) === branchCode)
      : baseTargets;
    const mode = String(req.body?.mode || "single").trim().toLowerCase() === "trace" ? "trace" : "single";
    const maxHopsRaw = Number(req.body?.maxHops);
    const maxHops = Number.isFinite(maxHopsRaw) ? Math.max(1, Math.min(50, Math.floor(maxHopsRaw))) : 10;
    const events: MacSearchEvent[] = [];
    const addEvent = (event: Omit<MacSearchEvent, "timestamp">) => {
      events.push({ ...event, timestamp: new Date().toISOString() });
    };
    addEvent({
      stage: "request",
      status: "info",
      message: `Starting ${mode} search for ${macMatcher.displayMac} (${macMatcher.matchType}) across ${targets.length} device(s).`,
    });
    if (branchCode && !isStrictSingleSelected) {
      addEvent({
        stage: "request",
        status: "info",
        message: `Branch filter ${branchCode}: ${targets.length}/${baseTargets.length} device(s) selected.`,
      });
    }
    const results = await collectMacHitsForDevices(macMatcher.matcher, macMatcher.matchType, targets, addEvent);
    addEvent({
      stage: "request",
      status: "success",
      message: `Initial lookup completed with ${results.length} hit(s).`,
    });

    if (mode !== "trace") {
      logAction(actorName(req), "MAC Search", `MAC ${macMatcher.displayMac} (${macMatcher.matchType}) -> ${results.length} hit(s)`, "automation");
      return res.json({ success: true, mac: macMatcher.displayMac, matchType: macMatcher.matchType, results, events });
    }

    const hops: MacTraceHop[] = [];
    const ambiguityNotes: string[] = [];
    if (!results.length) {
      if (isStrictSingleSelected && baseTargets[0]) {
        const selected = baseTargets[0];
        addEvent({
          stage: "trace",
          status: "warning",
          message:
            `Not found on selected device ${selected.name} (${selected.ip}): no MAC table entry matched ${macMatcher.displayMac} (${macMatcher.matchType}). ` +
            `Не найдено на выбранном устройстве ${selected.name} (${selected.ip}): в таблице MAC нет записи, совпадающей с ${macMatcher.displayMac} (${macMatcher.matchType}).`,
          deviceId: selected.id,
          deviceName: selected.name,
          ip: selected.ip,
        });
      }
      addEvent({
        stage: "trace",
        status: "warning",
        message: "Trace skipped because no initial hit was found.",
      });
      return res.json({
        success: true,
        mode: "trace",
        mac: macMatcher.displayMac,
        matchType: macMatcher.matchType,
        finalStatus: "not_found" as MacTraceStatus,
        hops,
        ambiguityNotes,
        events,
      });
    }

    const preferredTraceDeviceIds = requestedIds && requestedIds.size > 0 ? requestedIds : undefined;
    const rankedStarts = rankTraceCandidates(results, {
      preferDeviceIds: preferredTraceDeviceIds,
    });
    const traceStarts = rankedStarts.slice(0, Math.min(4, rankedStarts.length));
    if (results.length > traceStarts.length) {
      ambiguityNotes.push(`Initial search returned ${results.length} candidates; tracing top ${traceStarts.length} edge-priority candidates.`);
    } else {
      ambiguityNotes.push(`Initial search returned ${results.length} candidates; tracing all candidates by edge-priority.`);
    }
    const attempts: Array<{ start: MacHit; finalStatus: MacTraceStatus; hops: MacTraceHop[]; ambiguityNotes: string[] }> = [];
    for (let idx = 0; idx < traceStarts.length; idx += 1) {
      const start = traceStarts[idx];
      addEvent({
        stage: "trace",
        status: "info",
        message: `Trace candidate ${idx + 1}/${traceStarts.length}: ${start.deviceName} ${start.interface || "unknown"} (${detectPortType(start)}).`,
        deviceId: start.deviceId,
        deviceName: start.deviceName,
        ip: start.ip,
      });
      const traced = await traceMacPathFromCandidate({
        start,
        macMatcher: { matcher: macMatcher.matcher, matchType: macMatcher.matchType },
        maxHops,
        addEvent,
      });
      attempts.push({ start, ...traced });
      if (traced.finalStatus === "found_access") break;
    }
    const statusRank: Record<MacTraceStatus, number> = {
      found_access: 0,
      transit_last_seen: 1,
      ambiguous: 2,
      depth_limit: 3,
      loop_detected: 4,
      not_found: 5,
    };
    const chosen = [...attempts].sort((a, b) => {
      const statusDiff = statusRank[a.finalStatus] - statusRank[b.finalStatus];
      if (statusDiff !== 0) return statusDiff;
      const aFinalHop = a.hops[a.hops.length - 1];
      const bFinalHop = b.hops[b.hops.length - 1];
      const aPenalty =
        a.finalStatus === "found_access" &&
        a.hops.length <= 1 &&
        (!aFinalHop || !findTopologyNeighbors(a.start.deviceId, String(aFinalHop.inPort || a.start.interface || "")).length)
          ? 120
          : 0;
      const bPenalty =
        b.finalStatus === "found_access" &&
        b.hops.length <= 1 &&
        (!bFinalHop || !findTopologyNeighbors(b.start.deviceId, String(bFinalHop.inPort || b.start.interface || "")).length)
          ? 120
          : 0;
      const priorityA = traceCandidatePriority(a.start, { preferDeviceIds: preferredTraceDeviceIds }) - aPenalty;
      const priorityB = traceCandidatePriority(b.start, { preferDeviceIds: preferredTraceDeviceIds }) - bPenalty;
      return priorityB - priorityA;
    })[0];
    const finalStatus: MacTraceStatus = chosen?.finalStatus || "not_found";
    hops.push(...(chosen?.hops || []));
    for (const note of chosen?.ambiguityNotes || []) ambiguityNotes.push(note);

    addEvent({
      stage: "trace",
      status: finalStatus === "found_access" ? "success" : finalStatus === "transit_last_seen" ? "warning" : "info",
      message: `Trace finished with status: ${finalStatus}.`,
    });
    logAction(actorName(req), "MAC Trace", `MAC ${macMatcher.displayMac} (${macMatcher.matchType}) -> ${finalStatus} (${hops.length} hop(s))`, "automation");
    return res.json({
      success: true,
      mode: "trace",
      mac: macMatcher.displayMac,
      matchType: macMatcher.matchType,
      maxHops,
      finalStatus,
      hops,
      ambiguityNotes,
      results,
      events,
    });
  });

  app.get("/api/automation/voice-vlan/:deviceId", checkRole(["admin", "operator", "viewer"]), async (req, res) => {
    const deviceId = String(req.params.deviceId || "");
    const device = inventory.find((d) => d.id === deviceId);
    if (!device) return res.status(404).json({ error: "Device not found" });
    const map = await collectVoiceVlanMap(device.ip);
    return res.json({
      success: true,
      deviceId,
      oid: snmpConfig.macSearch?.voiceVlanMacOid || "",
      records: Object.entries(map).map(([ifIndex, vlan]) => ({ ifIndex, vlan })),
    });
  });

  // API: System Configuration
  app.get("/api/config/system", checkRole(['admin', 'operator', 'viewer']), (req, res) => {
    res.json({ config: systemConfig });
  });

  // Public lightweight config for pre-auth UI (login/language bootstrap).
  app.get("/api/config/public", (_req, res) => {
    res.json({
      defaultLanguage: systemConfig.defaultLanguage || "ru",
      siteLabel: systemConfig.siteLabel || "UNSET",
      productName: systemConfig.productName || "NETNODE",
      theme: systemConfig.theme === "light" ? "light" : "dark",
      logoDataUrl: typeof systemConfig.logoDataUrl === "string" ? systemConfig.logoDataUrl : "",
    });
  });

  app.post("/api/config/system", checkRole(['admin']), async (req, res) => {
    const actor = actorName(req);
    const incoming = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const patch: Record<string, unknown> = { ...incoming };
    if (typeof incoming.productName === 'string') {
      patch.productName = incoming.productName.trim().slice(0, 64) || 'NETNODE';
    }
    if (incoming.theme !== undefined) {
      patch.theme = incoming.theme === 'light' ? 'light' : 'dark';
    }
    if (incoming.logoDataUrl !== undefined) {
      const logo = typeof incoming.logoDataUrl === 'string' ? incoming.logoDataUrl.trim() : '';
      // Keep payload bounded to reduce memory risk.
      patch.logoDataUrl = logo.length <= 2_000_000 ? logo : '';
    }
    systemConfig = { ...systemConfig, ...patch };
    logAction(actor, 'System Config Update', `Updated system settings`, 'config');
    await persistPgConfigs("system");
    res.json({ success: true, config: systemConfig });
  });

  app.get("/api/system/banner", checkRole(['admin', 'operator', 'viewer']), (_req, res) => {
    res.json({
      siteLabel: systemConfig.siteLabel || "UNSET",
      productName: systemConfig.productName || "NETNODE",
      logoDataUrl: typeof systemConfig.logoDataUrl === "string" ? systemConfig.logoDataUrl : "",
      theme: systemConfig.theme === "light" ? "light" : "dark",
      appUptime: formatDuration(process.uptime()),
    });
  });

  app.get("/api/config/ldap", checkRole(['admin']), (_req, res) => {
    res.json({ ldap: maskLdapForClient() });
  });

  app.post("/api/config/ldap", checkRole(['admin']), async (req, res) => {
    const actor = actorName(req);
    const body = req.body as { admin?: LdapClientPatch; operator?: LdapClientPatch };
    await mergeLdapPasswords(body || {});
    logAction(actor, 'LDAP Config Update', 'Updated LDAP authentication profiles', 'config');
    await persistPgConfigs("ldap");
    res.json({ success: true, ldap: maskLdapForClient() });
  });

  app.post("/api/config/ldap/test", checkRole(["admin"]), async (req, res) => {
    const body = req.body as {
      profile?: "admin" | "operator";
      draft?: LdapClientPatch;
      testUsername?: string;
      testPassword?: string;
    };
    const key = body.profile === "operator" ? "operator" : "admin";
    let p: LdapRoleProfile = { ...ldapConfig[key] };
    if (body.draft && typeof body.draft === "object") {
      const d = body.draft;
      p = {
        ...p,
        enabled: d.enabled ?? p.enabled,
        url: d.url ?? p.url,
        bindDn: d.bindDn ?? p.bindDn,
        searchBase: d.searchBase ?? p.searchBase,
        searchFilter: d.searchFilter ?? p.searchFilter,
        tlsRejectUnauthorized: d.tlsRejectUnauthorized ?? p.tlsRejectUnauthorized,
      };
      const bp = d.bindPassword;
      if (bp !== undefined && bp.trim() && bp !== "********") {
        p.bindPasswordMaterial = await materialFromUserPassword(bp.trim());
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
      actorName(req),
      "LDAP Test",
      `${key}: ${bindRes.message}`,
      "config"
    );
    return res.json(bindRes);
  });

  registerInventoryHttpRoutes(app, {
    checkRole,
    actorName,
    actorRole,
    logAction,
    getInventory: () => inventory,
    setInventory: (next) => {
      inventory = next;
    },
    inventoryMeta,
    deriveZoneKeyFromDeviceName,
    resolveDeviceZone,
    deriveFcSubcategoryByName,
    upsertInventoryMetaFromItem,
    rebuildTopologyFromInventory,
    deleteTopologyLayoutIds,
    persistPgInventoryAndTopology,
  });

  // API: Health Check
  app.get("/api/health", (req, res) => {
    res.json({ status: "online", version: "pro", timestamp: new Date().toISOString() });
  });

  // API: User Management
  app.get("/api/users", checkRole(['admin']), (req, res) => {
    // Don't send password material to frontend
    res.json(users.map(({ password, passwordHash, ...u }) => u));
  });

  app.post("/api/auth/login", loginLimiter, async (req, res) => {
    const parsed = loginBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => i.message).join("; ");
      return res.status(400).json({ success: false, message: msg || "Invalid request body" });
    }
    const { username, password } = parsed.data;
    const requestIp = getRequestIp(req);

    const user = users.find((u) => u.username === username && password && verifyLocalPassword(u, password));
    if (user) {
      const authUser = { id: user.id, username: user.username, role: user.role };
      user.lastLogin = new Date().toISOString();
      const { sessionId: sid, csrfToken } = await createSession(authUser);
      writeSessionCookie(res, sid, shouldUseSecureCookie(req, isProd));
      logAction(username || "unknown", "Login Success", "User authenticated successfully", "auth", requestIp);
      await persistPgUsers();
      return res.json({ success: true, user: authUser, csrfToken });
    }

    if (username && password) {
      const adminOk = await verifyLdapLogin(ldapConfig.admin, username, password);
      if (adminOk) {
        const authUser = { id: `ldap-admin:${username}`, username, role: "admin" };
        const { sessionId: sid, csrfToken } = await createSession(authUser);
        writeSessionCookie(res, sid, shouldUseSecureCookie(req, isProd));
        logAction(username, "Login Success", "LDAP (administrators profile)", "auth", requestIp);
        return res.json({ success: true, user: authUser, csrfToken });
      }
      const operatorOk = await verifyLdapLogin(ldapConfig.operator, username, password);
      if (operatorOk) {
        const authUser = { id: `ldap-operator:${username}`, username, role: "operator" };
        const { sessionId: sid, csrfToken } = await createSession(authUser);
        writeSessionCookie(res, sid, shouldUseSecureCookie(req, isProd));
        logAction(username, "Login Success", "LDAP (operators profile)", "auth", requestIp);
        return res.json({ success: true, user: authUser, csrfToken });
      }
    }

    logAction(
      username || "unknown",
      "Login Failure",
      `Failed login attempt for username: ${username || "unknown"}`,
      "auth",
      requestIp
    );
    res.status(401).json({ success: false, message: "Invalid credentials" });
  });

  app.get("/api/auth/session", (req, res) => {
    const { sid, user, csrfToken } = readSession(req);
    if (!user) {
      if (sid) clearSessionCookie(res, shouldUseSecureCookie(req, isProd));
      // Return 200 to avoid noisy expected 401 logs before login in browser console.
      return res.json({ success: false, message: "Session expired or invalid" });
    }
    return res.json({ success: true, user, csrfToken });
  });

  app.post("/api/auth/logout", async (req, res) => {
    const { sid, user } = readSession(req);
    const requestIp = getRequestIp(req);
    if (sid) await revokeSession(sid);
    clearSessionCookie(res, shouldUseSecureCookie(req, isProd));
    if (user?.username) {
      logAction(user.username, "Logout", "User logged out", "auth", requestIp);
    }
    return res.json({ success: true });
  });

  app.post("/api/users", checkRole(['admin']), async (req, res) => {
    const parsed = createUserBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    }
    const { username, password, role } = parsed.data;
    const actor = actorName(req);
    const newUser = {
      id: Date.now().toString(),
      username,
      passwordHash: hashPassword(String(password)),
      role: role || 'operator',
      lastLogin: '-'
    };
    users.push(newUser);
    logAction(actor, 'Create User', `Created new user: ${username} with role ${role}`, 'user_mgmt');
    await persistPgUsers();
    const { passwordHash, ...safeUser } = newUser;
    res.json({ success: true, user: safeUser });
  });

  app.patch("/api/users/:id", checkRole(['admin']), async (req, res) => {
    const parsed = patchUserBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    }
    const { role } = parsed.data;
    const actor = actorName(req);
    const user = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    
    const oldRole = user.role;
    if (role) user.role = role;
    logAction(actor, 'Update User Role', `Updated user ${user.username} role from ${oldRole} to ${role}`, 'user_mgmt');
    await persistPgUsers();
    res.json({ success: true });
  });

  app.post("/api/users/:id/password", checkRole(['admin']), async (req, res) => {
    const parsed = resetPasswordBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    }
    const { password } = parsed.data;
    const actor = actorName(req);
    const user = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    
    if (password) {
      user.passwordHash = hashPassword(String(password));
      delete user.password;
    }
    logAction(actor, 'Reset Password', `Reset password for user: ${user.username}`, 'user_mgmt');
    await persistPgUsers();
    res.json({ success: true, message: "Password updated successfully" });
  });

  app.delete("/api/users/:id", checkRole(['admin']), async (req, res) => {
    const actor = actorName(req);
    const user = users.find(u => u.id === req.params.id);
    if (user) {
      logAction(actor, 'Delete User', `Deleted user: ${user.username}`, 'user_mgmt');
    }
    users = users.filter(u => u.id !== req.params.id);
    await persistPgUsers();
    res.json({ success: true });
  });

  const runWatchProfiles = async (
    actor: string,
    trigger: "scheduled" | "manual",
    profileIds?: string[],
    onProgress?: (progress: { completed: number; total: number; latest?: DiscoveryWatchRunResult }) => void
  ) => {
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
      const runs: DiscoveryWatchRunResult[] = [];
      let completed = 0;
      onProgress?.({ completed, total: selected.length });
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
          const latest = { profileId: p.id, profileName: p.name, result: summary } as DiscoveryWatchRunResult;
          runs.push(latest);
          completed += 1;
          onProgress?.({ completed, total: selected.length, latest });
        } catch (e) {
          const msg = safeErrorDetail(e);
          p.lastRunAt = new Date().toISOString();
          p.lastResult = { success: false, error: msg };
          const latest = { profileId: p.id, profileName: p.name, result: p.lastResult } as DiscoveryWatchRunResult;
          runs.push(latest);
          completed += 1;
          onProgress?.({ completed, total: selected.length, latest });
          console.warn(`[discovery-watch] profile failed name="${p.name}" branch="${p.branch}": ${msg}`);
        }
      }
      logAction(actor, trigger === "manual" ? "Discovery Watch Manual Run" : "Discovery Watch Scheduled Run", `Profiles processed: ${runs.length}`, "inventory");
      await persistPgDiscoveryProfiles(trigger === "manual" ? "watch-manual" : "watch-batch");
      return { started: true, runs };
    } finally {
      discoveryRunLock = false;
    }
  };

  app.post("/api/discovery/start", checkRole(["admin", "operator"]), async (req, res) => {
    const parsed = discoveryStartBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => i.message).join("; ");
      return res.status(400).json(clientErrorPayload("discovery.start.validation", msg || "Invalid request body"));
    }
    const { subnets, protocol, city, zone, branch } = parsed.data;
    const actor = actorName(req);
    if (discoveryRunLock) {
      return res.status(409).json({
        ...clientErrorPayload("discovery.start.lock", "Discovery run is already in progress"),
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
    void persistPgDiscoveryJobMaps();

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
        const msg = safeErrorDetail(e);
        const current = manualDiscoveryJobs.get(jobId);
        if (current) {
          current.status = "error";
          current.error = msg;
          current.finishedAt = new Date().toISOString();
          manualDiscoveryJobs.set(jobId, current);
        }
        console.warn(`[discovery] manual scan failed job=${jobId}: ${msg}`);
        logAction(actor, "Discovery Failed", msg, "inventory");
      } finally {
        discoveryRunLock = false;
        if (activeManualDiscoveryJobId === jobId) activeManualDiscoveryJobId = null;
        await persistPgDiscoveryJobMaps();
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
    if (!job) return res.status(404).json(clientErrorPayload("discovery.start.status", "Discovery job not found"));
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
      activeManualWatchRunJobId,
      enabledProfiles: entries.length,
      nextRuns: entries.slice(0, 20),
      serverNow: new Date(now).toISOString(),
    });
  });

  app.post("/api/discovery/watch", checkRole(["admin", "operator"]), async (req, res) => {
    const parsed = discoveryWatchSaveBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    }
    const incoming = parsed.data.profiles;
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
    const actor = actorName(req);
    logAction(actor, "Discovery Watch Update", `Profiles saved: ${discoveryWatchProfiles.length}`, "inventory");
    await persistPgDiscoveryProfiles("api-watch-save");
    res.json({ success: true, profiles: discoveryWatchProfiles });
  });

  app.post("/api/discovery/watch/run", checkRole(["admin", "operator"]), async (req, res) => {
    const actor = actorName(req);
    const profileIds = Array.isArray(req.body?.profileIds) ? req.body.profileIds.map((x: unknown) => String(x)) : undefined;
    if (discoveryRunLock) {
      return res.status(409).json({
        ...clientErrorPayload("discovery.watch.run.lock", "Discovery run is already in progress"),
        error: "Discovery run is already in progress",
        runningJobId: activeManualWatchRunJobId || activeManualDiscoveryJobId,
      });
    }

    const jobId = `dwr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const nowIso = new Date().toISOString();
    const job: DiscoveryWatchRunJob = {
      id: jobId,
      actor,
      status: "running",
      createdAt: nowIso,
      startedAt: nowIso,
      profileIds: profileIds?.length ? profileIds : null,
      progress: { completed: 0, total: 0 },
      runs: [],
    };
    discoveryWatchRunJobs.set(jobId, job);
    trimDiscoveryWatchRunJobs();
    activeManualWatchRunJobId = jobId;
    void persistPgDiscoveryJobMaps();

    (async () => {
      try {
        const out = await runWatchProfiles(actor, "manual", profileIds, ({ completed, total }) => {
          const current = discoveryWatchRunJobs.get(jobId);
          if (!current) return;
          current.progress = { completed, total };
          discoveryWatchRunJobs.set(jobId, current);
        });
        const current = discoveryWatchRunJobs.get(jobId);
        if (!current) return;
        if (!out.started) {
          current.status = "error";
          current.error = out.reason === "already-running" ? "Discovery run is already in progress" : String(out.reason || "Unable to start run");
        } else {
          current.runs = out.runs;
          const failedRuns = out.runs.filter((run) => run.result?.success === false);
          if (failedRuns.length > 0) {
            const detail = failedRuns
              .map((run) => `${run.profileName}: ${safeErrorDetail(run.result?.error)}`)
              .join("; ");
            current.status = "error";
            current.error = `${failedRuns.length} profile(s) failed: ${detail}`;
            console.warn(`[discovery-watch] manual run completed with failures: ${detail}`);
          } else {
            current.status = "done";
          }
        }
        current.finishedAt = new Date().toISOString();
        discoveryWatchRunJobs.set(jobId, current);
      } catch (e) {
        const current = discoveryWatchRunJobs.get(jobId);
        if (current) {
          current.status = "error";
          current.error = safeErrorDetail(e);
          current.finishedAt = new Date().toISOString();
          discoveryWatchRunJobs.set(jobId, current);
        }
      } finally {
        if (activeManualWatchRunJobId === jobId) activeManualWatchRunJobId = null;
        await persistPgDiscoveryJobMaps();
      }
    })();

    return res.status(202).json({
      success: true,
      accepted: true,
      jobId,
      status: "running",
      statusEndpoint: `/api/discovery/watch/run/status/${jobId}`,
    });
  });

  app.get("/api/discovery/watch/run/status/:jobId", checkRole(["admin", "operator"]), (req, res) => {
    const jobId = String(req.params.jobId || "").trim();
    const job = discoveryWatchRunJobs.get(jobId);
    if (!job) return res.status(404).json(clientErrorPayload("discovery.watch.run.status", "Discovery watch run job not found"));
    return res.json({
      success: true,
      jobId: job.id,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt || null,
      profileIds: job.profileIds,
      progress: job.progress,
      runs: job.runs,
      error: job.error || null,
      profiles: discoveryWatchProfiles,
    });
  });

  app.get("/api/topology/links", checkRole(["admin", "operator", "viewer"]), (req, res) => {
    const branch = String(req.query.branch || "").trim();
    const topologyMode = normalizeTopologyMode(req.query.topologyMode);
    topologyLinks = topologyLinks.map((l) => ensureTopologyLinkId(l));
    res.json({
      links: topologyLinks,
      layout: getTopologyLayoutForScope(topologyMode, branch || undefined),
      zoneLabelOverrides: getTopologyZoneLabelOverridesForScope(topologyMode, branch || undefined),
    });
  });

  app.get("/api/topology/trunk-diagnostics", checkRole(["admin", "operator", "viewer"]), async (req, res) => {
    try {
      const branch = String(req.query.branch || "").trim();
      const refresh = String(req.query.refresh ?? "true").trim().toLowerCase() !== "false";
      if (refresh) {
        await inferTopologyLinksFromTrunkDescriptions(branch || undefined);
      }
      return res.json({ success: true, trunkDiagnostics: lastTopologyTrunkDiagnostics });
    } catch (e) {
      const msg = safeErrorDetail(e);
      console.warn(`[topology] trunk diagnostics failed branch="${String(req.query.branch || "").trim()}": ${msg}`);
      return res.status(500).json(clientErrorPayload("topology.trunk-diagnostics", msg));
    }
  });

  app.get("/api/topology/versions", checkRole(["admin", "operator", "viewer"]), (_req, res) => {
    const versions = topologySnapshots
      .slice()
      .reverse()
      .map((v) => ({
        id: v.id,
        createdAt: v.createdAt,
        actor: v.actor,
        reason: v.reason,
        branch: v.branch,
      }));
    res.json({ versions, total: versions.length });
  });

  app.get("/api/topology/versions/:id/preview", checkRole(["admin", "operator", "viewer"]), (req, res) => {
    const id = String(req.params.id || "").trim();
    const branch = String(req.query.branch || "").trim();
    const topologyMode = normalizeTopologyMode(req.query.topologyMode);
    const snapshot = topologySnapshots.find((v) => v.id === id);
    if (!snapshot) return res.status(404).json({ success: false, error: "Topology version not found" });
    const currentScoped = filterTopologyByBranch(topologyLinks, getTopologyLayoutForScope(topologyMode, branch || undefined), branch || undefined);
    const targetScoped = filterTopologyByBranch(snapshot.links, getSnapshotLayoutForScope(snapshot, topologyMode, branch || undefined), branch || undefined);
    const summary = diffTopologyState(currentScoped, targetScoped);
    return res.json({
      success: true,
      version: {
        id: snapshot.id,
        createdAt: snapshot.createdAt,
        actor: snapshot.actor,
        reason: snapshot.reason,
        branch: snapshot.branch,
      },
      scope: { branch: branch || null, topologyMode },
      summary,
    });
  });

  app.post("/api/topology/restore", checkRole(["admin", "operator"]), async (req, res) => {
    const id = String(req.body?.versionId || "").trim();
    const branch = String(req.body?.branch || "").trim();
    const topologyMode = normalizeTopologyMode(req.body?.topologyMode);
    const actor = actorName(req);
    if (!id) return res.status(400).json({ success: false, error: "versionId is required" });
    const snapshot = topologySnapshots.find((v) => v.id === id);
    if (!snapshot) return res.status(404).json({ success: false, error: "Topology version not found" });

    saveTopologySnapshot(actor, "topology.restore.pre", branch || undefined);
    if (!branch) {
      topologyLinks = cloneTopologyLinks(snapshot.links).map((l) => ensureTopologyLinkId(l));
      setTopologyLayoutForScope(topologyMode, undefined, getSnapshotLayoutForScope(snapshot, topologyMode));
      topologyZoneLabelOverridesScopes = cloneTopologyZoneLabelOverrideScopes(snapshot.zoneLabelOverridesScopes || { ip: {}, fc: {} });
    } else {
      const ids = branchDeviceIdSet(branch);
      const currentExternalLinks = topologyLinks.filter((l) => !(ids.has(l.source) && ids.has(l.target)));
      const targetBranchLinks = snapshot.links.filter((l) => ids.has(l.source) && ids.has(l.target));
      topologyLinks = [...currentExternalLinks, ...cloneTopologyLinks(targetBranchLinks).map((l) => ensureTopologyLinkId(l))];
      setTopologyLayoutForScope(topologyMode, branch, getSnapshotLayoutForScope(snapshot, topologyMode, branch));
      const key = topologyLayoutBranchKey(branch);
      topologyZoneLabelOverridesScopes[topologyMode][key] = cloneTopologyZoneLabelOverrides(
        snapshot.zoneLabelOverridesScopes?.[topologyMode]?.[key] || {}
      );
    }
    logAction(actor, "Topology Restore", `Restored version ${snapshot.id}${branch ? ` (branch: ${branch})` : ""}`, "inventory");
    await persistPgTopologyOnly("topology-restore");
    return res.json({
      success: true,
      restored: { id: snapshot.id, createdAt: snapshot.createdAt, reason: snapshot.reason },
      links: topologyLinks,
      layout: getTopologyLayoutForScope(topologyMode, branch || undefined),
      zoneLabelOverrides: getTopologyZoneLabelOverridesForScope(topologyMode, branch || undefined),
    });
  });

  app.post("/api/topology/undo", checkRole(["admin", "operator"]), async (req, res) => {
    const branch = String(req.body?.branch || "").trim();
    const topologyMode = normalizeTopologyMode(req.body?.topologyMode);
    const actor = actorName(req);
    if (!topologySnapshots.length) {
      return res.status(404).json({ success: false, error: "No topology versions available" });
    }
    const idx = branch
      ? (() => {
          for (let i = topologySnapshots.length - 1; i >= 0; i--) {
            const v = topologySnapshots[i];
            if (!v.branch || v.branch === branch) return i;
          }
          return -1;
        })()
      : topologySnapshots.length - 1;
    if (idx < 0) return res.status(404).json({ success: false, error: "No matching topology version found" });
    const snapshot = topologySnapshots[idx];
    topologySnapshots.splice(idx, 1);
    topologyLinks = cloneTopologyLinks(snapshot.links).map((l) => ensureTopologyLinkId(l));
    setTopologyLayoutForScope(topologyMode, branch || undefined, getSnapshotLayoutForScope(snapshot, topologyMode, branch || undefined));
    if (!branch) {
      topologyZoneLabelOverridesScopes = cloneTopologyZoneLabelOverrideScopes(snapshot.zoneLabelOverridesScopes || { ip: {}, fc: {} });
    } else {
      const key = topologyLayoutBranchKey(branch);
      topologyZoneLabelOverridesScopes[topologyMode][key] = cloneTopologyZoneLabelOverrides(
        snapshot.zoneLabelOverridesScopes?.[topologyMode]?.[key] || {}
      );
    }
    logAction(actor, "Topology Undo", `Restored version ${snapshot.id}${branch ? ` (branch: ${branch})` : ""}`, "inventory");
    await persistPgTopologyOnly("topology-undo");
    return res.json({
      success: true,
      restored: { id: snapshot.id, createdAt: snapshot.createdAt, reason: snapshot.reason },
      links: topologyLinks,
      layout: getTopologyLayoutForScope(topologyMode, branch || undefined),
      zoneLabelOverrides: getTopologyZoneLabelOverridesForScope(topologyMode, branch || undefined),
    });
  });

  app.post("/api/topology/links/rebuild", checkRole(["admin", "operator"]), async (req, res) => {
    try {
      const branch = String(req.body?.branch || "").trim();
      const topologyMode = normalizeTopologyMode(req.body?.topologyMode);
      const actor = actorName(req);
      if (topologyMode === "fc") {
        return res.json({ success: true, links: topologyLinks, layout: getTopologyLayoutForScope(topologyMode, branch || undefined) });
      }
      saveTopologySnapshot(actor, "topology.rebuild", branch || undefined);
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
      logAction(
        actor,
        "Rebuild Topology",
        `Auto-built ${links.length} links from Trunk descriptions${branch ? ` (branch: ${branch})` : ""}`,
        "inventory"
      );
      await persistPgTopologyOnly("topology-rebuild");
      return res.json({
        success: true,
        links: topologyLinks,
        layout: getTopologyLayoutForScope(topologyMode, branch || undefined),
        trunkDiagnostics: lastTopologyTrunkDiagnostics,
      });
    } catch (e) {
      const msg = safeErrorDetail(e);
      console.warn(`[topology] rebuild failed branch="${String(req.body?.branch || "").trim()}" mode="${normalizeTopologyMode(req.body?.topologyMode)}": ${msg}`);
      return res.status(500).json(clientErrorPayload("topology.links.rebuild", msg));
    }
  });

  app.post("/api/topology/classify-subcategories", checkRole(["admin", "operator"]), async (req, res) => {
    try {
      const branch = String(req.body?.branch || "").trim();
      const out = await classifyInventorySubcategoriesBySnmp(branch || undefined);
      const actor = actorName(req);
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

  app.post("/api/inventory/branches/rename", checkRole(["admin", "operator"]), async (req, res) => {
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
    renameTopologyLayoutBranchScopes(from, to);
    renameTopologyZoneLabelBranchScopes(from, to);

    const actor = actorName(req);
    logAction(actor, "Rename Branch", `${from} -> ${to}, affected: ${renamed}`, "inventory");
    await persistPgInventoryAndTopology("branch-rename");
    await persistPgDiscoveryProfiles("branch-rename");
    return res.json({ success: true, renamed, from, to, branches: inventoryMeta.branches });
  });

  app.post("/api/topology/zones/label", checkRole(["admin", "operator"]), async (req, res) => {
    const body = req.body as { zoneKey?: string; label?: string; branch?: string; topologyMode?: string };
    const zoneKey = String(body.zoneKey || "").trim();
    const label = String(body.label || "").trim();
    const branch = String(body.branch || "").trim();
    const topologyMode = normalizeTopologyMode(body.topologyMode);
    if (!zoneKey) return res.status(400).json({ error: "zoneKey is required" });

    const scopeKey = topologyLayoutBranchKey(branch || undefined);
    const current = topologyZoneLabelOverridesScopes[topologyMode][scopeKey] || {};
    const currentLabel = String(current[zoneKey] || "").trim();
    if (currentLabel === label) {
      return res.json({
        success: true,
        zoneKey,
        label: label || null,
        zoneLabelOverrides: getTopologyZoneLabelOverridesForScope(topologyMode, branch || undefined),
      });
    }

    saveTopologySnapshot(actorName(req), "topology.zone.label.rename", branch || undefined);
    const next = cloneTopologyZoneLabelOverrides(current);
    if (label) next[zoneKey] = label;
    else delete next[zoneKey];
    topologyZoneLabelOverridesScopes[topologyMode][scopeKey] = next;

    logAction(
      actorName(req),
      "Rename Zone Label",
      label
        ? `zone=${zoneKey} -> "${label}"${branch ? ` (branch: ${branch}, mode: ${topologyMode})` : ` (mode: ${topologyMode})`}`
        : `zone=${zoneKey} label cleared${branch ? ` (branch: ${branch}, mode: ${topologyMode})` : ` (mode: ${topologyMode})`}`,
      "inventory"
    );

    await persistPgTopologyOnly("topology-zone-label");
    return res.json({
      success: true,
      zoneKey,
      label: label || null,
      zoneLabelOverrides: getTopologyZoneLabelOverridesForScope(topologyMode, branch || undefined),
    });
  });

  app.post("/api/topology/links", checkRole(["admin", "operator"]), async (req, res) => {
    const body = req.body as {
      source?: string;
      target?: string;
      portA?: string;
      portB?: string;
      topologyMode?: string;
      allowDuplicate?: boolean;
      branch?: string;
    };
    const source = String(body.source || "").trim();
    const target = String(body.target || "").trim();
    const portA = String(body.portA || "").trim();
    const portB = String(body.portB || "").trim();
    const branch = String(body.branch || "").trim();
    const topologyMode = String(body.topologyMode || "").trim().toLowerCase();
    const allowDuplicate = Boolean(body.allowDuplicate) || topologyMode === "fc";
    if (!source || !target || source === target) {
      return res.status(400).json({ error: "Invalid link endpoints" });
    }
    if (branch) {
      const branchIds = branchDeviceIdSet(branch);
      if (!branchIds.has(source) || !branchIds.has(target)) {
        return res.status(400).json({ error: "Link endpoints must belong to active branch" });
      }
    }
    const exists = !allowDuplicate && topologyLinks.some(
      (l) =>
        (l.source === source && l.target === target && l.portA === portA && l.portB === portB) ||
        (l.source === target && l.target === source && l.portA === portB && l.portB === portA)
    );
    if (!exists) {
      saveTopologySnapshot(actorName(req), "topology.link.add", branch || undefined);
      topologyLinks.push(ensureTopologyLinkId({ source, target, portA: portA || "N/A", portB: portB || "N/A", manual: true }));
    }
    await persistPgTopologyOnly("topology-link-add");
    res.json({ success: true, links: topologyLinks });
  });

  app.post("/api/topology/links/rename", checkRole(["admin", "operator"]), async (req, res) => {
    const body = req.body as {
      id?: string;
      source?: string;
      target?: string;
      portA?: string;
      portB?: string;
      newPortA?: string;
      newPortB?: string;
      branch?: string;
    };
    const source = String(body.source || "").trim();
    const target = String(body.target || "").trim();
    const id = String(body.id || "").trim();
    const portA = String(body.portA || "").trim();
    const portB = String(body.portB || "").trim();
    const newPortA = String(body.newPortA || "").trim();
    const newPortB = String(body.newPortB || "").trim();
    const branch = String(body.branch || "").trim();
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
    if (branch) {
      const branchIds = branchDeviceIdSet(branch);
      const link = topologyLinks[pick];
      if (!branchIds.has(link.source) || !branchIds.has(link.target)) {
        return res.status(400).json({ error: "Link is outside active branch" });
      }
    }

    saveTopologySnapshot(actorName(req), "topology.link.rename", branch || undefined);
    const cur = topologyLinks[pick];
    topologyLinks[pick] = ensureTopologyLinkId({
      ...cur,
      portA: newPortA || cur.portA,
      portB: newPortB || cur.portB,
      renamed: true,
    });
    await persistPgTopologyOnly("topology-link-rename");
    return res.json({ success: true, links: topologyLinks });
  });

  app.delete("/api/topology/links", checkRole(["admin", "operator"]), async (req, res) => {
    const body = req.body as { id?: string; source?: string; target?: string; portA?: string; portB?: string; branch?: string };
    const id = String(body.id || "").trim();
    const source = String(body.source || "").trim();
    const target = String(body.target || "").trim();
    const portA = String(body.portA || "").trim();
    const portB = String(body.portB || "").trim();
    const branch = String(body.branch || "").trim();
    const branchIds = branch ? branchDeviceIdSet(branch) : null;
    const before = topologyLinks.length;
    const nextLinks = topologyLinks.filter((l) => {
      if (branchIds && (!branchIds.has(l.source) || !branchIds.has(l.target))) return true;
      if (id) return l.id !== id;
      return !(
        l.source === source &&
        l.target === target &&
        l.portA === portA &&
        l.portB === portB
      );
    });
    const removed = before - nextLinks.length;
    if (removed > 0) saveTopologySnapshot(actorName(req), "topology.link.delete", branch || undefined);
    topologyLinks = nextLinks;
    await persistPgTopologyOnly("topology-link-delete");
    res.json({ success: true, removed, links: topologyLinks });
  });

  app.post("/api/topology/layout", checkRole(["admin", "operator"]), async (req, res) => {
    const body = req.body as {
      positions?: TopologyLayout;
      branch?: string;
      topologyMode?: string;
      replace?: boolean;
    };
    const positions = body?.positions || {};
    const branch = String(body?.branch || "").trim();
    const topologyMode = normalizeTopologyMode(body?.topologyMode);
    const branchIds = branch ? branchDeviceIdSet(branch) : null;
    const actor = actorName(req);
    const scopedPositions: TopologyLayout = {};
    for (const [id, pos] of Object.entries(positions)) {
      if (branchIds && !branchIds.has(id)) continue;
      if (Number.isFinite(pos?.x) && Number.isFinite(pos?.y)) {
        scopedPositions[id] = { x: Number(pos.x), y: Number(pos.y) };
      }
    }
    const hasIncoming = Object.keys(scopedPositions).length > 0;
    if (hasIncoming) saveTopologySnapshot(actor, "topology.layout.update", branch || undefined);
    const layout = mergeTopologyLayoutForScope(topologyMode, branch || undefined, scopedPositions, Boolean(body?.replace));
    await persistPgTopologyOnly("topology-layout");
    res.json({ success: true, layout });
  });

  app.get("/api/config/snmp", checkRole(['admin', 'operator']), (_req, res) => {
    res.json({ snmp: snmpConfigForClient() });
  });

  app.get("/api/backup/config", checkRole(["admin", "operator", "viewer"]), (_req, res) => {
    res.json({
      config: {
        ...backupConfig,
        credentials: {
          username: backupConfig.credentials?.username || "",
          domain: backupConfig.credentials?.domain || "",
          hasPassword: Boolean(backupConfig.credentials?.password),
        },
      },
      scheduler: {
        enabled: backupConfig.enabled,
        lastTickAt: backupSchedulerLastTickAt,
        running: backupRunLock,
      },
    });
  });

  app.post("/api/backup/config", checkRole(["admin", "operator"]), async (req, res) => {
    const body = req.body as Partial<BackupConfig>;
    backupConfig.enabled = body.enabled === true;
    backupConfig.intervalHours = Math.max(1, Math.min(168, Number(body.intervalHours || backupConfig.intervalHours || 6)));
    backupConfig.networkSharePath = String(body.networkSharePath || backupConfig.networkSharePath || "").trim();
    backupConfig.scope = {
      mode: body.scope?.mode === "filtered" ? "filtered" : "all",
      deviceIds: Array.isArray(body.scope?.deviceIds) ? body.scope?.deviceIds.map((x) => String(x)) : [],
      vendors: Array.isArray(body.scope?.vendors) ? body.scope?.vendors.map((x) => String(x)) : [],
      branches: Array.isArray(body.scope?.branches) ? body.scope?.branches.map((x) => String(x)) : [],
    };
    backupConfig.credentials = {
      username: String(body.credentials?.username || backupConfig.credentials?.username || "").trim(),
      domain: String(body.credentials?.domain || backupConfig.credentials?.domain || "").trim(),
      password: String(body.credentials?.password || backupConfig.credentials?.password || ""),
    };
    logAction(actorName(req), "Backup Config Update", `enabled=${backupConfig.enabled}, interval=${backupConfig.intervalHours}h`, "config");
    await persistPgConfigs("backup");
    return res.json({ success: true, config: backupConfig });
  });

  app.post("/api/backup/run", checkRole(["admin", "operator"]), async (req, res) => {
    if (backupRunLock) {
      return res.status(409).json(clientErrorPayload("backup.run.lock", "Backup run already in progress"));
    }
    const readiness = validateBackupRunReadiness();
    if (readiness.ok === false) {
      return res.status(readiness.status).json(
        clientErrorPayload("backup.run.preflight", readiness.error, {
          remediation: readiness.remediation,
          targetCount: readiness.targetCount,
        })
      );
    }
    const result = await runBackupJob(actorName(req));
    if (result.status === "failed") {
      const detail = safeErrorDetail(
        result.error ||
          result.details
            .filter((d) => d.status === "failed")
            .map((d) => `${d.deviceName}: ${d.error || "failed"}`)
            .join("; "),
        "Backup run failed"
      );
      console.warn(`[backup] run failed id=${result.id}: ${detail}`);
      const failedDetails = result.details
        .filter((d) => d.status === "failed")
        .slice(0, 5)
        .map((d) => `${d.deviceName || d.ip}: ${safeErrorDetail(d.error, "failed")}`);
      return res.status(500).json(
        clientErrorPayload("backup.run.execute", detail, {
          runId: result.id,
          summary: result.summary,
          detail: failedDetails.join("; "),
          remediation: "Check device reachability, SSH credentials, and backup path permissions.",
          run: result,
        })
      );
    }
    return res.json({ success: true, run: result });
  });

  app.get("/api/backup/history", checkRole(["admin", "operator", "viewer"]), (_req, res) => {
    res.json({ runs: backupHistory.slice(0, 30) });
  });

  app.get("/api/snmp/templates", checkRole(['admin', 'operator', 'viewer']), (_req, res) => {
    res.json({ templates: snmpTemplates });
  });

  app.post("/api/snmp/templates", checkRole(['admin']), async (req, res) => {
    const tpl = req.body as SnmpTemplate;
    if (!tpl?.id || !tpl?.name || !Array.isArray(tpl.metrics)) {
      return res.status(400).json({ error: "Invalid template payload" });
    }
    snmpTemplates = [...snmpTemplates.filter((t) => t.id !== tpl.id), tpl];
    await persistPgSnmpTemplates();
    res.json({ success: true, templates: snmpTemplates });
  });

  app.delete("/api/snmp/templates/:id", checkRole(['admin']), async (req, res) => {
    const id = String(req.params.id || "");
    const before = snmpTemplates.length;
    snmpTemplates = snmpTemplates.filter((t) => t.id !== id);
    if (snmpTemplates.length === before) {
      return res.status(404).json({ success: false, error: "Template not found" });
    }
    inventory = inventory.map((item) =>
      item.snmpTemplateId === id ? { ...item, snmpTemplateId: undefined } : item
    );
    await persistPgSnmpTemplates();
    await persistPgInventoryAndTopology("snmp-template-delete");
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
        await Promise.all(
          allDefs.map(async (def) => {
            const value = await resolveMetricValue(item.ip, def, map);
            if (value === null || value === undefined) return;
            custom[def.key] = typeof value === "number" ? Math.round(value * 100) / 100 : String(value);
          })
        );
        const cpuCandidates = Object.entries(custom)
          .filter(([k, v]) => k.toLowerCase().includes("cpu") && Number.isFinite(Number(v)))
          .map(([, v]) => Number(v));
        const cpuLoad = cpuCandidates.length
          ? Math.round((cpuCandidates.reduce((a, b) => a + b, 0) / cpuCandidates.length) * 100) / 100
          : null;
        const trunks = await collectTrunkMetricsWithFallback(item);
        return {
          id: item.id,
          name: item.name,
          ip: item.ip,
          branch: item.branch || "ULN",
          category: item.category || "Switch",
          trunks,
          metrics: custom,
          cpuLoad,
        };
      })
    );

    const trunkFlat = sample.flatMap((d) => d.trunks.map((t) => ({ ...t, deviceId: d.id, deviceName: d.name, branch: d.branch })));
    const cpuDevices = sample.filter((d) => Number.isFinite(Number(d.cpuLoad))).map((d) => Number(d.cpuLoad));
    const avgCpuLoad = cpuDevices.length ? Math.round((cpuDevices.reduce((a, b) => a + b, 0) / cpuDevices.length) * 100) / 100 : null;
    res.json({
      generatedAt: new Date().toISOString(),
      devices: sample,
      cpuSummary: {
        avgCpuLoad,
        devicesWithCpu: cpuDevices.length,
      },
      trunkSummary: {
        total: trunkFlat.length,
        down: trunkFlat.filter((t) => t.isDown === true).length,
        topByTraffic: trunkFlat
          .map((t) => ({ ...t, totalBps: t.inBps + t.outBps }))
          .sort((a, b) => b.totalBps - a.totalBps)
          .slice(0, 10),
      },
    });
  });

  // API: SNMP Configuration
  app.post("/api/config/snmp", checkRole(['admin']), async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const { version, timeoutMs, retries, port, macSearch } = body;
    const actor = actorName(req);
    const mergedCred = await mergeSnmpCredentialsFromBody(body, snmpConfig);
    snmpConfig.communityMaterial = mergedCred.communityMaterial;
    snmpConfig.communitiesMaterials = mergedCred.communitiesMaterials;
    if (typeof version === "string" && version.trim()) snmpConfig.version = version.trim();
    if (Number.isFinite(Number(timeoutMs))) snmpConfig.timeoutMs = Math.max(300, Math.min(5000, Number(timeoutMs)));
    if (Number.isFinite(Number(retries))) snmpConfig.retries = Math.max(0, Math.min(3, Number(retries)));
    if (Number.isFinite(Number(port))) snmpConfig.port = Math.max(1, Math.min(65535, Number(port)));
    if (macSearch && typeof macSearch === "object") {
      const normalizedPrefixes = normalizeOuiPrefixList(
        (macSearch as { voiceOuiPrefixes?: unknown }).voiceOuiPrefixes ?? snmpConfig.macSearch.voiceOuiPrefixes
      );
      const explicitEntries = normalizeVoiceOuiEntries(
        (macSearch as { voiceOuiEntries?: unknown }).voiceOuiEntries ?? snmpConfig.macSearch.voiceOuiEntries
      );
      const compatEntries = buildVoiceOuiEntriesFromPrefixes(normalizedPrefixes);
      const mergedVoiceOuiEntries = normalizeVoiceOuiEntries([...explicitEntries, ...compatEntries]);
      const ms = macSearch as Record<string, unknown>;
      snmpConfig.macSearch = {
        ...snmpConfig.macSearch,
        dot1dTpFdbPortOid: String(ms.dot1dTpFdbPortOid || snmpConfig.macSearch.dot1dTpFdbPortOid).trim(),
        dot1dBasePortIfIndexOid: String(ms.dot1dBasePortIfIndexOid || snmpConfig.macSearch.dot1dBasePortIfIndexOid).trim(),
        dot1qTpFdbPortOid: String(ms.dot1qTpFdbPortOid || snmpConfig.macSearch.dot1qTpFdbPortOid).trim(),
        voiceVlanMacOid: String(ms.voiceVlanMacOid || snmpConfig.macSearch.voiceVlanMacOid).trim(),
        voiceOuiPrefixes: normalizedPrefixes,
        voiceOuiEntries: mergedVoiceOuiEntries,
      };
    }
    logAction(actor, 'SNMP Config Update', `Changed SNMP settings (Version: ${version})`, 'config');
    await persistPgConfigs("snmp");
    res.json({ success: true, message: "SNMP configuration saved.", snmp: snmpConfigForClient() });
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

  app.post("/api/config/ssh-readonly", checkRole(["admin", "operator"]), async (req, res) => {
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
      passwordMaterial: await materialFromUserPassword(password),
      port: Number.isFinite(port) && port > 0 && port <= 65535 ? port : 22,
      allowMetricsFallback: body.allowMetricsFallback !== false,
      expiresAt: Date.now() + ttlHours * 60 * 60 * 1000,
    };
    logAction(
      actorName(req),
      "SSH Readonly Profile Set",
      `TTL ${ttlHours}h, metrics fallback: ${sshReadonlyProfile.allowMetricsFallback ? "on" : "off"}`,
      "config"
    );
    return res.json({ success: true, expiresAt: new Date(sshReadonlyProfile.expiresAt).toISOString() });
  });

  // API: Trap Receiver Configuration
  app.post("/api/config/trap-receiver", checkRole(['admin']), (req, res) => {
    const { ip, port } = req.body;
    const actor = actorName(req);
    logAction(actor, 'Trap Receiver Update', `Updated trap receiver to ${ip}:${port}`, 'config');
    res.json({ success: true, message: "Trap receiver configuration saved." });
  });

  // Socket.io for Terminal (SSH)
  io.use((socket, next) => {
    void (async () => {
      try {
        const { user } = await readSessionFromCookieHeader(socket.handshake.headers.cookie || "");
        if (!user) return next(new Error("unauthorized"));
        (socket.data as { netnodeUser: AuthUser }).netnodeUser = user;
        next();
      } catch (e) {
        next(e instanceof Error ? e : new Error("session load failed"));
      }
    })();
  });

  io.on("connection", (socket) => {
    const authenticatedUser = (socket.data as { netnodeUser?: AuthUser }).netnodeUser;
    if (!authenticatedUser) {
      socket.emit("ssh:status", { sessionId: "auth", status: "unauthorized" });
      socket.disconnect(true);
      return;
    }
    const requireSocketUser = (sessionId = "auth") => {
      if (!authenticatedUser) {
        socket.emit("ssh:data", { sessionId, data: "\r\n*** Authentication required for SSH proxy. ***\r\n" });
        socket.disconnect(true);
        return null;
      }
      return authenticatedUser;
    };
    const sessions = new Map<
      string,
      {
        client: Client;
        stream?: Duplex;
        idleTimer?: NodeJS.Timeout;
        bumpIdle?: () => void;
      }
    >();
    const SSH_MAX_SESSIONS_PER_TAB = Math.max(1, Math.min(32, Number(process.env.NETNODE_SSH_MAX_SESSIONS_PER_TAB) || 8));
    const SSH_SHELL_IDLE_MS = Math.max(60_000, Math.min(4 * 60 * 60_000, Number(process.env.NETNODE_SSH_IDLE_MS) || 30 * 60 * 1000));

    socket.on("ssh:connect", ({ sessionId, host, username, password, port }) => {
      const socketUser = requireSocketUser(sessionId);
      if (!socketUser) return;
      if (!sessions.has(sessionId) && sessions.size >= SSH_MAX_SESSIONS_PER_TAB) {
        socket.emit("ssh:data", {
          sessionId,
          data: `\r\n*** Too many concurrent SSH sessions (${SSH_MAX_SESSIONS_PER_TAB}) for this browser tab. Close one first. ***\r\n`,
        });
        socket.emit("ssh:status", { sessionId, status: "disconnected" });
        return;
      }
      // Clean up existing session if it exists for this ID
      if (sessions.has(sessionId)) {
        const prev = sessions.get(sessionId);
        if (prev?.idleTimer) clearTimeout(prev.idleTimer);
        sessions.get(sessionId)?.client.end();
      }

      const sshClient = new Client();
      sessions.set(sessionId, { client: sshClient });
      const sshPort = typeof port === "number" && port > 0 && port < 65536 ? port : 22;
      const pwd = typeof password === "string" ? password : "";

      try {
        sshClient
          .on("keyboard-interactive", (_name, _instr, _lang, prompts, finish) => {
            if (pwd && prompts?.length) {
              finish(prompts.map(() => pwd));
            } else {
              finish([]);
            }
          })
          .on("ready", () => {
            logAction(
              socketUser.username,
              "SSH Connect",
              `Opened SSH proxy to ${host}:${sshPort} as ${username}`,
              "system"
            );
            socket.emit("ssh:status", { sessionId, status: "connected" });
            sshClient.shell(
              {
                term: "xterm-256color",
                cols: 160,
                rows: 40,
              },
              (err, stream) => {
            if (err) {
              const message = normalizeSshErrorForClient(err);
              socket.emit("ssh:data", { sessionId, data: `\r\n*** SSH Shell Error: ${message} ***\r\n` });
              socket.emit("ssh:status", { sessionId, status: "disconnected" });
              try {
                sshClient.end();
              } catch {
                /* ignore */
              }
              sessions.delete(sessionId);
              return;
            }
            
            const session = sessions.get(sessionId);
            if (!session) {
              try {
                stream.destroy?.();
              } catch {
                /* ignore */
              }
              try {
                sshClient.end();
              } catch {
                /* ignore */
              }
              sessions.delete(sessionId);
              socket.emit("ssh:status", { sessionId, status: "disconnected" });
              return;
            }
            session.stream = stream;

            let idleTimer: NodeJS.Timeout | undefined;
            const clearShellIdle = () => {
              if (idleTimer) clearTimeout(idleTimer);
              idleTimer = undefined;
              session.idleTimer = undefined;
              session.bumpIdle = undefined;
            };
            const bumpShellIdle = () => {
              clearShellIdle();
              idleTimer = setTimeout(() => {
                try {
                  stream.destroy?.();
                } catch {
                  /* ignore */
                }
                try {
                  sshClient.end();
                } catch {
                  /* ignore */
                }
                sessions.delete(sessionId);
                socket.emit("ssh:status", { sessionId, status: "disconnected" });
              }, SSH_SHELL_IDLE_MS);
              session.idleTimer = idleTimer;
            };
            session.bumpIdle = bumpShellIdle;
            bumpShellIdle();

            stream.on("data", (data: Buffer) => {
              bumpShellIdle();
              socket.emit("ssh:data", { sessionId, data: data.toString() });
            });
            
            stream.on("close", () => {
              clearShellIdle();
              sshClient.end();
              sessions.delete(sessionId);
              socket.emit("ssh:status", { sessionId, status: "disconnected" });
            });
            }
          );
        })
        .on("error", (err) => {
          const sess = sessions.get(sessionId);
          if (sess?.idleTimer) clearTimeout(sess.idleTimer);
          if (sess) {
            sess.idleTimer = undefined;
            sess.bumpIdle = undefined;
          }
          const message = normalizeSshErrorForClient(err);
          socket.emit("ssh:data", { sessionId, data: `\r\n*** SSH Error: ${message} ***\r\n` });
          socket.emit("ssh:status", { sessionId, status: "disconnected" });
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
      } catch (e) {
        sessions.delete(sessionId);
        try {
          sshClient.end();
        } catch {
          /* ignore */
        }
        const message = normalizeSshErrorForClient(e);
        socket.emit("ssh:data", { sessionId, data: `\r\n*** SSH Connect Error: ${message} ***\r\n` });
        socket.emit("ssh:status", { sessionId, status: "disconnected" });
      }
    });

    socket.on("ssh:input", ({ sessionId, input }) => {
      if (!requireSocketUser(sessionId)) return;
      const session = sessions.get(sessionId);
      session?.bumpIdle?.();
      if (session && session.stream) {
        session.stream.write(input);
      }
    });

    socket.on("ssh:disconnect", ({ sessionId }) => {
      if (!requireSocketUser(sessionId)) return;
      const session = sessions.get(sessionId);
      if (session) {
        if (session.idleTimer) clearTimeout(session.idleTimer);
        session.client.end();
        sessions.delete(sessionId);
      }
    });

    socket.on("disconnect", () => {
      sessions.forEach((session) => {
        if (session.idleTimer) clearTimeout(session.idleTimer);
        session.client.end();
      });
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

  const shutdown = async () => {
    console.log("\n[shutdown] Closing HTTP server and background connections…");
    if (discoveryScheduler) {
      clearInterval(discoveryScheduler);
      discoveryScheduler = null;
    }
    if (backupScheduler) {
      clearInterval(backupScheduler);
      backupScheduler = null;
    }
    if (inventoryMetricsScheduler) {
      clearInterval(inventoryMetricsScheduler);
      inventoryMetricsScheduler = null;
    }
    const deadline = Date.now() + 8000;
    while ((discoveryRunLock || backupRunLock) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    try {
      await shutdownPool(pgPool);
    } catch {
      /* ignore */
    }
    await closeAmqp();
    await shutdownSessionRuntime();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 4000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  server.listen(Number(listenPort), "0.0.0.0", () => {
    console.log(`\n================================================`);
    console.log(`NETNODE Backend running on http://0.0.0.0:${listenPort}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`================================================\n`);
  });
}
