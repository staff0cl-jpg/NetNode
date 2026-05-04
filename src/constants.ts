import { Switch } from './types';

export const INITIAL_SWITCHES: Switch[] = [
  { id: '1', name: 'CORE-SW-01', vendor: 'Cisco', model: 'Catalyst 9300', city: 'Moscow', zone: 'DC-East', ip: '10.10.1.1', status: 'online', uptime: '12d 4h' },
  { id: '2', name: 'ACC-SW-05', vendor: 'Aruba', model: 'CX 6300', city: 'Moscow', zone: 'Floor-3', ip: '10.10.2.5', status: 'online', uptime: '45d 2h' },
  { id: '3', name: 'HPE-ENT-02', vendor: 'HPE', model: 'FlexFabric 5940', city: 'St. Petersburg', zone: 'Server-Farm', ip: '192.168.1.20', status: 'warning', uptime: '2d 18h' },
  { id: '4', name: 'ARUBA-WIFI-01', vendor: 'Aruba', model: '2930F', city: 'Kazan', zone: 'Office-A', ip: '172.16.5.1', status: 'online', uptime: '150d 12h' },
  { id: '5', name: 'CS-AGG-01', vendor: 'Cisco', model: 'Nexus 9000', city: 'Novosibirsk', zone: 'Agg-Zone', ip: '10.50.0.1', status: 'offline', uptime: '0d 0h' },
  { id: '6', name: 'SW-BRANCH-01', vendor: 'HPE', model: 'Aruba 2530', city: 'Krasnodar', zone: 'Branch-Office', ip: '10.60.1.10', status: 'online', uptime: '8d 5h' },
];

export const VENDORS: string[] = ['HPE', 'Aruba', 'Cisco'];
export const MODELS: Record<string, string[]> = {
  HPE: ['FlexFabric 5940', 'Altoline 6900', 'OfficeConnect 1920'],
  Aruba: ['CX 6300', '2930F', '5400R', '2530'],
  Cisco: ['Catalyst 9300', 'Nexus 9000', 'Catalyst 2960X']
};
