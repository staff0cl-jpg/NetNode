import React from 'react';
import { LayoutDashboard, Database, Share2, Terminal as TerminalIcon, Settings, Network, Users, Languages, History } from 'lucide-react';
import { cn } from '../lib/utils';
import { useTranslation } from '../lib/i18n';

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  onLogout: () => void;
  user: { username: string, role: string } | null;
}

const Sidebar: React.FC<SidebarProps> = ({ activeTab, setActiveTab, onLogout, user }) => {
  const { t, language, setLanguage } = useTranslation();
  
  const menuItems = [
    { id: 'dashboard', label: t('dashboard'), icon: LayoutDashboard },
    { id: 'inventory', label: t('inventory'), icon: Database },
    { id: 'topology', label: t('topology'), icon: Share2 },
    { id: 'terminal', label: t('terminal'), icon: TerminalIcon },
    { id: 'users', label: t('users'), icon: Users, adminOnly: true },
    { id: 'audit', label: t('auditLogs'), icon: History, adminOnly: true },
    { id: 'settings', label: t('settings'), icon: Settings },
  ];

  const visibleMenuItems = menuItems.filter(item => !item.adminOnly || user?.role === 'admin');

  return (
    <aside className="w-64 bg-[#141517] border-r border-[#373a40] flex flex-col h-full overflow-hidden">
      <div className="p-6 flex items-center gap-3 border-b border-[#373a40]">
        <div className="w-10 h-10 bg-[#228be6] rounded flex items-center justify-center text-white shadow-lg">
          <svg width="24" height="24" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M6 10H26" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            <path d="M9 10V22C9 24.2091 10.7909 26 13 26C15.2091 26 17 24.2091 17 22V10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            <path d="M17 10V22C17 24.2091 18.7909 26 21 26C23.2091 26 25 24.2091 25 22V10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            <circle cx="13" cy="5" r="2.5" fill="currentColor" />
            <circle cx="21" cy="5" r="2.5" fill="currentColor" />
          </svg>
        </div>
        <div>
          <h1 className="font-bold text-white tracking-tight text-lg">NETNODE</h1>
        </div>
      </div>
      
      <nav className="flex-1 p-4 space-y-1">
        <p className="text-[10px] font-bold text-[#5c5f66] uppercase tracking-widest mb-4 px-2">{t('mainManagement')}</p>
        {visibleMenuItems.map((item) => (
          <button
            key={item.id}
            onClick={() => setActiveTab(item.id)}
            className={cn(
              "w-full flex items-center gap-3 px-3 py-2.5 rounded transition-all text-sm font-medium",
              activeTab === item.id 
                ? "bg-[#228be6] text-white shadow-sm" 
                : "text-[#909296] hover:bg-[#2c2e33] hover:text-[#c1c2c5]"
            )}
          >
            <item.icon size={18} />
            {item.label}
          </button>
        ))}
      </nav>

      <div className="p-4 space-y-4 border-t border-[#373a40] bg-[#1a1b1e]">
        <div className="flex items-center gap-2 p-1 bg-[#141517] rounded">
          <button 
            onClick={() => setLanguage('ru')}
            className={cn("flex-1 py-1 rounded text-[10px] font-bold uppercase transition-all", language === 'ru' ? "bg-[#228be6] text-white" : "text-[#5c5f66]")}
          >RU</button>
          <button 
            onClick={() => setLanguage('en')}
            className={cn("flex-1 py-1 rounded text-[10px] font-bold uppercase transition-all", language === 'en' ? "bg-[#228be6] text-white" : "text-[#5c5f66]")}
          >EN</button>
        </div>

        <div className="flex items-center justify-between px-2 py-2">
          <div className="flex items-center gap-3 overflow-hidden">
            <div className="w-8 h-8 shrink-0 rounded-full bg-[#373a40] flex items-center justify-center text-[10px] font-bold text-white uppercase">
              {user?.username.slice(0, 2)}
            </div>
            <div className="flex flex-col overflow-hidden">
              <span className="text-xs font-semibold text-white truncate">{user?.username || 'Guest'}</span>
              <span className="text-[10px] text-[#909296] uppercase">{user?.role || 'Viewer'}</span>
            </div>
          </div>
          <button 
            onClick={onLogout}
            className="text-[#909296] hover:text-red-500 transition-colors"
            title={t('logout')}
          >
            <Share2 className="rotate-90" size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
