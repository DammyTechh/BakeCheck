# ─────────────────────────────────────────────────────────────────────────────
# BreadGuard AI — Python computer-vision service
#
# This service is INTERNAL. Do not publish its port. It expects to sit on a
# private network and to be reached only by the Node API, which presents a
# shared key.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: build the virtualenv ────────────────────────────────────────────
FROM python:3.12-slim-bookworm AS build

# Build tools are needed only to compile any wheel that lacks a prebuilt
# binary for this platform. They do not travel to the runtime image.
RUN apt-get -o Acquire::Retries=5 update \
 && apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
      build-essential \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# A virtualenv rather than --user: it copies forward as one self-contained
# directory with no dependency on the home directory layout.
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY services/ai/requirements.txt ./

# Only the runtime requirements. Test tooling lives in requirements-dev.txt and
# is deliberately not installed here — a server image has no business shipping
# a test runner.
#
# Three details, all of which exist because this step is ~130 MB of wheels
# (OpenCV, NumPy, SciPy, scikit-learn) and is the step most likely to fail on
# a slow or intermittent connection:
#
#   1. No `pip install --upgrade pip`. The base image ships a recent pip, so
#      upgrading downloads ~1.8 MB to gain nothing — and being the first
#      network operation in the build, it was the step that actually failed:
#        ReadTimeoutError: HTTPSConnectionPool(host='files.pythonhosted.org')
#
#   2. `--retries`/`--timeout` well above pip's defaults (5 and 15s), which
#      are tuned for a datacentre rather than a home connection.
#
#   3. A BuildKit cache mount for pip's download cache, and therefore NOT
#      `--no-cache-dir`. BuildKit only keeps *completed* layers, so without
#      this a timeout 120 MB into the download throws all of it away and the
#      next attempt starts from zero. With it, every wheel already fetched is
#      still there, so retrying resumes. The cache lives outside the image, so
#      this costs nothing in final size.
#
# The cache mount needs no `# syntax=` directive: Docker's built-in Dockerfile
# frontend has supported it for years, and adding the directive would make the
# build pull a frontend image first — another download on a connection that is
# already the problem.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --retries 10 --timeout 120 -r requirements.txt

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM python:3.12-slim-bookworm AS runtime

# opencv-python-headless still needs a few shared libraries at runtime even
# without GUI bindings.
RUN apt-get -o Acquire::Retries=5 update \
 && apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
      libglib2.0-0 \
      libgomp1 \
      tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --shell /usr/sbin/nologin --uid 10001 breadguard

COPY --from=build /opt/venv /opt/venv

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    # Keep OpenCV and NumPy to one thread each. The service runs several
    # analyses concurrently, and letting each one spawn a thread per core
    # oversubscribes the CPU and makes every request slower.
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1

WORKDIR /app

COPY --chown=breadguard:breadguard services/ai/app ./app
COPY --chown=breadguard:breadguard services/ai/requirements.txt ./

# Model artifacts land here. Mount a volume or use object storage in
# production — a container filesystem does not survive a redeploy.
RUN mkdir -p /app/artifacts && chown breadguard:breadguard /app/artifacts

USER breadguard

EXPOSE 8000

ENTRYPOINT ["/usr/bin/tini", "--"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD python -c "import urllib.request,os,sys; \
    sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('AI_PORT','8000')+'/health', timeout=4).status==200 else 1)"

# One worker per container. Scale by adding containers rather than workers:
# each worker loads its own copy of the model and OpenCV, so several in one
# container multiplies memory for no throughput gain on a CPU-bound workload.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${AI_PORT:-8000} --workers 1"]
