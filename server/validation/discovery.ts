import { z } from "zod";

function ipv4OctetsOk(ip: string): boolean {
  const p = ip.trim().split(".").map((x) => parseInt(x, 10));
  return p.length === 4 && p.every((n) => Number.isFinite(n) && n >= 0 && n <= 255);
}

/** One token from discovery subnet list: IPv4 host or IPv4/prefix (8–32). */
function discoverySubnetTokenOk(token: string): boolean {
  const t = token.trim();
  if (!t) return false;
  if (!t.includes("/")) return ipv4OctetsOk(t);
  const [ipStr, prefStr] = t.split("/");
  if (!ipv4OctetsOk(ipStr.trim())) return false;
  const prefix = parseInt(prefStr, 10);
  return Number.isFinite(prefix) && prefix >= 8 && prefix <= 32;
}

function discoverySubnetsFieldOk(raw: string): boolean {
  const parts = raw
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 && parts.every(discoverySubnetTokenOk);
}

export const discoveryStartBodySchema = z.object({
  subnets: z
    .string()
    .trim()
    .min(1)
    .max(10_000)
    .refine(discoverySubnetsFieldOk, "Each entry must be an IPv4 address or IPv4 CIDR (prefix 8–32), separated by comma, semicolon, or newline"),
  protocol: z.string().max(64).optional(),
  city: z.string().max(200).optional(),
  zone: z.string().max(200).optional(),
  branch: z.string().max(200).optional(),
});

const discoveryWatchProfileSchema = z.object({
  id: z.string().max(200).optional(),
  name: z.string().max(200).optional(),
  subnets: z.string().max(10_000).optional(),
  protocol: z.string().max(64).optional(),
  city: z.string().max(200).optional(),
  zone: z.string().max(200).optional(),
  branch: z.string().max(200).optional(),
  enabled: z.boolean().optional(),
  intervalHours: z.number().finite().optional(),
  lastRunAt: z.string().max(80).nullable().optional(),
  lastResult: z.unknown().optional(),
});

export const discoveryWatchSaveBodySchema = z.object({
  profiles: z
    .array(
      discoveryWatchProfileSchema.extend({
        subnets: discoveryWatchProfileSchema.shape.subnets.refine(
          (s) => s === undefined || s === null || String(s).trim() === "" || discoverySubnetsFieldOk(String(s)),
          "Each entry must be an IPv4 address or IPv4 CIDR (prefix 8–32), separated by comma, semicolon, or newline"
        ),
      })
    )
    .max(500),
});

export type DiscoveryStartBody = z.infer<typeof discoveryStartBodySchema>;

