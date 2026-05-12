import React from 'react';
import { motion } from 'motion/react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line } from 'recharts';
import { Activity, ShieldCheck, Server, AlertTriangle, Settings, Plus, Trash2, ArrowUp, ArrowDown } from 'lucide-react';
import { Switch } from '../types';
import { useTranslation } from '../lib/i18n';
import { netnodeFetch } from '../lib/netnodeFetch';

interface DashboardProps {
  switches: Switch[];
  role?: string;
  username?: string;
}

type DashboardPanel = {
  id: string;
  kind: 'kpi' | 'traffic' | 'load' | 'monitor' | 'metric';
  title: string;
  enabled: boolean;
  source: 'all' | string;
  metricKey?: string;
};

const defaultPanels = (t: (key: string) => string): DashboardPanel[] => [
  { id: 'kpi', kind: 'kpi', title: t('infraOverview'), enabled: true, source: 'all' },
  { id: 'traffic', kind: 'traffic', title: t('trunkThroughputTitle'), enabled: true, source: 'all' },
  { id: 'load', kind: 'load', title: t('trunkLoadTitle'), enabled: true, source: 'all' },
  { id: 'monitor', kind: 'monitor', title: t('trunkMonitorTitle'), enabled: true, source: 'all' },
];

const presetPanels = (preset: 'noc' | 'traffic' | 'capacity', t: (key: string) => string): DashboardPanel[] => {
  if (preset === 'traffic') {
    return [
      { id: 'traffic', kind: 'traffic', title: t('trunkThroughputTitle'), enabled: true, source: 'all' },
      { id: 'load', kind: 'load', title: t('trunkLoadTitle'), enabled: true, source: 'all' },
      { id: 'monitor', kind: 'monitor', title: t('trunkMonitorTitle'), enabled: true, source: 'all' },
    ];
  }
  if (preset === 'capacity') {
    return [
      { id: 'kpi', kind: 'kpi', title: t('infraOverview'), enabled: true, source: 'all' },
      { id: 'load', kind: 'load', title: t('trunkLoadTitle'), enabled: true, source: 'all' },
    ];
  }
  return defaultPanels(t);
};

const isTrunkActive = (trunk: any) => trunk?.isActive === true || (Number(trunk?.operStatus) === 1 && trunk?.isDown !== true);

const Dashboard: React.FC<DashboardProps> = ({ switches, role, username }) => {
  const { t } = useTranslation();
  const [isMounted, setIsMounted] = React.useState(false);
  const [dashboardMetrics, setDashboardMetrics] = React.useState<any>(null);
  const previousSnapshotRef = React.useRef<{
    totalSwitches: number;
    onlineNodes: number;
    activeAlerts: number;
    avgLoad: number;
  } | null>(null);
  const [panels, setPanels] = React.useState<DashboardPanel[]>(defaultPanels(t));
  const [editingPanel, setEditingPanel] = React.useState<DashboardPanel | null>(null);
  const [isSavingPanels, setIsSavingPanels] = React.useState(false);
  const [isAlertsOpen, setIsAlertsOpen] = React.useState(false);

  React.useEffect(() => {
    setIsMounted(true);
  }, []);

  React.useEffect(() => {
    const loadUi = async () => {
      try {
        const r = await netnodeFetch('/api/config/system', {
          credentials: 'include',
        });
        if (!r.ok) return;
        const data = await r.json();
        const configuredPanels = data?.config?.dashboardPanels;
        if (Array.isArray(configuredPanels) && configuredPanels.length > 0) {
          setPanels(configuredPanels);
        }
      } catch {
        /* ignore */
      }
    };
    loadUi();
  }, []);

  React.useEffect(() => {
    const load = async () => {
      try {
        const r = await netnodeFetch('/api/metrics/dashboard');
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
  const avgLoadValue = Number.isFinite(Number(dashboardMetrics?.cpuSummary?.avgCpuLoad))
    ? Number(dashboardMetrics?.cpuSummary?.avgCpuLoad)
    : 0;
  
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
  const devicesWithMetrics = React.useMemo(() => (dashboardMetrics?.devices || []) as Array<any>, [dashboardMetrics]);
  const metricKeys = React.useMemo(() => {
    const set = new Set<string>();
    devicesWithMetrics.forEach((dev: any) => {
      Object.keys(dev.metrics || {}).forEach((k) => set.add(k));
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [devicesWithMetrics]);

  const trunkDown = dashboardMetrics?.trunkSummary?.down || 0;
  const deviceAlerts = React.useMemo(
    () => switches.filter((s) => s.status !== 'online'),
    [switches]
  );
  const trunkAlerts = React.useMemo(() => {
    const devices = (dashboardMetrics?.devices || []) as Array<any>;
    return devices.flatMap((d: any) =>
      (d.trunks || [])
        .filter((t: any) => t.isDown === true)
        .map((t: any) => ({
          deviceName: d.name,
          deviceIp: d.ip,
          ifName: t.ifName || `if#${t.ifIndex || '-'}`,
          description: t.description || '',
        }))
    );
  }, [dashboardMetrics]);

  const stats = [
    { label: t('totalSwitches'), value: switches.length, icon: Server, color: '#228be6' },
    { label: t('onlineNodes'), value: onlineCount, icon: ShieldCheck, color: '#40c057' },
    { label: t('activeAlerts'), value: switches.filter(s => s.status !== 'online').length + trunkDown, icon: AlertTriangle, color: '#fa5252' },
    { label: t('avgLoad'), value: `${avgLoadValue}%`, icon: Activity, color: '#fab005' },
  ];

  const trendSnapshot = React.useMemo(
    () => ({
      totalSwitches: switches.length,
      onlineNodes: onlineCount,
      activeAlerts: switches.filter(s => s.status !== 'online').length + trunkDown,
      avgLoad: avgLoadValue,
    }),
    [switches, onlineCount, trunkDown, avgLoadValue]
  );

  React.useEffect(() => {
    previousSnapshotRef.current = trendSnapshot;
  }, [trendSnapshot]);

  const trendTextByLabel = React.useMemo(() => {
    const previous = previousSnapshotRef.current;
    if (!previous) {
      return {
        [t('totalSwitches')]: t('noTrendData'),
        [t('onlineNodes')]: t('noTrendData'),
        [t('activeAlerts')]: t('noTrendData'),
        [t('avgLoad')]: t('noTrendData'),
      } as Record<string, string>;
    }

    const formatTrend = (current: number, prev: number) => {
      if (!Number.isFinite(current) || !Number.isFinite(prev)) return t('noTrendData');
      if (prev === 0) {
        if (current === 0) return t('trendNoChange');
        return t('noTrendData');
      }
      const deltaPercent = ((current - prev) / Math.abs(prev)) * 100;
      if (!Number.isFinite(deltaPercent)) return t('noTrendData');
      const rounded = Math.round(deltaPercent * 10) / 10;
      const sign = rounded > 0 ? '+' : '';
      if (rounded === 0) return t('trendNoChange');
      return `${sign}${rounded}% ${t('trendSinceLastSample')}`;
    };

    return {
      [t('totalSwitches')]: formatTrend(trendSnapshot.totalSwitches, previous.totalSwitches),
      [t('onlineNodes')]: formatTrend(trendSnapshot.onlineNodes, previous.onlineNodes),
      [t('activeAlerts')]: formatTrend(trendSnapshot.activeAlerts, previous.activeAlerts),
      [t('avgLoad')]: formatTrend(trendSnapshot.avgLoad, previous.avgLoad),
    } as Record<string, string>;
  }, [trendSnapshot, t]);

  const savePanels = async (nextPanels: DashboardPanel[]) => {
    setIsSavingPanels(true);
    try {
      await netnodeFetch('/api/config/system', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ dashboardPanels: nextPanels }),
      });
    } catch {
      /* ignore */
    } finally {
      setIsSavingPanels(false);
    }
  };

  const updatePanel = (panel: DashboardPanel) => {
    const next = panels.map((p) => (p.id === panel.id ? panel : p));
    setPanels(next);
    savePanels(next);
    setEditingPanel(null);
  };

  const movePanel = (id: string, direction: 'up' | 'down') => {
    const idx = panels.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const nextIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (nextIdx < 0 || nextIdx >= panels.length) return;
    const next = [...panels];
    const [item] = next.splice(idx, 1);
    next.splice(nextIdx, 0, item);
    setPanels(next);
    savePanels(next);
    setEditingPanel(item);
  };

  const removePanel = (id: string) => {
    const next = panels.filter((p) => p.id !== id);
    setPanels(next);
    savePanels(next);
    setEditingPanel(null);
  };

  const addPanel = () => {
    const panel: DashboardPanel = {
      id: `metric-${Date.now()}`,
      kind: 'metric',
      title: t('customMetricPanel'),
      source: 'all',
      metricKey: metricKeys[0] || '',
      enabled: true,
    };
    const next = [...panels, panel];
    setPanels(next);
    setEditingPanel(panel);
    savePanels(next);
  };

  const applyPreset = (preset: 'noc' | 'traffic' | 'capacity') => {
    const next = presetPanels(preset, t);
    setPanels(next);
    setEditingPanel(null);
    savePanels(next);
  };

  const selectedPanels = panels.filter((p) => p.enabled !== false);
  const customMetricData = (panel: DashboardPanel) => {
    const sourceDevices =
      panel.source && panel.source !== 'all'
        ? devicesWithMetrics.filter((d: any) => d.id === panel.source)
        : devicesWithMetrics;
    const key = panel.metricKey || metricKeys[0];
    const data = sourceDevices.map((d: any) => {
      const raw = d.metrics?.[key];
      const num = Number(raw);
      return { name: d.name.slice(0, 14), value: Number.isFinite(num) ? num : 0 };
    });
    return data.length ? data : [{ name: 'N/A', value: 0 }];
  };

  return (
    <div className="p-4 md:p-8 space-y-6 md:space-y-8 animate-in fade-in duration-500">
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold text-white mb-2 leading-tight">{t('infraOverview')}</h2>
          <p className="text-sm text-[#909296]">{t('realtimeStatus')}</p>
        </div>
        <button
          onClick={addPanel}
          className="flex items-center gap-2 px-3 py-2 text-xs uppercase font-bold border border-[#373a40] rounded bg-[#25262b] text-[#c1c2c5] hover:text-white"
        >
          <Plus size={14} />
          {t('addPanel')}
        </button>
      </header>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => applyPreset('noc')} className="px-3 py-1.5 text-[10px] uppercase font-bold bg-[#25262b] border border-[#373a40] rounded text-[#c1c2c5] hover:text-white">{t('presetNoc')}</button>
        <button onClick={() => applyPreset('traffic')} className="px-3 py-1.5 text-[10px] uppercase font-bold bg-[#25262b] border border-[#373a40] rounded text-[#c1c2c5] hover:text-white">{t('presetTraffic')}</button>
        <button onClick={() => applyPreset('capacity')} className="px-3 py-1.5 text-[10px] uppercase font-bold bg-[#25262b] border border-[#373a40] rounded text-[#c1c2c5] hover:text-white">{t('presetCapacity')}</button>
      </div>

      {selectedPanels.map((panel) => {
        if (panel.kind === 'kpi') {
          return (
            <div key={panel.id}>
              <div className="flex justify-between items-center mb-3">
                <h3 className="text-sm font-bold text-white uppercase tracking-widest">{panel.title || t('infraOverview')}</h3>
                <button onClick={() => setEditingPanel(panel)} className="text-[#909296] hover:text-white">
                  <Settings size={14} />
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 md:gap-6">
                {stats.map((stat, i) => (
                  <motion.div
                    key={stat.label}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.1 }}
                    className="bg-[#25262b] p-4 md:p-6 border border-[#373a40] rounded shadow-sm hover:border-[#228be6] transition-colors group"
                  >
                    <div className="flex justify-between items-start">
                      <div>
                        <p className="text-xs font-bold text-[#909296] uppercase tracking-widest mb-1">{stat.label}</p>
                        <h3 className="text-2xl md:text-3xl font-bold text-white tracking-tight break-words">{stat.value}</h3>
                      </div>
                      <div className="p-3 rounded bg-[#2c2e33] text-white group-hover:bg-[#228be6] transition-colors" style={{ color: stat.color }}>
                        <stat.icon size={20} />
                      </div>
                    </div>
                    <div className="mt-4 flex items-center gap-2 text-[10px] font-mono text-[#909296]">
                      <span>{trendTextByLabel[stat.label] || t('noTrendData')}</span>
                    </div>
                    {stat.label === t('activeAlerts') && (
                      <button
                        onClick={() => setIsAlertsOpen(true)}
                        className="mt-3 text-[10px] uppercase font-bold tracking-widest text-[#228be6] hover:text-white"
                      >
                        {t('viewAlerts')}
                      </button>
                    )}
                  </motion.div>
                ))}
              </div>
            </div>
          );
        }

        if (panel.kind === 'traffic' || panel.kind === 'load' || panel.kind === 'metric') {
          const isLine = panel.kind === 'traffic';
          const data = panel.kind === 'metric' ? customMetricData(panel) : dynamicData;
          return (
            <div key={panel.id} className="bg-[#25262b] p-4 md:p-6 border border-[#373a40] rounded shadow-sm">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-sm font-bold text-white uppercase tracking-widest">{panel.title}</h3>
                <button onClick={() => setEditingPanel(panel)} className="text-[#909296] hover:text-white">
                  <Settings size={14} />
                </button>
              </div>
              <div className="h-56 sm:h-64 outline-none">
                {isMounted && (
                  <ResponsiveContainer width="100%" height="100%">
                    {isLine ? (
                      <LineChart data={data}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#373a40" vertical={false} />
                        <XAxis dataKey="name" stroke="#5c5f66" fontSize={10} tickLine={false} axisLine={false} />
                        <YAxis stroke="#5c5f66" fontSize={10} tickLine={false} axisLine={false} />
                        <Tooltip contentStyle={{ backgroundColor: '#1a1b1e', borderColor: '#373a40', color: '#c1c2c5' }} />
                        <Line type="monotone" dataKey={panel.kind === 'metric' ? 'value' : 'traffic'} stroke="#228be6" strokeWidth={2} dot />
                      </LineChart>
                    ) : (
                      <BarChart data={data}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#373a40" vertical={false} />
                        <XAxis dataKey="name" stroke="#5c5f66" fontSize={10} tickLine={false} axisLine={false} />
                        <YAxis stroke="#5c5f66" fontSize={10} tickLine={false} axisLine={false} />
                        <Tooltip contentStyle={{ backgroundColor: '#1a1b1e', borderColor: '#373a40', color: '#c1c2c5' }} />
                        <Bar dataKey={panel.kind === 'metric' ? 'value' : 'load'} fill="#40c057" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    )}
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          );
        }

        return (
          <div key={panel.id} className="bg-[#25262b] p-4 md:p-6 border border-[#373a40] rounded shadow-sm">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-sm font-bold text-white uppercase tracking-widest">{panel.title || t('trunkMonitorTitle')}</h3>
              <button onClick={() => setEditingPanel(panel)} className="text-[#909296] hover:text-white">
                <Settings size={14} />
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              {(dashboardMetrics?.trunkSummary?.topByTraffic || []).slice(0, 6).map((p: any) => (
                <div key={`${p.deviceId}-${p.ifIndex}`} className="border border-[#373a40] rounded p-3 min-w-0">
                  <div className="flex justify-between">
                    <span className="text-white font-semibold">{p.deviceName}</span>
                    <span className={isTrunkActive(p) ? 'text-[#40c057]' : 'text-[#fa5252]'}>
                      {isTrunkActive(p) ? t('trunkStateUp') : t('trunkStateDown')}
                    </span>
                  </div>
                  <div className="text-[#909296] mt-1 break-words">{p.ifName} :: {p.description}</div>
                  <div className="text-[#228be6] mt-1">IN {Math.round(p.inBps / 1_000_000)} Mbps / OUT {Math.round(p.outBps / 1_000_000)} Mbps</div>
                  {(() => {
                    const device = ((dashboardMetrics?.devices || []) as Array<any>).find((d) => d.id === p.deviceId);
                    const cpu = Number(device?.cpuLoad);
                    if (!Number.isFinite(cpu)) return null;
                    return <div className="text-[#fab005] mt-1">CPU: {Math.round(cpu * 100) / 100}%</div>;
                  })()}
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {editingPanel && (
        <div className="fixed inset-0 z-[120] bg-black/60 flex items-center justify-center p-3 sm:p-4">
          <div className="w-full max-w-lg bg-[#25262b] border border-[#373a40] rounded p-4 sm:p-5 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-sm font-bold text-white uppercase tracking-widest">{t('panelSettings')}</h3>
              <button onClick={() => setEditingPanel(null)} className="text-[#909296] hover:text-white">x</button>
            </div>
            <div className="space-y-3 text-sm">
              <label className="block">
                <span className="text-[#909296] text-xs">{t('title')}</span>
                <input
                  value={editingPanel.title}
                  onChange={(e) => setEditingPanel({ ...editingPanel, title: e.target.value })}
                  className="mt-1 w-full bg-[#141517] border border-[#373a40] rounded px-2 py-2 text-white"
                />
              </label>
              <label className="block">
                <span className="text-[#909296] text-xs">{t('panelType')}</span>
                <select
                  value={editingPanel.kind}
                  onChange={(e) => setEditingPanel({ ...editingPanel, kind: e.target.value as DashboardPanel['kind'] })}
                  className="mt-1 w-full bg-[#141517] border border-[#373a40] rounded px-2 py-2 text-white"
                >
                  <option value="kpi">{t('panelTypeKpiCards')}</option>
                  <option value="traffic">{t('panelTypeTrafficLine')}</option>
                  <option value="load">{t('panelTypeLoadBars')}</option>
                  <option value="monitor">{t('panelTypeMonitorList')}</option>
                  <option value="metric">{t('panelTypeCustomMetricBars')}</option>
                </select>
              </label>
              {editingPanel.kind === 'metric' && (
                <>
                  <label className="block">
                    <span className="text-[#909296] text-xs">{t('linkedSwitch')}</span>
                    <select
                      value={editingPanel.source}
                      onChange={(e) => setEditingPanel({ ...editingPanel, source: e.target.value })}
                      className="mt-1 w-full bg-[#141517] border border-[#373a40] rounded px-2 py-2 text-white"
                    >
                      <option value="all">{t('allSwitches')}</option>
                      {switches.map((sw) => (
                        <option key={sw.id} value={sw.id}>{sw.name} ({sw.ip})</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-[#909296] text-xs">{t('metricKey')}</span>
                    <select
                      value={editingPanel.metricKey || ''}
                      onChange={(e) => setEditingPanel({ ...editingPanel, metricKey: e.target.value })}
                      className="mt-1 w-full bg-[#141517] border border-[#373a40] rounded px-2 py-2 text-white"
                    >
                      {metricKeys.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </label>
                </>
              )}
              <label className="flex items-center gap-2 text-[#c1c2c5]">
                <input
                  type="checkbox"
                  checked={editingPanel.enabled !== false}
                  onChange={(e) => setEditingPanel({ ...editingPanel, enabled: e.target.checked })}
                />
                {t('panelEnabled')}
              </label>
            </div>
            <div className="mt-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <button
                onClick={() => removePanel(editingPanel.id)}
                className="flex items-center gap-2 px-3 py-2 text-xs text-[#fa5252] border border-[#fa5252]/40 rounded hover:bg-[#fa5252]/10"
              >
                <Trash2 size={14} />
                {t('deletePanel')}
              </button>
              <div className="flex items-center gap-2 self-end">
                <button
                  onClick={() => movePanel(editingPanel.id, 'up')}
                  className="p-2 border border-[#373a40] rounded text-[#c1c2c5] hover:text-white"
                  title={t('moveUp')}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  onClick={() => movePanel(editingPanel.id, 'down')}
                  className="p-2 border border-[#373a40] rounded text-[#c1c2c5] hover:text-white"
                  title={t('moveDown')}
                >
                  <ArrowDown size={14} />
                </button>
                <button
                  disabled={isSavingPanels}
                  onClick={() => updatePanel(editingPanel)}
                  className="px-3 py-2 text-xs uppercase font-bold bg-[#228be6] text-white rounded disabled:opacity-60"
                >
                  {t('save')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {isAlertsOpen && (
        <div className="fixed inset-0 z-[120] bg-black/60 flex items-center justify-center p-3 sm:p-4">
          <div className="w-full max-w-3xl bg-[#25262b] border border-[#373a40] rounded p-4 sm:p-5 max-h-[90vh] overflow-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-sm font-bold text-white uppercase tracking-widest">{t('activeAlertsDetails')}</h3>
              <button onClick={() => setIsAlertsOpen(false)} className="text-[#909296] hover:text-white">x</button>
            </div>

            <div className="mb-5">
              <h4 className="text-xs uppercase font-bold text-[#fa5252] mb-2">
                {t('deviceAlerts')} ({deviceAlerts.length})
              </h4>
              {deviceAlerts.length === 0 ? (
                <div className="text-xs text-[#909296]">{t('noActiveAlerts')}</div>
              ) : (
                <div className="space-y-2">
                  {deviceAlerts.map((d) => (
                    <div key={`dev-alert-${d.id}`} className="border border-[#373a40] rounded p-2 text-xs">
                      <div className="text-white font-semibold">{d.name}</div>
                      <div className="text-[#909296]">{d.ip} · {d.branch || '-'}</div>
                      <div className="text-[#fa5252] uppercase">{d.status}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <h4 className="text-xs uppercase font-bold text-[#fa5252] mb-2">
                {t('trunkAlerts')} ({trunkAlerts.length})
              </h4>
              {trunkAlerts.length === 0 ? (
                <div className="text-xs text-[#909296]">{t('noActiveAlerts')}</div>
              ) : (
                <div className="space-y-2">
                  {trunkAlerts.map((a, idx) => (
                    <div key={`trunk-alert-${a.deviceIp}-${a.ifName}-${idx}`} className="border border-[#373a40] rounded p-2 text-xs">
                      <div className="text-white font-semibold">{a.deviceName} ({a.deviceIp})</div>
                      <div className="text-[#909296]">{a.ifName}{a.description ? ` · ${a.description}` : ''}</div>
                      <div className="text-[#fa5252] uppercase">{t('trunkStateDown')}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Dashboard;
