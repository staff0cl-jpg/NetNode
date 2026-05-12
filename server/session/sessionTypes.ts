import type { AuthUser } from "../auth/types.js";

export type SessionPayload = { user: AuthUser; expiresAt: number; csrfToken: string };

export type SessionReadResult = { sid?: string; user: AuthUser | null; csrfToken?: string };

/** Narrow surface we use from node-redis (avoids generic client typing drift). */
export type SessionRedisClient = {
  connect(): Promise<void>;
  quit(): Promise<void>;
  on(event: "error", fn: (err: Error) => void): void;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { EX?: number }): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
};

export interface SessionBackend {
  create(user: AuthUser): Promise<{ sessionId: string; csrfToken: string }>;
  read(cookieHeader: string): Promise<SessionReadResult>;
  revoke(sessionId: string): Promise<void>;
  pruneExpired(now?: number): Promise<number>;
}
