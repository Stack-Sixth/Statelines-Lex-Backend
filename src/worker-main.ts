import { setTimeout as delay } from 'node:timers/promises';
import { configFromEnv } from './config.js';
import { postgres } from './db.js';
import { DeliveryWorker } from './delivery.js';
import { webhookSender } from './webhooks.js';
const config = configFromEnv();
const db = postgres(config);
const worker = new DeliveryWorker(db, config, webhookSender(config));
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    stopping = true;
  });
try {
  while (!stopping) {
    try {
      await worker.tick();
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'Delivery sweep failed',
          error: error instanceof Error ? error.message : 'unknown',
        }),
      );
    }
    if (!stopping) await delay(config.pollMs);
  }
} finally {
  await db.close();
}
