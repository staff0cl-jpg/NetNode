import crypto from "crypto";
import type express from "express";
import type { AuthUser } from "../auth/types.js";

export const SESSION_COOKIE_NAME = "netnode_sid";
export const SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8 hours

type SessionRecord = { user: AuthUser; expiresAt: number };

const sessionStore = new Map<string, SessionRecord>();

function parseCookieHeader(src = ""): Record<string, string> {
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

export function writeSessionCookie(res: express.Response, sessionId: string, secure: boolean): void {
  res.cookie(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

export function clearSessionCookie(res: express.Response, secure: boolean): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
  });
}

export function shouldUseSecureCookie(req: express.Request, isProd: boolean): boolean {
  if (!isProd) return false;
  if (req.secure) return true;
  const proto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    ?.trim()
    .toLowerCase();
  return proto === "https";
}

export function makeSession(user: AuthUser): string {
  const sid = crypto.randomBytes(32).toString("hex");
  sessionStore.set(sid, { user, expiresAt: Date.now() + SESSION_TTL_MS });
  return sid;
}

export function readSession(req: express.Request): { sid?: string; user: AuthUser | null } {
  return readSessionFromCookieHeader(req.headers.cookie || "");
}

export function readSessionFromCookieHeader(cookieHeader = ""): { sid?: string; user: AuthUser | null } {
  const sid = parseCookieHeader(cookieHeader)[SESSION_COOKIE_NAME];
  if (!sid) return { user: null };
  const record = sessionStore.get(sid);
  if (!record) return { sid, user: null };
  if (record.expiresAt <= Date.now()) {
    sessionStore.delete(sid);
    return { sid, user: null };
  }
  return { sid, user: record.user };
}

export function revokeSession(sessionId: string): void {
  sessionStore.delete(sessionId);
}

/** Removes expired session rows so abandoned cookies do not grow the map without bound. */
export function pruneExpiredSessions(now = Date.now()): number {
  let removed = 0;
  for (const [sid, rec] of sessionStore) {
    if (rec.expiresAt <= now) {
      sessionStore.delete(sid);
      removed += 1;
    }
  }
  return removed;
}
