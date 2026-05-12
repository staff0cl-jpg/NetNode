import type { Express, NextFunction, Request, Response } from "express";

function clientIp(req: Request): string {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0]?.trim();
  if (xf) return xf;
  return req.socket.remoteAddress || "unknown";
}

/** Basic hardening headers without extra dependencies (Helmet-equivalent subset). */
const DEFAULT_CSP_PROD =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";

/** Dev: Vite needs unsafe-eval for HMR; connect-src allows local WS. */
const DEFAULT_CSP_DEV =
  "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; base-uri 'self'; form-action 'self'";

export function applySecurityMiddleware(app: Express, opts: { isProd: boolean }): void {
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (opts.isProd) {
      res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    }
    const cspOverride = String(process.env.NETNODE_CONTENT_SECURITY_POLICY || "").trim();
    if (cspOverride && cspOverride !== "0") {
      res.setHeader("Content-Security-Policy", cspOverride);
    } else {
      res.setHeader("Content-Security-Policy", opts.isProd ? DEFAULT_CSP_PROD : DEFAULT_CSP_DEV);
    }
    next();
  });
}

type LoginFailBucket = { windowStart: number; failures: number };

const loginFailBuckets = new Map<string, LoginFailBucket>();

/**
 * Counts failed login responses (HTTP 401) per client IP in a sliding window.
 * Successful logins reset the counter for that IP.
 */
export function createLoginRateLimiter(): (req: Request, res: Response, next: NextFunction) => void {
  const windowMs = 15 * 60 * 1000;
  const maxFails = Math.max(5, Math.min(200, Number(process.env.NETNODE_LOGIN_RATE_LIMIT_MAX || 40)));

  return (req: Request, res: Response, next: NextFunction) => {
    const ip = clientIp(req);
    const now = Date.now();
    let bucket = loginFailBuckets.get(ip);
    if (!bucket || now - bucket.windowStart > windowMs) {
      bucket = { windowStart: now, failures: 0 };
      loginFailBuckets.set(ip, bucket);
    }
    if (bucket.failures >= maxFails) {
      res.setHeader("Retry-After", String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ success: false, message: "Too many failed login attempts. Try again later." });
    }

    res.on("finish", () => {
      const b = loginFailBuckets.get(ip);
      if (!b) return;
      if (res.statusCode === 401) {
        b.failures += 1;
      } else if (res.statusCode < 400) {
        loginFailBuckets.delete(ip);
      }
    });

    next();
  };
}

type MutateApiBucket = { windowStart: number; count: number };

const mutatingApiBuckets = new Map<string, MutateApiBucket>();

/**
 * Sliding-window cap for mutating /api calls per client IP (POST/PUT/PATCH/DELETE).
 * GET/HEAD/OPTIONS and POST /api/auth/login are excluded (login has its own limiter).
 * Set NETNODE_API_MUTATE_RATE_DISABLED=1 to disable.
 */
export function createMutatingApiRateLimiter(): (req: Request, res: Response, next: NextFunction) => void {
  const disabled = String(process.env.NETNODE_API_MUTATE_RATE_DISABLED || "").trim() === "1";
  const windowMs = Math.max(5000, Math.min(120_000, Number(process.env.NETNODE_API_MUTATE_WINDOW_MS) || 60_000));
  const maxOps = Math.max(30, Math.min(10_000, Number(process.env.NETNODE_API_MUTATE_MAX) || 400));

  return (req: Request, res: Response, next: NextFunction) => {
    if (disabled) return next();
    if (!req.path.startsWith("/api")) return next();
    const m = req.method.toUpperCase();
    if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();
    if (req.path === "/api/auth/login") return next();

    const ip = clientIp(req);
    const now = Date.now();
    let bucket = mutatingApiBuckets.get(ip);
    if (!bucket || now - bucket.windowStart > windowMs) {
      bucket = { windowStart: now, count: 0 };
      mutatingApiBuckets.set(ip, bucket);
    }
    bucket.count += 1;
    if (bucket.count > maxOps) {
      res.setHeader("Retry-After", String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({
        error: "Too many requests. Try again later.",
        source: "api.mutate_rate_limit",
      });
    }
    next();
  };
}
