import React, { useState, useRef, useEffect } from 'react';
import { Stage, Layer, Rect, Text, Line, Circle } from 'react-konva';
import { Share2, Box, ZoomIn, ZoomOut, RotateCcw, Globe, TerminalSquare } from 'lucide-react';
import { Switch } from '../types';
import { useTranslation } from '../lib/i18n';

interface TopologyProps {
  switches: Switch[];
  role?: string;
  username?: string;
  onOpenSSH?: (sw: Switch) => void;
}

type TopoLink = { id?: string; source: string; target: string; portA: string; portB: string; manual?: boolean; renamed?: boolean };
type TopologyVersion = { id: string; createdAt: string; actor: string; reason: string; branch?: string };
type TopologyVersionPreview = {
  addedLinks: number;
  removedLinks: number;
  changedLinkLabels: number;
  movedNodes: number;
  totalCurrentLinks: number;
  totalTargetLinks: number;
};
type LinkDraft = { sourceId: string; x1: number; y1: number; x2: number; y2: number } | null;

type NodeWithPos = Switch & { x: number; y: number };
type TopologyMode = 'ip' | 'fc';

const TOPO_NODE_WIDTH = 160;
const TOPO_NODE_HEIGHT = 80;
const TOPO_LAYER_GAP = 156;
const TOPO_CLUSTER_STEP_X = 390;
const TOPO_RING_STEP = 136;

function computeLayout(switches: Switch[], links: TopoLink[], cw: number, ch: number): NodeWithPos[] {
  if (switches.length === 0) return [];
  const margin = 110;
  const byId = new Map(switches.map((s) => [s.id, s]));
  const adj = new Map<string, Set<string>>();
  const degree = new Map<string, number>();
  switches.forEach((s) => {
    adj.set(s.id, new Set());
    degree.set(s.id, 0);
  });
  links.forEach((l) => {
    if (!byId.has(l.source) || !byId.has(l.target)) return;
    adj.get(l.source)?.add(l.target);
    adj.get(l.target)?.add(l.source);
    degree.set(l.source, (degree.get(l.source) || 0) + 1);
    degree.set(l.target, (degree.get(l.target) || 0) + 1);
  });

  const lower = (v?: string) => String(v || '').trim().toLowerCase();
  const toName = (s?: Switch) => String(s?.name || '').trim().toLowerCase();
  const switchSortKey = (id: string) => `${toName(byId.get(id))}\u0000${id}`;
  const stableSort = (items: Switch[], rank: (s: Switch) => number) =>
    [...items].sort((a, b) => {
      const dr = rank(b) - rank(a);
      if (dr !== 0) return dr;
      const na = toName(a);
      const nb = toName(b);
      if (na !== nb) return na.localeCompare(nb);
      return String(a.id).localeCompare(String(b.id));
    });
  const byIdStable = (a: string, b: string) => {
    const ka = switchSortKey(a);
    const kb = switchSortKey(b);
    return ka === kb ? a.localeCompare(b) : ka.localeCompare(kb);
  };

  const isRouterLike = (s: Switch) =>
    lower(s.category) === 'router' ||
    lower(s.category) === 'маршрутизатор' ||
    lower(s.vendor) === 'mikrotik';
  const isExplicitCore = (s: Switch) =>
    lower(s.subcategory) === 'core' ||
    lower(s.vendor) === 'cisco';
  const isDistribution = (s: Switch) => lower(s.subcategory) === 'distribution';
  const isAccess = (s: Switch) =>
    lower(s.subcategory) === 'access' ||
    lower(s.vendor) === 'hpe' ||
    lower(s.vendor) === 'aruba';

  type Lane = 'router' | 'core' | 'distribution' | 'access' | 'unknown';
  const laneScore = (s: Switch) => {
    if (isRouterLike(s)) return { lane: 'router' as Lane, score: 4 };
    if (isExplicitCore(s)) return { lane: 'core' as Lane, score: 4 };
    if (isDistribution(s)) return { lane: 'distribution' as Lane, score: 4 };
    if (isAccess(s)) return { lane: 'access' as Lane, score: 4 };
    const deg = degree.get(s.id) || 0;
    if (deg <= 1) return { lane: 'unknown' as Lane, score: 1 };
    if (deg >= 5) return { lane: 'core' as Lane, score: 2 };
    if (deg >= 3) return { lane: 'distribution' as Lane, score: 2 };
    return { lane: 'access' as Lane, score: 2 };
  };
  const parentKey = (id: string, parentSet: Set<string>) => {
    const neighbors = Array.from(adj.get(id) || [])
      .filter((n) => parentSet.has(n))
      .sort(byIdStable);
    return neighbors[0] || `~${id}`;
  };

  const trunkThreshold = Math.max(3, Math.ceil(Math.sqrt(Math.max(2, switches.length)) * 1.4));
  const isTrunkRich = (s: Switch) => (degree.get(s.id) || 0) >= trunkThreshold;

  const rankedAll = stableSort(switches, (s) => degree.get(s.id) || 0);
  const laneMap = new Map<string, Lane>();
  rankedAll.forEach((s) => laneMap.set(s.id, laneScore(s).lane));

  type ComponentInfo = {
    id: string;
    nodes: Switch[];
    nodeIds: Set<string>;
    edgeCount: number;
    maxDegree: number;
    hasRouter: boolean;
    hasExplicitCore: boolean;
    isSpider: boolean;
  };

  const components: ComponentInfo[] = [];
  const visited = new Set<string>();
  const sortedIds = switches.map((s) => s.id).sort(byIdStable);
  sortedIds.forEach((startId) => {
    if (visited.has(startId)) return;
    const queue = [startId];
    const nodeIds = new Set<string>();
    visited.add(startId);
    while (queue.length) {
      const current = queue.shift()!;
      nodeIds.add(current);
      Array.from(adj.get(current) || []).sort(byIdStable).forEach((next) => {
        if (visited.has(next)) return;
        visited.add(next);
        queue.push(next);
      });
    }
    const nodes = stableSort(
      Array.from(nodeIds).map((id) => byId.get(id)).filter((s): s is Switch => !!s),
      (s) => degree.get(s.id) || 0
    );
    const edgeCount = links.filter((l) => nodeIds.has(l.source) && nodeIds.has(l.target)).length;
    const maxDegree = nodes.reduce((max, n) => Math.max(max, degree.get(n.id) || 0), 0);
    const hasRouter = nodes.some(isRouterLike);
    const hasExplicitCore = nodes.some((n) => !isRouterLike(n) && isExplicitCore(n));
    const leafCount = nodes.filter((n) => (degree.get(n.id) || 0) <= 1).length;
    components.push({
      id: nodes[0]?.id || startId,
      nodes,
      nodeIds,
      edgeCount,
      maxDegree,
      hasRouter,
      hasExplicitCore,
      isSpider: nodes.length >= 5 && (maxDegree >= nodes.length - 2 || leafCount / nodes.length >= 0.68),
    });
  });

  const componentRank = (c: ComponentInfo) =>
    (c.hasRouter ? 9000 : 0) +
    (c.hasExplicitCore ? 7000 : 0) +
    c.edgeCount * 90 +
    c.nodes.length * 30 +
    c.maxDegree * 10 -
    (c.isSpider && !c.hasExplicitCore && !c.hasRouter ? 500 : 0);

  components.sort((a, b) => {
    const dr = componentRank(b) - componentRank(a);
    if (dr !== 0) return dr;
    if (a.nodes.length !== b.nodes.length) return b.nodes.length - a.nodes.length;
    return switchSortKey(a.id).localeCompare(switchSortKey(b.id));
  });

  const primaryComponent = components[0];
  const primaryIds = primaryComponent?.nodeIds || new Set<string>();
  const primaryNodes = primaryComponent?.nodes || [];
  const secondaryComponents = components.slice(1).sort((a, b) => {
    if (a.isSpider !== b.isSpider) return a.isSpider ? -1 : 1;
    if (a.nodes.length !== b.nodes.length) return b.nodes.length - a.nodes.length;
    if (a.edgeCount !== b.edgeCount) return b.edgeCount - a.edgeCount;
    return switchSortKey(a.id).localeCompare(switchSortKey(b.id));
  });

  let sourceCores = stableSort(
    primaryNodes.filter((s) => !isRouterLike(s) && isExplicitCore(s)),
    (s) => degree.get(s.id) || 0
  );
  if (!sourceCores.length) {
    sourceCores = stableSort(
      primaryNodes.filter((s) => !isRouterLike(s) && !isDistribution(s) && !isAccess(s) && isTrunkRich(s)),
      (s) => degree.get(s.id) || 0
    );
  }
  if (!sourceCores.length && primaryNodes.length) {
    const inferredCore = stableSort(primaryNodes.filter((s) => !isRouterLike(s)), (s) => degree.get(s.id) || 0)[0] || primaryNodes[0];
    sourceCores = inferredCore ? [inferredCore] : [];
  }

  const coreIds = new Set(sourceCores.map((c) => c.id));
  sourceCores.forEach((core) => laneMap.set(core.id, 'core'));
  const routers = stableSort(primaryNodes.filter((s) => isRouterLike(s) && !coreIds.has(s.id)), (s) => degree.get(s.id) || 0);

  const laneOrder: Lane[] = ['router', 'core', 'distribution', 'access', 'unknown'];
  const laneGapX = TOPO_NODE_WIDTH + 54;
  const primaryLaneCounts = new Map<Lane, number>();
  laneOrder.forEach((lane) => primaryLaneCounts.set(lane, 0));
  primaryNodes.forEach((node) => {
    const lane = laneMap.get(node.id) || 'unknown';
    primaryLaneCounts.set(lane, (primaryLaneCounts.get(lane) || 0) + 1);
  });
  const maxPrimaryLane = Math.max(1, ...Array.from(primaryLaneCounts.values()));
  const islandColumns = secondaryComponents.length ? Math.min(3, secondaryComponents.length) : 0;
  const islandRows = islandColumns ? Math.ceil(secondaryComponents.length / islandColumns) : 0;
  const primaryWidth = Math.max(
    980,
    maxPrimaryLane * laneGapX + 280,
    Math.max(1, sourceCores.length) * TOPO_CLUSTER_STEP_X + 240
  );
  const islandStartX = margin + primaryWidth + 280;
  const islandColumnWidth = 430;
  const islandRowHeight = 276;
  const width = Math.max(
    1480,
    Math.floor(cw * 1.42),
    islandStartX + islandColumns * islandColumnWidth + margin
  );
  const height = Math.max(
    980,
    Math.floor(ch * 1.36),
    margin + TOPO_LAYER_GAP * 4 + islandRows * islandRowHeight + 120
  );
  const rightLimit = width - TOPO_NODE_WIDTH - 26;
  const bottomLimit = height - TOPO_NODE_HEIGHT - 24;
  const pos = new Map<string, { x: number; y: number }>();

  const owners = new Map<string, string>();
  const dist = new Map<string, number>();
  const queue: string[] = [];
  sourceCores.forEach((c) => {
    owners.set(c.id, c.id);
    dist.set(c.id, 0);
    queue.push(c.id);
  });
  while (queue.length) {
    const u = queue.shift()!;
    for (const v of Array.from(adj.get(u) || []).sort(byIdStable)) {
      if (!primaryIds.has(v)) continue;
      const cand = (dist.get(u) || 0) + 1;
      const cur = dist.get(v);
      if (cur === undefined || cand < cur) {
        dist.set(v, cand);
        owners.set(v, owners.get(u)!);
        queue.push(v);
      } else if (cand === cur) {
        const currentOwner = owners.get(v) || '';
        const nextOwner = owners.get(u) || '';
        if (nextOwner.localeCompare(currentOwner) < 0) owners.set(v, nextOwner);
      }
    }
  }

  const fallbackCore = sourceCores[0];
  primaryNodes.forEach((s) => {
    if (owners.has(s.id) || !fallbackCore) return;
    owners.set(s.id, fallbackCore.id);
  });

  const unknownIds = new Set<string>();
  primaryNodes.forEach((s) => {
    const meta = laneScore(s);
    if (meta.lane === 'unknown' || meta.score <= 1) unknownIds.add(s.id);
  });

  const coreClusterMap = new Map<string, Switch[]>();
  sourceCores.forEach((c) => coreClusterMap.set(c.id, [c]));
  stableSort(primaryNodes, (s) => degree.get(s.id) || 0).forEach((s) => {
    if (coreIds.has(s.id) || unknownIds.has(s.id)) return;
    const owner = owners.get(s.id);
    if (!owner) {
      unknownIds.add(s.id);
      return;
    }
    const lane = laneMap.get(s.id) || 'unknown';
    if (lane === 'unknown') {
      unknownIds.add(s.id);
      return;
    }
    if (!coreClusterMap.has(owner)) coreClusterMap.set(owner, []);
    coreClusterMap.get(owner)!.push(s);
  });

  if (!sourceCores.length) {
    const hasRouter = primaryNodes.some(isRouterLike);
    const baseY = margin;
    const laneY = new Map<Lane, number>([
      ['router', baseY],
      ['core', baseY + (hasRouter ? TOPO_LAYER_GAP : 0)],
      ['distribution', baseY + (hasRouter ? TOPO_LAYER_GAP : 0) + TOPO_LAYER_GAP],
      ['access', baseY + (hasRouter ? TOPO_LAYER_GAP : 0) + TOPO_LAYER_GAP * 2],
      ['unknown', Math.min(bottomLimit, baseY + (hasRouter ? TOPO_LAYER_GAP : 0) + TOPO_LAYER_GAP * 3 + 48)],
    ]);
    const itemsByLane = new Map<Lane, Switch[]>();
    laneOrder.forEach((lane) => itemsByLane.set(lane, []));
    stableSort(primaryNodes, (s) => degree.get(s.id) || 0).forEach((s) => {
      const lane = laneMap.get(s.id) || 'unknown';
      itemsByLane.get(lane)?.push(s);
    });
    laneOrder.forEach((lane) => {
      const laneItems = itemsByLane.get(lane) || [];
      laneItems.forEach((s, idx) => {
        const row = Math.floor(idx / 6);
        const col = idx % 6;
        const laneBaseY = laneY.get(lane) || baseY;
        pos.set(s.id, {
          x: margin + col * laneGapX,
          y: laneBaseY + row * (TOPO_NODE_HEIGHT + 18),
        });
      });
    });
  } else {
    const hasRouterLayer = routers.length > 0;
    const yRouter = margin;
    const yCore = margin + (hasRouterLayer ? TOPO_LAYER_GAP : 0);
    const yDist = yCore + TOPO_LAYER_GAP;
    const yAccess = yDist + TOPO_LAYER_GAP;
    const yUnknown = Math.min(bottomLimit, yAccess + TOPO_LAYER_GAP + 30);
    const laneY = new Map<Lane, number>([
      ['router', yRouter],
      ['core', yCore],
      ['distribution', yDist],
      ['access', yAccess],
      ['unknown', yUnknown],
    ]);

    const left = margin;
    const availableWidth = primaryWidth;
    const sortedCores = [...sourceCores].sort((a, b) => {
      const aRouterHits = Array.from(adj.get(a.id) || []).filter((id) => routers.some((r) => r.id === id)).length;
      const bRouterHits = Array.from(adj.get(b.id) || []).filter((id) => routers.some((r) => r.id === id)).length;
      if (aRouterHits !== bRouterHits) return bRouterHits - aRouterHits;
      const aClusterSize = (coreClusterMap.get(a.id) || []).length;
      const bClusterSize = (coreClusterMap.get(b.id) || []).length;
      if (aClusterSize !== bClusterSize) return bClusterSize - aClusterSize;
      const da = degree.get(a.id) || 0;
      const db = degree.get(b.id) || 0;
      if (da !== db) return db - da;
      const na = toName(a);
      const nb = toName(b);
      if (na !== nb) return na.localeCompare(nb);
      return String(a.id).localeCompare(String(b.id));
    });
    const coreStep = sortedCores.length === 1 ? 0 : availableWidth / (sortedCores.length - 1);
    sortedCores.forEach((core, idx) => {
      const x = sortedCores.length === 1
        ? left + availableWidth / 2
        : left + idx * coreStep;
      pos.set(core.id, { x, y: yCore });
    });

    const routerTargets = stableSort(routers, (s) => degree.get(s.id) || 0);
    routerTargets.forEach((r, idx) => {
      const neighbors = Array.from(adj.get(r.id) || []).filter((id) => coreIds.has(id)).sort(byIdStable);
      const anchorCore = neighbors[0] || sortedCores[idx % sortedCores.length]?.id || sortedCores[0]?.id;
      const baseX = pos.get(anchorCore || '')?.x || left + availableWidth / 2;
      const spread = Math.floor(idx / Math.max(1, sortedCores.length));
      pos.set(r.id, { x: baseX + (spread - 0.5) * 136, y: yRouter });
    });

    sortedCores.forEach((core, coreIdx) => {
      const coreX = pos.get(core.id)?.x || left + availableWidth / 2;
      const members = (coreClusterMap.get(core.id) || []).filter((n) => n.id !== core.id);
      const clusterDist = stableSort(
        members.filter((s) => {
          if (unknownIds.has(s.id)) return false;
          const lane = laneMap.get(s.id) || 'unknown';
          return lane === 'distribution';
        }),
        (s) => degree.get(s.id) || 0
      );
      const clusterAccess = stableSort(
        members.filter((s) => {
          if (unknownIds.has(s.id)) return false;
          const lane = laneMap.get(s.id) || 'unknown';
          return lane === 'access';
        }),
        (s) => degree.get(s.id) || 0
      );
      const residue = members.filter((s) => !clusterDist.some((d) => d.id === s.id) && !clusterAccess.some((a) => a.id === s.id));
      residue.forEach((r) => unknownIds.add(r.id));

      const clusterDistIds = new Set(clusterDist.map((d) => d.id));
      const accessByDist = new Map<string, Switch[]>();
      const distParentSet = new Set<string>([core.id, ...routers.map((r) => r.id), ...sortedCores.map((c) => c.id)]);
      const orderedDist = [...clusterDist].sort((a, b) => {
        const pa = parentKey(a.id, distParentSet);
        const pb = parentKey(b.id, distParentSet);
        if (pa !== pb) return pa.localeCompare(pb);
        const da = degree.get(a.id) || 0;
        const db = degree.get(b.id) || 0;
        if (da !== db) return db - da;
        const na = toName(a);
        const nb = toName(b);
        if (na !== nb) return na.localeCompare(nb);
        return String(a.id).localeCompare(String(b.id));
      });

      const slotLeft = sortedCores.length === 1 ? left : left + (coreIdx / sortedCores.length) * availableWidth;
      const slotRight = sortedCores.length === 1 ? left + availableWidth : left + ((coreIdx + 1) / sortedCores.length) * availableWidth;
      const slotWidth = Math.max(TOPO_NODE_WIDTH, slotRight - slotLeft);
      const distStep = Math.max(TOPO_RING_STEP, Math.min(laneGapX, slotWidth / Math.max(1, orderedDist.length)));
      orderedDist.forEach((d, idx) => {
        const offset = (idx - (orderedDist.length - 1) / 2) * distStep;
        pos.set(d.id, { x: coreX + offset, y: yDist });
      });

      clusterAccess.forEach((a) => {
        const candidates = Array.from(adj.get(a.id) || []).filter((id) => clusterDistIds.has(id)).sort(byIdStable);
        const parent = candidates[0] || `~${core.id}`;
        if (!accessByDist.has(parent)) accessByDist.set(parent, []);
        accessByDist.get(parent)!.push(a);
      });

      const distOrder = orderedDist.map((d) => d.id);
      const accessOrdered = [...clusterAccess].sort((a, b) => {
        const pa = accessByDist.has(parentKey(a.id, clusterDistIds)) ? parentKey(a.id, clusterDistIds) : '~';
        const pb = accessByDist.has(parentKey(b.id, clusterDistIds)) ? parentKey(b.id, clusterDistIds) : '~';
        const ia = distOrder.indexOf(pa);
        const ib = distOrder.indexOf(pb);
        if (ia !== ib) return ia - ib;
        const da = degree.get(a.id) || 0;
        const db = degree.get(b.id) || 0;
        if (da !== db) return db - da;
        const na = toName(a);
        const nb = toName(b);
        if (na !== nb) return na.localeCompare(nb);
        return String(a.id).localeCompare(String(b.id));
      });

      const placedAccess = new Set<string>();
      orderedDist.forEach((d) => {
        const group = accessOrdered.filter((a) => {
          if (placedAccess.has(a.id)) return false;
          const parents = Array.from(adj.get(a.id) || []).filter((id) => clusterDistIds.has(id)).sort(byIdStable);
          return (parents[0] || '') === d.id;
        });
        const step = TOPO_NODE_WIDTH + 30;
        group.forEach((a, idx) => {
          const offset = (idx - (group.length - 1) / 2) * step;
          const base = pos.get(d.id)?.x || coreX;
          const row = Math.floor(idx / 8);
          pos.set(a.id, { x: base + offset, y: yAccess + row * (TOPO_NODE_HEIGHT + 18) });
          placedAccess.add(a.id);
        });
      });
      accessOrdered.forEach((a, idx) => {
        if (placedAccess.has(a.id)) return;
        const fallbackOffset = (idx - (accessOrdered.length - 1) / 2) * (TOPO_NODE_WIDTH + 24);
        pos.set(a.id, { x: coreX + fallbackOffset, y: yAccess });
      });
    });

    const unknownNodes = stableSort(
      primaryNodes.filter((s) => unknownIds.has(s.id) || !pos.has(s.id)),
      (s) => degree.get(s.id) || 0
    );
    const unknownStartX = margin;
    unknownNodes.forEach((n, idx) => {
      const col = idx % 6;
      const row = Math.floor(idx / 6);
      pos.set(n.id, {
        x: unknownStartX + col * laneGapX,
        y: laneY.get('unknown')! + row * (TOPO_NODE_HEIGHT + 18),
      });
    });
  }

  const placeRow = (items: Switch[], baseX: number, y: number, maxColumns: number) => {
    const step = TOPO_NODE_WIDTH + 30;
    const columns = Math.max(1, Math.min(maxColumns, items.length));
    items.forEach((item, idx) => {
      const row = Math.floor(idx / columns);
      const col = idx % columns;
      const rowItems = Math.min(columns, items.length - row * columns);
      const rowWidth = (rowItems - 1) * step;
      pos.set(item.id, {
        x: baseX - rowWidth / 2 + col * step,
        y: y + row * (TOPO_NODE_HEIGHT + 18),
      });
    });
  };

  secondaryComponents.forEach((component, idx) => {
    const col = islandColumns ? idx % islandColumns : 0;
    const row = islandColumns ? Math.floor(idx / islandColumns) : 0;
    const baseX = islandStartX + col * islandColumnWidth + islandColumnWidth / 2 - TOPO_NODE_WIDTH / 2;
    const baseY = margin + row * islandRowHeight;
    const ordered = stableSort(component.nodes, (s) => degree.get(s.id) || 0);
    const hubs = ordered.filter((s) => isRouterLike(s) || isExplicitCore(s) || (degree.get(s.id) || 0) === component.maxDegree);
    const hub = hubs[0] || ordered[0];
    if (!hub) return;
    const hubLane = isRouterLike(hub) ? 'router' : 'core';
    laneMap.set(hub.id, hubLane);
    pos.set(hub.id, { x: baseX, y: baseY });

    const rest = ordered.filter((s) => s.id !== hub.id);
    const middle = rest.filter((s) => isDistribution(s) || (degree.get(s.id) || 0) > 1);
    const leaves = rest.filter((s) => !middle.some((m) => m.id === s.id));
    middle.forEach((s) => laneMap.set(s.id, 'distribution'));
    leaves.forEach((s) => laneMap.set(s.id, 'access'));
    placeRow(middle, baseX, baseY + 118, 3);
    placeRow(leaves, baseX, baseY + (middle.length ? 224 : 118), 4);
  });

  const points = switches.map((s) => {
    const p = pos.get(s.id) || { x: width / 2, y: height / 2 };
    return { id: s.id, x: p.x, y: p.y, lane: (laneMap.get(s.id) || 'unknown') as Lane };
  });
  const laneIdx = new Map<Lane, number>(laneOrder.map((lane, idx) => [lane, idx]));
  const laneNodes = new Map<Lane, { id: string; x: number; y: number; lane: Lane }[]>();
  laneOrder.forEach((lane) => laneNodes.set(lane, []));
  points
    .filter((p) => primaryIds.has(p.id) && p.lane !== 'unknown')
    .forEach((p) => laneNodes.get(p.lane)?.push(p));
  const idToPoint = new Map(points.map((p) => [p.id, p]));
  const byLaneEdges = new Map<number, Array<{ a: string; b: string }>>();
  links.forEach((l) => {
    const a = idToPoint.get(l.source);
    const b = idToPoint.get(l.target);
    if (!a || !b) return;
    if (!primaryIds.has(a.id) || !primaryIds.has(b.id)) return;
    const ai = laneIdx.get(a.lane) ?? 0;
    const bi = laneIdx.get(b.lane) ?? 0;
    if (Math.abs(ai - bi) !== 1) return;
    const low = Math.min(ai, bi);
    const edge = ai < bi ? { a: a.id, b: b.id } : { a: b.id, b: a.id };
    if (!byLaneEdges.has(low)) byLaneEdges.set(low, []);
    byLaneEdges.get(low)!.push(edge);
  });

  const anchorX = new Map<string, number>(points.map((p) => [p.id, p.x]));
  const nodeHalf = TOPO_NODE_WIDTH / 2;
  const median = (nums: number[]) => {
    if (!nums.length) return 0;
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const resolveLane = (lane: Lane) => {
    const lanePoints = [...(laneNodes.get(lane) || [])].sort((a, b) => (a.x - b.x) || a.id.localeCompare(b.id));
    for (let i = 1; i < lanePoints.length; i++) {
      const prev = lanePoints[i - 1];
      const cur = lanePoints[i];
      const minX = prev.x + laneGapX;
      if (cur.x < minX) cur.x = minX;
    }
    const maxRight = Math.min(rightLimit - nodeHalf, margin + primaryWidth - nodeHalf);
    const minLeft = 35 + nodeHalf;
    let shift = 0;
    if (lanePoints.length) {
      const leftMost = lanePoints[0].x;
      const rightMost = lanePoints[lanePoints.length - 1].x;
      if (rightMost > maxRight) shift = maxRight - rightMost;
      if (leftMost + shift < minLeft) shift = minLeft - leftMost;
      lanePoints.forEach((p) => {
        p.x = Math.min(maxRight, Math.max(minLeft, p.x + shift));
      });
    }
    laneNodes.set(lane, lanePoints);
  };
  laneOrder.filter((lane) => lane !== 'unknown').forEach(resolveLane);

  for (let iter = 0; iter < 6; iter++) {
    const passOrder = iter % 2 === 0 ? laneOrder.filter((lane) => lane !== 'unknown') : laneOrder.filter((lane) => lane !== 'unknown').reverse();
    passOrder.forEach((lane) => {
      const idx = laneIdx.get(lane) ?? 0;
      const lanePoints = laneNodes.get(lane) || [];
      const targetX = new Map<string, number>();
      lanePoints.forEach((p) => {
        const neighbors: number[] = [];
        const upEdges = byLaneEdges.get(idx - 1) || [];
        const downEdges = byLaneEdges.get(idx) || [];
        upEdges.forEach((e) => {
          if (e.b === p.id) {
            const src = idToPoint.get(e.a);
            if (src) neighbors.push(src.x);
          }
        });
        downEdges.forEach((e) => {
          if (e.a === p.id) {
            const dst = idToPoint.get(e.b);
            if (dst) neighbors.push(dst.x);
          }
        });
        const base = anchorX.get(p.id) ?? p.x;
        targetX.set(p.id, neighbors.length ? median(neighbors) * 0.72 + base * 0.28 : base);
      });
      lanePoints
        .sort((a, b) => {
          const ax = targetX.get(a.id) ?? a.x;
          const bx = targetX.get(b.id) ?? b.x;
          if (ax !== bx) return ax - bx;
          return a.id.localeCompare(b.id);
        })
        .forEach((p, order) => {
          const tx = targetX.get(p.id) ?? p.x;
          const leftBound = 35 + nodeHalf + order * laneGapX;
          p.x = Math.max(tx, leftBound);
        });
      resolveLane(lane);
    });
  }

  return switches.map((s) => {
    const p = idToPoint.get(s.id) || { x: width / 2, y: height / 2, lane: 'unknown' as Lane };
    return {
      ...s,
      x: Math.min(rightLimit, Math.max(35, p.x)),
      y: Math.min(bottomLimit, Math.max(35, p.y)),
    };
  });
}

function topologyScopeQuery(topologyMode: TopologyMode, branch?: string) {
  const params = new URLSearchParams({ topologyMode });
  if (branch) params.set('branch', branch);
  const query = params.toString();
  return query ? `?${query}` : '';
}

const Topology: React.FC<TopologyProps> = ({ switches, role, username, onOpenSSH }) => {
  const { t } = useTranslation();
  const canEditTopology = role === 'admin' || role === 'operator';
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<any>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });
  const [links, setLinks] = useState<TopoLink[]>([]);
  const [nodes, setNodes] = useState<NodeWithPos[]>([]);
  const [savedLayout, setSavedLayout] = useState<Record<string, { x: number; y: number }>>({});
  const [scale, setScale] = useState(0.82);
  const [stagePos, setStagePos] = useState({ x: 20, y: 20 });
  const [contextMenu, setContextMenu] = useState<{ node: Switch; x: number; y: number } | null>(null);
  const [isRightPanning, setIsRightPanning] = useState(false);
  const [isNodeDragging, setIsNodeDragging] = useState(false);
  const panLastPointRef = useRef<{ x: number; y: number } | null>(null);
  const suppressNodeContextMenuRef = useRef(false);
  const draftLinkStartedAtRef = useRef(0);
  const [topologyMode, setTopologyMode] = useState<TopologyMode>('ip');
  const [selectedRegion, setSelectedRegion] = useState<string>('');
  const [newRegion, setNewRegion] = useState('');
  const [regionEditor, setRegionEditor] = useState({ from: '', to: '' });
  const [manualLink, setManualLink] = useState({ source: '', target: '', portA: '', portB: '' });
  const [editingRegion, setEditingRegion] = useState<string | null>(null);
  const [editingRegionValue, setEditingRegionValue] = useState('');
  const [editingLinkId, setEditingLinkId] = useState<string | null>(null);
  const [editingLinkValue, setEditingLinkValue] = useState<{ comment: string }>({ comment: '' });
  const [topologyVersionCount, setTopologyVersionCount] = useState(0);
  const [topologyVersions, setTopologyVersions] = useState<TopologyVersion[]>([]);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string>('');
  const [versionPreview, setVersionPreview] = useState<TopologyVersionPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [linkDraft, setLinkDraft] = useState<LinkDraft>(null);
  const topologySwitches = React.useMemo(() => {
    const ipAllowed = new Set(['switch', 'router', 'коммутатор', 'маршрутизатор']);
    const fcAllowed = new Set(['fc switch', 'fibre channel switch', 'fiber channel switch', 'fc коммутатор']);
    return switches.filter((s) => {
      const category = String(s.category || '').trim().toLowerCase();
      return topologyMode === 'fc' ? fcAllowed.has(category) : ipAllowed.has(category);
    });
  }, [switches, topologyMode]);
  const regions = React.useMemo(() => {
    const set = new Set<string>();
    topologySwitches.forEach((s) => {
      const r = String(s.branch || '').trim();
      if (r) set.add(r);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [topologySwitches]);
  useEffect(() => {
    if (!regions.length) {
      if (selectedRegion !== '') setSelectedRegion('');
      return;
    }
    if (!selectedRegion || !regions.includes(selectedRegion)) {
      setSelectedRegion(regions[0]);
    }
  }, [regions, selectedRegion]);
  const regionSwitches = React.useMemo(
    () => topologySwitches.filter((s) => (selectedRegion ? (s.branch || '') === selectedRegion : false)),
    [topologySwitches, selectedRegion]
  );
  const topologySwitchIds = React.useMemo(() => new Set(regionSwitches.map((s) => s.id)), [regionSwitches]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/topology/links${topologyScopeQuery(topologyMode, selectedRegion || undefined)}`, {
          headers: {
            'x-user-role': role || 'viewer',
            'x-user-name': username || 'unknown'
          }
        });
        const data: { links: TopoLink[]; layout?: Record<string, { x: number; y: number }> } = await response.json();
        if (!cancelled) {
          setLinks(data.links || []);
          setSavedLayout(data.layout || {});
        }
      } catch (error) {
        console.error('Failed to fetch topology links:', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [topologyMode, selectedRegion, role, username]);

  const refreshTopologyVersions = React.useCallback(async () => {
    try {
      const response = await fetch('/api/topology/versions', {
        headers: {
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown'
        }
      });
      if (!response.ok) return;
      const data = await response.json();
      const versions = Array.isArray(data?.versions) ? (data.versions as TopologyVersion[]) : [];
      setTopologyVersions(versions);
      setTopologyVersionCount(Number(data?.total || versions.length || 0));
    } catch {
      // ignore
    }
  }, [role, username]);

  useEffect(() => {
    refreshTopologyVersions();
  }, [refreshTopologyVersions]);
  const latestVersion = topologyVersions[0] || null;

  const loadVersionPreview = React.useCallback(async (versionId: string) => {
    if (!versionId) return;
    try {
      setPreviewLoading(true);
      const query = topologyScopeQuery(topologyMode, selectedRegion || undefined);
      const response = await fetch(`/api/topology/versions/${encodeURIComponent(versionId)}/preview${query}`, {
        headers: {
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown'
        }
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || t('topologyPreviewFailed'));
      setVersionPreview(data?.summary || null);
    } catch (error) {
      alert(error instanceof Error ? error.message : t('topologyPreviewFailed'));
    } finally {
      setPreviewLoading(false);
    }
  }, [role, username, selectedRegion, topologyMode, t]);

  const handleRestoreSelectedVersion = React.useCallback(async () => {
    if (!canEditTopology) return;
    if (!selectedVersionId) {
      alert(t('topologySelectVersionFirst'));
      return;
    }
    try {
      setRestoreLoading(true);
      const response = await fetch('/api/topology/restore', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown'
        },
        body: JSON.stringify({ versionId: selectedVersionId, branch: selectedRegion || undefined, topologyMode }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || t('topologyRestoreFailed'));
      setLinks(data?.links || []);
      setSavedLayout(data?.layout || {});
      setVersionPreview(null);
      setSelectedVersionId('');
      refreshTopologyVersions();
      setVersionsOpen(false);
    } catch (error) {
      alert(error instanceof Error ? error.message : t('topologyRestoreFailed'));
    } finally {
      setRestoreLoading(false);
    }
  }, [canEditTopology, role, username, selectedVersionId, selectedRegion, topologyMode, refreshTopologyVersions, t]);

  useEffect(() => {
    const w = containerRef.current?.offsetWidth || canvasSize.width;
    const h = containerRef.current?.offsetHeight || canvasSize.height;
    const visibleLinks = links.filter((l) => topologySwitchIds.has(l.source) && topologySwitchIds.has(l.target));
    const timer = window.setTimeout(() => {
      const computed = computeLayout(regionSwitches, visibleLinks, w, h);
      setNodes(
        computed.map((n) => {
          const saved = savedLayout[n.id];
          return saved ? { ...n, x: saved.x, y: saved.y } : n;
        })
      );
    }, 80);
    return () => window.clearTimeout(timer);
  }, [regionSwitches, topologySwitchIds, links, canvasSize.width, canvasSize.height, savedLayout]);

  const handleAutoLayout = async () => {
    if (!canEditTopology) return;
    if (!selectedRegion) {
      alert(t('topologySelectTabFirst'));
      return;
    }
    try {
      if (topologyMode !== 'fc') {
        const rebuild = await fetch('/api/topology/links/rebuild', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-user-role': role || 'viewer',
            'x-user-name': username || 'unknown'
          },
          body: JSON.stringify({ branch: selectedRegion, topologyMode }),
        });
        if (!rebuild.ok) {
          const err = await rebuild.json().catch(() => null);
          console.warn('Topology rebuild failed, using existing links', err?.error || '');
        }
      }
      const response = await fetch(`/api/topology/links${topologyScopeQuery(topologyMode, selectedRegion || undefined)}`, {
        headers: {
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown'
        }
      });
      if (!response.ok) throw new Error('Topology load failed');
      const data: { links: TopoLink[]; layout?: Record<string, { x: number; y: number }> } = await response.json();
      setLinks(data.links || []);
      setSavedLayout(data.layout || {});
      refreshTopologyVersions();

      // After rebuilding topology for this tab, classify inventory subcategories by trunk count (SNMP).
      if (topologyMode !== 'fc') {
        try {
          await fetch('/api/topology/classify-subcategories', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-user-role': role || 'viewer',
              'x-user-name': username || 'unknown'
            },
            body: JSON.stringify({ branch: selectedRegion })
          });
        } catch {
          // ignore classification errors
        }
      }
      const w = containerRef.current?.offsetWidth || canvasSize.width;
      const h = containerRef.current?.offsetHeight || canvasSize.height;
      const visibleLinks = (data.links || []).filter((l) => topologySwitchIds.has(l.source) && topologySwitchIds.has(l.target));
      const computed = computeLayout(regionSwitches, visibleLinks, w, h);
      // Auto-layout must take precedence over previously saved coordinates for this active tab.
      setNodes(computed);
      const nextPositions = computed.reduce<Record<string, { x: number; y: number }>>((acc, n) => {
        acc[n.id] = { x: n.x, y: n.y };
        return acc;
      }, {});
      setSavedLayout(nextPositions);
      try {
        await fetch('/api/topology/layout', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-user-role': role || 'viewer',
            'x-user-name': username || 'unknown'
          },
          body: JSON.stringify({ positions: nextPositions, branch: selectedRegion || undefined, topologyMode, replace: true }),
        });
      } catch {
        // ignore layout persistence errors on auto-layout
      }
    } catch (error) {
      console.error('Failed to refresh topology:', error);
      alert(error instanceof Error ? error.message : 'Failed to refresh topology');
    }
  };

  const handleUndoLastTopologyChange = async () => {
    if (!canEditTopology) return;
    if (!selectedRegion) {
      alert(t('topologySelectTabFirst'));
      return;
    }
    try {
      const response = await fetch('/api/topology/undo', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown'
        },
        body: JSON.stringify({ branch: selectedRegion, topologyMode }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || 'Failed to undo topology change');
      }
      setLinks(data?.links || []);
      setSavedLayout(data?.layout || {});
      refreshTopologyVersions();
    } catch (error) {
      alert(error instanceof Error ? error.message : t('topologyUndoFailed'));
    }
  };

  useEffect(() => {
    if (!containerRef.current) return;
    const updateDimensions = () => {
      if (containerRef.current) {
        setCanvasSize({
          width: containerRef.current.offsetWidth || 800,
          height: containerRef.current.offsetHeight || 600,
        });
      }
    };
    updateDimensions();
    const observer = new ResizeObserver((entries) => {
      if (!entries?.length) return;
      const entry = entries[0];
      if (entry.contentRect) {
        setCanvasSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    observer.observe(containerRef.current);
    window.addEventListener('resize', updateDimensions);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateDimensions);
    };
  }, []);

  const handleDragEnd = async (id: string, e: { target: { x: () => number; y: () => number } }) => {
    const x = e.target.x();
    const y = e.target.y();
    setNodes((prev) =>
      prev.map((node) =>
        node.id === id ? { ...node, x, y } : node
      )
    );
    setSavedLayout((prev) => ({ ...prev, [id]: { x, y } }));
    try {
      await fetch('/api/topology/layout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown'
        },
        body: JSON.stringify({ positions: { [id]: { x, y } }, branch: selectedRegion || undefined, topologyMode }),
      });
    } catch (error) {
      console.error('Failed to save layout:', error);
    }
  };

  const getNodeCenter = (id: string) => {
    const node = nodes.find((n) => n.id === id);
    if (!node) return { x: 0, y: 0 };
    return { x: node.x + 80, y: node.y + 40 };
  };

  const toStageCoords = (clientX: number, clientY: number) => {
    const rect = stageRef.current?.container()?.getBoundingClientRect?.();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - stagePos.x) / scale,
      y: (clientY - rect.top - stagePos.y) / scale,
    };
  };

  const createManualLink = async (source: string, target: string, comment?: string) => {
    if (!canEditTopology) return;
    if (!source || !target || source === target) return;
    try {
      const isFcMode = topologyMode === 'fc';
      const res = await fetch('/api/topology/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source,
          target,
          portA: String(comment || '').trim() || t('topologyLinkCommentDefault'),
          portB: '',
          topologyMode,
          allowDuplicate: isFcMode,
          branch: selectedRegion || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok && Array.isArray(data.links)) {
        setLinks(data.links);
        refreshTopologyVersions();
      }
    } catch (error) {
      console.error('Failed to add link:', error);
    }
  };

  const handleDeleteLink = async (link: TopoLink) => {
    if (!canEditTopology) return;
    try {
      const res = await fetch('/api/topology/links', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...link, branch: selectedRegion || undefined }),
      });
      const data = await res.json();
      if (res.ok && Array.isArray(data.links)) {
        setLinks(data.links);
        refreshTopologyVersions();
      }
    } catch (error) {
      console.error('Failed to delete link:', error);
    }
  };

  const handleRenameLink = async (link: TopoLink, nextComment: string) => {
    if (!canEditTopology) return;
    const nextPortA = String(nextComment || '').trim();
    try {
      const res = await fetch('/api/topology/links/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...link,
          newPortA: nextPortA || t('topologyLinkCommentDefault'),
          newPortB: '',
          branch: selectedRegion || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok && Array.isArray(data.links)) {
        setLinks(data.links);
        refreshTopologyVersions();
      }
    } catch (error) {
      console.error('Failed to rename link:', error);
    }
  };

  const visibleLinks = React.useMemo(
    () => links.filter((l) => topologySwitchIds.has(l.source) && topologySwitchIds.has(l.target)),
    [links, topologySwitchIds]
  );
  const editingLink = React.useMemo(
    () => visibleLinks.find((l) => l.id === editingLinkId) || null,
    [visibleLinks, editingLinkId]
  );
  const editingLinkAnchor = React.useMemo(() => {
    if (!editingLink) return null;
    const start = getNodeCenter(editingLink.source);
    const end = getNodeCenter(editingLink.target);
    return {
      x: ((start.x + end.x) / 2) * scale + stagePos.x,
      y: (((start.y + end.y) / 2) - 10) * scale + stagePos.y,
    };
  }, [editingLink, nodes, scale, stagePos]);
  const getLinkLabel = React.useCallback((link: TopoLink) => {
    const a = String(link.portA || '').trim();
    const b = String(link.portB || '').trim();
    if (link.manual && !b) return a;
    if (!b) return a;
    return `${a} <-> ${b}`;
  }, []);
  const openLinkEditor = React.useCallback((link: TopoLink) => {
    if (!canEditTopology) return;
    if (!link.id) return;
    setEditingLinkId(link.id);
    setEditingLinkValue({ comment: getLinkLabel(link) });
  }, [canEditTopology, getLinkLabel]);

  const handleWheelZoom = (e: any) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const oldScale = scale;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    const mousePointTo = {
      x: (pointer.x - stagePos.x) / oldScale,
      y: (pointer.y - stagePos.y) / oldScale,
    };
    const direction = e.evt.deltaY > 0 ? -1 : 1;
    const nextScale = Math.min(1.8, Math.max(0.35, oldScale + direction * 0.08));
    setScale(nextScale);
    setStagePos({
      x: pointer.x - mousePointTo.x * nextScale,
      y: pointer.y - mousePointTo.y * nextScale,
    });
  };

  const handleOpenWeb = (sw: Switch) => {
    window.open(`http://${sw.ip}`, '_blank', 'noopener,noreferrer');
  };

  const handleRenameRegionInline = async () => {
    const from = String(editingRegion || '').trim();
    const to = String(editingRegionValue || '').trim();
    if (!from || !to || from === to) {
      setEditingRegion(null);
      return;
    }
    try {
      const resp = await fetch('/api/inventory/branches/rename', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown'
        },
        body: JSON.stringify({ from, to })
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => null);
        throw new Error(err?.error || 'Failed to rename region');
      }
      setSelectedRegion(to);
      setEditingRegion(null);
      setEditingRegionValue('');
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to rename region');
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <header className="p-3 md:p-4 border-b border-[#373a40] bg-[#1c1d21] flex flex-col xl:flex-row xl:justify-between xl:items-center gap-3">
        <div className="flex items-center gap-2 md:gap-4 min-w-0 flex-wrap">
          <h2 className="text-sm font-bold text-white uppercase tracking-widest flex items-center gap-3">
            <Share2 size={18} className="text-[#228be6]" />
            {t('topologyVisualizer')}
          </h2>
          <div className="h-4 w-px bg-[#373a40]" />
          <nav className="flex gap-2 flex-wrap">
            {canEditTopology && (
              <button
                type="button"
                onClick={handleAutoLayout}
                className="flex items-center gap-2 px-3 py-1.5 bg-[#2c2e33] text-[#c1c2c5] hover:text-white rounded text-[10px] font-bold uppercase transition-all border border-[#373a40]"
              >
                <Box size={14} />
                {t('autoLayout')}
              </button>
            )}
            {canEditTopology && (
              <button
                type="button"
                onClick={handleUndoLastTopologyChange}
                className="flex items-center gap-2 px-3 py-1.5 bg-[#2c2e33] text-[#c1c2c5] hover:text-white rounded text-[10px] font-bold uppercase transition-all border border-[#373a40]"
              >
                <RotateCcw size={14} />
                {t('topologyUndo')}
              </button>
            )}
            <button
              type="button"
              onClick={() => setScale((s) => Math.max(0.35, s - 0.1))}
              className="flex items-center gap-1 px-2 py-1.5 bg-[#2c2e33] text-[#c1c2c5] hover:text-white rounded text-[10px] font-bold uppercase border border-[#373a40]"
              title={t('topologyZoomOut')}
            >
              <ZoomOut size={12} />
            </button>
            <button
              type="button"
              onClick={() => setScale((s) => Math.min(1.8, s + 0.1))}
              className="flex items-center gap-1 px-2 py-1.5 bg-[#2c2e33] text-[#c1c2c5] hover:text-white rounded text-[10px] font-bold uppercase border border-[#373a40]"
              title={t('topologyZoomIn')}
            >
              <ZoomIn size={12} />
            </button>
            <button
              type="button"
              onClick={() => {
                setScale(0.82);
                setStagePos({ x: 20, y: 20 });
              }}
              className="flex items-center gap-1 px-2 py-1.5 bg-[#2c2e33] text-[#c1c2c5] hover:text-white rounded text-[10px] font-bold uppercase border border-[#373a40]"
              title={t('topologyResetView')}
            >
              <RotateCcw size={12} />
            </button>
            <button
              type="button"
              onClick={() => {
                setVersionsOpen(true);
                setSelectedVersionId('');
                setVersionPreview(null);
                refreshTopologyVersions();
              }}
              className="flex items-center gap-2 px-3 py-1.5 bg-[#2c2e33] text-[#c1c2c5] hover:text-white rounded text-[10px] font-bold uppercase transition-all border border-[#373a40]"
            >
              <Box size={14} />
              {t('topologyVersions')}
            </button>
            {canEditTopology && (
              <span className="text-[10px] text-[#909296] uppercase tracking-wider pl-1">
                {t('topologyVersions')}: {topologyVersionCount}
              </span>
            )}
          </nav>
        </div>
        {canEditTopology && (
          <div className="text-[10px] text-[#909296]">
            {t('topologyDrawLinkHint')}
          </div>
        )}
      </header>
      <div className="px-3 md:px-4 py-2 border-b border-[#373a40] bg-[#1a1b1e] flex flex-col xl:flex-row xl:items-center xl:justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => setTopologyMode('ip')}
            className={`px-3 py-1 rounded text-[10px] font-bold uppercase border ${topologyMode === 'ip' ? 'bg-[#228be6] border-[#228be6] text-white' : 'bg-[#2c2e33] border-[#373a40] text-[#c1c2c5]'}`}
          >
            {t('topologyModeIp')}
          </button>
          <button
            type="button"
            onClick={() => setTopologyMode('fc')}
            className={`px-3 py-1 rounded text-[10px] font-bold uppercase border ${topologyMode === 'fc' ? 'bg-[#228be6] border-[#228be6] text-white' : 'bg-[#2c2e33] border-[#373a40] text-[#c1c2c5]'}`}
          >
            {t('topologyModeFc')}
          </button>
          <div className="h-4 w-px bg-[#373a40] mx-1" />
          {regions.map((r) => (
            editingRegion === r ? (
              <input
                key={`edit-${r}`}
                value={editingRegionValue}
                autoFocus
                onChange={(e) => setEditingRegionValue(e.target.value)}
                onBlur={handleRenameRegionInline}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRenameRegionInline();
                  if (e.key === 'Escape') {
                    setEditingRegion(null);
                    setEditingRegionValue('');
                  }
                }}
                className="bg-[#141517] border border-[#228be6] rounded px-2 py-1 text-[10px] font-bold uppercase text-white w-28"
              />
            ) : (
              <button
                key={r}
                type="button"
                onClick={() => setSelectedRegion(r)}
                onDoubleClick={() => {
                  if (!canEditTopology) return;
                  setEditingRegion(r);
                  setEditingRegionValue(r);
                }}
                className={`px-3 py-1 rounded text-[10px] font-bold uppercase border ${selectedRegion === r ? 'bg-[#228be6] border-[#228be6] text-white' : 'bg-[#2c2e33] border-[#373a40] text-[#c1c2c5]'}`}
                title={canEditTopology ? t('renameTabInlineHint') : undefined}
              >
                {r}
              </button>
            )
          ))}
        </div>
        <div className="text-[10px] text-[#909296]">
          {canEditTopology ? t('renameTabInlineHint') : ''}
        </div>
      </div>
      <div className="px-3 md:px-4 py-2 border-b border-[#373a40] bg-[#16171a] text-[11px] text-[#909296]">
        {latestVersion ? (
          <span>
            {t('topologyLastChange')}: {new Date(latestVersion.createdAt).toLocaleString()} - {t('topologyEditedBy')}: {latestVersion.actor || 'unknown'}
          </span>
        ) : (
          <span>{t('topologyNoVersions')}</span>
        )}
      </div>

      <div
        ref={containerRef}
        className={`flex-1 min-h-[420px] bg-[#141517] relative overflow-hidden ${isRightPanning ? 'cursor-grabbing' : 'cursor-crosshair'}`}
        onContextMenu={(e) => e.preventDefault()}
        onClick={() => {
          setContextMenu(null);
          setEditingLinkId(null);
          setLinkDraft(null);
        }}
      >
        <Stage
          ref={stageRef}
          width={canvasSize.width}
          height={canvasSize.height}
          scaleX={scale}
          scaleY={scale}
          x={stagePos.x}
          y={stagePos.y}
          draggable={false}
          onMouseDown={(e) => {
            const evt = e.evt as MouseEvent;
            if (linkDraft) return;
            if (evt.button !== 2 || isNodeDragging) return;
            const stage = e.target.getStage();
            if (!stage || e.target !== stage) return;
            evt.preventDefault();
            setContextMenu(null);
            setEditingLinkId(null);
            setIsRightPanning(true);
            panLastPointRef.current = { x: evt.clientX, y: evt.clientY };
          }}
          onMouseMove={(e) => {
            if (linkDraft) {
              const evt = e.evt as MouseEvent;
              const p = toStageCoords(evt.clientX, evt.clientY);
              setLinkDraft((prev) => (prev ? { ...prev, x2: p.x, y2: p.y } : prev));
              return;
            }
            if (!isRightPanning) return;
            const evt = e.evt as MouseEvent;
            evt.preventDefault();
            const prev = panLastPointRef.current;
            if (!prev) {
              panLastPointRef.current = { x: evt.clientX, y: evt.clientY };
              return;
            }
            const dx = evt.clientX - prev.x;
            const dy = evt.clientY - prev.y;
            panLastPointRef.current = { x: evt.clientX, y: evt.clientY };
            setStagePos((p) => ({ x: p.x + dx, y: p.y + dy }));
          }}
          onMouseUp={() => {
            setIsRightPanning(false);
            panLastPointRef.current = null;
            suppressNodeContextMenuRef.current = false;
            setLinkDraft(null);
          }}
          onMouseLeave={() => {
            setIsRightPanning(false);
            panLastPointRef.current = null;
            suppressNodeContextMenuRef.current = false;
            setLinkDraft(null);
          }}
          onWheel={handleWheelZoom}
        >
          <Layer>
            {visibleLinks.map((link, i) => {
              const start = getNodeCenter(link.source);
              const end = getNodeCenter(link.target);
              const linkId = link.id || `${link.source}::${link.target}::${i}`;
              return (
                <React.Fragment key={`link-${linkId}`}>
                  <Line
                    points={[start.x, start.y, end.x, end.y]}
                    stroke="#228be6"
                    strokeWidth={1}
                    opacity={0.5}
                    onMouseDown={(e) => {
                      e.cancelBubble = true;
                    }}
                    onDblClick={(e) => {
                      e.cancelBubble = true;
                      openLinkEditor(link);
                    }}
                  />
                  <Text
                    x={(start.x + end.x) / 2}
                    y={(start.y + end.y) / 2 - 10}
                    text={getLinkLabel(link)}
                    fill={editingLinkId === link.id ? "#ffffff" : "#5c5f66"}
                    fontSize={9}
                    align="center"
                    onMouseDown={(e) => {
                      e.cancelBubble = true;
                    }}
                    onDblClick={(e) => {
                      e.cancelBubble = true;
                      openLinkEditor(link);
                    }}
                  />
                </React.Fragment>
              );
            })}
            {linkDraft && (
              <Line
                points={[linkDraft.x1, linkDraft.y1, linkDraft.x2, linkDraft.y2]}
                stroke="#40c057"
                strokeWidth={2}
                dash={[6, 4]}
                opacity={0.9}
              />
            )}

            {nodes.map((node) => (
              <React.Fragment key={node.id}>
                <Rect
                  x={node.x}
                  y={node.y}
                  width={160}
                  height={80}
                  fill="#25262b"
                  stroke={node.status === 'online' ? '#40c057' : '#fa5252'}
                  strokeWidth={2}
                  cornerRadius={4}
                  draggable={canEditTopology}
                  onDragStart={(e) => {
                    e.cancelBubble = true;
                    setIsNodeDragging(true);
                  }}
                  onDragEnd={(e) => {
                    e.cancelBubble = true;
                    setIsNodeDragging(false);
                    handleDragEnd(node.id, e);
                  }}
                  onDragMove={(e) => {
                    e.cancelBubble = true;
                  }}
                  onMouseEnter={() => {
                    const stage = stageRef.current;
                    if (!stage) return;
                    stage.container().style.cursor = 'move';
                  }}
                  onMouseLeave={() => {
                    const stage = stageRef.current;
                    if (!stage) return;
                    stage.container().style.cursor = isRightPanning ? 'grabbing' : 'crosshair';
                  }}
                  onMouseDown={(e) => {
                    e.cancelBubble = true;
                    const evt = e.evt as MouseEvent;
                    if (canEditTopology && evt.button === 2) {
                      evt.preventDefault();
                      suppressNodeContextMenuRef.current = true;
                      draftLinkStartedAtRef.current = Date.now();
                      const center = getNodeCenter(node.id);
                      setLinkDraft({ sourceId: node.id, x1: center.x, y1: center.y, x2: center.x, y2: center.y });
                    }
                  }}
                  onMouseUp={(e) => {
                    e.cancelBubble = true;
                    setIsNodeDragging(false);
                    const evt = e.evt as MouseEvent;
                    if (canEditTopology && evt.button === 2 && linkDraft?.sourceId && linkDraft.sourceId !== node.id) {
                      draftLinkStartedAtRef.current = Date.now();
                      createManualLink(linkDraft.sourceId, node.id);
                      setLinkDraft(null);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.evt.preventDefault();
                    const justStartedDraft = Date.now() - draftLinkStartedAtRef.current < 360;
                    if (suppressNodeContextMenuRef.current || !!linkDraft || justStartedDraft) {
                      suppressNodeContextMenuRef.current = false;
                      return;
                    }
                    if (!canEditTopology) return;
                    setContextMenu({
                      node,
                      x: e.evt.clientX,
                      y: e.evt.clientY,
                    });
                  }}
                />
                <Text x={node.x + 10} y={node.y + 12} text={node.name} fill="white" fontSize={12} fontStyle="bold" />
                <Text x={node.x + 10} y={node.y + 32} text={node.vendor} fill="#909296" fontSize={9} />
                <Text x={node.x + 10} y={node.y + 55} text={node.ip} fill="#228be6" fontSize={10} fontFamily="monospace" />
                <Circle
                  x={node.x + 145}
                  y={node.y + 15}
                  radius={4}
                  fill={node.status === 'online' ? '#40c057' : '#fa5252'}
                />
              </React.Fragment>
            ))}
          </Layer>
        </Stage>
        {editingLink && editingLinkAnchor && (
          <div
            className="absolute z-20 -translate-x-1/2 -translate-y-full bg-[#25262b] border border-[#373a40] rounded px-2 py-1 flex items-center gap-1"
            style={{ left: editingLinkAnchor.x, top: editingLinkAnchor.y }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              value={editingLinkValue.comment}
              onChange={(e) => setEditingLinkValue({ comment: e.target.value })}
              placeholder={t('topologyLinkCommentPlaceholder')}
              className="bg-[#141517] border border-[#373a40] rounded px-1 py-0.5 text-[10px] text-white w-44"
            />
            <button
              className="text-[#40c057] px-1 text-[10px]"
              onClick={() => {
                handleRenameLink(editingLink, editingLinkValue.comment);
                setEditingLinkId(null);
              }}
              title={t('save')}
            >
              ok
            </button>
            <button
              className="text-[#fa5252] px-1 text-[10px]"
              onClick={() => setEditingLinkId(null)}
              title={t('cancel')}
            >
              x
            </button>
          </div>
        )}

        <div className="hidden md:block absolute bottom-6 right-6 p-4 bg-[#25262b] border border-[#373a40] rounded text-[10px] font-mono text-[#909296] pointer-events-none z-10">
          {t('topologyCanvasHint')}
        </div>
        <div className="absolute top-3 right-3 md:top-4 md:right-4 p-2 md:p-3 bg-[#25262b] border border-[#373a40] rounded text-[10px] text-[#909296] z-10 w-[calc(100%-1.5rem)] max-w-xs max-h-[45vh] overflow-auto">
          <div className="font-bold mb-2 text-white">{t('topologyManualLinks')}</div>
          <div className="space-y-1 max-h-40 overflow-auto">
            {visibleLinks.filter((l) => l.manual).map((l, i) => (
              <div key={`${l.id || `${l.source}-${l.target}-${i}`}`} className="flex items-center justify-between gap-2">
                {(() => {
                  const key = l.id || '';
                  const isEditing = !!key && editingLinkId === key;
                  if (!isEditing) {
                    return (
                      <span
                        className={canEditTopology ? "cursor-text" : ""}
                        title={t('clickToRename')}
                        onClick={() => {
                          if (!canEditTopology) return;
                          if (!key) return;
                          setEditingLinkId(key);
                          setEditingLinkValue({ comment: getLinkLabel(l) });
                        }}
                      >
                        {getLinkLabel(l)}
                      </span>
                    );
                  }
                  return (
                    <span className="flex items-center gap-1">
                      <input
                        value={editingLinkValue.comment}
                        onChange={(e) => setEditingLinkValue({ comment: e.target.value })}
                        className="bg-[#141517] border border-[#373a40] rounded px-1 py-0.5 text-[10px] text-white w-36"
                      />
                      <button
                        className="text-[#40c057] px-1"
                        onClick={() => {
                          handleRenameLink(l, editingLinkValue.comment);
                          setEditingLinkId(null);
                        }}
                        title={t('save')}
                      >
                        ok
                      </button>
                      <button
                        className="text-[#fa5252] px-1"
                        onClick={() => setEditingLinkId(null)}
                        title={t('cancel')}
                      >
                        x
                      </button>
                    </span>
                  );
                })()}
                {canEditTopology && <button onClick={() => handleDeleteLink(l)} className="text-red-400">x</button>}
              </div>
            ))}
          </div>
        </div>
        {versionsOpen && (
          <div className="fixed inset-0 z-[130] bg-black/60 flex items-center justify-center p-4" onClick={() => setVersionsOpen(false)}>
            <div
              className="w-full max-w-3xl max-h-[80vh] overflow-hidden bg-[#1c1d21] border border-[#373a40] rounded-lg"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-4 py-3 border-b border-[#373a40] flex items-center justify-between">
                <h3 className="text-sm font-bold text-white">{t('topologyVersionsWindowTitle')}</h3>
                <button className="text-[#909296] hover:text-white" onClick={() => setVersionsOpen(false)}>
                  {t('cancel')}
                </button>
              </div>
              <div className="overflow-auto max-h-[70vh]">
                <table className="w-full text-xs">
                  <thead className="bg-[#25262b] text-[#909296] uppercase">
                    <tr>
                      <th className="text-left px-3 py-2">{t('dateTime')}</th>
                      <th className="text-left px-3 py-2">{t('topologyEditedBy')}</th>
                      <th className="text-left px-3 py-2">{t('action')}</th>
                      <th className="text-left px-3 py-2">{t('branchLabel')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topologyVersions.map((v) => (
                      <tr
                        key={v.id}
                        className={`border-t border-[#2c2e33] cursor-pointer ${selectedVersionId === v.id ? 'bg-[#1a1b1e]' : ''}`}
                        onClick={() => setSelectedVersionId(v.id)}
                      >
                        <td className="px-3 py-2 text-[#c1c2c5]">{new Date(v.createdAt).toLocaleString()}</td>
                        <td className="px-3 py-2 text-[#c1c2c5]">{v.actor || 'unknown'}</td>
                        <td className="px-3 py-2 text-[#c1c2c5]">{v.reason}</td>
                        <td className="px-3 py-2 text-[#909296]">{v.branch || '-'}</td>
                      </tr>
                    ))}
                    {!topologyVersions.length && (
                      <tr>
                        <td colSpan={4} className="px-3 py-6 text-center text-[#909296]">
                          {t('topologyNoVersions')}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-3 border-t border-[#373a40] space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    className="px-3 py-1 bg-[#2c2e33] border border-[#373a40] text-[#c1c2c5] rounded text-xs"
                    onClick={() => loadVersionPreview(selectedVersionId)}
                    disabled={!selectedVersionId || previewLoading}
                  >
                    {previewLoading ? t('loading') : t('topologyPreview')}
                  </button>
                  {canEditTopology && (
                    <button
                      className="px-3 py-1 bg-[#228be6] text-white rounded text-xs disabled:opacity-60"
                      onClick={handleRestoreSelectedVersion}
                      disabled={!selectedVersionId || restoreLoading}
                    >
                      {restoreLoading ? t('loading') : t('topologyRestoreToVersion')}
                    </button>
                  )}
                </div>
                {versionPreview && (
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
                    <div className="bg-[#141517] border border-[#373a40] rounded px-2 py-1 text-[#c1c2c5]">{t('topologyPreviewAddedLinks')}: {versionPreview.addedLinks}</div>
                    <div className="bg-[#141517] border border-[#373a40] rounded px-2 py-1 text-[#c1c2c5]">{t('topologyPreviewRemovedLinks')}: {versionPreview.removedLinks}</div>
                    <div className="bg-[#141517] border border-[#373a40] rounded px-2 py-1 text-[#c1c2c5]">{t('topologyPreviewChangedLabels')}: {versionPreview.changedLinkLabels}</div>
                    <div className="bg-[#141517] border border-[#373a40] rounded px-2 py-1 text-[#c1c2c5]">{t('topologyPreviewMovedNodes')}: {versionPreview.movedNodes}</div>
                    <div className="bg-[#141517] border border-[#373a40] rounded px-2 py-1 text-[#c1c2c5]">{t('topologyPreviewCurrentLinks')}: {versionPreview.totalCurrentLinks}</div>
                    <div className="bg-[#141517] border border-[#373a40] rounded px-2 py-1 text-[#c1c2c5]">{t('topologyPreviewTargetLinks')}: {versionPreview.totalTargetLinks}</div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        {contextMenu && (
          <div
            className="fixed z-[120] bg-[#25262b] border border-[#373a40] rounded shadow-lg p-1 min-w-[180px]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[#c1c2c5] hover:bg-[#141517] hover:text-white rounded"
              onClick={() => {
                onOpenSSH?.(contextMenu.node);
                setContextMenu(null);
              }}
            >
              <TerminalSquare size={14} />
              {t('sshConnect')}
            </button>
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[#c1c2c5] hover:bg-[#141517] hover:text-white rounded"
              onClick={() => {
                handleOpenWeb(contextMenu.node);
                setContextMenu(null);
              }}
            >
              <Globe size={14} />
              {t('openWebUi')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default Topology;
