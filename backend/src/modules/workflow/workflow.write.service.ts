import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { defaultWorkflow } from '../../shared/config';
import type { Status, WorkflowConfig } from '../../shared/models';
import { DRIZZLE, type Db } from '../../core/database/drizzle.service';
import * as s from '../../core/database/schema';
import { WorkflowService } from '../../core/workflow/workflow.service';
import type { WorkflowUpdate } from './workflow.schema';

@Injectable()
export class WorkflowWriteService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly workflow: WorkflowService,
  ) {}

  /** Replaces the whole configuration. Returns what a subsequent GET would produce. */
  async replace(update: WorkflowUpdate, actorId: number): Promise<WorkflowConfig> {
    await this.db.transaction(async (tx) => {
      // Delete-then-insert rather than diffing: the payload is the complete configuration, the
      // tables are tiny, and it is one transaction — so a partial apply is not reachable.
      await tx.delete(s.workflowTransitions);
      await tx.delete(s.workflowThresholds);
      await tx.delete(s.workflowStatusColors);
      await tx.delete(s.workflowWipLimits);

      const transitions = Object.entries(update.transitions).flatMap(([from, tos]) =>
        (tos as Status[]).map((to) => ({ fromStatus: from as Status, toStatus: to })),
      );
      if (transitions.length) await tx.insert(s.workflowTransitions).values(transitions);

      await tx.insert(s.workflowThresholds).values(
        Object.entries(update.thresholds).map(([action, level]) => ({
          action: action as never,
          level: level as number,
        })),
      );

      await tx.insert(s.workflowStatusColors).values(
        Object.entries(update.statusColors).map(([status, color]) => ({
          status: status as Status,
          color: color as string,
        })),
      );

      // A limit of 0 means "no limit", so it is absent rather than stored as zero — matching
      // the frontend, which deletes the key when the input is cleared.
      const limits = Object.entries(update.wipLimits)
        .filter(([, v]) => typeof v === 'number' && v > 0)
        .map(([status, limitValue]) => ({ status: status as Status, limitValue: limitValue as number }));
      if (limits.length) await tx.insert(s.workflowWipLimits).values(limits);

      await tx
        .update(s.workflowConfig)
        .set({
          resolvedStatus: update.resolvedStatus as Status,
          autoAssignStatus: update.autoAssignStatus,
          boardColumns: update.boardColumns.join(','),
          // The cache key includes the revision, so bumping it is what makes an admin's edit
          // take effect on the very next request instead of after the TTL.
          revision: sql`${s.workflowConfig.revision} + 1`,
          updatedAt: new Date(),
          updatedById: actorId,
        })
        .where(eq(s.workflowConfig.id, 1));
    });

    await this.workflow.invalidate();
    return this.workflow.get();
  }

  /** Back to the shipped defaults, which are the frontend's defaultWorkflow(). */
  async reset(actorId: number): Promise<WorkflowConfig> {
    const base = defaultWorkflow();
    return this.replace(
      {
        transitions: base.transitions,
        thresholds: base.thresholds,
        statusColors: base.statusColors,
        resolvedStatus: base.resolvedStatus,
        autoAssignStatus: base.autoAssignStatus,
        boardColumns: base.boardColumns,
        wipLimits: base.wipLimits as Record<string, number>,
      } as WorkflowUpdate,
      actorId,
    );
  }
}
