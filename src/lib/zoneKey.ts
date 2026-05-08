const CYRILLIC_MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh',
  щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

const TRAILING_ROLE_TOKENS = new Set([
  'poe', 'sw', 'switch', 'router', 'rtr', 'gw', 'gateway', 'core', 'dist', 'distribution',
  'access', 'acc', 'agg', 'uplink', 'edge', 'lan', 'wan', 'mgmt', 'management', 'stk', 'stack',
]);

const transliterate = (input: string) =>
  input
    .toLowerCase()
    .split('')
    .map((ch) => CYRILLIC_MAP[ch] ?? ch)
    .join('');

export const deriveZoneKey = (deviceName: string): string => {
  const trimmed = String(deviceName || '').trim();
  if (!trimmed) return '';

  const ascii = transliterate(trimmed)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');

  let tokens = ascii
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);

  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1];
    if (/^\d+$/.test(last) || TRAILING_ROLE_TOKENS.has(last)) {
      tokens = tokens.slice(0, -1);
      continue;
    }
    break;
  }

  const normalized = tokens.join('-').replace(/-+/g, '-').replace(/^-|-$/g, '').trim();
  return normalized || ascii.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/-+/g, '-').replace(/^-|-$/g, '');
};
