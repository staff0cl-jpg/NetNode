import { z } from "zod";

export const loginBodySchema = z.object({
  username: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(500),
});

export const createUserBodySchema = z.object({
  username: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(500),
  role: z.enum(["admin", "operator", "viewer"]).optional(),
});

export const patchUserBodySchema = z.object({
  role: z.enum(["admin", "operator", "viewer"]).optional(),
});

export const resetPasswordBodySchema = z.object({
  password: z.string().min(1).max(500),
});
