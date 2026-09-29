/** Vitest does not read .env on its own; integration and e2e suites need the DB URL. */
try {
  process.loadEnvFile();
} catch {
  /* CI provides the environment directly */
}
// Every date-range predicate is built in UTC, matching the frontend's toISOString().slice(0,10).
process.env['TZ'] = 'UTC';
