# SheepKeep for iPhone

Bundled Capacitor iOS client with native Swift storage, Keychain credentials, Core NFC tag reading/writing/Find mode, camera and document capture, Quick Look media viewing, and durable offline synchronization against an existing Kept backend.


See the [NFC runbook](../../docs/runbooks/nfc-mvp.md) for the integrated setup and the [gate record](../../docs/mvp1/status.md) for device results.

## Inventory on iPhone

- The bottom tab bar contains **Home**, **Browse**, **Scan**, **History** and **More**. Scan sits in the center above the bar. Home shows inventory counts, shortcuts, recently used boxes and sync status. **History** shows recent activity. **Assistant** is in the header. Open **Settings** from the Home gear or **More**. Home offers **Continue finding** when there is a saved Find target.
- Choose **Add to bin** on Home, then tap the plus on a box card to add an item directly to it. You can choose a 27-gallon tote, shoe box bin or cardboard box when creating a box, or change an existing box's type under **Edit**. The server must be updated and migrated to provide these types.
- Choose **Missing items** on Home to see records marked missing, including their last recorded locations. On an item, choose **Mark missing**; when you find it at its recorded location, choose **Mark found here**. To record a different location, use **Move**. The list shows cached inventory when offline, while changing the status requires a connection.
- Tap **Browse** to open the filterable inventory view. Tap **Home** again to focus **Search inventory**. Type to search boxes, rooms, items and documents. Use **Open in Browse** to take that search into the filterable inventory view, or **Add “your text”** to start an entry with that description.
- Open **More → Settings → Locations** to hide Personal or delete another location you own. Personal shows again if it becomes your only location. Deleting another location removes it for everyone who uses it. Its owner can restore it for 30 days from **Settings → Locations** in the web app.
- Open **Home → Places → Create place** to add a room, spot, closet or floor. **Add sub-location** adds a place inside the current one. With a connection, open a place and tap **Edit** beside its name to rename it or change its description or kind. **Move** changes where it sits in the location.
- In **Add**, choose **Add item** or **Add box**. Add item is one screen: enter a description, add photos or files with **Camera**, **Photos**, **Files** (images or PDFs) or **Clipboard**, and check the destination. **Scan UPC** and **Start with NFC** sit under the description. Add starts at the place or box you last added to, or at Unplaced. A default location in Settings keeps it in that location. Tap **Change** to pick another destination; **Recent** there switches to a recent place or box in one tap. **Details** holds the action, categories, type, quantity, notes and the label. **Save item** saves right away. **Suggest details** lists what AI read from the photos field by field: tick the rows to use, or **Accept all**. After saving, the form clears, keeps the action and categories, and returns to the description for the next item. Item capture works offline with a cached destination. Creating a box requires a connection. When creating a box, list its **Contents** one item per line ("3 x HDMI cable" for a count) to add them with the box, or choose **Create box and add items** to go straight to adding items into it with photos and AI.
- Open a bin or item and choose **Add photos** to record its appearance without changing the inventory. The **Photos** section shows thumbnails. Tap a photo to open its display preview when available. If you have access to the full-size file, choose **Open original photo**. **Edit** changes the record, **Move** changes its location, and **More actions** includes **Seen here** and **Not here**. Choose **Move to Trash** directly on the record and confirm. Restore the record from **Trash** under **More**.
- Under **Last logged location**, choose **Add location photo** to show where you left an item or bin. The three most recently logged photos appear with their dates. Ordinary gallery photos and the recorded inventory location are separate. A photo saved offline syncs when SheepKeep reconnects.
- An item saved without a label gets a QR code when it syncs. To print it later, open the item's **QR and NFC label** screen. To use a physical tag while adding, open **Details**, then **QR or NFC label**. Scan a preprinted QR label or an NFC tag with an unassigned SheepKeep code, even offline when the code is cached. For a writable blank NFC tag, scan it and choose **Write and verify** while online. You can also reserve and share a QR label before saving.
- Use the **Scan** tab to open an existing label. To print a bin label, open **QR and NFC label**, then **Share QR label PDF**. The 3 × 2 inch PDF uses the bin’s existing HTTPS label and opens in the iOS share sheet. Use **Print label sheets** for writable 8-, 12- or 24-label US Letter sheets. Scan a blank label to assign it to a new or existing box.
- **History** shows who performed a recorded action and when the server logged it. Capture records existing contents by default. Change **Action** to **Add contents** when you put something in. **Add photos** logs an observation. Use **Contents checked, unchanged** after checking every direct entry. **More actions** includes recording a location correction or removing an item to **Unplaced**. Bin history includes direct contents changes with recorded bin IDs. A record marked **Not here** keeps its last known location visible.

---

## NIIMBOT B1 Pro printing

Open **Thermal printing** from a record’s **QR and NFC label** screen or from
**Print label sheets**. Open **NIIMBOT B1 Pro Bluetooth**, tap **Find nearby
printers**, and select the printer. SheepKeep reads its model ID before
remembering it. **Check printer status** reconnects briefly and reports the
battery, lid, paper, or roll information the printer supplies. The app
reconnects to the selected printer for each print job.

Load genuine NIIMBOT gap stock, starting with **50 × 20 mm**. You can also select
40 × 20, 30 × 20, 40 × 30, 50 × 30, and 50 × 50 mm. Choose **Prepare
calibration print** for a QR sample and alignment ticks, or **Prepare labels**
for inventory output. **Print on B1 Pro** accepts a range of up to 40 pages and
up to 20 copies per label. Open **Printer settings** from the print screen or
from **More → Settings** to adjust calibration and save printer profiles. AirPrint and PDF export remain
available. USB direct printing to the B1 Pro is outside this adapter's scope.

After a signed-in phone has cached the permanent label address, it can prepare
numbered batches and print them offline. Cached record labels with a known QR
address can also print offline. Registration and confirmation sync when the
server is available. If Bluetooth drops or a job is interrupted, check what
printed before reprinting the same identifiers. A printer completion report and
your confirmation are separate.

### Protocol references and qualification

The B1 Pro adapter checks model **4097** and uses the V4 print task over
CoreBluetooth. SheepKeep renders the existing thermal layout at **300 DPI**
with a conservative **567-dot** usable width. The pinned upstream hardware
notes report a **576-dot** head. This release uses the narrower area to leave
clearance. It does not reinterpret the consumable RFID reader as inventory NFC.

The Swift implementation uses published packet formats and no vendor app,
printer SDK, cloud service, or firmware patch. References are
[the hardware-tested driver at `98f352d`](https://github.com/JeisonSDC/niimbot/tree/98f352db6bbda1db7a63ad5d8865349a67a51e79),
[the V4 protocol document at `50801f4`](https://github.com/iscarelli/niimbot-web-bluetooth/blob/50801f40bc91a5bde782451c0e45b7e4e826f729/docs/protocol-v4.md),
and [NiimBlueLib at `7738f0a`](https://github.com/MultiMote/niimbluelib/tree/7738f0a777be340b00e2ceb6ed52aff656370f31).
The references are MIT licensed, copyright iscarelli (2026) and MultiMote
(2024). No upstream driver is bundled.

For hardware qualification, identify the printer, print the calibration label,
scan its QR, then print distinct labels and copies. Repeat offline and confirm
paper-out, an open lid, and printer power loss give actionable results before
reprinting. Check edge clearance and alignment when trying another stock size.

## Architecture

- **`apps/ios/NativeStore` (`KeptNativeStore` Swift Package):**
  - `Outbox.swift`: Actor-backed SQLite (`PRAGMA journal_mode = WAL`, `PRAGMA busy_timeout = 5000`) queue and protected pending-original storage (`excludedFromBackup`), staged file commits + startup manifest repair, `OutboxError.storageFull` mapping (`CocoaError.fileWriteOutOfSpace`, `ENOSPC`, `SQLITE_FULL`), scoped inventory cache, scoped `kv` storage (e.g. Find target state), atomic `retarget`, `clearFailure`, and `StorageStats`.
  - `SyncQueue.swift`: The durable `/sync/ops` queue (`sync_ops` table): ops stored once per idempotency key, answers kept, only unsent ops taken back, and a capture's ops released for a retarget only while none is `sent` or `applied`. `apps/web/src/native/sync-queue.ts` sends it by the web app's rules (`apps/web/src/offline/send-queue.ts`).
  - `NFCLogic.swift`: Strict NDEF label URL validator (`NFCLabelValidation`: HTTPS scheme + the server's origin or its label address + `/l/<code>` with Crockford folding, or `/l/<numbered alias>`), `NFCRepeatDebouncer` (2.5 s cooldown), `NDEFRecordSnapshot` SHA-256 fingerprint, and `FindOutcome`.
- **`apps/ios/ios/App/App` (Capacitor iOS Host & Swift Bridge):**
  - `KeptBridge.swift`: Privileged native Capacitor plugin registered only when the WKWebView loads the bundled `capacitor://localhost` / `app://` assets. Handles PKCE browser auth (`ASWebAuthenticationSession`), Keychain credentials (`KeptKeychain`), scoped native HTTP requests (`X-Kept-Native-Account`, `X-Kept-Native-Epoch`), raw file uploads (`X-Kept-Sha256`), `Outbox` actions, Quick Look preview (`QLPreviewController`), and `UIApplication` active/resign lifecycle observers.
  - `KeptNFC.swift`: Foreground `NFCNDEFReaderSession` coordinator for `.read`, `.inspect`, `.write(url, expected:)`, and continuous `.find` mode with repeat debounce, multi-tag polling restart (`restartPolling`), background interruption cleanup, and `KeptMatchFeedback` (prepared `UINotificationFeedbackGenerator` / `UIImpactFeedbackGenerator`, a chime built once and played with `AVAudioPlayer` under `AVAudioSession` `.ambient`, and `UIAccessibility` VoiceOver announcements).
- **`apps/web/src/native/` (Bundled Web UI & Platform Adapters):**
  - `vite.ios.ts`: Dedicated production bundle config building `apps/web/dist-ios` (synced into `apps/ios/ios/App/App/public`).
  - `adapters.ts`: `PlatformAdapters` + `NativePlatformProvider` + `capacitorAdapters` isolating native bridge calls from shared/mobile UI modules.
  - `outbox.ts`, `inventory.ts`, `labels.ts`: Replay engine (`deduplicatedFrom` canonical ID handling, post-upload attachment verification, `reviewSuggestions: true`), offline cache + filename-tokenized local search, strict label URL checking, and unresolved-when-offline Find semantics.
  - `main.tsx`, `home.tsx`, `record.tsx`, `capture-form.tsx`, `label-panel.tsx`, `native.css`: Home dashboard and phone navigation, **Add to this box** destination-locked capture, multi-photo and PDF attachment pickers, non-blocking AI review, Find target persistence, failure retargeting, and RTL-ready logical CSS across all 8 locales.

---

## Development, Build, and Test Commands

Run commands from the repository root with Node 24 and the pnpm version pinned in `package.json`.

### 1. Fast Automated Checks & Tests

```sh
# Swift Package unit tests (Outbox durability, storage exhaustion, NFC validation & debounce)
swift test --package-path apps/ios/NativeStore

# Native adapter, outbox, inventory, label, UI workflow, and Arabic RTL Vitest suite
pnpm exec vitest run --project @kept/web apps/web/src/native

# Workspace typecheck, Biome, i18n catalogues, logical CSS, API path, local-path & licence gates
pnpm typecheck
pnpm exec biome check apps/web/src/native apps/web/vite.ios.ts
node scripts/check-i18n.mjs
node scripts/check-logical-css.mjs
node scripts/check-web-api-paths.mjs
node scripts/check-no-local-paths.mjs
node scripts/check-licences.mjs
```

### 2. Build Bundled Assets & Sync iOS Project

```sh
# Build the standalone iOS web bundle (apps/web/dist-ios) and copy it into ios/App/App/public
pnpm --filter @kept/ios sync

# Open Xcode project
pnpm --filter @kept/ios open
```

Build the ordinary server web bundle (`pnpm --filter @kept/web build`) for Apple linking and MFA. Use a server build that supports [the Apple sign-in contract](../../docs/mvp1/integration-contract.md#session-and-capability).

### 3. Build & Launch on iOS Simulator

```sh
xcodebuild \
  -project apps/ios/ios/App/App.xcodeproj \
  -scheme App \
  -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath .tmp/ios-derived \
  CODE_SIGNING_ALLOWED=NO \
  build
```

To test Keychain operations on Simulator cleanly, use Xcode or sign the simulator binary ad hoc (`CODE_SIGN_IDENTITY=-`). Install and launch on a booted simulator:

```sh
xcrun simctl install <SIMULATOR_UDID> .tmp/ios-derived/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl launch <SIMULATOR_UDID> info.keptinventory.nfc
```

*Simulator limitations:* Core NFC (`NFCNDEFReaderSession`), hardware camera capture, silent-switch haptics, and physical reboot persistence cannot execute on iOS Simulator and must be qualified on a physical iPhone.

---

## Device Setup: Signing, Entitlements, Tags, and HTTPS

### Xcode Signing & Bundle Identifier

1. Open `apps/ios/ios/App/App.xcodeproj` in Xcode (Xcode 26+ recommended, deployment target iOS 15.0+).
2. Select target **App** → **Signing & Capabilities**:
   - Choose your Apple Developer Team (`<TEAM_ID>`).
   - Use bundle identifier `info.keptinventory.nfc`. The server verifies this exact Apple token audience.
   - Enable **Sign in with Apple** on that App ID in Apple Developer and refresh the development and distribution provisioning profiles. The server verifies the native identity token using Apple's public keys. This flow requires no Services ID, Apple callback URL or Apple private key. [Apple capability setup](https://developer.apple.com/help/account/identifiers/enable-app-capabilities/#enable-sign-in-with-apple).
   - Confirm **Near Field Communication Tag Reading** capability is enabled (maps to `com.apple.developer.nfc.readersession.formats` = `NDEF` in `App/KeptNFC.entitlements`).
   - Confirm **Keychain Sharing** / default app keychain access works for `KeptKeychain` (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`).

### Entitlements (`KeptNFC.entitlements` vs `KeptNFC-AssociatedDomains.entitlements`)

- **Default:** `CODE_SIGN_ENTITLEMENTS` points to `App/KeptNFC.entitlements` (foreground NFC tag reading without requiring domain association setup).
- **Optional Universal Links (`/l/*`):** a label's QR code or NFC tag then opens the app where it is installed, and Safari (the web app) everywhere else.
  1. Switch `CODE_SIGN_ENTITLEMENTS` in Xcode build settings to `App/KeptNFC-AssociatedDomains.entitlements`, and enable **Associated Domains** on the App ID.
  2. Set `KEPT_NFC_ASSOCIATED_DOMAIN` to the host labels carry: the server's `KEPT_LABEL_URL` host when it has one, else its `KEPT_PUBLIC_URL` host (no scheme, no port).
  3. Set `KEPT_APPLE_APP_IDS=<TEAM_ID>.info.keptinventory.nfc` on the server. It then serves `/.well-known/apple-app-site-association` itself, as `application/json` with no redirect and no sign-in, on both the label and the public host:

```json
{
  "applinks": {
    "details": [
      {
        "appIDs": ["<TEAM_ID>.info.keptinventory.nfc"],
        "components": [
          { "/": "/l/*", "comment": "A label: its code or numbered alias." },
          { "/": "/t/???-????-????", "comment": "A numbered label read as /t/." }
        ]
      }
    ]
  }
}
```

  4. Check it from outside your network: `curl -sI https://<label host>/.well-known/apple-app-site-association` answers `200` and `content-type: application/json`. Apple's CDN caches the file; a change can take a day to reach phones.

The app accepts a link, an NFC tag or a QR code under the server's own origin and under the label address the server names (`GET /api/v1/labels/address`, remembered for offline use), and nothing else. A link that arrives before sign-in is held in memory and opened once you are signed in; it is not kept across a force-quit. Universal Links are never guaranteed: iOS opens Safari when the person long-pressed and chose to, when the file can't be fetched, or in some in-app browsers, and the web app answers the same link.

### Local Server & Phone-Reachable HTTPS

- **Bundled assets remain authoritative:** Leave Capacitor `server.url` unset in `capacitor.config.json` so the privileged `KeptNative` Swift bridge stays bound strictly to bundled `capacitor://localhost` assets.
- **Physical phone connectivity:** iPhones require trusted HTTPS for `ASWebAuthenticationSession` and NDEF URL labels (plain `http://` is permitted only on Simulator loopback). Expose your private dev server over Tailscale Serve or a reverse proxy with a trusted TLS certificate (for example `https://<machine>.<tailnet>.ts.net`), and set `KEPT_PUBLIC_URL` on the Kept server to that exact origin.

### NFC Tag Hardware Notes

- Use ISO 14443 Type A NDEF-formatted writable tags: **NTAG213** (~144 bytes usable NDEF), **NTAG215** (~504 bytes), or **NTAG216** (~888 bytes).
- Kept writes exactly **one NDEF URI record** containing `https://<label host>/l/<6-char-code>` (~38–60 bytes depending on hostname length; the label host is `KEPT_LABEL_URL`'s, else the server's). A numbered label's link (`/l/BIN-A09Z-0001`) is 7 bytes longer. Short HTTPS hostnames comfortably fit NTAG213 (144 bytes).
- **Zero secrets or inventory contents** are ever stored on a tag. Multiple tags and printed QR stickers can share the same identifier for one box.

---

## Physical-Device Acceptance Checklist

Execute against disposable boxes/tags on a physical iPhone (Core NFC requires iPhone 7+ / iOS 15+). Record **Device Model**, **iOS Version**, **Tag Type**, and **Observed Outcome** for each check.

### A. Authentication & Account Isolation
- [ ] **Standard PKCE login:** Enter `https://<configured-host>`, tap **Sign in**, approve consent in `ASWebAuthenticationSession`, verify box list loads and `/api/v1/me/sessions` shows a `Kept for iPhone` session.
- [ ] **MFA login:** Enable TOTP on test user, sign in from iPhone, complete 6-digit TOTP challenge inside system auth sheet, approve consent, confirm `secondFactor: true`.
- [ ] **Session expiry recovery:** Revoke the iPhone session from another browser's active sessions list, trigger a refresh/sync on iPhone, verify pending captures remain safe in outbox, re-sign in as the same user on the same server, and confirm pending captures sync cleanly.
- [ ] **Safe sign-out & server/account switching:** Create an offline draft, tap **Sign out**, verify warning confirmation dialog (`AlertDialog`), test canceling (**Stay signed in**), then sign in as another user/server and verify the prior account's cache, Find target, and pending captures are completely isolated.

### B. Mobile Capture, Documents, AI & Search
- [ ] **Box destination visibility:** Open a Box/Bin, confirm readable recorded-location path (e.g. `Home › Office › Shelf`), tap **Add to this box**, and verify the box name and path remain visible throughout capture.
- [ ] **Multi-photo & PDF manual capture (no AI):** Disconnect or disable AI, enter description `"Holiday decorations"`, add notes & optional quantity, take 2 photos via camera/library, attach 1 PDF document, tap **Save to box** → verify **Saved on device** appears immediately after SQLite/file commit.
- [ ] **Batch capture & sync:** Add a second entry in the same session, reconnect network, verify **Synced** only after backend confirms records and original files.
- [ ] **Original-file integrity:** Reopen the synced item, open both photos and the PDF via Quick Look, and verify exact pixel quality, PDF readability, and server SHA-256 checksums match.
- [ ] **AI suggestions review:** With an AI provider configured, capture with a photo, open the synced item via **Check AI suggestions** / **Recent capture batches**, edit or ignore suggestions, and save.
- [ ] **Search (online & offline):** Search online by name/note/code; disconnect network and verify cached search finds boxes, notes, codes, and PDF filenames inside attachments.

### C. NFC Identification, Enrollment & QR Fallback
- [ ] **NFC Identify (valid):** Scan a programmed NTAG213/215/216 tag → opens authorized box record with contents and location path.
- [ ] **Malformed / Unknown / Retired / Foreign / Inaccessible tags:**
  - Plain text or `http://` NDEF record → **Malformed** error.
  - `https://other.invalid/l/7KQ4MZ` → **Foreign server** error (no silent server switch).
  - Unowned/unknown/retired `/l/<code>` → privacy-preserving unavailable response.
  - Valid uncached tag while offline → explicit **Unresolved offline** message.
- [ ] **NFC Enroll (fresh & reuse QR):** On a box with an existing QR/short code, tap **Inspect NFC tag**, scan blank writable NTAG213/215/216, verify writable capacity check passes, write `/l/<code>`, read back & verify, confirm both old QR sticker and new NFC tag open the same box.
- [ ] **Enrollment edge cases:**
  - **Occupied tag:** Inspect a tag belonging to another box → verify owner name / deliberate overwrite confirmation prompt before writing.
  - **Locked / too-small tag:** Test a locked read-only tag and a capacity-constrained tag → clear refusal without corruption.
  - **Interrupted write recovery:** Pull tag out mid-write, tap **Inspect NFC tag** on the same tag → confirm deterministic payload inspection distinguishes verified write from unprogrammed/foreign payload.
- [ ] **QR & manual fallback:** Scan box QR code via camera and via manual 6-character Crockford entry; verify `O->0` / `I,L->1` folding works.

### D. Find Mode & Accessibility
- [ ] **Match vs nonmatch vs repeat:** Select Box A → **Find this box** → start foreground scan.
  - Tap Box B tag → distinct nonmatch UI + light tap haptic + session stays active.
  - Tap Box B tag again within 2.5 s → repeat debounce notice ("Same tag scanned again. Move to another box.").
  - Tap Box A tag → distinct match banner + `.success` haptic + chime + VoiceOver announcement.
- [ ] **Silent switch & VoiceOver:** Toggle physical silent/mute switch on iPhone → haptic and visual match still trigger distinctly; enable VoiceOver and verify accessible labels and match announcements.
- [ ] **Offline uncached tag in Find mode:** Disconnect network, scan an uncached tag → reports **unresolved**, NOT a verified nonmatch.
- [ ] **Multi-tag, cancellation, timeout & restart persistence:**
  - Bring 2+ tags into field or scan past single-shot read → polling continues cleanly.
  - Cancel session or let 60 s NFC timeout fire → box target remains selected with **Continue finding**.
  - Background/force-quit app mid-Find, reopen → resumable Find target banner restores Box A target cleanly.

### E. Crash, Force-Quit & Device Reboot Durability
- [ ] **Termination & reboot persistence:** Disconnect network, save a capture with 1 photo + 1 PDF until **Saved on device** shows, force-quit the app (`App Switcher` swipe up), reboot the physical iPhone, relaunch offline → verify draft remains visible with intact preview thumbnails/Quick Look PDF and zero data loss.
- [ ] **Reconnect replay & duplicate prevention:** Reconnect network, allow sync (or tap **Retry sync**), confirm capture uploads once with matching original hashes and outbox empties.
- [ ] **Storage exhaustion (`storage_full`) & retargeting:** Verify graceful error on low-storage save refusal (simulated/unit-verified cleanly) and retargeting a capture whose destination box was trashed via **Change box → Move and retry**.
