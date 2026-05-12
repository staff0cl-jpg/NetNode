/** Defaults seeded on first-run setup (aligned with server.ts in-memory defaults). */

export const DEFAULT_SYSTEM_CONFIG_FOR_SETUP = {
  defaultLanguage: "ru",
  siteLabel: "UNSET",
  productName: "NETNODE",
  theme: "dark" as const,
  logoDataUrl: "",
  automationDefaults: {
    batchSize: 10,
    timeoutMs: 15000,
    retry: 1,
    concurrency: 10,
    errorThreshold: 20,
  },
  dashboardUi: {
    trunkThroughputTitle: "Trunk Throughput (Mbps)",
    trunkLoadTitle: "Trunk Load (Mbps)",
    trunkMonitorTitle: "Trunk Monitor",
    showTrunkMonitor: true,
  },
};

export const DEFAULT_SNMP_TEMPLATES_FOR_SETUP = [
  {
    id: "zbx-switch-basic",
    name: "Zabbix-like Switch Basic",
    vendorHint: "Any",
    metrics: [
      { key: "uptime", oid: "1.3.6.1.2.1.1.3.0", scale: 0.01, unit: "s" },
      { key: "cpu_load", oid: "1.3.6.1.2.1.25.3.3.1.2", scale: 1, unit: "%" },
    ],
  },
  {
    id: "zbx-ups-basic",
    name: "Zabbix-like UPS Basic",
    vendorHint: "UPS",
    metrics: [{ key: "ups_uptime", oid: "1.3.6.1.2.1.1.3.0", scale: 0.01, unit: "s" }],
  },
  {
    id: "zbx-fc-sn3600b",
    name: "FC Switch SN3600B",
    vendorHint: "HPE",
    metrics: [
      { key: "fc_uptime", oid: "1.3.6.1.2.1.1.3.0", scale: 0.01, unit: "s" },
      { key: "fc_ports_total", oid: "1.3.6.1.2.1.2.1.0", scale: 1, unit: "count" },
    ],
  },
];

export const DEFAULT_DISCOVERY_PROFILES_FOR_SETUP = [
  {
    id: "default-uln-10-0-94-0-24",
    name: "ULN Default Discovery",
    subnets: "10.0.94.0/24",
    protocol: "snmp",
    city: "Ульяновск",
    zone: "Core",
    branch: "ULN",
    enabled: true,
    intervalHours: 3,
    lastRunAt: null,
    lastResult: null,
  },
];
