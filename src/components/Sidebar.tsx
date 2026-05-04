import React from 'react';
import { LayoutDashboard, Database, Share2, Terminal as TerminalIcon, Settings, Network, MapPin } from 'lucide-react';
import { cn } from '../lib/utils';

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
}

const Sidebar: React.FC<SidebarProps> = ({ activeTab, setActiveTab }) => {
  const menuItems = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'inventory', label: 'Inventory', icon: Database },
    { id: 'topology', label: 'Topology', icon: Share2 },
    { id: 'terminal', label: 'CLI Console', icon: TerminalIcon },
    { id: 'settings', label: 'Configuration', icon: Settings },
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
        <p className="text-[10px] font-bold text-[#5c5f66] uppercase tracking-widest mb-4 px-2">Main Management</p>
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

      <div className="p-4 border-t border-[#373a40] bg-[#1a1b1e]">
        <div className="flex items-center gap-3 px-2 py-2">
          <div className="w-8 h-8 rounded-full bg-[#373a40] flex items-center justify-center text-[10px] font-bold text-white">AD</div>
          <div className="flex flex-col">
            <span className="text-xs font-semibold text-white">Admin User</span>
            <span className="text-[10px] text-[#909296]">Active Directory</span>
          </div>
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
