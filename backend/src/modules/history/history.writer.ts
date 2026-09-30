import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { HistoryType } from '../../shared/models';
import * as s from '../../core/database/schema';
import type { Tx } from '../../core/database/unit-of-work';

export interface HistoryRow {
  issueId: number;
  type: HistoryType;
  field?: string;
  old?: string;
  new?: string;
}

/**
 * The only writer of historyEntries.
 *
 * The domain describes the rows (applyPatch returns drafts); this assigns the timestamp and
 * the actor and persists them in one insert, IN THE ORDER GIVEN — which is TRACKED's order,
 * not the caller's patch order. A ported test asserts that, because the history read back is
 * how anyone reconstructs what happened.
 */
@Injectable()
export class HistoryWriter {
  async writeMany(tx: Tx, actorId: number, rows: HistoryRow[], at = new Date()): Promise<void> {
    if (!rows.length) return;

    await tx.insert(s.historyEntries).values(
      rows.map((r) => ({
        issueId: r.issueId,
        userId: actorId,
        date: at,
        type: r.type,
        field: (r.field ?? '').slice(0, 32),
        // The column is VARCHAR(255) and applyPatch already truncates rich text to 120
        // characters; this is the backstop for a long plain value like a summary.
        oldValue: (r.old ?? '').slice(0, 255),
        newValue: (r.new ?? '').slice(0, 255),
      })),
    );

    // /summary ranks "most active" issues by history-row count, so the denormalized counter is
    // maintained here rather than recomputed with a COUNT(*) per issue on every dashboard load.
    const perIssue = new Map<number, number>();
    for (const r of rows) perIssue.set(r.issueId, (perIssue.get(r.issueId) ?? 0) + 1);
    for (const [issueId, n] of perIssue) {
      await tx
        .update(s.issues)
        .set({ historyCount: sql`${s.issues.historyCount} + ${n}` })
        .where(eq(s.issues.id, issueId));
    }
  }

  write(tx: Tx, actorId: number, row: HistoryRow, at = new Date()): Promise<void> {
    return this.writeMany(tx, actorId, [row], at);
  }
}
