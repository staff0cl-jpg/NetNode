import type { AuthUser } from "../auth/types.js";

declare global {
  namespace Express {
    interface Request {
      /** Populated by `attachNetnodeSession` before route handlers. */
      netnodeSession?: { sid?: string; user: AuthUser | null; csrfToken?: string };
    }
  }
}

export {};
