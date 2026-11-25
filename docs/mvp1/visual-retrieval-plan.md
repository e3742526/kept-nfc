# Visual retrieval implementation and qualification

**R10** Words retrieve objects visible in stored image pixels even when omitted from all text.
**R11** A new photograph retrieves likely recorded locations with stored visual evidence.
The first whole-image slice gives both journeys the same encoder and index. Qualification remains open for both requirements. Ordinary search, exact identifiers and text-semantic search remain available on the Search page.

## Qualify on household fixtures

Collect opt-in originals across households, rooms and bins. Include crowded and partly occluded objects, small objects, similar items in different locations, varied light and angles, and older photographs. Use genuinely new photographs for the photo queries. Include absent items, inaccessible locations and ambiguous duplicates. Check that the names in the R10 cohort are absent from captions, aliases, notes, filenames and document text. Label acceptable record and box IDs plus the visible region. Split tuning and held-out data by household or object instance so closely related photos do not cross the split.

Run ordinary search, text-semantic search, full-image vectors, and full-image plus bounded regions on identical cohorts. Report Recall@1/5, no-match precision and false positives on absent items, ambiguity, coverage, latency, indexing throughput, memory and cost. Agree on the pass thresholds from the design before opening the held-out set. The four-image OpenCLIP study provides feasibility evidence for the encoder. Its shared scene/crop queries and small gallery leave household accuracy and abstention unqualified. [Experiment and measurements](../../scripts/visual-retrieval/README.md).

## Index and enforce source eligibility

1. Add a distinct pgvector index keyed by attachment, original content hash, region, and model generation. Pin weights, encoder dimensions, and preprocessing per generation. Use Kept's durable jobs for bounded, idempotent indexing. Backfill into a new generation and switch once measured coverage is acceptable.
2. Scope candidate generation and evidence to the caller's authorized locations and currently visible, eligible attachments. Use Kept's RLS and narrowly scoped search functions, honoring role, attachment visibility, trash and review state. Check eligibility before reading bytes or handing them to a provider, before committing an index row, and before returning results or issuing signed media URLs. Any external inference requires the existing explicit opt-in.
3. Use deletion, replacement and moves to invalidate the old source generation. Jobs recheck hash, attachment and location on commit, so an in-flight index cannot resurrect old results. Cross-location moves re-evaluate authorization at the destination. Revocation filters results, coverage, counts and new media URLs immediately on the server. Use the current canonical containment path in results. Rebuild derived vectors from surviving originals after restore.
4. Bound image bytes, decoded pixels, regions and per-account processing. Use a private, principal-scoped temporary object for query photos, with a proposed 15-minute maximum lifetime and deletion after encoding or cancellation. Keep a short-lived query vector for retry within that lifetime. Exclude query photos and vectors from inventory, backups, export, analytics, logs and model training. Expire them on schedule and invalidate them on access revocation.

## Whole-image interfaces

| Interface | Behavior |
| --- | --- |
| `POST /api/v1/visual-search/input` | Accepts JPEG, PNG or WebP up to 8 MiB and 20 megapixels, with optional comma-separated `locationIds`. Returns `{inputId, expiresAt}`. Encoding uses memory. The vector is bound to the principal, session or token, server origin, restore epoch, and authorized locations for up to 15 minutes. |
| `DELETE /api/v1/visual-search/input/:id` | Clears the caller's temporary input. Repeat calls return 204. |
| `POST /api/v1/visual-search` | Accepts one of `text` and `inputId`, optional `locationIds`, and a limit from 1 through 20. Photo queries can narrow the scope specified at upload. |
| `GET /api/v1/visual-search/status` | Returns the generation and scoped counts for ready, waiting, failed and paused photos. Current servers also report encoder health, denied scopes and photos without a supported rendition. |
| `POST /api/v1/admin/visual-search/reindex` | A signed-in location owner or admin submits `{locationId}`. Each audited request enqueues up to 100 attachments for the configured generation and returns `{queued, next?}`. Pass the optional continuation as `after` in the next request. |

The native Search and Browse screens open **Find in photos** and **Search with a photo**.
The first can reuse the search phrase. Camera and library queries use the existing native
session and a temporary JPEG. The app shows the live room and container path, evidence
thumbnail and an original-photo action. Users can open the record, navigate to a containing
bin, or continue into Find where the record has a supported bin label. Returning from record
navigation preserves the visual query and its current results. A result identifies a stored
photo to inspect. A weak match or closely ranked locations need extra verification.

Image search supports whole authorized locations. Room, bin, category, nested contents and
AND/OR filters still apply to ordinary Browse. Visual search has no server-side predicates for
those filters. The visual screen shows its effective scope and requests only that scope.
Live RLS, attachment eligibility and session checks govern candidates and coverage. Source
photos use the ordinary authorized media routes.

Native photo queries convert JPEG, PNG, WebP and HEIC/HEIF with ImageIO to upright JPEG at
up to 2,048 pixels per side. The source is bounded at 24 MiB and 100 megapixels for this
conversion. Local lexical search continues offline. Visual search needs a connection and
keeps no offline queue. Query cancellation releases the handle when the upload delivers it.
Temporary vectors expire within 15 minutes, or sooner on process restart. Multiple replicas
would need affinity for upload, search and cleanup.

## Index and reindex

Start the [pinned loopback OpenCLIP sidecar](../../scripts/visual-retrieval/README.md#opt-in-local-encoder)
and opt in on the server and worker. Normal in-limit JPEG, PNG and WebP originals are decoded
and resized for inference. An authorized, bounded display JPEG covers ordinary HEIC/HEIF and
large camera originals when available. Native uploads retain the original and can supply this
display rendition. Originals remain the source of evidence, with their existing checksums.
Existing HEIC/HEIF without a readable display rendition may need one generated where HEVC
decoding is available. A one-version server rollback can still serve authorized originals and
display URLs. The older AI extraction worker can miss newer HEIC renditions because it uses
a fixed blob path. Documents, draft and in-review attachments stay outside this index.
Viewers cannot query embeddings derived from originals.

Check scoped status after adding photos. Use the audited reindex route for eligible photos
missing from the current generation. Advance with the returned cursor to pass repeatedly failing sources. Let the queue drain
before checking coverage or retrying failures. Moving a record updates its displayed
path. Source changes and permission changes recheck eligibility, and replaced/deleted sources
lose their old indexed references. A verified restore advances the epoch and discards derived
vectors after verifying the database against the backup manifest. Reindex the restored
locations from the recovered originals and their authorized display renditions.

## Held-out household-photo proxy

The [predeclared protocol](../../scripts/visual-retrieval/household-protocol.md) fixes the
published beta thresholds and separates the COIL-20 tuning evidence from held-out Caltech Home
Objects scenes and independent object exposures. The benchmark used 70 gallery scenes and
neutral metadata. It measured the released OpenCLIP ViT-B/32 whole-image configuration first.
The [reproduction instructions](../../scripts/visual-retrieval/README.md) identify the corpus and
commands.

| Held-out measure | Text to photo | Independent photo to photo |
| --- | ---: | ---: |
| Top 1 | 43/63 (68.3%) | 42/59 (71.2%) |
| Top 5 | 53/63 (84.1%) | 48/59 (81.4%) |
| Crowded top 5 | 41/56 (73.2%) | 39/52 (75.0%) |
| Distinctive top 5 | — | 18/19 (94.7%) |
| Any candidates for absent queries | 10/12 (83.3%) | 16/21 (76.2%) |
| Likely claims for absent queries with released cutoff | 2/12 (16.7%) | 10/21 (47.6%) |
| No-match precision | 2/3 | 5/10 |

The additional weak-match tier reclassifies one absent photo query, leaving 9/21 likely claims
and 2/12 for text. Both exceed the beta maximum of 10%. Four overlapping gallery crops
improved crowded text top five to 51/56, returned candidates for all 12 absent text queries
and used five times the raw vector storage. The shipped index stays whole-image. Ranking stays
provisional. A calibration or model change needs a separate tuning set and a fresh holdout.

Loopback encoder median/p95 was 11.34/12.42 ms for text and 19.72/20.57 ms for JPEG queries.
The encoder processed 45.47 stored photos/sec and used about 609 MiB resident memory after the
run. The 70 vectors contain 143,360 bytes of float32 values before PostgreSQL and index overhead.
These measurements cover the Apple Silicon host and public proxy corpus. Keep G3 open for
absent-query behavior and physical acceptance. Keep G6 open for the household pilot.

### Actual application and scale

Disposable Fastify, PostgreSQL 18 and its durable worker reached 70/70 eligible attachments.
The first attachment became searchable after 1.20 seconds and the complete load took 139.26
seconds (0.50 photos/sec). The existing worker cadence dominates this result. Original
uploads took 28.63/37.03 ms median/p95. The browser check used Chromium at 375 px, verified
that ordinary Search found no matching text, exercised both visual actions, opened authorized
stored evidence and observed temporary-input deletion.

| Scope | Median | p95 | Vector relation size |
| --- | ---: | ---: | ---: |
| Held-out text API | 56.75 ms | 67.62 ms | 352 KiB at 70 |
| Held-out photo API, including query upload and encoding | 80.62 ms | 95.75 ms | Same index |
| Photo-query upload, preparation and encoding alone | 50.03 ms | 62.81 ms | — |
| 300 scoped vectors | 114.92 ms | 129.43 ms | 1.05 MiB |
| 3,000 scoped vectors | 308.60 ms | 328.37 ms | 9.30 MiB |
| 10,000 scoped vectors | 301.85 ms | 426.11 ms | 30.70 MiB |

The scale runs used 19 warm samples per size and duplicate vectors on disposable authorized
records. They measure actual application and database work at fixed scope, with no additional
accuracy evidence. Native results request eight cards, with the backend capped at 20. Chromium rendered
20 results at 10,000 rows with 12.35–12.89 MiB of JavaScript heap after garbage collection.
Physical client memory and long-running indexing throughput remain unmeasured.

### Next qualification work

1. Improve abstention for look-alikes with a separately labeled calibration set and verify
   both positive recall and likely false positives against a fresh held-out corpus.
2. Complete the signed-in native workflow with a disposable account, representative camera
   photos, NFC tags and a recovery destination. Record query latency over the phone's normal
   network and coverage of its actual capture formats.
3. Run the household pilot and a production read-only verification after deployment.
   Repeat the bounded backfill if the generation changes or a database is restored.

## First-slice evidence

The disposable Fastify and PostgreSQL integration indexed five out of five COIL-20 photos in distinct fixture boxes. The search words were absent from the associated records and ordinary lexical search returned no matching record. Photo queries used separately captured turntable exposures. The portable corpus includes similar cups and toy vehicles in different recorded locations. [Encoder setup and corpus commands](../../scripts/visual-retrieval/README.md#real-encoder-smoke-with-independent-image-exposures).

| Measure | Caption-omitted text | Independently exposed photo |
| --- | --- | --- |
| Recall@1 | 5/6 | 5/5 |
| Recall@5 | 6/6 | 5/5 |
| Absent queries without a match | 2/2 | 1/2 |
| API round trip on `e2f8d94c` | 34.7–95.3 ms | 66.0–113.8 ms including upload and encoding |

The five-photo upload, attachment and indexing path took 0.84–1.42 seconds in two focused runs. The encoder process used about 589 MiB resident memory on Apple Silicon after the small smoke run. The 375 px Chromium check used the built app and its running durable worker. One attachment became searchable 1.02–1.47 seconds after the attach request across two runs. Both browser query modes returned the same recorded box, an authorized signed preview loaded, and the query handle was released.

The absent cat figurine returned the rubber duck as a false positive. The small turntable corpus does not qualify household accuracy, abstention, throughput or latency at scale. Keep G3 and G6 pending. Assess the provisional scores on the approved independent household cohorts before applying them to pilot acceptance. [Approved NFC design and implementation plan](design/nfc-software-design.docx).
