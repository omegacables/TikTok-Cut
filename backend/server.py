"""FastAPI ローカルサーバ。Electron から spawn され 127.0.0.1 で待ち受ける。

起動完了時に stdout へ `BACKEND_READY:{port}` を出力する（Electron 側がこれを待つ）。
ブラウザ単体でも動くよう、動画はローカルパス指定（Electron）と multipart アップロード
（ブラウザ）の両対応。重い処理はスレッドで実行し、進捗は /api/status でポーリングする。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import shutil
import threading
import uuid
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path

import uvicorn
from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import (FONTS, FONTS_DIR, OUTPUT_ROOT, PREFS_FILE, PROJECT_DIR, SETTINGS,
                     SFX, SFX_DIR, valid_font)
from .pipeline.orchestrator import render_from_manifest, run_job

# UI(web) は TIKTOKCUT_WEB があればそこから配信（Electron 側更新だけで UI 差し替え可能）。
# 無ければ同梱の web を使う。
WEB_DIR = (Path(os.environ["TIKTOKCUT_WEB"]).resolve()
           if os.environ.get("TIKTOKCUT_WEB") else (PROJECT_DIR / "web").resolve())

_PORT = 8000
API_TOKEN = os.environ.get("TIKTOKCUT_API_TOKEN", "").strip()
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _output_path(*parts: str | int) -> Path:
    target = OUTPUT_ROOT.joinpath(*(str(p) for p in parts)).resolve()
    if target != OUTPUT_ROOT and OUTPUT_ROOT not in target.parents:
        raise HTTPException(403, "不正なパス")
    return target


def _job_dir(job_id: str) -> Path:
    return _output_path(job_id)


def _sanitize_folder(name: str) -> str:
    """ファイルシステムに安全なフォルダ名に変換する。"""
    name = re.sub(r'[\\/:*?"<>|#%&\';\[\](){}!@^`~\x00-\x1f]', '', name)
    name = re.sub(r'[\s　]+', ' ', name).strip().strip('.')
    return name[:80] if name else ""


def _new_job_id(title: str = "") -> str:
    """保存フォルダ名を配信タイトル（あれば）、無ければ日付連番にする。

    _jobs_lock 下で呼ぶこと（連番の競合回避）。
    """
    base = _sanitize_folder(title)
    if base:
        if not (OUTPUT_ROOT / base).exists():
            return base
        n = 2
        while (OUTPUT_ROOT / f"{base}_{n}").exists():
            n += 1
        return f"{base}_{n}"

    today = datetime.datetime.now().strftime("%Y%m%d")
    n = 0
    try:
        if OUTPUT_ROOT.exists():
            for p in OUTPUT_ROOT.iterdir():
                name = p.name
                if p.is_dir() and name.startswith(today) and name[len(today):].isdigit():
                    n = max(n, int(name[len(today):]))
    except OSError:
        pass
    n += 1
    while (OUTPUT_ROOT / f"{today}{n}").exists():
        n += 1
    return f"{today}{n}"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    # ffmpeg の存在チェック（無いと生成時にクラッシュするため起動時に警告）
    from .config import FFMPEG
    print(f"[info] ffmpeg = {FFMPEG}", flush=True)
    try:
        from .pipeline.render import check_ffmpeg
        check_ffmpeg()
    except Exception as e:
        print(f"[WARNING] {e}", flush=True)
    print(f"BACKEND_READY:{_PORT}", flush=True)
    yield


app = FastAPI(title="TikTok-Cut", lifespan=lifespan)


@app.middleware("http")
async def require_api_token(request: Request, call_next):
    if API_TOKEN and request.url.path.startswith("/api/"):
        supplied = request.headers.get("X-TikTokCut-Token") or request.query_params.get("token")
        if supplied != API_TOKEN:
            return JSONResponse({"detail": "不正なリクエストです"}, status_code=403)
    return await call_next(request)

if WEB_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")
if FONTS_DIR.exists():
    # UI のフォントプレビュー用に同梱フォントを配信
    app.mount("/fonts", StaticFiles(directory=str(FONTS_DIR)), name="fonts")
if SFX_DIR.exists():
    # 効果音タイムライン UI の試聴用に同梱効果音を配信
    app.mount("/sfx", StaticFiles(directory=str(SFX_DIR)), name="sfx")


@app.get("/api/fonts")
def fonts_list():
    return FONTS


@app.get("/api/sfx")
def sfx_list():
    return SFX


@app.get("/api/prefs")
def get_prefs():
    """UI のプリセット/パレット/直近スタイルを返す（サーバ側に永続化＝起動間で消えない）。"""
    if PREFS_FILE.exists():
        try:
            return json.loads(PREFS_FILE.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return {}
    return {}


@app.post("/api/prefs")
def set_prefs(payload: dict = Body(...)):
    """UI 設定（プリセット等）を保存。"""
    try:
        PREFS_FILE.parent.mkdir(parents=True, exist_ok=True)
        PREFS_FILE.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except OSError as e:
        raise HTTPException(500, f"設定の保存に失敗しました: {e}")
    return {"ok": True}


@app.get("/api/genres")
def genres_list():
    from .pipeline import genres as genre_mod
    return genre_mod.public_list()


@app.get("/api/capabilities")
def capabilities():
    """実行環境の能力（GPU/NVENC 有無と既定 Whisper モデル）を UI へ返す。

    GPU 無し機で UI が誤って large-v3 を既定選択しないよう、推奨モデルも返す。
    """
    try:
        from .pipeline.transcribe import _default_model, _resolve_device
        device, _ = _resolve_device()
    except Exception:
        device = "cpu"
    gpu = device == "cuda"
    try:
        from .pipeline.render import _nvenc_available
        nvenc = bool(_nvenc_available())
    except Exception:
        nvenc = False
    try:
        default_model = _default_model(device)
    except Exception:
        default_model = "large-v3" if gpu else "medium"
    from .config import _REMOTE_KEY
    has_key = bool(SETTINGS.gemini_api_key)
    has_proxy = bool(SETTINGS.gemini_proxy_url)
    key_source = "proxy" if has_proxy else (
        "remote" if (_REMOTE_KEY and SETTINGS.gemini_api_key == _REMOTE_KEY) else (
            "local" if has_key else "none"))
    return {"gpu": gpu, "nvenc": nvenc, "default_model": default_model,
            "has_gemini_key": has_key or has_proxy, "gemini_key_source": key_source,
            "llm_provider": SETTINGS.effective_provider()}


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    idx = WEB_DIR / "index.html"
    if idx.exists():
        return HTMLResponse(idx.read_text(encoding="utf-8"))
    return HTMLResponse("<h1>TikTok-Cut</h1><p>web/index.html が見つかりません。</p>")


def _set(job_id: str, **kw) -> None:
    with _jobs_lock:
        if job_id in _jobs:
            _jobs[job_id].update(kw)


def _run(job_id: str, src: str, clip_count: int, meta_title: str | None,
         reframe: str, style: dict, tempo: str, intro: str,
         genres: list[str], watermark: dict | None, logo: dict | None,
         user_prompt: str, letterbox_color: str | None = None,
         laugh_on: bool = False, comment_on: bool = False) -> None:
    try:
        result = run_job(
            src,
            out_root=OUTPUT_ROOT,
            clip_count=clip_count,
            meta_title=meta_title,
            job_id=job_id,
            reframe_mode=reframe,
            letterbox_color=letterbox_color,
            intro=intro,
            style=style,
            tempo_mode=tempo,
            genres=genres,
            user_prompt=user_prompt,
            watermark=watermark,
            logo=logo,
            laugh_on=laugh_on,
            comment_on=comment_on,
            progress=lambda p, s: _set(job_id, progress=p, step=s),
        )
        if not result.clips:
            raise RuntimeError(result.warning or "クリップを作成できませんでした")
        _set(
            job_id,
            status="completed",
            progress=100,
            step="完了",
            provider=result.provider,
            language=result.language,
            duration=result.duration,
            warning=result.warning,
            clips=[asdict(c) for c in result.clips],
        )
    except Exception as e:  # noqa: BLE001
        _set(job_id, status="failed", step="失敗", error=str(e))


@app.post("/api/process")
async def process(
    url: str = Form(""),
    title: str = Form(""),
    clip_count: int = Form(SETTINGS.default_clip_count),
    reframe: str = Form(SETTINGS.reframe_mode),
    letterbox_color: str = Form(""),
    intro: str = Form("none"),
    animate: str = Form("1"),
    animation: str = Form(""),
    effect: str = Form(""),
    tempo: str = Form("off"),
    genres: str = Form(""),
    user_prompt: str = Form(""),
    font: str = Form(""),
    subtitle_color: str = Form(""),
    highlight_color: str = Form(""),
    emphasis_color: str = Form(""),
    outline_color: str = Form(""),
    title_color: str = Form(""),
    title_outline_color: str = Form(""),
    caption_size: str = Form(""),
    title_size: str = Form(""),
    outline_width: str = Form(""),
    title_outline_width: str = Form(""),
    box: str = Form("0"),
    box_color: str = Form(""),
    box_pad: str = Form(""),
    watermark: str = Form("0"),
    watermark_text: str = Form(""),
    watermark_pos: str = Form("tr"),
    logo: str = Form("0"),
    logo_path: str = Form(""),
    logo_pos: str = Form("br"),
    logo_scale: str = Form(""),
    logo_opacity: str = Form(""),
    laugh: str = Form("0"),
    comment: str = Form("0"),
    video_path: str = Form(""),
    video: UploadFile | None = File(None),
):
    with _jobs_lock:
        job_id = _new_job_id(title)
        job_dir = _job_dir(job_id)
        job_dir.mkdir(parents=True, exist_ok=False)

    if video is not None:
        suffix = Path(video.filename or "source.mp4").suffix or ".mp4"
        dest = job_dir / f"source{suffix}"
        with open(dest, "wb") as f:
            shutil.copyfileobj(video.file, f)
        src = str(dest)
    elif video_path:
        if not API_TOKEN:
            raise HTTPException(403, "ローカルパス指定はアプリ版のみ利用できます")
        if not Path(video_path).exists():
            raise HTTPException(400, "指定の動画ファイルが見つかりません")
        src = video_path
    else:
        raise HTTPException(400, "動画が指定されていません")

    with _jobs_lock:
        _jobs[job_id] = {
            "job_id": job_id,
            "status": "processing",
            "progress": 0,
            "step": "待機中",
            "clips": [],
            "error": "",
            "warning": "",
            "url": url,
        }
    def _num(v):
        try:
            return float(v) if str(v).strip() != "" else None
        except (TypeError, ValueError):
            return None

    style = {
        "font": font or None,
        "subtitle_color": subtitle_color or None,
        "highlight_color": highlight_color or None,
        "emphasis_color": (emphasis_color or highlight_color) or None,  # 強調色（旧ハイライト欄）
        "outline_color": outline_color or None,
        "title_color": title_color or None,
        "title_outline_color": title_outline_color or None,
        "animate": str(animate).lower() not in ("0", "false", "off", ""),
        "animation": animation or None,
        "effect": effect or None,
        "caption_size": _num(caption_size),
        "title_size": _num(title_size),
        "outline_width": _num(outline_width),
        "title_outline_width": _num(title_outline_width),
        "box": str(box).lower() in ("1", "true", "on"),
        "box_color": box_color or None,
        "box_pad": _num(box_pad),
    }
    genre_list = [g for g in (genres or "").split(",") if g.strip()]

    wm = None
    if str(watermark).lower() in ("1", "true", "on"):
        text = (watermark_text or os.environ.get("TIKTOKCUT_HANDLE", "")).strip()
        if text:
            wm = {"text": text, "position": watermark_pos or "tr"}
    lg = None
    if str(logo).lower() in ("1", "true", "on"):
        lpath = (logo_path or os.environ.get("TIKTOKCUT_LOGO", "")).strip()
        if lpath and Path(lpath).exists():
            lg = {"path": lpath, "position": logo_pos or "br",
                  "scale": _num(logo_scale) or 0.16, "opacity": _num(logo_opacity) or 0.9}

    threading.Thread(
        target=_run,
        args=(job_id, src, clip_count, (title or None), reframe, style, tempo, intro,
              genre_list, wm, lg, (user_prompt or ""),
              (letterbox_color or None),
              str(laugh).lower() in ("1", "true", "on"),
              str(comment).lower() in ("1", "true", "on")),
        daemon=True,
    ).start()
    return {"job_id": job_id}


@app.get("/api/status/{job_id}")
def status(job_id: str):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job:
            return dict(job)
    # メモリに無ければディスクの result.json から復元（再起動後など）
    rj = _output_path(job_id, "result.json")
    if rj.exists():
        data = json.loads(rj.read_text(encoding="utf-8"))
        return {
            "job_id": job_id,
            "status": "completed",
            "progress": 100,
            "step": "完了",
            "clips": data.get("clips", []),
            "provider": data.get("provider", ""),
            "warning": data.get("warning", ""),
            "error": "",
        }
    raise HTTPException(404, "ジョブが見つかりません")


@app.get("/api/clip/{job}/{cid}")
def get_clip(job: str, cid: int):
    """手動修正UI用: クリップの編集データ（タイトル/テロップ）を返す。"""
    mf = _output_path(job, f"clip_{cid:02d}.json")
    if not mf.exists():
        raise HTTPException(404, "クリップ情報が見つかりません")
    m = json.loads(mf.read_text(encoding="utf-8"))
    return {"id": m["id"], "title": m.get("title", ""), "hook": m.get("hook", ""),
            "telops": m.get("telops", []), "style": m.get("style", {}),
            "telops_orig": m.get("telops_orig", []),   # 「初期設定に戻す」用の原字幕
            "keeps": m.get("keeps"), "keeps_orig": m.get("keeps_orig"),   # 部分カット（残し区間）
            "start": m.get("start"), "end": m.get("end"),               # 元クリップ範囲（カット計算用）
            "sub_offset": m.get("sub_offset", 0.0),
            "intro": m.get("intro", "none"), "sfx": m.get("sfx", []),
            "clip_duration": m.get("clip_duration", 0.0),
            "reframe": m.get("reframe", "crop"), "letterbox_color": m.get("letterbox_color", "#000000")}


@app.get("/api/clip/{job}/{cid}/waveform")
def clip_waveform(job: str, cid: int, n: int = 400):
    """効果音タイムライン用に、生成済みクリップの波形ピーク（0-1）と尺を返す。

    mp4 の mtime をキーに clip_XX.peaks.json へキャッシュ（再描画で mp4 が更新されると自動失効）。
    """
    from .pipeline import audio
    mp4 = _output_path(job, f"clip_{cid:02d}.mp4")
    if not mp4.exists():
        raise HTTPException(404, "クリップが見つかりません")
    n = max(50, min(2000, int(n)))
    mtime = mp4.stat().st_mtime
    cache = _output_path(job, f"clip_{cid:02d}.peaks.json")
    if cache.exists():
        try:
            cached = json.loads(cache.read_text(encoding="utf-8"))
            if cached.get("mtime") == mtime and cached.get("n") == n:
                return {"peaks": cached["peaks"], "duration": cached.get("duration", 0.0)}
        except (ValueError, OSError, KeyError):
            pass
    peaks = audio.waveform_peaks(mp4, n=n)
    mf = _output_path(job, f"clip_{cid:02d}.json")
    dur = 0.0
    if mf.exists():
        try:
            dur = float(json.loads(mf.read_text(encoding="utf-8")).get("clip_duration", 0.0))
        except (ValueError, OSError):
            dur = 0.0
    try:
        cache.write_text(json.dumps({"mtime": mtime, "n": n, "peaks": peaks, "duration": dur}),
                         encoding="utf-8")
    except OSError:
        pass
    return {"peaks": peaks, "duration": dur}


@app.post("/api/clip/{job}/{cid}")
def update_clip(job: str, cid: int, payload: dict = Body(...)):
    """編集（タイトル/テロップ/alert切替）を反映し、そのクリップだけ再描画する。"""
    mf = _output_path(job, f"clip_{cid:02d}.json")
    if not mf.exists():
        raise HTTPException(404, "クリップ情報が見つかりません")
    m = json.loads(mf.read_text(encoding="utf-8"))
    if "title" in payload:
        m["title"] = str(payload["title"])
    if "hook" in payload:
        m["hook"] = str(payload["hook"])
    if isinstance(payload.get("telops"), list):
        tl = []
        for tp in payload["telops"]:
            try:
                s = max(0.0, float(tp.get("start", 0)))
                e = max(s + 0.1, float(tp.get("end", 0)))
            except (TypeError, ValueError):
                continue
            item = {"start": round(s, 3), "end": round(e, 3), "text": str(tp.get("text", ""))}
            if tp.get("style") in ("alert", "laugh", "comment"):
                item["style"] = tp["style"]
            if tp.get("emphasis"):
                item["emphasis"] = True
            if tp.get("animation"):
                item["animation"] = str(tp["animation"])
            try:
                if int(tp.get("layer") or 0):
                    item["layer"] = max(0, min(20, int(tp["layer"])))
            except (TypeError, ValueError):
                pass
            pos = tp.get("pos")
            if isinstance(pos, dict) and "x" in pos and "y" in pos:
                try:
                    item["pos"] = {"x": max(0.0, min(1.0, float(pos["x"]))),
                                   "y": max(0.0, min(1.0, float(pos["y"])))}
                except (TypeError, ValueError):
                    pass
            tl.append(item)
        m["telops"] = tl
    # 字幕プリセット／位置ドラッグ／サイズ調整の反映（編集UIから）
    if isinstance(payload.get("style"), dict):
        m.setdefault("style", {}).update(
            {k: v for k, v in payload["style"].items() if v is not None}
        )
    for key in ("caption_pos", "title_pos"):
        if key in payload:                      # null を渡すと位置リセット
            m.setdefault("style", {})[key] = payload[key]
    if "intro" in payload:
        m["intro"] = payload["intro"]
    if payload.get("reframe") in ("crop", "blur", "letterbox"):
        m["reframe"] = payload["reframe"]
    if "letterbox_color" in payload and payload["letterbox_color"]:
        m["letterbox_color"] = str(payload["letterbox_color"])
    if "sub_offset" in payload:   # 字幕タイミング（per-clip・秒）
        try:
            m["sub_offset"] = max(-2.0, min(2.0, float(payload["sub_offset"])))
        except (TypeError, ValueError):
            pass
    # 効果音タイムライン（配置リスト）の反映
    if isinstance(payload.get("sfx"), list):
        items = []
        for it in payload["sfx"]:
            if not isinstance(it, dict) or not it.get("id"):
                continue
            try:
                items.append({"id": str(it["id"]), "at": max(0.0, float(it.get("at", 0))),
                              "gain": max(0.0, min(3.0, float(it.get("gain", 1.0))))})
            except (TypeError, ValueError):
                continue
        m["sfx"] = items

    # 部分カット（残し区間 keeps＝元クリップ時間の[a,b]）。null/空でカット解除（全区間）。
    # フロントは telops/sfx を圧縮時間に再配置済みで送る。clip_duration は keeps から再計算。
    if "keeps" in payload:
        kp = payload["keeps"]
        keeps = []
        if isinstance(kp, list):
            for k in kp:
                try:
                    a = max(0.0, float(k[0]))
                    b = float(k[1])
                    if b > a + 0.01:
                        keeps.append([round(a, 3), round(b, 3)])
                except (TypeError, ValueError, IndexError):
                    continue
        if keeps:
            from .pipeline import tempo
            m["keeps"] = keeps
            m["clip_duration"] = tempo.total_kept([tuple(x) for x in keeps])
        else:
            m["keeps"] = None   # カット解除＝全区間
            try:
                m["clip_duration"] = round(float(m["end"]) - float(m["start"]), 3)
            except (TypeError, ValueError, KeyError):
                pass

    # 時間の延長（頭・末尾を秒で延ばす）→ transcript から取り直してテロップ再生成（#②）
    try:
        ext_s = max(0.0, float(payload.get("extend_start", 0) or 0))
        ext_e = max(0.0, float(payload.get("extend_end", 0) or 0))
    except (TypeError, ValueError):
        ext_s = ext_e = 0.0
    # 延長は keeps（部分カット）と排他（延長は keeps=None で全区間に戻すため）。カット中は延長を無視。
    if (ext_s or ext_e) and not m.get("keeps"):
        _extend_clip(job, m, ext_s, ext_e)

    # 追加指示でタイトルを作り直す（#②）
    extra = str(payload.get("extra_prompt", "")).strip()
    if extra:
        from .pipeline import highlight
        clip_text = "".join(str(tp.get("text", "")) for tp in m.get("telops", []))
        nt = highlight.retitle(clip_text, extra)
        if nt:
            m["title"] = nt

    mf.write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        render_from_manifest(m["input_video"], _job_dir(job), m)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"再作成に失敗しました: {e}")
    return {"ok": True, "file_path": f"{job}/clip_{cid:02d}.mp4",
            "title": m.get("title", ""), "telops": m.get("telops", []),
            "start": m.get("start"), "end": m.get("end")}


# 一括適用できる字幕スタイルのキー（位置は per-clip レイアウトなので除外）
_BULK_STYLE_KEYS = {
    "font", "subtitle_color", "highlight_color", "emphasis_color", "outline_color", "title_color",
    "title_outline_color", "caption_size", "title_size", "outline_width",
    "title_outline_width", "box", "box_color", "box_pad", "animate", "animation", "effect",
}


def _clip_manifests(job_dir: Path) -> list[Path]:
    """clip_NN.json のみ（clip_NN.peaks.json 等は除外）を番号順で返す。"""
    return sorted(p for p in job_dir.glob("clip_*.json")
                  if re.fullmatch(r"clip_\d+\.json", p.name))


def _run_bulk(bulk_id: str, job_dir: Path, manifests: list[Path], patch: dict) -> None:
    """全クリップに字幕スタイルをマージして再描画する（バックグラウンド・進捗付き）。"""
    try:
        n = len(manifests)
        failed = 0
        for i, mf in enumerate(manifests):
            _set(bulk_id, progress=int(i / n * 95), step=f"クリップ {i + 1}/{n} を再作成中")
            try:
                m = json.loads(mf.read_text(encoding="utf-8"))
                m.setdefault("style", {}).update(patch)
                mf.write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")
                render_from_manifest(m["input_video"], job_dir, m)
            except Exception as e:  # noqa: BLE001  1本失敗しても続行
                failed += 1
                print(f"[bulk] {mf.name} 再作成失敗: {e}", flush=True)
        warn = f"{failed}本のクリップで再作成に失敗しました" if failed else ""
        _set(bulk_id, status="completed", progress=100, step="完了", warning=warn)
    except Exception as e:  # noqa: BLE001
        _set(bulk_id, status="failed", step="失敗", error=str(e))


@app.post("/api/clips/{job}/bulk")
def bulk_style(job: str, payload: dict = Body(...)):
    """字幕スタイルを全クリップへ一括適用し、バックグラウンドで再作成する。"""
    job_dir = _job_dir(job)
    if not job_dir.exists():
        raise HTTPException(404, "ジョブが見つかりません")
    style = payload.get("style")
    if not isinstance(style, dict):
        raise HTTPException(400, "style が指定されていません")
    manifests = _clip_manifests(job_dir)
    if not manifests:
        raise HTTPException(404, "クリップがありません")
    patch = {k: v for k, v in style.items() if k in _BULK_STYLE_KEYS and v is not None}
    if "font" in patch:
        patch["font"] = valid_font(patch["font"])
    bulk_id = f"{job}__bulk"
    with _jobs_lock:
        _jobs[bulk_id] = {
            "job_id": bulk_id, "status": "processing", "progress": 0,
            "step": "準備中", "clips": [], "error": "", "warning": "",
        }
    threading.Thread(target=_run_bulk, args=(bulk_id, job_dir, manifests, patch),
                     daemon=True).start()
    return {"bulk_id": bulk_id, "count": len(manifests)}


def _extend_clip(job: str, m: dict, ext_s: float, ext_e: float) -> None:
    """クリップの頭/末尾を延ばす（テンポトリムは解除）。

    既存（編集済み）テロップは保持し、頭 ext_s 秒ぶん後ろへずらした上で、新たに露出した
    頭/末尾の領域だけ transcript から取り直して前後に足す（編集が消えないように）。
    """
    from .pipeline import captions
    from .pipeline.transcribe import Transcript
    tpath = _output_path(job, "transcript.json")
    if not tpath.exists():
        return
    t = Transcript.from_json(json.loads(tpath.read_text(encoding="utf-8")))
    dur = t.duration or (t.words[-1].end if t.words else 0.0)
    old_start, old_end = float(m["start"]), float(m["end"])
    new_start = max(0.0, old_start - ext_s)
    new_end = old_end + ext_e
    if dur > 0:
        new_end = min(new_end, dur)
    if new_end - new_start < 1.0:
        return
    shift = old_start - new_start              # 頭をどれだけ前に出したか（既存テロップの後ろずらし量）

    # 既存（編集済み）テロップを保持してシフト
    kept = []
    for tp in (m.get("telops") or []):
        try:
            item = {"start": round(float(tp.get("start", 0)) + shift, 3),
                    "end": round(float(tp.get("end", 0)) + shift, 3),
                    "text": str(tp.get("text", ""))}
        except (TypeError, ValueError):
            continue
        if tp.get("style"):
            item["style"] = tp["style"]
        kept.append(item)

    # 頭の新規領域 [new_start, old_start] → 新クリップ相対 [0, shift]
    head = captions.segment(captions.words_for_clip(t.words, new_start, old_start)) if shift > 0.05 else []
    # 末尾の新規領域 [old_end, new_end] → 新クリップ相対へオフセット
    tail = []
    if new_end - old_end > 0.05:
        off = old_end - new_start
        for tp in captions.segment(captions.words_for_clip(t.words, old_end, new_end)):
            tp["start"] = round(tp["start"] + off, 3)
            tp["end"] = round(tp["end"] + off, 3)
            tail.append(tp)

    m["start"] = round(new_start, 2)
    m["end"] = round(new_end, 2)
    m["keeps"] = None
    m["clip_duration"] = round(new_end - new_start, 2)
    m["telops"] = captions.tag_alerts(head + kept + tail)


@app.get("/api/download/{path:path}")
def download(path: str):
    target = _output_path(path)
    if not target.exists() or not target.is_file():
        raise HTTPException(404, "ファイルが見つかりません")
    return FileResponse(str(target))


def main(argv: list[str] | None = None) -> int:
    global _PORT
    p = argparse.ArgumentParser(description="TikTok-Cut backend server")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--host", default="127.0.0.1")
    args = p.parse_args(argv)
    _PORT = args.port
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
