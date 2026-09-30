import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import type { FilterCriteria, SortKey } from '../../shared/models';
import type { Page } from '../../common/pagination/page.dto';
import { MAX_PAGE_SIZE } from '../../common/pagination/page-query.dto';
import { NotFoundError } from '../../common/errors/domain-error';
import { DRIZZLE, type Db } from '../../core/database/drizzle.service';
import * as s from '../../core/database/schema';
import { ProjectTreeService } from '../../core/project-tree/project-tree.service';
import type { ActorLike } from '../auth/ability';
import { VisibilityService } from '../auth/visibility.service';
import {
  buildIssueOrderBy, buildIssueWhere, type VisibilityScope,
} from './issue-query.builder';

/** One row of the issue list, shaped for the table the frontend already renders. */
export interface IssueListRow {
  id: number;
  /** `WEB-123`. The frontend builds this from the project key, so the API ships it ready. */
  key: string;
  projectId: number;
  projectName: string;
  category: string;
  summary: string;
  status: string;
  resolution: string;
  priority: string;
  severity: string;
  reproducibility: string;
  reporterId: number;
  reporterName: string;
  handlerId: number | null;
  handlerName: string | null;
  sprintId: number | null;
  sprintName: string | null;
  targetVersion: string;
  fixedInVersion: string;
  tags: string[];
  viewState: string;
  sticky: boolean;
  dueDate: string | null;
  overdue: boolean;
  storyPoints: number | null;
  noteCount: number;
  attachmentCount: number;
  created: string;
  updated: string;
}

export interface IssueListResult extends Page<IssueListRow> {
  /**
   * The full ordered id list, capped. Present only when asked for: the issue view needs it for
   * prev/next within the current filter (Workspace.issueNav), and returning it with the first
   * page saves a second round trip.
   */
  ids?: number[];
}

const IDS_CAP = 2000;

// The reporter and the handler are both rows of `users`, so the table is joined twice under
// two aliases. Drizzle's alias() keeps this fully typed, unlike a hand-written SQL join.
const reporter = alias(s.users, 'reporter');
const handler = alias(s.users, 'handler');

@Injectable()
export class IssuesQueryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly visibility: VisibilityService,
    private readonly tree: ProjectTreeService,
  ) {}

  /**
   * THE entry point for every read of `issues`.
   *
   * Drizzle has no query middleware, so `deletedAt IS NULL` and the visibility predicate
   * cannot be injected transparently the way a Prisma extension would. Routing every read
   * through here is the discipline that replaces it — and it is enforced by a test that scans
   * modules/ for direct access to the table.
   */
  async baseWhere(actor: ActorLike, criteria: Partial<FilterCriteria> = {}): Promise<SQL> {
    const scope = await this.visibility.scope(actor);
    const descendants = await this.descendantResolver(criteria);
    return buildIssueWhere(
      criteria,
      { meId: actor.id, now: new Date(), scope },
      descendants,
    );
  }

  async list(
    actor: ActorLike,
    criteria: Partial<FilterCriteria>,
    sort: SortKey[],
    paging: { page: number; pageSize: number; withIds?: boolean },
  ): Promise<IssueListResult> {
    const where = await this.baseWhere(actor, criteria);
    const orderBy = buildIssueOrderBy(sort);

    // Joins are unconditional rather than added only when a sort key needs them: they are all
    // indexed single-row lookups, and every row needs the project key and the display names
    // anyway, so a conditional join would save nothing and fork the query shape.
    const rows = await this.selectRows(where, orderBy, paging.pageSize, paging.page * paging.pageSize);

    const [counted] = await this.db
      .select({ total: sql<number>`COUNT(*)` })
      .from(s.issues)
      .where(where);
    const total = Number(counted?.total ?? 0);

    const ids = paging.withIds ? await this.idsFor(where, orderBy) : undefined;
    const tags = await this.tagsFor(rows.map((r) => r.id));
    const today = new Date().toISOString().slice(0, 10);

    return {
      items: rows.map((r) => this.toRow(r, tags.get(r.id) ?? [], today)),
      page: paging.page,
      pageSize: paging.pageSize,
      total,
      ...(ids ? { ids } : {}),
    };
  }

  /** Count only, for the navigator's per-node badges. */
  async count(actor: ActorLike, criteria: Partial<FilterCriteria>): Promise<number> {
    const where = await this.baseWhere(actor, criteria);
    const [row] = await this.db
      .select({ total: sql<number>`COUNT(*)` })
      .from(s.issues)
      .where(where);
    return Number(row?.total ?? 0);
  }

  /** Loads one issue, or 404s — which is also the answer for one the actor cannot see. */
  async requireVisible(actor: ActorLike, id: number) {
    const where = await this.baseWhere(actor, { hideStatus: '' });
    const [row] = await this.db
      .select()
      .from(s.issues)
      .where(and(where, eq(s.issues.id, id)))
      .limit(1);
    // Deliberately not 403: telling the caller "forbidden" would confirm the issue exists,
    // which for a private issue is the leak the visibility rules are meant to prevent.
    if (!row) throw new NotFoundError('issue', id);
    return row;
  }

  private async selectRows(where: SQL, orderBy: SQL[], limit: number, offset: number) {
    return this.db
      .select({
        id: s.issues.id,
        projectId: s.issues.projectId,
        projectName: s.projects.name,
        projectKey: s.projects.key,
        category: s.issues.category,
        summary: s.issues.summary,
        status: s.issues.status,
        resolution: s.issues.resolution,
        priority: s.issues.priority,
        severity: s.issues.severity,
        reproducibility: s.issues.reproducibility,
        reporterId: s.issues.reporterId,
        reporterName: reporter.realName,
        handlerId: s.issues.handlerId,
        sprintId: s.issues.sprintId,
        sprintName: s.sprints.name,
        targetVersion: s.issues.targetVersion,
        fixedInVersion: s.issues.fixedInVersion,
        viewState: s.issues.viewState,
        sticky: s.issues.sticky,
        dueDate: s.issues.dueDate,
        statusRank: s.issues.statusRank,
        storyPoints: s.issues.storyPoints,
        noteCount: s.issues.noteCount,
        attachmentCount: s.issues.attachmentCount,
        created: s.issues.created,
        updated: s.issues.updated,
        handlerName: handler.realName,
      })
      .from(s.issues)
      .innerJoin(s.projects, eq(s.projects.id, s.issues.projectId))
      .innerJoin(reporter, eq(reporter.id, s.issues.reporterId))
      .leftJoin(handler, eq(handler.id, s.issues.handlerId))
      .leftJoin(s.sprints, eq(s.sprints.id, s.issues.sprintId))
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset);
  }

  private async idsFor(where: SQL, orderBy: SQL[]): Promise<number[]> {
    const rows = await this.db
      .select({ id: s.issues.id })
      .from(s.issues)
      .where(where)
      .orderBy(...orderBy)
      .limit(IDS_CAP);
    return rows.map((r) => r.id);
  }

  /** One query for every row's tags, in insertion order, instead of N. */
  private async tagsFor(issueIds: number[]): Promise<Map<number, string[]>> {
    if (!issueIds.length) return new Map();
    const rows = await this.db
      .select({ issueId: s.issueTags.issueId, tag: s.issueTags.tag })
      .from(s.issueTags)
      .where(inArray(s.issueTags.issueId, issueIds))
      .orderBy(asc(s.issueTags.issueId), asc(s.issueTags.sortOrder));
    const out = new Map<number, string[]>();
    for (const r of rows) {
      const list = out.get(r.issueId);
      if (list) list.push(r.tag);
      else out.set(r.issueId, [r.tag]);
    }
    return out;
  }

  /**
   * The subproject closure, resolved up front because buildIssueWhere is synchronous.
   * Only computed when the criteria actually scope by project.
   */
  private async descendantResolver(
    criteria: Partial<FilterCriteria>,
  ): Promise<(ids: number[]) => number[]> {
    if (!criteria.projectIds?.length || criteria.includeSubprojects === false) {
      return (ids) => ids;
    }
    const expanded = await this.tree.descendants(criteria.projectIds);
    return () => expanded;
  }

  private toRow(
    r: Awaited<ReturnType<IssuesQueryService['selectRows']>>[number],
    tags: string[],
    today: string,
  ): IssueListRow {
    return {
      id: r.id,
      key: `${r.projectKey}-${r.id}`,
      projectId: r.projectId,
      projectName: r.projectName,
      category: r.category,
      summary: r.summary,
      status: r.status,
      resolution: r.resolution,
      priority: r.priority,
      severity: r.severity,
      reproducibility: r.reproducibility,
      reporterId: r.reporterId,
      reporterName: r.reporterName,
      handlerId: r.handlerId,
      handlerName: r.handlerName,
      sprintId: r.sprintId,
      sprintName: r.sprintName,
      targetVersion: r.targetVersion,
      fixedInVersion: r.fixedInVersion,
      tags,
      viewState: r.viewState,
      sticky: r.sticky,
      dueDate: r.dueDate,
      // Computed here so the table does not have to reimplement isOverdue(): strictly before
      // today AND not yet resolved.
      overdue: !!r.dueDate && r.dueDate < today && r.statusRank < 5,
      storyPoints: r.storyPoints,
      noteCount: r.noteCount,
      attachmentCount: r.attachmentCount,
      created: r.created.toISOString(),
      updated: r.updated.toISOString(),
    };
  }
}

export { MAX_PAGE_SIZE };
export type { VisibilityScope };
