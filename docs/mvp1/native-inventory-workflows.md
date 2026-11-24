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

## Photo review

**Add** and **Add to this bin** show the recorded destination and action. Manual capture can save a broad description with optional categories, notes, quantity and photographs. **Suggest description** proposes a single description. **Suggest categories** keeps the entered description. **Suggest items** opens review with up to 12 entries. **Review multiple items** opens the same review without inference.

The selected provider receives a prepared image for each photo selected for analysis. The server preview reuses ROOM extraction. The validation shared by the providers also accepts an optional description from device-backed inference. The client merges repeated normalized names and keeps the supporting photo indexes. Review shows AI quantities as estimates. An explicit quantity entry serves as the accepted count. The inventory service uses its standard quantity default when quantity is omitted. Additional photos can be chosen before starting analysis. A failed or cancelled request leaves manual capture available.

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

## Verification

The OpenAI server preview was exercised live with two repository fixture photographs and a disposable database. It produced multiple proposals and replayed two approved records with two canonical originals exactly once. The native UI tests exercise edits, rejection, added entries, multiple assigned categories, and saved-review recovery with mocked providers. The PostgreSQL export and restore tests verify shared original hashes, bin and record associations, category assignments, and a restored custom value.

The [iPhone procedure](ios-handoff.md#multi-item-photo-review-and-browse) covers live Apple Intelligence and ChatGPT plan, connected and disconnected capture, actual camera originals, and physical relaunch. The iOS build packages the React application in Capacitor. This increment targets the iPhone build.
