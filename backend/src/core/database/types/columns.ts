import { customType, date, datetime, mysqlEnum } from 'drizzle-orm/mysql-core';

/**
 * TipTap JSON stored as LONGTEXT.
 *
 * Deliberately NOT a `json` column: on MariaDB 10.4 `JSON` is an alias for LONGTEXT with
 * a `json_valid()` CHECK bolted on, it cannot be indexed, and nothing here is ever
 * queried by content — that is what the denormalized `searchNorm` columns are for.
 */
export const jsonLongtext = <T>(name: string) =>
  customType<{ data: T; driverData: string }>({
    dataType: () => 'longtext',
    toDriver: (value) => JSON.stringify(value),
    fromDriver: (value) => JSON.parse(value) as T,
  })(name);

/**
 * Every timestamp is DATETIME(3). Millisecond precision is REQUIRED, not cosmetic: the
 * frontend sorts and compares ISO strings, and seed.ts generates marks with fractional
 * days (`iso(1 + uid / 10)`), so at second precision the history ordering collapses and
 * the ported ordering tests fail.
 */
export const ts = (name: string) => datetime(name, { fsp: 3, mode: 'date' });

/**
 * Date-only columns as 'YYYY-MM-DD' strings — exactly the shape the frontend already
 * uses for `dueDate`, `Sprint.start/end` and `ProjectVersion.date`. Returning strings
 * means no serialization layer and no timezone reinterpretation on the way out.
 */
export const day = (name: string) => date(name, { mode: 'string' });

/**
 * MySQL ENUM from one of the canonical arrays in shared/config.ts.
 *
 * The declaration order matters twice over: MariaDB stores the ordinal, so raw SQL
 * `ORDER BY status` already equals `statusRank`; and the *Rank columns derive from the
 * same array indexes. Never reorder these arrays without a migration.
 */
export const enumCol = <T extends string>(name: string, values: readonly T[]) =>
  mysqlEnum(name, values as unknown as [T, ...T[]]);
