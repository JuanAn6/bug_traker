import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { AccessLevel, Action, RelationshipType, Status } from '../../shared/models';
import { DRIZZLE, type Db } from '../../core/database/drizzle.service';
import * as s from '../../core/database/schema';
import { ProjectTreeService } from '../../core/project-tree/project-tree.service';
import { WorkflowService } from '../../core/workflow/workflow.service';
import { can, canSeeIssue, levelIn } from '../auth/ability';
import type { AuthUser } from '../auth/auth.types';
import { allowedTransitions } from './domain/allowed-transitions';
import { IssuesQueryService } from './issues.query.service';

/** The actions the issue view hides or disables buttons for. */
const UI_ACTIONS: readonly Action[] = [
  'update', 'assign', 'changeStatus', 'close', 'reopen', 'delete', 'move', 'addNote',
  'viewPrivate', 'uploadFile', 'monitorOthers', 'manageRelationships', 'manageTags',
];

export interface IssueDetail {
  issue: Record<string, unknown>;
  key: string;
  project: {
    id: number;
    name: string;
    key: string;
    categories: { name: string; defaultHandlerId: number | null }[];
    versions: { name: string; date: string | null; released: boolean; obsolete: boolean }[];
    customFieldIds: number[];
  };
  sprint: { id: number; name: string; state: string } | null;
  tags: string[];
  monitorIds: number[];
  monitoring: boolean;
  relationships: {
    type: RelationshipType;
    issueId: number;
    /** null when the target exists but this actor cannot see it. */
    target: { id: number; key: string; summary: string; status: Status } | null;
  }[];
  customFields: { id: number; name: string; type: string; options: string[]; required: boolean; value: string }[];
  /** Only the transitions this actor may actually perform, right now. */
  allowedTransitions: Status[];
  /** Everything the UI needs to decide what to render, resolved server-side. */
  permissions: Record<string, boolean>;
  /** The actor's effective level IN THIS PROJECT — a membership may raise or lower it. */
  effectiveLevel: AccessLevel;
  assignable: { id: number; username: string; realName: string; avatarColor: string }[];
  counts: { notes: number; attachments: number; history: number };
  timeSpent: number;
}

/**
 * The whole issue view in one request.
 *
 * The frontend assembles this from eight or nine signals over the local store; over HTTP that
 * would be eight or nine round trips. Two parts are deliberately computed here rather than
 * shipped as raw data: `allowedTransitions`, because the status dialog and the board's
 * drag-and-drop must agree with what the server will actually accept, and `permissions`,
 * because the alternative is exporting the threshold table and re-deriving the same answers in
 * the client.
 */
@Injectable()
export class IssueDetailService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly issues: IssuesQueryService,
    private readonly tree: ProjectTreeService,
    private readonly workflow: WorkflowService,
  ) {}

  async detail(actor: AuthUser, id: number): Promise<IssueDetail> {
    // 404s for an issue that does not exist OR that this actor cannot see — the same answer,
    // on purpose.
    const issue = await this.issues.requireVisible(actor, id);
    const [wf, project] = await Promise.all([
      this.workflow.get(),
      this.tree.get(issue.projectId),
    ]);

    const [categories, versions, customFieldIds, tags, monitors, relationships, customFields, time] =
      await Promise.all([
        this.categories(issue.projectId),
        this.versions(issue.projectId),
        this.customFieldIds(issue.projectId),
        this.tags(id),
        this.monitors(id),
        this.relationships(actor, id, wf),
        this.customFields(issue.projectId, id),
        this.timeSpent(actor, id, issue.projectId),
      ]);

    const sprint = issue.sprintId ? await this.sprint(issue.sprintId) : null;

    const permissions: Record<string, boolean> = {};
    for (const action of UI_ACTIONS) permissions[action] = can(actor, action, project, wf);
    // canEditIssue widens `update` for the reporter, so it cannot be derived from the map above.
    permissions['edit'] =
      permissions['update'] === true || (issue.reporterId === actor.id && can(actor, 'report', project, wf));

    return {
      issue: this.serialize(issue),
      key: `${project?.key ?? '#'}-${issue.id}`,
      project: {
        id: issue.projectId,
        name: project?.name ?? '',
        key: project?.key ?? '',
        categories,
        versions,
        customFieldIds,
      },
      sprint,
      tags,
      monitorIds: monitors,
      monitoring: monitors.includes(actor.id),
      relationships,
      customFields,
      allowedTransitions: allowedTransitions(issue, wf, {
        can: (action) => can(actor, action, project, wf),
        meId: actor.id,
      }),
      permissions,
      effectiveLevel: levelIn(actor, project),
      assignable: await this.assignable(issue.projectId),
      counts: {
        notes: issue.noteCount,
        attachments: issue.attachmentCount,
        history: issue.historyCount,
      },
      timeSpent: time,
    };
  }

  /** ISO strings out, matching the frontend's model exactly. */
  private serialize(issue: Awaited<ReturnType<IssuesQueryService['requireVisible']>>) {
    const { searchNorm: _s, tagsSorted: _t, rowVersion, ...rest } = issue;
    return {
      ...rest,
      created: issue.created.toISOString(),
      updated: issue.updated.toISOString(),
      resolvedAt: issue.resolvedAt?.toISOString() ?? null,
      firstResolvedAt: issue.firstResolvedAt?.toISOString() ?? null,
      reopenedAt: issue.reopenedAt?.toISOString() ?? null,
      // Exposed so a client can send it back on a write and lose a concurrent-edit race
      // cleanly instead of silently clobbering.
      rowVersion,
    };
  }

  private async categories(projectId: number) {
    return this.db
      .select({ name: s.projectCategories.name, defaultHandlerId: s.projectCategories.defaultHandlerId })
      .from(s.projectCategories)
      .where(eq(s.projectCategories.projectId, projectId))
      .orderBy(asc(s.projectCategories.sortOrder));
  }

  private async versions(projectId: number) {
    return this.db
      .select({
        name: s.projectVersions.name,
        date: s.projectVersions.date,
        released: s.projectVersions.released,
        obsolete: s.projectVersions.obsolete,
      })
      .from(s.projectVersions)
      .where(eq(s.projectVersions.projectId, projectId))
      // sortOrder, not name: the array position is the order roadmap and changelog rely on.
      .orderBy(asc(s.projectVersions.sortOrder));
  }

  private async customFieldIds(projectId: number): Promise<number[]> {
    const rows = await this.db
      .select({ id: s.projectCustomFields.customFieldId })
      .from(s.projectCustomFields)
      .where(eq(s.projectCustomFields.projectId, projectId))
      .orderBy(asc(s.projectCustomFields.sortOrder));
    return rows.map((r) => r.id);
  }

  private async tags(issueId: number): Promise<string[]> {
    const rows = await this.db
      .select({ tag: s.issueTags.tag })
      .from(s.issueTags)
      .where(eq(s.issueTags.issueId, issueId))
      .orderBy(asc(s.issueTags.sortOrder));
    return rows.map((r) => r.tag);
  }

  private async monitors(issueId: number): Promise<number[]> {
    const rows = await this.db
      .select({ userId: s.issueMonitors.userId })
      .from(s.issueMonitors)
      .where(eq(s.issueMonitors.issueId, issueId));
    return rows.map((r) => r.userId);
  }

  private async sprint(sprintId: number) {
    const [row] = await this.db
      .select({ id: s.sprints.id, name: s.sprints.name, state: s.sprints.state })
      .from(s.sprints)
      .where(eq(s.sprints.id, sprintId))
      .limit(1);
    return row ?? null;
  }

  /**
   * Relationship targets, with `target: null` where the other issue exists but is invisible.
   *
   * Nulling the target rather than dropping the row is what the frontend does, and it is the
   * honest answer: hiding the row entirely would make a parent/child relationship look absent,
   * while showing the summary would leak a private issue's title.
   */
  private async relationships(
    actor: AuthUser,
    issueId: number,
    wf: Awaited<ReturnType<WorkflowService['get']>>,
  ): Promise<IssueDetail['relationships']> {
    const rows = await this.db
      .select({
        type: s.issueRelationships.type,
        otherId: s.issueRelationships.otherIssueId,
        summary: s.issues.summary,
        status: s.issues.status,
        viewState: s.issues.viewState,
        reporterId: s.issues.reporterId,
        handlerId: s.issues.handlerId,
        projectId: s.issues.projectId,
        projectKey: s.projects.key,
      })
      .from(s.issueRelationships)
      .innerJoin(s.issues, eq(s.issues.id, s.issueRelationships.otherIssueId))
      .innerJoin(s.projects, eq(s.projects.id, s.issues.projectId))
      .where(and(eq(s.issueRelationships.issueId, issueId), isNull(s.issues.deletedAt)))
      .orderBy(asc(s.issueRelationships.otherIssueId));

    const out: IssueDetail['relationships'] = [];
    for (const r of rows) {
      const project = await this.tree.get(r.projectId);
      const visible = canSeeIssue(actor, r, project, wf);
      out.push({
        type: r.type,
        issueId: r.otherId,
        target: visible
          ? { id: r.otherId, key: `${r.projectKey}-${r.otherId}`, summary: r.summary, status: r.status }
          : null,
      });
    }
    return out;
  }

  private async customFields(projectId: number, issueId: number): Promise<IssueDetail['customFields']> {
    const ids = await this.customFieldIds(projectId);
    if (!ids.length) return [];
    const [definitions, values] = await Promise.all([
      this.db.select().from(s.customFields).where(inArray(s.customFields.id, ids)),
      this.db
        .select({ customFieldId: s.issueCustomValues.customFieldId, value: s.issueCustomValues.value })
        .from(s.issueCustomValues)
        .where(eq(s.issueCustomValues.issueId, issueId)),
    ]);
    const byId = new Map(values.map((v) => [v.customFieldId, v.value]));
    // Ordered by the project's own field order, not by id.
    return ids.flatMap((id) => {
      const definition = definitions.find((d) => d.id === id);
      if (!definition) return [];
      return [{
        id,
        name: definition.name,
        type: definition.type,
        options: definition.options ? definition.options.split('\n').filter(Boolean) : [],
        required: definition.required,
        value: byId.get(id) ?? definition.defaultValue,
      }];
    });
  }

  /** Port of the frontend rule: enabled, updater or above, and a member unless manager+. */
  private async assignable(projectId: number): Promise<IssueDetail['assignable']> {
    const project = await this.tree.get(projectId);
    const rows = await this.db
      .select({
        id: s.users.id,
        username: s.users.username,
        realName: s.users.realName,
        avatarColor: s.users.avatarColor,
        accessLevel: s.users.accessLevel,
      })
      .from(s.users)
      .where(and(eq(s.users.enabled, true), isNull(s.users.deletedAt)))
      .orderBy(asc(s.users.realName));

    return rows
      .filter(
        (u) =>
          u.accessLevel >= 40 &&
          (!project || project.members.some((m) => m.userId === u.id) || u.accessLevel >= 70),
      )
      .map(({ accessLevel: _level, ...rest }) => rest);
  }

  /** Total minutes, counting only notes this actor is allowed to see. */
  private async timeSpent(actor: AuthUser, issueId: number, projectId: number): Promise<number> {
    const rows = await this.db
      .select({ timeSpent: s.comments.timeSpent, private: s.comments.private, authorId: s.comments.authorId })
      .from(s.comments)
      .where(and(eq(s.comments.issueId, issueId), isNull(s.comments.deletedAt)));
    const wf = await this.workflow.get();
    const project = await this.tree.get(projectId);
    return rows
      .filter((r) => !r.private || r.authorId === actor.id || can(actor, 'viewPrivate', project, wf))
      .reduce((sum, r) => sum + r.timeSpent, 0);
  }
}
