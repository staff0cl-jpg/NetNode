import { createClient } from "redis";
import type { SessionBackend, SessionRedisClient } from "./sessionTypes.js";
import { MemorySessionBackend } from "./memorySessionBackend.js";
import { RedisSessionBackend } from "./redisSessionBackend.js";

let backend: SessionBackend = new MemorySessionBackend();
let redisClient: SessionRedisClient | null = null;

export async function initSessionRuntime(): Promise<void> {
  const url = process.env.REDIS_URL?.trim() || process.env.NETNODE_REDIS_URL?.trim();
  if (!url) {
    backend = new MemorySessionBackend();
    console.log("[session] backend=memory (set REDIS_URL or NETNODE_REDIS_URL for Redis)");
    return;
  }
  const client = createClient({ url }) as unknown as SessionRedisClient;
  client.on("error", (err) => console.error("[redis] session client:", err.message));
  await client.connect();
  redisClient = client;
  backend = new RedisSessionBackend(client);
  console.log("[session] backend=redis");
}

export function getSessionBackend(): SessionBackend {
  return backend;
}

export async function shutdownSessionRuntime(): Promise<void> {
  if (redisClient) {
    try {
      await redisClient.quit();
    } catch {
      /* ignore */
    }
    redisClient = null;
  }
}
