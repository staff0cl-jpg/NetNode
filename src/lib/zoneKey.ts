export const deriveZoneKey = (deviceName: string): string => {
  const trimmed = String(deviceName || '').trim();
  if (!trimmed) return '';
  // Collapse numeric suffix chains like SW-01-02, SW_01, SW01, TRK 1.
  const normalized = trimmed
    .replace(/(?:[\s._-]*\d+)+$/, '')
    .replace(/[\s._-]+$/, '')
    .trim();
  return normalized || trimmed;
};
