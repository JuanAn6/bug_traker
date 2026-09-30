import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { AVATAR_COLORS, defaultPrefs } from '../../shared/config';
import type { AccessLevel, NotifyEvent, UserPrefs } from '../../shared/models';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain-error';
import { DRIZZLE, type Db } from '../../core/database/drizzle.service';
import * as s from '../../core/database/schema';
import { insertedId, UnitOfWork } from '../../core/database/unit-of-work';
import { ProjectTreeService } from '../../core/project-tree/project-tree.service';
import type { AuthUser } from '../auth/auth.types';
import { PasswordService } from '../auth/password.service';
import { TokenService } from '../auth/token.service';

export interface UserInput {
  username: string;
  realName: string;
  email: string;
  accessLevel: AccessLevel;
  enabled?: boolean;
  avatarColor?: string;
  password?: string;
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly uow: UnitOfWork,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly tree: ProjectTreeService,
  ) {}

  /** The full record, including the email — behind `manageUsers`, unlike the catalog list. */
  async detail(id: number) {
    const [row] = await this.db
      .select()
      .from(s.users)
      .leftJoin(s.userPrefs, eq(s.userPrefs.userId, s.users.id))
      .where(and(eq(s.users.id, id), isNull(s.users.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundError('user', id);

    const memberships = await this.db
      .select({ projectId: s.projectMembers.projectId, accessLevel: s.projectMembers.accessLevel })
      .from(s.projectMembers)
      .where(eq(s.projectMembers.userId, id));

    const [counts] = await this.db
      .select({
        reported: sql<number>`SUM(${s.issues.reporterId} = ${id})`,
        handled: sql<number>`SUM(${s.issues.handlerId} = ${id})`,
      })
      .from(s.issues)
      .where(isNull(s.issues.deletedAt));

    const { passwordHash: _hidden, ...user } = row.users;
    return {
      ...user,
      created: user.created.toISOString(),
      lastVisit: user.lastVisit?.toISOString() ?? null,
      hasPassword: row.users.passwordHash !== null,
      prefs: row.userPrefs,
      memberships,
      stats: { reported: Number(counts?.reported ?? 0), handled: Number(counts?.handled ?? 0) },
    };
  }

  async usernameAvailable(username: string, exceptId?: number): Promise<boolean> {
    const rows = await this.db
      .select({ id: s.users.id })
      .from(s.users)
      .where(exceptId
        ? and(eq(s.users.username, username.trim()), ne(s.users.id, exceptId))
        : eq(s.users.username, username.trim()));
    return rows.length === 0;
  }

  async create(input: UserInput): Promise<{ id: number }> {
    const username = input.username.trim();
    if (!(await this.usernameAvailable(username))) {
      throw new ConflictError('errors.usernameTaken', { username });
    }

    const id = await this.uow.transaction(async (tx) => {
      const userId = insertedId(
        await tx.insert(s.users).values({
          username,
          realName: input.realName.trim(),
          email: input.email.trim(),
          // Accounts created through the API always get a hash. Only the seeded demo users have
          // none, and DEMO_MODE is what lets those in.
          passwordHash: input.password ? await this.passwords.hash(input.password) : null,
          accessLevel: input.accessLevel,
          enabled: input.enabled ?? true,
          avatarColor: input.avatarColor || '',
          created: new Date(),
        }),
      );

      // Deterministic colour when none was chosen, matching users.service.ts.
      if (!input.avatarColor) {
        await tx
          .update(s.users)
          .set({ avatarColor: AVATAR_COLORS[userId % AVATAR_COLORS.length]! })
          .where(eq(s.users.id, userId));
      }

      await tx.insert(s.userPrefs).values(prefsRow(userId, defaultPrefs()));
      return userId;
    });

    return { id };
  }

  async update(id: number, input: Partial<UserInput>): Promise<void> {
    const [existing] = await this.db.select().from(s.users).where(eq(s.users.id, id)).limit(1);
    if (!existing || existing.deletedAt) throw new NotFoundError('user', id);

    if (input.username && input.username.trim() !== existing.username) {
      if (!(await this.usernameAvailable(input.username, id))) {
        throw new ConflictError('errors.usernameTaken', { username: input.username.trim() });
      }
    }

    // SQL expressions are allowed as values by Drizzle at runtime but not by $inferInsert's
    // types, so the bag is widened rather than casting at each assignment.
    const changes: Record<string, unknown> = {};
    if (input.username !== undefined) changes.username = input.username.trim();
    if (input.realName !== undefined) changes.realName = input.realName.trim();
    if (input.email !== undefined) changes.email = input.email.trim();
    if (input.accessLevel !== undefined) changes.accessLevel = input.accessLevel;
    if (input.avatarColor !== undefined) changes.avatarColor = input.avatarColor;
    if (input.password) changes.passwordHash = await this.passwords.hash(input.password);

    // Disabling an account, or changing its password, has to end the sessions it already has —
    // otherwise a disabled user keeps working for up to fifteen minutes.
    const killsSessions = (input.enabled === false && existing.enabled) || !!input.password;
    if (input.enabled !== undefined) changes.enabled = input.enabled;
    if (killsSessions) changes.tokenVersion = sql`${s.users.tokenVersion} + 1`;

    if (Object.keys(changes).length) {
      await this.db.update(s.users).set(changes as never).where(eq(s.users.id, id));
    }
    if (killsSessions) await this.tokens.revokeAllForUser(id);
  }

  async updatePrefs(id: number, patch: Partial<UserPrefs>): Promise<void> {
    const changes: Record<string, unknown> = {};
    if (patch.language !== undefined) changes['language'] = patch.language;
    if (patch.theme !== undefined) changes['theme'] = patch.theme;
    if (patch.density !== undefined) changes['density'] = patch.density;
    if (patch.defaultProjectId !== undefined) changes['defaultProjectId'] = patch.defaultProjectId;
    if (patch.pageSize !== undefined) changes['pageSize'] = patch.pageSize;
    if (patch.notesNewestFirst !== undefined) changes['notesNewestFirst'] = patch.notesNewestFirst;
    if (patch.homeWidgets !== undefined) changes['homeWidgets'] = patch.homeWidgets.join(',');
    if (patch.notify !== undefined) {
      // The whole map is replaced, which is what updatePrefs does — its shallow merge means the
      // client always sends every flag.
      for (const [event, on] of Object.entries(patch.notify) as Array<[NotifyEvent, boolean]>) {
        changes[`notify${event[0]!.toUpperCase()}${event.slice(1)}`] = on;
      }
    }
    if (!Object.keys(changes).length) return;
    await this.db.update(s.userPrefs).set(changes).where(eq(s.userPrefs.userId, id));
  }

  /**
   * Soft-deletes a user, handing their open work to somebody else.
   *
   * Soft, not hard, and this is a deliberate departure: users.service.ts deletes the row while
   * leaving `reporterId` pointing at it, so every issue that person ever filed ends up with a
   * dangling reporter that no join can resolve. Keeping the row means "reported by" still renders
   * and the audit trail stays readable.
   */
  async remove(actor: AuthUser, id: number, reassignTo: number | null): Promise<void> {
    if (id === actor.id) {
      throw new ValidationError('errors.validation', 'You cannot delete your own account');
    }
    const [existing] = await this.db.select().from(s.users).where(eq(s.users.id, id)).limit(1);
    if (!existing || existing.deletedAt) throw new NotFoundError('user', id);

    if (reassignTo !== null) {
      const [target] = await this.db
        .select({ id: s.users.id })
        .from(s.users)
        .where(and(eq(s.users.id, reassignTo), eq(s.users.enabled, true), isNull(s.users.deletedAt)))
        .limit(1);
      if (!target) throw new NotFoundError('user', reassignTo);
    }

    await this.uow.transaction(async (tx) => {
      await tx.update(s.issues).set({ handlerId: reassignTo }).where(eq(s.issues.handlerId, id));
      await tx.delete(s.issueMonitors).where(eq(s.issueMonitors.userId, id));
      await tx.delete(s.projectMembers).where(eq(s.projectMembers.userId, id));
      await tx
        .update(s.projectCategories)
        .set({ defaultHandlerId: null })
        .where(eq(s.projectCategories.defaultHandlerId, id));
      await tx.delete(s.notifications).where(eq(s.notifications.userId, id));
      await tx.update(s.savedFilters).set({ deletedAt: new Date() }).where(eq(s.savedFilters.ownerId, id));

      await tx
        .update(s.users)
        .set({ deletedAt: new Date(), enabled: false, tokenVersion: sql`${s.users.tokenVersion} + 1` })
        .where(eq(s.users.id, id));
    });

    await this.tokens.revokeAllForUser(id);
    await this.tree.invalidate();
  }
}

/** Explodes UserPrefs into the column shape. */
const prefsRow = (userId: number, prefs: UserPrefs) => ({
  userId,
  language: prefs.language,
  theme: prefs.theme,
  density: prefs.density,
  defaultProjectId: prefs.defaultProjectId,
  pageSize: prefs.pageSize,
  notesNewestFirst: prefs.notesNewestFirst,
  homeWidgets: prefs.homeWidgets.join(','),
  notifyAssigned: prefs.notify.assigned,
  notifyMentioned: prefs.notify.mentioned,
  notifyStatus: prefs.notify.status,
  notifyNote: prefs.notify.note,
  notifyAttachment: prefs.notify.attachment,
});
