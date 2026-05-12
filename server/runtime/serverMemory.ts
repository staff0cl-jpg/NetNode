/**
 * Process-local mutable state (not horizontally scaled unless Redis sessions + external DB).
 * Inventory and topology mirror PostgreSQL `inventory_device` / `app_kv.topology` after hydrate.
 */
import type { InventoryItem } from "../inventory/inventoryTypes.js";
import type {
  TopologyLayout,
  TopologyLink,
  TopologyMode,
  TopologySnapshot,
  TopologyZoneLabelOverrides,
} from "../topology/topologyTypes.js";

export const serverMemory = {
  inventory: [] as InventoryItem[],
  topologyLinks: [] as TopologyLink[],
  topologyLayout: {} as TopologyLayout,
  topologyLayoutScopes: { ip: {}, fc: {} } as Record<TopologyMode, Record<string, TopologyLayout>>,
  topologyZoneLabelOverridesScopes: { ip: {}, fc: {} } as Record<
    TopologyMode,
    Record<string, TopologyZoneLabelOverrides>
  >,
  topologySnapshots: [] as TopologySnapshot[],
};
