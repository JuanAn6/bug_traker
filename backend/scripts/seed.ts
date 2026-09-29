/**
 * Loads the demo dataset.
 *
 * It does not reimplement anything: it calls the frontend's own createSeed() (copied
 * verbatim into src/shared) and pipes the result through the same ingestDb() that
 * POST /admin/import uses. So every seed run is also a test of the importer, against 80
 * issues with relationships, private notes, mentions and notifications.
 *
 *   npm run db:seed                 # DATABASE_URL
 *   npm run db:seed -- --test       # DATABASE_URL_TEST
 */
import { hash } from '@node-rs/argon2';
import { createSeed } from '../src/shared/seed';
import { createDb, createPool } from '../src/core/database/drizzle.service';
import { ingestDb } from '../src/modules/admin/db-import';

try {
  process.loadEnvFile();
} catch {
  /* CI provides the environment directly */
}

const useTest = process.argv.includes('--test');
const url = useTest ? process.env['DATABASE_URL_TEST'] : process.env['DATABASE_URL'];
const seedNow = process.env['SEED_NOW'] ?? '2026-09-29T00:00:00.000Z';
const password = process.env['SEED_PASSWORD'] ?? 'demo';

async function main(): Promise<void> {
  if (!url) throw new Error(`Missing ${useTest ? 'DATABASE_URL_TEST' : 'DATABASE_URL'}`);

  // A fixed clock is what makes the dataset reproducible. The default matches the value
  // frontend/src/app/core/issue-filter.spec.ts pins, so its concrete assertions (#7 -> id 7,
  // web-2 -> id 2, subproject 4 under project 1) hold against this database too.
  const json = createSeed(new Date(seedNow).getTime());

  // argon2id over the shared dev password, so the seeded accounts also work with
  // DEMO_MODE=false. Hashed once and reused: 8 separate hashes would cost ~2s for nothing.
  const passwordHash = await hash(password, { algorithm: 2 });

  const pool = createPool({ url, poolSize: 1 });
  const db = createDb(pool);
  try {
    const started = Date.now();
    const counts = await ingestDb(db, json, {
      mode: 'replace',
      passwordHash,
      source: `seed(${seedNow})`,
    });
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(`seeded ${total} rows in ${Date.now() - started}ms`);
    for (const [table, n] of Object.entries(counts)) {
      if (n) console.log(`  ${String(n).padStart(5)}  ${table}`);
    }
    console.log(`\nusers: ${json.users.map((u) => u.username).join(', ')}`);
    console.log(`password for all of them: ${password}`);
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
