import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { issueIdShortcut, norm, searchWords } from '../../src/shared/norm';

describe('norm', () => {
  /**
   * norm.ts is hand-written because issue-filter.ts keeps its norm() private. This test
   * pulls the actual regex literal out of the copied file and re-runs it, so the two cannot
   * silently diverge — which would make SQL search and UI search disagree on accents.
   */
  it('matches the implementation inside the copied filter-semantics.ts', () => {
    const src = readFileSync(join(__dirname, '../../src/shared/filter-semantics.ts'), 'utf8');
    const line = /const norm = (\(s: string\) => [^;]+);/.exec(src);
    expect(line, 'norm() not found in filter-semantics.ts — did the frontend rename it?').toBeTruthy();

    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const frontendNorm = new Function(`return ${line![1]!.replace(/: string/g, '')}`)() as (s: string) => string;
    const samples = [
      'María López', 'CRASH', 'Añadir configuración', 'Chloé Dubois', 'ÉÈÊË',
      'straße', '  spaced  out ', 'Über', 'naïve café', 'MOB-2', '#123',
    ];
    for (const s of samples) expect(norm(s), s).toBe(frontendNorm(s));
  });

  it('strips diacritics and lowercases', () => {
    expect(norm('María')).toBe('maria');
    expect(norm('Chloé DUBOIS')).toBe('chloe dubois');
  });

  it('splits a query into the words that must all match', () => {
    expect(searchWords('  Maria   López ')).toEqual(['maria', 'lopez']);
    expect(searchWords('   ')).toEqual([]);
  });

  describe('issueIdShortcut', () => {
    it('recognizes #id and KEY-id', () => {
      expect(issueIdShortcut('#7')).toBe(7);
      expect(issueIdShortcut('7')).toBe(7);
      expect(issueIdShortcut('WEB-2')).toBe(2);
      expect(issueIdShortcut('web-2')).toBe(2);
    });

    it('ignores the project key, replicating the frontend quirk', () => {
      // Documented parity gap: `MOB-2` finds issue 2 even if it lives in WEB. A test pins
      // it so the behaviour is a decision rather than an accident.
      expect(issueIdShortcut('MOB-2')).toBe(2);
    });

    it('returns null for ordinary text', () => {
      expect(issueIdShortcut('login fails')).toBeNull();
      expect(issueIdShortcut('web-')).toBeNull();
      expect(issueIdShortcut('')).toBeNull();
    });
  });
});
