import { sql } from 'drizzle-orm';
import { isResolved } from '../../shared/config';
import { resolvedDates } from '../../shared/metrics';
import type { Attachment, Db as DbJson, HistoryEntry, Issue, Status } from '../../shared/models';
import type { Db } from '../../core/database/drizzle.service';
import * as s from '../../core/database/schema';
import { rankColumns } from '../issues/domain/rank';
import { commentSearchNorm, issueSearchNorm, tagsSorted } from '../issues/domain/search-text';

/**
 * Ingests the exact `Db` JSON that the frontend's `store.exportJson()` produces.
 *
 * This is the one code path that loads data, used by both `POST /admin/import` and the seed
 * script. Sharing it means every seed run exercises the importer against 80 issues with
 * relationships, private notes, mentions and notifications — the alternative (a separate
 * seed) would leave the importer untested until someone actually imported something.
 */
export interface IngestOptions {
  /** 'replace' truncates every domain table first. */
  mode: 'replace' | 'merge';
  /** Applied to every user. Absent means demo accounts (passwordHash NULL). */
  passwordHash?: string;
  source: string;
}

export type IngestCounts = Record<string, number>;

const SENTINEL_HASH = '0'.repeat(64);

/** Tables in dependency order. Truncation walks this backwards. */
const TABLES = [
  s.users, s.userPrefs, s.customFields, s.projects, s.projectCategories, s.projectVersions,
  s.projectMembers, s.projectCustomFields, s.sprints, s.issues, s.issueTags, s.issueMonitors,
  s.issueCustomValues, s.issueRelationships, s.comments, s.blobs, s.attachments,
  s.historyEntries, s.notifications, s.savedFilters, s.workflowConfig, s.workflowTransitions,
  s.workflowThresholds, s.workflowStatusColors, s.workflowWipLimits,
] as const;

const iso = (v: string | null | undefined): Date | null => (v ? new Date(v) : null);
const isoReq = (v: string): Date => new Date(v);

export async function ingestDb(
  db: Db,
  json: DbJson,
  options: IngestOptions,
): Promise<IngestCounts> {
  assertEnvelope(json);
  const counts: IngestCounts = {};

  await db.transaction(async (tx) => {
    // The Db JSON is a consistent snapshot but its insert order cannot satisfy every FK
    // simultaneously (issues reference sprints which reference projects, and relationships
    // reference issues that come later in the same batch). Checks go back on before commit.
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    try {
      if (options.mode === 'replace') {
        for (const table of [...TABLES].reverse()) {
          await tx.execute(sql`TRUNCATE TABLE ${table}`);
        }
      }

      const insert = async <T extends Record<string, unknown>>(
        name: string,
        table: Parameters<typeof tx.insert>[0],
        rows: T[],
      ) => {
        counts[name] = rows.length;
        // Drizzle rejects an empty values() array, and the seed legitimately has none.
        for (let i = 0; i < rows.length; i += 500) {
          await tx.insert(table).values(rows.slice(i, i + 500) as never);
        }
      };

      // ── users ───────────────────────────────────────────────────────────────
      await insert('users', s.users, json.users.map((u) => ({
        id: u.id,
        username: u.username,
        realName: u.realName,
        email: u.email,
        // A Db export carries no credentials. Without an explicit hash these become demo
        // accounts, which DEMO_MODE lets in with any password — matching the frontend.
        passwordHash: options.passwordHash ?? null,
        accessLevel: u.accessLevel,
        enabled: u.enabled,
        avatarColor: u.avatarColor,
        lastVisit: iso(u.lastVisit),
        created: isoReq(u.created),
        tokenVersion: 0,
        deletedAt: null,
      })));

      await insert('userPrefs', s.userPrefs, json.users.map((u) => ({
        userId: u.id,
        language: u.prefs.language,
        theme: u.prefs.theme,
        density: u.prefs.density,
        defaultProjectId: u.prefs.defaultProjectId,
        pageSize: u.prefs.pageSize,
        notesNewestFirst: u.prefs.notesNewestFirst,
        // Order is user-visible, so it is preserved as an ordered CSV rather than a set.
        homeWidgets: u.prefs.homeWidgets.join(','),
        // Exploded into columns because the notification fan-out filters on them in SQL.
        notifyAssigned: u.prefs.notify.assigned,
        notifyMentioned: u.prefs.notify.mentioned,
        notifyStatus: u.prefs.notify.status,
        notifyNote: u.prefs.notify.note,
        notifyAttachment: u.prefs.notify.attachment,
      })));

      // ── custom fields ───────────────────────────────────────────────────────
      await insert('customFields', s.customFields, json.customFields.map((f) => ({
        id: f.id,
        name: f.name,
        type: f.type,
        options: f.options.join('\n'),
        required: f.required,
        defaultValue: f.defaultValue,
      })));

      // ── projects and their value objects ────────────────────────────────────
      await insert('projects', s.projects, json.projects.map((p) => ({
        id: p.id,
        name: p.name,
        key: p.key,
        keyUpper: p.key.toUpperCase(),
        description: p.description,
        status: p.status,
        viewState: p.viewState,
        enabled: p.enabled,
        parentId: p.parentId,
        created: isoReq(p.created),
        deletedAt: null,
      })));

      // sortOrder = array index. This is the moment the frontend's implicit ordering (a
      // position in a JSON array) becomes durable data; roadmap reads it forwards and
      // changelog backwards, so losing it would scramble both pages.
      await insert('projectCategories', s.projectCategories, json.projects.flatMap((p) =>
        p.categories.map((c, i) => ({
          projectId: p.id, name: c.name, defaultHandlerId: c.defaultHandlerId, sortOrder: i,
        })),
      ));
      await insert('projectVersions', s.projectVersions, json.projects.flatMap((p) =>
        p.versions.map((v, i) => ({
          projectId: p.id, name: v.name, date: v.date, released: v.released,
          obsolete: v.obsolete, description: v.description, sortOrder: i,
        })),
      ));
      await insert('projectMembers', s.projectMembers, json.projects.flatMap((p) =>
        p.members.map((m) => ({ projectId: p.id, userId: m.userId, accessLevel: m.accessLevel })),
      ));
      await insert('projectCustomFields', s.projectCustomFields, json.projects.flatMap((p) =>
        p.customFieldIds.map((id, i) => ({ projectId: p.id, customFieldId: id, sortOrder: i })),
      ));

      await insert('sprints', s.sprints, json.sprints.map((sp) => ({
        id: sp.id, projectId: sp.projectId, name: sp.name, goal: sp.goal,
        start: sp.start, end: sp.end, state: sp.state, capacity: sp.capacity, deletedAt: null,
      })));

      // ── issues, with everything denormalized derived here ───────────────────
      const marks = resolutionMarks(json.issues, json.history);
      const noteCounts = countBy(json.comments, (c) => c.issueId);
      const attachmentCounts = countBy(
        json.attachments.filter((a) => a.current && a.issueId),
        (a) => a.issueId,
      );
      const historyCounts = countBy(json.history, (h) => h.issueId);

      await insert('issues', s.issues, json.issues.map((i) => {
        const m = marks.get(i.id);
        return {
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
          ...rankColumns(i),
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
          dueDate: i.dueDate,
          estimate: i.estimate,
          storyPoints: i.storyPoints,
          created: isoReq(i.created),
          updated: isoReq(i.updated),
          searchNorm: issueSearchNorm(i),
          tagsSorted: tagsSorted(i.tags),
          noteCount: noteCounts.get(i.id) ?? 0,
          attachmentCount: attachmentCounts.get(i.id) ?? 0,
          historyCount: historyCounts.get(i.id) ?? 0,
          resolvedAt: m?.resolvedAt ?? null,
          firstResolvedAt: m?.firstResolvedAt ?? null,
          reopenedAt: m?.reopenedAt ?? null,
          reopenCount: m?.reopenCount ?? 0,
          resolvedAtEstimated: m?.estimated ?? false,
          deletedAt: null,
          rowVersion: 0,
        };
      }));

      await insert('issueTags', s.issueTags, json.issues.flatMap((i) =>
        i.tags.map((tag, k) => ({ issueId: i.id, tag, sortOrder: k })),
      ));
      await insert('issueMonitors', s.issueMonitors, json.issues.flatMap((i) =>
        i.monitorIds.map((userId) => ({ issueId: i.id, userId })),
      ));
      await insert('issueCustomValues', s.issueCustomValues, json.issues.flatMap((i) =>
        Object.entries(i.customFields).map(([fieldId, value]) => ({
          issueId: i.id, customFieldId: Number(fieldId), value,
        })),
      ));
      await insert('issueRelationships', s.issueRelationships, symmetricRelationships(json.issues));

      // ── notes ───────────────────────────────────────────────────────────────
      await insert('comments', s.comments, json.comments.map((c) => ({
        id: c.id,
        issueId: c.issueId,
        authorId: c.authorId,
        body: c.body,
        bodyNorm: commentSearchNorm(c.body),
        private: c.private,
        timeSpent: c.timeSpent,
        created: isoReq(c.created),
        edited: iso(c.edited),
        deletedAt: null,
      })));

      // ── attachments ─────────────────────────────────────────────────────────
      // A Db export carries metadata but no bytes, so every row points at a sentinel hash
      // and is flagged blobMissing; GET /content answers 410 for those.
      const hasAttachments = json.attachments.length > 0;
      await insert('blobs', s.blobs, hasAttachments
        ? [{
            hash: SENTINEL_HASH,
            size: 0,
            refCount: json.attachments.length,
            created: new Date(),
          }]
        : []);

      const documentIds = deriveDocumentIds(json.attachments);
      await insert('attachments', s.attachments, json.attachments.map((a) => ({
        id: a.id,
        documentId: documentIds.get(a.id) ?? a.id,
        issueId: a.issueId === 0 ? null : a.issueId,
        commentId: a.commentId,
        name: a.name,
        description: a.description,
        mimeType: a.mimeType,
        sniffedMimeType: null,
        size: a.size,
        uploaderId: a.uploaderId,
        date: isoReq(a.date),
        version: a.version,
        previousVersionId: a.previousVersionId,
        current: a.current,
        blobHash: SENTINEL_HASH,
        blobMissing: true,
        deletedAt: null,
      })));

      // ── history, notifications, saved filters ───────────────────────────────
      await insert('historyEntries', s.historyEntries, json.history.map((h) => ({
        id: h.id,
        issueId: h.issueId,
        userId: h.userId,
        date: isoReq(h.date),
        type: h.type,
        field: h.field,
        oldValue: h.old.slice(0, 255),
        newValue: h.new.slice(0, 255),
      })));

      const issueById = new Map(json.issues.map((i) => [i.id, i]));
      await insert('notifications', s.notifications, json.notifications.map((n) => {
        // fromStatus/toStatus stay NULL for imported rows. The frontend's `text` for a
        // status change is "<from> → <to>: <summary>" with both endpoints already rendered
        // through i18n in the ACTOR's language, so recovering the enum values would mean
        // reverse-mapping localized labels from tables that live in the frontend. Not worth
        // guessing: `text` is preserved verbatim as the fallback, and the structured columns
        // are populated from here on for every notification the API itself writes.
        return {
          id: n.id,
          userId: n.userId,
          issueId: n.issueId,
          actorId: n.actorId,
          type: n.type,
          read: n.read,
          date: isoReq(n.date),
          fromStatus: null,
          toStatus: null,
          commentId: null,
          attachmentId: null,
          subject: (issueById.get(n.issueId)?.summary ?? '').slice(0, 255),
          excerpt: n.type === 'note' || n.type === 'mentioned' ? n.text.slice(0, 160) : null,
          excerptPrivate: false,
          text: n.text.slice(0, 255),
        };
      }));

      await insert('savedFilters', s.savedFilters, json.filters.map((f) => ({
        id: f.id,
        name: f.name,
        ownerId: f.ownerId,
        shared: f.shared,
        projectId: f.projectId,
        isDefault: f.isDefault,
        criteria: JSON.stringify(f.criteria),
        columns: f.columns.join(','),
        sort: f.sort.map((k) => `${k.column}:${k.dir}`).join(','),
        deletedAt: null,
      })));

      // ── workflow: one config row plus four child tables ─────────────────────
      const wf = json.workflow;
      await insert('workflowConfig', s.workflowConfig, [{
        id: 1,
        resolvedStatus: wf.resolvedStatus,
        autoAssignStatus: wf.autoAssignStatus,
        boardColumns: wf.boardColumns.join(','),
        revision: 1,
        updatedAt: new Date(),
        updatedById: null,
      }]);
      await insert('workflowTransitions', s.workflowTransitions,
        Object.entries(wf.transitions).flatMap(([from, tos]) =>
          (tos as Status[]).map((to) => ({ fromStatus: from as Status, toStatus: to })),
        ));
      await insert('workflowThresholds', s.workflowThresholds,
        Object.entries(wf.thresholds).map(([action, level]) => ({
          action: action as keyof typeof wf.thresholds, level,
        })));
      await insert('workflowStatusColors', s.workflowStatusColors,
        Object.entries(wf.statusColors).map(([status, color]) => ({
          status: status as Status, color,
        })));
      await insert('workflowWipLimits', s.workflowWipLimits,
        Object.entries(wf.wipLimits)
          .filter(([, v]) => typeof v === 'number' && v > 0)
          .map(([status, limitValue]) => ({ status: status as Status, limitValue: limitValue as number })));
    } finally {
      await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
    }

    // Explicit ids were inserted, so each sequence has to be moved past them — otherwise
    // the first API-created row collides with imported data.
    await resetAutoIncrements(tx as unknown as Db);
  });

  return counts;
}

/** The same three checks Store.importJson makes, before anything is touched. */
function assertEnvelope(json: DbJson): void {
  if (json.schema !== 1) {
    throw new Error(`Unsupported Db schema ${String(json.schema)}; expected 1`);
  }
  if (!Array.isArray(json.issues) || !Array.isArray(json.users)) {
    throw new Error('Invalid backup: issues and users must be arrays');
  }
}

function countBy<T>(items: T[], key: (t: T) => number): Map<number, number> {
  const m = new Map<number, number>();
  for (const it of items) {
    const k = key(it);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

interface Marks {
  resolvedAt: Date | null;
  firstResolvedAt: Date | null;
  reopenedAt: Date | null;
  reopenCount: number;
  estimated: boolean;
}

/**
 * Derives the resolution columns from the imported history.
 *
 * `resolvedAt` reuses the frontend's own resolvedDates() so an import reproduces exactly
 * what the UI would have computed — including its fallback to `issue.updated` for issues
 * with no status history, which is flagged `estimated` so charts can disclose it. From then
 * on applyPatch maintains the columns directly and the fallback never applies again.
 */
function resolutionMarks(issues: Issue[], history: HistoryEntry[]): Map<number, Marks> {
  const resolved = resolvedDates(issues, history);
  const out = new Map<number, Marks>();

  const firstResolved = new Map<number, string>();
  const reopens = new Map<number, { count: number; last: string }>();
  for (const h of history) {
    if (h.field === 'status' && isResolved(h.new as Status)) {
      const prev = firstResolved.get(h.issueId);
      if (!prev || h.date < prev) firstResolved.set(h.issueId, h.date);
    }
    // Matches /summary's reopen detection: a resolution field row set to 'reopened'.
    if (h.field === 'resolution' && h.new === 'reopened') {
      const prev = reopens.get(h.issueId);
      reopens.set(h.issueId, {
        count: (prev?.count ?? 0) + 1,
        last: !prev || h.date > prev.last ? h.date : prev.last,
      });
    }
  }

  for (const i of issues) {
    const r = resolved.get(i.id);
    const reopen = reopens.get(i.id);
    out.set(i.id, {
      resolvedAt: r ? new Date(r) : null,
      firstResolvedAt: firstResolved.get(i.id)
        ? new Date(firstResolved.get(i.id)!)
        : (r ? new Date(r) : null),
      reopenedAt: reopen ? new Date(reopen.last) : null,
      reopenCount: reopen?.count ?? 0,
      // resolvedDates() fell back to `updated` when no status row explained the state.
      estimated: !!r && !firstResolved.has(i.id),
    });
  }
  return out;
}

/**
 * Expands the frontend's per-issue relationship arrays into rows, asserting symmetry.
 *
 * The frontend stores both directions already, but an export could be asymmetric (a bug, or
 * a hand-edited file); the missing side is synthesized rather than silently dropped, because
 * the composite primary key makes a one-sided link invisible from the other issue.
 */
function symmetricRelationships(issues: Issue[]) {
  const rows = new Map<string, { issueId: number; otherIssueId: number; type: Issue['relationships'][number]['type']; created: Date }>();
  const now = new Date();
  const reverse = {
    related_to: 'related_to', parent_of: 'child_of', child_of: 'parent_of',
    duplicate_of: 'has_duplicate', has_duplicate: 'duplicate_of',
  } as const;

  for (const i of issues) {
    for (const r of i.relationships) {
      if (r.issueId === i.id) continue; // the CHECK constraint would reject it anyway
      rows.set(`${i.id}:${r.issueId}`, {
        issueId: i.id, otherIssueId: r.issueId, type: r.type, created: now,
      });
      const key = `${r.issueId}:${i.id}`;
      if (!rows.has(key)) {
        rows.set(key, {
          issueId: r.issueId, otherIssueId: i.id, type: reverse[r.type], created: now,
        });
      }
    }
  }
  return [...rows.values()];
}

/**
 * Walks `previousVersionId` chains backwards to find each chain's root, which becomes
 * `documentId` — the column the frontend lacks, and the reason its version listing pays an
 * O(n) walk per attachment.
 */
function deriveDocumentIds(attachments: Attachment[]): Map<number, number> {
  const byId = new Map(attachments.map((a) => [a.id, a]));
  const out = new Map<number, number>();
  for (const a of attachments) {
    const seen = new Set<number>();
    let cur: Attachment | undefined = a;
    while (cur?.previousVersionId && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.previousVersionId);
    }
    out.set(a.id, cur?.id ?? a.id);
  }
  return out;
}


async function resetAutoIncrements(db: Db): Promise<void> {
  const tables = [
    'users', 'customFields', 'projects', 'sprints', 'issues', 'comments', 'attachments',
    'historyEntries', 'notifications', 'savedFilters',
  ];
  for (const t of tables) {
    const rows = await db.execute(sql`SELECT COALESCE(MAX(id), 0) + 1 AS next FROM ${sql.identifier(t)}`);
    const next = Number((rows as unknown as Array<Array<{ next: number }>>)[0]?.[0]?.next ?? 1);
    await db.execute(sql.raw(`ALTER TABLE \`${t}\` AUTO_INCREMENT = ${next}`));
  }
}
