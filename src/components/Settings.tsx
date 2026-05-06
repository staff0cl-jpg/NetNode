import React from 'react';
import { Key, Shield, HardDrive, Database } from 'lucide-react';
import { useTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';

type LdapProfileForm = {
  enabled: boolean;
  url: string;
  bindDn: string;
  bindPassword: string;
  searchBase: string;
  searchFilter: string;
  tlsRejectUnauthorized: boolean;
};

type SnmpMetricDef = {
  key: string;
  oid: string;
  scale?: number;
  unit?: string;
};

type SnmpTemplate = {
  id: string;
  name: string;
  vendorHint?: string;
  metrics: SnmpMetricDef[];
};

const emptyLdapProfile = (): LdapProfileForm => ({
  enabled: false,
  url: 'ldap://127.0.0.1:389',
  bindDn: '',
  bindPassword: '',
  searchBase: '',
  searchFilter: '(sAMAccountName={{username}})',
  tlsRejectUnauthorized: true,
});

interface SettingsProps {
  role?: string;
  username?: string;
}

const Settings: React.FC<SettingsProps> = ({ role, username }) => {
  const { t } = useTranslation();
  const isAdmin = role === 'admin';
  const isOperator = role === 'admin' || role === 'operator';
  const [discoveryConfig, setDiscoveryConfig] = React.useState({ subnets: '10.0.0.0/24, 192.168.1.0/24', username: 'admin', password: '' });
  const [defaultLanguage, setDefaultLanguage] = React.useState('ru');
  const [siteLabel, setSiteLabel] = React.useState('UNSET');
  const [snmpConfig, setSnmpConfig] = React.useState({
    community: 'public',
    communities: 'public',
    version: 'SNMP v2c',
    timeoutMs: 1200,
    retries: 0,
    port: 161
  });
  const [trapConfig, setTrapConfig] = React.useState({ ip: '10.10.50.10', port: '162' });
  const [snmpTemplates, setSnmpTemplates] = React.useState<SnmpTemplate[]>([]);
  const [dashboardUi, setDashboardUi] = React.useState({
    trunkThroughputTitle: '',
    trunkLoadTitle: '',
    trunkMonitorTitle: '',
    showTrunkMonitor: true,
  });
  const [templateEditor, setTemplateEditor] = React.useState({
    id: '',
    name: '',
    vendorHint: '',
    metricsText: 'uptime|1.3.6.1.2.1.1.3.0|0.01|s'
  });
  const [ldapForm, setLdapForm] = React.useState<{ admin: LdapProfileForm; operator: LdapProfileForm }>({
    admin: emptyLdapProfile(),
    operator: emptyLdapProfile(),
  });
  const [ldapTestUser, setLdapTestUser] = React.useState('');
  const [ldapTestPassword, setLdapTestPassword] = React.useState('');

  React.useEffect(() => {
    const fetchConfig = async () => {
      try {
        const response = await fetch('/api/config/system', {
          headers: { 
            'x-user-role': role || 'viewer',
            'x-user-name': username || 'unknown'
          }
        });
        const data = await response.json();
        if (data.config && data.config.defaultLanguage) {
          setDefaultLanguage(data.config.defaultLanguage);
        }
        if (data.config && data.config.siteLabel) {
          setSiteLabel(data.config.siteLabel);
        }
        if (data.config && data.config.dashboardUi) {
          setDashboardUi({
            trunkThroughputTitle: data.config.dashboardUi.trunkThroughputTitle || '',
            trunkLoadTitle: data.config.dashboardUi.trunkLoadTitle || '',
            trunkMonitorTitle: data.config.dashboardUi.trunkMonitorTitle || '',
            showTrunkMonitor: data.config.dashboardUi.showTrunkMonitor !== false,
          });
        }
        const snmpResp = await fetch('/api/config/snmp', {
          headers: {
            'x-user-role': role || 'viewer',
            'x-user-name': username || 'unknown'
          }
        });
        if (snmpResp.ok) {
          const snmpData = await snmpResp.json();
          if (snmpData.snmp) {
            setSnmpConfig({
              community: snmpData.snmp.community || 'public',
              communities: Array.isArray(snmpData.snmp.communities) ? snmpData.snmp.communities.join(', ') : 'public',
              version: snmpData.snmp.version || 'SNMP v2c',
              timeoutMs: Number(snmpData.snmp.timeoutMs || 1200),
              retries: Number(snmpData.snmp.retries || 0),
              port: Number(snmpData.snmp.port || 161)
            });
          }
        }
        const templateResp = await fetch('/api/snmp/templates', {
          headers: {
            'x-user-role': role || 'viewer',
            'x-user-name': username || 'unknown'
          }
        });
        if (templateResp.ok) {
          const templateData = await templateResp.json();
          if (Array.isArray(templateData.templates)) {
            setSnmpTemplates(templateData.templates);
          }
        }
      } catch (err) {
        console.error('Failed to load system config');
      }
    };
    fetchConfig();
  }, [role, username]);

  React.useEffect(() => {
    if (!isAdmin) return;
    const loadLdap = async () => {
      try {
        const response = await fetch('/api/config/ldap', {
          headers: {
            'x-user-role': role || 'viewer',
            'x-user-name': username || 'unknown',
          },
        });
        const data = await response.json();
        if (data.ldap) {
          setLdapForm({
            admin: { ...emptyLdapProfile(), ...data.ldap.admin },
            operator: { ...emptyLdapProfile(), ...data.ldap.operator },
          });
        }
      } catch {
        /* ignore */
      }
    };
    loadLdap();
  }, [isAdmin, role, username]);

  const saveLdapProfiles = async () => {
    try {
      const response = await fetch('/api/config/ldap', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown',
        },
        body: JSON.stringify(ldapForm),
      });
      const data = await response.json();
      if (data.ldap) {
        setLdapForm({
          admin: { ...emptyLdapProfile(), ...data.ldap.admin },
          operator: { ...emptyLdapProfile(), ...data.ldap.operator },
        });
      }
      alert(t('ldapSaved'));
    } catch {
      alert('LDAP save failed');
    }
  };

  const saveSystemConfig = async (payload: { defaultLanguage?: string; siteLabel?: string; dashboardUi?: any }) => {
    try {
      await fetch('/api/config/system', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown'
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      alert('Failed to save config');
    }
  };

  const testLdap = async (kind: 'admin' | 'operator', withUserLogin: boolean) => {
    try {
      const body: Record<string, unknown> = {
        profile: kind,
        draft: ldapForm[kind],
      };
      if (withUserLogin) {
        body.testUsername = ldapTestUser.trim();
        body.testPassword = ldapTestPassword;
      }
      const response = await fetch('/api/config/ldap/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown',
        },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      alert(data.ok ? `OK: ${data.message}` : `${data.message || 'LDAP test failed'}`);
    } catch {
      alert('LDAP test request failed');
    }
  };

  const handleStartDiscovery = async () => {
    try {
      const response = await fetch('/api/discovery/start', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown'
        },
        body: JSON.stringify(discoveryConfig),
      });
      const data = await response.json();
      if (!response.ok) {
        alert(data.error || 'Discovery failed');
        return;
      }
      alert(
        `${t('discoveryScanned')}: ${data.scanned}\n${t('discoverySshOpen')}: ${data.sshOpen}\n${t('discoveryAdded')}: ${data.added}`
      );
    } catch {
      alert('Failed to initiate discovery.');
    }
  };

  const handleSaveSNMP = async () => {
    try {
      const communities = snmpConfig.communities
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
      const response = await fetch('/api/config/snmp', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown'
        },
        body: JSON.stringify({
          community: snmpConfig.community,
          version: snmpConfig.version,
          communities,
          timeoutMs: snmpConfig.timeoutMs,
          retries: snmpConfig.retries,
          port: snmpConfig.port
        }),
      });
      const data = await response.json();
      alert(data.message);
    } catch (error) {
      alert('Failed to save SNMP config.');
    }
  };

  const handleSaveTrap = async () => {
    try {
      const response = await fetch('/api/config/trap-receiver', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown'
        },
        body: JSON.stringify(trapConfig),
      });
      const data = await response.json();
      alert(data.message);
    } catch (error) {
      alert('Failed to save Trap Receiver config.');
    }
  };

  const handleDeleteTemplate = async (id: string) => {
    if (!confirm(`Delete template ${id}?`)) return;
    try {
      const response = await fetch(`/api/snmp/templates/${id}`, {
        method: 'DELETE',
        headers: {
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown'
        }
      });
      const data = await response.json();
      if (!response.ok) {
        alert(data.error || 'Template delete failed');
        return;
      }
      setSnmpTemplates(data.templates || []);
    } catch {
      alert('Template delete failed');
    }
  };

  const handleSaveDashboardUi = async () => {
    await saveSystemConfig({ dashboardUi });
    alert('Dashboard UI saved');
  };

  const loadTemplateToEditor = (tpl: SnmpTemplate) => {
    setTemplateEditor({
      id: tpl.id,
      name: tpl.name,
      vendorHint: tpl.vendorHint || '',
      metricsText: tpl.metrics.map((m) => `${m.key}|${m.oid}|${m.scale ?? 1}|${m.unit ?? ''}`).join('\n')
    });
  };

  const handleSaveTemplate = async () => {
    const metrics = templateEditor.metricsText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [key, oid, scale, unit] = line.split('|').map((v) => (v || '').trim());
        return {
          key,
          oid,
          scale: Number.isFinite(Number(scale)) ? Number(scale) : 1,
          unit: unit || undefined
        };
      })
      .filter((m) => m.key && m.oid);

    if (!templateEditor.id.trim() || !templateEditor.name.trim() || metrics.length === 0) {
      alert('Template id/name and at least one metric are required');
      return;
    }

    try {
      const response = await fetch('/api/snmp/templates', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown'
        },
        body: JSON.stringify({
          id: templateEditor.id.trim(),
          name: templateEditor.name.trim(),
          vendorHint: templateEditor.vendorHint.trim() || undefined,
          metrics
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        alert(data.error || 'Template save failed');
        return;
      }
      setSnmpTemplates(data.templates || []);
      alert('SNMP template saved');
    } catch {
      alert('Template save failed');
    }
  };

  return (
    <div className="p-8 space-y-8 max-w-4xl animate-in slide-in-from-bottom-5 duration-700">
      <header>
        <h2 className="text-2xl font-bold text-white mb-2 leading-tight">{t('sysConfig')}</h2>
        <p className="text-sm text-[#909296]">{t('manageInfra')}</p>
      </header>

      <div className="space-y-6">
        {/* Language Section */}
        <div className={cn("bg-[#25262b] border border-[#373a40] rounded overflow-hidden", !isAdmin && "opacity-50 pointer-events-none")}>
          <div className="p-4 border-b border-[#373a40] bg-[#1c1d21] flex items-center gap-3">
            <Database size={18} className="text-[#228be6]" />
            <h3 className="text-sm font-bold text-white uppercase tracking-widest">{t('sysConfig')}</h3>
          </div>
          <div className="p-6">
            <div className="max-w-xs space-y-2">
              <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">Default Language (Default для всех)</label>
              <select 
                value={defaultLanguage}
                onChange={(e) => {
                  setDefaultLanguage(e.target.value);
                  saveSystemConfig({ defaultLanguage: e.target.value });
                }}
                className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none appearance-none cursor-pointer"
              >
                <option value="ru">Русский (Russian)</option>
                <option value="en">English</option>
              </select>
              <p className="text-[9px] text-[#5c5f66] mt-1 font-medium">Этот параметр определяет язык системы для всех новых сессий и пользователей без локальных настроек.</p>
            </div>
            <div className="max-w-xl space-y-2 mt-6">
              <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">DC Label (верхняя панель)</label>
              <div className="flex gap-3">
                <input
                  value={siteLabel}
                  onChange={(e) => setSiteLabel(e.target.value)}
                  className="flex-1 bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none"
                  placeholder="DC-EAST :: MOSCOW"
                />
                <button
                  type="button"
                  onClick={() => saveSystemConfig({ siteLabel })}
                  className="px-4 py-2 bg-[#228be6] hover:bg-[#1c7ed6] text-white rounded text-[10px] font-bold uppercase tracking-widest transition-all"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* LDAP */}
        <div className={cn("bg-[#25262b] border border-[#373a40] rounded overflow-hidden", !isAdmin && "opacity-50 pointer-events-none")}>
          <div className="p-4 border-b border-[#373a40] bg-[#1c1d21] flex items-center gap-3">
            <Key size={18} className="text-[#40c057]" />
            <div>
              <h3 className="text-sm font-bold text-white uppercase tracking-widest">{t('ldapAuthSection')}</h3>
              <p className="text-[10px] text-[#5c5f66] mt-1 max-w-2xl">{t('ldapAuthSectionDesc')}</p>
            </div>
            {!isAdmin && <span className="text-[10px] bg-red-500/20 text-red-500 px-2 py-0.5 rounded font-bold uppercase tracking-widest ml-auto">Admin Only</span>}
          </div>
          <div className="p-6 space-y-10">
            <div className="flex flex-wrap gap-4 items-end pb-4 border-b border-[#373a40]">
              <div className="space-y-2 min-w-[140px]">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('ldapTestAccount')}</label>
                <input
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none"
                  value={ldapTestUser}
                  onChange={(e) => setLdapTestUser(e.target.value)}
                  autoComplete="username"
                />
              </div>
              <div className="space-y-2 min-w-[140px]">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('ldapTestPasswordField')}</label>
                <input
                  type="password"
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none"
                  value={ldapTestPassword}
                  onChange={(e) => setLdapTestPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </div>
            </div>
            {(['admin', 'operator'] as const).map((kind) => (
              <div key={kind} className="space-y-4 border border-[#373a40] rounded-lg p-5 bg-[#1c1d21]/50">
                <h4 className="text-xs font-bold text-[#fab005] uppercase tracking-widest">
                  {kind === 'admin' ? t('ldapAdminProfile') : t('ldapOperatorProfile')}
                </h4>
                <label className="flex items-center gap-2 text-xs text-[#c1c2c5] cursor-pointer">
                  <input
                    type="checkbox"
                    className="w-4 h-4 rounded border-[#373a40] bg-[#141517] text-[#228be6]"
                    checked={ldapForm[kind].enabled}
                    onChange={(e) =>
                      setLdapForm((prev) => ({
                        ...prev,
                        [kind]: { ...prev[kind], enabled: e.target.checked },
                      }))
                    }
                  />
                  {t('ldapEnabled')}
                </label>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2 md:col-span-2">
                    <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('ldapUrl')}</label>
                    <input
                      className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none"
                      value={ldapForm[kind].url}
                      onChange={(e) =>
                        setLdapForm((prev) => ({ ...prev, [kind]: { ...prev[kind], url: e.target.value } }))
                      }
                    />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('ldapBindDn')}</label>
                    <input
                      className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none font-mono text-xs"
                      value={ldapForm[kind].bindDn}
                      onChange={(e) =>
                        setLdapForm((prev) => ({ ...prev, [kind]: { ...prev[kind], bindDn: e.target.value } }))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('ldapBindPassword')}</label>
                    <input
                      type="password"
                      className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none"
                      value={ldapForm[kind].bindPassword}
                      onChange={(e) =>
                        setLdapForm((prev) => ({ ...prev, [kind]: { ...prev[kind], bindPassword: e.target.value } }))
                      }
                      placeholder="••••••••"
                      autoComplete="new-password"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('ldapSearchBase')}</label>
                    <input
                      className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none font-mono text-xs"
                      value={ldapForm[kind].searchBase}
                      onChange={(e) =>
                        setLdapForm((prev) => ({ ...prev, [kind]: { ...prev[kind], searchBase: e.target.value } }))
                      }
                    />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('ldapSearchFilter')}</label>
                    <input
                      className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none font-mono text-xs"
                      value={ldapForm[kind].searchFilter}
                      onChange={(e) =>
                        setLdapForm((prev) => ({ ...prev, [kind]: { ...prev[kind], searchFilter: e.target.value } }))
                      }
                    />
                    <p className="text-[9px] text-[#5c5f66]">{t('ldapSearchFilterHint')}</p>
                  </div>
                </div>
                <label className="flex items-center gap-2 text-xs text-[#909296] cursor-pointer">
                  <input
                    type="checkbox"
                    className="w-4 h-4 rounded border-[#373a40] bg-[#141517] text-[#228be6]"
                    checked={!ldapForm[kind].tlsRejectUnauthorized}
                    onChange={(e) =>
                      setLdapForm((prev) => ({
                        ...prev,
                        [kind]: { ...prev[kind], tlsRejectUnauthorized: !e.target.checked },
                      }))
                    }
                  />
                  {t('ldapTlsInsecure')}
                </label>
                <div className="flex flex-wrap gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => testLdap(kind, false)}
                    className="px-4 py-2 bg-[#2c2e33] border border-[#373a40] text-[#c1c2c5] hover:text-white rounded text-[10px] font-bold uppercase tracking-widest transition-all"
                  >
                    {t('ldapTestConnection')}
                  </button>
                  <button
                    type="button"
                    disabled={!ldapTestUser.trim()}
                    onClick={() => testLdap(kind, true)}
                    className="px-4 py-2 bg-[#228be6]/20 border border-[#228be6]/40 text-[#228be6] hover:bg-[#228be6]/30 rounded text-[10px] font-bold uppercase tracking-widest transition-all disabled:opacity-40 disabled:pointer-events-none"
                  >
                    {t('ldapTestUserLogin')}
                  </button>
                </div>
              </div>
            ))}
            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={saveLdapProfiles}
                className="px-6 py-2 bg-[#40c057] hover:bg-[#37b24d] text-white rounded text-[10px] font-bold uppercase tracking-widest transition-all shadow-lg"
              >
                {t('ldapSave')}
              </button>
            </div>
          </div>
        </div>

        {/* Auto-Discovery Section */}
        <div className={cn("bg-[#25262b] border border-[#373a40] rounded overflow-hidden", !isOperator && "opacity-50 pointer-events-none")}>
          <div className="p-4 border-b border-[#373a40] bg-[#1c1d21] flex items-center gap-3">
            <Database className="text-[#228be6]" size={18} />
            <h3 className="text-sm font-bold text-white uppercase tracking-widest">{t('autoDiscovery')}</h3>
            {!isOperator && <span className="text-[10px] bg-red-500/20 text-red-500 px-2 py-0.5 rounded font-bold uppercase tracking-widest ml-auto">Privileged Action Required</span>}
          </div>
          <div className="p-6 space-y-6">
            <p className="text-[10px] text-[#5c5f66] leading-relaxed">{t('discoveryScanExplain')}</p>
            <div className="grid grid-cols-1 gap-6">
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('discoverySubnets')}</label>
                <input 
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none transition-colors" 
                  value={discoveryConfig.subnets}
                  onChange={(e) => setDiscoveryConfig({...discoveryConfig, subnets: e.target.value})}
                  placeholder="10.0.0.0/24, 192.168.1.0/24" 
                />
              </div>
            </div>
            
            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('username')}</label>
                <input 
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none transition-colors" 
                  value={discoveryConfig.username}
                  onChange={(e) => setDiscoveryConfig({...discoveryConfig, username: e.target.value})}
                  placeholder="admin" 
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">Password</label>
                <input 
                  type="password" 
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none transition-colors" 
                  value={discoveryConfig.password}
                  onChange={(e) => setDiscoveryConfig({...discoveryConfig, password: e.target.value})}
                  placeholder="••••••••" 
                />
              </div>
            </div>

            <div className="pt-4 border-t border-[#373a40] flex justify-between items-center">
              <p className="text-[10px] text-[#5c5f66] uppercase">{t('sshCredentials')}</p>
              <button 
                onClick={handleStartDiscovery}
                className="px-6 py-2 bg-[#40c057] hover:bg-[#37b24d] text-white rounded text-[10px] font-bold uppercase tracking-widest transition-all shadow-lg"
              >
                {t('startDiscovery')}
              </button>
            </div>
          </div>
        </div>

        {/* SNMP Configuration Section */}
        <div className={cn("bg-[#25262b] border border-[#373a40] rounded overflow-hidden", !isAdmin && "opacity-50 pointer-events-none")}>
          <div className="p-4 border-b border-[#373a40] bg-[#1c1d21] flex items-center gap-3">
            <Shield className="text-[#fab005]" size={18} />
            <h3 className="text-sm font-bold text-white uppercase tracking-widest">{t('snmpConfig')}</h3>
            {!isAdmin && <span className="text-[10px] bg-red-500/20 text-red-500 px-2 py-0.5 rounded font-bold uppercase tracking-widest ml-auto">Admin Only</span>}
          </div>
          <div className="p-6 space-y-6">
            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('snmpCommunity')}</label>
                <input 
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none transition-colors" 
                  value={snmpConfig.community}
                  onChange={(e) => setSnmpConfig({...snmpConfig, community: e.target.value})}
                  placeholder="public" 
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('snmpVersion')}</label>
                <select 
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none transition-colors"
                  value={snmpConfig.version}
                  onChange={(e) => setSnmpConfig({...snmpConfig, version: e.target.value})}
                >
                  <option>SNMP v2c</option>
                  <option>SNMP v1</option>
                  <option>SNMP v3 (AuthPriv)</option>
                </select>
              </div>
              <div className="space-y-2 col-span-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">SNMP Communities (fallback list)</label>
                <input
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none transition-colors"
                  value={snmpConfig.communities}
                  onChange={(e) => setSnmpConfig({ ...snmpConfig, communities: e.target.value })}
                  placeholder="public, netops_ro, noc_read"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">SNMP Port</label>
                <input
                  type="number"
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none transition-colors"
                  value={snmpConfig.port}
                  onChange={(e) => setSnmpConfig({ ...snmpConfig, port: Number(e.target.value) || 161 })}
                  min={1}
                  max={65535}
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">SNMP Timeout (ms)</label>
                <input
                  type="number"
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none transition-colors"
                  value={snmpConfig.timeoutMs}
                  onChange={(e) => setSnmpConfig({ ...snmpConfig, timeoutMs: Number(e.target.value) || 1200 })}
                  min={300}
                  max={5000}
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">SNMP Retries</label>
                <input
                  type="number"
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none transition-colors"
                  value={snmpConfig.retries}
                  onChange={(e) => setSnmpConfig({ ...snmpConfig, retries: Number(e.target.value) || 0 })}
                  min={0}
                  max={3}
                />
              </div>
            </div>
            <div className="flex justify-end">
               <button 
                onClick={handleSaveSNMP}
                className="px-6 py-2 bg-[#fab005] hover:bg-[#f08c00] text-black rounded text-[10px] font-bold uppercase tracking-widest transition-all shadow-lg"
              >
                {t('saveChanges')}
              </button>
            </div>
          </div>
        </div>

        {/* SNMP Trap Receiver Section */}
        <div className={cn("bg-[#25262b] border border-[#373a40] rounded overflow-hidden", !isAdmin && "opacity-50 pointer-events-none")}>
          <div className="p-4 border-b border-[#373a40] bg-[#1c1d21] flex items-center gap-3">
            <Shield className="text-[#fab005]" size={18} />
            <h3 className="text-sm font-bold text-white uppercase tracking-widest">SNMP Trap Receiver</h3>
            {!isAdmin && <span className="text-[10px] bg-red-500/20 text-red-500 px-2 py-0.5 rounded font-bold uppercase tracking-widest ml-auto">Admin Only</span>}
          </div>
          <div className="p-6 space-y-6">
            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('trapReceiverIp')}</label>
                <input 
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none transition-colors" 
                  value={trapConfig.ip}
                  onChange={(e) => setTrapConfig({...trapConfig, ip: e.target.value})}
                  placeholder="10.0.0.10" 
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('trapReceiverPort')}</label>
                <input 
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none transition-colors" 
                  value={trapConfig.port}
                  onChange={(e) => setTrapConfig({...trapConfig, port: e.target.value})}
                  placeholder="162" 
                />
              </div>
            </div>
            <div className="flex justify-end">
               <button 
                onClick={handleSaveTrap}
                className="px-6 py-2 bg-[#fab005] hover:bg-[#f08c00] text-black rounded text-[10px] font-bold uppercase tracking-widest transition-all shadow-lg"
              >
                {t('saveChanges')}
              </button>
            </div>
          </div>
        </div>

        {/* SNMP Template Management */}
        <div className={cn("bg-[#25262b] border border-[#373a40] rounded overflow-hidden", !isAdmin && "opacity-50 pointer-events-none")}>
          <div className="p-4 border-b border-[#373a40] bg-[#1c1d21] flex items-center gap-3">
            <HardDrive className="text-[#228be6]" size={18} />
            <h3 className="text-sm font-bold text-white uppercase tracking-widest">{t('snmpTemplatesTitle')}</h3>
            {!isAdmin && <span className="text-[10px] bg-red-500/20 text-red-500 px-2 py-0.5 rounded font-bold uppercase tracking-widest ml-auto">Admin Only</span>}
          </div>
          <div className="p-6 space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">Template ID</label>
                <input
                  value={templateEditor.id}
                  onChange={(e) => setTemplateEditor({ ...templateEditor, id: e.target.value })}
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none"
                  placeholder="zbx-switch-basic"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">Template Name</label>
                <input
                  value={templateEditor.name}
                  onChange={(e) => setTemplateEditor({ ...templateEditor, name: e.target.value })}
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none"
                  placeholder="Switch Core Template"
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">Vendor Hint</label>
                <input
                  value={templateEditor.vendorHint}
                  onChange={(e) => setTemplateEditor({ ...templateEditor, vendorHint: e.target.value })}
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none"
                  placeholder="Cisco / UPS / Any"
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">Metrics (key|oid|scale|unit per line)</label>
                <textarea
                  value={templateEditor.metricsText}
                  onChange={(e) => setTemplateEditor({ ...templateEditor, metricsText: e.target.value })}
                  className="w-full min-h-[140px] bg-[#141517] border border-[#373a40] p-2.5 rounded text-xs text-white focus:border-[#228be6] outline-none font-mono"
                  placeholder={"uptime|1.3.6.1.2.1.1.3.0|0.01|s\ncpu|1.3.6.1.4.1.x.y.z|1|%"}
                />
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleSaveTemplate}
                className="px-6 py-2 bg-[#40c057] hover:bg-[#37b24d] text-white rounded text-[10px] font-bold uppercase tracking-widest transition-all shadow-lg"
              >
                {t('saveTemplate')}
              </button>
            </div>

            <div className="border-t border-[#373a40] pt-5">
              <p className="text-[10px] text-[#909296] uppercase tracking-wider mb-3">{t('existingTemplates')}</p>
              <div className="space-y-2">
                {snmpTemplates.map((tpl) => (
                  <div key={tpl.id} className="w-full text-left border border-[#373a40] bg-[#141517] rounded p-3 transition-colors">
                    <button
                      type="button"
                      onClick={() => loadTemplateToEditor(tpl)}
                      className="w-full text-left hover:text-[#228be6] transition-colors"
                    >
                      <div className="text-sm text-white font-semibold">{tpl.name}</div>
                      <div className="text-[10px] text-[#909296] mt-1">{tpl.id} {tpl.vendorHint ? `:: ${tpl.vendorHint}` : ''}</div>
                    </button>
                    <div className="mt-3 flex justify-end">
                      <button
                        type="button"
                        onClick={() => handleDeleteTemplate(tpl.id)}
                        className="px-3 py-1.5 bg-red-500/15 border border-red-500/40 text-red-400 rounded text-[10px] font-bold uppercase tracking-widest"
                      >
                        {t('deleteTemplate')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Dashboard customization */}
        <div className={cn("bg-[#25262b] border border-[#373a40] rounded overflow-hidden", !isAdmin && "opacity-50 pointer-events-none")}>
          <div className="p-4 border-b border-[#373a40] bg-[#1c1d21] flex items-center gap-3">
            <Database className="text-[#228be6]" size={18} />
            <h3 className="text-sm font-bold text-white uppercase tracking-widest">{t('dashboardCustomization')}</h3>
          </div>
          <div className="p-6 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <input
                value={dashboardUi.trunkThroughputTitle}
                onChange={(e) => setDashboardUi({ ...dashboardUi, trunkThroughputTitle: e.target.value })}
                className="bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none"
                placeholder={t('trunkThroughputTitle')}
              />
              <input
                value={dashboardUi.trunkLoadTitle}
                onChange={(e) => setDashboardUi({ ...dashboardUi, trunkLoadTitle: e.target.value })}
                className="bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none"
                placeholder={t('trunkLoadTitle')}
              />
              <input
                value={dashboardUi.trunkMonitorTitle}
                onChange={(e) => setDashboardUi({ ...dashboardUi, trunkMonitorTitle: e.target.value })}
                className="bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none md:col-span-2"
                placeholder={t('trunkMonitorTitle')}
              />
              <label className="flex items-center gap-2 text-xs text-[#c1c2c5] md:col-span-2">
                <input
                  type="checkbox"
                  checked={dashboardUi.showTrunkMonitor}
                  onChange={(e) => setDashboardUi({ ...dashboardUi, showTrunkMonitor: e.target.checked })}
                  className="w-4 h-4 rounded border-[#373a40] bg-[#141517] text-[#228be6]"
                />
                {t('showTrunkMonitor')}
              </label>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleSaveDashboardUi}
                className="px-6 py-2 bg-[#228be6] hover:bg-[#1c7ed6] text-white rounded text-[10px] font-bold uppercase tracking-widest transition-all shadow-lg"
              >
                {t('saveChanges')}
              </button>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
};

export default Settings;
