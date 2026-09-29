import { isResolved } from './config';
import type { HistoryEntry, Issue, Sprint } from './models';

const DAY = 86_400_000;
export const dayKey = (d: Date | string) => (typeof d === 'string' ? d : d.toISOString()).slice(0, 10);

/** issueId → ISO date the issue last entered a resolved state (only for currently resolved issues). */
export function resolvedDates(issues: Issue[], history: HistoryEntry[]): Map<number, string> {
  const resolvedIds = new Set(issues.filter((i) => isResolved(i.status)).map((i) => i.id));
  const out = new Map<number, string>();
  for (const h of history) {
    if (h.field !== 'status' || !resolvedIds.has(h.issueId) || !isResolved(h.new as Issue['status'])) continue;
    const prev = out.get(h.issueId);
    if (!prev || h.date > prev) out.set(h.issueId, h.date);
  }
  // Issues resolved without a history row (imported data): fall back to their last update.
  for (const i of issues) if (resolvedIds.has(i.id) && !out.has(i.id)) out.set(i.id, i.updated);
  return out;
}

export const points = (i: Issue) => i.storyPoints ?? 1;

export interface Burndown { labels: string[]; ideal: number[]; remaining: (number | null)[]; total: number; done: number; }

export function burndown(sprint: Sprint, issues: Issue[], resolved: Map<number, string>, now = Date.now()): Burndown {
  const scope = issues.filter((i) => i.sprintId === sprint.id);
  const total = scope.reduce((s, i) => s + points(i), 0);
  const start = new Date(sprint.start + 'T00:00:00').getTime();
  const end = new Date(sprint.end + 'T00:00:00').getTime();
  const days = Math.max(1, Math.round((end - start) / DAY));
  const labels: string[] = [];
  const ideal: number[] = [];
  const remaining: (number | null)[] = [];
  const today = dayKey(new Date(now));
  for (let k = 0; k <= days; k++) {
    const d = dayKey(new Date(start + k * DAY));
    labels.push(d.slice(5));
    ideal.push(Math.round((total * (1 - k / days)) * 10) / 10);
    if (d > today) { remaining.push(null); continue; }
    const doneBy = scope.filter((i) => {
      const r = resolved.get(i.id);
      return r && dayKey(r) <= d;
    }).reduce((s, i) => s + points(i), 0);
    remaining.push(total - doneBy);
  }
  const done = scope.filter((i) => isResolved(i.status)).reduce((s, i) => s + points(i), 0);
  return { labels, ideal, remaining, total, done };
}

/** Weekly created vs resolved counts for the last `weeks` weeks. */
export function createdVsResolved(issues: Issue[], resolved: Map<number, string>, weeks = 12, now = Date.now()) {
  const labels: string[] = [];
  const created: number[] = [];
  const done: number[] = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const from = dayKey(new Date(now - (w + 1) * 7 * DAY));
    const to = dayKey(new Date(now - w * 7 * DAY));
    labels.push(to.slice(5));
    created.push(issues.filter((i) => dayKey(i.created) > from && dayKey(i.created) <= to).length);
    done.push([...resolved.values()].filter((d) => dayKey(d) > from && dayKey(d) <= to).length);
  }
  return { labels, created, done };
}

export function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / DAY);
}
