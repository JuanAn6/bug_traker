import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { PRIORITIES, STATUSES } from '../../shared/config';
import { burndown, points, type Burndown } from '../../shared/metrics';
import type { Issue, Sprint, Status } from '../../shared/models';
import { NotFoundError } from '../../common/errors/domain-error';
import { DRIZZLE, type Db } from '../../core/database/drizzle.service';
import * as s from '../../core/database/schema';
import { ProjectTreeService } from '../../core/project-tree/project-tree.service';
import { WorkflowService } from '../../core/workflow/workflow.service';
import { can } from '../auth/ability';
import type { AuthUser } from '../auth/auth.types';
import { allowedTransitions } from '../issues/domain/allowed-transitions';
import { IssuesQueryService } from '../issues/issues.query.service';
import { RESOLVED_RANK } from './summary.service';

const handler = alias(s.users, 'handlerUser');

export interface IssueBrief {
  id: number;
  key: string;
  summary: string;
  status: Status;
  statusRank: number;
  priority: string;
  priorityRank: number;
  severity: string;
  category: string;
  handlerId: number | null;
  handlerName: string | null;
  storyPoints: number | null;
  dueDate: string | null;
  overdue: boolean;
  tags: string[];
}

@Injectable()
export class AggregatesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly issues: IssuesQueryService,
    private readonly tree: ProjectTreeService,
    private readonly workflow: WorkflowService,
  ) {}

  /**
   * Unreleased, non-obsolete versions plus the sprints still in play.
   *
   * Version membership is `targetVersion` — where the work is HEADED — which is why roadmap and
   * changelog read different columns. Versions come first, then sprints, matching the page.
   */
  async roadmap(actor: AuthUser, projectId?: number) {
    const projectIds = await this.scopeProjects(actor, projectId);
    const out = [];

    for (const id of projectIds) {
      const project = await this.tree.get(id);
      if (!project) continue;

      const versions = await this.db
        .select()
        .from(s.projectVersions)
        .where(and(
          eq(s.projectVersions.projectId, id),
          eq(s.projectVersions.released, false),
          eq(s.projectVersions.obsolete, false),
        ))
        .orderBy(asc(s.projectVersions.sortOrder));

      const sprints = await this.db
        .select()
        .from(s.sprints)
        .where(and(
          eq(s.sprints.projectId, id),
          ne(s.sprints.state, 'closed'),
          isNull(s.sprints.deletedAt),
        ))
        .orderBy(asc(s.sprints.start));

      const entries = [];
      for (const version of versions) {
        const issues = await this.briefs(actor, and(
          eq(s.issues.projectId, id),
          eq(s.issues.targetVersion, version.name),
        ));
        entries.push({
          kind: 'version' as const,
          id: version.name,
          name: version.name,
          date: version.date,
          description: version.description,
          issues: sortRoadmap(issues),
          done: issues.filter((i) => i.statusRank >= RESOLVED_RANK).length,
          total: issues.length,
        });
      }
      for (const sprint of sprints) {
        const issues = await this.briefs(actor, and(
          eq(s.issues.projectId, id),
          eq(s.issues.sprintId, sprint.id),
        ));
        entries.push({
          kind: 'sprint' as const,
          id: String(sprint.id),
          name: sprint.name,
          date: sprint.end,
          description: sprint.goal,
          issues: sortRoadmap(issues),
          done: issues.filter((i) => i.statusRank >= RESOLVED_RANK).length,
          total: issues.length,
        });
      }

      if (entries.length) out.push({ project: { id, name: project.name, key: project.key }, entries });
    }
    return out;
  }

  /**
   * Released versions, newest first, with the issues actually FIXED in them.
   *
   * `fixedInVersion`, not `targetVersion` — a changelog documents what shipped, not what was
   * aimed at. The order is `sortOrder` descending, which is the frontend's `.reverse()` over the
   * array: that is why the column had to become durable data rather than an array position.
   */
  async changelog(actor: AuthUser, projectId?: number) {
    const projectIds = await this.scopeProjects(actor, projectId);
    const out = [];

    for (const id of projectIds) {
      const project = await this.tree.get(id);
      if (!project) continue;

      const versions = await this.db
        .select()
        .from(s.projectVersions)
        .where(and(eq(s.projectVersions.projectId, id), eq(s.projectVersions.released, true)))
        .orderBy(desc(s.projectVersions.sortOrder));

      const entries = [];
      for (const version of versions) {
        const issues = await this.briefs(actor, and(
          eq(s.issues.projectId, id),
          eq(s.issues.fixedInVersion, version.name),
          sql`${s.issues.statusRank} >= ${RESOLVED_RANK}`,
        ));
        if (!issues.length) continue;

        const byCategory = new Map<string, IssueBrief[]>();
        for (const issue of issues) {
          const list = byCategory.get(issue.category);
          if (list) list.push(issue);
          else byCategory.set(issue.category, [issue]);
        }
        entries.push({
          name: version.name,
          date: version.date,
          description: version.description,
          total: issues.length,
          categories: [...byCategory.entries()]
            .map(([name, list]) => ({ name, issues: list.sort((a, b) => a.id - b.id) }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        });
      }

      if (entries.length) out.push({ project: { id, name: project.name, key: project.key }, entries });
    }
    return out;
  }

  /**
   * The kanban board.
   *
   * `allowedTransitions` is computed per card on purpose: the drag-and-drop has to agree with
   * what the server will accept, and a client that re-derived it from the threshold table would
   * be a second implementation of the rule waiting to drift.
   */
  async board(
    actor: AuthUser,
    options: { projectId?: number; sprint?: string; lane?: 'none' | 'handler' | 'priority' },
  ) {
    const wf = await this.workflow.get();
    const conditions: Array<SQL | undefined> = [];

    if (options.projectId) {
      const ids = await this.tree.descendants([options.projectId]);
      conditions.push(inArray(s.issues.projectId, ids));
    }
    // '' means every sprint; 'none' means the backlog.
    if (options.sprint === 'none') conditions.push(isNull(s.issues.sprintId));
    else if (options.sprint) conditions.push(eq(s.issues.sprintId, Number(options.sprint)));

    const cards = await this.briefs(actor, conditions.length ? and(...conditions) : undefined);
    const columns = wf.boardColumns;
    const project = options.projectId ? await this.tree.get(options.projectId) : undefined;

    const withTransitions = await Promise.all(
      cards
        .filter((c) => columns.includes(c.status))
        .map(async (card) => ({
          ...card,
          allowedTransitions: allowedTransitions(
            { status: card.status, reporterId: -1 },
            wf,
            { can: (action) => can(actor, action, project, wf), meId: actor.id },
          ),
        })),
    );

    const lane = options.lane ?? 'none';
    const lanes = lane === 'none'
      ? [{ key: 'all', label: '', cards: withTransitions }]
      : lane === 'handler'
        ? groupByHandler(withTransitions)
        : groupByPriority(withTransitions);

    // Within a column: priority descending, then most recently touched.
    for (const group of lanes) {
      group.cards.sort((a, b) => b.priorityRank - a.priorityRank || b.id - a.id);
    }

    return {
      columns,
      wipLimits: wf.wipLimits,
      totalPoints: cards.reduce((sum, c) => sum + (c.storyPoints ?? 0), 0),
      lanes,
    };
  }

  /**
   * A month of due dates and sprint boundaries.
   *
   * The 42-cell grid is keyed in UTC, and that is a deliberate difference: pages/calendar builds
   * its cells by mutating a local-time Date while `dueDate` is a bare 'YYYY-MM-DD' string, so in
   * a far-eastern timezone its "today" highlight lands on the wrong cell. The API answers in the
   * same timezone every other date boundary uses.
   */
  async calendar(actor: AuthUser, month: string, projectId?: number) {
    const [year, monthIndex] = month.split('-').map(Number);
    if (!year || !monthIndex) throw new NotFoundError('month', month);

    const first = new Date(Date.UTC(year, monthIndex - 1, 1));
    // Monday-first, six weeks, always 42 cells so the grid never reflows.
    const start = new Date(first);
    start.setUTCDate(1 - ((first.getUTCDay() + 6) % 7));
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 41);

    const from = start.toISOString().slice(0, 10);
    const to = end.toISOString().slice(0, 10);

    const scope: Array<SQL | undefined> = [sql`${s.issues.dueDate} BETWEEN ${from} AND ${to}`];
    if (projectId) scope.push(inArray(s.issues.projectId, await this.tree.descendants([projectId])));
    const issues = await this.briefs(actor, and(...scope));

    const visibleProjects = projectId
      ? await this.tree.descendants([projectId])
      : (await this.tree.all()).map((p) => p.id);
    const sprints = await this.db
      .select()
      .from(s.sprints)
      .where(and(
        inArray(s.sprints.projectId, visibleProjects.length ? visibleProjects : [-1]),
        isNull(s.sprints.deletedAt),
        sql`(${s.sprints.start} BETWEEN ${from} AND ${to} OR ${s.sprints.end} BETWEEN ${from} AND ${to})`,
      ));

    const days = [];
    for (let i = 0; i < 42; i++) {
      const day = new Date(start);
      day.setUTCDate(start.getUTCDate() + i);
      const key = day.toISOString().slice(0, 10);
      days.push({
        key,
        inMonth: day.getUTCMonth() === monthIndex - 1,
        issues: issues.filter((issue) => issue.dueDate === key),
        sprints: [
          ...sprints.filter((sp) => sp.start === key).map((sp) => ({ id: sp.id, name: sp.name, kind: 'start' as const })),
          ...sprints.filter((sp) => sp.end === key).map((sp) => ({ id: sp.id, name: sp.name, kind: 'end' as const })),
        ],
      });
    }
    return { month, from, to, days };
  }

  /**
   * The dashboard in one request.
   *
   * Without this the home page is nine round trips: one per widget plus the KPIs plus the
   * activity feed. The widget criteria are the same ones the frontend's WIDGETS table uses.
   */
  async home(actor: AuthUser, projectId?: number) {
    const base = projectId ? { projectIds: [projectId] } : {};
    const widget = (criteria: Record<string, unknown>) =>
      this.issues.list(actor, { ...base, ...criteria } as never, [{ column: 'updated', dir: 'desc' }], {
        page: 0,
        pageSize: 10,
      });

    const [assigned, reported, unassigned, recent, monitored, feedback, due] = await Promise.all([
      widget({ handlerIds: [-1], hideStatus: 'resolved' }),
      widget({ reporterIds: [-1] }),
      widget({ handlerIds: [0], hideStatus: 'resolved' }),
      widget({}),
      widget({ monitorId: -1 }),
      widget({ statuses: ['feedback'] }),
      widget({ overdueOnly: true }),
    ]);

    return {
      widgets: { assigned, reported, unassigned, recent, monitored, feedback, due },
      activeSprints: await this.activeSprints(actor, projectId),
    };
  }

  /** Sprint detail with the burndown, which is what the sprint page needs in one call. */
  async sprintDetail(actor: AuthUser, sprintId: number) {
    const [sprint] = await this.db
      .select()
      .from(s.sprints)
      .where(and(eq(s.sprints.id, sprintId), isNull(s.sprints.deletedAt)))
      .limit(1);
    if (!sprint) throw new NotFoundError('sprint', sprintId);

    const project = await this.tree.get(sprint.projectId);
    const wf = await this.workflow.get();

    const scope = await this.briefs(actor, eq(s.issues.sprintId, sprintId));
    const backlog = await this.briefs(actor, and(
      eq(s.issues.projectId, sprint.projectId),
      isNull(s.issues.sprintId),
      sql`${s.issues.statusRank} < ${RESOLVED_RANK}`,
    ));

    const other = await this.db
      .select({ id: s.sprints.id, name: s.sprints.name })
      .from(s.sprints)
      .where(and(
        eq(s.sprints.projectId, sprint.projectId),
        ne(s.sprints.state, 'closed'),
        ne(s.sprints.id, sprintId),
        isNull(s.sprints.deletedAt),
      ));

    const totalPoints = scope.reduce((sum, i) => sum + points(i as unknown as Issue), 0);
    const donePoints = scope
      .filter((i) => i.statusRank >= RESOLVED_RANK)
      .reduce((sum, i) => sum + points(i as unknown as Issue), 0);

    const byStatus = STATUSES.map((status) => ({
      status,
      count: scope.filter((i) => i.status === status).length,
    }));

    return {
      sprint: {
        id: sprint.id, projectId: sprint.projectId, name: sprint.name, goal: sprint.goal,
        start: sprint.start, end: sprint.end, state: sprint.state, capacity: sprint.capacity,
      },
      project: project ? { id: project.id, name: project.name, key: project.key } : null,
      canManage: can(actor, 'manageSprints', project, wf),
      scope,
      backlog,
      otherSprints: other,
      byStatus,
      totalPoints,
      donePoints,
      pct: totalPoints ? Math.round((donePoints / totalPoints) * 100) : 0,
      daysLeft: Math.max(0, Math.round((Date.parse(`${sprint.end}T00:00:00.000Z`) - Date.now()) / 86_400_000)),
      unfinished: scope.filter((i) => i.statusRank < RESOLVED_RANK).length,
      burndown: await this.burndown(actor, sprint),
    };
  }

  /**
   * The burndown, computed in UTC throughout.
   *
   * metrics.burndown() parses the sprint boundaries with `new Date(start + 'T00:00:00')` — local
   * time — while keying its day buckets through `toISOString()` in UTC. West of UTC that shifts
   * the first bucket by a day and can drop the last one. Passing an explicit UTC-parsed sprint
   * keeps both ends in the same timezone.
   */
  async burndown(actor: AuthUser, sprint: typeof s.sprints.$inferSelect): Promise<Burndown> {
    const where = await this.issues.baseWhere(actor, { hideStatus: '' });
    const rows = await this.db
      .select({
        id: s.issues.id,
        sprintId: s.issues.sprintId,
        storyPoints: s.issues.storyPoints,
        statusRank: s.issues.statusRank,
        status: s.issues.status,
        resolvedAt: s.issues.resolvedAt,
        updated: s.issues.updated,
      })
      .from(s.issues)
      .where(and(where, eq(s.issues.sprintId, sprint.id)));

    const issues = rows.map((r) => ({
      id: r.id,
      sprintId: r.sprintId,
      storyPoints: r.storyPoints,
      status: r.status,
      updated: r.updated.toISOString(),
    })) as Issue[];

    const resolved = new Map<number, string>();
    for (const r of rows) {
      // resolvedAt is maintained at transition time, so no history scan and no drift when the
      // issue is edited afterwards — which resolvedDates()'s fallback to `updated` suffers from.
      if (r.resolvedAt) resolved.set(r.id, r.resolvedAt.toISOString());
    }

    return burndown(
      { ...sprint, goal: sprint.goal } as unknown as Sprint,
      issues,
      resolved,
      Date.now(),
    );
  }

  private async activeSprints(actor: AuthUser, projectId?: number) {
    const ids = await this.scopeProjects(actor, projectId);
    if (!ids.length) return [];
    const sprints = await this.db
      .select()
      .from(s.sprints)
      .where(and(
        inArray(s.sprints.projectId, ids),
        eq(s.sprints.state, 'active'),
        isNull(s.sprints.deletedAt),
      ));

    return Promise.all(sprints.map(async (sprint) => {
      const scope = await this.briefs(actor, eq(s.issues.sprintId, sprint.id));
      const total = scope.reduce((sum, i) => sum + points(i as unknown as Issue), 0);
      const done = scope
        .filter((i) => i.statusRank >= RESOLVED_RANK)
        .reduce((sum, i) => sum + points(i as unknown as Issue), 0);
      return {
        id: sprint.id,
        projectId: sprint.projectId,
        name: sprint.name,
        goal: sprint.goal,
        end: sprint.end,
        total,
        done,
        pct: total ? Math.round((done / total) * 100) : 0,
        daysLeft: Math.max(0, Math.round((Date.parse(`${sprint.end}T00:00:00.000Z`) - Date.now()) / 86_400_000)),
      };
    }));
  }

  /** Visible project ids, optionally narrowed to one project plus its DIRECT children. */
  private async scopeProjects(actor: AuthUser, projectId?: number): Promise<number[]> {
    const visible = (await this.tree.all()).map((p) => p.id);
    if (!projectId) return visible;
    // Direct children only — projectsInScope() in the frontend goes one level deep here, while
    // the issue filter goes all the way down. Reproduced rather than quietly unified.
    const scoped = await this.tree.withDirectChildren(projectId);
    return scoped.filter((id) => visible.includes(id));
  }

  /** Issue briefs, always through the visibility-scoped base predicate. */
  private async briefs(actor: AuthUser, extra?: SQL): Promise<IssueBrief[]> {
    const base = await this.issues.baseWhere(actor, { hideStatus: '' });
    const rows = await this.db
      .select({
        id: s.issues.id,
        projectKey: s.projects.key,
        summary: s.issues.summary,
        status: s.issues.status,
        statusRank: s.issues.statusRank,
        priority: s.issues.priority,
        priorityRank: s.issues.priorityRank,
        severity: s.issues.severity,
        category: s.issues.category,
        handlerId: s.issues.handlerId,
        handlerName: handler.realName,
        storyPoints: s.issues.storyPoints,
        dueDate: s.issues.dueDate,
        tagsSorted: s.issues.tagsSorted,
      })
      .from(s.issues)
      .innerJoin(s.projects, eq(s.projects.id, s.issues.projectId))
      .leftJoin(handler, eq(handler.id, s.issues.handlerId))
      .where(extra ? and(base, extra) : base);

    const today = new Date().toISOString().slice(0, 10);
    return rows.map((r) => ({
      id: r.id,
      key: `${r.projectKey}-${r.id}`,
      summary: r.summary,
      status: r.status,
      statusRank: r.statusRank,
      priority: r.priority,
      priorityRank: r.priorityRank,
      severity: r.severity,
      category: r.category,
      handlerId: r.handlerId,
      handlerName: r.handlerName,
      storyPoints: r.storyPoints,
      dueDate: r.dueDate,
      overdue: !!r.dueDate && r.dueDate < today && r.statusRank < RESOLVED_RANK,
      tags: r.tagsSorted ? r.tagsSorted.split(',').filter(Boolean) : [],
    }));
  }
}

/** Unresolved first, then by category, then by id — the roadmap's own ordering. */
const sortRoadmap = (issues: IssueBrief[]): IssueBrief[] =>
  [...issues].sort((a, b) => {
    const aDone = a.statusRank >= RESOLVED_RANK ? 1 : 0;
    const bDone = b.statusRank >= RESOLVED_RANK ? 1 : 0;
    return aDone - bDone || a.category.localeCompare(b.category) || a.id - b.id;
  });

function groupByHandler<T extends { handlerId: number | null; handlerName: string | null }>(cards: T[]) {
  const lanes = new Map<number, { key: string; label: string; cards: T[] }>();
  for (const card of cards) {
    // 0 is the unassigned lane, as everywhere else.
    const key = card.handlerId ?? 0;
    const lane = lanes.get(key);
    if (lane) lane.cards.push(card);
    else lanes.set(key, { key: String(key), label: card.handlerName ?? '', cards: [card] });
  }
  return [...lanes.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function groupByPriority<T extends { priority: string }>(cards: T[]) {
  // Reverse canonical order: most urgent lane first. Empty lanes are dropped.
  return [...PRIORITIES]
    .reverse()
    .map((priority) => ({
      key: priority,
      label: priority,
      cards: cards.filter((c) => c.priority === priority),
    }))
    .filter((lane) => lane.cards.length > 0);
}
