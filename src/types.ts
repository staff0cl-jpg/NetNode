export type Vendor = 'HPE' | 'Aruba' | 'Cisco';

export interface Switch {
  id: string;
  name: string;
  vendor: Vendor;
  model: string;
  city: string;
  zone: string;
  ip: string;
  status: 'online' | 'offline' | 'warning';
  uptime: string;
}

export interface SiteZone {
  id: string;
  name: string;
  city: string;
}
