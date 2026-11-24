#!/usr/bin/env python3
"""Evaluate the pinned encoder on independently photographed public household fixtures."""

import argparse
from collections import defaultdict
import hashlib
from io import BytesIO
import json
from pathlib import Path
import platform
import re
from time import perf_counter
from urllib.error import HTTPError
from urllib.request import build_opener, HTTPRedirectHandler, ProxyHandler, Request
from zipfile import ZipFile

import numpy as np
from PIL import Image, ImageOps
from scipy.io import loadmat

from serve import DIMENSIONS, GENERATION

ARCHIVE_SHA256 = "29b05bfa04627a037e671685454ca10f7ba8cdb075c82438cdc872f1dfd2fa20"
DATASET = "https://doi.org/10.22002/D1.20089"
DEFINITIONS = Path(__file__).with_name("household-text.json")
TEXT_CUTOFF = 0.20
PHOTO_CUTOFF = 0.58
AMBIGUITY_MARGIN = 0.035
ROOT = "Home_Objects_06"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, new_url):
        raise HTTPError(req.full_url, code, msg, headers, fp)


class Encoder:
    def __init__(self, port):
        self.origin = f"http://127.0.0.1:{port}"
        self.http = build_opener(ProxyHandler({}), NoRedirect())
        status = self.call("/v1/status")
        if status != {"generation": GENERATION, "dimensions": DIMENSIONS}:
            raise ValueError("Unexpected encoder generation")

    def call(self, path, body=None, content_type=None):
        headers = {"X-Kept-Visual-Generation": GENERATION}
        if content_type:
            headers["Content-Type"] = content_type
        req = Request(self.origin + path, data=body, headers=headers)
        with self.http.open(req, timeout=30) as response:
            return json.load(response)

    def encode(self, kind, body, content_type):
        start = perf_counter()
        reply = self.call(f"/v1/encode/{kind}", body, content_type)
        elapsed = (perf_counter() - start) * 1000
        vector = np.array(reply["vector"], dtype=np.float32)
        if (
            reply["generation"] != GENERATION or reply["dimensions"] != DIMENSIONS
            or vector.shape != (DIMENSIONS,) or not np.isfinite(vector).all()
            or abs(np.linalg.norm(vector) - 1) > 0.001
        ):
            raise ValueError("Unexpected encoder output")
        return vector, elapsed

    def image(self, image):
        with BytesIO() as output:
            image.save(output, "JPEG", quality=85)
            return self.encode("image", output.getvalue(), "image/jpeg")

    def text(self, text):
        return self.encode("text", json.dumps({"text": text}).encode(), "application/json")


class Corpus:
    def __init__(self, archive):
        self.archive = archive
        self.train = self.files("Train")
        scenes = {name: self.boxes(name) for name in self.files("Test")}
        parents = {name: name for name in self.train}

        def instance(name):
            while parents[name] != name:
                name = parents[name]
            return name

        # Every label at a given polygon identifies the same physical instance.
        for boxes in scenes.values():
            for aliases in boxes.values():
                roots = {instance(name) for name in aliases}
                root = min(roots)
                for name in roots:
                    parents[name] = root

        self.aliases = {name: instance(name) for name in self.train}
        instances = sorted(set(self.aliases.values()))
        self.absent = set(instances[::5])
        self.gallery = {}
        for name, boxes in scenes.items():
            objects = {
                coordinates: {instance(alias) for alias in aliases}
                for coordinates, aliases in boxes.items()
            }
            labelled = set().union(*objects.values())
            if labelled and not labelled & self.absent:
                self.gallery[name] = objects

        if not self.gallery or not self.absent:
            raise ValueError("The gallery and absent cohort both require labels")

    def files(self, split):
        return sorted(
            Path(name).stem
            for name in self.archive.namelist()
            if name.startswith(f"{ROOT}/{split}/") and name.endswith(".JPG")
        )

    def boxes(self, name):
        mat = self.archive.read(f"{ROOT}/Test/Gtruth/{name}.JPG.mat")
        outline = loadmat(BytesIO(mat), simplify_cells=True)["outline"]
        boxes = defaultdict(set)
        for row in outline if isinstance(outline, list) else [outline]:
            if isinstance(row, dict):
                polygon = tuple(float(value) for value in row["vertices"].flat)
                boxes[polygon].add(Path(row["name"]).stem)
        return boxes

    def image(self, split, name):
        with Image.open(BytesIO(self.archive.read(f"{ROOT}/{split}/{name}.JPG"))) as original:
            image = ImageOps.exif_transpose(original).convert("RGB")
        image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
        return image


def region_crops(image):
    width, height = image.size
    crop_width, crop_height = round(0.6 * width), round(0.6 * height)
    for x, y in ((0, 0), (width - crop_width, 0), (0, height - crop_height),
                 (width - crop_width, height - crop_height)):
        yield image.crop((x, y, x + crop_width, y + crop_height))


def occupied_fraction(polygon, width, height):
    x = np.clip(polygon[::2], 0, width)
    y = np.clip(polygon[1::2], 0, height)
    area = abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1))) / 2
    return float(area / (width * height))


def relevance(corpus, sizes, targets):
    expected = {}
    for name, boxes in corpus.gallery.items():
        fractions = [
            occupied_fraction(polygon, *sizes[name])
            for polygon, instances in boxes.items() if instances & targets
        ]
        if fractions:
            expected[name] = "crowded" if len(boxes) > 1 or max(fractions) < 0.15 else "distinctive"
    return expected


def rank_query(query, expected, embedding, index, cutoff):
    vector, elapsed = embedding
    scores = np.max(index @ vector, axis=1)
    order = np.argsort(-scores, kind="stable")
    returned = order[scores[order] >= cutoff]
    if not len(returned):
        outcome = "no_close_match"
    elif len(returned) > 1 and scores[returned[0]] - scores[returned[1]] < AMBIGUITY_MARGIN:
        outcome = "ambiguous"
    else:
        outcome = "matches"
    weak = outcome == "matches" and scores[returned[0]] < cutoff + AMBIGUITY_MARGIN
    return {
        "query": query,
        "expected": expected,
        "raw_first_correct_rank": next(
            (i for i, item in enumerate(order, 1) if int(item) in expected), None
        ),
        "top5": [
            {"record": int(item), "cosine": round(float(scores[item]), 4)}
            for item in order[:5]
        ],
        "displayed_top5": [int(item) for item in returned[:5]],
        "outcome": outcome,
        "outcome_with_weak": "weak" if weak else outcome,
        "encoder_ms": round(elapsed, 2),
    }


def latency(values):
    return {
        name: round(float(np.percentile(values, percentile)), 2)
        for name, percentile in (("p50_ms", 50), ("p95_ms", 95), ("max_ms", 100))
    }


def score(rows, cohort=None):
    def relevant(row):
        return {record for record, group in row["expected"].items() if not cohort or group == cohort}

    positive = [(row, relevant(row)) for row in rows if relevant(row)]
    absent = [row for row in rows if not row["expected"]]
    no_match = [row for row in rows if row["outcome"] == "no_close_match"]
    def count_at(n):
        return sum(bool(set(row["displayed_top5"][:n]) & target) for row, target in positive)

    result = {"positive": len(positive), "top1": count_at(1), "top5": count_at(5)}
    if cohort is None:
        result.update({
            "raw_top1": sum(row["raw_first_correct_rank"] == 1 for row, _ in positive),
            "raw_top5": sum(row["raw_first_correct_rank"] <= 5 for row, _ in positive),
            "mean_reciprocal_rank": round(sum(
                1 / row["raw_first_correct_rank"] for row, _ in positive
            ) / len(positive), 4),
            "absent": len(absent),
            "absent_with_any_result": sum(row["outcome"] != "no_close_match" for row in absent),
            "absent_with_likely_match": sum(row["outcome"] == "matches" for row in absent),
            "absent_with_likely_match_using_weak": sum(
                row["outcome_with_weak"] == "matches" for row in absent
            ),
            "weak": sum(row["outcome_with_weak"] == "weak" for row in rows),
            "no_match_correct": sum(not row["expected"] for row in no_match),
            "no_match_total": len(no_match),
            "ambiguous": sum(row["outcome"] == "ambiguous" for row in rows),
            "encoder_latency": latency([row["encoder_ms"] for row in rows]),
        })
    return result


def evaluate(corpus, sidecar):
    gallery = list(corpus.gallery)
    ids = {name: index for index, name in enumerate(gallery)}
    sizes = {}
    vectors = []
    whole_elapsed = []
    region_elapsed = []
    started = perf_counter()
    for name in gallery:
        image = corpus.image("Test", name)
        sizes[name] = image.size
        vector, elapsed = sidecar.image(image)
        whole_elapsed.append(elapsed)
        images = [vector]
        for region in region_crops(image):
            vector, elapsed = sidecar.image(region)
            images.append(vector)
            region_elapsed.append(elapsed)
        vectors.append(images)
    wall_ms = (perf_counter() - started) * 1000
    index = np.array(vectors, dtype=np.float32)
    whole = index[:, :1]
    whole_text, region_text, whole_photo = [], [], []

    known = set().union(*(set().union(*boxes.values()) for boxes in corpus.gallery.values()))
    fixture_metadata = ["Household", "Recorded contents"] + [f"Bay {i + 1:03}" for i in ids.values()]
    searchable_words = set(re.findall(r"\w+", " ".join(fixture_metadata + ["jpg"]).casefold()))
    for query, names in json.loads(DEFINITIONS.read_text(encoding="utf-8")):
        missing = set(names) - known
        if missing:
            raise ValueError(f"Unresolved text targets for {query!r}: {sorted(missing)}")
        if searchable_words & set(re.findall(r"\w+", query.casefold())):
            raise ValueError(f"Query appears in fixture metadata: {query!r}")
        expected = {ids[name]: group for name, group in relevance(corpus, sizes, set(names)).items()}
        encoded = sidecar.text(query)
        whole_text.append(rank_query(query, expected, encoded, whole, TEXT_CUTOFF))
        region_text.append(rank_query(query, expected, encoded, index, TEXT_CUTOFF))

    for name in sorted(known | corpus.absent):
        expected = {ids[key]: group for key, group in relevance(corpus, sizes, {name}).items()}
        encoded = sidecar.image(corpus.image("Train", name))
        whole_photo.append(rank_query(name, expected, encoded, whole, PHOTO_CUTOFF))

    variants = {"text_full": whole_text, "text_regions": region_text, "photo_full": whole_photo}
    return {
        "dataset": DATASET,
        "corpus_sha256": ARCHIVE_SHA256,
        "omission_control": "Object query words absent from all searchable fixture metadata",
        "protocol_sha256": hashlib.sha256(Path(__file__).with_name(
            "household-protocol.md"
        ).read_bytes()).hexdigest(),
        "text_manifest_sha256": hashlib.sha256(DEFINITIONS.read_bytes()).hexdigest(),
        "model_and_generation": GENERATION,
        "host": platform.platform(),
        "score_cutoffs": {"text": TEXT_CUTOFF, "photo": PHOTO_CUTOFF, "ambiguity": AMBIGUITY_MARGIN},
        "index": {
            "eligible_photos": len(gallery),
            "indexed_photos": whole.shape[0],
            "bytes_float32": whole.nbytes,
            "bytes_with_regions_float32": index.nbytes,
            "encode_full_ms": round(sum(whole_elapsed), 2),
            "encode_regions_extra_ms": round(sum(region_elapsed), 2),
            "full_encoder_images_per_second": round(1000 * len(whole_elapsed) / sum(whole_elapsed), 2),
            "full_plus_regions_wall_ms": round(wall_ms, 2),
            "gallery": {
                ids[name]: {"capture": name, "record": fixture_metadata[1], "path": fixture_metadata[2 + ids[name]]}
                for name in gallery
            },
        },
        "metrics": {mode: {
            "all": score(rows),
            "crowded": score(rows, "crowded"),
            "distinctive": score(rows, "distinctive"),
        } for mode, rows in variants.items()},
        "queries": variants,
    }


def write_fixtures(archive, result, directory):
    directory.mkdir(parents=True)
    for record, source in result["index"]["gallery"].items():
        photo = archive.read(f"{ROOT}/Test/{source['capture']}.JPG")
        (directory / f"stored-{record}.jpg").write_bytes(photo)
    for index, row in enumerate(result["queries"]["photo_full"]):
        photo = archive.read(f"{ROOT}/Train/{row['query']}.JPG")
        (directory / f"input-{index}.jpg").write_bytes(photo)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8798)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--fixture-dir", type=Path, help="New local directory for disposable Kept")
    options = parser.parse_args()
    with options.archive.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != ARCHIVE_SHA256:
            parser.error("Caltech archive does not match the pinned fixture digest")
    with ZipFile(options.archive) as archive:
        result = evaluate(Corpus(archive), Encoder(options.port))
        if options.fixture_dir:
            write_fixtures(archive, result, options.fixture_dir)
    options.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
