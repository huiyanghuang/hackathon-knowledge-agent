"""
Thread-safe counters for LLM / embedding usage.

Gemini SDK returns `usage_metadata` on responses (prompt_token_count, candidates_token_count,
total_token_count). We record these directly when available, and fall back to char-based
heuristics when not (Gemini embed endpoint doesn't expose token counts cleanly).

Cost estimates use gemini-3.1-flash-lite + gemini-embedding-001 published rates (USD/1M tokens).
Snapshot is persisted to data/stats.json so counters survive restarts.
"""
import json
import os
from threading import Lock

from core.config import settings

# USD per 1M tokens (gemini-3.1-flash-lite paid tier as of 2026-05)
PRICE_LLM_INPUT = 0.10
PRICE_LLM_OUTPUT = 0.40
PRICE_EMBED = 0.15
# Heuristic when SDK doesn't return token count: ~2 chars per token for mixed Chinese/English
_CHARS_PER_TOKEN = 2.0

_STATS_FILE = os.path.join(os.path.dirname(settings.upload_path), "stats.json")

_lock = Lock()
_state = {
    "llm_calls": 0,
    "llm_input_tokens": 0,
    "llm_output_tokens": 0,
    "embed_calls": 0,
    "embed_chunks": 0,
    "embed_tokens_est": 0,
}


def _load():
    if os.path.exists(_STATS_FILE):
        try:
            with open(_STATS_FILE, encoding="utf-8") as f:
                loaded = json.load(f)
            for k in _state:
                if k in loaded:
                    _state[k] = int(loaded[k])
        except Exception:
            pass


def _persist():
    try:
        os.makedirs(os.path.dirname(_STATS_FILE), exist_ok=True)
        with open(_STATS_FILE, "w", encoding="utf-8") as f:
            json.dump(_state, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


_load()


def record_llm(input_tokens: int | None, output_tokens: int | None, prompt_text: str = "", reply_text: str = ""):
    """Record one LLM call. Falls back to char heuristic if token counts missing."""
    if input_tokens is None:
        input_tokens = int(len(prompt_text) / _CHARS_PER_TOKEN)
    if output_tokens is None:
        output_tokens = int(len(reply_text) / _CHARS_PER_TOKEN)
    with _lock:
        _state["llm_calls"] += 1
        _state["llm_input_tokens"] += input_tokens
        _state["llm_output_tokens"] += output_tokens
        _persist()


def record_embed(batch_texts: list[str]):
    """Record one embedding batch."""
    total_chars = sum(len(t) for t in batch_texts)
    est_tokens = int(total_chars / _CHARS_PER_TOKEN)
    with _lock:
        _state["embed_calls"] += 1
        _state["embed_chunks"] += len(batch_texts)
        _state["embed_tokens_est"] += est_tokens
        _persist()


def snapshot() -> dict:
    with _lock:
        s = dict(_state)
    cost_llm = (s["llm_input_tokens"] * PRICE_LLM_INPUT + s["llm_output_tokens"] * PRICE_LLM_OUTPUT) / 1_000_000
    cost_embed = s["embed_tokens_est"] * PRICE_EMBED / 1_000_000
    s["llm_total_tokens"] = s["llm_input_tokens"] + s["llm_output_tokens"]
    s["cost_llm_usd"] = round(cost_llm, 4)
    s["cost_embed_usd"] = round(cost_embed, 4)
    s["cost_total_usd"] = round(cost_llm + cost_embed, 4)
    return s


def reset():
    with _lock:
        for k in _state:
            _state[k] = 0
        _persist()
