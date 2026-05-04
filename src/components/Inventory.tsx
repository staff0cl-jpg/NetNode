import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Plus, Search, Filter, MoreVertical, Edit2, Trash2, Cpu, Download } from 'lucide-react';
import { Switch, Vendor } from '../types';
import { MODELS, VENDORS } from '../constants';
import { cn } from '../lib/utils';
import { useTranslation } from '../lib/i18n';

interface InventoryProps {
  switches: Switch[];
  setSwitches: React.Dispatch<React.SetStateAction<Switch[]>>;
}

const Inventory: React.FC<InventoryProps> = ({ switches, setSwitches }) => {
  const { t } = useTranslation();
  const [searchTerm, setSearchTerm] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newSwitch, setNewSwitch] = useState<Partial<Switch>>({
    vendor: 'HPE',
    status: 'online',
    uptime: '0d 0h'
  });

  const handleAdd = () => {
    if (!newSwitch.name || !newSwitch.ip || !newSwitch.city) return;
    
    if (editingId) {
      setSwitches(switches.map(s => s.id === editingId ? { ...newSwitch, id: editingId } as Switch : s));
    } else {
      const id = Date.now().toString();
      setSwitches([...switches, { ...newSwitch, id } as Switch]);
    }
    
    setIsAdding(false);
    setEditingId(null);
    setNewSwitch({ vendor: 'HPE', status: 'online', uptime: '0d 0h' });
  };

  const handleDelete = (id: string) => {
    if (confirm('Are you sure you want to remove this node from inventory?')) {
      setSwitches(switches.filter(s => s.id !== id));
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

  const filteredSwitches = switches.filter(s => 
    s.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    s.city.toLowerCase().includes(searchTerm.toLowerCase()) ||
    s.ip.includes(searchTerm)
  );

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
          <button 
            onClick={() => setIsAdding(true)}
            className="flex items-center gap-2 px-4 py-2 bg-[#228be6] hover:bg-[#1c7ed6] text-white rounded text-sm font-bold transition-all shadow-lg"
          >
            <Plus size={18} />
            {t('registerSwitch')}
          </button>
        </div>
      </header>

      <div className="bg-[#25262b] border border-[#373a40] rounded overflow-hidden">
        <div className="p-4 border-b border-[#373a40] flex gap-4 items-center bg-[#1c1d21]">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[#5c5f66]" size={16} />
            <input 
              type="text" 
              placeholder={t('filterPlaceholder')}
              className="w-full bg-[#141517] border border-[#373a40] pl-10 pr-4 py-2 rounded text-sm text-white focus:outline-none focus:border-[#228be6] transition-colors"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <button className="p-2 border border-[#373a40] rounded text-[#909296] hover:text-white transition-colors">
            <Filter size={18} />
          </button>
        </div>

        <table className="z-table">
          <thead>
            <tr>
              <th>{t('status')}</th>
              <th>{t('name')}</th>
              <th>{t('vendorModel')}</th>
              <th>{t('ipAddress')}</th>
              <th>{t('location')}</th>
              <th>{t('uptime')}</th>
              <th className="text-right">{t('actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filteredSwitches.map((sw) => (
              <tr key={sw.id}>
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
