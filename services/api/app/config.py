from decimal import Decimal
from pathlib import Path
from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _read_secret_file(path_str: str | None) -> str | None:
    if not path_str:
        return None
    p = Path(path_str)
    if p.is_file():
        return p.read_text(encoding="utf-8").strip()
    return None


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    procureai_env: str = Field(default="development", alias="PROCUREAI_ENV")
    dev_auth_enabled: bool = Field(default=False, alias="PROCUREAI_DEV_AUTH_ENABLED")

    session_secret: str = Field(default="", alias="PROCUREAI_SESSION_SECRET")
    session_secret_file: str | None = Field(default=None, alias="PROCUREAI_SESSION_SECRET_FILE")

    database_app_url: str = Field(
        default="postgresql+psycopg://procureai_app:procureai_app_local_dev_pw_2026@db:5432/procureai",
        alias="DATABASE_APP_URL",
    )
    database_checkpoint_url: str = Field(
        default="postgresql://procureai_app:procureai_app_local_dev_pw_2026@db:5432/procureai?options=-c%20search_path%3Dlanggraph_checkpoints",
        alias="DATABASE_CHECKPOINT_URL",
    )
    database_owner_url: str = Field(default="", alias="DATABASE_OWNER_URL")
    database_checkpoint_owner_url: str = Field(default="", alias="DATABASE_CHECKPOINT_OWNER_URL")

    objectstore_endpoint: str = Field(default="http://objectstore:9000", alias="OBJECTSTORE_ENDPOINT")
    objectstore_root_user: str = Field(default="procureai_storage", alias="OBJECTSTORE_ROOT_USER")
    objectstore_root_password: str = Field(default="", alias="OBJECTSTORE_ROOT_PASSWORD")
    objectstore_bucket: str = Field(default="procureai-private-documents", alias="OBJECTSTORE_BUCKET")
    objectstore_region: str = Field(default="us-east-1", alias="OBJECTSTORE_REGION")

    openrouter_api_key: str = Field(default="", alias="OPENROUTER_API_KEY")
    openrouter_api_key_file: str | None = Field(default=None, alias="OPENROUTER_API_KEY_FILE")
    openrouter_base_url: str = Field(default="https://openrouter.ai/api/v1", alias="OPENROUTER_BASE_URL")
    openrouter_app_url: str = Field(default="http://localhost:3000", alias="OPENROUTER_APP_URL")
    openrouter_app_title: str = Field(default="ProcureAI", alias="OPENROUTER_APP_TITLE")

    openrouter_model_extraction: str = Field(
        default="deepseek/deepseek-v4.1-flash", alias="OPENROUTER_MODEL_EXTRACTION"
    )
    openrouter_model_decision: str = Field(
        default="typesafe/jev-router", alias="OPENROUTER_MODEL_DECISION"
    )
    openrouter_model_reasoning: str = Field(
        default="typesafe/jev-router", alias="OPENROUTER_MODEL_REASONING"
    )
    openrouter_model_vision: str = Field(
        default="deepseek/deepseek-v4.1-flash", alias="OPENROUTER_MODEL_VISION"
    )
    openrouter_model_fallback: str = Field(
        default="deepseek/deepseek-v4.1-flash", alias="OPENROUTER_MODEL_FALLBACK"
    )
    openrouter_jev_max_prompt_usd_per_m: float = Field(
        default=0.50, alias="OPENROUTER_JEV_MAX_PROMPT_USD_PER_M"
    )
    openrouter_jev_max_completion_usd_per_m: float = Field(
        default=1.50, alias="OPENROUTER_JEV_MAX_COMPLETION_USD_PER_M"
    )

    openrouter_data_collection: str = Field(default="deny", alias="OPENROUTER_DATA_COLLECTION")
    openrouter_require_zdr: bool = Field(default=True, alias="OPENROUTER_REQUIRE_ZDR")
    openrouter_require_parameters: bool = Field(default=True, alias="OPENROUTER_REQUIRE_PARAMETERS")
    openrouter_max_retries: int = Field(default=2, alias="OPENROUTER_MAX_RETRIES")
    openrouter_timeout_seconds: float = Field(default=45.0, alias="OPENROUTER_TIMEOUT_SECONDS")
    tenant_daily_ai_budget_usd: Decimal = Field(
        default=Decimal("5.00"), alias="PROCUREAI_TENANT_DAILY_AI_BUDGET_USD"
    )
    llm_cache_ttl_seconds: int = Field(default=86400, alias="PROCUREAI_LLM_CACHE_TTL_SECONDS")
    external_search_enabled: bool = Field(default=True, alias="PROCUREAI_EXTERNAL_SEARCH_ENABLED")
    tavily_api_key: str = Field(default="", alias="TAVILY_API_KEY")
    tavily_api_key_file: str | None = Field(default=None, alias="TAVILY_API_KEY_FILE")
    tavily_cost_per_credit_usd: Decimal = Field(
        default=Decimal("0.008000"), alias="PROCUREAI_TAVILY_COST_PER_CREDIT_USD"
    )
    tavily_cache_ttl_seconds: int = Field(
        default=43200, alias="PROCUREAI_TAVILY_CACHE_TTL_SECONDS"
    )
    # Optional SMTP configuration for real RFQ email sending (off unless host configured)
    smtp_host: str = Field(default="", alias="PROCUREAI_SMTP_HOST")
    smtp_port: int = Field(default=587, alias="PROCUREAI_SMTP_PORT")
    smtp_user: str = Field(default="", alias="PROCUREAI_SMTP_USER")
    smtp_password: str = Field(default="", alias="PROCUREAI_SMTP_PASSWORD")
    smtp_from_email: str = Field(default="", alias="PROCUREAI_SMTP_FROM_EMAIL")
    smtp_use_tls: bool = Field(default=True, alias="PROCUREAI_SMTP_USE_TLS")

    @model_validator(mode="after")
    def resolve_secrets_and_guard_production(self) -> "Settings":
        file_or_key = _read_secret_file(self.openrouter_api_key_file)
        if file_or_key:
            self.openrouter_api_key = file_or_key
        file_sess = _read_secret_file(self.session_secret_file)
        if file_sess:
            self.session_secret = file_sess
        file_tavily = _read_secret_file(self.tavily_api_key_file)
        if file_tavily:
            self.tavily_api_key = file_tavily

        if self.procureai_env.lower() == "production" and self.dev_auth_enabled:
            raise ValueError("PROCUREAI_DEV_AUTH_ENABLED cannot be true in production")
        return self


settings = Settings()
