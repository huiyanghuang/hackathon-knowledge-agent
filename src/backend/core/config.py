import os
from pydantic_settings import BaseSettings, SettingsConfigDict

# 向上查找 .env，支持从任意子目录启动
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.normpath(os.path.join(_HERE, "..", "..", ".."))
_ENV_FILE = os.path.join(_ROOT, ".env")


class Settings(BaseSettings):
    gemini_api_key: str = ""
    llm_model: str = "gemini-3.1-flash-lite"

    chroma_path: str = os.path.join(_ROOT, "data", "chroma")
    upload_path: str = os.path.join(_ROOT, "data", "textbooks")

    compression_ratio: float = 0.30
    align_threshold_high: float = 0.88
    align_threshold_low: float = 0.70

    model_config = SettingsConfigDict(env_file=_ENV_FILE, env_file_encoding="utf-8")


settings = Settings()
