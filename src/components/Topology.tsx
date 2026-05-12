import React, { useState, useRef, useEffect } from 'react';
import { Stage, Layer, Rect, Text, Line, Circle } from 'react-konva';
import { Share2, Box, ZoomIn, ZoomOut, RotateCcw, Globe, TerminalSquare, Loader2 } from 'lucide-react';
import { Switch } from '../types';
import { useTranslation } from '../lib/i18n';
import { deriveZoneKey } from '../lib/zoneKey';
import { useNotifications } from '../lib/notifications';

const safeErrorText = (value: unknown, fallback = 'Unknown error') =>
  String(value || fallback)
    .replace(/(password|community|secret|token|passphrase)\s*[:=]\s*[^,\s;]+/gi, '$1=<redacted>')
    .replace(/(ssh:\/\/[^:\s]+:)[^@\s]+@/gi, '$1<redacted>@')
    .slice(0, 500);

const apiErrorDetailText = (value: unknown, httpStatus?: number) => {
  if (value && typeof value === 'object') {
    const payload = value as Record<string, unknown>;
    const parts = [
      payload.error || payload.message,
      payload.detail ? `Detail: ${payload.detail}` : '',
      payload.remediation ? `Next step: ${payload.remediation}` : '',
    ]
      .filter(Boolean)
      .map((part) => safeErrorText(part));
    const meta = [
      payload.source ? `server: ${safeErrorText(payload.source)}` : '',
      payload.code ? `code: ${safeErrorText(payload.code)}` : '',
      httpStatus ? `http ${httpStatus}` : '',
    ].filter(Boolean);
    if (meta.length) parts.push(`(${meta.join(', ')})`);
    return parts.join(' ') || safeErrorText(undefined);
  }
  return safeErrorText(value);
};

const readApiPayload = async (response: Response, fallback: string) => {
  const raw = await response.text();
  const contentType = response.headers.get('content-type') || '';
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    const looksLikeHtml = /text\/html/i.test(contentType) || /^\s*<!doctype html/i.test(raw) || /^\s*<html/i.test(raw);
    if (looksLikeHtml) {
      if (response.status === 504) {
        return {
          error: 'Gateway timeout from proxy',
          detail: 'The backend task took too long for the reverse proxy timeout.',
          source: 'proxy',
          code: 'gateway_timeout',
        };
      }
      return {
        error: 'Unexpected HTML error response from proxy',
        source: 'proxy',
        code: 'proxy_html_error',
      };
    }
    return { error: safeErrorText(raw, fallback) };
  }
};

const operationFailedMessage = (operation: string, detail?: unknown, httpStatus?: number) =>
  `${operation} failed${detail ? `: ${apiErrorDetailText(detail, httpStatus)}` : ''}`;

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
type SelectionDraft = { x1: number; y1: number; x2: number; y2: number } | null;
type GroupDragState = {
  anchorId: string;
  anchorStart: { x: number; y: number };
  originPositions: Record<string, { x: number; y: number }>;
} | null;

type NodeWithPos = Switch & { x: number; y: number };
type TopologyMode = 'ip' | 'fc';
type AutoLayoutState = 'idle' | 'running' | 'timed_out';

const TOPO_NODE_WIDTH = 160;
const TOPO_NODE_HEIGHT = 80;
const TOPO_ZONE_PAD_X = 56;
const TOPO_ZONE_PAD_TOP = 34;
const TOPO_ZONE_PAD_BOTTOM = 30;
const TOPO_ROW_TOP_Y = 34;
const TOPO_ROW_SECOND_Y = 170;
const TOPO_ROW_THIRD_Y = 306;
const TOPO_ROW_HEIGHT = TOPO_NODE_HEIGHT + 52;
const TOPO_COLUMN_GAP = TOPO_NODE_WIDTH + 120;
const TOPO_ZONE_GAP_X = 180;
const TOPO_ZONE_GAP_Y = 120;
const TOPO_ROW_STAGGER_X = 120;
const TOPO_VENDOR_LAYER_GAP_Y = 130;
const TOPO_VENDOR_MAX_COLUMNS = 9;
const TOPO_ZONE_MIN_WIDTH = TOPO_NODE_WIDTH + TOPO_ZONE_PAD_X * 2;
const TOPO_MAX_COLUMNS = 14;
const TOPO_MAX_ZONE_COLUMNS_PER_ROW = 10;
const TOPO_STAGE_SIDE_PADDING = 35;
const TOPO_LAYOUT_MAX_WIDTH = 3200;
const TOPO_LAYOUT_FIT_SCALE = 0.82;
const TOPO_LOWER_LAYOUT_FIT_SCALE = 0.72;
const TOPO_BARYCENTER_ITERATIONS = 6;
const TOPO_AUTO_LAYOUT_TIMEOUT_MS = 30000;
const TOPO_AUTO_LAYOUT_FOLLOWUP_TIMEOUT_MS = 12000;
/** Right-button drag below this distance (screen px) counts as a click → SSH/Web menu, not a link. */
const TOPO_LINK_DRAG_THRESHOLD_PX = 10;

const TOPO_TRUNK_STROKE = '#ff922b';
const TOPO_TRUNK_LABEL_FILL = 'rgba(255, 146, 43, 0.18)';
const TOPO_TRUNK_LABEL_STROKE = 'rgba(255, 146, 43, 0.82)';
const TOPO_REGULAR_LINK_STROKE = '#4dabf7';
const TOPO_REGULAR_LABEL_FILL = 'rgba(20, 21, 23, 0.78)';
const TOPO_REGULAR_LABEL_STROKE = 'rgba(77, 171, 247, 0.36)';
const TOPO_MANUAL_LINK_STROKE = '#40c057';

const sortSwitchesByNameThenId = (a: Switch, b: Switch) => {
  const an = String(a.name || '').toLowerCase();
  const bn = String(b.name || '').toLowerCase();
  if (an !== bn) return an.localeCompare(bn);
  return String(a.id).localeCompare(String(b.id));
};

const isMikroTikSwitch = (sw: Switch) => String(sw.vendor || '').trim().toLowerCase().includes('mikrotik');
const isCiscoSwitch = (sw: Switch) => String(sw.vendor || '').trim().toLowerCase().includes('cisco');
const isPriorityVendorSwitch = (sw: Switch) => isMikroTikSwitch(sw) || isCiscoSwitch(sw);
const isTrunkTopologyLink = (link: TopoLink, label: string) =>
  !link.manual || /\b(trunk|uplink|lag|port-channel|etherchannel|po\d+|ae\d+|bond\d*)\b/i.test(label);

function computeLegacyFlatLayout(switches: Switch[], links: TopoLink[], cw: number, ch: number): NodeWithPos[] {
  if (switches.length === 0) return [];
  void links;
  void ch;
  const topRow = [...switches].filter(isMikroTikSwitch).sort(sortSwitchesByNameThenId);
  const lowerRow = [...switches].filter((sw) => !isMikroTikSwitch(sw)).sort(sortSwitchesByNameThenId);
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
  const stageWidth = Math.max(cw, 1200);
  const placeRow = (items: Switch[], baseY: number, maxCols: number) => {
    const cols = Math.max(1, Math.min(maxCols, items.length));
    const rows = Math.ceil(items.length / cols);
    const positions = new Map<string, { x: number; y: number }>();
    for (let r = 0; r < rows; r++) {
      const start = r * cols;
      const rowItems = items.slice(start, start + cols);
      const rowWidth = (rowItems.length - 1) * TOPO_COLUMN_GAP;
      const startX = stageWidth / 2 - rowWidth / 2;
      rowItems.forEach((sw, idx) => {
        positions.set(sw.id, {
          x: clamp(startX + idx * TOPO_COLUMN_GAP, 35, stageWidth - TOPO_NODE_WIDTH - 35),
          y: baseY + r * TOPO_ROW_HEIGHT,
        });
      });
    }
    return positions;
  };
  const pos = new Map<string, { x: number; y: number }>();
  placeRow(topRow, TOPO_ROW_TOP_Y, Math.max(1, Math.min(4, topRow.length || 1))).forEach((v, k) => pos.set(k, v));
  placeRow(lowerRow, TOPO_ROW_SECOND_Y, TOPO_MAX_COLUMNS).forEach((v, k) => pos.set(k, v));
  return switches.map((sw) => {
    const p = pos.get(sw.id) || { x: 35, y: TOPO_ROW_SECOND_Y };
    return { ...sw, x: p.x, y: p.y };
  });
}

function computeLayout(switches: Switch[], links: TopoLink[], cw: number, ch: number): NodeWithPos[] {
  if (switches.length === 0) return [];
  void ch;
  const stageWidth = Math.max(cw, 1100);
  const layoutWidth = Math.min(
    TOPO_LAYOUT_MAX_WIDTH,
    Math.max(1100, (stageWidth - TOPO_STAGE_SIDE_PADDING * 2) / TOPO_LAYOUT_FIT_SCALE)
  );
  const lowerLayoutWidth = Math.min(
    TOPO_LAYOUT_MAX_WIDTH,
    Math.max(1300, (stageWidth - TOPO_STAGE_SIDE_PADDING * 2) / TOPO_LOWER_LAYOUT_FIT_SCALE)
  );
  const maxColumnsForWidth = (targetWidth: number) => {
    const gap = TOPO_COLUMN_GAP - TOPO_NODE_WIDTH;
    const usable = Math.max(TOPO_NODE_WIDTH, targetWidth - TOPO_ZONE_PAD_X * 2);
    return Math.max(1, Math.floor((usable + gap) / TOPO_COLUMN_GAP));
  };
  const priorityMikroTik = switches.filter(isMikroTikSwitch).sort(sortSwitchesByNameThenId);
  const priorityCisco = switches
    .filter((sw) => !isMikroTikSwitch(sw) && isCiscoSwitch(sw))
    .sort(sortSwitchesByNameThenId);
  const lowerSwitches = switches.filter((sw) => !isPriorityVendorSwitch(sw));
  const allSortedSwitches = [...switches].sort(sortSwitchesByNameThenId);
  const nodeIndex = new Map(allSortedSwitches.map((sw, idx) => [sw.id, idx]));
  const switchById = new Map(switches.map((sw) => [sw.id, sw]));
  const zoneKeyForSwitch = (sw: Switch) => deriveZoneKey(sw.name) || '__ungrouped__';
  const weightedCenter = (entries: Array<{ value: number; weight: number }>, fallback: number) => {
    let totalWeight = 0;
    let weightedSum = 0;
    entries.forEach((entry) => {
      if (entry.weight <= 0 || !Number.isFinite(entry.value)) return;
      totalWeight += entry.weight;
      weightedSum += entry.value * entry.weight;
    });
    return totalWeight > 0 ? weightedSum / totalWeight : fallback;
  };
  const zones = new Map<string, Switch[]>();
  lowerSwitches.forEach((sw) => {
    const zoneKey = zoneKeyForSwitch(sw);
    if (!zones.has(zoneKey)) zones.set(zoneKey, []);
    zones.get(zoneKey)!.push(sw);
  });
  const zoneKeys = Array.from(zones.keys()).sort((a, b) => a.localeCompare(b));

  const zoneGraph = new Map<string, Map<string, number>>();
  const zoneToPriorityAnchor = new Map<string, Array<{ value: number; weight: number }>>();
  const switchToAnchor = new Map<string, Array<{ value: number; weight: number }>>();
  const priorityOrder = [...priorityMikroTik, ...priorityCisco];
  const priorityAnchorById = new Map(priorityOrder.map((sw, idx) => [sw.id, idx]));
  const getLinkWeight = (link: TopoLink) => {
    const label = `${String(link.portA || '')} ${String(link.portB || '')}`.trim();
    return isTrunkTopologyLink(link, label) ? 3 : 1;
  };
  const addZoneEdge = (a: string, b: string, weight: number) => {
    if (!zoneGraph.has(a)) zoneGraph.set(a, new Map());
    if (!zoneGraph.has(b)) zoneGraph.set(b, new Map());
    zoneGraph.get(a)!.set(b, (zoneGraph.get(a)!.get(b) || 0) + weight);
    zoneGraph.get(b)!.set(a, (zoneGraph.get(b)!.get(a) || 0) + weight);
  };
  links.forEach((link) => {
    const source = switchById.get(link.source);
    const target = switchById.get(link.target);
    if (!source || !target) return;
    const weight = getLinkWeight(link);
    const sourcePriorityAnchor = priorityAnchorById.get(source.id);
    const targetPriorityAnchor = priorityAnchorById.get(target.id);
    const sourceIsLower = !isPriorityVendorSwitch(source);
    const targetIsLower = !isPriorityVendorSwitch(target);
    if (sourceIsLower && targetIsLower) {
      const sourceZone = zoneKeyForSwitch(source);
      const targetZone = zoneKeyForSwitch(target);
      if (sourceZone !== targetZone) addZoneEdge(sourceZone, targetZone, weight);
    }
    if (sourceIsLower && targetPriorityAnchor !== undefined) {
      const sourceZone = zoneKeyForSwitch(source);
      if (!zoneToPriorityAnchor.has(sourceZone)) zoneToPriorityAnchor.set(sourceZone, []);
      zoneToPriorityAnchor.get(sourceZone)!.push({ value: targetPriorityAnchor, weight });
      if (!switchToAnchor.has(source.id)) switchToAnchor.set(source.id, []);
      switchToAnchor.get(source.id)!.push({ value: targetPriorityAnchor, weight });
    }
    if (targetIsLower && sourcePriorityAnchor !== undefined) {
      const targetZone = zoneKeyForSwitch(target);
      if (!zoneToPriorityAnchor.has(targetZone)) zoneToPriorityAnchor.set(targetZone, []);
      zoneToPriorityAnchor.get(targetZone)!.push({ value: sourcePriorityAnchor, weight });
      if (!switchToAnchor.has(target.id)) switchToAnchor.set(target.id, []);
      switchToAnchor.get(target.id)!.push({ value: sourcePriorityAnchor, weight });
    }
  });

  const zoneInitialOrder = [...zoneKeys].sort((a, b) => {
    const aFallback = nodeIndex.get(zones.get(a)?.[0]?.id || '') || 0;
    const bFallback = nodeIndex.get(zones.get(b)?.[0]?.id || '') || 0;
    const aCenter = weightedCenter(zoneToPriorityAnchor.get(a) || [], aFallback);
    const bCenter = weightedCenter(zoneToPriorityAnchor.get(b) || [], bFallback);
    if (aCenter !== bCenter) return aCenter - bCenter;
    return a.localeCompare(b);
  });
  let orderedZoneKeys = [...zoneInitialOrder];
  for (let i = 0; i < TOPO_BARYCENTER_ITERATIONS; i++) {
    const orderIndex = new Map(orderedZoneKeys.map((zoneKey, idx) => [zoneKey, idx]));
    orderedZoneKeys = [...orderedZoneKeys].sort((a, b) => {
      const aFallback = orderIndex.get(a) || 0;
      const bFallback = orderIndex.get(b) || 0;
      const aNeighborEntries =
        Array.from((zoneGraph.get(a) || new Map()).entries()).map(([neighbor, weight]) => ({
          value: orderIndex.get(neighbor) ?? aFallback,
          weight,
        }));
      const bNeighborEntries =
        Array.from((zoneGraph.get(b) || new Map()).entries()).map(([neighbor, weight]) => ({
          value: orderIndex.get(neighbor) ?? bFallback,
          weight,
        }));
      const aCenter = weightedCenter(
        [...aNeighborEntries, ...(zoneToPriorityAnchor.get(a) || [])],
        aFallback
      );
      const bCenter = weightedCenter(
        [...bNeighborEntries, ...(zoneToPriorityAnchor.get(b) || [])],
        bFallback
      );
      if (aCenter !== bCenter) return aCenter - bCenter;
      return a.localeCompare(b);
    });
  }

  const zonePlans = orderedZoneKeys.map((zoneKey) => {
      const zoneSwitches = [...(zones.get(zoneKey) || [])];
      const others = zoneSwitches.sort((a, b) => {
        const aFallback = nodeIndex.get(a.id) || 0;
        const bFallback = nodeIndex.get(b.id) || 0;
        const aCenter = weightedCenter(switchToAnchor.get(a.id) || [], aFallback);
        const bCenter = weightedCenter(switchToAnchor.get(b.id) || [], bFallback);
        if (aCenter !== bCenter) return aCenter - bCenter;
        return sortSwitchesByNameThenId(a, b);
      });
      const otherCols = Math.max(
        1,
        Math.min(others.length || 1, Math.min(TOPO_MAX_COLUMNS, maxColumnsForWidth(lowerLayoutWidth)))
      );
      const rowWidth = otherCols * TOPO_NODE_WIDTH + Math.max(0, otherCols - 1) * (TOPO_COLUMN_GAP - TOPO_NODE_WIDTH);
      const otherRows = Math.max(1, Math.ceil(others.length / otherCols));
      const contentBottom = TOPO_ROW_TOP_Y + (otherRows - 1) * TOPO_ROW_HEIGHT + TOPO_NODE_HEIGHT;
      return {
        zoneKey,
        others,
        otherCols,
        width: Math.max(TOPO_ZONE_MIN_WIDTH, rowWidth + TOPO_ZONE_PAD_X * 2),
        height: Math.max(
          TOPO_NODE_HEIGHT + TOPO_ZONE_PAD_TOP + TOPO_ZONE_PAD_BOTTOM,
          contentBottom + TOPO_ZONE_PAD_BOTTOM
        ),
      };
    });

  const placeRow = (items: Switch[], zoneX: number, zoneWidth: number, baseY: number, maxCols: number) => {
    if (!items.length) return;
    const cols = Math.max(1, Math.min(maxCols, items.length));
    for (let r = 0; r < Math.ceil(items.length / cols); r++) {
      const rowItems = items.slice(r * cols, r * cols + cols);
      const rowWidth = rowItems.length * TOPO_NODE_WIDTH + Math.max(0, rowItems.length - 1) * (TOPO_COLUMN_GAP - TOPO_NODE_WIDTH);
      const startX = zoneX + zoneWidth / 2 - rowWidth / 2;
      rowItems.forEach((sw, idx) => {
        pos.set(sw.id, {
          x: startX + idx * TOPO_COLUMN_GAP,
          y: baseY + r * TOPO_ROW_HEIGHT,
        });
      });
    }
  };

  const pos = new Map<string, { x: number; y: number }>();
  let rowY = 70;
  const placePriorityLayer = (items: Switch[], baseY: number) => {
    if (!items.length) return;
    const cols = Math.max(1, Math.min(TOPO_VENDOR_MAX_COLUMNS, items.length));
    const width = Math.max(
      TOPO_ZONE_MIN_WIDTH,
      cols * TOPO_NODE_WIDTH + Math.max(0, cols - 1) * (TOPO_COLUMN_GAP - TOPO_NODE_WIDTH) + TOPO_ZONE_PAD_X * 2
    );
    const zoneX = Math.max(TOPO_STAGE_SIDE_PADDING, stageWidth / 2 - width / 2);
    placeRow(items, zoneX, width, baseY, cols);
  };
  placePriorityLayer(priorityMikroTik, rowY + TOPO_ROW_TOP_Y);
  rowY += TOPO_ROW_HEIGHT;
  placePriorityLayer(priorityCisco, rowY + TOPO_ROW_TOP_Y);
  rowY += TOPO_ROW_HEIGHT + TOPO_VENDOR_LAYER_GAP_Y;

  const rows: Array<{ plans: typeof zonePlans; width: number; height: number }> = [];
  let currentRow: { plans: typeof zonePlans; width: number; height: number } = { plans: [], width: 0, height: 0 };
  zonePlans.forEach((plan) => {
    const nextWidth = currentRow.width === 0 ? plan.width : currentRow.width + TOPO_ZONE_GAP_X + plan.width;
    if (
      currentRow.plans.length &&
      (currentRow.plans.length >= TOPO_MAX_ZONE_COLUMNS_PER_ROW || nextWidth > lowerLayoutWidth)
    ) {
      rows.push(currentRow);
      currentRow = { plans: [plan], width: plan.width, height: plan.height };
      return;
    }
    currentRow.plans.push(plan);
    currentRow.width = nextWidth;
    currentRow.height = Math.max(currentRow.height, plan.height);
  });
  if (currentRow.plans.length) rows.push(currentRow);
  const rowOrderIndices = rows.map((row) =>
    new Map(row.plans.map((plan, idx) => [plan.zoneKey, idx]))
  );
  for (let i = 1; i < rows.length; i++) {
    const prevOrder = rowOrderIndices[i - 1];
    rows[i].plans = [...rows[i].plans].sort((a, b) => {
      const aFallback = rowOrderIndices[i].get(a.zoneKey) || 0;
      const bFallback = rowOrderIndices[i].get(b.zoneKey) || 0;
      const aCenter = weightedCenter(
        Array.from((zoneGraph.get(a.zoneKey) || new Map()).entries())
          .filter(([zoneKey]) => prevOrder.has(zoneKey))
          .map(([zoneKey, weight]) => ({ value: prevOrder.get(zoneKey) || 0, weight })),
        aFallback
      );
      const bCenter = weightedCenter(
        Array.from((zoneGraph.get(b.zoneKey) || new Map()).entries())
          .filter(([zoneKey]) => prevOrder.has(zoneKey))
          .map(([zoneKey, weight]) => ({ value: prevOrder.get(zoneKey) || 0, weight })),
        bFallback
      );
      if (aCenter !== bCenter) return aCenter - bCenter;
      return a.zoneKey.localeCompare(b.zoneKey);
    });
    rows[i].width = rows[i].plans.reduce(
      (sum, plan, idx) => sum + plan.width + (idx > 0 ? TOPO_ZONE_GAP_X : 0),
      0
    );
  }

  rows.forEach((row, rowIndex) => {
    const rowOffset = rowIndex % 2 === 1 ? TOPO_ROW_STAGGER_X : 0;
    let zoneX = Math.max(TOPO_STAGE_SIDE_PADDING, stageWidth / 2 - row.width / 2 + rowOffset);
    const maxStartX = Math.max(TOPO_STAGE_SIDE_PADDING, lowerLayoutWidth - row.width - TOPO_STAGE_SIDE_PADDING);
    zoneX = Math.min(zoneX, maxStartX);
    row.plans.forEach((plan) => {
      placeRow(plan.others, zoneX, plan.width, rowY + TOPO_ROW_TOP_Y, plan.otherCols);
      zoneX += plan.width + TOPO_ZONE_GAP_X;
    });
    rowY += row.height + TOPO_ZONE_GAP_Y;
  });

  return switches.map((sw) => {
    const p = pos.get(sw.id) || { x: 35, y: rowY + TOPO_ROW_TOP_Y };
    return { ...sw, x: p.x, y: p.y };
  });
}

const isLikelyLegacyAutoPosition = (
  sw: Switch,
  saved: { x: number; y: number },
  legacyPositions: Map<string, { x: number; y: number }>
) => {
  const legacy = legacyPositions.get(sw.id);
  if (!legacy) return false;
  return Math.abs(Number(saved.x) - legacy.x) <= 0.5 && Math.abs(Number(saved.y) - legacy.y) <= 0.5;
};

const mergeManualAnchors = (
  computed: NodeWithPos[],
  savedLayout: Record<string, { x: number; y: number }>,
  legacyPositions: Map<string, { x: number; y: number }>
) =>
  computed.map((n) => {
    const saved = savedLayout[n.id];
    if (!saved) return n;
    if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return n;
    if (isLikelyLegacyAutoPosition(n, saved, legacyPositions)) return n;
    return { ...n, x: Number(saved.x), y: Number(saved.y) };
  });

const getNodeSeverity = (sw: Switch): 'online' | 'warning' | 'critical' => {
  if (sw.warningSeverity === 'critical' || sw.status === 'offline') return 'critical';
  if (sw.warningSeverity === 'warning' || sw.status === 'warning') return 'warning';
  return 'online';
};

const NODE_COLORS: Record<'online' | 'warning' | 'critical', string> = {
  online: '#40c057',
  warning: '#fab005',
  critical: '#fa5252',
};

function topologyScopeQuery(topologyMode: TopologyMode, branch?: string) {
  const params = new URLSearchParams({ topologyMode });
  if (branch) params.set('branch', branch);
  const query = params.toString();
  return query ? `?${query}` : '';
}

const Topology: React.FC<TopologyProps> = ({ switches, role, username, onOpenSSH }) => {
  const { t } = useTranslation();
  const { notifySuccess, notifyError, notifyInfo } = useNotifications();
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
  const linkDraftPointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const linkDraftRef = useRef<LinkDraft>(null);
  const suppressContextMenuRef = useRef(false);
  const linkPointerIdRef = useRef<number | null>(null);
  const [topologyMode, setTopologyMode] = useState<TopologyMode>('ip');
  const [selectedRegion, setSelectedRegion] = useState<string>('');
  const [selectedZone, setSelectedZone] = useState<string>('');
  const [zoneLabelOverrides, setZoneLabelOverrides] = useState<Record<string, string>>({});
  const [editingZoneKey, setEditingZoneKey] = useState<string | null>(null);
  const [editingZoneValue, setEditingZoneValue] = useState('');
  const [newRegion, setNewRegion] = useState('');
  const [regionEditor, setRegionEditor] = useState({ from: '', to: '' });
  const [manualLink, setManualLink] = useState({ source: '', target: '', portA: '', portB: '' });
  const [editingRegion, setEditingRegion] = useState<string | null>(null);
  const [editingRegionValue, setEditingRegionValue] = useState('');
  const [editingLinkId, setEditingLinkId] = useState<string | null>(null);
  const [editingLinkValue, setEditingLinkValue] = useState<{ comment: string }>({ comment: '' });
  const zoneTapRef = useRef<{ zoneKey: string; at: number } | null>(null);
  const [topologyVersionCount, setTopologyVersionCount] = useState(0);
  const [topologyVersions, setTopologyVersions] = useState<TopologyVersion[]>([]);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string>('');
  const [versionPreview, setVersionPreview] = useState<TopologyVersionPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [linkDraft, setLinkDraft] = useState<LinkDraft>(null);
  const [selectionDraft, setSelectionDraft] = useState<SelectionDraft>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [hoveredLinkId, setHoveredLinkId] = useState<string | null>(null);
  const [autoLayoutState, setAutoLayoutState] = useState<AutoLayoutState>('idle');
  const groupDragRef = useRef<GroupDragState>(null);
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
  const zones = React.useMemo(() => {
    const set = new Set<string>();
    regionSwitches.forEach((s) => {
      const zone = deriveZoneKey(s.name);
      if (zone) set.add(zone);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [regionSwitches]);
  useEffect(() => {
    if (!zones.length) {
      if (selectedZone !== '') setSelectedZone('');
      return;
    }
    if (!selectedZone || (!zones.includes(selectedZone) && selectedZone !== '__all__')) {
      setSelectedZone('__all__');
    }
  }, [zones, selectedZone]);
  const zoneSwitches = React.useMemo(
    () =>
      regionSwitches.filter((s) => {
        if (selectedZone === '__all__') return true;
        return selectedZone ? deriveZoneKey(s.name) === selectedZone : false;
      }),
    [regionSwitches, selectedZone]
  );
  const zoneLabel = React.useCallback((zoneKey: string) => {
    const override = String(zoneLabelOverrides[zoneKey] || '').trim();
    return override || zoneKey;
  }, [zoneLabelOverrides]);
  const topologySwitchIds = React.useMemo(() => new Set(zoneSwitches.map((s) => s.id)), [zoneSwitches]);
  const selectedNodeIdSet = React.useMemo(() => new Set(selectedNodeIds), [selectedNodeIds]);

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
        const data: {
          links: TopoLink[];
          layout?: Record<string, { x: number; y: number }>;
          zoneLabelOverrides?: Record<string, string>;
        } = await response.json();
        if (!cancelled) {
          setLinks(data.links || []);
          setSavedLayout(data.layout || {});
          setZoneLabelOverrides(data.zoneLabelOverrides || {});
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
      setZoneLabelOverrides((data?.zoneLabelOverrides || {}) as Record<string, string>);
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
      const computed = computeLayout(zoneSwitches, visibleLinks, w, h);
      const legacy = computeLegacyFlatLayout(zoneSwitches, visibleLinks, w, h);
      const legacyPositions = new Map(legacy.map((n) => [n.id, { x: n.x, y: n.y }]));
      setNodes(mergeManualAnchors(computed, savedLayout, legacyPositions));
    }, 80);
    return () => window.clearTimeout(timer);
  }, [zoneSwitches, topologySwitchIds, links, canvasSize.width, canvasSize.height, savedLayout]);

  const fetchWithTimeout = React.useCallback(
    async (input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = TOPO_AUTO_LAYOUT_TIMEOUT_MS) => {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(input, { ...init, signal: controller.signal });
      } finally {
        window.clearTimeout(timeoutId);
      }
    },
    []
  );

  const applyTopologyPayload = React.useCallback(
    (
      payload: {
        links?: TopoLink[];
        layout?: Record<string, { x: number; y: number }>;
        zoneLabelOverrides?: Record<string, string>;
      },
      preserveClientManualPositions = false
    ) => {
      const nextLinks = payload.links || [];
      const nextLayout = payload.layout || {};
      const mergedLayout = preserveClientManualPositions ? { ...nextLayout, ...savedLayout } : nextLayout;
      setLinks(nextLinks);
      setSavedLayout(mergedLayout);
      setZoneLabelOverrides(payload.zoneLabelOverrides || {});
      const w = containerRef.current?.offsetWidth || canvasSize.width;
      const h = containerRef.current?.offsetHeight || canvasSize.height;
      const visible = nextLinks.filter((l) => topologySwitchIds.has(l.source) && topologySwitchIds.has(l.target));
      const computed = computeLayout(zoneSwitches, visible, w, h);
      const legacy = computeLegacyFlatLayout(zoneSwitches, visible, w, h);
      const legacyPositions = new Map(legacy.map((n) => [n.id, { x: n.x, y: n.y }]));
      setNodes(mergeManualAnchors(computed, mergedLayout, legacyPositions));
      return {
        visibleCount: visible.length,
        trunkCount: visible.filter((l) => isTrunkTopologyLink(l, `${String(l.portA || '')} ${String(l.portB || '')}`)).length,
      };
    },
    [canvasSize.height, canvasSize.width, savedLayout, topologySwitchIds, zoneSwitches]
  );

  const refreshLinksScoped = React.useCallback(async () => {
    const response = await fetchWithTimeout(`/api/topology/links${topologyScopeQuery(topologyMode, selectedRegion || undefined)}`, {
      headers: {
        'x-user-role': role || 'viewer',
        'x-user-name': username || 'unknown'
      }
    });
    const data: {
      links?: TopoLink[];
      layout?: Record<string, { x: number; y: number }>;
      zoneLabelOverrides?: Record<string, string>;
      error?: string;
    } = await readApiPayload(response, 'Topology load failed');
    if (!response.ok) throw new Error(operationFailedMessage('Topology load', data, response.status));
    return data;
  }, [fetchWithTimeout, role, selectedRegion, topologyMode, username]);

  const refreshLinksScopedWithFallback = React.useCallback(async () => {
    try {
      return await refreshLinksScoped();
    } catch (error) {
      const isTimeout = error instanceof DOMException && error.name === 'AbortError';
      if (!isTimeout) throw error;
      const response = await fetch(`/api/topology/links${topologyScopeQuery(topologyMode, selectedRegion || undefined)}`, {
        headers: {
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown'
        }
      });
      const data: {
        links?: TopoLink[];
        layout?: Record<string, { x: number; y: number }>;
        zoneLabelOverrides?: Record<string, string>;
        error?: string;
      } = await readApiPayload(response, 'Topology load timeout');
      if (!response.ok) throw new Error(operationFailedMessage('Topology load', data, response.status));
      return data;
    }
  }, [refreshLinksScoped, role, selectedRegion, topologyMode, username]);

  const handleAutoLayout = async () => {
    if (!canEditTopology) return;
    if (!selectedRegion) {
      alert(t('topologySelectTabFirst'));
      return;
    }
    if (autoLayoutState === 'running') return;
    try {
      setAutoLayoutState('running');
      notifyInfo('topologyLayoutRunStarted', 'topologyLayoutProgressTitle');
      if (topologyMode !== 'fc') {
        const rebuild = await fetchWithTimeout('/api/topology/links/rebuild', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-user-role': role || 'viewer',
            'x-user-name': username || 'unknown'
          },
          body: JSON.stringify({ branch: selectedRegion, topologyMode }),
        });
        if (!rebuild.ok) {
          const err = await readApiPayload(rebuild, 'Topology rebuild failed').catch(() => null);
          console.warn('Topology rebuild failed, using existing links', apiErrorDetailText(err, rebuild.status));
        }
      }
      let data = await refreshLinksScopedWithFallback();
      if (!Array.isArray(data.links) || data.links.length === 0) {
        await new Promise((resolve) => window.setTimeout(resolve, 450));
        data = await refreshLinksScopedWithFallback();
      }
      const applied = applyTopologyPayload(data, true);
      await refreshTopologyVersions();

      // After rebuilding topology for this tab, classify inventory subcategories by trunk count (SNMP).
      if (topologyMode !== 'fc') {
        try {
          await fetchWithTimeout('/api/topology/classify-subcategories', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-user-role': role || 'viewer',
              'x-user-name': username || 'unknown'
            },
            body: JSON.stringify({ branch: selectedRegion })
          }, TOPO_AUTO_LAYOUT_FOLLOWUP_TIMEOUT_MS);
        } catch {
          // ignore classification errors
        }
      }
      notifySuccess(
        t('topologyLayoutCompletedSummary')
          .replace('{links}', String(applied.visibleCount))
          .replace('{trunks}', String(applied.trunkCount)),
        'topologyLayoutCompletedTitle'
      );
      if (applied.trunkCount === 0) {
        notifyInfo('topologyNoTrunksAfterLayout', 'topologyNoTrunksAfterLayoutTitle', 9000);
      }
      setAutoLayoutState('idle');
    } catch (error) {
      console.error('Failed to refresh topology:', error);
      const isTimeout = error instanceof DOMException && error.name === 'AbortError';
      setAutoLayoutState(isTimeout ? 'timed_out' : 'idle');
      notifyError(
        isTimeout ? 'topologyLayoutTimeout' : 'topologyLayoutFailedFriendly',
        isTimeout ? 'topologyLayoutTimeoutTitle' : 'topologyLayoutFailedTitle',
        9000
      );
    }
  };

  const openZoneRenameEditor = React.useCallback((zoneKey: string) => {
    if (!canEditTopology) return;
    setEditingZoneKey(zoneKey);
    setEditingZoneValue(zoneLabel(zoneKey));
  }, [canEditTopology, zoneLabel]);

  const handleZoneTouchEnd = React.useCallback((zoneKey: string) => {
    if (!canEditTopology) return;
    const now = Date.now();
    const previous = zoneTapRef.current;
    if (previous && previous.zoneKey === zoneKey && now - previous.at <= 350) {
      openZoneRenameEditor(zoneKey);
      zoneTapRef.current = null;
      return;
    }
    zoneTapRef.current = { zoneKey, at: now };
  }, [canEditTopology, openZoneRenameEditor]);

  const handleRenameZoneInline = React.useCallback(async () => {
    const zoneKey = String(editingZoneKey || '').trim();
    const nextLabel = String(editingZoneValue || '').trim();
    setEditingZoneKey(null);
    setEditingZoneValue('');
    if (!zoneKey) return;
    const currentLabel = String(zoneLabelOverrides[zoneKey] || '').trim();
    if (currentLabel === nextLabel) return;
    try {
      const response = await fetch('/api/topology/zones/label', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown'
        },
        body: JSON.stringify({
          zoneKey,
          label: nextLabel,
          branch: selectedRegion || undefined,
          topologyMode,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || t('topologyZoneRenameFailed'));
      }
      setZoneLabelOverrides((data?.zoneLabelOverrides || {}) as Record<string, string>);
    } catch (error) {
      alert(error instanceof Error ? error.message : t('topologyZoneRenameFailed'));
    }
  }, [editingZoneKey, editingZoneValue, role, selectedRegion, t, topologyMode, username, zoneLabelOverrides]);

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
      setZoneLabelOverrides((data?.zoneLabelOverrides || {}) as Record<string, string>);
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

  const persistLayoutPositions = React.useCallback(
    async (positions: Record<string, { x: number; y: number }>) => {
      if (!Object.keys(positions).length) return;
      try {
        await fetch('/api/topology/layout', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-user-role': role || 'viewer',
            'x-user-name': username || 'unknown'
          },
          body: JSON.stringify({ positions, branch: selectedRegion || undefined, topologyMode }),
        });
      } catch (error) {
        console.error('Failed to save layout:', error);
      }
    },
    [role, selectedRegion, topologyMode, username]
  );

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

  const selectionRect = React.useMemo(() => {
    if (!selectionDraft) return null;
    const x = Math.min(selectionDraft.x1, selectionDraft.x2);
    const y = Math.min(selectionDraft.y1, selectionDraft.y2);
    const width = Math.abs(selectionDraft.x2 - selectionDraft.x1);
    const height = Math.abs(selectionDraft.y2 - selectionDraft.y1);
    return { x, y, width, height };
  }, [selectionDraft]);

  useEffect(() => {
    setSelectedNodeIds((prev) => prev.filter((id) => nodes.some((n) => n.id === id)));
  }, [nodes]);

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
  const zoneBoxes = React.useMemo(() => {
    const map = new Map<string, NodeWithPos[]>();
    nodes.forEach((node) => {
      const zoneKey = isMikroTikSwitch(node)
        ? '__vendor_mikrotik__'
        : isCiscoSwitch(node)
          ? '__vendor_cisco__'
          : deriveZoneKey(node.name);
      if (!zoneKey) return;
      if (!map.has(zoneKey)) map.set(zoneKey, []);
      map.get(zoneKey)!.push(node);
    });
    return Array.from(map.entries())
      .map(([zoneKey, zoneNodes]) => {
        const minX = Math.min(...zoneNodes.map((n) => n.x));
        const maxX = Math.max(...zoneNodes.map((n) => n.x + TOPO_NODE_WIDTH));
        const minY = Math.min(...zoneNodes.map((n) => n.y));
        const maxY = Math.max(...zoneNodes.map((n) => n.y + TOPO_NODE_HEIGHT));
        return {
          zoneKey,
          label: zoneKey === '__vendor_mikrotik__' ? 'MikroTik' : zoneKey === '__vendor_cisco__' ? 'Cisco' : zoneLabel(zoneKey),
          x: minX - TOPO_ZONE_PAD_X,
          y: minY - TOPO_ZONE_PAD_TOP,
          width: Math.max(TOPO_ZONE_MIN_WIDTH, maxX - minX + TOPO_ZONE_PAD_X * 2),
          height: Math.max(TOPO_NODE_HEIGHT + TOPO_ZONE_PAD_TOP + TOPO_ZONE_PAD_BOTTOM, maxY - minY + TOPO_ZONE_PAD_TOP + TOPO_ZONE_PAD_BOTTOM),
        };
      })
      .sort((a, b) => {
        const order = (key: string) => (key === '__vendor_mikrotik__' ? 0 : key === '__vendor_cisco__' ? 1 : 2);
        const priority = order(a.zoneKey) - order(b.zoneKey);
        return priority || a.zoneKey.localeCompare(b.zoneKey);
      });
  }, [nodes, zoneLabel]);
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
  const renderedLinks = React.useMemo(() => {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const zoneOf = (id: string) => {
      const node = nodeById.get(id);
      if (!node) return '__ungrouped__';
      if (isMikroTikSwitch(node)) return '__vendor_mikrotik__';
      if (isCiscoSwitch(node)) return '__vendor_cisco__';
      return deriveZoneKey(node.name) || '__ungrouped__';
    };
    const getAnchorPoint = (node: NodeWithPos, peer: NodeWithPos, preferHorizontal: boolean) => {
      const dx = peer.x - node.x;
      const dy = peer.y - node.y;
      if (preferHorizontal || Math.abs(dx) >= Math.abs(dy)) {
        return dx >= 0
          ? { x: node.x + TOPO_NODE_WIDTH, y: node.y + TOPO_NODE_HEIGHT / 2 }
          : { x: node.x, y: node.y + TOPO_NODE_HEIGHT / 2 };
      }
      return dy >= 0
        ? { x: node.x + TOPO_NODE_WIDTH / 2, y: node.y + TOPO_NODE_HEIGHT }
        : { x: node.x + TOPO_NODE_WIDTH / 2, y: node.y };
    };
    const grouped = new Map<string, TopoLink[]>();
    visibleLinks.forEach((link) => {
      const a = String(link.source || '');
      const b = String(link.target || '');
      const key = a < b ? `${a}::${b}` : `${b}::${a}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(link);
    });
    return Array.from(grouped.values()).flatMap((group) => {
      const orderedGroup = [...group].sort((a, b) => {
        const ak = `${String(a.id || '')}\u0000${String(a.portA || '')}\u0000${String(a.portB || '')}`;
        const bk = `${String(b.id || '')}\u0000${String(b.portA || '')}\u0000${String(b.portB || '')}`;
        return ak.localeCompare(bk);
      });
      return orderedGroup.map((link, idx) => {
        const sourceNode = nodeById.get(link.source);
        const targetNode = nodeById.get(link.target);
        const fallbackStart = getNodeCenter(link.source);
        const fallbackEnd = getNodeCenter(link.target);
        if (!sourceNode || !targetNode) {
          return {
            link,
            idx,
            isTrunk: false,
            linePoints: [fallbackStart.x, fallbackStart.y, fallbackEnd.x, fallbackEnd.y] as number[],
            labelText: getLinkLabel(link),
            labelX: (fallbackStart.x + fallbackEnd.x) / 2,
            labelY: (fallbackStart.y + fallbackEnd.y) / 2,
            labelWidth: 84,
            labelHeight: 16,
            deemphasized: true,
          };
        }
        const sourceZone = zoneOf(sourceNode.id);
        const targetZone = zoneOf(targetNode.id);
        const preferHorizontal = sourceZone !== targetZone;
        const start = getAnchorPoint(sourceNode, targetNode, preferHorizontal);
        const end = getAnchorPoint(targetNode, sourceNode, preferHorizontal);
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const len = Math.max(1, Math.hypot(dx, dy));
        const nx = -dy / len;
        const ny = dx / len;
        const tx = dx / len;
        const ty = dy / len;
        const laneOffset = (idx - (orderedGroup.length - 1) / 2) * 14;
        const x1 = start.x + nx * laneOffset;
        const y1 = start.y + ny * laneOffset;
        const x2 = end.x + nx * laneOffset;
        const y2 = end.y + ny * laneOffset;
        const labelText = getLinkLabel(link);
        const isTrunk = isTrunkTopologyLink(link, labelText);
        const displayLabel = isTrunk ? `TRUNK ${labelText}` : labelText;
        const laneDistance = Math.abs(idx - (orderedGroup.length - 1) / 2);
        const labelLineOffset = 16 + laneDistance * 3;
        const tangentShift = (idx % 2 === 0 ? 1 : -1) * Math.ceil(idx / 2) * 12;
        const labelX = (x1 + x2) / 2 + nx * labelLineOffset + tx * tangentShift;
        const labelY = (y1 + y2) / 2 + ny * labelLineOffset + ty * tangentShift;
        const labelWidth = Math.max(52, Math.ceil(displayLabel.length * 6.1 + 16));
        const labelHeight = 16;
        const linePoints: number[] = isTrunk
          ? (() => {
              const pairKey = `${sourceZone}|${targetZone}`;
              let hash = 0;
              for (let i = 0; i < pairKey.length; i++) hash = (hash * 31 + pairKey.charCodeAt(i)) | 0;
              const laneBias = ((Math.abs(hash) % 7) - 3) * 34;
              const corridorX = (x1 + x2) / 2 + laneBias + laneOffset * 1.1;
              return [x1, y1, corridorX, y1, corridorX, y2, x2, y2];
            })()
          : [x1, y1, x2, y2];
        return {
          link,
          idx,
          isTrunk,
          linePoints,
          labelText: displayLabel,
          labelX,
          labelY,
          labelWidth,
          labelHeight,
          deemphasized: !isTrunk && !link.manual,
        };
      });
    }).sort((a, b) => Number(a.isTrunk) - Number(b.isTrunk));
  }, [visibleLinks, nodes, getLinkLabel]);
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

  const openNodeActionMenu = React.useCallback((node: Switch, clientX: number, clientY: number) => {
    setContextMenu({
      node,
      x: clientX,
      y: clientY,
    });
  }, []);

  React.useEffect(() => {
    linkDraftRef.current = linkDraft;
  }, [linkDraft]);

  const releaseLinkPointerCapture = React.useCallback(() => {
    const pid = linkPointerIdRef.current;
    const dom = stageRef.current?.container() as (HTMLElement & { releasePointerCapture?: (id: number) => void }) | undefined;
    if (dom && pid != null && typeof dom.releasePointerCapture === 'function') {
      try {
        dom.releasePointerCapture(pid);
      } catch {
        // ignore
      }
    }
    linkPointerIdRef.current = null;
  }, []);

  const finalizeRightLinkDraft = React.useCallback(
    (clientX: number, clientY: number, button: number) => {
      if (button !== 2) return;
      const draft = linkDraftRef.current;
      if (!draft) return;
      const start = linkDraftPointerStartRef.current;
      const movement = start ? Math.hypot(clientX - start.x, clientY - start.y) : 0;
      const p = toStageCoords(clientX, clientY);
      const target = nodes.find(
        (n) =>
          n.id !== draft.sourceId &&
          p.x >= n.x &&
          p.x <= n.x + TOPO_NODE_WIDTH &&
          p.y >= n.y &&
          p.y <= n.y + TOPO_NODE_HEIGHT
      );
      const source = nodes.find((n) => n.id === draft.sourceId);

      if (movement < TOPO_LINK_DRAG_THRESHOLD_PX) {
        if (source) {
          openNodeActionMenu(source, clientX, clientY);
          suppressContextMenuRef.current = true;
        }
      } else if (target) {
        void createManualLink(draft.sourceId, target.id);
        suppressContextMenuRef.current = true;
      } else if (movement >= TOPO_LINK_DRAG_THRESHOLD_PX) {
        suppressContextMenuRef.current = true;
      }

      setLinkDraft(null);
      linkDraftPointerStartRef.current = null;
      releaseLinkPointerCapture();
    },
    [createManualLink, nodes, openNodeActionMenu, releaseLinkPointerCapture, toStageCoords]
  );

  React.useEffect(() => {
    if (!linkDraft) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setLinkDraft(null);
        linkDraftPointerStartRef.current = null;
        releaseLinkPointerCapture();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [linkDraft, releaseLinkPointerCapture]);

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
                disabled={autoLayoutState === 'running'}
                className="flex items-center gap-2 px-3 py-1.5 bg-[#2c2e33] text-[#c1c2c5] hover:text-white rounded text-[10px] font-bold uppercase transition-all border border-[#373a40] disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {autoLayoutState === 'running' ? <Loader2 size={14} className="animate-spin" /> : <Box size={14} />}
                {autoLayoutState === 'running'
                  ? t('topologyLayoutRunning')
                  : autoLayoutState === 'timed_out'
                    ? t('topologyLayoutTimeout')
                    : t('autoLayout')}
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
          <div className="h-4 w-px bg-[#373a40] mx-1" />
          <span className="text-[10px] text-[#909296] uppercase tracking-wide">{t('topologyZones')}</span>
          <button
            type="button"
            onClick={() => setSelectedZone('__all__')}
            className={`px-3 py-1 rounded text-[10px] font-bold uppercase border ${selectedZone === '__all__' ? 'bg-[#12b886] border-[#12b886] text-white' : 'bg-[#2c2e33] border-[#373a40] text-[#c1c2c5]'}`}
          >
            {t('topologyAllZones')}
          </button>
          {zones.map((z) => (
            editingZoneKey === z ? (
              <input
                key={`zone-edit-${z}`}
                value={editingZoneValue}
                autoFocus
                onChange={(e) => setEditingZoneValue(e.target.value)}
                onBlur={handleRenameZoneInline}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRenameZoneInline();
                  if (e.key === 'Escape') {
                    setEditingZoneKey(null);
                    setEditingZoneValue('');
                  }
                }}
                placeholder={t('topologyZoneRenamePlaceholder')}
                className="bg-[#141517] border border-[#12b886] rounded px-2 py-1 text-[10px] font-bold text-white w-32"
              />
            ) : (
              <button
                key={`zone-${z}`}
                type="button"
                onClick={() => setSelectedZone(z)}
                onDoubleClick={() => openZoneRenameEditor(z)}
                onTouchEnd={() => handleZoneTouchEnd(z)}
                className={`px-3 py-1 rounded text-[10px] font-bold border ${selectedZone === z ? 'bg-[#12b886] border-[#12b886] text-white' : 'bg-[#2c2e33] border-[#373a40] text-[#c1c2c5]'}`}
                title={canEditTopology ? t('topologyZoneRenameHint') : t('topologyZoneDerivedHint')}
              >
                {zoneLabel(z)}
              </button>
            )
          ))}
        </div>
        <div className="text-[10px] text-[#909296]">
          {canEditTopology ? `${t('renameTabInlineHint')} ${t('topologyZoneRenameHint')} ${t('topologyZoneDerivedHint')}` : t('topologyZoneDerivedHint')}
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
          linkDraftPointerStartRef.current = null;
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
            const stage = e.target.getStage();
            if (linkDraftRef.current && evt.button === 2 && stage && e.target === stage) {
              evt.preventDefault();
              setLinkDraft(null);
              linkDraftPointerStartRef.current = null;
              releaseLinkPointerCapture();
              return;
            }
            if (linkDraftRef.current && evt.button === 0) return;
            if (evt.button === 0 && !isNodeDragging) {
              if (!stage || e.target !== stage) return;
              evt.preventDefault();
              const p = toStageCoords(evt.clientX, evt.clientY);
              setContextMenu(null);
              setEditingLinkId(null);
              setSelectionDraft({ x1: p.x, y1: p.y, x2: p.x, y2: p.y });
              return;
            }
            if (evt.button !== 2 || isNodeDragging) return;
            if (linkDraftRef.current) return;
            if (!stage || e.target !== stage) return;
            evt.preventDefault();
            setContextMenu(null);
            setEditingLinkId(null);
            setIsRightPanning(true);
            panLastPointRef.current = { x: evt.clientX, y: evt.clientY };
          }}
          onMouseMove={(e) => {
            if (selectionDraft) {
              const evt = e.evt as MouseEvent;
              const p = toStageCoords(evt.clientX, evt.clientY);
              setSelectionDraft((prev) => (prev ? { ...prev, x2: p.x, y2: p.y } : prev));
              return;
            }
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
          onMouseUp={(e) => {
            const evt = e.evt as MouseEvent;
            if (linkDraftRef.current && evt.button === 2) {
              finalizeRightLinkDraft(evt.clientX, evt.clientY, 2);
            } else if (linkDraftRef.current && evt.button === 0) {
              setLinkDraft(null);
              linkDraftPointerStartRef.current = null;
              releaseLinkPointerCapture();
            }
            if (selectionDraft) {
              const x = Math.min(selectionDraft.x1, selectionDraft.x2);
              const y = Math.min(selectionDraft.y1, selectionDraft.y2);
              const width = Math.abs(selectionDraft.x2 - selectionDraft.x1);
              const height = Math.abs(selectionDraft.y2 - selectionDraft.y1);
              if (width < 4 && height < 4) {
                setSelectedNodeIds([]);
              } else {
                const nextSelected = nodes
                  .filter((node) => {
                    const nx1 = node.x;
                    const ny1 = node.y;
                    const nx2 = node.x + TOPO_NODE_WIDTH;
                    const ny2 = node.y + TOPO_NODE_HEIGHT;
                    const sx2 = x + width;
                    const sy2 = y + height;
                    return nx1 < sx2 && nx2 > x && ny1 < sy2 && ny2 > y;
                  })
                  .map((node) => node.id);
                setSelectedNodeIds(nextSelected);
              }
              setSelectionDraft(null);
            }
            setIsRightPanning(false);
            panLastPointRef.current = null;
          }}
          onMouseLeave={() => {
            setIsRightPanning(false);
            panLastPointRef.current = null;
            setSelectionDraft(null);
          }}
          onWheel={handleWheelZoom}
        >
          <Layer>
            {zoneBoxes.map((zone) => (
              <Rect
                key={`zone-box-${zone.zoneKey}`}
                x={zone.x}
                y={zone.y}
                width={zone.width}
                height={zone.height}
                cornerRadius={10}
                stroke="#12b886"
                strokeWidth={1.5}
                dash={[10, 7]}
                fill="rgba(18, 184, 134, 0.08)"
                listening={false}
              />
            ))}
            {renderedLinks.map((rendered, i) => {
              const link = rendered.link;
              const linkId = link.id || `${link.source}::${link.target}::${i}`;
              const isTrunk = rendered.isTrunk;
              const isEditing = editingLinkId === link.id;
              const lineColor = isTrunk ? TOPO_TRUNK_STROKE : link.manual ? TOPO_MANUAL_LINK_STROKE : TOPO_REGULAR_LINK_STROKE;
              const labelX = rendered.labelX - rendered.labelWidth / 2;
              const labelY = rendered.labelY - rendered.labelHeight / 2;
              const linkIdentity = link.id || `${link.source}:${link.target}:${rendered.idx}`;
              const showLabel = isTrunk || isEditing || hoveredLinkId === linkIdentity || !!link.manual;
              return (
                <React.Fragment key={`link-${linkId}`}>
                  <Line
                    points={rendered.linePoints}
                    stroke={isEditing ? '#ffffff' : lineColor}
                    strokeWidth={isTrunk ? 4.4 : 1.6}
                    opacity={isTrunk ? 0.96 : rendered.deemphasized ? 0.22 : 0.5}
                    dash={isTrunk ? undefined : [8, 6]}
                    lineCap="round"
                    lineJoin="round"
                    shadowColor={isTrunk ? TOPO_TRUNK_STROKE : undefined}
                    shadowBlur={isTrunk ? 8 : 0}
                    shadowOpacity={isTrunk ? 0.35 : 0}
                    onMouseDown={(e) => {
                      e.cancelBubble = true;
                    }}
                    onMouseEnter={() => setHoveredLinkId(linkIdentity)}
                    onMouseLeave={() => setHoveredLinkId((prev) => (prev === linkIdentity ? null : prev))}
                    onDblClick={(e) => {
                      e.cancelBubble = true;
                      openLinkEditor(link);
                    }}
                  />
                  {showLabel && (
                    <>
                      <Rect
                        x={labelX}
                        y={labelY}
                        width={rendered.labelWidth}
                        height={rendered.labelHeight}
                        cornerRadius={6}
                        fill={isTrunk ? TOPO_TRUNK_LABEL_FILL : TOPO_REGULAR_LABEL_FILL}
                        stroke={isEditing ? '#ffffff' : isTrunk ? TOPO_TRUNK_LABEL_STROKE : TOPO_REGULAR_LABEL_STROKE}
                        strokeWidth={isEditing ? 1.2 : isTrunk ? 1.1 : 0.8}
                        opacity={isTrunk ? 1 : 0.72}
                        onMouseDown={(e) => {
                          e.cancelBubble = true;
                        }}
                        onMouseEnter={() => setHoveredLinkId(linkIdentity)}
                        onMouseLeave={() => setHoveredLinkId((prev) => (prev === linkIdentity ? null : prev))}
                        onDblClick={(e) => {
                          e.cancelBubble = true;
                          openLinkEditor(link);
                        }}
                      />
                      <Text
                        x={labelX}
                        y={labelY + 1}
                        width={rendered.labelWidth}
                        height={rendered.labelHeight}
                        text={rendered.labelText}
                        fill={isEditing ? "#ffffff" : isTrunk ? "#fff4e6" : "#ced4da"}
                        fontSize={10}
                        fontStyle="bold"
                        align="center"
                        verticalAlign="middle"
                        onMouseDown={(e) => {
                          e.cancelBubble = true;
                        }}
                        onMouseEnter={() => setHoveredLinkId(linkIdentity)}
                        onMouseLeave={() => setHoveredLinkId((prev) => (prev === linkIdentity ? null : prev))}
                        onDblClick={(e) => {
                          e.cancelBubble = true;
                          openLinkEditor(link);
                        }}
                      />
                    </>
                  )}
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
            {selectionRect && (
              <Rect
                x={selectionRect.x}
                y={selectionRect.y}
                width={selectionRect.width}
                height={selectionRect.height}
                stroke="#4dabf7"
                strokeWidth={1.5}
                dash={[6, 4]}
                fill="rgba(77, 171, 247, 0.12)"
                listening={false}
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
                  stroke={selectedNodeIdSet.has(node.id) ? '#4dabf7' : NODE_COLORS[getNodeSeverity(node)]}
                  strokeWidth={selectedNodeIdSet.has(node.id) ? 3 : 2}
                  cornerRadius={4}
                  draggable={canEditTopology}
                  onDragStart={(e) => {
                    e.cancelBubble = true;
                    setIsNodeDragging(true);
                    if (selectedNodeIdSet.has(node.id) && selectedNodeIds.length > 1) {
                      const originPositions: Record<string, { x: number; y: number }> = {};
                      nodes.forEach((n) => {
                        if (selectedNodeIdSet.has(n.id)) originPositions[n.id] = { x: n.x, y: n.y };
                      });
                      groupDragRef.current = {
                        anchorId: node.id,
                        anchorStart: { x: node.x, y: node.y },
                        originPositions,
                      };
                    } else {
                      groupDragRef.current = null;
                    }
                  }}
                  onDragEnd={(e) => {
                    e.cancelBubble = true;
                    setIsNodeDragging(false);
                    const dragState = groupDragRef.current;
                    if (dragState && dragState.anchorId === node.id) {
                      const dx = e.target.x() - dragState.anchorStart.x;
                      const dy = e.target.y() - dragState.anchorStart.y;
                      const movedPositions = Object.fromEntries(
                        Object.entries(dragState.originPositions).map(([id, p]) => [
                          id,
                          { x: p.x + dx, y: p.y + dy },
                        ])
                      );
                      setNodes((prev) =>
                        prev.map((n) => (movedPositions[n.id] ? { ...n, ...movedPositions[n.id] } : n))
                      );
                      setSavedLayout((prev) => ({ ...prev, ...movedPositions }));
                      persistLayoutPositions(movedPositions);
                      groupDragRef.current = null;
                      return;
                    }
                    handleDragEnd(node.id, e);
                  }}
                  onDragMove={(e) => {
                    e.cancelBubble = true;
                    const dragState = groupDragRef.current;
                    if (!dragState || dragState.anchorId !== node.id) return;
                    const dx = e.target.x() - dragState.anchorStart.x;
                    const dy = e.target.y() - dragState.anchorStart.y;
                    setNodes((prev) =>
                      prev.map((n) => {
                        const origin = dragState.originPositions[n.id];
                        if (!origin) return n;
                        return { ...n, x: origin.x + dx, y: origin.y + dy };
                      })
                    );
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
                      const center = getNodeCenter(node.id);
                      setLinkDraft({ sourceId: node.id, x1: center.x, y1: center.y, x2: center.x, y2: center.y });
                      linkDraftPointerStartRef.current = { x: evt.clientX, y: evt.clientY };
                      const pe = evt as PointerEvent;
                      if (typeof pe.pointerId === 'number') {
                        linkPointerIdRef.current = pe.pointerId;
                        const dom = stageRef.current?.container();
                        if (dom && typeof dom.setPointerCapture === 'function') {
                          try {
                            dom.setPointerCapture(pe.pointerId);
                          } catch {
                            // ignore
                          }
                        }
                      }
                      return;
                    }
                  }}
                  onMouseUp={(e) => {
                    const evt = e.evt as MouseEvent;
                    if (linkDraftRef.current && evt.button === 2) {
                      e.cancelBubble = true;
                      finalizeRightLinkDraft(evt.clientX, evt.clientY, 2);
                      setIsNodeDragging(false);
                      return;
                    }
                    e.cancelBubble = true;
                    setIsNodeDragging(false);
                  }}
                  onContextMenu={(e) => {
                    e.evt.preventDefault();
                    if (suppressContextMenuRef.current) {
                      suppressContextMenuRef.current = false;
                      return;
                    }
                    const evt = e.evt as MouseEvent;
                    openNodeActionMenu(node, evt.clientX, evt.clientY);
                  }}
                />
                <Text x={node.x + 10} y={node.y + 12} text={node.name} fill="white" fontSize={12} fontStyle="bold" />
                <Text x={node.x + 10} y={node.y + 32} text={node.vendor} fill="#909296" fontSize={9} />
                <Text x={node.x + 10} y={node.y + 55} text={node.ip} fill="#228be6" fontSize={10} fontFamily="monospace" />
                <Circle
                  x={node.x + 145}
                  y={node.y + 15}
                  radius={4}
                  fill={NODE_COLORS[getNodeSeverity(node)]}
                />
              </React.Fragment>
            ))}
            {zoneBoxes.map((zone) => (
              <Text
                key={`zone-label-${zone.zoneKey}`}
                x={zone.x + 10}
                y={zone.y + 8}
                text={zone.label}
                fill="#63e6be"
                fontSize={11}
                fontStyle="bold"
                listening={false}
              />
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

