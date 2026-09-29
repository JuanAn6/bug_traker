import { z } from 'zod';
import { ACCESS_LEVELS, STATUSES } from '../../shared/config';
import { ACTIONS } from '../../core/database/schema/enums';

const statusEnum = z.enum(STATUSES as unknown as [string, ...string[]]);
const actionEnum = z.enum(ACTIONS as unknown as [string, ...string[]]);
const accessLevel = z.number().int().refine(
  (n) => (ACCESS_LEVELS as readonly number[]).includes(n),
  { message: `must be one of ${ACCESS_LEVELS.join(', ')}` },
);

/**
 * The whole WorkflowConfig, validated exhaustively.
 *
 * Every status must appear in `transitions`, every status in `statusColors`, and every one of
 * the 22 actions in `thresholds`. A partial payload would otherwise leave a status with no
 * outgoing edges — silently freezing every issue in it — or an action with no threshold. The
 * loader defends against a missing row as well, but rejecting the write is where the mistake
 * is actually visible to whoever made it.
 */
export const workflowUpdateSchema = z
  .object({
    transitions: z
      .record(statusEnum, z.array(statusEnum))
      .refine((v) => STATUSES.every((s) => Array.isArray(v[s])), {
        message: `must list all ${STATUSES.length} statuses`,
      }),
    thresholds: z
      .record(actionEnum, accessLevel)
      .refine((v) => ACTIONS.every((a) => v[a] !== undefined), {
        message: `must cover all ${ACTIONS.length} actions`,
      }),
    statusColors: z
      .record(statusEnum, z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb colour'))
      .refine((v) => STATUSES.every((s) => typeof v[s] === 'string'), {
        message: 'must cover every status',
      }),
    resolvedStatus: statusEnum,
    autoAssignStatus: z.boolean(),
    boardColumns: z.array(statusEnum).min(1),
    /** Sparse by design: only the statuses that have a limit. 0 removes one. */
    wipLimits: z.record(statusEnum, z.number().int().min(0).max(999)),
  })
  .strict();

export type WorkflowUpdate = z.infer<typeof workflowUpdateSchema>;
