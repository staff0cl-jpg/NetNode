import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { io, Socket } from 'socket.io-client';
import { Terminal as TerminalIcon, Power, Monitor, Shield, Plus, X, Server, Save, Settings } from 'lucide-react';
import { Switch } from '../types';
import 'xterm/css/xterm.css';
import { useTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';
import { motion, AnimatePresence } from 'motion/react';

interface TerminalProps {
  switches: Switch[];
  role?: string;
  targetDevice?: Switch | null;
  onClearTarget?: () => void;
}

interface TerminalSession {
  id: string;
  name: string;
  host: string;
  username: string;
  password?: string;
  connected: boolean;
  autoReconnect: boolean;
}

const Terminal: React.FC<TerminalProps> = ({ switches, role, targetDevice, onClearTarget }) => {
  const { t } = useTranslation();
  const isAdmin = role === 'admin';
  const isOperator = role === 'admin' || role === 'operator';
  const isViewer = role === 'viewer';
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [newSession, setNewSession] = useState({ name: '', host: '', username: 'admin', password: '', autoReconnect: true });
  const [passwordPrompt, setPasswordPrompt] = useState<{ session: TerminalSession } | null>(null);
  const [promptUsername, setPromptUsername] = useState('admin');
  const [promptPassword, setPromptPassword] = useState('');
  const [savePasswordToSession, setSavePasswordToSession] = useState(true);
  
  const xterms = useRef<Map<string, { xterm: XTerm, fitAddon: FitAddon }>>(new Map());
  const socket = useRef<Socket | null>(null);
  const terminalContainers = useRef<Map<string, HTMLDivElement>>(new Map());
  const reconnectTimers = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const handleConnectRef = useRef<(s: TerminalSession, pwd?: string) => void>(() => {});
  const sessionsRef = useRef<TerminalSession[]>([]);

  // Load saved sessions from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('netnode_ssh_sessions');
    if (saved) {
      setSessions(JSON.parse(saved).map((s: any) => ({
        ...s,
        password: s.password ?? '',
        connected: false,
        autoReconnect: s.autoReconnect ?? true
      })));
    } else {
      setSessions([]);
    }
  }, []); // Only on mount

  const emitSshConnect = (session: TerminalSession, password: string) => {
    socket.current?.emit('ssh:connect', {
      sessionId: session.id,
      host: session.host,
      username: session.username,
      password,
    });
  };

  const handleConnect = useCallback((session: TerminalSession, overridePassword?: string) => {
    const effectivePassword = overridePassword ?? session.password ?? '';
    if (!effectivePassword.trim()) {
      setPasswordPrompt({ session });
      setPromptUsername(session.username || 'admin');
      return;
    }

    setActiveSessionId(session.id);
    const te = xterms.current.get(session.id);

    if (reconnectTimers.current.has(session.id)) {
      clearTimeout(reconnectTimers.current.get(session.id));
      reconnectTimers.current.delete(session.id);
    }

    if (te) {
      te.xterm.clear();
      te.xterm.write(`\r\n\x1b[34m[NETNODE]\x1b[0m Connecting to ${session.name} at ${session.host}...\r\n`);
    }

    emitSshConnect(session, effectivePassword);
  }, []);

  handleConnectRef.current = handleConnect;

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    if (!targetDevice) return;
    setSessions(prev => {
      const existing = prev.find(s => s.host === targetDevice.ip);
      if (existing) {
        setActiveSessionId(existing.id);
        if (!existing.connected) {
          setTimeout(() => handleConnectRef.current(existing), 50);
        }
        return prev;
      }

      const newId = `session-${targetDevice.id}-${Date.now()}`;
      const session: TerminalSession = {
        id: newId,
        name: `${targetDevice.name} (Direct)`,
        host: targetDevice.ip,
        username: 'admin',
        password: '',
        connected: false,
        autoReconnect: true
      };

      const updated = [session, ...prev];
      localStorage.setItem('netnode_ssh_sessions', JSON.stringify(updated));
      setActiveSessionId(newId);
      setTimeout(() => handleConnectRef.current(session), 100);
      return updated;
    });
    onClearTarget?.();
  }, [targetDevice, onClearTarget]);

  useEffect(() => {
    socket.current = io();

    socket.current.on('ssh:data', ({ sessionId, data }: { sessionId: string, data: string }) => {
      const xtermEntry = xterms.current.get(sessionId);
      if (xtermEntry) {
        xtermEntry.xterm.write(data);
      }
    });

    socket.current.on('ssh:status', ({ sessionId, status }: { sessionId: string, status: string }) => {
      setSessions(prev => {
        const session = prev.find(s => s.id === sessionId);
        const updated = prev.map(s => s.id === sessionId ? { ...s, connected: status === 'connected' } : s);
        
        // Auto-reconnect logic
        if (status === 'disconnected' && session?.autoReconnect) {
          const xtermEntry = xterms.current.get(sessionId);
          xtermEntry?.xterm.writeln(`\r\n\x1b[33m[RECONNECTING]\x1b[0m Connection lost. Retrying in 5s...\r\n`);
          
          const timer = setTimeout(() => {
            handleConnectRef.current(session);
          }, 5000);
          reconnectTimers.current.set(sessionId, timer);
        }
        
        return updated;
      });

      const xtermEntry = xterms.current.get(sessionId);
      if (xtermEntry && status === 'connected') {
        xtermEntry.xterm.writeln(`\r\n\x1b[32m[CONNECTED]\x1b[0m Established secure shell to the node.\r\n`);
      }
    });

    return () => {
      socket.current?.disconnect();
      xterms.current.forEach(te => te.xterm.dispose());
      reconnectTimers.current.forEach(t => clearTimeout(t));
    };
  }, []);

  const createXTerm = (sessionId: string, container: HTMLDivElement) => {
    if (xterms.current.has(sessionId)) return;

    const term = new XTerm({
      theme: {
        background: '#0a0a0a',
        foreground: '#40c057',
        cursor: '#fff',
        selectionBackground: 'rgba(255, 255, 255, 0.3)',
      },
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 13,
      cursorBlink: true,
      rows: 30,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();

    term.onData((data) => {
      const session = sessionsRef.current.find(s => s.id === sessionId);
      if (session?.connected) {
        socket.current?.emit('ssh:input', { sessionId, input: data });
      }
    });

    xterms.current.set(sessionId, { xterm: term, fitAddon });
    
    // Fit after a short delay
    setTimeout(() => fitAddon.fit(), 50);
  };

  const handleDisconnect = (sessionId: string) => {
    // Disable autoReconnect for manual disconnect
    setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, autoReconnect: false, connected: false } : s));
    
    socket.current?.emit('ssh:disconnect', { sessionId });
    
    const te = xterms.current.get(sessionId);
    if (te) {
      te.xterm.writeln('\r\n\x1b[31m[DISCONNECTED]\x1b[0m SSH Session terminated.');
    }

    if (reconnectTimers.current.has(sessionId)) {
      clearTimeout(reconnectTimers.current.get(sessionId));
      reconnectTimers.current.delete(sessionId);
    }
  };

  const addSession = () => {
    if (!newSession.host) return;
    
    if (editingSessionId) {
      const prev = sessions.find(s => s.id === editingSessionId);
      const updated = sessions.map(s => s.id === editingSessionId ? {
        ...s,
        name: newSession.name || newSession.host,
        host: newSession.host,
        username: newSession.username,
        password: newSession.password.trim() ? newSession.password : (prev?.password ?? ''),
        autoReconnect: newSession.autoReconnect
      } : s);
      setSessions(updated);
      localStorage.setItem('netnode_ssh_sessions', JSON.stringify(updated));
    } else {
      const session: TerminalSession = {
        id: `session-${Date.now()}`,
        name: newSession.name || newSession.host,
        host: newSession.host,
        username: newSession.username,
        password: newSession.password,
        connected: false,
        autoReconnect: newSession.autoReconnect
      };
      const updated = [...sessions, session];
      setSessions(updated);
      localStorage.setItem('netnode_ssh_sessions', JSON.stringify(updated));
    }
    
    setIsConfigOpen(false);
    setEditingSessionId(null);
    setNewSession({ name: '', host: '', username: 'admin', password: '', autoReconnect: true });
  };

  const handleEditSession = (e: React.MouseEvent, session: TerminalSession) => {
    e.stopPropagation();
    setNewSession({
      name: session.name,
      host: session.host,
      username: session.username,
      password: '',
      autoReconnect: session.autoReconnect
    });
    setEditingSessionId(session.id);
    setIsConfigOpen(true);
  };

  const removeSession = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const updated = sessions.filter(s => s.id !== id);
    setSessions(updated);
    localStorage.setItem('netnode_ssh_sessions', JSON.stringify(updated));
    if (activeSessionId === id) setActiveSessionId(null);
    
    const te = xterms.current.get(id);
    if (te) {
      te.xterm.dispose();
      xterms.current.delete(id);
    }
  };

  return (
    <div className="flex h-full bg-[#0a0a0a] overflow-hidden">
      {/* Session Sidebar */}
      <aside className="w-64 border-r border-[#373a40] bg-[#1c1d21] flex flex-col shrink-0">
        <div className="p-4 border-b border-[#373a40] flex justify-between items-center">
          <h3 className="text-[10px] font-bold text-[#5c5f66] uppercase tracking-widest">{t('sessions')}</h3>
          {!isViewer && (
            <button 
              onClick={() => setIsConfigOpen(true)}
              className="p-1 hover:bg-white/5 rounded transition-all text-[#228be6]"
            >
              <Plus size={16} />
            </button>
          )}
        </div>
        
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {sessions.map(session => (
            <div 
              key={session.id}
              onClick={() => setActiveSessionId(session.id)}
              className={cn(
                "group flex items-center justify-between p-3 rounded cursor-pointer transition-all border",
                activeSessionId === session.id 
                  ? "bg-[#228be6]/10 border-[#228be6]/30 text-white" 
                  : "bg-transparent border-transparent text-[#909296] hover:bg-white/5"
              )}
            >
              <div className="flex items-center gap-3 overflow-hidden">
                <div className={cn(
                  "w-2 h-2 rounded-full",
                  session.connected ? "bg-[#40c057] shadow-lg shadow-[#40c057]/20 animate-pulse" : "bg-[#373a40]"
                )} />
                <div className="flex flex-col overflow-hidden">
                  <span className="text-xs font-bold truncate">{session.name}</span>
                  <span className="text-[10px] opacity-50 truncate">{session.host}</span>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {!isViewer && (
                  <>
                    <button 
                      onClick={(e) => handleEditSession(e, session)}
                      className="opacity-0 group-hover:opacity-100 p-1 hover:text-[#228be6] transition-all"
                    >
                      <Settings size={12} />
                    </button>
                    <button 
                      onClick={(e) => removeSession(e, session.id)}
                      className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-500 transition-all"
                    >
                      <X size={12} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
          {sessions.length === 0 && (
            <div className="p-8 text-center text-[10px] text-[#5c5f66] uppercase">
              No active sessions
            </div>
          )}
        </div>

        <div className="p-2 border-t border-[#373a40]">
           {/* System status footer removed */}
        </div>
      </aside>

      {/* Main Terminal Area */}
      <main className="flex-1 flex flex-col overflow-hidden relative">
        <header className="h-14 border-b border-[#373a40] bg-[#1c1d21] flex justify-between items-center px-4 shrink-0">
          <div className="flex items-center gap-4">
            {activeSessionId ? (
              <>
                <div className="flex items-center gap-2">
                  <Server size={14} className="text-[#228be6]" />
                  <span className="text-xs font-bold text-white">
                    {sessions.find(s => s.id === activeSessionId)?.name}
                  </span>
                </div>
                <div className="h-4 w-px bg-[#373a40]" />
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold text-[#5c5f66] uppercase">Status:</span>
                  <span className={cn(
                    "text-[10px] font-bold uppercase",
                    sessions.find(s => s.id === activeSessionId)?.connected ? "text-[#40c057]" : "text-red-500"
                  )}>
                    {sessions.find(s => s.id === activeSessionId)?.connected ? 'Online' : 'Offline'}
                  </span>
                </div>
              </>
            ) : (
              <span className="text-xs text-[#5c5f66] italic">Select a session to start terminal</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {activeSessionId && (
              <>
                <button 
                  onClick={(e) => handleEditSession(e, sessions.find(s => s.id === activeSessionId)!)}
                  className="flex items-center gap-2 px-3 py-1.5 bg-[#2c2e33] text-[#c1c2c5] rounded text-[10px] font-bold uppercase tracking-widest hover:text-white transition-all border border-[#373a40]"
                >
                  <Save size={12} />
                  Settings
                </button>
                {!sessions.find(s => s.id === activeSessionId)?.connected ? (
                  <button 
                    onClick={() => handleConnect(sessions.find(s => s.id === activeSessionId)!)}
                    className="flex items-center gap-2 px-3 py-1.5 bg-[#228be6] text-white rounded text-[10px] font-bold uppercase tracking-widest hover:bg-[#1c7ed6] transition-all"
                  >
                    <Power size={12} />
                    Connect
                  </button>
                ) : (
                  <button 
                    onClick={() => handleDisconnect(activeSessionId)}
                    className="flex items-center gap-2 px-3 py-1.5 bg-red-500/10 border border-red-500/30 text-red-500 rounded text-[10px] font-bold uppercase tracking-widest hover:bg-red-500/20 transition-all"
                  >
                    <X size={12} />
                    Hangup
                  </button>
                )}
              </>
            )}
          </div>
        </header>

        <div className="flex-1 bg-[#0a0a0a] relative">
          <AnimatePresence mode="wait">
            {sessions.map(session => (
              <div 
                key={session.id}
                className={cn(
                  "absolute inset-0 p-2 transition-opacity duration-300",
                  activeSessionId === session.id ? "opacity-100 z-10" : "opacity-0 z-0 pointer-events-none"
                )}
              >
                <div 
                  ref={el => {
                    if (el) {
                      terminalContainers.current.set(session.id, el);
                      createXTerm(session.id, el);
                    }
                  }} 
                  className="h-full w-full" 
                />
              </div>
            ))}
          </AnimatePresence>
          {!activeSessionId && (
            <div className="h-full flex flex-col items-center justify-center text-[#373a40]">
              <TerminalIcon size={64} className="mb-4 opacity-10" />
              <p className="text-sm font-mono uppercase tracking-[0.2em] opacity-30">Waiting for session...</p>
            </div>
          )}
        </div>
      </main>

      {/* New Session Overlay */}
      {isConfigOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-6">
          <motion.div 
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-[#1c1d21] border border-[#373a40] p-8 rounded-lg shadow-2xl w-full max-w-md"
          >
            <div className="flex items-center gap-3 mb-8">
              {editingSessionId ? <Settings className="text-[#fab005]" /> : <Plus className="text-[#228be6]" />}
              <h3 className="text-lg font-bold text-white uppercase tracking-widest">
                {editingSessionId ? 'Edit Session Configuration' : 'Add New SSH Session'}
              </h3>
            </div>

            <div className="space-y-6">
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#5c5f66] uppercase">Session Name</label>
                <input 
                  className="w-full bg-[#141517] border border-[#373a40] p-3 rounded text-sm text-white focus:border-[#228be6] outline-none"
                  placeholder="e.g. CORE-SW-NORTH"
                  value={newSession.name}
                  onChange={e => setNewSession({...newSession, name: e.target.value})}
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#5c5f66] uppercase">Node Address (IP/FQDN)</label>
                <input 
                  className="w-full bg-[#141517] border border-[#373a40] p-3 rounded text-sm text-white focus:border-[#228be6] outline-none"
                  placeholder="10.0.0.1"
                  value={newSession.host}
                  onChange={e => setNewSession({...newSession, host: e.target.value})}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-[10px] font-bold text-[#5c5f66] uppercase">Username</label>
                  <input 
                    className="w-full bg-[#141517] border border-[#373a40] p-3 rounded text-sm text-white focus:border-[#228be6] outline-none"
                    value={newSession.username}
                    onChange={e => setNewSession({...newSession, username: e.target.value})}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-bold text-[#5c5f66] uppercase">Auto Reconnect</label>
                  <div className="flex items-center gap-2 h-11">
                    <input 
                      type="checkbox"
                      className="w-4 h-4 rounded border-[#373a40] bg-[#141517] text-[#228be6] focus:ring-[#228be6]"
                      checked={newSession.autoReconnect}
                      onChange={e => setNewSession({...newSession, autoReconnect: e.target.checked})}
                    />
                    <span className="text-xs text-[#909296]">Retry on loss</span>
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#5c5f66] uppercase">{t('sshSessionPassword')}</label>
                <input 
                  type="password"
                  className="w-full bg-[#141517] border border-[#373a40] p-3 rounded text-sm text-white focus:border-[#228be6] outline-none"
                  placeholder={editingSessionId ? t('sshPasswordEditHint') : t('sshPasswordPlaceholder')}
                  value={newSession.password}
                  onChange={e => setNewSession({ ...newSession, password: e.target.value })}
                  autoComplete="new-password"
                />
                <p className="text-[9px] text-[#5c5f66]">{t('sshPasswordStoredHint')}</p>
              </div>
            </div>

            <div className="mt-10 flex gap-4">
              <button 
                onClick={() => {
                  setIsConfigOpen(false);
                  setEditingSessionId(null);
                  setNewSession({ name: '', host: '', username: 'admin', password: '', autoReconnect: true });
                }}
                className="flex-1 py-3 border border-[#373a40] text-[#909296] rounded text-[10px] font-bold uppercase tracking-widest hover:bg-white/5 transition-all"
              >
                Cancel
              </button>
              <button 
                onClick={addSession}
                className={cn(
                  "flex-[2] py-3 text-white rounded text-[10px] font-bold uppercase tracking-widest transition-all shadow-lg",
                  editingSessionId ? "bg-[#fab005] text-black hover:bg-[#f08c00]" : "bg-[#228be6] hover:bg-[#1c7ed6]"
                )}
              >
                {editingSessionId ? 'Save Configuration' : 'Create Session'}
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {passwordPrompt && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] flex items-center justify-center p-6">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-[#1c1d21] border border-[#373a40] p-8 rounded-lg shadow-2xl w-full max-w-md"
          >
            <h3 className="text-lg font-bold text-white uppercase tracking-widest mb-2">{t('sshPasswordModalTitle')}</h3>
            <p className="text-xs text-[#909296] mb-6">
              {passwordPrompt.session.name} ({passwordPrompt.session.host}) — {passwordPrompt.session.username}
            </p>
            <div className="space-y-4">
              <input
                type="text"
                className="w-full bg-[#141517] border border-[#373a40] p-3 rounded text-sm text-white focus:border-[#228be6] outline-none"
                placeholder={t('username')}
                value={promptUsername}
                onChange={(e) => setPromptUsername(e.target.value)}
              />
              <input
                type="password"
                className="w-full bg-[#141517] border border-[#373a40] p-3 rounded text-sm text-white focus:border-[#228be6] outline-none"
                placeholder={t('sshPasswordPlaceholder')}
                value={promptPassword}
                onChange={(e) => setPromptPassword(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && promptPassword.trim()) {
                    e.preventDefault();
                    const uname = (promptUsername || '').trim() || 'admin';
                    const pwd = promptPassword.trim();
                    if (savePasswordToSession) {
                      setSessions((prev) => {
                        const next = prev.map((s) =>
                          s.id === passwordPrompt.session.id ? { ...s, username: uname, password: pwd } : s
                        );
                        localStorage.setItem('netnode_ssh_sessions', JSON.stringify(next));
                        return next;
                      });
                      handleConnectRef.current({ ...passwordPrompt.session, username: uname, password: pwd });
                    } else {
                      handleConnectRef.current({ ...passwordPrompt.session, username: uname }, pwd);
                    }
                    setPasswordPrompt(null);
                    setPromptUsername('admin');
                    setPromptPassword('');
                  }
                }}
              />
              <label className="flex items-center gap-2 text-xs text-[#909296] cursor-pointer">
                <input
                  type="checkbox"
                  className="w-4 h-4 rounded border-[#373a40] bg-[#141517] text-[#228be6]"
                  checked={savePasswordToSession}
                  onChange={(e) => setSavePasswordToSession(e.target.checked)}
                />
                {t('sshSavePasswordInSession')}
              </label>
            </div>
            <div className="mt-8 flex gap-4">
              <button
                type="button"
                onClick={() => {
                  setPasswordPrompt(null);
                  setPromptUsername('admin');
                  setPromptPassword('');
                }}
                className="flex-1 py-3 border border-[#373a40] text-[#909296] rounded text-[10px] font-bold uppercase tracking-widest hover:bg-white/5 transition-all"
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                onClick={() => {
                  const uname = (promptUsername || '').trim() || 'admin';
                  const pwd = promptPassword.trim();
                  if (!pwd) return;
                  if (savePasswordToSession) {
                    setSessions((prev) => {
                      const next = prev.map((s) =>
                        s.id === passwordPrompt.session.id ? { ...s, username: uname, password: pwd } : s
                      );
                      localStorage.setItem('netnode_ssh_sessions', JSON.stringify(next));
                      return next;
                    });
                    handleConnectRef.current({ ...passwordPrompt.session, username: uname, password: pwd });
                  } else {
                    handleConnectRef.current({ ...passwordPrompt.session, username: uname }, pwd);
                  }
                  setPasswordPrompt(null);
                  setPromptUsername('admin');
                  setPromptPassword('');
                }}
                className="flex-[2] py-3 bg-[#228be6] hover:bg-[#1c7ed6] text-white rounded text-[10px] font-bold uppercase tracking-widest transition-all"
              >
                {t('sshConnectBtn')}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
};

export default Terminal;

