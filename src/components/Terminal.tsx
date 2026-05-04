import React, { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { io, Socket } from 'socket.io-client';
import { Terminal as TerminalIcon, Power, Monitor, Shield, Database } from 'lucide-react';
import { Switch } from '../types';
import 'xterm/css/xterm.css';
import { useTranslation } from '../lib/i18n';

interface TerminalProps {
  switches: Switch[];
}

const Terminal: React.FC<TerminalProps> = ({ switches }) => {
  const { t } = useTranslation();
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

    const handleResize = () => {
      if (terminalRef.current && xterm.current) {
        fitAddon.fit();
      }
    };
    window.addEventListener('resize', handleResize);
    
    // Initial fit with small delay to ensure container is mounted
    setTimeout(() => {
      if (terminalRef.current && xterm.current) {
        fitAddon.fit();
      }
    }, 100);

    socket.current.on('ssh:data', (data: string) => {
      xterm.current?.write(data);
    });

    socket.current.on('ssh:status', (status: string) => {
      if (status === 'connected') {
        setIsConnected(true);
      }
    });

    xterm.current.onData((data) => {
      if (isConnected) {
        socket.current?.emit('ssh:input', data);
      }
    });

    return () => {
      window.removeEventListener('resize', handleResize);
      xterm.current?.dispose();
      socket.current?.disconnect();
    };
  }, [isConnected]);

  const handleConnect = (sw: Switch) => {
    setActiveSwitch(sw);
    xterm.current?.clear();
    xterm.current?.write(`\r\n\x1b[34m[NETNODE]\x1b[0m Connecting to ${sw.name} at ${sw.ip}...\r\n`);
    
    socket.current?.emit('ssh:connect', {
      host: sw.ip,
      username: 'admin',
      password: 'admin'
    });
  };

  const handleDisconnect = () => {
    socket.current?.disconnect();
    socket.current = io(); // Reset socket
    setIsConnected(false);
    xterm.current?.writeln('\r\n\x1b[31m[DISCONNECTED]\x1b[0m SSH Session terminated.');
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
            {t('terminal')}
          </div>
          
          <div className="h-4 w-px bg-[#373a40]" />
          
          <div className="flex items-center gap-3">
            <label className="text-[10px] font-bold text-[#5c5f66] uppercase">{t('activeSession')}</label>
            <select 
              className="bg-[#141517] border border-[#373a40] px-3 py-1 rounded text-xs text-white focus:outline-none"
              value={activeSwitch?.id}
              onChange={(e) => {
                const sw = switches.find(s => s.id === e.target.value);
                if (sw) handleConnect(sw);
              }}
            >
              {switches.map(sw => (
                <option key={sw.id} value={sw.id}>{sw.name} ({sw.ip})</option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1.5 border border-[#228be6]/30 bg-[#228be6]/10 rounded text-[10px] font-bold text-[#228be6]">
            <Shield size={12} />
            SSH {isConnected ? 'ACTIVE' : 'READY'}
          </div>
          <button 
            onClick={handleDisconnect}
            className="flex items-center gap-2 px-3 py-1.5 bg-red-500/10 border border-red-500/30 rounded text-[10px] font-bold text-red-500 hover:bg-red-500/20 transition-all"
          >
            <Power size={12} />
            {t('disconnect')}
          </button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-hidden p-2">
            <div ref={terminalRef} className="h-full w-full" />
        </div>
      </div>
    </div>
  );
};

export default Terminal;
