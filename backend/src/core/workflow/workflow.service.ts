import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { defaultWorkflow } from '../../shared/config';
import type { Action, AccessLevel, Status, WorkflowConfig } from '../../shared/models';
import { CACHE_PORT, type CachePort } from '../ports/cache.port';
import { DRIZZLE, type Db } from '../database/drizzle.service';
import * as s from '../database/schema';

const KEY = 'workflow:config';
/**
 * Short, not zero. The cache is invalidated explicitly on write, so the TTL only bounds how
 * long a stale value could survive a missed invalidation — a second instance writing, before
 * CachePort is backed by Redis.
 */
const TTL_MS = 30_000;

/**
 * Serves the single global WorkflowConfig, reassembled into the exact shape the frontend's
 * shared code expects, so applyPatch and allowedTransitions can consume it unchanged.
 *
 * This is cached because authorization is CONFIGURATION here: every `can()` call reads
 * `thresholds[action]` from this table, so an uncached read would mean several round trips per
 * request. `revision` exists so an admin's edit takes effect at once instead of after a TTL.
 */
@Injectable()
export class WorkflowService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(CACHE_PORT) private readonly cache: CachePort,
  ) {}

  async get(): Promise<WorkflowConfig> {
    const cached = await this.cache.get<WorkflowConfig>(KEY);
    if (cached) return cached;
    const config = await this.load();
    await this.cache.set(KEY, config, TTL_MS);
    return config;
  }

  async threshold(action: Action): Promise<AccessLevel> {
    return (await this.get()).thresholds[action];
  }

  /** Called by PUT /workflow after bumping `revision`. */
  async invalidate(): Promise<void> {
    await this.cache.del(KEY);
    // Visibility scopes embed the workflow revision (they depend on the viewPrivate
    // threshold), so they have to go too.
    await this.cache.delByPrefix('scope:');
  }

  private async load(): Promise<WorkflowConfig> {
    const [config] = await this.db.select().from(s.workflowConfig).where(eq(s.workflowConfig.id, 1));
    if (!config) {
      // An unseeded database is a deployment mistake, not a runtime state to paper over: the
      // defaults would silently grant level-90 actions different thresholds than the admin
      // configured. Fail loudly instead.
      throw new Error('workflowConfig row 1 is missing. Run: npm run db:seed');
    }

    const [transitions, thresholds, colors, wipLimits] = await Promise.all([
      this.db.select().from(s.workflowTransitions),
      this.db.select().from(s.workflowThresholds),
      this.db.select().from(s.workflowStatusColors),
      this.db.select().from(s.workflowWipLimits),
    ]);

    // Start from the defaults so a row missing from the database cannot turn into an
    // `undefined` threshold, which `level >= undefined` would silently answer `false` for —
    // locking everyone out of that action rather than erroring.
    const base = defaultWorkflow();

    const transitionMap = { ...base.transitions };
    for (const key of Object.keys(transitionMap) as Status[]) transitionMap[key] = [];
    for (const t of transitions) transitionMap[t.fromStatus].push(t.toStatus);

    const thresholdMap = { ...base.thresholds };
    for (const t of thresholds) thresholdMap[t.action as Action] = t.level as AccessLevel;

    const colorMap = { ...base.statusColors };
    for (const c of colors) colorMap[c.status] = c.color;

    const wip: WorkflowConfig['wipLimits'] = {};
    for (const w of wipLimits) wip[w.status] = w.limitValue;

    return {
      transitions: transitionMap,
      thresholds: thresholdMap,
      statusColors: colorMap,
      resolvedStatus: config.resolvedStatus,
      autoAssignStatus: config.autoAssignStatus,
      boardColumns: config.boardColumns.split(',').filter(Boolean) as Status[],
      wipLimits: wip,
    };
  }
}
