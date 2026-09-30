import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, like, sql } from 'drizzle-orm';
import type { AccessLevel } from '../../shared/models';
import { DRIZZLE, type Db } from '../../core/database/drizzle.service';
import * as s from '../../core/database/schema';
import { ProjectTreeService } from '../../core/project-tree/project-tree.service';
import type { AuthUser } from '../auth/auth.types';
import { VisibilityService } from '../auth/visibility.service';

/**
 * The reference data the shell needs on nearly every screen: which projects the caller can see
 * (with their categories, versions and members), who can be assigned things, which sprints and
 * tags exist.
 *
 * Grouped into one module rather than one per entity because they share a single constraint —
 * every list is scoped to the caller's visible projects — and because the navigator fetches
 * most of them together.
 */
@Injectable()
export class CatalogService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly tree: ProjectTreeService,
    private readonly visibility: VisibilityService,
  ) {}

  /** Visible projects, with everything the project switcher and the navigator render. */
  async projects(actor: AuthUser) {
    const scope = await this.visibility.scope(actor);
    if (!scope.visibleProjectIds.length) return [];

    const ids = scope.visibleProjectIds;
    const [rows, categories, versions, members, customFields, counts] = await Promise.all([
      this.db
        .select()
        .from(s.projects)
        .where(and(inArray(s.projects.id, ids), isNull(s.projects.deletedAt)))
        .orderBy(asc(s.projects.name)),
      this.db.select().from(s.projectCategories).where(inArray(s.projectCategories.projectId, ids))
        .orderBy(asc(s.projectCategories.sortOrder)),
      this.db.select().from(s.projectVersions).where(inArray(s.projectVersions.projectId, ids))
        .orderBy(asc(s.projectVersions.sortOrder)),
      this.db.select().from(s.projectMembers).where(inArray(s.projectMembers.projectId, ids)),
      this.db.select().from(s.projectCustomFields).where(inArray(s.projectCustomFields.projectId, ids))
        .orderBy(asc(s.projectCustomFields.sortOrder)),
      // Open-issue counts for the navigator badges, in one grouped query rather than N.
      this.db
        .select({ projectId: s.issues.projectId, open: sql<number>`COUNT(*)` })
        .from(s.issues)
        .where(and(
          inArray(s.issues.projectId, ids),
          isNull(s.issues.deletedAt),
          sql`${s.issues.statusRank} < 5`,
        ))
        .groupBy(s.issues.projectId),
    ]);

    const openByProject = new Map(counts.map((c) => [c.projectId, Number(c.open)]));

    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      key: p.key,
      description: p.description,
      status: p.status,
      viewState: p.viewState,
      enabled: p.enabled,
      parentId: p.parentId,
      created: p.created.toISOString(),
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
        .map((m) => ({ userId: m.userId, accessLevel: m.accessLevel as AccessLevel })),
      customFieldIds: customFields.filter((f) => f.projectId === p.id).map((f) => f.customFieldId),
      openIssues: openByProject.get(p.id) ?? 0,
    }));
  }

  /**
   * The user list every picker and avatar needs.
   *
   * No emails and no hashes: this is readable by any authenticated user, and the frontend's
   * pickers only ever show a username, a real name and an avatar colour. Full user records live
   * behind the `manageUsers` threshold in the users module.
   */
  async users() {
    const rows = await this.db
      .select({
        id: s.users.id,
        username: s.users.username,
        realName: s.users.realName,
        accessLevel: s.users.accessLevel,
        enabled: s.users.enabled,
        avatarColor: s.users.avatarColor,
      })
      .from(s.users)
      .where(isNull(s.users.deletedAt))
      .orderBy(asc(s.users.realName));
    return rows.map((u) => ({ ...u, accessLevel: u.accessLevel as AccessLevel }));
  }

  async sprints(actor: AuthUser, projectId?: number) {
    const scope = await this.visibility.scope(actor);
    if (!scope.visibleProjectIds.length) return [];
    const ids = projectId
      ? (await this.tree.descendants([projectId])).filter((id) => scope.visibleProjectIds.includes(id))
      : scope.visibleProjectIds;
    if (!ids.length) return [];

    const rows = await this.db
      .select()
      .from(s.sprints)
      .where(and(inArray(s.sprints.projectId, ids), isNull(s.sprints.deletedAt)))
      // Newest first, which is what the sprint list and the board's selector show.
      .orderBy(desc(s.sprints.start));

    return rows.map((sp) => ({
      id: sp.id,
      projectId: sp.projectId,
      name: sp.name,
      goal: sp.goal,
      start: sp.start,
      end: sp.end,
      state: sp.state,
      capacity: sp.capacity,
    }));
  }

  /**
   * The tag vocabulary with usage counts, scoped to what the caller can see.
   *
   * Tags are not an entity — they are derived from issueTags, exactly as the frontend derives
   * them from issue.tags. Sorted by name, matching Store.tags.
   */
  async tags(actor: AuthUser, query?: string) {
    const scope = await this.visibility.scope(actor);
    if (!scope.visibleProjectIds.length) return [];

    const conditions = [
      inArray(s.issues.projectId, scope.visibleProjectIds),
      isNull(s.issues.deletedAt),
    ];
    // The tag column is utf8mb4_unicode_ci, so this is already case- and accent-insensitive.
    if (query) conditions.push(like(s.issueTags.tag, `${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`));

    const rows = await this.db
      .select({ tag: s.issueTags.tag, count: sql<number>`COUNT(*)` })
      .from(s.issueTags)
      .innerJoin(s.issues, eq(s.issues.id, s.issueTags.issueId))
      .where(and(...conditions))
      .groupBy(s.issueTags.tag)
      .orderBy(asc(s.issueTags.tag));

    return rows.map((r) => ({ tag: r.tag, count: Number(r.count) }));
  }

  /** Custom field definitions, with usage counts and the projects they are linked to. */
  async customFields() {
    const [definitions, links, usage] = await Promise.all([
      this.db.select().from(s.customFields).orderBy(asc(s.customFields.name)),
      this.db.select().from(s.projectCustomFields),
      this.db
        .select({ customFieldId: s.issueCustomValues.customFieldId, used: sql<number>`COUNT(*)` })
        .from(s.issueCustomValues)
        // The frontend's usage() counts non-empty values, so '' does not count as "in use".
        .where(sql`${s.issueCustomValues.value} <> ''`)
        .groupBy(s.issueCustomValues.customFieldId),
    ]);
    const usedById = new Map(usage.map((u) => [u.customFieldId, Number(u.used)]));

    return definitions.map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      options: d.options ? d.options.split('\n').filter(Boolean) : [],
      required: d.required,
      defaultValue: d.defaultValue,
      projectIds: links.filter((l) => l.customFieldId === d.id).map((l) => l.projectId),
      usage: usedById.get(d.id) ?? 0,
    }));
  }

  /** Saved filters: the caller's own, plus the ones others shared. */
  async savedFilters(actor: AuthUser) {
    const rows = await this.db
      .select()
      .from(s.savedFilters)
      .where(and(
        isNull(s.savedFilters.deletedAt),
        sql`(${s.savedFilters.ownerId} = ${actor.id} OR ${s.savedFilters.shared} = 1)`,
      ))
      .orderBy(asc(s.savedFilters.name));

    return rows.map((f) => ({
      id: f.id,
      name: f.name,
      ownerId: f.ownerId,
      shared: f.shared,
      projectId: f.projectId,
      isDefault: f.isDefault,
      criteria: JSON.parse(f.criteria) as unknown,
      columns: f.columns ? f.columns.split(',').filter(Boolean) : [],
      sort: f.sort
        ? f.sort.split(',').filter(Boolean).map((part) => {
            const [column, dir] = part.split(':');
            return { column, dir: dir === 'asc' ? 'asc' : 'desc' };
          })
        : [],
    }));
  }
}
