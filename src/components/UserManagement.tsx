import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { UserPlus, Shield, User, Trash2, Edit2, Key, Check, X } from 'lucide-react';
import { useTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';
import { netnodeFetch } from '../lib/netnodeFetch';
import { useNotifications } from '../lib/notifications';

interface LocalUser {
  id: string;
  username: string;
  role: 'admin' | 'operator' | 'viewer';
  lastLogin: string;
}

interface UserManagementProps {
  role?: string;
  username?: string;
}

const UserManagement: React.FC<UserManagementProps> = ({ role, username }) => {
  const { t } = useTranslation();
  const { notifySuccess, notifyError } = useNotifications();
  const [users, setUsers] = useState<LocalUser[]>([]);
  const [loading, setLoading] = useState(true);

  const [isAdding, setIsAdding] = useState(false);
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'operator' as const });
  
  const [editingUser, setEditingUser] = useState<LocalUser | null>(null);
  const [changingPasswordUser, setChangingPasswordUser] = useState<LocalUser | null>(null);
  const [newPassword, setNewPassword] = useState('');

  const fetchUsers = async () => {
    try {
      const response = await netnodeFetch('/api/users', {
        headers: { 
        }
      });
      const data = await response.json();
      setUsers(data);
    } catch (error) {
      console.error('Failed to fetch users:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const handleAdd = async () => {
    if (!newUser.username || !newUser.password) return;
    try {
      const response = await netnodeFetch('/api/users', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(newUser),
      });
      if (response.ok) {
        await fetchUsers();
        setIsAdding(false);
        setNewUser({ username: '', password: '', role: 'operator' });
      }
    } catch (error) {
      notifyError(t('userMgmtAddUserError'));
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(t('confirmDelete'))) return;
    try {
      await netnodeFetch('/api/users/' + id, { 
        method: 'DELETE',
        headers: { 
        }
      });
      await fetchUsers();
    } catch (error) {
      notifyError(t('userMgmtDeleteUserError'));
    }
  };

  const handleUpdateRole = async (id: string, newRole: string) => {
    try {
      await netnodeFetch('/api/users/' + id, {
        method: 'PATCH',
        headers: { 
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: newRole }),
      });
      await fetchUsers();
      setEditingUser(null);
      notifySuccess(t('roleUpdated'));
    } catch (error) {
      notifyError(t('userMgmtUpdateRoleError'));
    }
  };

  const handleChangePassword = async () => {
    if (!changingPasswordUser || !newPassword) return;
    try {
      const response = await netnodeFetch(`/api/users/${changingPasswordUser.id}/password`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password: newPassword }),
      });
      if (response.ok) {
        setChangingPasswordUser(null);
        setNewPassword('');
        notifySuccess(t('passwordUpdated'));
      }
    } catch (error) {
      notifyError(t('userMgmtUpdatePasswordError'));
    }
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

      <div className="bg-[#25262b] border border-[#373a40] rounded overflow-hidden shadow-xl">
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
            {loading ? (
              <tr><td colSpan={4} className="text-center p-8 text-[#5c5f66]">Loading...</td></tr>
            ) : users.map((user) => (
              <tr key={user.id} className="hover:bg-white/[0.02] transition-colors">
                <td className="font-bold text-white">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-[#141517] rounded text-[#228be6] border border-[#373a40]">
                      <User size={14} />
                    </div>
                    {user.username}
                  </div>
                </td>
                <td>
                  <span className={cn(
                    "z-badge",
                    user.role === 'admin' ? "z-badge-error border border-red-500/30 text-red-400 bg-red-400/10" : 
                    user.role === 'operator' ? "z-badge-success border border-green-500/30 text-green-400 bg-green-400/10" :
                    "z-badge-info border border-blue-500/30 text-blue-400 bg-blue-400/10"
                  )}>
                    {t(user.role)}
                  </span>
                </td>
                <td className="text-xs text-[#909296] font-mono">{user.lastLogin}</td>
                <td className="text-right">
                  <div className="flex justify-end gap-2 text-[#5c5f66]">
                    <button 
                      onClick={() => setEditingUser(user)}
                      className="p-2 hover:text-white hover:bg-white/5 rounded transition-all" 
                      title={t('editPermissions')}
                    >
                      <Shield size={14} />
                    </button>
                    <button 
                      onClick={() => setChangingPasswordUser(user)}
                      className="p-2 hover:text-white hover:bg-white/5 rounded transition-all" 
                      title={t('changePassword')}
                    >
                      <Key size={14} />
                    </button>
                    <button 
                      onClick={() => handleDelete(user.id)}
                      className="p-2 hover:text-red-500 hover:bg-red-500/5 rounded transition-all" 
                      title={t('deleteUser')}
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

      {/* Add User Modal */}
      {isAdding && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[110] backdrop-blur-md">
          <motion.div 
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
            className="bg-[#1c1d21] border border-[#373a40] p-8 rounded-lg shadow-2xl w-full max-w-md"
          >
            <div className="flex items-center gap-3 mb-6">
               <UserPlus className="text-[#228be6]" size={20} />
               <h3 className="text-lg font-bold text-white uppercase tracking-widest">{t('addUser')}</h3>
            </div>
            
            <div className="space-y-5">
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('username')}</label>
                <input 
                  className="w-full bg-[#141517] border border-[#373a40] p-3 rounded text-sm text-white outline-none focus:border-[#228be6] transition-colors"
                  value={newUser.username}
                  onChange={e => setNewUser({...newUser, username: e.target.value})}
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('accToken')}</label>
                <input 
                  type="password"
                  className="w-full bg-[#141517] border border-[#373a40] p-3 rounded text-sm text-white outline-none focus:border-[#228be6] transition-colors"
                  value={newUser.password}
                  onChange={e => setNewUser({...newUser, password: e.target.value})}
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('role')}</label>
                <select 
                  className="w-full bg-[#141517] border border-[#373a40] p-3 rounded text-sm text-white outline-none focus:border-[#228be6] transition-colors"
                  value={newUser.role}
                  onChange={e => setNewUser({...newUser, role: e.target.value as any})}
                >
                  <option value="admin">{t('admin')}</option>
                  <option value="operator">{t('operator')}</option>
                  <option value="viewer">{t('viewer')}</option>
                </select>
              </div>
            </div>

            <div className="mt-8 flex justify-end gap-3 pt-6 border-t border-[#373a40]">
              <button onClick={() => setIsAdding(false)} className="px-6 py-2.5 text-[10px] font-bold text-[#909296] hover:text-white uppercase tracking-widest">{t('cancel')}</button>
              <button 
                onClick={handleAdd}
                className="px-8 py-2.5 bg-[#40c057] hover:bg-[#37b24d] text-white rounded text-[10px] font-bold shadow-lg uppercase tracking-widest transition-all"
              >
                {t('completeReg')}
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Edit Role Modal */}
      {editingUser && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[110] backdrop-blur-md">
          <motion.div 
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
            className="bg-[#1c1d21] border border-[#373a40] p-8 rounded-lg shadow-2xl w-full max-w-sm"
          >
            <div className="flex items-center gap-3 mb-6">
               <Shield className="text-[#fab005]" size={20} />
               <h3 className="text-lg font-bold text-white uppercase tracking-widest">{t('editPermissions')}</h3>
            </div>
            
            <p className="text-sm text-[#909296] mb-6">
              User: <span className="text-white font-bold">{editingUser.username}</span>
            </p>

            <div className="space-y-4">
              {(['admin', 'operator', 'viewer'] as const).map(role => (
                <button
                  key={role}
                  onClick={() => handleUpdateRole(editingUser.id, role)}
                  className={cn(
                    "w-full p-4 rounded border text-left flex justify-between items-center transition-all",
                    editingUser.role === role ? "bg-[#228be6]/10 border-[#228be6] text-[#228be6]" : "bg-[#141517] border-[#373a40] text-[#909296] hover:border-[#5c5f66]"
                  )}
                >
                  <div className="font-bold uppercase text-xs tracking-wider">{t(role)}</div>
                  {editingUser.role === role && <Check size={16} />}
                </button>
              ))}
            </div>

            <div className="mt-8 flex justify-end pt-6 border-t border-[#373a40]">
              <button onClick={() => setEditingUser(null)} className="px-6 py-2.5 text-[10px] font-bold text-[#909296] hover:text-white uppercase tracking-widest">{t('cancel')}</button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Change Password Modal */}
      {changingPasswordUser && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[110] backdrop-blur-md">
          <motion.div 
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
            className="bg-[#1c1d21] border border-[#373a40] p-8 rounded-lg shadow-2xl w-full max-w-sm"
          >
            <div className="flex items-center gap-3 mb-6">
               <Key className="text-[#40c057]" size={20} />
               <h3 className="text-lg font-bold text-white uppercase tracking-widest">{t('changePassword')}</h3>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t('newPassword')}</label>
                <input 
                  type="password"
                  className="w-full bg-[#141517] border border-[#373a40] p-3 rounded text-sm text-white outline-none focus:border-[#228be6] transition-colors"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  autoFocus
                />
              </div>
            </div>

            <div className="mt-8 flex justify-end gap-3 pt-6 border-t border-[#373a40]">
              <button onClick={() => {setChangingPasswordUser(null); setNewPassword('');}} className="px-6 py-2.5 text-[10px] font-bold text-[#909296] hover:text-white uppercase tracking-widest">{t('cancel')}</button>
              <button 
                onClick={handleChangePassword}
                className="px-8 py-2.5 bg-[#40c057] hover:bg-[#37b24d] text-white rounded text-[10px] font-bold shadow-lg uppercase tracking-widest transition-all"
              >
                {t('save')}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
};

export default UserManagement;
