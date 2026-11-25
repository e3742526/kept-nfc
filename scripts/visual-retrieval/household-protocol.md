# Household retrieval qualification protocol

Use this protocol before looking at retrieval results. The provisional criteria come from the
[approved design](../../docs/mvp1/design/nfc-software-design.docx). Preserve the distinction between a
public household-photo benchmark, an approved pilot inventory and physical iPhone acceptance.

| Cohort or measure | Provisional target |
| --- | --- |
| R11 clearly visible, distinctive items | Recall@5 at least 85% |
| R10 object descriptions absent from all inventory text | Recall@5 at least 75% |
| Crowded photographs, reported separately by modality | Recall@5 at least 70% |
| Labelled absent queries | At least 90% abstention from likely-match claims |
| Warm first-pass online search across 10,000 image/region vectors | p95 below 3 seconds |

Report raw rank and recall after applying the cutoff. Count a positive only if an annotated
source appears in the displayed results for that record. Score each modality separately.
Measure top-1, top-5, first correct rank, no-match precision and the rates of any returned
candidate and of likely claims on absent inputs. A query that returns ambiguous candidates
still counts as displaying an absent candidate, even when the interface withheld a likely claim.

## Data and controls

Use the three existing [feasibility sources](README.md) for exploratory checks and the
five-record COIL-20 gallery for tuning. Use independent public household photographs from
[Caltech Home Objects 2006](https://doi.org/10.22002/D1.20089) for the held-out proxy.
This corpus includes annotation-linked object views and scene photographs, with limits on
household, photographic and object diversity. Use it locally. Keep images and raw
annotations out of Git and run without an external inference service. No evidence from this
corpus substitutes for a physical workflow or proves general household accuracy.

Caltech's Test scenes represent stored photos. Train images provide independent object query
exposures. Merge model IDs that share an annotated box in any scene. Exclude all scenes known to
contain reserved absent objects. Label positive and absent IDs before inference. Treat images
with an annotated object in at least one other location as multiple acceptable locations when the
evidence ground truth supports it. Report a distinct crowded subset using multiple annotations
or a target occupying less than 15% of the image area. Exact annotated object regions may establish
ground truth and frame independent photo queries. Gallery image preprocessing and proposed
regions must never read these annotations.

Use a single neutral record name and distinct synthetic recorded paths per stored photo.
Use numbered source filenames, empty aliases, captions, categories, notes and documents.
Create text queries using the public photographs and annotation identities before scoring.
Include ordinary synonyms and semantically related negatives. Do not select prompts or
modify the ranking based on held-out results. A future model or cutoff selected using this run
requires a fresh hold-out.

## Compared variants and measurement

Use the pinned local generation and its released whole-image cutoffs and ambiguity margin.
As a bounded exploratory comparison, keep the full image and add four 60%-size, overlapping
corner crops, scoring a record by its best image region. Compare using the same fixed
cutoffs. Use whole-image ranking for photo search unless the measured evidence supports changing
it. For text, measure the delta in crowded recall and absent outcomes along with the extra
encoding work. A retrieval gain alone does not qualify a change that worsens abstention.
The omitted metadata baseline has no matching object terms by construction. Measure the actual
ordinary search API separately when claiming an end-to-end lexical or text-semantic result.

Record dataset hash, label set, model generation, query-level predictions and cohort metrics,
along with encoder median and p95 latency, elapsed time until ready, throughput, CPU, memory and
derived storage. Account separately for gallery preparation, network transport, encoding,
authorized database ranking, client rendering and total wall-clock time where each is measured.
Declare the index size and deployment in any latency claim. Repeated or synthetic vectors may
measure scale costs but may not count towards retrieval quality. Report the constraints of the
proxy and any tests missing before G3 is closed.
