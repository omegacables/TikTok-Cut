"""CLI: ローカル mp4 から TikTok 縦型ショートを生成する。

例:
    python -m backend.cli archive.mp4 --clips 5 --out output
    python -m backend.cli archive.mp4 --title "配信タイトル" --reframe letterbox
"""
from __future__ import annotations

import argparse
import os
import sys

from .config import SETTINGS
from .pipeline.orchestrator import run_job


def _progress(percent: int, step: str) -> None:
    bar = "#" * (percent // 4) + "-" * (25 - percent // 4)
    print(f"\r[{bar}] {percent:3d}%  {step:<24}", end="", flush=True)
    if percent >= 100:
        print()


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="TikTok-Cut: 縦型ショート自動生成")
    p.add_argument("video", help="入力動画 (mp4 等)")
    p.add_argument("--out", default="output", help="出力ルート (既定: output)")
    p.add_argument("--clips", type=int, default=SETTINGS.default_clip_count, help="生成本数")
    p.add_argument("--title", default=None, help="動画タイトル等のメタ（字幕精度向上・任意）")
    p.add_argument("--url", default=None, help="YouTube URL（メタ用・任意）")
    p.add_argument(
        "--reframe", choices=["crop", "letterbox", "blur"], default=None, help="9:16 変換方式"
    )
    p.add_argument(
        "--intro", choices=["none", "fade", "zoom", "flash"], default=None,
        help="クリップ冒頭トランジション（既定 none）",
    )
    p.add_argument("--job", default=None, help="ジョブID（既存の transcript.json を再利用して再生成）")
    p.add_argument(
        "--tempo", choices=["off", "silence", "content", "both"], default=None,
        help="テンポ編集モード（不要部分カット。既定 off）",
    )
    args = p.parse_args(argv)

    meta_title = args.title or (f"YouTube: {args.url}" if args.url else None)
    print(f"プロバイダ: {SETTINGS.effective_provider()} / Whisper: {SETTINGS.whisper_model}")

    try:
        result = run_job(
            args.video,
            out_root=args.out,
            clip_count=args.clips,
            meta_title=meta_title,
            reframe_mode=args.reframe,
            intro=args.intro,
            job_id=args.job,
            tempo_mode=args.tempo,
            progress=_progress,
        )
    except Exception as e:  # noqa: BLE001
        print(f"\nエラー: {e}", file=sys.stderr)
        return 1

    print(f"\n完了: {len(result.clips)} 本（手法: {result.provider}）")
    for c in result.clips:
        print(f"  #{c.id} [{c.start:.1f}-{c.end:.1f}s] {c.title}  -> {c.file_path}")
    if result.warning:
        print(f"  警告: {result.warning}")
    return 0


if __name__ == "__main__":
    _code = main()
    # CUDA/ctranslate2 は通常終了時の後始末で稀にクラッシュ（exit 127）するため、
    # 出力を flush して即時終了し、成功コードを確実に返す。
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(_code)
