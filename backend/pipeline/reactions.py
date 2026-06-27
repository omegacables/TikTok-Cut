"""テロップの反応分類: 「笑い(ｗ)」と「コメント読み上げ」を判定する。

- コメント読み上げ: 配信者が視聴者コメントを読んでいるテロップ（本文の言語的手がかりで判定）。
  ※「声のトーン」からの厳密抽出は、テロップが音声と単語整合していない＋日本語のピッチ
    アクセントの影響で不安定なので、テキストベースの LLM 分類で近似する（明示）。
- 笑い: テキストマーカー（草/ｗ/ははは 等）＋LLM 判定の併用。

LLM が使えない/失敗時は安全側（コメントなし、笑いはマーカーのみ）に倒す。
"""
from __future__ import annotations

import json
import re

from ..llm import provider

# 明示的な笑いのマーカー（これらを含むテロップは笑い扱い）
_LAUGH_RE = re.compile(
    r"(?:ｗｗ|ww|草|くさ|笑笑|\(笑\)|（笑）|ww+|ｗ+|"
    r"あは+|わは+|うは+|ぎゃは+|は{3,}|ハ{3,}|フフ+|ふふ+|げらげら|爆笑)"
)


def is_laugh_text(text: str) -> bool:
    return bool(_LAUGH_RE.search(str(text or "")))


def _build_prompt(items: list[dict]) -> str:
    payload = json.dumps(items, ensure_ascii=False)
    return f"""あなたは日本語ライブ配信のテロップ分類器です。各テロップについて2つを判定します。
voice tone は使えないので本文の言語的手がかりだけで判定してください。出力はJSONのみ。

is_comment=true（配信者が視聴者コメントを読み上げている）の手がかり:
- 「〜ってコメント(が)きた」「〜だって」「読みます」「コメントありがとう」等の引用・読み上げ明示
- 「〇〇さんから」「〜って書いてある」等、他者の発言を再生している
- カギ括弧/引用調で他者の発言を読んでいる
- 配信者自身のリアクション・実況・独り言・呼びかけは false。迷ったら false。

is_laugh=true（その瞬間に笑っている/爆笑している）の手がかり:
- 笑い声・笑い表現（ｗ, 草, ははは, あはは, 爆笑 等）、明らかに面白がっている発話
- 淡々とした内容は false。

入力は {{i, t, start}} の配列。JSONのみで
{{"items":[{{"i":<int>,"is_comment":<bool>,"is_laugh":<bool>}}]}} を返す（説明・コードフェンス禁止）。

--- 入力 ---
{payload}
"""


def classify(texts: list[str], starts: list[float], context: str = "") -> list[dict]:
    """各テロップの {is_comment, is_laugh} を返す（入力と同数）。失敗時は全 False。"""
    n = len(texts)
    base = [{"is_comment": False, "is_laugh": False} for _ in range(n)]
    if n == 0 or not any(t.strip() for t in texts):
        return base
    items = [{"i": i, "t": texts[i], "start": round(float(starts[i]), 2) if i < len(starts) else 0}
             for i in range(n)]
    try:
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "",
                     provider.generate_json(_build_prompt(items)).strip(),
                     flags=re.IGNORECASE | re.MULTILINE).strip()
        data = json.loads(raw)
        arr = data["items"] if isinstance(data, dict) and "items" in data else data
        for it in arr:
            if isinstance(it, dict) and "i" in it:
                k = int(it["i"])
                if 0 <= k < n:
                    base[k] = {"is_comment": bool(it.get("is_comment")),
                               "is_laugh": bool(it.get("is_laugh"))}
    except Exception as e:  # noqa: BLE001
        print(f"[reactions] 分類に失敗 → 反応なし ({type(e).__name__}: {e})", flush=True)
        return [{"is_comment": False, "is_laugh": False} for _ in range(n)]
    return base
