export type Vendor = 'HPE' | 'Aruba' | 'Cisco' | 'Juniper' | 'MikroTik' | 'Huawei' | 'Arista' | 'Unknown';

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
  cpuLoad?: number | null;
  trunkDownCount?: number;
}

export interface SiteZone {
  id: string;
  name: string;
  city: string;
}
