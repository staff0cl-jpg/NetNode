import React, { useState } from 'react';
import Sidebar from './components/Sidebar';
import Dashboard from './components/Dashboard';
import Inventory from './components/Inventory';
import Topology from './components/Topology';
import Terminal from './components/Terminal';
import Settings from './components/Settings';
import UserManagement from './components/UserManagement';
import AuditLogs from './components/AuditLogs';
import Login from './components/Login';
import { Switch } from './types';
import { LanguageProvider } from './lib/i18n';

function AppContent() {
  const [user, setUser] = useState<{ id: string, username: string, role: string } | null>(null);
  const [authBootstrapping, setAuthBootstrapping] = useState(true);
  const [activeTab, setActiveTab] = useState('inventory');
  const [switches, setSwitches] = useState<Switch[]>([]);
  const [loading, setLoading] = useState(true);
  const [sshTarget, setSshTarget] = useState<Switch | null>(null);
  const [banner, setBanner] = useState({ siteLabel: 'UNSET', appUptime: '0d 0h 0m' });

  const fetchInventory = async () => {
    try {
      const response = await fetch('/api/inventory', {
        headers: { 
          'x-user-role': user?.role || 'viewer',
          'x-user-name': user?.username || 'unknown'
        }
      });
      if (response.status === 401 || response.status === 403) {
        setUser(null);
        setSwitches([]);
        return;
      }
      const data = await response.json();
      setSwitches(data);
    } catch (error) {
      console.error('Failed to fetch inventory:', error);
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => {
    const restoreSession = async () => {
      try {
        const response = await fetch('/api/auth/session', { credentials: 'include' });
        if (!response.ok) {
          setUser(null);
          return;
        }
        const data = await response.json();
        if (data?.success && data?.user) {
          setUser(data.user);
        } else {
          setUser(null);
        }
      } catch {
        setUser(null);
      } finally {
        setAuthBootstrapping(false);
      }
    };
    restoreSession();
  }, []);

  React.useEffect(() => {
    if (user) {
      fetchInventory();
      // Poll every 5 seconds to catch discovery results
      const interval = setInterval(fetchInventory, 5000);
      return () => clearInterval(interval);
    }
  }, [user]);

  React.useEffect(() => {
    if (!user) return;
    const fetchBanner = async () => {
      try {
        const response = await fetch('/api/system/banner', {
          headers: {
            'x-user-role': user?.role || 'viewer',
            'x-user-name': user?.username || 'unknown'
          }
        });
        if (response.status === 401 || response.status === 403) {
          setUser(null);
          return;
        }
        const data = await response.json();
        setBanner({
          siteLabel: data.siteLabel || 'UNSET',
          appUptime: data.appUptime || '0d 0h 0m'
        });
      } catch {
        /* ignore */
      }
    };
    fetchBanner();
    const timer = setInterval(fetchBanner, 10000);
    return () => clearInterval(timer);
  }, [user]);

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {
      /* ignore */
    } finally {
      setUser(null);
      setSwitches([]);
      setSshTarget(null);
      setActiveTab('inventory');
    }
  };

  if (authBootstrapping) {
    return (
      <div className="min-h-screen w-full bg-[#1a1b1e] flex items-center justify-center text-[#909296] text-sm font-mono">
        Restoring session...
      </div>
    );
  }

  if (!user) {
    return <Login onLogin={(userData) => setUser(userData)} />;
  }

  const isAdmin = user.role === 'admin';
  const isOperator = user.role === 'admin' || user.role === 'operator';

  const renderContent = () => {
    switch (activeTab) {
      case 'dashboard':
        return <Dashboard switches={switches} role={user.role} username={user.username} />;
      case 'inventory':
        return (
          <Inventory 
            switches={switches} 
            setSwitches={setSwitches} 
            role={user.role} 
            username={user.username} 
            onOpenSSH={(sw) => {
              setSshTarget(sw);
              setActiveTab('terminal');
            }}
          />
        );
      case 'topology':
        return (
          <Topology
            switches={switches}
            role={user.role}
            username={user.username}
            onOpenSSH={(sw) => {
              setSshTarget(sw);
              setActiveTab('terminal');
            }}
          />
        );
      case 'terminal':
        return (
          <Terminal 
            switches={switches} 
            role={user.role} 
            targetDevice={sshTarget}
            onClearTarget={() => setSshTarget(null)}
          />
        );
      case 'users':
        return isAdmin ? <UserManagement role={user.role} username={user.username} /> : <Dashboard switches={switches} role={user.role} username={user.username} />;
      case 'audit':
        return isAdmin ? <AuditLogs role={user.role} username={user.username} /> : <Dashboard switches={switches} role={user.role} username={user.username} />;
      case 'settings':
        return <Settings role={user.role} username={user.username} />;
      default:
        return <Dashboard switches={switches} role={user.role} username={user.username} />;
    }
  };

  return (
    <div className="flex h-screen w-screen bg-[#1a1b1e] text-[#c1c2c5] overflow-hidden font-sans">
      <Sidebar 
        activeTab={activeTab} 
        setActiveTab={setActiveTab} 
        onLogout={handleLogout} 
        user={user}
      />
      
      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        {/* Top Header Bar */}
        <header className="h-10 border-b border-[#373a40] bg-[#1a1b1e] shrink-0 flex items-center px-8 justify-between">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 bg-[#40c057] rounded-full" />
              <span className="text-[10px] font-mono text-[#909296] uppercase tracking-wider">Sync Status: Real-time</span>
            </div>
            <div className="h-3 w-px bg-[#373a40]" />
            <span className="text-[10px] font-mono text-[#5c5f66] uppercase tracking-wider">Session: Secure (AES-256)</span>
          </div>
          <div className="flex items-center gap-4 text-[10px] font-mono text-[#909296]">
            <span>{banner.siteLabel}</span>
            <span>UPTIME: {banner.appUptime}</span>
          </div>
        </header>

        <div className="flex-1">
          {renderContent()}
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <LanguageProvider>
      <AppContent />
    </LanguageProvider>
  );
}
