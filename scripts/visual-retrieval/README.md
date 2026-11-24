# Visual retrieval feasibility

This experiment compares Kept's existing keyword search against caption-independent image
retrieval. The gallery has four public fixture photographs with descriptions that omit the
objects. Each record sits inside a named box in a disposable Kept location. The experiment
runs inference locally and does not write image vectors into Kept.

| Image | Fixture description | Recorded box | Source |
| --- | --- | --- | --- |
| Coffee cup and saucer | Kitchen spares | Blue tote | scikit-image `coffee`, CC0 |
| Wall clock | Hallway odds and ends | Top shelf | scikit-image `clock`, photographer's public-domain release |
| Coins | Tray from the attic | Red box | scikit-image `coins`, Brooklyn Museum, no known copyright restrictions |
| Motorcycle | Garage overflow | Bottom shelf | Middlebury Stereo 2014, left camera |

The cup, clock and coins give the gallery round shapes with different contents. Image queries
use the right stereo camera's view of the motorcycle, a crop of the indexed clock exposure,
and the public CC0 scikit-image `chelsea` cat photograph as an absent object. The clock crop is
a transform of an indexed image. The motorcycle's right camera captured the same scene from
a different viewpoint. These are limited stand-ins for photographs taken during later use.

[scikit-image data and attribution](https://scikit-image.org/docs/stable/api/skimage.data.html)
and [Middlebury dataset terms and citation](https://vision.middlebury.edu/stereo/data/).
The Middlebury fixtures come from D. Scharstein et al., *High-Resolution Stereo Datasets
with Subpixel-Accurate Ground Truth*, GCPR 2014.

## Run the experiment

Use Python 3.12. Install into an ignored environment. The model checkpoint is roughly
577 MiB and the evaluator verifies its SHA-256 before loading it.

```sh
mkdir -p .tmp/kept-visual
python3.12 -m venv .tmp/kept-visual/venv
.tmp/kept-visual/venv/bin/pip install -r scripts/visual-retrieval/requirements.txt
curl -fL -o .tmp/kept-visual/open_clip_model.safetensors \
  https://huggingface.co/laion/CLIP-ViT-B-32-laion2B-s34B-b79K/resolve/1a25a446712ba5ee05982a381eed697ef9b435cf/open_clip_model.safetensors
.tmp/kept-visual/venv/bin/python scripts/visual-retrieval/evaluate.py \
  --weights .tmp/kept-visual/open_clip_model.safetensors \
  --output .tmp/kept-visual/results.json
```

For the keyword comparison, start a disposable [Kept development server](../../CONTRIBUTING.md)
on loopback with local storage and text embeddings off. Set `KEPT_VISUAL_EMAIL` and
`KEPT_VISUAL_PASSWORD` to the disposable seeded account's credentials, then add
`--kept-origin http://localhost:8080` to the command. The evaluator creates a uniquely named
fixture location on each run. It uses Kept's actual authenticated search API for the keyword
baseline. An encoder-only run leaves the keyword columns empty.

## Measured run on November 22, 2026

OpenCLIP 3.2.0 ran ViT-B/32 with LAION-2B `s34B-b79K` weights at revision
`1a25a446712ba5ee05982a381eed697ef9b435cf`, checkpoint SHA-256
`ac4f8c4b88af6d963118cbf40ad93176d092abbedfcb752601ae1866352656e6`.
Images were converted to RGB, resized bicubically to a 224-pixel short edge, center cropped
to 224 × 224, and normalized with the model's RGB means and standard deviations.
Both encoders produced L2-normalized 512-dimensional vectors. Ranking used cosine similarity.

Run on Apple Silicon CPU with four PyTorch threads, PyTorch 2.8.0, and no paid inference.
The model loaded in 809 ms and the four-image gallery encoded in 73 ms. The process peaked
at 1,504 MiB RSS, including the model and libraries. Query encoding took 13–21 ms for text
and 26–30 ms for images. Kept keyword requests took 17–29 ms over loopback. These timings
come from one run with a four-image gallery and exclude download time.

| Query | Expected | Kept keyword matches | Image-vector ranking by cosine |
| --- | --- | --- | --- |
| a cup of coffee on a saucer | Blue tote | None | Coffee .328, clock .175, coins .064, motorcycle .049 |
| a round analog wall clock | Top shelf | None | Clock .229, coins .145, coffee .143, motorcycle .127 |
| old metal coins | Red box | None | Coins .287, motorcycle .147, clock .146, coffee .066 |
| a motorcycle | Bottom shelf | None | Motorcycle .314, clock .179, coffee .155, coins .127 |
| a folding stepladder | No match | None | Coffee .130, clock .104, coins .101, motorcycle .099 |
| Kitchen spares | Blue tote | Blue tote | Motorcycle .158, clock .142, coins .134, coffee .131 |
| Motorcycle, right camera | Bottom shelf | No image input | Motorcycle .950, coffee .369, coins .282, clock .242 |
| Clock, same-exposure crop | Top shelf | No image input | Clock .975, coins .489, coffee .416, motorcycle .235 |
| Chelsea cat | No match | No image input | Coffee .396, clock .342, motorcycle .334, coins .265 |

The encoder ranked the expected record first for all four caption-omitted text queries and
both matching image queries. It ranked the exact description “Kitchen spares” last, and
ranked candidates even for the two absent objects. Preserve keyword and text-semantic
search, and evaluate abstention thresholds on a larger held-out dataset. This run has too few
classes, viewpoints and near-identical objects to qualify thresholds or generalize accuracy.

## Production boundary for a follow-on experiment

Restrict candidate IDs to the caller's authorized, visible things and attachments before
computing any rank. The evaluator filters its fixture gallery against Kept's authenticated
thing list before embedding or ranking when a Kept server is supplied. A production worker
would index an authorized original in a separate, model-versioned image index, with metadata
for location, attachment ID, checksum and deletion. Keep the original file and Kept's text
embedding rows separate. Include membership revocation, hidden and trashed things, and
deletion in cross-household retrieval tests before serving any private image results.

[OpenCLIP model and inference](https://github.com/mlfoundations/open_clip),
[pinned weights](https://huggingface.co/laion/CLIP-ViT-B-32-laion2B-s34B-b79K/tree/1a25a446712ba5ee05982a381eed697ef9b435cf).

## Opt-in local encoder

Use the Python 3.12 environment and local checkpoint from the setup above. Start the sidecar as
a separate process in the same network namespace as the Kept server and worker. It listens on
IPv4 loopback only, verifies the checkpoint SHA-256 and pinned inference package versions at
startup, and uses the CPU. Keep port 8798 private.

```sh
.tmp/kept-visual/venv/bin/python scripts/visual-retrieval/serve.py \
  --weights .tmp/kept-visual/open_clip_model.safetensors
```

Set `KEPT_VISUAL_ENCODER_URL=http://127.0.0.1:8798` in the environments that start Kept's server
and worker. With the variable unset, visual inference is disabled. Kept checks that the sidecar
serves its expected generation before sending either kind of input. The sidecar decodes and
encodes requests in memory. Weight downloads are a separate setup step.

Generation `openclip-vit-b-32-laion2b-s34b-b79k-1a25a446-224-v1` uses the checkpoint above and
the OpenCLIP 3.2.0 ViT-B/32 tokenizer and encoders. Kept bounds source images to 20 megapixels,
auto-orients them, scales them to fit within 1024 × 1024 without enlargement, flattens
transparency against white and transcodes to JPEG at quality 85. The sidecar validates the JPEG
and its dimensions, decodes to RGB, resizes the short edge to 224 with bicubic interpolation,
center crops to 224 × 224, and applies the OpenCLIP RGB normalization constants. Each encoder
returns a normalized 512-dimensional vector. Both the backend and the sidecar validate sizes,
and the backend checks the generation, dimension, and norm before using a response.

## Real encoder smoke with independent image exposures

The [Columbia Object Image Library (COIL-20)](https://www.cs.columbia.edu/CAVE/software/softlib/coil-20.php)
contains distinct exposures of objects on a turntable. The smoke run uses five gallery frames
from 0°, separate query frames captured at 30–50°, and similar toy vehicles and cups assigned to
separate fixture boxes. The fixture names and box labels omit the visible objects. The script
reads a local ZIP and verifies its SHA-256. The ZIP and generated fixtures stay out of Git.

```sh
curl -fL -o .tmp/kept-visual/coil-20-proc.zip \
  https://www.cs.columbia.edu/CAVE/databases/SLAM_coil-20_coil-100/coil-20/coil-20-proc.zip
.tmp/kept-visual/venv/bin/python scripts/visual-retrieval/check-sidecar.py \
  --coil-archive .tmp/kept-visual/coil-20-proc.zip \
  --output .tmp/kept-visual/sidecar-smoke.json \
  --fixture-dir .tmp/kept-visual/coil-fixtures
```

The November 23, 2026 run used the provisional text cutoff of 0.20, photo cutoff of 0.58, and
an ambiguity margin of 0.035. The sidecar started in 3.15 s and encoded the five gallery images
in 200 ms over loopback. Its process used approximately 589 MiB resident memory after the run.

| Query type | Recall@1 | Recall@5 | False positives on absent objects | Median / maximum encode over loopback |
| --- | ---: | ---: | ---: | ---: |
| Caption-omitted words | 5/6 | 6/6 | 0/2 | 14.01 / 45.40 ms |
| Separate photo exposure | 5/5 | 5/5 | 1/2 | 20.12 / 20.76 ms |

The absent cat figurine matched the rubber duck at 0.630. The handle-less cup text query ranked
the other cup first. The corpus is a five-object, single-background turntable smoke test. The
provisional cutoffs and measured timings still need held-out household qualification. This
command measures the local inference interface. Kept's authorized search, indexing coverage and
attachment lifecycle are exercised separately by server tests.

## Held-out household-photo proxy

Read the [qualification protocol](household-protocol.md) and
[frozen text labels](household-text.json). The held-out corpus uses the public
[Caltech Home Objects 2006 archive](https://doi.org/10.22002/D1.20089), by Pierre Moreels and
Pietro Perona. The evaluator uses author annotations and keeps the source images outside Git.
It reserves every fifth sorted annotated object instance for absent photo queries and excludes
every scene labelled as containing a reserved instance. Each of the 70 remaining scene
photographs has a neutral title and a distinct recorded bay. The 59 positive and 21 absent
photo inputs come from other physical exposures. The 63 positive text prompts include five
additional phrasings. The 12 absent prompts include related household objects. The evaluator
checks fixture metadata for overlapping query words. Some background objects may be
unannotated. This is a one-source-domain proxy for the household pilot.

Start the pinned local encoder above and run the evaluator in the same Python 3.12 environment.

```sh
curl -fL -o .tmp/kept-visual/Home_Objects_06.zip \
  'https://data.caltech.edu/records/bckkv-8my10/files/Home_Objects_06.zip?download=1'
.tmp/kept-visual/venv/bin/python scripts/visual-retrieval/qualify-household.py \
  --archive .tmp/kept-visual/Home_Objects_06.zip \
  --output .tmp/kept-visual/household.json \
  --fixture-dir .tmp/kept-visual/household-fixtures
```

The script verifies the archive SHA-256 and records the protocol and text-label hashes.
It checks annotation aliases and reports query-level first correct ranks, displayed
results, outcomes, eligible sources, encoder timing and derived bytes. Its JPEG
preprocessing uses Pillow. The API follow-up uses Kept's real image preparation,
worker and authorized search routes.

### Caltech encoder results

Apple M5, CPU, pinned OpenCLIP model and preprocessing above. Use the COIL-20 numbers only
for comparison with the earlier exploratory corpus. The Caltech report holds the cutoffs
and ambiguity margin fixed.

| Measure | R10 whole image | R11 whole image | R10 whole image plus four crops |
| --- | ---: | ---: | ---: |
| Displayed top-1 | 43/63 | 42/59 | 44/63 |
| Displayed top-5 | 53/63 | 48/59 | 60/63 |
| Crowded top-5 | 41/56 | 39/52 | 51/56 |
| Distinctive top-5 | 22/22 | 18/19 | 22/22 |
| Absent queries with candidates | 10/12 | 16/21 | 12/12 |
| Absent queries with a single-path match outcome | 2/12 | 10/21 | 1/12 |
| Absent single-path match after marking a lead within 0.035 of the cutoff weak | 2/12 | 9/21 | 1/12 |
| No-match precision | 2/3 | 5/10 | Undefined, zero no-match outcomes |
| Encoder median / p95, loopback | 11.34 / 12.42 ms | 19.72 / 20.57 ms | Same text encoding |

Within these cohorts, the whole-image encoder met the provisional recall targets and missed
the 90% abstention target for likely claims. A cordless-drill query returned a distractor at
cosine 0.240, and a crayon-box query led to another packaged object at 0.285. An absent
dark bottle had a lead of 0.750 and an absent armchair had a lead of 0.729.
The low no-match denominators reflect how rarely this system abstained. The crop experiment
improved crowded recall while returning candidates for every absent text query. It added
5.36 seconds of serial encoding for these fixtures and multiplied vector storage by five.
Keep the released whole-image index and communicate uncertainty. Recalibration and region
selection require a new independent held-out set before promotion.

All 70 eligible images were encoded successfully. The full image pass took 1.54 seconds of
loopback encoder requests (45.47 originals per second). The images and their four crops
took 7.25 seconds including local image preparation. The baseline used 140 KiB of float32
vectors before database overhead. The encoder was ready after 2.13 seconds and sampled at
about 609 MiB RSS immediately after the run. Process CPU time rose by roughly 11 seconds
during the measured run. These measurements omit authorized database access and the client.

### Fastify, PostgreSQL and Chromium

Start the disposable database and build the application using the repository instructions.
Start a dedicated E2E instance and run the harness from the repository root while the local
encoder is active. Stop the E2E instance after the run to clean up its scratch database.

```sh
KEPT_VISUAL_ENCODER_URL=http://127.0.0.1:8798 \
  node --conditions=kept-dist apps/web/e2e/serve.mjs visual-qualification 8237 --seed
```

```sh
node --conditions=kept-dist scripts/visual-retrieval/check-household-api.mjs \
  --fixture-dir .tmp/kept-visual/household-fixtures \
  --encoder-report .tmp/kept-visual/household.json \
  --output .tmp/kept-visual/household-api.json --scale
```

The harness uploads the public originals through the application, waits for the durable
worker, checks both browser query paths and opens an authorized image at a 375 px viewport.
It re-runs the benchmark against the actual visual API with a result limit of five. The
optional `--scale` adds disposable records that reuse the original files and duplicate
vectors to measure warm API query performance and relation size at 300, 3,000 and 10,000
candidate rows. The scale rows do not contribute to accuracy or photo ingestion measurements.

The loopback API run indexed 70 of 70 originals. The first became searchable 1.20 seconds
after attachment. The whole gallery was ready in 139.26 seconds, 132.32 seconds after the
last attachment. The worker sustained about 0.50 photos per second in this run. The encoder
was much faster in isolation. Durable dispatch and the serial worker cadence limit this
backfill rate. Original upload median and p95 were 28.63 and 37.03 ms.

The API returned the same top-1, top-5 and absent outcomes as the whole-image proxy. The
median and p95 round trip were 56.75 and 67.62 ms for text, and 80.62 and 95.75 ms for
photos. The photo-input upload, preparation and encoding portion measured 50.03 and
62.81 ms. Chromium showed no ordinary match for the omitted description, found annotated
evidence by text and by a separate exposure, opened the authorized photograph and observed
HTTP 204 for temporary input release.

| Scoped rows | Visual relation and index storage | Warm text HTTP, median / p95 |
| ---: | ---: | ---: |
| 70 real sources | 360,448 bytes | 56.75 / 67.62 ms |
| 300 scale rows | 1,097,728 bytes | 114.92 / 129.43 ms |
| 3,000 scale rows | 9,756,672 bytes | 308.60 / 328.37 ms |
| 10,000 scale rows | 32,186,368 bytes | 301.85 / 426.11 ms |

Each scale measurement uses 19 warm requests through the authorized exact-search route
with a result cap of 20. They measure loopback response times on the test host. The
Chromium screen limited its list to 10 rendered results at 10,000 ready rows. In three
queries after forced garbage collection, the JS heap measured 11.68–12.71 MiB before
and 12.14–12.69 MiB after rendering. A second set raised the real request's result limit
to 20 using Playwright and disabled service workers during request routing. At 10,000
ready rows, JavaScript heap for all 20 rendered results measured 11.65–11.87 MiB
before and 12.35–12.89 MiB afterward. These samples cover JavaScript allocations
in Chromium. iPhone WKWebView, image decoding, memory under sustained use and WAN
response times need separate measurements.
