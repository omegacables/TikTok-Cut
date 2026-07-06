"""文字起こしから TikTok 向けハイライトを N 本選定する。

既定では LLM（Gemini）に「面白い/伸びる」区間を選ばせ、タイトル・フック・キャプション・
ハッシュタグも生成させる。API キーが無い場合は heuristic（発話量ベース）で代替し、
パイプライン全体がキー無しでも end-to-end で動くようにする。
"""
from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field

from ..config import SETTINGS
from ..llm import provider
from .transcribe import Transcript


@dataclass
class Highlight:
    start: float
    end: float
    title: str = ""
    hook: str = ""           # 冒頭 1-2 秒に出す掴みテロップ
    reason: str = ""         # なぜ伸びるか（UI の「推しポイント」）
    caption: str = ""        # TikTok 投稿文
    hashtags: list[str] = field(default_factory=list)

    @property
    def duration(self) -> float:
        return self.end - self.start

    def to_json(self) -> dict:
        return asdict(self)


def _ts(sec: float) -> str:
    m, s = divmod(int(sec), 60)
    return f"{m:02d}:{s:02d}"


def _build_prompt(
    t: Transcript, clip_count: int, meta_title: str | None,
    loud_moments: list[float] | None = None,
    *, min_sec: float | None = None, max_sec: float | None = None, genre_block: str = "",
    user_prompt: str = "",
) -> str:
    lines = [f"[{_ts(s.start)}] {s.text}" for s in t.segments if s.text]
    transcript_block = "\n".join(lines)
    meta = f"\n配信タイトル（参考・固有名詞用）: {meta_title}" if meta_title else ""
    dur = int(t.duration)
    lo = int(min_sec if min_sec is not None else SETTINGS.clip_min_sec)
    hi = int(max_sec if max_sec is not None else SETTINGS.clip_max_sec)
    loud_block = ""
    if loud_moments:
        ts = "、".join(_ts(s) for s in loud_moments)
        loud_block = (
            "\n【音の盛り上がり】次の時刻付近は音量が急上昇しています"
            "（銃声・爆発・歓声・絶叫など。声が少なくてもキル/デス/盛り上がりの可能性が高い）。"
            f"FPS では特に、ここを候補として優先的に検討してください: {ts}\n"
        )
    user_block = ""
    if user_prompt and user_prompt.strip():
        user_block = (
            f"\n【ユーザーからの指示（最優先で従う）】\n{user_prompt.strip()}\n"
            "この指示の意図に沿って切り抜きを選ぶこと（下記ルールと矛盾する場合はこの指示を優先）。\n"
        )
    return f"""あなたは TikTok で累計数億再生を生み出してきた切り抜き編集のプロです。
配信アーカイブから「初見の視聴者が最後まで見て、思わずコメント・シェアしたくなる」切り抜きを選定します。

【成功の定義（この順に最適化する）】
1. 完視聴される: 冒頭2秒で「何が起きる？」と思わせ、途中で離脱させない
2. 感情が動く: 笑う・驚く・ゾクッとする・グッとくる、のどれかが必ず起きる
3. 反応したくなる: ツッコミたくなる／人に見せたくなる瞬間がある

━━━━ タスク ━━━━
下の文字起こしから、単体で完結して伸びる切り抜きを **ちょうど {clip_count} 本**、伸びる順に選ぶ。
多くても少なくてもいけない。必ず {clip_count} 個の要素を返すこと。{meta}{loud_block}{genre_block}{user_block}

━━━━ 何を狙うか（優先度順） ━━━━
A. **実際に笑いが起きている爆笑シーン**（笑い声・ツッコミ・www の反応が文字起こしに現れている所）
B. 予想外の展開・ハプニング・素のリアクション（「え！？」「まじで！？」等の感情の爆発）
C. キル/クラッチ/神プレイ（「音の盛り上がり」付近は戦闘の可能性大・必ず検討）
D. 本音・感動・シリアスな名場面（トーンが明確に変わる所）
E. 強い煽り・掛け合い・名言・パワーワード
→ 平坦な進行・作業的な区間・山のない雑談は、たとえ {clip_count} 本に足りなくても選ばない方がまし
  （ただし本数は必須なので、その場合は次点の中で最も感情の動きがある区間を選ぶ）。

━━━━ 切り出しルール ━━━━
1. 「話の頭」から切り出す。文や相槌の途中から始めない。場面の理解に必要な前フリ・状況説明を必ず含める。
2. **オチ・結末・その後のリアクション（笑い・ツッコミ・余韻）まで含めて終える。**
   オチの直前で切るのは最悪の失敗。迷ったら長めに切る（長い＝OK、良い所の手前で終わる＝致命的）。
3. 冒頭1〜2秒で掴める区間にする。先頭・末尾の沈黙や「えーっと」は含めない。
4. 長さは {lo}〜{hi} 秒。**{lo}秒未満は絶対に作らない**。目安: 一言ネタ=20〜35秒、
   エピソード・掛け合い=30〜60秒、解説/シリアス=40〜120秒。内容が途切れず続く長編だけ最長{hi}秒可。
   話が完結するまでが最優先。ただし中だるみの水増しは禁止。
5. クリップ同士は時間が重複しない。前半・中盤・後半からバランス良く散らす。
6. start < end、0〜{dur} 秒の範囲内（数値・秒）。[mm:ss] を境界の目安にする。

━━━━ 良い例と悪い例 ━━━━
✅ 良い: [12:03]で話のフリが始まり[12:38]で爆笑が起きた
   → start=723（フリの頭）, end=772（笑いの余韻が収まるまで）。フリ→オチ→リアクションが1本で完結。
❌ 悪い: 爆笑した[12:38]の周辺だけを切る → フリが無く初見には何が面白いのか伝わらない。
❌ 悪い: 盛り上がりの[12:35]で終える → オチ直前でブツ切り。絶対にしない。
❌ 悪い: タイトルに区間内で起きていない誇張を書く → 釣りは低評価・通報のもと。

━━━━ 出力前セルフチェック ━━━━
各クリップについて以下を確認し、1つでも×なら境界を修正してから出力する:
□ 話の頭から始まっているか（前フリを含んだか）
□ オチ/決着/リアクションまで含んで終わっているか
□ {lo}秒以上あるか
□ 他のクリップと重複していないか
□ 前後を知らない初見が文脈を理解できるか

━━━━ 出力形式 ━━━━
各クリップに日本語で:
- start, end: 秒（数値）
- score: バズる可能性 0〜100（高い順に並べる）
- title: 画面上部の短いタイトル（〜18字）。**その区間で実際に話している内容だけ**を、
  視聴者が中身を正しく予想できる具体的な一言で。誇張・釣り禁止。
- hook: 冒頭テロップ（〜15字、続きを見たくなる）
- reason: 推しポイント（なぜ伸びるか一言）
- caption: TikTok 投稿文（〜80字、絵文字可）
- hashtags: 3〜5個（#なし・文字列配列）

出力は次の JSON のみ（前後に説明文や```を付けない）:
{{"clips": [{{"start": 0.0, "end": 0.0, "score": 0, "title": "", "hook": "", "reason": "", "caption": "", "hashtags": []}}]}}

━━━━ 文字起こし（各行頭 [mm:ss] は発話開始時刻・配信全体 {dur} 秒） ━━━━
{transcript_block}
"""


def _parse_llm_json(raw: str) -> list[dict]:
    raw = raw.strip()
    # ```json ... ``` のコードフェンスを除去
    raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.IGNORECASE | re.MULTILINE).strip()
    data = json.loads(raw)
    if isinstance(data, dict):
        for key in ("clips", "highlights", "items", "results"):
            if isinstance(data.get(key), list):
                return data[key]
        # dict だが配列キーが無い → 単一要素とみなす
        return [data]
    if isinstance(data, list):
        return data
    raise ValueError("LLM 応答を配列として解釈できません")


def _sanitize(
    raw_items: list[dict], duration: float, clip_count: int,
    *, min_sec: float | None = None, max_sec: float | None = None,
) -> list[Highlight]:
    """時間のクランプ・重複除去・尺の検証を行う。"""
    cmin = min_sec if min_sec is not None else SETTINGS.clip_min_sec
    cmax = max_sec if max_sec is not None else SETTINGS.clip_max_sec
    out: list[Highlight] = []
    items = sorted(
        (it for it in raw_items if "start" in it and "end" in it),
        key=lambda it: float(it["start"]),
    )
    last_end = -1.0
    for it in items:
        try:
            start = max(0.0, float(it["start"]))
            end = float(it["end"])
        except (TypeError, ValueError):
            continue
        if duration > 0:
            end = min(end, duration)
        # 尺をクランプ
        length = end - start
        if length < cmin:
            end = min(start + cmin, duration or end)
        if end - start > cmax:
            end = start + cmax
        if end - start < 1.0:
            continue
        # 重複スキップ
        if start < last_end:
            continue
        hashtags = it.get("hashtags") or []
        if isinstance(hashtags, str):
            hashtags = [h.strip().lstrip("#") for h in re.split(r"[,\s]+", hashtags) if h.strip()]
        out.append(
            Highlight(
                start=round(start, 2),
                end=round(end, 2),
                title=str(it.get("title", "")).strip(),
                hook=str(it.get("hook", "")).strip(),
                reason=str(it.get("reason", "")).strip(),
                caption=str(it.get("caption", "")).strip(),
                hashtags=[str(h).lstrip("#").strip() for h in hashtags][:5],
            )
        )
        last_end = end
        if len(out) >= clip_count:
            break
    return out


def _heuristic(t: Transcript, clip_count: int) -> list[Highlight]:
    """API キー無しの代替: 動画を N 分割し、各区間で発話密度が高い窓を切る。"""
    duration = t.duration or (t.segments[-1].end if t.segments else 0.0)
    if duration <= 0 or not t.segments:
        return []
    cmin, cmax = SETTINGS.clip_min_sec, SETTINGS.clip_max_sec
    window_sizes = sorted({cmin, min(22.0, cmax), min(32.0, cmax), min(42.0, cmax)})
    bucket = duration / clip_count
    highlights: list[Highlight] = []
    for i in range(clip_count):
        b_start, b_end = i * bucket, (i + 1) * bucket
        in_bucket = [s for s in t.segments if b_start <= s.start < b_end and s.text]
        if not in_bucket:
            continue

        best: tuple[float, float, float] | None = None  # score, start, end
        anchors = sorted({b_start, *[s.start for s in in_bucket], *[max(b_start, s.end - cmin) for s in in_bucket]})
        for length in window_sizes:
            if length <= 0:
                continue
            for a in anchors:
                start = max(b_start, min(a, b_end - min(length, b_end - b_start)))
                end = min(b_end, start + length)
                if end - start < cmin * 0.75:
                    continue
                segs = [s for s in in_bucket if s.end > start and s.start < end]
                chars = sum(len(s.text.strip()) for s in segs)
                speech_span = sum(max(0.0, min(s.end, end) - max(s.start, start)) for s in segs)
                density = chars / max(1.0, end - start)
                coverage = speech_span / max(1.0, end - start)
                score = density * 10.0 + coverage * 25.0 + len(segs) * 1.5 - (end - start) * 0.08
                if best is None or score > best[0]:
                    best = (score, start, end)
        if best is None:
            peak = max(in_bucket, key=lambda s: len(s.text))
            center = (peak.start + peak.end) / 2
            start = max(b_start, center - cmin / 2)
            end = min(duration, start + cmin)
            start = max(0.0, end - cmin)
        else:
            _, start, end = best

        text = " ".join(s.text for s in t.segments if start <= s.start < end)
        title = (text[:18] + "…") if len(text) > 18 else text
        highlights.append(
            Highlight(
                start=round(start, 2),
                end=round(end, 2),
                title=title or f"ハイライト {i + 1}",
                hook="",
                reason="発話が密な区間（自動選定）",
                caption=title,
                hashtags=["切り抜き", "TikTok", "shorts"],
            )
        )
    return highlights


def _uncovered_gaps(
    highlights: list[Highlight], duration: float, min_len: float
) -> list[tuple[float, float]]:
    """既存ハイライトが覆っていない、長さ min_len 以上の時間帯を返す。"""
    gaps: list[tuple[float, float]] = []
    cur = 0.0
    for h in sorted(highlights, key=lambda x: x.start):
        if h.start - cur >= min_len:
            gaps.append((cur, h.start))
        cur = max(cur, h.end)
    if duration - cur >= min_len:
        gaps.append((cur, duration))
    return gaps


def _supplement(
    highlights: list[Highlight], t: Transcript, clip_count: int,
    *, min_sec: float | None = None, max_sec: float | None = None,
) -> list[Highlight]:
    """LLM が clip_count に満たなかった分を、未使用区間からヒューリスティックに補完する。

    Gemini が指定本数より少なく返す／_sanitize の重複・尺クランプで脱落する、といった事情でも
    最終的に（動画長が許す限り）clip_count 本を返せるようにする。バグ #25 対策。
    """
    cmin = min_sec if min_sec is not None else SETTINGS.clip_min_sec
    cmax = max_sec if max_sec is not None else SETTINGS.clip_max_sec
    duration = t.duration or (t.segments[-1].end if t.segments else 0.0)
    if duration <= 0 or len(highlights) >= clip_count:
        return highlights[:clip_count]
    target = min(cmax, max(cmin, 40.0))
    out = list(highlights)
    # まずは通常尺で、足りなければ短めの区間も許容して埋める
    for gap_min in (cmin, max(8.0, cmin * 0.6)):
        guard = 0
        while len(out) < clip_count and guard < clip_count * 4:
            guard += 1
            gaps = _uncovered_gaps(out, duration, gap_min)
            if not gaps:
                break
            gs, ge = max(gaps, key=lambda g: g[1] - g[0])
            in_gap = [s for s in t.segments if gs <= s.start < ge and s.text]
            center = (
                (max(in_gap, key=lambda s: len(s.text)).start
                 + max(in_gap, key=lambda s: len(s.text)).end) / 2
                if in_gap else (gs + ge) / 2
            )
            length = min(target, ge - gs)
            start = max(gs, center - length / 2)
            end = min(ge, start + length)
            start = max(gs, end - length)
            text = " ".join(s.text for s in t.segments if start <= s.start < end)
            title = (text[:16] + "…") if len(text) > 16 else (text or "ハイライト")
            out.append(
                Highlight(
                    start=round(start, 2),
                    end=round(end, 2),
                    title=title,
                    hook="",
                    reason="AIが不足分を自動補完した区間",
                    caption=title,
                    hashtags=["切り抜き", "TikTok", "shorts"],
                )
            )
            out.sort(key=lambda h: h.start)
    return out[:clip_count]


def refine_titles(clip_texts: list[str], *, meta_title: str | None = None) -> list[str] | None:
    """各クリップの「実際の発話テキスト」からタイトルを作り直す（#24 タイトル精度）。

    字幕の AI 文脈補正後の確定テキストを渡し、内容と食い違わない具体的なタイトルへ整える。
    LLM が使えない／失敗した場合は None（呼び出し側は元タイトルを維持する）。
    """
    if SETTINGS.effective_provider() == "heuristic" or not clip_texts:
        return None
    meta = f"\n配信タイトル（固有名詞の参考）: {meta_title}" if meta_title else ""
    blocks = "\n".join(f"[{i}] {txt.strip()[:400]}" for i, txt in enumerate(clip_texts))
    prompt = f"""次は TikTok 切り抜きクリップ {len(clip_texts)} 本の「実際の発話内容」です。{meta}
各クリップに、画面上部に出す日本語タイトルを 1 つずつ付けてください。

厳守:
- タイトルは **そのクリップの発話内容だけ** を表す（書かれていない情報・過剰な煽り・内容と食い違う釣りは禁止）。
- 18 字以内・体言止め寄りで、視聴者が中身を正しく予想できる具体的な一言。
- 入力と同じ {len(clip_texts)} 個、index の順で返す。

出力は次の JSON のみ（説明文や```は付けない）:
{{"titles": ["...", "..."]}}

--- 各クリップの発話 ---
{blocks}
"""
    try:
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", provider.generate_json(prompt).strip(),
                     flags=re.IGNORECASE | re.MULTILINE).strip()
        data = json.loads(raw)
        if isinstance(data, dict):
            titles = [str(x).strip() for x in data.get("titles", [])]
        elif isinstance(data, list):
            titles = [str(x).strip() for x in data]
        else:
            return None
        return titles or None
    except Exception as e:  # noqa: BLE001
        print(f"[highlight] タイトル再生成スキップ ({type(e).__name__}: {e})", flush=True)
        return None


def retitle(clip_text: str, instruction: str, *, meta_title: str | None = None) -> str | None:
    """編集UIの「追加指示」で、1クリップのタイトルを作り直す（#②）。失敗時 None。"""
    if SETTINGS.effective_provider() == "heuristic" or not clip_text.strip():
        return None
    meta = f"（参考: {meta_title}）" if meta_title else ""
    prompt = f"""次は TikTok 切り抜きクリップの実際の発話です{meta}。
ユーザーからの追加指示: {instruction.strip() or "内容に合った良いタイトルにする"}
この指示を踏まえ、発話内容に忠実な日本語タイトルを1つだけ作ってください
（18字以内・体言止め寄り・内容と食い違う釣りは禁止）。

出力は次の JSON のみ: {{"title": "..."}}

--- 発話 ---
{clip_text[:700]}
"""
    try:
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", provider.generate_json(prompt).strip(),
                     flags=re.IGNORECASE | re.MULTILINE).strip()
        data = json.loads(raw)
        title = str(data.get("title", "")).strip() if isinstance(data, dict) else ""
        return title or None
    except Exception as e:  # noqa: BLE001
        print(f"[highlight] retitle スキップ ({type(e).__name__}: {e})", flush=True)
        return None


def suggest_sfx(telops: list[dict], sfx_catalog: list[dict], clip_duration: float) -> list[dict]:
    """テロップ内容から効果音の配置候補を提案する（編集UIの「AI提案」）。失敗時 []。

    返り値: [{"at": 秒, "id": 効果音id, "reason": 短い理由}] （最大4件・時刻順）
    """
    if SETTINGS.effective_provider() == "heuristic":
        return []
    lines = [f"{float(tp.get('start', 0)):.1f}s: {str(tp.get('text', ''))}"
             for tp in telops if str(tp.get("text", "")).strip()]
    if not lines:
        return []
    valid_ids = {str(s.get("id", "")) for s in sfx_catalog}
    catalog = "\n".join(f"- {s['id']}: {s.get('label', s['id'])}" for s in sfx_catalog)
    prompt = f"""次は TikTok 縦型切り抜きクリップの字幕（開始秒: テキスト）です。
内容が最も引き立つ場所に効果音を最大4つ提案してください。

ルール:
- 入れすぎない（本当に効果的な場所だけ。0〜4個）
- ツッコミ・オチ・決め台詞・登場・驚きの「瞬間」に合わせる
- at は該当する発話の開始秒に合わせる（0〜{clip_duration:.1f}の範囲）
- id は次の一覧から選ぶ

使える効果音:
{catalog}

出力は次の JSON のみ:
{{"sfx": [{{"at": 1.2, "id": "tsukkomi", "reason": "ツッコミの瞬間"}}]}}

--- 字幕 ---
{chr(10).join(lines)[:1500]}
"""
    try:
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", provider.generate_json(prompt).strip(),
                     flags=re.IGNORECASE | re.MULTILINE).strip()
        data = json.loads(raw)
        items = data.get("sfx") if isinstance(data, dict) else None
        out: list[dict] = []
        for it in (items or [])[:4]:
            if not isinstance(it, dict):
                continue
            sid = str(it.get("id", ""))
            if sid not in valid_ids:
                continue
            try:
                at = max(0.0, min(float(clip_duration or 0) or 9e9, float(it.get("at", 0))))
            except (TypeError, ValueError):
                continue
            out.append({"at": round(at, 2), "id": sid, "reason": str(it.get("reason", ""))[:60]})
        out.sort(key=lambda x: x["at"])
        return out
    except Exception as e:  # noqa: BLE001
        print(f"[highlight] suggest_sfx スキップ ({type(e).__name__}: {e})", flush=True)
        return []


def select_highlights(
    t: Transcript,
    clip_count: int | None = None,
    *,
    meta_title: str | None = None,
    loud_moments: list[float] | None = None,
    genres: list[str] | None = None,
    user_prompt: str | None = None,
) -> tuple[list[Highlight], str]:
    """(ハイライト一覧, 使用した手法) を返す。手法は 'gemini'/'openai'/'claude'/'heuristic'。"""
    from . import genres as genre_mod

    clip_count = clip_count or SETTINGS.default_clip_count
    provider_name = SETTINGS.effective_provider()
    # 選択ジャンルから、プロンプト断片と有効な尺レンジを決める（10秒未満は作らない）
    g_block, gmin, gmax, _prefer_loud = genre_mod.build_block(
        genre_mod.resolve(genres), SETTINGS.clip_min_sec, SETTINGS.clip_max_sec
    )
    gmin = max(genre_mod.HARD_MIN_SEC, gmin)

    if provider_name != "heuristic":
        try:
            raw = provider.generate_json(_build_prompt(
                t, clip_count, meta_title, loud_moments,
                min_sec=gmin, max_sec=gmax, genre_block=g_block,
                user_prompt=user_prompt or "",
            ))
            items = _parse_llm_json(raw)
            highlights = _sanitize(items, t.duration, clip_count, min_sec=gmin, max_sec=gmax)
            if highlights:
                # 本数が不足していれば未使用区間から補完して clip_count を保証（#25）
                if len(highlights) < clip_count:
                    before = len(highlights)
                    highlights = _supplement(highlights, t, clip_count, min_sec=gmin, max_sec=gmax)
                    print(f"[highlight] LLM {before}本 → 補完して {len(highlights)}本", flush=True)
                return highlights, provider_name
        except Exception as e:  # noqa: BLE001
            # キー/モデル不正・通信・JSON 崩れ等はすべて heuristic にフォールバック
            print(f"[highlight] LLM 失敗 ({type(e).__name__}: {e}) → heuristic", flush=True)

    return _heuristic(t, clip_count), "heuristic"
