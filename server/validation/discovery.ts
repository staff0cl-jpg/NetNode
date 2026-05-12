import { z } from "zod";

export const discoveryStartBodySchema = z.object({
  subnets: z.string().trim().min(1).max(10_000),
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
  profiles: z.array(discoveryWatchProfileSchema).max(500),
});

export type DiscoveryStartBody = z.infer<typeof discoveryStartBodySchema>;

