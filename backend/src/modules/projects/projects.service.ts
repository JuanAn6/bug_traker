import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain-error';
import { DRIZZLE, type Db } from '../../core/database/drizzle.service';
import * as s from '../../core/database/schema';
import { insertedId, UnitOfWork, type Tx } from '../../core/database/unit-of-work';
import { ProjectTreeService } from '../../core/project-tree/project-tree.service';
import type { AuthUser } from '../auth/auth.types';
import { HistoryWriter } from '../history/history.writer';
import { issueSearchNorm } from '../issues/domain/search-text';
import type {
  CategoryDto, CreateProjectDto, MemberDto, UpdateProjectDto, VersionDto,
} from './dto/project.dto';

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly uow: UnitOfWork,
    private readonly tree: ProjectTreeService,
    private readonly history: HistoryWriter,
  ) {}

  async create(actor: AuthUser, input: CreateProjectDto): Promise<{ id: number }> {
    await this.assertKeyFree(input.key);
    if (input.parentId) await this.requireProject(input.parentId);

    const id = await this.uow.transaction(async (tx) => {
      const projectId = insertedId(
        await tx.insert(s.projects).values({
          name: input.name,
          key: input.key.toUpperCase(),
          keyUpper: input.key.toUpperCase(),
          description: input.description ?? null,
          status: input.status ?? 'development',
          viewState: input.viewState ?? 'public',
          enabled: input.enabled ?? true,
          parentId: input.parentId ?? null,
          created: new Date(),
        }),
      );

      // A project with no categories cannot accept an issue, so one is seeded — the same
      // 'General' the frontend's create() starts from.
      await tx.insert(s.projectCategories).values({
        projectId, name: 'General', defaultHandlerId: null, sortOrder: 0,
      });
      // And the creator is a manager of it, or they could not edit what they just made.
      await tx.insert(s.projectMembers).values({ projectId, userId: actor.id, accessLevel: 70 });

      await this.uow.outbox(tx, 'project.created', { projectId, actorId: actor.id });
      return projectId;
    });

    await this.tree.invalidate();
    return { id };
  }

  /**
   * A whole-project save.
   *
   * The hard part is not the scalar fields but the name-matched value objects: categories and
   * versions are referenced by NAME from `issues`, so a rename has to rewrite every issue that
   * used the old name, and a delete has to send its issues somewhere. Both happen in the same
   * transaction as the project row, so the data is never briefly inconsistent.
   */
  async update(actor: AuthUser, id: number, input: UpdateProjectDto): Promise<void> {
    const project = await this.requireProject(id);
    if (input.key && input.key.toUpperCase() !== project.key.toUpperCase()) {
      await this.assertKeyFree(input.key, id);
    }
    if (input.parentId !== undefined && input.parentId !== null) {
      await this.assertNoCycle(id, input.parentId);
    }

    await this.uow.transaction(async (tx) => {
      const scalars: Partial<typeof s.projects.$inferInsert> = {};
      if (input.name !== undefined) scalars.name = input.name;
      if (input.key !== undefined) {
        scalars.key = input.key.toUpperCase();
        scalars.keyUpper = input.key.toUpperCase();
      }
      if (input.description !== undefined) scalars.description = input.description;
      if (input.status !== undefined) scalars.status = input.status;
      if (input.viewState !== undefined) scalars.viewState = input.viewState;
      if (input.enabled !== undefined) scalars.enabled = input.enabled;
      if (input.parentId !== undefined) scalars.parentId = input.parentId;
      if (Object.keys(scalars).length) {
        await tx.update(s.projects).set(scalars).where(eq(s.projects.id, id));
      }

      if (input.categories) {
        await this.syncCategories(tx, actor, id, input.categories, input.categoryMerges ?? {});
      }
      if (input.versions) {
        await this.syncVersions(tx, actor, id, input.versions);
      }
      if (input.members) {
        await this.syncMembers(tx, id, input.members);
      }
      if (input.customFieldIds) {
        await tx.delete(s.projectCustomFields).where(eq(s.projectCustomFields.projectId, id));
        if (input.customFieldIds.length) {
          await tx.insert(s.projectCustomFields).values(
            input.customFieldIds.map((customFieldId, sortOrder) => ({ projectId: id, customFieldId, sortOrder })),
          );
        }
      }

      await this.uow.outbox(tx, 'project.updated', { projectId: id, actorId: actor.id });
    });

    await this.tree.invalidate();
  }

  /**
   * Reconciles the category list.
   *
   * Three cases, and each one has to touch `issues`:
   *  - renamed (carries `previousName`): rewrite `issues.category`, and log it per issue;
   *  - deleted while still in use: move its issues to the nominated target, which the caller
   *    must supply — the frontend's project-edit page forces that choice rather than guessing;
   *  - added: nothing to migrate.
   *
   * The frontend does the rewriting but writes NO history for it, so a category rename across
   * forty issues leaves no trace. Logged here.
   */
  private async syncCategories(
    tx: Tx,
    actor: AuthUser,
    projectId: number,
    incoming: CategoryDto[],
    merges: Record<string, string>,
  ): Promise<void> {
    const names = incoming.map((c) => c.name);
    if (new Set(names).size !== names.length) {
      throw new ValidationError('errors.validation', 'Category names must be unique');
    }
    if (!names.length) {
      throw new ValidationError('errors.validation', 'A project needs at least one category');
    }

    const existing = await tx
      .select()
      .from(s.projectCategories)
      .where(eq(s.projectCategories.projectId, projectId));
    const existingNames = new Set(existing.map((c) => c.name));

    // Renames first, so a rename to a name that is also being freed still works.
    for (const category of incoming) {
      if (!category.previousName || category.previousName === category.name) continue;
      if (!existingNames.has(category.previousName)) continue;
      await this.rewriteCategory(tx, actor, projectId, category.previousName, category.name);
      existingNames.delete(category.previousName);
      existingNames.add(category.name);
    }

    // Deletions: anything no longer present, with its issues moved somewhere real.
    const keep = new Set(names);
    for (const name of existingNames) {
      if (keep.has(name)) continue;
      const [counted] = await tx
        .select({ count: sql<number>`COUNT(*)` })
        .from(s.issues)
        .where(and(eq(s.issues.projectId, projectId), eq(s.issues.category, name)));
      const count = Number(counted?.count ?? 0);

      if (count > 0) {
        const target = merges[name];
        if (!target || !keep.has(target)) {
          throw new ConflictError('errors.categoryInUse', { name, count });
        }
        await this.rewriteCategory(tx, actor, projectId, name, target);
      }
    }

    await tx.delete(s.projectCategories).where(eq(s.projectCategories.projectId, projectId));
    await tx.insert(s.projectCategories).values(
      incoming.map((category, sortOrder) => ({
        projectId,
        name: category.name,
        defaultHandlerId: category.defaultHandlerId ?? null,
        sortOrder,
      })),
    );
  }

  /** Moves every issue from one category name to another, logging each one. */
  private async rewriteCategory(
    tx: Tx,
    actor: AuthUser,
    projectId: number,
    from: string,
    to: string,
  ): Promise<void> {
    const affected = await tx
      .select({ id: s.issues.id })
      .from(s.issues)
      .where(and(eq(s.issues.projectId, projectId), eq(s.issues.category, from)));
    if (!affected.length) return;

    await tx
      .update(s.issues)
      .set({ category: to, updated: new Date() })
      .where(and(eq(s.issues.projectId, projectId), eq(s.issues.category, from)));

    // One row per issue: a category rename IS a change to every issue that used it, and the
    // frontend's silent rewrite is one of the parity gaps the plan chose to close.
    await this.history.writeMany(
      tx,
      actor.id,
      affected.map((issue) => ({
        issueId: issue.id, type: 'field' as const, field: 'category', old: from, new: to,
      })),
    );
    await this.reindex(tx, affected.map((i) => i.id));
  }

  /**
   * Reconciles the version list, preserving order.
   *
   * `sortOrder` is the array position, and it is load-bearing: roadmap reads it forwards,
   * changelog backwards. A rename rewrites all THREE version columns on the issues —
   * `productVersion`, `targetVersion` and `fixedInVersion` — because all three hold version
   * names and leaving any behind would orphan it.
   */
  private async syncVersions(
    tx: Tx,
    actor: AuthUser,
    projectId: number,
    incoming: VersionDto[],
  ): Promise<void> {
    const names = incoming.map((v) => v.name);
    if (new Set(names).size !== names.length) {
      throw new ValidationError('errors.validation', 'Version names must be unique');
    }

    for (const version of incoming) {
      if (!version.previousName || version.previousName === version.name) continue;
      await this.rewriteVersion(tx, actor, projectId, version.previousName, version.name);
    }

    // A deleted version is cleared from the issues rather than left dangling.
    const existing = await tx
      .select({ name: s.projectVersions.name })
      .from(s.projectVersions)
      .where(eq(s.projectVersions.projectId, projectId));
    const keep = new Set(names);
    const renamedFrom = new Set(incoming.map((v) => v.previousName).filter(Boolean));
    for (const version of existing) {
      if (keep.has(version.name) || renamedFrom.has(version.name)) continue;
      await this.rewriteVersion(tx, actor, projectId, version.name, '');
    }

    await tx.delete(s.projectVersions).where(eq(s.projectVersions.projectId, projectId));
    if (incoming.length) {
      await tx.insert(s.projectVersions).values(
        incoming.map((version, sortOrder) => ({
          projectId,
          name: version.name,
          date: version.date ?? null,
          released: version.released ?? false,
          obsolete: version.obsolete ?? false,
          description: version.description ?? '',
          sortOrder,
        })),
      );
    }
  }

  private async rewriteVersion(
    tx: Tx,
    actor: AuthUser,
    projectId: number,
    from: string,
    to: string,
  ): Promise<void> {
    const columns = [
      { column: s.issues.productVersion, field: 'productVersion' },
      { column: s.issues.targetVersion, field: 'targetVersion' },
      { column: s.issues.fixedInVersion, field: 'fixedInVersion' },
    ] as const;

    for (const { column, field } of columns) {
      const affected = await tx
        .select({ id: s.issues.id })
        .from(s.issues)
        .where(and(eq(s.issues.projectId, projectId), eq(column, from)));
      if (!affected.length) continue;

      await tx
        .update(s.issues)
        .set({ [field]: to, updated: new Date() })
        .where(and(eq(s.issues.projectId, projectId), eq(column, from)));

      await this.history.writeMany(
        tx,
        actor.id,
        affected.map((issue) => ({
          issueId: issue.id, type: 'field' as const, field, old: from, new: to,
        })),
      );
    }
  }

  private async syncMembers(tx: Tx, projectId: number, members: MemberDto[]): Promise<void> {
    const userIds = members.map((m) => m.userId);
    if (new Set(userIds).size !== userIds.length) {
      throw new ValidationError('errors.validation', 'A user cannot appear twice in the members list');
    }
    if (userIds.length) {
      const known = await tx
        .select({ id: s.users.id })
        .from(s.users)
        .where(and(inArray(s.users.id, userIds), isNull(s.users.deletedAt)));
      if (known.length !== userIds.length) {
        throw new ValidationError('errors.validation', 'Unknown user in the members list');
      }
    }
    await tx.delete(s.projectMembers).where(eq(s.projectMembers.projectId, projectId));
    if (members.length) {
      await tx.insert(s.projectMembers).values(
        members.map((m) => ({ projectId, userId: m.userId, accessLevel: m.accessLevel })),
      );
    }
  }

  /** Reorders versions without touching anything else. */
  async reorderVersions(id: number, names: string[]): Promise<void> {
    await this.requireProject(id);
    await this.uow.transaction(async (tx) => {
      const existing = await tx
        .select({ name: s.projectVersions.name })
        .from(s.projectVersions)
        .where(eq(s.projectVersions.projectId, id));
      const known = new Set(existing.map((v) => v.name));
      if (names.length !== known.size || names.some((n) => !known.has(n))) {
        throw new ValidationError('errors.validation', 'The order must list every version exactly once');
      }
      for (const [sortOrder, name] of names.entries()) {
        await tx
          .update(s.projectVersions)
          .set({ sortOrder })
          .where(and(eq(s.projectVersions.projectId, id), eq(s.projectVersions.name, name)));
      }
    });
    await this.tree.invalidate();
  }

  /**
   * Soft-deletes a project and everything scoped to it.
   *
   * Child projects are orphaned rather than deleted (`parentId = null`), matching the frontend:
   * deleting a parent should not silently take its subprojects with it. Users' default project
   * preference is cleared, which is the one place the FK-less column has to be maintained by hand.
   */
  async remove(actor: AuthUser, id: number): Promise<void> {
    await this.requireProject(id);
    await this.uow.transaction(async (tx) => {
      const now = new Date();
      await tx.update(s.projects).set({ parentId: null }).where(eq(s.projects.parentId, id));

      const issues = await tx
        .select({ id: s.issues.id })
        .from(s.issues)
        .where(and(eq(s.issues.projectId, id), isNull(s.issues.deletedAt)));
      const issueIds = issues.map((i) => i.id);

      if (issueIds.length) {
        await tx.update(s.issues).set({ deletedAt: now }).where(inArray(s.issues.id, issueIds));
        await tx.update(s.comments).set({ deletedAt: now })
          .where(and(inArray(s.comments.issueId, issueIds), isNull(s.comments.deletedAt)));
      }
      await tx.update(s.sprints).set({ deletedAt: now })
        .where(and(eq(s.sprints.projectId, id), isNull(s.sprints.deletedAt)));
      await tx.update(s.projects).set({ deletedAt: now }).where(eq(s.projects.id, id));

      // No FK on userPrefs.defaultProjectId — users and projects would be circular modules — so
      // it is cleared here, exactly as Projects.remove does.
      await tx.update(s.userPrefs).set({ defaultProjectId: null })
        .where(eq(s.userPrefs.defaultProjectId, id));

      await this.uow.outbox(tx, 'project.deleted', { projectId: id, actorId: actor.id });
    });
    await this.tree.invalidate();
  }

  async keyAvailable(key: string, exceptId?: number): Promise<boolean> {
    const rows = await this.db
      .select({ id: s.projects.id })
      .from(s.projects)
      .where(exceptId
        ? and(eq(s.projects.keyUpper, key.toUpperCase()), ne(s.projects.id, exceptId))
        : eq(s.projects.keyUpper, key.toUpperCase()));
    return rows.length === 0;
  }

  /** searchNorm includes the tags but not the category, so only a tag change needs it — this
   * exists for the category rewrite, where `updated` moves and the row is rewritten anyway. */
  private async reindex(tx: Tx, issueIds: number[]): Promise<void> {
    if (!issueIds.length) return;
    const rows = await tx
      .select({
        id: s.issues.id,
        summary: s.issues.summary,
        description: s.issues.description,
        stepsToReproduce: s.issues.stepsToReproduce,
        additionalInfo: s.issues.additionalInfo,
      })
      .from(s.issues)
      .where(inArray(s.issues.id, issueIds));

    for (const row of rows) {
      const tags = (
        await tx.select({ tag: s.issueTags.tag }).from(s.issueTags)
          .where(eq(s.issueTags.issueId, row.id)).orderBy(asc(s.issueTags.sortOrder))
      ).map((t) => t.tag);
      await tx.update(s.issues)
        .set({ searchNorm: issueSearchNorm({ ...row, tags }) })
        .where(eq(s.issues.id, row.id));
    }
  }

  private async requireProject(id: number) {
    const project = await this.tree.get(id);
    if (!project) throw new NotFoundError('project', id);
    return project;
  }

  private async assertKeyFree(key: string, exceptId?: number): Promise<void> {
    if (!(await this.keyAvailable(key, exceptId))) {
      throw new ConflictError('errors.keyTaken', { key: key.toUpperCase() });
    }
  }

  /** A project cannot become its own descendant's child. */
  private async assertNoCycle(id: number, parentId: number): Promise<void> {
    if (id === parentId) {
      throw new ValidationError('errors.validation', 'A project cannot be its own parent');
    }
    const descendants = await this.tree.descendants([id]);
    if (descendants.includes(parentId)) {
      throw new ValidationError('errors.validation', 'That parent is a descendant of this project');
    }
  }
}
