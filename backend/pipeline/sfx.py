"""効果音（SFX）のミックス。

タイムラインエディタで配置した効果音を、描画済みクリップの音声へ amix で重ねる。
base 音量を下げないよう `amix=...:normalize=0` を使い、各 SFX は `adelay` で指定時刻へずらす。
ロゴ焼き込み（render.overlay_logo）と同様、生成済み mp4 への 2 パス後処理。
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

from ..config import FFMPEG, SFX, sfx_path


class SfxError(RuntimeError):
    pass


def list_sfx() -> list[dict]:
    return SFX


def _has_audio(video_path: Path, ffmpeg: str) -> bool:
    """base 動画に音声ストリームがあるか（ffprobe 非依存・`ffmpeg -i` 解析）。"""
    proc = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", str(video_path)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, errors="replace",
    )
    return "Audio:" in (proc.stderr or "")


def _norm_items(items, clip_duration: float) -> list[dict]:
    """UI からの配置リストを検証・正規化（不正値/未知id/範囲外を除去）。"""
    out: list[dict] = []
    for it in items or []:
        if not isinstance(it, dict):
            continue
        p = sfx_path(str(it.get("id", "")))
        if not p:
            continue
        try:
            at = max(0.0, float(it.get("at", 0)))
        except (TypeError, ValueError):
            at = 0.0
        if clip_duration and at >= clip_duration:
            continue  # クリップ尺の外は無視
        try:
            gain = float(it.get("gain", 1.0))
        except (TypeError, ValueError):
            gain = 1.0
        out.append({"id": str(it["id"]), "path": p, "at": at,
                    "gain": max(0.0, min(3.0, gain))})
    out.sort(key=lambda x: x["at"])
    return out


def apply_sfx(video_path: str | Path, items, *, clip_duration: float = 0.0,
              ffmpeg: str = FFMPEG) -> Path:
    """描画済みクリップに効果音を amix で焼き込む（base 音量は維持）。items 無しなら無処理。"""
    video_path = Path(video_path).resolve()
    norm = _norm_items(items, clip_duration)
    if not norm:
        return video_path

    tmp = video_path.with_name(video_path.stem + "__sfx.mp4")
    inputs: list[str] = ["-i", str(video_path)]
    # base に音声が無いソースでも効果音が鳴るよう、無い場合は無音トラックを土台にする。
    if _has_audio(video_path, ffmpeg):
        base_label = "[0:a]"
        sfx_start = 1
    else:
        dur = max(0.1, float(clip_duration) or 0.0) or 60.0
        inputs += ["-f", "lavfi", "-t", f"{dur:.3f}",
                   "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"]
        base_label = "[1:a]"
        sfx_start = 2

    parts: list[str] = []
    mix = [base_label]
    for j, it in enumerate(norm):
        inputs += ["-i", str(it["path"])]
        ms = int(round(it["at"] * 1000))
        parts.append(f"[{sfx_start + j}:a]adelay={ms}|{ms},volume={it['gain']:.3f}[s{j}]")
        mix.append(f"[s{j}]")
    # normalize=0 で base を等倍維持（amix 既定は分割して base 音量が下がる）。
    # 純加算でピークが 0dBFS を超え得るため alimiter で頭打ち（level=disabled=自動レベル無効）。
    fc = ";".join(parts + [
        f"{''.join(mix)}amix=inputs={len(mix)}:normalize=0:duration=first:dropout_transition=0[mx]",
        "[mx]alimiter=level=disabled:limit=0.97[aout]",
    ])
    args = [
        ffmpeg, "-y", *inputs,
        "-filter_complex", fc,
        "-map", "0:v", "-map", "[aout]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "160k",
        "-movflags", "+faststart",
        tmp.name,
    ]
    proc = subprocess.run(
        args, cwd=str(video_path.parent),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace",
    )
    if proc.returncode != 0:
        tail = "\n".join((proc.stderr or "").strip().splitlines()[-12:])
        raise SfxError(f"効果音ミックス失敗 (code {proc.returncode}):\n{tail}")
    from .render import replace_retry
    replace_retry(tmp, video_path)   # 出力mp4のロック（WinError5）に再試行
    return video_path
