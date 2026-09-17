import 'dotenv/config';
import { z } from 'zod';
const secret = z
  .string()
  .min(32)
  .refine((s) => !s.includes('REPLACE_'), 'Generate an actual secret');
export const roleSchema = z.enum(['admin', 'operator', 'merchant', 'carrier', 'platform']);
export type Role = z.infer<typeof roleSchema>;
const clientsSchema = z
  .array(z.object({ id: z.string().min(1), secret, roles: z.array(roleSchema).min(1) }))
  .min(1);
export interface Config {
  databaseUrl: string;
  databaseSsl: boolean;
  databaseCa?: string;
  poolSize: number;
  port: number;
  host: string;
  logLevel: string;
  clients: z.infer<typeof clientsSchema>;
  webhookSecrets: Record<string, string>;
  allowedHosts: string[];
  pollMs: number;
  batchSize: number;
  maxAttempts: number;
}
export function configFromEnv(env = process.env): Config {
  const raw = z
    .object({
      DATABASE_URL: z.string().url(),
      DATABASE_SSL: z.enum(['true', 'false']).default('true'),
      DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(50).default(5),
      PORT: z.coerce.number().int().min(1).max(65535).default(3000),
      HOST: z.string().default('0.0.0.0'),
      LOG_LEVEL: z
        .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
        .default('info'),
      WORKER_POLL_MS: z.coerce.number().int().min(100).max(60000).default(2000),
      WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
      DELIVERY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
    })
    .parse(env);
  const clients = clientsSchema.parse(JSON.parse(env.API_CLIENTS_JSON || '[]'));
  if (new Set(clients.map((c) => c.id)).size !== clients.length)
    throw Error('Duplicate API client IDs');
  if (env.NODE_ENV === 'production' && raw.DATABASE_SSL !== 'true')
    throw Error('Production requires verified database TLS');
  return {
    databaseUrl: raw.DATABASE_URL,
    databaseSsl: raw.DATABASE_SSL === 'true',
    databaseCa: env.DATABASE_CA_CERT,
    poolSize: raw.DATABASE_POOL_SIZE,
    port: raw.PORT,
    host: raw.HOST,
    logLevel: raw.LOG_LEVEL,
    clients,
    webhookSecrets: z
      .record(z.string(), secret)
      .parse(JSON.parse(env.WEBHOOK_SECRETS_JSON || '{}')),
    allowedHosts: (env.WEBHOOK_ALLOWED_HOSTS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    pollMs: raw.WORKER_POLL_MS,
    batchSize: raw.WORKER_BATCH_SIZE,
    maxAttempts: raw.DELIVERY_MAX_ATTEMPTS,
  };
}
