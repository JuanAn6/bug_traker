/**
 * Applies the migrations in ./drizzle.
 *
 * Not `drizzle-kit migrate`, because the migration files are hand-extended with FULLTEXT
 * indexes and charset conversions and we want the same runner in CI, in tests and locally,
 * against whichever URL is passed in.
 *
 *   npm run db:migrate                 # DATABASE_URL
 *   npm run db:migrate -- --test       # DATABASE_URL_TEST
 */
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { createDb, createPool } from '../src/core/database/drizzle.service';

try {
  process.loadEnvFile();
} catch {
  /* CI provides the environment directly */
}

const useTest = process.argv.includes('--test');
const url = useTest ? process.env['DATABASE_URL_TEST'] : process.env['DATABASE_URL'];

if (!url) {
  console.error(`Missing ${useTest ? 'DATABASE_URL_TEST' : 'DATABASE_URL'}. Copy .env.example to .env.`);
  process.exit(1);
}

async function main(): Promise<void> {
  const pool = createPool({ url: url!, poolSize: 1 });
  const db = createDb(pool);
  try {
    console.log(`migrating ${url!.replace(/\/\/[^@]*@/, '//***@')}`);
    await migrate(db, { migrationsFolder: './drizzle' });
    console.log('migrations applied');
  } finally {
    await pool.end();
  }
}

/** Drizzle's migrator wraps driver errors, so the useful text is down the cause chain. */
function rootMessage(e: unknown): string {
  const seen = new Set<unknown>();
  let current = e;
  let last = String(e);
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    last = current.message;
    if (!current.cause) break;
    current = current.cause;
  }
  return current instanceof Error ? current.message : last;
}

main().catch((e: unknown) => {
  const message = rootMessage(e);
  if (/ECONNREFUSED|ENOENT|ER_ACCESS_DENIED|ER_BAD_DB/.test(message)) {
    console.error(
      `\nCannot reach MariaDB (${message}).\n` +
        `XAMPP's server is probably stopped, or the database does not exist yet:\n` +
        `  sudo /opt/lampp/lampp startmysql\n` +
        `  /opt/lampp/bin/mysql -u root -e "CREATE DATABASE bugtracker CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"\n`,
    );
  } else {
    console.error(message);
  }
  process.exit(1);
});
