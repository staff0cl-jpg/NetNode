import React, { useState } from 'react';
import Sidebar from './components/Sidebar';
import Dashboard from './components/Dashboard';
import Inventory from './components/Inventory';
import Topology from './components/Topology';
import Terminal from './components/Terminal';
import Automation from './components/Automation';
import Settings from './components/Settings';
import UserManagement from './components/UserManagement';
import AuditLogs from './components/AuditLogs';
import Login from './components/Login';
import SetupWizard from './components/SetupWizard';
import { Switch } from './types';
import { LanguageProvider, useTranslation } from './lib/i18n';
import { NotificationsProvider } from './lib/notifications';
import NotificationCenter from './components/NotificationCenter';
import { APP_VERSION } from './lib/version';
import { Menu } from 'lucide-react';

type ThemeMode = 'dark' | 'light';
const APP_CONFIG_UPDATED_EVENT = 'netnode:config-updated';
type PublicBanner = {
  siteLabel: string;
  productName: string;
  logoDataUrl: string;
  theme: ThemeMode;
  appUptime: string;
};

const DEFAULT_BANNER: PublicBanner = {
  siteLabel: 'UNSET',
  productName: 'NETNODE',
  logoDataUrl: '',
  theme: 'dark',
  appUptime: '0d 0h 0m',
};

function AppContent() {
  const { t } = useTranslation();
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);
  const [user, setUser] = useState<{ id: string, username: string, role: string } | null>(null);
  const [authBootstrapping, setAuthBootstrapping] = useState(true);
  const [activeTab, setActiveTab] = useState('inventory');
  const [switches, setSwitches] = useState<Switch[]>([]);
  const [loading, setLoading] = useState(true);
  const [sshTarget, setSshTarget] = useState<Switch | null>(null);
  const [banner, setBanner] = useState<PublicBanner>(DEFAULT_BANNER);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/setup/status");
        const data = await response.json();
        if (!cancelled) setSetupRequired(!!data.needsSetup);
      } catch {
        if (!cancelled) setSetupRequired(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchInventory = async () => {
    try {
      const response = await fetch('/api/inventory', {
        credentials: 'include',
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
    if (setupRequired === true) {
      setAuthBootstrapping(false);
    }
  }, [setupRequired]);

  React.useEffect(() => {
    if (setupRequired !== false) return;
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
  }, [setupRequired]);

  React.useEffect(() => {
    const fetchPublicConfig = async () => {
      try {
        const response = await fetch('/api/config/public');
        if (!response.ok) return;
        const data = await response.json();
        setBanner((prev) => ({
          ...prev,
          siteLabel: data.siteLabel || DEFAULT_BANNER.siteLabel,
          productName: data.productName || DEFAULT_BANNER.productName,
          logoDataUrl: data.logoDataUrl || DEFAULT_BANNER.logoDataUrl,
          theme: data.theme === 'light' ? 'light' : 'dark',
        }));
      } catch {
        /* ignore: keep defaults when public config unavailable */
      }
    };

    fetchPublicConfig();
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
          credentials: 'include',
        });
        if (response.status === 401 || response.status === 403) {
          setUser(null);
          return;
        }
        const data = await response.json();
        setBanner({
          siteLabel: data.siteLabel || 'UNSET',
          productName: data.productName || 'NETNODE',
          logoDataUrl: data.logoDataUrl || '',
          theme: data.theme === 'light' ? 'light' : 'dark',
          appUptime: data.appUptime || '0d 0h 0m',
        });
      } catch {
        /* ignore */
      }
    };
    fetchBanner();
    const timer = setInterval(fetchBanner, 10000);
    return () => clearInterval(timer);
  }, [user]);

  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', banner.theme === 'light' ? 'light' : 'dark');
    document.body.setAttribute('data-theme', banner.theme === 'light' ? 'light' : 'dark');
  }, [banner.theme]);

  React.useEffect(() => {
    const handleConfigUpdated = (event: Event) => {
      const customEvent = event as CustomEvent<{ theme?: ThemeMode; logoDataUrl?: string }>;
      const { theme, logoDataUrl } = customEvent.detail || {};
      if (!theme && typeof logoDataUrl !== 'string') return;
      setBanner((prev) => ({
        ...prev,
        theme: theme ?? prev.theme,
        logoDataUrl: typeof logoDataUrl === 'string' ? logoDataUrl : prev.logoDataUrl,
      }));
    };
    window.addEventListener(APP_CONFIG_UPDATED_EVENT, handleConfigUpdated as EventListener);
    return () => window.removeEventListener(APP_CONFIG_UPDATED_EVENT, handleConfigUpdated as EventListener);
  }, []);

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

  React.useEffect(() => {
    setMobileSidebarOpen(false);
  }, [activeTab]);

  if (setupRequired === null) {
    return (
      <div className="min-h-screen w-full bg-[#1a1b1e] flex items-center justify-center text-[#909296] text-sm font-mono">
        {t('setupLoading')}
      </div>
    );
  }

  if (setupRequired) {
    return <SetupWizard />;
  }

  if (authBootstrapping) {
    return (
      <div className="min-h-screen w-full bg-[#1a1b1e] flex items-center justify-center text-[#909296] text-sm font-mono">
        {t('restoringSession')}
      </div>
    );
  }

  if (!user) {
    return (
      <Login
        onLogin={(userData) => setUser(userData)}
        productName={banner.productName}
        logoDataUrl={banner.logoDataUrl}
      />
    );
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
      case 'automation':
        return <Automation role={user.role} username={user.username} />;
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
      <NotificationCenter />
      <div className="hidden md:block">
        <Sidebar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          onLogout={handleLogout}
          user={user}
          productName={banner.productName}
          logoDataUrl={banner.logoDataUrl}
        />
      </div>
      <div className="md:hidden">
        <Sidebar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          onLogout={handleLogout}
          user={user}
          productName={banner.productName}
          logoDataUrl={banner.logoDataUrl}
          isMobile
          isOpen={mobileSidebarOpen}
          onClose={() => setMobileSidebarOpen(false)}
        />
        {mobileSidebarOpen && (
          <button
            className="fixed inset-0 z-[110] bg-black/50"
            aria-label={t('closeMenuOverlay')}
            onClick={() => setMobileSidebarOpen(false)}
          />
        )}
      </div>
      
      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        {/* Top Header Bar */}
        <header className="h-10 border-b border-[#373a40] bg-[#1a1b1e] shrink-0 flex items-center px-3 md:px-8 justify-between gap-2">
          <div className="flex items-center gap-2 md:gap-4 min-w-0">
            <button
              className="md:hidden p-1.5 text-[#909296] hover:text-white"
              onClick={() => setMobileSidebarOpen(true)}
              aria-label={t('openMenu')}
            >
              <Menu size={16} />
            </button>
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 bg-[#40c057] rounded-full" />
              <span className="text-[10px] font-mono text-[#909296] uppercase tracking-wider whitespace-nowrap">{t('syncStatusRealtime')}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 md:gap-4 text-[10px] font-mono text-[#909296] min-w-0">
            <span className="whitespace-nowrap text-[#5c5f66]">v{APP_VERSION}</span>
            <span className="whitespace-nowrap">{t('uptimeLabel')}: {banner.appUptime}</span>
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
      <NotificationsProvider>
        <AppContent />
      </NotificationsProvider>
    </LanguageProvider>
  );
}
