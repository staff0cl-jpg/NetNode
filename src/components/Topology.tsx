import React, { useState } from 'react';
import { Stage, Layer, Rect, Text, Line, Circle } from 'react-konva';
import { Share2, Download, MousePointer2, Plus, Box } from 'lucide-react';
import { Switch } from '../types';
import { useTranslation } from '../lib/i18n';

interface TopologyProps {
  switches: Switch[];
}

const Topology: React.FC<TopologyProps> = ({ switches }) => {
  const { t } = useTranslation();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });
  const [links, setLinks] = useState<{ source: string, target: string, portA: string, portB: string }[]>([]);
  const [nodes, setNodes] = useState(switches.map((s, i) => ({
    ...s,
    x: 100 + (i % 3) * 250,
    y: 100 + Math.floor(i / 3) * 200
  })));

  const fetchLinks = async () => {
    try {
      const response = await fetch('/api/topology/links');
      const data = await response.json();
      setLinks(data);
    } catch (error) {
      console.error('Failed to fetch topology links:', error);
    }
  };

  React.useEffect(() => {
    fetchLinks();
    // Update nodes when switches change
    setNodes(switches.map((s, i) => {
      const existingNode = nodes.find(n => n.id === s.id);
      if (existingNode) return { ...s, x: existingNode.x, y: existingNode.y };
      return {
        ...s,
        x: 100 + (i % 3) * 250,
        y: 100 + Math.floor(i / 3) * 200
      };
    }));
  }, [switches]);

  React.useEffect(() => {
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
      if (!entries || !entries.length) return;
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

  const handleDragEnd = (id: string, e: any) => {
    setNodes(nodes.map(node => 
      node.id === id ? { ...node, x: e.target.x(), y: e.target.y() } : node
    ));
  };

  const handleAutoLayout = () => {
    fetchLinks();
    setNodes(nodes.map((node, i) => ({
      ...node,
      x: 100 + (i % 3) * 250,
      y: 100 + Math.floor(i / 3) * 200
    })));
  };

  const getNodeCenter = (id: string) => {
    const node = nodes.find(n => n.id === id);
    if (!node) return { x: 0, y: 0 };
    return { x: node.x + 80, y: node.y + 40 };
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
              onClick={handleAutoLayout}
              className="flex items-center gap-2 px-3 py-1.5 bg-[#2c2e33] text-[#c1c2c5] hover:text-white rounded text-[10px] font-bold uppercase transition-all border border-[#373a40]"
            >
              <Box size={14} />
              {t('autoLayout')}
            </button>
          </nav>
        </div>
      </header>

      <div ref={containerRef} className="flex-1 bg-[#141517] relative cursor-crosshair overflow-hidden">
        <Stage width={canvasSize.width} height={canvasSize.height}>
          <Layer>
            {/* Logical Connections */}
            {links.map((link, i) => {
              const start = getNodeCenter(link.source);
              const end = getNodeCenter(link.target);
              return (
                <React.Fragment key={`link-${i}`}>
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

            {/* Switch Nodes */}
            {nodes.map((node) => (
              <React.Fragment key={node.id}>
                <Rect
                  x={node.x}
                  y={node.y}
                  width={160}
                  height={80}
                  fill="#25262b"
                  stroke={node.status === 'online' ? "#40c057" : "#fa5252"}
                  strokeWidth={2}
                  cornerRadius={4}
                  draggable
                  onDragEnd={(e) => handleDragEnd(node.id, e)}
                />
                <Text x={node.x + 10} y={node.y + 12} text={node.name} fill="white" fontSize={12} fontStyle="bold" />
                <Text x={node.x + 10} y={node.y + 32} text={node.vendor} fill="#909296" fontSize={9} />
                <Text x={node.x + 10} y={node.y + 55} text={node.ip} fill="#228be6" fontSize={10} fontFamily="monospace" />
                <Circle x={node.x + 145} y={node.y + 15} radius={4} fill={node.status === 'online' ? "#40c057" : "#fa5252"} />
              </React.Fragment>
            ))}
          </Layer>
        </Stage>

        <div className="absolute bottom-6 right-6 p-4 bg-[#25262b] border border-[#373a40] rounded text-[10px] font-mono text-[#909296] pointer-events-none z-10">
          CANVAS RESOLUTION: FULL HD<br />
          COORDINATE SYSTEM: RELATIVE<br />
          AUTO-SYNCING TOPOLOGY...
        </div>
      </div>
    </div>
  );
};

export default Topology;
