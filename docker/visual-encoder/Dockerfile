# The visual search encoder: scripts/visual-retrieval/serve.py with its pinned model, as an image.
# Build it from the repository root:
#
#   docker build -f docker/visual-encoder/Dockerfile -t sheepkeep-visual-encoder:local .
#
# It must share the Kept server's and worker's network namespace, because it answers only on
# 127.0.0.1 (compose.yaml's `visual` profile, or visualEncoder.enabled in the Helm chart). Kept
# reaches it at KEPT_VISUAL_ENCODER_URL=http://127.0.0.1:8798.
#
# The image holds everything the encoder reads: the hashed Python lock, CPU-only PyTorch and the
# checkpoint, verified against its SHA-256 at build time. At run time it makes no network requests
# and writes only to /tmp, as uid 10001 on a read-only root filesystem. Expect about 1.5 GB on disk
# and 600 MiB to 1.5 GiB of memory.
#
# The build uses no BuildKit-only syntax, so the legacy builder can build it too.

# python:3.12.16-slim-bookworm, pinned by its multi-arch index digest (read from Docker Hub,
# 2026-11-27).
ARG PYTHON_IMAGE=python:3.12.16-slim-bookworm@sha256:44cf1793efa7c7a476bb0f2cff81443f4a072c90c1cb127e2924933daa3e8c64

FROM ${PYTHON_IMAGE} AS weights
# The checkpoint generation VISUAL_GENERATION names (apps/server/src/visual-search/provider.ts):
# LAION-2B ViT-B/32 at a fixed Hugging Face revision, about 577 MiB. serve.py checks the same
# SHA-256 again before it loads the file.
ARG WEIGHTS_URL=https://huggingface.co/laion/CLIP-ViT-B-32-laion2B-s34B-b79K/resolve/1a25a446712ba5ee05982a381eed697ef9b435cf/open_clip_model.safetensors
ARG WEIGHTS_SHA256=ac4f8c4b88af6d963118cbf40ad93176d092abbedfcb752601ae1866352656e6
COPY docker/visual-encoder/fetch-weights.py /tmp/fetch-weights.py
RUN python /tmp/fetch-weights.py "$WEIGHTS_URL" "$WEIGHTS_SHA256" /weights/open_clip_model.safetensors

FROM ${PYTHON_IMAGE} AS deps
COPY docker/visual-encoder/requirements.lock /tmp/requirements.lock
# Hash-checked wheels only: nothing is built from source, and nothing unlisted is installed.
RUN python -m venv /opt/encoder/venv \
 && /opt/encoder/venv/bin/pip install --no-cache-dir --disable-pip-version-check \
      --require-hashes --only-binary=:all: --no-deps \
      --index-url https://download.pytorch.org/whl/cpu \
      --extra-index-url https://pypi.org/simple \
      -r /tmp/requirements.lock

FROM ${PYTHON_IMAGE}
ARG REVISION=
ARG SOURCE=https://github.com/e3742526/kept-nfc
LABEL org.opencontainers.image.title="SheepKeep visual encoder" \
      org.opencontainers.image.description="OpenCLIP ViT-B/32 image and text encoder for SheepKeep's visual search, served on loopback" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="${SOURCE}" \
      org.opencontainers.image.revision="${REVISION}"

COPY --from=deps /opt/encoder/venv /opt/encoder/venv
COPY --from=weights /weights/open_clip_model.safetensors /opt/encoder/open_clip_model.safetensors
COPY scripts/visual-retrieval/serve.py docker/visual-encoder/healthcheck.py /opt/encoder/
RUN useradd --system --uid 10001 --user-group --no-create-home --home-dir /tmp encoder \
 && chmod -R a+rX /opt/encoder

# HOME and the caches point at /tmp, the only writable path. HF_HUB_OFFLINE keeps the model
# libraries from reaching the network; serve.py sets it too.
ENV PATH=/opt/encoder/venv/bin:$PATH \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    HF_HUB_OFFLINE=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    KEPT_VISUAL_ENCODER_PORT=8798

USER 10001:10001
WORKDIR /tmp
# Loading the model takes a few seconds, more on a small machine.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD ["python", "/opt/encoder/healthcheck.py"]
CMD ["sh", "-c", "exec python /opt/encoder/serve.py --weights /opt/encoder/open_clip_model.safetensors --port \"$KEPT_VISUAL_ENCODER_PORT\""]
