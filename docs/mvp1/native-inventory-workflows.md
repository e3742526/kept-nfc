# Native inventory workflows

Starting revision `67f9fb0b` includes the iPhone assistant, local capture queue, and negotiated capture payloads 2–4.

- Physical placement uses places and containers. Record types select field definitions. Lifecycle and derived states describe status. The existing account-scoped tags model supplies many-to-many classification, including count, search, rename, delete, batch assignment, permissions, and audit events.
- Existing things and search endpoints apply location, place, type, status, and tag filters before pagination. Their `all=tagId` selects an intersection of tags. Cross-group OR and container expansion require explicit server semantics or a complete, clearly labeled local cache.
- Full thing views include the resolved field definitions and values. The existing form model builds changed-key patches. Native saves use authenticated `PATCH` with the current row version.
- Native capture payloads carry the device save time. That timestamp does not establish when the original image was taken. Audit events carry the server recording time.
- ROOM extraction can propose several objects. Its review and source retention rules are scoped to room walkthroughs. Bin capture must keep the original visible to each accepted entry and preserve separate replay identities.

## Assistant

The rightmost tab opens inventory chat. Searches cover the locations the user can access with Assistant enabled. The default location in **More** guides where a new entry goes when the user leaves the destination open. It also supplies the fallback location in **Add**. The default photo AI appears when multiple photo providers are available. Inventory chat uses the server's configured Assistant provider.

The native chat’s record-only context offers add, edit and move-to-Trash proposals. Confirmation runs as the signed-in user and records an audit event. The Trash proposal checks the record version and requires an empty container if the record is a bin. The chat displays Undo while the audit event can be reversed, including when a thread is reopened.

Use **Delete this thread** and confirm to permanently remove the conversation. The same private thread API serves the browser and the iPhone. Confirmed inventory changes retain their normal activity and Undo history.

**Attach photo** adds one picture to the next question. The server decodes and re-encodes a bounded, metadata-free JPEG for the selected Assistant model. It keeps the rendition in the private thread and shows a photo marker in history. Follow-up turns use the text conversation. They send a picture when one is attached again.

**Model** selects a model for the next message. Automatic uses the configured chat model for text and an available vision model for a picture. Choices come from the provider for the authorized context. A provider manager can also pick from that provider's stored text model list. The server checks the selection and provider again during the turn. Model changes use the existing payer and budget rules.

When a lookup changes who pays, the turn keeps the requested model if the new payer's provider offers it. Otherwise it uses that provider's default eligible model. Photo turns still require a model that accepts images.

## Places and reference photos

Open **Places** from Home to browse by inventory location. Expand a room, spot or box to see what is inside. The search matches names, breadcrumbs and descriptions. Direct counts show items immediately inside the record. All-level counts include items under its descendants.

Use **Create place** at the top of a location or **Add sub-location** on a place. Only the name is required. Top-level places default to Room and children default to Spot. **Move** changes the parent within the same inventory location. Trash offers to move the contents or trash them with the place.

**Add here** starts a capture with the current place selected. The destination picker drills down one level at a time and keeps the selected path visible. You can stop at a room, a shelf or a box wherever the operation permits it. The picker remembers successful destinations for the connected account. Use Unplaced for items that belong to the inventory location without a more specific place.

When Labels is enabled, an editor can open **QR and NFC label** on a place to show its SheepKeep QR code or write and verify a compatible NFC tag. The label follows the same place through a rename or move. Scanning a place from **Scan** opens its record with current direct items and child places. While choosing a destination, **Scan place label** fills the current picker and preserves edits in progress. A registered legacy code can resolve to the same record.

The iPhone camera and photo library add ordinary place attachments to **Reference photos**, which also appears on the web place page. These uploads run separately from saving the place. They create no AI drafts. You can open a photo at display size, replace or remove it, or choose a cover where your role allows. A replacement keeps the original photo's position and cover selection. Rolling location photos and Room Photos still in review stay outside this gallery.

Item and photo search show the current path from the inventory location down to the innermost bin. Search also shows the nearest place with storage directions and the nearest place with a ready reference thumbnail. The two can come from different places along the path. The assistant can search all descendants of a selected room, shelf or bin, and asks for a path when more than one destination fits.

On iPhone, create places, add items, and add or replace reference photos while offline. Pending places appear in Places and can be selected as destinations. A queued child, item or photo waits for its pending place to sync. An offline replacement uses the version on the phone and keeps the original upload in the queue if the server reports a conflict. Recently viewed covers can be available offline. Editing or moving a saved place and changing its cover need a connection.

A capped snapshot shows incomplete results offline and uses the scoped location hierarchy when online. Apply migration `0191_place_descriptions` before deploying the server that advertises description writes. For a one-release rollback, revert the app and server code while keeping the column and stored descriptions.

The rollback test runs the pre-Places server from `e84eedae` against a migrated development test database. Build that revision in a separate checkout and set `KEPT_TEST_PLACE_ROLLBACK_SERVER` to its `apps/server/dist/http/app.js` before running `pnpm exec vitest run --project @kept/server apps/server/src/sync/native-compat.test.ts`. The test checks that an edit from the previous server preserves the stored description and that queued place creation replays after returning to the current build.

## Photo review

**Add** and **Add to this bin** show the recorded destination and action. Manual capture can save a broad description with optional categories, notes, quantity and photographs. **Suggest description** proposes a single description. **Suggest categories** keeps the entered description. **Suggest items** opens review with up to 12 entries. **Review multiple items** opens the same review without inference.

The selected provider receives a prepared image for each photo selected for analysis. The server preview reuses ROOM extraction. The validation shared by the providers also accepts an optional description from device-backed inference. The client merges repeated normalized names and keeps the supporting photo indexes. A quantity entered before review carries forward when there is a single item and its description matches or was left blank. Review shows AI quantities as estimates. An explicit quantity entry serves as the accepted count. The inventory service uses its standard quantity default when quantity is omitted. Additional photos can be chosen before starting analysis. A failed or cancelled request leaves manual capture available.

Review saves the destination, intent, originals, selected entries, edits, and category choices in NativeStore. A cached same-name record at the destination can receive the photos or a user-approved name and description update. The update uses the current row version and can add categories through the existing batch endpoint. A version conflict holds that entry in the queue. Other entries can complete independently.

The outbox reuses stable operation and request IDs. It uploads each original once per replay pass and reuses canonical server file IDs across the entries and destination bin. Records in a room share the originals through their attachments. A bin receives an additional photo-only capture, so its history and attachments retain the originals independently of the child records. A batch completes after the server confirms the approved operations, category writes and expected attachment hashes. A retry skips completed entries and reuses the same upload IDs. Held work stays scoped to its original account, origin and restore epoch. Its recovery export includes the review, IDs, checksums and originals.

## Browse contract

Native Browse uses the existing `GET /api/v1/things` list with additive query fields. Repeated `roomId`, `binId`, `tagId`, `typeId`, and `brandId` select alternatives within their dimensions. `all=tagId` requires all selected categories. Active dimensions combine by intersection, or by union with `match=any`. Base visibility, deletion rules and inventory mode requirements apply in either mode.

`nested=1` expands room descendants and container ancestry. `categoryContents=1` includes descendants of a matching categorized container without changing their category assignments. All-category matching requires the categories on the item itself or on one matching ancestor. The server marks which rows match through a container on each page. `uncategorized=1` matches entries with no direct category assignments. `unplaced=1` matches the Unplaced area. `count=1` returns the total before the cursor is applied. Counts and result pages use the app role and the same filters. Name, recorded time, modified time, direct confirmation time and recorded location have separate sort keys.

The existing snapshot supplies authorized category names and item assignments for offline browsing. Cached results carry a device coverage label. Brand filtering needs the server because the snapshot lacks brand values. Offline lists use the available cached sort keys. The grid and sort preference are saved in the native connection’s store. Edits and category registry management need a connection.

## Categories

The Browse category manager uses the existing account tag registry, with authorized direct membership counts and paginated search. Category pages use the main Browse query and support uncategorized entries. Assignments are independent of physical placement and record type. Batch assign and remove send only the chosen category operation. The picker supports search, removable chips, recent choices in the current app session, and explicit category creation. Existing or similarly named categories are offered before creation. Optional starter categories are available from the manager. Deletion follows the registry’s unused-category rule. Cached category choices are usable during offline capture and review. The registry and existing-record changes require connectivity.

## Custom fields

Native views use resolved definitions and existing type names, field labels and value formatters. The edit form adds changed custom keys to its authenticated row-versioned patch. An explicit null clears an optional field. Required definitions are validated only when touched. Numbers, arrays, dates, options, booleans and money follow the shared value schema. Reference kinds are read-only. Secret, archived and money-gated values stay outside ordinary editing. A type change lists affected pending edits and reloads the current definitions after saving. The server handles archival of incompatible fields. A captured item can be enriched from its edit screen after synchronization.

## Provenance

History shows the authoritative server event time and separately labels the device save time. Direct confirmation events can supply an observation date. Legacy inventory activity timestamps also include saves and moves, so Browse and record details label these as recorded activity. The native capture payload has no dedicated photo timestamp. Bin history groups the loaded inventory entries from the same photo review and preserves each entry's history. Photo-only evidence, a direct unchanged check, physical moves, corrections, removal to Unplaced, Trash, and restoration use separate wording. Category and field edits use the existing audited mutation routes.

## Where to look

Open **Where to look** on an item or box to see ranked storage history. Switch between rooms and
areas, exact places, and inventory locations. Each result shows the number of recorded placements
and the most recent date. Counts include initial placements and recorded moves, including movement
with a box. The server uses the viewer’s location access. An older event that only saved a
destination ID can use that destination’s current breadcrumb. The list shows up to 12 results per
group. For long histories, the panel labels counts based on the most recent retained records.
Open the panel while connected.

## Verification

The OpenAI server preview was exercised live with two repository fixture photographs and a disposable database. It produced multiple proposals and replayed two approved records with two canonical originals exactly once. The native UI tests exercise edits, rejection, added entries, multiple assigned categories, and saved-review recovery with mocked providers. The PostgreSQL export and restore tests verify shared original hashes, bin and record associations, category assignments, and a restored custom value.

The [iPhone procedure](ios-handoff.md#multi-item-photo-review-and-browse) covers live Apple Intelligence and ChatGPT plan, connected and disconnected capture, actual camera originals, and physical relaunch. The iOS build packages the React application in Capacitor. This increment targets the iPhone build.
