#!/usr/bin/env python3
"""Exit 0 when the visual encoder on loopback serves Kept's expected generation.

The encoder binds 127.0.0.1 only, so an orchestrator can't probe it over the network. Docker's
HEALTHCHECK and the Helm chart's exec probes run this inside the encoder's network namespace.
"""

import json
import os
import sys
from urllib.request import Request, urlopen

GENERATION = "openclip-vit-b-32-laion2b-s34b-b79k-1a25a446-224-v1"
DIMENSIONS = 512


def main():
    port = int(os.environ.get("KEPT_VISUAL_ENCODER_PORT", "8798"))
    request = Request(f"http://127.0.0.1:{port}/v1/status", headers={"Accept": "application/json"})
    try:
        with urlopen(request, timeout=2) as response:
            status = json.load(response)
    except (OSError, ValueError):
        return 1
    ready = status == {"generation": GENERATION, "dimensions": DIMENSIONS}
    return 0 if ready else 1


if __name__ == "__main__":
    sys.exit(main())
