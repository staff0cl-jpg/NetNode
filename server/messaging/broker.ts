import { connect as amqpConnect } from "amqplib";

type ChannelModel = Awaited<ReturnType<typeof amqpConnect>>;
type AmqpChannel = Awaited<ReturnType<ChannelModel["createChannel"]>>;

let channelModel: ChannelModel | null = null;
let ch: AmqpChannel | null = null;
let exchangeReady = false;
const EXCHANGE = "netnode.events";

let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempt = 0;
let amqpShuttingDown = false;

function amqpUrl(): string | undefined {
  return process.env.AMQP_URL?.trim() || process.env.RABBITMQ_URL?.trim() || undefined;
}

function scheduleReconnect(): void {
  if (amqpShuttingDown) return;
  const url = amqpUrl();
  if (!url) return;
  if (reconnectTimer) return;
  const base = 800;
  const cap = 30_000;
  const delay = Math.min(cap, base * 2 ** Math.min(reconnectAttempt, 6));
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void ensureChannel();
  }, delay);
}

async function ensureChannel(): Promise<AmqpChannel | null> {
  const url = amqpUrl();
  if (!url) return null;
  try {
    if (!channelModel) {
      channelModel = await amqpConnect(url);
      reconnectAttempt = 0;
      channelModel.on("error", (err: Error) => {
        console.error("[amqp] connection error:", err?.message || err);
        ch = null;
        exchangeReady = false;
      });
      channelModel.on("close", () => {
        ch = null;
        channelModel = null;
        exchangeReady = false;
        scheduleReconnect();
      });
    }
    if (!ch) {
      ch = await channelModel.createChannel();
      await ch.assertExchange(EXCHANGE, "topic", { durable: true });
      exchangeReady = true;
    }
    return ch;
  } catch (e) {
    console.error("[amqp] connect/publish failed:", e instanceof Error ? e.message : e);
    ch = null;
    channelModel = null;
    exchangeReady = false;
    scheduleReconnect();
    return null;
  }
}

/**
 * Publishes a JSON message to the topic exchange `netnode.events`.
 * Routing keys are dotted, e.g. `inventory.persisted`, `topology.persisted`.
 * No-op when AMQP_URL / RABBITMQ_URL is unset.
 */
export async function publishAmqpJson(routingKey: string, payload: unknown): Promise<void> {
  const channel = await ensureChannel();
  if (!channel || !exchangeReady) return;
  try {
    const body = Buffer.from(JSON.stringify({ v: 1, ts: new Date().toISOString(), routingKey, payload }), "utf8");
    channel.publish(EXCHANGE, routingKey, body, { contentType: "application/json", persistent: true });
  } catch (e) {
    console.error("[amqp] publish failed:", e instanceof Error ? e.message : e);
    try {
      await ch?.close();
    } catch {
      /* ignore */
    }
    ch = null;
    exchangeReady = false;
    try {
      await channelModel?.close();
    } catch {
      /* ignore */
    }
    channelModel = null;
    scheduleReconnect();
  }
}

export async function closeAmqp(): Promise<void> {
  amqpShuttingDown = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    await ch?.close();
  } catch {
    /* ignore */
  }
  try {
    await channelModel?.close();
  } catch {
    /* ignore */
  }
  ch = null;
  channelModel = null;
  exchangeReady = false;
  amqpShuttingDown = false;
}
