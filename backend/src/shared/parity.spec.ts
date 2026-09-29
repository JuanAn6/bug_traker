import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_LEVELS, BLOCKED_EXTENSIONS, MAX_FILE_SIZE, REVERSE_RELATIONSHIP, STATUSES,
  defaultPrefs, defaultWorkflow, emptyCriteria,
} from './config';

/**
 * Guards the copied modules against drift from the frontend.
 *
 * A divergence here would not fail a type-check — it would quietly make the API answer
 * queries differently than the UI does. The digest check is the real test; the assertions
 * below are a second net around the values whose exact content the schema depends on.
 */
describe('shared module parity', () => {
  it('has identical bytes to frontend/src/app/core', () => {
    const root = join(__dirname, '../..');
    try {
      execFileSync('node', ['scripts/sync-shared.mjs', '--check'], { cwd: root, stdio: 'pipe' });
    } catch (e) {
      const err = e as { stderr?: Buffer; stdout?: Buffer };
      throw new Error(String(err.stderr ?? err.stdout ?? e));
    }
  });

  it('keeps the status order the *Rank columns are built from', () => {
    // Reordering this array is a data migration: MariaDB stores the ENUM ordinal and every
    // statusRank value in the database is an index into it.
    expect(STATUSES).toEqual([
      'new', 'feedback', 'acknowledged', 'confirmed', 'assigned', 'resolved', 'closed',
    ]);
  });

  it('keeps all 22 permission thresholds', () => {
    const { thresholds } = defaultWorkflow();
    expect(Object.keys(thresholds)).toHaveLength(22);
    // Spot-check the ones the API's guards lean on hardest.
    expect(thresholds.view).toBe(10);
    expect(thresholds.report).toBe(25);
    expect(thresholds.viewPrivate).toBe(55);
    expect(thresholds.delete).toBe(70);
    expect(thresholds.manageWorkflow).toBe(90);
  });

  it('keeps the transition matrix', () => {
    const { transitions } = defaultWorkflow();
    expect(transitions.closed).toEqual(['feedback']);
    expect(transitions.resolved).toEqual(['feedback', 'assigned', 'closed']);
  });

  it('keeps relationship reversal symmetric and self-inverse where it should be', () => {
    expect(REVERSE_RELATIONSHIP.related_to).toBe('related_to');
    expect(REVERSE_RELATIONSHIP.parent_of).toBe('child_of');
    expect(REVERSE_RELATIONSHIP.duplicate_of).toBe('has_duplicate');
    for (const [a, b] of Object.entries(REVERSE_RELATIONSHIP)) {
      expect(REVERSE_RELATIONSHIP[b], `${a} must reverse back to itself`).toBe(a);
    }
  });

  it('keeps the filter defaults that a bare GET /issues must honour', () => {
    const c = emptyCriteria();
    // These two are the single most common way to get the list endpoint subtly wrong.
    expect(c.hideStatus).toBe('closed');
    expect(c.includeSubprojects).toBe(true);
    expect(c.hasAttachments).toBeNull();
    expect(c.tagsMode).toBe('any');
  });

  it('keeps the upload limits and access levels', () => {
    expect(MAX_FILE_SIZE).toBe(10 * 1024 * 1024);
    expect(BLOCKED_EXTENSIONS).toContain('exe');
    expect(BLOCKED_EXTENSIONS).toContain('sh');
    expect(ACCESS_LEVELS).toEqual([10, 25, 40, 55, 70, 90]);
  });

  it('keeps the default prefs the userPrefs columns mirror', () => {
    const p = defaultPrefs();
    expect(p.pageSize).toBe(25);
    expect(Object.keys(p.notify)).toEqual(['assigned', 'mentioned', 'status', 'note', 'attachment']);
    // The default deliberately omits 'feedback' even though HOME_WIDGETS includes it.
    expect(p.homeWidgets).not.toContain('feedback');
  });
});
