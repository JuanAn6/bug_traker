import { computed, effect, Injectable, signal } from '@angular/core';
import type { Db, Issue } from './models';
import { createSeed, SCHEMA_VERSION } from './seed';

const KEY = 'bt:v1';

function load(): Db {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return migrate(JSON.parse(raw) as Db);
  } catch {
    /* corrupted or unavailable storage → fall back to seed */
  }
  return createSeed();
}

/** Upgrade older stored shapes here when SCHEMA_VERSION bumps. */
function migrate(db: Db): Db {
  if (db.schema !== SCHEMA_VERSION) return createSeed();
  return db;
}

/**
 * Single source of truth. Every mutation clones the db, so previous values are immutable
 * snapshots usable for undo.
 * ponytail: structuredClone of the whole db per mutation; fine for thousands of rows,
 * switch to per-collection signals or an API if data grows large.
 */
@Injectable({ providedIn: 'root' })
export class Store {
  private readonly db = signal<Db>(load());
  readonly lastSaved = signal<Date | null>(null);
  readonly saveError = signal<string | null>(null);

  readonly users = computed(() => this.db().users);
  readonly projects = computed(() => this.db().projects);
  readonly sprints = computed(() => this.db().sprints);
  readonly issues = computed(() => this.db().issues);
  readonly comments = computed(() => this.db().comments);
  readonly attachments = computed(() => this.db().attachments);
  readonly history = computed(() => this.db().history);
  readonly filters = computed(() => this.db().filters);
  readonly notifications = computed(() => this.db().notifications);
  readonly customFields = computed(() => this.db().customFields);
  readonly workflow = computed(() => this.db().workflow);

  readonly userMap = computed(() => new Map(this.users().map((u) => [u.id, u])));
  readonly projectMap = computed(() => new Map(this.projects().map((p) => [p.id, p])));
  readonly sprintMap = computed(() => new Map(this.sprints().map((s) => [s.id, s])));
  readonly issueMap = computed(() => new Map(this.issues().map((i) => [i.id, i])));
  readonly noteCounts = computed(() => countBy(this.comments(), (c) => c.issueId));
  readonly attachmentCounts = computed(() =>
    countBy(this.attachments().filter((a) => a.current && a.issueId), (a) => a.issueId));
  readonly tags = computed(() => {
    const counts = new Map<string, number>();
    for (const i of this.issues()) for (const t of i.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts].sort((a, b) => a[0].localeCompare(b[0]));
  });

  constructor() {
    effect(() => {
      const d = this.db();
      try {
        localStorage.setItem(KEY, JSON.stringify(d));
        this.lastSaved.set(new Date());
        this.saveError.set(null);
      } catch (e) {
        this.saveError.set(e instanceof Error ? e.message : String(e));
      }
    });
  }

  snapshot(): Db {
    return this.db();
  }

  restore(db: Db) {
    this.db.set(db);
  }

  mutate(recipe: (draft: Db) => void) {
    const draft = structuredClone(this.db());
    recipe(draft);
    this.db.set(draft);
  }

  nextId(draft: Db): number {
    return ++draft.seq;
  }

  issueKey(issue: Pick<Issue, 'id' | 'projectId'>): string {
    return `${this.projectMap().get(issue.projectId)?.key ?? '#'}-${issue.id}`;
  }

  reset() {
    this.db.set(createSeed());
  }

  exportJson(): string {
    return JSON.stringify(this.db(), null, 2);
  }

  importJson(text: string) {
    const parsed = JSON.parse(text) as Db;
    if (parsed.schema !== SCHEMA_VERSION || !Array.isArray(parsed.issues) || !Array.isArray(parsed.users)) {
      throw new Error('Invalid or incompatible backup file');
    }
    this.db.set(parsed);
  }
}

function countBy<T>(items: T[], key: (t: T) => number): Map<number, number> {
  const m = new Map<number, number>();
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
  return m;
}
