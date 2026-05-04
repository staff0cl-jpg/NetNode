import React, { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { io, Socket } from 'socket.io-client';
import { Terminal as TerminalIcon, Power, Monitor, Shield, Database } from 'lucide-react';
import { Switch } from '../types';
import 'xterm/css/xterm.css';

interface TerminalProps {
  switches: Switch[];
}

const Terminal: React.FC<TerminalProps> = ({ switches }) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const [activeSwitch, setActiveSwitch] = useState<Switch | null>(switches[0]);
  const [isConnected, setIsConnected] = useState(false);
  const xterm = useRef<XTerm | null>(null);
  const socket = useRef<Socket | null>(null);

  useEffect(() => {
    if (!terminalRef.current) return;

    xterm.current = new XTerm({
      theme: {
        background: '#0a0a0a',
        foreground: '#40c057',
        cursor: '#fff',
        selectionBackground: 'rgba(255, 255, 255, 0.3)',
      },
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 14,
      cursorBlink: true,
      rows: 24,
    });

    const fitAddon = new FitAddon();
    xterm.current.loadAddon(fitAddon);
    xterm.current.open(terminalRef.current);
    fitAddon.fit();

    socket.current = io();

    socket.current.on('terminal:output', (data: string) => {
      xterm.current?.write(data);
    });

    let currentLine = '';
    xterm.current.onData(data => {
      if (data === '\r') {
        socket.current?.emit('terminal:input', currentLine);
        currentLine = '';
      } else if (data === '\u007f') { // Backspace
        if (currentLine.length > 0) {
          currentLine = currentLine.slice(0, -1);
          xterm.current?.write('\b \b');
        }
      } else {
        currentLine += data;
        xterm.current?.write(data);
      }
    });

    setIsConnected(true);

    return () => {
      xterm.current?.dispose();
      socket.current?.disconnect();
    };
  }, []);

  const handleConnect = (sw: Switch) => {
    setActiveSwitch(sw);
    xterm.current?.clear();
    xterm.current?.write(`\r\nConnecting to [${sw.vendor}] ${sw.name} at ${sw.ip}...\r\n`);
    socket.current?.emit('terminal:input', ''); // Trigger prompt
  };

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a]">
      <header className="p-4 border-b border-[#373a40] bg-[#1c1d21] flex justify-between items-center h-16 shrink-0">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2 text-[#40c057] font-mono text-xs font-bold uppercase tracking-widest">
            <div className="relative">
              <Monitor size={16} />
              <div className="absolute -top-1 -right-1 w-2 h-2 bg-[#40c057] rounded-full animate-pulse" />
            </div>
            Virtual Terminal / CLI
          </div>
          
          <div className="h-4 w-px bg-[#373a40]" />
          
          <div className="flex items-center gap-3">
            <label className="text-[10px] font-bold text-[#5c5f66] uppercase">Active Session:</label>
            <select 
              className="bg-[#141517] border border-[#373a40] px-3 py-1 rounded text-xs text-white focus:outline-none"
              value={activeSwitch?.id}
              onChange={(e) => handleConnect(switches.find(s => s.id === e.target.value)!)}
            >
              {switches.map(sw => (
                <option key={sw.id} value={sw.id}>{sw.name} ({sw.ip})</option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1.5 border border-amber-500/30 bg-amber-500/10 rounded text-[10px] font-bold text-amber-500">
            <Shield size={12} />
            SSH SECURE
          </div>
          <button className="flex items-center gap-2 px-3 py-1.5 bg-red-500/10 border border-red-500/30 rounded text-[10px] font-bold text-red-500 hover:bg-red-500/20 transition-all">
            <Power size={12} />
            DISCONNECT
          </button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <div className="w-1/4 p-4 border-r border-[#373a40] bg-[#141517] overflow-y-auto hidden lg:block">
          <h4 className="text-[10px] font-bold text-[#5c5f66] uppercase tracking-widest mb-4 flex items-center gap-2">
            <Database size={12} />
            Recent Connections
          </h4>
          <div className="space-y-1">
            {switches.map(sw => (
              <button
                key={sw.id}
                onClick={() => handleConnect(sw)}
                className={`w-full text-left px-3 py-2 rounded text-xs transition-colors ${activeSwitch?.id === sw.id ? 'bg-[#228be6] text-white' : 'text-[#909296] hover:bg-[#2c2e33]'}`}
              >
                <div className="font-bold mb-0.5">{sw.name}</div>
                <div className="opacity-60 font-mono text-[9px] uppercase">{sw.vendor} / {sw.ip}</div>
              </button>
            ))}
          </div>
        </div>
        
        <div className="flex-1 p-0 flex flex-col bg-black">
          <div ref={terminalRef} className="flex-1 overflow-hidden" />
          <div className="p-2 border-t border-[#373a40] bg-[#1c1d21] text-[10px] font-mono text-[#5c5f66] flex justify-between">
            <span>BAUD RATE: 9600 | DATA BITS: 8 | PARITY: NONE | STOP BITS: 1</span>
            <span>TERMINAL TYPE: XTERM-COLOR</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Terminal;
