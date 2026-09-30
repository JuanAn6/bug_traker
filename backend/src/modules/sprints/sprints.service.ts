import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { NotFoundError, ValidationError } from '../../common/errors/domain-error';
import { DRIZZLE, type Db } from '../../core/database/drizzle.service';
import * as s from '../../core/database/schema';
import { insertedId, UnitOfWork } from '../../core/database/unit-of-work';
import type { AuthUser } from '../auth/auth.types';
import { IssueBulkService } from '../issues/issue-bulk.service';
import { RESOLVED_RANK } from '../summary/summary.service';

export interface SprintInput {
  projectId: number;
  name: string;
  goal?: string;
  start: string;
  end: string;
  capacity?: number;
}

@Injectable()
export class SprintsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly uow: UnitOfWork,
    private readonly bulk: IssueBulkService,
  ) {}

  async create(actor: AuthUser, input: SprintInput): Promise<{ id: number }> {
    this.assertDates(input.start, input.end);
    const id = await this.uow.transaction(async (tx) => {
      const sprintId = insertedId(
        await tx.insert(s.sprints).values({
          projectId: input.projectId,
          name: input.name,
          goal: input.goal ?? '',
          start: input.start,
          end: input.end,
          state: 'planned',
          capacity: input.capacity ?? 0,
        }),
      );
      await this.uow.outbox(tx, 'sprint.created', { sprintId, actorId: actor.id });
      return sprintId;
    });
    return { id };
  }

  async update(actor: AuthUser, id: number, input: Partial<SprintInput>): Promise<void> {
    const sprint = await this.require(id);
    const start = input.start ?? sprint.start;
    const end = input.end ?? sprint.end;
    this.assertDates(start, end);

    await this.db
      .update(s.sprints)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.goal !== undefined ? { goal: input.goal } : {}),
        ...(input.start !== undefined ? { start: input.start } : {}),
        ...(input.end !== undefined ? { end: input.end } : {}),
        ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
      })
      .where(eq(s.sprints.id, id));
  }

  /**
   * Starts a sprint.
   *
   * A start date in the future is clamped to today, as start() does: a sprint that is running
   * cannot claim to begin tomorrow, and the burndown's first bucket would otherwise sit in the
   * future with nothing in it.
   *
   * No "one active sprint per project" rule — the frontend does not enforce one either, and teams
   * running overlapping sprints is a legitimate if unusual choice.
   */
  async start(id: number): Promise<void> {
    const sprint = await this.require(id);
    const today = new Date().toISOString().slice(0, 10);
    await this.db
      .update(s.sprints)
      .set({ state: 'active', start: sprint.start > today ? today : sprint.start })
      .where(eq(s.sprints.id, id));
  }

  /**
   * Completes a sprint, moving whatever did not get finished.
   *
   * The unfinished issues go through the bulk patch rather than a bare UPDATE, so each move is a
   * real field change: history row, `updated` bump, notifications. `moveTo: null` sends them back
   * to the backlog.
   */
  async complete(
    actor: AuthUser,
    id: number,
    moveTo: number | null,
  ): Promise<{ moved: number[]; unmoved: Array<{ id: number; reason: string }> }> {
    const sprint = await this.require(id);

    if (moveTo !== null) {
      const [target] = await this.db
        .select({ id: s.sprints.id, projectId: s.sprints.projectId, state: s.sprints.state })
        .from(s.sprints)
        .where(and(eq(s.sprints.id, moveTo), isNull(s.sprints.deletedAt)))
        .limit(1);
      if (!target) throw new NotFoundError('sprint', moveTo);
      // A sprint belongs to a project, so moving work across projects this way would be a
      // silent reparenting. The dialog only offers same-project sprints; the API enforces it.
      if (target.projectId !== sprint.projectId) {
        throw new ValidationError('errors.validation', 'The target sprint belongs to another project');
      }
      if (target.state === 'closed') {
        throw new ValidationError('errors.validation', 'Cannot move work into a closed sprint');
      }
    }

    const unfinished = await this.db
      .select({ id: s.issues.id })
      .from(s.issues)
      .where(and(
        eq(s.issues.sprintId, id),
        isNull(s.issues.deletedAt),
        sql`${s.issues.statusRank} < ${RESOLVED_RANK}`,
      ));

    const result = unfinished.length
      ? await this.bulk.bulkUpdate(actor, unfinished.map((i) => i.id), { sprintId: moveTo })
      : { applied: [], unchanged: [], skipped: [] };

    await this.db.update(s.sprints).set({ state: 'closed' }).where(eq(s.sprints.id, id));
    return { moved: result.applied, unmoved: result.skipped };
  }

  /** Soft delete; the issues simply lose their sprint. */
  async remove(actor: AuthUser, id: number): Promise<void> {
    await this.require(id);
    await this.uow.transaction(async (tx) => {
      await tx.update(s.issues).set({ sprintId: null }).where(eq(s.issues.sprintId, id));
      await tx.update(s.sprints).set({ deletedAt: new Date() }).where(eq(s.sprints.id, id));
      await this.uow.outbox(tx, 'sprint.deleted', { sprintId: id, actorId: actor.id });
    });
  }

  private async require(id: number) {
    const [sprint] = await this.db
      .select()
      .from(s.sprints)
      .where(and(eq(s.sprints.id, id), isNull(s.sprints.deletedAt)))
      .limit(1);
    if (!sprint) throw new NotFoundError('sprint', id);
    return sprint;
  }

  private assertDates(start: string, end: string): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      throw new ValidationError('errors.validation', 'Dates must be YYYY-MM-DD');
    }
    // The dialog's own rule. A zero-length sprint is allowed (start === end); an inverted one is
    // not, and burndown would divide by a negative span.
    if (end < start) {
      throw new ValidationError('errors.validation', 'The end date cannot precede the start date');
    }
  }
}
