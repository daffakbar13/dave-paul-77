// Local development without MongoDB installed: starts an in-memory MongoDB, fills it
// with sample data and runs the API. Data is lost when the process stops.
// --empty skips the sample data (testing with the real MT4 EA, e.g. through ngrok).
// --data <file> replaces the sample candles and lines with a JSON dump of real ones:
// { SYMBOL: { digits, manualLines, candles: [{ t, o, h, l, c }] } } (t in ms).
// The calendar uses fixed sample news, since every restart starts with an empty cache
// and would call the real feed again (that got us rate-limited); --live-news uses .env.
// Values from .env are used when present; otherwise web password `admin`,
// EA_DATA_KEY `dev-data-key`, sample EA keys in SAMPLE_KEYS (src/sample.ts).
import { readFileSync } from 'node:fs';
import bcrypt from 'bcryptjs';
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongo = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongo.getUri();
process.env.JWT_SECRET ||= 'dev-only-secret';
process.env.ADMIN_PASSWORD_HASH ||= bcrypt.hashSync('admin', 10);
process.env.EA_DATA_KEY ||= 'dev-data-key';
process.env.CORS_ORIGIN ||= 'http://localhost:5173';
if (!process.argv.includes('--live-news')) process.env.NEWS_SOURCE = 'sample';

const { connect } = await import('../src/db.ts');
const { seedSample } = await import('../src/sample.ts');
const { client, db } = await connect(process.env.MONGODB_URI, 'dave_paul_77');
if (process.argv.includes('--empty')) {
  console.log('In-memory MongoDB started empty: waiting for the MT4 EA.');
} else {
  await seedSample(db);
  console.log('In-memory MongoDB seeded with sample data.');
}
const dataFile = process.argv[process.argv.indexOf('--data') + 1];
if (process.argv.includes('--data') && dataFile) {
  type Dump = Record<string, { digits: number; manualLines: number[]; candles: { t: number; o: number; h: number; l: number; c: number }[] }>;
  const dump: Dump = JSON.parse(readFileSync(dataFile, 'utf8'));
  for (const [symbol, d] of Object.entries(dump)) {
    await db.symbols.updateOne({ name: symbol }, { $set: { digits: d.digits, manualLines: d.manualLines, active: true } });
    await db.candles.deleteMany({ symbol });
    await db.candles.insertMany(d.candles.map((c) => ({ symbol, t: new Date(c.t), o: c.o, h: c.h, l: c.l, c: c.c })));
    const last = d.candles[d.candles.length - 1];
    if (last) await db.quotes.updateOne({ _id: symbol }, { $set: { bid: last.c, ask: last.c, at: new Date() } }, { upsert: true });
  }
  await db.analyses.deleteMany({});
  console.log(`Loaded real candles for ${Object.keys(dump).length} symbols from ${dataFile}.`);
}
await client.close();

await import('../src/server.ts');
process.on('exit', () => void mongo.stop());
