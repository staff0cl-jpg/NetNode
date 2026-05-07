import React, { useState, useRef, useEffect } from 'react';
import { Stage, Layer, Rect, Text, Line, Circle } from 'react-konva';
import { Share2, Box, ZoomIn, ZoomOut, RotateCcw, Globe, TerminalSquare, Hand } from 'lucide-react';
import { Switch } from '../types';
import { useTranslation } from '../lib/i18n';

interface TopologyProps {
  switches: Switch[];
  role?: string;
  username?: string;
  onOpenSSH?: (sw: Switch) => void;
}

type TopoLink = { source: string; target: string; portA: string; portB: string };

type NodeWithPos = Switch & { x: number; y: number };

function computeLayout(switches: Switch[], links: TopoLink[], cw: number, ch: number): NodeWithPos[] {
  if (switches.length === 0) return [];
  const width = Math.max(1400, Math.floor(cw * 1.4));
  const height = Math.max(900, Math.floor(ch * 1.35));
  const margin = 120;
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

  const seen = new Set<string>();
  const components: string[][] = [];
  for (const s of switches) {
    if (seen.has(s.id)) continue;
    const stack = [s.id];
    const comp: string[] = [];
    seen.add(s.id);
    while (stack.length) {
      const u = stack.pop()!;
      comp.push(u);
      for (const v of adj.get(u) || []) {
        if (seen.has(v)) continue;
        seen.add(v);
        stack.push(v);
      }
    }
    components.push(comp);
  }
  components.sort((a, b) => b.length - a.length);

  const cols = Math.max(1, Math.ceil(Math.sqrt(components.length || 1)));
  const rowH = Math.max(420, (height - margin * 2) / Math.max(1, Math.ceil(components.length / cols)));
  const colW = Math.max(560, (width - margin * 2) / cols);
  const pos = new Map<string, { x: number; y: number }>();

  components.forEach((comp, idx) => {
    const row = Math.floor(idx / cols);
    const col = idx % cols;
    const cx = margin + colW * col + colW / 2;
    const cy = margin + rowH * row + rowH / 2;
    const sortedByDegree = [...comp].sort((a, b) => (degree.get(b) || 0) - (degree.get(a) || 0));
    const cores = sortedByDegree.filter((id) => (degree.get(id) || 0) > 2);
    const root = sortedByDegree[0];
    const starRoots = cores.length > 0 ? cores : [root];

    const starCenters = new Map<string, { x: number; y: number }>();
    const coreRadius = Math.min(Math.max(90, Math.min(colW, rowH) * 0.25), 260);
    starRoots.forEach((coreId, i) => {
      if (starRoots.length === 1) {
        starCenters.set(coreId, { x: cx, y: cy });
      } else {
        const coreAngle = ((Math.PI * 2) / starRoots.length) * i - Math.PI / 2;
        starCenters.set(coreId, {
          x: cx + Math.cos(coreAngle) * coreRadius,
          y: cy + Math.sin(coreAngle) * coreRadius,
        });
      }
    });

    const nearestCore = new Map<string, string>();
    starRoots.forEach((coreId) => {
      nearestCore.set(coreId, coreId);
      const q: string[] = [coreId];
      const visited = new Set<string>([coreId]);
      while (q.length) {
        const u = q.shift()!;
        for (const v of adj.get(u) || []) {
          if (visited.has(v)) continue;
          if (!nearestCore.has(v)) nearestCore.set(v, coreId);
          visited.add(v);
          q.push(v);
        }
      }
    });

    const starNodes = new Map<string, string[]>();
    starRoots.forEach((coreId) => starNodes.set(coreId, [coreId]));
    comp.forEach((id) => {
      if (starRoots.includes(id)) return;
      const coreId = nearestCore.get(id) || starRoots[0];
      if (!starNodes.has(coreId)) starNodes.set(coreId, []);
      starNodes.get(coreId)!.push(id);
    });

    starRoots.forEach((coreId) => {
      const center = starCenters.get(coreId) || { x: cx, y: cy };
      pos.set(coreId, center);
      const members = (starNodes.get(coreId) || []).filter((id) => id !== coreId);
      members.sort((a, b) => (degree.get(b) || 0) - (degree.get(a) || 0));
      const localDepth = new Map<string, number>();
      const queue = [coreId];
      localDepth.set(coreId, 0);
      while (queue.length) {
        const u = queue.shift()!;
        const du = localDepth.get(u) || 0;
        for (const v of adj.get(u) || []) {
          if (localDepth.has(v) || !members.includes(v)) continue;
          localDepth.set(v, du + 1);
          queue.push(v);
        }
      }
      const grouped = new Map<number, string[]>();
      members.forEach((id) => {
        const d = localDepth.get(id) || 1;
        if (!grouped.has(d)) grouped.set(d, []);
        grouped.get(d)!.push(id);
      });
      const maxDepth = Math.max(1, ...Array.from(grouped.keys()));
      const stepR = Math.min(150, (Math.min(colW, rowH) * 0.48) / Math.max(1, maxDepth));
      Array.from(grouped.entries()).forEach(([d, ids]) => {
        const radius = 85 + d * stepR;
        ids.forEach((id, i) => {
          const angle = (Math.PI * 2 * i) / Math.max(1, ids.length) - Math.PI / 2;
          pos.set(id, {
            x: center.x + Math.cos(angle) * radius,
            y: center.y + Math.sin(angle) * radius,
          });
        });
      });
    });
  });

  // Resolve visual overlaps for better readability.
  const points = switches.map((s) => {
    const p = pos.get(s.id) || { x: width / 2, y: height / 2 };
    return { id: s.id, x: p.x, y: p.y };
  });
  const minDx = 230;
  const minDy = 130;
  const maxIterations = points.length > 120 ? 70 : points.length > 70 ? 110 : 160;
  for (let iter = 0; iter < maxIterations; iter++) {
    let moved = false;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i];
        const b = points[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        if (Math.abs(dx) < minDx && Math.abs(dy) < minDy) {
          const pushX = (minDx - Math.abs(dx)) * 0.24 * (dx >= 0 ? 1 : -1);
          const pushY = (minDy - Math.abs(dy)) * 0.24 * (dy >= 0 ? 1 : -1);
          a.x -= pushX;
          b.x += pushX;
          a.y -= pushY;
          b.y += pushY;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  points.forEach((p) => {
    pos.set(p.id, {
      x: Math.min(width - 220, Math.max(40, p.x)),
      y: Math.min(height - 120, Math.max(40, p.y)),
    });
  });

  return switches.map((s) => {
    const p = pos.get(s.id);
    return {
      ...s,
      x: Math.min(width - 220, Math.max(40, p?.x ?? width / 2)),
      y: Math.min(height - 120, Math.max(40, p?.y ?? height / 2)),
    };
  });
}

const Topology: React.FC<TopologyProps> = ({ switches, role, username, onOpenSSH }) => {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<any>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });
  const [links, setLinks] = useState<TopoLink[]>([]);
  const [nodes, setNodes] = useState<NodeWithPos[]>([]);
  const [savedLayout, setSavedLayout] = useState<Record<string, { x: number; y: number }>>({});
  const [manualLink, setManualLink] = useState({ source: '', target: '', portA: '', portB: '' });
  const [scale, setScale] = useState(0.82);
  const [stagePos, setStagePos] = useState({ x: 20, y: 20 });
  const [contextMenu, setContextMenu] = useState<{ node: Switch; x: number; y: number } | null>(null);
  const [isPanMode, setIsPanMode] = useState(false);
  const [isNodeDragging, setIsNodeDragging] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState<string>('');
  const [newRegion, setNewRegion] = useState('');
  const [regionEditor, setRegionEditor] = useState({ from: '', to: '' });
  const topologySwitches = React.useMemo(() => {
    const allowed = new Set(['switch', 'router', 'коммутатор', 'маршрутизатор']);
    return switches.filter((s) => allowed.has(String(s.category || '').trim().toLowerCase()));
  }, [switches]);
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

  const handleAddLink = async () => {
    if (!manualLink.source || !manualLink.target || manualLink.source === manualLink.target) return;
    try {
      const res = await fetch('/api/topology/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manualLink),
      });
      const data = await res.json();
      if (res.ok && Array.isArray(data.links)) {
        setLinks(data.links);
        setManualLink({ source: '', target: '', portA: '', portB: '' });
      }
    } catch (error) {
      console.error('Failed to add link:', error);
    }
  };

  const handleDeleteLink = async (link: TopoLink) => {
    try {
      const res = await fetch('/api/topology/links', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(link),
      });
      const data = await res.json();
      if (res.ok && Array.isArray(data.links)) {
        setLinks(data.links);
      }
    } catch (error) {
      console.error('Failed to delete link:', error);
    }
  };

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

  const handleAddRegion = async () => {
    const value = newRegion.trim();
    if (!value) return;
    try {
      const resp = await fetch('/api/inventory/meta', {
        headers: {
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown'
        }
      });
      const meta = await resp.json();
      const branches = Array.from(new Set([...(meta.branches || []), value]));
      const saveResp = await fetch('/api/inventory/meta', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown'
        },
        body: JSON.stringify({ ...meta, branches }),
      });
      if (!saveResp.ok) throw new Error('Failed to save region');
      setNewRegion('');
      setSelectedRegion(value);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to add region');
    }
  };

  const handleRenameRegion = async () => {
    const from = (regionEditor.from || selectedRegion || '').trim();
    const to = regionEditor.to.trim();
    if (!from || !to || from === to) return;
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
      setRegionEditor({ from: to, to: '' });
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to rename region');
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <header className="p-4 border-b border-[#373a40] bg-[#1c1d21] flex justify-between items-center">
        <div className="flex items-center gap-4">
          <h2 className="text-sm font-bold text-white uppercase tracking-widest flex items-center gap-3">
            <Share2 size={18} className="text-[#228be6]" />
            {t('topologyVisualizer')}
          </h2>
          <div className="h-4 w-px bg-[#373a40]" />
          <nav className="flex gap-2">
            <button
              type="button"
              onClick={handleAutoLayout}
              className="flex items-center gap-2 px-3 py-1.5 bg-[#2c2e33] text-[#c1c2c5] hover:text-white rounded text-[10px] font-bold uppercase transition-all border border-[#373a40]"
            >
              <Box size={14} />
              {t('autoLayout')}
            </button>
            <button
              type="button"
              onClick={() => setIsPanMode((v) => !v)}
              className={`flex items-center gap-1 px-2 py-1.5 rounded text-[10px] font-bold uppercase border ${isPanMode ? 'bg-[#228be6] border-[#228be6] text-white' : 'bg-[#2c2e33] border-[#373a40] text-[#c1c2c5] hover:text-white'}`}
              title="Pan mode"
            >
              <Hand size={12} />
              Pan
            </button>
            <button
              type="button"
              onClick={() => setScale((s) => Math.max(0.35, s - 0.1))}
              className="flex items-center gap-1 px-2 py-1.5 bg-[#2c2e33] text-[#c1c2c5] hover:text-white rounded text-[10px] font-bold uppercase border border-[#373a40]"
              title="Zoom out"
            >
              <ZoomOut size={12} />
            </button>
            <button
              type="button"
              onClick={() => setScale((s) => Math.min(1.8, s + 0.1))}
              className="flex items-center gap-1 px-2 py-1.5 bg-[#2c2e33] text-[#c1c2c5] hover:text-white rounded text-[10px] font-bold uppercase border border-[#373a40]"
              title="Zoom in"
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
              title="Reset view"
            >
              <RotateCcw size={12} />
            </button>
          </nav>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <select value={manualLink.source} onChange={(e) => setManualLink({ ...manualLink, source: e.target.value })} className="bg-[#141517] border border-[#373a40] rounded px-2 py-1 text-white">
            <option value="">Source</option>
            {regionSwitches.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input value={manualLink.portA} onChange={(e) => setManualLink({ ...manualLink, portA: e.target.value })} placeholder="Port A" className="bg-[#141517] border border-[#373a40] rounded px-2 py-1 text-white w-20" />
          <select value={manualLink.target} onChange={(e) => setManualLink({ ...manualLink, target: e.target.value })} className="bg-[#141517] border border-[#373a40] rounded px-2 py-1 text-white">
            <option value="">Target</option>
            {regionSwitches.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input value={manualLink.portB} onChange={(e) => setManualLink({ ...manualLink, portB: e.target.value })} placeholder="Port B" className="bg-[#141517] border border-[#373a40] rounded px-2 py-1 text-white w-20" />
          <button onClick={handleAddLink} className="px-3 py-1 bg-[#228be6] text-white rounded">Link</button>
        </div>
      </header>
      <div className="px-4 py-2 border-b border-[#373a40] bg-[#1a1b1e] flex items-center justify-between">
        <div className="flex items-center gap-2">
          {regions.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setSelectedRegion(r)}
              className={`px-3 py-1 rounded text-[10px] font-bold uppercase border ${selectedRegion === r ? 'bg-[#228be6] border-[#228be6] text-white' : 'bg-[#2c2e33] border-[#373a40] text-[#c1c2c5]'}`}
            >
              {r}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input
            value={newRegion}
            onChange={(e) => setNewRegion(e.target.value)}
            placeholder="Add region"
            className="bg-[#141517] border border-[#373a40] rounded px-2 py-1 text-xs text-white"
          />
          <button onClick={handleAddRegion} className="px-3 py-1 bg-[#40c057] text-white rounded text-[10px] font-bold uppercase">Add</button>
          <select
            value={regionEditor.from || selectedRegion}
            onChange={(e) => setRegionEditor((prev) => ({ ...prev, from: e.target.value }))}
            className="bg-[#141517] border border-[#373a40] rounded px-2 py-1 text-xs text-white"
          >
            <option value="">Rename tab</option>
            {regions.map((r) => <option key={`rename-${r}`} value={r}>{r}</option>)}
          </select>
          <input
            value={regionEditor.to}
            onChange={(e) => setRegionEditor((prev) => ({ ...prev, to: e.target.value }))}
            placeholder="New tab name"
            className="bg-[#141517] border border-[#373a40] rounded px-2 py-1 text-xs text-white"
          />
          <button onClick={handleRenameRegion} className="px-3 py-1 bg-[#f08c00] text-white rounded text-[10px] font-bold uppercase">Rename</button>
        </div>
      </div>

      <div
        ref={containerRef}
        className={`flex-1 bg-[#141517] relative overflow-hidden ${isPanMode ? 'cursor-grab' : 'cursor-crosshair'}`}
        onClick={() => setContextMenu(null)}
      >
        <Stage
          ref={stageRef}
          width={canvasSize.width}
          height={canvasSize.height}
          scaleX={scale}
          scaleY={scale}
          x={stagePos.x}
          y={stagePos.y}
          draggable={isPanMode && !isNodeDragging}
          onDragEnd={(e) => setStagePos({ x: e.target.x(), y: e.target.y() })}
          onWheel={handleWheelZoom}
        >
          <Layer>
            {links.filter((l) => topologySwitchIds.has(l.source) && topologySwitchIds.has(l.target)).map((link, i) => {
              const start = getNodeCenter(link.source);
              const end = getNodeCenter(link.target);
              return (
                <React.Fragment key={`link-${link.source}-${link.target}-${i}`}>
                  <Line
                    points={[start.x, start.y, end.x, end.y]}
                    stroke="#228be6"
                    strokeWidth={1}
                    opacity={0.5}
                  />
                  <Text
                    x={(start.x + end.x) / 2}
                    y={(start.y + end.y) / 2 - 10}
                    text={`${link.portA} <-> ${link.portB}`}
                    fill="#5c5f66"
                    fontSize={8}
                    align="center"
                  />
                </React.Fragment>
              );
            })}

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
                  draggable
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
                    stage.container().style.cursor = isPanMode ? 'grab' : 'crosshair';
                  }}
                  onMouseDown={(e) => {
                    e.cancelBubble = true;
                  }}
                  onMouseUp={(e) => {
                    e.cancelBubble = true;
                    setIsNodeDragging(false);
                  }}
                  onContextMenu={(e) => {
                    e.evt.preventDefault();
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

        <div className="absolute bottom-6 right-6 p-4 bg-[#25262b] border border-[#373a40] rounded text-[10px] font-mono text-[#909296] pointer-events-none z-10">
          {t('topologyCanvasHint')}
        </div>
        <div className="absolute top-4 right-4 p-3 bg-[#25262b] border border-[#373a40] rounded text-[10px] text-[#909296] z-10 max-w-xs">
          <div className="font-bold mb-2 text-white">Manual links</div>
          <div className="space-y-1 max-h-40 overflow-auto">
            {links.map((l, i) => (
              <div key={`${l.source}-${l.target}-${i}`} className="flex items-center justify-between gap-2">
                <span>{l.portA} - {l.portB}</span>
                <button onClick={() => handleDeleteLink(l)} className="text-red-400">x</button>
              </div>
            ))}
          </div>
        </div>
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
              SSH connect
            </button>
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[#c1c2c5] hover:bg-[#141517] hover:text-white rounded"
              onClick={() => {
                handleOpenWeb(contextMenu.node);
                setContextMenu(null);
              }}
            >
              <Globe size={14} />
              Open web UI
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default Topology;
