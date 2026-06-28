"""集中設定。.env を（python-dotenv 無しで）読み、環境変数→既定値の順で解決する。

TikTok 向けのレイアウト定数（解像度・セーフゾーン・字幕スタイル）もここに集約し、
開発中の「品質⇄コスト」精査でいじる値を一箇所にまとめる。
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BACKEND_DIR.parent

# PyInstaller でパッケージ化されているか
FROZEN = getattr(sys, "frozen", False)


def _bundle_dir() -> Path | None:
    """パッケージ版でバンドル内リソース（_internal 等）のルートを返す。開発版は None。"""
    if not FROZEN:
        return None
    return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))


def _tool_path(name: str) -> str:
    """ffmpeg/ffprobe の実体を解決。env 上書き → 同梱 → PATH の順。"""
    exe = name + (".exe" if os.name == "nt" else "")
    override = os.environ.get(f"{name.upper()}_BINARY", "").strip()
    if override and Path(override).exists():
        return override
    bd = _bundle_dir()
    if bd:
        for cand in (bd / exe, bd / "ffmpeg" / exe):
            if cand.exists():
                return str(cand)
    return name  # PATH 上の ffmpeg にフォールバック


FFMPEG = _tool_path("ffmpeg")
FFPROBE = _tool_path("ffprobe")


def _output_root() -> Path:
    """出力先。env 指定 → パッケージ版は LOCALAPPDATA → 開発版はプロジェクト直下。"""
    env = os.environ.get("TIKTOKCUT_OUTPUT", "").strip()
    if env:
        return Path(env)
    if FROZEN:
        base = os.environ.get("LOCALAPPDATA") or str(Path.home())
        return Path(base) / "TikTok-Cut" / "output"
    return PROJECT_DIR / "output"


OUTPUT_ROOT = _output_root().resolve()


def _prefs_file() -> Path:
    """UI のプリセット/パレット/直近スタイルを保存する安定パス。

    Electron は毎回ランダムポートで起動するため localStorage(origin依存) は起動間で消える。
    そこでサーバ側の固定ファイルに保存して永続化する。
    """
    env = os.environ.get("TIKTOKCUT_PREFS", "").strip()
    if env:
        return Path(env)
    if FROZEN:
        base = os.environ.get("LOCALAPPDATA") or str(Path.home())
        return Path(base) / "TikTok-Cut" / "prefs.json"
    return PROJECT_DIR / ".prefs.json"


PREFS_FILE = _prefs_file()


def _fonts_dir() -> Path:
    bd = _bundle_dir()
    if bd:
        cand = bd / "assets" / "fonts"
        if cand.exists():
            return cand
    return PROJECT_DIR / "assets" / "fonts"


# 同梱フォント（OFL/Apache）の置き場。libass に fontsdir として渡す。
FONTS_DIR = _fonts_dir()


def _sfx_dir() -> Path:
    bd = _bundle_dir()
    if bd:
        cand = bd / "assets" / "sfx"
        if cand.exists():
            return cand
    return PROJECT_DIR / "assets" / "sfx"


# 同梱効果音（mp3）の置き場。タイムラインエディタで配置し render で amix する。
SFX_DIR = _sfx_dir()

# 選択可能な効果音。file は SFX_DIR 内の実体（ASCII名・ffmpeg/URL安全）。dur は秒。
SFX = [
    {"id": "chime",    "label": "チーン（正解・締め）",   "file": "chime.mp3",    "dur": 3.53, "emoji": "🔔"},
    {"id": "pop",      "label": "ニュッ（登場）",         "file": "pop.mp3",      "dur": 0.29, "emoji": "✨"},
    {"id": "tsukkomi", "label": "ビシッ（ツッコミ）",     "file": "tsukkomi.mp3", "dur": 0.41, "emoji": "👊"},
    {"id": "bonk",     "label": "ポカン（げんこつ）",     "file": "bonk.mp3",      "dur": 0.30, "emoji": "💥"},
    {"id": "silly",    "label": "間抜け（ズコー）",       "file": "silly.mp3",    "dur": 1.24, "emoji": "😅"},
]
_SFX_BY_ID = {s["id"]: s for s in SFX}


def sfx_path(sfx_id: str) -> Path | None:
    """効果音 id → 実体パス。未知 id は None。"""
    s = _SFX_BY_ID.get(str(sfx_id))
    if not s:
        return None
    p = SFX_DIR / s["file"]
    return p if p.exists() else None

# 選択可能フォント。family は ASS の Fontname と一致させる（fonttools で実名を確認済み）。
# bundled=True は assets/fonts に同梱、False は Windows 標準フォント。
FONTS = [
    {"id": "meiryo",       "label": "メイリオ（標準）",          "family": "Meiryo",           "category": "simple", "bundled": False, "file": ""},
    {"id": "yugothic",     "label": "游ゴシック",                "family": "Yu Gothic",        "category": "simple", "bundled": False, "file": ""},
    {"id": "bizud",        "label": "BIZ UDPゴシック",           "family": "BIZ UDPGothic",    "category": "simple", "bundled": False, "file": ""},
    {"id": "mspgothic",    "label": "ＭＳ Ｐゴシック",            "family": "MS PGothic",       "category": "simple", "bundled": False, "file": ""},
    {"id": "mplusrounded", "label": "丸ゴ M+（まるっこ）",       "family": "Rounded Mplus 1c", "category": "cute",   "bundled": True,  "file": "MPLUSRounded1c-Regular.ttf"},
    {"id": "kosugimaru",   "label": "小杉丸ゴシック",            "family": "Kosugi Maru",      "category": "cute",   "bundled": True,  "file": "KosugiMaru-Regular.ttf"},
    {"id": "zenmaru",      "label": "Zen丸ゴ（かわいい）",       "family": "Zen Maru Gothic",  "category": "cute",   "bundled": True,  "file": "ZenMaruGothic-Regular.ttf"},
    {"id": "mochiypop",    "label": "もちポップ",                "family": "Mochiy Pop One",   "category": "cute",   "bundled": True,  "file": "MochiyPopOne-Regular.ttf"},
    {"id": "yuseimagic",   "label": "ゆせいマジック（手書き）",  "family": "Yusei Magic",      "category": "cute",   "bundled": True,  "file": "YuseiMagic-Regular.ttf"},
    {"id": "hachimaru",    "label": "はちまるポップ（激かわ）",  "family": "Hachi Maru Pop",   "category": "cute",   "bundled": True,  "file": "HachiMaruPop-Regular.ttf"},
    {"id": "dotgothic",    "label": "ドットゴシック（レトロ）",  "family": "DotGothic16",      "category": "cute",   "bundled": True,  "file": "DotGothic16-Regular.ttf"},
    {"id": "reggae",       "label": "レゲエ（極太インパクト）",  "family": "Reggae One",       "category": "impact", "bundled": True,  "file": "ReggaeOne-Regular.ttf"},
]
_FONT_FAMILIES = {f["family"] for f in FONTS}


def valid_font(family: str | None, default: str = "Meiryo") -> str:
    """許可リストにある family のみ通す（不正値は既定へ）。"""
    return family if family in _FONT_FAMILIES else default


def _load_dotenv(path: Path) -> None:
    """最小限の .env ローダ（KEY=VALUE 行のみ。既存の環境変数は上書きしない）。"""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        # インラインコメント（空白+#）を除去（strip 前の生値で判定。先頭 # の hex 値は維持）
        hpos = value.find(" #")
        if hpos != -1:
            value = value[:hpos]
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_dotenv(BACKEND_DIR / ".env")
# 配布アプリ用: exe と同じ場所 / %LOCALAPPDATA%\TikTok-Cut からも .env を読む
# （GEMINI_API_KEY 等の設定用。先に読まれた値は上書きしない）
if getattr(sys, "frozen", False):
    _load_dotenv(Path(sys.executable).parent / ".env")
_localappdata = os.environ.get("LOCALAPPDATA")
if _localappdata:
    _load_dotenv(Path(_localappdata) / "TikTok-Cut" / ".env")


def _fetch_remote_key() -> str:
    """GEMINI_KEY_URL が設定されていれば、そこから API キーを取得する。
    JSON {"key":"..."} またはプレーンテキストを受け付ける。失敗時は空文字。
    """
    url = os.environ.get("GEMINI_KEY_URL", "").strip()
    if not url:
        return ""
    try:
        import urllib.request
        import json as _json
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            body = resp.read().decode("utf-8").strip()
            try:
                return str(_json.loads(body).get("key", "")).strip()
            except (ValueError, AttributeError):
                return body
    except Exception as e:
        print(f"[config] リモートAPIキー取得失敗: {e}", flush=True)
        return ""


_REMOTE_KEY: str | None = None


def _gemini_key() -> str:
    """GEMINI_API_KEY を解決: 環境変数 → リモート(GEMINI_KEY_URL) の順。"""
    global _REMOTE_KEY
    local = os.environ.get("GEMINI_API_KEY", "").strip()
    if local:
        return local
    if _REMOTE_KEY is None:
        _REMOTE_KEY = _fetch_remote_key()
        if _REMOTE_KEY:
            os.environ["GEMINI_API_KEY"] = _REMOTE_KEY
    return _REMOTE_KEY or ""


def _env(key: str, default: str = "") -> str:
    return os.environ.get(key, default).strip()


def _env_int(key: str, default: int) -> int:
    """整数env。空/不正値は既定にフォールバック（不正値で import 時クラッシュさせない）。"""
    v = _env(key)
    try:
        return int(v) if v else default
    except ValueError:
        return default


def _env_float(key: str, default: float) -> float:
    """浮動小数env。空/不正値は既定にフォールバック。"""
    v = _env(key)
    try:
        return float(v) if v else default
    except ValueError:
        return default


# ---------------------------------------------------------------------------
# 出力先 9:16 縦型 (TikTok / Shorts / Reels 標準)
# ---------------------------------------------------------------------------
OUTPUT_W = 1080
OUTPUT_H = 1920


@dataclass(frozen=True)
class SafeZone:
    """TikTok の UI が被る領域を避けるためのマージン（出力解像度に対する割合 0-1）。

    TikTok は右側にアイコン列、下部にユーザー名/キャプション、上部に検索等を重ねる。
    字幕・タイトルはこの内側に収める。
    """
    top: float = 0.10      # 上 10%
    bottom: float = 0.20   # 下 20%（キャプション帯）
    left: float = 0.06
    right: float = 0.12    # 右 12%（アイコン列）


@dataclass(frozen=True)
class CaptionStyle:
    """カラオケ字幕の見た目。ASS 生成時に使用。"""
    font_name: str = "Meiryo"        # Win11 同梱の日本語フォント。配布時は同梱フォントに差し替え
    font_size: int = 74              # PlayResY=1920 基準（はみ出し防止のため控えめ）
    primary_hex: str = "#FFFFFF"     # 字幕の色（静的表示）
    highlight_hex: str = "#27E36B"   # （旧カラオケ用・現在は未使用）
    outline_hex: str = "#000000"
    outline_width: int = 6
    shadow: int = 2
    # 字幕の縦位置（上端からの割合）。セーフゾーン下端より上に置く。
    pos_y: float = 0.72
    # 1 テロップの最大行数・最大秒数。秒は「文節境界での区切り」の上限であり、超過しても
    # 単語/文節の途中では切らない（短すぎる断片や語の分断を防ぐため 2.6s に緩和）。
    max_lines: int = 2
    max_phrase_sec: float = 2.6


@dataclass(frozen=True)
class TitleStyle:
    font_name: str = "Meiryo"
    font_size: int = 80
    primary_hex: str = "#FFFFFF"
    outline_hex: str = "#000000"
    outline_width: int = 8
    shadow: int = 2
    pos_y: float = 0.16              # 上端からの割合（セーフゾーン内）


@dataclass(frozen=True)
class Settings:
    # LLM
    llm_provider: str = field(default_factory=lambda: _env("LLM_PROVIDER", "gemini"))
    llm_model: str = field(default_factory=lambda: _env("LLM_MODEL", "gemini-2.5-flash"))
    gemini_api_key: str = field(default_factory=_gemini_key)
    gemini_proxy_url: str = field(default_factory=lambda: _env("GEMINI_PROXY_URL"))
    openai_api_key: str = field(default_factory=lambda: _env("OPENAI_API_KEY"))
    anthropic_api_key: str = field(default_factory=lambda: _env("ANTHROPIC_API_KEY"))

    # Whisper（whisper_model 空="auto"＝デバイスに応じて GPU:large-v3 / CPU:medium を自動選択）
    whisper_model: str = field(default_factory=lambda: _env("WHISPER_MODEL", ""))
    whisper_device: str = field(default_factory=lambda: _env("WHISPER_DEVICE", "auto"))
    whisper_language: str = field(default_factory=lambda: _env("WHISPER_LANGUAGE"))
    # GPUバッチ推論で文字起こしを高速化（WHISPER_BATCHED=0 で無効）。バッチは幻聴抑制ノブの一部が
    # 無効化されるため、品質最優先なら 0。batch_size は 8GB VRAM 安全値の 8、beam は精度の 5。
    whisper_batched: bool = field(default_factory=lambda: _env("WHISPER_BATCHED", "1") != "0")
    whisper_batch_size: int = field(default_factory=lambda: _env_int("WHISPER_BATCH_SIZE", 8))
    whisper_beam_size: int = field(default_factory=lambda: _env_int("WHISPER_BEAM_SIZE", 5))

    # kotoba 等（単語時刻を出さない蒸留モデル）に実単語タイムスタンプを与える「供与モデル」。
    # 別途この軽量モデルを走らせ、その実時刻を kotoba のテキストへ移植して字幕ズレを抑える。
    # "" で無効（synth 時刻＝従来の均等割りに戻す）。small=日本語精度高・推奨, base=軽量/高速だが日本語弱い。
    kotoba_timing_donor: str = field(default_factory=lambda: _env("KOTOBA_TIMING_DONOR", "small"))

    # クリップ条件（TikTok の最適尺）
    clip_min_sec: float = 12.0
    clip_max_sec: float = 60.0
    default_clip_count: int = 5

    # 9:16 リフレーム方式: "crop"(中央クロップ=全画面) / "letterbox"(上下黒帯) / "blur"(背景ぼかし)
    reframe_mode: str = "crop"

    # クリップ冒頭のトランジション: none / fade(黒フェード) / zoom(パンチイン) / flash(白フラッシュ)
    intro_transition: str = field(default_factory=lambda: _env("INTRO_TRANSITION", "none"))

    # 字幕・タイトルのポップイン演出（SUBTITLE_ANIMATE=0 で無効化）
    subtitle_animate: bool = field(default_factory=lambda: _env("SUBTITLE_ANIMATE", "1") != "0")

    # 字幕の AI 文脈補正（既定OFF＝捏造を避ける。ONでもテキストのみ補正し時刻は変えない）。
    # CORRECT_SUBTITLES=1 で有効化。
    correct_subtitles: bool = field(default_factory=lambda: _env("CORRECT_SUBTITLES", "0") == "1")

    # テンポ編集モード: off(既定) / silence(無音詰め) / content(LLMで退屈区間カット) / both
    tempo_mode: str = field(default_factory=lambda: _env("TEMPO_MODE", "off"))

    caption: CaptionStyle = field(default_factory=CaptionStyle)
    title: TitleStyle = field(default_factory=TitleStyle)
    safe: SafeZone = field(default_factory=SafeZone)

    def effective_provider(self) -> str:
        """キーが無いプロバイダが指定された場合は heuristic に落とす。"""
        p = self.llm_provider.lower()
        if self.gemini_proxy_url and p in ("gemini", "claude"):
            return p
        if p == "gemini" and not self.gemini_api_key:
            return "heuristic"
        if p == "openai" and not self.openai_api_key:
            return "heuristic"
        if p == "claude" and not self.anthropic_api_key:
            return "heuristic"
        return p


SETTINGS = Settings()
