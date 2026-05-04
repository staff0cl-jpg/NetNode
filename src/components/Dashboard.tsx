import React from 'react';
import { motion } from 'motion/react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line } from 'recharts';
import { Activity, ShieldCheck, Server, AlertTriangle } from 'lucide-react';
import { Switch } from '../types';
import { useTranslation } from '../lib/i18n';

const data = [
  { name: '00:00', load: 45, traffic: 120 },
  { name: '04:00', load: 30, traffic: 80 },
  { name: '08:00', load: 65, traffic: 450 },
  { name: '12:00', load: 85, traffic: 890 },
  { name: '16:00', load: 75, traffic: 650 },
  { name: '20:00', load: 55, traffic: 300 },
];

interface DashboardProps {
  switches: Switch[];
}

const Dashboard: React.FC<DashboardProps> = ({ switches }) => {
  const { t } = useTranslation();
  const [isMounted, setIsMounted] = React.useState(false);

  React.useEffect(() => {
    setIsMounted(true);
  }, []);

  const stats = [
    { label: t('totalSwitches'), value: switches.length, icon: Server, color: '#228be6' },
    { label: t('onlineNodes'), value: switches.filter(s => s.status === 'online').length, icon: ShieldCheck, color: '#40c057' },
    { label: t('activeAlerts'), value: switches.filter(s => s.status !== 'online').length, icon: AlertTriangle, color: '#fa5252' },
    { label: t('avgLoad'), value: '42%', icon: Activity, color: '#fab005' },
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
              <span>+2.4% vs last week</span>
            </div>
          </motion.div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="bg-[#25262b] p-6 border border-[#373a40] rounded shadow-sm">
          <h3 className="text-sm font-bold text-white uppercase tracking-widest mb-6">{t('throughput')}</h3>
          <div className="h-64 outline-none">
            {isMounted && (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data}>
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
                  <Line type="monotone" dataKey="traffic" stroke="#228be6" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="bg-[#25262b] p-6 border border-[#373a40] rounded shadow-sm">
          <h3 className="text-sm font-bold text-white uppercase tracking-widest mb-6">{t('cpuLoadVendor')}</h3>
          <div className="h-64 outline-none">
            {isMounted && (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data}>
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
    </div>
  );
};

export default Dashboard;
