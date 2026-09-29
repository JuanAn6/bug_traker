import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type { Env } from '../../core/config/env.schema';
import { DRIZZLE, type Db } from '../../core/database/drizzle.service';
import * as s from '../../core/database/schema';
import type { AccessTokenClaims, AuthUser, TokenPair } from './auth.types';

/** "15m" | "2h" | "7d" | "3600" -> seconds. Unparseable values fall back to 15 minutes. */
function parseDuration(value: string): number {
  const m = /^(\d+)\s*([smhd])?$/.exec(value.trim());
  if (!m) return 900;
  const unit = (m[2] ?? 's') as 's' | 'm' | 'h' | 'd';
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86_400 }[unit];
}

/** Refresh tokens are opaque random strings; only their digest is ever stored. */
const digest = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface RefreshOutcome {
  userId: number;
  family: string;
}

/** Thrown for every refresh failure, so the caller cannot leak which one it was. */
export class InvalidRefreshTokenError extends Error {}

@Injectable()
export class TokenService {
  /**
   * Seconds, not the "15m" string. @types/jsonwebtoken types `expiresIn` as a template
   * literal union from `ms`, which a plain string does not satisfy — and parsing once here
   * means the value is not re-parsed on every issue().
   */
  private readonly accessTtlSeconds: number;
  private readonly refreshDays: number;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly jwt: JwtService,
    config: ConfigService<Env, true>,
  ) {
    this.accessTtlSeconds = parseDuration(config.get('ACCESS_TOKEN_TTL', { infer: true }));
    this.refreshDays = config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true });
  }

  async issue(
    user: AuthUser & { tokenVersion: number },
    context: { userAgent?: string; ip?: string },
    // Typed explicitly: randomUUID()'s return type is a template literal, which would stop
    // a plain string read back from the database being passed on refresh.
    family: string = randomUUID(),
  ): Promise<TokenPair> {
    const claims: AccessTokenClaims = {
      sub: user.id,
      username: user.username,
      lvl: user.accessLevel,
      ver: user.tokenVersion,
    };
    const accessToken = await this.jwt.signAsync(claims, { expiresIn: this.accessTtlSeconds });

    const refreshToken = randomBytes(32).toString('base64url');
    const refreshExpiresAt = new Date(Date.now() + this.refreshDays * 86_400_000);
    await this.db.insert(s.refreshTokens).values({
      userId: user.id,
      tokenHash: digest(refreshToken),
      family,
      userAgent: context.userAgent?.slice(0, 255) ?? null,
      ip: context.ip?.slice(0, 45) ?? null,
      expiresAt: refreshExpiresAt,
      created: new Date(),
    });

    return { accessToken, expiresIn: this.accessTtlSeconds, refreshToken, refreshExpiresAt };
  }

  /**
   * Consumes a refresh token, rotating it.
   *
   * Reuse detection: a token that exists but was already revoked means someone is replaying a
   * stolen copy — the legitimate client rotated past it. The whole family is revoked, which
   * logs out both the thief and the victim, and the victim's next refresh fails visibly
   * rather than the theft continuing unnoticed.
   */
  async rotate(refreshToken: string): Promise<RefreshOutcome> {
    const hash = digest(refreshToken);
    const [row] = await this.db
      .select()
      .from(s.refreshTokens)
      .where(eq(s.refreshTokens.tokenHash, hash))
      .limit(1);

    if (!row) throw new InvalidRefreshTokenError('unknown token');

    if (row.revokedAt) {
      await this.revokeFamily(row.family);
      throw new InvalidRefreshTokenError('token reuse detected');
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new InvalidRefreshTokenError('expired');
    }

    await this.db
      .update(s.refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(s.refreshTokens.id, row.id));

    return { userId: row.userId, family: row.family };
  }

  async revoke(refreshToken: string): Promise<void> {
    await this.db
      .update(s.refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(s.refreshTokens.tokenHash, digest(refreshToken)), isNull(s.refreshTokens.revokedAt)));
  }

  async revokeFamily(family: string): Promise<void> {
    await this.db
      .update(s.refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(s.refreshTokens.family, family), isNull(s.refreshTokens.revokedAt)));
  }

  /** Called when a password changes or an account is disabled. */
  async revokeAllForUser(userId: number): Promise<void> {
    await this.db
      .update(s.refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(s.refreshTokens.userId, userId), isNull(s.refreshTokens.revokedAt)));
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    return this.jwt.verifyAsync<AccessTokenClaims>(token);
  }

  /** Housekeeping: revoked or expired rows serve no purpose after the refresh window. */
  async pruneExpired(): Promise<number> {
    const cutoff = new Date(Date.now() - this.refreshDays * 86_400_000);
    const result = await this.db
      .delete(s.refreshTokens)
      .where(or(lt(s.refreshTokens.expiresAt, new Date()), lt(s.refreshTokens.created, cutoff)));
    return (result as unknown as { affectedRows?: number }).affectedRows ?? 0;
  }

}
