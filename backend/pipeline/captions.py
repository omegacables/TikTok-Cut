r"""字幕（テロップ）を ASS で生成する。

- 静的表示（カラオケ無し）。1テロップ＝1〜2行を、その発話区間だけ表示。
- 日本語はスペースが無く libass が自動折返しできないため、フォント幅から1行最大文字数を
  算出し `\N` で手動折返し（はみ出し防止）。「。！？」で次テロップ、「、」で改行。
- 編集単位は「テロップ」= {start, end, text, (style)}。`segment()` で words → telops、
  `build_ass(telops=...)` で telops → ASS。手動修正UIはこの telops を編集して再描画する。
- style="alert" のテロップは Twitch 風アラート様式（上部バナー・別色・背景ボックス）で表示。
"""
from __future__ import annotations

from pathlib import Path

from ..config import OUTPUT_H, OUTPUT_W, SETTINGS, CaptionStyle, TitleStyle
from .transcribe import Word

_WIDTH_RATIO = 0.66


def _max_chars(font_size: int) -> int:
    return max(6, int(OUTPUT_W * _WIDTH_RATIO / max(1, font_size)))


def _ass_color(hex_color: str) -> str:
    h = hex_color.lstrip("#")
    if len(h) != 6:
        h = "FFFFFF"
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H00{b}{g}{r}".upper()


def _escape(text: str) -> str:
    return text.replace("\\", "／").replace("{", "(").replace("}", ")").strip()


def _t(sec: float) -> str:
    cs = int(round(max(0.0, sec) * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h:d}:{m:02d}:{s:02d}.{cs:02d}"


def _dialogue(start: float, end: float, style: str, lines: list[str], override: str = "",
              layer: int = 0) -> str:
    text = "\\N".join(_escape(ln) for ln in lines if ln.strip())
    # override は ASS の {\...} タグ（ポップイン演出等）。_escape を通さず先頭に付ける。
    # layer が大きいほど前面（glow 背面層は layer 0、文字は layer 1）。
    return f"Dialogue: {layer},{_t(start)},{_t(end)},{style},,0,0,0,,{override}{text}"


def _display_telops(telops: list[dict], clip_duration: float) -> list[dict]:
    """焼き込み時だけ字幕の表示時間を少し延ばす。

    Whisper の単語時刻どおりだと短い発話が一瞬で消え、動画上では「字幕が少ない」
    ように見える。編集データの時刻は変えず、ASS 出力時だけ自然な範囲で延長する。
    """
    ordered = sorted((dict(tp) for tp in telops), key=lambda tp: float(tp.get("start", 0)))
    out: list[dict] = []
    for i, tp in enumerate(ordered):
        try:
            s = max(0.0, min(clip_duration, float(tp.get("start", 0))))
            e = max(s + 0.2, min(clip_duration, float(tp.get("end", s + 0.2))))
        except (TypeError, ValueError):
            continue
        next_s = clip_duration
        if i + 1 < len(ordered):
            try:
                next_s = max(s, min(clip_duration, float(ordered[i + 1].get("start", clip_duration))))
            except (TypeError, ValueError):
                next_s = clip_duration
        min_end = s + 1.35
        max_end = e + 2.6
        target = max(e, min_end)
        if next_s - e <= 2.8:
            target = max(target, next_s - 0.05)
        tp["start"] = round(s, 3)
        tp["end"] = round(max(s + 0.2, min(clip_duration, next_s - 0.05, max_end, target)), 3)
        out.append(tp)
    return out


# ポップイン演出（animate=True 時に各種テロップへ付与する ASS override）
_ANIM_TITLE = r"{\fad(220,0)\fscx72\fscy72\t(0,230,\fscx100\fscy100)}"
_ANIM_HOOK = r"{\fad(140,90)\fscx55\fscy55\t(0,200,\fscx108\fscy108)\t(200,260,\fscx100\fscy100)}"
_ANIM_CAPTION = r"{\fad(110,60)\fscx94\fscy94\t(0,120,\fscx100\fscy100)}"
_ANIM_ALERT = r"{\fad(120,80)}"
# 強調テロップ（中央・大）は常にインパクトのあるバウンスインで出す
_ANIM_EMPH = r"{\fad(100,80)\fscx50\fscy50\t(0,170,\fscx113\fscy113)\t(170,280,\fscx100\fscy100)}"
# 笑い「ｗｗｗ」テロップ（弾けて出る・少し揺れる）
_ANIM_LAUGH = r"{\fad(80,120)\fscx40\fscy40\frz-8\t(0,150,\fscx118\fscy118\frz6)\t(150,300,\fscx100\fscy100\frz0)}"

# ── 文字アニメーション（出現の動き）。UIの選択名 → ASS override（{}込み・全種別共通）。
# libass で素直に描けるものを採用。per-char ウェーブは行全体の回転ゆらぎで近似する。
_ANIM_NAMED = {
    "none": "",
    "fade": r"{\fad(260,140)}",
    "pop": r"{\fad(110,60)\fscx80\fscy80\t(0,150,\fscx100\fscy100)}",
    "bounce": r"{\fad(90,70)\fscx55\fscy55\t(0,160,\fscx113\fscy113)\t(160,280,\fscx100\fscy100)}",
    "slide": r"{\fad(180,120)\fax0.7\t(0,220,\fax0)}",        # 横シアで滑り込み（パン）
    "wipe": r"{\fad(80,80)\fscx0\t(0,240,\fscx100)}",         # 横方向に開くワイプ
    "breathe": r"{\fad(160,120)\fscx103\fscy103\t(0,650,\fscx98\fscy98)\t(650,1300,\fscx102\fscy102)}",
    "wave": r"{\fad(120,90)\frz-5\t(0,170,\frz5)\t(170,360,\frz-3)\t(360,540,\frz0)}",  # 回転ゆらぎ（近似）
    "flip": r"{\fad(60,40)\fry90\t(0,180,\fry0)}",                              # Y軸めくり
    "zoombig": r"{\fad(60,0)\fscx400\fscy400\t(0,140,\fscx108\fscy108)\t(140,220,\fscx100\fscy100)}",  # 特大→等倍
    "shake": r"{\fad(60,40)\frz6\t(0,60,\frz-6)\t(60,120,\frz4)\t(120,180,\frz-3)\t(180,240,\frz0)}",  # 揺れ
    "spin": r"{\fad(80,40)\frz359.9\t(0,300,\frz0)}",                           # 1回転イン
    "blurin": r"{\fad(60,40)\blur12\t(0,200,\blur0)}",                          # ぼけ→鮮明
}

# ── 文字エフェクト（装飾）。horror は文字へタグ付与、sparkle は別途★粒子、
# glow は2層（背面に色付きぼかし縁の発光層＋前面に鮮明な文字）で別処理（_glow_group）。
_EFFECT_TAGS = {
    "none": "",
    "sparkle": r"{\be1}",          # 文字は軽くにじませ、★粒子は _sparkle_events で重ねる
    "horror": (r"{\1c&H2424E0&\3c&H101058&\blur1.2"
               r"\frz-1.5\t(0,130,\frz1.5)\t(130,260,\frz-1.2)\t(260,400,\frz0.8)\t(400,560,\frz0)}"),
}

# ★粒子（キラキラ）の配置（画面上部にばら撒く・0-1 正規化）と簡易スター形状
_SPARKLE_PTS = [(0.16, 0.13), (0.84, 0.15), (0.30, 0.085), (0.70, 0.10),
                (0.50, 0.06), (0.22, 0.27), (0.78, 0.26)]
_SPARKLE_SHAPE = r"m 0 -16 l 4 -4 16 0 4 4 0 16 -4 4 -16 0 -4 -4"


def _anim_group(animation: str | None, kind: str, animate: bool) -> str:
    """出現アニメの override（{}込み）を返す。animation 未指定時は従来のポップイン挙動。"""
    a = (animation or "").lower()
    if a in ("", "default"):
        if not animate:
            return ""
        return {"title": _ANIM_TITLE, "hook": _ANIM_HOOK,
                "emph": _ANIM_EMPH}.get(kind, _ANIM_CAPTION)
    return _ANIM_NAMED.get(a, "")


def _effect_group(effect: str | None) -> str:
    """文字に付与する装飾 override（{}込み）。"""
    return _EFFECT_TAGS.get((effect or "none").lower(), "")


def _glow_group(color_hex: str, font_size: int) -> str:
    r"""光彩（glow）の背面層タグ {}込み。

    透明塗り(\1a&HFF&)＋不透明な色付き太縁(\3c,\bord)＋ガウスぼかし(\blur)＝発光ハロー。
    前面の鮮明な文字を別レイヤで重ねる。ScaledBorderAndShadow:yes 前提（1920基準）。
    """
    bord = max(6, int(font_size * 0.11))   # ~8 @74px。太縁がぼかしの広がり元になる
    blur = max(12, int(font_size * 0.26))  # ~19 @74px。これが発光の広がり
    return (f"{{\\1a&HFF&\\3a&H00&\\4a&HFF&\\3c{_ass_color(color_hex)}"
            f"\\bord{bord}\\blur{blur}}}")


# コメント風アバター（青丸＋白い人型シルエット）の ASS ベクター描画（60px枠・3層に分ける）。
# 注意（検証済み）: 頭と肩を1つの \p ブロックにまとめると even-odd 合成で消えるため必ず3イベントに分ける。
_AV_CIRCLE = r"m 30 0 b 13 0 0 13 0 30 b 0 47 13 60 30 60 b 47 60 60 47 60 30 b 60 13 47 0 30 0"
_AV_HEAD = r"m 30 16 b 23 16 17 22 17 29 b 17 36 23 42 30 42 b 37 42 43 36 43 29 b 43 22 37 16 30 16"
_AV_SHOULDER = r"m 30 45 b 19 45 10 53 9 64 b 17 64 43 64 51 64 b 50 53 41 45 30 45"


def _comment_events(text: str, start: float, end: float, *, text_x: int, y: int,
                    av_x: int, av_size: int, cap_size: int, max_lines: int,
                    zlayer: int = 5) -> list[str]:
    r"""配信者がコメントを読み上げているテロップを、白ボックス＋アバターのチャット風で描く。

    text=\an4\pos 左寄せ＋Comment スタイル（BorderStyle=3 白ボックス）、アバターは \an7\pos の3層描画。
    """
    lines = _wrap_static(text, _max_chars(int(cap_size * 0.9)), max_lines)
    if not lines:
        return []
    body = "\\N".join(_escape(ln) for ln in lines if ln.strip())
    av_y = y - int(av_size * 0.5)
    sc = max(10, int(av_size / 60.0 * 100))
    avh = f"{{\\an7\\pos({av_x},{av_y})\\bord0\\shad0\\fscx{sc}\\fscy{sc}"
    L = zlayer
    return [
        f"Dialogue: {L},{_t(start)},{_t(end)},Comment,,0,0,0,,{{\\an4\\pos({text_x},{y})}}{body}",
        f"Dialogue: {L + 1},{_t(start)},{_t(end)},Avatar,,0,0,0,,{avh}\\1c&HF0C080&\\p1}}{_AV_CIRCLE}{{\\p0}}",
        f"Dialogue: {L + 1},{_t(start)},{_t(end)},Avatar,,0,0,0,,{avh}\\1c&HFFFFFF&\\p1}}{_AV_HEAD}{{\\p0}}",
        f"Dialogue: {L + 1},{_t(start)},{_t(end)},Avatar,,0,0,0,,{avh}\\1c&HFFFFFF&\\p1}}{_AV_SHOULDER}{{\\p0}}",
    ]


def _sparkle_events(clip_duration: float) -> list[str]:
    """キラキラ＝瞬く★粒子を描画イベントとして重ねる（粒子の近似・明示）。"""
    if clip_duration <= 0:
        return []
    events: list[str] = []
    period, n = 1.1, 0
    for i, (fx, fy) in enumerate(_SPARKLE_PTS):
        x, y = int(fx * OUTPUT_W), int(fy * OUTPUT_H)
        t = (i % 5) * 0.22                       # 位相をずらして瞬かせる
        while t < clip_duration and n < 40:
            end = min(clip_duration, t + 0.62)
            ov = (f"{{\\an5\\pos({x},{y})\\frz{(i * 37) % 360}\\fscx0\\fscy0\\alpha&H30&"
                  f"\\t(0,300,\\fscx120\\fscy120\\alpha&H00&)"
                  f"\\t(300,600,\\fscx0\\fscy0\\alpha&H40&)}}")
            events.append(f"Dialogue: 5,{_t(t)},{_t(end)},Sparkle,,0,0,0,,"
                          f"{ov}{{\\p1}}{_SPARKLE_SHAPE}{{\\p0}}")
            t += period
            n += 1
    return events


def _clamp(val, lo: float, hi: float, default: float) -> float:
    if val is None:
        return default
    try:
        return max(lo, min(hi, float(val)))
    except (TypeError, ValueError):
        return default


def _pos_tag(pos: dict | None) -> str:
    """ドラッグ位置 {x,y}(0-1正規化) を ASS の中央アンカー絶対配置タグにする。"""
    if not isinstance(pos, dict):
        return ""
    try:
        x = max(0.0, min(1.0, float(pos["x"])))
        y = max(0.0, min(1.0, float(pos["y"])))
    except (TypeError, ValueError, KeyError):
        return ""
    return f"{{\\an5\\pos({int(x * OUTPUT_W)},{int(y * OUTPUT_H)})}}"


def _wm_corner(position: str) -> tuple[int, int, int]:
    """ウォーターマークの隅指定 → (alignment, x, y)。"""
    mx, my = int(0.045 * OUTPUT_W), int(0.05 * OUTPUT_H)
    table = {
        "tl": (7, mx, my),
        "tr": (9, OUTPUT_W - mx, my),
        "bl": (1, mx, OUTPUT_H - my),
        "br": (3, OUTPUT_W - mx, OUTPUT_H - my),
    }
    return table.get(position, table["tr"])


# ── 日本語の付属語（字幕の先頭に置かない＝直前の単位へ必ず結合する）。文節単位の分割に使う。
_JOSHI = {  # 助詞
    "は", "が", "を", "に", "へ", "と", "で", "も", "の", "や", "か", "ね", "よ", "わ", "さ", "ぞ",
    "な", "ら", "り", "から", "まで", "より", "ので", "のに", "けど", "けれど", "けれども", "ても",
    "でも", "し", "たり", "つつ", "ながら", "ば", "には", "では", "とは", "って", "という",
    "っていう", "など", "くらい", "ぐらい", "ほど", "だけ", "しか", "こそ", "さえ", "とか", "なら",
    "たら", "だら", "ったら", "ては", "じゃ",
}
_JODOUSHI = {  # 助動詞・補助用言・語尾
    "です", "ます", "だ", "た", "て", "ない", "ぬ", "う", "よう", "せる", "させる", "れる",
    "られる", "たい", "そう", "らしい", "みたい", "べき", "はず", "わけ", "ん", "だろう", "でしょう",
    "ている", "てる", "ちゃう", "じゃう", "とく", "どく", "ました", "ません", "でした", "ましょう",
    "なんや", "なの", "んだ", "んです",
}
# フィラー・接続詞（単独・短尺で出さず、後続の内容語へ結合する）
_FILLER = {
    "えっと", "えーと", "えと", "あの", "あのー", "その", "まあ", "まぁ", "なんか", "ええ", "えー",
    "うーん", "あー", "んー", "えっ", "あっ", "なんていうか", "まじ",
}
_CONJ = {
    "だから", "でも", "しかし", "ただ", "それで", "そして", "つまり", "で", "けど", "あと", "まず",
    "では", "じゃあ", "あとは", "ところで", "なので", "だが", "けれど", "それと",
}
_SENT_END = "。．！？!?"
_PAUSE_MARK = "、，,・"
# 長音・促音・小書き仮名・繰り返し記号は単独で切らず直前へ結合する（カタカナ語/口語を割らない）
_SMALL_KANA = "ーぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮ々ゝゞヽヾ"


def _is_kata(s: str) -> bool:
    """カタカナ（＋長音・中黒）だけで構成される単位か。"""
    return bool(s) and all(("ァ" <= c <= "ヴ") or c in "ー・゛゜ヷヸヹヺ" for c in s)


def _ja_units(text: str) -> list[str]:
    """TinySegmenter で分かち書きし、カタカナ語・長音・小書き仮名を結合して『割ってはいけない単位』にする。

    例:「スコープ」を「スコ」「ープ」に割らない。TinySegmenter 未導入時は 1 文字単位にフォールバック。
    """
    from .correct import _ja_tokens

    toks = _ja_tokens(text) or list(text)
    # 句読点・文末記号は必ず独立した単位にする（TinySegmenter が「！で」等と次語へ付ける誤りを正し、
    # 後段の文末/読点区切り判定を確実にする）。
    pieces: list[str] = []
    for t in toks:
        buf = ""
        for c in t:
            if c in _SENT_END or c in _PAUSE_MARK:
                if buf:
                    pieces.append(buf)
                    buf = ""
                pieces.append(c)
            else:
                buf += c
        if buf:
            pieces.append(buf)
    out: list[str] = []
    for t in pieces:
        t = t.strip()
        if not t:
            continue
        if out and t[0] in _SMALL_KANA:                  # 長音・促音・小書き → 前の単位へ
            out[-1] += t
        elif out and _is_kata(out[-1]) and _is_kata(t):  # 連続カタカナを 1 単位に（スコープ等）
            out[-1] += t
        else:
            out.append(t)
    return out


def _is_attached(unit: str) -> bool:
    """この単位は字幕/行の先頭に置かない（直前へ必ず結合する）＝助詞・助動詞・句読点・小書き仮名。"""
    if not unit:
        return True
    if unit[0] in _SENT_END or unit[0] in _PAUSE_MARK or unit[0] in _SMALL_KANA:
        return True
    return unit in _JOSHI or unit in _JODOUSHI


def _clean_telop_text(s: str) -> str:
    """テロップ保存用テキスト。前後の空白・先頭読点を除き、文末「。」のみ落とす（、！？は保持）。"""
    s = s.strip(" 　").lstrip(_PAUSE_MARK + " 　").rstrip("。．")
    return s.strip(" 　")


def _disp_len(s: str) -> int:
    """字数カウント（句読点・空白を除いた実文字数）。短すぎ判定に使う。"""
    return len(s.strip(_PAUSE_MARK + _SENT_END + " 　"))


def _wrap_lines(text: str, max_chars: int, max_lines: int | None = None) -> list[str]:
    """単語境界（日本語は単位化）で詰めて折返した行のリスト。max_lines=None なら全行を返す。

    「、」で改行・「。」除去・「！？」は行末に保持。助詞・助動詞・長音などの付属語は
    行頭に置かない（単語/カタカナ語を途中で割らない）。
    """
    text = text.strip().replace("\n", "")
    if not text:
        return []
    if " " in text:
        toks, joiner = text.split(), " "
    else:
        toks, joiner = _ja_units(text), ""

    lines: list[str] = []
    line = ""

    def push() -> None:
        nonlocal line
        s = line.strip("、，, 　。．")
        if s:
            lines.append(s)
        line = ""

    for tk in toks:
        if tk in "。．":
            continue
        if tk in _PAUSE_MARK:           # 読点で改行
            if line:
                push()
            continue
        keep = tk in "！？!?"           # 感嘆/疑問は行末に残す
        attached = _is_attached(tk)     # 助詞・助動詞・長音は行頭に置かない
        cand = (line + joiner + tk) if line else tk
        if line and not keep and not attached and len(cand) > max_chars:
            push()
            line = tk
        else:
            line = cand
    if line:
        push()
    # max_lines を超える分は捨てずに最後の許容行へ畳み込む（焼込みで文字を落とさない）。
    if max_lines is not None and len(lines) > max_lines:
        keep_n = max(1, max_lines)
        merged = lines[:keep_n - 1]
        merged.append(joiner.join(lines[keep_n - 1:]))
        lines = merged
    return lines


def _wrap_static(text: str, max_chars: int, max_lines: int = 2) -> list[str]:
    """テロップ表示用の折返し（max_lines 行まで）。"""
    return _wrap_lines(text, max_chars, max_lines)


def _fits_lines(text: str, max_chars: int, max_lines: int) -> bool:
    """text が max_lines 行に収まる（焼き込み時に末尾が切れない）か。"""
    return len(_wrap_lines(text, max_chars)) <= max_lines


def _merge_short_telops(telops: list[dict], min_chars: int, max_chars: int, max_lines: int,
                        max_sec: float, pause_split: float = 0.6) -> list[dict]:
    """短すぎる断片（助詞・フィラー・接続詞だけ／min_chars 未満）を隣のテロップへ結合する。

    接続詞・フィラー始まりは後続の内容語へ前方結合し、それ以外は直前へ後方結合する。結合後も
    max_lines 行に収まる（焼き込みで末尾が切れない）場合のみ結合し、どこにも収まらない断片は
    そのまま残す（切れた字幕より短い完結字幕を優先）。時刻は実発話時刻を引き継ぐ。
    """
    if not telops:
        return telops

    def _leads_forward(t: dict) -> bool:
        u = _ja_units(t["text"])
        head = u[0] if u else t["text"]
        return head in _CONJ or head in _FILLER

    def _join(a: dict, b: dict) -> dict:
        return {"start": a["start"], "end": b["end"],
                "text": _clean_telop_text(a["text"].rstrip("。．") + b["text"])}

    def _is_bare_fragment(txt: str) -> bool:
        """助詞・助動詞・記号・小書き仮名だけの短い断片か（独立させず前文へ取り込む対象）。"""
        units = _ja_units(txt)
        core = [u for u in units if u not in _SENT_END and u not in _PAUSE_MARK]
        return bool(core) and all(_is_attached(u) for u in core)

    def _can_merge(a, b) -> bool:
        """a の直後へ b を結合できるか。a が文末（。！？）で終わるなら次文は原則繋げない。
        ただし b が助詞・記号だけの短い断片なら、孤立テロップ（「の？」「よ。」「！」）を作らないよう
        例外的に直前の文へ取り込む。"""
        if not a or not b:
            return False
        if (b["start"] - a["end"]) >= pause_split:   # 実無音をまたぐ結合はしない（例: 3…2…1 を保つ）
            return False
        at = a["text"].rstrip()
        if at and at[-1] in _SENT_END:
            if not (_disp_len(b["text"]) < min_chars and _is_bare_fragment(b["text"])):
                return False
        return (_fits_lines(a["text"].rstrip("。．") + b["text"], max_chars, max_lines)
                and b["end"] - a["start"] <= max_sec * 1.8)

    out = [dict(t) for t in telops]
    changed = True
    while changed and len(out) > 1:
        changed = False
        for i, t in enumerate(out):
            if _disp_len(t["text"]) >= min_chars:
                continue
            fwd = out[i + 1] if i + 1 < len(out) else None
            bwd = out[i - 1] if i - 1 > -1 else None
            prefer_fwd = _leads_forward(t) or bwd is None
            if prefer_fwd and _can_merge(t, fwd):
                out[i:i + 2] = [_join(t, fwd)]
            elif _can_merge(bwd, t):
                out[i - 1:i + 1] = [_join(bwd, t)]
            elif _can_merge(t, fwd):
                out[i:i + 2] = [_join(t, fwd)]
            else:
                continue
            changed = True
            break
    return out


def _split_oversized_spans(spans: list[tuple[str, int, int]], full: str,
                           max_chars: int, max_lines: int) -> list[tuple[str, int, int]]:
    """表示容量(max_chars*max_lines)を超える単位を max_chars 文字ごとに強制分割する。

    超長尺の 1 単語（割れないカタカナ連結・記号列・長い英数字）はそのままだと焼込みで末尾が
    切れる。割れる箇所が無い以上、文字単位で割って全文を表示できるようにする（最終手段）。
    """
    cap = max(1, max_chars * max_lines)
    out: list[tuple[str, int, int]] = []
    for (u, a, b) in spans:
        if b - a <= cap:
            out.append((u, a, b))
            continue
        i = a
        while i < b:
            j = min(i + max_chars, b)
            out.append((full[i:j], i, j))
            i = j
    return out


def _dedup_consecutive(telops: list[dict]) -> list[dict]:
    """連続する同一テキストのテロップをマージ（Whisper幻聴による重複表示の防止）。"""
    if len(telops) < 2:
        return telops
    out = [telops[0]]
    for tp in telops[1:]:
        prev = out[-1]
        if tp["text"].strip() == prev["text"].strip() and tp["start"] - prev["end"] < 1.0:
            prev["end"] = max(prev["end"], tp["end"])
        else:
            out.append(tp)
    return out


def _segment_telops(words: list[Word], max_chars: int, max_lines: int, max_sec: float,
                    *, min_chars: int | None = None, pause_split: float = 0.6) -> list[dict]:
    """単語列を日本語の文節・単語境界で自然なテロップに分割する（時刻は実発話時刻のまま）。

    手順: ①Whisper 語を文字ストリーム化（各文字に実時刻を内挿）→ Whisper の分割に縛られない。
    ②全文を日本語単位に再分割（カタカナ語を割らない）。③単位を貪欲にパック（文末「。！？」・
    読点・無音・長さ/時間で区切る／助詞・助動詞は先頭に置かない）。④短すぎる断片を隣へ結合。
    """
    if not words:
        return []
    cap_len = max(6, max_chars * max_lines)
    if min_chars is None:
        min_chars = max(5, min(8, cap_len // 3))
    min_chars = min(min_chars, cap_len)

    # ① 文字ストリーム（各文字 = (文字, 開始, 終了)）。語内は文字数で時刻を内挿。
    # 併せて各 Whisper 語の先頭文字インデックスを記録（高信頼な分割位置の判定に使う）。
    # さらに「直前に pause_split 以上の実無音がある語頭」を hard_boundaries に記録する＝確実な区切り。
    chars: list[tuple[str, float, float]] = []
    whisper_starts: set[int] = set()
    hard_boundaries: set[int] = set()
    prev_w_end: float | None = None
    for w in words:
        t = "".join((w.text or "").split())   # 前後＋内部の空白を除去（_ja_units と文字数を一致＝時刻が崩れない）
        if not t:
            continue
        idx0 = len(chars)
        whisper_starts.add(idx0)
        if prev_w_end is not None and (float(w.start) - prev_w_end) >= pause_split:
            hard_boundaries.add(idx0)
        dur = max(0.001, float(w.end) - float(w.start))
        n = len(t)
        for j, ch in enumerate(t):
            cs = float(w.start) + dur * (j / n)
            ce = float(w.start) + dur * ((j + 1) / n)
            chars.append((ch, cs, ce))
        prev_w_end = float(w.end)
    if not chars:
        return []
    full = "".join(c[0] for c in chars)

    # ② 日本語単位へ再分割し、各単位を文字インデックス範囲 [a, b) に対応付ける。
    raw_spans: list[tuple[str, int, int]] = []
    pos = 0
    for u in (_ja_units(full) or list(full)):
        a, b = pos, min(pos + len(u), len(chars))
        if a < b:
            raw_spans.append((u, a, b))
        pos += len(u)
    if pos < len(chars):                       # 取りこぼし防止
        raw_spans.append((full[pos:], pos, len(chars)))

    # ②'' 実無音(>= pause_split)のある語頭が単位の内側に埋もれている場合は強制的に割る。
    # TinySegmenter が無音をまたいで「いっぱい＋やり合っ」を1単位にまとめると、後段の無音区切りが
    # 効かず文がつながる（run-on）ため、確実な区切り=実無音位置で単位を分割しておく。
    if hard_boundaries:
        split_spans: list[tuple[str, int, int]] = []
        for (u, a, b) in raw_spans:
            cuts = sorted(h for h in hard_boundaries if a < h < b)
            if not cuts:
                split_spans.append((u, a, b))
                continue
            prev = a
            for c in cuts + [b]:
                if c > prev:
                    split_spans.append((full[prev:c], prev, c))
                prev = c
        raw_spans = split_spans

    # ②' Whisper 語の途中に当たる単位境界（＝TinySegmenter だけが作った境界。例「さ＋いきなり」を
    # 「さいき／なり」と誤分割）は信用せず直前へ結合し、語の途中で字幕を割らない。ただし
    #  - 句読点・文末記号は独立を保つ（文末/読点で確実に区切れるようにする）、
    #  - 結合しても表示容量(max_chars*max_lines)を超えない（超長尺の Whisper 語が 1 個の巨大で
    #    割れない字幕になり、焼込みで末尾が切れるのを防ぐ）。
    spans: list[tuple[str, int, int]] = []
    for (u, a, b) in raw_spans:
        prev = spans[-1][0] if spans else ""
        glue = (bool(spans) and a not in whisper_starts
                and not (u and (u[0] in _SENT_END or u[0] in _PAUSE_MARK))
                and not (prev and prev[-1] in _SENT_END + _PAUSE_MARK)
                and (b - spans[-1][1]) <= cap_len)
        if glue:
            pu, pa, _pb = spans[-1]
            spans[-1] = (pu + u, pa, b)
        else:
            spans.append((u, a, b))
    # 1 単位が表示容量を超える（超長尺の単語・カタカナ連結等）場合は文字単位で強制分割し、
    # 焼込みで末尾が切れないようにする（割るしかない最終手段）。
    spans = _split_oversized_spans(spans, full, max_chars, max_lines)

    # ③ 単位を貪欲にパック。
    telops: list[dict] = []
    cur: list[str] = []
    cur_a: int | None = None
    cur_b: int | None = None

    def flush() -> None:
        nonlocal cur, cur_a, cur_b
        if cur and cur_a is not None and cur_b is not None:
            s = chars[cur_a][1]
            e = chars[cur_b - 1][2]
            txt = _clean_telop_text("".join(cur))
            if txt:
                telops.append({"start": round(s, 3), "end": round(max(s + 0.3, e), 3),
                               "text": txt})
        cur, cur_a, cur_b = [], None, None

    prev_end: float | None = None
    for (u, a, b) in spans:
        gap = (chars[a][1] - prev_end) if prev_end is not None else 0.0
        if cur and not _is_attached(u):
            cl = _disp_len("".join(cur))
            dur = chars[cur_b - 1][2] - chars[cur_a][1]
            # 文節境界（＝内容語の頭）でのみ区切る: 行あふれ（焼込みで切れる）・無音・時間超過のいずれか。
            overflow = not _fits_lines("".join(cur) + u, max_chars, max_lines)
            # 無音/時間超過は「強い区切り信号」。min_chars 未満でも区切る（例:「3」「2」「1」の
            # カウントダウンが '321' に潰れるのを防ぐ）。行あふれだけは min_chars ゲートを残す
            # （短すぎる断片乱発を避ける／後段 _merge_short_telops が短片を再結合する）。
            strong = (gap >= pause_split) or (dur >= max_sec)
            if (cl >= min_chars and overflow) or (strong and cl >= 1):
                flush()
        if cur_a is None:
            cur_a = a
        cur.append(u)
        cur_b = b
        prev_end = chars[b - 1][2]
        if u and u[-1] in _SENT_END:           # 文末で必ず区切る
            flush()
    flush()

    # ④ 短すぎる断片を結合し、隣接の時間重なりを解消。
    telops = _merge_short_telops(telops, min_chars, max_chars, max_lines, max_sec, pause_split)
    for i in range(len(telops) - 1):
        if telops[i]["end"] > telops[i + 1]["start"]:
            telops[i]["end"] = max(telops[i]["start"] + 0.3, telops[i + 1]["start"])

    # ⑤ Whisper の幻聴で同じテキストが連続する場合をマージ（重複表示の防止）。
    telops = _dedup_consecutive(telops)
    return telops


def segment(words: list[Word], caption_style: CaptionStyle | None = None) -> list[dict]:
    """words から編集用テロップ [{start, end, text}] を作る（手動修正UI/保存用）。"""
    cap = caption_style or SETTINGS.caption
    return _segment_telops(words, _max_chars(cap.font_size), cap.max_lines, cap.max_phrase_sec)


def tag_alerts(telops: list[dict]) -> list[dict]:
    """ラテン文字（英語）が多いテロップを alert 様式に自動タグ付け（TikTok ギフト等）。"""
    for tp in telops:
        if tp.get("style"):
            continue
        text = str(tp.get("text", ""))
        letters = sum(1 for c in text if c.isascii() and c.isalpha())
        if text and letters >= max(3, int(len(text) * 0.5)):
            tp["style"] = "alert"
    return telops


def build_ass(
    words: list[Word] | None = None,
    *,
    telops: list[dict] | None = None,
    clip_duration: float,
    title: str = "",
    hook: str = "",
    language: str = "",
    caption_style: CaptionStyle | None = None,
    title_style: TitleStyle | None = None,
    font: str | None = None,
    subtitle_color: str | None = None,
    highlight_color: str | None = None,   # 互換（旧カラオケ・未使用）
    emphasis_color: str | None = None,    # 強調テロップ(中央大)の色
    outline_color: str | None = None,
    title_color: str | None = None,
    title_outline_color: str | None = None,
    animate: bool = False,
    animation: str | None = None,
    effect: str | None = None,
    caption_size: float | None = None,
    title_size: float | None = None,
    outline_width: float | None = None,
    title_outline_width: float | None = None,
    caption_pos: dict | None = None,
    title_pos: dict | None = None,
    watermark: dict | None = None,
    box: bool = False,
    box_color: str | None = None,
    box_pad: float | None = None,
    sub_offset: float | None = None,
) -> str:
    """ASS を生成。`telops` を渡せばそれを、無ければ `words` から自動分割して使う。

    animate=True でポップイン演出。animation で出現の動き（fade/pop/bounce/slide/wipe/breathe/wave）、
    effect で装飾（glow/sparkle/horror）を付与（animation 未指定時は animate のポップインに従う）。
    caption_size/title_size/outline_width 等で見た目を上書き、caption_pos/title_pos({x,y}0-1) で
    ドラッグ位置に絶対配置、watermark で @ハンドル等を隅に焼く。
    """
    cap = caption_style or SETTINGS.caption
    ttl = title_style or SETTINGS.title
    safe = SETTINGS.safe
    font_cap = font or cap.font_name
    font_ttl = font or ttl.font_name
    sub_c = subtitle_color or cap.primary_hex
    out_c = outline_color or cap.outline_hex
    ttl_c = title_color or ttl.primary_hex
    ttl_out_c = title_outline_color or ttl.outline_hex
    emph_c = emphasis_color or "#FFE600"

    # サイズ・縁取りの上書き（UI スライダー／字幕プリセット）。安全な範囲にクランプ。
    cap_size = int(_clamp(caption_size, 36, 140, cap.font_size))
    ttl_size = int(_clamp(title_size, 40, 170, ttl.font_size))
    cap_out = int(_clamp(outline_width, 0, 20, cap.outline_width))
    ttl_out = int(_clamp(title_outline_width, 0, 24, ttl.outline_width))

    margin_l = int(safe.left * OUTPUT_W)
    margin_r = int(safe.right * OUTPUT_W)
    caption_mv = int((1.0 - cap.pos_y) * OUTPUT_H)
    title_mv = int(ttl.pos_y * OUTPUT_H)
    hook_size = int(ttl_size * 1.2)
    alert_size = int(cap_size * 0.82)
    alert_mv = int(0.30 * OUTPUT_H)
    wm_size = max(24, int(OUTPUT_W * 0.034))
    emph_size = int(cap_size * 1.5)
    laugh_size = int(cap_size * 1.25)

    # 枠（box）モード: BorderStyle=3（半透明の背景ボックス）。縁取りの代わりに枠を出す。
    # box_pad（Outline 値）で枠の余白＝大きさを調整（UIスライダー）。
    if box:
        cap_border = 3
        cap_pad = int(_clamp(box_pad, 2, 40, 10))
        cap_outline_col = "&H40" + _ass_color(box_color or "#000000")[4:]  # alpha 0x40=半透明
    else:
        cap_border, cap_pad = 1, cap_out
        cap_outline_col = _ass_color(out_c)

    styles = [
        f"Style: Caption,{font_cap},{cap_size},"
        f"{_ass_color(sub_c)},{_ass_color(sub_c)},{cap_outline_col},&H64000000,-1,0,0,0,"
        f"100,100,0,0,{cap_border},{cap_pad},{cap.shadow},2,{margin_l},{margin_r},{caption_mv},1",
        # Emphasis: 盛り上がり/強調テロップを画面中央に大きく
        f"Style: Emphasis,{font_ttl},{emph_size},"
        f"{_ass_color(emph_c)},{_ass_color(emph_c)},{_ass_color('#000000')},&H64000000,-1,0,0,0,"
        f"100,100,0,0,1,{cap_out + 3},{cap.shadow},5,{margin_l},{margin_r},0,1",
        f"Style: Title,{font_ttl},{ttl_size},"
        f"{_ass_color(ttl_c)},{_ass_color(ttl_c)},{_ass_color(ttl_out_c)},&H64000000,-1,0,0,0,"
        f"100,100,0,0,1,{ttl_out},{ttl.shadow},8,{margin_l},{margin_r},{title_mv},1",
        f"Style: Hook,{font_ttl},{hook_size},"
        f"{_ass_color('#FFE600')},{_ass_color('#FFE600')},{_ass_color(ttl_out_c)},&H64000000,-1,0,0,0,"
        f"100,100,0,0,1,{ttl_out + 2},{ttl.shadow},5,{margin_l},{margin_r},0,1",
        # Alert: Twitch 風バナー（背景ボックス BorderStyle=3）
        f"Style: Alert,{font_ttl},{alert_size},"
        f"{_ass_color('#FFFFFF')},{_ass_color('#FFFFFF')},{_ass_color('#25F4EE')},&H64000000,-1,0,0,0,"
        f"100,100,0,0,3,6,0,8,{margin_l},{margin_r},{alert_mv},1",
        # Watermark: 半透明の @ハンドル等（隅に固定）
        f"Style: Watermark,{font_ttl},{wm_size},"
        f"&H50FFFFFF,&H50FFFFFF,&HA0000000,&H64000000,-1,0,0,0,100,100,0,0,1,3,0,9,20,20,20,1",
        # Sparkle: キラキラ★粒子（黄＋白縁・中央アンカーで \pos 配置）
        f"Style: Sparkle,{font_ttl},40,"
        f"&H0033FFFF,&H0033FFFF,&H00FFFFFF,&H64000000,0,0,0,0,100,100,0,0,1,1,1,5,0,0,0,1",
        # Laugh: 笑い「ｗｗｗ」（緑・太め・右寄り中段。字幕/タイトルと被りにくい）
        f"Style: Laugh,{font_ttl},{laugh_size},"
        f"{_ass_color('#27E36B')},{_ass_color('#27E36B')},{_ass_color('#0A3D1E')},&H64000000,-1,0,0,0,"
        f"100,100,0,0,1,{cap_out + 2},{cap.shadow},6,{margin_l},{margin_r},0,1",
        # Comment: コメント読み上げ＝白ボックス(BorderStyle=3)＋濃い太字。Outline=余白。
        f"Style: Comment,{font_cap},{cap_size},"
        f"&H00202020,&H00202020,&H00FFFFFF,&H30000000,-1,0,0,0,100,100,0,0,3,16,4,4,0,0,0,1",
        # Avatar: コメントの青丸＋人型シルエット（描画用・縁/影なし・左上アンカー）
        "Style: Avatar,Arial,20,&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,&H00000000,0,0,0,0,"
        "100,100,0,0,1,0,0,7,0,0,0,1",
    ]

    if telops is None:
        telops = _segment_telops(words or [], _max_chars(cap_size), cap.max_lines,
                                 cap.max_phrase_sec)
    telops = _display_telops(telops, clip_duration)

    is_glow = (effect or "").lower() == "glow"
    eff_ov = "" if is_glow else _effect_group(effect)  # glow は2層で別処理。alert/WM には付けない

    events: list[str] = []

    def emit(start, end, style, lines, pos_anim_ov, color, fsize, zlayer=3):
        """1要素を描画。zlayer が大きいほど前面（テロップのレイヤー）。

        glow 時は同レイヤに背面(発光)→前面(鮮明)の順で重ねる（同レイヤは記述順＝後が上）。
        """
        if not lines:
            return
        if is_glow:
            events.append(_dialogue(start, end, style, lines,
                                    pos_anim_ov + _glow_group(color, fsize), layer=zlayer))
            events.append(_dialogue(start, end, style, lines, pos_anim_ov, layer=zlayer))
        else:
            events.append(_dialogue(start, end, style, lines, pos_anim_ov + eff_ov, layer=zlayer))

    # ウォーターマーク（@ハンドル等のテキスト）。装飾なし・最背面。
    if isinstance(watermark, dict) and str(watermark.get("text", "")).strip():
        an, wx, wy = _wm_corner(str(watermark.get("position", "tr")))
        events.append(_dialogue(0.0, clip_duration, "Watermark",
                                [str(watermark["text"]).strip()],
                                f"{{\\an{an}\\pos({wx},{wy})}}"))
    if title.strip():
        emit(0.0, clip_duration, "Title", _wrap_static(title, _max_chars(ttl_size), 2),
             _pos_tag(title_pos) + _anim_group(animation, "title", animate), ttl_c, ttl_size)
    if hook.strip():
        emit(0.0, min(2.2, clip_duration), "Hook", _wrap_static(hook, _max_chars(hook_size), 2),
             _anim_group(animation, "hook", animate), "#FFE600", hook_size)
    sub_off = 0.0
    for tp in telops:
        text = str(tp.get("text", "")).strip()
        if not text:
            continue
        tstyle = tp.get("style")
        is_alert = tstyle == "alert"
        is_emph = bool(tp.get("emphasis")) and not is_alert and tstyle not in ("laugh", "comment")
        s = max(0.0, min(clip_duration, float(tp["start"]) + sub_off))
        e = max(s + 0.2, min(clip_duration, float(tp["end"]) + sub_off))
        zl = 5 + int(tp.get("layer") or 0)   # テロップの z 順（レイヤー・大きいほど前面）
        tp_pos = tp.get("pos")               # テロップ個別位置（無ければ既定）
        if tstyle == "comment":   # コメント読み上げ＝チャット風ボックス＋アバター
            cy = int(float(tp_pos["y"]) * OUTPUT_H) if isinstance(tp_pos, dict) else int(OUTPUT_H * 0.55)
            cx = int(float(tp_pos["x"]) * OUTPUT_W) if isinstance(tp_pos, dict) else margin_l + 90
            events.extend(_comment_events(
                text, s, e, text_x=cx, y=cy, av_x=cx - 84, av_size=72,
                cap_size=cap_size, max_lines=cap.max_lines, zlayer=zl))
        elif tstyle == "laugh":   # 笑い「ｗｗｗ」
            lines = _wrap_static(text, _max_chars(laugh_size), 1)
            if lines:
                ov = (_pos_tag(tp_pos) if tp_pos else "") + (_ANIM_LAUGH if animate else "")
                events.append(_dialogue(s, e, "Laugh", lines, ov, layer=zl))
        elif is_alert:   # アラートは glow/装飾を付けず単層（バナー様式）
            lines = _wrap_static(text, _max_chars(alert_size), cap.max_lines)
            if lines:
                ov = (_pos_tag(tp_pos) if tp_pos else "") + (_ANIM_ALERT if animate else "")
                events.append(_dialogue(s, e, "Alert", lines, ov, layer=zl))
        elif is_emph:
            ov = (_pos_tag(tp_pos) if tp_pos else "") + _ANIM_EMPH
            emit(s, e, "Emphasis", _wrap_static(text, _max_chars(emph_size), cap.max_lines),
                 ov, emph_c, emph_size, zlayer=zl)
        else:   # テロップ個別の position/animation があればクリップ既定を上書き
            emit(s, e, "Caption", _wrap_static(text, _max_chars(cap_size), cap.max_lines),
                 _pos_tag(tp_pos or caption_pos) + _anim_group(tp.get("animation") or animation, "caption", animate),
                 sub_c, cap_size, zlayer=zl)

    if (effect or "").lower() == "sparkle":
        events.extend(_sparkle_events(clip_duration))

    return "\n".join(
        [
            "[Script Info]",
            "ScriptType: v4.00+",
            f"PlayResX: {OUTPUT_W}",
            f"PlayResY: {OUTPUT_H}",
            "WrapStyle: 2",
            "ScaledBorderAndShadow: yes",
            "",
            "[V4+ Styles]",
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
            "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
            "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
            *styles,
            "",
            "[Events]",
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
            *events,
            "",
        ]
    )


def words_for_clip(all_words: list[Word], start: float, end: float) -> list[Word]:
    out: list[Word] = []
    for w in all_words:
        if w.end <= start or w.start >= end:
            continue
        out.append(
            Word(
                start=round(max(0.0, w.start - start), 3),
                end=round(min(end, w.end) - start, 3),
                text=w.text,
            )
        )
    return out


def write_ass(path: str | Path, content: str) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path
