import { Inject, Injectable } from '@nestjs/common';
import { isNull } from 'drizzle-orm';
import type { AccessLevel, ViewState } from '../../shared/models';
import type { ProjectLike } from '../../modules/auth/ability';
import { CACHE_PORT, type CachePort } from '../ports/cache.port';
import { DRIZZLE, type Db } from '../database/drizzle.service';
import * as s from '../database/schema';

const KEY = 'projects:tree';
const TTL_MS = 30_000;

export interface ProjectNode extends ProjectLike {
  id: number;
  name: string;
  key: string;
  parentId: number | null;
  viewState: ViewState;
  enabled: boolean;
  members: { userId: number; accessLevel: AccessLevel }[];
}

interface Tree {
  byId: Record<number, ProjectNode>;
  ids: number[];
}

/**
 * Keeps the whole project tree (with memberships) in memory.
 *
 * Justified by size and by reuse: a bug tracker has tens of projects, not thousands, and the
 * same data answers the subproject closure for the issue filter, the visible-project set for
 * every query's access control, /roadmap, /summary and the navigator counts. A recursive CTE
 * per request would be correct but wasteful; MariaDB 10.4 supports one if the tree ever grows
 * past what is comfortable to hold.
 */
@Injectable()
export class ProjectTreeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(CACHE_PORT) private readonly cache: CachePort,
  ) {}

  async invalidate(): Promise<void> {
    await this.cache.del(KEY);
    // Visibility scopes are derived from this tree.
    await this.cache.delByPrefix('scope:');
  }

  async get(id: number): Promise<ProjectNode | undefined> {
    return (await this.tree()).byId[id];
  }

  async all(): Promise<ProjectNode[]> {
    const tree = await this.tree();
    return tree.ids.map((id) => tree.byId[id]!);
  }

  /**
   * Transitive closure downwards, including the roots themselves.
   * Port of descendantProjectIds(): a fixed-point loop, so nesting depth is unbounded.
   */
  async descendants(roots: number[]): Promise<number[]> {
    if (!roots.length) return [];
    const all = await this.all();
    const out = new Set(roots);
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of all) {
        if (p.parentId !== null && out.has(p.parentId) && !out.has(p.id)) {
          out.add(p.id);
          grew = true;
        }
      }
    }
    return [...out];
  }

  /**
   * Only DIRECT children, plus the project itself.
   *
   * Deliberately different from descendants(): the frontend's Workspace.projectsInScope goes
   * one level deep while its filter goes all the way down, and /roadmap and /changelog use the
   * shallow one. Reproducing the inconsistency beats quietly "fixing" it and changing what
   * those two pages show.
   */
  async withDirectChildren(root: number): Promise<number[]> {
    const all = await this.all();
    return [root, ...all.filter((p) => p.parentId === root).map((p) => p.id)];
  }

  private async tree(): Promise<Tree> {
    const cached = await this.cache.get<Tree>(KEY);
    if (cached) return cached;

    const [rows, members] = await Promise.all([
      this.db
        .select({
          id: s.projects.id,
          name: s.projects.name,
          key: s.projects.key,
          parentId: s.projects.parentId,
          viewState: s.projects.viewState,
          enabled: s.projects.enabled,
        })
        .from(s.projects)
        .where(isNull(s.projects.deletedAt)),
      this.db.select().from(s.projectMembers),
    ]);

    const byId: Record<number, ProjectNode> = {};
    for (const r of rows) byId[r.id] = { ...r, members: [] };
    for (const m of members) {
      byId[m.projectId]?.members.push({
        userId: m.userId,
        accessLevel: m.accessLevel as AccessLevel,
      });
    }

    const tree: Tree = { byId, ids: rows.map((r) => r.id) };
    await this.cache.set(KEY, tree, TTL_MS);
    return tree;
  }
}
