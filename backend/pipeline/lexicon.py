"""文字起こし精度を上げるための語彙辞書（若者言葉・ネットスラング・ゲーム用語・方言）。

2 通りに使う:
1. Whisper の initial_prompt に「正しい表記の例文」として与え、認識を寄せる。
2. AI 字幕補正（correct.py）の用語集として与え、誤変換の修正先を正しい綴りに寄せる
   ＋方言・口語はそのまま残すよう指示する。

ユーザーが設定で追加した独自単語（環境変数 TIKTOKCUT_VOCAB）も併合する。
"""
from __future__ import annotations

import os

# --- 内蔵辞書（カテゴリ別） -------------------------------------------------
NET_SLANG = [
    "草", "草生える", "大草原", "ワンチャン", "それな", "あーね", "ぴえん", "しんどい",
    "エモい", "尊い", "ガチ", "ガチで", "神回", "推し", "推せる", "沼", "語彙力", "限界",
    "メンブレ", "テンアゲ", "陽キャ", "陰キャ", "わかる", "なるほどね", "やばい", "やば",
    "むり", "むずい", "きっつ", "うける", "つよい", "よわい", "天才", "おつ", "おつかれ",
]
GAMING = [
    "キル", "デス", "キルデス", "クラッチ", "リスポーン", "リス", "漁る", "物資", "回復",
    "シールド", "グレネード", "グレ", "スモーク", "索敵", "凸る", "裏取り", "詰める", "引く",
    "芋る", "ダウン", "蘇生", "復活", "アンチ", "安置", "スクワッド", "デュオ", "ソロ",
    "ドン勝", "ビクロイ", "エイム", "ヘッドショット", "ヘッショ", "リコイル", "キャリー",
    "連携", "ピン", "マーカー", "スナイパー", "アサルト", "近接", "ローリング", "リロード",
]

STREAM = [
    "投げ銭", "スパチャ", "スーパーチャット", "ギフト", "メンバーシップ", "案件", "高評価",
    "チャンネル登録", "アーカイブ", "切り抜き", "同接", "コメント", "リスナー", "わこつ",
    "初見", "常連", "概要欄", "通知", "コラボ",
]
DIALECT = [
    "せやな", "せやで", "ほんま", "めっちゃ", "なんでやねん", "あかん", "ちゃう", "やんけ",
    "しとる", "やけん", "ばり", "だべ", "じゃん", "っしょ", "なまら", "でら", "とっとと",
    "ばい", "たい", "やん", "へん", "ねん", "わいわい",
]

_BUILTIN = NET_SLANG + GAMING + STREAM + DIALECT


def _user_vocab() -> list[str]:
    """設定（環境変数 TIKTOKCUT_VOCAB, カンマ/改行区切り）の独自単語。"""
    raw = os.environ.get("TIKTOKCUT_VOCAB", "")
    out: list[str] = []
    for tok in raw.replace("\n", ",").replace("、", ",").split(","):
        t = tok.strip()
        if t and t not in out:
            out.append(t)
    return out


def all_terms() -> list[str]:
    seen, out = set(), []
    for t in _BUILTIN + _user_vocab():
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


def whisper_primer(meta_title: str | None = None) -> str:
    """Whisper の initial_prompt 用の短い自然文。

    重要: 大量の単語リストを initial_prompt に入れると Whisper がそれらを“捏造挿入”しやすく
    なる（幻聴の原因）。そこで initial_prompt には自然文（配信タイトル）だけを置き、
    用語バイアスは hotwords（whisper_hotwords）と補正側の用語集で行う。
    """
    t = (meta_title or "").strip()
    return f"{t}。" if t else ""


def whisper_hotwords(limit: int = 30) -> str:
    """Whisper の hotwords 用（独自登録した固有名詞＝配信者名等のみ・空白区切り）。

    内蔵の一般スラングは入れない（一般語をバイアスすると挿入幻聴が増えるため）。
    ユーザーが設定で登録した単語だけを軽く寄せる。
    """
    return " ".join(_user_vocab()[:limit])


def correction_glossary(limit: int = 160) -> str:
    """字幕補正に渡す用語集（カンマ区切り）。内蔵辞書＋独自単語（こちらは安全＝後処理）。"""
    return "、".join(all_terms()[:limit])
