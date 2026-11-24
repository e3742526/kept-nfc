# Native inventory workflows

Starting revision `67f9fb0b` includes the iPhone assistant, local capture queue, and negotiated capture payloads 2–4.

- Physical placement uses places and containers. Record types select field definitions. Lifecycle and derived states describe status. The existing account-scoped tags model supplies many-to-many classification, including count, search, rename, delete, batch assignment, permissions, and audit events.
- Existing things and search endpoints apply location, place, type, status, and tag filters before pagination. Their `all=tagId` selects an intersection of tags. Cross-group OR and container expansion require explicit server semantics or a complete, clearly labeled local cache.
- Full thing views include the resolved field definitions and values. The existing form model builds changed-key patches. Native saves use authenticated `PATCH` with the current row version.
- Native capture payloads carry the device save time. That timestamp does not establish when the original image was taken. Audit events carry the server recording time.
- ROOM extraction can propose several objects. Its review and source retention rules are scoped to room walkthroughs. Bin capture must keep the original visible to each accepted entry and preserve separate replay identities.

## Photo review

A photo review uses one original and up to 12 entries. Choose **Suggest items** to review individual proposals, **Suggest categories** to keep the broad description already entered, or **Review multiple items** to work manually. Review saves the destination, intent, entries and category choices on the phone. Once approved, the outbox uploads the original, replays the approved entries with stable IDs, and verifies their attachments and category assignments before marking the batch synced.

## Browse contract

Native Browse uses the existing `GET /api/v1/things` list with additive query fields. Repeated `roomId`, `binId`, `tagId`, `typeId`, and `brandId` select alternatives within their dimensions. `all=tagId` requires all selected categories. Active dimensions combine by intersection, or by union with `match=any`. Base visibility, deletion rules and inventory mode requirements apply in either mode.

`nested=1` expands room descendants and container ancestry. `categoryContents=1` includes descendants of a matching categorized container without changing their category assignments. All-category matching requires the categories on the item itself or on one matching ancestor. The server marks which rows match through a container on each page. `uncategorized=1` matches entries with no direct category assignments. `unplaced=1` matches the Unplaced area. `count=1` returns the total before the cursor is applied. Counts and result pages use the app role and the same filters. Name, recorded time, modified time, direct confirmation time and recorded location have separate sort keys.

The existing snapshot supplies authorized category names and item assignments for offline browsing. Cached results carry a device coverage label. Brand filtering needs the server because the snapshot lacks brand values. Offline lists use the available cached sort keys. The grid and sort preference are saved in the native connection’s store. Edits and category registry management need a connection.

## Custom fields

Native views use resolved definitions and existing type names, field labels and value formatters. The edit form adds changed custom keys to its authenticated row-versioned patch. An explicit null clears an optional field. Required definitions are validated only when touched. Numbers, arrays, dates, options, booleans and money follow the shared value schema. Reference kinds are read-only. Secret, archived and money-gated values stay outside ordinary editing. A type change reloads the record and its field definitions after saving. The server handles archival of incompatible fields.

## Provenance

History displays the server event time and a separately labeled device save time when available. A direct observation time is shown only when the audit records one. The app does not infer a photo timestamp from an upload or device save. Record, addition, correction, removal, observation and Trash use distinct labels. Category events retain their existing audit and undo behavior. Native history resolves category names from the visible registry when available and uses a generic category-change label for unresolved IDs.

## Verification

Focused tests cover combination filters and counts before pagination, row-level authorization, changed custom values, device review restoration, selected-entry sync, and shared photo retention. The live OpenAI server API check used a fixture photo and a disposable database. It returned five proposals, saved two approved entries with one shared original, and replayed them without duplicates. The physical iPhone procedure is in the [iOS handoff](ios-handoff.md).
