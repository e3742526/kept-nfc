#!/usr/bin/env python3
"""serve.py's HTTP server with a stand-in model, for Kept's encoder contract test.

The request handling, host and header checks, size limits, text parsing and replies are
serve.py's own. Only the model is replaced: vectors are deterministic unit vectors derived from
the input, so the test needs neither PyTorch nor the checkpoint. Standard library only.

Usage: contract_server.py   (listens on an ephemeral loopback port and prints it)
"""

import hashlib
from pathlib import Path
import sys

# Leave no __pycache__ in the checkout.
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import serve  # noqa: E402


class StandInEncoder:
    def encode_text(self, body):
        return self.vector(b"text:" + serve.parse_text(body).encode("utf-8"))

    def encode_image(self, body):
        # serve.py decodes the JPEG with Pillow. The stand-in checks only its start and end markers.
        if not (body.startswith(b"\xff\xd8") and body.endswith(b"\xff\xd9")):
            raise serve.InvalidInput()
        return self.vector(b"image:" + body)

    def vector(self, seed):
        # One component set: a unit vector whose position depends on the input.
        index = int.from_bytes(hashlib.sha256(seed).digest()[:4], "big") % serve.DIMENSIONS
        return [1.0 if i == index else 0.0 for i in range(serve.DIMENSIONS)]


def main():
    with serve.EncoderServer(0, StandInEncoder()) as server:
        print(f"contract encoder ready on 127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
