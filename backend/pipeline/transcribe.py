"""faster-whisper による文字起こし（単語タイムスタンプ付き）。

単語タイムスタンプは TikTok 風カラオケ字幕の生成に必須。
結果は JSON にキャッシュし、再実行時の再 STT を避ける。
"""
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path

from ..config import SETTINGS


@dataclass
class Word:
    start: float   # 動画先頭からの秒
    end: float
    text: str


@dataclass
class Segment:
    start: float
    end: float
    text: str


@dataclass
class Transcript:
    language: str
    duration: float
    text: str
    words: list[Word]
    segments: list[Segment]

    def to_json(self) -> dict:
        return {
            "language": self.language,
            "duration": self.duration,
            "text": self.text,
            "words": [asdict(w) for w in self.words],
            "segments": [asdict(s) for s in self.segments],
        }

    @classmethod
    def from_json(cls, d: dict) -> "Transcript":
        return cls(
            language=d["language"],
            duration=d["duration"],
            text=d["text"],
            words=[Word(**w) for w in d["words"]],
            segments=[Segment(**s) for s in d["segments"]],
        )


def _resolve_device() -> tuple[str, str]:
    """(device, compute_type) を決める。"""
    pref = SETTINGS.whisper_device.lower()
    # GPU は int8_float16（VRAM 約半分・品質ほぼ維持。large-v3 を 8GB 以下でも載せやすい）
    if pref in ("cpu",):
        return "cpu", "int8"
    if pref in ("cuda", "gpu"):
        return "cuda", "int8_float16"
    # auto: CUDA が使えるか軽く判定
    try:
        import ctranslate2  # faster-whisper の依存

        if ctranslate2.get_cuda_device_count() > 0:  # type: ignore[attr-defined]
            return "cuda", "int8_float16"
    except Exception:
        pass
    return "cpu", "int8"


def _add_cuda_dll_dirs() -> None:
    """pip の nvidia-* パッケージの bin を DLL 検索パスに追加（Windows GPU 用）。"""
    try:
        import nvidia  # type: ignore

        # nvidia は名前空間パッケージ（__file__ は None）。__path__ を辿る。
        dirs = []
        for base in list(getattr(nvidia, "__path__", [])):
            dirs += [str(p) for p in Path(base).glob("*/bin") if p.is_dir()]
        for d in dirs:
            try:
                os.add_dll_directory(d)
            except Exception:
                pass
        if dirs:  # PATH にも前置（add_dll_directory が効かないローダ対策）
            os.environ["PATH"] = os.pathsep.join(dirs) + os.pathsep + os.environ.get("PATH", "")
    except Exception:
        pass


# モジュール読込時（ctranslate2 を import する前）に CUDA DLL パスを通す
_add_cuda_dll_dirs()


_MODEL_CACHE: dict[str, object] = {}
_BATCHED_CACHE: dict[str, object] = {}


def _evict(key: str) -> None:
    """キャッシュからモデルを破棄し VRAM を解放（OOM降格前に呼ぶ）。

    バッチ→本体の順に参照を落とさないと ctranslate2 のデストラクタが走らず GPU メモリが残り、
    降格先モデルの読込で再び OOM する。
    """
    _BATCHED_CACHE.pop(key, None)   # WhisperModel を参照しているので先に落とす
    _MODEL_CACHE.pop(key, None)
    try:
        import gc
        gc.collect()
    except Exception:
        pass
    try:
        import torch
        torch.cuda.empty_cache()
    except Exception:
        pass


def _default_model(device: str) -> str:
    """ユーザー未指定時の既定モデル。

    GPUは高精度の large-v3、GPU無しは kotoba-whisper（CPUで large-v3 は激遅のため）。
    """
    return "large-v3" if device == "cuda" else "kotoba-tech/kotoba-whisper-v2.0-faster"


def _cpu_threads() -> int:
    """CPU文字起こしのスレッド数（明示しないとコアを使い切らない）。env で上書き可。"""
    env = os.environ.get("WHISPER_CPU_THREADS", "").strip()
    if env.isdigit() and int(env) > 0:
        return int(env)
    return min(8, max(1, os.cpu_count() or 4))


def _get_model(device: str, compute_type: str, model_name: str | None = None):
    from faster_whisper import WhisperModel

    name = model_name or SETTINGS.whisper_model or _default_model(device)
    key = f"{name}:{device}:{compute_type}"
    if key not in _MODEL_CACHE:
        if device == "cuda":
            _add_cuda_dll_dirs()
        kwargs = {}
        if device == "cpu":
            kwargs["cpu_threads"] = _cpu_threads()   # GPU無し機でコアを活用
        _MODEL_CACHE[key] = WhisperModel(name, device=device, compute_type=compute_type, **kwargs)
    return _MODEL_CACHE[key]


def _get_batched(model, key: str):
    """WhisperModel を BatchedInferencePipeline で包む（キャッシュ）。利用不可なら None→逐次。"""
    if key in _BATCHED_CACHE:
        return _BATCHED_CACHE[key]
    try:
        from faster_whisper import BatchedInferencePipeline
        _BATCHED_CACHE[key] = BatchedInferencePipeline(model=model)
    except Exception as e:  # 古い faster-whisper 等
        print(f"[transcribe] バッチ推論 利用不可 ({type(e).__name__}: {e}) → 逐次実行", flush=True)
        _BATCHED_CACHE[key] = None
    return _BATCHED_CACHE[key]


def _is_oom(e: Exception) -> bool:
    s = str(e).lower()
    return any(k in s for k in ("out of memory", "oom", "cudamalloc", "out_of_memory"))


def _no_word_ts(model_name: str) -> bool:
    """蒸留系（kotoba / distil / turbo）は単語タイムスタンプが不安定でクラッシュ要因。

    これらはセグメント単位で文字起こしし、語の時刻はセグメントから合成する。
    """
    n = (model_name or "").lower()
    return ("kotoba" in n) or ("distil" in n) or ("turbo" in n)


def _synth_words(start: float, end: float, text: str) -> list["Word"]:
    """セグメント [start,end] のテキストを語に分割し、文字数比例で時刻を割り当てる。"""
    text = (text or "").strip()
    if not text:
        return []
    toks = _tokenize(text)
    span = max(0.02, end - start)
    total = sum(len(t) for t in toks) or 1
    out: list[Word] = []
    cum = 0
    for t in toks:
        s = start + span * (cum / total)
        cum += len(t)
        e = start + span * (cum / total)
        out.append(Word(start=round(s, 3), end=round(max(s + 0.02, e), 3), text=t))
    return out


def _timing_donor_words(video_path, language, device, compute_type, progress=None) -> list["Word"] | None:
    """単語時刻を出せる軽量モデル（base 等）を別途走らせ、実単語タイムスタンプを得る。

    kotoba は単語時刻を出さないため、その「テキスト」へこの実時刻を後段で移植する（align_transfer）。
    モデル未指定/失敗時は None を返し、呼び出し側は synth 時刻を維持する（決して落とさない）。
    """
    donor_name = (SETTINGS.kotoba_timing_donor or "").strip()
    if not donor_name:
        return None
    try:
        if progress:
            progress(0.50, "単語タイミング取得中")
        model = _get_model(device, compute_type, donor_name)
        seg_iter, info = model.transcribe(
            str(video_path), language=language, word_timestamps=True,
            vad_filter=True, beam_size=1, condition_on_previous_text=False,
            no_speech_threshold=0.6, compression_ratio_threshold=2.4,
            log_prob_threshold=-1.0, temperature=[0.0, 0.2, 0.4],
            hallucination_silence_threshold=2.0,
        )
        total = float(getattr(info, "duration", 0.0) or 0.0)
        dwords: list[Word] = []
        for seg in seg_iter:
            for w in (seg.words or []):
                tx = (w.word or "").strip()
                if tx:
                    dwords.append(Word(start=float(w.start), end=float(w.end), text=tx))
            if progress and total > 0:
                progress(min(0.95, 0.50 + 0.45 * (seg.end / total)), "単語タイミング取得中")
        return dwords or None
    except Exception as e:  # noqa: BLE001
        print(f"[transcribe] タイミング供与モデル({donor_name})失敗 ({type(e).__name__}: {e}) → synth 維持", flush=True)
        return None


def _kotoba_words(video_path, segments, language, device, compute_type, progress=None) -> list["Word"]:
    """kotoba 等（単語時刻なし）の語列を作る。供与モデルが使えれば実時刻を移植、無ければ synth。"""
    synth: list[Word] = []
    for seg in segments:
        synth.extend(_synth_words(seg.start, seg.end, seg.text))
    donor = _timing_donor_words(video_path, language, device, compute_type, progress)
    if not donor:
        return synth
    try:
        from . import align_transfer
        transferred = align_transfer.transfer_word_times(synth, donor)
        if transferred:
            print(f"[transcribe] 単語タイミングを供与モデルから移植（{len(transferred)}語）", flush=True)
            return [Word(start=t.start, end=t.end, text=t.text) for t in transferred]
    except Exception as e:  # noqa: BLE001
        print(f"[transcribe] タイミング移植失敗 ({type(e).__name__}: {e}) → synth 維持", flush=True)
    return synth


def _tokenize(text: str) -> list[str]:
    text = (text or "").strip()
    if not text:
        return []
    try:
        from .correct import _ja_tokens
        toks = _ja_tokens(text)
        if toks:
            return toks
    except Exception:
        pass
    return text.split() if " " in text else list(text)



# GPUメモリ不足時に降格する順（テロップ用の単語タイムスタンプを壊さない標準モデルのみ）
_GPU_FALLBACK = {"large-v3": "medium", "large-v2": "medium", "large": "medium", "medium": "small"}


def _is_cuda_error(e: Exception) -> bool:
    s = str(e).lower()
    # OOM は CPU フォールバック対象外（CPU で large を回すと激遅になるため即エラーにする）。
    if "out of memory" in s or "oom" in s or "cudamalloc" in s:
        return False
    # ライブラリ未ロード・デバイス不在・ドライバ不整合 → CPU フォールバック対象。
    return any(k in s for k in (
        "cublas", "cudnn", ".dll", "libcu", "not found", "cannot be loaded",
        "cuda", "nvcuda", "nvrtc", "no capable", "driver", "device",
        "nvml", "gpu", "compute capability", "runtime error",
    ))


def transcribe(
    video_path: str | Path,
    cache_path: str | Path | None = None,
    *,
    initial_prompt: str | None = None,
    hotwords: str | None = None,
    progress=None,
) -> Transcript:
    """動画/音声を文字起こしして Transcript を返す。

    initial_prompt に動画タイトル等を渡すと固有名詞の精度が上がる（YouTube URL 由来メタ）。
    hotwords に配信者名等の独自単語を渡すと、幻聴を増やさずに認識を寄せられる。
    progress(fraction: float, message: str) を渡すと進捗を通知。
    """
    video_path = Path(video_path)
    if cache_path is not None:
        cache_path = Path(cache_path)
        if cache_path.exists():
            return Transcript.from_json(json.loads(cache_path.read_text(encoding="utf-8")))

    language = SETTINGS.whisper_language or None
    device, compute_type = _resolve_device()
    model_name = SETTINGS.whisper_model or _default_model(device)
    transcript = None
    while transcript is None:
        try:
            transcript = _run(device, compute_type, video_path, language,
                              initial_prompt, hotwords, progress, model_name)
        except Exception as e:  # noqa: BLE001
            if device == "cuda" and _is_oom(e):
                # OOM したモデルを VRAM から破棄しないと降格先が再び OOM する。
                _evict(f"{model_name}:{device}:{compute_type}")
                # GPUメモリ不足: まず小さいモデルへ降格（速度維持）→ 無ければ CPU
                nxt = _GPU_FALLBACK.get(model_name)
                if nxt:
                    print(f"[transcribe] GPUメモリ不足({model_name}) → {nxt}に降格して再試行", flush=True)
                    model_name = nxt
                    continue
                print("[transcribe] GPUメモリ不足 → CPU(int8)へ（遅くなります）", flush=True)
                transcript = _run("cpu", "int8", video_path, language,
                                 initial_prompt, hotwords, progress, model_name)
            elif device == "cuda":
                # GPU での任意のエラー（DLL不足・ドライバ不整合・デバイス不在等）→ CPU で再試行
                print(f"[transcribe] GPU 不可 ({type(e).__name__}: {e}) → CPU にフォールバック", flush=True)
                cpu_model = "kotoba-tech/kotoba-whisper-v2.0-faster" if model_name in ("large-v3", "large-v2", "large", "medium") else model_name
                transcript = _run("cpu", "int8", video_path, language,
                                 initial_prompt, hotwords, progress, cpu_model)
            else:
                raise

    if cache_path is not None:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(
            json.dumps(transcript.to_json(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    return transcript


def _run(device, compute_type, video_path, language, initial_prompt, hotwords, progress,
         model_name=None) -> Transcript:
    """指定デバイスで文字起こしを実行し Transcript を返す（生成器を完全消費）。"""
    name = model_name or SETTINGS.whisper_model or _default_model(device)
    model = _get_model(device, compute_type, name)
    want_word_ts = not _no_word_ts(name)
    beam = max(1, int(SETTINGS.whisper_beam_size or 5))
    # バッチ推論で高速化（word_timestamps 対応モデルのみ。蒸留系は逐次のまま）。
    use_batched = want_word_ts and SETTINGS.whisper_batched
    batched = _get_batched(model, f"{name}:{device}:{compute_type}") if use_batched else None

    print(
        f"[transcribe] model={name} device={device} compute={compute_type} "
        f"batched={'yes' if batched else 'no'}"
        + (f" batch_size={SETTINGS.whisper_batch_size}" if batched else "")
        + f" beam={beam} word_ts={want_word_ts}",
        flush=True,
    )

    kw = dict(
        language=language,
        word_timestamps=want_word_ts,
        vad_filter=True,                 # 無音をまたぐ過剰なタイムスタンプを抑制
        initial_prompt=initial_prompt or None,
        hotwords=(hotwords or None),     # 配信者名等の独自単語のみ軽くバイアス
        beam_size=beam,
        # --- 幻聴（捏造）抑制（逐次モードで有効。バッチでは一部が無視される）---
        condition_on_previous_text=False,    # 直前テキストへの依存を切り、誤りの連鎖/繰り返しを防ぐ
        no_speech_threshold=0.6,             # 無発話判定をやや厳しめに
        compression_ratio_threshold=2.4,     # 繰り返し的な無意味出力を破棄
        log_prob_threshold=-1.0,             # 低信頼セグメントを破棄
        temperature=[0.0, 0.2, 0.4, 0.6],    # 失敗時のみ温度フォールバック
    )
    if want_word_ts:
        kw["hallucination_silence_threshold"] = 2.0  # word_timestamps 前提のため対応モデルのみ

    seg_iter = info = None
    if batched is not None:
        try:
            seg_iter, info = batched.transcribe(
                str(video_path), batch_size=int(SETTINGS.whisper_batch_size or 8), **kw)
            # 推論は生成器の消費時に走る＝OOM/実行時エラーはここで顕在化させて捕捉する
            # （消費を try の外でやると下のフォールバックに到達せずジョブごと失敗する）。
            seg_iter = list(seg_iter)
        except Exception as e:  # noqa: BLE001
            if _is_oom(e):
                raise   # OOM は外側ハンドラでモデル降格→CPU へ
            print(f"[transcribe] バッチ失敗 ({type(e).__name__}: {e}) → 逐次に切替", flush=True)
            seg_iter = info = None
    if seg_iter is None:
        seg_iter, info = model.transcribe(str(video_path), **kw)

    total = float(getattr(info, "duration", 0.0) or 0.0)
    words: list[Word] = []
    segments: list[Segment] = []
    text_parts: list[str] = []

    for seg in seg_iter:
        segments.append(Segment(start=seg.start, end=seg.end, text=seg.text.strip()))
        text_parts.append(seg.text.strip())
        if want_word_ts:
            for w in (seg.words or []):
                token = (w.word or "").strip()
                if token:
                    words.append(Word(start=float(w.start), end=float(w.end), text=token))
        if progress and total > 0:
            frac = min(0.49 if not want_word_ts else 0.99, seg.end / total)
            progress(frac, "文字起こし中")

    if not want_word_ts:
        words = _kotoba_words(video_path, segments,
                              getattr(info, "language", language) or language,
                              device, compute_type, progress)

    return Transcript(
        language=getattr(info, "language", language or "unknown"),
        duration=total or (segments[-1].end if segments else 0.0),
        text=" ".join(text_parts).strip(),
        words=words,
        segments=segments,
    )
