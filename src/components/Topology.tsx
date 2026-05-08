import React, { useState, useRef, useEffect } from 'react';
import { Stage, Layer, Rect, Text, Line, Circle } from 'react-konva';
import { Share2, Box, ZoomIn, ZoomOut, RotateCcw, Globe, TerminalSquare } from 'lucide-react';
import { Switch } from '../types';
import { useTranslation } from '../lib/i18n';
import { deriveZoneKey } from '../lib/zoneKey';

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
const TOPO_VENDOR_GROUP_GAP_X = 220;
const TOPO_VENDOR_LAYER_GAP_Y = 150;
const TOPO_VENDOR_MAX_COLUMNS = 5;
const TOPO_ZONE_MIN_WIDTH = TOPO_NODE_WIDTH + TOPO_ZONE_PAD_X * 2;
const TOPO_MAX_COLUMNS = 8;
const TOPO_MAX_ZONE_COLUMNS_PER_ROW = 5;
const TOPO_STAGE_SIDE_PADDING = 35;
const TOPO_LAYOUT_MAX_WIDTH = 1900;
const TOPO_LAYOUT_FIT_SCALE = 0.82;

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
  void links;
  void ch;
  const stageWidth = Math.max(cw, 1100);
  const layoutWidth = Math.min(
    TOPO_LAYOUT_MAX_WIDTH,
    Math.max(1100, (stageWidth - TOPO_STAGE_SIDE_PADDING * 2) / TOPO_LAYOUT_FIT_SCALE)
  );
  const priorityMikroTik = switches.filter(isMikroTikSwitch).sort(sortSwitchesByNameThenId);
  const priorityCisco = switches
    .filter((sw) => !isMikroTikSwitch(sw) && isCiscoSwitch(sw))
    .sort(sortSwitchesByNameThenId);
  const lowerSwitches = switches.filter((sw) => !isPriorityVendorSwitch(sw));
  const zones = new Map<string, Switch[]>();
  lowerSwitches.forEach((sw) => {
    const zoneKey = deriveZoneKey(sw.name) || '__ungrouped__';
    if (!zones.has(zoneKey)) zones.set(zoneKey, []);
    zones.get(zoneKey)!.push(sw);
  });

  const zonePlans = Array.from(zones.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([zoneKey, zoneSwitches]) => {
      const others = zoneSwitches.sort(sortSwitchesByNameThenId);
      const otherCols = Math.max(1, Math.min(TOPO_MAX_COLUMNS, others.length || 1));
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
  const vendorGroups = [
    { key: 'mikrotik', switches: priorityMikroTik },
    { key: 'cisco', switches: priorityCisco },
  ]
    .filter((group) => group.switches.length > 0)
    .map((group) => {
      const cols = Math.max(1, Math.min(TOPO_VENDOR_MAX_COLUMNS, group.switches.length));
      const rows = Math.max(1, Math.ceil(group.switches.length / cols));
      return {
        ...group,
        cols,
        width: Math.max(TOPO_ZONE_MIN_WIDTH, cols * TOPO_NODE_WIDTH + Math.max(0, cols - 1) * (TOPO_COLUMN_GAP - TOPO_NODE_WIDTH) + TOPO_ZONE_PAD_X * 2),
        height: TOPO_ROW_TOP_Y + (rows - 1) * TOPO_ROW_HEIGHT + TOPO_NODE_HEIGHT + TOPO_ZONE_PAD_BOTTOM,
      };
    });
  const vendorLayerWidth = vendorGroups.reduce(
    (total, group, index) => total + group.width + (index > 0 ? TOPO_VENDOR_GROUP_GAP_X : 0),
    0
  );
  let rowY = 70;
  if (vendorGroups.length > 0) {
    let vendorX = Math.max(TOPO_STAGE_SIDE_PADDING, stageWidth / 2 - vendorLayerWidth / 2);
    vendorGroups.forEach((vendorGroup) => {
      placeRow(vendorGroup.switches, vendorX, vendorGroup.width, rowY + TOPO_ROW_TOP_Y, vendorGroup.cols);
      vendorX += vendorGroup.width + TOPO_VENDOR_GROUP_GAP_X;
    });
    rowY += Math.max(...vendorGroups.map((vendorGroup) => vendorGroup.height)) + TOPO_VENDOR_LAYER_GAP_Y;
  }

  const rows: Array<{ plans: typeof zonePlans; width: number; height: number }> = [];
  let currentRow: { plans: typeof zonePlans; width: number; height: number } = { plans: [], width: 0, height: 0 };
  zonePlans.forEach((plan) => {
    const nextWidth = currentRow.width === 0 ? plan.width : currentRow.width + TOPO_ZONE_GAP_X + plan.width;
    if (
      currentRow.plans.length &&
      (currentRow.plans.length >= TOPO_MAX_ZONE_COLUMNS_PER_ROW || nextWidth > layoutWidth)
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

  rows.forEach((row, rowIndex) => {
    const rowOffset = rowIndex % 2 === 1 ? TOPO_ROW_STAGGER_X : 0;
    let zoneX = Math.max(TOPO_STAGE_SIDE_PADDING, stageWidth / 2 - row.width / 2 + rowOffset);
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
    if (isPriorityVendorSwitch(n)) return n;
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
          const err = await readApiPayload(rebuild, 'Topology rebuild failed').catch(() => null);
          console.warn('Topology rebuild failed, using existing links', apiErrorDetailText(err, rebuild.status));
        }
      }
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
      } = await readApiPayload(response, 'Topology load failed');
      if (!response.ok) throw new Error(operationFailedMessage('Topology load', data, response.status));
      setLinks(data.links || []);
      setSavedLayout(data.layout || {});
      setZoneLabelOverrides(data.zoneLabelOverrides || {});
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
      const computed = computeLayout(zoneSwitches, visibleLinks, w, h);
      const freshLayout = data.layout || {};
      const legacy = computeLegacyFlatLayout(zoneSwitches, visibleLinks, w, h);
      const legacyPositions = new Map(legacy.map((n) => [n.id, { x: n.x, y: n.y }]));
      const merged = mergeManualAnchors(computed, freshLayout, legacyPositions);
      setNodes(merged);
      setSavedLayout(freshLayout);
    } catch (error) {
      console.error('Failed to refresh topology:', error);
      alert(operationFailedMessage('Topology auto-layout', error instanceof Error ? error.message : error));
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
        const start = getNodeCenter(link.source);
        const end = getNodeCenter(link.target);
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
        const labelLineOffset = 22 + laneDistance * 4;
        const tangentShift = (idx % 2 === 0 ? 1 : -1) * Math.ceil(idx / 2) * 12;
        const labelX = (x1 + x2) / 2 + nx * labelLineOffset + tx * tangentShift;
        const labelY = (y1 + y2) / 2 + ny * labelLineOffset + ty * tangentShift;
        const labelWidth = Math.max(52, Math.ceil(displayLabel.length * 6.1 + 16));
        const labelHeight = 16;
        return {
          link,
          idx,
          isTrunk,
          linePoints: [x1, y1, x2, y2] as [number, number, number, number],
          labelText: displayLabel,
          labelX,
          labelY,
          labelWidth,
          labelHeight,
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
            if (linkDraft) return;
            const stage = e.target.getStage();
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
          onMouseUp={() => {
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
            linkDraftPointerStartRef.current = null;
            setLinkDraft(null);
          }}
          onMouseLeave={() => {
            setIsRightPanning(false);
            panLastPointRef.current = null;
            linkDraftPointerStartRef.current = null;
            setLinkDraft(null);
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
              return (
                <React.Fragment key={`link-${linkId}`}>
                  <Line
                    points={rendered.linePoints}
                    stroke={isEditing ? '#ffffff' : lineColor}
                    strokeWidth={isTrunk ? 4.4 : 1.6}
                    opacity={isTrunk ? 0.96 : 0.46}
                    dash={isTrunk ? undefined : [8, 6]}
                    lineCap="round"
                    lineJoin="round"
                    shadowColor={isTrunk ? TOPO_TRUNK_STROKE : undefined}
                    shadowBlur={isTrunk ? 8 : 0}
                    shadowOpacity={isTrunk ? 0.35 : 0}
                    onMouseDown={(e) => {
                      e.cancelBubble = true;
                    }}
                    onDblClick={(e) => {
                      e.cancelBubble = true;
                      openLinkEditor(link);
                    }}
                  />
                  <Rect
                    x={labelX}
                    y={labelY}
                    width={rendered.labelWidth}
                    height={rendered.labelHeight}
                    cornerRadius={6}
                    fill={isTrunk ? TOPO_TRUNK_LABEL_FILL : TOPO_REGULAR_LABEL_FILL}
                    stroke={isEditing ? '#ffffff' : isTrunk ? TOPO_TRUNK_LABEL_STROKE : TOPO_REGULAR_LABEL_STROKE}
                    strokeWidth={isEditing ? 1.2 : isTrunk ? 1.1 : 0.8}
                    opacity={isTrunk ? 1 : 0.88}
                    onMouseDown={(e) => {
                      e.cancelBubble = true;
                    }}
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
                      linkDraftPointerStartRef.current = { x: evt.clientX, y: evt.clientY };
                      const center = getNodeCenter(node.id);
                      setLinkDraft({ sourceId: node.id, x1: center.x, y1: center.y, x2: center.x, y2: center.y });
                    }
                  }}
                  onMouseUp={(e) => {
                    e.cancelBubble = true;
                    setIsNodeDragging(false);
                    const evt = e.evt as MouseEvent;
                    if (canEditTopology && evt.button === 2 && linkDraft?.sourceId && linkDraft.sourceId !== node.id) {
                      createManualLink(linkDraft.sourceId, node.id);
                      linkDraftPointerStartRef.current = null;
                      setLinkDraft(null);
                      return;
                    }
                  }}
                  onDblClick={(e) => {
                    e.cancelBubble = true;
                    const evt = e.evt as MouseEvent;
                    if (evt.button !== 0) return;
                    evt.preventDefault();
                    openNodeActionMenu(node, evt.clientX, evt.clientY);
                  }}
                  onDblTap={(e) => {
                    e.cancelBubble = true;
                    const evt = e.evt as TouchEvent;
                    const touch = evt.changedTouches?.[0] || evt.touches?.[0];
                    if (!touch) return;
                    openNodeActionMenu(node, touch.clientX, touch.clientY);
                  }}
                  onContextMenu={(e) => {
                    e.evt.preventDefault();
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

