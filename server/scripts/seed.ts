// Fills the database in MONGODB_URI with sample data. Wipes candles, accounts and
// commands first, so it refuses to run unless --force is given.
import { connect } from '../src/db.ts';
import { seedSample } from '../src/sample.ts';

if (!process.argv.includes('--force')) {
  console.error('This wipes symbols, candles, accounts and commands. Run again with --force.');
  process.exit(1);
}
const uri = process.env.MONGODB_URI;
if (!uri) throw new Error('Missing MONGODB_URI');
const { client, db } = await connect(uri, process.env.MONGODB_DB ?? 'dave_paul_77');
await seedSample(db);
console.log('Sample data written.');
await client.close();
