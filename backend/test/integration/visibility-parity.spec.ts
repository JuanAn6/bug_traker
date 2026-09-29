import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { defaultWorkflow } from '../../src/shared/config';
import type { Db as DbJson, Project, User } from '../../src/shared/models';
import { createSeed } from '../../src/shared/seed';
import { createDb, createPool, type Db } from '../../src/core/database/drizzle.service';
import { comments, issues } from '../../src/core/database/schema';
import { ingestDb } from '../../src/modules/admin/db-import';
import { canSeeIssue, canSeeNote, canSeeProject, can } from '../../src/modules/auth/ability';
import { buildIssueWhere, type VisibilityScope } from '../../src/modules/issues/issue-query.builder';

/**
 * The twin of filter-parity: that suite proves the FILTER translates correctly, this one
 * proves ACCESS CONTROL does.
 *
 * It matters more than it looks. In the browser, visibility is applied in
 * Workspace.visibleIssues() — outside filterIssues() — so a backend that translated only the
 * filter would happily serve private issues. Here the entity predicates (canSeeIssue,
 * canSeeNote) are run in memory over the seeded data and compared against what the SQL scope
 * actually returns, for every seeded user.
 */
describe('visibility parity', () => {
  const SEED_NOW = Date.UTC(2026, 8, 29);
  const wf = defaultWorkflow();
  let json: DbJson;
  let db: Db;
  let pool: ReturnType<typeof createPool>;

  beforeAll(async () => {
    const url = process.env['DATABASE_URL_TEST'];
    if (!url) throw new Error('DATABASE_URL_TEST is required for integration tests');
    json = createSeed(SEED_NOW);
    pool = createPool({ url, poolSize: 2 });
    db = createDb(pool);
    await ingestDb(db, json, {
      mode: 'replace',
      passwordHash: await hash('demo', { algorithm: 2 }),
      source: 'visibility-parity.spec',
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  const projectById = (id: number): Project | undefined => json.projects.find((p) => p.id === id);

  /** The same computation VisibilityService performs, without needing Nest's DI here. */
  const scopeFor = (u: User): VisibilityScope => {
    const visible = json.projects.filter((p) => canSeeProject(u, p));
    return {
      visibleProjectIds: visible.map((p) => p.id),
      privateIssueProjectIds: visible.filter((p) => can(u, 'viewPrivate', p, wf)).map((p) => p.id),
      isAdmin: u.accessLevel === 90,
    };
  };

  describe.each(
    // cdubois is disabled; authentication rejects them before ability is consulted, so there
    // is no scope to compare. The other seven cover 90/70/55/55/55/40/25.
    createSeed(Date.UTC(2026, 8, 29)).users.filter((u) => u.enabled).map((u) => [u.username, u.id] as const),
  )('as %s (id %i)', (username, userId) => {
    const actor = () => json.users.find((u) => u.id === userId)!;

    it('returns exactly the issues the entity predicate allows', async () => {
      const u = actor();
      const expected = json.issues
        .filter((i) => canSeeIssue(u, i, projectById(i.projectId), wf))
        .map((i) => i.id)
        .sort((a, b) => a - b);

      const rows = await db
        .select({ id: issues.id })
        .from(issues)
        // hideStatus:'' so the comparison is about visibility alone, not the default filter.
        .where(buildIssueWhere({ hideStatus: '' }, { meId: u.id, now: new Date(SEED_NOW), scope: scopeFor(u) }, () => []));

      expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual(expected);
    });

    it('returns exactly the notes the entity predicate allows', async () => {
      const u = actor();
      const visibleIssueIds = new Set(
        json.issues.filter((i) => canSeeIssue(u, i, projectById(i.projectId), wf)).map((i) => i.id),
      );
      const expected = json.comments
        .filter((c) => {
          if (!visibleIssueIds.has(c.issueId)) return false;
          const issue = json.issues.find((i) => i.id === c.issueId)!;
          return canSeeNote(u, c, projectById(issue.projectId), wf);
        })
        .map((c) => c.id)
        .sort((a, b) => a - b);

      const scope = scopeFor(u);
      const rows = await db
        .select({ id: comments.id })
        .from(comments)
        .innerJoin(issues, eq(issues.id, comments.issueId))
        .where(
          and(
            isNull(comments.deletedAt),
            buildIssueWhere({ hideStatus: '' }, { meId: u.id, now: new Date(SEED_NOW), scope }, () => []),
            scope.isAdmin
              ? undefined
              : or(
                  eq(comments.private, false),
                  eq(comments.authorId, u.id),
                  inArray(issues.projectId, scope.privateIssueProjectIds.length ? scope.privateIssueProjectIds : [-1]),
                ),
          ),
        );

      expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual(expected);
    });
  });

  describe('the cases that would leak', () => {
    const nwilliams = () => json.users.find((u) => u.username === 'nwilliams')!;
    const dkim = () => json.users.find((u) => u.username === 'dkim')!;

    it('hides the private project from a non-member', async () => {
      const u = nwilliams(); // reporter, member of WEB and MOB only
      const scope = scopeFor(u);
      expect(scope.visibleProjectIds).not.toContain(3); // DATA is private

      const rows = await db
        .select({ id: issues.id, projectId: issues.projectId })
        .from(issues)
        .where(buildIssueWhere({ hideStatus: '' }, { meId: u.id, now: new Date(SEED_NOW), scope }, () => []));
      expect(rows.some((r) => r.projectId === 3)).toBe(false);

      // And the data really is there to be leaked — otherwise this test proves nothing.
      expect(json.issues.filter((i) => i.projectId === 3).length).toBeGreaterThan(0);
    });

    it('hides private issues the actor neither reported nor handles', async () => {
      const u = nwilliams();
      const scope = scopeFor(u);
      const rows = await db
        .select({ id: issues.id })
        .from(issues)
        .where(buildIssueWhere({ viewState: 'private', hideStatus: '' }, { meId: u.id, now: new Date(SEED_NOW), scope }, () => []));

      const returned = new Set(rows.map((r) => r.id));
      const privateIssues = json.issues.filter((i) => i.viewState === 'private');
      expect(privateIssues.length).toBeGreaterThan(0);
      for (const i of privateIssues) {
        const allowed = i.reporterId === u.id || i.handlerId === u.id;
        expect(returned.has(i.id), `issue ${i.id} (reporter ${i.reporterId}, handler ${i.handlerId})`)
          .toBe(allowed && scope.visibleProjectIds.includes(i.projectId));
      }
    });

    it('shows private issues to a developer who clears viewPrivate', async () => {
      const u = dkim(); // 55 >= viewPrivate
      const scope = scopeFor(u);
      const rows = await db
        .select({ id: issues.id })
        .from(issues)
        .where(buildIssueWhere({ viewState: 'private', hideStatus: '' }, { meId: u.id, now: new Date(SEED_NOW), scope }, () => []));
      const expected = json.issues
        .filter((i) => i.viewState === 'private' && canSeeIssue(u, i, projectById(i.projectId), wf))
        .map((i) => i.id);
      expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual(expected.sort((a, b) => a - b));
      expect(expected.length).toBeGreaterThan(0);
    });

    it('lets an administrator see everything', async () => {
      const u = json.users.find((x) => x.accessLevel === 90)!;
      const rows = await db
        .select({ id: issues.id })
        .from(issues)
        .where(buildIssueWhere({ hideStatus: '' }, { meId: u.id, now: new Date(SEED_NOW), scope: scopeFor(u) }, () => []));
      expect(rows).toHaveLength(80);
    });

    it('never widens the result set compared to no scope at all', async () => {
      // A scope may only remove rows. If any user saw more with a scope than without one, the
      // predicate would be doing something other than filtering.
      const unscoped = await db
        .select({ id: issues.id })
        .from(issues)
        .where(buildIssueWhere({ hideStatus: '' }, { meId: 1, now: new Date(SEED_NOW) }, () => []));
      for (const u of json.users.filter((x) => x.enabled)) {
        const scoped = await db
          .select({ id: issues.id })
          .from(issues)
          .where(buildIssueWhere({ hideStatus: '' }, { meId: u.id, now: new Date(SEED_NOW), scope: scopeFor(u) }, () => []));
        expect(scoped.length, u.username).toBeLessThanOrEqual(unscoped.length);
      }
    });
  });
});
