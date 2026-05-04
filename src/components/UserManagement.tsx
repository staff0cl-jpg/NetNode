import React, { useState } from 'react';
import { motion } from 'motion/react';
import { UserPlus, Shield, User, Trash2, Edit2, Key } from 'lucide-react';
import { useTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';

interface LocalUser {
  id: string;
  username: string;
  role: 'admin' | 'operator' | 'viewer';
  lastLogin: string;
}

const UserManagement: React.FC = () => {
  const { t } = useTranslation();
  const [users, setUsers] = useState<LocalUser[]>([
    { id: '1', username: 'admin', role: 'admin', lastLogin: '2024-05-04 10:15' },
    { id: '2', username: 'operator_01', role: 'operator', lastLogin: '2024-05-03 16:45' },
  ]);

  const [isAdding, setIsAdding] = useState(false);
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'operator' as const });

  const handleAdd = () => {
    if (!newUser.username || !newUser.password) return;
    const user: LocalUser = {
      id: Date.now().toString(),
      username: newUser.username,
      role: newUser.role,
      lastLogin: '-'
    };
    setUsers([...users, user]);
    setIsAdding(false);
    setNewUser({ username: '', password: '', role: 'operator' });
  };

  return (
    <div className="p-8 space-y-6">
      <header className="flex justify-between items-end">
        <div>
          <h2 className="text-2xl font-bold text-white mb-2 leading-tight">{t('localUsers')}</h2>
          <p className="text-sm text-[#909296]">{t('manageAccs')}</p>
        </div>
        <button 
          onClick={() => setIsAdding(true)}
          className="flex items-center gap-2 px-4 py-2 bg-[#228be6] hover:bg-[#1c7ed6] text-white rounded text-sm font-bold transition-all shadow-lg"
        >
          <UserPlus size={18} />
          {t('addUser')}
        </button>
      </header>

      <div className="bg-[#25262b] border border-[#373a40] rounded overflow-hidden">
        <table className="z-table">
          <thead>
            <tr>
              <th>{t('username')}</th>
              <th>{t('role')}</th>
              <th>{t('lastLogin')}</th>
              <th className="text-right">{t('actions')}</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td className="font-bold text-white">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-[#141517] rounded text-[#228be6]">
                      <User size={14} />
                    </div>
                    {user.username}
                  </div>
                </td>
                <td>
                  <span className={cn(
                    "z-badge",
                    user.role === 'admin' ? "z-badge-error text-red-400 bg-red-400/10" : "z-badge-success text-green-400 bg-green-400/10"
                  )}>
                    {t(user.role)}
                  </span>
                </td>
                <td className="text-xs text-[#909296] font-mono">{user.lastLogin}</td>
                <td className="text-right">
                  <div className="flex justify-end gap-2 text-[#5c5f66]">
                    <button className="hover:text-white transition-colors" title="Edit Permissions"><Shield size={14} /></button>
                    <button className="hover:text-white transition-colors" title="Change Password"><Key size={14} /></button>
                    <button 
                      onClick={() => setUsers(users.filter(u => u.id !== user.id))}
                      className="hover:text-red-500 transition-colors" 
                      title="Delete User"
                    >
                      <Trash2 size={14} />
                    </button>
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
            className="bg-[#25262b] border border-[#373a40] p-8 rounded-lg shadow-2xl w-full max-w-md"
          >
            <h3 className="text-xl font-bold text-white mb-6 uppercase tracking-widest">{t('addUser')}</h3>
            
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase">{t('username')}</label>
                <input 
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white outline-none focus:border-[#228be6]"
                  value={newUser.username}
                  onChange={e => setNewUser({...newUser, username: e.target.value})}
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase">Password</label>
                <input 
                  type="password"
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white outline-none focus:border-[#228be6]"
                  value={newUser.password}
                  onChange={e => setNewUser({...newUser, password: e.target.value})}
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase">{t('role')}</label>
                <select 
                  className="w-full bg-[#141517] border border-[#373a40] p-2.5 rounded text-sm text-white outline-none focus:border-[#228be6]"
                  value={newUser.role}
                  onChange={e => setNewUser({...newUser, role: e.target.value as any})}
                >
                  <option value="admin">{t('admin')}</option>
                  <option value="operator">{t('operator')}</option>
                  <option value="viewer">{t('viewer')}</option>
                </select>
              </div>
            </div>

            <div className="mt-8 flex justify-end gap-3">
              <button 
                onClick={() => setIsAdding(false)}
                className="px-6 py-2.5 text-[10px] font-bold text-[#909296] hover:text-white uppercase tracking-widest"
              >
                {t('cancel')}
              </button>
              <button 
                onClick={handleAdd}
                className="px-8 py-2.5 bg-[#228be6] hover:bg-[#1c7ed6] text-white rounded text-[10px] font-bold shadow-lg uppercase tracking-widest"
              >
                {t('addUser')}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
};

export default UserManagement;
