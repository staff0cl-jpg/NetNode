import React from 'react';
import { Key, Shield, HardDrive, Database } from 'lucide-react';
import { useTranslation } from '../lib/i18n';
import { useNotifications } from '../lib/notifications';
import { cn } from '../lib/utils';
import { MAX_LOGO_SIZE_BYTES, processLogoWhiteToTransparent, validatePngFile } from '../lib/logo';
import { friendlyErrorMessage, logTechnicalError, readApiPayload } from '../lib/friendlyErrors';

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

type DiscoveryWatchProfile = {
  id: string;
  name: string;
  subnets: string;
  protocol: 'snmp';
  city: string;
  branch: string;
  enabled: boolean;
  intervalHours: number;
  lastRunAt: string | null;
  lastResult: any;
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

type SettingsTabKey = 'general' | 'discovery' | 'ssh' | 'ldap' | 'automation' | 'adminMeta';
type ThemeMode = 'dark' | 'light';

const APP_CONFIG_UPDATED_EVENT = 'netnode:config-updated';

const Settings: React.FC<SettingsProps> = ({ role, username }) => {
  const { t } = useTranslation();
  const { notifySuccess, notifyError, notifyInfo } = useNotifications();
  const isAdmin = role === 'admin';
  const isOperator = role === 'admin' || role === 'operator';
  const [activeTab, setActiveTab] = React.useState<SettingsTabKey>('general');
  const [discoveryConfig, setDiscoveryConfig] = React.useState({
    subnets: '10.0.0.0/24, 192.168.1.0/24',
    protocol: 'snmp',
    city: 'Ульяновск',
    branch: 'ULN',
  });
  const [watchProfiles, setWatchProfiles] = React.useState<DiscoveryWatchProfile[]>([]);
  const [watchStatus, setWatchStatus] = React.useState<{
    schedulerActive: boolean;
    tickIntervalSec: number;
    lastTickAt: string | null;
    lastProcessedProfiles: number;
    currentlyRunning: boolean;
    activeManualWatchRunJobId?: string | null;
    enabledProfiles: number;
    nextRuns: Array<{ id: string; name: string; nextRunAt: string; dueInMs: number }>;
    serverNow: string;
  } | null>(null);
  const [defaultLanguage, setDefaultLanguage] = React.useState('ru');
  const [productName, setProductName] = React.useState('NETNODE');
  const [theme, setTheme] = React.useState<ThemeMode>('dark');
  const [appliedLogoDataUrl, setAppliedLogoDataUrl] = React.useState('');
  const [logoDraftDataUrl, setLogoDraftDataUrl] = React.useState('');
  const [logoThreshold, setLogoThreshold] = React.useState(245);
  const [logoProcessing, setLogoProcessing] = React.useState(false);
  const [automationDefaults, setAutomationDefaults] = React.useState({
    batchSize: 10,
    timeoutMs: 15000,
    retry: 1,
    concurrency: 10,
    errorThreshold: 20,
  });
  const automationPresets = React.useMemo(
    () => ({
      safe: { batchSize: 5, timeoutMs: 20000, retry: 2, concurrency: 3, errorThreshold: 10 },
      balanced: { batchSize: 10, timeoutMs: 15000, retry: 1, concurrency: 8, errorThreshold: 20 },
      fast: { batchSize: 20, timeoutMs: 10000, retry: 0, concurrency: 16, errorThreshold: 30 },
    }),
    []
  );
  const [snmpConfig, setSnmpConfig] = React.useState({
    community: 'public',
    communities: 'public',
    version: 'SNMP v2c',
    timeoutMs: 1200,
    retries: 0,
    port: 161,
  });
  const [sshReadonlyConfig, setSshReadonlyConfig] = React.useState({
    username: '',
    password: '',
    port: 22,
    ttlHours: 3,
    allowMetricsFallback: true,
    enabled: false,
    hasPassword: false,
    expiresAt: '',
  });
  const [inventoryMetaEditor, setInventoryMetaEditor] = React.useState({
    categories: '',
    subcategories: '',
    branches: '',
    cities: '',
    vendors: '',
    modelsJson: '{}'
  });
  const [snmpTemplates, setSnmpTemplates] = React.useState<SnmpTemplate[]>([]);
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
        if (data.config && typeof data.config.productName === 'string') {
          setProductName(data.config.productName || 'NETNODE');
        }
        if (data.config && data.config.theme) {
          setTheme(data.config.theme === 'light' ? 'light' : 'dark');
        }
        if (data.config && typeof data.config.logoDataUrl === 'string') {
          const nextLogo = data.config.logoDataUrl;
          setAppliedLogoDataUrl(nextLogo);
          setLogoDraftDataUrl(nextLogo);
        }
        if (data.config && data.config.automationDefaults) {
          setAutomationDefaults({
            batchSize: Number(data.config.automationDefaults.batchSize || 10),
            timeoutMs: Number(data.config.automationDefaults.timeoutMs || 15000),
            retry: Number(data.config.automationDefaults.retry || 1),
            concurrency: Number(data.config.automationDefaults.concurrency || 10),
            errorThreshold: Number(data.config.automationDefaults.errorThreshold || 20),
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
              port: Number(snmpData.snmp.port || 161),
            });
          }
        }
        const sshReadonlyResp = await fetch('/api/config/ssh-readonly', {
          headers: {
            'x-user-role': role || 'viewer',
            'x-user-name': username || 'unknown'
          }
        });
        if (sshReadonlyResp.ok) {
          const sshData = await sshReadonlyResp.json();
          setSshReadonlyConfig((prev) => ({
            ...prev,
            username: sshData.username || '',
            port: Number(sshData.port || 22),
            allowMetricsFallback: sshData.allowMetricsFallback !== false,
            enabled: sshData.enabled === true,
            hasPassword: sshData.hasPassword === true,
            expiresAt: sshData.expiresAt || '',
            password: '',
          }));
        }
        const templateResp = await fetch('/api/snmp/templates', {
          credentials: 'include',
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
        const invMetaResp = await fetch('/api/inventory/meta', {
          credentials: 'include',
          headers: {
            'x-user-role': role || 'viewer',
            'x-user-name': username || 'unknown'
          }
        });
        if (invMetaResp.ok) {
          const inv = await invMetaResp.json();
          setInventoryMetaEditor({
            categories: (inv.categories || []).join(', '),
            subcategories: (inv.subcategories || []).join(', '),
            branches: (inv.branches || []).join(', '),
            cities: (inv.cities || []).join(', '),
            vendors: (inv.vendors || []).join(', '),
            modelsJson: JSON.stringify(inv.models || {}, null, 2)
          });
        }
        const watchResp = await fetch('/api/discovery/watch', {
          headers: {
            'x-user-role': role || 'viewer',
            'x-user-name': username || 'unknown'
          }
        });
        if (watchResp.ok) {
          const watchData = await watchResp.json();
          if (Array.isArray(watchData.profiles)) {
            setWatchProfiles(watchData.profiles);
          }
        }
        const watchStatusResp = await fetch('/api/discovery/watch/status', {
          headers: {
            'x-user-role': role || 'viewer',
            'x-user-name': username || 'unknown'
          }
        });
        if (watchStatusResp.ok) {
          const status = await watchStatusResp.json();
          setWatchStatus(status);
        }
      } catch (err) {
        console.error('Failed to load system config');
      }
    };
    fetchConfig();
  }, [role, username]);

  React.useEffect(() => {
    if (!isOperator) return;
    const timer = window.setInterval(async () => {
      try {
        const [watchResp, statusResp] = await Promise.all([
          fetch('/api/discovery/watch', {
            headers: {
              'x-user-role': role || 'viewer',
              'x-user-name': username || 'unknown'
            }
          }),
          fetch('/api/discovery/watch/status', {
            headers: {
              'x-user-role': role || 'viewer',
              'x-user-name': username || 'unknown'
            }
          })
        ]);
        if (watchResp.ok) {
          const watchData = await watchResp.json();
          if (Array.isArray(watchData.profiles)) setWatchProfiles(watchData.profiles);
        }
        if (statusResp.ok) {
          const statusData = await statusResp.json();
          setWatchStatus(statusData);
        }
      } catch {
        /* ignore periodic refresh errors */
      }
    }, 20000);
    return () => window.clearInterval(timer);
  }, [isOperator, role, username]);

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
      notifySuccess(t('ldapSaved'));
    } catch {
      notifyError('LDAP save failed');
    }
  };

  const saveSystemConfig = async (payload: {
    defaultLanguage?: string;
    productName?: string;
    theme?: ThemeMode;
    logoDataUrl?: string;
    automationDefaults?: any;
  }) => {
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
      return true;
    } catch (err) {
      notifyError('Failed to save config');
      return false;
    }
  };

  const emitConfigUpdate = React.useCallback((payload: { theme?: ThemeMode; logoDataUrl?: string }) => {
    window.dispatchEvent(new CustomEvent(APP_CONFIG_UPDATED_EVENT, { detail: payload }));
  }, []);

  const saveThemeImmediately = React.useCallback(async (nextTheme: ThemeMode) => {
    setTheme(nextTheme);
    emitConfigUpdate({ theme: nextTheme });
    const ok = await saveSystemConfig({ theme: nextTheme });
    if (!ok) {
      notifyError(t('settingsThemeSaveFailed'));
    }
  }, [emitConfigUpdate, notifyError, t]);

  const handleLogoUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setLogoProcessing(true);
    try {
      await validatePngFile(file);
      const { originalDataUrl, processedDataUrl } = await processLogoWhiteToTransparent(file, logoThreshold);
      const safeLogo = processedDataUrl || originalDataUrl;
      setLogoDraftDataUrl(safeLogo);
      notifySuccess(t('settingsLogoReadyToApply'));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('settingsLogoUploadFailed');
      notifyError(message);
    } finally {
      setLogoProcessing(false);
    }
  };

  const applyLogoThreshold = async () => {
    if (!logoDraftDataUrl) return;
    try {
      const response = await fetch(logoDraftDataUrl);
      const blob = await response.blob();
      const logoFile = new File([blob], 'logo.png', { type: 'image/png' });
      const { originalDataUrl, processedDataUrl } = await processLogoWhiteToTransparent(logoFile, logoThreshold);
      const safeLogo = processedDataUrl || originalDataUrl;
      setLogoDraftDataUrl(safeLogo);
      notifySuccess(t('settingsLogoThresholdApplied'));
    } catch {
      notifyError(t('settingsLogoProcessFailed'));
    }
  };

  const applyLogoDraft = async () => {
    if (!logoDraftDataUrl || logoDraftDataUrl === appliedLogoDataUrl) return;
    setLogoProcessing(true);
    try {
      const ok = await saveSystemConfig({ logoDataUrl: logoDraftDataUrl });
      if (!ok) return;
      setAppliedLogoDataUrl(logoDraftDataUrl);
      emitConfigUpdate({ logoDataUrl: logoDraftDataUrl });
      notifySuccess(t('settingsLogoSaved'));
    } finally {
      setLogoProcessing(false);
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
      if (data.ok) {
        notifySuccess(`OK: ${data.message}`);
      } else {
        notifyError(`${data.message || 'LDAP test failed'}`);
      }
    } catch {
      notifyError('LDAP test request failed');
    }
  };

  const handleStartDiscovery = async () => {
    const payload = {
      subnets: String(discoveryConfig.subnets || '').trim(),
      protocol: 'snmp' as const,
      city: String(discoveryConfig.city || '').trim() || 'Ульяновск',
      branch: String(discoveryConfig.branch || '').trim() || 'ULN',
    };
    try {
      const response = await fetch('/api/discovery/start', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown'
        },
        body: JSON.stringify(payload),
      });
      const data = await readApiPayload(response, 'Discovery scan failed');
      if (!response.ok) {
        logTechnicalError('Discovery scan failed', data, response.status);
        notifyError(friendlyErrorMessage({ t, httpStatus: response.status, detail: data }));
        return;
      }
      const jobId = String(data.jobId || '').trim();
      if (!jobId) {
        logTechnicalError('Discovery scan missing job ID', data);
        notifyError(t('friendlyErrorJobStartNoId'));
        return;
      }
      notifyInfo('Discovery started');
      let attempts = 0;
      const maxAttempts = 180; // ~6 minutes at 2s polling
      const poll = async () => {
        attempts += 1;
        const statusResp = await fetch(`/api/discovery/start/status/${encodeURIComponent(jobId)}`, {
          headers: {
            'x-user-role': role || 'viewer',
            'x-user-name': username || 'unknown'
          }
        });
        const statusData = await readApiPayload(statusResp, 'Discovery status check failed');
        if (!statusResp.ok) {
          throw { status: statusResp.status, detail: statusData };
        }
        if (statusData.status === 'running') {
          if (attempts >= maxAttempts) {
            notifyInfo('Discovery is still running. Check status in a minute.');
            return;
          }
          window.setTimeout(() => {
            poll().catch((e) => {
              const status = (e as { status?: number })?.status;
              const detail = (e as { detail?: unknown })?.detail ?? e;
              logTechnicalError('Discovery status check failed', detail, status);
              notifyError(friendlyErrorMessage({ t, httpStatus: status, detail }));
            });
          }, 2000);
          return;
        }
        if (statusData.status === 'error') {
          logTechnicalError('Discovery scan completed with error', statusData);
          notifyError(friendlyErrorMessage({ t, detail: statusData }));
          return;
        }
        const summary = statusData.summary || {};
        notifySuccess(
          `${t('discoveryScanned')}: ${summary.scanned ?? 0}\nSkipped existing: ${summary.skippedExisting ?? 0}\nSNMP found: ${summary.snmpFound ?? 0}\n${t('discoveryAdded')}: ${summary.added ?? 0}`
        );
      };
      poll().catch((e) => {
        const status = (e as { status?: number })?.status;
        const detail = (e as { detail?: unknown })?.detail ?? e;
        logTechnicalError('Discovery scan polling failed', detail, status);
        notifyError(friendlyErrorMessage({ t, httpStatus: status, detail }));
      });
    } catch (e) {
      logTechnicalError('Discovery scan request failed', e);
      notifyError(friendlyErrorMessage({ t, detail: e }));
    }
  };

  const saveWatchProfiles = async () => {
    try {
      const response = await fetch('/api/discovery/watch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown'
        },
        body: JSON.stringify({ profiles: watchProfiles }),
      });
      const data = await response.json();
      if (!response.ok) {
        notifyError(data.error || 'Failed to save watch profiles');
        return;
      }
      setWatchProfiles(data.profiles || []);
      notifySuccess('Discovery watch profiles saved');
    } catch {
      notifyError('Failed to save watch profiles');
    }
  };

  const runWatchNow = async (profileId?: string) => {
    try {
      const response = await fetch('/api/discovery/watch/run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown'
        },
        body: JSON.stringify(profileId ? { profileIds: [profileId] } : {}),
      });
      const data = await readApiPayload(response, 'Discovery watch run start failed');
      if (!response.ok) {
        logTechnicalError('Discovery watch run start failed', data, response.status);
        notifyError(friendlyErrorMessage({ t, httpStatus: response.status, detail: data }));
        return;
      }
      const jobId = String(data.jobId || '').trim();
      if (!jobId) {
        logTechnicalError('Discovery watch run missing job ID', data);
        notifyError(t('friendlyErrorJobStartNoId'));
        return;
      }
      notifyInfo('Discovery watch run started');

      let attempts = 0;
      const maxAttempts = 180; // ~6 minutes at 2s polling
      const poll = async () => {
        attempts += 1;
        const statusResp = await fetch(`/api/discovery/watch/run/status/${encodeURIComponent(jobId)}`, {
          headers: {
            'x-user-role': role || 'viewer',
            'x-user-name': username || 'unknown'
          }
        });
        const statusData = await readApiPayload(statusResp, 'Discovery watch status check failed');
        if (!statusResp.ok) {
          throw { status: statusResp.status, detail: statusData };
        }

        if (Array.isArray(statusData.profiles)) setWatchProfiles(statusData.profiles);
        try {
          const watchResp = await fetch('/api/discovery/watch/status', {
            headers: {
              'x-user-role': role || 'viewer',
              'x-user-name': username || 'unknown'
            }
          });
          if (watchResp.ok) setWatchStatus(await watchResp.json());
        } catch {
          /* ignore */
        }

        if (statusData.status === 'running') {
          if (attempts >= maxAttempts) {
            notifyInfo('Discovery watch run is still running. Check status again in a minute.');
            return;
          }
          window.setTimeout(() => {
            poll().catch((e) => {
              const status = (e as { status?: number })?.status;
              const detail = (e as { detail?: unknown })?.detail ?? e;
              logTechnicalError('Discovery watch status check failed', detail, status);
              notifyError(friendlyErrorMessage({ t, httpStatus: status, detail }));
            });
          }, 2000);
          return;
        }

        if (statusData.status === 'error') {
          logTechnicalError('Discovery watch run completed with error', statusData, 500);
          notifyError(friendlyErrorMessage({ t, httpStatus: 500, detail: statusData }));
          return;
        }

        notifySuccess(`Profiles run: ${(statusData.runs || []).length}`);
      };

      poll().catch((e) => {
        const status = (e as { status?: number })?.status;
        const detail = (e as { detail?: unknown })?.detail ?? e;
        logTechnicalError('Discovery watch run polling failed', detail, status);
        notifyError(friendlyErrorMessage({ t, httpStatus: status, detail }));
      });
    } catch (e) {
      logTechnicalError('Discovery watch run request failed', e);
      notifyError(friendlyErrorMessage({ t, detail: e }));
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
          port: snmpConfig.port,
        }),
      });
      const data = await response.json();
      if (response.ok) {
        notifySuccess(data.message || 'SNMP config saved');
      } else {
        notifyError(data.message || 'Failed to save SNMP config.');
      }
    } catch (error) {
      notifyError('Failed to save SNMP config.');
    }
  };

  const handleSaveSshReadonly = async () => {
    try {
      const response = await fetch('/api/config/ssh-readonly', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown'
        },
        body: JSON.stringify({
          username: sshReadonlyConfig.username,
          password: sshReadonlyConfig.password,
          port: sshReadonlyConfig.port,
          ttlHours: sshReadonlyConfig.ttlHours,
          allowMetricsFallback: sshReadonlyConfig.allowMetricsFallback,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        notifyError(data.error || 'Failed to save SSH readonly profile');
        return;
      }
      setSshReadonlyConfig((prev) => ({
        ...prev,
        enabled: true,
        hasPassword: true,
        expiresAt: data.expiresAt || '',
        password: '',
      }));
      notifySuccess('SSH readonly profile saved in memory');
    } catch {
      notifyError('Failed to save SSH readonly profile');
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
        notifyError(data.error || 'Template delete failed');
        return;
      }
      setSnmpTemplates(data.templates || []);
    } catch {
      notifyError('Template delete failed');
    }
  };

  const parseList = (src: string) =>
    src
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);

  const handleSaveInventoryMeta = async () => {
    try {
      const models = JSON.parse(inventoryMetaEditor.modelsJson || '{}');
      const response = await fetch('/api/inventory/meta', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown'
        },
        body: JSON.stringify({
          categories: parseList(inventoryMetaEditor.categories),
          subcategories: parseList(inventoryMetaEditor.subcategories),
          branches: parseList(inventoryMetaEditor.branches),
          cities: parseList(inventoryMetaEditor.cities),
          vendors: parseList(inventoryMetaEditor.vendors),
          models
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        notifyError(data.error || 'Inventory dictionaries save failed');
        return;
      }
      notifySuccess('Inventory dictionaries saved');
    } catch {
      notifyError('Inventory dictionaries save failed: check models JSON');
    }
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
      notifyError('Template id/name and at least one metric are required');
      return;
    }

    try {
      const response = await fetch('/api/snmp/templates', {
        method: 'POST',
        credentials: 'include',
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
        notifyError(data.error || 'Template save failed');
        return;
      }
      setSnmpTemplates(data.templates || []);
      notifySuccess('SNMP template saved');
    } catch {
      notifyError('Template save failed');
    }
  };

  const settingsTabs: Array<{ key: SettingsTabKey; label: string }> = [
    { key: 'general', label: t('settingsTabGeneralSystem') },
    { key: 'discovery', label: t('settingsTabDiscoverySnmp') },
    { key: 'ssh', label: t('settingsTabSshProfile') },
    { key: 'ldap', label: t('settingsTabLdap') },
    { key: 'automation', label: t('settingsTabAutomationDefaults') },
    { key: 'adminMeta', label: t('settingsTabAdminMeta') },
  ];

  return (
    <div className="p-4 md:p-8 space-y-8 w-full max-w-[1600px] animate-in slide-in-from-bottom-5 duration-700">
      <header>
        <h2 className="text-2xl font-bold text-white mb-2 leading-tight">{t('sysConfig')}</h2>
        <p className="text-sm text-[#909296]">{t('manageInfra')}</p>
      </header>

      <nav className="border border-[#373a40] rounded bg-[#1c1d21] p-2">
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2">
          {settingsTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                'w-full px-3 py-2 rounded text-[10px] font-bold uppercase tracking-widest border transition-colors',
                activeTab === tab.key
                  ? 'bg-[#228be6] border-[#228be6] text-white'
                  : 'bg-[#25262b] border-[#373a40] text-[#c1c2c5] hover:text-white'
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </nav>

      <div className="space-y-6">
        {/* Language Section */}
        {activeTab === 'general' && (
        <div className={cn("bg-[#25262b] border border-[#373a40] rounded overflow-hidden", !isAdmin && "opacity-50 pointer-events-none")}>
          <div className="p-4 border-b border-[#373a40] bg-[#1c1d21] flex items-center gap-3">
            <Database size={18} className="text-[#228be6]" />
            <h3 className="text-sm font-bold text-white uppercase tracking-widest">{t('sysConfig')}</h3>
          </div>
          <div className="p-4 md:p-6">
            <div className="max-w-xs space-y-2">
            <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('defaultLanguageLabel')}</label>
              <select 
                value={defaultLanguage}
                onChange={(e) => {
                  setDefaultLanguage(e.target.value);
                  saveSystemConfig({ defaultLanguage: e.target.value });
                }}
                className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none appearance-none cursor-pointer"
              >
                <option value="ru">{t('russianLanguage')}</option>
                <option value="en">{t('englishLanguage')}</option>
              </select>
              <p className="text-[9px] text-[#5c5f66] mt-1 font-medium">{t('defaultLanguageHelp')}</p>
            </div>
            <div className="max-w-xl space-y-2 mt-6 min-w-0">
              <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('settingsProductNameLabel')}</label>
              <div className="flex flex-col sm:flex-row gap-3">
                <input
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  className="flex-1 min-w-0 bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none"
                  placeholder="NETNODE"
                />
                <button
                  type="button"
                  onClick={() => saveSystemConfig({ productName: productName.trim() || 'NETNODE' })}
                  className="px-4 py-2 bg-[#228be6] hover:bg-[#1c7ed6] text-white rounded text-[10px] font-bold uppercase tracking-widest transition-all"
                >
                  {t('save')}
                </button>
              </div>
            </div>
            <div className="max-w-xl space-y-2 mt-6 min-w-0">
              <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('settingsThemeLabel')}</label>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => {
                    saveThemeImmediately('dark');
                  }}
                  className={cn(
                    'px-4 py-2 rounded text-[10px] font-bold uppercase tracking-widest border transition-all',
                    theme === 'dark'
                      ? 'bg-[#228be6] border-[#228be6] text-white'
                      : 'bg-[#141517] border-[#373a40] text-[#909296]'
                  )}
                >
                  {t('settingsThemeDark')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    saveThemeImmediately('light');
                  }}
                  className={cn(
                    'px-4 py-2 rounded text-[10px] font-bold uppercase tracking-widest border transition-all',
                    theme === 'light'
                      ? 'bg-[#228be6] border-[#228be6] text-white'
                      : 'bg-[#141517] border-[#373a40] text-[#909296]'
                  )}
                >
                  {t('settingsThemeLight')}
                </button>
              </div>
            </div>
            <div className="max-w-xl space-y-3 mt-6 min-w-0">
              <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('settingsLogoLabel')}</label>
              {logoDraftDataUrl ? (
                <div className="w-16 h-16 rounded border border-[#373a40] bg-[#141517] p-1">
                  <img src={logoDraftDataUrl} alt="App logo" className="w-full h-full object-contain" />
                </div>
              ) : null}
              <input
                type="file"
                accept="image/png"
                onChange={handleLogoUpload}
                className="block text-xs text-[#c1c2c5] file:mr-3 file:px-3 file:py-1.5 file:text-[10px] file:font-bold file:uppercase file:tracking-widest file:border file:border-[#373a40] file:bg-[#25262b] file:text-[#c1c2c5] file:rounded"
                disabled={logoProcessing}
              />
              <p className="text-[9px] text-[#5c5f66]">
                {t('settingsLogoHelp')} ({Math.floor(MAX_LOGO_SIZE_BYTES / 1024 / 1024)}MB max)
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={applyLogoDraft}
                  disabled={!logoDraftDataUrl || logoDraftDataUrl === appliedLogoDataUrl || logoProcessing}
                  className="px-3 py-1.5 bg-[#228be6] hover:bg-[#1c7ed6] text-white rounded text-[10px] font-bold uppercase tracking-widest transition-all disabled:opacity-40 disabled:pointer-events-none"
                >
                  {t('settingsLogoApply')}
                </button>
                {logoDraftDataUrl !== appliedLogoDataUrl ? (
                  <span className="text-[10px] text-[#fab005]">{t('settingsLogoPendingApply')}</span>
                ) : null}
              </div>
              <div className="space-y-1">
                <label className="text-[10px] text-[#909296]">{t('settingsLogoThreshold')}</label>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={220}
                    max={255}
                    value={logoThreshold}
                    onChange={(e) => setLogoThreshold(Number(e.target.value))}
                    className="w-full"
                  />
                  <span className="text-xs text-[#909296]">{logoThreshold}</span>
                </div>
                <button
                  type="button"
                  onClick={applyLogoThreshold}
                  disabled={!logoDraftDataUrl || logoProcessing}
                  className="px-3 py-1.5 bg-[#25262b] border border-[#373a40] text-[#c1c2c5] hover:text-white rounded text-[10px] font-bold uppercase tracking-widest transition-all disabled:opacity-40 disabled:pointer-events-none"
                >
                  {t('settingsLogoApplyThreshold')}
                </button>
              </div>
            </div>
          </div>
        </div>
        )}

        {activeTab === 'ssh' && (
        <div className={cn("bg-[#25262b] border border-[#373a40] rounded overflow-hidden", !isOperator && "opacity-50 pointer-events-none")}>
          <div className="p-4 border-b border-[#373a40] bg-[#1c1d21] flex items-center gap-3">
            <Shield className="text-[#40c057]" size={18} />
            <h3 className="text-sm font-bold text-white uppercase tracking-widest">{t('sshTerminalFallbackTitle')}</h3>
          </div>
          <div className="p-4 md:p-6 space-y-4">
            <p className="text-[10px] text-[#5c5f66]">
              {t('sshTerminalFallbackDesc')}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <input
                className="bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                value={sshReadonlyConfig.username}
                onChange={(e) => setSshReadonlyConfig({ ...sshReadonlyConfig, username: e.target.value })}
                placeholder={t('username')}
              />
              <input
                type="password"
                className="bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                value={sshReadonlyConfig.password}
                onChange={(e) => setSshReadonlyConfig({ ...sshReadonlyConfig, password: e.target.value })}
                placeholder={sshReadonlyConfig.hasPassword ? t('enterNewPasswordToRotate') : t('sshSessionPassword')}
              />
              <input
                type="number"
                min={1}
                max={65535}
                className="bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                value={sshReadonlyConfig.port}
                onChange={(e) => setSshReadonlyConfig({ ...sshReadonlyConfig, port: Number(e.target.value) || 22 })}
                placeholder={t('sshPort')}
              />
              <input
                type="number"
                min={1}
                max={24}
                className="bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                value={sshReadonlyConfig.ttlHours}
                onChange={(e) => setSshReadonlyConfig({ ...sshReadonlyConfig, ttlHours: Math.max(1, Math.min(24, Number(e.target.value) || 3)) })}
                placeholder={t('ttlHours')}
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-[#c1c2c5]">
              <input
                type="checkbox"
                checked={sshReadonlyConfig.allowMetricsFallback}
                onChange={(e) => setSshReadonlyConfig({ ...sshReadonlyConfig, allowMetricsFallback: e.target.checked })}
              />
              {t('allowFallbackMetrics')}
            </label>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-[#909296]">
                {t('status')}: {sshReadonlyConfig.enabled ? `${t('activeUntil')} ${sshReadonlyConfig.expiresAt || '-'}` : t('disabled')}
              </span>
              <button
                type="button"
                onClick={handleSaveSshReadonly}
                className="px-4 py-2 bg-[#40c057] hover:bg-[#37b24d] text-white rounded text-[10px] font-bold uppercase tracking-widest"
              >
                {t('saveTemporaryProfile')}
              </button>
            </div>
          </div>
        </div>
        )}

        {/* LDAP */}
        {activeTab === 'ldap' && (
        <div className={cn("bg-[#25262b] border border-[#373a40] rounded overflow-hidden", !isAdmin && "opacity-50 pointer-events-none")}>
          <div className="p-4 border-b border-[#373a40] bg-[#1c1d21] flex items-center gap-3">
            <Key size={18} className="text-[#40c057]" />
            <div>
              <h3 className="text-sm font-bold text-white uppercase tracking-widest">{t('ldapAuthSection')}</h3>
              <p className="text-[10px] text-[#5c5f66] mt-1 max-w-2xl">{t('ldapAuthSectionDesc')}</p>
            </div>
            {!isAdmin && <span className="text-[10px] bg-red-500/20 text-red-500 px-2 py-0.5 rounded font-bold uppercase tracking-widest ml-auto">{t('adminOnly')}</span>}
          </div>
          <div className="p-4 md:p-6 space-y-10">
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
                  <div className="space-y-2 md:col-span-2 min-w-0">
                    <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('ldapUrl')}</label>
                    <input
                      className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none"
                      value={ldapForm[kind].url}
                      onChange={(e) =>
                        setLdapForm((prev) => ({ ...prev, [kind]: { ...prev[kind], url: e.target.value } }))
                      }
                    />
                  </div>
                  <div className="space-y-2 md:col-span-2 min-w-0">
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
                  <div className="space-y-2 md:col-span-2 min-w-0">
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
        )}

        {/* Auto-Discovery Section */}
        {activeTab === 'discovery' && (
        <div className={cn("bg-[#25262b] border border-[#373a40] rounded overflow-hidden", !isOperator && "opacity-50 pointer-events-none")}>
          <div className="p-4 border-b border-[#373a40] bg-[#1c1d21] flex items-center gap-3">
            <Database className="text-[#228be6]" size={18} />
            <h3 className="text-sm font-bold text-white uppercase tracking-widest">{t('autoDiscovery')}</h3>
            {!isOperator && <span className="text-[10px] bg-red-500/20 text-red-500 px-2 py-0.5 rounded font-bold uppercase tracking-widest ml-auto">{t('privilegedActionRequired')}</span>}
          </div>
          <div className="p-4 md:p-6 space-y-6">
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
            
            <p className="text-[10px] text-[#5c5f66]">{t('discoveryProbeNote')}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('defaultCity')}</label>
                <input
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none transition-colors"
                  value={discoveryConfig.city}
                  onChange={(e) => setDiscoveryConfig({ ...discoveryConfig, city: e.target.value })}
                  placeholder={t('defaultCityPlaceholder')}
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('defaultBranch')}</label>
                <input
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none transition-colors"
                  value={discoveryConfig.branch}
                  onChange={(e) => setDiscoveryConfig({ ...discoveryConfig, branch: e.target.value })}
                  placeholder={t('defaultBranchPlaceholder')}
                />
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('discoveryProtocol')}</label>
              <select
                className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:border-[#228be6] outline-none"
                value={discoveryConfig.protocol}
                onChange={(e) => setDiscoveryConfig({ ...discoveryConfig, protocol: e.target.value as 'snmp' })}
              >
                <option value="snmp">{t('snmpOnly')}</option>
              </select>
            </div>

            <div className="pt-4 border-t border-[#373a40] flex justify-between items-center">
              <p className="text-[10px] text-[#5c5f66] uppercase">{t('discoverySnmpOnlyCredentialsNote')}</p>
              <button 
                onClick={handleStartDiscovery}
                className="px-6 py-2 bg-[#40c057] hover:bg-[#37b24d] text-white rounded text-[10px] font-bold uppercase tracking-widest transition-all shadow-lg"
              >
                {t('startDiscovery')}
              </button>
            </div>

            <div className="pt-4 border-t border-[#373a40] space-y-4">
              <div className="rounded border border-[#373a40] bg-[#141517] p-3 text-[11px] text-[#909296]">
                <div className="text-white font-semibold mb-2">{t('discoveryWatchStatusTitle')}</div>
                <div>{t('discoveryWatchEngine')}: {watchStatus?.schedulerActive ? t('discoveryWatchEngineActive') : t('discoveryWatchEngineInactive')}</div>
                <div>{t('discoveryWatchRunningNow')}: {watchStatus?.currentlyRunning ? t('yes') : t('no')}</div>
                <div>{t('enabledProfiles')}: {watchStatus?.enabledProfiles ?? watchProfiles.filter((p) => p.enabled).length}</div>
                <div>{t('lastSchedulerTick')}: {watchStatus?.lastTickAt || '-'}</div>
                <div>{t('lastProcessedProfiles')}: {watchStatus?.lastProcessedProfiles ?? 0}</div>
                <div className="mt-2 text-[#c1c2c5]">{t('nextRuns')}:</div>
                <div className="max-h-20 overflow-auto">
                  {(watchStatus?.nextRuns || []).slice(0, 5).map((x) => (
                    <div key={x.id}>{x.name}: {x.nextRunAt} ({Math.ceil(x.dueInMs / 60000)} min)</div>
                  ))}
                  {!(watchStatus?.nextRuns || []).length && <div>-</div>}
                </div>
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <p className="text-[10px] text-[#5c5f66] uppercase">{t('savedWatchProfiles')}</p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setWatchProfiles((prev) => [
                        ...prev,
                        {
                          id: `local-${Date.now()}`,
                          name: `Profile ${prev.length + 1}`,
                          subnets: discoveryConfig.subnets,
                          protocol: 'snmp',
                          city: discoveryConfig.city,
                          branch: discoveryConfig.branch,
                          enabled: true,
                          intervalHours: 3,
                          lastRunAt: null,
                          lastResult: null,
                        },
                      ])
                    }
                    className="px-3 py-1.5 bg-[#2c2e33] border border-[#373a40] text-[#c1c2c5] hover:text-white rounded text-[10px] font-bold uppercase"
                  >
                    {t('addProfile')}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setWatchProfiles((prev) => [
                        ...prev,
                        {
                          id: `local-${Date.now()}`,
                          name: `From current settings`,
                          subnets: discoveryConfig.subnets,
                          protocol: 'snmp',
                          city: discoveryConfig.city,
                          branch: discoveryConfig.branch,
                          enabled: true,
                          intervalHours: 3,
                          lastRunAt: null,
                          lastResult: null,
                        },
                      ])
                    }
                    className="px-3 py-1.5 bg-[#25262b] border border-[#228be6]/40 text-[#228be6] hover:bg-[#228be6]/20 rounded text-[10px] font-bold uppercase"
                  >
                    {t('cloneCurrentConfig')}
                  </button>
                  <button
                    type="button"
                    onClick={() => runWatchNow()}
                    className="px-3 py-1.5 bg-[#228be6]/20 border border-[#228be6]/40 text-[#228be6] hover:bg-[#228be6]/30 rounded text-[10px] font-bold uppercase"
                  >
                    {t('runAllNow')}
                  </button>
                  <button
                    type="button"
                    onClick={saveWatchProfiles}
                    className="px-3 py-1.5 bg-[#40c057] hover:bg-[#37b24d] text-white rounded text-[10px] font-bold uppercase"
                  >
                    {t('saveProfiles')}
                  </button>
                </div>
              </div>
              <div className="space-y-3">
                {watchProfiles.map((p, i) => (
                  <div key={p.id} className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center border border-[#373a40] rounded p-3 bg-[#141517]">
                    <input className="sm:col-span-2 bg-[#25262b] border border-[#373a40] p-2 rounded text-xs text-white min-w-0" value={p.name} onChange={(e) => setWatchProfiles((prev) => prev.map((x, idx) => idx === i ? { ...x, name: e.target.value } : x))} />
                    <input className="sm:col-span-4 bg-[#25262b] border border-[#373a40] p-2 rounded text-xs text-white min-w-0" value={p.subnets} onChange={(e) => setWatchProfiles((prev) => prev.map((x, idx) => idx === i ? { ...x, subnets: e.target.value } : x))} />
                    <select className="sm:col-span-1 bg-[#25262b] border border-[#373a40] p-2 rounded text-xs text-white" value="snmp" disabled>
                      <option value="snmp">snmp</option>
                    </select>
                    <input className="sm:col-span-1 bg-[#25262b] border border-[#373a40] p-2 rounded text-xs text-white min-w-0" value={p.city} onChange={(e) => setWatchProfiles((prev) => prev.map((x, idx) => idx === i ? { ...x, city: e.target.value } : x))} />
                    <input className="sm:col-span-1 bg-[#25262b] border border-[#373a40] p-2 rounded text-xs text-white min-w-0" value={p.branch} onChange={(e) => setWatchProfiles((prev) => prev.map((x, idx) => idx === i ? { ...x, branch: e.target.value } : x))} />
                    <input type="number" min={1} className="sm:col-span-1 bg-[#25262b] border border-[#373a40] p-2 rounded text-xs text-white" value={p.intervalHours} onChange={(e) => setWatchProfiles((prev) => prev.map((x, idx) => idx === i ? { ...x, intervalHours: Math.max(1, Number(e.target.value) || 1) } : x))} />
                    <label className="sm:col-span-1 flex items-center sm:justify-center"><input type="checkbox" checked={p.enabled} onChange={(e) => setWatchProfiles((prev) => prev.map((x, idx) => idx === i ? { ...x, enabled: e.target.checked } : x))} /></label>
                    <div className="sm:col-span-1 flex gap-2 sm:justify-end">
                      <button type="button" onClick={() => runWatchNow(p.id)} className="text-[#228be6] text-xs">{t('run')}</button>
                      <button type="button" onClick={() => setWatchProfiles((prev) => prev.filter((_, idx) => idx !== i))} className="text-red-400 text-xs">{t('deleteShort')}</button>
                    </div>
                    <div className="sm:col-span-12 text-[10px] text-[#5c5f66] break-words">
                      {t('lastRun')}: {p.lastRunAt || '-'} | {t('lastResult')}: {p.lastResult?.success === false ? p.lastResult.error : (p.lastResult ? `${t('addedCount')} ${p.lastResult.added}, ${t('scannedCount')} ${p.lastResult.scanned}` : '-')}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
        )}

        {/* Inventory dictionaries */}
        {activeTab === 'adminMeta' && (
        <div className={cn("bg-[#25262b] border border-[#373a40] rounded overflow-hidden", !isAdmin && "opacity-50 pointer-events-none")}>
          <div className="p-4 border-b border-[#373a40] bg-[#1c1d21] flex items-center gap-3">
            <Database className="text-[#228be6]" size={18} />
            <h3 className="text-sm font-bold text-white uppercase tracking-widest">{t('inventoryDictionaries')}</h3>
          </div>
          <div className="p-4 md:p-6 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <input className="bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white" value={inventoryMetaEditor.categories} onChange={(e) => setInventoryMetaEditor({ ...inventoryMetaEditor, categories: e.target.value })} placeholder={t('categoriesCommaSeparated')} />
              <input className="bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white" value={inventoryMetaEditor.subcategories} onChange={(e) => setInventoryMetaEditor({ ...inventoryMetaEditor, subcategories: e.target.value })} placeholder={t('subcategoriesCommaSeparated')} />
              <input className="bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white" value={inventoryMetaEditor.branches} onChange={(e) => setInventoryMetaEditor({ ...inventoryMetaEditor, branches: e.target.value })} placeholder={t('branchesCommaSeparated')} />
              <input className="bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white" value={inventoryMetaEditor.cities} onChange={(e) => setInventoryMetaEditor({ ...inventoryMetaEditor, cities: e.target.value })} placeholder={t('citiesCommaSeparated')} />
              <input className="bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white" value={inventoryMetaEditor.vendors} onChange={(e) => setInventoryMetaEditor({ ...inventoryMetaEditor, vendors: e.target.value })} placeholder={t('vendorsCommaSeparated')} />
              <textarea
                className="md:col-span-2 min-h-[140px] bg-[#141517] border border-[#373a40] p-2.5 rounded text-xs text-white font-mono"
                value={inventoryMetaEditor.modelsJson}
                onChange={(e) => setInventoryMetaEditor({ ...inventoryMetaEditor, modelsJson: e.target.value })}
                placeholder='{"Cisco":["Catalyst 9300"],"HPE":["Aruba 2930F"]}'
              />
            </div>
            <div className="flex justify-end">
              <button onClick={handleSaveInventoryMeta} className="px-6 py-2 bg-[#228be6] hover:bg-[#1c7ed6] text-white rounded text-[10px] font-bold uppercase tracking-widest transition-all shadow-lg">
                {t('saveChanges')}
              </button>
            </div>
          </div>
        </div>
        )}

        {/* SNMP Configuration Section */}
        {activeTab === 'discovery' && (
        <div className={cn("bg-[#25262b] border border-[#373a40] rounded overflow-hidden", !isAdmin && "opacity-50 pointer-events-none")}>
          <div className="p-4 border-b border-[#373a40] bg-[#1c1d21] flex items-center gap-3">
            <Shield className="text-[#fab005]" size={18} />
            <h3 className="text-sm font-bold text-white uppercase tracking-widest">{t('snmpConfig')}</h3>
            {!isAdmin && <span className="text-[10px] bg-red-500/20 text-red-500 px-2 py-0.5 rounded font-bold uppercase tracking-widest ml-auto">{t('adminOnly')}</span>}
          </div>
          <div className="p-4 md:p-6 space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
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
        )}

        {/* SNMP Template Management */}
        {activeTab === 'discovery' && (
        <div className={cn("bg-[#25262b] border border-[#373a40] rounded overflow-hidden", !isAdmin && "opacity-50 pointer-events-none")}>
          <div className="p-4 border-b border-[#373a40] bg-[#1c1d21] flex items-center gap-3">
            <HardDrive className="text-[#228be6]" size={18} />
            <h3 className="text-sm font-bold text-white uppercase tracking-widest">{t('snmpTemplatesTitle')}</h3>
            {!isAdmin && <span className="text-[10px] bg-red-500/20 text-red-500 px-2 py-0.5 rounded font-bold uppercase tracking-widest ml-auto">Admin Only</span>}
          </div>
          <div className="p-4 md:p-6 space-y-6">
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
        )}

        {activeTab === 'automation' && (
        <div className={cn("bg-[#25262b] border border-[#373a40] rounded overflow-hidden", !isAdmin && "opacity-50 pointer-events-none")}>
          <div className="p-4 border-b border-[#373a40] bg-[#1c1d21] flex items-center gap-3">
            <Database size={18} className="text-[#228be6]" />
            <h3 className="text-sm font-bold text-white uppercase tracking-widest">{t('automationDefaultsTitle')}</h3>
          </div>
          <div className="p-4 md:p-6">
            <div className="max-w-3xl space-y-3 min-w-0">
              <p className="text-[10px] text-[#5c5f66]">{t('automationDefaultsHelp')}</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setAutomationDefaults(automationPresets.safe)}
                  className="px-3 py-1.5 text-[10px] uppercase font-bold bg-[#25262b] border border-[#373a40] rounded text-[#c1c2c5] hover:text-white"
                >
                  {t('automationPresetSafe')}
                </button>
                <button
                  type="button"
                  onClick={() => setAutomationDefaults(automationPresets.balanced)}
                  className="px-3 py-1.5 text-[10px] uppercase font-bold bg-[#25262b] border border-[#373a40] rounded text-[#c1c2c5] hover:text-white"
                >
                  {t('automationPresetBalanced')}
                </button>
                <button
                  type="button"
                  onClick={() => setAutomationDefaults(automationPresets.fast)}
                  className="px-3 py-1.5 text-[10px] uppercase font-bold bg-[#25262b] border border-[#373a40] rounded text-[#c1c2c5] hover:text-white"
                >
                  {t('automationPresetFast')}
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="space-y-1">
                  <span className="text-[11px] text-[#c1c2c5]">{t('automationBatchSize')}</span>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={automationDefaults.batchSize}
                    onChange={(e) => setAutomationDefaults({ ...automationDefaults, batchSize: Number(e.target.value) || 1 })}
                    className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                  />
                  <span className="text-[10px] text-[#5c5f66]">{t('automationBatchSizeHelp')}</span>
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] text-[#c1c2c5]">{t('automationTimeoutMs')}</span>
                  <input
                    type="number"
                    min={1000}
                    max={60000}
                    value={automationDefaults.timeoutMs}
                    onChange={(e) => setAutomationDefaults({ ...automationDefaults, timeoutMs: Number(e.target.value) || 1000 })}
                    className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                  />
                  <span className="text-[10px] text-[#5c5f66]">{t('automationTimeoutMsHelp')}</span>
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] text-[#c1c2c5]">{t('automationRetry')}</span>
                  <input
                    type="number"
                    min={0}
                    max={5}
                    value={automationDefaults.retry}
                    onChange={(e) => setAutomationDefaults({ ...automationDefaults, retry: Number(e.target.value) || 0 })}
                    className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                  />
                  <span className="text-[10px] text-[#5c5f66]">{t('automationRetryHelp')}</span>
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] text-[#c1c2c5]">{t('automationConcurrency')}</span>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={automationDefaults.concurrency}
                    onChange={(e) => setAutomationDefaults({ ...automationDefaults, concurrency: Number(e.target.value) || 1 })}
                    className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                  />
                  <span className="text-[10px] text-[#5c5f66]">{t('automationConcurrencyHelp')}</span>
                </label>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end">
                <label className="space-y-1">
                  <span className="text-[11px] text-[#c1c2c5]">{t('automationErrorThreshold')}</span>
                  <input
                    type="number"
                    min={1}
                    max={10000}
                    value={automationDefaults.errorThreshold}
                    onChange={(e) => setAutomationDefaults({ ...automationDefaults, errorThreshold: Number(e.target.value) || 1 })}
                    className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                  />
                  <span className="text-[10px] text-[#5c5f66]">{t('automationErrorThresholdHelp')}</span>
                </label>
                <button
                  type="button"
                  onClick={() => saveSystemConfig({ automationDefaults })}
                  className="px-4 py-2 bg-[#228be6] hover:bg-[#1c7ed6] text-white rounded text-[10px] font-bold uppercase tracking-widest transition-all"
                >
                  {t('saveChanges')}
                </button>
              </div>
            </div>
          </div>
        </div>
        )}

      </div>
    </div>
  );
};

export default Settings;
