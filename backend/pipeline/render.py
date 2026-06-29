"""ffmpeg による描画: クリップ切出し → 9:16 リフレーム → カラオケ字幕焼き込み。

Windows の filtergraph 内パス問題を避けるため、ASS は出力先ディレクトリに置き、
ffmpeg を cwd=出力先 で起動して basename 参照する。
"""
from __future__ import annotations

import functools
import os
import re
import subprocess
import threading
from pathlib import Path

from ..config import FFMPEG, FONTS_DIR, OUTPUT_H, OUTPUT_W, SETTINGS


class RenderError(RuntimeError):
    pass


def check_ffmpeg(ffmpeg: str | None = None) -> None:
    """ffmpeg の存在と実行可能性を確認。無ければ分かりやすいエラーを出す。"""
    import shutil
    cmd = ffmpeg or FFMPEG
    if shutil.which(cmd) is None and not Path(cmd).exists():
        raise RenderError(
            f"ffmpeg が見つかりません（検索パス: {cmd}）。"
            "ffmpeg をインストールして PATH に通してください。\n"
            "https://ffmpeg.org/download.html"
        )
    try:
        proc = subprocess.run(
            [cmd, "-version"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", timeout=10,
        )
        ver = (proc.stdout or "").split("\n", 1)[0]
        print(f"[info] ffmpeg OK: {ver}", flush=True)
    except Exception as e:
        raise RenderError(f"ffmpeg は存在しますが実行できません（{cmd}）: {e}") from e


def replace_retry(src, dst, tries: int = 12, delay: float = 0.3) -> None:
    """os.replace を再試行付きで（Windowsで出力mp4が一時的にロック=WinError5 のとき有効）。"""
    import time
    last = None
    for i in range(tries):
        try:
            os.replace(src, dst)
            return
        except PermissionError as e:   # WinError 5 等。AV/プレイヤーのロック解放を待って再試行
            last = e
            time.sleep(delay)
        except OSError as e:
            last = e
            time.sleep(delay)
    raise last if last else OSError(f"replace failed: {src} -> {dst}")


def _run(args: list[str], cwd: Path | None = None) -> None:
    proc = subprocess.run(
        args,
        cwd=str(cwd) if cwd else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        tail = "\n".join((proc.stderr or "").strip().splitlines()[-12:])
        cmd_str = " ".join(args[:6]) + " ..." if len(args) > 6 else " ".join(args)
        print(f"[render] ffmpeg failed: {cmd_str}\n  cwd={cwd}\n  stderr(tail)={tail}", flush=True)
        raise RenderError(f"ffmpeg 失敗 (code {proc.returncode}):\n{tail}")


# ===== ハードウェアエンコード(NVENC)判定とコーデック引数の一元化 =====
# GPU 機では h264_nvenc でエンコードを大幅高速化。非対応機（GPU無し等）は libx264 に自動フォールバック。
@functools.lru_cache(maxsize=8)
def _nvenc_available(ffmpeg: str = FFMPEG) -> bool:
    """ffmpeg が h264_nvenc を持つか（プロセス毎に1回だけ -encoders を実行してキャッシュ）。"""
    if os.environ.get("TIKTOKCUT_NVENC", "").strip().lower() in ("0", "false", "off"):
        return False
    try:
        proc = subprocess.run(
            [ffmpeg, "-hide_banner", "-encoders"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", timeout=15,
        )
        return "h264_nvenc" in (proc.stdout or "")
    except Exception:
        return False


def _video_codec_args(*, use_nvenc: bool | None = None, ffmpeg: str = FFMPEG) -> list[str]:
    """映像コーデック引数（全エンコード箇所で共有）。NVENC 可なら GPU、不可なら libx264。"""
    if use_nvenc is None:
        use_nvenc = _nvenc_available(ffmpeg)
    if use_nvenc:
        # p5 ≈ veryfast バランス、cq23 ≈ crf20 相当。-b:v 0 で cq 主導（一部ビルドの 2M クランプ回避）。
        return [
            "-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr",
            "-cq", "23", "-b:v", "0", "-pix_fmt", "yuv420p",
        ]
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]


_NVENC_DISABLED = False
_nvenc_lock = threading.Lock()


def _run_with_nvenc_fallback(build, *, cwd: Path | None = None, ffmpeg: str = FFMPEG) -> None:
    """build(use_nvenc)->args を実行。NVENC 失敗時は libx264 で1回リトライ。

    恒久的な NVENC 不可（ドライバ/デバイス無し）はモジュール全体で以後無効化し、
    クリップ毎の無駄な再試行を避ける（並列描画でも安全なよう Lock 保護）。
    """
    global _NVENC_DISABLED
    if _NVENC_DISABLED or not _nvenc_available(ffmpeg):
        _run(build(False), cwd=cwd)
        return
    try:
        _run(build(True), cwd=cwd)
    except RenderError as e:
        msg = str(e).lower()
        if any(s in msg for s in ("cannot load nvcuda", "no nvenc capable",
                                  "no capable devices", "nvenc", "cuda",
                                  "driver", "gpu", "device")):
            with _nvenc_lock:
                _NVENC_DISABLED = True
        print(f"[render] NVENC 失敗、libx264 で再試行: {type(e).__name__}", flush=True)
        _run(build(False), cwd=cwd)


def _logo_overlay_chain(in_label: str, out_label: str, logo_idx: int,
                        position: str, scale: float, opacity: float) -> str:
    """ロゴ(PNG等)を隅へ重ねる filter_complex 断片。in_label の映像に logo_idx 入力を合成→out_label。"""
    mx, my = int(OUTPUT_W * 0.045), int(OUTPUT_H * 0.05)
    lw = max(40, int(OUTPUT_W * max(0.04, min(0.5, scale))))
    pos = {
        "tl": f"{mx}:{my}", "tr": f"W-w-{mx}:{my}",
        "bl": f"{mx}:H-h-{my}", "br": f"W-w-{mx}:H-h-{my}",
    }.get(position, f"W-w-{mx}:H-h-{my}")
    op = max(0.1, min(1.0, opacity))
    return (f"[{logo_idx}:v]scale={lw}:-1,format=rgba,colorchannelmixer=aa={op:.2f}[__lg];"
            f"{in_label}[__lg]overlay={pos}{out_label}")


def _logo_ok(logo: dict | None) -> bool:
    """ロゴ dict が有効（path 存在）か。"""
    try:
        return bool(logo and logo.get("path") and Path(logo["path"]).exists())
    except Exception:
        return False


def _has_audio(video_path: str | Path, ffmpeg: str = FFMPEG) -> bool:
    """入力に音声ストリームがあるか（ffprobe 非依存・`ffmpeg -i` 解析）。"""
    proc = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", str(Path(video_path).resolve())],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, errors="replace",
    )
    return "Audio:" in (proc.stderr or "")


def _ff_color(hex_or_name: str | None, default: str = "black") -> str:
    """UI の #RRGGBB を ffmpeg の 0xRRGGBB に変換（色名/不正値はそのまま/既定）。"""
    s = (hex_or_name or "").strip()
    if not s:
        return default
    if s.startswith("#") and len(s) == 7:
        return "0x" + s[1:]
    return s


def _reframe_filter(mode: str, letterbox_color: str = "black") -> str:
    if mode == "letterbox":
        col = _ff_color(letterbox_color)
        return (
            f"scale={OUTPUT_W}:{OUTPUT_H}:force_original_aspect_ratio=decrease,"
            f"pad={OUTPUT_W}:{OUTPUT_H}:(ow-iw)/2:(oh-ih)/2:color={col}"
        )
    if mode == "blur":
        # CapCut 風: 背景は拡大クロップ＋ぼかし、前景は全体が収まるよう縮小して中央に重ねる。
        # 上下黒帯にならず、横長ソースでも縦型がおしゃれに埋まる。split→2系統→overlay。
        return (
            f"split=2[bg][fg];"
            f"[bg]scale={OUTPUT_W}:{OUTPUT_H}:force_original_aspect_ratio=increase,"
            f"crop={OUTPUT_W}:{OUTPUT_H},gblur=sigma=22,eq=brightness=-0.06[bgb];"
            f"[fg]scale={OUTPUT_W}:{OUTPUT_H}:force_original_aspect_ratio=decrease[fgs];"
            f"[bgb][fgs]overlay=(W-w)/2:(H-h)/2"
        )
    # 既定: 中央クロップで全画面 9:16
    return (
        f"scale={OUTPUT_W}:{OUTPUT_H}:force_original_aspect_ratio=increase,"
        f"crop={OUTPUT_W}:{OUTPUT_H}"
    )


def probe_fps(video_path: str | Path, ffmpeg: str = FFMPEG, default: float = 30.0) -> float:
    """ffmpeg -i の出力から映像の fps を取得（zoompan の元 fps 維持用）。失敗時 default。"""
    proc = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", str(Path(video_path).resolve())],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, errors="replace",
    )
    m = re.search(r"(\d+(?:\.\d+)?)\s*fps", proc.stderr or "")
    if m:
        try:
            f = float(m.group(1))
            if 1.0 < f <= 240.0:
                return f
        except ValueError:
            pass
    return default


def _intro_video_filter(intro: str, fps: float, dur: float = 0.5) -> str:
    """クリップ冒頭の映像トランジション。リフレーム＋字幕焼き込み後に適用する。"""
    intro = (intro or "none").lower()
    if intro in ("", "none"):
        return ""
    if intro == "fade":
        return f"fade=t=in:st=0:d={dur:.2f}"
    if intro == "flash":
        return f"fade=t=in:st=0:d={min(0.3, dur):.2f}:color=white"
    W, H, d = OUTPUT_W, OUTPUT_H, dur
    if intro == "zoom":
        # パンチイン: 開始は拡大表示→約 dur 秒でゼロイン（等倍）に収束。元 fps を維持。
        nf = max(1, int(round(dur * fps)))
        z0 = 1.18
        return (
            f"zoompan=z='if(lte(on,{nf}),{z0:.3f}-{z0 - 1.0:.3f}*on/{nf},1.0)':"
            f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
            f"d=1:s={W}x{H}:fps={fps:.3f}"
        )
    if intro == "zoomout":
        # 拡大状態(1.5x)から等倍へ収束。zoompan は on(フレーム番号)で時間を扱う。
        nf = max(1, int(round(d * fps)))
        return (
            f"zoompan=z='if(lte(on,{nf}),1.5-0.5*on/{nf},1.0)':"
            f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={W}x{H}:fps={fps:.3f}"
        )
    if intro == "slide":   # 左からスライドイン（pad で黒地を作り crop 窓を移動）
        return (f"pad=2*iw:ih:0:0:black,crop={W}:{H}:"
                f"x='if(lt(t,{d:.2f}),iw/2*({d:.2f}-t)/{d:.2f},0)':y=0")
    if intro == "slidedown":   # 上から落とす
        return (f"pad=iw:2*ih:0:0:black,crop={W}:{H}:"
                f"x=0:y='if(lt(t,{d:.2f}),ih/2*({d:.2f}-t)/{d:.2f},0)'")
    if intro == "spin":   # 回転イン（拡大crop で黒角を隠す）
        return (f"rotate=a='if(lt(t,{d:.2f}),({d:.2f}-t)/{d:.2f}*0.6,0)':ow=iw:oh=ih:c=black,"
                f"scale={int(W * 1.1)}:{int(H * 1.1)},crop={W}:{H}")
    if intro == "shake":   # 減衰するカメラシェイク
        return (f"pad=iw+60:ih+60:30:30:black,crop={W}:{H}:"
                f"x='if(lt(t,{d:.2f}),30+({d:.2f}-t)/{d:.2f}*25*sin(t*90),30)':"
                f"y='if(lt(t,{d:.2f}),30+({d:.2f}-t)/{d:.2f}*25*cos(t*110),30)'")
    if intro == "glitch":   # 一瞬の色ずれ（rgbashift は t 非対応なので静的値＋enable で短時間）
        return "rgbashift=rh=14:bh=-14:enable='lt(t,0.12)'"
    return ""


def _audio_intro_filter(intro: str, dur: float = 0.4) -> str:
    """冒頭トランジションに合わせた音声フェードイン。"""
    intro = (intro or "none").lower()
    if intro in ("", "none"):
        return ""
    d = 0.18 if intro == "flash" else dur
    return f"afade=t=in:st=0:d={d:.2f}"


def render_clip(
    input_video: str | Path,
    start: float,
    end: float,
    ass_content: str,
    out_path: str | Path,
    *,
    reframe_mode: str | None = None,
    intro: str | None = None,
    letterbox_color: str = "black",
    logo: dict | None = None,
    fonts_dir: str | Path | None = FONTS_DIR,
    ffmpeg: str = FFMPEG,
) -> Path:
    """1 クリップを描画して out_path に書き出す。logo 指定時は同一パスで合成（再エンコード削減）。"""
    input_video = Path(input_video).resolve()
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    duration = max(0.1, end - start)
    mode = reframe_mode or SETTINGS.reframe_mode

    # ASS を出力先に配置（filtergraph では basename で参照）
    ass_name = out_path.stem + ".ass"
    (out_path.parent / ass_name).write_text(ass_content, encoding="utf-8")

    # 同梱フォントを libass に渡す。絶対パスのドライブ ":" は filtergraph と衝突するため
    # cwd(出力先)からの相対パスにして ":" を回避する。
    ass_opt = ass_name
    if fonts_dir and Path(fonts_dir).exists():
        try:
            rel = os.path.relpath(Path(fonts_dir).resolve(), out_path.parent.resolve())
            ass_opt = f"{ass_name}:fontsdir={rel.replace(chr(92), '/')}"
        except ValueError:
            fd = str(Path(fonts_dir)).replace("\\", "/").replace(":", "\\:")
            ass_opt = f"{ass_name}:fontsdir={fd}"

    # リフレーム → 字幕焼き込み → 冒頭トランジション（映像） → ロゴ（最前面）の順。
    vf_parts = [_reframe_filter(mode, letterbox_color), f"ass={ass_opt}"]
    intro_v = _intro_video_filter(intro, probe_fps(input_video)) if intro else ""
    if intro_v:
        vf_parts.append(intro_v)
    vf_chain = ",".join(vf_parts)
    intro_a = _audio_intro_filter(intro) if intro else ""
    use_logo = _logo_ok(logo)

    def build(use_nvenc: bool) -> list[str]:
        # -ss は入力前（高速シーク）。-t は全入力の後＝出力オプションにする
        # （ロゴ入力の前に置くと -t がロゴPNGの入力長指定と解釈され、出力尺が崩れる）。
        args = [ffmpeg, "-y", "-ss", f"{start:.3f}", "-i", str(input_video)]
        if use_logo:
            # ロゴ有り: 第2入力(PNG)が要るため -vf でなく -filter_complex で 1 パス合成。
            args += ["-i", str(Path(logo["path"]).resolve())]
            fc = (f"[0:v]{vf_chain}[__v];"
                  + _logo_overlay_chain("[__v]", "[vout]", 1, logo.get("position", "br"),
                                        float(logo.get("scale", 0.16)), float(logo.get("opacity", 0.9))))
            args += ["-filter_complex", fc, "-map", "[vout]", "-map", "0:a?"]
        else:
            args += ["-vf", vf_chain]
        args += ["-t", f"{duration:.3f}"]   # 出力長の制限（全入力の後＝出力オプション）
        if intro_a:
            args += ["-af", intro_a]
        args += _video_codec_args(use_nvenc=use_nvenc, ffmpeg=ffmpeg)
        args += [
            "-c:a", "aac", "-b:a", "128k",
            "-avoid_negative_ts", "make_zero",
            "-movflags", "+faststart",
            out_path.name,
        ]
        return args

    _run_with_nvenc_fallback(build, cwd=out_path.parent, ffmpeg=ffmpeg)
    return out_path


def _fontsdir_opt(ass_name: str, out_dir: Path, fonts_dir) -> str:
    if fonts_dir and Path(fonts_dir).exists():
        try:
            rel = os.path.relpath(Path(fonts_dir).resolve(), out_dir.resolve())
            return f"{ass_name}:fontsdir={rel.replace(chr(92), '/')}"
        except ValueError:
            fd = str(Path(fonts_dir)).replace("\\", "/").replace(":", "\\:")
            return f"{ass_name}:fontsdir={fd}"
    return ass_name


def render_clip_segments(
    input_video: str | Path,
    clip_start: float,
    keeps: list[tuple[float, float]],
    ass_content: str,
    out_path: str | Path,
    *,
    reframe_mode: str | None = None,
    intro: str | None = None,
    letterbox_color: str = "black",
    logo: dict | None = None,
    fonts_dir: str | Path | None = FONTS_DIR,
    ffmpeg: str = FFMPEG,
) -> Path:
    """残し区間 keeps（クリップ先頭基準）を trim→concat で詰めて 1 本に描画する。"""
    input_video = Path(input_video).resolve()
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    mode = reframe_mode or SETTINGS.reframe_mode

    ass_name = out_path.stem + ".ass"
    (out_path.parent / ass_name).write_text(ass_content, encoding="utf-8")
    ass_opt = _fontsdir_opt(ass_name, out_path.parent, fonts_dir)

    read_dur = max(b for _, b in keeps) + 0.1
    has_audio = _has_audio(input_video, ffmpeg)   # 音声無しソースでは concat/atrim が失敗するため分岐
    parts, labels = [], []
    for i, (a, b) in enumerate(keeps):
        parts.append(f"[0:v]trim={a:.3f}:{b:.3f},setpts=PTS-STARTPTS[v{i}]")
        if has_audio:
            parts.append(f"[0:a]atrim={a:.3f}:{b:.3f},asetpts=PTS-STARTPTS[a{i}]")
            labels.append(f"[v{i}][a{i}]")
        else:
            labels.append(f"[v{i}]")
    intro_v = _intro_video_filter(intro, probe_fps(input_video)) if intro else ""
    intro_a = _audio_intro_filter(intro) if intro else ""
    use_logo = _logo_ok(logo)
    # ロゴ有り時は映像鎖を [vpre] で止め、ロゴ合成を続けて [vout] に出す。
    vlast = "[vpre]" if use_logo else "[vout]"
    vchain = f"[cv]{_reframe_filter(mode, letterbox_color)},ass={ass_opt}" + (f",{intro_v}" if intro_v else "") + vlast
    if has_audio:
        achain = (f"[ca]{intro_a}[aout]" if intro_a else None)
        amap = "[aout]" if achain else "[ca]"
        chains = [f"{''.join(labels)}concat=n={len(keeps)}:v=1:a=1[cv][ca]", vchain]
    else:
        achain = None
        amap = None
        chains = [f"{''.join(labels)}concat=n={len(keeps)}:v=1:a=0[cv]", vchain]
    if use_logo:
        chains.append(_logo_overlay_chain(
            "[vpre]", "[vout]", 1, logo.get("position", "br"),
            float(logo.get("scale", 0.16)), float(logo.get("opacity", 0.9))))
    if achain:
        chains.append(achain)
    fc = ";".join(parts + chains)

    def build(use_nvenc: bool) -> list[str]:
        args = [ffmpeg, "-y", "-ss", f"{clip_start:.3f}", "-t", f"{read_dur:.3f}",
                "-i", str(input_video)]
        if use_logo:
            args += ["-i", str(Path(logo["path"]).resolve())]   # 入力 #1 = ロゴ
        args += ["-filter_complex", fc, "-map", "[vout]"]
        if amap:
            args += ["-map", amap, "-c:a", "aac", "-b:a", "128k"]
        else:
            args += ["-an"]   # 音声無しソース
        args += _video_codec_args(use_nvenc=use_nvenc, ffmpeg=ffmpeg)
        args += ["-movflags", "+faststart", out_path.name]
        return args

    _run_with_nvenc_fallback(build, cwd=out_path.parent, ffmpeg=ffmpeg)
    return out_path


def overlay_logo(
    video_path: str | Path,
    logo_path: str | Path,
    *,
    position: str = "br",
    scale: float = 0.16,
    opacity: float = 0.9,
    ffmpeg: str = FFMPEG,
) -> Path:
    """生成済みクリップにロゴ画像（PNG等）を隅へ重ねて焼き込む（任意・2パス）。

    文字の @ハンドルは字幕(ASS)側で焼くため、ここは画像ロゴ専用。透過 PNG 推奨。
    """
    video_path = Path(video_path).resolve()
    logo_path = Path(logo_path)
    if not logo_path.exists():
        return video_path
    tmp = video_path.with_name(video_path.stem + "__wm.mp4")
    mx, my = int(OUTPUT_W * 0.045), int(OUTPUT_H * 0.05)
    lw = max(40, int(OUTPUT_W * max(0.04, min(0.5, scale))))
    pos = {
        "tl": f"{mx}:{my}",
        "tr": f"W-w-{mx}:{my}",
        "bl": f"{mx}:H-h-{my}",
        "br": f"W-w-{mx}:H-h-{my}",
    }.get(position, f"W-w-{mx}:H-h-{my}")
    op = max(0.1, min(1.0, opacity))
    fc = (
        f"[1:v]scale={lw}:-1,format=rgba,colorchannelmixer=aa={op:.2f}[lg];"
        f"[0:v][lg]overlay={pos}[vout]"
    )

    def build(use_nvenc: bool) -> list[str]:
        return [
            ffmpeg, "-y",
            "-i", str(video_path),
            "-i", str(logo_path.resolve()),
            "-filter_complex", fc,
            "-map", "[vout]", "-map", "0:a?",
            *_video_codec_args(use_nvenc=use_nvenc, ffmpeg=ffmpeg),
            "-c:a", "copy",
            "-movflags", "+faststart",
            tmp.name,
        ]

    _run_with_nvenc_fallback(build, cwd=video_path.parent, ffmpeg=ffmpeg)
    replace_retry(tmp, video_path)
    return video_path


def make_thumbnail(
    video_path: str | Path,
    out_path: str | Path,
    *,
    at: float = 0.5,
    ffmpeg: str = FFMPEG,
) -> Path:
    """動画の指定割合位置から 1 フレームをサムネイルとして書き出す。"""
    video_path = Path(video_path).resolve()
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    args = [
        ffmpeg, "-y",
        "-ss", f"{max(0.0, at):.3f}",
        "-i", str(video_path),
        "-frames:v", "1",
        "-q:v", "3",
        out_path.name,
    ]
    _run(args, cwd=out_path.parent)
    return out_path


def probe_duration(video_path: str | Path, ffmpeg: str = FFMPEG) -> float:
    """ffmpeg の出力から動画長（秒）を取得（ffprobe 非依存で軽量化）。失敗時 0.0。"""
    proc = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", str(Path(video_path).resolve())],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, errors="replace",
    )
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", proc.stderr or "")
    if m:
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    return 0.0
