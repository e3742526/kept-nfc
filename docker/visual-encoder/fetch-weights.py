#!/usr/bin/env python3
"""Download the encoder checkpoint and refuse it unless its SHA-256 is the pinned one.

Usage: fetch-weights.py <url> <sha256> <target>   (the image build's `weights` stage)
"""

import hashlib
import shutil
import sys
from pathlib import Path
from urllib.request import urlopen


def main():
    url, expected, target = sys.argv[1], sys.argv[2], Path(sys.argv[3])
    target.parent.mkdir(parents=True, exist_ok=True)
    with urlopen(url, timeout=120) as response, target.open("wb") as out:
        shutil.copyfileobj(response, out, 1024 * 1024)
    with target.open("rb") as checkpoint:
        actual = hashlib.file_digest(checkpoint, "sha256").hexdigest()
    if actual != expected:
        target.unlink()
        sys.exit(f"checkpoint SHA-256 {actual} is not the pinned {expected}")
    print(f"checkpoint verified: {target.stat().st_size} bytes, SHA-256 {actual}")


if __name__ == "__main__":
    main()
