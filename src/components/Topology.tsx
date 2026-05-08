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
type LinkDraft = { sourceId: string; x1: number; y1: number; x2: number; y2: number } | null;

type NodeWithPos = Switch & { x: number; y: number };

const TOPO_NODE_WIDTH = 160;
const TOPO_NODE_HEIGHT = 80;
const TOPO_LAYER_GAP = 170;
const TOPO_CLUSTER_STEP_X = 430;
const TOPO_RING_STEP = 122;

function computeLayout(switches: Switch[], links: TopoLink[], cw: number, ch: number): NodeWithPos[] {
  if (switches.length === 0) return [];
  const width = Math.max(1500, Math.floor(cw * 1.45));
  const height = Math.max(980, Math.floor(ch * 1.4));
  const margin = 110;
  const rightLimit = width - TOPO_NODE_WIDTH - 30;
  const bottomLimit = height - TOPO_NODE_HEIGHT - 30;
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
  const stableHash = (value: string) => {
    let h = 0;
    for (let i = 0; i < value.length; i++) h = (h * 131 + value.charCodeAt(i)) % 2147483647;
    return h;
  };
  const stableSort = (items: Switch[], rank: (s: Switch) => number) =>
    [...items].sort((a, b) => {
      const dr = rank(b) - rank(a);
      if (dr !== 0) return dr;
      const na = String(a.name || '').toLowerCase();
      const nb = String(b.name || '').toLowerCase();
      if (na !== nb) return na.localeCompare(nb);
      return String(a.id).localeCompare(String(b.id));
    });

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

  const trunkThreshold = Math.max(3, Math.ceil(Math.sqrt(Math.max(2, switches.length)) * 1.4));
  const isTrunkRich = (s: Switch) => (degree.get(s.id) || 0) >= trunkThreshold;

  const routers = stableSort(switches.filter(isRouterLike), (s) => degree.get(s.id) || 0);
  let cores = stableSort(
    switches.filter((s) => !isRouterLike(s) && isExplicitCore(s)),
    (s) => degree.get(s.id) || 0
  );
  if (!cores.length) {
    cores = stableSort(
      switches.filter((s) => !isRouterLike(s) && !isDistribution(s) && !isAccess(s) && isTrunkRich(s)),
      (s) => degree.get(s.id) || 0
    );
  }

  const pos = new Map<string, { x: number; y: number }>();
  if (!cores.length) {
    const ranked = stableSort(switches, (s) => degree.get(s.id) || 0);
    ranked.forEach((s, idx) => {
      const row = Math.floor(idx / 5);
      const col = idx % 5;
      pos.set(s.id, {
        x: margin + col * (TOPO_NODE_WIDTH + 90),
        y: margin + row * (TOPO_NODE_HEIGHT + 90),
      });
    });
  } else {
    const sourceCores = stableSort(cores, (s) => degree.get(s.id) || 0);
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
      for (const v of adj.get(u) || []) {
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

    const unassigned = switches.filter((s) => !owners.has(s.id));
    unassigned.forEach((s) => {
      const fallback = sourceCores[stableHash(s.id) % sourceCores.length];
      owners.set(s.id, fallback.id);
    });

    const clusterNodes = new Map<string, Switch[]>();
    sourceCores.forEach((c) => clusterNodes.set(c.id, [c]));
    stableSort(switches, (s) => degree.get(s.id) || 0).forEach((s) => {
      if (sourceCores.some((c) => c.id === s.id)) return;
      const owner = owners.get(s.id)!;
      if (!clusterNodes.has(owner)) clusterNodes.set(owner, []);
      clusterNodes.get(owner)!.push(s);
    });

    const hasRouterLayer = routers.length > 0;
    const yRouter = margin;
    const yCore = margin + (hasRouterLayer ? TOPO_LAYER_GAP : 0) + 30;
    const yDist = yCore + TOPO_LAYER_GAP;
    const yAccess = yDist + TOPO_LAYER_GAP;
    const yUnknown = Math.min(bottomLimit - 20, yAccess + TOPO_LAYER_GAP + 40);

    const left = margin;
    const availableWidth = Math.max(800, width - margin * 2 - 280);
    const coreStep = Math.max(TOPO_CLUSTER_STEP_X, availableWidth / Math.max(1, sourceCores.length - 1));

    sourceCores.forEach((core, idx) => {
      const x = sourceCores.length === 1
        ? left + availableWidth / 2
        : left + idx * coreStep;
      pos.set(core.id, { x, y: yCore });
    });

    stableSort(routers, (s) => degree.get(s.id) || 0).forEach((r, idx) => {
      if (sourceCores.length === 1) {
        pos.set(r.id, { x: left + availableWidth / 2 + (idx - (routers.length - 1) / 2) * 170, y: yRouter });
      } else {
        const targetCore = sourceCores[idx % sourceCores.length];
        const base = pos.get(targetCore.id)?.x || left + availableWidth / 2;
        const offset = (Math.floor(idx / sourceCores.length) - 0.5) * 145;
        pos.set(r.id, { x: base + offset, y: yRouter });
      }
    });

    const unknown: Switch[] = [];
    sourceCores.forEach((core) => {
      const center = pos.get(core.id)!;
      const members = clusterNodes.get(core.id) || [];
      const distribution = stableSort(
        members.filter((n) => n.id !== core.id && isDistribution(n)),
        (n) => degree.get(n.id) || 0
      );
      const access = stableSort(
        members.filter((n) => n.id !== core.id && isAccess(n)),
        (n) => degree.get(n.id) || 0
      );
      const rest = stableSort(
        members.filter((n) => n.id !== core.id && !isDistribution(n) && !isAccess(n)),
        (n) => degree.get(n.id) || 0
      );

      const placeArc = (items: Switch[], radius: number, yBase: number, spread: number) => {
        if (!items.length) return;
        const total = items.length;
        const minAngle = Math.PI * (0.2 + spread);
        const maxAngle = Math.PI * (0.8 - spread);
        items.forEach((n, i) => {
          const t = total === 1 ? 0.5 : i / (total - 1);
          const angle = minAngle + (maxAngle - minAngle) * t;
          pos.set(n.id, {
            x: center.x + Math.cos(angle) * radius,
            y: yBase + Math.sin(angle) * 34,
          });
        });
      };

      placeArc(distribution, Math.max(145, TOPO_RING_STEP + 28), yDist, 0.06);
      placeArc(access, Math.max(250, TOPO_RING_STEP * 2), yAccess, 0.02);

      rest.forEach((n) => {
        const hasNeighborInCluster = Array.from(adj.get(n.id) || []).some((nb) => owners.get(nb) === core.id);
        if (!hasNeighborInCluster || (degree.get(n.id) || 0) <= 1) unknown.push(n);
      });
      const restKnown = rest.filter((n) => !unknown.some((u) => u.id === n.id));
      restKnown.forEach((n, idx) => {
        const row = Math.floor(idx / 4);
        const col = idx % 4;
        pos.set(n.id, {
          x: center.x - 170 + col * 110,
          y: yAccess + 95 + row * 86,
        });
      });
    });

    const unknownSet = new Set(unknown.map((n) => n.id));
    const stillUnplaced = switches.filter((s) => !pos.has(s.id));
    stillUnplaced.forEach((s) => unknownSet.add(s.id));
    const unknownNodes = stableSort(
      switches.filter((s) => unknownSet.has(s.id)),
      (s) => degree.get(s.id) || 0
    );
    const unknownStartX = Math.max(width - 380, margin + Math.min(width * 0.72, availableWidth + margin * 0.4));
    unknownNodes.forEach((n, idx) => {
      const col = idx % 2;
      const row = Math.floor(idx / 2);
      pos.set(n.id, {
        x: unknownStartX + col * 185,
        y: yUnknown + row * 98,
      });
    });
  }

  const points = switches.map((s) => {
    const p = pos.get(s.id) || { x: width / 2, y: height / 2 };
    return { id: s.id, x: p.x, y: p.y };
  });
  const idToIndex = new Map(points.map((p, idx) => [p.id, idx]));
  const minGapX = TOPO_NODE_WIDTH + 54;
  const minGapY = TOPO_NODE_HEIGHT + 34;

  for (let iter = 0; iter < 120; iter++) {
    let moved = false;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i];
        const b = points[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        if (Math.abs(dx) < minGapX && Math.abs(dy) < minGapY) {
          const signX = dx === 0 ? (stableHash(a.id) % 2 === 0 ? -1 : 1) : Math.sign(dx);
          const signY = dy === 0 ? (stableHash(b.id) % 2 === 0 ? -1 : 1) : Math.sign(dy);
          const pushX = (minGapX - Math.abs(dx)) * 0.22 * signX;
          const pushY = (minGapY - Math.abs(dy)) * 0.2 * signY;
          a.x -= pushX;
          b.x += pushX;
          a.y -= pushY;
          b.y += pushY;
          moved = true;
        }
      }
    }

    links.forEach((l) => {
      const ai = idToIndex.get(l.source);
      const bi = idToIndex.get(l.target);
      if (ai === undefined || bi === undefined) return;
      const a = points[ai];
      const b = points[bi];
      const spanX = b.x - a.x;
      if (Math.abs(spanX) > TOPO_CLUSTER_STEP_X * 1.3) {
        const pull = (Math.abs(spanX) - TOPO_CLUSTER_STEP_X * 1.3) * 0.03 * Math.sign(spanX);
        a.x += pull;
        b.x -= pull;
        moved = true;
      }
    });

    points.forEach((p) => {
      p.x = Math.min(rightLimit, Math.max(35, p.x));
      p.y = Math.min(bottomLimit, Math.max(35, p.y));
    });

    if (!moved) break;
  }

  return switches.map((s) => {
    const p = points.find((x) => x.id === s.id) || { x: width / 2, y: height / 2 };
    return {
      ...s,
      x: Math.min(rightLimit, Math.max(35, p.x)),
      y: Math.min(bottomLimit, Math.max(35, p.y)),
    };
  });
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
  const [topologyMode, setTopologyMode] = useState<'ip' | 'fc'>('ip');
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
        const response = await fetch('/api/topology/links');
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
  }, [topologySwitches]);

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
      const rebuild = await fetch('/api/topology/links/rebuild', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown'
        },
        body: JSON.stringify({ branch: selectedRegion }),
      });
      if (!rebuild.ok) {
        const err = await rebuild.json().catch(() => null);
        console.warn('Topology rebuild failed, using existing links', err?.error || '');
      }
      const response = await fetch('/api/topology/links', {
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
      setNodes(
        computed.map((n) => {
          const saved = (data.layout || {})[n.id];
          return saved ? { ...n, x: saved.x, y: saved.y } : n;
        })
      );
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
        body: JSON.stringify({ branch: selectedRegion }),
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positions: { [id]: { x, y } } }),
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
      const res = await fetch('/api/topology/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source,
          target,
          portA: String(comment || '').trim() || t('topologyLinkCommentDefault'),
          portB: '',
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
        body: JSON.stringify(link),
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
            {canEditTopology && (
              <span className="text-[10px] text-[#909296] uppercase tracking-wider">
                {t('topologyVersions')}: {topologyVersionCount}
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                setVersionsOpen(true);
                refreshTopologyVersions();
              }}
              className="flex items-center gap-2 px-3 py-1.5 bg-[#2c2e33] text-[#c1c2c5] hover:text-white rounded text-[10px] font-bold uppercase transition-all border border-[#373a40]"
            >
              <Box size={14} />
              {t('topologyVersions')}
            </button>
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
            setLinkDraft(null);
          }}
          onMouseLeave={() => {
            setIsRightPanning(false);
            panLastPointRef.current = null;
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
                      if (!canEditTopology) return;
                      if (!link.id) return;
                      setEditingLinkId(link.id);
                      setEditingLinkValue({ comment: getLinkLabel(link) });
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
                      setLinkDraft(null);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.evt.preventDefault();
                    if (!canEditTopology) return;
                    if (linkDraft) return;
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
                      <tr key={v.id} className="border-t border-[#2c2e33]">
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
