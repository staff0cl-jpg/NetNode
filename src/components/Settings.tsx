import React from 'react';
import { Key, Shield, UserCheck, HardDrive, Cpu, Database } from 'lucide-react';
import { useTranslation } from '../lib/i18n';

const Settings: React.FC = () => {
  const { t } = useTranslation();
  const [testStatus, setTestStatus] = React.useState<'idle' | 'testing' | 'success' | 'error'>('idle');

  const handleTestConnection = () => {
    setTestStatus('testing');
    // Simulate LDAP connection test
    setTimeout(() => {
      const isSuccess = Math.random() > 0.3; // 70% success rate for simulation
      setTestStatus(isSuccess ? 'success' : 'error');
      
      setTimeout(() => setTestStatus('idle'), 3000);
    }, 2000);
  };

  return (
    <div className="p-8 space-y-8 max-w-4xl animate-in slide-in-from-bottom-5 duration-700">
      <header>
        <h2 className="text-2xl font-bold text-white mb-2 leading-tight">{t('sysConfig')}</h2>
        <p className="text-sm text-[#909296]">{t('manageInfra')}</p>
      </header>

      <div className="space-y-6">
        {/* LDAP / AD Section */}
        <div className="bg-[#25262b] border border-[#373a40] rounded overflow-hidden">
          <div className="p-4 border-b border-[#373a40] bg-[#1c1d21] flex items-center justify-between">
            <div className="flex items-center gap-3">
              <UserCheck className="text-[#228be6]" size={18} />
              <h3 className="text-sm font-bold text-white uppercase tracking-widest">{t('ldapAuth')}</h3>
            </div>
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
                <input className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none transition-colors" placeholder="ad.company.local" />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('ldapPort')}</label>
                <input className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none transition-colors" placeholder="389 (LDAP) or 636 (LDAPS)" />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('baseDN')}</label>
                <input className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none transition-colors" placeholder="dc=company,dc=local" />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('serviceAccount')}</label>
                <input className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none transition-colors" placeholder="cn=ldap-user,ou=Service Accounts,dc=company,dc=local" />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('accessGroup')}</label>
                <input className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none transition-colors" placeholder="cn=NetAdmins,ou=Groups,dc=company,dc=local" />
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
              <button 
                onClick={() => {
                  alert('Configuration saved to server.');
                }}
                className="px-6 py-2 border border-[#373a40] text-[#c1c2c5] rounded text-[10px] font-bold uppercase tracking-widest hover:bg-[#2c2e33] transition-all"
              >
                {t('saveChanges')}
              </button>
            </div>
          </div>
        </div>

        {/* Resource Planning Info */}
        <div className="bg-[#25262b] border border-[#373a40] rounded overflow-hidden">
          <div className="p-4 border-b border-[#373a40] bg-[#1c1d21] flex items-center gap-3">
            <Cpu className="text-[#fab005]" size={18} />
            <h3 className="text-sm font-bold text-white uppercase tracking-widest">{t('resourcePlanning')}</h3>
          </div>
          <div className="p-6">
            <p className="text-xs text-[#909296] mb-6 leading-relaxed">
              Based on the requested Nginx + PHP requirements (deployment instructions below), 
              the following resources are recommended for a production environment managing up to 500 switches.
            </p>
            
            <div className="grid grid-cols-3 gap-6">
              <div className="flex items-center gap-4 p-4 bg-[#141517] border border-[#373a40] rounded">
                <Cpu className="text-[#fab005]" size={24} />
                <div>
                  <p className="text-[10px] font-bold text-[#909296] uppercase">CPU</p>
                  <p className="text-lg font-bold text-white leading-none mt-1">4 vCPU</p>
                </div>
              </div>
              <div className="flex items-center gap-4 p-4 bg-[#141517] border border-[#373a40] rounded">
                <Database className="text-[#228be6]" size={24} />
                <div>
                  <p className="text-[10px] font-bold text-[#909296] uppercase">RAM</p>
                  <p className="text-lg font-bold text-white leading-none mt-1">8 GB</p>
                </div>
              </div>
              <div className="flex items-center gap-4 p-4 bg-[#141517] border border-[#373a40] rounded">
                <HardDrive className="text-[#fa5252]" size={24} />
                <div>
                  <p className="text-[10px] font-bold text-[#909296] uppercase">Disk (RAID 10)</p>
                  <p className="text-lg font-bold text-white leading-none mt-1">100 GB</p>
                </div>
              </div>
            </div>

            <div className="mt-8 space-y-4">
              <h4 className="text-xs font-bold text-white uppercase tracking-widest">Deployment Implementation Guide (Linux)</h4>
              <div className="bg-[#141517] p-4 rounded font-mono text-[11px] text-[#40c057] overflow-x-auto border border-[#373a40]">
                <p># Install Nginx, PHP (7.4+ or 8.x) & Extensions</p>
                <p>sudo apt install nginx php-fpm php-curl php-ldap php-mbstring php-xml</p>
                <p className="mt-2 text-white"># Nginx Host Configuration (/etc/nginx/sites-available/netnode)</p>
                <p className="opacity-60">server {"{"}</p>
                <p className="opacity-60 ml-4">listen 80;</p>
                <p className="opacity-60 ml-4">root /var/www/netnode/public;</p>
                <p className="opacity-60 ml-4">index index.php;</p>
                <p className="opacity-60 ml-4">location ~ \.php$ {"{"} include snippets/fastcgi-php.conf; fastcgi_pass unix:/var/run/php/php8.1-fpm.sock; {"}"}</p>
                <p className="opacity-60">{"}"}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Settings;
