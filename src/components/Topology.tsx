import React, { useState, useRef, useEffect } from 'react';
import { Stage, Layer, Rect, Text, Line, Circle } from 'react-konva';
import { Share2, Box } from 'lucide-react';
import { Switch } from '../types';
import { useTranslation } from '../lib/i18n';

interface TopologyProps {
  switches: Switch[];
}

type TopoLink = { source: string; target: string; portA: string; portB: string };

type NodeWithPos = Switch & { x: number; y: number };

function computeLayout(switches: Switch[], links: TopoLink[], cw: number, ch: number): NodeWithPos[] {
  if (switches.length === 0) return [];
  const margin = 64;
  const usableW = Math.max(400, cw - 2 * margin);
  const usableH = Math.max(300, ch - 2 * margin);

  if (links.length === 0) {
    const cols = Math.max(1, Math.floor(usableW / 200));
    return switches.map((s, i) => ({
      ...s,
      x: margin + (i % cols) * 200,
      y: margin + Math.floor(i / cols) * 120,
    }));
  }

  const adj = new Map<string, Set<string>>();
  switches.forEach((s) => adj.set(s.id, new Set()));
  links.forEach((l) => {
    adj.get(l.source)?.add(l.target);
    adj.get(l.target)?.add(l.source);
  });

  const sorted = [...switches].sort((a, b) =>
    a.ip.localeCompare(b.ip, undefined, { numeric: true })
  );
  const rootId = sorted[0].id;

  const depth = new Map<string, number>();
  const q: string[] = [rootId];
  depth.set(rootId, 0);
  const seen = new Set([rootId]);
  while (q.length) {
    const u = q.shift()!;
    const du = depth.get(u)!;
    for (const v of adj.get(u) || []) {
      if (!seen.has(v)) {
        seen.add(v);
        depth.set(v, du + 1);
        q.push(v);
      }
    }
  }
  switches.forEach((s) => {
    if (!depth.has(s.id)) depth.set(s.id, 0);
  });

  const maxD = Math.max(0, ...depth.values());
  const xStep = maxD === 0 ? 0 : Math.min(240, usableW / Math.max(maxD, 1));

  const atDepth = new Map<number, Switch[]>();
  switches.forEach((s) => {
    const d = depth.get(s.id) || 0;
    if (!atDepth.has(d)) atDepth.set(d, []);
    atDepth.get(d)!.push(s);
  });

  const pos = new Map<string, { x: number; y: number }>();
  atDepth.forEach((list, d) => {
    const n = list.length;
    list.forEach((s, idx) => {
      const y =
        n === 1
          ? margin + usableH / 2 - 40
          : margin + (idx * (usableH - 80)) / Math.max(n - 1, 1);
      pos.set(s.id, {
        x: margin + d * xStep,
        y: Math.min(Math.max(margin, y), ch - 120),
      });
    });
  });

  return switches.map((s) => {
    const p = pos.get(s.id);
    return { ...s, x: p?.x ?? margin, y: p?.y ?? margin };
  });
}

const Topology: React.FC<TopologyProps> = ({ switches }) => {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });
  const [links, setLinks] = useState<TopoLink[]>([]);
  const [nodes, setNodes] = useState<NodeWithPos[]>([]);
  const [savedLayout, setSavedLayout] = useState<Record<string, { x: number; y: number }>>({});
  const [manualLink, setManualLink] = useState({ source: '', target: '', portA: '', portB: '' });

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
  }, [switches]);

  useEffect(() => {
    const w = containerRef.current?.offsetWidth || canvasSize.width;
    const h = containerRef.current?.offsetHeight || canvasSize.height;
    const computed = computeLayout(switches, links, w, h);
    setNodes(
      computed.map((n) => {
        const saved = savedLayout[n.id];
        return saved ? { ...n, x: saved.x, y: saved.y } : n;
      })
    );
  }, [switches, links, canvasSize.width, canvasSize.height, savedLayout]);

  const handleAutoLayout = async () => {
    try {
      const response = await fetch('/api/topology/links');
      const data: { links: TopoLink[]; layout?: Record<string, { x: number; y: number }> } = await response.json();
      setLinks(data.links || []);
      setSavedLayout(data.layout || {});
      const w = containerRef.current?.offsetWidth || canvasSize.width;
      const h = containerRef.current?.offsetHeight || canvasSize.height;
      const computed = computeLayout(switches, data.links || [], w, h);
      setNodes(
        computed.map((n) => {
          const saved = (data.layout || {})[n.id];
          return saved ? { ...n, x: saved.x, y: saved.y } : n;
        })
      );
    } catch (error) {
      console.error('Failed to refresh topology:', error);
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
          </nav>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <select value={manualLink.source} onChange={(e) => setManualLink({ ...manualLink, source: e.target.value })} className="bg-[#141517] border border-[#373a40] rounded px-2 py-1 text-white">
            <option value="">Source</option>
            {switches.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input value={manualLink.portA} onChange={(e) => setManualLink({ ...manualLink, portA: e.target.value })} placeholder="Port A" className="bg-[#141517] border border-[#373a40] rounded px-2 py-1 text-white w-20" />
          <select value={manualLink.target} onChange={(e) => setManualLink({ ...manualLink, target: e.target.value })} className="bg-[#141517] border border-[#373a40] rounded px-2 py-1 text-white">
            <option value="">Target</option>
            {switches.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input value={manualLink.portB} onChange={(e) => setManualLink({ ...manualLink, portB: e.target.value })} placeholder="Port B" className="bg-[#141517] border border-[#373a40] rounded px-2 py-1 text-white w-20" />
          <button onClick={handleAddLink} className="px-3 py-1 bg-[#228be6] text-white rounded">Link</button>
        </div>
      </header>

      <div ref={containerRef} className="flex-1 bg-[#141517] relative cursor-crosshair overflow-hidden">
        <Stage width={canvasSize.width} height={canvasSize.height}>
          <Layer>
            {links.map((link, i) => {
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
                  onDragEnd={(e) => handleDragEnd(node.id, e)}
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
      </div>
    </div>
  );
};

export default Topology;
