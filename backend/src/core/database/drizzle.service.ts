import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import { sql } from 'drizzle-orm';
import mysql from 'mysql2/promise';
import * as schema from './schema';

export type Db = MySql2Database<typeof schema>;

export const DRIZZLE = Symbol('DRIZZLE');
export const DB_OPTIONS = Symbol('DB_OPTIONS');

export interface DbOptions {
  url: string;
  poolSize: number;
}

/**
 * Builds the mysql2 pool with the settings the whole design depends on.
 *
 * `timezone: 'Z'` is not optional: the filter translates date ranges to UTC instants
 * (`created >= from T00:00:00.000Z`) because the frontend compares
 * `toISOString().slice(0,10)`. If the driver reinterpreted DATETIME values in the local
 * zone, every range boundary would be off by the machine's offset.
 */
export function createPool(options: DbOptions): mysql.Pool {
  const pool = mysql.createPool({
    uri: options.url,
    connectionLimit: options.poolSize,
    timezone: 'Z',
    // DECIMAL/BIGINT as strings would leak into DTOs; there are none wide enough to need it.
    supportBigNumbers: true,
    bigNumberStrings: false,
    dateStrings: false,
    charset: 'utf8mb4_unicode_ci',
    // A statement that cannot get its locks is a bug to surface, not to wait out.
    connectTimeout: 10_000,
    waitForConnections: true,
    queueLimit: 0,
  });

  // Pin the SESSION timezone on every connection instead of requiring
  // default_time_zone='+00:00' in my.cnf. It matters for the server-side date functions the
  // filter uses — CURRENT_DATE in the overdue predicate — which would otherwise follow the
  // machine's local zone while every other boundary is computed in UTC.
  pool.on('connection', (connection) => {
    connection.query("SET time_zone = '+00:00'");
  });

  return pool;
}

export function createDb(pool: mysql.Pool): Db {
  return drizzle(pool, { schema, mode: 'default' });
}

@Injectable()
export class DrizzleService implements OnModuleDestroy {
  private readonly logger = new Logger(DrizzleService.name);
  private readonly pool: mysql.Pool;
  readonly db: Db;

  constructor(@Inject(DB_OPTIONS) options: DbOptions) {
    this.pool = createPool(options);
    this.db = createDb(this.pool);
  }

  /**
   * Verifies the connection and the two server settings the schema was built against.
   * Getting these wrong produces wrong answers rather than errors, so they are checked at
   * boot instead of being assumed.
   */
  async verify(): Promise<void> {
    const [[version]] = await this.pool.query<mysql.RowDataPacket[]>('SELECT VERSION() AS v');
    this.logger.log(`connected to ${String(version?.['v'])}`);

    const [[tz]] = await this.pool.query<mysql.RowDataPacket[]>(
      "SELECT @@session.time_zone AS tz, @@session.sql_mode AS mode",
    );
    if (tz?.['tz'] !== '+00:00' && tz?.['tz'] !== 'UTC') {
      this.logger.warn(
        `session time_zone is ${String(tz?.['tz'])}, not UTC. Date-range filters assume UTC; ` +
          `set default_time_zone='+00:00' in my.cnf.`,
      );
    }

    const [[coll]] = await this.pool.query<mysql.RowDataPacket[]>(
      'SELECT @@collation_database AS c',
    );
    if (coll?.['c'] !== 'utf8mb4_unicode_ci') {
      this.logger.warn(
        `database collation is ${String(coll?.['c'])}, expected utf8mb4_unicode_ci. ` +
          `Accent-insensitive LIKE comparisons depend on it.`,
      );
    }
  }

  /** True when the FULLTEXT indexes the search adapter needs are present. */
  async hasFulltextIndexes(): Promise<boolean> {
    const rows = await this.db.execute(sql`
      SELECT COUNT(*) AS n FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND INDEX_TYPE = 'FULLTEXT'
        AND INDEX_NAME IN ('ft_issue_search', 'ft_comment_search')
    `);
    const first = (rows as unknown as Array<Array<{ n: number | string }>>)[0]?.[0];
    return Number(first?.n ?? 0) >= 2;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
