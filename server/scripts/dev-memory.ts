// Local development without MongoDB installed: starts an in-memory MongoDB, fills it
// with sample data and runs the API. Data is lost when the process stops.
// Web login password: admin. EA keys: see SAMPLE_KEYS in src/sample.ts.
import bcrypt from 'bcryptjs';
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongo = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongo.getUri();
process.env.JWT_SECRET ??= 'dev-only-secret';
process.env.ADMIN_PASSWORD_HASH ??= bcrypt.hashSync('admin', 10);
process.env.EA_DATA_KEY ??= 'dev-data-key';
process.env.CORS_ORIGIN ??= 'http://localhost:5173';

const { connect } = await import('../src/db.ts');
const { seedSample } = await import('../src/sample.ts');
const { client, db } = await connect(process.env.MONGODB_URI, 'dave_paul_77');
await seedSample(db);
await client.close();
console.log('In-memory MongoDB seeded with sample data. Web password: admin');

await import('../src/server.ts');
process.on('exit', () => void mongo.stop());
