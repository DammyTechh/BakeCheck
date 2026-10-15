"""Configuration for the AI service, from environment variables."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

PIPELINE_VERSION = "0.1.0"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    environment: str = Field(default="development", alias="NODE_ENV")
    port: int = Field(default=8000, alias="AI_PORT")
    log_level: str = Field(default="INFO", alias="AI_LOG_LEVEL")

    # Shared secret the Node API presents as `x-internal-key`. There is no
    # default: the service refuses to start without one, because an internal
    # service that accepts unauthenticated calls is worse than one that is down.
    internal_key: str = Field(alias="AI_INTERNAL_KEY", min_length=16)

    # FastAPI's own docs. Useful in development, closed in production — these
    # endpoints describe internal administration routes.
    docs_enabled: bool = Field(default=True, alias="AI_DOCS_ENABLED")

    artifact_dir: Path = Field(default=Path("./artifacts"), alias="AI_ARTIFACT_DIR")

    max_image_bytes: int = Field(default=10_485_760, alias="AI_MAX_IMAGE_BYTES")
    max_image_pixels: int = Field(default=50_000_000, alias="AI_MAX_IMAGE_PIXELS")

    # Caps concurrent analyses. OpenCV work is CPU-bound, so letting requests
    # pile up past the core count degrades every one of them.
    max_concurrent_analyses: int = Field(default=4, alias="AI_MAX_CONCURRENCY")

    # Per-request wall-clock budget. A pathological image must not hold a
    # worker indefinitely.
    analysis_timeout_seconds: float = Field(default=25.0, alias="AI_ANALYSIS_TIMEOUT")

    @field_validator("internal_key")
    @classmethod
    def _reject_placeholder(cls, value: str) -> str:
        placeholders = {
            "replace-with-openssl-rand-hex-32",
            "change-me",
            "changeme",
            "secret",
            "test",
        }
        if value.lower() in placeholders:
            raise ValueError(
                "AI_INTERNAL_KEY is still set to a placeholder. Generate one "
                "with: openssl rand -hex 32"
            )
        return value

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
