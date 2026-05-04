import React, { createContext, useContext, useState } from 'react';

type Language = 'ru' | 'en';

interface Translations {
  [key: string]: {
    [K in Language]: string;
  };
}

export const translations: Translations = {
  // Sidebar
  dashboard: { ru: 'Дашборд', en: 'Dashboard' },
  inventory: { ru: 'Инвентаризация', en: 'Inventory' },
  topology: { ru: 'Топология', en: 'Topology' },
  terminal: { ru: 'Консоль CLI', en: 'CLI Console' },
  settings: { ru: 'Настройки', en: 'Configuration' },
  users: { ru: 'Пользователи', en: 'User Management' },
  mainManagement: { ru: 'Основное управление', en: 'Main Management' },
  logout: { ru: 'Выйти', en: 'Log out' },

  // Dashboard
  infraOverview: { ru: 'Обзор инфраструктуры', en: 'Infrastructure Overview' },
  realtimeStatus: { ru: 'Статус системы и производительность сети в реальном времени.', en: 'Real-time system status and network performance metrics.' },
  totalSwitches: { ru: 'Всего коммутаторов', en: 'Total Switches' },
  onlineNodes: { ru: 'В сети', en: 'Online Nodes' },
  activeAlerts: { ru: 'Активные алерты', en: 'Active Alerts' },
  avgLoad: { ru: 'Средняя нагрузка', en: 'Avg Network Load' },
  throughput: { ru: 'Пропускная способность сети (Гбит/с)', en: 'Aggregate Network Throughput (Gbps)' },
  cpuLoadVendor: { ru: 'Загрузка ЦП по вендорам (%)', en: 'CPU Load by Vendor (%)' },

  // Inventory
  switchInventory: { ru: 'Инвентаризация коммутаторов', en: 'Switch Inventory' },
  manageNodes: { ru: 'Управление и мониторинг сетевых узлов по городам и зонам.', en: 'Manage and monitor all network nodes across cities and zones.' },
  registerSwitch: { ru: 'Регистрация устройства', en: 'Register Switch' },
  exportCsv: { ru: 'Экспорт CSV', en: 'Export CSV' },
  filterPlaceholder: { ru: 'Поиск по имени, IP или городу...', en: 'Filter by name, IP, or city...' },
  status: { ru: 'Статус', en: 'Status' },
  name: { ru: 'Имя', en: 'Name' },
  vendorModel: { ru: 'Вендор / Модель', en: 'Vendor / Model' },
  ipAddress: { ru: 'IP адрес', en: 'IP Address' },
  location: { ru: 'Локация (Город/Зона)', en: 'Location (City/Zone)' },
  uptime: { ru: 'Аптайм', en: 'Uptime' },
  actions: { ru: 'Действия', en: 'Actions' },
  editNode: { ru: 'Редактировать узел', en: 'Edit Network Node' },
  deviceName: { ru: 'Имя устройства', en: 'Device Name' },
  mgmntIp: { ru: 'IP управления', en: 'Management IP' },
  city: { ru: 'Город', en: 'City' },
  zone: { ru: 'Зона / Дата-центр', en: 'Zone / Data Center' },
  cancel: { ru: 'Отмена', en: 'Cancel' },
  save: { ru: 'Сохранить изменения', en: 'Save Changes' },
  completeReg: { ru: 'Завершить регистрацию', en: 'Complete Registration' },

  // Topology
  topologyVisualizer: { ru: 'Визуализатор топологии сети', en: 'Network Topology Visualizer' },
  exportJson: { ru: 'Экспорт в JSON', en: 'Export to JSON' },

  // Login
  authGateway: { ru: 'Шлюз управления инфраструктурой', en: 'Infrastructure Control Gateway' },
  authorize: { ru: 'Авторизоваться', en: 'Authorize Access' },
  opId: { ru: 'Логин / Username', en: 'Login / Username' },
  accToken: { ru: 'Пароль / Password', en: 'Password' },
  authFailed: { ru: 'ОШИБКА АВТОРИЗАЦИИ: НЕВЕРНЫЕ ДАННЫЕ', en: 'AUTHENTICATION FAILED: INVALID CREDENTIALS' },
  sysStatus: { ru: 'Статус системы', en: 'System status' },
  secured: { ru: 'Активно', en: 'Active' },

  // Settings
  sysConfig: { ru: 'Конфигурация системы', en: 'System Configuration' },
  manageInfra: { ru: 'Управление параметрами инфраструктуры, контролем доступа и распределением ресурсов.', en: 'Manage infrastructure settings, access control, and resource allocation.' },
  saveChanges: { ru: 'Сохранить изменения', en: 'Save Changes' },
  trapReceiverIp: { ru: 'IP-адрес приемника Trap', en: 'Trap Receiver IP' },
  trapReceiverPort: { ru: 'Порт приемника Trap', en: 'Trap Receiver Port' },
  autoDiscovery: { ru: 'Авто-обнаружение сети', en: 'Network Auto-Discovery' },
  discoverySubnets: { ru: 'Подсети для сканирования (через запятую)', en: 'Scanning Subnets (comma separated)' },
  snmpConfig: { ru: 'Параметры SNMP', en: 'SNMP Configuration' },
  snmpCommunity: { ru: 'SNMP Community (Read-Only)', en: 'SNMP Community (Read-Only)' },
  snmpVersion: { ru: 'Версия SNMP', en: 'SNMP Version' },
  sshCredentials: { ru: 'Учетные данные SSH (для автозаполнения)', en: 'SSH Credentials (for auto-fill)' },
  startDiscovery: { ru: 'Запустить сканирование', en: 'Start Discovery Scan' },
  resourcePlanning: { ru: 'Планирование ресурсов', en: 'Resource Planning' },
  deployGuide: { ru: 'Руководство по развертыванию (Linux)', en: 'Deployment Implementation Guide (Linux)' },

  // Terminal
  clearBuffer: { ru: 'Очистить буфер', en: 'Clear Buffer' },
  disconnect: { ru: 'Отключить', en: 'Disconnect' },
  recentConns: { ru: 'Недавние подключения', en: 'Recent Connections' },
  activeSession: { ru: 'Активная сессия:', en: 'Active Session:' },

  // User Management
  localUsers: { ru: 'Локальные пользователи', en: 'Local Users' },
  manageAccs: { ru: 'Управление правами доступа для локальных операторов.', en: 'Manage access rights for local operators.' },
  addUser: { ru: 'Добавить пользователя', en: 'Add User' },
  username: { ru: 'Имя пользователя', en: 'Username' },
  role: { ru: 'Роль', en: 'Role' },
  lastLogin: { ru: 'Последний вход', en: 'Last Login' },
  admin: { ru: 'Администратор', en: 'Administrator' },
  operator: { ru: 'Оператор', en: 'Operator' },
  viewer: { ru: 'Наблюдатель', en: 'Viewer' },
  editPermissions: { ru: 'Изменить права доступа', en: 'Edit Permissions' },
  changePassword: { ru: 'Сменить пароль', en: 'Change Password' },
  deleteUser: { ru: 'Удалить пользователя', en: 'Delete User' },
  newPassword: { ru: 'Новый пароль', en: 'New Password' },
  confirmDelete: { ru: 'Вы уверены, что хотите удалить этого пользователя?', en: 'Are you sure you want to delete this user?' },
  passwordUpdated: { ru: 'Пароль успешно обновлен', en: 'Password updated successfully' },
  roleUpdated: { ru: 'Роль пользователя обновлена', en: 'User role updated' },

  // Audit Logs
  auditLogs: { ru: 'Журнал аудита', en: 'Audit Logs' },
  trackingActions: { ru: 'Отслеживание действий пользователей и системных событий.', en: 'Tracking user actions and system events.' },
  searchLogs: { ru: 'Поиск по логам...', en: 'Search logs...' },
  timestamp: { ru: 'Временная метка', en: 'Timestamp' },
  user: { ru: 'Пользователь', en: 'User' },
  category: { ru: 'Категория', en: 'Category' },
  action: { ru: 'Действие', en: 'Action' },
  details: { ru: 'Детали', en: 'Details' },
};

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: string) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguage] = useState<Language>(() => {
    // Check local storage first on initialization
    const saved = localStorage.getItem('netnode_lang');
    return (saved as Language) || 'ru';
  });

  React.useEffect(() => {
    // Only fetch server default if user hasn't set an explicit preference
    const userPref = localStorage.getItem('netnode_lang');
    if (!userPref) {
      fetch('/api/config/system')
        .then(res => res.json())
        .then(data => {
          if (data.config && data.config.defaultLanguage) {
            setLanguage(data.config.defaultLanguage as Language);
          }
        })
        .catch(() => {});
    }
  }, []);

  const t = (key: string) => {
    if (!translations[key]) return key;
    return translations[key][language];
  };

  const handleSetLanguage = (lang: Language) => {
    setLanguage(lang);
    localStorage.setItem('netnode_lang', lang);
  };

  return (
    <LanguageContext.Provider value={{ language, setLanguage: handleSetLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useTranslation = () => {
  const context = useContext(LanguageContext);
  if (!context) throw new Error('useTranslation must be used within LanguageProvider');
  return context;
};
