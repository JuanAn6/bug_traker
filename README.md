# Bug Tracker

A MantisBT-style issue tracker with a desktop-IDE look (DBeaver-inspired): an Angular
single-page application and a NestJS API over MariaDB.

The repository holds two independent applications that share one data contract:

| Directory | What it is | Stack |
|---|---|---|
| [frontend/](frontend/) | The whole UI, fully functional on its own | Angular 21 (standalone, signals, zoneless), SCSS tokens, TipTap 3 |
| [backend/](backend/) | The API that replaces the browser store | NestJS 11 on Fastify, Drizzle ORM, MariaDB |

The frontend was built first and persists everything in the browser (`localStorage` for
records, IndexedDB for attachment bytes) behind a single `Store` service. The backend is
written **to that same `Db` model**, so it can be swapped in under `Store` without changing
any data shape, and `GET /api/admin/export` produces a file that the UI's
**Settings → Import** accepts unmodified.

---

## Features

- **Issues** — the MantisBT field set (status, resolution, priority, severity,
  reproducibility, platform/OS, product/target/fixed-in versions, ETA, projection), rich-text
  description / steps to reproduce / additional info, categories, tags, custom fields,
  relationships (related, parent/child, duplicate) with automatic reverse links, monitors,
  estimates and story points, due dates, private issues and private notes, time tracking,
  full history per issue, clone, move between projects, and bulk operations.
- **Agile** — sprints (planned/active/closed with capacity), a drag-and-drop board, burndown,
  roadmap and changelog by version.
- **Views** — issue list with configurable columns, saved filters, summary dashboards,
  calendar, per-user activity, a home page of widgets, and notifications with mentions.
- **Administration** — users and access levels, projects and subprojects with per-project
  membership, a configurable workflow (allowed transitions and required access level per
  action), custom fields, tags, and JSON import/export of the whole database.
- **UI** — native-first controls (`<dialog>`, `popover`, `<details>`, real tables) styled with
  CSS custom properties: light/dark themes, compact/comfortable density, editor tabs with
  dirty markers, a resizable project navigator, a `Ctrl+K` command palette, keyboard
  shortcuts, toasts with undo, and runtime i18n (English and Spanish).

## Authorization model

Six access levels — viewer (10), reporter (25), updater (40), developer (55), manager (70),
administrator (90) — checked against **22 action thresholds**, with per-project membership
able to raise or lower a user's effective level. Seven statuses in a fixed order
(`new → feedback → acknowledged → confirmed → assigned → resolved → closed`) drive both the
transition matrix and every rank comparison.

The backend enforces all of it server-side, including the checks the UI only hides.

---

## Quick start

Prerequisites: Node 20+, and MariaDB 10.4+ (this project develops against XAMPP's, on 3306 —
start it with `sudo /opt/lampp/lampp startmysql`).

### Frontend only

The UI is self-contained; no database and no API are needed to run it.

```bash
cd frontend
npm install
npm start                  # http://localhost:4200
```

It boots with seeded data — 8 users covering every access level, 4 projects (one a
subproject), 6 sprints and 80 issues. Sign in as any of them — authentication is local and
accepts any password.

### Backend

```bash
cd backend
cp .env.example .env       # then set JWT_SECRET
npm install
npm run sync:shared        # copy the frontend's pure modules into src/shared
npm run db:migrate         # apply ./drizzle/*.sql
npm run db:seed            # the same 1052-row dataset the UI ships with
npm run build && npm start # or: npm run start:dev
```

`http://localhost:3000/api` — Swagger UI at [`/api/docs`](http://localhost:3000/api/docs).
Every seeded user's password is `demo`.

`CORS_ORIGINS` already allows `http://localhost:4200`, so `ng serve` and the API work
together out of the box; served same-origin behind XAMPP, neither CORS nor cookies need
configuring.

---

## Layout

```
frontend/
  src/app/core/        models, config, store, business rules, pure filter — the contract
  src/app/pages/       one folder per route (issues, board, sprints, summary, admin, …)
  src/app/shell/       menu bar, toolbar, navigator, editor tabs, command palette
  src/app/shared/      dialogs, charts, avatars, rich-text editor, reusable pieces
  src/app/i18n/        en / es dictionaries and the runtime language service
  src/styles/          design tokens and native-element styling
  plan.md              the full specification this UI was built from

backend/
  src/shared/          6 files copied verbatim from frontend/src/app/core (see below)
  src/core/            config, Drizzle schema (29 tables), ports and their adapters
  src/modules/         one module per resource (issues, comments, attachments, admin, …)
  src/common/          guards, pipes, filters, decorators, pagination
  drizzle/             SQL migrations
  scripts/             migrate, seed, integrity check, sync-shared
  test/                unit · integration (parity) · e2e (over HTTP)
  README.md            runbook, design decisions, and every deliberate deviation
```

## The shared core

Six modules are **copied, not rewritten**: `models.ts`, `config.ts`, `rich.ts`, `metrics.ts`,
`seed.ts` and `issue-filter.ts` go from `frontend/src/app/core` into `backend/src/shared`,
pinned by SHA-256. They are the single source of truth for the statuses and their order, the
permission thresholds, the transition matrix, the filter defaults and the seed data.

Change the **frontend** file, then run `npm run sync:shared` in `backend/`. The test suite
fails on drift.

## Tests

```bash
cd frontend && npm test    # Vitest unit tests for the business rules and the filter
cd backend  && npm run test:all
```

The backend's `test:all` chains the sync check, a typecheck, and three suites:

| Suite | Needs | What it protects |
|---|---|---|
| `test:unit` | nothing | the ported business rules and the authorization sweep |
| `test:integration` | `bugtraker_test` | filter and visibility parity against the frontend's own functions |
| `test:e2e` | a build + `bugtraker_test` | the real compiled server over HTTP |

Parity is the point of the middle suite: the SQL query builder and the frontend's pure
`filterIssues()` are run against the same dataset and must return the same ids.

## Configuration

Everything is environment-driven and validated at boot — see
[backend/.env.example](backend/.env.example) for the annotated list. The ones worth knowing:

- `DEMO_MODE` — keeps the login page's demo panel working, accepts any password for the
  seeded accounts, and gates `/admin/import` and `/admin/reset`. **Must be `false` outside
  local development.**
- `STORAGE_DRIVER` — `local` writes attachment bytes to disk under `STORAGE_ROOT`, named by
  their SHA-256 and reference-counted, so a clone or a re-upload adds a row but not a second
  copy. `s3` is in the schema and everything goes through `StoragePort`; the adapter is one
  new file.
- `SEARCH_DRIVER` — `like` is the authority, not a fallback: the UI matches substrings
  mid-word (`ogin` finds "Login"), which InnoDB FULLTEXT cannot do.

Attachment bytes live outside the database, so **a `mysqldump` is not a complete backup** —
`GET /api/admin/storage` reports the files separately for exactly that reason.

---

## Further reading

- [backend/README.md](backend/README.md) — the runbook, the two rules to know before changing
  anything, the deviations from the plan and why, and the parity gaps kept on purpose.
- [frontend/plan.md](frontend/plan.md) — the complete UI specification, section by section.
