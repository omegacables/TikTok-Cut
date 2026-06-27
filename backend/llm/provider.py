"""LLM プロバイダ抽象化。

Gemini を既定とし、OpenAI / Claude にも差し替え可能。いずれも「プロンプト→JSON文字列」を返す
単一インターフェイス `generate_json()` に統一する。キーが無い／SDK 未導入の場合は
`LLMUnavailable` を投げ、呼び出し側（highlight.py）が heuristic fallback に切り替える。

開発中の品質⇄コスト精査は、.env の LLM_PROVIDER / LLM_MODEL を変えるだけで切替できる。
"""
from __future__ import annotations

import time

from ..config import SETTINGS

# 一時的エラー（高負荷・レート）の判定キーワード → 短いバックオフでリトライ
_TRANSIENT = ("503", "unavailable", "overloaded", "high demand", "429",
              "rate", "resource_exhausted", "timeout", "deadline")


class LLMUnavailable(RuntimeError):
    """API キー未設定・SDK 未導入などで LLM を呼べない。"""


def _call(provider: str, prompt: str, temperature: float) -> str:
    if provider == "gemini":
        if SETTINGS.gemini_proxy_url:
            return _llm_proxy(prompt, temperature, "gemini")
        return _gemini(prompt, temperature)
    if provider == "openai":
        return _openai(prompt, temperature)
    if provider == "claude":
        if SETTINGS.gemini_proxy_url:
            return _llm_proxy(prompt, temperature, "claude")
        return _claude(prompt, temperature)
    raise LLMUnavailable(f"LLM provider '{provider}' は利用できません")


def generate_json(prompt: str, *, temperature: float = 0.4, retries: int = 2) -> str:
    """プロンプトを投げ JSON 文字列を返す。高負荷/レート等の一時エラーはリトライ。"""
    provider = SETTINGS.effective_provider()
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            return _call(provider, prompt, temperature)
        except LLMUnavailable:
            raise  # キー/SDK 不足は即 fallback（リトライ不要）
        except Exception as e:  # noqa: BLE001
            last = e
            msg = str(e).lower()
            is_quota_zero = "limit: 0" in msg  # 無料枠で不可なモデル等は回復しない
            if attempt < retries and not is_quota_zero and any(k in msg for k in _TRANSIENT):
                time.sleep(2.5 * (attempt + 1))
                continue
            raise
    raise last if last else RuntimeError("LLM 呼び出し失敗")


def _llm_proxy(prompt: str, temperature: float, provider: str | None = None) -> str:
    """プロキシ経由で LLM を呼ぶ（APIキー不要・キーはサーバー側に保持）。"""
    import json
    import urllib.request
    url = SETTINGS.gemini_proxy_url
    data = json.dumps({
        "provider": provider or SETTINGS.llm_provider,
        "model": SETTINGS.llm_model,
        "prompt": prompt,
        "temperature": temperature,
    }).encode("utf-8")
    req = urllib.request.Request(url, data=data,
                                headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace") if e.fp else str(e)
        raise RuntimeError(f"Gemini proxy error {e.code}: {err_body}") from e
    if body.get("error"):
        raise RuntimeError(f"Gemini proxy: {body['error']}")
    return body.get("text", "")


def _gemini(prompt: str, temperature: float) -> str:
    if not SETTINGS.gemini_api_key:
        raise LLMUnavailable("GEMINI_API_KEY が未設定")
    try:
        from google import genai
        from google.genai import types
    except Exception as e:  # SDK 未導入
        raise LLMUnavailable(f"google-genai 未導入: {e}") from e

    client = genai.Client(api_key=SETTINGS.gemini_api_key)
    resp = client.models.generate_content(
        model=SETTINGS.llm_model,
        contents=prompt,
        config=types.GenerateContentConfig(
            temperature=temperature,
            response_mime_type="application/json",
        ),
    )
    return resp.text or ""


def _openai(prompt: str, temperature: float) -> str:
    if not SETTINGS.openai_api_key:
        raise LLMUnavailable("OPENAI_API_KEY が未設定")
    try:
        from openai import OpenAI
    except Exception as e:
        raise LLMUnavailable(f"openai 未導入: {e}") from e

    client = OpenAI(api_key=SETTINGS.openai_api_key)
    resp = client.chat.completions.create(
        model=SETTINGS.llm_model,
        temperature=temperature,
        response_format={"type": "json_object"},
        messages=[{"role": "user", "content": prompt}],
    )
    return resp.choices[0].message.content or ""


def _claude(prompt: str, temperature: float) -> str:
    if not SETTINGS.anthropic_api_key:
        raise LLMUnavailable("ANTHROPIC_API_KEY が未設定")
    try:
        import anthropic
    except Exception as e:
        raise LLMUnavailable(f"anthropic 未導入: {e}") from e

    client = anthropic.Anthropic(api_key=SETTINGS.anthropic_api_key)
    msg = client.messages.create(
        model=SETTINGS.llm_model,
        max_tokens=4096,
        temperature=temperature,
        messages=[{"role": "user", "content": prompt + "\n\n必ず JSON のみを出力してください。"}],
    )
    parts = [b.text for b in msg.content if getattr(b, "type", None) == "text"]
    return "".join(parts)
