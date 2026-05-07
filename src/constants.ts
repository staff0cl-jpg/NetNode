import { Switch } from './types';

export const VENDORS: string[] = ['Cisco', 'Juniper', 'HPE', 'Aruba', 'MikroTik', 'Huawei', 'Arista', 'Unknown'];

export const MODELS: Record<string, string[]> = {
  Cisco: ['Catalyst 9300', 'Catalyst 9200', 'Nexus 93180YC', 'ASR 1001-X'],
  Juniper: ['EX4300', 'EX2300', 'MX204', 'QFX5120'],
  HPE: ['HP 1910', 'HP 1810', 'Aruba 2530', 'Aruba CX6000', 'Aruba 2930F', 'Aruba 5406R', 'FlexFabric 5940', 'Aruba 6300M'],
  Aruba: ['Aruba 2530', 'Aruba CX6000', 'Aruba 2930F', 'Aruba 5406R', 'Aruba 6300M'],
  MikroTik: ['CCR2004', 'CRS326', 'RB5009', 'CCR2116'],
  Huawei: ['CloudEngine S5735', 'S6730', 'NetEngine AR6121'],
  Arista: ['7050SX3', '7280SR3', '7010T'],
  Unknown: ['Discovered (SSH)', 'Generic L2'],
};

export const INITIAL_SWITCHES: Switch[] = [];
