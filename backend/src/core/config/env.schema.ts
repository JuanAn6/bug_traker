import { z } from 'zod';

// .default() applies to the INPUT side of a transform in Zod 3, so the default has to be
// the string form, not a boolean. Taking it as a parameter keeps call sites honest.
const bool = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(fallback)
    .transform((v) => v === 'true' || v === '1');

const int = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_URL_TEST: z.string().optional(),
  DB_POOL_SIZE: int(10),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: int(30),

  /**
   * Keeps the login page's demo-user list working and accepts any password for accounts
   * with no hash (the eight seeded users), mirroring the frontend's fake auth. Also gates
   * the destructive admin endpoints. Refused in production below.
   */
  DEMO_MODE: bool('false'),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_ROOT: z.string().default('./var/storage'),
  ATTACHMENT_RETENTION_DAYS: int(7),
  PENDING_UPLOAD_MAX_FILES: int(50),
  PENDING_UPLOAD_MAX_BYTES: int(100 * 1024 * 1024),

  SEARCH_DRIVER: z.enum(['fulltext', 'like', 'elastic']).default('fulltext'),
  CACHE_DRIVER: z.enum(['memory', 'redis']).default('memory'),
  QUEUE_DRIVER: z.enum(['in-process', 'bullmq']).default('in-process'),

  UNDO_TTL_MS: int(120_000),
  IMPORT_MAX_BYTES: int(64 * 1024 * 1024),

  SEED_NOW: z.string().datetime().default('2026-09-29T00:00:00.000Z'),
  SEED_PASSWORD: z.string().min(1).default('demo'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.DEMO_MODE) {
    throw new Error('DEMO_MODE must be false when NODE_ENV=production: it accepts any password for seeded accounts.');
  }
  return parsed.data;
}
