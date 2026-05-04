import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Plus, Search, Filter, MoreVertical, Edit2, Trash2, Cpu, Download, ChevronUp, ChevronDown, RefreshCw, Play, Square, CheckSquare, Terminal as TerminalIcon } from 'lucide-react';

const SortIcon = ({ active, direction }: { active: boolean, direction?: 'asc' | 'desc' }) => {
  if (!active) return <div className="w-3" />;
  return direction === 'asc' ? <ChevronUp size={12} className="text-[#228be6]" /> : <ChevronDown size={12} className="text-[#228be6]" />;
};
import { Switch, Vendor } from '../types';
import { MODELS, VENDORS } from '../constants';
import { cn } from '../lib/utils';
import { useTranslation } from '../lib/i18n';

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
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isBulkProcessing, setIsBulkProcessing] = useState(false);
  const [sortConfig, setSortConfig] = useState<{ key: keyof Switch | 'vendorModel' | 'location'; direction: 'asc' | 'desc' } | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newSwitch, setNewSwitch] = useState<Partial<Switch>>({
    vendor: 'HPE',
    status: 'online',
    uptime: '0d 0h'
  });

  const handleAdd = async () => {
    if (!newSwitch.name || !newSwitch.ip || !newSwitch.city) return;
    
    try {
      if (editingId) {
        const response = await fetch(`/api/inventory/${editingId}`, {
          method: 'PATCH',
          headers: { 
            'Content-Type': 'application/json',
            'x-user-role': role || 'viewer',
            'x-user-name': username || 'unknown'
          },
          body: JSON.stringify(newSwitch),
        });
        if (!response.ok) throw new Error('Update failed');
      } else {
        const response = await fetch('/api/inventory', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-user-role': role || 'viewer',
            'x-user-name': username || 'unknown'
          },
          body: JSON.stringify(newSwitch),
        });
        if (!response.ok) throw new Error('Creation failed');
      }
      
      // Refresh inventory in parent
      // In a real app we'd trigger a parent refresh, here we'll assume App.tsx poller catches it 
      // or we just close the modal. For better UX, let's just close and wait for poll.
      setIsAdding(false);
      setEditingId(null);
      setNewSwitch({ vendor: 'HPE', status: 'online', uptime: '0d 0h' });
    } catch (error) {
      alert('Error saving device configuration');
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
    setEditingId(sw.id);
    setIsAdding(true);
  };

  const handleExport = () => {
    const headers = ['Name', 'Vendor', 'Model', 'IP', 'City', 'Zone', 'Status', 'Uptime'];
    const rows = switches.map(s => [s.name, s.vendor, s.model, s.ip, s.city, s.zone, s.status, s.uptime]);
    const csvContent = [headers, ...rows].map(e => e.join(",")).join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `switching_inventory_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  };

  const handleSort = (key: keyof Switch | 'vendorModel' | 'location') => {
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
      
      return matchesSearch && matchesStatus;
    })
    .sort((a, b) => {
      if (!sortConfig) return 0;

      let aValue: any;
      let bValue: any;

      if (sortConfig.key === 'vendorModel') {
        aValue = `${a.vendor} ${a.model}`.toLowerCase();
        bValue = `${b.vendor} ${b.model}`.toLowerCase();
      } else if (sortConfig.key === 'location') {
        aValue = `${a.city} ${a.zone}`.toLowerCase();
        bValue = `${b.city} ${b.zone}`.toLowerCase();
      } else {
        aValue = (a[sortConfig.key as keyof Switch] as string).toLowerCase();
        bValue = (b[sortConfig.key as keyof Switch] as string).toLowerCase();
      }

      if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1;
      if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });

  return (
    <div className="p-8 space-y-6">
      <header className="flex justify-between items-end">
        <div>
          <h2 className="text-2xl font-bold text-white mb-2 leading-tight">{t('switchInventory')}</h2>
          <p className="text-sm text-[#909296]">{t('manageNodes')}</p>
        </div>
        <div className="flex gap-3">
          <button 
            onClick={handleExport}
            className="flex items-center gap-2 px-4 py-2 border border-[#373a40] text-[#c1c2c5] hover:text-white rounded text-sm font-bold transition-all"
          >
            <Download size={18} />
            {t('exportCsv')}
          </button>
          {isAdmin && (
            <button 
              onClick={() => setIsAdding(true)}
              className="flex items-center gap-2 px-4 py-2 bg-[#228be6] hover:bg-[#1c7ed6] text-white rounded text-sm font-bold transition-all shadow-lg"
            >
              <Plus size={18} />
              {t('registerSwitch')}
            </button>
          )}
        </div>
      </header>

      <div className="bg-[#25262b] border border-[#373a40] rounded overflow-hidden">
        <div className="flex items-center justify-between bg-[#25262b] p-4 border border-[#373a40] rounded shadow-sm">
          <div className="flex items-center gap-4 flex-1">
            <div className="relative flex-1 max-w-md">
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
              className="px-4 py-2 bg-[#141517] border border-[#373a40] rounded text-sm text-white focus:outline-none focus:border-[#228be6] appearance-none"
            >
              <option value="all">All Status</option>
              <option value="online">Online</option>
              <option value="offline">Offline</option>
              <option value="warning">Warning</option>
            </select>
          </div>

          <motion.div 
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: selectedIds.length > 0 ? 1 : 0, x: selectedIds.length > 0 ? 0 : 20 }}
            className={cn(
              "flex items-center gap-2 border-l border-[#373a40] pl-4 ml-4 transition-opacity",
              selectedIds.length === 0 && "opacity-0 pointer-events-none"
            )}
          >
            <span className="text-[10px] font-bold text-[#228be6] uppercase mr-2">{selectedIds.length} Selected</span>
            <button 
              onClick={() => handleBulkAction('status', 'online')}
              disabled={isBulkProcessing || !isOperator}
              className="p-1.5 hover:bg-[#141517] rounded text-[#40c057] transition-colors"
              title="Bulk Set Online"
            >
              <Play size={16} />
            </button>
            <button 
              onClick={() => handleBulkAction('status', 'offline')}
              disabled={isBulkProcessing || !isOperator}
              className="p-1.5 hover:bg-[#141517] rounded text-[#fa5252] transition-colors"
              title="Bulk Set Offline"
            >
              <Square size={16} />
            </button>
            <button 
              onClick={() => handleBulkAction('reboot')}
              disabled={isBulkProcessing || !isOperator}
              className="p-1.5 hover:bg-[#141517] rounded text-[#fab005] transition-colors"
              title="Bulk Reboot"
            >
              <RefreshCw size={16} className={cn(isBulkProcessing && "animate-spin")} />
            </button>
          </motion.div>
        </div>

        <table className="z-table">
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
              <th onClick={() => handleSort('ip')} className="cursor-pointer hover:text-white transition-colors">
                <div className="flex items-center gap-2">
                  {t('ipAddress')}
                  <SortIcon active={sortConfig?.key === 'ip'} direction={sortConfig?.direction} />
                </div>
              </th>
              <th onClick={() => handleSort('location')} className="cursor-pointer hover:text-white transition-colors">
                <div className="flex items-center gap-2">
                  {t('location')}
                  <SortIcon active={sortConfig?.key === 'location'} direction={sortConfig?.direction} />
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
                <td className="font-mono text-xs text-[#228be6]">{sw.ip}</td>
                <td>
                  <div className="flex flex-col">
                    <span className="text-xs">{sw.city}</span>
                    <span className="text-[10px] text-[#909296] uppercase tracking-wider">{sw.zone}</span>
                  </div>
                </td>
                <td className="text-xs text-[#909296] font-mono">{sw.uptime}</td>
                <td className="text-right">
                  <div className="flex justify-end gap-2 text-[#5c5f66]">
                    <button 
                      onClick={() => onOpenSSH?.(sw)}
                      className="hover:text-[#228be6] transition-colors"
                      title="Open SSH Session"
                    >
                      <TerminalIcon size={14} />
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
                    <button className="hover:text-white transition-colors"><MoreVertical size={14} /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isAdding && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[100] backdrop-blur-sm">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-[#25262b] border border-[#373a40] p-8 rounded-lg shadow-2xl w-full max-w-xl"
          >
            <div className="flex items-center gap-3 mb-8 border-b border-[#373a40] pb-4">
              <Cpu className="text-[#228be6]" size={24} />
              <h3 className="text-xl font-bold text-white">
                {editingId ? t('editNode') : t('registerSwitch')}
              </h3>
            </div>
            
            <div className="grid grid-cols-2 gap-6">
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
                  onChange={e => setNewSwitch({...newSwitch, vendor: e.target.value as Vendor, model: MODELS[e.target.value][0]})}
                >
                  {VENDORS.map(v => <option key={v} value={v}>{v}</option>)}
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
                  {newSwitch.vendor && MODELS[newSwitch.vendor].map(m => <option key={m} value={m} />)}
                </datalist>
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase">{t('city')}</label>
                <input 
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:outline-none focus:border-[#228be6]"
                  placeholder="Moscow"
                  value={newSwitch.city || ''}
                  onChange={e => setNewSwitch({...newSwitch, city: e.target.value})}
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase">{t('zone')}</label>
                <input 
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white focus:outline-none focus:border-[#228be6]"
                  placeholder="Server-Farm-A"
                  value={newSwitch.zone || ''}
                  onChange={e => setNewSwitch({...newSwitch, zone: e.target.value})}
                />
              </div>
            </div>

            <div className="mt-10 flex justify-end gap-3">
              <button 
                onClick={() => {
                  setIsAdding(false);
                  setEditingId(null);
                  setNewSwitch({ vendor: 'HPE', status: 'online', uptime: '0d 0h' });
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
