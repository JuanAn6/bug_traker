import { defineConfig } from 'drizzle-kit';

// Node 20.6+ reads .env natively; no dotenv dependency needed for tooling scripts.
try {
  process.loadEnvFile();
} catch {
  /* no .env yet: drizzle-kit commands that do not touch the DB still work */
}

/**
 * MariaDB 10.4 speaks the mysql dialect. Migrations land in ./drizzle as plain .sql
 * files that we edit by hand to add the FULLTEXT indexes and the utf8mb4_unicode_ci
 * conversions — neither is expressible in the schema DSL, and having editable SQL is a
 * large part of why Drizzle suits this project.
 */
export default defineConfig({
  dialect: 'mysql',
  schema: './src/core/database/schema/index.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  strict: true,
  verbose: true,
});
