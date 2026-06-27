# -*- mode: python ; coding: utf-8 -*-
# backend を単一フォルダ exe (TikTok-Cut-Backend) にパッケージする。
# ffmpeg/ffprobe を同梱し、faster-whisper / ctranslate2 / onnxruntime を確実に取り込む。
import glob
import os
import shutil
from PyInstaller.utils.hooks import collect_all

ROOT = os.path.dirname(SPECPATH)  # プロジェクトルート（packaging/ の親）

datas, binaries, hiddenimports = [], [], []

# ML / Web / サーバ関連を丸ごと収集（足りない依存取りこぼしを防ぐ）
for pkg in [
    "faster_whisper", "ctranslate2", "onnxruntime", "av",
    "tokenizers", "huggingface_hub", "uvicorn", "fastapi", "starlette", "tinysegmenter",
    "google.genai",  # 任意（未導入ならスキップ）
]:
    try:
        d, b, h = collect_all(pkg)
        datas += d; binaries += b; hiddenimports += h
    except Exception:
        pass

# Web UI（_internal/web に配置 → config.PROJECT_DIR/web で解決）
datas += [(os.path.join(ROOT, "web"), "web")]

# 同梱フォント（_internal/assets/fonts → config.FONTS_DIR で解決）
fonts_dir = os.path.join(ROOT, "assets", "fonts")
if os.path.isdir(fonts_dir):
    datas.append((fonts_dir, os.path.join("assets", "fonts")))

# 同梱効果音（_internal/assets/sfx → config.SFX_DIR で解決）
sfx_dir = os.path.join(ROOT, "assets", "sfx")
if os.path.isdir(sfx_dir):
    datas.append((sfx_dir, os.path.join("assets", "sfx")))

# ffmpeg を同梱（軽量 essentials を優先。ffprobe は廃止し ffmpeg で尺取得）
ffmpeg_local = os.path.join(ROOT, "packaging", "ffmpeg", "ffmpeg.exe")
if os.path.exists(ffmpeg_local):
    binaries.append((ffmpeg_local, "."))
else:
    p = shutil.which("ffmpeg")
    if p:
        binaries.append((os.path.realpath(p), "."))

# CUDA ランタイム DLL（cublas/cudnn/cudart/nvrtc）を _internal 直下へ同梱 → GPU 文字起こし。
# 無い環境では transcribe が自動で CPU にフォールバックする。
try:
    import nvidia
    for _base in list(getattr(nvidia, "__path__", [])):
        for _dll in glob.glob(os.path.join(_base, "*", "bin", "*.dll")):
            binaries.append((_dll, "."))
except Exception:
    pass

a = Analysis(
    [os.path.join(ROOT, "packaging", "backend_entry.py")],
    pathex=[ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports + ["backend.server", "backend.pipeline.align_transfer"],
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "PyQt5", "PySide6"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="TikTok-Cut-Backend",
    console=True,          # stdout の BACKEND_READY を拾う（spawn 時は windowsHide で非表示）
    disable_windowed_traceback=False,
)
coll = COLLECT(
    exe, a.binaries, a.datas,
    strip=False, upx=False,
    name="TikTok-Cut-Backend",
)
