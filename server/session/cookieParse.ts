export function parseCookieHeader(src = ""): Record<string, string> {
  return src
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, entry) => {
      const idx = entry.indexOf("=");
      if (idx <= 0) return acc;
      const key = entry.slice(0, idx).trim();
      const value = decodeURIComponent(entry.slice(idx + 1).trim());
      acc[key] = value;
      return acc;
    }, {});
}
