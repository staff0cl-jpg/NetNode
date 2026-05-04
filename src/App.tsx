import React, { useState } from 'react';
import Sidebar from './components/Sidebar';
import Dashboard from './components/Dashboard';
import Inventory from './components/Inventory';
import Topology from './components/Topology';
import Terminal from './components/Terminal';
import Settings from './components/Settings';
import UserManagement from './components/UserManagement';
import Login from './components/Login';
import { INITIAL_SWITCHES } from './constants';
import { Switch } from './types';
import { LanguageProvider } from './lib/i18n';

function AppContent() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [activeTab, setActiveTab] = useState('inventory');
  const [switches, setSwitches] = useState<Switch[]>(INITIAL_SWITCHES);

  if (!isAuthenticated) {
    return <Login onLogin={() => setIsAuthenticated(true)} />;
  }

  const renderContent = () => {
    switch (activeTab) {
      case 'dashboard':
        return <Dashboard switches={switches} />;
      case 'inventory':
        return <Inventory switches={switches} setSwitches={setSwitches} />;
      case 'topology':
        return <Topology switches={switches} />;
      case 'terminal':
        return <Terminal switches={switches} />;
      case 'users':
        return <UserManagement />;
      case 'settings':
        return <Settings />;
      default:
        return <Dashboard switches={switches} />;
    }
  };

  return (
    <div className="flex h-screen w-screen bg-[#1a1b1e] text-[#c1c2c5] overflow-hidden font-sans">
      <Sidebar 
        activeTab={activeTab} 
        setActiveTab={setActiveTab} 
        onLogout={() => setIsAuthenticated(false)} 
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
            <span>DC-EAST :: MOSCOW</span>
            <span>UPTIME: 14:24:51</span>
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
