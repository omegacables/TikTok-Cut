"""音声ラウドネス解析。

文字起こし（テキスト）だけでは拾えない「声の無い盛り上がり」（銃声・爆発・歓声・絶叫）を
音量から検出し、ハイライト選定に加味する。さらに低音量スパン（無音・間延び）も返し、
将来のテンポ編集（ジャンプカット）に使う。

ffmpeg で mono/16kHz の生 PCM を取り出し、numpy で短時間 RMS を計算する。
"""
from __future__ import annotations

import subprocess
from pathlib import Path

from ..config import FFMPEG


def loudness(video_path: str | Path, sr: int = 16000, win: float = 0.5,
             ffmpeg: str = FFMPEG) -> tuple[list[float], list[float]]:
    """(時刻[s], ラウドネス[dB]) を窓 `win` 秒ごとに返す。失敗時は ([], [])。"""
    import numpy as np

    proc = subprocess.run(
        [ffmpeg, "-hide_banner", "-nostats", "-i", str(Path(video_path).resolve()),
         "-vn", "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    pcm = np.frombuffer(proc.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    n = int(sr * win)
    if pcm.size < n:
        return [], []
    frames = pcm.size // n
    blocks = pcm[: frames * n].reshape(frames, n)
    rms = np.sqrt((blocks ** 2).mean(axis=1) + 1e-9)
    db = 20.0 * np.log10(rms + 1e-9)
    times = (np.arange(frames) * win).tolist()
    return times, db.tolist()


def waveform_peaks(video_path: str | Path, *, n: int = 400, sr: int = 8000,
                   ffmpeg: str = FFMPEG) -> list[float]:
    """波形描画用に 0-1 正規化したピーク配列を n 本返す（効果音タイムラインUI用）。失敗時 []。"""
    import numpy as np

    proc = subprocess.run(
        [ffmpeg, "-hide_banner", "-nostats", "-i", str(Path(video_path).resolve()),
         "-vn", "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    pcm = np.frombuffer(proc.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    if pcm.size == 0:
        return []
    n = max(1, int(n))
    if pcm.size < n:
        pcm = np.pad(pcm, (0, n - pcm.size))
    peaks = np.array([float(np.abs(b).max()) if b.size else 0.0
                      for b in np.array_split(pcm, n)])
    mx = float(peaks.max()) or 1.0
    return [round(float(p / mx), 4) for p in peaks]


def loud_moments(times: list[float], db: list[float], *, top_k: int = 8,
                 min_gap: float = 15.0, z: float = 1.6) -> list[float]:
    """音量が際立って高い瞬間（盛り上がり候補）の時刻を、互いに `min_gap` 秒空けて返す。"""
    if not times:
        return []
    import numpy as np

    arr = np.array(db)
    med = float(np.median(arr))
    mad = float(np.median(np.abs(arr - med))) + 1e-6
    score = (arr - med) / mad  # ロバストな z 値（外れ値＝盛り上がり）
    order = np.argsort(score)[::-1]
    picked: list[float] = []
    for i in order:
        if score[i] < z:
            break
        t = times[int(i)]
        if all(abs(t - p) >= min_gap for p in picked):
            picked.append(t)
        if len(picked) >= top_k:
            break
    return sorted(picked)


def silence_spans(times: list[float], db: list[float], *, win: float = 0.5,
                  rel_db: float = -18.0, min_len: float = 0.6) -> list[tuple[float, float]]:
    """中央値より `rel_db` dB 以上低い静かな区間（無音・間延び）を返す。テンポ編集用。"""
    if not times:
        return []
    import numpy as np

    arr = np.array(db)
    thr = float(np.median(arr)) + rel_db
    spans: list[tuple[float, float]] = []
    start = None
    for i, d in enumerate(arr):
        quiet = d < thr
        if quiet and start is None:
            start = times[i]
        elif not quiet and start is not None:
            end = times[i]
            if end - start >= min_len:
                spans.append((round(start, 2), round(end, 2)))
            start = None
    if start is not None:
        end = times[-1] + win
        if end - start >= min_len:
            spans.append((round(start, 2), round(end, 2)))
    return spans
