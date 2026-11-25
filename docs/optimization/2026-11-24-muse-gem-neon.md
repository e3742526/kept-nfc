# SheepKeep (`kept-nfc`) Optimization Opportunity Audit

- **Report file:** `docs/optimization/2026-11-24-muse-gem-neon.md`
- **Date:** 2026-11-24
- **Repository:** `e3742526/kept-nfc`
- **Branch / Commit:** `main` @ `89b5f65ef7d9cd01654d297228bd170d2cd951c9`
- **Mode:** Read-only optimization audit (**no code modified**)
- **Methodology:** `audit-optimization-opportunities` (`OPT-001`..`OPT-020` coverage taxonomy + `audit-base` evidence discipline and confidence calibration)
- **Surfaces Reviewed:**
  - `apps/server/src` (1,021 files: Fastify 5 API, Drizzle/Postgres, pg-boss worker, CLI, exports/imports, AI/embeddings/visual-search)
  - `apps/web/src` (1,342 files: React 19, TanStack Router/Query, 3D Map/Graph, offline SyncEngine, PWA/SW, Vite bundle config)
  - `apps/ios` (15 Swift source/test files: Capacitor bridge `KeptBridge`, `KeptNFC`, `KeptCaptureAI`, `ChatGPTPlan`, `KeptNativeStore`/`Outbox`)
  - `packages/shared/src` (114 files) and `packages/mcp/src` (7 files)
  - `.github/workflows/*.yml`, `scripts/*`, `Dockerfile`, `compose*.yaml`, `package.json`

---

## 1. Executive Summary

This read-only audit inventoried avoidable work across SheepKeep's runtime server, web client, native iOS layer, shared/MCP packages, and CI/Docker/lint pipelines. Overall, the codebase exhibits strong engineering discipline in several critical areas (RLS/TOCTOU guards, PWA precache budgets, offline `SyncEngine` visibility gating, Docker runtime image stripping, and `together()` bulk-edit fast paths). However, **evidenced, high-leverage waste** exists across six categories:

1. **Unnecessary Polling & Idle Churn:**
   - **Server:** All **44** `pg-boss` queues poll Postgres every `2s` (`~22 queries/s`, `~1.9M queries/day` on a completely idle instance), including daily/weekly/rare queues (`apps/server/src/jobs/boss.ts:227-257`, `policies.ts:26-137`).
   - **Web:** Unbounded `3s` polling leak in Scan Session Summary *after* terminal `'saved'`/`'refused'` states (`apps/web/src/components/scan/session/summary.tsx:105-131`); `20Hz` `setInterval` re-render loop in 3D Graph with no tab-visibility pause (`apps/web/src/graph/floors-3d.tsx:96-107`); `1s` error-state polling loop in `useTurn` (`apps/web/src/api/assistant/queries.ts:78-85`); manual `setInterval` polling bypassing TanStack Query background/offline pause; unconditional IndexedDB polling in Capture/Scan/Inbox.
2. **Database Resource & Query Efficiency:**
   - **12** long-running tenant jobs open an outer `withScope()` Postgres transaction that sits `idle in transaction` for up to **2 hours** (`7260s`) while external HTTP calls or child processes run, doubling `kept_app` pool usage and pinning Postgres's `xmin` horizon (`apps/server/src/jobs/boss.ts:205-220` + 12 `SET LOCAL idle_in_transaction_session_timeout` workarounds).
   - Systematic N+1 query loops: `2N` queries/thing in Insurance Claim Pack (`claim-pack.ts:391-433`), sequential `pg-boss` enqueues in `sendTenantJobs` (`boss.ts:174-186`), up to 50 sequential DB pages (10,000 rows) JS-filtered in Admin AI Calls (`ai/calls.ts:553-582`), `O(N²)` JSONB array rewrites in Monthly AI Summary (`ai/summary.ts:55-93`), `2L` sequential `gateFor()` queries across multi-location views, and per-row queries in `places/service.ts`, `enrich/job.ts`, `labels/service.ts`, `imports/lubelogger.ts`, `purchases/service.ts`, `schedules/services.ts`, and `boxcheck/service.ts`.
   - Uncached external query embeddings on every semantic search (`search/semantic.ts:119-175`).
3. **Poor Algorithms & Rendering Hotspots:**
   - Forced synchronous layout thrashing (interleaved DOM writes + `offsetWidth`/`offsetHeight` reads) + `O(N²)` `childrenOn` scans inside the 60fps 3D Map `requestAnimationFrame` loop (`apps/web/src/map/engine/engine.ts:1420-1509`).
   - `O(N²)` thumbnail dedup and `O(P²)` place lookups in Readable Export (`exports/readable/index.ts:286-305, 488-499`).
   - `O(N³)` overlap scan (`rooms.indexOf` inside nested pair loops) and 6-nested-loop `O(X³·Z³·V)` `largestRect()` in `packages/shared/src/floor-plan.ts:355-378, 443-454`.
   - Redundant subtree traversal and `O(F²)` full-envelope `JSON.stringify` in `packages/mcp/src/output.ts:156-166, 221-239`.
   - Uncached `makeFormatter()` allocating 12 `Intl.*` instances per mounted component across 223 files (`apps/web/src/lib/format.ts:82-200`) + unstable `useSyncExternalStore` subscribing to the entire `QueryCache` on every render (`apps/web/src/lib/units.ts:27-35`).
   - Eager top-level multilingual index construction in `packages/shared/src/map-shapes.ts` (3,943 lines) on every `@kept/shared` import.
4. **iOS Main-Thread Blocking & Redundant Serialization:**
   - `2–5×` synchronous `SecItemCopyMatching` Keychain IPC + `JSONDecoder` calls on `@MainActor` per bridge call (~200 Keychain XPC calls to stage a 25 MB photo in 256 KB chunks; `KeptBridge.swift:126-137, 670-853`).
   - Heavy synchronous file copies (up to 500 MB in `exportHeldCapture`), CoreImage/PDF rendering (`shareLabelSheet`), SHA-256 hashing (`uploadPhotoDisplay`), and 6 MB base64/image decoding (`suggestCaptureName`) executed on `@MainActor`.
   - Double JSON encoding on `Outbox.commit`/`retarget`, full disk+JSON+SQLite `repair()` pass on every cold launch, and N+1 `heldEntries()` (`Outbox.swift:252-520`).
5. **Zombie / Dead Code & Redundant Dependencies:**
   - Entire dead production modules: `apps/server/src/money/convert.ts` (0 prod callers) and `packages/shared/src/device-labels.ts` (0 prod callers).
   - 9 unreferenced exported web query hooks/utilities, 52 unreferenced runtime exports in `packages/shared/src`, and 11 unreferenced exports in `packages/mcp/src`.
   - `@tabler/icons-react` retained in `apps/web/package.json:33` for 2 static icons (`type-icon.tsx:13`), and `@simplewebauthn/browser` eagerly imported into the precached shell via `api/auth.ts:3`.
6. **CI / Build / Docker / Script Redundancy:**
   - `5×–6×` redundant `@kept/server` + `@kept/web` builds and Playwright Chromium downloads across `e2e-shard`, `e2e-update`, and `ha` in `ci.yml` / `ci-local.sh`, plus zero BuildKit layer caching on PR Docker builds.
   - `pnpm lint` executes 9 independent checks sequentially (**21.31s** measured vs ~**9.2s** parallel), followed immediately by `check-i18n-extract.mjs` (**7.01s**) which re-runs Lingui extraction a second time (**16.23s** combined).
   - `Dockerfile` `COPY . .` with an incomplete `.dockerignore` (includes `apps/docs`, `apps/ios`, `charts`, `homeassistant`, `e2e` videos) and `ARG VERSION` placed before `@kept/shared`/`@kept/mcp`/`@kept/server` builds.
   - `scripts/repo-settings.sh:384` required checks list has drifted from `.github/workflows/ci.yml`.

---

## 2. Optimization Objective Table

No single optimization metric was specified by the user; per methodology, this audit uses a multi-metric discovery table and never translates structural proxies into invented runtime speedups.

| Beneficiary | Metric | Workload | Baseline | Immutable Constraint | Success Test |
|---|---|---|---|---|---|
| Self-hoster / Operator | Idle DB QPS, Postgres vacuum health, pool saturation | Idle instance & concurrent long jobs (`export`, `import-*`, `extract`) | **Counted:** 44 `pg-boss` workers @ 2s default (`~22 QPS` idle); 12 jobs pinning `idle in transaction` up to `7260s` | Job delivery SLA, RLS tenant isolation (`withScope`), crash recovery | `pg_stat_statements` idle `pgboss` QPS drops >80%; zero `idle in transaction` connections during long external-I/O jobs |
| End User (Web & iOS) | UI frame smoothness, battery/network churn, main-thread hangs | 3D Map orbit, 3D Graph idle, Scan summary, iOS photo staging/export | **Counted / Structural:** 3s post-saved poll leak; 20Hz unpaused spin; N reflows/frame; 200 Keychain XPC/25MB stage | Offline durability, WCAG/RTL/Arabic formatting, session-switch revocation safety | Zero post-saved network requests; zero background-tab timer ticks; main-thread hitch-free Instruments/DevTools trace |
| Service / Budget Owner | External AI API spend & latency | Repeated/paginated semantic search, assistant follow-ups | **Structural:** 0 query-embedding cache hits; 1+ external `embed_query` per search | Per-payer billing isolation, fresh provider key resolution | Repeated identical semantic query within TTL produces 0 additional `llm_calls` rows |
| Developer / CI Budget | Local lint & PR CI wall-clock time, runner minutes | `pnpm lint`, `ci-local.sh`, GitHub Actions PRs (`ci.yml`, `mvp1-ios.yml`) | **Measured:** `pnpm lint` = `21.31s` + `check-i18n-extract` = `7.01s`; **Counted:** 5–6× Playwright/build repeats | All 9 lint gates, RLS leak tests, E2E/update-migration parity | `pnpm lint` < 10s wall clock; 1 build artifact reused across E2E shards; BuildKit GHA cache active |
| Maintainer | Change surface, dead code, drift risk | Cross-package helpers, exports, watchdogs, CI config | **Counted:** 2 dead modules, 16+ digit-folding copies, 2 drifted RSS watchdogs, drifted `repo-settings.sh` | Zero behavior regression, backward-compatible migrations, public package contracts | All unit/typecheck/lint gates green after dead-code removal and consolidation |

---

## 3. Recurring-Work Map

| Surface | Recurring Work Unit | Trigger / Frequency | Current Mechanism | Primary Consumers |
|---|---|---|---|---|
| Server Worker | `pg-boss` queue polling | Every `2s` × 44 queues (continuous) | `boss.work(job.name, workOptions, ...)` with default `pollingIntervalSeconds` | All background & scheduled jobs |
| Server Worker | Tenant job DB transaction | Per tenant job execution | `runJob()` unconditionally opens `withScope()` tx even for HTTP/CLI-bound jobs | 12 long-running jobs (`export`, `import-*`, `extract`, `embed-thing`, etc.) |
| Server HTTP / Jobs | Bulk DB reads/writes & enqueues | Per bulk save, claim pack, export, import, multi-location view | Per-item SQL loops (`sendTenantJobs`, `entriesOf`, `gateFor`, `makeBlanks`, `applyAnswers`) | Web UI, MCP/Assistant, background workers |
| Server Search | Semantic query embedding | Every semantic search / assistant tool call | Uncached `embeddingsSource` + per-location `keys.resolve` + external `embedValues` | Search bar, Assistant `search_things` / `where_is` |
| Web UI | Polling & cache invalidation | `1s`–`5s` intervals & mutation callbacks | Unterminated `setInterval` in Scan summary, `20Hz` spin in 3D Graph, full-cache `invalidateQueries()` | Active browser tabs (and background tabs) |
| Web UI | Rendering & formatting | 60fps `rAF` (3D Map), list mounts (223 files), cell renders | Interleaved DOM write/read in `placeLabels()`, uncached `Intl.*` in `makeFormatter()`, `.find()` in `sheet-view.tsx` | Mobile & desktop browsers |
| iOS Native | Bridge IPC, Keychain, Outbox I/O | Per JS→Swift bridge call, per 256 KB upload chunk, cold launch | `@MainActor` `SecItemCopyMatching`, sync `FileManager.copyItem`, full `Outbox.repair()` on init | Capacitor WKWebView / iOS main thread |
| Shared / MCP | Startup eval & payload fitting | Process cold start; oversized MCP tool responses | Eager top-level `map-shapes.ts` folding; recursive `largestRemovable` + full `JSON.stringify` loop | Server, Web, CLI, Tests, MCP clients |
| CI / Local Dev | Lint, i18n, builds, Docker, E2E | Every commit / PR / `ci-local.sh` | Sequential 9-step `pnpm lint`, double Lingui extract, 5–6× builds & Playwright installs, uncached Docker | Developers & GitHub Actions runners |

---

## 4. Evidence-Source & Trust-Limit Table

| Evidence Source | Type | Trust Level | Limits / Caveats |
|---|---|---|---|
| Direct file reads across `apps/server`, `apps/web`, `apps/ios`, `packages/*`, `.github/`, `scripts/`, `Dockerfile` | `source-evidenced` | High (exact quoted lines) | Proves deterministic code/config mechanisms; does not prove live production traffic frequency or latency distribution |
| Deterministic `git grep` & file counts | `Counted` | High | Static reachability; dynamic imports/reflection checked explicitly (e.g., `observability/tracing.ts` via `node --import`) |
| Local read-only timing of `pnpm lint` subcommands & `check-i18n-extract.mjs` | `Measured` (local macOS) | Medium-High | Single local developer machine baseline; relative proportions hold, absolute times vary by hardware/CI runner |
| Runtime DB load / Instruments main-thread profiling / Chrome DevTools frame timings | **Not executed** | Unavailable in read-only pass | Runtime impact claims are capped at `Likely` / `Counted` with explicit reproduction harnesses provided |

---

## 5. `OPT-001`..`OPT-020` Coverage Matrix

Every taxonomy code is accounted for below; findings sharing a causal mechanism are cross-referenced rather than duplicated.

| Code | Mechanism | Status | Evidence / Findings |
|---|---|---|---|
| `OPT-001` | Repeated invariant computation | **Finding** | `REL-OPT-004` (`exports/readable/index.ts:286-305, 488-499`), `WFG-OPT-002` (`engine.ts:1420-1509`), `WFG-OPT-003` (`floors-3d.tsx:115-248`), `WFG-OPT-010` (`sheet-view.tsx:185-247`), `ARC-OPT-007` (`floor-plan.ts:355-378, 443-454`), `ARC-OPT-008` (`output.ts:156-166, 221-239`), `WFG-OPT-013` (`KeptNFC.swift:282-331`), `ARC-OPT-015` (`check-i18n.mjs:146-206`, `check-db-scope.mjs:69-114`) |
| `OPT-002` | One-at-a-time fan-out (N+1) | **Finding** | `DAT-OPT-003` (`boss.ts:174-186`), `DAT-OPT-005` (`claim-pack.ts:391-433`), `DAT-OPT-006` (`ai/summary.ts:55-93`), `DAT-OPT-009` (`places/service.ts:899-955`, `enrich/job.ts:211-254`, `labels/service.ts:422-440`, `lubelogger.ts:195-219`, `purchases/service.ts:346-375`, `schedules/services.ts:337-410`, `boxcheck/service.ts:367-381`, `serialize/gates.ts:57-99`), `WFG-OPT-012` (`Outbox.swift:404-406`), `ARC-OPT-016` (`check-attribution.sh:14-20`) |
| `OPT-003` | Full-scope recomputation / invalidation | **Finding** | `WFG-OPT-005` (`units.ts:27-35`), `WFG-OPT-007` (`confirm-card.tsx:812-816`, `lubelogger-import.tsx:140`), `WFG-OPT-012` (`Outbox.swift:468-491`), `ARC-OPT-014` (`Dockerfile:54, 57-61`, `.dockerignore`) |
| `OPT-004` | Avoidable serialization | **Finding** | `ARC-OPT-013` (`package.json:11` sequential 9-step `pnpm lint` = `21.31s` vs ~`9.2s` parallel), `WFG-OPT-011` (`KeptBridge.swift` synchronous `@MainActor` I/O/PDF/SHA256) |
| `OPT-005` | Redundant conversion or copying | **Finding** | `WFG-OPT-004` (`format.ts:82-200`), `WFG-OPT-011` (`KeptBridge.swift:126-137` Keychain `JSONDecoder`), `WFG-OPT-012` (`Outbox.swift:252, 260, 325, 332, 454-466`), `ARC-OPT-009` (`money.ts:227-253`, `language-search.ts:49-73`, `normalize.ts:75-96`, `map-shapes.ts:3274-3869`) |
| `OPT-006` | Over-fetch or over-materialization | **Finding** | `DAT-OPT-007` (`ai/calls.ts:553-582` pulling up to 10,000 rows for JS filtering), `WFG-OPT-012` (`Outbox.swift:454-466` decoding all 64 KB manifests to sum bytes) |
| `OPT-007` | Per-unit setup and teardown | **Finding** | `REL-OPT-002` (`boss.ts:205-220` outer `withScope` tx held idle for 2h), `WFG-OPT-011` (`KeptBridge.swift:1019-1137` fresh `CIContext()` per PDF), `WFG-OPT-013` (`KeptNFC.swift:286` fresh `AVAudioPlayer`), `ARC-OPT-008` (`output.ts:84, 242, 252` per-call `TextEncoder`/`TextDecoder`) |
| `OPT-008` | Missed safe reuse | **Finding** | `REL-OPT-008` (`search/semantic.ts:119-175` uncached query embeddings), `WFG-OPT-004` (uncached `makeFormatter`), `WFG-OPT-011` (uncached `KeptConnection` on `@MainActor`) |
| `OPT-009` | Polling, timer, watcher, schedule churn | **Finding** | `REL-OPT-001` (44 `pg-boss` workers @ 2s idle), `WFG-OPT-001` (`summary.tsx:105-131` post-saved 3s leak), `WFG-OPT-003` (`floors-3d.tsx:105` unpaused 20Hz timer), `WFG-OPT-006` (`assistant/queries.ts:78-85` error-state 1s loop; manual `setInterval` in `stepper.tsx`, `archive-run.tsx`, `log-service-sheet.tsx`; unconditional IDB polling in `capture-screen.tsx`, `session-screen.tsx`, `inbox-list.tsx`), `REL-OPT-010` (`mailin/poll.ts:348-350`, `embeddings/backfill.ts:195-196`), `WFG-OPT-013` (`KeptBridge.swift:314-323`) |
| `OPT-010` | Artifact or storage churn | **Finding** | `WFG-OPT-008` (`api/auth.ts:3` eager `@simplewebauthn/browser` in precached shell; `@tabler/icons-react` for 2 icons), `ARC-OPT-014` (Docker context includes `apps/docs`, `apps/ios`, `e2e` videos; duplicated 14-layer `COPY` block) |
| `OPT-011` | External-call amplification | **Finding** | `REL-OPT-008` (`search/semantic.ts:162` uncached `embed_query`), `REL-OPT-009` (`paperless/routes.ts:794` unbounded `Promise.all` Paperless fetches) |
| `OPT-012` | Resource right-sizing mismatch | **Not Reviewed (requires live telemetry)** | No production CPU/memory/replica utilization telemetry exists in this read-only checkout; routed to Measurement Backlog |
| `OPT-013` | Redundant or poorly ordered build/CI work | **Finding** | `ARC-OPT-011` (5–6× builds + Playwright installs in `ci.yml`/`ci-local.sh`; cold BuildKit builds in `images-amd64`/`ha`; double `step3-update.spec.ts` in local `ci-local.sh`; duplicate `portability`/`backup` Vitest runs), `ARC-OPT-012` (`mvp1-ios.yml` missing `private == false` guard + double `build:ios`), `ARC-OPT-013` (sequential `pnpm lint` + double Lingui extraction) |
| `OPT-014` | Missing safe incremental / selective validation | **Held (partially)** / **Candidate** | `ci.yml` + `scripts/ci-changes.sh` already skip duplicate `main` runs and prose-only heavy jobs (Held). Candidate: `step_compose` unconditionally starts RustFS (`--profile s3`) and Mailpit for all 9 DB/E2E jobs even when unused (`ci-local.sh:181`). |
| `OPT-015` | Repeated manual operator workflow | **Not Applicable / Not Reviewed** | No operator runbook timing logs or support tickets in checkout; `kept admin` CLI already automates backup/seed/recovery-kit. |
| `OPT-016` | Duplicate entry or derivation | **Finding** | `ARC-OPT-017` (`scripts/repo-settings.sh:384` drifted from `ci.yml`), `ARC-OPT-010` (16+ duplicated Eastern Arabic/Persian digit-folding helpers; `legacyCodeOf` vs `storedCodeOf`; `SHORT_CODE` regex), `ARC-OPT-018` (10+ copy-pasted GitHub Actions setup blocks) |
| `OPT-017` | Duplicate implementation of one policy | **Finding** | `REL-OPT-011` (drifted child-process RSS watchdog in `pdf-text.ts:76-172` vs `render.ts:74-149`), `WFG-OPT-009` (`useOnline()` ×3, `declutter()` ×2), `WFG-OPT-013` (duplicated Keychain/base64url helpers in `KeptBridge.swift` vs `ChatGPTPlan.swift`) |
| `OPT-018` | Unjustified abstraction / indirection | **Held** | No severe gratuitous abstraction hotspots surfaced in sampled paths; existing seams (`pools`, `withScope`, `Storage`, `KeptNative`) protect real security/platform boundaries. |
| `OPT-019` | Disproportionate dependency surface | **Finding** | `WFG-OPT-008` (`@tabler/icons-react` 3.48.0 in `apps/web/package.json:33` used for only 2 icons) |
| `OPT-020` | Obsolete or unreachable work (dead/zombie code) | **Finding** | `ARC-OPT-006` (dead modules `apps/server/src/money/convert.ts` and `packages/shared/src/device-labels.ts`; 9 dead web hooks/utilities; 52 unreferenced runtime exports in `packages/shared/src`; 11 unreferenced exports in `packages/mcp/src`; 5 empty template stubs in `AppDelegate.swift:14-34`) |

---

## 6. Prioritized Opportunity Register

Ordered by decision readiness and objective leverage (no synthetic composite score).

| Priority | Finding ID | Surface | Summary | OPT | Evidence State | Disposition | Severity | Confidence | Impl. Cost | Reversibility |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `REL-OPT-001` | Server | 44 `pg-boss` workers polling Postgres every 2s while idle (~22 QPS / ~1.9M queries/day) | OPT-009 | Counted | **Ready** | High | Confirmed | S | Reversible |
| 2 | `REL-OPT-002` | Server | 12 long-running tenant jobs hold Postgres connections `idle in transaction` up to 2h (`7260s`) | OPT-007 | Counted | **Ready** | High | Confirmed | M | Reversible |
| 3 | `WFG-OPT-001` | Web | Unbounded 3s network + IDB polling leak after terminal `'saved'`/`'refused'` state in Scan Summary | OPT-009 | Source-evidenced | **Ready** | High | Confirmed | XS | Reversible |
| 4 | `ARC-OPT-011` | CI/Build | 5–6× redundant server+web builds & Playwright installs + uncached PR Docker builds | OPT-013 | Counted | **Ready** | High | Confirmed | M | Reversible |
| 5 | `ARC-OPT-013` | Dev/CI | Sequential 9-step `pnpm lint` (21.31s) + redundant 2nd Lingui extraction (7.01s) | OPT-004, OPT-013 | Measured | **Ready** | Medium | Confirmed | S | Reversible |
| 6 | `WFG-OPT-002` | Web | Forced synchronous layout thrashing + `O(N²)` scans in 60fps 3D Map `rAF` loop | OPT-001, OPT-005 | Structural | **Ready** | High | Confirmed (code) / Likely (jank) | M | Reversible |
| 7 | `WFG-OPT-011` | iOS | 2–5× sync Keychain XPC + heavy file copy (up to 500 MB)/PDF/SHA256 on `@MainActor` | OPT-004, OPT-005 | Counted | **Ready** | High | Confirmed (code) / Likely (hang) | M | Reversible |
| 8 | `WFG-OPT-003` | Web | Unpaused 20Hz `setInterval` full-component re-render loop in 3D Graph | OPT-009, OPT-001 | Source-evidenced | **Ready** | Medium | Confirmed | S | Reversible |
| 9 | `WFG-OPT-004` | Web | Uncached `makeFormatter()` (12 `Intl.*`/mount across 223 files) + 3× `formatToParts` + unmemoized `useBytes()` | OPT-005, OPT-008 | Counted | **Ready** | Medium | Confirmed | XS | Reversible |
| 10 | `DAT-OPT-003` | Server | Sequential one-at-a-time `pg-boss` enqueues in `sendTenantJobs` & `queueWebhookFanout` | OPT-002 | Counted | **Ready** | Medium | Confirmed | S | Reversible |
| 11 | `DAT-OPT-005` | Server | `2N` SQL queries/thing in Insurance Claim Pack assembly (`entriesOf`) | OPT-002 | Counted | **Ready** | Medium | Confirmed | S | Reversible |
| 12 | `REL-OPT-004` | Server | `O(N²)` thumbnail dedup & `O(P²)` place lookup in Readable Export | OPT-001 | Structural | **Ready** | Medium | Confirmed | XS | Reversible |
| 13 | `DAT-OPT-006` | Server | `O(N²)` JSONB array rewrite + N+1 transactions in Monthly AI Summary | OPT-001, OPT-002 | Counted | **Ready** | Medium | Confirmed | M | Reversible |
| 14 | `DAT-OPT-007` | Server | Up to 50 sequential DB pages (10,000 rows) JS-filtered in Admin AI Calls | OPT-006 | Counted | **Ready** | Medium | Confirmed | S | Reversible |
| 15 | `REL-OPT-008` | Server | Uncached query embeddings + per-location provider resolution on every semantic search | OPT-008, OPT-011 | Structural | **Measure** | Medium | Confirmed (code) / Plausible (hit rate) | S | Reversible |
| 16 | `WFG-OPT-005` | Web | Unstable `useSyncExternalStore` subscribing to entire `QueryCache` on every render (`units.ts`) | OPT-003 | Source-evidenced | **Ready** | Medium | Confirmed | XS | Reversible |
| 17 | `WFG-OPT-006` | Web | Error-state 1s polling loop in `useTurn`; manual `setInterval` & unconditional IDB polling | OPT-009 | Source-evidenced | **Ready** | Medium | Confirmed | S | Reversible |
| 18 | `WFG-OPT-007` | Web | Full-cache `qc.invalidateQueries()` storms in Assistant ConfirmCard & LubeLogger import | OPT-003 | Source-evidenced | **Ready** | Medium | Confirmed | S | Reversible |
| 19 | `WFG-OPT-012` | iOS | Double JSON encode on `Outbox.commit`/`retarget`, full cold-launch `repair()`, N+1 `heldEntries()` | OPT-002, OPT-003, OPT-005 | Counted | **Ready** | Medium | Confirmed | S | Reversible |
| 20 | `ARC-OPT-014` | Docker | Incomplete `.dockerignore` + `ARG VERSION` placed before server/shared builds | OPT-003, OPT-010 | Source-evidenced | **Ready** | Medium | Confirmed | XS | Reversible |
| 21 | `ARC-OPT-012` | CI | `mvp1-ios.yml` lacks `private == false` guard (10× macOS billing) + double `build:ios` | OPT-013 | Source-evidenced | **Ready** | Medium | Confirmed | XS | Reversible |
| 22 | `ARC-OPT-017` | Ops/CI | `scripts/repo-settings.sh:384` required checks drifted from `ci.yml` | OPT-016 | Source-evidenced | **Ready** | Medium | Confirmed | XS | Reversible |
| 23 | `DAT-OPT-009` | Server | Additional N+1 loops (`places/service`, `enrich/job`, `labels`, `lubelogger`, `purchases`, `schedules`, `boxcheck`, `serialize/gates`) | OPT-002 | Counted | **Ready** | Medium | Confirmed | M | Reversible |
| 24 | `ARC-OPT-006` | All | Dead modules (`money/convert.ts`, `device-labels.ts`) & unused exports across web/shared/mcp | OPT-020 | Counted | **Route** (`audit-deadcode-cleanup`) | Low | Confirmed | S | Reversible |
| 25 | `ARC-OPT-007` | Shared | `O(N³)` overlap scan & 6-nested-loop `largestRect()` in `floor-plan.ts` | OPT-001 | Structural | **Ready** | Low-Med | Confirmed | S | Reversible |
| 26 | `ARC-OPT-008` | MCP | Redundant subtree recursion & `O(F²)` full-envelope serialization in `output.ts` | OPT-001, OPT-005 | Structural | **Ready** | Low-Med | Confirmed | XS | Reversible |
| 27 | `ARC-OPT-009` | Shared | Eager `map-shapes.ts` init on every `@kept/shared` import + uncached `Intl` in `money.ts`/`language-search.ts` + double `normalize()` | OPT-005 | Counted | **Measure** | Low-Med | Confirmed | S | Reversible |
| 28 | `WFG-OPT-008` | Web | Eager `@simplewebauthn/browser` in shell + `@tabler/icons-react` retained for 2 icons | OPT-010, OPT-019 | Counted | **Ready** | Low | Confirmed | XS | Reversible |
| 29 | `REL-OPT-011` | Server | Drifted duplicate child-process RSS watchdog (`pdf-text.ts` vs `render.ts`) | OPT-017 | Source-evidenced | **Ready** | Medium | Confirmed | XS | Reversible |
| 30 | `ARC-OPT-010` | All | 16+ duplicated digit-folding helpers, `legacyCodeOf` vs `storedCodeOf`, `SHORT_CODE` regex | OPT-016 | Counted | **Route** (`audit-invariant-sync`) | Low | Confirmed | S | Reversible |

---

## 7. Detailed Material Findings (Reproducible)

### REL-OPT-001: 44 Independent `pg-boss` Workers Poll Postgres Every 2 Seconds When Idle

- **Severity:** High
- **Confidence:** Confirmed
- **Evidence basis:** `source-evidenced`
- **Domain:** Reliability (Taxonomy: `OPT-009`)
- **Evidence:**
  - `apps/server/src/jobs/boss.ts:227-257` (`registerJobs`)
  - `apps/server/src/jobs/policies.ts:26-137` (`JOB_POLICIES` — 44 queues)
- **Observed behavior:** `registerJobs()` iterates over all 44 queues and calls `boss.work(job.name, workOptions, ...)` without passing a per-queue `pollingIntervalSeconds`. In production (`opts.pollingIntervalSeconds === undefined`), `pg-boss` defaults to `2s` per worker—including weekly (`backup-verify`), daily (`backup`, `audit-partitions`, `prune-stale-rows`, `ai-maintenance`, `ai-rollover`, `assistant-maintenance`, `purge`, `prune-imports`, `update-check`), hourly (`repair-orphans`, `purge-reports`, `report-schedules`, `purge-exports`, `embed-backfill`, `ops-watch`), and rare admin/import queues (`transparency-notice`, `import-homebox`, `import-kept`, `import-csv`, `claim-pack`).
- **Expected boundary:** Low-frequency/scheduled/batch queues should poll at a much lower cadence (e.g., 30–60s) or share a maintenance dispatcher queue, reserving 2s polling for interactive user-facing queues (`assistant-turn`, `extract`, `embed-thing`, `visual-index`, `webhook-deliver`).
- **Failure mechanism:** 44 independent timers issue `FOR UPDATE SKIP LOCKED` fetches every 2s = **~22 queries/s (~1.9M queries/day)** on an idle self-hosted Raspberry Pi / NAS / VPS, preventing disks/CPU from idling and creating constant `pg_stat_statements` noise.
- **Break-it angle:** Multi-worker deployments multiply idle QPS linearly (`22 × W` QPS) and increase lock contention on `pgboss.job_common`.
- **Reproducibility to confirm:**
  1. Static count: `node -e "import('./apps/server/src/jobs/policies.ts').then(m => console.log(Object.keys(m.JOB_POLICIES).length))"` (or count keys in `apps/server/src/jobs/policies.ts:26-137` -> `44`) and inspect `apps/server/src/jobs/boss.ts:242-248`.
  2. Runtime confirmation: Start `kept` with zero user traffic and sample `pg_stat_activity` / `pg_stat_statements` on `pgboss` over 60 seconds; expect ~1,320 fetch queries/minute.
- **Operational impact:** Blast radius: Service | Side-effect class: DB | Reversibility: reversible | Operator visibility: silent | Rerun safety: safe
- **Recommended mitigation:** Add an optional `pollingIntervalSeconds` field to `JobPolicy` (e.g., `2` for interactive queues, `15–60` for batch/hourly/daily/weekly queues) and forward it in `registerJobs()`.
- **Implementation assessment:** Complexity: `local_guardrail` | Cost: `S` | Cost drivers: modules, tests | Nominal agent: `other-agent` (server TS + Vitest)
- **Validation:** Unit test asserting `boss.work` receives the policy's `pollingIntervalSeconds`; 60s idle `pg_stat_statements` delta check.
- **Non-goals:** Changing `pg-boss` itself or altering retry/backoff policies.

---

### REL-OPT-002: 12 Long-Running Tenant Jobs Pin Postgres Connections `idle in transaction` for Up To 2 Hours

- **Severity:** High
- **Confidence:** Confirmed
- **Evidence basis:** `source-evidenced`
- **Domain:** Reliability (Taxonomy: `OPT-007`)
- **Evidence:**
  - `apps/server/src/jobs/boss.ts:205-220` (`runJob`)
  - 12 handlers executing `SET LOCAL idle_in_transaction_session_timeout`:
    - `apps/server/src/exports/job.ts:629` (`7200s`)
    - `apps/server/src/imports/homebox/job.ts:380` (`7260s`)
    - `apps/server/src/imports/job.ts:408` (`7260s`)
    - `apps/server/src/imports/kept/job.ts:617` (`7260s`)
    - `apps/server/src/incidents/jobs.ts:46` (`1800s`)
    - `apps/server/src/assistant/turn-job.ts:56` (`210s`)
    - `apps/server/src/enrich/job.ts:442` (`180s`)
    - `apps/server/src/extraction/job.ts:795` (`180s`)
    - `apps/server/src/reports/jobs.ts:33` (`180s`)
    - `apps/server/src/embeddings/job.ts:205` (`100s`)
    - `apps/server/src/visual-search/job.ts:105` (`100s`)
    - `apps/server/src/files/pdf-text.ts:371` (`90s`)
- **Observed behavior:** `runJob()` unconditionally wraps every `kind: 'tenant'` job in `withScope(pools.app, scope, ...)`, opening a `BEGIN` transaction on `kept_app`. All 12 handlers perform long external I/O (LLM/embedding APIs, Typst/PDF child processes, multi-hour archive imports/exports) using *separate* short `withScope()` calls, leaving the outer transaction open and completely idle—necessitating 12 explicit `SET LOCAL idle_in_transaction_session_timeout` overrides up to `7260s`.
- **Expected boundary:** Long-running/external-I/O tenant jobs should receive `{ data, scope, job }` without an outer open Postgres transaction, opening short `withScope()` transactions only for actual DB reads/writes.
- **Failure mechanism:** Each active job holds 2 `kept_app` pool connections simultaneously and pins Postgres's global `xmin` horizon for up to 2 hours, blocking `VACUUM` from reclaiming dead tuples across the entire database during large imports/exports.
- **Reproducibility to confirm:**
  1. Static: `git grep -n "idle_in_transaction_session_timeout" apps/server/src` (returns all 12 handlers).
  2. Runtime: Trigger an `export`, `import-csv`, or `extract` job and query `SELECT state, now() - xact_start FROM pg_stat_activity WHERE state = 'idle in transaction';`.
- **Operational impact:** Blast radius: Service | Side-effect class: DB | Reversibility: reversible | Operator visibility: silent | Rerun safety: safe
- **Recommended mitigation:** Add `transactional: false` (or `kind: 'tenant-unmanaged'`) to `JobDefinition` so `runJob()` validates `tenantPayload(data)` and passes `{ data, scope, job }` without calling `withScope()`. Remove all 12 `SET LOCAL idle_in_transaction_session_timeout` overrides.
- **Implementation assessment:** Complexity: `workflow_protocol` | Cost: `M` | Cost drivers: modules, tests | Nominal agent: `other-agent` (server TS + Postgres Vitest)
- **Validation:** Server job tests verify RLS scope is still enforced inside each handler's short `withScope()` calls and zero outer idle transactions exist during execution.
- **Non-goals:** Changing short transactional tenant jobs that legitimately rely on atomic commit/rollback.

---

### WFG-OPT-001: Unbounded 3-Second Network & IndexedDB Polling Leak After Terminal State in Scan Session Summary

- **Severity:** High
- **Confidence:** Confirmed
- **Evidence basis:** `source-evidenced`
- **Domain:** Workflow-GUI (Taxonomy: `OPT-009`)
- **Evidence:** `apps/web/src/components/scan/session/summary.tsx:104-131` (`useEffect` / `check` / `setInterval`)
- **Observed behavior:** `setInterval(() => void check(), 3000)` is started when `phase === 'saved' && session.saving && store`. When `check()` observes `dropped` (`setStatus({ state: 'refused', ... })`) or completes the save (`setStatus({ state: 'saved', view })`), it **never calls `clearInterval(timer)`**.
- **Expected boundary:** Polling must terminate immediately once the session reaches a terminal state (`'saved'` or `'refused'`) and pause when `document.hidden`.
- **Failure mechanism:** For as long as the user leaves the Scan Session Summary screen open (including backgrounded on a phone), the browser reads IndexedDB (`store.pending()`, `store.notices()`) and issues a live `GET /api/v1/scan-sessions/:id` HTTP request every 3 seconds indefinitely.
- **Reproducibility to confirm:**
  1. Open Scan Session in the web app (`pnpm --filter @kept/web dev` or live server), complete a scan session so `phase === 'saved'`.
  2. Open DevTools → Network tab. Observe `GET /scan-sessions/:id` continuing to fire every 3.0s even after the UI displays the saved summary.
- **Operational impact:** Blast radius: Local / Service | Side-effect class: network | Reversibility: reversible | Operator visibility: silent | Rerun safety: safe
- **Recommended mitigation:** Call `clearInterval(timer)` inside `check()` on both terminal branches (`dropped` and `state: 'saved'`), and guard `check()` on `!document.hidden`.
- **Implementation assessment:** Complexity: `local_guardrail` | Cost: `XS` | Cost drivers: modules, tests | Nominal agent: `other-agent`
- **Validation:** Vitest component test with fake timers asserting `captureApi.scanSession` is called once after pending clears and zero times across subsequent `vi.advanceTimersByTime(15_000)`.
- **Non-goals:** Rewriting the scan session offline queue.

---

### WFG-OPT-002: Forced Synchronous Layout Thrashing & `O(N²)` Scans Inside 60fps 3D Map `rAF` Loop

- **Severity:** High (Medium on small rooms, High on populated multi-room plans / mobile Safari)
- **Confidence:** Confirmed (code mechanism) / Likely (visible frame drops on mobile)
- **Evidence basis:** `source-evidenced`
- **Domain:** Workflow-GUI (Taxonomy: `OPT-001`, `OPT-005`)
- **Evidence:** `apps/web/src/map/engine/engine.ts:1420-1509` (`placeLabels`, `obstacles`) and `apps/web/src/map/layout.ts:442` (`childrenOn`)
- **Observed behavior:**
  1. `placeLabels()` runs on every `requestAnimationFrame` while orbiting/panning/zooming/tweening.
  2. Inside `want.map(...)` (`engine.ts:1458-1484`), each iteration writes DOM (`el.className`, `el.innerHTML`, `el.hidden = false`, `el.style.transform`) and immediately reads `el.offsetWidth` and `el.offsetHeight` (`lines 1472-1473`), triggering **N forced synchronous layout reflows per frame**.
  3. Line 1488 calls `this.obstacles()` (`lines 1500-1509`), executing `this.stage.querySelectorAll('[data-map-obstacle]')` and `getBoundingClientRect()` on every frame.
  4. Lines 1421-1431 iterate `this.plan.items` and call `this.itemLevel(it)` (linear `.find` over `rooms`), `this.unseen(it)` (linear `groundOf`), and `childrenOn(this.plan.items, it.id)` (full array filter → **O(N²) per frame**).
- **Expected boundary:** DOM writes and reads must be separated into distinct passes (or label dimensions cached per `_html` string), obstacle rects cached via `ResizeObserver`, and room/item/child lookups indexed in `Map`s when `setPlan()` runs.
- **Reproducibility to confirm:** Open a location with 30+ mapped items in the 3D Map view, start Chrome DevTools Performance recording, and orbit/zoom for 3 seconds; observe purple "Recalculate Style / Forced reflow" warnings inside `placeLabels` on every animation frame.
- **Operational impact:** Blast radius: Local | Side-effect class: user-visible | Reversibility: reversible | Operator visibility: UI-visible | Rerun safety: safe
- **Recommended mitigation:** Cache `{ w, h }` on each pooled label element whenever `el._html` changes (re-measuring only dirty labels in a single read pass before setting `transform`), cache `obstacles()` on resize/overlay mutation, and pre-index `roomsById` and `childrenByHostId` in `setPlan()`.
- **Implementation assessment:** Complexity: `local_guardrail` | Cost: `M` | Cost drivers: modules, runtime_verification | Nominal agent: `other-agent`
- **Validation:** Chrome Performance trace confirming zero forced reflows during steady-state orbit and O(N) `placeLabels` work.
- **Non-goals:** Changing Three.js rendering architecture or label declutter rules.

---

### WFG-OPT-003: Unpaused 20Hz `setInterval` Full-Component Re-Render Loop in 3D Graph

- **Severity:** Medium
- **Confidence:** Confirmed
- **Evidence basis:** `source-evidenced`
- **Domain:** Workflow-GUI (Taxonomy: `OPT-009`, `OPT-001`)
- **Evidence:** `apps/web/src/graph/floors-3d.tsx:96-107`, `115-248` (`Floors3D`)
- **Observed behavior:** `spinning` defaults to `!reduced` (`line 96`), running `setInterval(() => setYaw((y) => y + SPIN * 0.05), 50)` (`line 105`) with no `document.visibilityState` listener. Every 50ms tick re-renders the entire component and recomputes unmemoized `shownIds`, `focusSet`, `edges`, `floorIndex`, `boxes`, `obstacles`, and `O(N²)` `declutter(boxes, ...)` (`line 229`).
- **Expected boundary:** Animation should pause when the tab is hidden (`visibilitychange`), and topology-derived structures (`shownIds`, `focusSet`, `edges`, `floorIndex`) should be memoized independently of `yaw`.
- **Reproducibility to confirm:** Open the 3D Graph screen, switch to another browser tab, and inspect Chrome Task Manager / DevTools Performance—the background tab continues executing 20 React renders/second.
- **Operational impact:** Blast radius: Local | Side-effect class: user-visible | Reversibility: reversible | Operator visibility: silent | Rerun safety: safe
- **Recommended mitigation:** Gate the spin loop on `document.visibilityState === 'visible'` (preferring `requestAnimationFrame`, which automatically pauses in background tabs) and wrap `shownIds`, `focusSet`, `edges`, and `floorIndex` in `useMemo`.
- **Implementation assessment:** Complexity: `local_guardrail` | Cost: `S` | Cost drivers: modules, tests | Nominal agent: `other-agent`
- **Validation:** Component test verifying `setYaw` stops firing when `document.visibilityState` becomes `'hidden'`.
- **Non-goals:** Removing auto-spin when visible and `prefers-reduced-motion` is off.

---

### WFG-OPT-004: Uncached `makeFormatter()` Allocating 12 `Intl.*` Instances Per Mount Across 223 Files + 3× `formatToParts`

- **Severity:** Medium
- **Confidence:** Confirmed
- **Evidence basis:** `source-evidenced`
- **Domain:** Workflow-GUI (Taxonomy: `OPT-005`, `OPT-008`)
- **Evidence:** `apps/web/src/lib/format.ts:82-90` (`isoDate`), `92-174` (`makeFormatter`), `177-200` (`useBytes`, `useFormat`); `git grep -l "useFormat(" apps/web/src | wc -l` = **223 files** (including per-row components like `agenda-row.tsx:101` and `ai-history-row.tsx:15`).
- **Observed behavior:**
  1. `useFormat()` memoizes `makeFormatter(...)` per component instance (`lines 194-200`), with no module-level cache keyed by `${tag}|${dateFormat}`. Mounting 50 list rows constructs `50 × 12 = 600` `Intl.DateTimeFormat`/`Intl.NumberFormat`/`Intl.RelativeTimeFormat` instances.
  2. `isoDate()` (`lines 84-88`) calls `f.formatToParts(d)` **3 separate times** per date (once each for `year`, `month`, `day`).
  3. `useBytes()` (`lines 177-192`) constructs a brand-new `new Intl.NumberFormat(...)` on **every invocation**.
- **Expected boundary:** `makeFormatter(tag, dateFormat)` and `useBytes` formatters should be cached in a bounded module-level `Map` (keyed by locale tag + preference), and `isoDate` should call `formatToParts(d)` once.
- **Reproducibility to confirm:** `git grep -l "useFormat(" apps/web/src | wc -l` -> `223`; read `apps/web/src/lib/format.ts:82-200`.
- **Operational impact:** Blast radius: Local | Side-effect class: none | Reversibility: reversible | Operator visibility: silent | Rerun safety: safe
- **Recommended mitigation:** Add a bounded module-level `Map<string, Formatter>` (e.g., max 16 entries) inside `makeFormatter`, cache byte/kilobyte `Intl.NumberFormat` instances per tag, and destructure `f.formatToParts(d)` in one pass in `isoDate()`.
- **Implementation assessment:** Complexity: `local_guardrail` | Cost: `XS` | Cost drivers: modules, tests | Nominal agent: `other-agent`
- **Validation:** Unit test asserting `makeFormatter('en', 'auto') === makeFormatter('en', 'auto')` and existing i18n/Arabic Eastern-digit formatting tests stay green.
- **Non-goals:** Changing any formatted output strings.

---

### WFG-OPT-005: Unstable `useSyncExternalStore` Subscribing to the Entire `QueryCache` on Every Render

- **Severity:** Medium
- **Confidence:** Confirmed
- **Evidence basis:** `source-evidenced`
- **Domain:** Workflow-GUI (Taxonomy: `OPT-003`)
- **Evidence:** `apps/web/src/lib/units.ts:27-35` (`useUnitSystem`, also called by `useLengths` at `42-54`)
- **Observed behavior:**
  ```ts
  return useSyncExternalStore(
    client ? (onChange) => client.getQueryCache().subscribe(onChange) : noSubscription,
    read,
    read,
  );
  ```
  The inline subscribe closure is recreated on every render, causing React to unsubscribe and re-subscribe on every render of every consumer; and the callback fires for **every** `QueryCache` event app-wide instead of filtering for `keys.me`.
- **Expected boundary:** `subscribe` must have stable identity (`useCallback` on `client`) and only invoke `onChange` when `event.query.queryKey[0] === keys.me[0]`.
- **Reproducibility to confirm:** Read `apps/web/src/lib/units.ts:27-35`; spy on `queryClient.getQueryCache().subscribe` during re-renders of any component calling `useLengths()` or `useUnitSystem()`.
- **Operational impact:** Blast radius: Local | Side-effect class: none | Reversibility: reversible | Operator visibility: silent | Rerun safety: safe
- **Recommended mitigation:** Memoize `subscribe` with `useCallback` and filter `QueryCache` notifications to `keys.me`.
- **Implementation assessment:** Complexity: `local_guardrail` | Cost: `XS` | Cost drivers: modules, tests | Nominal agent: `other-agent`
- **Validation:** Unit test verifying `subscribe` is called once per mount (not on re-renders) and unrelated query updates do not trigger `read()`.
- **Non-goals:** Changing how `profile.units` is fetched.

---

### WFG-OPT-006: Error-State 1s Polling Loop (`useTurn`), Manual `setInterval` Polling, and Unconditional IndexedDB Polling

- **Severity:** Medium
- **Confidence:** Confirmed
- **Evidence basis:** `source-evidenced`
- **Domain:** Workflow-GUI (Taxonomy: `OPT-009`)
- **Evidence:**
  - `apps/web/src/api/assistant/queries.ts:78-85` (`useTurn`): `refetchInterval: (query) => query.state.data && !isLiveTurn(query.state.data.status) ? false : TURN_POLL_MS` — when `query.state.status === 'error'` and `data` is `undefined`, it polls every `1000ms` forever even on 403/404.
  - Manual `setInterval(() => void query.refetch(), ...)` bypassing TanStack Query's `refetchIntervalInBackground: false` and offline pause: `apps/web/src/components/import/stepper.tsx:377, 394-399`, `apps/web/src/components/import/archive-run.tsx:117-122`, `apps/web/src/components/services/log-service-sheet.tsx:308-313`.
  - Unconditional IndexedDB polling without idle/visibility stop: `apps/web/src/components/capture/capture-screen.tsx:502-510` (2s) & `:1343-1355` (2s `new Set(...)` re-render even when `waiting === 0`), `apps/web/src/components/scan/session/session-screen.tsx:201-205` (3s full locations+places IDB read), `apps/web/src/components/inbox/inbox-list.tsx:772-778` (5s even when empty).
- **Reproducibility to confirm:** Return HTTP 404 for `/api/v1/assistant/turns/:id` and observe `useTurn` retrying every 1s indefinitely in Network tab; mount `CaptureSummaryWrapper` with 0 pending items and observe state updates every 2s.
- **Operational impact:** Blast radius: Local / Service | Side-effect class: network | Reversibility: reversible | Operator visibility: silent | Rerun safety: safe
- **Recommended mitigation:** Return `false` in `useTurn` when `query.state.status === 'error'`; replace manual `setInterval` with TanStack Query's `refetchInterval` (already supported by `useImportRun` at `api/capture/queries.ts:409-415`); subscribe Capture/Scan/Inbox to `offline.engine.subscribe` instead of blind IDB timers.
- **Implementation assessment:** Complexity: `local_guardrail` | Cost: `S` | Cost drivers: modules, tests | Nominal agent: `other-agent`
- **Validation:** Vitest fake-timer tests for error-state stop and background-tab pause.
- **Non-goals:** Changing `SyncEngine`'s own backoff schedule (which already pauses when hidden).

---

### WFG-OPT-007: Full-Cache `qc.invalidateQueries()` Storms in Assistant ConfirmCard & LubeLogger Import

- **Severity:** Medium
- **Confidence:** Confirmed
- **Evidence basis:** `source-evidenced`
- **Domain:** Workflow-GUI (Taxonomy: `OPT-003`)
- **Evidence:**
  - `apps/web/src/assistant/confirm-card.tsx:812-816`: invalidates `assistantKeys.all` **and** `predicate: (q) => q.queryKey[0] !== 'assistant'` — literally 100% of the TanStack Query cache (including `me`, `currencies`, `settings`, `admin`, `sessions`, `hints`).
  - `apps/web/src/components/vehicles/lubelogger-import.tsx:140`: `await qc.invalidateQueries()` after importing fuel/service rows for one vehicle.
  - Also `import/repair.tsx:66`, `connections/recent-changes.tsx:139`, `history/undo.ts:136`.
- **Reproducibility to confirm:** Confirm any assistant proposal card or complete a LubeLogger import with DevTools Network open; observe simultaneous refetches of static/session/unrelated queries.
- **Operational impact:** Blast radius: Local / Service | Side-effect class: network | Reversibility: reversible | Operator visibility: silent | Rerun safety: safe
- **Recommended mitigation:** Scope invalidation to affected domain query keys (e.g., `inventoryKeys`, `vehiclesKeys`, `householdKeys`).
- **Implementation assessment:** Complexity: `local_guardrail` | Cost: `S` | Cost drivers: modules, tests | Nominal agent: `other-agent`
- **Validation:** Assert `keys.me` / `currencies` / `admin` are not refetched on a vehicle import or thing-move proposal confirmation.
- **Non-goals:** Weakening freshness of affected inventory/vehicle views.

---

### DAT-OPT-003: Sequential One-at-a-Time `pg-boss` Enqueues Inside Bulk Write Transactions

- **Severity:** Medium
- **Confidence:** Confirmed
- **Evidence basis:** `source-evidenced`
- **Domain:** Data-Integrity / Performance (Taxonomy: `OPT-002`)
- **Evidence:** `apps/server/src/jobs/boss.ts:174-186` (`sendTenantJobs`), called by `apps/server/src/embeddings/job.ts:84-106` (`enqueueEmbeds`); also `apps/server/src/webhooks/fanout.ts:151-153` (`queueWebhookFanout`).
- **Observed behavior:** `sendTenantJobs()` reads `tenantScopeOf(client)` once, then loops `for (const job of jobs) { await sendInTx(boss, client, name, payload, ...); }`. Saving 200 rows in the spreadsheet executes **200 sequential `INSERT INTO pgboss.job_common` round-trips** while holding the HTTP write transaction open.
- **Reproducibility to confirm:** Save 200 rows via `POST /api/v1/things/bulk-edit` with SQL query logging enabled; count `INSERT INTO pgboss.job_common` statements (200 instead of 1).
- **Operational impact:** Blast radius: Workflow | Side-effect class: DB | Reversibility: reversible | Operator visibility: silent | Rerun safety: safe
- **Recommended mitigation:** Use `boss.insert(name, rows, { db })` for a single multi-row `INSERT` per queue inside the same transaction (falling back only if per-job options require `send`).
- **Implementation assessment:** Complexity: `local_guardrail` | Cost: `S` | Cost drivers: modules, tests | Nominal agent: `other-agent`
- **Validation:** Existing bulk-edit and `sendTenantJobs` tests plus a query-count assertion (1 `pgboss` insert for N jobs).
- **Non-goals:** Changing transactional outbox semantics (jobs must still commit atomically with the tenant write).

---

### DAT-OPT-005: `2N` Sequential SQL Queries Per Thing in Insurance Claim Pack Assembly

- **Severity:** Medium
- **Confidence:** Confirmed
- **Evidence basis:** `source-evidenced`
- **Domain:** Data-Integrity / Performance (Taxonomy: `OPT-002`)
- **Evidence:** `apps/server/src/incidents/claim-pack.ts:391-433` (`entriesOf`)
- **Observed behavior:** Inside `for (const t of things)`, executes 2 sequential SQL queries per thing: (1) `kept.thing_receipts($1) CROSS JOIN LATERAL kept.thing_receipt_file($1, r.file_id) UNION ... attachments` (`lines 395-410`) and (2) `attachments JOIN file_derivatives` for display photos (`lines 419-425`). A 500-item claim executes **1,000 sequential SQL queries**.
- **Reproducibility to confirm:** Inspect `apps/server/src/incidents/claim-pack.ts:391-433`; run claim-pack generation on a 100-thing incident with query counting enabled.
- **Operational impact:** Blast radius: Workflow | Side-effect class: DB | Reversibility: reversible | Operator visibility: silent | Rerun safety: safe
- **Recommended mitigation:** Batch both queries across `things.map(t => t.id)` with `unnest($1::uuid[])` / `ANY($1::uuid[])` and group into `Map<string, ...>` (2 queries total instead of `2N`).
- **Implementation assessment:** Complexity: `local_guardrail` | Cost: `S` | Cost drivers: modules, tests | Nominal agent: `other-agent`
- **Validation:** Existing claim-pack tests assert identical archive contents and ordering; query count stays constant at O(1) regardless of item count.
- **Non-goals:** Changing claim-pack ZIP structure or receipt redaction rules.

---

### REL-OPT-004: `O(N²)` Thumbnail Dedup & `O(P²)` Place Lookup in Readable Export

- **Severity:** Medium
- **Confidence:** Confirmed
- **Evidence basis:** `source-evidenced`
- **Domain:** Reliability / Performance (Taxonomy: `OPT-001`)
- **Evidence:** `apps/server/src/exports/readable/index.ts:286-305` (line 302: `!thumbJobs.some((j) => j.fileId === photo.file_id)`) and `488-499` (line 490: `read.places.find((r) => r.id === p.id)`).
- **Observed behavior:** `read.things` contains all things in the location (unbounded by `MAX_THINGS`). Checking `!thumbJobs.some(...)` inside the thing loop is `O(N²)` (~50M comparisons for 10,000 photographed things), and `read.places.find(...)` inside `for (const p of places)` is `O(P²)`.
- **Reproducibility to confirm:** Read `apps/server/src/exports/readable/index.ts:286-305, 488-499`.
- **Operational impact:** Blast radius: Workflow | Side-effect class: none | Reversibility: reversible | Operator visibility: silent | Rerun safety: safe
- **Recommended mitigation:** Track seen thumbnail IDs in a `Set<string>` and index `read.places` in a `Map<string, ...>`.
- **Implementation assessment:** Complexity: `local_guardrail` | Cost: `XS` | Cost drivers: modules | Nominal agent: `other-agent`
- **Validation:** Existing readable export tests produce byte-identical HTML/manifest output.
- **Non-goals:** Changing readable export layout.

---

### DAT-OPT-006: `O(N²)` JSONB Array Rewrite + N+1 Transactions in Monthly AI Summary

- **Severity:** Medium
- **Confidence:** Confirmed
- **Evidence basis:** `source-evidenced`
- **Domain:** Data-Integrity (Taxonomy: `OPT-001`, `OPT-002`)
- **Evidence:** `apps/server/src/ai/summary.ts:54-66` (`claim`), `80-93` (`runAiSummary`)
- **Observed behavior:** Loops `for (const r of rows)` opening a separate `withSystem()` transaction per user; inside each, `claim()` locks the single `instance_settings` row (`FOR UPDATE`), appends one `userId` to `v.users`, and rewrites the entire JSONB array (`JSON.stringify({ month, users: [...users, userId] })`).
- **Reproducibility to confirm:** Read `apps/server/src/ai/summary.ts:54-93`.
- **Operational impact:** Blast radius: Workflow | Side-effect class: DB | Reversibility: reversible | Operator visibility: silent | Rerun safety: safe
- **Recommended mitigation:** Batch-claim all unclaimed users for the month in one transaction (or track per-user claims in a dedicated `(month, user_id)` table) while keeping idempotency intact before sending emails.
- **Implementation assessment:** Complexity: `persistence_recovery` | Cost: `M` | Cost drivers: modules, tests, migrations (if table) | Nominal agent: `other-agent`
- **Validation:** Unit test verifying duplicate `runAiSummary` runs still send each user at most once with O(1) settings writes.
- **Non-goals:** Changing summary email content or notification preferences.

---

### DAT-OPT-007: Up To 50 Sequential DB Pages (10,000 Rows) Filtered in JS on Admin AI Calls

- **Severity:** Medium
- **Confidence:** Confirmed
- **Evidence basis:** `source-evidenced`
- **Domain:** Data-Integrity / Performance (Taxonomy: `OPT-006`)
- **Evidence:** `apps/server/src/ai/calls.ts:553-582` (`instanceCalls`)
- **Observed behavior:** `single()` only forwards `task`, `model`, or `outcome` to SQL (`kept.ai_instance_calls`) when `v?.length === 1` and not negated. Any multi-value or negated filter triggers `for (let pageNo = 0; pageNo < 50 && picked.length <= q.limit; pageNo++)`, pulling up to 50 sequential 200-row pages (10,000 rows) into Node to filter via `instanceMatch(q, r)`.
- **Reproducibility to confirm:** Call `GET /api/v1/ai/calls?scope=instance&task=extract&task=embed_thing` on a populated `llm_calls` ledger and inspect SQL query count.
- **Operational impact:** Blast radius: Workflow | Side-effect class: DB | Reversibility: reversible | Operator visibility: silent | Rerun safety: safe
- **Recommended mitigation:** Extend `kept.ai_instance_calls` (additive migration) to accept array/negated filters in SQL `WHERE` clauses (`ANY`/`ALL`).
- **Implementation assessment:** Complexity: `persistence_recovery` | Cost: `S` | Cost drivers: migrations, modules, tests | Nominal agent: `other-agent`
- **Validation:** Assert 1 SQL query returns the exact same filtered cursor page as the 50-page JS scan.
- **Non-goals:** Altering RLS or admin-only access checks on `instanceCalls`.

---

### REL-OPT-008: Uncached Query Embeddings & Per-Location Provider Resolution on Every Semantic Search

- **Severity:** Medium
- **Confidence:** Confirmed (code) / Plausible (cost savings depend on query repetition rate)
- **Evidence basis:** `source-evidenced`
- **Domain:** Reliability / External Spend (Taxonomy: `OPT-008`, `OPT-011`)
- **Evidence:** `apps/server/src/search/semantic.ts:119-175` (`prepareSemantic`), `apps/server/src/embeddings/provider.ts:28-47` (`embeddingsSource`)
- **Observed behavior:** Every semantic search (including pagination/refinement and assistant `search_things`/`where_is` calls) queries `instance_settings` via `embeddingsSource()`, loops sequentially over every visible location calling `rt.keys.resolve(...)`, and invokes external `embedValues()` with zero in-memory LRU/TTL cache.
- **Reproducibility to confirm:** Run the exact same semantic search query twice in 10 seconds and inspect `llm_calls` for two identical `embed_query` external calls.
- **Operational impact:** Blast radius: Service | Side-effect class: external API | Reversibility: reversible | Operator visibility: logged (`llm_calls`) | Rerun safety: safe
- **Recommended mitigation:** Add a bounded in-memory LRU/TTL cache (e.g., 512 entries, 5–10 min TTL) keyed by `(modelKey, dims, normalizedText)` — note: must still check authorization/payer eligibility before returning a cached vector so billing/access isolation holds — and batch `keys.resolve` across locations.
- **Implementation assessment:** Complexity: `local_guardrail` | Cost: `S` | Cost drivers: modules, tests | Nominal agent: `other-agent`
- **Validation:** Measure cache hit rate on real search logs (see Measurement Backlog) before/after; test that revoking a location's provider still prevents semantic search.
- **Non-goals:** Caching across different `modelKey` or `dims`.

---

### DAT-OPT-009: Additional N+1 DB Query Loops Across Server Services

- **Severity:** Medium
- **Confidence:** Confirmed
- **Evidence basis:** `source-evidenced`
- **Domain:** Data-Integrity / Performance (Taxonomy: `OPT-002`)
- **Evidence:**
  1. `apps/server/src/places/service.ts:899-955` (`convertChildrenToContainers`): bulk-locks places with `ANY($1::uuid[])`, then runs 4 SQL queries + `audited()` per place in a loop.
  2. `apps/server/src/enrich/job.ts:211-254` (`applyAnswers`): per-thing `SELECT ... FOR UPDATE` + `UPDATE` inside a loop despite already using `auditedMany()` at line 254.
  3. `apps/server/src/labels/service.ts:422-440` (`makeBlanks`): 1 `INSERT INTO public.short_ids` per blank label instead of bulk `unnest($1::text[])`.
  4. `apps/server/src/imports/lubelogger.ts:195-219` + `schedules/services.ts:413-424`: per-row `import_source_ids` dedup query AND per-row `locations.timezone` query (`noonOf`) for a constant `locationId`.
  5. `apps/server/src/purchases/service.ts:346-375` & `schedules/services.ts:337-410`: per-line inserts, per-line `audited()`, and `O(L²)` `lines.filter(...)` inside the loop.
  6. `apps/server/src/serialize/gates.ts:57-99` (`gateFor`): 2 sequential SQL queries per visible location across 11 global view callers (`insights`, `home/overview`, `search`, `reports`, `things/sheet`, `history`, `vehicles`, etc.) — `2L` queries where `preloadGates(tx, locationIds, scope)` takes 2 queries total.
  7. `apps/server/src/boxcheck/service.ts:367-381` (`undoBoxCheck`), `locations/membership-jobs.ts:91-136` (`expireMemberships`), `tools/handlers/read.ts:209, 286` (`Promise.all` on a single `pg.Client`), `notify/push.ts:180-196` (per-subscription `withSystem()` transaction), `imports/homebox/repair.ts:236-275`.
  8. `apps/server/src/paperless/routes.ts:794-839`: unbounded `Promise.all(ids.map((id) => client.document(id)))` HTTP fan-out + per-doc `INSERT` + `audited()`.
- **Operational impact:** Blast radius: Workflow | Side-effect class: DB / external API | Reversibility: reversible | Operator visibility: silent | Rerun safety: safe
- **Recommended mitigation:** Convert each loop to `ANY($1::uuid[])` / `unnest(...)` + `auditedMany()`, add `preloadGates()`, and cap Paperless fetch concurrency (or use `id__in`).
- **Implementation assessment:** Complexity: `local_guardrail` | Cost: `M` (incremental per feature) | Cost drivers: modules, tests | Nominal agent: `other-agent`
- **Validation:** Existing feature Vitest suites + query-count assertions on multi-row inputs.

---

### WFG-OPT-011: iOS `@MainActor` Synchronous Keychain XPC (2–5×/Call) & Heavy File Copy / PDF / SHA-256 Blocking

- **Severity:** High
- **Confidence:** Confirmed (code) / Likely (UI hitches / watchdog risk on large exports)
- **Evidence basis:** `source-evidenced`
- **Domain:** Workflow-GUI (Taxonomy: `OPT-004`, `OPT-005`, `OPT-007`)
- **Evidence:**
  - `apps/ios/ios/App/App/KeptBridge.swift:126-137` (`KeptKeychain.read()`), `:1310-1318` (`run` on `@MainActor`), called 2–5× per bridge call (`:670, 686, 697, 709, 714, 732, 809, 816, 823, 833, 837, 853`) and `KeptCaptureAI.swift:130, 133`.
  - Heavy synchronous work on `@MainActor`: `exportHeldCapture` (`KeptBridge.swift:1268-1286` copying up to 20 × 25 MB = **500 MB** via `FileManager.default.copyItem`), `openHeldMedia` (`:1206-1212` up to 25 MB copy outside `NativeOutbox` actor), `shareLabelPdf` / `shareLabelSheet` (`:1019-1137` fresh `CIContext()` + up to 24 QR renders + PDF write), `uploadPhotoDisplay` (`:858` SHA-256 of up to 8 MB JPEG), `suggestCaptureName` (`KeptCaptureAI.swift:93-101` 6 MB base64 decode + `CGImageSource`).
- **Observed behavior:** Staging a 25 MB photo in 256 KB chunks (~100 chunks) performs **~200 synchronous main-thread `SecItemCopyMatching` XPC round-trips** to `securityd`. Exporting held captures or generating a 24-label PDF sheet blocks UIKit/WKWebView on `@MainActor`.
- **Reproducibility to confirm:** Run the iOS app under Xcode Instruments (Time Profiler + Hangs) while staging a 10+ MB photo or invoking `exportHeldCapture` / `shareLabelSheet`.
- **Operational impact:** Blast radius: Local | Side-effect class: user-visible, file | Reversibility: reversible | Operator visibility: UI-visible | Rerun safety: safe
- **Recommended mitigation:** Cache `KeptConnection` in memory on `@MainActor` (invalidated on `write`/`delete`, preserving the post-`await` session-switch guard), and offload file copies (`openHeldMedia`, `exportHeldCapture`), PDF/QR rendering (with a shared `CIContext`), SHA-256 hashing, and `suggestCaptureName` image decoding to `Task.detached` / `NativeOutbox` actor.
- **Implementation assessment:** Complexity: `local_guardrail` | Cost: `M` | Cost drivers: modules, runtime_verification | Nominal agent: `other-agent` (Swift/Xcode)
- **Validation:** Instruments Time Profiler shows zero `SecItemCopyMatching` per chunk and zero >16ms main-thread hangs during `exportHeldCapture` / `shareLabelSheet`.
- **Non-goals:** Changing Keychain accessibility attributes or session revocation semantics.

---

### WFG-OPT-012: `Outbox.swift` Double JSON Encoding, Cold-Launch `repair()` Rewrite Amplification, and N+1 `heldEntries()`

- **Severity:** Medium
- **Confidence:** Confirmed
- **Evidence basis:** `source-evidenced`
- **Domain:** Data-Integrity / Performance (Taxonomy: `OPT-002`, `OPT-003`, `OPT-005`, `OPT-006`)
- **Evidence:** `apps/ios/NativeStore/Sources/KeptNativeStore/Outbox.swift:252, 260, 325, 332, 404-406, 454-466, 468-497, 520`
- **Observed behavior:**
  1. `commit()` (`:252, 260, 494`) and `retarget()` (`:325, 332`) encode `PendingCapture` to JSON **twice** (once for `capture.json`, once for SQLite).
  2. `repair()` (`:468-491`), called on every `Outbox.init` (`:159`), walks every folder on disk, reads & decodes every `capture.json`, stats every original file, re-encodes JSON, and executes `INSERT OR IGNORE` even for captures already recorded in SQLite.
  3. `stats(context:)` (`:454-466`) fetches and JSON-decodes every pending manifest (up to 64 KB each) just to sum byte counts.
  4. `heldEntries(current:)` (`:404-406`) runs `1 + N` SQLite queries instead of 1 query.
  5. `captureFolder()` (`:520`) recomputes `SHA256(context)` + hex formatting on every call (including every 256 KB chunk).
- **Reproducibility to confirm:** Run `swift test` in `apps/ios/NativeStore` with an instrumented test populating 20 pending captures and instantiating `Outbox(root:)`.
- **Operational impact:** Blast radius: Local | Side-effect class: file, DB | Reversibility: reversible | Operator visibility: silent | Rerun safety: safe
- **Recommended mitigation:** Pass already-encoded JSON string into `insert()`, pre-load existing SQLite capture IDs in `repair()` to skip already-indexed finalized folders, store `total_bytes` column (or compute in SQLite), collapse `heldEntries` to 1 query, and cache `scopeHash(context)`.
- **Implementation assessment:** Complexity: `local_guardrail` | Cost: `S` | Cost drivers: modules, tests | Nominal agent: `other-agent` (Swift)
- **Validation:** `swift test` in `apps/ios/NativeStore` (including crash-recovery tests) stays 100% green.
- **Non-goals:** Weakening `WAL` / `synchronous = FULL` / atomic manifest durability.

---

### ARC-OPT-011: 5–6× Redundant Builds & Playwright Installs + Uncached PR Docker Builds in CI

- **Severity:** High (CI runtime & runner-minute spend)
- **Confidence:** Confirmed
- **Evidence basis:** `source-evidenced`
- **Domain:** Architecture / Build-CI (Taxonomy: `OPT-013`)
- **Evidence:**
  - `.github/workflows/ci.yml:155-170, 185-240, 255-302`
  - `scripts/ci-local.sh:47, 187-193, 291, 505-535, 576-648, 663-668, 685-699`
- **Observed behavior:**
  1. All 4 `e2e-shard` jobs + `e2e-update` + `ha` independently run `pnpm install --frozen-lockfile`, build `@kept/server...` and `@kept/web`, and execute `playwright install --with-deps chromium` (downloading ~150 MB Chromium + `apt-get` deps **5–6 times per PR** with no `~/.cache/ms-playwright` cache and no shared build artifact).
  2. `images-amd64` and `ha` (`ci-local.sh:664, 690`) run `docker buildx build ... --load .` with **no `--cache-from`/`--cache-to`** (unlike `release.yml:186-187`), rebuilding all stages from scratch on every PR—and duplicating `build`, `prod-deps`, `restic`, and `os-base` in parallel.
  3. Local full `ci-local.sh` (`ALL_STEPS`, line 47) runs `step3-update.spec.ts` **twice** and rebuilds server+web twice (once at `step_e2e:617-618`, again at `step_e2e-update:634-647`), and `step_ha:693-697` omits the `uses_installed_chrome` check.
  4. `db-test` (`step_test`) and `db-ops` (`step_portability`, `step_backup`) execute the same 9 portability/backup Vitest files twice per PR.
- **Reproducibility to confirm:** Inspect `.github/workflows/ci.yml:185-302` and `scripts/ci-local.sh:47, 582-699`; run `bash scripts/ci-local.sh --list`.
- **Operational impact:** Blast radius: Repo | Side-effect class: none | Reversibility: reversible | Operator visibility: UI-visible (CI duration) | Rerun safety: safe
- **Recommended mitigation:** Add an upstream `build` job uploading compiled `dist/` artifacts for `e2e-shard`/`e2e-update`/`db-ops`; cache `~/.cache/ms-playwright` keyed on `pnpm-lock.yaml`; enable `type=gha` BuildKit cache on PR image jobs; skip `step3-update.spec.ts` inside `step_e2e` when `e2e-update` is also scheduled; deduplicate `portability`/`backup` from `step_test` or `db-ops`.
- **Implementation assessment:** Complexity: `workflow_protocol` | Cost: `M` | Cost drivers: modules (workflows/scripts), runtime_verification | Nominal agent: `other-agent`
- **Validation:** Compare PR CI total runner-minutes and wall-clock time before/after while confirming identical test count executed.
- **Non-goals:** Reducing E2E or DB test coverage.

---

### ARC-OPT-013: Sequential 9-Step `pnpm lint` (21.31s) + Duplicate Lingui Extraction (7.01s)

- **Severity:** Medium
- **Confidence:** Confirmed
- **Evidence basis:** `runtime-observed` (local wall-clock timing) + `source-evidenced`
- **Domain:** Architecture / Build-CI (Taxonomy: `OPT-004`, `OPT-013`, `OPT-001`)
- **Evidence:**
  - `package.json:11` (`lint` script chaining 9 `&&` commands sequentially)
  - `scripts/ci-local.sh:47-48, 167-171` (`step_lint` followed by `step_catalogues`)
  - Measured local timings:
    - `biome check .`: `3.543s`
    - `check-logical-css.mjs`: `0.269s`
    - `check-i18n.mjs`: `9.218s` (runs Lingui extraction + parses `icuShape` 2×/translation & 14×/source at lines `146-206`)
    - `check-no-local-paths.mjs`: `5.265s` (`git grep -iE` scans ~30 MB of `migrations/meta/*_snapshot.json` and `pnpm-lock.yaml` at lines `156-164`)
    - `check-db-scope.mjs`: `2.599s` (Babel-parses all 679 server `.ts` files even though **253 files / 37%** contain neither `query` nor `connect` at lines `69-114`)
    - `check-ha-app.mjs` (`0.068s`), `check-web-api-paths.mjs` (`0.211s`), `check-setting-parity.mjs` (`0.059s`), `check-compose-files.mjs` (`0.076s`)
    - **Sequential total:** `21.31s` (parallel theoretical floor: ~`9.2s`).
    - Immediately followed by `check-i18n-extract.mjs`: **`7.011s`** (re-runs Lingui extraction a second time -> `16.23s` total for i18n alone).
  - Also `scripts/check-attribution.sh:14-20` forks `git log -1` + `grep` once per commit (`O(N)` forks).
- **Reproducibility to confirm:** Time each command in `package.json:11` plus `node scripts/check-i18n-extract.mjs` with `/usr/bin/time -p`.
- **Operational impact:** Blast radius: Repo | Side-effect class: none | Reversibility: reversible | Operator visibility: UI-visible | Rerun safety: safe
- **Recommended mitigation:** Run the 9 read-only lint checks in parallel (e.g., tiny Node runner); share one Lingui extract pass between `check-i18n.mjs` and `check-i18n-extract.mjs`; add a string `includes` prefilter in `check-db-scope.mjs`; exclude `*_snapshot.json` or tune prefilter in `check-no-local-paths.mjs`; collapse `check-attribution.sh --range` to a single `git log` pipe.
- **Implementation assessment:** Complexity: `local_guardrail` | Cost: `S` | Cost drivers: modules, tests | Nominal agent: `other-agent`
- **Validation:** Wall-clock time of `pnpm lint` drops from ~`21s` to <`10s` with identical exit codes on injected lint violations.

---

### ARC-OPT-014 & ARC-OPT-012 & ARC-OPT-017: Docker Cache Busting, Unprotected macOS CI Workflow, and Drifted Branch-Protection Script

- **Severity:** Medium
- **Confidence:** Confirmed
- **Evidence basis:** `source-evidenced`
- **Domain:** Architecture / Compliance-Posture (Taxonomy: `OPT-003`, `OPT-010`, `OPT-013`, `OPT-016`)
- **Evidence:**
  1. **`Dockerfile:54` + `.dockerignore:1-32`**: `COPY . .` sends `apps/docs`, `apps/ios`, `charts`, `homeassistant`, `.github`, `README.md`, `CHANGELOG.md`, `apps/web/e2e` (`.y4m` video fixtures), `apps/server/test`, `eval`, and `bench` into the build context, busting the entire `build` stage on unrelated edits.
  2. **`Dockerfile:57-61`**: `ARG VERSION=0.0.0-dev` is declared before a single `RUN` building `@kept/shared`, `@kept/mcp`, `@kept/server`, and `@kept/web`, even though only `@kept/web` reads `VERSION`—busting the first 3 workspace builds on every release tag. Also lines `303-318` and `360-378` duplicate 14 `COPY` layers between `ha` and `runtime`.
  3. **`.github/workflows/mvp1-ios.yml:29-66`**: Lacks the `if: github.event.repository.private == false` billing guard used in `ci.yml`/`docs.yml`/`perf.yml` while running `simulator` on `macos-26` (10× minute multiplier), and runs `@kept/web build:ios` twice (`bundled-ui:44` and `simulator:59` via `apps/ios/package.json:8`).
  4. **`scripts/repo-settings.sh:384` vs `.github/workflows/ci.yml:15, 246, 271, 292`**: `required=(... ci.yml:e2e-update ... ci.yml:images-arm64 ...)` requires `images-arm64` (which only runs on `schedule`/`workflow_dispatch`, never PRs), lists `e2e-update` redundantly alongside aggregate `e2e`, and omits `ci.yml:ha`.
- **Reproducibility to confirm:** Inspect the cited lines directly.
- **Operational impact:** Blast radius: Repo | Side-effect class: none | Reversibility: reversible | Operator visibility: UI-visible | Rerun safety: safe
- **Recommended mitigation:** Expand `.dockerignore`, move `ARG VERSION` below `@kept/server build`, add `private == false` guard + artifact handoff to `mvp1-ios.yml`, and sync `repo-settings.sh:384` with `ci.yml`.
- **Implementation assessment:** Complexity: `local_guardrail` | Cost: `XS` | Cost drivers: modules (config) | Nominal agent: `human-owner` (for `repo-settings.sh` / billing policy) & `other-agent`

---

### ARC-OPT-007 & ARC-OPT-008 & ARC-OPT-009: Algorithmic & Cold-Start Inefficiencies in `packages/shared` & `packages/mcp`

- **Severity:** Low–Medium
- **Confidence:** Confirmed
- **Evidence basis:** `source-evidenced`
- **Domain:** Architecture / Performance (Taxonomy: `OPT-001`, `OPT-005`)
- **Evidence:**
  1. **`packages/shared/src/floor-plan.ts:355-378, 443-454, 714-723`**: `separate()` calls `rooms.indexOf(a) < rooms.indexOf(b)` inside an `O(N²)` pair loop inside a 400-pass loop (`O(N³)` per pass instead of `i`/`j=i+1`); `largestRect(poly)` runs 6 nested loops calling `O(V)` `inside()` per cell (`O(X³·Z³·V)` instead of precomputing the `(X-1)×(Z-1)` grid once); `matchFloors()` re-normalizes names inside `.find()`.
  2. **`packages/mcp/src/output.ts:84-86, 156-166, 221-256`**: `largestRemovable()` still recurses into `value` at line 235 even after determining `!isProtected(key) && !holdsProtected(value)` (no descendant can ever exceed `value`'s byte size), `fit()` re-walks from root and runs full-envelope `JSON.stringify` on every deleted field (`O(F²)`), and `byteLength`/`base64url`/`unbase64url` allocate `new TextEncoder()`/`TextDecoder()` on every call.
  3. **`packages/shared/src/map-shapes.ts:3274-3869` (re-exported at `packages/shared/src/index.ts:34`)**: Eagerly executes `foldText` (`NFKD` + 9 regexes) across thousands of multilingual shape terms at module import time for every process importing anything from `@kept/shared`.
  4. **`packages/shared/src/money.ts:227-253` & `language-search.ts:49-73`**: Uncached `new Intl.NumberFormat(...)` per call and `2N` `new Intl.DisplayNames(...)` instances per `languageSearch()` call.
  5. **`packages/shared/src/normalize.ts:75-79, 88-96`**: `tsQuery()` calls `normalize(q)` then calls `searchVariants(w)` which re-runs `normalize(w)` on every word.
- **Reproducibility to confirm:** Read each cited line range; benchmark `import('@kept/shared')` cold-start time with/without eager `map-shapes.ts` initialization.
- **Operational impact:** Blast radius: Repo | Side-effect class: none | Reversibility: reversible | Operator visibility: silent | Rerun safety: safe
- **Recommended mitigation:** Fix index loops & precompute grid in `floor-plan.ts`; add `else if` in `largestRemovable()` + module-level `TextEncoder`/`TextDecoder` in `output.ts`; lazily initialize `map-shapes.ts` indexes on first lookup; cache `Intl` instances; call `stripPrefixes(w)` directly in `tsQuery()`.
- **Implementation assessment:** Complexity: `local_guardrail` | Cost: `S` | Cost drivers: modules, tests | Nominal agent: `other-agent`

---

### ARC-OPT-006, REL-OPT-010, REL-OPT-011, WFG-OPT-008, WFG-OPT-009, ARC-OPT-010: Dead / Zombie Code, Idle Job Queries, Bundle Bloat & Duplicated Logic

- **Severity:** Low–Medium
- **Confidence:** Confirmed
- **Evidence basis:** `source-evidenced` + `Counted`
- **Domain:** Architecture / Reliability (Taxonomy: `OPT-020`, `OPT-019`, `OPT-017`, `OPT-016`, `OPT-010`, `OPT-009`)
- **Evidence:**
  1. **Dead production modules (0 production callers):**
     - `apps/server/src/money/convert.ts:1-76` (`converterFor`, `convertTotals`, `sumDecimals`) — imported only by `apps/server/src/money/money.test.ts:10`.
     - `packages/shared/src/device-labels.ts:1-63` (re-exported at `packages/shared/src/index.ts:16`) — imported only by `device-labels.test.ts`; line 39 notes resolver is unimplemented.
  2. **Dead exported web hooks/utilities (0 non-test callers):** `useCaptureBatches` (`api/capture/queries.ts:328`), `useBoxChecks` (`:399`), `useAccountTemplates` (`:423`), `useServiceRecords` (`api/household/queries.ts:510`), `useDocument` (`:542`), `useThingHistory` (`api/inventory/queries.ts:346`), `getRecoveryKit` (`api/admin.ts:45`), `forgetThisDevice` (`pwa/push.ts:155`), `storageEstimate` (`offline/persist.ts:68`), `dropAll` (`offline/extras.ts:308`). Plus 52 unreferenced runtime exports in `packages/shared/src`, 11 in `packages/mcp/src`, and 5 empty Xcode template stubs in `apps/ios/ios/App/App/AppDelegate.swift:14-34`.
  3. **Bundle / dependency bloat:** `apps/web/src/api/auth.ts:3` statically imports `@simplewebauthn/browser` into the precached shell (only needed on passkey button clicks); `apps/web/package.json:33` keeps `@tabler/icons-react@3.48.0` for only 2 icons (`apps/web/src/components/type-icon.tsx:13`).
  4. **Drifted duplicate child-process RSS watchdog:** `apps/server/src/files/pdf-text.ts:76-172` (has `{ timeout: 2000 }` on `ps` and `belt` fallback timer) vs `apps/server/src/reports/render/render.ts:74-149` (missing both safeguards).
  5. **Redundant idle job queries:** `apps/server/src/mailin/poll.ts:348-350` runs a 90-day `DELETE` every 10 minutes even when `due.length === 0`; `apps/server/src/embeddings/backfill.ts:195-196` runs `backlog()` a second time and writes `kept.embedding_mark(...)` even when `batch === 0` found 0 pending rows.
  6. **Duplicated helpers:** Eastern Arabic/Persian digit folding duplicated 16+ times across `shared`, `server`, `web`, and `docs`; `apps/server/src/imports/csv.ts:240-242` (`legacyCodeOf`) duplicates `packages/shared/src/short-code.ts:61-70` (`storedCodeOf`); `useOnline()` duplicated 3× (`lib/online.ts:20`, `print-sheet.tsx:44-60`, `capture-screen.tsx:159-174`); `declutter()` duplicated 2× (`graph/declutter.ts`, `map/declutter.ts`); Keychain/base64url duplicated in `KeptBridge.swift` vs `ChatGPTPlan.swift`.
- **Reproducibility to confirm:** Run the `git grep` verification commands listed in Section 10.
- **Recommended mitigation:** Route dead-code deletion to `audit-deadcode-cleanup` (confirming no external package consumers); unify the RSS watchdog (`pdf-text.ts` + `render.ts`) first because it carries an active safety drift; lazy-import `@simplewebauthn/browser` and inline the 2 Tabler SVG icons.

---

## 8. Rejected / Held Candidates (Do Not "Optimize" Away)

Retaining checked-and-clean seams prevents future wasted passes and protects deliberate safety boundaries:

| Seam | Location | Suspected Issue | Why Held / Rejected |
|---|---|---|---|
| Visual search re-checks | `apps/server/src/visual-search/query.ts:58-250` | Repeated `visualLocations()` / `reauthorize()` across async encoding | Deliberate TOCTOU security guard preventing cross-tenant leak if membership changes mid-request; vector cache is properly bounded (`MAX_INPUTS = 128`, `.unref()` timers). |
| Bulk edit savepoints | `apps/server/src/things/sheet.ts:499-622` | Per-row savepoints in bulk edit | Already uses a set-based `together()` fast path (`writeThingUpdates`), falling back to per-row savepoints only on write-time errors. |
| Place tree BFS | `apps/server/src/reminders/items.ts:43-81` | Recursive tree walk | Level-by-level BFS with `ANY($1::uuid[])` bounded by `MAX_DEPTH` — no N+1. |
| Place view path hoisting | `apps/server/src/places/view.ts:787-819` | Per-item path lookup | Explicitly hoisted `pathOfPlace()` once per page and batched `thumbKeysOf`; `Promise.all` only signs URLs in memory. |
| Webhook listener check | `apps/server/src/webhooks/fanout.ts:124-150` | Per-event listener lookup | Already caches `(locationId, event)` per `tx` in a `WeakMap` and batches unknown pairs with `unnest`. |
| Offline `SyncEngine` timer | `apps/web/src/offline/sync-engine.ts:185-221` | 60s sync timer | Properly pauses when `document.visibilityState !== 'visible'`, coordinates tabs via `navigator.locks`, uses exponential backoff (`5s→5m`), and cleans up on `stop()`. |
| PWA bundle & SW budgets | `apps/web/vite.config.ts`, `sw.ts`, `scripts/check-bundle.mjs` | Bundle bloat / precache churn | Enforces strict entry-chunk & precache budgets, splits `assets/household/`, lazy-loads `@serwist/window` on `window.load`, and dynamically imports demo fixtures. |
| iOS `ChatGPTPlan.swift` & Bridge | `apps/ios/ios/App/App/ChatGPTPlan.swift`, `KeptBridge.swift:511-538` | Suspected dead prototype code | 100% live production code; all 26 `CAPPluginMethod` entries and all 19 `outbox` actions are wired in `apps/web/src/native/`. |
| iOS `Outbox.swift` SQLite mode | `apps/ios/NativeStore/Sources/KeptNativeStore/Outbox.swift` | `synchronous = FULL` + atomic manifest write | Deliberate crash-recovery durability invariant for offline capture; keep intact when removing duplicate JSON encodes. |
| Unreferenced server files | `observability/tracing.ts`, `reports/render/build-assets.ts`, `ai/memory.ts`, `backup/restic/fake.ts` | Suspected dead files | Loaded dynamically via `Dockerfile:393` (`node --import`), `package.json` build script, or `eval/`/`test/` harnesses. |
| `compose.yaml` vs `compose.full.yaml` | Root Compose files | ~250 duplicated lines | Intentional standalone Portainer/Dockge pasteability; parity enforced automatically by `scripts/check-compose-files.mjs` (`0.076s`). |
| `scripts/` inventory | `scripts/*.mjs`, `scripts/*.sh` | Suspected dead scripts | Every script is referenced by workflows, `package.json`, `Dockerfile`, or maintainer runbooks. |

---

## 9. Specialist Routing Table

| Candidate / Group | Owning Follow-Up Skill | Reason for Route |
|---|---|---|
| `REL-OPT-001`, `REL-OPT-002`, `WFG-OPT-001`, `WFG-OPT-003`, `WFG-OPT-006`, `REL-OPT-011` | `audit-resource-lifecycle` | Deep timer, connection-pool, `xmin`-horizon, and child-process watchdog lifecycle analysis |
| `WFG-OPT-002`, `WFG-OPT-011`, `ARC-OPT-009` | `audit-performance-profile` | Same-harness frame-time profiling (3D Map), Instruments main-thread profiling (iOS), and Node cold-start measurement (`map-shapes.ts`) |
| `ARC-OPT-006` | `audit-deadcode-cleanup` | Full reachability verification (including external/CLI/docs consumers) before deleting dead modules and 60+ unused exports |
| `ARC-OPT-010`, `ARC-OPT-017`, `WFG-OPT-009` | `audit-invariant-sync` | Canonical single-source consolidation for digit folding, short-code normalization, and CI required-check definitions |
| `REL-OPT-008` | `audit-memory-lifecycle` | Cache sizing, eviction bounds, and per-tenant/payer isolation review before introducing a query-embedding LRU/TTL cache |

---

## 10. Measurement Backlog & Reproducibility Commands

### One Discriminating Measurement Per `Measure` / Runtime-Dependent Item

| Item | Discriminating Measurement | Command / Harness | Decision Threshold |
|---|---|---|---|
| `REL-OPT-001` (Idle `pg-boss` QPS) | Count `pgboss` fetch queries over 60s on an idle dev server | `SELECT calls, query FROM pg_stat_statements WHERE query LIKE '%pgboss%' ORDER BY calls DESC;` | Confirms ~1,320 queries/min idle baseline |
| `REL-OPT-008` (Query embedding cache) | Compute duplicate `(model_key, normalized_query)` share over 7 days of `llm_calls` (`task = 'embed_query'`) | Query `llm_calls` / search logs in a representative instance | If repeat rate >10% within 10 min, LRU/TTL cache pays off immediately; if <2%, keep low priority |
| `ARC-OPT-009` (`map-shapes.ts` cold start) | Measure Node import latency of `@kept/shared` with vs without `map-shapes.ts` | `node --input-type=module -e "const t=performance.now(); await import('./packages/shared/src/index.ts'); console.log(performance.now()-t)"` | If >20ms on server/CLI/test worker startup, lazy-init is high leverage for Vitest & CLI |
| `WFG-OPT-002` (3D Map reflows) | Chrome DevTools Performance trace during 3s camera orbit on 50-item plan | DevTools → Performance → check `Forced reflow` warnings in `placeLabels` | Any frame >16.6ms dominated by Layout confirms High user-visible impact |
| `WFG-OPT-011` (iOS main-thread hangs) | Xcode Instruments Time Profiler + Hangs during 10 MB photo stage & 24-label PDF export | Xcode → Profile → Time Profiler on physical iPhone / Simulator | Any main-thread block >100ms confirms High mobile UX impact |
| `OPT-012` (Resource right-sizing) | 7-day container CPU/RAM/DB connection p95 from deployed instance | `docker stats` / Prometheus metrics on production/staging | Required before any container memory/worker-count changes |

### Deterministic Static Reproduction Script (Read-Only)

Run from the repository root to reproduce all static counts in this report:

```sh
# 1. Server: 12 idle_in_transaction_session_timeout workarounds & 44 job queues
git grep -n "idle_in_transaction_session_timeout" apps/server/src
git grep -n "defineJob(" -- apps/server/src ':!*test*' | wc -l

# 2. Dead production modules & single-use dependency
git grep -n "converterFor\|convertTotals\|sumDecimals" apps/server/src
git grep -n -E "device-labels|parseDeviceLabel|createDeviceLabelBatch|DEVICE_LABEL_" apps/ packages/
git grep -n "@tabler/icons-react" apps/ packages/

# 3. Web: 223 useFormat consumers & 9 dead exported hooks/utils
git grep -l "useFormat(" apps/web/src | wc -l
for fn in useCaptureBatches useBoxChecks useAccountTemplates useServiceRecords useDocument useThingHistory getRecoveryKit forgetThisDevice storageEstimate; do
  echo -n "$fn: "; git grep -n "\b$fn\b" -- apps/web/src ':!*test*' | wc -l
done

# 4. Lint timing breakdown (sequential vs parallel floor)
for cmd in \
  "pnpm exec biome check ." \
  "node scripts/check-logical-css.mjs" \
  "node scripts/check-i18n.mjs" \
  "node scripts/check-no-local-paths.mjs" \
  "node scripts/check-ha-app.mjs" \
  "node scripts/check-web-api-paths.mjs" \
  "node scripts/check-db-scope.mjs" \
  "node scripts/check-setting-parity.mjs" \
  "node scripts/check-compose-files.mjs" \
  "node scripts/check-i18n-extract.mjs"; do
  echo "=== $cmd ==="
  /usr/bin/time -p sh -c "$cmd" >/dev/null
done
```

---

## 11. Highest-Leverage Next Actions

1. **Immediate Quick Wins (XS–S, zero architectural risk):**
   - Fix the unbounded 3s post-saved polling leak in `apps/web/src/components/scan/session/summary.tsx:105-131` (`WFG-OPT-001`) and the error-state 1s polling loop in `apps/web/src/api/assistant/queries.ts:78-85` (`WFG-OPT-006`).
   - Add per-queue `pollingIntervalSeconds` to `JOB_POLICIES` / `registerJobs()` (`REL-OPT-001`) to eliminate ~1.9M idle `pg-boss` queries/day.
   - Cache `makeFormatter()` in `apps/web/src/lib/format.ts:92-200` (`WFG-OPT-004`) and stabilize `useUnitSystem()` in `apps/web/src/lib/units.ts:27-35` (`WFG-OPT-005`).
   - Parallelize the 9 independent checks in `pnpm lint` (`ARC-OPT-013`) and fix `.dockerignore` + `ARG VERSION` placement in `Dockerfile` (`ARC-OPT-014`).
   - Add the missing `private == false` guard to `.github/workflows/mvp1-ios.yml` (`ARC-OPT-012`) and sync `scripts/repo-settings.sh:384` (`ARC-OPT-017`).
2. **High-Impact Structural Repairs (M):**
   - Add `transactional: false` to `TenantJob` in `apps/server/src/jobs/boss.ts:205-220` (`REL-OPT-002`) to eliminate all 12 2-hour `idle in transaction` workarounds.
   - Cache `KeptConnection` on `@MainActor` and offload file copies/PDF/image decoding in `KeptBridge.swift` & `KeptCaptureAI.swift` (`WFG-OPT-011`).
   - Reuse build artifacts + cache Playwright Chromium + enable GHA BuildKit cache in `.github/workflows/ci.yml` (`ARC-OPT-011`).
   - Separate DOM write/read passes and index `plan.rooms`/`plan.items` in `apps/web/src/map/engine/engine.ts:1420-1509` (`WFG-OPT-002`).

---

## 12. Validation Limits & Unreviewed Frontier

- **Read-only scope:** No code was modified, no benchmarks or load tests were executed against Postgres, and no Xcode/Chrome runtime profilers were attached.
- **Unreviewed / lightly sampled surfaces:**
  - `apps/docs/src` (753 files): Not deeply audited for docs-site build/runtime optimization (only checked `docs.yml` CI workflow and `try-map/demo.ts` duplication).
  - `apps/server/migrations/*.sql`: SQL index coverage and `EXPLAIN ANALYZE` query plans for individual PostgreSQL functions (`kept.*`) were not profiled against a live 10k-row dataset (run `pnpm bench:rls` and `audit-performance-profile` for SQL plan depth).
  - `charts/kept` (Helm chart) and `homeassistant/` add-on runtime scripts: Only checked via `check-ha-app.mjs` / CI jobs, not deeply profiled.
  - Production telemetry (`OPT-012`): Unavailable in local checkout; right-sizing remains unreviewed.
