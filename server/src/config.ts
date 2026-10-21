// Environment settings. Read once at start-up; a missing required value stops the server.

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name} (see .env.example)`);
  return value;
}

export type Config = {
  port: number;
  mongoUri: string;
  dbName: string;
  jwtSecret: string;
  adminPasswordHash: string; // bcrypt
  eaDataKey: string; // shared by the MT4 data EA
  corsOrigins: string[];
};

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 4000),
    mongoUri: required('MONGODB_URI'),
    dbName: process.env.MONGODB_DB ?? 'dave_paul_77',
    jwtSecret: required('JWT_SECRET'),
    adminPasswordHash: required('ADMIN_PASSWORD_HASH'),
    eaDataKey: required('EA_DATA_KEY'),
    corsOrigins: (process.env.CORS_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}
