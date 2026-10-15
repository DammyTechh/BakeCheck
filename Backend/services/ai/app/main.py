"""
BreadGuard AI — internal computer-vision service.

**Not publicly routable.** Every route under /internal requires the shared
`x-internal-key` header presented by the Node API. Deploy it on a private
network; the header is a second line of defence, not the only one.
"""
from __future__ import annotations

import asyncio
import logging
import secrets
import sys
import time
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.responses import JSONResponse

from .core.config import PIPELINE_VERSION, Settings, get_settings
from .models.registry import ModelRegistry
from .registry.artifacts import approve_artifact
from .schemas.analysis import (
    AnalyzeRequest,
    AnalyzeResponse,
    ModelInfoOut,
    ServiceStatusOut,
)
from .schemas.training import (
    ApproveModelRequest,
    ApproveModelResponse,
    TrainingRequest,
    TrainingResponse,
)
from .services.pipeline import AnalysisPipeline
from .services.training_service import run_training
from .vision.validation import ImageValidationError

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s | %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("breadguard.ai")

STARTED_AT = time.time()

# Caps concurrent analyses. OpenCV work is CPU-bound and runs in a thread
# pool, so admitting more requests than cores makes every one of them slower
# without improving throughput.
_analysis_semaphore: asyncio.Semaphore | None = None
_registry: ModelRegistry | None = None
_pipeline: AnalysisPipeline | None = None

# Training is serialised: one job at a time per process. A training run is
# CPU-heavy and long, and letting two overlap would starve the analysis
# endpoints that technicians are actively waiting on.
_training_lock: asyncio.Lock | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _analysis_semaphore, _registry, _pipeline, _training_lock

    settings = get_settings()
    _analysis_semaphore = asyncio.Semaphore(settings.max_concurrent_analyses)
    _training_lock = asyncio.Lock()
    _registry = ModelRegistry(settings.artifact_dir)
    _pipeline = AnalysisPipeline(_registry, settings)

    logger.info(
        "AI service starting | pipeline=%s model=%s validated=%s concurrency=%d",
        PIPELINE_VERSION,
        _registry.active.info.name,
        _registry.active.info.validated,
        settings.max_concurrent_analyses,
    )
    if not _registry.active.info.validated:
        logger.warning(
            "Operating in reference-matching prototype mode. No validated "
            "predictive model is loaded; results are screening estimates only."
        )

    yield

    logger.info("AI service shutting down")


def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title="BreadGuard AI — internal vision service",
        description=(
            "Internal service. Performs image validation, region detection, "
            "colour measurement and reference matching.\n\n"
            "**This service never returns a confirmed chemical measurement.** "
            "Its output is an image-derived screening estimate whose "
            "reliability depends on the test method, the reference data, the "
            "imaging conditions and the sample preparation."
        ),
        version=PIPELINE_VERSION,
        lifespan=lifespan,
        # Closed in production: these docs describe internal administration
        # routes and should not be reachable from outside.
        docs_url="/internal/docs" if settings.docs_enabled else None,
        redoc_url=None,
        openapi_url="/internal/openapi.json" if settings.docs_enabled else None,
    )

    @app.exception_handler(ImageValidationError)
    async def _image_validation_handler(
        _request: Request, exc: ImageValidationError
    ) -> JSONResponse:
        # 422: the request was well-formed, the image was not usable.
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={"code": exc.code, "message": exc.message},
        )

    return app


app = create_app()


async def require_internal_key(
    x_internal_key: Annotated[str | None, Header()] = None,
    settings: Settings = Depends(get_settings),
) -> None:
    """
    Authenticate the calling service.

    Compared with `secrets.compare_digest` so the check does not leak the key
    one byte at a time through response timing.
    """
    if not x_internal_key or not secrets.compare_digest(
        x_internal_key, settings.internal_key
    ):
        # Deliberately vague: an unauthenticated caller learns nothing about
        # whether the header was missing, malformed or simply wrong.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")


@app.get("/health", include_in_schema=False)
async def health() -> dict:
    """
    Liveness probe. Unauthenticated on purpose — load balancers and container
    orchestrators need it, and it discloses nothing.
    """
    return {"status": "ok", "pipeline_version": PIPELINE_VERSION}


@app.get(
    "/internal/v1/status",
    response_model=ServiceStatusOut,
    dependencies=[Depends(require_internal_key)],
)
async def service_status() -> ServiceStatusOut:
    """Active model, available artifacts and the current operating mode."""
    assert _registry is not None
    info = _registry.active.info

    return ServiceStatusOut(
        status="ok",
        pipeline_version=PIPELINE_VERSION,
        active_model=ModelInfoOut(
            name=info.name,
            version=info.version,
            validated=info.validated,
            model_type=info.model_type,
            dataset_version=info.dataset_version,
        ),
        available_models=_registry.list_available(),
        mode=(
            "reference_matching"
            if info.model_type == "REFERENCE_MATCHER"
            else "model_inference"
        ),
        uptime_seconds=round(time.time() - STARTED_AT, 2),
    )


@app.post(
    "/internal/v1/analyze",
    response_model=AnalyzeResponse,
    dependencies=[Depends(require_internal_key)],
)
async def analyze(request: AnalyzeRequest) -> AnalyzeResponse:
    """
    Run the vision pipeline on one image.

    An image rejected on quality grounds is **not** an error: the response
    comes back 200 with `status: "rejected_quality"`, the measurement intact
    and no prediction. The caller persists it like any other result.
    """
    assert _pipeline is not None and _analysis_semaphore is not None

    settings = get_settings()

    async with _analysis_semaphore:
        loop = asyncio.get_running_loop()
        try:
            # The pipeline is synchronous CPU work; running it in a thread
            # keeps the event loop responsive to health checks under load.
            return await asyncio.wait_for(
                loop.run_in_executor(None, _pipeline.run, request),
                timeout=settings.analysis_timeout_seconds,
            )
        except TimeoutError as exc:
            logger.error(
                "Analysis exceeded %.1fs | correlation=%s",
                settings.analysis_timeout_seconds,
                request.correlation_id,
            )
            raise HTTPException(
                status_code=status.HTTP_504_GATEWAY_TIMEOUT,
                detail="Analysis timed out",
            ) from exc
        except ImageValidationError:
            raise
        except Exception as exc:
            logger.exception(
                "Unhandled pipeline failure | correlation=%s", request.correlation_id
            )
            # Never surface the underlying exception text: it may contain
            # paths or payload fragments.
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Analysis failed",
            ) from exc


@app.post(
    "/internal/v1/train",
    response_model=TrainingResponse,
    dependencies=[Depends(require_internal_key)],
)
async def train(request: TrainingRequest) -> TrainingResponse:
    """
    Build a dataset, train a model, evaluate it, and write it to disk.

    **A refusal is a 200, not an error.** When the dataset cannot support
    training — too few examples, one class, no measured ground truth — the
    response comes back with `status: "refused"` and the reasons. "Not enough
    data yet" is the expected state of this system for a long time and must
    not read as a bug.

    **The resulting model is never active.** It is written with
    `approved: false`, and the registry refuses to load an unapproved
    artifact. Activation requires a separate, human approval.

    Training is serialised per process: one job at a time, so a long run
    cannot starve the analysis endpoints a technician is waiting on.
    """
    assert _training_lock is not None

    settings = get_settings()

    if _training_lock.locked():
        # Better to refuse immediately than to queue behind an unbounded wait
        # the caller cannot see.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A training job is already running on this instance.",
        )

    async with _training_lock:
        loop = asyncio.get_running_loop()
        try:
            # Training is synchronous CPU work; a thread keeps the event loop
            # answering health checks while it runs.
            return await loop.run_in_executor(
                None, run_training, request, settings.artifact_dir
            )
        except Exception as exc:
            logger.exception(
                "Unhandled training failure | correlation=%s", request.correlation_id
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Training failed",
            ) from exc


@app.post(
    "/internal/v1/models/approve",
    response_model=ApproveModelResponse,
    dependencies=[Depends(require_internal_key)],
)
async def approve_model(request: ApproveModelRequest) -> ApproveModelResponse:
    """
    Mark a trained artifact approved and load it as the active model.

    Called by the Node API only after a human with the `model:approve`
    capability has made the decision, and after the API has re-checked the
    release criteria server-side. This endpoint performs the mechanical part:
    flip the flag, verify the checksum, load the model.

    The checksum is re-verified here. An artifact that changed since it was
    written is either corrupt or was swapped, and loading it would defeat the
    integrity guarantee the registry provides.
    """
    assert _registry is not None

    settings = get_settings()

    try:
        metadata = approve_artifact(
            settings.artifact_dir,
            request.name,
            request.version,
            approved_by=request.approved_by,
            validated=request.validated,
        )
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No artifact found for {request.name} v{request.version}",
        ) from exc
    except ValueError as exc:
        # Checksum mismatch: refuse rather than load something unverified.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=str(exc)
        ) from exc

    loaded = _registry.load_model(
        request.name,
        request.version,
        expected_checksum=metadata.get("artifact_checksum"),
    )

    logger.info(
        "Model %s v%s approved by %s (validated=%s, loaded=%s) | correlation=%s",
        request.name,
        request.version,
        request.approved_by,
        request.validated,
        loaded,
        request.correlation_id,
    )

    return ApproveModelResponse(
        name=request.name,
        version=request.version,
        approved=True,
        validated=request.validated,
        loaded=loaded,
        message=(
            f"{request.name} v{request.version} is now the active model."
            if loaded
            else (
                "The artifact was approved but could not be loaded. The "
                "previous model remains active."
            )
        ),
    )


@app.post(
    "/internal/v1/models/reset",
    dependencies=[Depends(require_internal_key)],
)
async def reset_to_baseline() -> dict:
    """
    Revert to the transparent reference matcher.

    The rollback target of last resort: the baseline always exists, needs no
    artifact, and is always safe to return to.
    """
    assert _registry is not None
    _registry.reset_to_baseline()

    info = _registry.active.info
    return {
        "active_model": info.name,
        "version": info.version,
        "mode": "reference_matching",
        "message": "Reverted to transparent reference matching.",
    }
