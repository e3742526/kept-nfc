# NFC MVP1 gate record

Visual qualification starts from `702769e1` on GitHub main. Previous evidence covers
the disposable native integration and the independent Cloudflare R2 recovery drill.
[Prior commands, results and hosted runs](backend-handoff.md).

| Gate | Status | Observed evidence and remaining acceptance |
| --- | --- | --- |
| G0 · Baseline and hosting | **Passed** | Node 24, pnpm 11, Fastify, PostgreSQL 18 and pgvector. The existing hosted HTTPS readiness route returned 200. The unauthenticated visual status route returned 401. A separate disposable HTTPS server indexed three public fixture originals using the real encoder. |
| G1 · Native feasibility on a physical iPhone | **Pending** | The earlier phone reached consent without a native exchange. Apple verification with a fixture key, server PKCE and native session rules passed locally. The browser MFA regression also passed. Renewed physical evidence needs the Apple sheet, link, MFA, consent, native exchange and Keychain relaunch, followed by cancellation, expiry and revocation. |
| G2 · NFC correctness | **Pending** | Swift and web tests cover NFC payload and Find state, and four phone-width Chromium checks verify label printing and QR placement. No writable or failure-mode tag was exercised in this increment. |
| G3 · Visual retrieval qualification | **Pending** | Native controls and authorized result navigation have automated coverage. The 70-scene Caltech proxy meets the provisional positive-recall measures and misses the absent-query target. Both camera capture through the physical app and testing with the pilot inventory remain pending. [Quality and performance](visual-retrieval-plan.md#held-out-household-photo-proxy). |
| G4 · Isolation and synchronization | **Pending** | PostgreSQL and test-key native sessions exercise context rejection, replay, original bytes, permissions and visual revocation races. Swift and web tests exercise durable completion and held work. Physical camera/PDF capture, AI review, force-quit, reboot, reconnect and switching need actual device evidence. |
| G5 · Recovery | **Pending** | Real Restic/PostgreSQL local recovery checked byte-identical JPEG/PDF originals, containment, categories, custom fields, existing label resolution, stale epoch rejection and visual index rebuild. The earlier R2 test independently restored lost objects. Physical old-tag readback and held work after recovery need a device test. [R2 evidence](backend-handoff.md#cloudflare-r2-recovery-on-november-23-2026). |
| G6 · Complete P0 pilot | **Pending** | Requires the operator's household workflow, signed-in device evidence and qualified absent-query behavior. |

The Apple-only sign-in increment after `a3f05d64` passed local Apple-token verification against a fixture key, the Kept MFA and PKCE handoff, and the real local-storage restore drill. Simulator and device compilation were unsigned. G1 stays pending until a provisioned iPhone completes the Apple flow and the capture and durability cases. [iOS handoff](ios-handoff.md#apple-only-iphone-sign-in).

Use the [physical-device checklist](../runbooks/nfc-mvp.md#physical-device-acceptance) and record the device model, iOS version, tag type, tested commit and observed results.

## G1 device evidence

Xcode 27.2 built an arm64 Release app with an Apple development profile for `info.keptinventory.nfc` carrying the NDEF entitlement. Signature validation, CoreDevice installation readback and foreground launch passed. The detached build used the same team and bundle ID for both device builds.

The disposable fixture used PostgreSQL, local blob storage and a private HTTPS origin. Browser password and TOTP verification returned 200 on the phone. The consent form returned the expected 303. At this checkpoint the server had received no native exchange request and issued no native session. Local diagnostic and installation logs are under the ignored `.tmp/mvp1-g1/` directory.

## Native inventory workflows · 2026-11-23

Multi-photo review, tag-backed category management and assignment, and item and bin custom fields build on the native workflows in `076ba2a5`. Disposable proof covers live OpenAI preview and replay, scoped exports, and database restore of shared originals, category assignments and custom values. The [native inventory workflow record](native-inventory-workflows.md) describes the contracts and offline behavior. The [physical-device procedure](ios-handoff.md#multi-item-photo-review-and-browse) remains pending.

## November 24 signed-device checkpoint

Build 13 of version 1.0 was signed, installed, read back and launched on an
iPhone 17 Pro running iOS 27.2.1. Its app source was `5508ff5a`. Xcode 27.2
(27B52) produced the arm64 Release bundle, with Sign in with Apple and NDEF
verified in the signing profile. CoreDevice used the paired local-network
tunnel. The physical screenshot showed **Find in photos**, **Search with a
photo** and **Browse**. Build, install, launch and screenshot evidence sit in
the ignored `.tmp/native-qualification/` directory. The disposable HTTPS fixture
indexed three public originals and was ready for operator sign-in. At the end of
the observation window it contained zero Apple proof claims, zero linked Apple
accounts and zero active native sessions. Fresh physical authentication was
therefore unverified. No tag type was recorded for this build.

## November 24 CI checkpoint

The GitHub run for `702769e1` passed the iOS and docs workflows. General CI failed in
the fast, database shard 3, Home Assistant and E2E shard 3 jobs. This branch repairs
the native separator and capture-mock checks and points the sync route catalogue to
the existing test that asserts its audit row. Unrelated baseline failures cover web
chrome and PWA theme expectations, label stock and units tests, admin former addresses,
email-in, webhooks, release links and Home Assistant ingress. Local check results apply
to this branch. [Starting GitHub CI run](https://github.com/e3742526/kept-nfc/actions/runs/45338916046).

Local qualification passed workspace typecheck, lint and catalogues, migration drift,
the focused Swift NativeStore, web and PostgreSQL suites, the built browser sign-in
and label tests, and the server, web and signed iOS Release builds. The real encoder
and real local Restic runs used disposable fixtures. See the
[visual performance results](visual-retrieval-plan.md#actual-application-and-scale) and
[recovery procedure](../runbooks/nfc-mvp.md#offline-and-recovery).
