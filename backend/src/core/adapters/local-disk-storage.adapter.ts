import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, unlink, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Readable } from 'node:stream';
import type { Env } from '../config/env.schema';
import {
  BlobMissingError, BlobTooLargeError, type ByteRange, type StoragePort, type StoredBlob,
} from '../ports/storage.port';

/**
 * Blobs on local disk, named by their SHA-256.
 *
 * The path is fanned out two levels — `blobs/a3/f9/a3f9…` — because tens of thousands of entries
 * in one directory makes `readdir` and most filesystems' lookups slow, and the purge job walks
 * the tree.
 */
@Injectable()
export class LocalDiskStorageAdapter implements StoragePort, OnModuleInit {
  private readonly logger = new Logger(LocalDiskStorageAdapter.name);
  private readonly root: string;
  private readonly blobsDir: string;
  private readonly tmpDir: string;

  constructor(config: ConfigService<Env, true>) {
    this.root = config.get('STORAGE_ROOT', { infer: true });
    this.blobsDir = join(this.root, 'blobs');
    this.tmpDir = join(this.root, 'tmp');
  }

  async onModuleInit(): Promise<void> {
    await mkdir(this.blobsDir, { recursive: true });
    await mkdir(this.tmpDir, { recursive: true });
    // A crash mid-upload leaves a temporary behind. Nothing references them, so they go on boot.
    await this.clearTemporaries();
  }

  /**
   * Streams to a temporary file while hashing, then moves it into place.
   *
   * The order matters: the name cannot be known until the last byte is read, so the write has to
   * land somewhere first. `rename` within the same filesystem is atomic, so a reader can never
   * observe a half-written blob at its final path.
   */
  async put(stream: Readable, options: { maxBytes: number }): Promise<StoredBlob> {
    const temp = join(this.tmpDir, randomUUID());
    const hash = createHash('sha256');
    let size = 0;
    let tooLarge = false;

    try {
      await pipeline(
        stream,
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            size += chunk.length;
            if (size > options.maxBytes) {
              // Thrown from inside the pipeline so reading stops here rather than after the whole
              // body has been consumed.
              tooLarge = true;
              throw new BlobTooLargeError(options.maxBytes);
            }
            hash.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(temp),
      );
    } catch (e) {
      await unlink(temp).catch(() => undefined);
      if (tooLarge || e instanceof BlobTooLargeError) throw new BlobTooLargeError(options.maxBytes);
      throw e;
    }

    const digest = hash.digest('hex');
    const target = this.pathFor(digest);

    const existing = await stat(target).catch(() => null);
    if (existing) {
      // Same bytes already stored: discard the copy. This is what makes cloning an issue and
      // re-uploading the same screenshot cost nothing.
      await unlink(temp).catch(() => undefined);
      return { hash: digest, size: existing.size, created: false };
    }

    await mkdir(dirname(target), { recursive: true });
    await rename(temp, target);
    return { hash: digest, size, created: true };
  }

  async open(hash: string, range?: ByteRange): Promise<Readable> {
    const path = this.pathFor(hash);
    const info = await stat(path).catch(() => null);
    if (!info) throw new BlobMissingError(hash);
    return range
      ? createReadStream(path, { start: range.start, end: range.end })
      : createReadStream(path);
  }

  async stat(hash: string): Promise<{ size: number } | null> {
    const info = await stat(this.pathFor(hash)).catch(() => null);
    return info ? { size: info.size } : null;
  }

  async delete(hash: string): Promise<boolean> {
    try {
      await unlink(this.pathFor(hash));
      return true;
    } catch {
      // Already gone is the desired end state, not a failure.
      return false;
    }
  }

  async usage(): Promise<{ bytes: number; files: number }> {
    let bytes = 0;
    let files = 0;
    for await (const path of this.walk(this.blobsDir)) {
      const info = await stat(path).catch(() => null);
      if (info?.isFile()) {
        bytes += info.size;
        files += 1;
      }
    }
    return { bytes, files };
  }

  /** Every hash currently on disk, for the orphan purge to compare against the database. */
  async *listHashes(): AsyncGenerator<string> {
    for await (const path of this.walk(this.blobsDir)) {
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (/^[0-9a-f]{64}$/.test(name)) yield name;
    }
  }

  private async *walk(dir: string): AsyncGenerator<string> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) yield* this.walk(path);
      else yield path;
    }
  }

  private async clearTemporaries(): Promise<void> {
    const entries = await readdir(this.tmpDir).catch(() => []);
    if (!entries.length) return;
    this.logger.log(`clearing ${entries.length} interrupted upload(s)`);
    for (const entry of entries) {
      await rm(join(this.tmpDir, entry), { force: true }).catch(() => undefined);
    }
  }

  /** `blobs/a3/f9/a3f9…` — two levels of fan-out so no directory grows unbounded. */
  private pathFor(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      // A hash comes from our own column, so a malformed one is a bug — but it would also be a
      // path traversal, so it is refused rather than normalized.
      throw new BlobMissingError(hash);
    }
    return join(this.blobsDir, hash.slice(0, 2), hash.slice(2, 4), hash);
  }
}
