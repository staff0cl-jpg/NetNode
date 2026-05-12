import type { Application, Request, Response } from "express";
import { isFirstRunWizardNeeded } from "./instanceFile.js";
import type { NetNodePostgresConfig } from "./instanceFile.js";
import { executeFirstRunApply, testPostgresConnection, type FirstRunApplyBody } from "./firstRunApply.js";

export function registerFirstRunSetupRoutes(
  app: Application,
  ctx: { reloadPersistenceAfterSetup: () => Promise<void> }
): void {
  app.get("/api/setup/status", (_req: Request, res: Response) => {
    res.json({ needsSetup: isFirstRunWizardNeeded() });
  });

  app.post("/api/setup/test-db", async (req: Request, res: Response) => {
    if (!isFirstRunWizardNeeded()) {
      return res.status(403).json({ ok: false, error: "First-run setup is not available." });
    }
    const body = req.body as { postgres?: Partial<NetNodePostgresConfig> };
    const postgres: NetNodePostgresConfig = {
      host: String(body.postgres?.host || "").trim(),
      port: Number(body.postgres?.port || 5432),
      database: String(body.postgres?.database || "").trim(),
      user: String(body.postgres?.user || "").trim(),
      password: String(body.postgres?.password ?? ""),
    };
    const r = await testPostgresConnection(postgres);
    if (!r.ok) return res.status(400).json(r);
    return res.json({ ok: true });
  });

  app.post("/api/setup/apply", async (req: Request, res: Response) => {
    if (!isFirstRunWizardNeeded()) {
      return res.status(403).json({ ok: false, error: "First-run setup is not available." });
    }
    const out = await executeFirstRunApply(req.body as FirstRunApplyBody);
    if (!out.ok) return res.status(400).json(out);
    try {
      await ctx.reloadPersistenceAfterSetup();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return res.status(500).json({ ok: false, error: `Saved configuration but reload failed: ${msg}` });
    }
    return res.json({ ok: true });
  });
}
