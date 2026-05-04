import React from 'react';
import { Key, Shield, UserCheck, HardDrive, Cpu, Database } from 'lucide-react';
import { useTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';

interface SettingsProps {
  role?: string;
  username?: string;
}

const Settings: React.FC<SettingsProps> = ({ role, username }) => {
  const { t } = useTranslation();
  const isAdmin = role === 'admin';
  const isOperator = role === 'admin' || role === 'operator';
  const [testStatus, setTestStatus] = React.useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [ldapConfig, setLdapConfig] = React.useState({ 
    enabled: false,
    host: 'ad.company.local', 
    port: '389', 
    baseDN: 'dc=company,dc=local', 
    adminGroup: 'OU=Admins,DC=company,DC=local',
    operatorGroup: 'OU=Operators,DC=company,DC=local'
  });
  const [discoveryConfig, setDiscoveryConfig] = React.useState({ subnets: '10.0.0.0/24, 192.168.1.0/24', username: 'admin', password: '' });
  const [snmpConfig, setSnmpConfig] = React.useState({ community: 'public', version: 'SNMP v2c' });
  const [trapConfig, setTrapConfig] = React.useState({ ip: '10.10.50.10', port: '162' });

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
        setLdapConfig(prev => ({
          ...prev,
          enabled: data.ldapEnabled,
          adminGroup: data.ldapAdminGroup,
          operatorGroup: data.ldapOperatorGroup
        }));
      } catch (err) {
        console.error('Failed to load system config');
      }
    };
    fetchConfig();
  }, [role, username]);

  const saveSystemConfig = async (newLdap: any) => {
    try {
      await fetch('/api/config/system', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown'
        },
        body: JSON.stringify({
          ldapEnabled: newLdap.enabled,
          ldapAdminGroup: newLdap.adminGroup,
          ldapOperatorGroup: newLdap.operatorGroup
        }),
      });
    } catch (err) {
      alert('Failed to save config');
    }
  };

  const handleTestConnection = async () => {
    setTestStatus('testing');
    try {
      const response = await fetch('/api/auth/ldap/test', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown'
        },
        body: JSON.stringify({
          ...ldapConfig,
          host: ldapConfig.host,
          port: ldapConfig.port,
          baseDN: ldapConfig.baseDN,
          adminGroup: ldapConfig.adminGroup,
          operatorGroup: ldapConfig.operatorGroup
        }),
      });
      const data = await response.json();
      setTestStatus(data.success ? 'success' : 'error');
    } catch (error) {
      setTestStatus('error');
    } finally {
      setTimeout(() => setTestStatus('idle'), 5000);
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
      alert(data.message);
    } catch (error) {
      alert('Failed to initiate discovery.');
    }
  };

  const handleSaveSNMP = async () => {
    try {
      const response = await fetch('/api/config/snmp', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown'
        },
        body: JSON.stringify(snmpConfig),
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

  return (
    <div className="p-8 space-y-8 max-w-4xl animate-in slide-in-from-bottom-5 duration-700">
      <header>
        <h2 className="text-2xl font-bold text-white mb-2 leading-tight">{t('sysConfig')}</h2>
        <p className="text-sm text-[#909296]">{t('manageInfra')}</p>
      </header>

      <div className="space-y-6">
        {/* LDAP / AD Section */}
        <div className={cn("bg-[#25262b] border border-[#373a40] rounded overflow-hidden", !isAdmin && "opacity-50 pointer-events-none")}>
          <div className="p-4 border-b border-[#373a40] bg-[#1c1d21] flex items-center justify-between">
            <div className="flex items-center gap-3">
              <UserCheck className="text-[#228be6]" size={18} />
              <h3 className="text-sm font-bold text-white uppercase tracking-widest">{t('ldapAuth')}</h3>
              <div className="flex items-center gap-2 ml-4">
                <input 
                  type="checkbox" 
                  checked={ldapConfig.enabled}
                  onChange={(e) => {
                    const next = { ...ldapConfig, enabled: e.target.checked };
                    setLdapConfig(next);
                    saveSystemConfig(next);
                  }}
                  className="w-4 h-4 rounded border-[#373a40] bg-[#141517] text-[#228be6]"
                />
                <span className="text-[10px] font-bold text-[#909296] uppercase">{t('enableLdap')}</span>
              </div>
            </div>
            {!isAdmin && <span className="text-[10px] bg-red-500/20 text-red-500 px-2 py-0.5 rounded font-bold uppercase tracking-widest">Admin Only</span>}
            {testStatus !== 'idle' && (
              <div className={`text-[10px] font-bold uppercase py-1 px-3 rounded ${
                testStatus === 'testing' ? 'text-amber-500 bg-amber-500/10' :
                testStatus === 'success' ? 'text-green-500 bg-green-500/10' :
                'text-red-500 bg-red-500/10'
              }`}>
                {testStatus === 'testing' ? t('connecting') : 
                 testStatus === 'success' ? t('connSuccess') : 
                 t('connFailed')}
              </div>
            )}
          </div>
          <div className="p-6 space-y-4">
            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('ldapDC')}</label>
                <input 
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none transition-colors" 
                  value={ldapConfig.host}
                  onChange={(e) => setLdapConfig({...ldapConfig, host: e.target.value})}
                  placeholder="ad.company.local" 
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('ldapPort')}</label>
                <input 
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none transition-colors" 
                  value={ldapConfig.port}
                  onChange={(e) => setLdapConfig({...ldapConfig, port: e.target.value})}
                  placeholder="389" 
                />
              </div>
              <div className="grid grid-cols-1 gap-6 col-span-2">
                <div className="space-y-2">
                  <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('baseDN')}</label>
                  <input 
                    className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none transition-colors" 
                    value={ldapConfig.baseDN}
                    onChange={(e) => setLdapConfig({...ldapConfig, baseDN: e.target.value})}
                    placeholder="dc=company,dc=local" 
                  />
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('serviceAccount')}</label>
                <input 
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none transition-colors" 
                  value={ldapConfig.adminGroup}
                  onChange={(e) => setLdapConfig({...ldapConfig, adminGroup: e.target.value})}
                  placeholder="OU=Admins,DC=company,DC=local" 
                />
              </div>
               <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('accessGroup')}</label>
                <input 
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none transition-colors" 
                  value={ldapConfig.operatorGroup}
                  onChange={(e) => setLdapConfig({...ldapConfig, operatorGroup: e.target.value})}
                  placeholder="OU=Operators,DC=company,DC=local" 
                />
              </div>
            </div>
            
            <div className="flex gap-3 pt-4">
              <button 
                onClick={handleTestConnection}
                disabled={testStatus === 'testing'}
                className="px-6 py-2 bg-[#228be6] text-white rounded text-[10px] font-bold uppercase tracking-widest hover:bg-[#1c7ed6] transition-all disabled:opacity-50 flex items-center gap-2"
              >
                {testStatus === 'testing' && <Cpu className="animate-spin" size={12} />}
                {t('testConn')}
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
                  <option>SNMP v3 (AuthPriv)</option>
                </select>
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

      </div>
    </div>
  );
};

export default Settings;
