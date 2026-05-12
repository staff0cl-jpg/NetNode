import type { InventoryWarningReasonDetail } from "./warnings.js";

export type InventoryItem = {
  id: string;
  name: string;
  zoneKey?: string;
  vendor: string;
  model: string;
  category?: string;
  subcategory?: string;
  branch?: string;
  snmpTemplateId?: string;
  customOids?: string[];
  city: string;
  zone: string;
  ip: string;
  status: "online" | "offline" | "warning";
  uptime: string;
  uptimeSeconds?: number;
  warningScore?: number;
  warningSeverity?: "none" | "warning" | "critical";
  warningReasons?: string[];
  warningReasonDetails?: InventoryWarningReasonDetail[];
  cpuLoad?: number | null;
  trunkDownCount?: number;
};

export type InventoryMetaState = {
  categories: string[];
  subcategories: string[];
  branches: string[];
  cities: string[];
  zones: string[];
  vendors: string[];
  models: Record<string, string[]>;
};
