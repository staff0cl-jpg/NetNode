export const deriveZoneKey = (deviceName: string): string => {
  const trimmed = String(deviceName || '').trim();
  if (!trimmed) return '';
  const normalized = trimmed.replace(/[\s_-]+\d+$/, '').trim();
  return normalized || trimmed;
};
