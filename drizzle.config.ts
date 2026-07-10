import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './libs/database/src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://brigadir:brigadir@localhost:5432/brigadir',
  },
});
