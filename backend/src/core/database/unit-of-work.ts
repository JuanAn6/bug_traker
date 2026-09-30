import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { ConflictError } from '../../common/errors/domain-error';
import * as s from './schema';
import { DRIZZLE, type Db } from './drizzle.service';

/** The transaction handle Drizzle hands to the callback. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type IssueRow = typeof s.issues.$inferSelect;

/**
 * Pulls the auto-increment id out of a Drizzle insert result.
 *
 * The mysql2 driver returns `[ResultSetHeader, FieldPacket[]]`, so the header is at index 0 —
 * reading `.insertId` off the array itself yields undefined, which then becomes NaN in an id
 * column and surfaces as a foreign-key failure several statements later. Centralised so that
 * mistake is made once and caught here.
 */
export function insertedId(result: unknown): number {
  const header = Array.isArray(result) ? (result[0] as { insertId?: number }) : undefined;
  const id = Number(header?.insertId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`insert did not return a usable id (got ${String(header?.insertId)})`);
  }
  return id;
}

/** Rows touched by an update or delete, for guarded writes. */
export function affectedRows(result: unknown): number {
  const header = Array.isArray(result) ? (result[0] as { affectedRows?: number }) : undefined;
  return Number(header?.affectedRows ?? 0);
}

/**
 * Wraps every write in one transaction and gives it the two things a correct write needs:
 * row locks in a deadlock-free order, and an outbox so events cannot escape a rollback.
 */
@Injectable()
export class UnitOfWork {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  /**
   * Loads one issue FOR UPDATE, so two concurrent patches serialize instead of interleaving
   * their history rows.
   *
   * Returns undefined for a missing OR soft-deleted issue; the caller decides whether that is
   * a 404 or something else. Visibility is NOT checked here — that belongs to the service,
   * which knows the actor.
   */
  async lockIssue(tx: Tx, id: number): Promise<IssueRow | undefined> {
    const [row] = await tx
      .select()
      .from(s.issues)
      .where(and(eq(s.issues.id, id), isNull(s.issues.deletedAt)))
      .for('update')
      .limit(1);
    return row;
  }

  /**
   * Locks several issues in ASCENDING ID ORDER.
   *
   * The order is the point: two bulk operations touching overlapping sets would deadlock if
   * each locked in the order its caller happened to list the ids. Sorting gives every
   * transaction the same acquisition order, so one simply waits.
   */
  async lockIssues(tx: Tx, ids: number[]): Promise<IssueRow[]> {
    if (!ids.length) return [];
    return tx
      .select()
      .from(s.issues)
      .where(and(inArray(s.issues.id, [...ids].sort((a, b) => a - b)), isNull(s.issues.deletedAt)))
      .orderBy(asc(s.issues.id))
      .for('update');
  }

  /**
   * Appends a domain event inside the caller's transaction.
   *
   * The reason events go through a table rather than straight to EventsPort: publishing inside
   * the transaction would announce a change that a later rollback undoes, and publishing after
   * it — outside any transaction — would lose the event if the process died in between. The
   * outbox row commits atomically with the write it describes.
   */
  async outbox(tx: Tx, topic: string, payload: Record<string, unknown>): Promise<void> {
    await tx.insert(s.outbox).values({
      topic,
      payload: JSON.stringify(payload),
      created: new Date(),
    });
  }

  /**
   * Applies a version-guarded update. Zero affected rows means somebody else wrote first.
   *
   * The guard matters even with FOR UPDATE, because not every path locks: a read-modify-write
   * that loaded the issue in an earlier request still has to lose cleanly rather than silently
   * overwrite the other edit.
   */
  async updateIssueGuarded(
    tx: Tx,
    id: number,
    expectedVersion: number,
    data: Partial<typeof s.issues.$inferInsert>,
  ): Promise<void> {
    const result = await tx
      .update(s.issues)
      .set({ ...data, rowVersion: sql`${s.issues.rowVersion} + 1` })
      .where(and(eq(s.issues.id, id), eq(s.issues.rowVersion, expectedVersion)));

    if (affectedRows(result) === 0) throw new ConflictError('errors.stale', { id });
  }

  /** Claims up to `limit` undispatched outbox rows, marking them so no other worker repeats. */
  async claimOutbox(limit: number): Promise<Array<{ id: number; topic: string; payload: string }>> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: s.outbox.id, topic: s.outbox.topic, payload: s.outbox.payload })
        .from(s.outbox)
        .where(isNull(s.outbox.dispatchedAt))
        .orderBy(asc(s.outbox.id))
        .limit(limit)
        .for('update');

      if (rows.length) {
        await tx
          .update(s.outbox)
          .set({ dispatchedAt: new Date() })
          .where(inArray(s.outbox.id, rows.map((r) => r.id)));
      }
      return rows;
    });
  }

  /** Housekeeping: dispatched rows older than a day have served their purpose. */
  async pruneOutbox(olderThanMs = 86_400_000): Promise<void> {
    await this.db
      .delete(s.outbox)
      .where(lt(s.outbox.dispatchedAt, new Date(Date.now() - olderThanMs)));
  }
}
