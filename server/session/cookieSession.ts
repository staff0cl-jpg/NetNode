import type express from "express";
import type { AuthUser } from "../auth/types.js";
import { SESSION_COOKIE_NAME, SESSION_TTL_MS } from "./sessionConstants.js";
import { getSessionBackend } from "./sessionRuntime.js";

export { SESSION_COOKIE_NAME, SESSION_TTL_MS } from "./sessionConstants.js";
export { parseCookieHeader } from "./cookieParse.js";

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

export async function createSession(user: AuthUser): Promise<{ sessionId: string; csrfToken: string }> {
  return getSessionBackend().create(user);
}

/** Requires `attachNetnodeSession` to run first. */
export function readSession(req: express.Request): { sid?: string; user: AuthUser | null; csrfToken?: string } {
  return req.netnodeSession ?? { user: null };
}

export async function readSessionFromCookieHeader(cookieHeader: string): Promise<{ sid?: string; user: AuthUser | null; csrfToken?: string }> {
  return getSessionBackend().read(cookieHeader);
}

export async function revokeSession(sessionId: string): Promise<void> {
  return getSessionBackend().revoke(sessionId);
}

export async function pruneExpiredSessions(now = Date.now()): Promise<number> {
  return getSessionBackend().pruneExpired(now);
}
