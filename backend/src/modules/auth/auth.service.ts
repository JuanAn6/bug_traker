import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, sql } from 'drizzle-orm';
import type { AccessLevel } from '../../shared/models';
import type { Env } from '../../core/config/env.schema';
import { DRIZZLE, type Db } from '../../core/database/drizzle.service';
import * as s from '../../core/database/schema';
import { ConflictError, DomainError, ValidationError } from '../../common/errors/domain-error';
import type { AccessTokenClaims, AuthUser, TokenPair } from './auth.types';
import { PasswordService } from './password.service';
import { InvalidRefreshTokenError, TokenService } from './token.service';

/**
 * Every authentication failure looks the same from outside — unknown user, disabled account,
 * wrong password, expired or replayed refresh token. 401 rather than 403: the request was not
 * authenticated, as opposed to authenticated-but-not-permitted.
 */
export class LoginFailedError extends DomainError {
  readonly status = 401;
  /** The key the login page already renders: "Unknown or disabled user." */
  readonly code = 'login.invalid';
  constructor() {
    super('Authentication failed');
  }
}

export interface DemoUser {
  id: number;
  username: string;
  realName: string;
  accessLevel: AccessLevel;
  avatarColor: string;
  enabled: boolean;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly demoMode: boolean;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    config: ConfigService<Env, true>,
  ) {
    this.demoMode = config.get('DEMO_MODE', { infer: true });
    if (this.demoMode) {
      this.logger.warn('DEMO_MODE is on: accounts without a password hash accept ANY password.');
    }
  }

  /**
   * Username match is case-insensitive and trimmed, as in the frontend.
   *
   * Failures are deliberately indistinguishable: unknown user, disabled account and wrong
   * password all raise the same error with the same i18n key the login page already shows
   * ('login.invalid' — "Unknown or disabled user"). Telling them apart would turn the login
   * form into a user-enumeration oracle.
   */
  async login(
    username: string,
    password: string,
    context: { userAgent?: string; ip?: string },
  ): Promise<{ tokens: TokenPair; user: AuthUser }> {
    const row = await this.findByUsername(username.trim());
    if (!row || !row.enabled || row.deletedAt) throw new LoginFailedError();

    if (row.passwordHash) {
      if (!(await this.passwords.verify(row.passwordHash, password))) throw new LoginFailedError();
      // Transparently upgrade a hash produced with weaker parameters.
      if (this.passwords.needsRehash(row.passwordHash)) {
        await this.db
          .update(s.users)
          .set({ passwordHash: await this.passwords.hash(password) })
          .where(eq(s.users.id, row.id));
      }
    } else if (!this.demoMode) {
      // A passwordless account outside demo mode cannot authenticate at all.
      throw new LoginFailedError();
    }

    // The frontend's login has this side effect, and the status bar shows it.
    await this.db.update(s.users).set({ lastVisit: new Date() }).where(eq(s.users.id, row.id));

    const user = this.toAuthUser(row);
    return {
      user,
      tokens: await this.tokens.issue({ ...user, tokenVersion: row.tokenVersion }, context),
    };
  }

  async refresh(
    refreshToken: string,
    context: { userAgent?: string; ip?: string },
  ): Promise<{ tokens: TokenPair; user: AuthUser }> {
    let outcome;
    try {
      outcome = await this.tokens.rotate(refreshToken);
    } catch (e) {
      if (e instanceof InvalidRefreshTokenError) throw new LoginFailedError();
      throw e;
    }

    const row = await this.findById(outcome.userId);
    if (!row || !row.enabled || row.deletedAt) {
      // The account was disabled while the session was alive: kill the whole family so the
      // client stops retrying with a token that can never work again.
      await this.tokens.revokeFamily(outcome.family);
      throw new LoginFailedError();
    }

    const user = this.toAuthUser(row);
    return {
      user,
      // Same family, so reuse detection still spans the whole chain.
      tokens: await this.tokens.issue(
        { ...user, tokenVersion: row.tokenVersion },
        context,
        outcome.family,
      ),
    };
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (refreshToken) await this.tokens.revoke(refreshToken);
  }

  /** Resolves the claims in an access token to the current user, re-checking every gate. */
  async resolve(claims: AccessTokenClaims): Promise<AuthUser | null> {
    const row = await this.findById(claims.sub);
    if (!row || !row.enabled || row.deletedAt) return null;
    // A password change or a disable bumps tokenVersion, retiring tokens already in flight
    // rather than letting them run out their 15 minutes.
    if (row.tokenVersion !== claims.ver) return null;
    return this.toAuthUser(row);
  }

  async changePassword(userId: number, current: string, next: string): Promise<void> {
    if (next.length < 8) {
      // Same key the account page already renders.
      throw new ValidationError('account.passwordShort', 'Password must be at least 8 characters');
    }
    const row = await this.findById(userId);
    if (!row) throw new LoginFailedError();

    // A demo account (no hash) has nothing to verify; setting a password takes it out of
    // demo mode permanently, which is the desired direction of travel.
    if (row.passwordHash && !(await this.passwords.verify(row.passwordHash, current))) {
      throw new ConflictError('account.currentRequired');
    }

    await this.db
      .update(s.users)
      .set({
        passwordHash: await this.passwords.hash(next),
        tokenVersion: sql`${s.users.tokenVersion} + 1`,
      })
      .where(eq(s.users.id, userId));

    // Other sessions must not survive a password change.
    await this.tokens.revokeAllForUser(userId);
  }

  /**
   * The seeded-account list the login page renders as clickable cards.
   * Only served with DEMO_MODE on — otherwise it is a user directory for anonymous callers.
   */
  async demoUsers(): Promise<DemoUser[]> {
    const rows = await this.db
      .select({
        id: s.users.id,
        username: s.users.username,
        realName: s.users.realName,
        accessLevel: s.users.accessLevel,
        avatarColor: s.users.avatarColor,
        enabled: s.users.enabled,
      })
      .from(s.users);
    return rows
      .map((r) => ({ ...r, accessLevel: r.accessLevel as AccessLevel }))
      .sort((a, b) => b.accessLevel - a.accessLevel);
  }

  private async findByUsername(username: string) {
    const [row] = await this.db
      .select()
      .from(s.users)
      .leftJoin(s.userPrefs, eq(s.userPrefs.userId, s.users.id))
      // The column collation is utf8mb4_unicode_ci, so `=` is already case-insensitive.
      .where(eq(s.users.username, username))
      .limit(1);
    return row ? { ...row.users, prefs: row.userPrefs } : undefined;
  }

  private async findById(id: number) {
    const [row] = await this.db
      .select()
      .from(s.users)
      .leftJoin(s.userPrefs, eq(s.userPrefs.userId, s.users.id))
      .where(eq(s.users.id, id))
      .limit(1);
    return row ? { ...row.users, prefs: row.userPrefs } : undefined;
  }

  private toAuthUser(row: NonNullable<Awaited<ReturnType<AuthService['findById']>>>): AuthUser {
    return {
      id: row.id,
      username: row.username,
      realName: row.realName,
      accessLevel: row.accessLevel as AccessLevel,
      prefs: {
        language: row.prefs?.language ?? 'en',
        theme: row.prefs?.theme ?? 'system',
        density: row.prefs?.density ?? 'compact',
        defaultProjectId: row.prefs?.defaultProjectId ?? null,
        pageSize: row.prefs?.pageSize ?? 25,
        notesNewestFirst: row.prefs?.notesNewestFirst ?? false,
      },
    };
  }
}
