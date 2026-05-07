import React, { useEffect, useState } from 'react';
import { useTranslation } from '../lib/i18n';
import { History, Shield, User, Database, Settings, LogIn, Search, Filter } from 'lucide-react';
import { cn } from '../lib/utils';

interface AuditLog {
  id: string;
  timestamp: string;
  user: string;
  action: string;
  details: string;
  category: 'auth' | 'inventory' | 'config' | 'user_mgmt' | 'system';
}

const CategoryIcon = ({ category }: { category: AuditLog['category'] }) => {
  switch (category) {
    case 'auth': return <LogIn size={14} className="text-[#228be6]" />;
    case 'inventory': return <Database size={14} className="text-[#40c057]" />;
    case 'config': return <Settings size={14} className="text-[#fab005]" />;
    case 'user_mgmt': return <User size={14} className="text-[#7950f2]" />;
    case 'system': return <Shield size={14} className="text-[#fa5252]" />;
    default: return <History size={14} />;
  }
};

const AuditLogs: React.FC<{ role?: string, username?: string }> = ({ role, username }) => {
  const { t, language } = useTranslation();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterCategory, setFilterCategory] = useState<string>('all');

  const fetchLogs = async () => {
    try {
      const response = await fetch('/api/audit-logs', {
        headers: { 
          'x-user-role': role || 'viewer',
          'x-user-name': username || 'unknown'
        }
      });
      const data = await response.json();
      setLogs(data);
    } catch (error) {
      console.error('Error fetching logs:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 10000); // Polling every 10s
    return () => clearInterval(interval);
  }, []);

  const filteredLogs = logs.filter(log => {
    const matchesSearch = log.user.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         log.action.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         log.details.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = filterCategory === 'all' || log.category === filterCategory;
    return matchesSearch && matchesCategory;
  });

  const localizeCategory = (category: AuditLog['category']) => {
    switch (category) {
      case 'auth': return t('auditCategoryAuth');
      case 'inventory': return t('auditCategoryInventory');
      case 'config': return t('auditCategoryConfig');
      case 'user_mgmt': return t('auditCategoryUserMgmt');
      case 'system': return t('auditCategorySystem');
      default: return category;
    }
  };

  const localizeAction = (action: string) => {
    if (language !== 'ru') return action;
    const map: Record<string, string> = {
      'Start Discovery': 'Запуск автообнаружения',
      'Discovery Complete': 'Автообнаружение завершено',
      'Discovery Watch Scheduled Run': 'Плановый запуск профилей автообнаружения',
      'Discovery Watch Scheduler Start': 'Планировщик автообнаружения запущен',
      'Discovery Watch Manual Run': 'Ручной запуск профилей автообнаружения',
      'System Config Update': 'Обновление системной конфигурации',
      'LDAP Config Update': 'Обновление LDAP-конфигурации',
      'LDAP Test': 'Проверка LDAP',
      'Bulk Action': 'Массовое действие',
      'Add Device': 'Добавление устройства',
      'Update Device': 'Обновление устройства',
      'Remove Device': 'Удаление устройства',
      'Rename Branch': 'Переименование филиала',
      'Login Success': 'Успешный вход',
      'Login Failure': 'Ошибка входа',
      'Logout': 'Выход из системы',
      'Create User': 'Создание пользователя',
      'Update User Role': 'Изменение роли пользователя',
      'Reset Password': 'Сброс пароля',
      'Delete User': 'Удаление пользователя',
      'SNMP Config Update': 'Обновление SNMP-конфигурации',
      'Trap Receiver Update': 'Обновление Trap Receiver',
      'SSH Readonly Profile Set': 'Сохранение read-only SSH профиля',
      'Topology Rebuild': 'Перестроение топологии',
      'Topology Manual Link Add': 'Добавление ручной связи',
      'Topology Manual Link Delete': 'Удаление ручной связи',
      'Topology Link Rename': 'Переименование подписи связи',
    };
    return map[action] || action;
  };

  const localizeDetails = (details: string) => {
    if (language !== 'ru') return details;
    return details
      .replace('Profiles processed:', 'Профилей обработано:')
      .replace('Updated system settings', 'Системные настройки обновлены')
      .replace('Updated LDAP authentication profiles', 'Профили LDAP-аутентификации обновлены')
      .replace('Performed reboot on', 'Выполнена команда reboot для')
      .replace('Performed delete on', 'Выполнено удаление для')
      .replace('devices', 'устройств')
      .replace('Registered new switch:', 'Зарегистрировано новое устройство:')
      .replace('Updated device configurations for:', 'Обновлена конфигурация устройства:')
      .replace('Deleted switch:', 'Удалено устройство:')
      .replace('User authenticated successfully', 'Пользователь успешно аутентифицирован')
      .replace('Failed login attempt for username:', 'Неуспешная попытка входа для пользователя:')
      .replace('Created new user:', 'Создан новый пользователь:')
      .replace('with role', 'с ролью')
      .replace('Reset password for user:', 'Сброшен пароль пользователя:')
      .replace('Deleted user:', 'Удален пользователь:')
      .replace('TTL', 'TTL')
      .replace('metrics fallback: on', 'fallback метрик: включен')
      .replace('metrics fallback: off', 'fallback метрик: выключен');
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#25262b]">
      <header className="p-6 border-b border-[#373a40] bg-[#1c1d21] flex justify-between items-center shrink-0">
        <div className="flex items-center gap-3">
          <History className="text-[#228be6]" size={24} />
          <div>
            <h2 className="text-xl font-bold text-white uppercase tracking-wider">{t('auditLogs')}</h2>
            <p className="text-xs text-[#909296] font-medium">{t('trackingActions')}</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[#5c5f66]" size={16} />
            <input 
              type="text" 
              placeholder={t('searchLogs')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10 pr-4 py-2 bg-[#1c1d21] border border-[#373a40] rounded text-sm text-white placeholder-[#5c5f66] focus:outline-none focus:border-[#228be6]"
            />
          </div>
          
          <select 
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className="px-4 py-2 bg-[#1c1d21] border border-[#373a40] rounded text-sm text-white focus:outline-none focus:border-[#228be6]"
          >
            <option value="all">{t('auditAllCategories')}</option>
            <option value="auth">{t('auditCategoryAuth')}</option>
            <option value="inventory">{t('auditCategoryInventory')}</option>
            <option value="config">{t('auditCategoryConfig')}</option>
            <option value="user_mgmt">{t('auditCategoryUserMgmt')}</option>
            <option value="system">{t('auditCategorySystem')}</option>
          </select>

          <button 
            onClick={fetchLogs}
            className="p-2 hover:bg-[#373a40] rounded transition-colors text-[#228be6]"
            title={t('refresh')}
          >
            <History size={18} />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-x-auto">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-[#1c1d21] z-10">
            <tr className="border-b border-[#373a40]">
              <th className="text-left p-4 text-[10px] uppercase font-bold text-[#5c5f66] tracking-widest">{t('timestamp')}</th>
              <th className="text-left p-4 text-[10px] uppercase font-bold text-[#5c5f66] tracking-widest">{t('user')}</th>
              <th className="text-left p-4 text-[10px] uppercase font-bold text-[#5c5f66] tracking-widest">{t('category')}</th>
              <th className="text-left p-4 text-[10px] uppercase font-bold text-[#5c5f66] tracking-widest">{t('action')}</th>
              <th className="text-left p-4 text-[10px] uppercase font-bold text-[#5c5f66] tracking-widest">{t('details')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#373a40]">
            {loading && logs.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-8 text-center text-[#909296] italic">{t('loadingLogs')}</td>
              </tr>
            ) : filteredLogs.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-8 text-center text-[#909296] italic">{t('noLogsFound')}</td>
              </tr>
            ) : filteredLogs.map((log) => (
              <tr key={log.id} className="hover:bg-white/5 transition-colors group">
                <td className="p-4 text-xs font-mono text-[#909296]">
                  {new Date(log.timestamp).toLocaleString()}
                </td>
                <td className="p-4">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-[#2c2e33] flex items-center justify-center text-[10px] uppercase text-[#228be6] border border-[#373a40]">
                      {log.user.charAt(0)}
                    </div>
                    <span className="text-sm text-white font-medium">{log.user}</span>
                  </div>
                </td>
                <td className="p-4">
                  <div className="flex items-center gap-2 px-2 py-1 rounded bg-[#2c2e33] w-fit">
                    <CategoryIcon category={log.category} />
                    <span className="text-[10px] uppercase font-bold text-[#909296] tracking-wider">{localizeCategory(log.category)}</span>
                  </div>
                </td>
                <td className="p-4 text-sm font-bold text-white">
                  {localizeAction(log.action)}
                </td>
                <td className="p-4 text-sm text-[#909296]">
                  {localizeDetails(log.details)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default AuditLogs;
