import React from 'react';
import { Bot, PlayCircle, CheckCircle2, ListChecks, RefreshCw, Square } from 'lucide-react';
import { useTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';

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
};

type MacSearchResult = {
  deviceId: string;
  deviceName: string;
  ip: string;
  vendor: string;
  mac: string;
  interface?: string;
  ifIndex?: string;
  vlan?: number;
  voiceVlan?: number;
  source: string;
  timestamp: string;
};

interface AutomationProps {
  role?: string;
  username?: string;
}

const Automation: React.FC<AutomationProps> = ({ role, username }) => {
  const { t } = useTranslation();
  const canApply = role === 'admin' || role === 'operator';

  const [scenario, setScenario] = React.useState<Scenario>('create-vlan');
  const [scope, setScope] = React.useState<Scope>('all');
  const [vlanId, setVlanId] = React.useState<number>(100);
  const [vlanName, setVlanName] = React.useState<string>('AUTO_VLAN_100');

  const [inventory, setInventory] = React.useState<InventoryDevice[]>([]);
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
    fetchJobs();
  }, [fetchInventory, fetchJobs]);

  React.useEffect(() => {
    const timer = window.setInterval(fetchJobs, 5000);
    return () => window.clearInterval(timer);
  }, [fetchJobs]);

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
        setErrorText(data?.error || t('automationDryRunFailed'));
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
        setErrorText(data?.error || t('automationApplyFailed'));
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
    try {
      const response = await fetch('/api/automation/mac-search', {
        method: 'POST',
        headers,
        body: JSON.stringify({ mac: macInput.trim() }),
      });
      const data = await response.json();
      if (!response.ok) {
        setErrorText(data?.error || t('automationMacSearchFailed'));
        return;
      }
      setMacResults(Array.isArray(data.results) ? data.results : []);
    } catch {
      setErrorText(t('automationMacSearchFailed'));
    } finally {
      setMacSearching(false);
    }
  };

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

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <section className="xl:col-span-2 space-y-6">
          <div className="bg-[#25262b] border border-[#373a40] rounded overflow-hidden">
            <div className="p-4 border-b border-[#373a40] bg-[#1c1d21] flex items-center gap-3">
              <h3 className="text-sm font-bold text-white uppercase tracking-widest">{t('automationMacSearchTitle')}</h3>
            </div>
            <div className="p-4 md:p-6 space-y-4">
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
                  className="px-4 py-2 bg-[#228be6] hover:bg-[#1c7ed6] text-white rounded text-[10px] font-bold uppercase tracking-widest disabled:opacity-50"
                >
                  {macSearching ? t('loading') : t('automationMacSearchButton')}
                </button>
              </div>
              <div className="max-h-[260px] overflow-auto space-y-2">
                {!macResults.length && <div className="text-xs text-[#909296]">{t('automationMacSearchNoResults')}</div>}
                {macResults.map((result, idx) => (
                  <div key={`${result.deviceId}-${idx}`} className="border border-[#373a40] rounded p-3 bg-[#141517]">
                    <div className="text-xs text-white font-semibold">
                      {result.deviceName} ({result.ip}) - {result.interface || '-'}
                    </div>
                    <div className="text-[11px] text-[#909296] mt-1">
                      MAC {result.mac} | VLAN {result.vlan ?? '-'} | Voice VLAN {result.voiceVlan ?? '-'} | {result.vendor}
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
            <div className="p-4 md:p-6 space-y-6">
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

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                    className="w-full min-h-[140px] bg-[#141517] border border-[#373a40] p-2 rounded text-xs text-white"
                  >
                    {inventory.map((device) => (
                      <option key={device.id} value={device.id}>
                        {device.name} ({device.ip}) {device.vendor ? `- ${device.vendor}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="space-y-4">
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

              <div className="pt-4 border-t border-[#373a40] flex flex-wrap gap-2 items-center">
                <button
                  type="button"
                  onClick={runDryRun}
                  disabled={dryRunLoading || !canApply}
                  className="px-4 py-2 bg-[#228be6] hover:bg-[#1c7ed6] text-white rounded text-[10px] font-bold uppercase tracking-widest disabled:opacity-50 inline-flex items-center gap-2"
                >
                  <PlayCircle size={14} />
                  {dryRunLoading ? t('automationDryRunRunning') : `4. ${t('automationRunDryRun')}`}
                </button>
                <button
                  type="button"
                  onClick={applyPlan}
                  disabled={applyLoading || !canApply || previewSteps.length === 0}
                  className="px-4 py-2 bg-[#40c057] hover:bg-[#37b24d] text-white rounded text-[10px] font-bold uppercase tracking-widest disabled:opacity-50 inline-flex items-center gap-2"
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
            <div className="p-4 max-h-[320px] overflow-auto space-y-2">
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

        <section className="space-y-6">
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
      </div>
    </div>
  );
};

export default Automation;
