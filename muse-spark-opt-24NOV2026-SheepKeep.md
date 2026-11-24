# SheepKeep optimization sweep — report only, no code changed

Date: 2026-11-24 · Scope: `apps/web/src`, `apps/server/src`, `packages/shared/src`,
`packages/mcp/src`, build/test config · Method: static inspection only (every
finding cites a file:line I opened and read; nothing was executed, profiled, or edited).

How to reproduce any finding: run the `rg` command in its "Confirm" row from the
repo root, then open the cited file at the cited line. Severity = my judgement of
waste × frequency, not a measurement.

Contents: [polling](#1-unnecessary-polling--repeated-updates) ·
[inefficient processes](#2-inefficient-processes) · [dead/zombie](#3-dead--zombie-code) ·
[duplicates](#4-duplicateredundant-processes) · [algorithms](#5-poor-algorithm-implementations) ·
[build/test](#6-buildcidev-process-waste) · [ruled out](#7-things-checked-and-ruled-out) ·
[backlog](#suggested-fix-backlog-prioritised).

---

## 1. Unnecessary polling / repeated updates

### OPT-1 (MEDIUM): Two near-identical 1.5 s network poll loops for import runs
Two screens poll the import-run endpoint on a fixed timer with a duplicated
constant and a duplicated effect:

- `apps/web/src/components/import/archive-run.tsx:59` — `const POLL_MS = 1500;`
- `apps/web/src/components/import/archive-run.tsx:116-122` — `setInterval(() => void query.refetch(), POLL_MS)` while `run?.status === 'running'`
- `apps/web/src/components/import/stepper.tsx:61` — second `const POLL_MS = 1500;`
- `apps/web/src/components/import/stepper.tsx:393-399` — byte-similar `setInterval(() => void query.refetch(), POLL_MS)` effect with the same comment

Same `put()` report-preserving cache write is duplicated just above each loop
(`archive-run.tsx:104-114`, `stepper.tsx:385-391`); `isStale` is at least shared
from `upload-step.tsx:39`.
Confirm: `rg -n "POLL_MS" apps/web/src/components/import`.

### OPT-2 (MEDIUM): Inbox drafts query polls local store every 5 s, unconditionally
`apps/web/src/components/inbox/inbox-list.tsx:771-778` — `LocalDrafts` runs
`local.pending()` with `refetchInterval: 5000` and no gating on visibility,
online state, or queue length. The read itself is a cheap local Dexie call, but it
re-renders on every tick for as long as the inbox is mounted. A sync-engine event
or `focusManager`/visibility-gated refetch would do the same job with ~zero ticks.
Confirm: `rg -n "refetchInterval" apps/web/src/components/inbox/inbox-list.tsx`.
Related, same shape: `apps/web/src/components/readings/pending.tsx:24` polls every
3 s — but only while `data.length > 0`, so it self-extinguishes; keep as the pattern
to copy, not a finding.

### OPT-3 (LOW): Three 2–3 s local-store poll loops on capture/scan screens
All cheap (local reads, correct cleanup), but all busy-poll instead of subscribing:

- `apps/web/src/components/capture/capture-screen.tsx:506-510` — `refreshCounts()` every 2000 ms
- `apps/web/src/components/capture/capture-screen.tsx:1343-1355` — pending-keys read every 2000 ms (second loop on the same screen)
- `apps/web/src/components/scan/session/session-screen.tsx:201-205` — `readWorld` every 3000 ms while `phase === 'setup'`
- `apps/web/src/components/scan/session/summary.tsx:109-131` — `check()` every 3000 ms; this one also hits the network (`captureApi.scanSession`) whenever online
- `apps/web/src/components/services/log-service-sheet.tsx:311` — `refetchRecord()` every 2000 ms

Two loops on one screen (`capture-screen`) plus one network-hitting loop
(`summary.tsx`) are the ones worth converting first (store subscription / push /
backoff-after-first-empty).
Confirm: `rg -n "setInterval" apps/web/src/components/capture/capture-screen.tsx apps/web/src/components/scan/session/session-screen.tsx apps/web/src/components/scan/session/summary.tsx apps/web/src/components/services/log-service-sheet.tsx`.

### OPT-4 (LOW): 1 s clock tick re-renders confirm card
`apps/web/src/assistant/confirm-card.tsx:85` — `setInterval(() => setNow(Date.now()), 1000)`
re-renders the whole card every second, presumably for a relative timestamp.
A minute-granularity tick (or `Intl.RelativeTimeFormat` updated on visibility)
renders 60× less.
Confirm: open the file at line 85.

### OPT-5 (LOW): 20 fps full-component re-render for graph spin
`apps/web/src/graph/floors-3d.tsx:100-107` — `setInterval(..., 50)` bumps `yaw`
state, re-rendering the entire SVG-projected scene (rebuilds `P`/`tagP` Maps and
`focusSet` Sets at lines 125-146 on every tick) at 20 fps. It honours
`prefers-reduced-motion` (`spinning` starts false when `reduced`) and stops on
demand — the shape is right, the mechanism is heavy. A `requestAnimationFrame`
loop writing a transform, or a CSS rotation, would skip 20 React renders/second.
Confirm: open lines 100-150 of the file.

### OPT-6 (INFO, acceptable as-is): 1 s live-turn poll, 45 s native tick, bounded retries
- `apps/web/src/native/assistant.tsx:113-119` — `refetchInterval` 1000 ms but gated
  on `isLiveTurn(status)`; it stops when the turn finishes. Correct; SSE would be
  nicer but this is not waste today.
- `apps/web/src/native/main.tsx:769` — `setInterval(now, 45_000)`; harmless cadence.
- `apps/web/src/pwa/update-prompt.tsx:35-58`, default `recheckMs = 5000` — only
  fires while a new worker waits AND gates report busy; bounded, fine.
- `apps/web/src/offline/sync-engine.ts:115-116,479-483` — 60 s idle cadence with
  exponential backoff (`BACKOFF_MIN_MS` 5 s → `BACKOFF_MAX_MS` 5 min); good shape.
- `apps/server/src/jobs/liveness.ts:15,57` — 15 s liveness heartbeat; appropriate.
- `apps/server/src/files/pdf-text.ts:142-149`, `apps/server/src/reports/render/render.ts:130` —
  `setInterval` RSS watchdogs on child processes with `polling` re-entrancy guards
  and cleanup in `finally`; correct, not waste.
- `apps/server/src/webhooks/deliver.ts:151-163` — `pace()` sleeps only when the
  per-location per-second budget is exhausted; rate limiting, not polling.

---

## 2. Inefficient processes

### OPT-7 (MEDIUM): Job handlers pin an idle DB transaction for up to 100–180 s
`apps/server/src/assistant/turn-job.ts:50-56` and
`apps/server/src/embeddings/job.ts:198-205` — both note it themselves:
`runJob()` holds the scoped transaction open and unused while the handler works on
other connections (a turn may run 180 s, an embedding up to 80 s); each sets
`idle_in_transaction_session_timeout` (210 s / 100 s) as a brace. Every concurrent
turn/embedding therefore occupies a pool slot doing nothing for minutes. Under
load this is pool exhaustion wearing a comment as a disguise. Fix direction: run
these handlers outside the scoped transaction (pass `client` only where the job
table needs it) or release-and-reacquire.
Confirm: open both ranges; reproduce under load with
`SELECT pid, state, now() - xact_start AS held FROM pg_stat_activity WHERE state = 'idle in transaction';`
during an assistant turn.

### OPT-8 (LOW): Sequential per-location `gateFor` awaits in insights scope walk
`apps/server/src/insights/service.ts:207-212` — `for (const r of rows) { await gateFor(...) }`.
`gateFor` (`apps/server/src/serialize/gates.ts:83-99`) has a per-scope promise
cache, so repeats are free — but first-touch loads for N locations resolve
sequentially instead of via one `Promise.all`. Same file has four more
`for (const r of rows)` accumulation loops (lines ~262, ~348, ~485, ~638) that are
pure CPU over already-fetched rows — fine, listed only so nobody "fixes" them.
Confirm: open `insights/service.ts:195-213` and `serialize/gates.ts:83-99`.

### OPT-9 (LOW): Unbounded in-process webhook throttle map
`apps/server/src/webhooks/deliver.ts:148-163` — `recent: Map<string, number[]>`
prunes old timestamps per location but never deletes the location key itself, so
the map grows one entry per location that ever fires a webhook, for the life of
the process. Negligible per entry; still a slow leak with an obvious fix
(`recent.delete(locationId)` when the filtered list is empty).
Confirm: open lines 148-163; no `delete` call exists in the file
(`rg -n "recent.delete" apps/server/src/webhooks/deliver.ts` → no matches).

### OPT-10 (LOW): `homeOverviewOf` issues independent queries sequentially
`apps/server/src/home/overview.ts:341-349` — `agenda`, `loans`, `things`,
`lowStock`, `places`, `values` are awaited one after another although none feeds
another (all take `client` + precomputed ids). One `Promise.all` would cut home
latency to the slowest query instead of the sum. The per-row SQL underneath is
well-aggregated CTEs (good — no N+1 here), so this is purely latency stacking.
Confirm: open lines 330-350.

---

## 3. Dead / zombie code

### OPT-11 (LOW): `country-flag-icons` — check before keeping
`apps/web/package.json` lists `country-flag-icons: 1.6.20`, but no import found:
`rg -n "country-flag-icons|CountryFlag|FlagIcon" apps/web/src apps/ios` → verify.
If unused, it ships locale SVG data for nothing. (LOW confidence — verify first;
flag icons may be referenced by dynamic name string.)

### OPT-12 (LOW): Two-icon dependency on `@tabler/icons-react`
Only `IconEngine, IconHanger` are imported, in one file
(`apps/web/src/components/type-icon.tsx:13`). Named imports tree-shake, so the
bundle cost is ~2 icons, but it is a whole dependency (with its own release/
license surface) for two glyphs that could be inlined SVGs or Lucide equivalents.
The file's own header (lines 1-12) already documents Tabler's broken dynamic
entry as a liability. Confirm: `rg -ln "tabler" apps/web/src` → one file.

### OPT-13 (INFO): Almost no zombie markers — codebase is clean here
- `rg -in "TODO|FIXME|HACK|XXX" apps/server/src apps/web/src packages/*/src` →
  one real TODO (`apps/server/src/currencies/routes.ts:106`, an instance-admin
  guard note) and `XXX` hits that are all the literal `XXX-XXX` setup-code format,
  not placeholders.
- Commented-out code search (`rg -n "^\s*//\s*(const|let|import|return)"`) → none;
  matches are prose comments.
- `console.log` in server src is confined to CLI output paths
  (`apps/server/src/cli/index.ts`, `config/db-passwords.ts:24` has a targeted
  biome-ignore) — legitimate.
- `rg -n "@deprecated|no longer used"` → no hits in src (only benign test-helper
  names like `unusedConfigDir`).

### OPT-14 (INFO): `cn` npm package is NOT dead — do not remove
`apps/web/src/lib/utils.ts:3` imports `createCn` from `cn/config`; all `@/lib/utils`
`cn(...)` call sites resolve to this. Verified live dependency despite zero
`from 'cn'` bare imports.

---

## 4. Duplicate/redundant processes

### OPT-15 (MEDIUM): Import-run polling + cache-write duplicated across two screens
Same as OPT-1, stated as duplication: `POLL_MS`, the `polling` guard
(`run?.status === 'running' && !isStale(run)`), the interval effect, and the
report-preserving `put()` exist in near-identical form in `archive-run.tsx`
and `stepper.tsx`. One shared `useImportRunPolling(runId)` hook would delete
~50 lines and prevent the two copies drifting (note they already differ slightly
in the invalidate target: `captureKeys.imports.all` vs
`captureKeys.imports.list(...)`).
Confirm: `diff <(sed -n '59,123p' apps/web/src/components/import/archive-run.tsx) <(sed -n '61,399p' apps/web/src/components/import/stepper.tsx)` and eyeball.

### OPT-16 (LOW): Same "idle transaction" workaround comment in two job files
`turn-job.ts:54-55` / `embeddings/job.ts:203-204` carry the same explanation
because both work around the same `runJob()` scoping behaviour. If OPT-7 is fixed
at the runner level, both comments and both `SET LOCAL` braces disappear together.
Track with OPT-7, not separately.

### OPT-17 (INFO): No duplicated validation/transformation passes found
`isStale` is shared from `upload-step.tsx:39`; `errorText`/`isApiError` are shared
helpers; cursor pagination shape (`items` + `next_cursor`) is consistently
re-implemented per route (fuel, notify, capture, assistant threads) but each is
a small zod+SQL adapter over different tables — convergence would add abstraction
without removing work. Left alone deliberately.

---

## 5. Poor algorithm implementations

### OPT-18 (LOW, textbook): `rows.find` inside a loop — O(n²) claim pass
`apps/server/src/assistant/proposals.ts:581-582`:
`for (const id of ids) { const r = rows.find((x) => x.id === id) ... }`.
`rows` is already iterated just above (line 572) — build one `Map` there and the
inner scan disappears. Batch sizes are small (a proposal batch), so this is
hygiene, not a hotspot; filed because it is exactly the construct the sweep asked
for. Confirm: open lines 560-600.

### OPT-19 (INFO): No O(n²)-that-matters, no regex hot paths, no repeated sorts found
- `rg -n "\.sort\(" apps/server/src` hits are single sorts before output; no
  sort-in-loop.
- The heavy aggregations (home overview, insights spending, fuel pages) are set
  SQL (CTEs, `GROUP BY`, window-style `DISTINCT ON`) — the expensive work is in
  the database, once, not in JS loops. `insights/service.ts` spending query even
  folds line-item sums into a scalar subquery rather than fetching lines.
- No `new RegExp` in loops, no per-keystroke filtering over full collections
  (search palette debounces: `apps/web/src/components/search/palette.tsx:97`,
  `DEBOUNCE_MS`; filter values debounce in
  `apps/web/src/components/filters/values.ts:17`).
- Per-row `await` inside `for` loops exists in several places checked
  (`assistant/loop.ts:653,746,796-798`, `home/overview.ts:317+`,
  `insights/service.ts` accumulators) — all iterate already-fetched rows or mix
  CPU with cached promises; none issues per-row queries except OPT-8.

---

## 6. Build/CI/dev-process waste

### OPT-20 (LOW): Lint script runs ~10 sequential check scripts
Root `package.json` `"lint"`: `biome check .` plus eight
`node scripts/check-*.mjs` invocations joined by `&&` — sequential, each paying
node startup + repo scan. They are fast individually, but `&&` chaining means no
parallelism; `pnpm -r --parallel`-style fan-out or one aggregator would cut wall
time. Confirm: `rg -n '"lint"' package.json`.

### OPT-21 (LOW): Slow-test sleeps inflate suite time
Real sleeps (not fakes) on failure/timeout paths:

- `apps/server/src/storage/s3.test.ts:462` — 2100 ms sleep
- `apps/server/src/things/move.test.ts:700` — 400 ms
- `apps/server/src/alerts/alerts.test.ts:189` — 300 ms; `:237,244` — 2× 100 ms
- `apps/server/src/files/pdf-text.test.ts:44` — allocates 16 MB chunks in a loop
  with 5 ms sleeps (memory churn to force a limit path)
- `apps/server/src/main.test.ts:196`, `auth/*` tests — 20–250 ms poll-until-state loops

Each is individually defensible; in aggregate they set a floor under the suite.
Prefer fake timers / direct state injection on the longest two (s3, move).
Confirm: `rg -n "setTimeout\(r, [0-9]{3,}" apps/server/src --glob '*.test.ts'`.

### OPT-22 (INFO): Good hygiene already present — bundle budget enforced
`apps/web/package.json` `"build"` runs `vite build && node scripts/check-bundle.mjs`
against `apps/web/bundle-baseline.json` (`entryGzipBytes: 89730`) — a real
regression gate. `three` (heavy) is legitimately the WebGL map engine
(`apps/web/src/map/engine/engine.ts:23`, render-on-demand per OPT section 1 —
`request()`/`frame` only re-queues while `busy > 0 || tw`, lines 1308-1343).
No action.

---

## 7. Things checked and ruled out

- `cn` package: live (`cn/config` import in `lib/utils.ts`) — not dead.
- Tabler vs Lucide: Lucide is the primary set (native/*, type-icon static map);
  only the 2 Tabler glyphs are questionable (OPT-12), not the Lucide side.
- `DemoWalk` interval (`camera.tsx:198-210`) is demo-mode only, self-stopping.
- `sw.ts:75` timer is a bounded share-hold (`SHARE_HOLD_MS`), released on claim.
- `visual-search/query.ts:148` timer is a bounded `.unref()`d expiry.
- `update-prompt`, sync-engine backoff, liveness heartbeat, pdf-text/render RSS
  watchdogs, webhook `pace()`: all bounded or conditional — documented in OPT-6.
- iOS (`apps/ios` + `apps/web/src/native` + `vite.ios.ts`) is a separate Capacitor
  client sharing the native platform layer — architecture, not duplication.
- No pagination gaps found: list endpoints use cursor pagination with limits
  (fuel, notifications, captures, assistant threads).

---

## Suggested fix backlog (prioritised)

| # | Item | Est. size |
|---|------|-----------|
| 1 | OPT-7: run assistant/embedding jobs outside the idle scoped transaction | M |
| 2 | OPT-1/15: one shared `useImportRunPolling` hook for both import screens | S |
| 3 | OPT-10: `Promise.all` the six independent home-overview queries | S |
| 4 | OPT-2/3: replace local-store poll loops with store subscriptions / visibility-gated refetch | M |
| 5 | OPT-18: `Map` lookup in proposal claim loop; OPT-8: `Promise.all` gate loads | XS |
| 6 | OPT-9: prune empty keys in webhook throttle map | XS |
| 7 | OPT-5: rAF/CSS spin for floors-3d; OPT-4: minute-granularity clock tick | S |
| 8 | OPT-11/12: verify `country-flag-icons`, inline 2 Tabler glyphs | XS |
| 9 | OPT-20/21: parallelise lint checks; de-sleep the two slowest tests | S |

## Verification notes / limits

- Static inspection only: no profiler, no test run, no DB. Frequencies cited are
  constants from source, not measurements.
- OPT-11 needs a dynamic-import-string check before acting (LOW confidence).
- The 5-lane workflow sweep attempted first returned only a skeletal probe
  result; all findings above are from direct inline inspection, each with a
  `rg`/open repro step.
- No code was changed. Nothing was committed.
