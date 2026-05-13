"""Thin wrapper around Gemini API. Single place to swap models."""
import time

import google.generativeai as genai

from core import stats
from core.config import settings

genai.configure(api_key=settings.gemini_api_key)


def _model() -> genai.GenerativeModel:
    return genai.GenerativeModel(settings.llm_model)


def _record_usage(resp, full: str, text: str):
    meta = getattr(resp, "usage_metadata", None)
    in_t = getattr(meta, "prompt_token_count", None) if meta else None
    out_t = getattr(meta, "candidates_token_count", None) if meta else None
    stats.record_llm(in_t, out_t, full, text)


def chat(prompt: str, system: str = "") -> str:
    """Single-turn call with retry on transient errors. Returns text."""
    full = f"{system}\n\n{prompt}" if system else prompt
    last_err: Exception | None = None
    for attempt in range(4):
        try:
            resp = _model().generate_content(full)
            text = resp.text.strip()
            _record_usage(resp, full, text)
            return text
        except Exception as e:
            last_err = e
            msg = str(e)
            if ("429" in msg or "503" in msg or "504" in msg) and attempt < 3:
                time.sleep(2 ** attempt)  # 1, 2, 4 s
                continue
            raise
    raise RuntimeError(f"chat failed after retries: {last_err}")


def multi_turn(messages: list[dict], system: str = "") -> str:
    """
    Multi-turn call with 30s per-attempt timeout + 1 retry.
    总耗时上限 ~62s，控制在 Cloudflare 100s 切断之前。
    messages: list of {"role": "user"|"model", "parts": [str]}
    """
    model = genai.GenerativeModel(settings.llm_model, system_instruction=system or None)
    history = messages[:-1]
    last = messages[-1]["parts"][0] if messages else ""

    last_err: Exception | None = None
    for attempt in range(2):
        try:
            gc = model.start_chat(history=history)
            resp = gc.send_message(last, request_options={"timeout": 30})
            text = resp.text.strip()
            _record_usage(resp, str(history) + last, text)
            return text
        except Exception as e:
            last_err = e
            msg = str(e).lower()
            if attempt == 0 and ("429" in msg or "503" in msg or "504" in msg or "timeout" in msg or "deadline" in msg):
                time.sleep(2)
                continue
            raise
    raise RuntimeError(f"multi_turn failed after retries: {last_err}")
