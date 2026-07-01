"""テンポ編集: クリップ内の不要部分を削り、ジャンプカットで詰める。

モード:
- off     : 何もしない（全区間キープ）
- silence : 無音・間延び（長い低音量）を削る
- content : LLM がクリップ内の「面白い/必要」な区間だけを残す
- both    : content の後に silence も適用

keep_segments() は「残す区間」をクリップ先頭基準の (a, b) 秒のリスト（昇順・非重複）で返す。
compress_words() は残す区間に合わせて字幕（単語）の時刻を詰め直す。
"""
from __future__ import annotations

import json
import re

from ..config import SETTINGS
from ..llm import provider
from . import audio
from .transcribe import Word


def _full(dur: float) -> list[tuple[float, float]]:
    return [(0.0, round(float(dur), 3))]


def _invert(cuts: list[tuple[float, float]], dur: float) -> list[tuple[float, float]]:
    """削除区間 cuts の補集合（残す区間）を返す。"""
    keeps: list[tuple[float, float]] = []
    cur = 0.0
    for a, b in sorted(cuts):
        a, b = max(0.0, a), min(dur, b)
        if a > cur + 0.05:
            keeps.append((round(cur, 3), round(a, 3)))
        cur = max(cur, b)
    if dur - cur > 0.05:
        keeps.append((round(cur, 3), round(dur, 3)))
    return keeps or _full(dur)


def _silence_keeps(times: list[float], db: list[float], clip_start: float, dur: float,
                   min_cut: float = 0.7, pad: float = 0.18) -> list[tuple[float, float]]:
    """区間内の無音（長い低音量）を削った残し区間。"""
    reg = [(t - clip_start, d) for t, d in zip(times, db)
           if clip_start <= t < clip_start + dur]
    if not reg:
        return _full(dur)
    rt = [t for t, _ in reg]
    rd = [d for _, d in reg]
    spans = audio.silence_spans(rt, rd, min_len=min_cut)
    cuts = []
    for a, b in spans:
        a2, b2 = a + pad, b - pad  # 切り口に少し余白を残す
        if b2 - a2 >= 0.25:
            cuts.append((a2, b2))
    return _invert(cuts, dur)


# 切りすぎ防止: トリム後はこの長さ以上＆元尺のこの割合以上を必ず残す
_MIN_KEEP_SEC = 10.0
_MIN_KEEP_RATIO = 0.55

_SENT_END = "。．!！?？"


def _units(words: list[Word], max_chars: int = 28, pause: float = 0.6) -> list[dict]:
    """単語列を「カットして自然な単位」に分割する（実際の単語境界を使う）。

    文末（。！？）／長い無音（pause 秒以上の間）／一定の長さ、で区切る。
    各単位の end は実際の最後の単語の end（字幕表示用の頭打ちを使わない＝語尾に食い込まない）。
    """
    units: list[dict] = []
    cur: list[Word] = []

    def flush() -> None:
        if cur:
            units.append({"start": cur[0].start, "end": cur[-1].end,
                          "text": "".join(w.text for w in cur)})
            cur.clear()

    for idx, w in enumerate(words):
        cur.append(w)
        txt = (w.text or "").strip()
        end_punct = bool(txt) and txt[-1] in _SENT_END
        gap_next = (words[idx + 1].start - w.end) if idx + 1 < len(words) else 99.0
        if end_punct or gap_next >= pause or sum(len(x.text) for x in cur) >= max_chars:
            flush()
    flush()
    return units


def _content_keeps(words: list[Word], dur: float, context: str) -> list[tuple[float, float]]:
    """発話を「単位（文）」に分け、LLM に“削ってよい単位”だけ選ばせる。

    単位は単語境界・文境界で作るので、発話の途中では切れない（ユーザー要望）。
    切りすぎ（前後が分からなくなる/10秒未満/元尺の55%未満）になる場合はカットしない。
    失敗時は全区間。
    """
    if not words:
        return _full(dur)
    units = [u for u in _units(words) if str(u.get("text", "")).strip()]
    if len(units) <= 2:
        return _full(dur)  # 単純/短いクリップは切らない

    listing = "\n".join(
        f"{i}: [{u['start']:.1f}-{u['end']:.1f}] {u['text']}" for i, u in enumerate(units)
    )
    prompt = f"""次は1本の短いクリップ（長さ {dur:.0f} 秒）を、発話の意味のまとまり（単位）で区切ったものです（番号: [開始-終了秒] テキスト）。{context}
TikTok 向けにテンポを上げるため、**削っても自然で前後の文脈が壊れない単位だけ**を remove に入れてください。
プロ編集の原則: 自動カットの最大の失敗は「切りすぎ・詰めすぎ」。これは粗い第一パスなので、**控えめ**に。

削ってよい単位（無くても話が完全に通じるものだけ）:
- 長い間延び・沈黙だけの単位
- 過剰な言い淀み（えー/あの/まあ 等）や言い直し・言いかけ（false start）。※全部ではなく明らかに過剰な分だけ
- 同じ内容の繰り返し・撮り直し的な重複（一番良い1回だけ残す）
- 冒頭の挨拶・自己紹介・「今日は〜」等の前置き
- 情報・笑い・感情のどれも足していない『死んだ』単位

絶対に削らない / 守る:
- **発話の途中では切らない**（単位は丸ごと残すか丸ごと削るかのみ。一部だけ削るのは禁止）。
- 冒頭の掴み（最初の単位）と、オチ・結論・パンチライン（最後の意味ある単位）は必ず残す。
- 削ると話が飛ぶ・前後が分からなくなる・脈絡が切れる単位は残す。**迷ったら残す。全体の6割以上は必ず残す**。
- テンポの良い掛け合いや、一続きの流れは分断しない。

各単位が「情報・笑い・感情のいずれかを足しているか」を自問し、足さない単位だけを remove に入れること。正当化できないカットは入れない。

出力は JSON のみ（説明や```は付けない）: {{"remove": [削ってよい単位の番号, ...]}}（無ければ {{"remove": []}}）

--- 発話単位 ---
{listing}
"""
    try:
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", provider.generate_json(prompt).strip(),
                     flags=re.IGNORECASE | re.MULTILINE)
        data = json.loads(raw)
        rem = data.get("remove") if isinstance(data, dict) else data
        remove = set()
        for x in (rem or []):
            try:
                i = int(x)
            except (TypeError, ValueError):
                continue
            if 0 <= i < len(units):
                remove.add(i)
    except Exception as e:  # noqa: BLE001
        print(f"[tempo] content 区間選定に失敗 → 全区間 ({type(e).__name__})", flush=True)
        return _full(dur)

    # 冒頭の掴み・最後のオチは保護（LLM が誤って消しても残す）
    remove.discard(0)
    remove.discard(len(units) - 1)
    if not remove:
        return _full(dur)

    # 残す単位を連続した「まとまり」に集約（first_idx, last_idx）。単位間の自然な間も保持。
    kept_idx = [i for i in range(len(units)) if i not in remove]
    runs: list[tuple[int, int]] = []
    for i in kept_idx:
        if runs and i == runs[-1][1] + 1:
            runs[-1] = (runs[-1][0], i)
        else:
            runs.append((i, i))

    # パディングは「隣接（削除）単位との無音の隙間」ぶんだけに制限。
    # 隙間が無ければ境界ぴったりで切る＝削る側の発話に食い込まない（jump cut を無音の中で行う）。
    out: list[tuple[float, float]] = []
    for first, last in runs:
        a = float(units[first]["start"])
        b = float(units[last]["end"])
        prev_end = float(units[first - 1]["end"]) if first > 0 else 0.0
        next_start = float(units[last + 1]["start"]) if last + 1 < len(units) else dur
        a2 = max(0.0, a - min(0.10, max(0.0, a - prev_end) * 0.5))
        b2 = min(dur, b + min(0.18, max(0.0, next_start - b) * 0.6))
        if b2 - a2 >= 1.0:
            out.append((round(a2, 3), round(b2, 3)))
    if not out:
        return _full(dur)

    # 切りすぎガード: 10秒未満 or 元尺の55%未満になるなら、無理に切らず全区間
    if total_kept(out) < max(_MIN_KEEP_SEC, dur * _MIN_KEEP_RATIO):
        return _full(dur)
    return out


def keep_segments(mode: str, *, clip_start: float, dur: float, words: list[Word],
                  loud_times: list[float] | None = None, loud_db: list[float] | None = None,
                  context: str = "") -> list[tuple[float, float]]:
    """モードに応じた残し区間を返す。"""
    mode = (mode or "off").lower()
    if mode == "off" or dur <= 0:
        return _full(dur)

    keeps = _full(dur)
    if mode in ("content", "both"):
        keeps = _content_keeps(words, dur, context)
    if mode in ("silence", "both") and loud_times:
        sil = _silence_keeps(loud_times, loud_db or [], clip_start, dur)
        keeps = _intersect(keeps, sil)
    # 全モード共通の最終ガード: 切りすぎ（最小秒数 or 元尺の _MIN_KEEP_RATIO 未満）なら切らない
    if is_trim(keeps, dur) and total_kept(keeps) < max(_MIN_KEEP_SEC, dur * _MIN_KEEP_RATIO):
        return _full(dur)
    return keeps


def _intersect(a: list[tuple[float, float]], b: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out = []
    for s1, e1 in a:
        for s2, e2 in b:
            s, e = max(s1, s2), min(e1, e2)
            if e - s >= 0.25:
                out.append((round(s, 3), round(e, 3)))
    return out or a


def total_kept(keeps: list[tuple[float, float]]) -> float:
    return round(sum(b - a for a, b in keeps), 3)


def is_trim(keeps: list[tuple[float, float]], dur: float) -> bool:
    """実際にカットが入るか（=全区間そのままでないか）。"""
    return not (len(keeps) == 1 and keeps[0][0] <= 0.05 and keeps[0][1] >= dur - 0.05)


def compress_words(words: list[Word], keeps: list[tuple[float, float]]) -> list[Word]:
    """残し区間に合わせて単語の時刻を詰め直す（削除区間の単語は除外）。"""
    out: list[Word] = []
    for w in words:
        mid = (w.start + w.end) / 2
        off = 0.0
        for a, b in keeps:
            if a <= mid <= b:
                ns = off + (max(a, w.start) - a)
                ne = off + (min(b, w.end) - a)
                out.append(Word(start=round(ns, 3), end=round(max(ns + 0.05, ne), 3), text=w.text))
                break
            off += b - a
    return out
