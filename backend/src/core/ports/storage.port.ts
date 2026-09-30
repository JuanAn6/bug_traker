import type { Readable } from 'node:stream';

export const STORAGE_PORT = Symbol('STORAGE_PORT');

export interface StoredBlob {
  /** SHA-256 of the bytes, lowercase hex. The only identity a blob has. */
  hash: string;
  size: number;
  /** False when the content was already stored, so the upload deduplicated. */
  created: boolean;
}

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Blob storage, addressed by content.
 *
 * Content addressing is not an optimization here, it is what makes the frontend's shared `blobId`
 * safe: cloning an issue or re-uploading the same screenshot points at one set of bytes, and the
 * reference count in the `blobs` table is what decides when those bytes may go.
 *
 * `put` consumes a stream and must enforce `maxBytes` WHILE reading, not after — otherwise a
 * caller announcing a 2 GB upload gets 2 GB of buffering before being told no.
 */
export interface StoragePort {
  put(stream: Readable, options: { maxBytes: number }): Promise<StoredBlob>;
  open(hash: string, range?: ByteRange): Promise<Readable>;
  stat(hash: string): Promise<{ size: number } | null>;
  delete(hash: string): Promise<boolean>;
  /** Total bytes held, for the settings page. */
  usage(): Promise<{ bytes: number; files: number }>;
  /**
   * Every hash currently stored.
   *
   * The purge job needs it to find bytes with no database row — which happens whenever validation
   * rejects an upload after the stream has already been written.
   */
  listHashes(): AsyncGenerator<string>;
}

/** Thrown by `put` when the stream exceeds the limit. Maps to 413. */
export class BlobTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Upload exceeds ${maxBytes} bytes`);
  }
}

export class BlobMissingError extends Error {
  constructor(readonly hash: string) {
    super(`Blob ${hash} is not in storage`);
  }
}
