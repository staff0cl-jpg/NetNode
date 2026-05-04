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
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [nodes, setNodes] = useState(switches.map((s, i) => ({
    ...s,
    x: 100 + (i % 3) * 250,
    y: 100 + Math.floor(i / 3) * 150
  })));

  React.useEffect(() => {
    if (!containerRef.current) return;

    const observer = new ResizeObserver((entries) => {
      for (let entry of entries) {
        setDimensions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const handleDragEnd = (id: string, e: any) => {
    setNodes(nodes.map(node => 
      node.id === id ? { ...node, x: e.target.x(), y: e.target.y() } : node
    ));
  };

  const handleExportDrawIo = () => {
    const data = JSON.stringify(nodes, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'network_topology.json';
    a.click();
    alert('Topology exported as JSON. This can be mapped to drawing tools.');
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
            <button className="flex items-center gap-2 px-3 py-1.5 bg-[#2c2e33] rounded text-[10px] font-bold text-[#c1c2c5] hover:text-white transition-all border border-[#373a40]">
              <MousePointer2 size={12} />
              SELECT
            </button>
            <button className="flex items-center gap-2 px-3 py-1.5 bg-[#141517] rounded text-[10px] font-bold text-[#909296] hover:text-white transition-all">
              <Box size={12} />
              SHAPES
            </button>
            <button className="flex items-center gap-2 px-3 py-1.5 bg-[#141517] rounded text-[10px] font-bold text-[#909296] hover:text-white transition-all">
              <Plus size={12} />
              ZONE
            </button>
          </nav>
        </div>
        <button 
          onClick={handleExportDrawIo}
          className="flex items-center gap-2 px-4 py-2 bg-[#228be6] hover:bg-[#1c7ed6] text-white rounded text-[10px] font-bold uppercase tracking-widest leading-none shadow-lg"
        >
          <Download size={14} />
          {t('exportJson')}
        </button>
      </header>

      <div ref={containerRef} className="flex-1 bg-[#141517] relative cursor-crosshair overflow-hidden">
        <Stage width={dimensions.width} height={dimensions.height}>
          <Layer>
            {/* Background Grid Pattern */}
            {[...Array(20)].map((_, i) => (
              <React.Fragment key={i}>
                <Line
                  points={[0, i * 100, 2000, i * 100]}
                  stroke="#1c1d21"
                  strokeWidth={1}
                />
                <Line
                  points={[i * 100, 0, i * 100, 2000]}
                  stroke="#1c1d21"
                  strokeWidth={1}
                />
              </React.Fragment>
            ))}

            {/* Logical Connections */}
            {nodes.length > 0 && nodes.slice(1).map((node, i) => (
              <Line
                key={`link-${i}`}
                points={[nodes[0].x + 80, nodes[0].y + 40, node.x + 80, node.y + 40]}
                stroke="#373a40"
                strokeWidth={2}
                dash={[5, 5]}
              />
            ))}

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
                  shadowBlur={10}
                  shadowColor="rgba(0,0,0,0.3)"
                />
                <Text
                  x={node.x + 10}
                  y={node.y + 12}
                  text={node.name}
                  fill="white"
                  fontSize={12}
                  fontStyle="bold"
                />
                <Text
                  x={node.x + 10}
                  y={node.y + 32}
                  text={node.vendor}
                  fill="#909296"
                  fontSize={9}
                  letterSpacing={1}
                />
                <Text
                  x={node.x + 10}
                  y={node.y + 55}
                  text={node.ip}
                  fill="#228be6"
                  fontSize={10}
                  fontFamily="monospace"
                />
                <Circle
                  x={node.x + 145}
                  y={node.y + 15}
                  radius={4}
                  fill={node.status === 'online' ? "#40c057" : node.status === 'warning' ? "#fab005" : "#fa5252"}
                />
              </React.Fragment>
            ))}
          </Layer>
        </Stage>

        <div className="absolute bottom-6 right-6 p-4 bg-[#25262b] border border-[#373a40] rounded text-[10px] font-mono text-[#909296] pointer-events-none">
          CANVAS RESOLUTION: FULL HD<br />
          COORDINATE SYSTEM: RELATIVE<br />
          AUTO-SYNCING TOPOLOGY...
        </div>
      </div>
    </div>
  );
};

export default Topology;
