export type Vendor = 'HPE' | 'Aruba' | 'Cisco' | 'Juniper' | 'MikroTik' | 'Huawei' | 'Arista' | 'Unknown';

export type WarningReasonCode = 'device_unreachable' | 'high_cpu_load' | 'down_trunk_ports';

export interface WarningReasonDetail {
  code: WarningReasonCode;
  params?: Record<string, number | string>;
}

export interface Switch {
  id: string;
  name: string;
  zoneKey?: string;
  vendor: Vendor;
  model: string;
  category?: string;
  subcategory?: string;
  branch?: string;
  snmpTemplateId?: string;
  customOids?: string[];
  city: string;
  zone: string;
  ip: string;
  status: 'online' | 'offline' | 'warning';
  uptime: string;
  warningScore?: number;
  warningSeverity?: 'none' | 'warning' | 'critical';
  warningReasons?: string[];
  warningReasonDetails?: WarningReasonDetail[];
  cpuLoad?: number | null;
  trunkDownCount?: number;
}

export interface SiteZone {
  id: string;
  name: string;
  city: string;
}
