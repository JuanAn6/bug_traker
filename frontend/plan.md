# Bug Tracker UI (MantisBT-style, DBeaver look) — Angular + SCSS + TipTap

## Context
`C:\projects\bt` is empty. Build a complete, fully functional front-end bug tracker covering the MantisBT feature set (and a bit beyond: sprints, board, burndown) with a DBeaver-like desktop-IDE look, as native as possible. No backend: seed data + CRUD in the browser (localStorage, IndexedDB for attachments) behind one service so an API can replace it later. Everything in English (UI + code) with a runtime i18n module to switch language per user (ship `en` + `es`).

Confirmed decisions: **Angular for all UI** · mock data + browser persistence · English + swappable runtime translations.
Not used: Tailwind (SCSS + CSS variables suffice), Angular Material/CDK (native HTML controls styled with tokens).

---

## 1. Stack & setup
- `npx @angular/cli@latest new bt --directory . --style=scss --routing --ssr=false --skip-git` (Node 20). Standalone components, signals, zoneless, `@if/@for/@switch`, `input()/output()/model()`.
- Deps: `@tiptap/core`, `@tiptap/starter-kit` (v3 incl. Link/Underline), `@tiptap/extension-mention`, `@tiptap/extension-placeholder`, `@tiptap/extension-task-list` + `task-item`, `@tiptap/extension-table` (+ row/cell/header). No other runtime deps.
- Rich text stored as TipTap JSON, rendered with `generateHTML` (schema-based) → `[innerHTML]` (Angular sanitizer as second layer).
- Lazy routes via `loadComponent`; `authGuard` → `/login`; `permissionGuard(level)` for admin pages.

## 2. Native-first UI toolkit
`<dialog>` modals via `DialogComponent` (`showModal()`, Esc/backdrop close) · `popover` for menus, dropdowns, context menus, tooltips · `<details>` tree · `<table>` grids with sticky headers · `<select>`, `<input type=date|datetime-local|color|search|file>`, `<datalist>` for tag autocomplete · `<progress>`/`<meter>` · HTML5 drag-and-drop (board, column reorder, file drop) · inline SVG charts (no chart lib) · Reactive Forms with native validation messages.

## 3. Shell layout (DBeaver-inspired) — `src/app/shell/`
- **Menu bar** (popovers): File (New issue, New project, Import/Export, Print, Sign out) · Edit (Search, Preferences) · View (Theme, Language, Toggle navigator, Toggle status bar, Density) · Issue (Report, My issues, Board, Saved filters) · Admin (Users, Projects, Workflow, Custom fields, Tags) · Help (Shortcuts, About).
- **Toolbar**: icon buttons (New issue, Refresh, Board, Summary), **project switcher** `<select>` (All projects / one), global **search** box (jump to `#123` or text search), notifications bell with unread count, current user menu.
- **Navigator** (left, resizable via CSS `resize`, collapsible): tree Projects › Sprints (active marked) / Versions / Categories / Saved filters; counts per node; click filters the issue list; right-click context menu (new issue here, edit project, new sprint).
- **Editor tabs** (DBeaver signature): opened issues/pages as tabs above the router outlet, close button, middle-click close, dirty marker `●` on unsaved forms, persisted in sessionStorage. `TabsService`.
- **Status bar**: current project, user + access level, open/total counts, overdue count, “Saved hh:mm”, language, theme.
- **Command palette** (`Ctrl+K`): fuzzy search issues/projects/users/actions.
- **Keyboard shortcuts** (`ShortcutsService`, help dialog `?`): `N` new issue, `/` search, `G I` issues, `G B` board, `E` edit, `A` assign to me, `C` comment, `J/K` next/prev row, `Ctrl+Enter` submit.
- **Toasts** (`ToastService`, `role=status`) with **Undo** for deletes/bulk ops.
- Confirm dialog for destructive actions.

## 4. Theming — `src/styles/`
`_tokens.scss` — every color a CSS custom property on `:root`, `[data-theme=dark]` override (DBeaver light / Darcula-like dark), plus `[data-density=compact|comfortable]`:
- corporate: `--brand`, `--brand-strong`, `--brand-accent` (orange), `--accent` (selection blue), `--accent-contrast`
- chrome: `--bg-window`, `--bg-panel`, `--bg-panel-alt`, `--bg-toolbar`, `--bg-menubar`, `--bg-tab`, `--bg-tab-active`, `--tab-active-indicator`, `--bg-input`, `--bg-statusbar`, `--border`, `--border-strong`, `--text`, `--text-muted`, `--text-inverse`, `--link`, `--row-alt`, `--row-hover`, `--row-selected`, `--focus-ring`, `--shadow`, `--scrollbar`
- semantic: `--status-{new,feedback,acknowledged,confirmed,assigned,resolved,closed}` (MantisBT palette, editable from Workflow admin at runtime), `--priority-{none…immediate}`, `--severity-{feature…block}`, `--danger`, `--warning`, `--success`, `--info`, `--overdue`
- chart series `--chart-1..6`.
Partials: `_base` (reset, typography Segoe UI 12–13px, native element styling: buttons, inputs, selects, tables, dialog, details, fieldset, scrollbars), `_layout`, `_grid`, `_editor` (ProseMirror + toolbar), `_print` (`@media print` for issue print view). Component `.scss` only for component layout.

## 5. Data model — `src/app/core/models.ts`
- `User`: id, username, realName, email, accessLevel (viewer/reporter/updater/developer/manager/administrator), enabled, avatarColor, prefs {language, theme, density, defaultProjectId, pageSize, emailOn…}, lastVisit, created.
- `Project`: id, name, key (e.g. `WEB`), description (rich), status (development/release/stable/obsolete), viewState (public/private), enabled, parentId (subprojects), categories[{name, defaultHandlerId}], versions[{name, date, released, obsolete, description}], members[{userId, accessLevel}], customFieldIds[].
- `Sprint`: id, projectId, name, goal, start, end, state (planned/active/closed), capacity.
- `Issue`: id, projectId, sprintId, category, summary, description/stepsToReproduce/additionalInfo (JSON), status, resolution, priority, severity, reproducibility, eta, projection, platform/os/osBuild, productVersion, targetVersion, fixedInVersion, reporterId, handlerId, viewState, tags[], monitorIds[], relationships[{type, issueId}], dueDate, estimate(h), storyPoints, customFields{}, created, updated.
- `Comment` (note): id, issueId, authorId, body JSON, private, timeSpent(min), created, edited.
- `Attachment`: id, issueId, **commentId?** (set when uploaded from a note), name, description, mimeType, size, uploaderId, date, version, previousVersionId? (metadata in store; blob in IndexedDB keyed by id). See §9b.
- `HistoryEntry`: id, issueId, userId, date, type (created/field/note-added/note-edited/note-deleted/attachment/relationship/tag/monitor/sprint), field, old, new.
- `SavedFilter`: id, name, ownerId, shared, criteria, columns, sort.
- `Notification`: id, userId, issueId, type (assigned/mentioned/status/note), read, date.
- `CustomField`: id, name, type (string/number/list/checkbox/date), options[], required.
- `WorkflowConfig`: allowed transitions status→status[], required access level per action (report, update, assign, change status, close, delete, manage project), status colors, default status/resolution on resolve/close.

`config.ts`: MantisBT enums + order + default workflow.  `seed.ts`: 8 users (all access levels), 4 projects (1 subproject), 6 sprints, ~80 issues spanning all statuses/priorities, notes with mentions + time, history, relationships, tags, 3 saved filters, notifications.

## 6. Services — `src/app/core/`
- `store.service.ts`: signal per collection; `effect()` persists to localStorage `bt:v1` (schema version + migrate hook); generic `upsert/remove`; issue ops write history automatically (`updateIssue` diff, notes, attachments, relationships incl. auto-reverse link, tags, monitors, sprint moves); `reset()`, `exportJSON/importJSON`; undo stack for last destructive op.
- `issue-actions.service.ts`: business rules — **assignment** (assign to me/user/unassign; auto-status `assigned` when handler set on `new`; category default handler on report; reporter/handler auto-monitor), change status honoring workflow transitions, resolve/close/reopen dialogs (resolution + fixed-in version + note), clone (with relationship “related to”), move to project/sprint, bulk ops, delete.
- `permissions.service.ts`: `can(action, project?)` from user level + project member override; templates hide/disable actions via `*can` style `@if (perm.can('assign'))`.
- `notification.service.ts`: generates notifications on assign/mention/status/note for monitors; bell dropdown, mark read/all.
- `issue-filter.ts`: pure `filterIssues(issues, criteria)` + `sortIssues` + `groupBy` (shared by list, My View, board, roadmap, summary, calendar).
- `attachments.service.ts`: single entry point for **all** files (ticket documents and note files) — IndexedDB blob put/get/delete, metadata via store, validation (size/type/quota), object-URL cache revoked on destroy, `listForIssue(issueId)` returns ticket + note files together. Details in §9b.
- `auth.service.ts` (fake login, current user signal), `theme.service.ts`, `tabs.service.ts`, `shortcuts.service.ts`, `toast.service.ts`, `csv.ts` (export/import).

## 7. i18n — `src/app/i18n/`
`en.ts` (typed key tree, source of truth incl. enum labels), `es.ts` (`DeepPartial<typeof en>`, falls back to en), `i18n.service.ts` (`lang` signal from user prefs, `t(key, params)`, plural helper, `Intl` date/number/relative-time formatting per locale), `t.pipe.ts`, `date.pipe`/`relative.pipe` locale-aware. Adding a language = one file + one list entry. (`@angular/localize` is build-time only, so it can't switch at runtime.)

## 8. Shared components — `src/app/shared/`
- `rich-editor` (TipTap in `afterNextRender`, destroyed on destroy, `ControlValueAccessor`): toolbar bold/italic/underline/strike/code, H2/H3, bullet/ordered/task lists, blockquote, code block, table, link, horizontal rule, undo/redo; `@mention` users (popover suggestion list); placeholder; `Ctrl+Enter` submit; paste image → attachment.
- `rich-view`, `issue-table` (configurable columns, sortable, multi-select with shift-click, status row colors, overdue highlight, context menu, keyboard nav, pagination, column chooser), `status-badge`, `priority-icon`, `severity-badge`, `user-chip` (avatar initials + color), `user-picker` (select with search), `tag-input` (datalist + chips), `dialog`, `confirm-dialog`, `empty-state`, `split-pane`, `tabs`, `svg-bar-chart`, `svg-line-chart` (burndown), `file-drop`.

## 9. Pages — `src/app/pages/`

### `/login`
User list cards + username/password fields (any password), “remember me”, language select.

### `/` — Home / My View (configurable)
- Header: greeting, current project, quick “Report issue”.
- KPI tiles: open, assigned to me, overdue, resolved this week, active sprint progress.
- Widgets (each an `issue-table` compact, collapsible `<details>`, reorderable, show/hide in prefs): **Assigned to me (unresolved)**, **Reported by me**, **Unassigned**, **Recently modified**, **Monitored by me**, **Resolved (awaiting my feedback)**, **Due soon / overdue**.
- Active sprint card (progress bar, days left, mini burndown), activity timeline (latest history across projects), status distribution bar, unread notifications.

### `/issues` — View Issues
- **Filter panel** (collapsible, MantisBT-like grid of fields): project (+ include subprojects), sprint, category, status (multi), hide status ≥ X, resolution, priority, severity, reproducibility, reporter, handler (incl. “unassigned”, “me”), monitored by, tags (any/all), target/fixed version, platform/OS, view state, created/updated/due date ranges, has attachments, relationship, custom fields, free text (summary/description/notes), `#id`.
- Filter state synced to URL query params (shareable, back button), active filter chips with × to remove, **Saved filters** (save/rename/delete, share with project, set default), reset.
- Grid: column chooser + drag reorder, sort by any column (shift for multi-sort), page size, pagination, row count, sticky header, status color legend, density toggle, “mark as read” styling for updated since last visit.
- **Bulk actions** on selection: assign, change status, set priority/severity, move to sprint/project/version, add/remove tags, monitor/unmonitor, copy, delete, export selected.
- Export CSV / JSON; print view; import CSV (map columns dialog).

### `/issues/:id` — Issue view
- Header: key `WEB-123`, summary (inline editable), status badge, prev/next navigation within current filter, actions toolbar: Edit, **Assign** (to me / user-picker), **Change status** (only allowed transitions; dialog with resolution, fixed-in version, handler, note), Monitor/Unmonitor, Sticky, Clone, Move, Print, Delete; overflow menu.
- Details grid (MantisBT layout): id, project, category, view state, dates (submitted/updated/due with overdue flag), reporter, handler, priority, severity, reproducibility, status, resolution, platform/OS/build, product/target/fixed versions, sprint, estimate, story points, time spent total, custom fields.
- Sections: Description, Steps to reproduce, Additional information (rich view, click to inline edit), **Tags** (add/remove), **Relationships** (add by id + type: related to, parent of, child of, duplicate of, has duplicate; shows target status; graph-less list), **Documents** panel (see §9b), **Monitors** (list, add user).
- **Activity tabs**: Notes (rich editor, private flag, time spent, @mentions, **attach files** via button/drop/paste — shown as chips under the note, edit/delete own, reply-quote, newest/oldest toggle), **History** table (date, user, field, change), Combined timeline, Time tracking summary per user.

### 9b. Ticket documents (attachments)

**Storage decision: store them the same way.** One `Attachment` entity + one IndexedDB object store for every file; a note file is just an attachment with `commentId` set. Reasons: one upload/preview/download/delete code path, the ticket's Documents list is a plain query (`issueId == X`) instead of merging two sources, quota/permissions/history apply uniformly, and it matches MantisBT (note files are bug files). The origin is kept in `commentId`, so the UI can still distinguish them.

**Documents panel on `/issues/:id`** (own tab next to Notes/History, with count badge):
- Upload: button (`<input type=file multiple>`), drag-and-drop zone over the whole panel, paste from clipboard; per-file progress + validation errors (max 10 MB/file, blocked executable types, total quota meter from `navigator.storage.estimate()`).
- Optional description on upload; rename and edit description later.
- **Source filter**: All · Ticket · From notes; each note file shows a “Note #N” link that scrolls to/highlights the note.
- Views: list (icon by type, name, size, uploader, date, source, version) and grid (thumbnails); sort by name/date/size/type; text search.
- **Preview** in a `<dialog>`: images (zoom, prev/next), PDF (`<iframe>` with blob URL), video/audio (native elements), text/JSON/CSV/log (`<pre>`), others → download.
- Download single; download all (sequential native downloads — zip skipped, add a zip lib if users ask).
- **New version** (“Replace”): uploads a new file linked via `previousVersionId`, keeps older versions collapsible under the current one.
- Delete (own files, or `manage` permission) with confirm + undo toast.
- Every upload/rename/new version/delete writes a History entry (`attachment` type) and notifies monitors.

**Notes integration**:
- Files attached in the note composer are uploaded with `commentId`; they appear as chips under the note **and** in the Documents panel.
- Images pasted into the rich editor are stored as attachments and embedded by id (`attachment:<id>` src resolved to an object URL at render time), so they also appear in Documents.
- Deleting a note asks: “Delete its N files too, or keep them on the ticket?” (keep → `commentId` cleared, file becomes a ticket document).
- Private note → its files inherit private visibility (hidden from users below `developer`).

**Elsewhere**: report/edit form accepts files (ticket documents); issue list has a 📎 count column and “has attachments” filter; clone optionally copies documents; project delete / reset demo data purges blobs; Settings shows attachment storage usage + “clear orphaned blobs”.

### `/report`, `/issues/:id/edit` — Report / Edit
Two-column form: project → category (drives default handler), reproducibility, severity, priority, platform/OS, product/target version, sprint, assign to, summary (required, max 128), 3 rich editors, tags, custom fields, due date, estimate/points, view state, attachments, “report stay” checkbox (report another), unsaved-changes guard (`canDeactivate`), advanced/simple toggle, draft autosave.

### `/board` & `/sprints/:id/board` — Kanban
Columns = statuses (configurable subset), swimlanes by assignee/priority/none, WIP limits, cards (key, summary, priority icon, avatar, points, tags), drag-and-drop → status change through workflow rules (invalid drops rejected with toast), quick filters (mine, unassigned, text), card click opens side panel preview.

### `/sprints`, `/sprints/:id`
List by project with state tabs (planned/active/closed); create/edit dialog (name, goal, dates, capacity); **sprint planning**: backlog (unscheduled issues) ↔ sprint panes with drag, points total vs capacity meter; start/complete sprint (move unfinished to next sprint/backlog); sprint detail: burndown SVG chart, scope, completed %, issues table.

### `/projects`, `/projects/:id` — Projects admin
- List: name, key, status, view state, enabled, parent, issue counts, members; create/delete (confirm with typed name).
- **Edit project** tabs: *General* (name, key, status, view state, enabled, parent, rich description) · *Categories* (add/rename/delete, default handler, merge on delete) · *Versions* (add/edit, date, released/obsolete, reorder) · *Members* (add users, per-project access level, remove) · *Sprints* · *Custom fields* (link/unlink) · *Statistics*.

### `/roadmap` & `/changelog`
Per project → per target version / sprint: progress bar (resolved/total), issue list with status. Changelog: released versions with resolved issues grouped by category.

### `/summary` — Statistics
Tables + SVG charts: by status, by project × status, by priority, by severity, by category, by handler (open/resolved/%), by reporter, resolution stats, reopen rate, time-to-resolve avg, created-vs-resolved per week line chart, most active issues, longest open.

### `/calendar`
Month grid (native CSS grid) of due dates and sprint spans; click day → issues; prev/next month.

### `/notifications`
Full list, filter unread, mark all read, go to issue.

### `/users`, `/users/:id` — Users admin
Table (username, real name, email, access level, enabled, last visit, projects), filters (level, enabled, text); create/edit dialog; enable/disable; reset password (fake); delete (reassign their issues dialog); per-user project memberships; user detail with their assigned/reported stats.

### `/account` — My account & preferences
Profile (real name, email, avatar color), change password (fake), preferences (language, theme, density, default project, page size, home widgets, notification toggles per event), my monitored issues, my time spent.

### `/admin/workflow`
Transition matrix (checkbox grid status×status), status colors (`<input type=color>` → CSS vars live), access thresholds per action, defaults on resolve/close.

### `/admin/custom-fields`, `/admin/tags`
CRUD custom fields (type, options, required, linked projects). Tags: rename/merge/delete with usage counts.

### `/settings`
Export/import full DB JSON, reset demo data, clear attachments, storage usage meter, about.

### Errors
`/404` page, issue-not-found / no-permission states, `ErrorHandler` toast.

## 10. Accessibility & UX basics
Labels on all inputs, focus-visible rings from tokens, `aria-sort` on grid headers, `aria-live` toasts, dialogs trap focus natively, keyboard-operable board (move card with menu as DnD alternative), `prefers-reduced-motion`, `prefers-color-scheme` default theme.

## 11. Folder layout
```
src/styles/{_tokens,_base,_layout,_grid,_editor,_print}.scss, styles.scss
src/app/app.config.ts, app.routes.ts
src/app/core/   models, config, seed, store, issue-actions, permissions, notification, attachments, auth, theme, tabs, shortcuts, toast, issue-filter, csv, guards
src/app/i18n/   en.ts, es.ts, i18n.service.ts, t.pipe.ts
src/app/shell/  shell, menubar, toolbar, navigator, editor-tabs, statusbar, command-palette
src/app/shared/ (components listed in §8)
src/app/pages/  login, home, issues, issue-view, issue-form, board, sprints, projects, roadmap, changelog, summary, calendar, notifications, users, account, admin/*, settings, not-found
```

## 12. Build order
1. Scaffold, tokens + base styles, shell layout, i18n, store + seed, auth.
2. Shared components (issue-table, rich-editor, dialog, pickers).
3. Issues list + filters, issue view, report/edit, assignment/workflow actions, history, notes, attachments.
4. Projects admin, users admin, account.
5. Home, board, sprints/planning, roadmap/changelog, summary, calendar, notifications.
6. Workflow/custom fields/tags admin, command palette, shortcuts, tabs, print, CSV, polish + `es` translation.

## Deliberately out of scope
Real backend/auth (swap `StoreService` internals for HttpClient), real email sending, LDAP/SSO, plugins, source-control integration.

## Verification
1. `ng build` passes (strict TS + strict templates).
2. `ng test`: `store.service.spec.ts` (history diffing, relationship reverse links, undo), `issue-filter.spec.ts` (criteria/sort), `issue-actions.spec.ts` (workflow transitions, auto-assign status, permissions), `attachments.service.spec.ts` (ticket + note files listed together, note delete keep/delete files, versioning, validation).
3. `ng serve`, manual E2E: log in as reporter → report issue with formatted description + attachment → log in as developer → filter list, save filter → assign to me (status → assigned, notification to reporter) → add note with @mention + time + a file (appears under the note and in Documents with “Note #N”) → upload a new version of the first document, preview it → delete the note keeping its file → resolve via dialog → history shows every change → drag on board (invalid transition rejected) → plan sprint and complete it → edit project (category default handler, version, member) → change language to `es`, dark theme, compact density → reload (all persists) → export/import JSON → reset demo data.
