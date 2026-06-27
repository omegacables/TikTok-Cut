"""kotoba-whisper のテキストに、別モデルの実単語タイムスタンプを移植する（torch 不要）。

kotoba（蒸留モデル）は日本語テキストは優秀だが単語タイムスタンプを出さない。そこで small/base
など「単語時刻を出せる faster-whisper モデル」を"タイミング供与役(donor)"として別途走らせ、その実時刻を
kotoba のテキストへ移す。テキストは 100% kotoba のまま（時刻だけ差し替える）。

手法 v2（時間窓ベースマッチング）:
  ① 両者を文字ストリーム化（各語の[start,end]を文字数で内挿）。句読点・空白は照合ノイズになるため除外。
  ② 時間窓ベースで difflib マッチング（全体一括ではなく 20秒窓×10秒ステップの重複窓で実行）。
     → donor の信頼できる時刻で窓を作り、kotoba 側は drift を考慮して広めに取る。
     → 遠距離の偽マッチを防止し、アンカー密度を大幅に向上。
  ③ アンカーを「donor時刻が単調増加」する最長部分列(LIS)に限定（誤マッチ除去）。
  ④ 一致文字は donor 時刻を採用。アンカー間の未一致は線形補間（8秒以内）、
     超える区間は kotoba の synth 時刻にフォールバック。
  ⑤ 文字時刻を語へ再集約（テキストは kotoba のものをそのまま使う）。

依存は標準ライブラリの difflib のみ。失敗時は呼び出し側が synth へフォールバックする。
"""
from __future__ import annotations

import bisect
import difflib
from dataclasses import dataclass

_PUNC = set(" 　、。．,.!?！？・「」『』…ー~〜")


@dataclass
class _Word:
    start: float
    end: float
    text: str


def _strip(text: str) -> str:
    return "".join((text or "").split())


def _char_stream(words):
    """語列を (文字列, 各文字の中点時刻, 各文字が属する語index) に展開する（句読点は除外）。"""
    chars: list[str] = []
    times: list[float] = []
    owner: list[int] = []
    for wi, w in enumerate(words):
        t = _strip(getattr(w, "text", ""))
        if not t:
            continue
        s = float(getattr(w, "start", 0.0))
        e = float(getattr(w, "end", s))
        dur = max(1e-3, e - s)
        n = len(t)
        for j, ch in enumerate(t):
            if ch in _PUNC:
                continue
            chars.append(ch)
            times.append(s + dur * ((j + 0.5) / n))
            owner.append(wi)
    return "".join(chars), times, owner


def _lis_nondecreasing(pairs):
    """pairs=[(k_idx, d_time)]（k_idx 昇順）から d_time が非減少な最長部分列を返す。"""
    if not pairs:
        return []
    tails: list[float] = []
    tails_idx: list[int] = []
    prev = [-1] * len(pairs)
    for i, (_k, t) in enumerate(pairs):
        j = bisect.bisect_right(tails, t)
        if j == len(tails):
            tails.append(t)
            tails_idx.append(i)
        else:
            tails[j] = t
            tails_idx[j] = i
        prev[i] = tails_idx[j - 1] if j > 0 else -1
    out_idx: list[int] = []
    k = tails_idx[-1] if tails_idx else -1
    while k != -1:
        out_idx.append(k)
        k = prev[k]
    out_idx.reverse()
    return [pairs[i] for i in out_idx]


def _windowed_anchors(kstr, ktimes, dstr, dtimes, window=20.0, step=10.0):
    """時間窓ベースで文字マッチングし、アンカー候補を返す。

    donor の信頼できる時刻で窓を定義し、kotoba 側は drift を考慮して広めの窓で取る。
    重複窓の結果を統合し、先に見つかったマッチを優先（同一 kotoba 文字の重複排除）。
    """
    if not kstr or not dstr:
        return []
    max_t = max(dtimes[-1], ktimes[-1]) + 1.0
    margin = window * 0.5
    anchors: list[tuple[int, float]] = []
    seen_k: set[int] = set()

    t = 0.0
    while t < max_t:
        win_end = t + window
        d_sel = [(i, kk) for i, kk in enumerate(dstr) if t <= dtimes[i] < win_end]
        k_sel = [(i, kk) for i, kk in enumerate(kstr) if (t - margin) <= ktimes[i] < (win_end + margin)]
        if d_sel and k_sel:
            k_sub = "".join(ch for _, ch in k_sel)
            d_sub = "".join(ch for _, ch in d_sel)
            sm = difflib.SequenceMatcher(None, k_sub, d_sub, autojunk=False)
            for a, b, size in sm.get_matching_blocks():
                if size < 2:
                    continue
                for j in range(size):
                    ki = k_sel[a + j][0]
                    di = d_sel[b + j][0]
                    if ki not in seen_k:
                        seen_k.add(ki)
                        anchors.append((ki, dtimes[di]))
        t += step

    anchors.sort(key=lambda x: x[0])
    return anchors


def transfer_word_times(kotoba_words, donor_words, *, synth_fallback_gap: float = 8.0):
    """kotoba_words のテキストはそのまま、時刻を donor_words の実時刻で置換した語列を返す。

    kotoba_words: kotoba のテキスト＋synth 時刻（保持する語）。.start/.end/.text を持つ。
    donor_words:  実単語時刻を持つモデル（small/base 等）の語列。
    返り値: kotoba_words と同じ順・同じテキストで start/end を差し替えた _Word のリスト。
    """
    kwords = list(kotoba_words)
    if not kwords:
        return []
    if not donor_words:
        return [_Word(float(w.start), float(w.end), w.text) for w in kwords]

    kstr, ktimes, kowner = _char_stream(kwords)
    dstr, dtimes, _downer = _char_stream(donor_words)
    if not kstr or not dstr:
        return [_Word(float(w.start), float(w.end), w.text) for w in kwords]

    anchors = _windowed_anchors(kstr, ktimes, dstr, dtimes)
    anchors = _lis_nondecreasing(anchors)

    out_t = list(ktimes)
    if anchors:
        anchor_idx = [k for k, _t in anchors]
        anchor_time = {k: t for k, t in anchors}
        for k, t in anchors:
            out_t[k] = t
        for ci in range(len(kstr)):
            if ci in anchor_time:
                continue
            p = bisect.bisect_left(anchor_idx, ci)
            left = anchor_idx[p - 1] if p > 0 else None
            right = anchor_idx[p] if p < len(anchor_idx) else None
            if left is not None and right is not None:
                lt, rt = anchor_time[left], anchor_time[right]
                if (rt - lt) < synth_fallback_gap:
                    frac = (ci - left) / (right - left) if right != left else 0.0
                    out_t[ci] = lt + (rt - lt) * frac

    per_word_lo: dict[int, float] = {}
    per_word_hi: dict[int, float] = {}
    for ci, wi in enumerate(kowner):
        t = out_t[ci]
        if wi not in per_word_lo or t < per_word_lo[wi]:
            per_word_lo[wi] = t
        if wi not in per_word_hi or t > per_word_hi[wi]:
            per_word_hi[wi] = t

    result: list[_Word] = []
    for wi, w in enumerate(kwords):
        if wi in per_word_lo:
            s = per_word_lo[wi]
            e = max(s + 0.02, per_word_hi[wi])
        else:
            s = float(w.start)
            e = max(s + 0.02, float(w.end))
        result.append(_Word(round(s, 3), round(e, 3), w.text))

    for i in range(1, len(result)):
        if result[i].start < result[i - 1].start:
            result[i].start = result[i - 1].start
        if result[i].end < result[i].start + 0.02:
            result[i].end = round(result[i].start + 0.02, 3)
    return result
