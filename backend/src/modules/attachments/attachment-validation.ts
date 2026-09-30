import { BLOCKED_EXTENSIONS, MAX_FILE_SIZE } from '../../shared/config';

/**
 * Types that may be rendered inline in the browser.
 *
 * An allow-list, not a block-list, and `image/svg+xml` is deliberately absent: an SVG is a
 * document that can carry script, so serving one inline from the same origin is a stored-XSS
 * vector. SVGs still download fine.
 */
const INLINE_SAFE = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
  'application/pdf',
  'video/mp4', 'video/webm', 'video/ogg',
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/flac',
  'text/plain',
];

/** Sniffed types that are executable or scriptable whatever the extension claims. */
const DANGEROUS_SNIFFED = [
  'application/x-msdownload', 'application/x-executable', 'application/x-mach-binary',
  'application/x-elf', 'application/vnd.microsoft.portable-executable',
  'application/x-msi', 'application/x-sh', 'application/x-bat',
  'image/svg+xml', 'text/html', 'application/xhtml+xml',
];

export const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
};

/** The frontend's check: blocked extension, then size. Returns an i18n key or null. */
export function validateName(name: string): string | null {
  if (!name.trim()) return 'files.nameRequired';
  if (BLOCKED_EXTENSIONS.includes(extensionOf(name))) return 'files.blockedType';
  return null;
}

/**
 * Sniffs the real type from the leading bytes and refuses executables.
 *
 * The extension check alone is trivially bypassed by renaming `payload.exe` to `payload.txt`, so
 * the magic bytes get the final say. Loaded through a dynamic import because `file-type` is
 * ESM-only and the app compiles to CommonJS.
 */
export async function sniffType(head: Buffer): Promise<string | undefined> {
  const { fileTypeFromBuffer } = await import('file-type');
  const detected = await fileTypeFromBuffer(head);
  return detected?.mime;
}

export function isDangerousSniffedType(mime: string | undefined): boolean {
  return !!mime && DANGEROUS_SNIFFED.includes(mime);
}

/** Whether a type may be sent with `Content-Disposition: inline`. */
export function canRenderInline(mime: string | undefined): boolean {
  return !!mime && INLINE_SAFE.includes(mime);
}

/**
 * The rendering hint the documents panel groups by — a port of Attachments.kind, which drives the
 * preview dialog's choice between an image viewer, an iframe, a media element and a <pre>.
 */
export function kindOf(mime: string, name = ''): 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'other' {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('text/') || /json|xml|csv|javascript/.test(mime)) return 'text';
  if (/\.(log|md|txt|ya?ml|ini|sql)$/i.test(name)) return 'text';
  return 'other';
}

export { MAX_FILE_SIZE };
