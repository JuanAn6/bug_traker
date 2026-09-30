import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNotNull, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { PRIORITIES, RESOLUTIONS, SEVERITIES, STATUSES } from '../../shared/config';
import { createdVsResolved, daysBetween } from '../../shared/metrics';
import type { Issue } from '../../shared/models';
import { DRIZZLE, type Db } from '../../core/database/drizzle.service';
import * as s from '../../core/database/schema';
import { ProjectTreeService } from '../../core/project-tree/project-tree.service';
import type { AuthUser } from '../auth/auth.types';
import { IssuesQueryService } from '../issues/issues.query.service';

const RESOLVED_RANK = STATUSES.indexOf('resolved');

const handler = alias(s.users, 'handlerUser');
const reporter = alias(s.users, 'reporterUser');

export interface SummaryReport {
  kpi: {
    total: number;
    open: number;
    resolved: number;
    mine: number;
    unassigned: number;
    overdue: number;
    resolvedThisWeek: number;
  };
  /** Mean days from creation to the FIRST resolution. '—' when nothing has been resolved. */
  mttrDays: number | null;
  reopenRatePct: number | null;
  byStatus: Array<{ key: string; count: number }>;
  byPriority: Array<{ key: string; count: number }>;
  bySeverity: Array<{ key: string; count: number }>;
  byResolution: Array<{ key: string; count: number }>;
  byCategory: Array<{ key: string; count: number }>;
  byProject: Array<{ projectId: number; name: string; counts: number[]; total: number }>;
  byHandler: Array<{ userId: number; name: string; open: number; resolved: number; pct: number }>;
  byReporter: Array<{ userId: number; name: string; total: number; open: number }>;
  longestOpen: Array<{ id: number; key: string; summary: string; ageDays: number }>;
  mostActive: Array<{ id: number; key: string; summary: string; events: number }>;
  trend: { labels: string[]; created: number[]; done: number[] };
}

/**
 * The statistics page, as grouped queries rather than hydrated issues.
 *
 * Every figure is scoped through IssuesQueryService.baseWhere, so a private issue never reaches
 * a count it should not be in — the frontend computes all of this over the already-filtered
 * `scopedIssues` signal, and losing that scoping here would leak aggregate information about
 * projects the caller cannot open.
 */
@Injectable()
export class SummaryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly issues: IssuesQueryService,
    private readonly tree: ProjectTreeService,
  ) {}

  async report(actor: AuthUser, projectId?: number): Promise<SummaryReport> {
    const where = await this.scopeWhere(actor, projectId);
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);

    const [kpi, byStatus, byPriority, bySeverity, byResolution, byCategory, byProject, byHandler,
      byReporter, longestOpen, mostActive, trend, mttr, reopen] = await Promise.all([
      this.kpi(actor, where, today, weekAgo),
      this.groupByColumn(where, s.issues.status, STATUSES, { keepZeros: true }),
      this.groupByColumn(where, s.issues.priority, PRIORITIES, { keepZeros: false }),
      this.groupByColumn(where, s.issues.severity, SEVERITIES, { keepZeros: false }),
      this.resolutions(where),
      this.categories(where),
      this.projects(where),
      this.handlers(where),
      this.reporters(where),
      this.longestOpen(where),
      this.mostActive(where),
      this.trend(where),
      this.mttr(where),
      this.reopenRate(where),
    ]);

    return {
      kpi, byStatus, byPriority, bySeverity, byResolution, byCategory, byProject, byHandler,
      byReporter, longestOpen, mostActive, trend,
      mttrDays: mttr,
      reopenRatePct: reopen,
    };
  }

  private async scopeWhere(actor: AuthUser, projectId?: number): Promise<SQL> {
    // hideStatus:'' because statistics cover everything, including closed issues — unlike the
    // issue list, whose default hides them.
    const criteria = projectId
      ? { hideStatus: '' as const, projectIds: [projectId] }
      : { hideStatus: '' as const };
    return this.issues.baseWhere(actor, criteria);
  }

  private async kpi(actor: AuthUser, where: SQL, today: string, weekAgo: Date) {
    const [row] = await this.db
      .select({
        total: sql<number>`COUNT(*)`,
        open: sql<number>`SUM(${s.issues.statusRank} < ${RESOLVED_RANK})`,
        resolved: sql<number>`SUM(${s.issues.statusRank} >= ${RESOLVED_RANK})`,
        mine: sql<number>`SUM(${s.issues.handlerId} = ${actor.id})`,
        unassigned: sql<number>`SUM(${s.issues.handlerId} IS NULL)`,
        overdue: sql<number>`SUM(${s.issues.dueDate} IS NOT NULL AND ${s.issues.dueDate} < ${today} AND ${s.issues.statusRank} < ${RESOLVED_RANK})`,
        resolvedThisWeek: sql<number>`SUM(${s.issues.resolvedAt} >= ${weekAgo})`,
      })
      .from(s.issues)
      .where(where);

    return {
      total: Number(row?.total ?? 0),
      open: Number(row?.open ?? 0),
      resolved: Number(row?.resolved ?? 0),
      mine: Number(row?.mine ?? 0),
      unassigned: Number(row?.unassigned ?? 0),
      overdue: Number(row?.overdue ?? 0),
      resolvedThisWeek: Number(row?.resolvedThisWeek ?? 0),
    };
  }

  /**
   * Counts per enum value, reindexed into canonical order.
   *
   * `keepZeros` reproduces a deliberate inconsistency in the frontend: byStatus shows all seven
   * statuses including the empty ones (the chart is a fixed axis), while byPriority and
   * bySeverity drop zeros. Matching it keeps the charts looking the same.
   */
  private async groupByColumn(
    where: SQL,
    column: typeof s.issues.status | typeof s.issues.priority | typeof s.issues.severity,
    order: readonly string[],
    options: { keepZeros: boolean },
  ) {
    const rows = await this.db
      .select({ key: column, count: sql<number>`COUNT(*)` })
      .from(s.issues)
      .where(where)
      .groupBy(column);

    const counts = new Map(rows.map((r) => [String(r.key), Number(r.count)]));
    return order
      .map((key) => ({ key, count: counts.get(key) ?? 0 }))
      .filter((entry) => options.keepZeros || entry.count > 0);
  }

  /** Resolved issues only, by resolution, highest first. */
  private async resolutions(where: SQL) {
    const rows = await this.db
      .select({ key: s.issues.resolution, count: sql<number>`COUNT(*)` })
      .from(s.issues)
      .where(and(where, sql`${s.issues.statusRank} >= ${RESOLVED_RANK}`))
      .groupBy(s.issues.resolution);
    return rows
      .map((r) => ({ key: String(r.key), count: Number(r.count) }))
      .sort((a, b) => b.count - a.count || RESOLUTIONS.indexOf(a.key as never) - RESOLUTIONS.indexOf(b.key as never));
  }

  /** OPEN issues per category, top 12 — the frontend's own cut-off. */
  private async categories(where: SQL) {
    const rows = await this.db
      .select({ key: s.issues.category, count: sql<number>`COUNT(*)` })
      .from(s.issues)
      .where(and(where, sql`${s.issues.statusRank} < ${RESOLVED_RANK}`))
      .groupBy(s.issues.category)
      .orderBy(desc(sql`COUNT(*)`))
      .limit(12);
    return rows.map((r) => ({ key: r.key, count: Number(r.count) }));
  }

  /** Per project, a count array aligned to STATUSES so the stacked bars line up. */
  private async projects(where: SQL) {
    const rows = await this.db
      .select({
        projectId: s.issues.projectId,
        name: s.projects.name,
        status: s.issues.status,
        count: sql<number>`COUNT(*)`,
      })
      .from(s.issues)
      .innerJoin(s.projects, eq(s.projects.id, s.issues.projectId))
      .where(where)
      .groupBy(s.issues.projectId, s.projects.name, s.issues.status);

    const byProject = new Map<number, { projectId: number; name: string; counts: number[]; total: number }>();
    for (const r of rows) {
      let entry = byProject.get(r.projectId);
      if (!entry) {
        entry = { projectId: r.projectId, name: r.name, counts: STATUSES.map(() => 0), total: 0 };
        byProject.set(r.projectId, entry);
      }
      const index = STATUSES.indexOf(r.status);
      if (index >= 0) entry.counts[index] = Number(r.count);
      entry.total += Number(r.count);
    }
    return [...byProject.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Per handler, open vs resolved. `userId: 0` is the unassigned bucket, as in the frontend. */
  private async handlers(where: SQL) {
    const rows = await this.db
      .select({
        userId: sql<number>`COALESCE(${s.issues.handlerId}, 0)`,
        name: handler.realName,
        open: sql<number>`SUM(${s.issues.statusRank} < ${RESOLVED_RANK})`,
        resolved: sql<number>`SUM(${s.issues.statusRank} >= ${RESOLVED_RANK})`,
      })
      .from(s.issues)
      .leftJoin(handler, eq(handler.id, s.issues.handlerId))
      .where(where)
      .groupBy(sql`COALESCE(${s.issues.handlerId}, 0)`, handler.realName);

    return rows
      .map((r) => {
        const open = Number(r.open);
        const resolved = Number(r.resolved);
        const total = open + resolved;
        return {
          userId: Number(r.userId),
          name: r.name ?? '',
          open,
          resolved,
          pct: total ? Math.round((resolved / total) * 100) : 0,
        };
      })
      .sort((a, b) => b.open - a.open);
  }

  private async reporters(where: SQL) {
    const rows = await this.db
      .select({
        userId: s.issues.reporterId,
        name: reporter.realName,
        total: sql<number>`COUNT(*)`,
        open: sql<number>`SUM(${s.issues.statusRank} < ${RESOLVED_RANK})`,
      })
      .from(s.issues)
      .innerJoin(reporter, eq(reporter.id, s.issues.reporterId))
      .where(where)
      .groupBy(s.issues.reporterId, reporter.realName);

    return rows
      .map((r) => ({
        userId: r.userId,
        name: r.name,
        total: Number(r.total),
        open: Number(r.open),
      }))
      .sort((a, b) => b.total - a.total);
  }

  private async longestOpen(where: SQL) {
    const rows = await this.db
      .select({
        id: s.issues.id,
        key: s.projects.key,
        summary: s.issues.summary,
        created: s.issues.created,
      })
      .from(s.issues)
      .innerJoin(s.projects, eq(s.projects.id, s.issues.projectId))
      .where(and(where, sql`${s.issues.statusRank} < ${RESOLVED_RANK}`))
      .orderBy(asc(s.issues.created))
      .limit(8);

    const now = new Date().toISOString();
    return rows.map((r) => ({
      id: r.id,
      key: `${r.key}-${r.id}`,
      summary: r.summary,
      ageDays: daysBetween(r.created.toISOString(), now),
    }));
  }

  /** Ranked by history-row count, which the denormalized counter already holds. */
  private async mostActive(where: SQL) {
    const rows = await this.db
      .select({
        id: s.issues.id,
        key: s.projects.key,
        summary: s.issues.summary,
        events: s.issues.historyCount,
      })
      .from(s.issues)
      .innerJoin(s.projects, eq(s.projects.id, s.issues.projectId))
      .where(where)
      .orderBy(desc(s.issues.historyCount))
      .limit(8);
    return rows.map((r) => ({ ...r, key: `${r.key}-${r.id}`, events: Number(r.events) }));
  }

  /**
   * Created vs resolved, twelve weekly buckets.
   *
   * Computed by the frontend's own createdVsResolved(), fed with the two date lists, rather than
   * bucketed in SQL — it is the same function that draws the chart, so the axis and the bucket
   * boundaries cannot drift apart.
   */
  private async trend(where: SQL) {
    const rows = await this.db
      .select({ created: s.issues.created, resolvedAt: s.issues.resolvedAt })
      .from(s.issues)
      .where(where);

    const issues = rows.map((r) => ({ created: r.created.toISOString() })) as Issue[];
    const resolved = new Map<number, string>();
    rows.forEach((r, index) => {
      if (r.resolvedAt) resolved.set(index, r.resolvedAt.toISOString());
    });
    return createdVsResolved(issues, resolved, 12);
  }

  /** Mean days from creation to the first resolution, over issues that ever got resolved. */
  private async mttr(where: SQL): Promise<number | null> {
    const [row] = await this.db
      .select({
        seconds: sql<number>`AVG(TIMESTAMPDIFF(SECOND, ${s.issues.created}, ${s.issues.firstResolvedAt}))`,
      })
      .from(s.issues)
      .where(and(where, isNotNull(s.issues.firstResolvedAt)));
    const seconds = Number(row?.seconds ?? 0);
    return seconds > 0 ? Math.round((seconds / 86_400) * 10) / 10 : null;
  }

  /**
   * Reopen rate, with the denominator FIXED.
   *
   * The frontend computes `reopened / (resolvedSet.size + reopenedSet.size)`, where its
   * `resolvedSet` holds only CURRENTLY resolved issues while `reopenedSet` holds issues that
   * were reopened — which are therefore usually absent from the first. So an issue reopened and
   * re-resolved is counted in both, and one reopened and left open inflates the denominator by
   * itself. The honest ratio is: of the issues that were ever resolved, how many came back.
   */
  private async reopenRate(where: SQL): Promise<number | null> {
    const [row] = await this.db
      .select({
        everResolved: sql<number>`SUM(${s.issues.firstResolvedAt} IS NOT NULL)`,
        reopened: sql<number>`SUM(${s.issues.reopenCount} > 0)`,
      })
      .from(s.issues)
      .where(where);

    const everResolved = Number(row?.everResolved ?? 0);
    if (!everResolved) return null;
    return Math.round((Number(row?.reopened ?? 0) / everResolved) * 100);
  }
}

export { RESOLVED_RANK };
