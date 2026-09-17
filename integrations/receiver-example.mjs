// Reference HTTP receiver. Install its schema in the receiving application's DB first.
// Run after npm run build: node integrations/receiver-example.mjs
import Fastify from 'fastify';
import 'dotenv/config';
import { postgres } from '../dist/src/db.js';
import { acceptEvent } from '../dist/src/inbox.js';
const secret = process.env.RECEIVER_WEBHOOK_SECRET;
if (!secret || secret.length < 32) throw Error('Set RECEIVER_WEBHOOK_SECRET');
if (!process.env.RECEIVER_DATABASE_URL) throw Error('Set RECEIVER_DATABASE_URL');
const db = postgres({
  databaseUrl: process.env.RECEIVER_DATABASE_URL,
  databaseSsl: process.env.RECEIVER_DATABASE_SSL !== 'false',
  databaseCa: process.env.DATABASE_CA_CERT,
  poolSize: 5,
});
const app = Fastify({ bodyLimit: 65536, logger: true });
app.removeContentTypeParser('application/json');
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) =>
  done(null, body),
);
app.post('/webhook', async (req, reply) => {
  try {
    return await acceptEvent(
      db,
      secret,
      req.body,
      String(req.headers['x-lex-timestamp'] || ''),
      String(req.headers['x-lex-signature'] || ''),
    );
  } catch (error) {
    req.log.error({ err: error }, 'Event not accepted');
    return reply.code(error.status || 503).send({ error: error.code || 'storage_unavailable' });
  }
});
app.addHook('onClose', () => db.close());
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    void app.close();
  });
await app.listen({ host: '0.0.0.0', port: Number(process.env.RECEIVER_PORT || 4000) });
