import type express from "express";
import { formatInventoryListResponse } from "../inventory/inventoryApiView.js";
import type { InventoryItem, InventoryMetaState } from "../inventory/inventoryTypes.js";

export type InventoryRouteDeps = {
  checkRole: (roles: string[]) => (req: express.Request, res: express.Response, next: express.NextFunction) => void;
  actorName: (req: express.Request) => string;
  actorRole: (req: express.Request) => string;
  logAction: (user: string, action: string, details: string, category: string, ip?: string) => void;
  getInventory: () => InventoryItem[];
  setInventory: (next: InventoryItem[]) => void;
  inventoryMeta: InventoryMetaState;
  deriveZoneKeyFromDeviceName: (deviceName: string) => string;
  resolveDeviceZone: (name: string, fallback?: string) => string;
  deriveFcSubcategoryByName: (name: string) => string | undefined;
  upsertInventoryMetaFromItem: (item: Partial<InventoryItem>) => void;
  rebuildTopologyFromInventory: () => void;
  deleteTopologyLayoutIds: (ids: string[]) => void;
  persistPgInventoryAndTopology: (reason: string) => Promise<void>;
};

export function registerInventoryHttpRoutes(app: express.Express, d: InventoryRouteDeps): void {
  app.get("/api/inventory/meta", d.checkRole(["admin", "operator", "viewer"]), (_req, res) => {
    res.json(d.inventoryMeta);
  });

  app.post("/api/inventory/meta", d.checkRole(["admin", "operator"]), async (req, res) => {
    const body = req.body as {
      categories?: string[];
      subcategories?: string[];
      branches?: string[];
      cities?: string[];
      zones?: string[];
      vendors?: string[];
      models?: Record<string, string[]>;
    };
    if (Array.isArray(body.categories)) {
      d.inventoryMeta.categories = [...new Set(body.categories.map((v) => String(v).trim()).filter(Boolean))];
    }
    if (Array.isArray(body.subcategories)) {
      d.inventoryMeta.subcategories = [...new Set(body.subcategories.map((v) => String(v).trim()).filter(Boolean))];
    }
    if (Array.isArray(body.branches)) {
      d.inventoryMeta.branches = [...new Set(body.branches.map((v) => String(v).trim()).filter(Boolean))];
    }
    if (Array.isArray(body.cities)) {
      d.inventoryMeta.cities = [...new Set(body.cities.map((v) => String(v).trim()).filter(Boolean))];
    }
    if (Array.isArray(body.zones)) {
      d.inventoryMeta.zones = [...new Set(body.zones.map((v) => String(v).trim()).filter(Boolean))];
    }
    if (Array.isArray(body.vendors)) {
      d.inventoryMeta.vendors = [...new Set(body.vendors.map((v) => String(v).trim()).filter(Boolean))];
    }
    if (body.models && typeof body.models === "object") {
      const next: Record<string, string[]> = {};
      for (const [vendor, list] of Object.entries(body.models)) {
        next[vendor] = [...new Set((list || []).map((v) => String(v).trim()).filter(Boolean))];
      }
      d.inventoryMeta.models = next;
    }
    await d.persistPgInventoryAndTopology("inventory-meta");
    res.json({ success: true, meta: d.inventoryMeta });
  });

  app.post("/api/inventory/bulk", d.checkRole(["admin", "operator"]), async (req, res) => {
    const { ids, action } = req.body;
    const actor = d.actorName(req);

    if (!Array.isArray(ids)) return res.status(400).json({ error: "Invalid IDs" });

    if (action === "delete") {
      if (d.actorRole(req) !== "admin") {
        return res.status(403).json({ error: "Access Denied: Insufficient permissions." });
      }
      d.setInventory(d.getInventory().filter((item) => !ids.includes(item.id)));
      d.deleteTopologyLayoutIds(ids);
    } else {
      d.setInventory(
        d.getInventory().map((item) => {
          if (ids.includes(item.id)) {
            if (action === "reboot") return { ...item, status: "offline" as const, uptime: "0d 0h", uptimeSeconds: 0 };
          }
          return item;
        })
      );
    }

    d.logAction(actor, "Bulk Action", `Performed ${action} on ${ids.length} devices`, "inventory");
    await d.persistPgInventoryAndTopology("inventory-bulk");
    res.json({ success: true, count: ids.length });
  });

  app.get("/api/inventory", d.checkRole(["admin", "operator", "viewer"]), (_req, res) => {
    res.json(formatInventoryListResponse(d.getInventory(), d.deriveZoneKeyFromDeviceName));
  });

  app.post("/api/inventory", d.checkRole(["admin", "operator"]), async (req, res) => {
    const sw = req.body;
    const actor = d.actorName(req);
    const category = String(sw.category || "Switch");
    const normalizedCategory = category.toLowerCase();
    const fcSubcategory =
      normalizedCategory === "fc switch" ||
      normalizedCategory === "fibre channel switch" ||
      normalizedCategory === "fiber channel switch"
        ? d.deriveFcSubcategoryByName(String(sw.name || ""))
        : undefined;
    const newSwitch = {
      ...sw,
      id: Date.now().toString(),
      zoneKey: d.deriveZoneKeyFromDeviceName(String(sw.name || "")),
      category,
      subcategory: fcSubcategory || sw.subcategory || "Core",
      branch: sw.branch || "ULN",
      city: sw.city || "Ульяновск",
      zone: d.resolveDeviceZone(String(sw.name || ""), sw.zone || "Core"),
    } as InventoryItem;
    d.upsertInventoryMetaFromItem(newSwitch);
    d.setInventory([...d.getInventory(), newSwitch]);
    d.rebuildTopologyFromInventory();
    d.logAction(actor, "Add Device", `Registered new switch: ${newSwitch.name} (${newSwitch.ip})`, "inventory");
    await d.persistPgInventoryAndTopology("inventory-add");
    res.json(newSwitch);
  });

  app.patch("/api/inventory/:id", d.checkRole(["admin", "operator"]), async (req, res) => {
    const actor = d.actorName(req);
    const inv = d.getInventory();
    const index = inv.findIndex((s) => s.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: "Device not found" });

    const oldName = inv[index].name;
    const next = [...inv];
    next[index] = { ...next[index], ...req.body } as InventoryItem;
    next[index].zoneKey = d.deriveZoneKeyFromDeviceName(next[index].name || "");
    next[index].zone = d.resolveDeviceZone(next[index].name || "", next[index].zone);
    const cat = String(next[index].category || "").toLowerCase();
    if (cat === "fc switch" || cat === "fibre channel switch" || cat === "fiber channel switch") {
      next[index].subcategory = d.deriveFcSubcategoryByName(next[index].name || "") || next[index].subcategory;
    }
    d.upsertInventoryMetaFromItem(next[index]);
    d.setInventory(next);
    d.rebuildTopologyFromInventory();
    d.logAction(actor, "Update Device", `Updated device configurations for: ${oldName}`, "inventory");
    await d.persistPgInventoryAndTopology("inventory-patch");
    res.json(next[index]);
  });

  app.delete("/api/inventory/:id", d.checkRole(["admin"]), async (req, res) => {
    const actor = d.actorName(req);
    const sw = d.getInventory().find((s) => s.id === req.params.id);
    if (sw) {
      d.logAction(actor, "Remove Device", `Deleted switch: ${sw.name} (${sw.ip})`, "inventory");
      d.setInventory(d.getInventory().filter((s) => s.id !== req.params.id));
      d.rebuildTopologyFromInventory();
      await d.persistPgInventoryAndTopology("inventory-delete");
      res.json({ success: true });
    } else {
      res.status(404).json({ error: "Device not found" });
    }
  });
}
