import crypto from "crypto";
import type { AuthUser } from "../auth/types.js";
import { parseCookieHeader } from "./cookieParse.js";
import { SESSION_COOKIE_NAME, SESSION_TTL_MS } from "./sessionConstants.js";
import type { SessionBackend, SessionPayload, SessionReadResult } from "./sessionTypes.js";

const DEFAULT_SESSION_STORE_MAX = 10_000;

function sessionStoreMax(): number {
  const n = Number(process.env.NETNODE_SESSION_STORE_MAX);
  if (!Number.isFinite(n)) return DEFAULT_SESSION_STORE_MAX;
  return Math.max(100, Math.min(500_000, Math.floor(n)));
}

function enforceSessionStoreCap(store: Map<string, SessionPayload>): void {
  const cap = sessionStoreMax();
  let guard = 0;
  while (store.size >= cap && guard < cap + 100) {
    const first = store.keys().next().value as string | undefined;
    if (first === undefined) break;
    store.delete(first);
    guard += 1;
  }
}

export class MemorySessionBackend implements SessionBackend {
  private readonly store = new Map<string, SessionPayload>();

  async create(user: AuthUser): Promise<{ sessionId: string; csrfToken: string }> {
    await this.pruneExpired();
    enforceSessionStoreCap(this.store);
    const sessionId = crypto.randomBytes(32).toString("hex");
    const csrfToken = crypto.randomBytes(24).toString("base64url");
    const payload: SessionPayload = {
      user,
      expiresAt: Date.now() + SESSION_TTL_MS,
      csrfToken,
    };
    this.store.set(sessionId, payload);
    return { sessionId, csrfToken };
  }

  async read(cookieHeader: string): Promise<SessionReadResult> {
    const sid = parseCookieHeader(cookieHeader)[SESSION_COOKIE_NAME];
    if (!sid) return { user: null };
    const record = this.store.get(sid);
    if (!record) return { sid, user: null };
    if (record.expiresAt <= Date.now()) {
      this.store.delete(sid);
      return { sid, user: null };
    }
    if (!record.csrfToken) {
      record.csrfToken = crypto.randomBytes(24).toString("base64url");
    }
    return { sid, user: record.user, csrfToken: record.csrfToken };
  }

  async revoke(sessionId: string): Promise<void> {
    this.store.delete(sessionId);
  }

  async pruneExpired(now = Date.now()): Promise<number> {
    let removed = 0;
    for (const [sid, rec] of this.store) {
      if (rec.expiresAt <= now) {
        this.store.delete(sid);
        removed += 1;
      }
    }
    enforceSessionStoreCap(this.store);
    return removed;
  }
}
