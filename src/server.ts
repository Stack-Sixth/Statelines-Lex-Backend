import { buildApp } from './app.js';
import { configFromEnv } from './config.js';
import { postgres } from './db.js';
const config = configFromEnv();
const db = postgres(config);
const app = await buildApp(db, config);
app.addHook('onClose', () => db.close());
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void app.close();
  });
try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
