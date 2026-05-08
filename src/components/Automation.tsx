import React from 'react';
import { Bot, PlayCircle, CheckCircle2, ListChecks, RefreshCw, Square, Shield, HardDrive } from 'lucide-react';
import { useTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';

const safeErrorText = (value: unknown, fallback = 'Unknown error') =>
  String(value || fallback)
    .replace(/(password|community|secret|token|passphrase)\s*[:=]\s*[^,\s;]+/gi, '$1=<redacted>')
    .replace(/(ssh:\/\/[^:\s]+:)[^@\s]+@/gi, '$1<redacted>@')
    .slice(0, 500);

const apiErrorDetailText = (value: unknown, httpStatus?: number) => {
  if (value && typeof value === 'object') {
    const payload = value as Record<string, unknown>;
    const parts = [
      payload.error || payload.message,
      payload.detail ? `Detail: ${payload.detail}` : '',
      payload.remediation ? `Next step: ${payload.remediation}` : '',
    ]
      .filter(Boolean)
      .map((part) => safeErrorText(part));
    const meta = [
      payload.source ? `server: ${safeErrorText(payload.source)}` : '',
      payload.code ? `code: ${safeErrorText(payload.code)}` : '',
      payload.runId ? `run: ${safeErrorText(payload.runId)}` : '',
      httpStatus ? `http ${httpStatus}` : '',
    ].filter(Boolean);
    if (meta.length) parts.push(`(${meta.join(', ')})`);
    return parts.join(' ') || safeErrorText(undefined);
  }
  return safeErrorText(value);
};

const readApiPayload = async (response: Response, fallback: string) => {
  const raw = await response.text();
  const contentType = response.headers.get('content-type') || '';
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    const looksLikeHtml = /text\/html/i.test(contentType) || /^\s*<!doctype html/i.test(raw) || /^\s*<html/i.test(raw);
    if (looksLikeHtml) {
      if (response.status === 504) {
        return {
          error: 'Gateway timeout from proxy',
          detail: 'The backend task took too long for the reverse proxy timeout.',
          source: 'proxy',
          code: 'gateway_timeout',
        };
      }
      return {
        error: 'Unexpected HTML error response from proxy',
        source: 'proxy',
        code: 'proxy_html_error',
      };
    }
    return { error: safeErrorText(raw, fallback) };
  }
};

const operationFailedMessage = (operation: string, detail?: unknown, httpStatus?: number) =>
  `${operation} failed${detail ? `: ${apiErrorDetailText(detail, httpStatus)}` : ''}`;

type Scope = 'all' | 'selected' | 'filter';
type Scenario = 'create-vlan' | 'allow-vlan-on-trunk';

type AutomationStep = {
  id: string;
  deviceId: string;
  deviceName: string;
  deviceIp: string;
  vendor: string;
  port?: string;
  status: string;
  message: string;
  commandPreview: string[];
};

type AutomationJob = {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  startedAt: string;
  finishedAt?: string;
  actor: string;
  summary: {
    total: number;
    applied: number;
    noop: number;
    errors: number;
    unsupported: number;
    cancelled: number;
  };
  progress: {
    done: number;
    total: number;
  };
  plan: {
    scenario: Scenario;
    vlanId: number;
    vlanName?: string;
  };
};

type AutomationJobDetails = AutomationJob & {
  steps: AutomationStep[];
  error?: string;
};

type InventoryDevice = {
  id: string;
  name: string;
  ip: string;
  vendor?: string;
  branch?: string;
  city?: string;
};

type MacSearchResult = {
  deviceId: string;
  deviceName: string;
  ip: string;
  vendor: string;
  mac: string;
  matchType?: 'exact' | 'suffix';
  interface?: string;
  ifIndex?: string;
  vlan?: number;
  voiceVlan?: number;
  voiceCandidate?: boolean;
  matchedOui?: string;
  expectedVoiceVlan?: number;
  detectedVoiceVlan?: number;
  voiceVlanMatch?: 'match' | 'mismatch' | 'unknown' | 'not_voice_candidate';
  candidateScore?: number;
  candidateRank?: number;
  candidateScoreReasons?: string[];
  source: string;
  timestamp: string;
};

type MacTraceStatus = 'found_access' | 'transit_last_seen' | 'not_found' | 'ambiguous' | 'loop_detected' | 'depth_limit';
type MacTraceHop = {
  device: string;
  ip: string;
  inPort: string;
  outPort?: string;
  portType: 'access' | 'trunk' | 'lag' | 'unknown';
  vlan?: number;
  reason: string;
};
type MacTraceResult = {
  mode: 'trace';
  mac: string;
  maxHops?: number;
  finalStatus: MacTraceStatus;
  hops: MacTraceHop[];
  ambiguityNotes?: string[];
  results?: MacSearchResult[];
  events?: MacSearchEvent[];
};
type MacSearchEvent = {
  stage: 'request' | 'device' | 'trace';
  status: 'info' | 'success' | 'warning' | 'error';
  message: string;
  timestamp: string;
  deviceName?: string;
  ip?: string;
};
type InventoryMeta = {
  branches?: string[];
  cities?: string[];
};

type BackupRun = {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'failed';
  actor: string;
  summary: { total: number; success: number; failed: number };
};

interface AutomationProps {
  role?: string;
  username?: string;
}

type AutomationTabKey = 'execution' | 'macOid' | 'backup';
type ExecutionFlowTabKey = 'scenario' | 'targeting';

const Automation: React.FC<AutomationProps> = ({ role, username }) => {
  const { t } = useTranslation();
  const canApply = role === 'admin' || role === 'operator';
  const isAdmin = role === 'admin';
  const [activeTab, setActiveTab] = React.useState<AutomationTabKey>('execution');
  const [executionFlowTab, setExecutionFlowTab] = React.useState<ExecutionFlowTabKey>('scenario');

  const [scenario, setScenario] = React.useState<Scenario>('create-vlan');
  const [scope, setScope] = React.useState<Scope>('all');
  const [vlanId, setVlanId] = React.useState<number>(100);
  const [vlanName, setVlanName] = React.useState<string>('AUTO_VLAN_100');

  const [inventory, setInventory] = React.useState<InventoryDevice[]>([]);
  const [inventoryMeta, setInventoryMeta] = React.useState<InventoryMeta>({});
  const [selectedDeviceIds, setSelectedDeviceIds] = React.useState<string[]>([]);

  const [vendorFilter, setVendorFilter] = React.useState('');
  const [modelFilter, setModelFilter] = React.useState('');
  const [branchFilter, setBranchFilter] = React.useState('');
  const [categoryFilter, setCategoryFilter] = React.useState('');
  const [subcategoryFilter, setSubcategoryFilter] = React.useState('');

  const [trunkOnly, setTrunkOnly] = React.useState(true);
  const [ifNameRegex, setIfNameRegex] = React.useState('');
  const [operStatusUp, setOperStatusUp] = React.useState(true);
  const [descriptionContains, setDescriptionContains] = React.useState('');

  const [dryRunPlanId, setDryRunPlanId] = React.useState('');
  const [previewSteps, setPreviewSteps] = React.useState<AutomationStep[]>([]);
  const [previewSummary, setPreviewSummary] = React.useState<{ total: number; unsupported: number } | null>(null);
  const [dryRunLoading, setDryRunLoading] = React.useState(false);
  const [applyLoading, setApplyLoading] = React.useState(false);

  const [jobs, setJobs] = React.useState<AutomationJob[]>([]);
  const [activeJobId, setActiveJobId] = React.useState<string>('');
  const [activeJob, setActiveJob] = React.useState<AutomationJobDetails | null>(null);
  const [jobsLoading, setJobsLoading] = React.useState(false);

  const [errorText, setErrorText] = React.useState('');
  const [macInput, setMacInput] = React.useState('');
  const [macSearching, setMacSearching] = React.useState(false);
  const [macResults, setMacResults] = React.useState<MacSearchResult[]>([]);
  const [macTraceResult, setMacTraceResult] = React.useState<MacTraceResult | null>(null);
  const [macEvents, setMacEvents] = React.useState<MacSearchEvent[]>([]);
  const [macMode, setMacMode] = React.useState<'trace' | 'single'>('trace');
  const [macMaxHops, setMacMaxHops] = React.useState<number>(10);
  const [macScope, setMacScope] = React.useState<'all' | 'branch' | 'region' | 'selected'>('all');
  const [macBranchFilter, setMacBranchFilter] = React.useState('');
  const [macRegionPrefix, setMacRegionPrefix] = React.useState('');
  const [macSelectedDeviceIds, setMacSelectedDeviceIds] = React.useState<string[]>([]);
  const [snmpConfig, setSnmpConfig] = React.useState({
    macSearch: {
      dot1dTpFdbPortOid: '1.3.6.1.2.1.17.4.3.1.2',
      dot1dBasePortIfIndexOid: '1.3.6.1.2.1.17.1.4.1.2',
      dot1qTpFdbPortOid: '1.3.6.1.2.1.17.7.1.2.2.1.2',
      voiceVlanMacOid: '1.3.6.1.4.1.9.9.315.1.2.3.1.1',
      voiceOuiPrefixes: '',
    },
  });
  const [voiceOuiList, setVoiceOuiList] = React.useState<string[]>([]);
  const [voiceOuiInput, setVoiceOuiInput] = React.useState('');
  const [voiceCityFilter, setVoiceCityFilter] = React.useState('');
  const [voiceBranchFilter, setVoiceBranchFilter] = React.useState('');
  const [voiceSwitchFilter, setVoiceSwitchFilter] = React.useState('');
  const [voiceVlanPreview, setVoiceVlanPreview] = React.useState<Array<{ ifIndex: string; vlan: number }>>([]);
  const [voiceVlanLoading, setVoiceVlanLoading] = React.useState(false);
  const [backupConfig, setBackupConfig] = React.useState({
    enabled: false,
    intervalHours: 6,
    networkSharePath: '',
    scopeMode: 'all' as 'all' | 'filtered',
    scopeVendors: '',
    scopeBranches: '',
    username: '',
    domain: '',
    password: '',
  });
  const [backupRuns, setBackupRuns] = React.useState<BackupRun[]>([]);

  const headers = React.useMemo(
    () => ({
      'Content-Type': 'application/json',
      'x-user-role': role || 'viewer',
      'x-user-name': username || 'unknown',
    }),
    [role, username]
  );

  const parseCsv = (value: string) =>
    value
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);

  const normalizeOuiPrefix = React.useCallback((value: string) => {
    const hex = String(value || '').toLowerCase().replace(/[^0-9a-f]/g, '');
    if (hex.length < 6 || hex.length > 12 || hex.length % 2 !== 0) return '';
    return hex.match(/.{1,2}/g)?.join(':') || '';
  }, []);

  const availableCities = React.useMemo(() => {
    const items = new Set<string>();
    (inventoryMeta.cities || []).forEach((city) => items.add(String(city)));
    inventory.forEach((device) => {
      const city = String(device.city || '').trim();
      if (city) items.add(city);
    });
    return Array.from(items).sort((a, b) => a.localeCompare(b));
  }, [inventory, inventoryMeta.cities]);

  const availableBranches = React.useMemo(() => {
    const items = new Set<string>();
    inventory
      .filter((device) => !voiceCityFilter || String(device.city || '').trim() === voiceCityFilter)
      .forEach((device) => {
        const branch = String(device.branch || '').trim();
        if (branch) items.add(branch);
      });
    (inventoryMeta.branches || []).forEach((branch) => {
      if (branch) items.add(String(branch));
    });
    return Array.from(items).sort((a, b) => a.localeCompare(b));
  }, [inventory, inventoryMeta.branches, voiceCityFilter]);

  const macBranchOptions = React.useMemo(() => {
    const inventoryBranches = new Set<string>();
    inventory.forEach((device) => {
      const branch = String(device.branch || '').trim();
      if (branch) inventoryBranches.add(branch);
    });
    const merged = new Set<string>(inventoryBranches);
    (inventoryMeta.branches || []).forEach((branch) => {
      const normalized = String(branch || '').trim();
      if (normalized) merged.add(normalized);
    });
    return Array.from(merged).sort((a, b) => a.localeCompare(b));
  }, [inventory, inventoryMeta.branches]);

  const macBranchDeviceCount = React.useMemo(() => {
    const normalizedBranch = macBranchFilter.trim().toLowerCase();
    if (!normalizedBranch) return 0;
    return inventory.filter((d) => String(d.branch || '').trim().toLowerCase() === normalizedBranch).length;
  }, [inventory, macBranchFilter]);

  const availableSwitches = React.useMemo(
    () =>
      inventory
        .filter((device) => (!voiceCityFilter || String(device.city || '').trim() === voiceCityFilter))
        .filter((device) => (!voiceBranchFilter || String(device.branch || '').trim() === voiceBranchFilter))
        .sort((a, b) => `${a.name}|${a.ip}`.localeCompare(`${b.name}|${b.ip}`)),
    [inventory, voiceBranchFilter, voiceCityFilter]
  );

  const buildPlan = React.useCallback(() => {
    const filters = {
      vendor: parseCsv(vendorFilter),
      model: parseCsv(modelFilter),
      branch: parseCsv(branchFilter),
      category: parseCsv(categoryFilter),
      subcategory: parseCsv(subcategoryFilter),
    };
    const hasFilters = Object.values(filters).some((arr) => arr.length > 0);

    return {
      scenario,
      vlanId: Math.max(1, Math.min(4094, Number(vlanId) || 1)),
      vlanName: vlanName.trim() || undefined,
      target: {
        scope,
        selectedDeviceIds: scope === 'selected' ? selectedDeviceIds : undefined,
        filters: scope === 'filter' && hasFilters ? filters : undefined,
        portConditions: {
          trunkOnly,
          ifNameRegex: ifNameRegex.trim() || undefined,
          operStatusUp,
          descriptionContains: descriptionContains.trim() || undefined,
        },
      },
    };
  }, [
    scenario,
    vlanId,
    vlanName,
    scope,
    selectedDeviceIds,
    vendorFilter,
    modelFilter,
    branchFilter,
    categoryFilter,
    subcategoryFilter,
    trunkOnly,
    ifNameRegex,
    operStatusUp,
    descriptionContains,
  ]);

  const fetchInventory = React.useCallback(async () => {
    try {
      const response = await fetch('/api/inventory', { headers });
      if (!response.ok) return;
      const data = await response.json();
      setInventory(Array.isArray(data) ? data : []);
    } catch {
      /* ignore */
    }
  }, [headers]);

  const fetchInventoryMeta = React.useCallback(async () => {
    try {
      const response = await fetch('/api/inventory/meta', { headers });
      if (!response.ok) return;
      const data = await response.json();
      setInventoryMeta(data && typeof data === 'object' ? data : {});
    } catch {
      /* ignore */
    }
  }, [headers]);

  const fetchJobs = React.useCallback(async () => {
    setJobsLoading(true);
    try {
      const response = await fetch('/api/automation/jobs', { headers });
      const data = await response.json();
      if (!response.ok) {
        setErrorText(data?.error || t('automationLoadJobsFailed'));
        return;
      }
      setJobs(Array.isArray(data.jobs) ? data.jobs : []);
    } catch {
      setErrorText(t('automationLoadJobsFailed'));
    } finally {
      setJobsLoading(false);
    }
  }, [headers, t]);

  const fetchJobDetails = React.useCallback(
    async (jobId: string) => {
      if (!jobId) return;
      try {
        const response = await fetch(`/api/automation/jobs/${encodeURIComponent(jobId)}`, { headers });
        const data = await response.json();
        if (!response.ok) {
          setErrorText(data?.error || t('automationLoadJobDetailsFailed'));
          return;
        }
        setActiveJob(data.job || null);
      } catch {
        setErrorText(t('automationLoadJobDetailsFailed'));
      }
    },
    [headers, t]
  );

  React.useEffect(() => {
    fetchInventory();
    fetchInventoryMeta();
    fetchJobs();
  }, [fetchInventory, fetchInventoryMeta, fetchJobs]);

  React.useEffect(() => {
    const timer = window.setInterval(fetchJobs, 5000);
    return () => window.clearInterval(timer);
  }, [fetchJobs]);

  React.useEffect(() => {
    if (voiceCityFilter && !availableCities.includes(voiceCityFilter)) {
      setVoiceCityFilter('');
    }
  }, [availableCities, voiceCityFilter]);

  React.useEffect(() => {
    if (voiceBranchFilter && !availableBranches.includes(voiceBranchFilter)) {
      setVoiceBranchFilter('');
    }
  }, [availableBranches, voiceBranchFilter]);

  React.useEffect(() => {
    if (macScope !== 'branch') return;
    if (macBranchFilter && !macBranchOptions.includes(macBranchFilter)) {
      setMacBranchFilter('');
    }
  }, [macBranchFilter, macBranchOptions, macScope]);

  React.useEffect(() => {
    if (voiceSwitchFilter && !availableSwitches.some((device) => device.id === voiceSwitchFilter)) {
      setVoiceSwitchFilter('');
      setVoiceVlanPreview([]);
    }
  }, [availableSwitches, voiceSwitchFilter]);

  React.useEffect(() => {
    if (!activeJobId) return;
    fetchJobDetails(activeJobId);
    const timer = window.setInterval(() => fetchJobDetails(activeJobId), 3000);
    return () => window.clearInterval(timer);
  }, [activeJobId, fetchJobDetails]);

  const runDryRun = async () => {
    setErrorText('');
    setDryRunLoading(true);
    try {
      const response = await fetch('/api/automation/plans/dry-run', {
        method: 'POST',
        headers,
        body: JSON.stringify(buildPlan()),
      });
      const data = await response.json();
      if (!response.ok) {
        setErrorText(operationFailedMessage('Automation dry-run', data || t('automationDryRunFailed'), response.status));
        return;
      }
      setDryRunPlanId(data.planId || '');
      setPreviewSteps(Array.isArray(data.steps) ? data.steps : []);
      setPreviewSummary(data.summary || null);
    } catch {
      setErrorText(t('automationDryRunFailed'));
    } finally {
      setDryRunLoading(false);
    }
  };

  const applyPlan = async () => {
    setErrorText('');
    setApplyLoading(true);
    try {
      const response = await fetch('/api/automation/plans/apply', {
        method: 'POST',
        headers,
        body: JSON.stringify(dryRunPlanId ? { planId: dryRunPlanId } : { plan: buildPlan() }),
      });
      const data = await response.json();
      if (!response.ok) {
        setErrorText(operationFailedMessage('Automation apply', data || t('automationApplyFailed'), response.status));
        return;
      }
      const jobId = String(data.jobId || '');
      if (jobId) {
        setActiveJobId(jobId);
        fetchJobs();
      }
    } catch {
      setErrorText(t('automationApplyFailed'));
    } finally {
      setApplyLoading(false);
    }
  };

  const cancelJob = async (jobId: string) => {
    try {
      await fetch(`/api/automation/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: 'POST',
        headers,
      });
      fetchJobs();
      if (activeJobId === jobId) fetchJobDetails(jobId);
    } catch {
      setErrorText(t('automationCancelFailed'));
    }
  };

  const selectedJob = jobs.find((j) => j.id === activeJobId);

  const runMacSearch = async () => {
    setErrorText('');
    setMacSearching(true);
    setMacEvents([]);
    try {
      const normalizedBranch = macBranchFilter.trim().toLowerCase();
      const deviceIds =
        macScope === 'selected'
          ? macSelectedDeviceIds
          : macScope === 'branch' && normalizedBranch
            ? inventory
                .filter((d) => String(d.branch || '').trim().toLowerCase() === normalizedBranch)
                .map((d) => d.id)
            : undefined;
      const response = await fetch('/api/automation/mac-search', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          mac: macInput.trim(),
          deviceIds,
          branch:
            macScope === 'branch'
              ? macBranchFilter.trim() || undefined
              : macScope === 'region'
                ? macRegionPrefix.trim() || undefined
                : undefined,
          mode: macMode,
          maxHops: Math.max(1, Math.min(50, Number(macMaxHops) || 10)),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setErrorText(data?.error || t('automationMacSearchFailed'));
        return;
      }
      if (macMode === 'trace') {
        setMacTraceResult({
          mode: 'trace',
          mac: String(data?.mac || ''),
          maxHops: Number(data?.maxHops || 0) || undefined,
          finalStatus: data?.finalStatus || 'not_found',
          hops: Array.isArray(data?.hops) ? data.hops : [],
          ambiguityNotes: Array.isArray(data?.ambiguityNotes) ? data.ambiguityNotes : [],
          results: Array.isArray(data?.results) ? data.results : [],
          events: Array.isArray(data?.events) ? data.events : [],
        });
        setMacResults(Array.isArray(data?.results) ? data.results : []);
      } else {
        setMacTraceResult(null);
        setMacResults(Array.isArray(data.results) ? data.results : []);
      }
      setMacEvents(Array.isArray(data?.events) ? data.events : []);
    } catch {
      setErrorText(t('automationMacSearchFailed'));
    } finally {
      setMacSearching(false);
    }
  };

  const traceStatusLabel: Record<MacTraceStatus, string> = {
    found_access: t('automationTraceStatusFoundAccess'),
    transit_last_seen: t('automationTraceStatusTransitLastSeen'),
    not_found: t('automationTraceStatusNotFound'),
    ambiguous: t('automationTraceStatusAmbiguous'),
    loop_detected: t('automationTraceStatusLoopDetected'),
    depth_limit: t('automationTraceStatusDepthLimit'),
  };

  const voiceVlanStatusText = (result: MacSearchResult) => {
    if (!result.voiceCandidate) return t('automationVoiceNotCandidate');
    const expected = result.expectedVoiceVlan ?? result.voiceVlan;
    const detected = result.detectedVoiceVlan ?? result.vlan;
    if (result.voiceVlanMatch === 'match') return t('automationVoiceVlanMatch');
    if (result.voiceVlanMatch === 'mismatch') {
      return `${t('automationVoiceVlanMismatch')}: ${t('automationVoiceExpected')} ${expected ?? '-'} / ${t('automationVoiceDetected')} ${detected ?? '-'}`;
    }
    return `${t('automationVoiceVlanUnknown')}: ${t('automationVoiceExpected')} ${expected ?? '-'} / ${t('automationVoiceDetected')} ${detected ?? '-'}`;
  };

  React.useEffect(() => {
    const loadEnterpriseConfig = async () => {
      try {
        const snmpResp = await fetch('/api/config/snmp', { headers });
        if (snmpResp.ok) {
          const snmpData = await snmpResp.json();
          if (snmpData.snmp) {
            const loadedOuiList = Array.isArray(snmpData.snmp.macSearch?.voiceOuiPrefixes)
              ? snmpData.snmp.macSearch.voiceOuiPrefixes.map((prefix: unknown) => normalizeOuiPrefix(String(prefix))).filter(Boolean)
              : String(snmpData.snmp.macSearch?.voiceOuiPrefixes || '')
                  .split(/[\s,;]+/)
                  .map((prefix) => normalizeOuiPrefix(prefix))
                  .filter(Boolean);
            setSnmpConfig({
              macSearch: {
                dot1dTpFdbPortOid: snmpData.snmp.macSearch?.dot1dTpFdbPortOid || '1.3.6.1.2.1.17.4.3.1.2',
                dot1dBasePortIfIndexOid: snmpData.snmp.macSearch?.dot1dBasePortIfIndexOid || '1.3.6.1.2.1.17.1.4.1.2',
                dot1qTpFdbPortOid: snmpData.snmp.macSearch?.dot1qTpFdbPortOid || '1.3.6.1.2.1.17.7.1.2.2.1.2',
                voiceVlanMacOid: snmpData.snmp.macSearch?.voiceVlanMacOid || '1.3.6.1.4.1.9.9.315.1.2.3.1.1',
                voiceOuiPrefixes: loadedOuiList.join('\n'),
              },
            });
            setVoiceOuiList(loadedOuiList);
          }
        }
        const [backupConfigResp, backupHistoryResp] = await Promise.all([
          fetch('/api/backup/config', { headers }),
          fetch('/api/backup/history', { headers }),
        ]);
        if (backupConfigResp.ok) {
          const backupData = await backupConfigResp.json();
          const cfg = backupData.config || {};
          setBackupConfig({
            enabled: cfg.enabled === true,
            intervalHours: Number(cfg.intervalHours || 6),
            networkSharePath: cfg.networkSharePath || '',
            scopeMode: cfg.scope?.mode === 'filtered' ? 'filtered' : 'all',
            scopeVendors: Array.isArray(cfg.scope?.vendors) ? cfg.scope.vendors.join(', ') : '',
            scopeBranches: Array.isArray(cfg.scope?.branches) ? cfg.scope.branches.join(', ') : '',
            username: cfg.credentials?.username || '',
            domain: cfg.credentials?.domain || '',
            password: '',
          });
        }
        if (backupHistoryResp.ok) {
          const runsData = await backupHistoryResp.json();
          setBackupRuns(Array.isArray(runsData.runs) ? runsData.runs : []);
        }
      } catch {
        /* ignore */
      }
    };
    loadEnterpriseConfig();
  }, [headers, normalizeOuiPrefix]);

  const handleSaveMacOidConfig = async () => {
    try {
      const currentSnmpResp = await fetch('/api/config/snmp', { headers });
      const currentData = currentSnmpResp.ok ? await currentSnmpResp.json() : {};
      const currentSnmp = currentData.snmp || {};
      const response = await fetch('/api/config/snmp', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...currentSnmp,
          macSearch: {
            ...snmpConfig.macSearch,
            voiceOuiPrefixes: voiceOuiList,
          },
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        alert(data?.error || 'Failed to save SNMP config.');
        return;
      }
      alert(data?.message || 'SNMP config saved.');
    } catch {
      alert('Failed to save SNMP config.');
    }
  };

  const handleAddVoiceOuiPrefix = () => {
    const normalized = normalizeOuiPrefix(voiceOuiInput);
    if (!normalized) {
      setErrorText(t('automationOuiInvalid'));
      return;
    }
    if (voiceOuiList.includes(normalized)) {
      setErrorText(t('automationOuiDuplicate'));
      return;
    }
    setErrorText('');
    const next = [...voiceOuiList, normalized];
    setVoiceOuiList(next);
    setSnmpConfig((prev) => ({ ...prev, macSearch: { ...prev.macSearch, voiceOuiPrefixes: next.join('\n') } }));
    setVoiceOuiInput('');
  };

  const handleRemoveVoiceOuiPrefix = (prefix: string) => {
    const next = voiceOuiList.filter((item) => item !== prefix);
    setVoiceOuiList(next);
    setSnmpConfig((prev) => ({
      ...prev,
      macSearch: { ...prev.macSearch, voiceOuiPrefixes: next.join('\n') },
    }));
  };

  const loadVoiceVlanPreview = async () => {
    if (!voiceSwitchFilter) {
      setVoiceVlanPreview([]);
      return;
    }
    setVoiceVlanLoading(true);
    try {
      const response = await fetch(`/api/automation/voice-vlan/${encodeURIComponent(voiceSwitchFilter)}`, { headers });
      const data = await response.json();
      if (!response.ok) {
        setErrorText(data?.error || t('automationVoiceVlanPreviewFailed'));
        return;
      }
      const map = data?.voiceVlanMap && typeof data.voiceVlanMap === 'object' ? data.voiceVlanMap : {};
      const rows = Object.entries(map)
        .map(([ifIndex, vlan]) => ({ ifIndex, vlan: Number(vlan) }))
        .filter((row) => Number.isFinite(row.vlan))
        .sort((a, b) => Number(a.ifIndex) - Number(b.ifIndex));
      setVoiceVlanPreview(rows);
    } catch {
      setErrorText(t('automationVoiceVlanPreviewFailed'));
    } finally {
      setVoiceVlanLoading(false);
    }
  };

  const saveBackupConfig = async () => {
    try {
      const response = await fetch('/api/backup/config', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          enabled: backupConfig.enabled,
          intervalHours: backupConfig.intervalHours,
          networkSharePath: backupConfig.networkSharePath,
          scope: {
            mode: backupConfig.scopeMode,
            vendors: backupConfig.scopeVendors.split(',').map((v) => v.trim()).filter(Boolean),
            branches: backupConfig.scopeBranches.split(',').map((v) => v.trim()).filter(Boolean),
          },
          credentials: {
            username: backupConfig.username,
            domain: backupConfig.domain,
            password: backupConfig.password || undefined,
          },
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        alert(data.error || 'Backup config save failed');
        return;
      }
      alert('Backup config saved');
      setBackupConfig((prev) => ({ ...prev, password: '' }));
    } catch {
      alert('Backup config save failed');
    }
  };

  const runBackupNow = async () => {
    try {
      const response = await fetch('/api/backup/run', {
        method: 'POST',
        headers,
      });
      const data = await readApiPayload(response, 'Backup run now failed');
      if (!response.ok || data?.success === false) {
        alert(operationFailedMessage('Backup run now', data, response.status));
        return;
      }
      const historyResp = await fetch('/api/backup/history', { headers });
      if (historyResp.ok) {
        const historyData = await historyResp.json();
        setBackupRuns(Array.isArray(historyData.runs) ? historyData.runs : []);
      }
      alert('Backup run completed');
    } catch (e) {
      alert(operationFailedMessage('Backup run now request', e instanceof Error ? e.message : e));
    }
  };

  const automationTabs: Array<{ key: AutomationTabKey; label: string }> = [
    { key: 'execution', label: t('automationTabExecution') },
    { key: 'macOid', label: t('automationTabMacOidConfig') },
    { key: 'backup', label: t('automationTabBackup') },
  ];
  const tabDescriptions: Record<AutomationTabKey, string> = {
    execution: t('automationTabExecutionHint'),
    macOid: t('automationTabMacOidHint'),
    backup: t('automationTabBackupHint'),
  };
  const macScopeHintKey =
    macScope === 'all'
      ? 'automationScopeHintAll'
      : macScope === 'branch'
        ? 'automationScopeHintBranch'
        : macScope === 'region'
          ? 'automationScopeHintRegion'
        : 'automationScopeHintSelected';
  const actionButtonBase =
    'px-4 py-2 rounded text-[10px] font-bold uppercase tracking-widest transition-colors disabled:opacity-50';
  const executionFlowTabs: Array<{ key: ExecutionFlowTabKey; label: string; hint: string }> = [
    { key: 'scenario', label: t('automationScenario'), hint: t('automationScenarioTabHint') },
    { key: 'targeting', label: t('automationTargetingTab'), hint: t('automationTargetingTabHint') },
  ];

  return (
    <div className="p-4 md:p-8 animate-in slide-in-from-bottom-5 duration-700 space-y-6">
      <header>
        <h2 className="text-2xl font-bold text-white mb-2 leading-tight">{t('automationTitle')}</h2>
        <p className="text-sm text-[#909296]">{t('automationSubtitle')}</p>
      </header>

      {errorText && (
        <div className="bg-red-500/10 border border-red-500/40 text-red-300 rounded p-3 text-xs">
          {errorText}
        </div>
      )}

      <nav className="border border-[#373a40] rounded bg-[#1c1d21] p-2">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {automationTabs.map((tab) => (
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
        <p className="mt-2 px-1 text-[11px] text-[#909296]">{tabDescriptions[activeTab]}</p>
      </nav>

      {activeTab === 'execution' && <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 md:gap-6">
        <section className="xl:col-span-7 space-y-6">
          <div className="bg-[#25262b] border border-[#373a40] rounded overflow-hidden">
            <div className="p-4 border-b border-[#373a40] bg-[#1c1d21] flex items-center gap-3">
              <h3 className="text-sm font-bold text-white uppercase tracking-widest">{t('automationMacSearchTitle')}</h3>
            </div>
            <div className="p-4 md:p-6 space-y-4">
              <div className="space-y-2">
                <p className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('automationMacModeLabel')}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {(['trace', 'single'] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => {
                        setMacMode(value);
                        if (value === 'single') setMacTraceResult(null);
                      }}
                      className={cn(
                        'px-3 py-2 rounded text-xs font-bold border text-left',
                        macMode === value
                          ? 'bg-[#228be6] border-[#228be6] text-white'
                          : 'bg-[#141517] border-[#373a40] text-[#909296] hover:text-white'
                      )}
                    >
                      <div>{value === 'trace' ? t('automationMacModeTraceTitle') : t('automationMacModeSingleTitle')}</div>
                      <div className="text-[10px] font-medium normal-case tracking-normal opacity-80 mt-0.5">
                        {value === 'trace' ? t('automationMacModeTraceHint') : t('automationMacModeSingleHint')}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
              {macMode === 'trace' && (
                <div className="space-y-2">
                  <p className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('automationMacMaxHops')}</p>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={macMaxHops}
                    onChange={(e) => setMacMaxHops(Math.max(1, Math.min(50, Number(e.target.value) || 10)))}
                    className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                  />
                </div>
              )}
              <div className="space-y-2">
                <p className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('automationTargetScope')}</p>
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                  {(['all', 'branch', 'region', 'selected'] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setMacScope(value)}
                      className={cn(
                        'px-3 py-2 rounded text-xs font-bold uppercase tracking-wider border',
                        macScope === value
                          ? 'bg-[#228be6] border-[#228be6] text-white'
                          : 'bg-[#141517] border-[#373a40] text-[#909296] hover:text-white'
                      )}
                    >
                      {value === 'all'
                        ? t('automationScopeAll')
                        : value === 'branch'
                          ? t('automationBranchFilter')
                          : value === 'region'
                            ? t('automationRegionPrefixLabel')
                            : t('automationSelectDevices')}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-[#5c5f66]">{t(macScopeHintKey)}</p>
              </div>
              {macScope === 'branch' && (
                <div className="space-y-2">
                  <select
                    value={macBranchFilter}
                    onChange={(e) => setMacBranchFilter(e.target.value)}
                    className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                  >
                    <option value="">{t('automationBranchSelectPlaceholder')}</option>
                    {macBranchOptions.map((branch) => (
                      <option key={branch} value={branch}>
                        {branch}
                      </option>
                    ))}
                  </select>
                  {macBranchFilter && macBranchDeviceCount === 0 && (
                    <p className="text-[11px] text-[#fab005]">{t('automationMacBranchNoDevicesHint')}</p>
                  )}
                </div>
              )}
              {macScope === 'branch' && macBranchOptions.length === 0 && (
                <p className="text-[11px] text-[#909296]">{t('automationMacBranchOptionsEmpty')}</p>
              )}
              {macScope === 'region' && (
                <select
                  value={macRegionPrefix}
                  onChange={(e) => setMacRegionPrefix(e.target.value)}
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                >
                  <option value="">{t('automationRegionPrefixPlaceholder')}</option>
                  {availableBranches.map((branch) => (
                    <option key={branch} value={branch}>
                      {branch}
                    </option>
                  ))}
                </select>
              )}
              {macScope === 'selected' && (
                <select
                  multiple
                  value={macSelectedDeviceIds}
                  onChange={(e) =>
                    setMacSelectedDeviceIds(Array.from(e.target.selectedOptions).map((opt) => opt.value))
                  }
                  className="w-full min-h-[120px] bg-[#141517] border border-[#373a40] p-2 rounded text-xs text-white"
                >
                  {inventory.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.name} ({device.ip}) {device.branch ? `- ${device.branch}` : ''} {device.vendor ? `- ${device.vendor}` : ''}
                    </option>
                  ))}
                </select>
              )}
              <div className="flex flex-col md:flex-row gap-3">
                <input
                  value={macInput}
                  onChange={(e) => setMacInput(e.target.value)}
                  className="flex-1 bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                  placeholder={t('automationMacSearchPlaceholder')}
                />
                <button
                  type="button"
                  disabled={macSearching || !macInput.trim()}
                  onClick={runMacSearch}
                  className={cn(actionButtonBase, 'bg-[#228be6] hover:bg-[#1c7ed6] text-white')}
                >
                  {macSearching ? t('loading') : t('automationMacSearchButton')}
                </button>
              </div>
              <div className="rounded border border-[#373a40] bg-[#141517] p-3 text-[10px] text-[#909296] space-y-1">
                <p>{t('automationMacSearchHelp')}</p>
                <p>{t('automationMacSuffixHint')}</p>
              </div>
              <div className="border border-[#373a40] rounded p-3 bg-[#141517] space-y-2">
                <div className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('automationMacEventsTitle')}</div>
                {!macEvents.length && <div className="text-xs text-[#909296]">{t('automationMacEventsEmpty')}</div>}
                {!!macEvents.length && (
                  <div className="max-h-[170px] overflow-auto space-y-1.5">
                    {macEvents.map((event, idx) => (
                      <div key={`${event.timestamp}-${idx}`} className="text-[11px] text-[#c1c2c5]">
                        <span
                          className={cn(
                            'mr-2 inline-block w-2 h-2 rounded-full',
                            event.status === 'success'
                              ? 'bg-[#40c057]'
                              : event.status === 'warning'
                                ? 'bg-[#fab005]'
                                : event.status === 'error'
                                  ? 'bg-red-500'
                                  : 'bg-[#868e96]'
                          )}
                        />
                        {event.message}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {macMode === 'trace' && macTraceResult && (
                <div className="border border-[#373a40] rounded p-3 bg-[#141517] space-y-2">
                  <div className="text-xs text-white font-semibold">
                    {t('automationTraceStatusLabel')}: {traceStatusLabel[macTraceResult.finalStatus] || macTraceResult.finalStatus}
                  </div>
                  <div className="text-[11px] text-[#909296]">
                    MAC {macTraceResult.mac} | Hops {macTraceResult.hops.length}/{macTraceResult.maxHops ?? '-'}
                  </div>
                  {!!macTraceResult.ambiguityNotes?.length && (
                    <div className="text-[11px] text-[#fab005] space-y-1">
                      {macTraceResult.ambiguityNotes.map((note, idx) => (
                        <div key={`note-${idx}`}>- {note}</div>
                      ))}
                    </div>
                  )}
                  <div className="space-y-2">
                    {!macTraceResult.hops.length && <div className="text-xs text-[#909296]">{t('automationMacSearchNoResults')}</div>}
                    {macTraceResult.hops.map((hop, idx) => (
                      <div key={`${hop.device}-${idx}`} className="border border-[#373a40] rounded p-2 bg-black/20">
                        <div className="text-xs text-white">
                          {idx + 1}. {hop.device} ({hop.ip}) | {hop.inPort} [{hop.portType}]
                        </div>
                        <div className="text-[11px] text-[#909296] mt-1">
                          Out: {hop.outPort || '-'} | VLAN {hop.vlan ?? '-'}
                        </div>
                        <div className="text-[11px] text-[#c1c2c5] mt-1">{hop.reason}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="max-h-[260px] overflow-auto space-y-2">
                {!macResults.length && (macMode === 'single' || macTraceResult) && <div className="text-xs text-[#909296]">{t('automationMacSearchNoResults')}</div>}
                {macResults.length > 0 && (
                  <div className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">
                    {t('automationMacSearchTitle')}
                  </div>
                )}
                {macResults.length > 0 &&
                  macResults.map((result, idx) => (
                    <div key={`${result.deviceId}-${idx}`} className="border border-[#373a40] rounded p-3 bg-[#141517]">
                      <div className="text-xs text-white font-semibold">
                        {result.deviceName} ({result.ip}) - {result.interface || '-'}
                      </div>
                      <div className="text-[11px] text-[#909296] mt-1">
                        MAC {result.mac} | VLAN {result.vlan ?? '-'} | Voice VLAN {result.voiceVlan ?? '-'} | {result.vendor}
                      </div>
                      {result.candidateScore !== undefined && (
                        <div className="text-[11px] text-[#c1c2c5] mt-1">
                          Rank {result.candidateRank ?? '-'} | Score {result.candidateScore} | {(result.candidateScoreReasons || []).join(', ') || 'no edge evidence'}
                        </div>
                      )}
                      <div className={cn('text-[11px] mt-1', result.voiceCandidate ? 'text-[#fab005]' : 'text-[#5c5f66]')}>
                        {t('automationVoiceCandidate')}: {result.voiceCandidate ? t('yes') : t('no')}
                        {result.matchedOui ? ` | ${t('automationMatchedOui')} ${result.matchedOui}` : ''}
                        {` | ${voiceVlanStatusText(result)}`}
                      </div>
                      <div className="text-[10px] text-[#5c5f66] mt-1">{result.timestamp}</div>
                    </div>
                  ))}
              </div>
            </div>
          </div>

          <div className="bg-[#25262b] border border-[#373a40] rounded overflow-hidden">
            <div className="p-4 border-b border-[#373a40] bg-[#1c1d21] flex items-center gap-3">
              <Bot className="text-[#228be6]" size={18} />
              <h3 className="text-sm font-bold text-white uppercase tracking-widest">{t('automationWizard')}</h3>
            </div>
            <div className="p-4 md:p-6 space-y-4">
              <div className="space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {executionFlowTabs.map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      onClick={() => setExecutionFlowTab(tab.key)}
                      className={cn(
                        'px-3 py-2 rounded text-xs font-bold uppercase tracking-wider border text-left',
                        executionFlowTab === tab.key
                          ? 'bg-[#228be6] border-[#228be6] text-white'
                          : 'bg-[#141517] border-[#373a40] text-[#909296] hover:text-white'
                      )}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-[#5c5f66]">
                  {executionFlowTabs.find((tab) => tab.key === executionFlowTab)?.hint}
                </p>
              </div>

              {executionFlowTab === 'scenario' && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <p className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">1. {t('automationScenario')}</p>
                    <select
                      value={scenario}
                      onChange={(e) => setScenario(e.target.value as Scenario)}
                      className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                    >
                      <option value="create-vlan">{t('automationScenarioCreateVlan')}</option>
                      <option value="allow-vlan-on-trunk">{t('automationScenarioAllowOnTrunk')}</option>
                    </select>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <p className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('automationVlanId')}</p>
                      <input
                        type="number"
                        min={1}
                        max={4094}
                        value={vlanId}
                        onChange={(e) => setVlanId(Number(e.target.value) || 1)}
                        className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                      />
                    </div>
                    <div className="space-y-2">
                      <p className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('automationVlanName')}</p>
                      <input
                        value={vlanName}
                        onChange={(e) => setVlanName(e.target.value)}
                        className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                        placeholder="AUTO_VLAN_100"
                      />
                    </div>
                  </div>
                </div>
              )}

              {executionFlowTab === 'targeting' && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <p className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">2. {t('automationTargetScope')}</p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      {(['all', 'selected', 'filter'] as Scope[]).map((value) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setScope(value)}
                          className={cn(
                            'px-3 py-2 rounded text-xs font-bold uppercase tracking-wider border',
                            scope === value
                              ? 'bg-[#228be6] border-[#228be6] text-white'
                              : 'bg-[#141517] border-[#373a40] text-[#909296] hover:text-white'
                          )}
                        >
                          {value === 'all' ? t('automationScopeAll') : value === 'selected' ? t('automationScopeSelected') : t('automationScopeFilter')}
                        </button>
                      ))}
                    </div>
                  </div>

                  {scope === 'selected' && (
                    <div className="space-y-2">
                      <p className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('automationSelectDevices')}</p>
                      <select
                        multiple
                        value={selectedDeviceIds}
                        onChange={(e) =>
                          setSelectedDeviceIds(Array.from(e.target.selectedOptions).map((opt) => opt.value))
                        }
                        className="w-full h-32 bg-[#141517] border border-[#373a40] p-2 rounded text-xs text-white"
                      >
                        {inventory.map((device) => (
                          <option key={device.id} value={device.id}>
                            {device.name} ({device.ip}) {device.vendor ? `- ${device.vendor}` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div className="space-y-3">
                    <p className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">3. {t('automationFiltersAndPorts')}</p>
                    {scope === 'filter' && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <input className="bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white" value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)} placeholder={t('automationVendorFilter')} />
                        <input className="bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white" value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} placeholder={t('automationModelFilter')} />
                        <input className="bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white" value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)} placeholder={t('automationBranchFilter')} />
                        <input className="bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} placeholder={t('automationCategoryFilter')} />
                        <input className="md:col-span-2 bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white" value={subcategoryFilter} onChange={(e) => setSubcategoryFilter(e.target.value)} placeholder={t('automationSubcategoryFilter')} />
                      </div>
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <input className="bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white" value={ifNameRegex} onChange={(e) => setIfNameRegex(e.target.value)} placeholder={t('automationIfNameRegex')} />
                      <input className="bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white" value={descriptionContains} onChange={(e) => setDescriptionContains(e.target.value)} placeholder={t('automationDescriptionContains')} />
                    </div>
                    <div className="flex flex-wrap gap-4">
                      <label className="flex items-center gap-2 text-xs text-[#c1c2c5]">
                        <input type="checkbox" checked={trunkOnly} onChange={(e) => setTrunkOnly(e.target.checked)} />
                        {t('automationTrunkOnly')}
                      </label>
                      <label className="flex items-center gap-2 text-xs text-[#c1c2c5]">
                        <input type="checkbox" checked={operStatusUp} onChange={(e) => setOperStatusUp(e.target.checked)} />
                        {t('automationOperStatusUp')}
                      </label>
                    </div>
                  </div>
                </div>
              )}

              <div className="pt-4 border-t border-[#373a40] flex flex-wrap gap-2 items-center">
                <button
                  type="button"
                  onClick={runDryRun}
                  disabled={dryRunLoading || !canApply}
                  className={cn(actionButtonBase, 'bg-[#228be6] hover:bg-[#1c7ed6] text-white inline-flex items-center gap-2')}
                >
                  <PlayCircle size={14} />
                  {dryRunLoading ? t('automationDryRunRunning') : `4. ${t('automationRunDryRun')}`}
                </button>
                <button
                  type="button"
                  onClick={applyPlan}
                  disabled={applyLoading || !canApply || previewSteps.length === 0}
                  className={cn(actionButtonBase, 'bg-[#40c057] hover:bg-[#37b24d] text-white inline-flex items-center gap-2')}
                >
                  <CheckCircle2 size={14} />
                  {applyLoading ? t('automationApplying') : `5. ${t('automationApproveApply')}`}
                </button>
              </div>
            </div>
          </div>

          <div className="bg-[#25262b] border border-[#373a40] rounded overflow-hidden">
            <div className="p-4 border-b border-[#373a40] bg-[#1c1d21] flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <ListChecks className="text-[#fab005]" size={18} />
                <h3 className="text-sm font-bold text-white uppercase tracking-widest">{t('automationPreview')}</h3>
              </div>
              {previewSummary && (
                <span className="text-[10px] text-[#909296] uppercase">
                  {t('automationSummary')}: {previewSummary.total} / {t('automationUnsupported')}: {previewSummary.unsupported}
                </span>
              )}
            </div>
            <div className="p-4 max-h-[260px] md:max-h-[320px] overflow-auto space-y-2">
              {!previewSteps.length && <div className="text-xs text-[#909296]">{t('automationNoPreview')}</div>}
              {previewSteps.map((step) => (
                <div key={step.id} className="border border-[#373a40] rounded p-3 bg-[#141517]">
                  <div className="text-xs text-white font-medium">
                    {step.deviceName} ({step.deviceIp}) {step.port ? `- ${step.port}` : ''}
                  </div>
                  <div className="text-[11px] text-[#909296] mt-1">{step.vendor} - {step.status} - {step.message}</div>
                  {!!step.commandPreview?.length && (
                    <pre className="mt-2 text-[10px] text-[#c1c2c5] bg-black/20 p-2 rounded overflow-auto">{step.commandPreview.join('\n')}</pre>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="xl:col-span-5 space-y-6">
          <div className="bg-[#25262b] border border-[#373a40] rounded overflow-hidden">
            <div className="p-4 border-b border-[#373a40] bg-[#1c1d21] flex items-center justify-between">
              <h3 className="text-sm font-bold text-white uppercase tracking-widest">{t('automationJobs')}</h3>
              <button
                type="button"
                onClick={fetchJobs}
                className="text-[#228be6] hover:text-white"
                title={t('refresh')}
              >
                <RefreshCw size={16} />
              </button>
            </div>
            <div className="p-3 max-h-[280px] overflow-auto space-y-2">
              {jobsLoading && <div className="text-xs text-[#909296]">{t('loadingLogs')}</div>}
              {!jobs.length && !jobsLoading && <div className="text-xs text-[#909296]">{t('automationNoJobs')}</div>}
              {jobs.map((job) => (
                <button
                  key={job.id}
                  type="button"
                  onClick={() => setActiveJobId(job.id)}
                  className={cn(
                    'w-full text-left border rounded p-3 transition-colors',
                    activeJobId === job.id
                      ? 'border-[#228be6] bg-[#228be6]/10'
                      : 'border-[#373a40] bg-[#141517] hover:border-[#5c5f66]'
                  )}
                >
                  <div className="text-xs text-white font-semibold">{job.id}</div>
                  <div className="text-[11px] text-[#909296] mt-1">
                    {job.plan.scenario} | VLAN {job.plan.vlanId}
                  </div>
                  <div className="text-[11px] text-[#909296] mt-1">
                    {job.status} | {job.progress.done}/{job.progress.total}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="bg-[#25262b] border border-[#373a40] rounded overflow-hidden">
            <div className="p-4 border-b border-[#373a40] bg-[#1c1d21] flex items-center justify-between">
              <h3 className="text-sm font-bold text-white uppercase tracking-widest">{t('automationJobDetails')}</h3>
              {selectedJob?.status === 'running' && canApply && (
                <button
                  type="button"
                  onClick={() => cancelJob(selectedJob.id)}
                  className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider bg-red-500/20 border border-red-500/40 rounded text-red-300 inline-flex items-center gap-1"
                >
                  <Square size={12} />
                  {t('automationCancelJob')}
                </button>
              )}
            </div>
            <div className="p-4 max-h-[420px] overflow-auto space-y-3">
              {!activeJob && <div className="text-xs text-[#909296]">{t('automationSelectJobHint')}</div>}
              {activeJob && (
                <>
                  <div className="text-xs text-[#909296]">
                    {t('status')}: <span className="text-white">{activeJob.status}</span> | {t('action')}: <span className="text-white">{activeJob.plan.scenario}</span>
                  </div>
                  <div className="text-xs text-[#909296]">
                    {t('automationProgress')}: <span className="text-white">{activeJob.progress.done}/{activeJob.progress.total}</span>
                  </div>
                  <div className="text-xs text-[#909296]">
                    {t('automationResultApplied')}: {activeJob.summary.applied} | {t('automationResultNoop')}: {activeJob.summary.noop} | {t('automationResultErrors')}: {activeJob.summary.errors}
                  </div>
                  {!!activeJob.error && <div className="text-xs text-red-300">{activeJob.error}</div>}
                  <div className="space-y-2 border-t border-[#373a40] pt-3">
                    {activeJob.steps.slice(0, 80).map((step) => (
                      <div key={step.id} className="border border-[#373a40] rounded p-2 bg-[#141517]">
                        <div className="text-xs text-white">
                          {step.deviceName} ({step.deviceIp}) {step.port ? `- ${step.port}` : ''}
                        </div>
                        <div className="text-[11px] text-[#909296]">{step.status} - {step.message}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </section>
      </div>}

      {activeTab === 'macOid' && (
        <div className={cn('bg-[#25262b] border border-[#373a40] rounded overflow-hidden', !isAdmin && 'opacity-50 pointer-events-none')}>
          <div className="p-4 border-b border-[#373a40] bg-[#1c1d21] flex items-center gap-3">
            <Shield className="text-[#fab005]" size={18} />
            <h3 className="text-sm font-bold text-white uppercase tracking-widest">{t('automationTabMacOidConfig')}</h3>
            {!isAdmin && <span className="text-[10px] bg-red-500/20 text-red-500 px-2 py-0.5 rounded font-bold uppercase tracking-widest ml-auto">{t('adminOnly')}</span>}
          </div>
          <div className="p-4 md:p-6 space-y-4">
            <p className="text-[11px] text-[#909296]">{t('automationOidConfigHelp')}</p>
            <div className="space-y-2">
              <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('settingsMacFdbPortOid')}</label>
              <input
                className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                value={snmpConfig.macSearch.dot1dTpFdbPortOid}
                onChange={(e) => setSnmpConfig({ ...snmpConfig, macSearch: { ...snmpConfig.macSearch, dot1dTpFdbPortOid: e.target.value } })}
              />
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('settingsBasePortIfIndexOid')}</label>
              <input
                className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                value={snmpConfig.macSearch.dot1dBasePortIfIndexOid}
                onChange={(e) => setSnmpConfig({ ...snmpConfig, macSearch: { ...snmpConfig.macSearch, dot1dBasePortIfIndexOid: e.target.value } })}
              />
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('settingsQBridgePortOid')}</label>
              <input
                className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                value={snmpConfig.macSearch.dot1qTpFdbPortOid}
                onChange={(e) => setSnmpConfig({ ...snmpConfig, macSearch: { ...snmpConfig.macSearch, dot1qTpFdbPortOid: e.target.value } })}
              />
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('settingsVoiceVlanMacOid')}</label>
              <input
                className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                value={snmpConfig.macSearch.voiceVlanMacOid}
                onChange={(e) => setSnmpConfig({ ...snmpConfig, macSearch: { ...snmpConfig.macSearch, voiceVlanMacOid: e.target.value } })}
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <select
                className="bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                value={voiceCityFilter}
                onChange={(e) => {
                  setVoiceCityFilter(e.target.value);
                  setVoiceSwitchFilter('');
                  setVoiceVlanPreview([]);
                }}
              >
                <option value="">{t('automationVoiceSelectCity')}</option>
                {availableCities.map((city) => (
                  <option key={city} value={city}>
                    {city}
                  </option>
                ))}
              </select>
              <select
                className="bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                value={voiceBranchFilter}
                onChange={(e) => {
                  setVoiceBranchFilter(e.target.value);
                  setVoiceSwitchFilter('');
                  setVoiceVlanPreview([]);
                }}
              >
                <option value="">{t('automationVoiceSelectBranch')}</option>
                {availableBranches.map((branch) => (
                  <option key={branch} value={branch}>
                    {branch}
                  </option>
                ))}
              </select>
              <select
                className="bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                value={voiceSwitchFilter}
                onChange={(e) => {
                  setVoiceSwitchFilter(e.target.value);
                  setVoiceVlanPreview([]);
                }}
              >
                <option value="">{t('automationVoiceSelectSwitch')}</option>
                {availableSwitches.map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.name} ({device.ip})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              <button
                type="button"
                onClick={loadVoiceVlanPreview}
                disabled={voiceVlanLoading || !voiceSwitchFilter}
                className={cn(actionButtonBase, 'bg-[#228be6] hover:bg-[#1c7ed6] text-white')}
              >
                {voiceVlanLoading ? t('loading') : t('automationVoiceLoadPreview')}
              </button>
              <span className="text-[10px] text-[#909296]">
                {t('automationVoiceSwitchCount')}: {availableSwitches.length}
              </span>
            </div>
            {!!voiceVlanPreview.length && (
              <div className="border border-[#373a40] rounded p-3 bg-[#141517] max-h-[180px] overflow-auto space-y-1">
                {voiceVlanPreview.map((row) => (
                  <div key={row.ifIndex} className="text-[11px] text-[#c1c2c5]">
                    ifIndex {row.ifIndex} - VLAN {row.vlan}
                  </div>
                ))}
              </div>
            )}
            <div className="space-y-2">
              <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('settingsVoiceOuiPrefixes')}</label>
              <div className="flex gap-2">
                <input
                  className="flex-1 bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                  value={voiceOuiInput}
                  onChange={(e) => setVoiceOuiInput(e.target.value)}
                  placeholder={t('automationOuiAddPlaceholder')}
                />
                <button
                  type="button"
                  onClick={handleAddVoiceOuiPrefix}
                  className={cn(actionButtonBase, 'bg-[#40c057] hover:bg-[#37b24d] text-white')}
                >
                  {t('automationOuiAdd')}
                </button>
              </div>
              <div className="max-h-[160px] overflow-auto space-y-1">
                {!voiceOuiList.length && <div className="text-xs text-[#909296]">{t('automationOuiListEmpty')}</div>}
                {voiceOuiList.map((prefix) => (
                  <div key={prefix} className="flex items-center justify-between border border-[#373a40] rounded px-2 py-1.5 bg-[#141517] text-xs text-white">
                    <span>{prefix}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveVoiceOuiPrefix(prefix)}
                      className="text-red-300 hover:text-red-200 text-[10px] uppercase tracking-wider"
                    >
                      {t('deleteShort')}
                    </button>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-[#5c5f66]">{t('settingsVoiceOuiPrefixesHelp')}</p>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleSaveMacOidConfig}
                className={cn(actionButtonBase, 'px-6 bg-[#fab005] hover:bg-[#f08c00] text-black shadow-lg')}
              >
                {t('saveChanges')}
              </button>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'backup' && (
        <div className={cn('bg-[#25262b] border border-[#373a40] rounded overflow-hidden', !isAdmin && 'opacity-50 pointer-events-none')}>
          <div className="p-4 border-b border-[#373a40] bg-[#1c1d21] flex items-center gap-3">
            <HardDrive className="text-[#228be6]" size={18} />
            <h3 className="text-sm font-bold text-white uppercase tracking-widest">{t('settingsBackupScheduleTitle')}</h3>
            {!isAdmin && <span className="text-[10px] bg-red-500/20 text-red-500 px-2 py-0.5 rounded font-bold uppercase tracking-widest ml-auto">{t('adminOnly')}</span>}
          </div>
          <div className="p-4 md:p-6 space-y-4">
            <p className="text-[11px] text-[#909296]">{t('automationBackupHelp')}</p>
            <label className="flex items-center gap-2 text-xs text-[#c1c2c5]">
              <input
                type="checkbox"
                checked={backupConfig.enabled}
                onChange={(e) => setBackupConfig({ ...backupConfig, enabled: e.target.checked })}
              />
              {t('settingsBackupEnabled')}
            </label>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <input
                type="number"
                min={1}
                max={168}
                className="bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                value={backupConfig.intervalHours}
                onChange={(e) => setBackupConfig({ ...backupConfig, intervalHours: Math.max(1, Number(e.target.value) || 1) })}
                placeholder={t('settingsBackupIntervalHours')}
              />
              <select
                className="bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                value={backupConfig.scopeMode}
                onChange={(e) => setBackupConfig({ ...backupConfig, scopeMode: e.target.value as 'all' | 'filtered' })}
              >
                <option value="all">{t('settingsBackupScopeAll')}</option>
                <option value="filtered">{t('settingsBackupScopeFiltered')}</option>
              </select>
              <input
                className="md:col-span-2 bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                value={backupConfig.networkSharePath}
                onChange={(e) => setBackupConfig({ ...backupConfig, networkSharePath: e.target.value })}
                placeholder={t('settingsBackupSharePath')}
              />
              <input
                className="bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                value={backupConfig.scopeVendors}
                onChange={(e) => setBackupConfig({ ...backupConfig, scopeVendors: e.target.value })}
                placeholder={t('settingsBackupScopeVendors')}
              />
              <input
                className="bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                value={backupConfig.scopeBranches}
                onChange={(e) => setBackupConfig({ ...backupConfig, scopeBranches: e.target.value })}
                placeholder={t('settingsBackupScopeBranches')}
              />
              <input
                className="bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                value={backupConfig.username}
                onChange={(e) => setBackupConfig({ ...backupConfig, username: e.target.value })}
                placeholder={t('username')}
              />
              <input
                className="bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                value={backupConfig.domain}
                onChange={(e) => setBackupConfig({ ...backupConfig, domain: e.target.value })}
                placeholder={t('settingsBackupDomain')}
              />
              <input
                type="password"
                className="md:col-span-2 bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white"
                value={backupConfig.password}
                onChange={(e) => setBackupConfig({ ...backupConfig, password: e.target.value })}
                placeholder={t('settingsBackupPassword')}
              />
            </div>
            <p className="text-[10px] text-[#5c5f66]">{t('settingsBackupShareHint')}</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={saveBackupConfig}
                className={cn(actionButtonBase, 'bg-[#228be6] hover:bg-[#1c7ed6] text-white')}
              >
                {t('saveChanges')}
              </button>
              <button
                type="button"
                onClick={runBackupNow}
                className={cn(actionButtonBase, 'bg-[#40c057] hover:bg-[#37b24d] text-white')}
              >
                {t('settingsBackupRunNow')}
              </button>
            </div>
            <div className="space-y-2 max-h-[280px] overflow-auto border-t border-[#373a40] pt-3">
              {!backupRuns.length && <div className="text-xs text-[#909296]">{t('settingsBackupNoHistory')}</div>}
              {backupRuns.map((run) => (
                <div key={run.id} className="border border-[#373a40] rounded p-2 bg-[#141517] text-xs text-[#c1c2c5]">
                  <div className="text-white">{run.id}</div>
                  <div>{run.status} | {run.summary.success}/{run.summary.total}</div>
                  <div className="text-[#909296]">{run.startedAt}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Automation;
