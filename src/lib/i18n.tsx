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
  viewAlerts: { ru: 'Показать алерты', en: 'View alerts' },
  activeAlertsDetails: { ru: 'Детали активных алертов', en: 'Active alerts details' },
  deviceAlerts: { ru: 'Алерты устройств', en: 'Device alerts' },
  trunkAlerts: { ru: 'Алерты trunk-портов', en: 'Trunk alerts' },
  noActiveAlerts: { ru: 'Активных алертов нет', en: 'No active alerts' },
  avgLoad: { ru: 'Средняя нагрузка', en: 'Avg Network Load' },
  throughput: { ru: 'Пропускная способность сети (Гбит/с)', en: 'Aggregate Network Throughput (Gbps)' },
  cpuLoadVendor: { ru: 'Загрузка ЦП по вендорам (%)', en: 'CPU Load by Vendor (%)' },
  trunkThroughputTitle: { ru: 'Пропускная способность trunk (Мбит/с)', en: 'Trunk Throughput (Mbps)' },
  trunkLoadTitle: { ru: 'Нагрузка trunk (Мбит/с)', en: 'Trunk Load (Mbps)' },
  trunkMonitorTitle: { ru: 'Монитор trunk-портов', en: 'Trunk Monitor' },
  noActiveTraffic: { ru: 'Нет активного трафика', en: 'No active traffic' },
  trendPlaceholder: { ru: '+2.4% к прошлой неделе', en: '+2.4% vs last week' },
  trunkStateUp: { ru: 'ВКЛ', en: 'UP' },
  trunkStateDown: { ru: 'ВЫКЛ', en: 'DOWN' },

  // Inventory
  switchInventory: { ru: 'Инвентаризация коммутаторов', en: 'Switch Inventory' },
  manageNodes: { ru: 'Управление и мониторинг сетевых узлов по городам и зонам.', en: 'Manage and monitor all network nodes across cities and zones.' },
  registerSwitch: { ru: 'Регистрация устройства', en: 'Register Switch' },
  exportCsv: { ru: 'Экспорт CSV', en: 'Export CSV' },
  filterPlaceholder: { ru: 'Поиск по имени, IP или городу...', en: 'Filter by name, IP, or city...' },
  status: { ru: 'Статус', en: 'Status' },
  name: { ru: 'Имя', en: 'Name' },
  vendorModel: { ru: 'Вендор / Модель', en: 'Vendor / Model' },
  categoryLabel: { ru: 'Категория', en: 'Category' },
  subcategoryLabel: { ru: 'Подкатегория', en: 'Subcategory' },
  allSubcategories: { ru: 'Все подкатегории', en: 'All Subcategories' },
  branchLabel: { ru: 'Филиал', en: 'Branch' },
  ipAddress: { ru: 'IP адрес', en: 'IP Address' },
  location: { ru: 'Локация (Город/Зона)', en: 'Location (City/Zone)' },
  uptime: { ru: 'Аптайм', en: 'Uptime' },
  actions: { ru: 'Действия', en: 'Actions' },
  addLabel: { ru: 'Добавить', en: 'Add' },
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
  ldapAuthSection: { ru: 'LDAP-аутентификация', en: 'LDAP authentication' },
  ldapAuthSectionDesc: {
    ru: 'Отдельные профили для входа администраторов и операторов (поиск учётной записи и проверка пароля по каталогу). Локальные пользователи проверяются первыми.',
    en: 'Separate profiles for administrator and operator sign-in (directory lookup and password bind). Local users are checked first.',
  },
  ldapAdminProfile: { ru: 'Профиль: администраторы', en: 'Profile: administrators' },
  ldapOperatorProfile: { ru: 'Профиль: операторы', en: 'Profile: operators' },
  ldapEnabled: { ru: 'Включить LDAP для этой роли', en: 'Enable LDAP for this role' },
  ldapUrl: { ru: 'URL сервера (ldap:// или ldaps://)', en: 'Server URL (ldap:// or ldaps://)' },
  ldapBindDn: { ru: 'Сервисная учётная запись (Bind DN)', en: 'Service account (Bind DN)' },
  ldapBindPassword: { ru: 'Пароль Bind DN', en: 'Bind DN password' },
  ldapSearchBase: { ru: 'База поиска (Search Base)', en: 'Search base' },
  ldapSearchFilter: { ru: 'Фильтр поиска', en: 'Search filter' },
  ldapSearchFilterHint: {
    ru: 'Подставьте {{username}} — логин с формы входа (например (sAMAccountName={{username}}) для AD).',
    en: 'Use {{username}} for the login from the sign-in form (e.g. (sAMAccountName={{username}}) for AD).',
  },
  ldapTlsInsecure: { ru: 'LDAPS: не проверять сертификат (только для отладки)', en: 'LDAPS: skip certificate verification (debug only)' },
  ldapSave: { ru: 'Сохранить LDAP', en: 'Save LDAP settings' },
  ldapSaved: { ru: 'Настройки LDAP сохранены', en: 'LDAP settings saved' },
  ldapTestConnection: { ru: 'Проверить соединение', en: 'Test connection' },
  ldapTestUserLogin: { ru: 'Проверить вход пользователя', en: 'Test user login' },
  ldapTestAccount: { ru: 'Логин для проверки входа', en: 'Test account username' },
  ldapTestPasswordField: { ru: 'Пароль для проверки', en: 'Test account password' },
  autoLayout: { ru: 'Авторазметка', en: 'Auto layout' },
  topologyCanvasHint: {
    ru: 'Связи строятся по данным обнаружения. Ручное перетаскивание сохраняется; «Авторазметка» перезагружает связи и сохраненные позиции.',
    en: 'Links are based on discovery data. Manual drag positions are persisted; "Auto layout" reloads links and saved positions.',
  },
  discoveryScanExplain: {
    ru: 'SNMP-сканирование по указанным IPv4-подсетям (до 1024 адресов за запуск). Уже известные IP пропускаются.',
    en: 'SNMP scan on listed IPv4 subnets (up to 1024 addresses per run). Known IPs are skipped.',
  },
  discoveryScanned: { ru: 'Проверено адресов', en: 'Addresses scanned' },
  discoverySshOpen: { ru: 'Порт 22 открыт', en: 'Port 22 open' },
  discoveryAdded: { ru: 'Добавлено в инвентарь', en: 'Added to inventory' },
  sshSessionPassword: { ru: 'Пароль SSH', en: 'SSH password' },
  sshPasswordPlaceholder: { ru: 'Пароль устройства', en: 'Device password' },
  sshPasswordEditHint: { ru: 'Оставьте пустым, чтобы не менять сохранённый пароль', en: 'Leave blank to keep the saved password' },
  sshPasswordStoredHint: {
    ru: 'Сохраняется в браузере (localStorage) только для этой рабочей станции. Для продакшена используйте jump host или SSO.',
    en: 'Stored in the browser (localStorage) for this workstation only. For production, prefer a jump host or SSO.',
  },
  sshPasswordModalTitle: { ru: 'Пароль SSH для подключения', en: 'SSH password required' },
  sshSavePasswordInSession: { ru: 'Сохранить пароль в профиле сессии', en: 'Save password in this session profile' },
  sshConnectBtn: { ru: 'Подключиться', en: 'Connect' },
  startDiscovery: { ru: 'Запустить сканирование', en: 'Start Discovery Scan' },
  resourcePlanning: { ru: 'Планирование ресурсов', en: 'Resource Planning' },
  deployGuide: { ru: 'Руководство по развертыванию (Linux)', en: 'Deployment Implementation Guide (Linux)' },
  snmpTemplatesTitle: { ru: 'Шаблоны SNMP (в стиле Zabbix)', en: 'SNMP Templates (Zabbix-like)' },
  saveTemplate: { ru: 'Сохранить шаблон', en: 'Save Template' },
  existingTemplates: { ru: 'Существующие шаблоны', en: 'Existing Templates' },
  deleteTemplate: { ru: 'Удалить шаблон', en: 'Delete Template' },
  dashboardCustomization: { ru: 'Кастомизация дашборда', en: 'Dashboard customization' },
  showTrunkMonitor: { ru: 'Показывать блок trunk-монитора', en: 'Show trunk monitor block' },
  addPanel: { ru: 'Добавить панель', en: 'Add panel' },
  presetNoc: { ru: 'Пресет: NOC', en: 'Preset: NOC' },
  presetTraffic: { ru: 'Пресет: Трафик', en: 'Preset: Traffic' },
  presetCapacity: { ru: 'Пресет: Емкость', en: 'Preset: Capacity' },
  panelSettings: { ru: 'Настройки панели', en: 'Panel settings' },
  deletePanel: { ru: 'Удалить панель', en: 'Delete panel' },
  moveUp: { ru: 'Переместить вверх', en: 'Move up' },
  moveDown: { ru: 'Переместить вниз', en: 'Move down' },
  saveTemporaryProfile: { ru: 'Сохранить временный профиль', en: 'Save temporary profile' },
  discoveryWatchStatusTitle: { ru: 'Статус watch-планировщика', en: 'Watch scheduler status' },
  discoveryWatchEngine: { ru: 'Движок', en: 'Engine' },
  discoveryWatchEngineActive: { ru: 'активен (внутренний таймер процесса, тик 60с)', en: 'active (in-process timer, 60s tick)' },
  discoveryWatchEngineInactive: { ru: 'неактивен', en: 'inactive' },
  discoveryWatchRunningNow: { ru: 'Выполняется сейчас', en: 'Running now' },
  yes: { ru: 'да', en: 'yes' },
  no: { ru: 'нет', en: 'no' },
  enabledProfiles: { ru: 'Активных профилей', en: 'Enabled profiles' },
  lastSchedulerTick: { ru: 'Последний тик планировщика', en: 'Last scheduler tick' },
  lastProcessedProfiles: { ru: 'Обработано профилей на последнем цикле', en: 'Last processed profiles' },
  nextRuns: { ru: 'Следующие запуски', en: 'Next runs' },
  cloneCurrentConfig: { ru: 'Клонировать текущую конфигурацию', en: 'Clone current config' },
  discoveryProbeNote: {
    ru: 'Примечание: discovery работает только по SNMP. Топология строится по SNMP + LLDP данным.',
    en: 'Note: discovery is SNMP-only. Topology is built from SNMP + LLDP data.',
  },
  customMetricPanel: { ru: 'Панель пользовательской метрики', en: 'Custom metric panel' },
  title: { ru: 'Заголовок', en: 'Title' },
  panelType: { ru: 'Тип панели', en: 'Panel type' },
  panelTypeKpiCards: { ru: 'KPI карточки', en: 'KPI cards' },
  panelTypeTrafficLine: { ru: 'Линия трафика trunk', en: 'Trunk traffic line' },
  panelTypeLoadBars: { ru: 'Столбцы нагрузки trunk', en: 'Trunk load bars' },
  panelTypeMonitorList: { ru: 'Список мониторинга trunk', en: 'Trunk monitor list' },
  panelTypeCustomMetricBars: { ru: 'Столбцы пользовательской метрики', en: 'Custom metric bars' },
  linkedSwitch: { ru: 'Связанный коммутатор', en: 'Linked switch' },
  allSwitches: { ru: 'Все коммутаторы', en: 'All switches' },
  metricKey: { ru: 'Ключ метрики', en: 'Metric key' },
  panelEnabled: { ru: 'Панель включена', en: 'Panel enabled' },
  inventoryDictionaries: { ru: 'Словари инвентаря', en: 'Inventory Dictionaries' },
  categoriesCommaSeparated: { ru: 'Категории (через запятую)', en: 'Categories (comma separated)' },
  subcategoriesCommaSeparated: { ru: 'Подкатегории (через запятую)', en: 'Subcategories (comma separated)' },
  branchesCommaSeparated: { ru: 'Филиалы (через запятую)', en: 'Branches (comma separated)' },
  citiesCommaSeparated: { ru: 'Города (через запятую)', en: 'Cities (comma separated)' },
  zonesCommaSeparated: { ru: 'Зоны (через запятую)', en: 'Zones (comma separated)' },
  vendorsCommaSeparated: { ru: 'Вендоры (через запятую)', en: 'Vendors (comma separated)' },
  manageCategoriesInSettings: { ru: 'Управляйте категориями в Настройках.', en: 'Manage categories in Settings.' },
  manageBranchesInSettings: { ru: 'Управляйте филиалами в Настройках.', en: 'Manage branches in Settings.' },
  allBranches: { ru: 'Все филиалы', en: 'All branches' },
  inventoryTabSwitches: { ru: 'Коммутаторы', en: 'Switches' },
  inventoryTabRouters: { ru: 'Маршрутизаторы', en: 'Routers' },
  inventoryTabFc: { ru: 'FC коммутаторы', en: 'FC switches' },
  inventoryTabUps: { ru: 'ИБП', en: 'UPS' },
  inventoryTabAllWithoutOther: { ru: 'Все (кроме Прочее)', en: 'All (without Other)' },
  topologyModeIp: { ru: 'L2/L3', en: 'L2/L3' },
  topologyModeFc: { ru: 'FC', en: 'FC' },

  // Terminal
  sessions: { ru: 'Сессии', en: 'Sessions' },
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
