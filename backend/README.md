# Bug Tracker API

NestJS + Drizzle + MariaDB backend for the Angular bug tracker in `../frontend`.

The contract is the frontend's own `Db` model: this API is built to be swapped in under
`StoreService` without changing the data shapes, and `GET /admin/export` produces a file that
the browser's **Settings → Import** accepts unmodified.

## Runbook

MariaDB is XAMPP's, on 3306. Start it with `sudo /opt/lampp/lampp startmysql`.

```bash
npm install
npm run sync:shared        # copy the frontend's pure modules into src/shared
npm run db:migrate         # apply ./drizzle/*.sql
npm run db:migrate -- --test
npm run db:seed            # 1052 rows: 8 users, 4 projects, 6 sprints, 80 issues
npm run build && npm start # or: npm run start:dev
```

`http://localhost:3000/api` · Swagger at `/api/docs` · every seeded user's password is `demo`.

```bash
npm run test:all           # sync check + typecheck + unit + integration + e2e
```

| Suite | Needs | What it protects |
|---|---|---|
| `test:unit` | nothing | the ported business rules and the authorization sweep |
| `test:integration` | `bugtraker_test` | **filter and visibility parity against the frontend's own functions** |
| `test:e2e` | a build + `bugtraker_test` | the real compiled server over HTTP |

## Two things to know before changing anything

**`src/shared/` is copied, not written.** Six files come verbatim from
`../frontend/src/app/core` and are pinned by SHA-256 in `.digests.json`. They are the source of
truth for the 7 statuses and their order (every `*Rank` column is an index into it), the 22
permission thresholds, the transition matrix and the filter defaults. Change the **frontend**
file, then `npm run sync:shared`. `npm run test:all` fails on drift.

**Never query `issues` without `IssuesQueryService.baseWhere(actor)`.** Drizzle has no query
middleware, so `deletedAt IS NULL` and the visibility predicate cannot be injected
transparently. In the browser, visibility is applied *outside* `filterIssues()`, so a backend
that only translated the filter would serve private issues to anyone who asked.

## Attachments

Bytes live on disk under `STORAGE_ROOT`, **named by their SHA-256** and fanned out two levels
(`var/storage/blobs/ab/cd/abcd…`). The database holds only metadata.

Content addressing is what makes the frontend's shared `blobId` safe. The `blobs` table carries a
reference count, so cloning an issue or re-uploading the same screenshot adds a row and a reference
but not a second copy — and a delete only unlinks the bytes when the count reaches zero.

**A `mysqldump` is not a complete backup.** The files are outside the database; `GET /admin/storage`
reports them separately for exactly that reason. This is the real cost of local disk, and the honest
argument for moving to object storage later — not performance.

`STORAGE_DRIVER=s3` is already in the env schema and everything goes through `StoragePort`, so an
R2/S3 adapter is one new file in `core/adapters/` plus one line in `PortsModule`. Nothing in
`modules/` names an adapter. Worth doing when the file backup becomes awkward, or if the app ever
runs somewhere without a persistent disk — not before.

Three things that are easy to get wrong and are pinned by tests:

- **Oversized uploads must be rejected, not truncated.** Fastify's multipart layer enforces its size
  limit by cutting the stream, so an 11 MB upload arrives as a complete-looking 10 MiB file. Without
  an explicit `truncated` check it is stored as if intact.
- **An SVG is never served inline**, whatever its extension. It is a document that can carry script,
  so inline from this origin is stored XSS. It downloads normally.
- **The extension check is not the last word**; the magic bytes are. `payload.exe` renamed to
  `payload.txt` is caught by sniffing.

## Deviations from the plan, and why

- **`module: commonjs`, not `NodeNext`.** NestJS's decorator/DI runtime is CJS-first and ESM
  would force `.js` on every relative import. The one ESM-only dependency (`file-type`) will be
  loaded with a dynamic `import()`.
- **The app is compiled with `tsc`, never run through `tsx`.** esbuild does not implement
  `emitDecoratorMetadata`, so `design:paramtypes` comes out `undefined` and every constructor
  injection resolves to nothing. `scripts/` stays on `tsx` because it uses no DI; the e2e suite
  runs `dist/main.js` for the same reason.
- **`SEARCH_DRIVER=like` is the authority, not a fallback.** The frontend matches substrings
  mid-word (`ogin` finds "Login"); InnoDB FULLTEXT matches whole tokens, and this server runs
  `innodb_ft_min_token_size=3` with stopwords on. The `ft_` indexes exist and are maintained —
  set `min_token_size=1` and `innodb_ft_enable_stopword=OFF` in `my.cnf`, rebuild them, and
  flip the driver if token-boundary matching becomes acceptable.
- **The session timezone is pinned per connection** rather than via `my.cnf`. Every date
  boundary is a UTC instant because the frontend compares `toISOString().slice(0,10)`.
- **`seed.ts` is the only copied file with `@ts-nocheck`.** It indexes arrays freely and the
  frontend does not enable `noUncheckedIndexedAccess`; editing it would break byte parity.

## Parity gaps kept on purpose

Faithful to the frontend even though they are arguably wrong. Changing any of them is a
product decision, not a cleanup:

- a mention in a **private** note still sends a 140-character excerpt to someone who cannot
  read the note (stored as `excerptPrivate = true`, so suppressing it later is a one-line
  change in the reader, with no migration);
- renaming or deleting tags from the admin panel writes no history and does not touch
  `updated`, unlike `addTag`/`removeTag`; the same goes for category and version renames;
- `setMonitor` does not touch `updated`; editing custom fields writes no history at all;
- `KEY-123` ignores the project key, so `MOB-2` finds issue 2 even in `WEB`;
- `workflow.resolvedStatus` is stored but unused — `isResolved` is hardcoded to `'resolved'`;
- the workflow configuration is global, not per project.

## Corrections that are deliberate

- **Issue ids are never reused.** `report()` used `max(id) + 1`, so deleting the highest issue
  freed its number for the next one.
- **Every permission is checked server-side**, including the ones the UI only hides: editing or
  deleting somebody else's note, removing relationships, adding tags, marking another user's
  notifications read, and reporting on behalf of another user (`reporterId` is forced to the
  caller unless they hold `manageUsers`).
- **Notification fan-out checks visibility**, which the frontend never did.
- **Note search respects `canSeeNote`.** The frontend builds its search haystack from every
  comment, so a private note's text is searchable by anyone today.
- **Burndown, the reopen rate and `move()`'s version remapping** are fixed — see §12.2 of the
  plan for the three bugs.
