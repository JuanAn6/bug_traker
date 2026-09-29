import { emptyCriteria, PRIORITIES, REPRODUCIBILITY, RESOLUTIONS, SEVERITIES, statusRank } from './config';
import type { ColumnId, FilterCriteria, Issue, Project, SortKey } from './models';
import { plainText } from './rich';

export interface FilterContext {
  meId: number;
  now?: number;
  projects: Project[];
  attachmentCounts?: Map<number, number>;
  /** issueId → concatenated note text; only needed when criteria.searchNotes is set */
  noteText?: Map<number, string>;
}

export function descendantProjectIds(projects: Project[], ids: number[]): Set<number> {
  const out = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of projects) {
      if (p.parentId !== null && out.has(p.parentId) && !out.has(p.id)) {
        out.add(p.id);
        grew = true;
      }
    }
  }
  return out;
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const inRange = (iso: string | null, from: string, to: string) =>
  (!from || (!!iso && iso.slice(0, 10) >= from)) && (!to || (!!iso && iso.slice(0, 10) <= to));

export function filterIssues(issues: Issue[], partial: Partial<FilterCriteria>, ctx: FilterContext): Issue[] {
  const c = { ...emptyCriteria(), ...partial };
  const today = new Date(ctx.now ?? Date.now()).toISOString().slice(0, 10);
  const projects = c.projectIds.length
    ? c.includeSubprojects ? descendantProjectIds(ctx.projects, c.projectIds) : new Set(c.projectIds)
    : null;
  const handlers = new Set(c.handlerIds.map((h) => (h === -1 ? ctx.meId : h)));
  const reporters = new Set(c.reporterIds.map((h) => (h === -1 ? ctx.meId : h)));
  const monitor = c.monitorId === -1 ? ctx.meId : c.monitorId;
  const text = norm(c.text.trim());
  const idMatch = /^#?(\d+)$/.exec(text) ?? /^[a-z]+-(\d+)$/.exec(text);

  return issues.filter((i) => {
    if (projects && !projects.has(i.projectId)) return false;
    if (c.sprintIds.length && !c.sprintIds.includes(i.sprintId ?? 'none')) return false;
    if (c.categories.length && !c.categories.includes(i.category)) return false;
    if (c.statuses.length && !c.statuses.includes(i.status)) return false;
    if (!c.statuses.length && c.hideStatus && statusRank(i.status) >= statusRank(c.hideStatus)) return false;
    if (c.resolutions.length && !c.resolutions.includes(i.resolution)) return false;
    if (c.priorities.length && !c.priorities.includes(i.priority)) return false;
    if (c.severities.length && !c.severities.includes(i.severity)) return false;
    if (c.reproducibility.length && !c.reproducibility.includes(i.reproducibility)) return false;
    if (reporters.size && !reporters.has(i.reporterId)) return false;
    if (handlers.size && !handlers.has(i.handlerId ?? 0)) return false;
    if (monitor && !i.monitorIds.includes(monitor)) return false;
    if (c.tags.length) {
      const has = (t: string) => i.tags.includes(t);
      if (c.tagsMode === 'all' ? !c.tags.every(has) : !c.tags.some(has)) return false;
    }
    if (c.targetVersion && i.targetVersion !== c.targetVersion) return false;
    if (c.fixedInVersion && i.fixedInVersion !== c.fixedInVersion) return false;
    if (c.platform && !norm(i.platform).includes(norm(c.platform))) return false;
    if (c.os && !norm(i.os).includes(norm(c.os))) return false;
    if (c.viewState && i.viewState !== c.viewState) return false;
    if (!inRange(i.created, c.createdFrom, c.createdTo)) return false;
    if (!inRange(i.updated, c.updatedFrom, c.updatedTo)) return false;
    if ((c.dueFrom || c.dueTo) && !inRange(i.dueDate, c.dueFrom, c.dueTo)) return false;
    if (c.overdueOnly && !isOverdue(i, today)) return false;
    if (c.hasAttachments !== null && !!ctx.attachmentCounts?.get(i.id) !== c.hasAttachments) return false;
    if (c.relationship && !i.relationships.some((r) => r.type === c.relationship)) return false;
    if (c.customFieldId !== null) {
      const v = i.customFields[c.customFieldId] ?? '';
      if (c.customFieldValue ? !norm(v).includes(norm(c.customFieldValue)) : !v) return false;
    }
    if (text) {
      if (idMatch) return i.id === Number(idMatch[1]);
      const hay = norm([
        i.summary, plainText(i.description), plainText(i.stepsToReproduce), plainText(i.additionalInfo), i.tags.join(' '),
        c.searchNotes ? ctx.noteText?.get(i.id) ?? '' : '',
      ].join(' '));
      if (!text.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

export function isOverdue(i: Pick<Issue, 'dueDate' | 'status'>, today = new Date().toISOString().slice(0, 10)): boolean {
  return !!i.dueDate && i.dueDate < today && statusRank(i.status) < statusRank('resolved');
}

export interface SortContext {
  name: (column: ColumnId, issue: Issue) => string | number;
}

const ORDERED: Partial<Record<ColumnId, readonly string[]>> = {
  priority: PRIORITIES, severity: SEVERITIES, resolution: RESOLUTIONS, reproducibility: REPRODUCIBILITY,
};

/** Value used for comparison. Enum columns sort by rank, lookups (user/project names) via ctx. */
export function sortValue(column: ColumnId, i: Issue, ctx?: SortContext): string | number {
  switch (column) {
    case 'status': return statusRank(i.status);
    case 'priority': case 'severity': case 'resolution': case 'reproducibility':
      return ORDERED[column]!.indexOf(i[column]);
    case 'id': return i.id;
    case 'summary': return i.summary.toLowerCase();
    case 'category': return i.category.toLowerCase();
    case 'created': return i.created;
    case 'updated': return i.updated;
    case 'dueDate': return i.dueDate ?? '9999';
    case 'storyPoints': return i.storyPoints ?? -1;
    case 'targetVersion': return i.targetVersion;
    case 'fixedInVersion': return i.fixedInVersion;
    case 'viewState': return i.viewState;
    case 'tags': return i.tags.join(',');
    default: return ctx?.name(column, i) ?? '';
  }
}

export function sortIssues(issues: Issue[], keys: SortKey[], ctx?: SortContext): Issue[] {
  const effective = keys.length ? keys : [{ column: 'updated' as ColumnId, dir: 'desc' as const }];
  return [...issues].sort((a, b) => {
    // Sticky issues always float to the top, like MantisBT.
    if (a.sticky !== b.sticky) return a.sticky ? -1 : 1;
    for (const k of effective) {
      const va = sortValue(k.column, a, ctx);
      const vb = sortValue(k.column, b, ctx);
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      if (cmp) return k.dir === 'asc' ? cmp : -cmp;
    }
    return b.id - a.id;
  });
}

export function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = m.get(k);
    if (list) list.push(it);
    else m.set(k, [it]);
  }
  return m;
}

/** Serialize only non-default criteria to URL query params (arrays comma-joined). */
export function criteriaToParams(c: Partial<FilterCriteria>): Record<string, string> {
  const def = emptyCriteria() as unknown as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c)) {
    if (JSON.stringify(v) === JSON.stringify(def[k])) continue;
    out[k] = Array.isArray(v) ? v.join(',') : v === null ? 'null' : String(v);
  }
  return out;
}

export function paramsToCriteria(params: Record<string, string | undefined>): FilterCriteria {
  const c = emptyCriteria() as unknown as Record<string, unknown>;
  for (const [k, def] of Object.entries(c)) {
    const raw = params[k];
    if (raw === undefined) continue;
    if (Array.isArray(def)) {
      const numeric = ['projectIds', 'reporterIds', 'handlerIds'].includes(k);
      c[k] = raw === '' ? [] : raw.split(',').map((x) => (numeric || (k === 'sprintIds' && x !== 'none') ? Number(x) : x));
    } else if (typeof def === 'boolean') c[k] = raw === 'true';
    else if (k === 'hasAttachments') c[k] = raw === 'null' ? null : raw === 'true';
    else if (k === 'monitorId' || k === 'customFieldId') c[k] = raw === 'null' || raw === '' ? null : Number(raw);
    else c[k] = raw;
  }
  return c as unknown as FilterCriteria;
}
