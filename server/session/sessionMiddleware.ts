import type express from "express";
import { getSessionBackend } from "./sessionRuntime.js";

/** Loads session from memory or Redis and attaches to `req.netnodeSession`. */
export function attachNetnodeSession(): (req: express.Request, res: express.Response, next: express.NextFunction) => void {
  return (req, res, next) => {
    void (async () => {
      try {
        req.netnodeSession = await getSessionBackend().read(req.headers.cookie || "");
        next();
      } catch (e) {
        next(e);
      }
    })();
  };
}
