import React from 'react';
import { motion } from 'motion/react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line } from 'recharts';
import { Activity, ShieldCheck, Server, AlertTriangle } from 'lucide-react';
import { Switch } from '../types';
import { useTranslation } from '../lib/i18n';

interface DashboardProps {
  switches: Switch[];
  role?: string;
  username?: string;
}

const Dashboard: React.FC<DashboardProps> = ({ switches, role, username }) => {
  const { t } = useTranslation();
  const [isMounted, setIsMounted] = React.useState(false);
  const [dashboardMetrics, setDashboardMetrics] = React.useState<any>(null);
  const [dashboardUi, setDashboardUi] = React.useState({
    trunkThroughputTitle: '',
    trunkLoadTitle: '',
    trunkMonitorTitle: '',
    showTrunkMonitor: true,
  });

  React.useEffect(() => {
    setIsMounted(true);
  }, []);

  React.useEffect(() => {
    const loadUi = async () => {
      try {
        const r = await fetch('/api/config/system', {
          headers: {
            'x-user-role': role || 'viewer',
            'x-user-name': username || 'unknown'
          }
        });
        if (!r.ok) return;
        const data = await r.json();
        const ui = data?.config?.dashboardUi;
        if (ui) {
          setDashboardUi({
            trunkThroughputTitle: ui.trunkThroughputTitle || '',
            trunkLoadTitle: ui.trunkLoadTitle || '',
            trunkMonitorTitle: ui.trunkMonitorTitle || '',
            showTrunkMonitor: ui.showTrunkMonitor !== false,
          });
        }
      } catch {
        /* ignore */
      }
    };
    loadUi();
  }, [role, username]);

  React.useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch('/api/metrics/dashboard');
        const data = await r.json();
        setDashboardMetrics(data);
      } catch {
        setDashboardMetrics(null);
      }
    };
    load();
    const i = setInterval(load, 15000);
    return () => clearInterval(i);
  }, []);

  const onlineSwitches = switches.filter(s => s.status === 'online');
  const onlineCount = onlineSwitches.length;
  const avgLoadValue = switches.length > 0 ? Math.round((onlineCount / switches.length) * 100) : 0;
  
  const dynamicData = React.useMemo(() => {
    const top = dashboardMetrics?.trunkSummary?.topByTraffic || [];
    if (!top.length) {
      return [{ name: 'N/A', load: 0, traffic: 0 }];
    }
    return top.slice(0, 8).map((p: any) => ({
      name: `${p.deviceName}:${p.ifName}`.slice(0, 18),
      load: Math.round(((p.inBps + p.outBps) / 1_000_000) * 100) / 100,
      traffic: Math.round((p.inBps + p.outBps) / 1_000_000),
    }));
  }, [dashboardMetrics]);

  const trunkDown = dashboardMetrics?.trunkSummary?.down || 0;

  const stats = [
    { label: t('totalSwitches'), value: switches.length, icon: Server, color: '#228be6' },
    { label: t('onlineNodes'), value: onlineCount, icon: ShieldCheck, color: '#40c057' },
    { label: t('activeAlerts'), value: switches.filter(s => s.status !== 'online').length + trunkDown, icon: AlertTriangle, color: '#fa5252' },
    { label: t('avgLoad'), value: `${avgLoadValue}%`, icon: Activity, color: '#fab005' },
  ];

  return (
    <div className="p-8 space-y-8 animate-in fade-in duration-500">
      <header>
        <h2 className="text-2xl font-bold text-white mb-2 leading-tight">{t('infraOverview')}</h2>
        <p className="text-sm text-[#909296]">{t('realtimeStatus')}</p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {stats.map((stat, i) => (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.1 }}
            className="bg-[#25262b] p-6 border border-[#373a40] rounded shadow-sm hover:border-[#228be6] transition-colors group"
          >
            <div className="flex justify-between items-start">
              <div>
                <p className="text-xs font-bold text-[#909296] uppercase tracking-widest mb-1">{stat.label}</p>
                <h3 className="text-3xl font-bold text-white tracking-tight">{stat.value}</h3>
              </div>
              <div className="p-3 rounded bg-[#2c2e33] text-white group-hover:bg-[#228be6] transition-colors" style={{ color: stat.color }}>
                <stat.icon size={20} />
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2 text-[10px] font-mono text-[#40c057]">
              <span>{onlineCount > 0 ? t('trendPlaceholder') : t('noActiveTraffic')}</span>
            </div>
          </motion.div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="bg-[#25262b] p-6 border border-[#373a40] rounded shadow-sm">
          <h3 className="text-sm font-bold text-white uppercase tracking-widest mb-6">{dashboardUi.trunkThroughputTitle || t('trunkThroughputTitle')}</h3>
          <div className="h-64 outline-none">
            {isMounted && (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={dynamicData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#373a40" vertical={false} />
                  <XAxis 
                    dataKey="name" 
                    stroke="#5c5f66" 
                    fontSize={10} 
                    tickLine={false} 
                    axisLine={false} 
                  />
                  <YAxis 
                    stroke="#5c5f66" 
                    fontSize={10} 
                    tickLine={false} 
                    axisLine={false} 
                  />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#1a1b1e', borderColor: '#373a40', color: '#c1c2c5' }}
                  />
                  <Line type="monotone" dataKey="traffic" stroke="#228be6" strokeWidth={2} dot />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="bg-[#25262b] p-6 border border-[#373a40] rounded shadow-sm">
          <h3 className="text-sm font-bold text-white uppercase tracking-widest mb-6">{dashboardUi.trunkLoadTitle || t('trunkLoadTitle')}</h3>
          <div className="h-64 outline-none">
            {isMounted && (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dynamicData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#373a40" vertical={false} />
                  <XAxis 
                    dataKey="name" 
                    stroke="#5c5f66" 
                    fontSize={10} 
                    tickLine={false} 
                    axisLine={false} 
                  />
                  <YAxis 
                    stroke="#5c5f66" 
                    fontSize={10} 
                    tickLine={false} 
                    axisLine={false} 
                  />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#1a1b1e', borderColor: '#373a40', color: '#c1c2c5' }}
                  />
                  <Bar dataKey="load" fill="#40c057" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      {dashboardUi.showTrunkMonitor && (
      <div className="bg-[#25262b] p-6 border border-[#373a40] rounded shadow-sm">
        <h3 className="text-sm font-bold text-white uppercase tracking-widest mb-4">{dashboardUi.trunkMonitorTitle || t('trunkMonitorTitle')}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          {(dashboardMetrics?.trunkSummary?.topByTraffic || []).slice(0, 6).map((p: any) => (
            <div key={`${p.deviceId}-${p.ifIndex}`} className="border border-[#373a40] rounded p-3">
              <div className="flex justify-between">
                <span className="text-white font-semibold">{p.deviceName}</span>
                <span className={p.operStatus === 1 ? 'text-[#40c057]' : 'text-[#fa5252]'}>
                  {p.operStatus === 1 ? t('trunkStateUp') : t('trunkStateDown')}
                </span>
              </div>
              <div className="text-[#909296] mt-1">{p.ifName} :: {p.description}</div>
              <div className="text-[#228be6] mt-1">IN {Math.round(p.inBps / 1_000_000)} Mbps / OUT {Math.round(p.outBps / 1_000_000)} Mbps</div>
            </div>
          ))}
        </div>
      </div>
      )}
    </div>
  );
};

export default Dashboard;
