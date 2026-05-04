import React from 'react';
import { LayoutDashboard, Database, Share2, Terminal as TerminalIcon, Settings, Network, Users, Languages } from 'lucide-react';
import { cn } from '../lib/utils';
import { useTranslation } from '../lib/i18n';

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  onLogout: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({ activeTab, setActiveTab, onLogout }) => {
  const { t, language, setLanguage } = useTranslation();
  
  const menuItems = [
    { id: 'dashboard', label: t('dashboard'), icon: LayoutDashboard },
    { id: 'inventory', label: t('inventory'), icon: Database },
    { id: 'topology', label: t('topology'), icon: Share2 },
    { id: 'terminal', label: t('terminal'), icon: TerminalIcon },
    { id: 'users', label: t('users'), icon: Users },
    { id: 'settings', label: t('settings'), icon: Settings },
  ];

  return (
    <aside className="w-64 bg-[#141517] border-r border-[#373a40] flex flex-col h-full overflow-hidden">
      <div className="p-6 flex items-center gap-3 border-b border-[#373a40]">
        <div className="w-10 h-10 bg-[#228be6] rounded flex items-center justify-center text-white shadow-lg">
          <Network size={24} strokeWidth={2.5} />
        </div>
        <div>
          <h1 className="font-bold text-white tracking-tight text-lg">NETNODE</h1>
          <p className="text-[10px] text-[#909296] uppercase tracking-widest font-mono">Enterprise v2.4</p>
        </div>
      </div>
      
      <nav className="flex-1 p-4 space-y-1">
        <p className="text-[10px] font-bold text-[#5c5f66] uppercase tracking-widest mb-4 px-2">{t('mainManagement')}</p>
        {menuItems.map((item) => (
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
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-[#373a40] flex items-center justify-center text-[10px] font-bold text-white">AD</div>
            <div className="flex flex-col">
              <span className="text-xs font-semibold text-white">Administrator</span>
              <span className="text-[10px] text-[#909296]">Local Account</span>
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
