import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { connect } from './db.ts';

const config = loadConfig();
const { client, db } = await connect(config.mongoUri, config.dbName);
const server = createApp(db, config).listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => void client.close());
  });
}
