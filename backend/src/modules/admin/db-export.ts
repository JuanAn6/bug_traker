import { asc, isNull } from 'drizzle-orm';
import { SCHEMA_VERSION } from '../../shared/seed';
import type {
  Attachment, Comment, CustomField, Db as DbJson, HistoryEntry, Issue, Notification, Project,
  SavedFilter, Sprint, User, WorkflowConfig,
} from '../../shared/models';
import type { Db } from '../../core/database/drizzle.service';
import * as s from '../../core/database/schema';

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

/**
 * Rebuilds the exact `Db` shape the frontend's `store.importJson()` accepts.
 *
 * This is the contract test for the whole schema: if the normalized tables cannot be reassembled
 * into the browser's own model, something was lost on the way in. The output is meant to load in
 * the running Angular app through Settings → Import without modification.
 */
export async function exportDb(db: Db): Promise<DbJson> {
  const [
    users, prefs, projects, categories, versions, members, projectFields, sprints, issues,
    issueTags, monitors, relationships, customValues, comments, attachments, history,
    notifications, filters, customFields, workflowConfig, transitions, thresholds, colors, wip,
  ] = await Promise.all([
    db.select().from(s.users).where(isNull(s.users.deletedAt)).orderBy(asc(s.users.id)),
    db.select().from(s.userPrefs),
    db.select().from(s.projects).where(isNull(s.projects.deletedAt)).orderBy(asc(s.projects.id)),
    db.select().from(s.projectCategories).orderBy(asc(s.projectCategories.sortOrder)),
    db.select().from(s.projectVersions).orderBy(asc(s.projectVersions.sortOrder)),
    db.select().from(s.projectMembers),
    db.select().from(s.projectCustomFields).orderBy(asc(s.projectCustomFields.sortOrder)),
    db.select().from(s.sprints).where(isNull(s.sprints.deletedAt)).orderBy(asc(s.sprints.id)),
    db.select().from(s.issues).where(isNull(s.issues.deletedAt)).orderBy(asc(s.issues.id)),
    db.select().from(s.issueTags).orderBy(asc(s.issueTags.sortOrder)),
    db.select().from(s.issueMonitors),
    db.select().from(s.issueRelationships),
    db.select().from(s.issueCustomValues),
    db.select().from(s.comments).where(isNull(s.comments.deletedAt)).orderBy(asc(s.comments.id)),
    db.select().from(s.attachments).where(isNull(s.attachments.deletedAt)).orderBy(asc(s.attachments.id)),
    db.select().from(s.historyEntries).orderBy(asc(s.historyEntries.id)),
    db.select().from(s.notifications).orderBy(asc(s.notifications.id)),
    db.select().from(s.savedFilters).where(isNull(s.savedFilters.deletedAt)).orderBy(asc(s.savedFilters.id)),
    db.select().from(s.customFields).orderBy(asc(s.customFields.id)),
    db.select().from(s.workflowConfig),
    db.select().from(s.workflowTransitions),
    db.select().from(s.workflowThresholds),
    db.select().from(s.workflowStatusColors),
    db.select().from(s.workflowWipLimits),
  ]);

  const prefsByUser = new Map(prefs.map((p) => [p.userId, p]));

  const exportedUsers: User[] = users.map((u) => {
    const p = prefsByUser.get(u.id);
    return {
      id: u.id,
      username: u.username,
      realName: u.realName,
      email: u.email,
      accessLevel: u.accessLevel as User['accessLevel'],
      enabled: u.enabled,
      avatarColor: u.avatarColor,
      lastVisit: iso(u.lastVisit),
      created: u.created.toISOString()!,
      // Re-nested from the columns. The five notify flags are columns because the fan-out has to
      // filter on them in SQL; the browser wants them back as one object.
      prefs: {
        language: p?.language ?? 'en',
        theme: p?.theme ?? 'system',
        density: p?.density ?? 'compact',
        defaultProjectId: p?.defaultProjectId ?? null,
        pageSize: p?.pageSize ?? 25,
        homeWidgets: (p?.homeWidgets ?? '').split(',').filter(Boolean) as User['prefs']['homeWidgets'],
        notify: {
          assigned: p?.notifyAssigned ?? true,
          mentioned: p?.notifyMentioned ?? true,
          status: p?.notifyStatus ?? true,
          note: p?.notifyNote ?? true,
          attachment: p?.notifyAttachment ?? true,
        },
        notesNewestFirst: p?.notesNewestFirst ?? false,
      },
    };
  });

  const exportedProjects: Project[] = projects.map((p) => ({
    id: p.id,
    name: p.name,
    key: p.key,
    description: p.description,
    status: p.status,
    viewState: p.viewState,
    enabled: p.enabled,
    parentId: p.parentId,
    // Ordered by sortOrder, which is what the array position meant in the browser.
    categories: categories
      .filter((c) => c.projectId === p.id)
      .map((c) => ({ name: c.name, defaultHandlerId: c.defaultHandlerId })),
    versions: versions
      .filter((v) => v.projectId === p.id)
      .map((v) => ({
        name: v.name, date: v.date, released: v.released,
        obsolete: v.obsolete, description: v.description,
      })),
    members: members
      .filter((m) => m.projectId === p.id)
      .map((m) => ({ userId: m.userId, accessLevel: m.accessLevel as User['accessLevel'] })),
    customFieldIds: projectFields.filter((f) => f.projectId === p.id).map((f) => f.customFieldId),
    created: p.created.toISOString(),
  }));

  const exportedIssues: Issue[] = issues.map((i) => ({
    id: i.id,
    projectId: i.projectId,
    sprintId: i.sprintId,
    category: i.category,
    summary: i.summary,
    description: i.description,
    stepsToReproduce: i.stepsToReproduce,
    additionalInfo: i.additionalInfo,
    status: i.status,
    resolution: i.resolution,
    priority: i.priority,
    severity: i.severity,
    reproducibility: i.reproducibility,
    platform: i.platform,
    os: i.os,
    osBuild: i.osBuild,
    productVersion: i.productVersion,
    targetVersion: i.targetVersion,
    fixedInVersion: i.fixedInVersion,
    reporterId: i.reporterId,
    handlerId: i.handlerId,
    viewState: i.viewState,
    sticky: i.sticky,
    tags: issueTags.filter((t) => t.issueId === i.id).map((t) => t.tag),
    monitorIds: monitors.filter((m) => m.issueId === i.id).map((m) => m.userId),
    // Only one direction is exported: the browser stores both, and the importer re-derives the
    // mirror, so emitting both here would duplicate every link on the way back.
    relationships: relationships
      .filter((r) => r.issueId === i.id)
      .map((r) => ({ type: r.type, issueId: r.otherIssueId })),
    dueDate: i.dueDate,
    estimate: i.estimate,
    storyPoints: i.storyPoints,
    customFields: Object.fromEntries(
      customValues.filter((v) => v.issueId === i.id).map((v) => [v.customFieldId, v.value]),
    ),
    created: i.created.toISOString(),
    updated: i.updated.toISOString(),
  }));

  /**
   * `blobId` is synthesized: the schema keys content by hash with a reference count, so several
   * attachments legitimately share bytes. The browser's model expects a numeric id, so each hash
   * maps to the first attachment id that referenced it — which reproduces exactly the sharing
   * behaviour clone() relied on.
   */
  const blobIdByHash = new Map<string, number>();
  for (const a of attachments) {
    if (!blobIdByHash.has(a.blobHash)) blobIdByHash.set(a.blobHash, a.id);
  }

  const exportedAttachments: Attachment[] = attachments.map((a) => ({
    id: a.id,
    issueId: a.issueId ?? 0,
    commentId: a.commentId,
    name: a.name,
    description: a.description,
    mimeType: a.mimeType,
    size: a.size,
    uploaderId: a.uploaderId,
    date: a.date.toISOString(),
    version: a.version,
    previousVersionId: a.previousVersionId,
    current: a.current,
    blobId: blobIdByHash.get(a.blobHash) ?? a.id,
  }));

  const config = workflowConfig[0];
  const workflow: WorkflowConfig = {
    transitions: Object.fromEntries(
      [...new Set(transitions.map((t) => t.fromStatus))].map((from) => [
        from,
        transitions.filter((t) => t.fromStatus === from).map((t) => t.toStatus),
      ]),
    ) as WorkflowConfig['transitions'],
    thresholds: Object.fromEntries(
      thresholds.map((t) => [t.action, t.level]),
    ) as WorkflowConfig['thresholds'],
    statusColors: Object.fromEntries(
      colors.map((c) => [c.status, c.color]),
    ) as WorkflowConfig['statusColors'],
    resolvedStatus: config?.resolvedStatus ?? 'resolved',
    autoAssignStatus: config?.autoAssignStatus ?? true,
    boardColumns: (config?.boardColumns ?? '').split(',').filter(Boolean) as WorkflowConfig['boardColumns'],
    wipLimits: Object.fromEntries(wip.map((w) => [w.status, w.limitValue])),
  };

  // `seq` was one shared counter in the browser. Here every table has its own sequence, so the
  // maximum across them is the only value that keeps a re-import collision-free.
  const seq = Math.max(
    0,
    ...exportedUsers.map((u) => u.id),
    ...exportedProjects.map((p) => p.id),
    ...sprints.map((x) => x.id),
    ...exportedIssues.map((i) => i.id),
    ...comments.map((c) => c.id),
    ...attachments.map((a) => a.id),
    ...history.map((h) => h.id),
    ...notifications.map((n) => n.id),
    ...filters.map((f) => f.id),
    ...customFields.map((f) => f.id),
  );

  return {
    schema: SCHEMA_VERSION,
    seq,
    users: exportedUsers,
    projects: exportedProjects,
    sprints: sprints.map((x) => ({
      id: x.id, projectId: x.projectId, name: x.name, goal: x.goal,
      start: x.start, end: x.end, state: x.state, capacity: x.capacity,
    })) as Sprint[],
    issues: exportedIssues,
    comments: comments.map((c) => ({
      id: c.id, issueId: c.issueId, authorId: c.authorId, body: c.body,
      private: c.private, timeSpent: c.timeSpent,
      created: c.created.toISOString(), edited: iso(c.edited),
    })) as Comment[],
    attachments: exportedAttachments,
    history: history.map((h) => ({
      id: h.id, issueId: h.issueId, userId: h.userId, date: h.date.toISOString(),
      type: h.type, field: h.field, old: h.oldValue, new: h.newValue,
    })) as HistoryEntry[],
    filters: filters.map((f) => ({
      id: f.id, name: f.name, ownerId: f.ownerId, shared: f.shared,
      projectId: f.projectId, isDefault: f.isDefault,
      criteria: JSON.parse(f.criteria) as SavedFilter['criteria'],
      columns: f.columns.split(',').filter(Boolean) as SavedFilter['columns'],
      sort: f.sort
        ? f.sort.split(',').filter(Boolean).map((part) => {
            const [column, dir] = part.split(':');
            return { column, dir: dir === 'asc' ? 'asc' : 'desc' };
          })
        : [],
    })) as SavedFilter[],
    notifications: notifications.map((n) => ({
      id: n.id, userId: n.userId, issueId: n.issueId, actorId: n.actorId,
      type: n.type, text: n.text, read: n.read, date: n.date.toISOString(),
    })) as Notification[],
    customFields: customFields.map((f) => ({
      id: f.id, name: f.name, type: f.type,
      options: f.options ? f.options.split('\n').filter(Boolean) : [],
      required: f.required, defaultValue: f.defaultValue,
    })) as CustomField[],
    workflow,
  };
}
