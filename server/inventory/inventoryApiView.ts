import type { InventoryItem } from "./inventoryTypes.js";

/** Fast path for GET /api/inventory: no live SNMP; uses last-known fields from persistence / background refresh. */
export function formatInventoryListResponse(
  items: readonly InventoryItem[],
  deriveZoneKeyFromDeviceName: (deviceName: string) => string
): InventoryItem[] {
  return items.map((item) => ({
    ...item,
    zoneKey: deriveZoneKeyFromDeviceName(item.name || ""),
    status: item.status ?? ("offline" as const),
    warningScore: item.warningScore ?? 0,
    warningSeverity: item.warningSeverity ?? "none",
    warningReasons: item.warningReasons ?? [],
    warningReasonDetails: item.warningReasonDetails ?? [],
    cpuLoad: Number.isFinite(Number(item.cpuLoad)) ? Number(item.cpuLoad) : null,
    trunkDownCount: Number.isFinite(Number(item.trunkDownCount)) ? Number(item.trunkDownCount) : 0,
  }));
}