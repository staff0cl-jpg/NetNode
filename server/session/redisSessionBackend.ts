import crypto from "crypto";
import type { AuthUser } from "../auth/types.js";
import { parseCookieHeader } from "./cookieParse.js";
import { SESSION_COOKIE_NAME, SESSION_TTL_MS } from "./sessionConstants.js";
import type { SessionBackend, SessionPayload, SessionReadResult, SessionRedisClient } from "./sessionTypes.js";

const key = (sid: string) => `netnode:sess:${sid}`;

export class RedisSessionBackend implements SessionBackend {
  constructor(private readonly client: SessionRedisClient) {}

  async create(user: AuthUser): Promise<{ sessionId: string; csrfToken: string }> {
    const sessionId = crypto.randomBytes(32).toString("hex");
    const csrfToken = crypto.randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + SESSION_TTL_MS;
    const payload: SessionPayload = { user, expiresAt, csrfToken };
    const ttlSec = Math.max(60, Math.ceil(SESSION_TTL_MS / 1000));
    await this.client.set(key(sessionId), JSON.stringify(payload), { EX: ttlSec });
    return { sessionId, csrfToken };
  }

  async read(cookieHeader: string): Promise<SessionReadResult> {
    const sid = parseCookieHeader(cookieHeader)[SESSION_COOKIE_NAME];
    if (!sid) return { user: null };
    const raw = await this.client.get(key(sid));
    if (!raw) return { sid, user: null };
    let record: SessionPayload;
    try {
      record = JSON.parse(raw) as SessionPayload;
    } catch {
      await this.client.del(key(sid));
      return { sid, user: null };
    }
    if (record.expiresAt <= Date.now()) {
      await this.client.del(key(sid));
      return { sid, user: null };
    }
    if (!record.csrfToken) {
      record.csrfToken = crypto.randomBytes(24).toString("base64url");
      const ttlSec = Math.max(60, Math.ceil((record.expiresAt - Date.now()) / 1000));
      await this.client.set(key(sid), JSON.stringify(record), { EX: ttlSec });
    }
    return { sid, user: record.user, csrfToken: record.csrfToken };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.client.del(key(sessionId));
  }

  async pruneExpired(): Promise<number> {
    /* Redis keys use TTL; nothing to scan here */
    return 0;
  }
}
