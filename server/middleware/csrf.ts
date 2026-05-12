import type { NextFunction, Request, Response } from "express";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

function requestPath(req: Request): string {
  const u = req.originalUrl || req.url || "";
  const q = u.indexOf("?");
  return q >= 0 ? u.slice(0, q) : u;
}

/**
 * Validates X-CSRF-Token against the server-side session record for mutating /api/* calls.
 * Skips first-run setup and login (no session yet).
 */
export function csrfProtectionMiddleware(): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    if (process.env.NETNODE_CSRF_DISABLED === "1") return next();
    const method = (req.method || "GET").toUpperCase();
    if (SAFE.has(method)) return next();
    const path = requestPath(req);
    if (!path.startsWith("/api/")) return next();
    if (path.startsWith("/api/auth/login")) return next();
    if (path.startsWith("/api/setup/")) return next();
    const { user, csrfToken } = req.netnodeSession ?? { user: null, csrfToken: undefined };
    if (!user) return next();
    const header = String(req.get("x-csrf-token") || req.get("x-xsrf-token") || "").trim();
    if (!csrfToken || !header || header !== csrfToken) {
      return res.status(403).json({ success: false, error: "CSRF token missing or invalid", code: "csrf_failed" });
    }
    next();
  };
}
