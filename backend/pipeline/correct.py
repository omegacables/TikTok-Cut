"""LLM による字幕（自動文字起こし）テキストの文脈補正。

Whisper の誤変換・ゲーム用語・口語を、意味を保ったまま読める日本語へ補正する。
**時刻は一切変更しない**（テロップ単位でテキストのみ直す）＝声とのズレを出さない。
補正は任意（既定OFF）。LLM が使えない／失敗した場合は原文をそのまま返す（安全）。
"""
from __future__ import annotations

import json
import re

from ..llm import provider


def _strip_fence(s: str) -> str:
    return re.sub(r"^```(?:json)?\s*|\s*```$", "", s.strip(), flags=re.IGNORECASE | re.MULTILINE).strip()


_SEGMENTER = None


def _ja_tokens(text: str) -> list[str] | None:
    """TinySegmenter で日本語を単語分割（句読点は別トークン）。未導入時は None。"""
    global _SEGMENTER
    try:
        import tinysegmenter

        if _SEGMENTER is None:
            _SEGMENTER = tinysegmenter.TinySegmenter()
        return [t for t in _SEGMENTER.tokenize(text) if t.strip()]
    except Exception:
        return None


def _build_prompt(texts: list[str], context: str) -> str:
    from . import lexicon

    items = "\n".join(f"{i}: {t}" for i, t in enumerate(texts))
    glossary = lexicon.correction_glossary()
    return f"""次は配信の自動文字起こしの断片です（{context}）。
各行を、話し言葉のニュアンス・意味を保ったまま、正しく自然な日本語に補正してください。

ルール:
- 明らかな誤変換・誤字・文法のみ直す。内容を足さない・要約しない・順序を変えない。
- **捏造禁止**: 入力に無い情報・固有名詞・文を新たに作らない。意味が通らない/聞き取れていない箇所は、
  無理に文章を“でっち上げず”、元の音に近い最小限の修正に留めるか、判断できなければ原文のまま残す。
- 同じ語の不自然な繰り返しや、文脈に合わない丸ごとの幻聴（実際には言っていない決まり文句等）は、
  自信が無ければ削るか原文のままにする（勝手に自然な文へ書き換えない）。
- 固有名詞 / ゲーム用語 / スラング / 略語は、その界隈で自然な表記にする。
- **方言・若者言葉・ネットスラング・口語はそのまま残す**（標準語や硬い言葉に直さない）。話者の話し方を変えない。
- **句読点**: 文の終わりには必ず句点「。」を付ける。疑問には「？」、感嘆には「！」を使う。
  読点「、」は息継ぎや意味の切れ目に入れる。これらは字幕の分割に使うので省略しない。
- 絵文字は付けない。
- 入力と同じ件数・同じ i を返す。

参考（この界隈で正しい表記の例。誤変換はこれらに寄せる）:
{glossary}

出力は JSON のみ: {{"items":[{{"i":0,"text":"補正後テキスト"}}]}}

--- 入力（{len(texts)}件）---
{items}
"""


def correct_texts(texts: list[str], context: str = "") -> list[str]:
    """テロップ（字幕）テキストだけを文脈補正する。時刻は変えない＝声とのズレが出ない。

    入力と同じ件数・同じ順で返す。失敗・欠落時は該当の原文を維持。
    """
    if not any(t.strip() for t in texts):
        return list(texts)
    try:
        raw = _strip_fence(provider.generate_json(_build_prompt(texts, context)))
        data = json.loads(raw)
        items = data["items"] if isinstance(data, dict) and "items" in data else data
        by_i: dict[int, str] = {}
        for it in items:
            if isinstance(it, dict) and "i" in it:
                by_i[int(it["i"])] = str(it.get("text", ""))
    except Exception as e:  # noqa: BLE001
        print(f"[correct] 字幕補正に失敗 → 原文維持 ({type(e).__name__}: {e})", flush=True)
        return list(texts)
    import difflib
    out: list[str] = []
    for i, t in enumerate(texts):
        c = by_i.get(i, "").strip()
        if not c:
            out.append(t)
            continue
        # 安全弁: 元と全く違う文へ「書き換え」られた行は採用しない（誤字補正のはずが
        # 別の台詞に化けるのを防ぐ）。短い行や数字・記号中心の行は比率がブレるため除外。
        orig = t.strip()
        if len(orig) >= 4 and difflib.SequenceMatcher(None, orig, c).ratio() < 0.5:
            out.append(t)
        else:
            out.append(c)
    return out
