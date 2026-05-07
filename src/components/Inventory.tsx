import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Plus, Search, MoreVertical, Edit2, Trash2, Cpu, Download, ChevronUp, ChevronDown, RefreshCw, Terminal as TerminalIcon, Globe } from 'lucide-react';

const SortIcon = ({ active, direction }: { active: boolean, direction?: 'asc' | 'desc' }) => {
  if (!active) return <div className="w-3" />;
  return direction === 'asc' ? <ChevronUp size={12} className="text-[#228be6]" /> : <ChevronDown size={12} className="text-[#228be6]" />;
};
import { Switch, Vendor } from '../types';
import { VENDORS } from '../constants';
import { cn } from '../lib/utils';
import { useTranslation } from '../lib/i18n';

const parseIpv4 = (ip: string): number | null => {
  const parts = ip.split('.').map((x) => Number.parseInt(x, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
};

const parseUptimeSeconds = (uptime: string): number => {
  const m = uptime.match(/(\d+)d\s+(\d+)h\s+(\d+)m/i);
  if (!m) return 0;
  return (Number(m[1]) * 86400) + (Number(m[2]) * 3600) + (Number(m[3]) * 60);
};

interface InventoryProps {
  switches: Switch[];
  setSwitches: React.Dispatch<React.SetStateAction<Switch[]>>;
  role?: string;
  username?: string;
  onOpenSSH?: (sw: Switch) => void;
}

const Inventory: React.FC<InventoryProps> = ({ switches, setSwitches, role, username, onOpenSSH }) => {
  const { t } = useTranslation();
  const isAdmin = role === 'admin';
  const isOperator = role === 'operator' || isAdmin;
  
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [subcategoryFilter, setSubcategoryFilter] = useState<string>('all');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isBulkProcessing, setIsBulkProcessing] = useState(false);
  const [sortConfig, setSortConfig] = useState<{ key: keyof Switch | 'vendorModel'; direction: 'asc' | 'desc' } | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newSwitch, setNewSwitch] = useState<Partial<Switch>>({
    vendor: 'HPE',
    status: 'online',
    uptime: '0d 0h',
    category: 'Switch',
    subcategory: 'Core',
    branch: 'ULN'
  });
  const [meta, setMeta] = useState<{
    categories: string[];
    subcategories: string[];
    branches: string[];
    cities: string[];
    zones: string[];
    vendors: string[];
    models: Record<string, string[]>;
  }>({
    categories: ['Switch', 'Router', 'FC Switch', 'UPS'],
    subcategories: ['Core'],
    branches: ['ULN', 'NCH', 'VRN', 'VLG', 'VLD', 'SMR', 'KRD'],
    cities: ['Ульяновск', 'Набережные Челны', 'Краснодар', 'Воронеж', 'Волгоград', 'Владимир', 'Самара'],
    zones: ['Core', 'Distribution', 'Access'],
    vendors: ['Cisco', 'Juniper', 'HPE', 'Aruba'],
    models: { HPE: ['Aruba 2930F', 'HP SN3600B'] }
  });
  const [snmpTemplates, setSnmpTemplates] = useState<Array<{ id: string; name: string }>>([]);
  const [customOidsText, setCustomOidsText] = useState('');
  const [activeBranchTab, setActiveBranchTab] = useState<string>('all');
  const [activeCategoryTab, setActiveCategoryTab] = useState<'switch' | 'router' | 'fc' | 'ups' | 'all'>('switch');
  const [openRowMenuId, setOpenRowMenuId] = useState<string | null>(null);
  const rowMenuRef = React.useRef<HTMLDivElement | null>(null);
  const makeDefaultSwitch = React.useCallback(
    (): Partial<Switch> => ({
      vendor: 'HPE',
      model: (meta.models.HPE || ['Aruba 2930F'])[0] || 'Aruba 2930F',
      status: 'online',
      uptime: '0d 0h',
      category: meta.categories[0] || 'Switch',
      subcategory: meta.subcategories[0] || 'Core',
      branch: meta.branches[0] || 'ULN',
      city: meta.cities[0] || 'Ульяновск',
      zone: meta.zones[0] || 'Core'
    }),
    [meta]
  );

  const localizeCategory = (value?: string) => {
    const v = (value || '').toLowerCase();
    if (v === 'switch') return 'Коммутатор';
    if (v === 'router') return 'Маршрутизатор';
    if (v === 'fc switch' || v === 'fibre channel switch' || v === 'fiber channel switch') return 'FC коммутатор';
    if (v === 'ups') return 'ИБП';
    if (v === 'firewall') return 'Межсетевой экран';
    if (v === 'other') return 'Прочее';
    return value || 'Коммутатор';
  };

  const branches = React.useMemo(
    () =>
      Array.from(
        new Set(
          switches
            .map((s) => String(s.branch || '').trim())
            .filter(Boolean)
        )
      ).sort((a, b) => a.localeCompare(b)),
    [switches]
  );

  const categoryKey = (category?: string): 'switch' | 'router' | 'fc' | 'ups' | 'other' => {
    const v = (category || '').toLowerCase();
    if (v === 'switch' || v === 'коммутатор') return 'switch';
    if (v === 'router' || v === 'маршрутизатор') return 'router';
    if (v === 'fc switch' || v === 'fibre channel switch' || v === 'fiber channel switch' || v === 'fc коммутатор') return 'fc';
    if (v === 'ups' || v === 'ибп') return 'ups';
    return 'other';
  };

  React.useEffect(() => {
    fetch('/api/inventory/meta', {
      headers: {
        'x-user-role': role || 'viewer',
        'x-user-name': username || 'unknown'
      }
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.categories && data.branches && data.models) {
          setMeta(data);
        }
      })
      .catch(() => {});
    fetch('/api/snmp/templates', {
      headers: {
        'x-user-role': role || 'viewer',
        'x-user-name': username || 'unknown'
      }
    })
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data.templates)) {
          setSnmpTemplates(data.templates.map((t: any) => ({ id: t.id, name: t.name })));
        }
      })
      .catch(() => {});
  }, [role, username]);

  React.useEffect(() => {
    const onDocClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rowMenuRef.current && !rowMenuRef.current.contains(target)) {
        setOpenRowMenuId(null);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const handleAdd = async () => {
    if (!newSwitch.name || !newSwitch.ip || !newSwitch.city) return;
    
    try {
      const payload = {
        ...makeDefaultSwitch(),
        ...newSwitch,
        name: (newSwitch.name || '').trim(),
        ip: (newSwitch.ip || '').trim(),
        model: (newSwitch.model || '').trim() || 'Unknown',
        city: (newSwitch.city || '').trim(),
        zone: (newSwitch.zone || '').trim() || String(newSwitch.subcategory || '').trim() || (meta.zones[0] || 'Core'),
        status: newSwitch.status || 'online',
        uptime: newSwitch.uptime || '0d 0h',
        customOids: customOidsText
          .split('\n')
          .map((v) => v.trim())
          .filter(Boolean)
      };
      if (editingId) {
        const response = await fetch(`/api/inventory/${editingId}`, {
          method: 'PATCH',
          headers: { 
            'Content-Type': 'application/json',
            'x-user-role': role || 'viewer',
            'x-user-name': username || 'unknown'
          },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          const errData = await response.json().catch(() => null);
          throw new Error(errData?.error || 'Update failed');
        }
      } else {
        const response = await fetch('/api/inventory', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-user-role': role || 'viewer',
            'x-user-name': username || 'unknown'
          },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          const errData = await response.json().catch(() => null);
          throw new Error(errData?.error || 'Creation failed');
        }
      }
      
      // Refresh inventory in parent
      // In a real app we'd trigger a parent refresh, here we'll assume App.tsx poller catches it 
      // or we just close the modal. For better UX, let's just close and wait for poll.
      setIsAdding(false);
      setEditingId(null);
      setNewSwitch(makeDefaultSwitch());
      setCustomOidsText('');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error saving device configuration';
      alert(message);
    }
  };

  const handleDelete = async (id: string) => {
    if (confirm('Are you sure you want to remove this node from inventory?')) {
      try {
        await fetch(`/api/inventory/${id}`, {
          method: 'DELETE',
          headers: { 
            'x-user-role': role || 'viewer',
            'x-user-name': username || 'unknown'
          }
        });
      } catch (error) {
        alert('Error deleting device');
      }
    }
  };

  const handleEdit = (sw: Switch) => {
    setNewSwitch(sw);
    setCustomOidsText((sw.customOids || []).join('\n'));
    setEditingId(sw.id);
    setIsAdding(true);
  };

  const handleExport = () => {
    const headers = ['Name', 'Vendor', 'Model', 'Category', 'Branch', 'IP', 'City', 'Status', 'Uptime'];
    const rows = switches.map(s => [s.name, s.vendor, s.model, s.category || 'Switch', s.branch || 'ULN', s.ip, s.city, s.status, s.uptime]);
    const csvContent = [headers, ...rows].map(e => e.join(",")).join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `switching_inventory_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  };

  const handleSort = (key: keyof Switch | 'vendorModel') => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const handleBulkAction = async (action: string, value?: string) => {
    if (selectedIds.length === 0) return;
    setIsBulkProcessing(true);
    try {
      const response = await fetch('/api/inventory/bulk', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown'
        },
        body: JSON.stringify({ ids: selectedIds, action, value }),
      });
      if (response.ok) {
        setSelectedIds([]);
      }
    } catch (error) {
      alert('Bulk action failed');
    } finally {
      setIsBulkProcessing(false);
    }
  };

  const toggleSelectAll = () => {
    if (selectedIds.length === filteredSwitches.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(filteredSwitches.map(s => s.id));
    }
  };

  const toggleSelectOne = (id: string) => {
    setSelectedIds(prev => 
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  const filteredSwitches = switches
    .filter(s => {
      const matchesSearch = 
        s.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        s.city.toLowerCase().includes(searchTerm.toLowerCase()) ||
        s.vendor.toLowerCase().includes(searchTerm.toLowerCase()) ||
        s.model.toLowerCase().includes(searchTerm.toLowerCase()) ||
        s.ip.includes(searchTerm);
      
      const matchesStatus = statusFilter === 'all' || s.status === statusFilter;
      const matchesSubcategory = subcategoryFilter === 'all' || (s.subcategory || '') === subcategoryFilter;
      const matchesBranchTab = activeBranchTab === 'all' || (s.branch || '') === activeBranchTab;
      const catKey = categoryKey(s.category);
      const matchesCategoryTab =
        activeCategoryTab === 'all'
          ? catKey !== 'other'
          : activeCategoryTab === catKey;

      return matchesSearch && matchesStatus && matchesSubcategory && matchesBranchTab && matchesCategoryTab;
    })
    .sort((a, b) => {
      if (!sortConfig) return 0;

      let aValue: any;
      let bValue: any;

      if (sortConfig.key === 'vendorModel') {
        aValue = `${a.vendor} ${a.model}`.toLowerCase();
        bValue = `${b.vendor} ${b.model}`.toLowerCase();
      } else if (sortConfig.key === 'ip') {
        aValue = parseIpv4(a.ip) ?? Number.MAX_SAFE_INTEGER;
        bValue = parseIpv4(b.ip) ?? Number.MAX_SAFE_INTEGER;
      } else if (sortConfig.key === 'uptime') {
        aValue = parseUptimeSeconds(a.uptime || '');
        bValue = parseUptimeSeconds(b.uptime || '');
      } else {
        aValue = String(a[sortConfig.key as keyof Switch] ?? '').toLowerCase();
        bValue = String(b[sortConfig.key as keyof Switch] ?? '').toLowerCase();
      }

      if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1;
      if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });

  return (
    <div className="p-4 md:p-8 space-y-6">
      <header className="flex flex-col sm:flex-row sm:justify-between sm:items-end gap-3">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold text-white mb-2 leading-tight">{t('switchInventory')}</h2>
          <p className="text-sm text-[#909296]">{t('manageNodes')}</p>
        </div>
        <div className="flex flex-wrap gap-2 sm:gap-3">
          <button 
            onClick={handleExport}
            className="flex items-center gap-2 px-4 py-2 border border-[#373a40] text-[#c1c2c5] hover:text-white rounded text-sm font-bold transition-all"
          >
            <Download size={18} />
            {t('exportCsv')}
          </button>
          {isAdmin && (
            <button 
              onClick={() => {
                setEditingId(null);
                setNewSwitch(makeDefaultSwitch());
                setCustomOidsText('');
                setIsAdding(true);
              }}
              className="flex items-center gap-2 px-4 py-2 bg-[#228be6] hover:bg-[#1c7ed6] text-white rounded text-sm font-bold transition-all shadow-lg"
            >
              <Plus size={18} />
              {t('registerSwitch')}
            </button>
          )}
        </div>
      </header>

      {/* Region tabs */}
      <div className="flex flex-wrap gap-2 mb-3">
        <button
          type="button"
          onClick={() => setActiveBranchTab('all')}
          className={cn(
            "px-3 py-1 rounded text-[10px] font-bold uppercase border",
            activeBranchTab === 'all'
              ? "bg-[#228be6] border-[#228be6] text-white"
              : "bg-[#2c2e33] border-[#373a40] text-[#c1c2c5]"
          )}
        >
          {t('allBranches')}
        </button>
        {branches.map((b) => (
          <button
            key={b}
            type="button"
            onClick={() => setActiveBranchTab(b)}
            className={cn(
              "px-3 py-1 rounded text-[10px] font-bold uppercase border",
              activeBranchTab === b
                ? "bg-[#228be6] border-[#228be6] text-white"
                : "bg-[#2c2e33] border-[#373a40] text-[#c1c2c5]"
            )}
          >
            {b}
          </button>
        ))}
      </div>

      {/* Category tabs */}
      <div className="flex flex-wrap gap-2 mb-4">
        <button
          type="button"
          onClick={() => setActiveCategoryTab('switch')}
          className={cn(
            "px-3 py-1 rounded text-[10px] font-bold uppercase border",
            activeCategoryTab === 'switch'
              ? "bg-[#228be6] border-[#228be6] text-white"
              : "bg-[#2c2e33] border-[#373a40] text-[#c1c2c5]"
          )}
        >
          {t('inventoryTabSwitches')}
        </button>
        <button
          type="button"
          onClick={() => setActiveCategoryTab('router')}
          className={cn(
            "px-3 py-1 rounded text-[10px] font-bold uppercase border",
            activeCategoryTab === 'router'
              ? "bg-[#228be6] border-[#228be6] text-white"
              : "bg-[#2c2e33] border-[#373a40] text-[#c1c2c5]"
          )}
        >
          {t('inventoryTabRouters')}
        </button>
        <button
          type="button"
          onClick={() => setActiveCategoryTab('fc')}
          className={cn(
            "px-3 py-1 rounded text-[10px] font-bold uppercase border",
            activeCategoryTab === 'fc'
              ? "bg-[#228be6] border-[#228be6] text-white"
              : "bg-[#2c2e33] border-[#373a40] text-[#c1c2c5]"
          )}
        >
          {t('inventoryTabFc')}
        </button>
        <button
          type="button"
          onClick={() => setActiveCategoryTab('ups')}
          className={cn(
            "px-3 py-1 rounded text-[10px] font-bold uppercase border",
            activeCategoryTab === 'ups'
              ? "bg-[#228be6] border-[#228be6] text-white"
              : "bg-[#2c2e33] border-[#373a40] text-[#c1c2c5]"
          )}
        >
          {t('inventoryTabUps')}
        </button>
        <button
          type="button"
          onClick={() => setActiveCategoryTab('all')}
          className={cn(
            "px-3 py-1 rounded text-[10px] font-bold uppercase border",
            activeCategoryTab === 'all'
              ? "bg-[#228be6] border-[#228be6] text-white"
              : "bg-[#2c2e33] border-[#373a40] text-[#c1c2c5]"
          )}
        >
          {t('inventoryTabAllWithoutOther')}
        </button>
      </div>

      <div className="bg-[#25262b] border border-[#373a40] rounded overflow-hidden">
        <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-3 bg-[#25262b] p-3 md:p-4 border border-[#373a40] rounded shadow-sm">
          <div className="flex flex-col md:flex-row md:items-center gap-3 md:gap-4 flex-1 min-w-0">
            <div className="relative w-full md:flex-1 md:max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[#5c5f66]" size={18} />
              <input 
                type="text" 
                placeholder={t('filterPlaceholder')}
                className="w-full bg-[#141517] border border-[#373a40] pl-10 pr-4 py-2 rounded text-sm text-white focus:outline-none focus:border-[#228be6] transition-colors"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="w-full md:w-auto px-4 py-2 bg-[#141517] border border-[#373a40] rounded text-sm text-white focus:outline-none focus:border-[#228be6] appearance-none"
            >
              <option value="all">All Status</option>
              <option value="online">Online</option>
              <option value="offline">Offline</option>
              <option value="warning">Warning</option>
            </select>
            <select
              value={subcategoryFilter}
              onChange={(e) => setSubcategoryFilter(e.target.value)}
              className="w-full md:w-auto px-4 py-2 bg-[#141517] border border-[#373a40] rounded text-sm text-white focus:outline-none focus:border-[#228be6] appearance-none"
            >
              <option value="all">{t('allSubcategories')}</option>
              {meta.subcategories.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <motion.div 
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: selectedIds.length > 0 ? 1 : 0, x: selectedIds.length > 0 ? 0 : 20 }}
            className={cn(
              "flex items-center gap-2 xl:border-l border-[#373a40] xl:pl-4 xl:ml-4 transition-opacity",
              selectedIds.length === 0 && "opacity-0 pointer-events-none"
            )}
          >
            <span className="text-[10px] font-bold text-[#228be6] uppercase mr-2">{selectedIds.length} Selected</span>
            <button 
              onClick={() => handleBulkAction('reboot')}
              disabled={isBulkProcessing || !isOperator}
              className="p-1.5 hover:bg-[#141517] rounded text-[#fab005] transition-colors"
              title="Bulk Reboot"
            >
              <RefreshCw size={16} className={cn(isBulkProcessing && "animate-spin")} />
            </button>
            {isAdmin && (
              <button
                onClick={() => {
                  if (confirm(`Delete ${selectedIds.length} selected devices?`)) {
                    handleBulkAction('delete');
                  }
                }}
                disabled={isBulkProcessing}
                className="p-1.5 hover:bg-[#141517] rounded text-[#fa5252] transition-colors"
                title="Bulk Delete"
              >
                <Trash2 size={16} />
              </button>
            )}
          </motion.div>
        </div>

        <div className="overflow-x-auto">
        <table className="z-table min-w-[1024px]">
          <thead>
            <tr>
              <th className="w-10">
                <input 
                  type="checkbox" 
                  checked={selectedIds.length > 0 && selectedIds.length === filteredSwitches.length}
                  onChange={toggleSelectAll}
                  className="w-4 h-4 rounded border-[#373a40] bg-[#141517] text-[#228be6]"
                />
              </th>
              <th onClick={() => handleSort('status')} className="cursor-pointer hover:text-white transition-colors">
                <div className="flex items-center gap-2">
                  {t('status')}
                  <SortIcon active={sortConfig?.key === 'status'} direction={sortConfig?.direction} />
                </div>
              </th>
              <th onClick={() => handleSort('name')} className="cursor-pointer hover:text-white transition-colors">
                <div className="flex items-center gap-2">
                  {t('name')}
                  <SortIcon active={sortConfig?.key === 'name'} direction={sortConfig?.direction} />
                </div>
              </th>
              <th onClick={() => handleSort('vendorModel')} className="cursor-pointer hover:text-white transition-colors">
                <div className="flex items-center gap-2">
                  {t('vendorModel')}
                  <SortIcon active={sortConfig?.key === 'vendorModel'} direction={sortConfig?.direction} />
                </div>
              </th>
              <th onClick={() => handleSort('subcategory')} className="cursor-pointer hover:text-white transition-colors">
                <div className="flex items-center gap-2">
                  {t('subcategoryLabel')}
                  <SortIcon active={sortConfig?.key === 'subcategory'} direction={sortConfig?.direction} />
                </div>
              </th>
              <th onClick={() => handleSort('branch')} className="cursor-pointer hover:text-white transition-colors">
                <div className="flex items-center gap-2">
                  {t('branchLabel')}
                  <SortIcon active={sortConfig?.key === 'branch'} direction={sortConfig?.direction} />
                </div>
              </th>
              <th onClick={() => handleSort('ip')} className="cursor-pointer hover:text-white transition-colors">
                <div className="flex items-center gap-2">
                  {t('ipAddress')}
                  <SortIcon active={sortConfig?.key === 'ip'} direction={sortConfig?.direction} />
                </div>
              </th>
              <th onClick={() => handleSort('city')} className="cursor-pointer hover:text-white transition-colors">
                <div className="flex items-center gap-2">
                  {t('city')}
                  <SortIcon active={sortConfig?.key === 'city'} direction={sortConfig?.direction} />
                </div>
              </th>
              <th onClick={() => handleSort('uptime')} className="cursor-pointer hover:text-white transition-colors">
                <div className="flex items-center gap-2">
                  {t('uptime')}
                  <SortIcon active={sortConfig?.key === 'uptime'} direction={sortConfig?.direction} />
                </div>
              </th>
              <th className="text-right">{t('actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filteredSwitches.map((sw) => (
              <tr key={sw.id} className={cn(selectedIds.includes(sw.id) && "bg-[#228be6]/5")}>
                <td>
                  <input 
                    type="checkbox" 
                    checked={selectedIds.includes(sw.id)}
                    onChange={() => toggleSelectOne(sw.id)}
                    className="w-4 h-4 rounded border-[#373a40] bg-[#141517] text-[#228be6]"
                  />
                </td>
                <td>
                  <span className={cn(
                    "z-badge",
                    sw.status === 'online' ? "z-badge-success" : 
                    sw.status === 'warning' ? "z-badge-warning" : "z-badge-error"
                  )}>
                    {sw.status}
                  </span>
                </td>
                <td className="font-bold text-white tracking-tight">{sw.name}</td>
                <td>
                  <div className="flex flex-col">
                    <span className="text-xs font-semibold">{sw.vendor}</span>
                    <span className="text-[10px] text-[#909296]">{sw.model}</span>
                  </div>
                </td>
                <td className="text-xs">{sw.subcategory || 'Core'}</td>
                <td className="text-xs">{sw.branch || 'ULN'}</td>
                <td className="font-mono text-xs text-[#228be6]">{sw.ip}</td>
                <td>
                    <span className="text-xs whitespace-nowrap">{sw.city}</span>
                </td>
                <td className="text-xs text-[#909296] font-mono">{sw.uptime}</td>
                <td className="text-right">
                  <div className="flex justify-end gap-2 text-[#5c5f66] relative">
                    <button 
                      onClick={() => onOpenSSH?.(sw)}
                      className="hover:text-[#228be6] transition-colors"
                      title="Open SSH Session"
                    >
                      <TerminalIcon size={14} />
                    </button>
                    <button
                      onClick={() => window.open(`http://${sw.ip}`, '_blank', 'noopener,noreferrer')}
                      className="hover:text-[#40c057] transition-colors"
                      title="Open device web UI"
                    >
                      <Globe size={14} />
                    </button>
                    {isAdmin && (
                      <>
                        <button 
                          onClick={() => handleEdit(sw)}
                          className="hover:text-white transition-colors"
                          title={t('editNode')}
                        >
                          <Edit2 size={14} />
                        </button>
                        <button 
                          onClick={() => handleDelete(sw.id)}
                          className="hover:text-red-500 transition-colors"
                          title="Delete Node"
                        >
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                    <div ref={openRowMenuId === sw.id ? rowMenuRef : null} className="relative">
                      <button
                        onClick={() => setOpenRowMenuId((prev) => (prev === sw.id ? null : sw.id))}
                        className="hover:text-white transition-colors"
                        title="More actions"
                      >
                        <MoreVertical size={14} />
                      </button>
                      {openRowMenuId === sw.id && (
                        <div className="absolute right-0 mt-2 min-w-[160px] bg-[#141517] border border-[#373a40] rounded shadow-xl z-20 text-left">
                          <button
                            className="w-full px-3 py-2 text-xs text-[#c1c2c5] hover:bg-[#25262b] hover:text-white"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(sw.ip);
                              } catch {
                                /* ignore clipboard errors */
                              }
                              setOpenRowMenuId(null);
                            }}
                          >
                            Copy IP
                          </button>
                          <button
                            className="w-full px-3 py-2 text-xs text-[#c1c2c5] hover:bg-[#25262b] hover:text-white"
                            onClick={() => {
                              window.open(`https://${sw.ip}`, '_blank', 'noopener,noreferrer');
                              setOpenRowMenuId(null);
                            }}
                          >
                            Open HTTPS UI
                          </button>
                          <button
                            className="w-full px-3 py-2 text-xs text-[#c1c2c5] hover:bg-[#25262b] hover:text-white"
                            onClick={() => {
                              alert(`Node: ${sw.name}\nBranch: ${sw.branch || '-'}\nIP: ${sw.ip}`);
                              setOpenRowMenuId(null);
                            }}
                          >
                            Device info
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      {isAdding && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[100] backdrop-blur-sm p-3 sm:p-4">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-[#25262b] border border-[#373a40] p-4 sm:p-8 rounded-lg shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center gap-3 mb-8 border-b border-[#373a40] pb-4">
              <Cpu className="text-[#228be6]" size={24} />
              <h3 className="text-xl font-bold text-white">
                {editingId ? t('editNode') : t('registerSwitch')}
              </h3>
            </div>
            
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase">{t('deviceName')}</label>
                <input 
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:outline-none focus:border-[#228be6]"
                  placeholder="e.g. CORE-SW-02"
                  value={newSwitch.name || ''}
                  onChange={e => setNewSwitch({...newSwitch, name: e.target.value})}
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase">{t('mgmntIp')}</label>
                <input 
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:outline-none focus:border-[#228be6]"
                  placeholder="10.x.x.x"
                  value={newSwitch.ip || ''}
                  onChange={e => setNewSwitch({...newSwitch, ip: e.target.value})}
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase">Vendor</label>
                <select 
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:outline-none focus:border-[#228be6]"
                  value={newSwitch.vendor}
                  onChange={e => setNewSwitch({...newSwitch, vendor: e.target.value as Vendor, model: (meta.models[e.target.value] || ['Unknown'])[0]})}
                >
                  {(meta.vendors?.length ? meta.vendors : VENDORS).map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase">Model</label>
                <input 
                  list="models"
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:outline-none focus:border-[#228be6]"
                  placeholder="Select or enter"
                  value={newSwitch.model || ''}
                  onChange={e => setNewSwitch({...newSwitch, model: e.target.value})}
                />
                <datalist id="models">
                  {newSwitch.vendor && (meta.models[newSwitch.vendor] || []).map(m => <option key={m} value={m} />)}
                </datalist>
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase">{t('categoryLabel')}</label>
                <select
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:outline-none focus:border-[#228be6]"
                  value={newSwitch.category || 'Switch'}
                  onChange={e => setNewSwitch({ ...newSwitch, category: e.target.value })}
                >
                  {meta.categories.map(c => <option key={c} value={c}>{localizeCategory(c)}</option>)}
                </select>
                <p className="text-[10px] text-[#909296]">{t('manageCategoriesInSettings')}</p>
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase">{t('subcategoryLabel')}</label>
                <select
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:outline-none focus:border-[#228be6]"
                  value={newSwitch.subcategory || 'Core'}
                  onChange={e => setNewSwitch({ ...newSwitch, subcategory: e.target.value })}
                >
                  {meta.subcategories.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase">{t('branchLabel')}</label>
                <select
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:outline-none focus:border-[#228be6]"
                  value={newSwitch.branch || 'ULN'}
                  onChange={e => setNewSwitch({ ...newSwitch, branch: e.target.value })}
                >
                  {meta.branches.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
                <p className="text-[10px] text-[#909296]">{t('manageBranchesInSettings')}</p>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase">SNMP Template</label>
                <select
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:outline-none focus:border-[#228be6]"
                  value={newSwitch.snmpTemplateId || ''}
                  onChange={e => setNewSwitch({ ...newSwitch, snmpTemplateId: e.target.value })}
                >
                  <option value="">Auto</option>
                  {snmpTemplates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}
                </select>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase">Custom SNMP OIDs (one per line)</label>
                <textarea
                  className="w-full min-h-[90px] bg-[#141517] border border-[#373a40] p-2.5 rounded text-xs text-white focus:outline-none focus:border-[#228be6] font-mono"
                  value={customOidsText}
                  onChange={(e) => setCustomOidsText(e.target.value)}
                  placeholder={"1.3.6.1.2.1.1.3.0\n1.3.6.1.4.1.x.x.x"}
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase">{t('city')}</label>
                <select
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:outline-none focus:border-[#228be6]"
                  value={newSwitch.city || ''}
                  onChange={e => setNewSwitch({...newSwitch, city: e.target.value})}
                >
                  {meta.cities.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>

            <div className="mt-10 flex justify-end gap-3">
              <button 
                onClick={() => {
                  setIsAdding(false);
                  setEditingId(null);
                  setNewSwitch(makeDefaultSwitch());
                  setCustomOidsText('');
                }}
                className="px-6 py-2.5 text-sm font-bold text-[#909296] hover:text-white transition-all uppercase tracking-widest"
              >
                {t('cancel')}
              </button>
              <button 
                onClick={handleAdd}
                className="px-8 py-2.5 bg-[#228be6] hover:bg-[#1c7ed6] text-white rounded text-sm font-bold shadow-lg uppercase tracking-widest transition-all"
              >
                {editingId ? t('save') : t('completeReg')}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
};

export default Inventory;
