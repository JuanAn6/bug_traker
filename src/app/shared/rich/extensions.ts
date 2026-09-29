import type { Extensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Mention from '@tiptap/extension-mention';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import type { User } from '../../core/models';

export interface RichOptions {
  placeholder?: string;
  users?: () => User[];
  /** Resolves `attachment:<id>` image sources to object URLs inside the editor. */
  resolveImage?: (attachmentId: number) => Promise<string>;
}

/** Images referencing stored attachments: `src="attachment:<id>"`. */
function attachmentImage(resolve?: RichOptions['resolveImage']) {
  return Image.configure({ inline: false, allowBase64: false }).extend({
    addNodeView() {
      if (!resolve) return null;
      return ({ node }) => {
        const img = document.createElement('img');
        const src = String(node.attrs['src'] ?? '');
        img.alt = node.attrs['alt'] ?? '';
        if (src.startsWith('attachment:')) resolve(Number(src.slice(11))).then((u) => (img.src = u));
        else img.src = src;
        return { dom: img };
      };
    },
  });
}

function mentionSuggestion(users: () => User[]) {
  return {
    items: ({ query }: { query: string }) => {
      const q = query.toLowerCase();
      return users()
        .filter((u) => u.enabled && (u.username.toLowerCase().includes(q) || u.realName.toLowerCase().includes(q)))
        .slice(0, 8);
    },
    render: () => {
      let el: HTMLDivElement | null = null;
      let props: SuggestionProps<User> | null = null;
      let active = 0;

      const draw = () => {
        if (!el || !props) return;
        el.replaceChildren();
        if (!props.items.length) {
          const none = document.createElement('div');
          none.className = 'none';
          none.textContent = '—';
          el.append(none);
        }
        props.items.forEach((u, i) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = i === active ? 'active' : '';
          b.textContent = u.realName;
          const small = document.createElement('small');
          small.textContent = '@' + u.username;
          b.append(small);
          b.onmousedown = (e) => {
            e.preventDefault();
            select(i);
          };
          el!.append(b);
        });
        const rect = props.clientRect?.();
        if (rect) {
          el.style.left = `${Math.min(rect.left, innerWidth - 240)}px`;
          el.style.top = `${rect.bottom + 4}px`;
        }
      };
      const select = (i: number) => {
        const u = props?.items[i];
        if (u) props!.command({ id: String(u.id), label: u.username } as unknown as User);
      };

      return {
        onStart: (p: SuggestionProps<User>) => {
          props = p;
          active = 0;
          el = document.createElement('div');
          el.className = 'mention-popup';
          document.body.append(el);
          draw();
        },
        onUpdate: (p: SuggestionProps<User>) => {
          props = p;
          active = Math.min(active, Math.max(0, p.items.length - 1));
          draw();
        },
        onKeyDown: ({ event }: SuggestionKeyDownProps) => {
          const n = props?.items.length ?? 0;
          if (event.key === 'ArrowDown') { active = (active + 1) % Math.max(n, 1); draw(); return true; }
          if (event.key === 'ArrowUp') { active = (active - 1 + n) % Math.max(n, 1); draw(); return true; }
          if (event.key === 'Enter' || event.key === 'Tab') { select(active); return true; }
          if (event.key === 'Escape') { el?.remove(); el = null; return true; }
          return false;
        },
        onExit: () => {
          el?.remove();
          el = null;
        },
      };
    },
  };
}

export function richExtensions(opts: RichOptions = {}): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [2, 3] },
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https', HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' } },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    attachmentImage(opts.resolveImage),
    Mention.configure({
      HTMLAttributes: { class: 'mention' },
      renderText: ({ node }) => `@${node.attrs['label'] ?? node.attrs['id']}`,
      renderHTML: ({ node }) => ['span', { class: 'mention', 'data-type': 'mention', 'data-id': node.attrs['id'] }, `@${node.attrs['label'] ?? node.attrs['id']}`],
      suggestion: opts.users ? mentionSuggestion(opts.users) : undefined,
    }),
    ...(opts.placeholder !== undefined ? [Placeholder.configure({ placeholder: opts.placeholder })] : []),
  ];
}

/** Extensions for static rendering (generateHTML); built once. */
export const STATIC_EXTENSIONS = richExtensions();
