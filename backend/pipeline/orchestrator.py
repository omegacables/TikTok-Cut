"""パイプライン全体の統合: 動画 → 文字起こし → ハイライト選定 → 縦型クリップ描画。

進捗は progress(percent: int, step: str) で通知（FastAPI / Electron から購読する用）。
"""
from __future__ import annotations

import json
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from pathlib import Path

from ..config import SETTINGS, valid_font
from . import (audio, captions, correct, highlight, lexicon, reactions, render,
               sfx, tempo, transcribe)

# クリップ毎の LLM 呼び出し（字幕補正・反応分類）の並列度。
# Gemini 無料枠のレート制限に配慮し保守的（既存の 429 バックオフ＋失敗時原文維持で安全）。
_LLM_WORKERS = max(1, int(os.environ.get("TIKTOKCUT_LLM_WORKERS", "3") or 3))


def _max_render_workers() -> int:
    """クリップ並列描画の同時数。文字起こし後はCPUが空くので複数同時が有効。

    env TIKTOKCUT_RENDER_WORKERS 優先。NVENC 時はGPUセッション/VRAMに配慮し控えめ、
    CPU(libx264)時はコア数に応じて 2〜4。
    """
    env = os.environ.get("TIKTOKCUT_RENDER_WORKERS", "").strip()
    if env.isdigit() and int(env) > 0:
        return int(env)
    cpu = os.cpu_count() or 8
    if render._nvenc_available():
        return min(3, max(1, cpu // 4))
    return min(4, max(2, cpu // 4))


@dataclass
class ClipResult:
    id: int
    title: str
    hook: str
    reason: str
    caption: str
    hashtags: list[str]
    start: float
    end: float
    file_path: str
    thumbnail_path: str
    ass_path: str


@dataclass
class JobResult:
    job_id: str
    input_video: str
    language: str
    duration: float
    provider: str
    clips: list[ClipResult] = field(default_factory=list)
    warning: str = ""

    def to_json(self) -> dict:
        d = asdict(self)
        return d


def _noop(percent: int, step: str) -> None:  # pragma: no cover
    pass


def render_from_manifest(input_video, job_dir: Path, m: dict) -> tuple[Path, Path]:
    """マニフェスト（telops/keeps/style）から 1 クリップを描画し、サムネも作る。

    初回描画と、手動修正UIからの再描画の両方で使う共通処理。
    """
    i = int(m["id"])
    out_mp4 = job_dir / f"clip_{i:02d}.mp4"
    st = m.get("style", {})
    intro = m.get("intro") or "none"
    ass = captions.build_ass(
        telops=m["telops"],
        clip_duration=float(m["clip_duration"]),
        title=m.get("title", ""),
        hook=m.get("hook", ""),
        language=m.get("language", ""),
        font=st.get("font"),
        subtitle_color=st.get("subtitle_color"),
        emphasis_color=st.get("emphasis_color"),
        outline_color=st.get("outline_color"),
        title_color=st.get("title_color"),
        title_outline_color=st.get("title_outline_color"),
        animate=bool(st.get("animate", True)),
        animation=st.get("animation"),
        effect=st.get("effect"),
        caption_size=st.get("caption_size"),
        title_size=st.get("title_size"),
        outline_width=st.get("outline_width"),
        title_outline_width=st.get("title_outline_width"),
        caption_pos=st.get("caption_pos"),
        title_pos=st.get("title_pos"),
        watermark=m.get("watermark"),
        box=bool(st.get("box")),
        box_color=st.get("box_color"),
        box_pad=st.get("box_pad"),
        sub_offset=m.get("sub_offset"),
    )
    keeps = m.get("keeps")
    lb_color = m.get("letterbox_color") or "black"
    # ロゴ画像（任意・テキスト@ハンドルは ASS 側で処理済み）は本体描画に統合し、
    # 別パスの再エンコードを省く。ロゴ合成だけ失敗した場合はロゴ無しで描き直して本体は出す。
    logo = m.get("logo") or {}
    logo_arg = logo if logo.get("path") else None

    def _render(logo_use):
        if keeps:
            render.render_clip_segments(
                input_video, float(m["start"]), [tuple(k) for k in keeps], ass,
                out_mp4, reframe_mode=m.get("reframe"), intro=intro,
                letterbox_color=lb_color, logo=logo_use,
            )
        else:
            render.render_clip(
                input_video, float(m["start"]), float(m["end"]), ass,
                out_mp4, reframe_mode=m.get("reframe"), intro=intro,
                letterbox_color=lb_color, logo=logo_use,
            )

    try:
        _render(logo_arg)
    except render.RenderError:
        if logo_arg is not None:
            print("[render] ロゴ合成に失敗 → ロゴ無しで再描画（本体は出力）", flush=True)
            _render(None)
        else:
            raise
    # 効果音（タイムラインで配置・任意）を amix で焼き込む（base 音量は維持）。
    # ロゴ/キャラと違い、ユーザーが明示配置した「音」なので失敗は握り潰さず伝播させる
    # （update_clip が 500 を返し、UI 表示と書き出しの不一致＝サイレント失敗を防ぐ）。
    sfx_items = m.get("sfx") or []
    if sfx_items:
        sfx.apply_sfx(out_mp4, sfx_items, clip_duration=float(m["clip_duration"]))
    thumb = job_dir / f"clip_{i:02d}.jpg"
    try:
        render.make_thumbnail(out_mp4, thumb, at=max(1.0, float(m["clip_duration"]) * 0.45))
    except render.RenderError:
        thumb = Path("")
    return out_mp4, thumb


def _preflight(job_dir: Path, input_video: Path) -> None:
    """ジョブ冒頭の環境診断。job_dir/debug.log にヘッダを書き、致命的問題はエラーコード付きで即停止。

    エラーは render.RenderError('[Exxx] …') として送出し、server が job.error に格納→UI 表示する。
    パス文字コード問題は ASCII 一時フォルダ描画で吸収するため、ここでは警告ログのみ（停止しない）。
    """
    import shutil as _shutil
    import sys as _sys
    from ..config import FFMPEG, OUTPUT_ROOT

    render.jlog(f"==== TikTok-Cut job @ {job_dir.name} ====")
    render.jlog(f"PY={_sys.version.split()[0]} FROZEN={getattr(_sys, 'frozen', False)}")
    render.jlog(f"FFMPEG={FFMPEG}")
    try:
        render.check_ffmpeg()   # E101: ffmpeg が起動できない
    except render.RenderError as e:
        raise render.RenderError(f"[E101] {e}") from e
    try:
        render.jlog(f"NVENC_AVAILABLE={render._nvenc_available()}")
    except Exception:
        pass
    import locale as _locale
    cp = _locale.getpreferredencoding(False)
    render.jlog(f"CODEPAGE={cp}")
    render.jlog(f"OUTPUT_ROOT={OUTPUT_ROOT!r} ANSI_SAFE={render.ansi_safe(OUTPUT_ROOT)}")
    render.jlog(f"JOB_DIR={str(job_dir)!r} ANSI_SAFE={render.ansi_safe(job_dir)} LEN={len(str(job_dir))}")
    render.jlog(f"INPUT={str(input_video)!r} ANSI_SAFE={render.ansi_safe(input_video)}")
    if not render.ansi_safe(job_dir) or not render.ansi_safe(input_video):
        render.jlog("[E201/E203] 非ANSIパスを検出 → ASCII一時フォルダ経由で描画します（自動対応）。")

    # E202: パス長（MAX_PATH 260 配慮。clip_NN.mp4 / .ass 等の余白を確保）
    if len(str(job_dir)) > 230:
        raise render.RenderError(
            "[E202] 保存先フォルダのパスが長すぎます。配信タイトルを短くするか、"
            "保存先を浅いフォルダに変更してください。")

    # E501: 書き込み可否
    probe = job_dir / ".ttc_write_test"
    try:
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
    except OSError as e:
        raise render.RenderError(
            "[E501] 保存先に書き込めませんでした。ウイルス対策ソフトの除外設定に保存フォルダを"
            f"追加するか、別の保存先をお試しください（{e}）。") from e

    # E502: 空き容量（最低 500MB）
    try:
        free = _shutil.disk_usage(job_dir).free
        render.jlog(f"FREE_BYTES={free}")
        if free < 500 * 1024 * 1024:
            raise render.RenderError("[E502] 空き容量が不足しています。ディスクの空きを増やしてから再実行してください。")
    except OSError:
        pass
    render.jlog("PREFLIGHT=PASS")


def run_job(
    input_video: str | Path,
    out_root: str | Path = "output",
    *,
    clip_count: int | None = None,
    meta_title: str | None = None,
    job_id: str | None = None,
    reframe_mode: str | None = None,
    letterbox_color: str | None = None,
    intro: str | None = None,
    style: dict | None = None,
    tempo_mode: str | None = None,
    genres: list[str] | None = None,
    user_prompt: str | None = None,
    watermark: dict | None = None,
    logo: dict | None = None,
    laugh_on: bool = False,
    comment_on: bool = False,
    progress=None,
) -> JobResult:
    progress = progress or _noop
    style = style or {}
    font_family = valid_font(style.get("font"))
    tmode = (tempo_mode or SETTINGS.tempo_mode or "off").lower()
    intro_mode = (intro or SETTINGS.intro_transition or "none").lower()
    animate = SETTINGS.subtitle_animate if style.get("animate") is None else bool(style.get("animate"))
    watermark = watermark if isinstance(watermark, dict) and str(watermark.get("text", "")).strip() else None
    logo = logo if isinstance(logo, dict) and logo.get("path") else None
    ctx = f"PUBG等のバトロワFPSのゲーム実況。{meta_title or ''}".strip()
    input_video = Path(input_video).resolve()
    if not input_video.exists():
        raise FileNotFoundError(input_video)

    clip_count = clip_count or SETTINGS.default_clip_count
    job_id = job_id or uuid.uuid4().hex[:12]
    job_dir = Path(out_root).resolve() / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    # 0) 診断ログ初期化 ＋ 事前チェック（環境起因の失敗を冒頭で確定させ、長い処理の無駄を防ぐ）
    render.set_job_context(job_id, job_dir)
    _preflight(job_dir, input_video)

    # 1) 文字起こし（単語タイムスタンプ）
    progress(3, "動画を解析中")
    duration = render.probe_duration(input_video)
    progress(5, "文字起こし中")

    def _stt_progress(frac: float, msg: str) -> None:
        progress(5 + int(frac * 55), msg)  # 5%→60%

    t = transcribe.transcribe(
        input_video,
        cache_path=job_dir / "transcript.json",
        initial_prompt=lexicon.whisper_primer(meta_title),
        hotwords=lexicon.whisper_hotwords(),
        progress=_stt_progress,
    )
    if duration <= 0:
        duration = t.duration

    # 2) 音の盛り上がり解析 → ハイライト選定（声の無いアクションも拾う）
    progress(60, "盛り上がりを解析中")
    a_times, a_db, louds = [], [], []
    try:
        a_times, a_db = audio.loudness(input_video)
        louds = audio.loud_moments(a_times, a_db, top_k=10, min_gap=18)
    except Exception:
        pass
    progress(62, "面白いシーンを選定中")
    highlights, provider_name = highlight.select_highlights(
        t, clip_count, meta_title=meta_title, loud_moments=louds, genres=genres,
        user_prompt=user_prompt,
    )

    result = JobResult(
        job_id=job_id,
        input_video=str(input_video),
        language=t.language,
        duration=duration,
        provider=provider_name,
    )
    if not highlights:
        result.warning = "ハイライトを検出できませんでした"
        (job_dir / "result.json").write_text(
            json.dumps(result.to_json(), ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return result

    # 3) クリップごとに テンポ編集 → テロップ分割（実Whisper語時刻のまま＝音声と同期）
    # 重要: 字幕の時刻は常に「実際の発話時刻」を使う。AI補正で時刻を再配分（_retime）すると
    # 無音区間を無視して数秒ズレるため、分割は補正前の実語時刻で行う。
    clip_words_all = [captions.words_for_clip(t.words, h.start, h.end) for h in highlights]
    should_correct = provider_name != "heuristic" and SETTINGS.correct_subtitles

    prepared: list[dict] = []
    for h, clip_words in zip(highlights, clip_words_all):
        keeps = tempo.keep_segments(
            tmode, clip_start=h.start, dur=h.duration, words=clip_words,
            loud_times=a_times, loud_db=a_db, context=ctx,
        )
        trimming = tempo.is_trim(keeps, h.duration)
        cw = tempo.compress_words(clip_words, keeps) if trimming else clip_words
        prepared.append({
            "keeps": keeps,
            "trimming": trimming,
            "cdur": tempo.total_kept(keeps) if trimming else h.duration,
            "telops": captions.segment(cw),     # 実語時刻で分割
        })

    # 3b) 任意のAI字幕補正（既定OFF）。分割後に「テキストのみ」補正＝時刻は一切変えない。
    # クリップ毎の個別呼び出し（巨大バッチは後半が劣化）を並列実行。失敗時は原文維持。
    if should_correct:
        todo = [i for i, p in enumerate(prepared) if p["telops"]]
        if todo:
            done = 0
            progress(62, f"字幕をAI補正中 0/{len(todo)}")

            def _corr_clip(i):
                texts = [tp["text"] for tp in prepared[i]["telops"]]
                return i, correct.correct_texts(texts, ctx)

            with ThreadPoolExecutor(max_workers=min(_LLM_WORKERS, len(todo))) as ex:
                for fut in as_completed([ex.submit(_corr_clip, i) for i in todo]):
                    try:
                        i, fixed = fut.result()
                        for tp, ctext in zip(prepared[i]["telops"], fixed):
                            if ctext.strip():
                                tp["text"] = ctext.strip()
                    except Exception:  # noqa: BLE001
                        pass
                    done += 1
                    progress(62 + int(done / len(todo) * 2), f"字幕をAI補正中 {done}/{len(todo)}")

    for p in prepared:
        captions.tag_alerts(p["telops"])   # 英語ギフト等の自動アラート化（補正後テキストで判定）

    # 3b-2) 自動センター強調: 声の盛り上がり付近 or 短い感嘆のテロップを中央・大で表示
    def _is_exclaim(txt: str) -> bool:
        s = txt.strip()
        return bool(s) and s[-1] in "！!？?" and len(s) <= 12
    for h, p in zip(highlights, prepared):
        for tp in p["telops"]:
            if tp.get("style") == "alert":
                continue
            loud = False
            if not p["trimming"] and louds:
                s = h.start + float(tp["start"])
                e = h.start + float(tp["end"])
                loud = any(s - 0.3 <= lt <= e + 0.3 for lt in louds)
            if loud or _is_exclaim(str(tp.get("text", ""))):
                tp["emphasis"] = True

    # 3c) タイトルを「補正後テロップ」から作り直す（内容との不一致を低減・#24）
    if provider_name != "heuristic":
        progress(64, "タイトルを最適化中")
        clip_texts = ["".join(tp.get("text", "") for tp in p["telops"]) for p in prepared]
        new_titles = highlight.refine_titles(clip_texts, meta_title=meta_title)
        if new_titles and len(new_titles) == len(highlights):
            for h, nt in zip(highlights, new_titles):
                if nt:
                    h.title = nt

    # 3e) 反応テロップ（任意）: 笑い「ｗ」の挿入＋コメント読み上げのチャット風スタイル化
    if (laugh_on or comment_on):
        progress(64, "笑い/コメントを解析中")
        base_idx_list = [[i for i, tp in enumerate(p["telops"]) if not tp.get("style")]
                         for p in prepared]   # 既存スタイル無しのみ対象
        flags_list: list[list | None] = [None] * len(prepared)

        # LLM 分類は各クリップ独立なので並列化（tl 変更は後で逐次・競合回避）。
        if provider_name != "heuristic":
            def _classify(ci: int):
                tl, bi = prepared[ci]["telops"], base_idx_list[ci]
                if not bi:
                    return ci, []
                return ci, reactions.classify([tl[i]["text"] for i in bi],
                                              [tl[i]["start"] for i in bi], ctx)
            with ThreadPoolExecutor(max_workers=min(_LLM_WORKERS, max(1, len(prepared)))) as ex:
                for fut in as_completed([ex.submit(_classify, ci) for ci in range(len(prepared))]):
                    try:
                        ci, flags = fut.result()
                        flags_list[ci] = flags
                    except Exception:  # noqa: BLE001
                        pass

        for ci, p in enumerate(prepared):
            tl, base_idx = p["telops"], base_idx_list[ci]
            flags = flags_list[ci]
            if flags is None:
                flags = [{"is_comment": False, "is_laugh": False}] * len(base_idx)
            adds = []
            for k, i in enumerate(base_idx):
                tp = tl[i]
                f = flags[k] if k < len(flags) else {}
                if comment_on and f.get("is_comment"):
                    tp["style"] = "comment"
                    continue
                if laugh_on and (f.get("is_laugh") or reactions.is_laugh_text(tp.get("text", ""))):
                    adds.append({"start": round(float(tp["start"]), 3),
                                 "end": round(min(float(tp["end"]), float(tp["start"]) + 2.0), 3),
                                 "text": "ｗｗｗｗ", "style": "laugh"})
            tl.extend(adds)

    # 4) クリップごとに描画
    # (a) マニフェストを逐次書き出し（決定的・安価）→ (b) プールで並列描画 → (c) ID順に整列。
    n = len(highlights)
    jobs: list[tuple[int, object, dict]] = []
    for i, (h, p) in enumerate(zip(highlights, prepared), start=1):
        keeps, trimming, cdur, telops = p["keeps"], p["trimming"], p["cdur"], p["telops"]
        manifest = {
            "id": i,
            "input_video": str(input_video),
            "start": h.start,
            "end": h.end,
            "keeps": [list(k) for k in keeps] if trimming else None,
            "reframe": reframe_mode or SETTINGS.reframe_mode,
            "letterbox_color": letterbox_color or "black",
            "intro": intro_mode,
            "language": t.language,
            "title": h.title,
            "hook": h.hook,
            "clip_duration": cdur,
            "style": {
                "font": font_family,
                "subtitle_color": style.get("subtitle_color"),
                "emphasis_color": style.get("emphasis_color"),
                "outline_color": style.get("outline_color"),
                "title_color": style.get("title_color"),
                "title_outline_color": style.get("title_outline_color"),
                "animate": animate,
                "animation": style.get("animation"),
                "effect": style.get("effect"),
                "caption_size": style.get("caption_size"),
                "title_size": style.get("title_size"),
                "outline_width": style.get("outline_width"),
                "title_outline_width": style.get("title_outline_width"),
                "caption_pos": style.get("caption_pos"),
                "title_pos": style.get("title_pos"),
                "box": bool(style.get("box")),
                "box_color": style.get("box_color"),
                "box_pad": style.get("box_pad"),
            },
            "watermark": watermark,
            "logo": logo,
            "sfx": [],            # 効果音は生成後のタイムラインエディタで追加
            "telops": telops,
            # 生成直後の原字幕／残し区間（不変）。編集UIの「初期設定に戻す」用に保持。
            "telops_orig": [dict(tp) for tp in telops],
            "keeps_orig": ([list(k) for k in keeps] if trimming else None),
            "sub_offset": 0.0,
        }
        (job_dir / f"clip_{i:02d}.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        jobs.append((i, h, manifest))

    def _render_one(i, h, manifest):
        out_mp4, thumb = render_from_manifest(input_video, job_dir, manifest)
        return i, h, out_mp4, thumb

    results_by_id: dict[int, ClipResult] = {}
    errors_by_id: dict[int, Exception] = {}
    done = 0
    prog_lock = threading.Lock()
    with ThreadPoolExecutor(max_workers=min(_max_render_workers(), max(1, n))) as ex:
        futs = {ex.submit(_render_one, i, h, mani): i for (i, h, mani) in jobs}
        for fut in as_completed(futs):
            idx = futs[fut]
            with prog_lock:
                done += 1
                progress(65 + int(done / n * 33), f"クリップ {done}/{n} を作成中")
            try:
                i, h, out_mp4, thumb = fut.result()
                results_by_id[i] = ClipResult(
                    id=i,
                    title=h.title,
                    hook=h.hook,
                    reason=h.reason,
                    caption=h.caption,
                    hashtags=h.hashtags,
                    start=h.start,
                    end=h.end,
                    file_path=str(out_mp4.relative_to(Path(out_root).resolve())),
                    thumbnail_path=str(thumb.relative_to(Path(out_root).resolve())) if thumb.name else "",
                    ass_path=f"{job_id}/clip_{i:02d}.ass",
                )
            except Exception as e:  # noqa: BLE001  （1本失敗しても他は継続）
                errors_by_id[idx] = e
                print(f"[render] clip_{idx:02d} 失敗（スキップ）: {e}", flush=True)

    for i in sorted(results_by_id):
        result.clips.append(results_by_id[i])
    if errors_by_id:
        msg = f"{len(errors_by_id)}本のクリップ作成に失敗しました"
        first_err = next(iter(errors_by_id.values()))
        lines = [ln for ln in str(first_err).strip().splitlines() if ln.strip()]
        # エラーコード行 [Exxx] を優先表示（無ければ末尾行）。debug.log に全文あり。
        detail = next((ln for ln in lines if ln.strip().startswith("[E")), lines[-1] if lines else "")
        if detail:
            msg += f"（{detail}）"
        render.jlog(f"[result] {msg}")
        result.warning = (result.warning + " " + msg) if result.warning else msg
    if errors_by_id and not results_by_id:
        raise RuntimeError(result.warning or "すべてのクリップ作成に失敗しました")

    progress(100, "完了")
    (job_dir / "result.json").write_text(
        json.dumps(result.to_json(), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return result
