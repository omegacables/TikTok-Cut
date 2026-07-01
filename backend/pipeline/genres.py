"""切り抜きジャンルの定義と、ジャンル別に最適化した選定プロンプト断片。

UI で選んだジャンル（複数可）を highlight._build_prompt に注入し、
「どんな見せ場を優先して切るか」をジャンルごとに最適化する。
length は (min, max) 秒の希望尺、prefer_loud=True は音ピーク（銃声/絶叫）を強く優先するジャンル。
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Genre:
    id: str
    label: str
    emoji: str
    guide: str                       # プロンプトに入れる「狙い」の説明
    length: tuple[float, float] | None = None   # (min, max) 秒。None は既定
    prefer_loud: bool = False        # 音の盛り上がりを強く優先


GENRES: list[Genre] = [
    Genre(
        "talk", "日常・雑談", "💬",
        "視聴者が『わかる』と共感する話・あるある・ホンネ・毒舌・急展開や言い間違いを優先。"
        "一つの話題が起承転結で完結する区間を選び、前フリは最小限に、必ずオチ・結論・感情の山まで含める。"
        "ただの説明や淡々とした進行だけの区間は選ばない。",
    ),
    Genre(
        "fps_br", "FPS・バトロワ", "🔫",
        "キル・クラッチ・不利からの逆転と、それに対する実況のリアクション（歓声・絶叫・煽り・笑い）が"
        "セットになった区間を最優先。『音の盛り上がり』付近は戦闘の可能性が高いので積極的に候補化する。"
        "プレイの結果（倒した／生き残った／全滅させた等）が分かる決着まで含める。",
        prefer_loud=True,
    ),
    Genre(
        "fps_kill", "FPS・キルシーンのみ", "🎯",
        "喋りの面白さより『映像の戦闘・撃ち合い・キルそのもの』を主役にする。発話が無くても"
        "『音の盛り上がり』のピーク（銃声・キル音・確キル）を最優先に選ぶ。1キル〜連続キルの見せ場を、"
        "決着後のリアクション（歓声・雄叫び）まで含めて切る（目安18〜35秒。18秒未満は作らない）。"
        "雑談・移動・漁りだけの区間は選ばない。",
        length=(18.0, 35.0), prefer_loud=True,
    ),
    Genre(
        "godplay", "神プレイ・上手い", "✨",
        "連続キル・精密なエイム・高度な立ち回り・芸術的なムーブなど『上手さ』が際立つ瞬間。"
        "視聴者が『うま！』『どうやったの』と思うプレイの開始から決着まで。凡プレイやミスは避ける。",
        prefer_loud=True,
    ),
    Genre(
        "funny", "面白い・笑い", "😂",
        "配信内で最も笑える瞬間。ボケ／ツッコミ、声を出して笑う所、予想外で噴き出す所。"
        "フリ→オチの笑いの構造を一区間に収める。クスッと程度の弱い笑いでは選ばず、笑いの山に絞る。",
    ),
    Genre(
        "moving", "感動・エモ", "🥹",
        "本音・努力・感謝・夢・覚悟など、胸が熱くなる発言。視聴者がグッとくる区間。"
        "感情が乗るまでの文脈を含めるため長め（目安45〜90秒）。茶化しで終わらず芯のある所を選ぶ。",
        length=(45.0, 90.0),
    ),
    Genre(
        "sad", "悲しい・しんみり", "😢",
        "切ない・落ち込む・涙ぐむ・しんみりする瞬間。なぜその感情になったかが伝わるよう前後の文脈を含める。"
        "明るいオチで打ち消さず、余韻が残る切り方にする（目安45〜90秒）。",
        length=(45.0, 90.0),
    ),
    Genre(
        "horror", "ホラー・ビックリ", "😱",
        "絶叫・ビクッと驚く・ジャンプスケアの瞬間。『音の盛り上がり』の急上昇（悲鳴）を最優先。"
        "驚く直前の油断から、驚いた後のリアクション・ツッコミまでワンセットで切る"
        "（目安18〜35秒。18秒未満は作らない）。",
        length=(18.0, 35.0), prefer_loud=True,
    ),
    Genre(
        "chaos", "ハプニング・カオス", "🌀",
        "事故・予想外の展開・グダグダ・トラブル・収拾のつかないカオス。『何が起きてるの』と最後まで"
        "見たくなる珍場面。状況が伝わる頭から、収束やオチまで含める（目安20〜60秒）。",
        length=(20.0, 60.0),
    ),
    Genre(
        "discussion", "深い議論・考察", "🧠",
        "持論・考察・ノウハウ・本質的な議論など、聞き応えのある話。結論や核心まで含めて長めに"
        "（目安60〜180秒）。要点が伝わるよう途中で切らない。冗長な脱線は含めない。",
        length=(60.0, 180.0),
    ),
]

_BY_ID = {g.id: g for g in GENRES}


def public_list() -> list[dict]:
    """UI 配信用（id/label/emoji）。"""
    return [{"id": g.id, "label": g.label, "emoji": g.emoji} for g in GENRES]


def resolve(genre_ids: list[str] | None) -> list[Genre]:
    if not genre_ids:
        return []
    return [_BY_ID[i] for i in genre_ids if i in _BY_ID]


# 18秒未満のクリップは作らない（ユーザー方針の絶対下限）
HARD_MIN_SEC = 18.0


def build_block(
    genres: list[Genre], default_min: float, default_max: float
) -> tuple[str, float, float, bool]:
    """選択ジャンルから (プロンプト断片, 有効min, 有効max, prefer_loud) を返す。"""
    if not genres:
        return "", max(HARD_MIN_SEC, default_min), default_max, False
    lines = [f"- {g.emoji} {g.label}: {g.guide}" for g in genres]
    # 各ジャンルの希望尺（無指定は既定）を集計し、全体は [最小の下限, 最大の上限]。
    mins = [(g.length[0] if g.length else default_min) for g in genres]
    maxs = [(g.length[1] if g.length else default_max) for g in genres]
    eff_min = max(HARD_MIN_SEC, min(mins))
    eff_max = max(maxs)
    prefer_loud = any(g.prefer_loud for g in genres)
    names = "／".join(g.label for g in genres)
    block = (
        f"\n【今回ねらうジャンル: {names}】\n"
        "次のジャンルに当てはまる切り抜きを優先的に選んでください（複数該当はむしろ歓迎）。"
        "どのジャンルにも当てはまらない平凡な区間は選ばないこと。\n"
        + "\n".join(lines) + "\n"
    )
    return block, eff_min, eff_max, prefer_loud
