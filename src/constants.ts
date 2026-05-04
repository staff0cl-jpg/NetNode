import { Switch } from './types';

export const VENDORS: string[] = ['Cisco', 'Juniper', 'HPE', 'MikroTik', 'Huawei', 'Arista'];

export const MODELS: Record<string, string[]> = {
  Cisco: ['Catalyst 9300', 'Catalyst 9200', 'Nexus 93180YC', 'ASR 1001-X'],
  Juniper: ['EX4300', 'EX2300', 'MX204', 'QFX5120'],
  HPE: ['Aruba 2930F', 'Aruba 5406R', 'FlexFabric 5940', 'Aruba 6300M'],
  MikroTik: ['CCR2004', 'CRS326', 'RB5009', 'CCR2116'],
  Huawei: ['CloudEngine S5735', 'S6730', 'NetEngine AR6121'],
  Arista: ['7050SX3', '7280SR3', '7010T'],
};

export const INITIAL_SWITCHES: Switch[] = [
  { id: '1', name: 'CORE-SW-01', vendor: 'Cisco', model: 'Nexus 93180YC', city: 'Moscow', zone: 'DC-East', ip: '10.10.1.1', status: 'online', uptime: '12d 4h' },
  { id: '2', name: 'DISTR-SW-05', vendor: 'Juniper', model: 'EX4300', city: 'Moscow', zone: 'Floor-3', ip: '10.10.2.5', status: 'online', uptime: '45d 2h' },
  { id: '3', name: 'EDGE-SW-12', vendor: 'HPE', model: 'Aruba 2930F', city: 'St. Petersburg', zone: 'Server-Farm', ip: '192.168.1.20', status: 'warning', uptime: '2d 18h' },
  { id: '4', name: 'MGMT-SW-01', vendor: 'MikroTik', model: 'CRS326', city: 'Kazan', zone: 'Office-A', ip: '172.16.5.1', status: 'online', uptime: '150d 12h' },
];
