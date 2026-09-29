import type { JSONContent } from '@tiptap/core';
import type { RichText } from './models';

/** Build a TipTap doc from plain paragraphs (used by seed data and plain-text imports). */
export function doc(...paragraphs: string[]): JSONContent {
  return {
    type: 'doc',
    content: paragraphs.map((p) => (p ? { type: 'paragraph', content: [{ type: 'text', text: p }] } : { type: 'paragraph' })),
  };
}

export function plainText(rt: RichText | undefined): string {
  if (!rt) return '';
  const out: string[] = [];
  const walk = (n: JSONContent) => {
    if (n.text) out.push(n.text);
    if (n.type === 'mention') out.push('@' + (n.attrs?.['label'] ?? ''));
    n.content?.forEach(walk);
    if (n.type === 'paragraph' || n.type === 'heading' || n.type === 'listItem') out.push(' ');
  };
  walk(rt);
  return out.join('').replace(/\s+/g, ' ').trim();
}

export function isEmptyRich(rt: RichText | undefined): boolean {
  return !rt || (!plainText(rt) && !findNodes(rt, 'image').length);
}

export function findNodes(rt: RichText | undefined, type: string): JSONContent[] {
  const found: JSONContent[] = [];
  const walk = (n: JSONContent) => {
    if (n.type === type) found.push(n);
    n.content?.forEach(walk);
  };
  if (rt) walk(rt);
  return found;
}

export const mentionedUserIds = (rt: RichText | undefined): number[] =>
  [...new Set(findNodes(rt, 'mention').map((n) => Number(n.attrs?.['id'])).filter(Boolean))];

export const embeddedAttachmentIds = (rt: RichText | undefined): number[] =>
  findNodes(rt, 'image')
    .map((n) => String(n.attrs?.['src'] ?? ''))
    .filter((s) => s.startsWith('attachment:'))
    .map((s) => Number(s.slice('attachment:'.length)));
