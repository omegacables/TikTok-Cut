# TikTok-Cut

YouTube 配信アーカイブから **TikTok 向け縦型ショート切り抜き**を自動生成するデスクトップアプリ。
（V-Cut を参考に、TikTok 特化＋低コスト構成で再設計したもの）

## 設計判断（確定事項）

| 項目 | 決定 | 理由 |
|---|---|---|
| アプリ形態 | **デスクトップ型**（Electron ＋ ローカル Python バックエンド） | 動画処理をユーザー PC で行い**サーバー費用ほぼゼロ**。大容量アップロード不要で安定。 |
| 動画入力 | **手動 DL ＋ mp4 アップロード**（URL は任意・メタデータ用） | YouTube 規約遵守。動画を外部に出さない。 |
| 字幕 | **TikTok 風カラオケ字幕**（単語ごとにハイライト） | TikTok ネイティブな見た目。最大の差別化点。 |
| 文字起こし | **faster-whisper**（ローカル, 単語タイムスタンプ） | 無料・高速・オフライン。 |
| AI（ハイライト選定） | **Gemini Flash 既定**（プロバイダ差し替え可） | テキスト入出力のみ＝1 本あたり概ね 1 円未満。 |
| 動画処理 | **ffmpeg**（同梱予定） | 業界標準。切出し・9:16 変換・字幕焼き込み。 |

> コストの主戦場は「動画処理」であって AI ではない。だからこそローカル処理（デスクトップ型）が
> コスト・安定性の両面で有利。クラウドに出るのは小さな LLM 呼び出しだけ。

## アーキテクチャ

```
Electron (app/)            ← ガワ・自動更新・ファイルダイアログ
   │ spawn + localhost
   ▼
FastAPI sidecar (backend/) ← ローカル処理サーバ
   ├─ pipeline/transcribe.py   faster-whisper（単語タイムスタンプ）
   ├─ pipeline/highlight.py    LLM でハイライト N 本選定＋メタ生成
   ├─ pipeline/captions.py     ASS カラオケ字幕生成（TikTok セーフゾーン）
   ├─ pipeline/render.py       ffmpeg：切出し→9:16→字幕焼き込み
   ├─ pipeline/orchestrator.py 全体統合
   └─ llm/provider.py          gemini / openai / claude 抽象化（+ キー無し fallback）
```

## プライバシー / データフロー（設計方針）

競合 V-Cut の構成（公開ドキュメントで確認）に倣い、プライバシーを売りにできる構成を踏襲する。

- **動画/音声はローカルから出さない。** 文字起こしは faster-whisper でユーザー PC 上のみ。
- **LLM へ送るのはテキストのみ**＝文字起こし＋（任意で）動画タイトル/チャンネル名。動画本体は送らない。
- Gemini は API 規約上「学習に使わない」設定（Zero Data Retention 相当）を選ぶ。
- 認証/課金を付ける場合も、サーバーが受け取るのは最小限（識別子・ライセンス状態）に留める。
- 法務: 出力の商用利用は自由とし、入力動画の権利確認は利用者責任とする旨を**自前の利用規約/プライバシーポリシー**に明記（本家の文面はコピーしない）。

## 現在の状態

- [x] バックエンド処理パイプライン（CLI で実行可能・E2E 検証済み）
- [x] FastAPI サーバ化（アップロード/進捗/DL を E2E 検証済み）
- [x] Web UI（作成→進捗→結果プレビュー/DL）
- [x] Electron シェル（バックエンド spawn＋ネイティブ選択/保存。インストール起動を確認済み）
- [x] 字幕フォント選択（日本語: 定番4種＋かわいい系8種を同梱、OFL/Apache）
- [x] よく使う色のカスタマイズ（字幕/ハイライト/縁取り/タイトル＋パレット localStorage 保存）
- [x] インストーラのサイズ最適化（288MB → 201MB: ffprobe 廃止＋ffmpeg essentials 化）
- [x] GPU 自動利用＋CPU フォールバック（faster-whisper, CUDA 不在でも動作）
- [x] 字幕の AI 文脈補正（LLM で誤字/ゲーム用語/口語を補正）
- [x] 字幕は静的テロップ（カラオケ廃止）＋はみ出し防止（TinySegmenter で単語折返し）＋句読点で改行/分割
- [x] 音の盛り上がり検出（銃声/歓声）→ ハイライト選定に加味（FPS の無言アクションも拾う）
- [x] テンポ編集（不要部分を削りジャンプカットで詰める）モード選択: off/silence/content(LLM)/both、既定 off。字幕も圧縮タイムラインへ再同期
- [x] 字幕の手動修正 UI（テロップ単位でテキスト編集→そのクリップだけ再作成）
- [x] ギフト等の英語イベントを別テロップ化（自動判定＋手動切替、Twitch 風アラートバナー）
- [x] クリップ冒頭トランジション（ズームイン/黒フェード/白フラッシュ、元 fps 維持の zoompan）
- [x] 背景ぼかしリフレーム（黒帯にせずぼかし拡大で 9:16 を埋める CapCut 風構成）
- [x] 字幕・タイトルのポップイン演出（ASS フェード＋スケール、ON/OFF 切替）
- [x] 生成本数の保証（LLM が不足して返しても未使用区間から自動補完して指定本数に揃える）
- [x] タイトル精度の向上（AI 補正後の確定発話からタイトルを再生成し内容との不一致を低減）
- [x] 起動スプラッシュ（バックエンド準備中＝初回モデルDL中に出るアニメ演出）
- [x] ジャンル選択（複数選択）＋ジャンル別最適化プロンプト（日常/FPSバトロワ/FPSキルのみ/神プレイ/笑い/感動/悲しい/ホラー/カオス）
- [x] 文字起こし語彙辞書（若者言葉・ネットスラング・ゲーム用語・方言の内蔵辞書＋設定で独自単語登録、方言/口語を保持）
- [x] TikTok @ハンドル設定（ウォーターマーク・投稿文に利用）
- [x] 字幕プリセット（フォント・色・サイズをまとめて保存／呼び出し／削除）
- [x] 文字サイズ・縁取り太さの調整（字幕・タイトル個別）
- [x] ウォーターマーク／ロゴ（@ハンドル文字＋画像ロゴ、隅の位置選択で焼き込み・任意）
- [x] 字幕／タイトルの位置ドラッグ（編集UIでクリップ毎に微調整→そのクリップだけ再作成）
- [x] 文字起こしの捏造（幻聴）抑制（語彙は initial_prompt に詰めず hotwords＋補正用語集へ、condition_on_previous_text=False 等の抑制パラメータ、補正は捏造禁止）
- [x] 字幕プレビューの刷新（タイトル・字幕の大きさ／色／縁取りを WYSIWYG でリアルタイム表示）
- [x] 文字起こしモデル選択に kotoba-whisper v2（日本語特化・実験的）／large-v3-turbo を追加
- [x] 編集UI（生成後）に文字サイズ・縁取りスライダー、作成タブのスタイルを次回既定として記憶
- [ ] キル/デスの映像認識（PUBG 系・後回し）
- [x] アプリ版を AI＋GPU 全機能で再ビルド（google-genai/tinysegmenter/CUDA 同梱、インストーラ約1.8GB）
- [x] アプリ内 ⚙設定で Gemini キー入力（safeStorage で暗号化保存＝Defender の隔離回避、env でバックエンドへ）
- [x] ⚙設定で「クリップの保存先フォルダ」選択（指定フォルダへ出力）
- [x] UI を extraResources(web)から配信 → 以後の UI 変更は electron-builder のみで反映（PyInstaller 不要）
- [ ] 将来: TikTok 直接投稿（Content Posting API）

## セットアップ（開発）

前提: Python 3.11+ と `ffmpeg`/`ffprobe` が PATH 上にあること。

```bash
cd backend
python -m venv .venv && .venv\Scripts\activate   # Windows
pip install -r requirements.txt

# Gemini を使う場合のみ（無くてもヒューリスティックで動く）
copy .env.example .env   # GEMINI_API_KEY を記入
```

## 使い方（CLI）

```bash
# ローカル mp4 から縦型ショートを N 本生成
python -m backend.cli path/to/archive.mp4 --clips 5 --out output/

# YouTube URL を補助メタとして渡す（字幕の固有名詞精度向上・任意）
python -m backend.cli archive.mp4 --url "https://www.youtube.com/watch?v=..." --clips 5

# 背景ぼかし＋冒頭ズームイン演出を付ける
python -m backend.cli archive.mp4 --clips 5 --reframe blur --intro zoom
```

主なオプション: `--reframe crop|blur|letterbox`（画面構成）/ `--intro none|fade|zoom|flash`
（冒頭トランジション）/ `--tempo off|silence|content|both`（不要部分カット）。
字幕ポップインは既定 ON（`SUBTITLE_ANIMATE=0` で無効化）。

生成物は `output/<job_id>/clip_XX.mp4`（焼き込み済み）と中間データ（transcript.json 等）。

## 起動方法（デスクトップアプリ / Electron）

```bash
# 1) バックエンド依存（初回のみ）
cd backend && pip install -r requirements.txt && cd ..

# 2) Electron 起動（初回は npm install で Electron をダウンロード）
cd app
npm install
npm start
```

Electron が空きポートを確保 → `python -m backend.server` を spawn → `BACKEND_READY` を待って
ウィンドウに localhost を表示する。「動画を選択」はネイティブのファイルダイアログを使うため
アップロード不要（ローカルパスを直接処理）。

ブラウザだけで確認したい場合:

```bash
python -m backend.server --port 8000
# ブラウザで http://127.0.0.1:8000 を開く（この場合はファイルをアップロードして処理）
```

## 配布ビルド（インストーラ exe）

ユーザーは Python も ffmpeg も不要。同梱した単体アプリになる（V-Cut と同方式）。

```bash
# 1) バックエンドを exe 化（ffmpeg/ffprobe を同梱）
pip install pyinstaller
python -m PyInstaller packaging/backend.spec --noconfirm --distpath dist --workpath build_pyi

# 2) Electron をインストーラ化
cd app && npm install && npm run dist
# → release/TikTok-Cut Setup <version>.exe（NSIS インストーラ）
```

- 生成物: `release/TikTok-Cut Setup x.y.z.exe`（インストーラ）/ `release/win-unpacked/`（動作確認用）
- インストール版の出力先: `%LOCALAPPDATA%\TikTok-Cut\output`
- 検証済み: 凍結 exe 単体で文字起こし（ctranslate2/onnxruntime）＋同梱 ffmpeg 描画→クリップ生成まで動作。
- **サイズ最適化（実施済み）**: ffprobe を廃止し `ffmpeg -i` で尺取得、ffmpeg を essentials build
  (~97MB) に差し替え。同梱フォント(~24MB)を足してもインストーラは 288MB → 201MB。
- **配布時の注意**: 無署名だと Windows SmartScreen 警告が出る。配布するならコード署名証明書を推奨。
