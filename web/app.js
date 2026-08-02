// TikTok-Cut フロントエンド。Electron(window.electronAPI) があれば
// ネイティブのファイル選択/保存を使い、無ければブラウザのアップロード/DLにフォールバック。

const electron = window.electronAPI || null;
const _nativeFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const token = electron && electron.apiToken;
  if (!token) return _nativeFetch(input, init);
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  let sameOriginApi = false;
  try {
    const u = new URL(url, window.location.href);
    sameOriginApi = u.origin === window.location.origin && u.pathname.startsWith('/api/');
  } catch (_) {
    sameOriginApi = String(url).startsWith('/api/');
  }
  if (!sameOriginApi) return _nativeFetch(input, init);
  const headers = new Headers(init.headers || (input && input.headers) || {});
  headers.set('X-TikTokCut-Token', token);
  return _nativeFetch(input, { ...init, headers });
};
function apiUrl(path) {
  const token = electron && electron.apiToken;
  if (!token) return path;
  const u = new URL(path, window.location.href);
  u.searchParams.set('token', token);
  return u.pathname + u.search;
}
let selectedFile = null;   // ブラウザ: File
let selectedPath = null;   // Electron: ローカル絶対パス
let currentJobId = null;
let pollTimer = null;

// ===== UI設定の永続化（プリセット/パレット/直近スタイル） =====
// Electron は毎回ランダムポート起動で localStorage(origin依存) が消えるため、サーバ側に保存する。
let _prefs = { presets: [], palette: null, laststyle: null };
let _prefsTimer = null;
async function loadPrefs() {
  try {
    const p = await (await fetch('/api/prefs')).json();
    if (p && typeof p === 'object') _prefs = Object.assign(_prefs, p);
  } catch (_) { /* サーバ未応答時はローカルへ */ }
  // 旧 localStorage / ローカルキャッシュからの移行（サーバが空のとき）
  const lsGet = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } };
  const cached = lsGet('tkc_prefs');
  if (cached && typeof cached === 'object') {
    if (!_prefs.presets || !_prefs.presets.length) _prefs.presets = cached.presets || _prefs.presets;
    if (!_prefs.palette) _prefs.palette = cached.palette || _prefs.palette;
    if (!_prefs.laststyle) _prefs.laststyle = cached.laststyle || _prefs.laststyle;
  }
  if (!_prefs.presets || !_prefs.presets.length) { const v = lsGet('tkc_presets'); if (v && v.length) _prefs.presets = v; }
  if (!_prefs.palette) { const v = lsGet('tkc_palette'); if (v) _prefs.palette = v; }
  if (!_prefs.laststyle) { const v = lsGet('tkc_laststyle'); if (v) _prefs.laststyle = v; }
}
function savePrefs(immediate) {
  try { localStorage.setItem('tkc_prefs', JSON.stringify(_prefs)); } catch (_) {}
  if (_prefsTimer) clearTimeout(_prefsTimer);
  const send = () => fetch('/api/prefs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(_prefs),
  }).catch(() => {});
  if (immediate) send();               // プリセット保存等は即時（アプリ終了で消えない）
  else _prefsTimer = setTimeout(send, 400);
}
// アプリ終了間際の未送信分を keepalive 付きで確実に送る
window.addEventListener('beforeunload', () => {
  if (!_prefsTimer) return;
  clearTimeout(_prefsTimer); _prefsTimer = null;
  try {
    fetch(apiUrl('/api/prefs'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(_prefs), keepalive: true }).catch(() => {});
  } catch (_) {}
});

// ===== ライセンス認証（初回起動時。Electron版のみ・オフライン検証） =====
async function initLicense() {
  const gate = document.getElementById('licenseGate');
  if (!gate) return;
  if (!(electron && electron.getLicense)) { gate.hidden = true; return; }  // ブラウザ版は不要
  try {
    const r = await electron.getLicense();
    if (r && r.licensed) { gate.hidden = true; return; }
    if (r && r.email) document.getElementById('licEmail').value = r.email;
    gate.hidden = false;
  } catch (_) { gate.hidden = true; }   // IPC不可時は通す（締め出さない）
}
async function submitLicense() {
  const email = document.getElementById('licEmail').value.trim();
  const key = document.getElementById('licKey').value.trim();
  const msg = document.getElementById('licMsg');
  msg.hidden = true;
  if (!email || !key) { msg.textContent = 'メールアドレスとライセンスキーを入力してください。'; msg.hidden = false; return; }
  try {
    const r = await electron.saveLicense(email, key);
    if (r && r.ok) document.getElementById('licenseGate').hidden = true;
    else { msg.textContent = 'ライセンスキーが正しくありません。メールアドレスとキーをご確認ください。'; msg.hidden = false; }
  } catch (e) { msg.textContent = 'エラー: ' + e.message; msg.hidden = false; }
}
initLicense();   // 起動直後にゲート判定
if (electron && electron.appVersion) document.title = `TikTok-Cut v${electron.appVersion}`;

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
}

// ===== 再編集モード（作成ページの分岐）: 過去の作品を開いて結果/詳細編集をそのまま使う =====
function switchPageMode(m) {
  document.querySelectorAll('[data-pmode]').forEach(b => b.classList.toggle('active', b.dataset.pmode === m));
  document.getElementById('createCard').hidden = (m !== 'new');
  document.getElementById('reeditCard').hidden = (m !== 'reedit');
  if (m === 'reedit') loadJobs();
}

async function loadJobs() {
  const box = document.getElementById('jobList');
  box.innerHTML = '<div class="ed-loading">読み込み中...</div>';
  try {
    const data = await (await fetch('/api/jobs')).json();
    const jobs = data.jobs || [];
    if (!jobs.length) {
      box.innerHTML = '<div class="ed-loading">過去の作品はまだありません（動画を作成するとここに並びます）</div>';
      return;
    }
    box.innerHTML = '';
    jobs.forEach(j => {
      const d = new Date((j.mtime || 0) * 1000);
      const date = d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate()
        + ' ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
      const item = document.createElement('div');
      item.className = 'job-item';
      if (j.thumbnail_path) {
        const img = document.createElement('img');
        img.src = apiUrl('/api/download/' + encodeURI(j.thumbnail_path));
        img.alt = '';
        item.appendChild(img);
      } else {
        const ph = document.createElement('div');
        ph.className = 'job-noimg';
        ph.textContent = '🎬';
        item.appendChild(ph);
      }
      const info = document.createElement('div');
      info.className = 'job-info';
      const name = document.createElement('div');
      name.className = 'job-name';
      name.textContent = j.job_id;
      const meta = document.createElement('div');
      meta.className = 'job-meta';
      meta.textContent = date + '・クリップ ' + (j.clip_count || 0) + '本'
        + (j.input_exists ? '' : '・元動画なし（閲覧/DLのみ・再生成不可）');
      info.appendChild(name); info.appendChild(meta);
      item.appendChild(info);
      const btn = document.createElement('button');
      btn.className = 'dl-btn';
      btn.textContent = '開く';
      btn.onclick = () => openJob(j.job_id);
      item.appendChild(btn);
      box.appendChild(item);
    });
  } catch (_) {
    box.innerHTML = '<div class="ed-loading">読み込みに失敗しました</div>';
  }
}

async function openJob(jobId) {
  try {
    const resp = await fetch('/api/status/' + encodeURIComponent(jobId));
    const job = await resp.json();
    if (!resp.ok) throw new Error(job.detail || '読み込みに失敗しました');
    currentJobId = jobId;
    renderClips(job.clips || []);
    const badge = document.getElementById('clipBadge');
    badge.textContent = (job.clips || []).length;
    badge.hidden = false;
    document.getElementById('resultTabBtn').disabled = false;
    switchTab('result');
  } catch (e) {
    alert('エラー: ' + e.message);
  }
}

async function selectVideo() {
  if (electron && electron.selectVideo) {
    const path = await electron.selectVideo();
    if (path) {
      selectedPath = path;
      selectedFile = null;
      setFileLabel(path.split(/[\\/]/).pop());
    }
  } else {
    document.getElementById('fileInput').click();
  }
}

document.getElementById('fileInput').addEventListener('change', function () {
  if (this.files && this.files[0]) {
    selectedFile = this.files[0];
    selectedPath = null;
    setFileLabel(selectedFile.name);
  }
});

function setFileLabel(name) {
  const btn = document.getElementById('selectBtn');
  document.getElementById('fileName').textContent = name;
  btn.classList.add('has-file');
}

async function startProcess() {
  if (!selectedFile && !selectedPath) {
    alert('動画ファイルを選択してください');
    return;
  }
  const btn = document.getElementById('startBtn');
  btn.disabled = true;
  btn.textContent = '作成中...';

  const fd = new FormData();
  fd.append('url', document.getElementById('urlInput').value.trim());
  fd.append('title', document.getElementById('titleInput').value.trim());
  fd.append('clip_count', document.getElementById('clipCount').value);
  fd.append('reframe', document.getElementById('reframe').value);
  fd.append('letterbox_color', document.getElementById('cLetterbox').value);
  fd.append('intro', document.getElementById('intro').value);
  const animV = document.getElementById('animSelect').value;
  fd.append('animation', animV);
  fd.append('effect', _effSel());   // エフェクトUIは廃止（既定 none・後方互換で送信のみ）
  fd.append('animate', animV === 'none' ? '0' : '1');
  const exitEl = document.getElementById('exitSelect');
  fd.append('exit_animation', exitEl ? exitEl.value : 'none');
  const karaEl = document.getElementById('karaOn');
  fd.append('karaoke', karaEl && karaEl.checked ? '1' : '0');
  fd.append('tempo', document.getElementById('tempo').value);
  fd.append('font', document.getElementById('fontSelect').value || '');
  fd.append('subtitle_color', document.getElementById('cSub').value);
  fd.append('highlight_color', document.getElementById('cHi').value);
  fd.append('emphasis_color', document.getElementById('cHi').value);   // 強調の色（旧ハイライト欄）
  fd.append('outline_color', document.getElementById('cOut').value);
  fd.append('title_color', document.getElementById('cTitle').value);
  fd.append('title_outline_color', document.getElementById('cOut').value);
  if (createMode === 'prompt') {
    fd.append('user_prompt', (document.getElementById('promptInput').value || '').trim());
    fd.append('genres', '');
  } else {
    fd.append('genres', selectedGenres().join(','));
    fd.append('user_prompt', '');
  }
  fd.append('caption_size', document.getElementById('capSize').value);
  fd.append('title_size', document.getElementById('titleSize').value);
  fd.append('outline_width', document.getElementById('capOutline').value);
  fd.append('title_outline_width', document.getElementById('titleOutline').value);
  fd.append('shadow_depth', document.getElementById('shadowD').value);
  fd.append('shadow_alpha', String((+document.getElementById('shadowA').value || 0) / 100));
  fd.append('shadow_blur', document.getElementById('shadowB').value);
  fd.append('box', document.getElementById('boxOn').checked ? '1' : '0');
  fd.append('box_color', document.getElementById('cBox').value);
  fd.append('box_pad', document.getElementById('boxPad').value);
  fd.append('watermark', document.getElementById('wmOn').checked ? '1' : '0');
  fd.append('watermark_pos', document.getElementById('wmPos').value);
  fd.append('logo', document.getElementById('logoOn').checked ? '1' : '0');
  fd.append('logo_pos', document.getElementById('logoPos').value);
  fd.append('laugh', document.getElementById('laughOn').checked ? '1' : '0');
  // コメント読み上げのチャット風化は廃止（読み上げソフトの合成音声はWhisperで安定認識できないため）
  fd.append('comment', '0');
  if (selectedPath) fd.append('video_path', selectedPath);
  else fd.append('video', selectedFile);

  // ステータス表示初期化
  const sc = document.getElementById('statusCard');
  sc.hidden = false;
  document.getElementById('errorBox').hidden = true;
  setProgress(0, '動画を解析中...');

  try {
    const resp = await fetch('/api/process', { method: 'POST', body: fd });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || '処理の開始に失敗しました');
    currentJobId = data.job_id;
    pollFails = 0;
    pollTimer = setInterval(checkStatus, 1500);
    checkStatus();
  } catch (e) {
    showError(e.message);
    resetStartBtn();
  }
}

let pollFails = 0;
async function checkStatus() {
  if (!currentJobId) return;
  try {
    const resp = await fetch('/api/status/' + currentJobId);
    const job = await resp.json();
    if (!resp.ok) throw new Error('接続が切れました');
    pollFails = 0;

    setProgress(job.progress || 0, job.step || '');

    if (job.clips && job.clips.length) {
      renderClips(job.clips);
      const badge = document.getElementById('clipBadge');
      badge.textContent = job.clips.length;
      badge.hidden = false;
      document.getElementById('resultTabBtn').disabled = false;
    }

    if (job.status === 'completed') {
      clearInterval(pollTimer);
      setProgress(100, job.warning ? ('完了（' + job.warning + '）') : '完了！');
      resetStartBtn();
      if (job.clips && job.clips.length) switchTab('result');
    } else if (job.status === 'failed') {
      clearInterval(pollTimer);
      showError(job.error || '処理中にエラーが発生しました');
      resetStartBtn();
    }
  } catch (e) {
    // 一過性の取りこぼしは無視。連続で失敗したらバックエンド異常終了とみなす。
    pollFails++;
    if (pollFails >= 4) {
      clearInterval(pollTimer);
      const where = (window.electronAPI && window.electronAPI.isElectron)
        ? 'ログ: %LOCALAPPDATA%\\TikTok-Cut\\backend.log を確認してください。'
        : '';
      showError('バックエンドが応答しません。処理が重すぎる/メモリ不足でクラッシュした可能性があります。'
        + 'モデルを medium にする・短い動画で試す等をお試しください。' + where);
      resetStartBtn();
    }
  }
}

function setProgress(pct, step) {
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressPct').textContent = pct + '%';
  if (step) document.getElementById('statusStep').textContent = step;
}

function showError(msg) {
  const box = document.getElementById('errorBox');
  box.textContent = 'エラー: ' + msg;
  box.hidden = false;
}

function resetStartBtn() {
  const btn = document.getElementById('startBtn');
  btn.disabled = false;
  btn.textContent = '✨ 切り抜きを作成する';
}

function esc(s) {
  // 引用符もエスケープ（属性値に埋め込むためタイトル等の " ' で属性を破られない）
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderClips(clips) {
  window._lastClips = clips || [];   // 「すべて保存」用に保持
  const sab = document.getElementById('saveAllBar');
  if (sab) sab.hidden = !(clips && clips.length);
  const grid = document.getElementById('clipGrid');
  grid.innerHTML = '';
  clips.forEach(c => {
    const src = apiUrl('/api/download/' + encodeURI(c.file_path));
    const poster = c.thumbnail_path ? apiUrl('/api/download/' + encodeURI(c.thumbnail_path)) : '';
    const job = (c.file_path || '').split(/[\\/]/)[0];
    const tags = (c.hashtags || []).map(h => '<span class="tag">#' + esc(h) + '</span>').join(' ');
    const card = document.createElement('div');
    card.className = 'clip-card';
    card.dataset.job = job; card.dataset.cid = c.id;
    card.innerHTML =
      '<video src="' + src + '" poster="' + poster + '" controls preload="metadata"></video>' +
      '<div class="clip-body">' +
        '<div class="clip-title">' + esc(c.id) + '. ' + esc(c.title || '無題') + '</div>' +
        '<div class="clip-meta">' + fmt(c.start) + ' 〜 ' + fmt(c.end) + '（' + Math.round(c.end - c.start) + '秒）</div>' +
        (c.hook ? '<div class="clip-meta">フック: ' + esc(c.hook) + '</div>' : '') +
        '<div class="clip-reason">' + esc(c.reason || '') + '</div>' +
        (c.caption ? '<div class="clip-caption">' + esc(c.caption) + '</div>' : '') +
        '<div class="tags">' + tags + '</div>' +
        '<button class="dl-btn" onclick="openDetailFromBtn(this)">✏️ 詳細編集（字幕・位置・効果音）</button>' +
        '<a class="dl-btn" href="#" onclick="return downloadClip(\'' + encodeURI(c.file_path) + '\',\'' + esc(String(c.title || 'clip').replace(/['"\\]/g, '')) + '\')">動画をダウンロード</a>' +
      '</div>';
    grid.appendChild(card);
  });
  // 一括スタイル適用バー（クリップがある時のみ）。ジョブIDを保持。
  const bar = document.getElementById('bulkBar');
  if (bar) {
    const job0 = clips.length ? (clips[0].file_path || '').split(/[\\/]/)[0] : '';
    if (job0) bar.dataset.job = job0;
    bar.hidden = clips.length === 0;
    updateBulkPreview();
  }
}

function fmt(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

// 全クリップを一括保存（アプリ版=フォルダ選択して一括コピー／ブラウザ=順次ダウンロード）
async function saveAllClips() {
  const clips = window._lastClips || [];
  const st = document.getElementById('saveAllStatus');
  if (!clips.length) return;
  const safe = s => String(s || 'clip').replace(/[\\/:*?"<>|]/g, '').slice(0, 60);
  if (electron && electron.saveAll) {
    st.textContent = '保存先を選択してください...';
    const items = clips.map(c => ({
      serverPath: c.file_path,
      saveName: String(c.id).padStart(2, '0') + '_' + safe(c.title) + '.mp4',
    }));
    const res = await electron.saveAll(items);
    if (res && res.ok) st.textContent = '✓ ' + res.count + '本を保存しました: ' + res.dir;
    else if (res && res.error) st.textContent = 'エラー: ' + res.error;
    else st.textContent = '';
  } else {
    clips.forEach(c => downloadClip(encodeURI(c.file_path), safe(c.title)));
    st.textContent = '✓ ダウンロードを開始しました';
  }
}

function downloadClip(path, title) {
  if (electron && electron.saveFile) {
    electron.saveFile(decodeURI(path), title + '.mp4');
  } else {
    const a = document.createElement('a');
    a.href = apiUrl('/api/download/' + path);
    a.download = title + '.mp4';
    document.body.appendChild(a); a.click(); a.remove();
  }
  return false;
}

// 詳細編集ページから、今開いているクリップをダウンロード
function downloadDetailClip() {
  const ed = document.getElementById('detailEditor');
  if (!ed || !ed.dataset.job) return;
  const job = ed.dataset.job, cid = ed.dataset.cid;
  const title = ((ed.querySelector('.ed-title') || {}).value || '').trim()
    || (document.getElementById('detailTitle').textContent || 'clip').replace(/^\d+\.\s*/, '');
  const safe = String(title || 'clip').replace(/[\\/:*?"<>|]/g, '').slice(0, 60) || 'clip';
  const path = job + '/clip_' + ('0' + cid).slice(-2) + '.mp4';
  downloadClip(encodeURI(path), safe);
}

// ===== フォント一覧・プレビュー・よく使う色 =====
let _lastColorInput = null;

function updatePreview() {
  const g = id => document.getElementById(id);
  const fam = g('fontSelect') ? g('fontSelect').value : '';
  const ff = `'${fam}', sans-serif`;
  const out = g('cOut').value;
  const apply = (el, color, size, ow) => {
    if (!el) return;
    el.style.fontFamily = ff;
    el.style.fontSize = size + 'px';
    el.style.color = color;
    el.style.webkitTextStroke = Math.max(0, ow).toFixed(1) + 'px ' + out;
  };
  apply(g('pvTitle'), g('cTitle').value, Math.max(14, Math.min(58, (+g('titleSize').value) * 0.42)),
        (+g('titleOutline').value) * 0.6);
  apply(g('pvCap'), g('cSub').value, Math.max(14, Math.min(50, (+g('capSize').value) * 0.42)),
        (+g('capOutline').value) * 0.6);
  // 枠（背景ボックス）: オンなら字幕に半透明の背景、縁取りは消す
  const cap = g('pvCap');
  if (cap) {
    const boxOn = g('boxOn') && g('boxOn').checked;
    if (boxOn) {
      const bp = (g('boxPad') ? +g('boxPad').value : 10) || 10;   // 枠の余白を反映
      cap.style.background = hexToRgba(g('cBox') ? g('cBox').value : '#000000', 0.5);
      cap.style.padding = Math.round(bp * 0.3) + 'px ' + Math.round(bp * 0.55) + 'px';
      cap.style.borderRadius = '6px';
      cap.style.webkitTextStroke = '0px transparent';
      cap.style.display = 'inline-block';
    } else {
      cap.style.background = 'transparent';
      cap.style.padding = '0';
    }
  }
  applyPreviewEffect();   // エフェクト装飾（光彩/キラキラ/ホラー）を反映
}

// ===== 文字アニメ／エフェクトの CSS 近似プレビュー =====
// 出現アニメ: 名前 → CSS keyframe（無限ループ系は iter:'infinite'）
const PV_ANIM = {
  default: { name: 'pvPop', dur: .55 },
  none: { name: '' },
  fade: { name: 'pvFade', dur: .6 },
  pop: { name: 'pvPop', dur: .5 },
  bounce: { name: 'pvBounce', dur: .65 },
  slide: { name: 'pvSlide', dur: .55 },
  wipe: { name: 'pvWipe', dur: .6 },
  breathe: { name: 'pvBreathe', dur: 2.4, iter: 'infinite' },
  wave: { name: 'pvWave', dur: 1.4, iter: 'infinite' },
  flip: { name: 'pvFlip', dur: .5 },
  zoombig: { name: 'pvZoomBig', dur: .5 },
  shake: { name: 'pvShakeIn', dur: .5 },
  spin: { name: 'pvSpin', dur: .55 },
  blurin: { name: 'pvBlurIn', dur: .5 },
  stagger: { name: '' },      // 1文字ずつ入場（チップ側で文字spanに分解して再現）
  typewriter: { name: '' },   // タイプライター（同上）
};
function _animSel() { const e = document.getElementById('animSelect'); return e ? e.value : 'default'; }
// 文字エフェクト: 作成ページのUIは廃止済。テンプレ適用時は内部状態(_styleEffect)で保持し、
// クリップごとの変更は詳細編集の「文字エフェクト」セレクトで行う。
let _styleEffect = 'none';
function _effSel() { const e = document.getElementById('effectSelect'); return e ? e.value : (_styleEffect || 'none'); }

// 作成タブ・編集UIで共有するアニメ/エフェクトの選択肢
const ANIM_OPTS = [['default', 'ポップイン（標準）'], ['none', 'なし'], ['fade', 'フェード'],
  ['pop', 'ポップ'], ['bounce', 'バウンス'], ['slide', 'スライドイン（パン）'],
  ['wipe', 'ワイプ'], ['breathe', 'ブリーズ'], ['wave', 'ウェーブ（近似）'],
  ['flip', 'フリップ'], ['zoombig', 'ズーム特大'], ['shake', 'シェイク'], ['spin', 'スピン'], ['blurin', 'ブラー'],
  ['stagger', '1文字ずつポップ'], ['typewriter', 'タイプライター']];
const EFFECT_OPTS = [['none', 'なし'], ['glow', '光彩'], ['sparkle', 'キラキラ（近似）'], ['horror', 'ホラー'],
  ['neon', 'ネオン'], ['rainbow', '虹色'], ['gold', '金文字'], ['jitter', 'ジッター（微振動）']];
const EXIT_OPTS = [['none', 'なし'], ['fade', 'フェードアウト'], ['shrink', '縮んで消える'],
  ['blurout', 'ぼけて消える'], ['flip', 'めくれて消える']];
// エフェクトのプレビュークラスをまとめて付け替え
const PV_EFFS = ['glow', 'horror', 'sparkle', 'neon', 'rainbow', 'gold', 'jitter'];
function _pvApplyEff(el, eff) {
  PV_EFFS.forEach(x => el.classList.remove('pv-eff-' + x));
  if (eff && eff !== 'none' && PV_EFFS.indexOf(eff) >= 0) el.classList.add('pv-eff-' + eff);
}
// stagger/typewriter/karaoke のチップ描画: 1文字ずつ<span>にして遅延アニメ（焼き込みの近似）。
// elapsedSec（テロップ開始からの経過秒）ぶん負の delay でずらす＝シーク位置でも途中経過が正しく見える。
// 一時停止中は play-state: paused でその瞬間の状態のまま静止。
function _pvCharSpans(text, maxChars, maxLines, mode, durSec, elapsedSec, playing, speed) {
  const lines = _pvWrap(text, maxChars, maxLines);
  const total = Math.max(1, lines.join('').length);
  const off = Math.round((elapsedSec || 0) * 1000);
  const ps = ';animation-play-state:' + (playing ? 'running' : 'paused');
  const spd = (+speed > 0) ? +speed : 1;   // 入場速度倍率（stagger/typewriter のみ・カラオケは発話同期）
  let k = 0;
  const mk = ch => {
    let st = '';
    if (mode === 'stagger') st = 'animation:pvChPop .15s ease-out both;animation-delay:' + (Math.round(Math.min(600, k * 45) / spd) - off) + 'ms' + ps;
    else if (mode === 'typewriter') st = 'animation:pvChShow 1ms steps(1) both;animation-delay:' + (Math.round(Math.min(600, k * 45) / spd) - off) + 'ms' + ps;
    else if (mode === 'karaoke') st = 'animation:pvChKara .12s linear both;animation-delay:' + (Math.round(k * (Math.max(0.3, durSec) * 920 / total)) - off) + 'ms' + ps;
    k++;
    return '<span class="pv-ch" style="' + st + '">' + esc(ch) + '</span>';
  };
  return lines.map(l => Array.from(l).map(mk).join('')).join('<br>');
}
// 虹色ウェーブのプレビュー: 各文字に負の delay で位相をずらした虹サイクル（常時ループ）
function _pvRainbowSpans(text, maxChars, maxLines) {
  const lines = _pvWrap(text, maxChars, maxLines);
  let k = 0;
  return lines.map(l => Array.from(l).map(ch =>
    '<span class="pv-ch pv-rb" style="animation-delay:-' + ((k++) * 0.14).toFixed(2) + 's">' + esc(ch) + '</span>'
  ).join('')).join('<br>');
}
function optionsHtml(list, sel) {
  return list.map(([v, l]) => '<option value="' + v + '"' + (v === sel ? ' selected' : '') + '>' + l + '</option>').join('');
}
// テロップ個別アニメの選択肢（''=クリップ既定に従う）
const TANIM_OPTS = [['', '（既定）']].concat(ANIM_OPTS.filter(o => o[0] !== 'default'));
// テロップ個別エフェクト（''=クリップ既定・'none'=明示的に無し）
const TEFFECT_OPTS = [['', '（既定）']].concat(EFFECT_OPTS);
// テロップ個別フォントの options HTML（''=クリップ既定）。各行にそのフォント自体を適用して
// 見た目で選べるようにする（@font-face は initFonts が document 全体に注入済み）。
function _tFontOpts(sel) {
  const list = window._fontList || [];
  let h = '<option value=""' + (!sel ? ' selected' : '') + '>（既定）</option>';
  list.forEach(f => {
    h += '<option value="' + esc(f.family) + '" style="font-family:\'' + esc(f.family) + '\'"' +
      (f.family === sel ? ' selected' : '') + '>' + esc(f.label) + '</option>';
  });
  return h;
}

// ===== 見た目つきピッカー（アニメ/エフェクト/退場の選択） =====
// フォント選択の「見た目で選べる」をアニメ/エフェクトにも展開: <select> を隠し、
// サンプル文字に実際のアニメ/エフェクトを適用したグリッドメニューで選ぶ。
// 値は元の <select> に書き戻して change をバブルさせる＝既存の配線はそのまま動く。
let _fxMenuEl = null;
function _fxCloseMenu() {
  if (_fxMenuEl) { _fxMenuEl.remove(); _fxMenuEl = null; }
  document.removeEventListener('pointerdown', _fxDocClose, true);
}
function _fxDocClose(e) { if (_fxMenuEl && !_fxMenuEl.contains(e.target)) _fxCloseMenu(); }
function _fxSample(el, kind, v) {
  if (kind === 'effect') { _pvApplyEff(el, v || 'none'); return; }
  if (kind === 'anim') {
    const a = v || 'default';
    if (a === 'stagger' || a === 'typewriter') {   // 1文字ずつ系は文字spanのループで近似
      el.innerHTML = Array.from('あア文字').map((ch, i) =>
        '<span style="display:inline-block;animation:' + (a === 'stagger' ? 'pvChPop' : 'pvChShow') +
        ' 1.3s ease-out ' + (i * 0.13).toFixed(2) + 's infinite both">' + ch + '</span>').join('');
      return;
    }
    const cfg = PV_ANIM[a] || {};
    if (cfg.name) el.style.animation = cfg.name + ' ' + Math.max(1.1, (cfg.dur || 1) * 1.6).toFixed(2) + 's ease-out infinite';
    return;
  }
  if (kind === 'exit') {
    const map = { fade: 'pvExFade', shrink: 'pvExShrink', blurout: 'pvExBlur', flip: 'pvExFlip' };
    if (map[v]) el.style.animation = map[v] + ' 1.6s ease-in infinite';
  }
}
function fxPickerify(sel, kind) {
  if (!sel || sel.dataset.fxp) return;
  sel.dataset.fxp = '1';
  sel.style.display = 'none';
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'fxp-btn';
  const sync = () => {
    const o = sel.options[sel.selectedIndex];
    btn.innerHTML = '<span class="fxp-cur">' + esc(o ? o.textContent : '') + '</span><span>▾</span>';
    if (kind === 'effect') _pvApplyEff(btn.querySelector('.fxp-cur'), sel.value || 'none');
  };
  sync();
  sel.insertAdjacentElement('afterend', btn);
  btn.addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    if (_fxMenuEl) { _fxCloseMenu(); return; }
    const menu = document.createElement('div');
    menu.className = 'fxp-menu';
    Array.from(sel.options).forEach(o => {
      const it = document.createElement('button');
      it.type = 'button';
      it.className = 'fxp-item' + (o.value === sel.value ? ' sel' : '');
      it.innerHTML = '<span class="fxp-sample">あア文字</span><span class="fxp-name">' + esc(o.textContent) + '</span>';
      _fxSample(it.querySelector('.fxp-sample'), kind, o.value);
      it.addEventListener('click', () => {
        sel.value = o.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        sync();
        _fxCloseMenu();
      });
      menu.appendChild(it);
    });
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(window.innerWidth - 356, r.left)) + 'px';
    menu.style.top = Math.max(8, Math.min(window.innerHeight - 336, r.bottom + 4)) + 'px';
    _fxMenuEl = menu;
    setTimeout(() => document.addEventListener('pointerdown', _fxDocClose, true), 0);
  });
}

// ===== 字幕＋効果音 インライン縦タイムライン（動画エディタ風・ed._telops/ed._sfx をライブ編集） =====
const ED_SNAP = 0.1, ED_MIN_DUR = 0.2, ED_MIN_PX = 14;
let ED_PX = 80;                                   // ズーム可変（px/秒）
const ED_PX_MIN = 20, ED_PX_MAX = 200;            // 5分クリップ×200でもcanvas上限(65535px)内
function edT2y(t) { return t * ED_PX; }
function edY2t(ed, y) { return Math.max(0, Math.min(ed._dur || 0, y / ED_PX)); }
function edSnap(t) { return Math.round(t / ED_SNAP) * ED_SNAP; }
function edClamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function edFmt(s) { const m = Math.floor(s / 60), ss = Math.floor(s % 60); return m + ':' + ('0' + ss).slice(-2); }

// --- タイムラインズーム（Ctrl+ホイール / ＋−ボタン） ---
function edSetZoom(ed, px, anchorT) {
  px = Math.round(edClamp(px, ED_PX_MIN, ED_PX_MAX));
  if (px === ED_PX) return;
  const wrap = ed.querySelector('.ed-tl-wrap');
  const oldPx = ED_PX;
  ED_PX = px;
  edRenderTimeline(ed);
  edDrawWave(ed);
  // アンカー時刻（マウス位置/プレイヘッド）が同じ画面位置に留まるようスクロール補正
  if (wrap && anchorT != null) {
    wrap.scrollTop = Math.max(0, wrap.scrollTop + anchorT * (ED_PX - oldPx));
  }
  const v = _clipVideo(ed); edPlayheadTo(ed, v ? (v.currentTime || 0) : 0);
  const o = ed.querySelector('.ed-zoom-o'); if (o) o.textContent = Math.round(ED_PX / 80 * 100) + '%';
}
function edZoomBtn(btn, dir) {
  const ed = btn.closest('.clip-editor'); if (!ed) return;
  const v = _clipVideo(ed);
  edSetZoom(ed, ED_PX * (dir > 0 ? 1.25 : 0.8), v ? (v.currentTime || 0) : 0);
}
function edWireZoom(ed) {
  const wrap = ed.querySelector('.ed-tl-wrap'); if (!wrap || wrap._zoomWired) return;
  wrap._zoomWired = true;
  wrap.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const tl = ed.querySelector('.ed-tl'); if (!tl) return;
    const anchorT = (e.clientY - tl.getBoundingClientRect().top) / ED_PX;   // マウス下の時刻を固定
    edSetZoom(ed, ED_PX * (e.deltaY < 0 ? 1.15 : 0.87), anchorT);
  }, { passive: false });
}

// --- 効果音レーンの音声波形（サーバの /waveform ピークを縦向きに描画） ---
function edDrawWave(ed) {
  const c = ed.querySelector('.ed-tl-wave'); if (!c) return;
  const peaks = ed._peaks;
  const lane = c.parentElement;
  const W = lane.clientWidth || 120, H = Math.max(1, Math.round(edT2y(ed._dur || 0)));
  c.width = W; c.height = Math.min(H, 65000);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  if (!peaks || !peaks.length) return;
  ctx.fillStyle = 'rgba(37,244,238,.22)';
  const n = peaks.length, bh = Math.max(1, c.height / n);
  for (let i = 0; i < n; i++) {
    const bw = Math.max(1, peaks[i] * (W - 10));
    ctx.fillRect((W - bw) / 2, i / n * c.height, bw, bh);
  }
}

// --- Undo / Redo（タイムライン編集のスナップショットスタック） ---
function edSnapState(ed) {
  return {
    telops: edClone(ed._telops),
    sfx: (ed._sfx || []).map(b => ({ uid: b.uid, id: b.id, at: b.at, gain: b.gain, baked: b.baked })),
    images: (ed._images || []).map(im => ({ ...im })),
    cuts: (ed._cuts || []).map(c => ({ start: c.start, end: c.end })),
    keeps: ed._keeps ? ed._keeps.map(k => [k[0], k[1]]) : null,
    dur: ed._dur,
  };
}
function edPushUndoSnap(ed, snap) {
  (ed._undo = ed._undo || []).push(snap);
  if (ed._undo.length > 100) ed._undo.shift();
  ed._redo = [];
  edSyncUndoBtns(ed);
}
function edPushUndo(ed, tag) {
  // 同じ操作（スライダー/連続キー入力）は800ms以内なら1回のUndoにまとめる
  const now = performance.now();
  if (tag && ed._undoTag === tag && now - (ed._undoT || 0) < 800) { ed._undoT = now; return; }
  ed._undoTag = tag || null; ed._undoT = now;
  edPushUndoSnap(ed, edSnapState(ed));
}
function edApplyState(ed, st) {
  ed._telops = edClone(st.telops);
  ed._sfx = (st.sfx || []).map(b => ({ ...b }));
  ed._images = (st.images || []).map(im => ({ ...im }));
  ed._cuts = (st.cuts || []).map(c => ({ ...c }));
  ed._keeps = st.keeps ? st.keeps.map(k => [k[0], k[1]]) : null;
  if (st.dur != null) ed._dur = st.dur;
  ed._selTelop = -1; ed._selSfx = null; ed._selSet = null; ed._selImg = null;
  edRenderTimeline(ed); edDrawWave(ed);
  edRenderSelTelop(ed); edRenderSelSfx(ed); edRenderSelImg(ed); edSyncImgCount(ed);
  renderPreviewTelops(ed); updateEditorPreview(ed);
}
function edUndo(ed) {
  const u = ed._undo; if (!u || !u.length) return;
  (ed._redo = ed._redo || []).push(edSnapState(ed));
  edApplyState(ed, u.pop());
  ed._undoTag = null; edSyncUndoBtns(ed);
}
function edRedo(ed) {
  const r = ed._redo; if (!r || !r.length) return;
  (ed._undo = ed._undo || []).push(edSnapState(ed));
  edApplyState(ed, r.pop());
  ed._undoTag = null; edSyncUndoBtns(ed);
}
function edSyncUndoBtns(ed) {
  const u = ed.querySelector('.ed-undo'), r = ed.querySelector('.ed-redo');
  if (u) u.disabled = !(ed._undo && ed._undo.length);
  if (r) r.disabled = !(ed._redo && ed._redo.length);
  // 画面端の「戻る/進む」ドックも同期
  const du = document.getElementById('dockUndo'), dr = document.getElementById('dockRedo');
  if (du) du.disabled = !(ed._undo && ed._undo.length);
  if (dr) dr.disabled = !(ed._redo && ed._redo.length);
}
function edUndoBtn(btn) { const ed = btn.closest('.clip-editor'); if (ed) edUndo(ed); }
function edRedoBtn(btn) { const ed = btn.closest('.clip-editor'); if (ed) edRedo(ed); }
// 画面端ドック（詳細編集タブに固定表示）
function dockUndo() { const ed = document.getElementById('detailEditor'); if (ed && ed.dataset.loaded) edUndo(ed); }
function dockRedo() { const ed = document.getElementById('detailEditor'); if (ed && ed.dataset.loaded) edRedo(ed); }

// --- 磁石スナップ（常時ON。8px相当以内に近づいた時だけ吸着＝それ以外は自由配置） ---
function edMagnetT(ed, t, opts) {
  opts = opts || {};
  const thr = 8 / ED_PX;   // 8px相当以内で吸着
  let best = null, bd = thr;
  const consider = c => { const d = Math.abs(c - t); if (d < bd) { bd = d; best = c; } };
  (ed._telops || []).forEach((tp, i) => { if (i === opts.skipTelop || (opts.skipSet && opts.skipSet.has(tp))) return; consider(tp.start); consider(tp.end); });
  (ed._sfx || []).forEach(b => { if (b.uid === opts.skipSfx) return; consider(b.at); });
  (ed._cuts || []).forEach((c, i) => { if (i === opts.skipCut) return; consider(c.start); consider(c.end); });
  const v = _clipVideo(ed); if (v) consider(v.currentTime || 0);
  return best == null ? t : best;
}

// --- 複数選択（Shift+クリック・telops） ---
function edSyncMsel(ed) {
  const set = ed._selSet;
  ed.querySelectorAll('.ed-tl-tel .ed-block').forEach(n => {
    const tp = (ed._telops || [])[+n.dataset.i];
    n.classList.toggle('msel', !!(set && tp && set.has(tp)));
  });
}
function edToggleMselTelop(ed, i) {
  const tp = (ed._telops || [])[i]; if (!tp) return;
  if (!ed._selSet) {
    ed._selSet = new Set();
    const cur = (ed._telops || [])[ed._selTelop];
    if (cur && cur !== tp) ed._selSet.add(cur);   // 既存の単一選択も含めて複数選択を開始
  }
  if (ed._selSet.has(tp)) ed._selSet.delete(tp); else ed._selSet.add(tp);
  if (!ed._selSet.size) ed._selSet = null;
  edSyncMsel(ed);
  edRenderSelTelop(ed);   // 「N個選択中」の表示を更新
}
function edClone(arr) {
  return (arr || []).map(t => ({ start: +t.start || 0, end: +t.end || 0, text: t.text || '',
    style: t.style || '', emphasis: !!t.emphasis, animation: t.animation || '',
    font: t.font || '', color: t.color || '', outline_color: t.outline_color || '',
    size: +t.size || 0, width: +t.width || 0, effect: t.effect || '', anim_speed: +t.anim_speed || 0,
    layer: +t.layer || 0, pos: (t.pos && t.pos.x != null) ? { x: +t.pos.x, y: +t.pos.y } : null }));
}
function edTip(e, msg) { const tip = document.getElementById('subTooltip'); if (!tip) return; tip.textContent = msg; tip.hidden = false; tip.style.left = (e.clientX + 12) + 'px'; tip.style.top = (e.clientY + 12) + 'px'; }
function edTipHide() { const t = document.getElementById('subTooltip'); if (t) t.hidden = true; }

// 補助線・目盛りの間隔（秒）。ズーム倍率に応じて 1/2/5 秒を自動で切り替える。
function edGridStep() { return ED_PX >= 48 ? 1 : (ED_PX >= 24 ? 2 : 5); }

function edRenderTimeline(ed) {
  const tl = ed.querySelector('.ed-tl'); if (!tl) return;
  const H = Math.max(140, edT2y(ed._dur || 0));
  tl.style.height = H + 'px';
  ed.querySelectorAll('.ed-tl-gutter, .ed-tl-lane').forEach(n => { n.style.height = H + 'px'; });
  // 全レーンを横断する補助線: 細線=edGridStep()秒ごと・太めの線=その5倍ごと（グラデ2層）
  const iv = edGridStep() * ED_PX;
  tl.style.backgroundImage =
    'repeating-linear-gradient(to bottom, rgba(255,255,255,.14) 0 1px, transparent 1px ' + (iv * 5) + 'px),' +
    'repeating-linear-gradient(to bottom, rgba(255,255,255,.06) 0 1px, transparent 1px ' + iv + 'px)';
  edRenderGutter(ed);
  edRenderTelopBlocks(ed);
  edRenderSfxBlocks(ed);
  edRenderImgBlocks(ed);
  edRenderCuts(ed);
}

// --- 画像レーン（タイムライン上で表示区間の移動・伸縮・選択・削除） ---
function edRenderImgBlocks(ed) {
  const lane = ed.querySelector('.ed-tl-img'); if (!lane) return;
  lane.querySelectorAll('.ed-block').forEach(n => n.remove());
  (ed._images || []).forEach(im => {
    const top = edT2y(im.start), hh = Math.max(ED_MIN_PX, edT2y(im.end) - edT2y(im.start));
    const el = document.createElement('div');
    el.className = 'ed-block ed-block-img' + (im.uid === ed._selImg ? ' sel' : '');
    el.style.top = top + 'px'; el.style.height = hh + 'px'; el.dataset.uid = im.uid;
    el.innerHTML = '<div class="ed-grip ed-grip-top"></div>' +
      '<button type="button" class="ed-block-del" tabindex="-1">✕</button>' +
      '<span class="ed-blk-dots" title="ドラッグで移動"></span>' +
      '<img class="ed-img-thumb" src="' + apiUrl('/api/download/' + ed.dataset.job + '/' + esc(im.file)) + '" alt="" draggable="false">' +
      '<div class="ed-grip ed-grip-bot"></div>';
    el.title = '画像 ' + (+im.start).toFixed(1) + 's〜' + (+im.end).toFixed(1) + 's（ドラッグ=移動・上下端=表示区間・✕=削除）';
    edWireImgBlock(ed, el, im);
    lane.appendChild(el);
  });
}
function edWireImgBlock(ed, el, im) {
  let mode = null, startY = 0, s0 = 0, e0 = 0, snap0 = null, pushed = false;
  el.querySelector('.ed-block-del').addEventListener('click', e => {
    e.stopPropagation();
    edPushUndo(ed);
    ed._images = (ed._images || []).filter(x => x.uid !== im.uid);
    if (ed._selImg === im.uid) ed._selImg = null;
    edRenderImgBlocks(ed); edRenderSelImg(ed); renderPreviewTelops(ed); edSyncImgCount(ed);
  });
  el.addEventListener('pointerdown', e => {
    if (e.target.classList.contains('ed-block-del')) return;
    // ダブルクリック＝ポップアップ編集（preventDefault のため dblclick は飛ばない→自前判定）
    const now = performance.now();
    if (el._dblT && now - el._dblT < 350) {
      el._dblT = 0;
      e.preventDefault(); e.stopPropagation();
      edOpenImgModal(ed, im.uid);
      return;
    }
    el._dblT = now;
    edSelectImg(ed, im.uid);
    mode = e.target.classList.contains('ed-grip-top') ? 'top' : e.target.classList.contains('ed-grip-bot') ? 'bot' : 'move';
    s0 = im.start; e0 = im.end; startY = e.clientY;
    snap0 = edSnapState(ed); pushed = false;
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault(); e.stopPropagation();
  });
  el.addEventListener('pointermove', e => {
    if (!mode) return;
    const dt = edSnap((e.clientY - startY) / ED_PX);
    if (!pushed && dt !== 0) { pushed = true; edPushUndoSnap(ed, snap0); ed._undoTag = null; }
    if (mode === 'move') {
      const len = e0 - s0;
      const s = edClamp(s0 + dt, 0, (ed._dur || 0) - len);
      im.start = +s.toFixed(2); im.end = +(s + len).toFixed(2);
    } else if (mode === 'top') { im.start = +edMagnetT(ed, edClamp(s0 + dt, 0, im.end - ED_MIN_DUR)).toFixed(2); }
    else { im.end = +edMagnetT(ed, edClamp(e0 + dt, im.start + ED_MIN_DUR, ed._dur || 0)).toFixed(2); }
    el.style.top = edT2y(im.start) + 'px';
    el.style.height = Math.max(ED_MIN_PX, edT2y(im.end) - edT2y(im.start)) + 'px';
    edSeekVideo(ed, mode === 'bot' ? im.end : im.start);
    edRenderSelImg(ed);
  });
  const up = e => { if (!mode) return; mode = null; try { el.releasePointerCapture(e.pointerId); } catch (_) {} renderPreviewTelops(ed); };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}
// 画像の選択（レーンブロック/プレビューチップ共通）。字幕・効果音の選択は解除する。
function edSelectImg(ed, uid) {
  ed._selImg = uid; ed._selTelop = -1; ed._selSfx = null;
  ed.querySelectorAll('.ed-tl-img .ed-block').forEach(n => n.classList.toggle('sel', n.dataset.uid === uid));
  ed.querySelectorAll('.ed-tl-tel .ed-block, .ed-tl-sfx .ed-block').forEach(n => n.classList.remove('sel'));
  const f = _edFrame(ed);   // プレビューチップの選択枠も同期
  if (f) f.querySelectorAll('.ed-img-chip').forEach(n => n.classList.toggle('sel', n.dataset.uid === uid));
  edRenderSelTelop(ed); edRenderSelSfx(ed); edRenderSelImg(ed);
}
function edRenderGutter(ed) {
  const g = ed.querySelector('.ed-tl-gutter'); if (!g) return;
  g.querySelectorAll('.ed-tick').forEach(n => n.remove());
  const dur = ed._dur || 0, step = edGridStep();   // ラベルは補助線と同じ間隔で揃える
  for (let s = 0; s <= Math.ceil(dur); s += step) {
    const tk = document.createElement('div'); tk.className = 'ed-tick'; tk.style.top = edT2y(s) + 'px';
    tk.innerHTML = '<span class="ed-tick-label">' + edFmt(s) + '</span>';
    g.appendChild(tk);
  }
}
// --- 字幕レーン ---
function edRenderTelopBlocks(ed) {
  const lane = ed.querySelector('.ed-tl-tel'); if (!lane) return;
  lane.querySelectorAll('.ed-block').forEach(n => n.remove());
  (ed._telops || []).forEach((tp, i) => {
    const top = edT2y(tp.start), hh = Math.max(ED_MIN_PX, edT2y(tp.end) - edT2y(tp.start));
    const el = document.createElement('div');
    el.className = 'ed-block ed-block-tel' + (i === ed._selTelop ? ' sel' : '');
    el.style.top = top + 'px'; el.style.height = hh + 'px'; el.dataset.i = i;
    el.innerHTML =
      '<div class="ed-grip ed-grip-top"></div>' +
      '<button type="button" class="ed-block-del" tabindex="-1">✕</button>' +
      '<span class="ed-blk-dots" title="ドラッグで移動"></span>' +
      '<div class="ed-block-body"><textarea class="ed-block-text" rows="1" placeholder="字幕">' + esc(tp.text || '') + '</textarea></div>' +
      '<div class="ed-grip ed-grip-bot"></div>';
    if (hh < 22) el.querySelectorAll('.ed-grip').forEach(gp => gp.style.height = Math.max(4, hh * 0.3) + 'px');
    edWireTelopBlock(ed, el, i);
    lane.appendChild(el);
  });
  edSyncMsel(ed);
}
function edWireTelopBlock(ed, el, i) {
  let mode = null, startY = 0, t0s = 0, t0e = 0, snap0 = null, pushed = false, group = null;
  const topG = el.querySelector('.ed-grip-top'), botG = el.querySelector('.ed-grip-bot');
  const ta = el.querySelector('.ed-block-text');
  topG.addEventListener('pointerenter', e => edTip(e, 'ドラッグで開始時刻を変更'));
  topG.addEventListener('pointerleave', edTipHide);
  botG.addEventListener('pointerenter', e => edTip(e, 'ドラッグで終了時刻を変更'));
  botG.addEventListener('pointerleave', edTipHide);
  el.addEventListener('pointerdown', e => {
    if (e.target.classList.contains('ed-block-text') || e.target.classList.contains('ed-block-del')) return;
    if (e.shiftKey) {   // Shift+クリック＝複数選択のトグル（ドラッグは開始しない）
      edToggleMselTelop(ed, i);
      e.preventDefault(); e.stopPropagation();
      return;
    }
    const tp0 = ed._telops[i];
    if (!(ed._selSet && ed._selSet.has(tp0))) ed._selSet = null;   // 選択外を普通にクリック＝複数選択解除
    edSyncMsel(ed);
    edSelectTelop(ed, i);
    mode = e.target.classList.contains('ed-grip-top') ? 'top' : e.target.classList.contains('ed-grip-bot') ? 'bot' : 'move';
    const tp = ed._telops[i]; t0s = tp.start; t0e = tp.end; startY = e.clientY;
    snap0 = edSnapState(ed); pushed = false;   // ドラッグ前の状態（実際に動いたらUndoへ積む）
    // 複数選択中のブロックを移動 → 選択全体をまとめて動かす
    group = (mode === 'move' && ed._selSet && ed._selSet.has(tp))
      ? Array.from(ed._selSet).map(m => ({ m, s: m.start, e: m.end, i: ed._telops.indexOf(m) })) : null;
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault(); e.stopPropagation();
  });
  el.addEventListener('pointermove', e => {
    if (!mode) return;
    const tp = ed._telops[i]; if (!tp) return;
    let dt = edSnap((e.clientY - startY) / ED_PX);
    if (!pushed && dt !== 0) { pushed = true; edPushUndoSnap(ed, snap0); ed._undoTag = null; }
    if (group) {
      // グループ移動: 全員が 0〜dur に収まる範囲に dt を制限
      const dur = ed._dur || 0;
      let lo = -Infinity, hi = Infinity;
      group.forEach(g => { lo = Math.max(lo, -g.s); hi = Math.min(hi, dur - g.e); });
      dt = edClamp(dt, lo, hi);
      group.forEach(g => {
        g.m.start = +(g.s + dt).toFixed(2); g.m.end = +(g.e + dt).toFixed(2);
        const bl = ed.querySelector('.ed-tl-tel .ed-block[data-i="' + g.i + '"]');
        if (bl) { bl.style.top = edT2y(g.m.start) + 'px'; bl.style.height = Math.max(ED_MIN_PX, edT2y(g.m.end) - edT2y(g.m.start)) + 'px'; }
      });
      edSeekVideo(ed, tp.start);
      edRenderSelTelop(ed);
      return;
    }
    if (mode === 'move') {
      const len = t0e - t0s;
      let s = edClamp(t0s + dt, 0, (ed._dur || 0) - len);
      const ms = edMagnetT(ed, s, { skipTelop: i });               // 開始端を吸着
      if (ms !== s && ms <= (ed._dur || 0) - len) s = ms;
      else { const me = edMagnetT(ed, s + len, { skipTelop: i }); if (me !== s + len && me - len >= 0) s = me - len; }   // 終了端を吸着
      tp.start = +s.toFixed(2); tp.end = +(s + len).toFixed(2);
    }
    else if (mode === 'top') { tp.start = +edMagnetT(ed, edClamp(t0s + dt, 0, tp.end - ED_MIN_DUR), { skipTelop: i }).toFixed(2); }
    else { tp.end = +edMagnetT(ed, edClamp(t0e + dt, tp.start + ED_MIN_DUR, ed._dur || 0), { skipTelop: i }).toFixed(2); }
    el.style.top = edT2y(tp.start) + 'px';
    el.style.height = Math.max(ED_MIN_PX, edT2y(tp.end) - edT2y(tp.start)) + 'px';
    edSeekVideo(ed, mode === 'bot' ? tp.end : tp.start);
    edRenderSelTelop(ed);
  });
  const up = e => { if (!mode) return; mode = null; group = null; try { el.releasePointerCapture(e.pointerId); } catch (_) {} renderPreviewTelops(ed); updateEditorPreview(ed); };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  ta.addEventListener('input', () => { if (ed._telops[i]) { edPushUndo(ed, 'ttext' + i); ed._telops[i].text = ta.value; renderPreviewTelops(ed); } });
  ta.addEventListener('pointerdown', e => e.stopPropagation());
  ta.addEventListener('focus', () => edSelectTelop(ed, i));
  el.querySelector('.ed-block-del').addEventListener('click', e => {
    e.stopPropagation();
    edPushUndo(ed);
    ed._telops.splice(i, 1);
    if (ed._selTelop === i) ed._selTelop = -1;
    else if (ed._selTelop > i) ed._selTelop--;   // splice で下の index がずれるので選択も追従
    edRenderTelopBlocks(ed); edRenderSelTelop(ed); renderPreviewTelops(ed); updateEditorPreview(ed);
  });
}
function edSelectTelop(ed, i) {
  ed._selTelop = i; ed._selSfx = null; ed._selImg = null;
  ed.querySelectorAll('.ed-tl-tel .ed-block').forEach(n => n.classList.toggle('sel', +n.dataset.i === i));
  ed.querySelectorAll('.ed-tl-sfx .ed-block, .ed-tl-img .ed-block').forEach(n => n.classList.remove('sel'));
  edRenderSelImg(ed);
  const tp = ed._telops[i];
  if (tp) {
    edSeekVideo(ed, tp.start);
    // seeking イベントの再描画(アニメ無し)後に再生したいので次フレームへ遅延
    requestAnimationFrame(() => { if (ed._selTelop === i) renderPreviewTelops(ed, true); });
  }
  edRenderSelTelop(ed); edRenderSelSfx(ed);
}
function edAddTelopAt(ed, t) {
  const s = edSnap(edClamp(t, 0, (ed._dur || 0) - ED_MIN_DUR));
  const len = Math.min(1.5, Math.max(ED_MIN_DUR, (ed._dur || 0) - s));
  const nt = { start: +s.toFixed(2), end: +(s + len).toFixed(2), text: '', style: '', emphasis: false, animation: '', layer: 0, pos: null };
  edPushUndo(ed);
  ed._telops.push(nt);
  ed._telops.sort((a, b) => a.start - b.start);
  ed._selTelop = ed._telops.indexOf(nt);   // 同じ開始時刻の既存と取り違えないよう参照で選択
  edRenderTelopBlocks(ed); edRenderSelTelop(ed); renderPreviewTelops(ed);
  const inp = ed.querySelector('.ed-tl-tel .ed-block[data-i="' + ed._selTelop + '"] .ed-block-text');
  if (inp) inp.focus();
}
function edRenderSelTelop(ed) {
  const panel = ed.querySelector('.ed-sel-tel'); if (!panel) return;
  const tp = (ed._telops || [])[ed._selTelop];
  if (!tp) { panel.hidden = true; panel.innerHTML = ''; return; }
  panel.hidden = false;
  const pv = ed._pv || {};
  const defSz = +((ed.querySelector('.ed-capsz') || {}).value) || 74;
  const defSpd = Math.round(+((ed.querySelector('.ed-aspd') || {}).value) || 100);
  const nMulti = (ed._selSet && ed._selSet.size > 1 && ed._selSet.has(tp)) ? ed._selSet.size : 0;
  panel.innerHTML =
    '<span class="ed-sel-cap">選択中の字幕' +
      (nMulti ? '<b class="ed-msel-note">（' + nMulti + '個選択中：スタイル・アニメの変更は選択した全部に適用されます）</b>' : '') + '</span>' +
    '<label>開始<input class="ed-t-s" type="number" step="0.1" min="0" value="' + (+tp.start).toFixed(1) + '"></label>' +
    '<label>終了<input class="ed-t-e" type="number" step="0.1" min="0" value="' + (+tp.end).toFixed(1) + '"></label>' +
    '<label>アニメ<select class="ed-t-anim">' + optionsHtml(TANIM_OPTS, tp.animation || '') + '</select></label>' +
    '<label title="この字幕だけの入退場アニメ速度（%・空欄＝クリップ既定）">速度<input class="ed-t-aspd" type="number" min="25" max="300" step="5" placeholder="' + defSpd + '" value="' + (tp.anim_speed ? Math.round(tp.anim_speed * 100) : '') + '">%</label>' +
    '<label>層<input class="ed-t-layer" type="number" min="0" max="9" value="' + (tp.layer || 0) + '"></label>' +
    '<label class="ed-flag"><input type="checkbox" class="ed-emph-cb"' + (tp.emphasis ? ' checked' : '') + '>強調</label>' +
    '<label class="ed-flag"><input type="checkbox" class="ed-alert-cb"' + (tp.style === 'alert' ? ' checked' : '') + '>ｱﾗｰﾄ</label>' +
    '<label class="ed-flag" title="チャット風の白ボックス＋アバターで表示"><input type="checkbox" class="ed-cmt-cb"' + (tp.style === 'comment' ? ' checked' : '') + '>💬ｺﾒﾝﾄ風</label>' +
    // ── このテロップだけのスタイル（未指定はクリップ既定に従う）──
    '<span class="ed-t-stybreak"></span>' +
    '<span class="ed-t-stylbl">🎨 この字幕だけのスタイル</span>' +
    '<label title="この字幕だけの文字色">文字色<input class="ed-t-color" type="color" value="' + (tp.color || pv.sub || '#FFFFFF') + '"></label>' +
    '<label title="この字幕だけの縁取り色">縁取り<input class="ed-t-outc" type="color" value="' + (tp.outline_color || pv.out || '#000000') + '"></label>' +
    '<label title="この字幕だけのフォント">フォント<select class="ed-t-font">' + _tFontOpts(tp.font) + '</select></label>' +
    '<label title="この字幕だけの文字サイズ（空欄＝クリップ既定）">サイズ<input class="ed-t-size" type="number" min="24" max="200" step="2" placeholder="' + defSz + '" value="' + (tp.size || '') + '"></label>' +
    '<label title="この字幕だけの折返し幅（%・空欄＝クリップ既定。広げると自動改行が減ります）">幅<input class="ed-t-width" type="number" min="35" max="95" step="1" placeholder="' + Math.round(+((ed.querySelector('.ed-capw') || {}).value) || 66) + '" value="' + (tp.width ? Math.round(tp.width * 100) : '') + '">%</label>' +
    '<label title="この字幕だけの文字エフェクト">エフェクト<select class="ed-t-eff">' + optionsHtml(TEFFECT_OPTS, tp.effect || '') + '</select></label>' +
    '<button type="button" class="mini-btn ed-t-styreset" title="この字幕の色・フォント・サイズ・エフェクトを既定に戻す">↺ 既定に戻す</button>';
  // フォントセレクト自体を選択中フォントで表示（閉じていても見た目が分かる）
  const fsel = panel.querySelector('.ed-t-font');
  if (fsel) fsel.style.fontFamily = tp.font ? `'${tp.font}', sans-serif` : '';
  // アニメ/エフェクトは「見た目つきピッカー」で選ぶ（フォントと同じ思想）
  fxPickerify(panel.querySelector('.ed-t-anim'), 'anim');
  fxPickerify(panel.querySelector('.ed-t-eff'), 'effect');
}
function edWireSelTelop(ed) {
  const panel = ed.querySelector('.ed-sel-tel'); if (!panel || panel.dataset.wired) return;
  panel.dataset.wired = '1';
  // 複数選択中（Shift+クリック）はスタイル・アニメ変更を選択した全テロップへ適用する
  const targets = tp => (ed._selSet && ed._selSet.size > 1 && ed._selSet.has(tp))
    ? Array.from(ed._selSet) : [tp];
  panel.addEventListener('input', e => {
    const tp = (ed._telops || [])[ed._selTelop]; if (!tp) return;
    if (e.target.classList.contains('ed-t-s')) {
      edPushUndo(ed, 'tsel-s');
      tp.start = edClamp(+e.target.value || 0, 0, ed._dur || 0);
      if (tp.start > tp.end - ED_MIN_DUR) tp.end = Math.min(ed._dur || 0, tp.start + ED_MIN_DUR);
      edRenderTelopBlocks(ed); renderPreviewTelops(ed);
    }
    else if (e.target.classList.contains('ed-t-e')) {
      edPushUndo(ed, 'tsel-e');
      tp.end = edClamp(+e.target.value || 0, ED_MIN_DUR, ed._dur || 0);
      if (tp.end < tp.start + ED_MIN_DUR) tp.start = Math.max(0, tp.end - ED_MIN_DUR);
      edRenderTelopBlocks(ed); renderPreviewTelops(ed);
    }
    else if (e.target.classList.contains('ed-t-layer')) { edPushUndo(ed, 'tsel-l'); tp.layer = Math.max(0, Math.min(9, +e.target.value || 0)); renderPreviewTelops(ed); }
    else if (e.target.classList.contains('ed-t-color')) { edPushUndo(ed, 'tsel-c'); targets(tp).forEach(t => { t.color = e.target.value; }); renderPreviewTelops(ed); }
    else if (e.target.classList.contains('ed-t-outc')) { edPushUndo(ed, 'tsel-oc'); targets(tp).forEach(t => { t.outline_color = e.target.value; }); renderPreviewTelops(ed); }
    else if (e.target.classList.contains('ed-t-size')) {
      edPushUndo(ed, 'tsel-sz');
      const v = +e.target.value || 0;
      targets(tp).forEach(t => { t.size = v > 0 ? Math.min(200, v) : 0; });   // 0=クリップ既定（描画側で下限24にクランプ）
      renderPreviewTelops(ed);
    }
    else if (e.target.classList.contains('ed-t-width')) {
      edPushUndo(ed, 'tsel-w');
      const v = +e.target.value || 0;
      targets(tp).forEach(t => { t.width = v > 0 ? Math.min(0.95, v / 100) : 0; });   // 0=クリップ既定（描画側で下限0.35にクランプ）
      renderPreviewTelops(ed);
    }
    else if (e.target.classList.contains('ed-t-aspd')) {
      edPushUndo(ed, 'tsel-as');
      const v = +e.target.value || 0;
      targets(tp).forEach(t => { t.anim_speed = v > 0 ? Math.max(0.25, Math.min(3, v / 100)) : 0; });
      renderPreviewTelops(ed, true);
    }
  });
  panel.addEventListener('change', e => {
    const tp = (ed._telops || [])[ed._selTelop]; if (!tp) return;
    if (e.target.classList.contains('ed-emph-cb')) { edPushUndo(ed); targets(tp).forEach(t => { t.emphasis = e.target.checked; }); renderPreviewTelops(ed); }
    else if (e.target.classList.contains('ed-alert-cb')) { edPushUndo(ed); targets(tp).forEach(t => { t.style = e.target.checked ? 'alert' : (t.style === 'alert' ? '' : t.style); }); renderPreviewTelops(ed); }
    else if (e.target.classList.contains('ed-cmt-cb')) { edPushUndo(ed); targets(tp).forEach(t => { t.style = e.target.checked ? 'comment' : (t.style === 'comment' ? '' : t.style); }); renderPreviewTelops(ed); }
    else if (e.target.classList.contains('ed-t-anim')) { edPushUndo(ed); targets(tp).forEach(t => { t.animation = e.target.value; }); renderPreviewTelops(ed, true); }
    else if (e.target.classList.contains('ed-t-font')) {
      edPushUndo(ed); targets(tp).forEach(t => { t.font = e.target.value; });
      e.target.style.fontFamily = tp.font ? `'${tp.font}', sans-serif` : '';
      renderPreviewTelops(ed);
    }
    else if (e.target.classList.contains('ed-t-eff')) { edPushUndo(ed); targets(tp).forEach(t => { t.effect = e.target.value; }); renderPreviewTelops(ed); }
  });
  panel.addEventListener('click', e => {
    if (!e.target.classList.contains('ed-t-styreset')) return;
    const tp = (ed._telops || [])[ed._selTelop]; if (!tp) return;
    edPushUndo(ed);
    targets(tp).forEach(t => {
      t.color = ''; t.outline_color = ''; t.font = ''; t.size = 0; t.width = 0; t.effect = ''; t.anim_speed = 0;
    });
    edRenderSelTelop(ed); renderPreviewTelops(ed);
  });
}
// --- 効果音レーン ---
function edRenderSfxPalette(ed) {
  const pal = ed.querySelector('.ed-sfx-pal'); if (!pal) return;
  const list = Object.values(ed._sfxById || {});
  pal.innerHTML = '<span class="ed-pal-lbl">効果音を追加（再生位置に）:</span>' + list.map(s =>
    '<button type="button" class="sfx-chip" data-id="' + esc(s.id) + '">' + (s.emoji ? s.emoji + ' ' : '') + esc(s.label || s.id) +
    '<span class="sfx-dur">' + (+s.dur || 0).toFixed(1) + 's</span>' +
    (s.user ? '<span class="sfx-del" title="この効果音を一覧から削除">✕</span>' : '') + '</button>').join('') +
    '<button type="button" class="mini-btn ed-sfx-add-btn" title="MP3/WAV などの音声ファイルを効果音として追加します">＋効果音を追加</button>' +
    '<input type="file" class="ed-sfx-file" accept=".mp3,.wav,.m4a,.ogg,.aac" hidden>' +
    '<button type="button" class="mini-btn ed-sfx-sug-btn" title="字幕の内容から効果音を入れる場所をAIが提案します">🤖 AI提案</button>';
  pal.querySelectorAll('.sfx-chip').forEach(b => b.addEventListener('click', async e => {
    if (e.target.classList.contains('sfx-del')) {   // ユーザー効果音の削除
      e.stopPropagation();
      if (!confirm('この効果音を一覧から削除しますか？（すでに保存済みの動画には影響しません）')) return;
      try {
        const r = await fetch('/api/sfx/' + encodeURIComponent(b.dataset.id), { method: 'DELETE' });
        if (!r.ok) throw new Error(((await r.json()) || {}).detail || '削除に失敗しました');
        await _refreshSfxList(ed);
      } catch (err) { alert('エラー: ' + err.message); }
      return;
    }
    edAddSfxAtPlayhead(ed, b.dataset.id);
  }));
  const addBtn = pal.querySelector('.ed-sfx-add-btn'), sfi = pal.querySelector('.ed-sfx-file');
  if (addBtn && sfi) {
    addBtn.addEventListener('click', () => sfi.click());
    sfi.addEventListener('change', async () => {
      const f = sfi.files && sfi.files[0]; sfi.value = '';
      if (!f) return;
      const fd = new FormData();
      fd.append('audio', f);
      fd.append('label', f.name.replace(/\.[^.]+$/, '').slice(0, 20));
      addBtn.disabled = true; addBtn.textContent = 'アップロード中...';
      try {
        const r = await fetch('/api/sfx', { method: 'POST', body: fd });
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || '追加に失敗しました');
        await _refreshSfxList(ed);
      } catch (err) { alert('効果音の追加に失敗しました: ' + err.message); }
      addBtn.disabled = false; addBtn.textContent = '＋効果音を追加';
    });
  }
  const sug = pal.querySelector('.ed-sfx-sug-btn');
  if (sug) sug.addEventListener('click', () => edSuggestSfx(ed));
}
// 効果音一覧をサーバから取り直してパレット/ブロック表示を更新（追加・削除後）
async function _refreshSfxList(ed) {
  _sfxListCache = null;
  const _sl = await getSfxList();
  ed._sfxById = Object.fromEntries(_sl.map(s => [s.id, s]));
  edRenderSfxPalette(ed);
  edRenderSfxBlocks(ed);
}
// AI効果音サジェスト: テロップ内容から配置候補をもらい、チップのワンタップで採用
async function edSuggestSfx(ed) {
  const box = ed.querySelector('.ed-sfx-sug'); if (!box) return;
  box.hidden = false;
  box.innerHTML = '<span class="ed-pal-lbl">🤖 AIが効果音の場所を考えています...</span>';
  try {
    const r = await fetch('/api/clip/' + ed.dataset.job + '/' + ed.dataset.cid + '/sfx_suggest', { method: 'POST' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || '提案に失敗しました');
    const items = d.suggestions || [];
    if (!items.length) {
      box.innerHTML = '<span class="ed-pal-lbl">提案なし（効果音を足す場所が見つかりませんでした）</span>' +
        '<button type="button" class="mini-btn sug-close">閉じる</button>';
    } else {
      box.innerHTML = '<span class="ed-pal-lbl">🤖 AI提案（クリックでタイムラインに追加）:</span>' + items.map((s, i) => {
        const meta = (ed._sfxById || {})[s.id] || {};
        return '<button type="button" class="sfx-chip sug-chip" data-i="' + i + '" title="' + esc(s.reason || '') + '">' +
          (meta.emoji || '♪') + ' ' + esc(meta.label || s.id) + ' <span class="sfx-dur">@' + (+s.at).toFixed(1) + 's</span></button>';
      }).join('') + '<button type="button" class="mini-btn sug-close">閉じる</button>';
      box.querySelectorAll('.sug-chip').forEach(b => b.addEventListener('click', () => {
        const s = items[+b.dataset.i]; if (!s) return;
        edPushUndo(ed);
        const nb = { uid: 'b' + (_uidN++), id: s.id, at: +s.at, gain: 1 };
        (ed._sfx = ed._sfx || []).push(nb);
        edRenderSfxBlocks(ed); edSeekVideo(ed, +s.at); edSelectSfx(ed, nb.uid, true);
        b.disabled = true; b.classList.add('used');
      }));
    }
    const cl = box.querySelector('.sug-close');
    if (cl) cl.addEventListener('click', () => { box.hidden = true; });
  } catch (e) {
    box.innerHTML = '<span class="ed-pal-lbl">エラー: ' + esc(e.message) + '</span>';
  }
}


function edRenderSfxBlocks(ed) {
  const lane = ed.querySelector('.ed-tl-sfx'); if (!lane) return;
  lane.querySelectorAll('.ed-block').forEach(n => n.remove());
  (ed._sfx || []).forEach(b => {
    const meta = (ed._sfxById || {})[b.id] || {};
    const top = edT2y(b.at), hh = Math.max(ED_MIN_PX, edT2y(+meta.dur || 0.3));
    const el = document.createElement('div');
    el.className = 'ed-block ed-block-sfx' + (b.uid === ed._selSfx ? ' sel' : '');
    el.style.top = top + 'px'; el.style.height = hh + 'px'; el.dataset.uid = b.uid;
    el.innerHTML = '<span class="ed-sfx-emoji">' + (meta.emoji || '♪') + '</span>' +
      '<span class="ed-blk-dots" title="ドラッグで移動"></span>' +
      '<button type="button" class="ed-block-del" tabindex="-1">✕</button>';
    el.title = (meta.label || b.id) + ' @' + b.at.toFixed(2) + 's';
    edWireSfxBlock(ed, el, b);
    lane.appendChild(el);
  });
}
function edWireSfxBlock(ed, el, b) {
  let dragging = false, grabOff = 0, snap0 = null, pushed = false;
  el.querySelector('.ed-block-del').addEventListener('click', e => {
    e.stopPropagation();
    edPushUndo(ed);
    ed._sfx = (ed._sfx || []).filter(x => x.uid !== b.uid);
    if (ed._selSfx === b.uid) ed._selSfx = null;
    edRenderSfxBlocks(ed); edRenderSelSfx(ed);
  });
  el.addEventListener('pointerdown', e => {
    if (e.target.classList.contains('ed-block-del')) return;   // ✕ はドラッグしない
    edSelectSfx(ed, b.uid, true);
    const lane = ed.querySelector('.ed-tl-sfx'); const r = lane.getBoundingClientRect();
    grabOff = (e.clientY - r.top) - edT2y(b.at);
    dragging = true; snap0 = edSnapState(ed); pushed = false;
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault(); e.stopPropagation();
  });
  el.addEventListener('pointermove', e => {
    if (!dragging) return;
    const lane = ed.querySelector('.ed-tl-sfx'); const r = lane.getBoundingClientRect();
    const t = edMagnetT(ed, edSnap(edClamp(edY2t(ed, (e.clientY - r.top) - grabOff), 0, ed._dur || 0)), { skipSfx: b.uid });
    if (!pushed && Math.abs(t - b.at) > 1e-6) { pushed = true; edPushUndoSnap(ed, snap0); ed._undoTag = null; }
    b.at = +t.toFixed(3); el.style.top = edT2y(t) + 'px';
    el.title = (((ed._sfxById || {})[b.id] || {}).label || b.id) + ' @' + b.at.toFixed(2) + 's';
    edSeekVideo(ed, t);
  });
  const up = e => { if (!dragging) return; dragging = false; try { el.releasePointerCapture(e.pointerId); } catch (_) {} };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}
function edAddSfxAtPlayhead(ed, id) {
  const v = _clipVideo(ed); const at = edClamp(v ? (v.currentTime || 0) : 0, 0, ed._dur || 0);
  const b = { uid: 'b' + (_uidN++), id: id, at: +at.toFixed(3), gain: 1 };
  edPushUndo(ed);
  (ed._sfx = ed._sfx || []).push(b);
  edRenderSfxBlocks(ed); edSelectSfx(ed, b.uid, true);
}
function edSelectSfx(ed, uid, audition) {
  ed._selSfx = uid; ed._selTelop = -1; ed._selImg = null;
  ed.querySelectorAll('.ed-tl-sfx .ed-block').forEach(n => n.classList.toggle('sel', n.dataset.uid === uid));
  ed.querySelectorAll('.ed-tl-tel .ed-block, .ed-tl-img .ed-block').forEach(n => n.classList.remove('sel'));
  edRenderSelTelop(ed); edRenderSelSfx(ed); edRenderSelImg(ed);
  const b = (ed._sfx || []).find(x => x.uid === uid);
  if (b && audition) _auditionSfx((ed._sfxById || {})[b.id], b.gain);
}
function edRenderSelSfx(ed) {
  const panel = ed.querySelector('.ed-sel-sfx'); if (!panel) return;
  const b = (ed._sfx || []).find(x => x.uid === ed._selSfx);
  if (!b) { panel.hidden = true; panel.innerHTML = ''; return; }
  const meta = (ed._sfxById || {})[b.id] || {};
  panel.hidden = false;
  panel.innerHTML =
    '<span class="ed-sel-cap">効果音: ' + esc(meta.label || b.id) + '</span>' +
    '<label class="ed-sel-gain">音量 <b class="ed-sfx-gain-o">' + Math.round(b.gain * 100) + '%</b>' +
    '<input type="range" class="ed-sfx-gain" min="0" max="200" step="5" value="' + Math.round(b.gain * 100) + '"></label>' +
    '<button type="button" class="mini-btn ed-sfx-prev">▶ 試聴</button>' +
    '<button type="button" class="mini-btn ed-sfx-del">削除</button>';
  if (!panel.dataset.wired) {
    panel.dataset.wired = '1';
    panel.addEventListener('input', e => {
      const bb = (ed._sfx || []).find(x => x.uid === ed._selSfx); if (!bb) return;
      if (e.target.classList.contains('ed-sfx-gain')) { edPushUndo(ed, 'sgain' + bb.uid); bb.gain = (+e.target.value || 0) / 100; const o = panel.querySelector('.ed-sfx-gain-o'); if (o) o.textContent = e.target.value + '%'; }
    });
    panel.addEventListener('click', e => {
      const bb = (ed._sfx || []).find(x => x.uid === ed._selSfx); if (!bb) return;
      if (e.target.classList.contains('ed-sfx-prev')) { _auditionSfx((ed._sfxById || {})[bb.id], bb.gain); }
      else if (e.target.classList.contains('ed-sfx-del')) {
        edPushUndo(ed);
        ed._sfx = (ed._sfx || []).filter(x => x.uid !== bb.uid); ed._selSfx = null;
        edRenderSfxBlocks(ed); edRenderSelSfx(ed);
      }
    });
  }
}
// --- スクラブ / プレイヘッド / 追加 ---
function edSeekVideo(ed, t) {
  const v = _clipVideo(ed); let sought = false;
  if (v) { try { v.currentTime = Math.max(0, t + 0.02); sought = (v._edPreviewWired === true); } catch (_) {} }
  edPlayheadTo(ed, t);
  const r = _edTimeNode(ed); if (r) r.textContent = t.toFixed(1) + 's';
  if (!sought) renderPreviewTelops(ed);   // seeking イベント配線済みならそちらで描画（二重描画を防ぐ）
}
// 毎フレーム触るノードはキャッシュ（loadEditor で作り直されたら isConnected で検知して引き直す）
function _edTimeNode(ed) {
  let n = ed._tlTimeN; if (!n || !n.isConnected) n = ed._tlTimeN = ed.querySelector('.ed-tl-time');
  return n;
}
function edPlayheadTo(ed, t) {
  let p = ed._tlPhN; if (!p || !p.isConnected) p = ed._tlPhN = ed.querySelector('.ed-tl-playhead');
  if (p) p.style.top = edT2y(t) + 'px';
}
function edWireLaneScrub(ed) {
  ed.querySelectorAll('.ed-tl-tel, .ed-tl-sfx, .ed-tl-img').forEach(lane => {
    const isTel = lane.classList.contains('ed-tl-tel');
    let downY = null, moved = false;
    lane.addEventListener('pointerdown', e => {
      if (e.target.closest('.ed-block')) return;
      downY = e.clientY; moved = false;
      try { lane.setPointerCapture(e.pointerId); } catch (_) {}
    });
    lane.addEventListener('pointermove', e => {
      if (downY == null) return;
      if (Math.abs(e.clientY - downY) > 4) moved = true;
      if (moved) { const r = lane.getBoundingClientRect(); edSeekVideo(ed, edY2t(ed, e.clientY - r.top)); }
    });
    lane.addEventListener('pointerup', e => {
      if (downY == null) return;
      if (!moved && !e.target.closest('.ed-block')) {
        const r = lane.getBoundingClientRect(); const t = edY2t(ed, e.clientY - r.top);
        if (isTel) edAddTelopAt(ed, t); else edSeekVideo(ed, t);
      }
      downY = null; try { lane.releasePointerCapture(e.pointerId); } catch (_) {}
    });
  });
}
function edPlaySfxAt(ed, t) {
  // プレビュー再生中に「未保存の」効果音をその時刻で鳴らす（at を跨いだら再生）。
  // 保存済み(baked)は動画音声に焼き込み済み＝ここで鳴らすと二重になるので除外。
  const prev = ed._lastSfxT;
  ed._lastSfxT = t;
  if (prev == null || t < prev || t - prev > 0.5) return;   // 初回/巻戻し/シーク跳びは鳴らさない
  (ed._sfx || []).forEach(b => { if (!b.baked && b.at > prev && b.at <= t) _auditionSfx((ed._sfxById || {})[b.id], b.gain); });
}
function edFollowScroll(ed, t) {
  // 再生に合わせてタイムラインを自動スクロール。
  // 旧実装は「画面の25〜75%の帯」にプレイヘッドを収めて随時センタリングしていたため、
  // 赤線が画面中央の狭い範囲を往復して見えた。→ ページ送り方式に変更:
  // 赤線は可視域の上から下まで走りきり、下端を越えた時だけ次ページ（赤線=上端）へ切り替える。
  // clientHeight/scrollTop の読取りは強制リフローになるため 250ms に間引く（60fpsで毎回やるとカクつく）
  const now = performance.now();
  if (ed._followT != null && now - ed._followT < 250) return;
  ed._followT = now;
  let wrap = ed._tlWrapN; if (!wrap || !wrap.isConnected) wrap = ed._tlWrapN = ed.querySelector('.ed-tl-wrap');
  if (!wrap) return;
  const y = edT2y(t), view = wrap.clientHeight, top = wrap.scrollTop;
  if (y > top + view - 10 || y < top) {
    wrap.scrollTop = Math.max(0, y - 10);   // 赤線を上端付近に置いて次ページへ
  }
}
function edWirePlayheadSync(ed) {
  const v = _clipVideo(ed); if (!v || v._edTlWired) return; v._edTlWired = true;
  const place = () => {
    const e = document.getElementById('detailEditor'); if (!e || !e.dataset.loaded) return;
    const t = v.currentTime || 0;
    edPlayheadTo(e, t);
    const r = _edTimeNode(e); if (r) r.textContent = t.toFixed(1) + 's';
    if (!v.paused) {
      edFollowScroll(e, t); edPlaySfxAt(e, t);   // 再生中: 追従＋効果音をプレビュー再生
      // 画像チップは rAF（毎フレーム）で差分更新＝フェード/スライド/ズームが滑らかに動く
      const fr = _edFrame(e);
      if (fr && !e._chipDragging) renderPreviewImages(e, fr, t, !e._cleanPreview);
    }
    else e._lastSfxT = t;
  };
  v.addEventListener('timeupdate', place); v.addEventListener('seeking', () => { const e = document.getElementById('detailEditor'); if (e) e._lastSfxT = v.currentTime; place(); }); v.addEventListener('seeked', place);
  let raf = null; const tick = () => { if (!v.isConnected) { raf = null; return; } place(); raf = requestAnimationFrame(tick); };
  v.addEventListener('play', () => { if (!raf) tick(); });
  v.addEventListener('pause', () => { if (raf) { cancelAnimationFrame(raf); raf = null; } place(); });
  place();
}
// --- 選択中ブロックの削除/複製（Deleteキー・Ctrl+D） ---
function edDeleteSelection(ed) {
  if (ed._selSet && ed._selSet.size) {
    edPushUndo(ed);
    ed._telops = ed._telops.filter(tp => !ed._selSet.has(tp));
    ed._selSet = null; ed._selTelop = -1;
    edRenderTelopBlocks(ed); edRenderSelTelop(ed); renderPreviewTelops(ed); updateEditorPreview(ed);
    return true;
  }
  if (ed._selTelop >= 0 && (ed._telops || [])[ed._selTelop]) {
    edPushUndo(ed);
    ed._telops.splice(ed._selTelop, 1); ed._selTelop = -1;
    edRenderTelopBlocks(ed); edRenderSelTelop(ed); renderPreviewTelops(ed); updateEditorPreview(ed);
    return true;
  }
  if (ed._selSfx) {
    edPushUndo(ed);
    ed._sfx = (ed._sfx || []).filter(x => x.uid !== ed._selSfx); ed._selSfx = null;
    edRenderSfxBlocks(ed); edRenderSelSfx(ed);
    return true;
  }
  if (ed._selImg) {
    edPushUndo(ed);
    ed._images = (ed._images || []).filter(x => x.uid !== ed._selImg); ed._selImg = null;
    edRenderImgBlocks(ed); edRenderSelImg(ed); renderPreviewTelops(ed); edSyncImgCount(ed);
    return true;
  }
  return false;
}
function edDuplicateSelection(ed) {
  const dur = ed._dur || 0;
  const targets = (ed._selSet && ed._selSet.size) ? Array.from(ed._selSet)
    : ((ed._selTelop >= 0 && (ed._telops || [])[ed._selTelop]) ? [ed._telops[ed._selTelop]] : null);
  if (targets && targets.length) {
    edPushUndo(ed);
    let first = null;
    targets.forEach(tp => {
      const c = edClone([tp])[0];
      const len = Math.max(ED_MIN_DUR, c.end - c.start);
      c.start = +edClamp(tp.end, 0, dur - ED_MIN_DUR).toFixed(2);   // 元の直後に複製
      c.end = +edClamp(c.start + len, c.start + ED_MIN_DUR, dur).toFixed(2);
      ed._telops.push(c);
      if (!first) first = c;
    });
    ed._telops.sort((a, b) => a.start - b.start);
    ed._selSet = null; ed._selTelop = ed._telops.indexOf(first);
    edRenderTelopBlocks(ed); edRenderSelTelop(ed); renderPreviewTelops(ed);
    return true;
  }
  const b = (ed._sfx || []).find(x => x.uid === ed._selSfx);
  if (b) {
    edPushUndo(ed);
    const nb = { uid: 'b' + (_uidN++), id: b.id, at: +edClamp(b.at + 0.5, 0, dur).toFixed(3), gain: b.gain };
    ed._sfx.push(nb);
    edRenderSfxBlocks(ed); edSelectSfx(ed, nb.uid, false);
    return true;
  }
  return false;
}

// 詳細編集のキーボードショートカット
// Space=再生/停止 ／ ←→=0.1秒送り(Shiftで1秒) ／ Delete=選択削除 ／ Ctrl+Z/Y=Undo/Redo ／ Ctrl+D=複製
document.addEventListener('keydown', e => {
  const dt = document.getElementById('tab-detail');
  if (!dt || !dt.classList.contains('active')) return;
  const ae = document.activeElement;
  const typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable);
  const ed = document.getElementById('detailEditor');
  const loaded = ed && ed.dataset.loaded;
  const v = document.getElementById('detailVideo');
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && (e.code === 'KeyZ' || e.code === 'KeyY')) {
    if (typing || !loaded) return;   // 入力欄はブラウザ標準のUndoに任せる
    e.preventDefault();
    if (e.code === 'KeyY' || e.shiftKey) edRedo(ed); else edUndo(ed);
    return;
  }
  if (ctrl && e.code === 'KeyD') {
    if (typing || !loaded) return;
    if (edDuplicateSelection(ed)) e.preventDefault();
    return;
  }
  if (typing || ctrl) return;
  if (e.code === 'Space' || e.key === ' ') {
    if (!v) return;
    e.preventDefault();
    if (v.paused) v.play().catch(() => {}); else v.pause();
    return;
  }
  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    if (!v || !loaded) return;
    e.preventDefault();
    const step = (e.shiftKey ? 1 : 0.1) * (e.code === 'ArrowLeft' ? -1 : 1);
    edSeekVideo(ed, edClamp((v.currentTime || 0) + step, 0, ed._dur || v.duration || 0));
    return;
  }
  if (e.code === 'Delete') {
    if (!loaded) return;
    if (edDeleteSelection(ed)) e.preventDefault();
  }
});
// クリップ全体スタイル設定パネルの開閉（既定は閉＝選択中の字幕編集をメインに）
function edToggleClipStyle(btn) {
  const ed = btn.closest('.clip-editor'); if (!ed) return;
  const p = ed.querySelector('.ed-clipstyle'); if (!p) return;
  p.hidden = !p.hidden;
  btn.textContent = p.hidden ? '🎨 クリップ全体のスタイル設定 ▸' : '🎨 クリップ全体のスタイル設定 ▾';
  btn.classList.toggle('on', !p.hidden);
}

// タイムラインの高さを引き伸ばすバー（ドラッグで変更・prefs に保存＝次回も同じ高さ）
function edWireTlResize(ed) {
  const bar = ed.querySelector('.ed-tl-resize'); if (!bar || bar.dataset.wired) return;
  bar.dataset.wired = '1';
  const wrap = ed.querySelector('.ed-tl-wrap'); if (!wrap) return;
  let on = false, y0 = 0, h0 = 0;
  bar.addEventListener('pointerdown', e => {
    on = true; y0 = e.clientY; h0 = wrap.clientHeight;
    try { bar.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  });
  bar.addEventListener('pointermove', e => {
    if (!on) return;
    const h = Math.max(200, Math.min(1600, h0 + (e.clientY - y0)));
    wrap.style.maxHeight = 'none';
    wrap.style.height = h + 'px';
  });
  const up = e => {
    if (!on) return;
    on = false;
    try { bar.releasePointerCapture(e.pointerId); } catch (_) {}
    _prefs.tl_h = wrap.clientHeight;   // 高さを永続化（次回の詳細編集でも同じ高さ）
    savePrefs();
  };
  bar.addEventListener('pointerup', up);
  bar.addEventListener('pointercancel', up);
}

function edTlReset(btn) {
  const ed = btn.closest('.clip-editor'); if (!ed) return;
  edPushUndo(ed);   // 「初期に戻す」もCtrl+Zで取り消せる
  ed._selSet = null;
  ed._telops = edClone((ed._telopsOrig && ed._telopsOrig.length) ? ed._telopsOrig : ed._telopsPristine);
  ed._keeps = ed._keepsOrig ? ed._keepsOrig.map(k => [k[0], k[1]]) : null;   // 原状の残し区間
  ed._cuts = [];
  ed._dur = (ed._keeps && ed._keeps.length) ? ed._keeps.reduce((s, k) => s + (k[1] - k[0]), 0) : (ed._origDur || ed._dur);
  ed._selTelop = -1;
  edRenderTimeline(ed); edRenderSelTelop(ed); updateEditorPreview(ed); renderPreviewTelops(ed);
}

// ===== 部分カット（ハサミ） =====
function edRenderCuts(ed) {
  const tl = ed.querySelector('.ed-tl'); if (!tl) return;
  tl.querySelectorAll('.ed-cut').forEach(n => n.remove());
  (ed._cuts || []).forEach((c, i) => {
    const top = edT2y(c.start), hh = Math.max(10, edT2y(c.end) - edT2y(c.start));
    const el = document.createElement('div');
    el.className = 'ed-cut'; el.style.top = top + 'px'; el.style.height = hh + 'px'; el.dataset.i = i;
    el.innerHTML = '<div class="ed-cut-grip ed-cut-top"></div>' +
      '<span class="ed-cut-lbl">✂ カット</span>' +
      '<button type="button" class="ed-cut-del" tabindex="-1">✕</button>' +
      '<div class="ed-cut-grip ed-cut-bot"></div>';
    edWireCut(ed, el, i);
    tl.appendChild(el);
  });
}
function edWireCut(ed, el, i) {
  let mode = null, startY = 0, c0s = 0, c0e = 0;
  el.addEventListener('pointerdown', e => {
    if (e.target.classList.contains('ed-cut-del')) return;
    mode = e.target.classList.contains('ed-cut-top') ? 'top' : e.target.classList.contains('ed-cut-bot') ? 'bot' : 'move';
    const c = ed._cuts[i]; c0s = c.start; c0e = c.end; startY = e.clientY;
    el._snap0 = edSnapState(ed); el._pushed = false;
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault(); e.stopPropagation();
  });
  el.addEventListener('pointermove', e => {
    if (!mode) return;
    const c = ed._cuts[i]; if (!c) return;
    const dt = edSnap((e.clientY - startY) / ED_PX);
    if (!el._pushed && dt !== 0) { el._pushed = true; edPushUndoSnap(ed, el._snap0 || edSnapState(ed)); ed._undoTag = null; }
    if (mode === 'move') { const len = c0e - c0s; const s = edClamp(c0s + dt, 0, (ed._dur || 0) - len); c.start = +s.toFixed(2); c.end = +(s + len).toFixed(2); }
    else if (mode === 'top') { c.start = +edMagnetT(ed, edClamp(c0s + dt, 0, c.end - 0.2), { skipCut: i }).toFixed(2); }
    else { c.end = +edMagnetT(ed, edClamp(c0e + dt, c.start + 0.2, ed._dur || 0), { skipCut: i }).toFixed(2); }
    el.style.top = edT2y(c.start) + 'px'; el.style.height = Math.max(10, edT2y(c.end) - edT2y(c.start)) + 'px';
    edSeekVideo(ed, mode === 'bot' ? c.end : c.start);
  });
  const up = e => { if (!mode) return; mode = null; try { el.releasePointerCapture(e.pointerId); } catch (_) {} };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.querySelector('.ed-cut-del').addEventListener('click', e => { e.stopPropagation(); edPushUndo(ed); ed._cuts.splice(i, 1); edRenderCuts(ed); });
}
function edAddCut(btn) {
  const ed = btn.closest('.clip-editor'); if (!ed) return;
  const v = _clipVideo(ed);
  const s = edClamp(v ? (v.currentTime || 0) : 0, 0, Math.max(0, (ed._dur || 0) - 0.5));
  const len = Math.min(1.0, Math.max(0.3, (ed._dur || 0) - s));
  edPushUndo(ed);
  (ed._cuts = ed._cuts || []).push({ start: +s.toFixed(2), end: +(s + len).toFixed(2) });
  ed._cuts.sort((a, b) => a.start - b.start);
  edRenderCuts(ed);
}

// カット(表示時間)を反映: telop/sfx を圧縮再配置し、backend用 keeps(元時間)＋新尺を返す
function edApplyCuts(ed) {
  const cuts = (ed._cuts || []).filter(c => c.end > c.start + 0.01).sort((a, b) => a.start - b.start);
  const dispDur = ed._dur || 0;
  const dispKeeps = _invertRegions(cuts, dispDur);          // 表示時間の残し区間
  // 区間/点を残し区間へ再配置。カットをまたぐ字幕は「重なり最大の残し区間」に寄せる（丸ごと消さない）。
  // 効果音(点 start==end)は内包する残し区間に帰属。どの残し区間とも無関係（カット内）なら null。
  const compress = (start, end) => {
    let off = 0, best = null, bestScore = 0;
    for (const [a, b] of dispKeeps) {
      const lo = Math.max(a, start), hi = Math.min(b, end);
      const ov = hi - lo;
      const inside = (start >= a - 1e-6 && start <= b + 1e-6);
      const score = ov > 0 ? ov : (inside ? 1e-9 : -1);
      if (score > bestScore) {
        bestScore = score;
        const clo = Math.min(Math.max(start, a), b), chi = Math.min(Math.max(end, a), b);
        const ns = off + (clo - a), ne = off + (chi - a);
        best = { start: +ns.toFixed(3), end: +Math.max(ns + 0.05, ne).toFixed(3) };
      }
      off += b - a;
    }
    return best;
  };
  const telops = [];
  (ed._telops || []).forEach(tp => { const r = compress(tp.start, tp.end); if (r) telops.push(Object.assign({}, tp, { start: r.start, end: r.end })); });
  const sfx = [];
  (ed._sfx || []).forEach(b => { const r = compress(b.at, b.at); if (r) sfx.push({ id: b.id, at: r.start, gain: b.gain }); });
  const images = [];
  (ed._images || []).forEach(im => { const r = compress(im.start, im.end); if (r) images.push(Object.assign({}, im, { start: r.start, end: r.end })); });
  const keeps = _dispKeepsToOrig(dispKeeps, ed._keeps, ed._origDur || dispDur);
  const removed = dispDur - dispKeeps.reduce((s, k) => s + (k[1] - k[0]), 0);
  const clip_duration = +dispKeeps.reduce((s, k) => s + (k[1] - k[0]), 0).toFixed(3);
  return { telops, sfx, images, keeps, clip_duration, removed: +removed.toFixed(3) };
}
function _invertRegions(cuts, dur) {   // カット区間の補集合（残す区間）[0,dur]
  const keeps = []; let pos = 0;
  for (const c of cuts) {
    const a = Math.max(0, c.start), b = Math.min(dur, c.end);
    if (a > pos + 0.01) keeps.push([+pos.toFixed(3), +a.toFixed(3)]);
    pos = Math.max(pos, b);
  }
  if (dur > pos + 0.01) keeps.push([+pos.toFixed(3), +dur.toFixed(3)]);
  return keeps.length ? keeps : [[0, dur]];
}
function _dispKeepsToOrig(dispKeeps, curKeeps, origDur) {   // 表示時間keeps→元時間keeps（現keepsと合成）
  const base = (curKeeps && curKeeps.length) ? curKeeps.map(k => [k[0], k[1]]) : [[0, origDur || 0]];
  const out = [];
  for (const [da, db] of dispKeeps) {
    let off = 0;
    for (const [a, b] of base) {
      const seg = b - a, segStart = off, segEnd = off + seg;
      const lo = Math.max(da, segStart), hi = Math.min(db, segEnd);
      if (hi > lo + 1e-6) out.push([+(a + (lo - off)).toFixed(3), +(a + (hi - off)).toFixed(3)]);
      off += seg;
    }
  }
  return out.length ? out : base;
}
function _editorSfx(ed) {
  return (ed._sfx || []).map(b => ({ id: b.id, at: +(+b.at).toFixed(3), gain: +(+b.gain).toFixed(3) }));
}
function edBulkAnim(sel) {
  const ed = sel.closest('.clip-editor'); const v = sel.value; sel.value = '';
  if (v === '_skip_') return;
  (ed._telops || []).forEach(tp => { tp.animation = v; });
  renderPreviewTelops(ed, true);
}

// 装飾（色・影・キラキラ層）。アニメは再生しない＝色変更等の頻繁な再描画でチラつかせない。
function applyPreviewEffect() {
  const e = _effSel();
  ['pvTitle', 'pvCap'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    _pvApplyEff(el, e);
  });
  renderSparkleLayer(e === 'sparkle');
}

// 出現アニメ（とホラーの揺れ）を再生し直す。アニメ/エフェクト選択の変更時と「▶再生」で呼ぶ。
function applyPreviewFx() {
  applyPreviewEffect();
  const a = _animSel(), e = _effSel();
  const cfg = PV_ANIM[a] || PV_ANIM.default;
  ['pvTitle', 'pvCap'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.animation = 'none';
    void el.offsetWidth;   // リフローでアニメをリスタート
    if (e === 'horror') {
      el.style.animation = 'pvShake .45s linear infinite';   // ホラーは揺れを優先
    } else if (cfg.name) {
      el.style.animation = `${cfg.name} ${cfg.dur}s ease-out ${cfg.iter || '1'} both`;
    }
  });
}

function renderSparkleLayer(on) {
  const stage = document.getElementById('previewStage');
  if (!stage) return;
  let layer = document.getElementById('pvSparkle');
  if (!on) { if (layer) layer.remove(); return; }
  if (layer) return;
  layer = document.createElement('div');
  layer.id = 'pvSparkle';
  const pts = [[14, 18], [82, 16], [30, 10], [68, 24], [50, 8], [22, 40], [80, 44]];
  pts.forEach((p, i) => {
    const s = document.createElement('span');
    s.className = 'pv-spark';
    s.textContent = '✦';
    s.style.left = p[0] + '%'; s.style.top = p[1] + '%';
    s.style.animationDelay = (i * 0.22).toFixed(2) + 's';
    layer.appendChild(s);
  });
  stage.appendChild(layer);
}
function hexToRgba(hex, a) {
  const h = String(hex || '#000000').replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) || 0, gg = parseInt(h.slice(2, 4), 16) || 0, b = parseInt(h.slice(4, 6), 16) || 0;
  return `rgba(${r},${gg},${b},${a})`;
}
// 既存の呼び出し名は updatePreview に集約
function updatePreviewColors() { updatePreview(); }

document.querySelectorAll('.color-item input[type=color]').forEach(inp => {
  _lastColorInput = _lastColorInput || inp;
  inp.addEventListener('focus', () => { _lastColorInput = inp; });
  inp.addEventListener('input', () => { _lastColorInput = inp; updatePreviewColors(); });
});

async function initFonts() {
  try {
    const fonts = await (await fetch('/api/fonts')).json();
    window._fontList = fonts;   // テロップ個別フォント選択（詳細編集）でも使う
    const sel = document.getElementById('fontSelect');
    const groups = { simple: 'シンプル・定番', cute: 'かわいい系', impact: 'インパクト' };
    const byCat = {};
    fonts.forEach(f => { (byCat[f.category] = byCat[f.category] || []).push(f); });
    let css = '';
    Object.keys(groups).forEach(cat => {
      if (!byCat[cat]) return;
      const og = document.createElement('optgroup');
      og.label = groups[cat];
      byCat[cat].forEach(f => {
        const o = document.createElement('option');
        o.value = f.family; o.textContent = f.label;
        o.style.fontFamily = `'${f.family}', sans-serif`;   // 一覧の各行をそのフォントで表示
        og.appendChild(o);
        if (f.bundled && f.file) {
          css += `@font-face{font-family:'${f.family}';src:url('/fonts/${encodeURIComponent(f.file)}');font-display:swap;}`;
        }
      });
      sel.appendChild(og);
    });
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    // セレクト自体も選択中のフォントで表示（閉じた状態でも見た目が分かる）
    const syncSelFont = () => { sel.style.fontFamily = sel.value ? `'${sel.value}', sans-serif` : ''; };
    sel.addEventListener('change', () => { syncSelFont(); updateFontPreview(); });
    restoreLastStyle();   // 前回のフォント/色/サイズ/縁取りを復元（options 構築後）
    syncSelFont();
    updateFontPreview();
  } catch (e) { console.error('fonts load failed', e); }
}

function updateFontPreview() { updatePreview(); }

const DEFAULT_PALETTE = ['#FFFFFF','#000000','#27E36B','#FFE600','#FF2D55','#25F4EE','#FF7AB6','#7C4DFF'];
function loadPalette() { return (_prefs.palette && _prefs.palette.length) ? _prefs.palette : DEFAULT_PALETTE.slice(); }
function savePalette(p) { _prefs.palette = p; savePrefs(); }
function renderPalette() {
  const wrap = document.getElementById('palette');
  wrap.innerHTML = '';
  loadPalette().forEach((c, i) => {
    const sw = document.createElement('div');
    sw.className = 'swatch'; sw.style.background = c; sw.title = c;
    sw.onclick = () => {
      const t = _lastColorInput || document.getElementById('cSub');
      t.value = c; updatePreviewColors();
    };
    const x = document.createElement('span');
    x.className = 'sw-x'; x.textContent = '×';
    x.onclick = (e) => { e.stopPropagation(); const p = loadPalette(); p.splice(i, 1); savePalette(p); renderPalette(); };
    sw.appendChild(x); wrap.appendChild(sw);
  });
}
function addPreset() {
  const c = (_lastColorInput || document.getElementById('cSub')).value.toUpperCase();
  const p = loadPalette();
  if (!p.includes(c)) { p.push(c); savePalette(p); renderPalette(); }
}

// ===== ジャンル選択（複数） =====
async function initGenres() {
  try {
    const genres = await (await fetch('/api/genres')).json();
    const box = document.getElementById('genreBox');
    box.innerHTML = '';
    genres.forEach(g => {
      const lab = document.createElement('label');
      lab.className = 'genre-chip';
      lab.innerHTML = '<input type="checkbox" value="' + esc(g.id) + '">' +
        (g.emoji ? g.emoji + ' ' : '') + esc(g.label);
      const cb = lab.querySelector('input');
      cb.addEventListener('change', () => lab.classList.toggle('on', cb.checked));
      box.appendChild(lab);
    });
  } catch (e) { console.error('genres load failed', e); }
}
function selectedGenres() {
  return Array.from(document.querySelectorAll('#genreBox input:checked')).map(i => i.value);
}

function onReframeChange() {
  const f = document.getElementById('lbColorField');
  if (f) f.style.display = (document.getElementById('reframe').value === 'letterbox') ? 'flex' : 'none';
}

let createMode = 'auto';
function switchCreateMode(mode) {
  createMode = mode;
  document.querySelectorAll('.mode-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
  document.getElementById('autoMode').hidden = (mode !== 'auto');
  document.getElementById('promptMode').hidden = (mode !== 'prompt');
}

// ===== 情報ページ（について／使用方法／利用規約／プライバシーポリシー） =====
const INFO = {
  about: {
    title: 'TikTok-Cut について',
    html:
      '<p>TikTok-Cut は、YouTube 等の配信アーカイブから <b>TikTok 向けの縦型ショート切り抜き</b>を自動生成するデスクトップアプリです。</p>' +
      '<p>文字起こし（音声→字幕）・面白いシーンの選定・縦型(9:16)への変換・字幕やタイトルの焼き込みまでを、あなたの PC 内で実行します。動画ファイルが外部に送られることはありません。</p>' +
      '<ul><li>文字起こし: ローカルAI（faster-whisper）</li>' +
      '<li>シーン選定・字幕補正: Google Gemini（送るのは文字起こしテキストのみ）</li>' +
      '<li>動画処理: ffmpeg（同梱）</li></ul>' +
      '<p class="info-note">本アプリは TikTok / YouTube / Google の公式・提携サービスではありません。</p>',
  },
  usage: {
    title: '使用方法',
    html:
      '<ol>' +
      '<li>切り抜きたい配信動画（mp4 等）をお手元にダウンロードしておきます。</li>' +
      '<li>「動画を選択」で動画ファイルを指定します（アップロードはしません）。</li>' +
      '<li>「おまかせ」でジャンルを選ぶか、「プロンプト入力」で指示を文章で書きます。</li>' +
      '<li>生成本数・画面構成・冒頭の演出・フォント・色・文字サイズ・縁取り・ウォーターマーク等を必要に応じて設定します。</li>' +
      '<li>「作成開始」を押すと、文字起こし→選定→字幕焼き込みが順に進みます。</li>' +
      '<li>「結果」タブでプレビュー。各クリップは「字幕を編集」から、文字修正・表示位置・サイズ・縁取り・時間の延長・AIへの追加指示で調整し、そのクリップだけ作り直せます。</li>' +
      '<li>「ダウンロード」で mp4 を保存します。</li>' +
      '</ol>' +
      '<p class="info-note">AI機能（Gemini）を使うには ⚙設定 で API キーを登録してください（未設定でも簡易選定で動作します）。</p>',
  },
  terms: {
    title: '利用規約',
    html:
      '<p>本利用規約（以下「本規約」）は、本アプリ TikTok-Cut（以下「本アプリ」）の利用条件を定めます。本アプリを利用した時点で本規約に同意したものとみなします。</p>' +
      '<ol>' +
      '<li><b>入力動画の権利</b>: 利用者は、入力する動画について必要な権利（著作権・利用許諾等）を自ら確認・取得する責任を負います。第三者の権利を侵害する利用は行わないものとします。</li>' +
      '<li><b>生成物</b>: 本アプリで生成したクリップの利用（商用含む）は利用者の自由です。ただし入力素材に起因する権利関係は利用者の責任とします。</li>' +
      '<li><b>禁止事項</b>: 法令違反、第三者の権利侵害、公序良俗に反する利用を禁止します。</li>' +
      '<li><b>非保証</b>: 本アプリは現状有姿で提供され、文字起こしや選定の正確性・特定目的への適合性を保証しません。</li>' +
      '<li><b>免責</b>: 本アプリの利用により生じた損害について、開発者は責任を負いません。</li>' +
      '<li><b>第三者サービス</b>: 本アプリは Google Gemini API 等の外部サービスを利用し、各サービスの規約も併せて適用されます。本アプリは TikTok / YouTube / Google の公式・提携サービスではありません。</li>' +
      '<li><b>変更</b>: 本規約は予告なく変更されることがあります。</li>' +
      '</ol>',
  },
  privacy: {
    title: 'プライバシーポリシー',
    html:
      '<p>本アプリ TikTok-Cut におけるデータの取り扱いについて説明します。</p>' +
      '<ol>' +
      '<li><b>動画・音声</b>: 入力した動画および音声は<b>あなたの PC 内でのみ処理</b>され、外部に送信・アップロードされません。文字起こしはローカルAI（faster-whisper）で行います。</li>' +
      '<li><b>AIに送る情報</b>: シーン選定・字幕補正のために、<b>文字起こしテキスト</b>（および任意で入力した配信タイトル等）のみを Google Gemini API に送信します。動画・音声・画像は送信しません。</li>' +
      '<li><b>APIキー</b>: あなたの Gemini API キーは OS の暗号化機構で暗号化し、この PC 内にのみ保存します。</li>' +
      '<li><b>生成物・設定</b>: 生成したクリップや設定はあなたの PC 内に保存されます。</li>' +
      '<li><b>解析・追跡なし</b>: 本アプリは利用状況の収集・トラッキングを行いません。</li>' +
      '<li><b>外部サービス</b>: 送信先である Google Gemini API のデータ取り扱いは Google のポリシーに従います（学習に使われない設定の利用を推奨）。</li>' +
      '</ol>',
  },
};
function showInfo(key) {
  const d = INFO[key];
  if (!d) return;
  document.getElementById('infoTitle').textContent = d.title;
  document.getElementById('infoBody').innerHTML = d.html;
  document.getElementById('infoModal').hidden = false;
}
function closeInfo() { document.getElementById('infoModal').hidden = true; }

// ===== サイズ・縁取りスライダー =====
const SLIDER_OUT = [['capSize', 'capSizeOut'], ['capOutline', 'capOutOut'],
                    ['titleSize', 'titleSizeOut'], ['titleOutline', 'titleOutOut'],
                    ['boxPad', 'boxPadOut'],
                    ['shadowD', 'shadowDOut'], ['shadowA', 'shadowAOut'], ['shadowB', 'shadowBOut']];
function syncSliderLabels() {
  SLIDER_OUT.forEach(([i, o]) => {
    const el = document.getElementById(o), inp = document.getElementById(i);
    if (el && inp) el.textContent = inp.value;
  });
}
function initSliders() {
  SLIDER_OUT.forEach(([i]) => {
    const inp = document.getElementById(i);
    if (inp) inp.addEventListener('input', () => { syncSliderLabels(); updateFontPreview(); });
  });
  syncSliderLabels();
}

// ===== 字幕プリセット（localStorage） =====
function loadPresets() { return _prefs.presets || []; }
function savePresets(p) { _prefs.presets = p; savePrefs(true); }   // プリセットは即時保存（確実性優先）

// ===== 組み込み見た目テンプレ（フォント＋色＋縁＋影＋アニメの完成セット・削除不可） =====
const BUILTIN_PRESETS = [
  { name: '★ バラエティ黄色', style: { font: 'Dela Gothic One', sub: '#FFFFFF', hi: '#FFE600', out: '#000000', title: '#FFE600',
      capSize: 78, capOutline: 8, titleSize: 88, titleOutline: 10, animation: 'pop', exit: 'none', karaoke: false, effect: 'none',
      box: false, boxColor: '#000000', boxPad: 10, shadowD: 3, shadowA: 70, shadowB: 1 } },
  { name: '★ ゲーム実況ポップ', style: { font: 'Rounded Mplus 1c', sub: '#FFFFFF', hi: '#25F4EE', out: '#1E2A78', title: '#25F4EE',
      capSize: 76, capOutline: 8, titleSize: 84, titleOutline: 9, animation: 'bounce', exit: 'fade', karaoke: true, effect: 'none',
      box: false, boxColor: '#000000', boxPad: 10, shadowD: 2, shadowA: 60, shadowB: 0 } },
  { name: '★ ホラー・怪談', style: { font: 'Shippori Mincho B1', sub: '#E6E6E6', hi: '#FF2D2D', out: '#1A0000', title: '#FF2D2D',
      capSize: 72, capOutline: 5, titleSize: 82, titleOutline: 7, animation: 'blurin', exit: 'blurout', karaoke: false, effect: 'horror',
      box: false, boxColor: '#000000', boxPad: 10, shadowD: 6, shadowA: 85, shadowB: 3 } },
  { name: '★ ニュース速報', style: { font: 'BIZ UDPGothic', sub: '#FFFFFF', hi: '#FFE600', out: '#000000', title: '#FFFFFF',
      capSize: 70, capOutline: 0, titleSize: 80, titleOutline: 8, animation: 'none', exit: 'none', karaoke: false, effect: 'none',
      box: true, boxColor: '#0A0A2E', boxPad: 14, shadowD: 0, shadowA: 60, shadowB: 0 } },
  { name: '★ かわいい・日常', style: { font: 'Hachi Maru Pop', sub: '#FFFFFF', hi: '#FF9BD2', out: '#7A3B5E', title: '#FFD1E8',
      capSize: 76, capOutline: 7, titleSize: 86, titleOutline: 9, animation: 'stagger', exit: 'shrink', karaoke: false, effect: 'none',
      box: false, boxColor: '#000000', boxPad: 10, shadowD: 2, shadowA: 55, shadowB: 1 } },
  { name: '★ 感動・エモ', style: { font: 'Zen Maru Gothic', sub: '#FFF8E7', hi: '#FFD86B', out: '#4A3B2A', title: '#FFF8E7',
      capSize: 72, capOutline: 5, titleSize: 82, titleOutline: 7, animation: 'fade', exit: 'fade', karaoke: false, effect: 'glow',
      box: false, boxColor: '#000000', boxPad: 10, shadowD: 3, shadowA: 65, shadowB: 2 } },
  { name: '★ キル集・大会', style: { font: 'Train One', sub: '#FFFFFF', hi: '#FF2D55', out: '#000000', title: '#FF2D55',
      capSize: 80, capOutline: 9, titleSize: 92, titleOutline: 11, animation: 'zoombig', exit: 'none', karaoke: false, effect: 'jitter',
      box: false, boxColor: '#000000', boxPad: 10, shadowD: 4, shadowA: 75, shadowB: 0 } },
  { name: '★ 高級・ゴールド', style: { font: 'Yuji Syuku', sub: '#FFC31C', hi: '#FFE600', out: '#5C3A00', title: '#FFC31C',
      capSize: 74, capOutline: 5, titleSize: 86, titleOutline: 8, animation: 'fade', exit: 'fade', karaoke: false, effect: 'gold',
      box: false, boxColor: '#000000', boxPad: 10, shadowD: 3, shadowA: 70, shadowB: 1 } },
];

// プリセットが空のとき、サーバから再取得してから一覧を作り直す（起動直後の取りこぼし対策）
async function ensurePresetsLoaded() {
  if (loadPresets().length) return;
  try {
    const p = await (await fetch('/api/prefs')).json();
    if (p && typeof p === 'object') _prefs = Object.assign(_prefs, p);
    refreshPresetSelect();
  } catch (_) { /* サーバ未応答時は現状維持 */ }
}
function refreshPresetSelect() {
  const sel = document.getElementById('presetSelect');
  const cur = sel.value;
  sel.innerHTML = '<option value="">（プリセットを選択）</option>';
  const ogT = document.createElement('optgroup'); ogT.label = 'テンプレ（組み込み）';
  BUILTIN_PRESETS.forEach(p => {
    const o = document.createElement('option'); o.value = p.name; o.textContent = p.name; ogT.appendChild(o);
  });
  sel.appendChild(ogT);
  const ups = loadPresets();
  if (ups.length) {
    const ogU = document.createElement('optgroup'); ogU.label = 'マイプリセット';
    ups.forEach(p => {
      const o = document.createElement('option'); o.value = p.name; o.textContent = p.name; ogU.appendChild(o);
    });
    sel.appendChild(ogU);
  }
  sel.value = cur;
}
function currentStyleObj() {
  const v = id => document.getElementById(id).value;
  return {
    font: v('fontSelect'), sub: v('cSub'), hi: v('cHi'), out: v('cOut'), title: v('cTitle'),
    capSize: +v('capSize'), capOutline: +v('capOutline'),
    titleSize: +v('titleSize'), titleOutline: +v('titleOutline'),
    animation: v('animSelect'), effect: _effSel(),
    exit: (document.getElementById('exitSelect') || {}).value || 'none',
    karaoke: !!(document.getElementById('karaOn') || {}).checked,
    box: document.getElementById('boxOn').checked, boxColor: v('cBox'), boxPad: +v('boxPad'),
    shadowD: +v('shadowD'), shadowA: +v('shadowA'), shadowB: +v('shadowB'),
  };
}
function applyStyleObj(s) {
  if (!s) return;
  const set = (id, val) => { const e = document.getElementById(id); if (e && val != null) e.value = val; };
  set('fontSelect', s.font); set('cSub', s.sub); set('cHi', s.hi); set('cOut', s.out); set('cTitle', s.title);
  set('capSize', s.capSize); set('capOutline', s.capOutline);
  set('titleSize', s.titleSize); set('titleOutline', s.titleOutline);
  set('cBox', s.boxColor);
  if (s.boxPad != null) set('boxPad', s.boxPad);
  // アニメ/エフェクト（旧プリセットは animate:boolean のみ → 既定/なしに読み替え）
  set('animSelect', s.animation != null ? s.animation : (s.animate === false ? 'none' : 'default'));
  set('exitSelect', s.exit || 'none');
  _styleEffect = s.effect || 'none';   // テンプレの文字エフェクト（UIなし・送信時に _effSel() が返す）
  const kEl = document.getElementById('karaOn'); if (kEl) kEl.checked = !!s.karaoke;
  set('shadowD', s.shadowD); set('shadowA', s.shadowA); set('shadowB', s.shadowB);
  if (typeof s.box === 'boolean') document.getElementById('boxOn').checked = s.box;
  syncSliderLabels(); updateFontPreview(); updatePreviewColors(); applyPreviewFx();
}
// 作成ページの「見た目テンプレ」チップ（ワンタップ適用）
function renderTplRow() {
  const row = document.getElementById('tplRow'); if (!row) return;
  row.innerHTML = '';
  BUILTIN_PRESETS.forEach(p => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'tpl-chip';
    b.textContent = p.name.replace(/^★ /, '');
    b.style.fontFamily = `'${p.style.font}', sans-serif`;
    b.style.color = p.style.sub;
    b.style.webkitTextStroke = '0.6px ' + p.style.out;
    b.addEventListener('click', () => {
      applyStyleObj(p.style);
      saveLastStyle();
      row.querySelectorAll('.tpl-chip').forEach(n => n.classList.toggle('sel', n === b));
    });
    row.appendChild(b);
  });
}

async function applyPreset() {
  await ensurePresetsLoaded();   // 起動直後でも必ず読めるように
  const name = document.getElementById('presetSelect').value;
  const p = BUILTIN_PRESETS.find(x => x.name === name) || loadPresets().find(x => x.name === name);
  if (p) applyStyleObj(p.style);
}
// ドロップダウンを開いた時点でも再取得（起動時のロード失敗をリカバー）
(function () {
  const ps = document.getElementById('presetSelect');
  if (ps) ps.addEventListener('focus', ensurePresetsLoaded);
})();
function saveCurrentPreset() {
  // Electron は window.prompt() が無効なのでインライン入力欄から取得する
  const inp = document.getElementById('presetName');
  const name = ((inp && inp.value) || '').trim();
  if (!name) {
    if (inp) { inp.focus(); inp.placeholder = '名前を入力してください'; }
    return;
  }
  const ps = loadPresets().filter(x => x.name !== name);
  ps.push({ name: name, style: currentStyleObj() });
  savePresets(ps);
  refreshPresetSelect();
  document.getElementById('presetSelect').value = name;
  if (inp) inp.value = '';
}
function deletePreset() {
  const name = document.getElementById('presetSelect').value;
  if (!name || BUILTIN_PRESETS.some(x => x.name === name)) return;   // 組み込みテンプレは削除不可
  savePresets(loadPresets().filter(x => x.name !== name));
  refreshPresetSelect();
}

// ===== 直近のスタイルを記憶（次回の既定に） =====
// スライダーの input は毎tick発火するため、localStorage 書込みは300msデバウンス
let _lastStyleT = null;
function saveLastStyle() {
  clearTimeout(_lastStyleT);
  _lastStyleT = setTimeout(() => { _prefs.laststyle = currentStyleObj(); savePrefs(); }, 300);
}
function restoreLastStyle() {
  try { if (_prefs.laststyle) applyStyleObj(_prefs.laststyle); } catch (_) {}
}
function wireStyleMemory() {
  ['fontSelect', 'cSub', 'cHi', 'cOut', 'cTitle', 'capSize', 'capOutline',
   'titleSize', 'titleOutline', 'animSelect', 'exitSelect', 'karaOn', 'boxOn', 'cBox', 'boxPad',
   'shadowD', 'shadowA', 'shadowB'].forEach(id => {
    const e = document.getElementById(id);
    if (e) {
      e.addEventListener('change', saveLastStyle); e.addEventListener('input', saveLastStyle);
      e.addEventListener('change', updateBulkPreview); e.addEventListener('input', updateBulkPreview);
    }
  });
  // 枠トグル/色/大きさはプレビューにも即反映
  ['boxOn', 'cBox', 'boxPad'].forEach(id => {
    const e = document.getElementById(id);
    if (e) { e.addEventListener('change', updatePreview); e.addEventListener('input', updatePreview); }
  });
  // アニメ/エフェクト変更はプレビューを再生し直す
  ['animSelect', 'effectSelect'].forEach(id => {
    const e = document.getElementById(id);
    if (e) e.addEventListener('change', applyPreviewFx);
  });
}

(async () => {
  await loadPrefs();          // プリセット等をサーバから先に読み込む（起動間で永続）
  initFonts();                // restoreLastStyle が _prefs を参照
  renderPalette();
  updatePreviewColors();
  initGenres();
  initSliders();
  refreshPresetSelect();      // _prefs.presets を表示
  renderTplRow();             // 見た目テンプレ（組み込み）チップ
  updateBrandHint();
  await applyBrandSettings();  // ウォーターマーク/ロゴ 表示トグルを設定値から復元（設定未オープンでも有効）
  wireStyleMemory();
  applyPreviewFx();
  onReframeChange();
})();

// ===== 詳細編集ページ（字幕・位置・効果音をまとめて編集） =====
function openDetailFromBtn(btn) {
  const card = btn.closest('.clip-card');
  if (!card) return;
  const t = card.querySelector('.clip-title').textContent.replace(/^\d+\.\s*/, '');
  openDetail(card.dataset.job, card.dataset.cid, t);
}
function openDetail(job, cid, title) {
  const ed = document.getElementById('detailEditor');
  // 動画要素を作り直し、前回のタイムライン用リスナー（timeupdate/play等）を破棄＝リーク防止
  const oldV = document.getElementById('detailVideo');
  const v = oldV.cloneNode(false);
  oldV.replaceWith(v);
  document.getElementById('detailTitle').textContent = cid + '. ' + (title || '無題');
  v.src = apiUrl('/api/download/' + job + '/clip_' + ('0' + cid).slice(-2) + '.mp4?t=' + Date.now());
  v.load();
  ed.dataset.job = job; ed.dataset.cid = cid; ed.dataset.loaded = '';
  ed.hidden = false; ed.innerHTML = '';
  document.getElementById('detailTabBtn').disabled = false;
  switchTab('detail');
  window.scrollTo(0, 0);
  loadEditor(ed);     // 詳細パネルが表示状態になってから読込（幅計算のため）＝字幕＋効果音タイムライン込み
}
// 詳細ページ: 字幕編集＋効果音を1回でまとめて保存・再作成
async function saveDetail(btn) {
  const ed = document.getElementById('detailEditor');
  const st0 = document.getElementById('detailSaveStatus');
  if (!ed.dataset.loaded) {   // 旧実装は無言で何もしなかった → 理由を必ず表示
    if (st0) st0.textContent = '編集データを読み込み中です。数秒待ってからもう一度押してください。';
    return;
  }
  if (ed._inputExists === false) {
    if (st0) { st0.textContent = 'エラー: 元動画が見つからないため再作成できません（動画を元の場所に戻すと保存できます）。'; st0.classList.add('err'); }
    return;
  }
  const job = ed.dataset.job, cid = ed.dataset.cid;
  const payload = _editorPayload(ed);
  payload.sfx = _editorSfx(ed);
  // 部分カット: カット範囲があれば telop/sfx を圧縮再配置し keeps を付与（保存後リロードで反映）
  let cutReload = false;
  if ((ed._cuts || []).length) {
    const cut = edApplyCuts(ed);
    if (cut.removed < 0.1 || cut.clip_duration < 0.5) {   // 何も削れない/全部消える指定は無効
      document.getElementById('detailSaveStatus').textContent =
        cut.clip_duration < 0.5 ? 'クリップ全体はカットできません。カット範囲を減らしてください。'
                                : 'カット範囲が短すぎます（0.1秒以上に）。';
      return;
    }
    payload.telops = cut.telops; payload.sfx = cut.sfx;
    payload.images = (cut.images || []).map(im => ({ file: im.file, x: im.x, y: im.y,
      scale: im.scale, start: im.start, end: im.end,
      opacity: im.opacity == null ? 1 : im.opacity,
      anim_in: im.anim_in || 'none', anim_out: im.anim_out || 'none',
      in_dur: im.in_dur || 0.4, out_dur: im.out_dur || 0.4 }));
    payload.keeps = cut.keeps; payload.clip_duration = cut.clip_duration;
    cutReload = true;
  } else {
    payload.keeps = ed._keeps || null;   // 既存/リセット後の残し区間を維持
  }
  const reload = !!(payload.extend_start || payload.extend_end) || cutReload;
  const st = document.getElementById('detailSaveStatus');
  st.classList.remove('err');
  st.textContent = reload ? '再調整してまとめて再作成中...' : '字幕＋効果音をまとめて再作成中...';
  btn.disabled = true;
  // 再作成前に動画ファイルを解放（プレイヤーのロックで os.replace が WinError5 になるのを防ぐ）
  const cap = _vCaps(document.getElementById('detailVideo'));
  _vRelease(cap);
  try {
    const resp = await fetch('/api/clip/' + job + '/' + cid, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || '失敗しました');
    _vRestore(cap, job, cid);
    const newTitle = data.title || payload.title;
    document.getElementById('detailTitle').textContent = cid + '. ' + (newTitle || '無題');
    const gc = _bustGridCard(job, cid);
    if (gc) gc.querySelector('.clip-title').textContent = cid + '. ' + (newTitle || '無題');
    st.textContent = data.warning ? ('✓ 保存（' + data.warning + '）') : '✓ 保存しました';
    _markSavedState(ed);   // 現在の編集内容＝焼き込み済み（再生中の二重表示防止の基準を更新）
    // 保存後は必ずサーバの実データ(manifest)から再読込＝画面の状態と動画/保存値の不整合を根絶
    ed.dataset.loaded = ''; loadEditor(ed);
  } catch (e) {
    _vRestore(cap, job, cid);   // 失敗時もプレビューを復帰（ディスクは未変更）
    st.textContent = 'エラー: ' + e.message;
    st.classList.add('err');
  }
  btn.disabled = false;
}

// 編集UI/タイムラインが属するプレビュー動画（結果カード or 詳細ページ）
function _clipVideo(el) {
  const card = el.closest('.clip-card');
  return card ? card.querySelector('video') : document.getElementById('detailVideo');
}
// プレビューの描画先フレーム。詳細編集では左の動画上のオーバーレイ（ed._frame）、それ以外は内蔵 .ed-frame。
function _edFrame(ed) { return (ed && ed._frame) || (ed && ed.querySelector('.ed-frame')) || null; }
// 再作成前後の動画ロック対策: POST前に解放し、成功/失敗どちらでも再読込で復帰させる。
// （プレイヤーが mp4 を掴んだままだと os.replace=WinError5 になり、backend のリトライも勝てない）
function _vCaps(v) {
  if (!v) return null;
  return { v, src: (v.currentSrc || v.getAttribute('src') || '').split('?')[0],
           poster: v.poster ? v.poster.split('?')[0] : null };
}
function _vRelease(cap) {
  if (!cap || !cap.v) return;
  try { cap.v.pause(); } catch (_) {}
  cap.v.removeAttribute('src'); cap.v.load();
}
function _vRestore(cap, job, cid) {
  if (!cap || !cap.v) return;
  const bust = '?t=' + Date.now();
  cap.v.src = apiUrl((cap.src || ('/api/download/' + job + '/clip_' + ('0' + cid).slice(-2) + '.mp4')).split('?')[0] + bust);
  if (cap.poster) cap.v.poster = apiUrl(cap.poster + bust);
  cap.v.load();
}
// 再作成後に結果グリッド側のカード動画も更新（詳細ページから編集した場合の同期）
function _bustGridCard(job, cid) {
  const card = document.querySelector('.clip-card[data-job="' + job + '"][data-cid="' + cid + '"]');
  if (!card) return null;
  const v = card.querySelector('video');
  if (v) {
    const b = '?t=' + Date.now();
    v.src = apiUrl(new URL(v.src, window.location.href).pathname + b);
    if (v.poster) v.poster = apiUrl(new URL(v.poster, window.location.href).pathname + b);
    v.load();
  }
  return card;
}

// ===== 字幕の手動修正 =====
async function loadEditor(ed) {
  const job = ed.dataset.job, cid = ed.dataset.cid;
  // 素早くクリップを切り替えた際、先発の遅い fetch が後発の状態を上書きしないよう世代番号で防ぐ
  const gen = (ed._loadGen = (ed._loadGen || 0) + 1);
  ed.innerHTML = '<div class="ed-loading">読み込み中...</div>';
  try {
    const data = await (await fetch('/api/clip/' + job + '/' + cid)).json();
    if (ed._loadGen !== gen) return;   // 別クリップの読込が始まっていたら破棄
    // 元動画が見つからない作品は再作成不可＝先に分かりやすく知らせる（保存時エラーの防止）
    ed._inputExists = (data.input_exists !== false);
    ed._dur = +data.clip_duration || 0;
    const _mkTelop = t => ({
      start: +t.start || 0, end: +t.end || 0, text: t.text || '',
      style: t.style || '', emphasis: !!t.emphasis, animation: t.animation || '',
      font: t.font || '', color: t.color || '', outline_color: t.outline_color || '',
      size: +t.size || 0, width: +t.width || 0, effect: t.effect || '', anim_speed: +t.anim_speed || 0,
      layer: +t.layer || 0, pos: (t.pos && t.pos.x != null) ? { x: +t.pos.x, y: +t.pos.y } : null,
    });
    ed._telops = (data.telops || []).map(_mkTelop);
    ed._telopsOrig = (data.telops_orig || []).map(_mkTelop);   // 「初期設定に戻す」用の原字幕
    ed._telopsPristine = _subClone(ed._telops);   // 初期に戻す用スナップショット
    // 効果音（インラインタイムラインの効果音レーン）
    // baked=true: 保存済み＝動画音声に焼き込み済み。プレビュー再生でライブ再生すると二重になるため鳴らさない。
    ed._sfx = (data.sfx || []).map(s => ({ uid: 'b' + (_uidN++), id: s.id, at: +s.at || 0, gain: s.gain == null ? 1 : +s.gain, baked: true }));
    // 画像オーバーレイ（保存済み＝動画に焼き込み済み。再生中は同一内容のチップを隠す）
    ed._images = (data.images || []).map(im => ({ uid: 'g' + (_uidN++), file: im.file,
      x: +im.x || 0.5, y: +im.y || 0.5, scale: +im.scale || 0.35,
      start: +im.start || 0, end: +im.end || 0,
      opacity: (im.opacity == null ? 1 : +im.opacity) || 1,
      // 旧形式 fade_in/fade_out（秒）→ anim_in/out='fade' に移行
      anim_in: im.anim_in || ((+im.fade_in || 0) > 0 ? 'fade' : 'none'),
      anim_out: im.anim_out || ((+im.fade_out || 0) > 0 ? 'fade' : 'none'),
      in_dur: +im.in_dur || +im.fade_in || 0.4,
      out_dur: +im.out_dur || +im.fade_out || 0.4, baked: true }));
    ed._imagesPristine = ed._images.map(_imgKey);
    ed._selImg = null;
    ed._sfxById = {};
    try { const _sl = await getSfxList(); ed._sfxById = Object.fromEntries(_sl.map(s => [s.id, s])); } catch (_) {}
    ed._selTelop = -1; ed._selSfx = null;
    ed._undo = []; ed._redo = []; ed._undoTag = null;   // Undo履歴はクリップ読込ごとにリセット
    ed._selSet = null;
    // 効果音レーン背景の音声波形（非同期・失敗しても編集には影響なし）
    ed._peaks = null;
    fetch('/api/clip/' + job + '/' + cid + '/waveform?n=' + Math.max(200, Math.min(4000, Math.round((+data.clip_duration || 60) * 8))))
      .then(r => r.json())
      .then(w => { if (ed._loadGen === gen) { ed._peaks = w.peaks || []; edDrawWave(ed); } })
      .catch(() => {});
    // 部分カット用: 現在の残し区間（manifest keeps・元クリップ時間）と元クリップ尺
    ed._keeps = data.keeps || null;
    ed._keepsOrig = data.keeps_orig || null;
    ed._origDur = (data.end != null && data.start != null) ? (+data.end - +data.start) : (ed._dur || 0);
    ed._cuts = [];   // 新規カット範囲（表示時間・未適用）
    ed._subOffset = +data.sub_offset || 0;   // 字幕タイミング（秒・per-clip）
    const st = data.style || {};
    // 位置は常に明示（既定でも \pos 中央アンカーで描画）→ プレビューと実際の位置を一致させる。
    ed._titlePos = st.title_pos || { x: 0.5, y: 0.16 };
    ed._capPos = st.caption_pos || { x: 0.5, y: 0.72 };
    const poster = apiUrl('/api/download/' + job + '/clip_' + ('0' + cid).slice(-2) + '.jpg');
    ed._poster = poster;   // 字幕調整モーダルのプレビュー背景
    const capSz = st.caption_size || 74, ttlSz = st.title_size || 80;
    const capOl = st.outline_width != null ? st.outline_width : 6;
    const ttlOl = st.title_outline_width != null ? st.title_outline_width : 8;
    const ttlW = Math.round((st.title_width || 0.66) * 100);   // タイトル折返し幅（%）
    const capW = Math.round((st.caption_width || 0.66) * 100); // 字幕折返し幅（%）
    const shD = st.shadow_depth != null ? +st.shadow_depth : 2;                  // 影の濃さ（px）
    const shA = Math.round((st.shadow_alpha != null ? +st.shadow_alpha : 0.61) * 100);  // 影の不透明度（%）
    const shB = st.shadow_blur != null ? +st.shadow_blur : 0;                    // 影のぼかし
    const animV = st.animation || 'default';
    const effV = st.effect || 'none';
    const aspdPct = Math.round((st.animation_speed || 1) * 100);   // アニメ速度（%）
    // WYSIWYG プレビュー用に、クリップのフォント・色・枠を控える（再描画前の見た目確認）
    ed._pv = {
      font: st.font || '', sub: st.subtitle_color || '#FFFFFF', out: st.outline_color || '#000000',
      title: st.title_color || '#FFFFFF', titleOut: st.title_outline_color || st.outline_color || '#000000',
      box: !!st.box, boxColor: st.box_color || '#000000', emph: st.emphasis_color || '#FFE600',
      hl: st.highlight_color || '#FFE600',   // カラオケの発話済み色
    };
    const tp0 = ed._titlePos || { x: 0.5, y: 0.16 };
    ed._reframe = data.reframe || 'crop';
    ed._lbColor = data.letterbox_color || '#000000';
    // プレビュー土台: 「字幕なし」クリーン動画があればそれを使う＝チップが唯一の字幕表示になり、
    // 編集した文字が焼込み済みの旧字幕と二重に見える（カラオケ風ゴースト）問題を根絶する。
    // 旧ジョブ（クリーン無し）は従来どおり焼込み動画＋保存済み隠し（pristine比較）で表示。
    ed._cleanPreview = !!data.preview;
    if (data.preview) {
      const pvv = _clipVideo(ed);
      if (pvv) { pvv.src = apiUrl('/api/download/' + data.preview + '?t=' + Date.now()); pvv.load(); }
    } else if (ed._inputExists) {
      // 旧クリップ（クリーン導入前に作成）: 裏で後追い生成し、できたら差し替える。
      // それまでは従来表示（焼込み字幕＋チップ）＝編集はそのまま続けられる。
      fetch('/api/clip/' + job + '/' + cid + '/clean_preview', { method: 'POST' })
        .then(r => (r.ok ? r.json() : null))
        .then(d2 => {
          if (ed._loadGen !== gen) return;   // 別クリップに切替済みなら捨てる
          const note = ed.querySelector('.ed-clean-note');
          if (!d2 || !d2.preview) { if (note) note.hidden = true; return; }   // 失敗時は従来表示のまま
          ed._cleanPreview = true;
          if (note) note.hidden = true;
          const pv2 = _clipVideo(ed);
          if (pv2) {
            const t0 = pv2.currentTime || 0;
            pv2.src = apiUrl('/api/download/' + d2.preview + '?t=' + Date.now());
            pv2.load();
            pv2.addEventListener('loadedmetadata', () => { try { pv2.currentTime = t0; } catch (_) {} }, { once: true });
          }
          renderPreviewTelops(ed);
        })
        .catch(() => {});
    }
    let h =
      '<label class="ed-label">タイトル</label>' +
      '<input class="ed-title" type="text" value="' + esc(data.title || '') + '">' +
      // クリップ全体のスタイル（サイズ・影・アニメ等）は折りたたみ（既定は閉）
      // ＝「選択中の字幕」の個別編集をメインのUIにする
      '<div class="ed-clipstyle-bar">' +
        '<button type="button" class="mini-btn ed-clipstyle-btn" onclick="edToggleClipStyle(this)">🎨 クリップ全体のスタイル設定 ▸</button>' +
        '<span class="opt">サイズ・影・アニメなど全字幕共通の設定。1つずつの色・サイズ・フォントは下の字幕をクリックして変更できます。</span>' +
      '</div>' +
      '<div class="ed-clipstyle" hidden>' +
      '<div class="ed-pos">' +
        '<div class="ed-pos-side">' +
          '<button type="button" class="mini-btn" onclick="resetPos(this)">位置を初期化</button>' +
          '<label class="slider-item">字幕サイズ <b class="ed-capsz-o">' + capSz + '</b>' +
            '<input type="range" class="ed-capsz" min="48" max="120" step="2" value="' + capSz + '"></label>' +
          '<label class="slider-item">字幕の縁取り <b class="ed-capol-o">' + capOl + '</b>' +
            '<input type="range" class="ed-capol" min="0" max="16" step="1" value="' + capOl + '"></label>' +
          '<label class="slider-item">字幕幅 <b class="ed-capw-o">' + capW + '</b>%' +
            '<input type="range" class="ed-capw" min="35" max="95" step="1" value="' + capW + '"></label>' +
          '<label class="slider-item">タイトルサイズ <b class="ed-ttlsz-o">' + ttlSz + '</b>' +
            '<input type="range" class="ed-ttlsz" min="50" max="140" step="2" value="' + ttlSz + '"></label>' +
          '<label class="slider-item">タイトルの縁取り <b class="ed-ttlol-o">' + ttlOl + '</b>' +
            '<input type="range" class="ed-ttlol" min="0" max="20" step="1" value="' + ttlOl + '"></label>' +
          '<label class="slider-item">タイトル幅 <b class="ed-ttlw-o">' + ttlW + '</b>%' +
            '<input type="range" class="ed-ttlw" min="35" max="95" step="1" value="' + ttlW + '"></label>' +
          '<label class="slider-item">影の濃さ <b class="ed-shd-o">' + shD + '</b>' +
            '<input type="range" class="ed-shd" min="0" max="16" step="1" value="' + shD + '"></label>' +
          '<label class="slider-item">影の不透明度 <b class="ed-sha-o">' + shA + '</b>%' +
            '<input type="range" class="ed-sha" min="0" max="100" step="5" value="' + shA + '"></label>' +
          '<label class="slider-item">影のぼかし <b class="ed-shb-o">' + shB + '</b>' +
            '<input type="range" class="ed-shb" min="0" max="10" step="0.5" value="' + shB + '"></label>' +
          '<label class="slider-item">アニメーション' +
            '<select class="ed-anim">' + optionsHtml(ANIM_OPTS, animV) + '</select></label>' +
          '<label class="slider-item">アニメ速度 <b class="ed-aspd-o">' + aspdPct + '</b>%' +
            '<input type="range" class="ed-aspd" min="25" max="300" step="5" value="' + aspdPct + '"></label>' +
          '<label class="slider-item">退場アニメ' +
            '<select class="ed-exit">' + optionsHtml(EXIT_OPTS, st.exit_animation || 'none') + '</select></label>' +
          '<label class="slider-item">文字エフェクト' +
            '<select class="ed-effect">' + optionsHtml(EFFECT_OPTS, effV) + '</select></label>' +
          '<label class="slider-item ed-kara-item" title="しゃべった所まで字幕の色が変わります（色は「強調の色」）">' +
            '<span>🎤 単語カラオケ</span><input type="checkbox" class="ed-kara"' + (st.karaoke ? ' checked' : '') + '></label>' +
          '<label class="slider-item">画面構成(9:16)' +
            '<select class="ed-reframe">' + optionsHtml([['crop', '中央クロップ'], ['blur', '背景ぼかし'], ['letterbox', 'レターボックス']], data.reframe || 'crop') + '</select></label>' +
          '<label class="slider-item ed-lb-field"' + ((data.reframe || 'crop') !== 'letterbox' ? ' style="display:none"' : '') + '>帯の色' +
            '<input type="color" class="ed-lb-color" value="' + (data.letterbox_color || '#000000') + '"></label>' +
        '</div>' +
      '</div>' +
      '</div>' +
      // 旧クリップ: プレビュー土台（字幕なし動画）を裏で準備中の案内（完成で自動非表示）
      (!data.preview && ed._inputExists
        ? '<div class="ed-clean-note hint">🎬 プレビュー用動画を準備中…（完了すると左の動画から焼込み字幕が消え、編集中の字幕だけが表示されます。編集はそのまま続けられます）</div>'
        : '') +
      '<div class="ed-tl-head">' +
        '<label class="ed-label" style="margin:0;">字幕・効果音タイムライン <span class="opt">（ブロックをドラッグで移動・上下端で時間・空きクリックで追加）</span></label>' +
        '<div class="ed-tel-tools">' +
          '<button type="button" class="mini-btn ed-undo" onclick="edUndoBtn(this)" title="元に戻す (Ctrl+Z)" disabled>↶</button>' +
          '<button type="button" class="mini-btn ed-redo" onclick="edRedoBtn(this)" title="やり直す (Ctrl+Y)" disabled>↷</button>' +
          '<span class="ed-zoom-ctl" title="タイムライン拡大率（Ctrl+ホイールでも変更）">' +
            '<button type="button" class="mini-btn" onclick="edZoomBtn(this,-1)">−</button>' +
            '<span class="ed-zoom-o">' + Math.round(ED_PX / 80 * 100) + '%</span>' +
            '<button type="button" class="mini-btn" onclick="edZoomBtn(this,1)">＋</button></span>' +
          '<button type="button" class="mini-btn" onclick="edAddCut(this)" title="再生位置にカット範囲を追加。やり直すときはカット範囲の✕で個別取消、または「初期に戻す」で全部戻せます">✂ カット範囲</button>' +
          '<button type="button" class="mini-btn" onclick="edTlReset(this)" title="字幕・カットを生成直後の状態に戻します（カットしすぎたときもこれで元に戻せます）">初期に戻す</button>' +
          '<select class="ed-bulk-anim" onchange="edBulkAnim(this)">' +
            '<option value="">全テロップのアニメ…</option>' + optionsHtml(ANIM_OPTS, '_skip_') + '</select>' +
        '</div>' +
      '</div>' +
      // 選択中の字幕/効果音/画像の編集パネル（タイムライン直上＝メインの編集UI）
      '<div class="ed-sel-tel" hidden></div>' +
      '<div class="ed-sel-sfx" hidden></div>' +
      '<div class="ed-sel-img" hidden></div>' +
      '<div class="ed-tl-colhead"><span></span><span>字幕</span><span>効果音</span><span>画像</span></div>' +
      '<div class="ed-tl-wrap"><div class="ed-tl">' +
        '<div class="ed-tl-gutter"></div>' +
        '<div class="ed-tl-lane ed-tl-tel"></div>' +
        '<div class="ed-tl-lane ed-tl-sfx"><canvas class="ed-tl-wave"></canvas></div>' +
        '<div class="ed-tl-lane ed-tl-img"></div>' +
        '<div class="ed-tl-playhead"></div>' +
      '</div></div>' +
      '<div class="ed-tl-resize" title="ドラッグでタイムラインの高さを変更"><span class="ed-tl-resize-grip"></span></div>' +
      '<div class="ed-tl-hint hint">Shift+クリック=複数選択 ／ Delete=削除 ／ Ctrl+D=複製 ／ Ctrl+Z=元に戻す ／ ←→=0.1秒送り ／ 画像はダブルクリックで編集</div>' +
      '<div class="ed-tl-readout"><span class="ed-tl-time">0.0s</span></div>' +
      // 追加ツール（効果音パレット・画像貼り付け）はタイムラインの下にまとめる
      '<div class="ed-sfx-pal"></div>' +
      '<div class="ed-sfx-sug" hidden></div>' +
      '<div class="ed-img-bar"><span class="ed-pal-lbl">🖼 画像を貼る</span>' +
        '<button type="button" class="mini-btn ed-img-add" title="動画の上に貼る画像（PNG/JPG/WebP）を追加します。追加後は左のプレビュー上でドラッグして配置">＋画像を追加</button>' +
        '<span class="ed-img-count"></span>' +
        '<input type="file" class="ed-img-file" accept=".png,.jpg,.jpeg,.webp" hidden></div>' +
      '<div class="ed-suboff">' +
        '<label>字幕タイミング <span class="opt">（秒・＋で字幕を遅らせる）</span> <b class="ed-suboff-val">0.00</b></label>' +
        '<input type="range" class="ed-suboff-range" min="-1" max="1" step="0.05" value="0">' +
        '<span class="hint" style="display:block;margin-top:2px;">音声より字幕が早い/遅いと感じたら調整→「保存して再作成」で反映。</span>' +
      '</div>' +
      '<div class="ed-extend">' +
        '<label class="ed-label">時間の延長 <span class="opt">（秒・0で変更なし。延長すると字幕は取り直します）</span></label>' +
        '<div class="ed-extend-row">' +
          '<label>頭 ＋<input type="number" class="ed-ext-s" min="0" max="120" step="1" value="0"> 秒</label>' +
          '<label>末尾 ＋<input type="number" class="ed-ext-e" min="0" max="120" step="1" value="0"> 秒</label>' +
        '</div>' +
      '</div>' +
      '<div class="ed-actions"><button class="ed-save" onclick="saveClip(this)">更新して再作成</button>' +
      '<span class="ed-status"></span></div>';
    ed.innerHTML = h;
    // プレビューは左の動画上のオーバーレイに描画＝編集中の字幕が「再生される動画」にそのまま乗る。
    // 毎回オーバーレイを作り直してタイトルチップを入れ直す（リスナー重複・前クリップ残りを防ぐ）。
    ed._frame = document.getElementById('detailPvFrame');
    if (ed._frame) {
      ed._frame.innerHTML = '<div class="ed-chip ed-wys ed-ct" title="ドラッグ=移動／右下グリップ=大きさ／左右端=幅" style="left:' + (tp0.x * 100) + '%;top:' + (tp0.y * 100) + '%"></div>';
    }
    // 現在の描画済み状態を「焼き込み済み」として記録（再生中の二重表示防止の基準）
    ed._title0 = { t: (data.title || '').trim(), sz: ttlSz, w: ttlW, x: tp0.x, y: tp0.y };
    initPosEditor(ed);
    wireEditorPreview(ed);
    // クリップ全体のアニメ/退場/エフェクトも見た目つきピッカーに（既存の change 配線はそのまま）
    fxPickerify(ed.querySelector('.ed-anim'), 'anim');
    fxPickerify(ed.querySelector('.ed-exit'), 'exit');
    fxPickerify(ed.querySelector('.ed-effect'), 'effect');
    wireReframe(ed);
    // 画像編集パネルの参照（ダブルクリックのポップアップへ移設しても追えるように保持）
    ed._imgPanel = ed.querySelector('.ed-sel-img');
    const _im = document.getElementById('imgEditModal');
    if (_im) { _im.hidden = true; const b = document.getElementById('imgEditBody'); if (b) b.innerHTML = ''; }
    // タイムラインの高さ（引き伸ばしバーで変更・prefs から復元）
    const _tw = ed.querySelector('.ed-tl-wrap');
    if (_tw && +_prefs.tl_h) {
      _tw.style.maxHeight = 'none';
      _tw.style.height = Math.max(200, Math.min(1600, +_prefs.tl_h)) + 'px';
    }
    edRenderTimeline(ed);        // 字幕＋効果音＋画像 インライン縦タイムライン
    edRenderSfxPalette(ed);
    edWireImages(ed);            // 画像オーバーレイ（追加ボタン）
    edSyncImgCount(ed);
    edWireTlResize(ed);
    edWireLaneScrub(ed);
    edWireSelTelop(ed);
    edWirePlayheadSync(ed);
    edWireZoom(ed);
    edSyncUndoBtns(ed);
    edDrawWave(ed);
    // 字幕タイミング スライダー（per-clip・プレビュー即反映）
    (function () {
      const sr = ed.querySelector('.ed-suboff-range'), sv = ed.querySelector('.ed-suboff-val');
      if (!sr) return;
      sr.value = ed._subOffset; if (sv) sv.textContent = (+ed._subOffset).toFixed(2);
      sr.addEventListener('input', () => { ed._subOffset = +sr.value || 0; if (sv) sv.textContent = ed._subOffset.toFixed(2); renderPreviewTelops(ed); });
    })();
    updateEditorPreview(ed);
    // 元動画なし: 警告バナーを編集パネル先頭に出す（保存ボタンを押して初めてエラーになるのを防ぐ）
    if (!ed._inputExists) {
      const warn = document.createElement('div');
      warn.className = 'ed-warn-banner';
      warn.textContent = '⚠ 元動画ファイルが見つかりません（移動または削除された可能性）。閲覧・ダウンロードはできますが、編集の保存（再作成）はできません。';
      ed.insertBefore(warn, ed.firstChild);
    }
    ed.dataset.loaded = '1';
    // 最初のテロップ位置へ動画をseekして初期プレビューを表示
    if (ed._telops && ed._telops.length) {
      const v = _clipVideo(ed);
      if (v) {
        const seek = () => { try { v.currentTime = Math.max(0, ed._telops[0].start + 0.05); } catch (_) {} renderPreviewTelops(ed); };
        if (v.readyState >= 1) seek(); else v.addEventListener('loadedmetadata', seek, { once: true });
      }
    }
  } catch (e) {
    if (ed._loadGen !== gen) return;   // 後発の読込に切り替わっていたら何もしない
    ed.innerHTML = '<div class="ed-loading">読み込みに失敗しました</div>';
  }
}

// 編集UIの WYSIWYG プレビュー（タイトル＋字幕を実スタイルで表示・再描画前に確認）
function wireEditorPreview(ed) {
  const upd = () => updateEditorPreview(ed);
  const t = ed.querySelector('.ed-title');
  if (t) t.addEventListener('input', upd);
  ed.querySelectorAll('.ed-text').forEach(i => i.addEventListener('input', upd));
  ['.ed-capsz', '.ed-capol', '.ed-ttlsz', '.ed-ttlol', '.ed-ttlw', '.ed-shd', '.ed-sha', '.ed-shb'].forEach(s => {
    const e = ed.querySelector(s); if (e) e.addEventListener('input', upd);
  });
  const eCapw = ed.querySelector('.ed-capw');
  if (eCapw) eCapw.addEventListener('input', () => { updateEditorPreview(ed); renderPreviewTelops(ed); });
  const eAnim = ed.querySelector('.ed-anim');
  if (eAnim) eAnim.addEventListener('change', () => { updateEditorPreview(ed); renderPreviewTelops(ed, true); });
  const eAspd = ed.querySelector('.ed-aspd');
  if (eAspd) eAspd.addEventListener('input', () => renderPreviewTelops(ed, true));   // 速度変更は即再生
  const eEff = ed.querySelector('.ed-effect');
  if (eEff) eEff.addEventListener('change', () => { updateEditorPreview(ed); renderPreviewTelops(ed); applyEditorFx(ed); });
  const eExit = ed.querySelector('.ed-exit');
  if (eExit) eExit.addEventListener('change', upd);
  const eKara = ed.querySelector('.ed-kara');
  if (eKara) eKara.addEventListener('change', () => renderPreviewTelops(ed, true));
  // 動画の再生位置に同期してプレビューのテロップを更新（全変更を反映）。
  // 再生中: 焼き込み済みテロップは動画側に任せ、未保存の変更だけチップで重ねる
  // （renderPreviewTelops 内で判定）。タイトルチップも未変更なら再生中は隠す。
  const v = _clipVideo(ed);
  if (v && !v._edPreviewWired) {
    v._edPreviewWired = true;
    const _re = () => { const e = document.getElementById('detailEditor'); if (e && e.dataset.loaded) renderPreviewTelops(e); };
    v.addEventListener('timeupdate', _re);
    v.addEventListener('seeking', _re);
    v.addEventListener('play', () => { _syncTitleChipVis(ed); _re(); });
    v.addEventListener('pause', () => { _syncTitleChipVis(ed); _re(); });
  }
}

// ===== タイトルチップの再生中表示制御＋保存済み状態の管理 =====
// タイトルが「動画に焼き込み済みの状態」から変更されているか
function _titleDirty(ed) {
  const t0 = ed._title0 || {};
  const cur = ((ed.querySelector('.ed-title') || {}).value || '').trim();
  const sz = +((ed.querySelector('.ed-ttlsz') || {}).value) || 0;
  const w = +((ed.querySelector('.ed-ttlw') || {}).value) || 0;
  const p = ed._titlePos || {};
  return cur !== (t0.t || '') || sz !== (t0.sz || 0) || w !== (t0.w || 0)
    || Math.abs((p.x || 0) - (t0.x || 0)) > 0.001 || Math.abs((p.y || 0) - (t0.y || 0)) > 0.001;
}
// 再生中かつタイトル未変更 → チップを隠す（焼き込み済みの本物が見えるので二重にしない）
function _syncTitleChipVis(ed) {
  const f = _edFrame(ed); const ct = f && f.querySelector('.ed-ct'); if (!ct) return;
  if (ed._cleanPreview) { ct.style.display = ''; return; }   // クリーン土台=タイトルは常にチップで表示
  const v = _clipVideo(ed);
  const playing = v && !v.paused && !v.ended;
  ct.style.display = (playing && !_titleDirty(ed)) ? 'none' : '';
}
// 保存成功後: 現在の編集状態を「焼き込み済み」として記録（以後、再生中は同一内容のチップを隠す）
function _markSavedState(ed) {
  ed._telopsPristine = _subClone(ed._telops || []);
  ed._imagesPristine = (ed._images || []).map(_imgKey);   // 画像も「焼き込み済み」基準を更新
  ed._title0 = {
    t: ((ed.querySelector('.ed-title') || {}).value || '').trim(),
    sz: +((ed.querySelector('.ed-ttlsz') || {}).value) || 0,
    w: +((ed.querySelector('.ed-ttlw') || {}).value) || 0,
    x: (ed._titlePos || {}).x || 0.5, y: (ed._titlePos || {}).y || 0.16,
  };
  _syncTitleChipVis(ed);
}

// 実描画(_wrap_static)と同一の日本語折返し（jawrap.js＝captions.py の忠実移植・差分テスト済み）
// → プレビューの改行位置が焼き込みと完全一致する。
function _pvWrap(text, maxChars, maxLines) {
  if (window.jaWrapStatic) {
    const lines = window.jaWrapStatic(text, maxChars, maxLines);
    return lines.length ? lines : [''];
  }
  // フォールバック（jawrap.js 未読込時のみ・文字数詰め）
  const parts = String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return [''];
  const limit = parts.length > 1 ? Math.max(maxLines, Math.min(4, parts.length)) : maxLines;
  const lines = [];
  for (const part of parts) {
    let cur = '';
    for (const ch of Array.from(part)) {
      if (cur.length >= maxChars) { lines.push(cur); cur = ''; if (lines.length >= limit) break; }
      cur += ch;
    }
    if (cur && lines.length < limit) lines.push(cur);
    if (lines.length >= limit) break;
  }
  return lines.slice(0, limit);
}
function _pvWrapHtml(text, maxChars, maxLines) {
  return _pvWrap(text, maxChars, maxLines).map(esc).join('<br>');
}

function updateEditorPreview(ed) {
  const pv = ed._pv || {};
  const frame = _edFrame(ed);
  const ct = frame && frame.querySelector('.ed-ct');
  if (!ct || !frame) return;
  const sc = (frame.clientWidth || 230) / 1080;   // 出力(1080幅)→プレビュー比率＝実寸感
  const num = (sel, d) => { const e = ed.querySelector(sel); const n = e ? +e.value : NaN; return isNaN(n) ? d : n; };
  const ff = pv.font ? `'${pv.font}', sans-serif` : 'sans-serif';
  const titleTxt = ((ed.querySelector('.ed-title') || {}).value || '').trim() || 'タイトル';
  // タイトル（実描画と同じ文字数で折返し＝行数一致で位置一致）
  const ttlSz = num('.ed-ttlsz', 80);
  const ttlW = num('.ed-ttlw', 66) / 100;   // タイトル幅（実描画の title_width と一致→行数一致→位置一致）
  ct.innerHTML = _pvWrapHtml(titleTxt, Math.max(4, Math.floor(1080 * ttlW / ttlSz)), 2);
  ct.style.fontFamily = ff;
  ct.style.color = pv.title;
  ct.style.fontSize = Math.max(7, ttlSz * sc) + 'px';
  ct.style.webkitTextStroke = Math.max(0, num('.ed-ttlol', 8) * sc).toFixed(1) + 'px ' + pv.titleOut;
  ct.style.background = 'transparent'; ct.style.padding = '0';
  ct.style.textShadow = _pvShadow(ed, sc);
  // 折返し幅を破線の箱として可視化＝左右端ドラッグ（幅ハンドル）の手応えを見せる
  ct.style.width = (ttlW * 100) + '%';
  ct.style.maxWidth = 'none';
  ct.style.textAlign = 'center';
  _syncTitleChipVis(ed);   // 再生中でもタイトルを編集したら即チップを出す
  renderPreviewTelops(ed);   // 再生位置にアクティブな全テロップを実スタイルで表示
  applyEditorFx(ed);
}

// 再生位置にアクティブな全テロップを、各テロップの位置・スタイルで表示（個別ドラッグ可）
// replay=true でアニメを再生（アニメ変更時のみ。timeupdate では再生せずチラつき回避）
// opts.frame/opts.telops/opts.noDrag で 字幕調整モーダル（#subFrame・_subDraft・ドラッグ無し）にも流用。
// 影のCSS近似（ASSの Shadow=オフセット / BackColourα=不透明度 / \blur=ぼかし に対応）
function _pvShadow(ed, sc) {
  const g = s => { const e = ed.querySelector(s); return e ? +e.value : null; };
  const d = g('.ed-shd') != null ? g('.ed-shd') : 2;
  const a = (g('.ed-sha') != null ? g('.ed-sha') : 61) / 100;
  const b = g('.ed-shb') != null ? g('.ed-shb') : 0;
  if (d <= 0 && b <= 0) return 'none';
  return (d * sc).toFixed(1) + 'px ' + (d * sc).toFixed(1) + 'px '
    + (b * 2 * sc).toFixed(1) + 'px rgba(0,0,0,' + a.toFixed(2) + ')';
}

// テロップの内容キー（焼き込み済みかどうかの判定用。保存時点のスナップショットと比較）
function _tpKey(tp) {
  return JSON.stringify([+tp.start, +tp.end, tp.text || '', tp.style || '', !!tp.emphasis,
    tp.animation || '', +(tp.layer || 0),
    tp.font || '', tp.color || '', tp.outline_color || '', +(tp.size || 0), +(tp.width || 0), tp.effect || '', +(tp.anim_speed || 0),
    (tp.pos && tp.pos.x != null) ? [+(+tp.pos.x).toFixed(3), +(+tp.pos.y).toFixed(3)] : null]);
}

function renderPreviewTelops(ed, replay, opts) {
  opts = opts || {};
  const frame = opts.frame || _edFrame(ed);
  if (!frame) return;
  if (!opts.frame && ed._chipDragging) return;   // チップをドラッグ中に再生成するとドラッグが切れるためスキップ
  // 再生中: 動画に焼き込み済みのテロップは隠し（二重表示防止）、
  // まだ保存していない変更（追加・編集・移動）だけをチップで重ねて見せる。
  let burnedKeys = null;
  if (!opts.frame && !opts.force && !ed._cleanPreview) {   // クリーン土台なら常に全チップを描く
    const vp = _clipVideo(ed);
    if (vp && !vp.paused && !vp.ended) {
      burnedKeys = new Set((ed._telopsPristine || []).map(_tpKey));
    }
  }
  const telops = opts.telops || ed._telops || [];
  const noDrag = !!opts.noDrag;
  const clipAnim = ((ed.querySelector('.ed-anim') || {}).value) || 'default';
  frame.querySelectorAll('.ed-tel-chip').forEach(n => n.remove());
  const pv = ed._pv || {};
  const sc = (frame.clientWidth || 230) / 1080;
  const v = _clipVideo(ed);
  const t = v ? (v.currentTime || 0) : 0;
  const def = ed._capPos || { x: 0.5, y: 0.72 };
  const capSz = +((ed.querySelector('.ed-capsz') || {}).value) || 74;
  const capW = (+((ed.querySelector('.ed-capw') || {}).value) || 66) / 100;   // 字幕折返し幅（実描画と一致）
  const capOl = (() => { const e = ed.querySelector('.ed-capol'); const n = e ? +e.value : NaN; return isNaN(n) ? 6 : n; })();
  const clipSpd = ((+((ed.querySelector('.ed-aspd') || {}).value) || 100) / 100) || 1;   // アニメ速度
  const clipEff = ((ed.querySelector('.ed-effect') || {}).value) || 'none';
  const ff = pv.font ? `'${pv.font}', sans-serif` : 'sans-serif';
  const soff = +ed._subOffset || 0;   // 字幕タイミング（プレビューを実描画に合わせてずらす）
  const vPlaying = !!(v && !v.paused && !v.ended);
  // 表示開始時刻を記録＝時間窓に入った瞬間に入場アニメを再生し、直後の再描画でも
  // 負の animation-delay で続きから継続させる（timeupdate 再描画でアニメが消えない）。
  const nowMs = performance.now();
  const prevShownAt = (!opts.frame && ed._pvShownAt) || new Map();
  const shownAt = new Map();
  telops.forEach((tp, ti) => {
    if (!tp.text || !tp.text.trim()) return;
    if (!(tp.start + soff <= t + 0.02 && t < tp.end + soff)) return;   // アクティブなテロップのみ（offset反映）
    if (burnedKeys && burnedKeys.has(_tpKey(tp))) return;   // 再生中: 焼き込み済みは動画側に任せる
    const isNew = !prevShownAt.has(tp);
    // replay=アニメ変更時は時計をリセット＝直後の再描画（seek/timeupdate）でも最後まで再生される
    shownAt.set(tp, (isNew || replay) ? nowMs : prevShownAt.get(tp));
    const animAge = (nowMs - shownAt.get(tp)) / 1000;   // 表示されてからの秒数
    const elapsed = Math.max(0, t - (tp.start + soff));
    // 位置の既定値は実描画（build_ass）の既定と一致させる（強調=中央/アラート=上部バナー/笑い=右中段）
    const pos = tp.pos || (tp.emphasis ? { x: 0.5, y: 0.5 }
      : tp.style === 'alert' ? { x: 0.5, y: 0.33 }
      : tp.style === 'laugh' ? { x: 0.78, y: 0.45 }
      : tp.style === 'comment' ? { x: 0.5, y: 0.55 }
      : def);
    const chip = document.createElement('div');
    chip.className = 'ed-chip ed-wys ed-tel-chip';
    chip.dataset.ti = ti;
    chip.style.left = (pos.x * 100) + '%'; chip.style.top = (pos.y * 100) + '%';
    chip.style.zIndex = 10 + (tp.layer || 0);
    // テロップ個別スタイル（フォント/文字色/縁色/サイズ/エフェクト）。無指定はクリップ既定。
    chip.style.fontFamily = tp.font ? `'${tp.font}', sans-serif` : ff;
    const baseSz = (+tp.size > 0) ? Math.max(24, +tp.size) : capSz;
    let size = baseSz, color = tp.color || pv.sub;
    if (tp.emphasis) { size = baseSz * 1.5; color = tp.color || pv.emph || '#FFE600'; }
    else if (tp.style === 'laugh') { color = tp.color || '#27E36B'; }
    else if (tp.style === 'comment') { color = '#202020'; }
    // 折返し幅: 通常字幕は個別幅＞クリップの「字幕幅」、強調/特殊は既定0.66（実描画と同じ規則）
    const plain = !tp.style && !tp.emphasis;
    const wr = plain ? ((+tp.width > 0) ? Math.max(0.35, Math.min(0.95, +tp.width)) : capW) : 0.66;
    const maxCh = Math.max(4, Math.floor(1080 * wr / size));
    // カラオケ/1文字入場は常に文字spanで描画（経過時間ぶん負delay＝シーク位置でも途中経過が正しい）
    const karaOn = plain && !!(ed.querySelector('.ed-kara') || {}).checked;
    const spdT = (+tp.anim_speed > 0 ? +tp.anim_speed : clipSpd) || 1;   // 個別速度＞クリップ
    const effSel = tp.effect ? tp.effect : clipEff;                       // 個別エフェクト＞クリップ
    const chAnim = plain ? ((tp.animation || clipAnim) === 'stagger' ? 'stagger'
      : (tp.animation || clipAnim) === 'typewriter' ? 'typewriter' : '') : '';
    if (karaOn) {
      chip.style.setProperty('--pv-kara', pv.hl || '#FFE600');
      chip.innerHTML = _pvCharSpans(tp.text, maxCh, 2, 'karaoke', (tp.end - tp.start), replay ? 0 : elapsed, vPlaying || replay);
    } else if (chAnim) {
      chip.innerHTML = _pvCharSpans(tp.text, maxCh, 2, chAnim, (tp.end - tp.start), replay ? 0 : elapsed, vPlaying || replay, spdT);
    } else if (effSel === 'rainbow') {
      // 虹色ウェーブ: 文字ごとに位相をずらした虹サイクル（焼込み _rainbow_wave_text と同調）
      chip.innerHTML = _pvRainbowSpans(tp.text, maxCh, 2);
    } else {
      chip.innerHTML = _pvWrapHtml(tp.text, maxCh, 2);
    }
    chip.style.color = color;
    chip.style.fontSize = Math.max(7, size * sc) + 'px';
    if (tp.style !== 'comment') chip.style.textShadow = _pvShadow(ed, sc);
    if (plain && !pv.box) {   // 破線箱=折返し幅（左右端=幅・上下端=文字サイズ・角=両方）
      chip.style.width = (wr * 100) + '%';
      chip.style.maxWidth = 'none';
      chip.style.textAlign = 'center';
      chip.classList.add('ed-has-w');   // 左端の幅ハンドルを表示
      chip.title = 'ドラッグ=移動／左右端=幅／上下端=文字サイズ／角=サイズ＋幅（この字幕だけ）';
    }
    if (tp.style === 'comment') {
      chip.style.background = '#fff'; chip.style.padding = '2px 6px'; chip.style.borderRadius = '4px'; chip.style.webkitTextStroke = '0px transparent';
    } else if (pv.box && !tp.emphasis && !tp.style) {
      chip.style.background = hexToRgba(pv.boxColor, 0.5); chip.style.padding = '1px 5px'; chip.style.borderRadius = '4px'; chip.style.webkitTextStroke = '0px transparent';
    } else {
      chip.style.webkitTextStroke = Math.max(0, capOl * sc).toFixed(1) + 'px '
        + (tp.outline_color || (tp.emphasis ? '#000' : pv.out));
    }
    // エフェクト（テロップ個別＞クリップ既定）を静的に反映（入場アニメは付けずチラつき回避）
    _pvApplyEff(chip, effSel);
    // 入場アニメ: アニメ変更時（replay）と、時間窓に入った直後は再生。速度倍率で長さを変える。
    // 再描画で作り直されても animAge ぶん負のdelayを付けて「続きから」見せる（消えない）。
    if (!tp.emphasis) {
      const cfg = PV_ANIM[tp.animation || clipAnim] || PV_ANIM.default;
      const loop = cfg.iter === 'infinite';
      const durS = (cfg.dur || 0) / spdT;
      if (cfg.name && (loop || animAge < durS)) {
        chip.style.animation = `${cfg.name} ${durS.toFixed(3)}s ease-out ${cfg.iter || '1'} both`;
        if (animAge > 0) chip.style.animationDelay = (-animAge).toFixed(3) + 's';
      }
    }
    if (!noDrag) {
      // 下辺=文字サイズの見えるハンドル（掴み判定はチップ側のゾーンで行う＝装飾のみ）
      chip.insertAdjacentHTML('beforeend', '<span class="ed-h-b"></span>');
      _attachTelopChipDrag(ed, chip, ti);
    }
    frame.appendChild(chip);
  });
  if (!opts.frame) {
    ed._pvShownAt = shownAt;
    // 画像オーバーレイのチップも同じ再生位置で描画（字幕調整モーダル流用時は描かない）
    renderPreviewImages(ed, frame, t, vPlaying && !opts.force && !ed._cleanPreview);
  }
}
// ===== 画像オーバーレイ（動画に貼る画像）: アップロード→チップでドラッグ配置→保存で焼き込み =====
function _imgKey(im) {
  return JSON.stringify([im.file, +(+im.x).toFixed(3), +(+im.y).toFixed(3),
    +(+im.scale).toFixed(3), +(+im.start).toFixed(2), +(+im.end).toFixed(2),
    +((im.opacity == null ? 1 : im.opacity)).toFixed(2),
    im.anim_in || 'none', im.anim_out || 'none',
    +(+im.in_dur || 0).toFixed(2), +(+im.out_dur || 0).toFixed(2)]);
}
function edSyncImgCount(ed) {
  const c = ed.querySelector('.ed-img-count'); if (!c) return;
  const n = (ed._images || []).length;
  c.textContent = n ? (n + '枚（プレビュー上でドラッグ移動・右下グリップで拡縮・クリックで選択）') : '';
}
function edWireImages(ed) {
  const btn = ed.querySelector('.ed-img-add'), fi = ed.querySelector('.ed-img-file');
  if (!btn || !fi || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', () => fi.click());
  fi.addEventListener('change', async () => {
    const f = fi.files && fi.files[0]; fi.value = '';
    if (!f) return;
    const fd = new FormData(); fd.append('image', f);
    btn.disabled = true; btn.textContent = 'アップロード中...';
    try {
      const r = await fetch('/api/clip/' + ed.dataset.job + '/' + ed.dataset.cid + '/image',
        { method: 'POST', body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || '追加に失敗しました');
      const v = _clipVideo(ed); const t = v ? (v.currentTime || 0) : 0;
      edPushUndo(ed);
      const im = { uid: 'g' + (_uidN++), file: d.file, x: 0.5, y: 0.4, scale: 0.35,
        start: +Math.max(0, t).toFixed(2), end: +(ed._dur || 0).toFixed(2),
        opacity: 1, anim_in: 'none', anim_out: 'none', in_dur: 0.4, out_dur: 0.4, baked: false };
      (ed._images = ed._images || []).push(im);
      edSelectImg(ed, im.uid);
      edRenderImgBlocks(ed); renderPreviewTelops(ed); edSyncImgCount(ed);
      edSeekVideo(ed, im.start);   // 追加した画像が見える位置へ
    } catch (e) { alert('画像の追加に失敗しました: ' + e.message); }
    btn.disabled = false; btn.textContent = '＋画像を追加';
  });
}
// 画像編集パネルの実体（ポップアップへ移動しても追える参照）。
// モーダルは同じパネルDOMを body へ移して表示する＝配線・状態を二重管理しない。
function _imgPanelOf(ed) {
  return (ed._imgPanel && ed._imgPanel.isConnected) ? ed._imgPanel : ed.querySelector('.ed-sel-img');
}
function edOpenImgModal(ed, uid) {
  edSelectImg(ed, uid);   // パネルを対象画像で描画（再生位置は動かさない＝ユーザー確定仕様）
  const m = document.getElementById('imgEditModal');
  const body = document.getElementById('imgEditBody');
  const panel = _imgPanelOf(ed);
  if (!m || !body || !panel) return;
  body.appendChild(panel);   // パネルごと移設（リスナー維持）
  m.hidden = false;
}
function closeImgModal() {
  const m = document.getElementById('imgEditModal');
  if (m) m.hidden = true;
  const ed = document.getElementById('detailEditor');
  const panel = ed && _imgPanelOf(ed);
  if (ed && panel && !ed.contains(panel)) {
    const anchor = ed.querySelector('.ed-tl-colhead');
    if (anchor) ed.insertBefore(panel, anchor); else ed.appendChild(panel);
  }
}
function edRenderSelImg(ed) {
  const panel = _imgPanelOf(ed); if (!panel) return;
  const im = (ed._images || []).find(g => g.uid === ed._selImg);
  if (!im) {
    panel.hidden = true; panel.innerHTML = '';
    const m = document.getElementById('imgEditModal');
    if (m && !m.hidden) closeImgModal();   // 削除等で対象が消えたらポップアップも閉じる
    return;
  }
  panel.hidden = false;
  const IMG_IN_OPTS = [['none', 'なし'], ['fade', 'フェード'], ['zoom', 'ズーム'],
    ['left', '左から'], ['right', '右から'], ['top', '上から'], ['bottom', '下から']];
  const IMG_OUT_OPTS = [['none', 'なし'], ['fade', 'フェード'], ['zoom', 'ズーム'],
    ['left', '左へ'], ['right', '右へ'], ['top', '上へ'], ['bottom', '下へ']];
  panel.innerHTML =
    '<span class="ed-sel-cap">🖼 選択中の画像</span>' +
    '<label>表示開始<input class="ed-img-s" type="number" step="0.1" min="0" value="' + (+im.start).toFixed(1) + '"></label>' +
    '<label>表示終了<input class="ed-img-e" type="number" step="0.1" min="0" value="' + (+im.end).toFixed(1) + '"></label>' +
    '<label>大きさ <b class="ed-img-sc-o">' + Math.round(im.scale * 100) + '</b>%' +
      '<input type="range" class="ed-img-sc" min="5" max="100" step="1" value="' + Math.round(im.scale * 100) + '"></label>' +
    '<label>透明度 <b class="ed-img-op-o">' + Math.round((im.opacity == null ? 1 : im.opacity) * 100) + '</b>%' +
      '<input type="range" class="ed-img-op" min="5" max="100" step="5" value="' + Math.round((im.opacity == null ? 1 : im.opacity) * 100) + '"></label>' +
    '<label title="表示開始時のアニメーション（選ぶと開始位置から再生してプレビュー）">イン<select class="ed-img-fi">' + optionsHtml(IMG_IN_OPTS, im.anim_in || 'none') + '</select></label>' +
    '<label title="表示終了時のアニメーション（選ぶと終了際から再生してプレビュー）">アウト<select class="ed-img-fo">' + optionsHtml(IMG_OUT_OPTS, im.anim_out || 'none') + '</select></label>' +
    '<button type="button" class="mini-btn ed-img-rembg" title="AIで背景を自動で透過します（初回はモデルの取得で1〜2分かかることがあります）">✨AI透過</button>' +
    '<button type="button" class="mini-btn ed-img-del">削除</button>';
  if (!panel.dataset.wired) {
    panel.dataset.wired = '1';
    panel.addEventListener('input', e => {
      const g = (ed._images || []).find(x => x.uid === ed._selImg); if (!g) return;
      if (e.target.classList.contains('ed-img-s')) {
        edPushUndo(ed, 'imgs' + g.uid);
        g.start = edClamp(+e.target.value || 0, 0, ed._dur || 0);
        edRenderImgBlocks(ed); edSeekVideo(ed, g.start);
      } else if (e.target.classList.contains('ed-img-e')) {
        edPushUndo(ed, 'imge' + g.uid);
        g.end = edClamp(+e.target.value || 0, 0, ed._dur || 0);
        edRenderImgBlocks(ed); edSeekVideo(ed, Math.max(0, g.end - 0.05));
      } else if (e.target.classList.contains('ed-img-sc')) {
        edPushUndo(ed, 'imgsc' + g.uid);
        g.scale = (+e.target.value || 35) / 100;
        const o = panel.querySelector('.ed-img-sc-o'); if (o) o.textContent = e.target.value;
        renderPreviewTelops(ed);
      } else if (e.target.classList.contains('ed-img-op')) {
        edPushUndo(ed, 'imgop' + g.uid);
        g.opacity = (+e.target.value || 100) / 100;
        const o = panel.querySelector('.ed-img-op-o'); if (o) o.textContent = e.target.value;
        renderPreviewTelops(ed);
      }
    });
    panel.addEventListener('change', e => {
      const g = (ed._images || []).find(x => x.uid === ed._selImg); if (!g) return;
      const v = _clipVideo(ed);
      if (e.target.classList.contains('ed-img-fi')) {
        edPushUndo(ed); g.anim_in = e.target.value || 'none';
        // 開始直前から再生してアニメをその場でプレビュー
        edSeekVideo(ed, Math.max(0, g.start - 0.1));
        if (v && g.anim_in !== 'none') v.play().catch(() => {});
      } else if (e.target.classList.contains('ed-img-fo')) {
        edPushUndo(ed); g.anim_out = e.target.value || 'none';
        edSeekVideo(ed, Math.max(0, g.end - (g.out_dur || 0.4) - 0.3));
        if (v && g.anim_out !== 'none') v.play().catch(() => {});
      }
    });
    panel.addEventListener('click', async e => {
      const g = (ed._images || []).find(x => x.uid === ed._selImg); if (!g) return;
      if (e.target.classList.contains('ed-img-del')) {
        edPushUndo(ed);
        ed._images = (ed._images || []).filter(x => x.uid !== g.uid); ed._selImg = null;
        edRenderImgBlocks(ed); edRenderSelImg(ed); renderPreviewTelops(ed); edSyncImgCount(ed);
      } else if (e.target.classList.contains('ed-img-rembg')) {
        // AI自動透過（rembg・背景除去）。元ファイルは残し新PNGへ差し替え＝Undoで戻せる。
        e.target.disabled = true; e.target.textContent = 'AI透過中...';
        try {
          const r = await fetch('/api/clip/' + ed.dataset.job + '/' + ed.dataset.cid + '/image_removebg',
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: g.file }) });
          const d = await r.json();
          if (!r.ok) throw new Error(d.detail || '失敗しました');
          edPushUndo(ed);
          g.file = d.file;
          edRenderImgBlocks(ed); renderPreviewTelops(ed);
        } catch (err) { alert('AI透過に失敗しました: ' + err.message); }
        edRenderSelImg(ed);
      }
    });
  }
}
// 再生位置にアクティブな画像チップを描画。再生中は焼き込み済み（保存時と同一内容）を隠す
// ＝テロップ(_telopsPristine)と同じ「焼込み済みは動画に任せ、未保存分だけ重ねる」パターン。
// ===== 中央ガイド線（ドラッグ中、中心付近で赤い線を出して吸着） =====
function _edEnsureGuides(frame) {
  if (!frame.querySelector('.ed-guide-v')) {
    frame.insertAdjacentHTML('beforeend',
      '<div class="ed-guide ed-guide-v" hidden></div><div class="ed-guide ed-guide-h" hidden></div>');
  }
}
// ドラッグ中の正規化座標 (x,y) を評価し、中央±2%なら吸着して該当ガイド線を表示。
// 戻り値は吸着後の座標。ドラッグ終了時は _edGuideHide で必ず消すこと。
function _edGuideSnap(frame, x, y) {
  _edEnsureGuides(frame);
  const thr = 0.02;
  const sx = Math.abs(x - 0.5) < thr;
  const sy = Math.abs(y - 0.5) < thr;
  const gv = frame.querySelector('.ed-guide-v'), gh = frame.querySelector('.ed-guide-h');
  if (gv) gv.hidden = !sx;
  if (gh) gh.hidden = !sy;
  return { x: sx ? 0.5 : x, y: sy ? 0.5 : y };
}
function _edGuideHide(frame) {
  if (frame) frame.querySelectorAll('.ed-guide').forEach(g => { g.hidden = true; });
}

// 画像チップのスタイルを再生位置 t で評価して適用（イン/アウトアニメ・透明度）。
// 焼込み側 overlay_images の式と同じモデル＝シークで途中経過・再生で実際に動く。
function _applyImgChipStyle(ed, el, im, t) {
  const ai = im.anim_in || 'none', ao = im.anim_out || 'none';
  const di = +im.in_dur || 0.4, doo = +im.out_dur || 0.4;
  const p = (ai !== 'none') ? Math.max(0, Math.min(1, (t - im.start) / di)) : 1;   // 入場進行 0→1
  const q = (ao !== 'none') ? Math.max(0, Math.min(1, (im.end - t) / doo)) : 1;    // 退場残り 1→0
  let alpha = (im.opacity == null ? 1 : im.opacity);
  let wPct = im.scale, offX = 0, offY = 0;
  const applyOff = (anim, f) => {   // f=画面外への係数（0=定位置・1=画面外）
    if (anim === 'left') offX -= (im.x + im.scale / 2) * f;
    else if (anim === 'right') offX += (1 - im.x + im.scale / 2) * f;
    else if (anim === 'top') offY -= (im.y + im.scale * 0.5) * f;
    else if (anim === 'bottom') offY += (1 - im.y + im.scale * 0.5) * f;
  };
  applyOff(ai, 1 - p); applyOff(ao, 1 - q);
  if (ai === 'fade') alpha *= p;
  if (ao === 'fade') alpha *= q;
  if (ai === 'zoom') wPct *= Math.max(0.02, p);
  if (ao === 'zoom') wPct *= Math.max(0.02, q);
  el.style.left = ((im.x + offX) * 100) + '%'; el.style.top = ((im.y + offY) * 100) + '%';
  el.style.width = (wPct * 100) + '%';
  el.style.opacity = String(alpha);
  el.classList.toggle('sel', im.uid === ed._selImg);
  // AI透過などでファイルが差し替わったら画像も更新
  const img = el.querySelector('img');
  if (img && img.src.indexOf(im.file) < 0) {
    img.src = apiUrl('/api/download/' + ed.dataset.job + '/' + im.file);
  }
}
function _mkImgChip(ed, im) {
  const el = document.createElement('div');
  el.className = 'ed-img-chip';
  el.dataset.uid = im.uid;
  el.innerHTML = '<img src="' + apiUrl('/api/download/' + ed.dataset.job + '/' + esc(im.file)) + '" draggable="false" alt="">';
  el.title = 'ドラッグ=移動／右下グリップ=大きさ／ダブルクリック=編集';
  _attachImgChipDrag(ed, el, im.uid);
  return el;
}
// 差分更新方式: <img> を毎回作り直すとチラつく＆重いため、既存チップは更新・不要は削除・新規のみ追加。
// 再生中は rAF（edWirePlayheadSync）から毎フレーム呼ばれ、アニメが滑らかに動く。
function renderPreviewImages(ed, frame, t, playing) {
  const burned = playing ? new Set(ed._imagesPristine || []) : null;
  const want = new Map();
  (ed._images || []).forEach(im => {
    if (!(im.start <= t + 0.02 && t < im.end)) return;
    if (burned && burned.has(_imgKey(im))) return;
    want.set(im.uid, im);
  });
  frame.querySelectorAll('.ed-img-chip').forEach(n => {
    const im = want.get(n.dataset.uid);
    if (!im) { n.remove(); return; }
    _applyImgChipStyle(ed, n, im, t);
    want.delete(n.dataset.uid);
  });
  want.forEach(im => {
    const el = _mkImgChip(ed, im);
    _applyImgChipStyle(ed, el, im, t);
    frame.appendChild(el);
  });
}
function _attachImgChipDrag(ed, el, uid) {
  // チップは差分更新で使い回されるため、対象は uid で毎回引き直す（Undo等で配列が入れ替わっても安全）
  const frame = _edFrame(ed);
  const imOf = () => (ed._images || []).find(g => g.uid === uid);
  let dragging = false, resizing = false, rz = null;
  el.addEventListener('pointerdown', e => {
    const im = imOf(); if (!im) return;
    // ダブルクリック（350ms以内の2度目）＝ポップアップ編集を開く。
    // pointerdown で preventDefault するため dblclick イベントは飛ばない→自前判定。
    const now = performance.now();
    if (el._dblT && now - el._dblT < 350) {
      el._dblT = 0;
      e.preventDefault(); e.stopPropagation();
      edOpenImgModal(ed, uid);
      return;
    }
    el._dblT = now;
    edSelectImg(ed, uid);   // レーンブロックの選択表示も同期
    const r = el.getBoundingClientRect();
    const inGrip = (e.clientX > r.right - 18 && e.clientY > r.bottom - 18);
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault(); e.stopPropagation();
    ed._chipDragging = true;   // 再生中の timeupdate 再描画でチップが破棄されるのを防ぐ
    edPushUndo(ed, 'img' + uid);
    if (inGrip) {
      resizing = true;
      rz = { cx: r.left + r.width / 2, cy: r.top + r.height / 2,
             d0: Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) || 1,
             s0: im.scale };
    } else { dragging = true; }
  });
  el.addEventListener('pointermove', e => {
    const im = imOf(); if (!im) return;
    if (resizing) {
      const d = Math.hypot(e.clientX - rz.cx, e.clientY - rz.cy);
      im.scale = Math.max(0.05, Math.min(1, rz.s0 * Math.max(0.2, Math.min(4, d / rz.d0))));
      el.style.width = (im.scale * 100) + '%';
    } else if (dragging) {
      const r = frame.getBoundingClientRect();
      let x = Math.max(0.02, Math.min(0.98, (e.clientX - r.left) / r.width));
      let y = Math.max(0.02, Math.min(0.98, (e.clientY - r.top) / r.height));
      const g = _edGuideSnap(frame, x, y); x = g.x; y = g.y;   // 中央ガイド＋吸着
      im.x = +x.toFixed(3); im.y = +y.toFixed(3);
      el.style.left = (x * 100) + '%'; el.style.top = (y * 100) + '%';
    }
  });
  const up = e => {
    if (!dragging && !resizing) return;
    dragging = false; resizing = false; ed._chipDragging = false;
    _edGuideHide(frame);
    try { el.releasePointerCapture(e.pointerId); } catch (_) {}
    edRenderSelImg(ed);
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

function _attachTelopChipDrag(ed, chip, ti) {
  // サイズ変更はすべて「この字幕1つだけ」に効く（tp.size / tp.width）。
  // ゾーン: 角=サイズ＋幅を同時に拡縮／左右の辺=幅（折返し幅・通常字幕のみ）／
  //         上下の辺=文字サイズ／それ以外=移動。ユーザー確定仕様。
  const frame = _edFrame(ed);
  let mode = null, rz = null;   // 'move' | 'both' | 'size' | 'width'
  chip.addEventListener('pointerdown', e => {
    const r = chip.getBoundingClientRect();
    const tp = ed._telops[ti]; if (!tp) return;
    const plain = !tp.style && !tp.emphasis;
    const edge = Math.min(14, Math.max(6, r.width * 0.15));   // 小さいチップでも移動域を残す
    const nearL = e.clientX < r.left + edge, nearR = e.clientX > r.right - edge;
    const nearT = e.clientY < r.top + edge, nearB = e.clientY > r.bottom - edge;
    try { chip.setPointerCapture(e.pointerId); } catch (_) {} e.preventDefault();
    ed._chipDragging = true;   // 再生中の timeupdate 再描画でドラッグ中のチップが破棄されるのを防ぐ
    const capSz0 = +((ed.querySelector('.ed-capsz') || {}).value) || 74;
    const capW0 = (+((ed.querySelector('.ed-capw') || {}).value) || 66) / 100;
    rz = {
      cx: r.left + r.width / 2, cy: r.top + r.height / 2,
      d0: Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) || 1,
      h0: Math.max(8, r.height),
      s0: (+tp.size > 0) ? +tp.size : capSz0,
      w0: (+tp.width > 0) ? +tp.width : capW0,
      plain,
    };
    if ((nearL || nearR) && (nearT || nearB)) mode = 'both';
    else if (plain && (nearL || nearR)) mode = 'width';
    else if (nearT || nearB) mode = 'size';
    else mode = 'move';
    if (mode !== 'move') edPushUndo(ed, 'chip' + ti);
  });
  chip.addEventListener('pointermove', e => {
    if (!mode) return;
    const tp = ed._telops[ti]; if (!tp) return;
    const sc = (frame.clientWidth || 230) / 1080;
    const applySize = () => {
      chip.style.fontSize = Math.max(7, tp.size * (tp.emphasis ? 1.5 : 1) * sc) + 'px';
    };
    if (mode === 'both') {
      // 角: 文字サイズと幅を同率で拡縮（1行の文字数が保たれ、改行位置が変わらない）
      const ratio = Math.max(0.35, Math.min(3, Math.hypot(e.clientX - rz.cx, e.clientY - rz.cy) / rz.d0));
      tp.size = Math.max(24, Math.min(200, Math.round(rz.s0 * ratio / 2) * 2));
      applySize();
      if (rz.plain) {
        tp.width = +Math.max(0.35, Math.min(0.95, rz.w0 * ratio)).toFixed(3);
        chip.style.width = (tp.width * 100) + '%';
      }
    } else if (mode === 'size') {
      // 上下の辺: 文字サイズのみ（中心からの縦距離×2÷元の高さ＝倍率）
      const ratio = Math.max(0.35, Math.min(3, (Math.abs(e.clientY - rz.cy) * 2) / rz.h0));
      tp.size = Math.max(24, Math.min(200, Math.round(rz.s0 * ratio / 2) * 2));
      applySize();
    } else if (mode === 'width') {
      // 左右の辺: 折返し幅のみ（広げれば「勝手な改行」を減らせる）
      const fr = frame.getBoundingClientRect();
      const pos = tp.pos || ed._capPos || { x: 0.5, y: 0.72 };
      const centerX = fr.left + pos.x * fr.width;
      tp.width = +Math.max(0.35, Math.min(0.95, (Math.abs(e.clientX - centerX) * 2) / fr.width)).toFixed(3);
      chip.style.width = (tp.width * 100) + '%';
    } else {   // move
      const r = frame.getBoundingClientRect();
      let x = Math.max(0.03, Math.min(0.97, (e.clientX - r.left) / r.width));
      let y = Math.max(0.03, Math.min(0.97, (e.clientY - r.top) / r.height));
      const g = _edGuideSnap(frame, x, y); x = g.x; y = g.y;   // 中央ガイド＋吸着
      chip.style.left = (x * 100) + '%'; chip.style.top = (y * 100) + '%';
      tp.pos = { x: +x.toFixed(3), y: +y.toFixed(3) };
    }
  });
  const up = e => {
    if (!mode) return;
    const redo = mode !== 'move';
    mode = null; ed._chipDragging = false;
    _edGuideHide(frame);
    try { chip.releasePointerCapture(e.pointerId); } catch (_) {}
    if (redo) {
      renderPreviewTelops(ed);   // サイズ/幅確定後に全チップを正しい折返しで再描画
      edRenderSelTelop(ed);      // 選択中パネルの数値（サイズ/幅）も追従
    }
  };
  chip.addEventListener('pointerup', up);
  chip.addEventListener('pointercancel', up);
}

// 画面構成プレビュー: レターボックス時に上下の帯を色付きで表示（近似・色確認用）
function _updateLetterboxBand(ed) {
  const frame = _edFrame(ed);
  if (!frame) return;
  if (!frame.querySelector('.ed-lb-top')) {
    const t = document.createElement('div'); t.className = 'ed-lb-band ed-lb-top'; frame.appendChild(t);
    const b = document.createElement('div'); b.className = 'ed-lb-band ed-lb-bot'; frame.appendChild(b);
  }
  const on = ed._reframe === 'letterbox';
  frame.querySelectorAll('.ed-lb-band').forEach(b => {
    b.style.display = on ? 'block' : 'none'; b.style.background = ed._lbColor || '#000';
  });
}
function wireReframe(ed) {
  const rf = ed.querySelector('.ed-reframe');
  if (rf) rf.addEventListener('change', () => {
    ed._reframe = rf.value;
    const f = ed.querySelector('.ed-lb-field'); if (f) f.style.display = (rf.value === 'letterbox') ? '' : 'none';
    _updateLetterboxBand(ed);
  });
  const lb = ed.querySelector('.ed-lb-color');
  if (lb) lb.addEventListener('input', () => { ed._lbColor = lb.value; _updateLetterboxBand(ed); });
  _updateLetterboxBand(ed);
}

/* ===== テロップ複製ユーティリティ ===== */
function _subClone(arr) {
  return (arr || []).map(t => ({
    start: +t.start || 0, end: +t.end || 0, text: t.text || '',
    style: t.style || '', emphasis: !!t.emphasis, animation: t.animation || '',
    font: t.font || '', color: t.color || '', outline_color: t.outline_color || '',
    size: +t.size || 0, width: +t.width || 0, effect: t.effect || '', anim_speed: +t.anim_speed || 0,
    layer: +t.layer || 0, pos: (t.pos && t.pos.x != null) ? { x: +t.pos.x, y: +t.pos.y } : null,
  }));
}

function applyEditorFx(ed) {
  const a = (ed.querySelector('.ed-anim') || {}).value || 'default';
  const e = (ed.querySelector('.ed-effect') || {}).value || 'none';
  const cfg = PV_ANIM[a] || PV_ANIM.default;
  // タイトルに入場アニメ＋エフェクト（テロップチップは renderPreviewTelops が静的に装飾）
  const _fr = _edFrame(ed);
  const el = _fr && _fr.querySelector('.ed-ct');
  if (el) {
    _pvApplyEff(el, e);
    el.style.animation = 'none';
    void el.offsetWidth;
    if (e === 'horror') el.style.animation = 'pvShake .45s linear infinite';
    else if (cfg.name) el.style.animation = `${cfg.name} ${cfg.dur}s ease-out ${cfg.iter || '1'} both`;
  }
}

function initPosEditor(ed) {
  const frame = _edFrame(ed);
  if (!frame) return;
  frame.querySelectorAll('.ed-chip').forEach(chip => {
    const isTitle = chip.classList.contains('ed-ct');
    let dragging = false, resizing = false, widthing = false, rz = null;
    const move = (cx, cy) => {
      const r = frame.getBoundingClientRect();
      let x = Math.max(0.03, Math.min(0.97, (cx - r.left) / r.width));
      let y = Math.max(0.03, Math.min(0.97, (cy - r.top) / r.height));
      const g = _edGuideSnap(frame, x, y); x = g.x; y = g.y;   // 中央ガイド＋吸着
      chip.style.left = (x * 100) + '%'; chip.style.top = (y * 100) + '%';
      const pos = { x: +x.toFixed(3), y: +y.toFixed(3) };
      if (isTitle) ed._titlePos = pos; else ed._capPos = pos;
    };
    // タイトルの左右端をドラッグ＝折返し幅（タイトル幅スライダー）を直接調整
    const widthResize = (cx) => {
      const fr = frame.getBoundingClientRect();
      const centerX = fr.left + (((ed._titlePos || {}).x != null ? ed._titlePos.x : 0.5) * fr.width);
      const ratio = Math.max(0.35, Math.min(0.95, (Math.abs(cx - centerX) * 2) / fr.width));
      const wInp = ed.querySelector('.ed-ttlw'); if (!wInp) return;
      const pct = Math.round(ratio * 100);
      if (+wInp.value === pct) return;
      wInp.value = pct;
      const wo = ed.querySelector('.ed-ttlw-o'); if (wo) wo.textContent = pct;
      updateEditorPreview(ed);
    };
    // タイトルは端(右下グリップ)を掴むと拡縮＝文字サイズ＋縁取りを連動更新
    const resize = (cx, cy) => {
      const d = Math.hypot(cx - rz.cx, cy - rz.cy);
      const ratio = Math.max(0.35, Math.min(3, d / rz.d0));
      const szInp = ed.querySelector(rz.szSel), olInp = ed.querySelector(rz.olSel);
      const step = +szInp.step || 1;
      let ns = Math.round((rz.s0 * ratio) / step) * step;
      ns = Math.max(+szInp.min, Math.min(+szInp.max, ns));
      szInp.value = ns;
      let no = Math.round(rz.o0 * ns / (rz.s0 || 1));
      no = Math.max(+olInp.min, Math.min(+olInp.max, no));
      olInp.value = no;
      const so = ed.querySelector(rz.szSel + '-o'); if (so) so.textContent = ns;
      const oo = ed.querySelector(rz.olSel + '-o'); if (oo) oo.textContent = no;
      updateEditorPreview(ed);
    };
    chip.addEventListener('pointerdown', e => {
      const r = chip.getBoundingClientRect();
      const inGrip = (e.clientX > r.right - 20 && e.clientY > r.bottom - 20);
      const onSide = isTitle && !inGrip
        && (e.clientX < r.left + 14 || e.clientX > r.right - 14);   // 左右端＝幅ハンドル
      try { chip.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
      if (onSide) { widthing = true; return; }
      if (inGrip) {
        resizing = true;
        rz = {
          cx: r.left + r.width / 2, cy: r.top + r.height / 2,
          d0: Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) || 1,
          szSel: isTitle ? '.ed-ttlsz' : '.ed-capsz', olSel: isTitle ? '.ed-ttlol' : '.ed-capol',
        };
        rz.s0 = +ed.querySelector(rz.szSel).value; rz.o0 = +ed.querySelector(rz.olSel).value;
      } else { dragging = true; }
    });
    chip.addEventListener('pointermove', e => {
      if (resizing) resize(e.clientX, e.clientY);
      else if (widthing) widthResize(e.clientX);
      else if (dragging) move(e.clientX, e.clientY);
    });
    const up = e => { dragging = false; resizing = false; widthing = false; _edGuideHide(frame); try { chip.releasePointerCapture(e.pointerId); } catch (_) {} };
    chip.addEventListener('pointerup', up);
    chip.addEventListener('pointercancel', up);
  });
  const bind = (sel, out) => {
    const i = ed.querySelector(sel), o = ed.querySelector(out);
    if (i && o) i.addEventListener('input', () => { o.textContent = i.value; });
  };
  bind('.ed-capsz', '.ed-capsz-o'); bind('.ed-ttlsz', '.ed-ttlsz-o');
  bind('.ed-capol', '.ed-capol-o'); bind('.ed-ttlol', '.ed-ttlol-o');
  bind('.ed-ttlw', '.ed-ttlw-o'); bind('.ed-capw', '.ed-capw-o');
  bind('.ed-shd', '.ed-shd-o'); bind('.ed-sha', '.ed-sha-o'); bind('.ed-shb', '.ed-shb-o');
  bind('.ed-aspd', '.ed-aspd-o');
}

function resetPos(btn) {
  const ed = btn.closest('.clip-editor');
  ed._titlePos = { x: 0.5, y: 0.16 }; ed._capPos = { x: 0.5, y: 0.72 };
  (ed._telops || []).forEach(tp => { tp.pos = null; });   // テロップ位置も既定に戻す
  const _fr = _edFrame(ed);
  const t = _fr && _fr.querySelector('.ed-ct');
  if (t) { t.style.left = '50%'; t.style.top = '16%'; }
  renderPreviewTelops(ed);
}

// 編集UIの入力をまとめて /api/clip 用ペイロードに（saveClip/saveDetail で共有）
function _editorPayload(ed) {
  const title = ed.querySelector('.ed-title').value;
  const telops = (ed._telops || []).map(tp => {
    const o = { start: tp.start, end: tp.end, text: tp.text };
    if (tp.style) o.style = tp.style;            // alert/laugh/comment
    if (tp.emphasis) o.emphasis = true;
    if (tp.animation) o.animation = tp.animation;
    // テロップ個別スタイル（無指定は送らない＝クリップ既定に従う）
    if (tp.font) o.font = tp.font;
    if (tp.color) o.color = tp.color;
    if (tp.outline_color) o.outline_color = tp.outline_color;
    if (tp.size) o.size = tp.size;
    if (tp.width) o.width = +(+tp.width).toFixed(3);
    if (tp.effect) o.effect = tp.effect;         // 'none' も明示指定として送る
    if (tp.anim_speed) o.anim_speed = tp.anim_speed;
    if (tp.layer) o.layer = tp.layer;
    if (tp.pos && tp.pos.x != null) o.pos = { x: tp.pos.x, y: tp.pos.y };
    return o;
  });
  const style = {};
  // NaN は JSON で null になりサーバ側で無視される（＝設定が反映されない）ため必ず数値のみ送る
  const q = (sel, key) => { const e = ed.querySelector(sel); if (e) { const n = +e.value; if (!isNaN(n)) style[key] = n; } };
  q('.ed-capsz', 'caption_size'); q('.ed-ttlsz', 'title_size');
  q('.ed-capol', 'outline_width'); q('.ed-ttlol', 'title_outline_width');
  const tw = ed.querySelector('.ed-ttlw'); if (tw) style.title_width = (+tw.value || 66) / 100;   // タイトル幅（%→比率）
  const cw = ed.querySelector('.ed-capw'); if (cw) style.caption_width = (+cw.value || 66) / 100; // 字幕幅（%→比率）
  const sd = ed.querySelector('.ed-shd'); if (sd) style.shadow_depth = +sd.value;                 // 影の濃さ
  const sa = ed.querySelector('.ed-sha'); if (sa) style.shadow_alpha = (+sa.value) / 100;         // 影の不透明度
  const sb = ed.querySelector('.ed-shb'); if (sb) style.shadow_blur = +sb.value;                  // 影のぼかし
  const qs = (sel, key) => { const e = ed.querySelector(sel); if (e) style[key] = e.value; };
  qs('.ed-anim', 'animation'); qs('.ed-effect', 'effect'); qs('.ed-exit', 'exit_animation');
  const asp = ed.querySelector('.ed-aspd'); if (asp) style.animation_speed = (+asp.value || 100) / 100;   // アニメ速度
  const kc = ed.querySelector('.ed-kara'); if (kc) style.karaoke = !!kc.checked;   // 単語カラオケ
  const num = sel => { const e = ed.querySelector(sel); return e ? (+e.value || 0) : 0; };
  const out = {
    title, telops, style,
    caption_pos: ed._capPos, title_pos: ed._titlePos,
    extend_start: num('.ed-ext-s'), extend_end: num('.ed-ext-e'),
    // 画像オーバーレイ（貼り付け画像）の配置
    images: (ed._images || []).map(im => ({ file: im.file, x: im.x, y: im.y,
      scale: im.scale, start: im.start, end: im.end,
      opacity: im.opacity == null ? 1 : im.opacity,
      anim_in: im.anim_in || 'none', anim_out: im.anim_out || 'none',
      in_dur: im.in_dur || 0.4, out_dur: im.out_dur || 0.4 })),
  };
  const rf = ed.querySelector('.ed-reframe'); if (rf) out.reframe = rf.value;          // 画面構成
  const lb = ed.querySelector('.ed-lb-color'); if (lb) out.letterbox_color = lb.value;  // 帯の色
  if (ed._subOffset != null) out.sub_offset = +ed._subOffset || 0;                     // 字幕タイミング
  return out;
}
async function saveClip(btn) {
  const ed = btn.closest('.clip-editor');
  const job = ed.dataset.job, cid = ed.dataset.cid;
  const p = _editorPayload(ed);
  const reload = !!(p.extend_start || p.extend_end);
  const st = ed.querySelector('.ed-status');
  st.textContent = reload ? 'AI再調整して再作成中...' : '再作成中...';
  btn.disabled = true;
  const cap = _vCaps(_clipVideo(ed));   // 再作成前に解放（WinError5対策）
  _vRelease(cap);
  try {
    const resp = await fetch('/api/clip/' + job + '/' + cid, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || '失敗しました');
    _vRestore(cap, job, cid);
    const newTitle = data.title || p.title;
    const card = ed.closest('.clip-card');
    if (card) {
      card.querySelector('.clip-title').textContent = cid + '. ' + (newTitle || '無題');
    } else {
      document.getElementById('detailTitle').textContent = cid + '. ' + (newTitle || '無題');
      const gc = _bustGridCard(job, cid);
      if (gc) gc.querySelector('.clip-title').textContent = cid + '. ' + (newTitle || '無題');
    }
    st.textContent = data.warning ? ('✓ 更新（' + data.warning + '）') : '✓ 更新しました';
    _markSavedState(ed);   // 現在の編集内容＝焼き込み済み（再生中の二重表示防止の基準を更新）
    // 保存後は必ずサーバの実データから再読込（画面と保存値のズレを根絶）
    ed.dataset.loaded = ''; loadEditor(ed);
  } catch (e) {
    _vRestore(cap, job, cid);   // 失敗時もプレビューを復帰
    st.textContent = 'エラー: ' + e.message;
  }
  btn.disabled = false;
}

// ===== 効果音 共通ユーティリティ（一覧キャッシュ・試聴） =====
let _sfxListCache = null;
let _uidN = 1;
let _tlAudio = null;   // 試聴用 <audio> は1つだけ使い回す
async function getSfxList() {
  if (!_sfxListCache) _sfxListCache = await (await fetch('/api/sfx')).json();
  return _sfxListCache;
}
function _auditionSfx(meta, gain) {
  // meta は効果音メタ（{src, file, ...}）。src があればそれを、無ければ同梱 /sfx/ を使う。
  const url = meta && (meta.src || (meta.file ? '/sfx/' + encodeURIComponent(meta.file) : ''));
  if (!url) return;
  if (!_tlAudio) _tlAudio = new Audio();
  if (_tlAudio.src.indexOf(url) < 0) _tlAudio.src = url;
  _tlAudio.volume = Math.max(0, Math.min(1, gain));   // <audio>.volume は最大1（>1はffmpeg側で適用）
  try { _tlAudio.currentTime = 0; } catch (_) {}
  _tlAudio.play().catch(() => {});
}
// ===== 全クリップ一括スタイル適用 =====
function bulkStyleFromCreate() {
  const v = id => { const e = document.getElementById(id); return e ? e.value : ''; };
  const animV = v('animSelect');
  return {
    font: v('fontSelect'),
    subtitle_color: v('cSub'),
    highlight_color: v('cHi'),
    emphasis_color: v('cHi'),
    outline_color: v('cOut'),
    title_color: v('cTitle'),
    title_outline_color: v('cOut'),
    caption_size: +v('capSize'),
    title_size: +v('titleSize'),
    outline_width: +v('capOutline'),
    title_outline_width: +v('titleOutline'),
    box: document.getElementById('boxOn').checked,
    box_color: v('cBox'),
    box_pad: +v('boxPad'),
    animate: animV !== 'none',
    animation: animV,
    effect: _effSel(),
    exit_animation: v('exitSelect') || 'none',
    karaoke: !!(document.getElementById('karaOn') || {}).checked,
    shadow_depth: +v('shadowD'),
    shadow_alpha: (+v('shadowA') || 0) / 100,
    shadow_blur: +v('shadowB'),
  };
}

function updateBulkPreview() {
  const t = document.getElementById('bulkPvTitle'), c = document.getElementById('bulkPvCap');
  if (!t || !c) return;
  const s = bulkStyleFromCreate();
  const ff = s.font ? `'${s.font}', sans-serif` : 'sans-serif';
  t.textContent = 'タイトル';
  t.style.fontFamily = ff; t.style.color = s.title_color;
  t.style.fontSize = Math.max(13, Math.min(40, s.title_size * 0.32)) + 'px';
  t.style.webkitTextStroke = (s.title_outline_width * 0.45).toFixed(1) + 'px ' + s.outline_color;
  c.textContent = '字幕プレビュー';
  c.style.fontFamily = ff; c.style.color = s.subtitle_color;
  c.style.fontSize = Math.max(12, Math.min(34, s.caption_size * 0.32)) + 'px';
  if (s.box) {
    c.style.background = hexToRgba(s.box_color, 0.5); c.style.padding = '2px 8px';
    c.style.borderRadius = '5px'; c.style.webkitTextStroke = '0px transparent';
  } else {
    c.style.background = 'transparent'; c.style.padding = '0';
    c.style.webkitTextStroke = (s.outline_width * 0.45).toFixed(1) + 'px ' + s.outline_color;
  }
  [t, c].forEach(el => _pvApplyEff(el, s.effect));
}

let _bulkTimer = null;
async function applyBulkStyle() {
  const bar = document.getElementById('bulkBar');
  const job = bar ? bar.dataset.job : '';
  if (!job) return;
  const st = document.getElementById('bulkStatus');
  const apply = bar.querySelector('.bulk-apply');
  if (!confirm('全クリップに字幕スタイルを適用して再作成します。本数によっては数分かかります。よろしいですか？')) return;
  apply.disabled = true;
  st.textContent = '開始中...';
  document.getElementById('bulkProgWrap').hidden = false;
  setBulkProg(0);
  try {
    const resp = await fetch('/api/clips/' + job + '/bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ style: bulkStyleFromCreate() }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || '開始に失敗しました');
    pollBulk(data.bulk_id);
  } catch (e) {
    st.textContent = 'エラー: ' + e.message;
    apply.disabled = false;
  }
}
function setBulkProg(p) {
  const f = document.getElementById('bulkProgFill');
  if (f) f.style.width = p + '%';
}
function pollBulk(bulkId) {
  const st = document.getElementById('bulkStatus');
  const apply = document.querySelector('#bulkBar .bulk-apply');
  if (_bulkTimer) clearInterval(_bulkTimer);
  _bulkTimer = setInterval(async () => {
    try {
      const job = await (await fetch('/api/status/' + bulkId)).json();
      setBulkProg(job.progress || 0);
      st.textContent = job.step || '処理中...';
      if (job.status === 'completed') {
        clearInterval(_bulkTimer); _bulkTimer = null;
        setBulkProg(100);
        st.textContent = job.warning ? ('完了（' + job.warning + '）') : '✓ 全クリップに適用しました';
        bustAllClips();
        apply.disabled = false;
        setTimeout(() => { const w = document.getElementById('bulkProgWrap'); if (w) w.hidden = true; }, 1500);
      } else if (job.status === 'failed') {
        clearInterval(_bulkTimer); _bulkTimer = null;
        st.textContent = 'エラー: ' + (job.error || '失敗しました');
        apply.disabled = false;
      }
    } catch (_) { /* 一過性は無視 */ }
  }, 1500);
}
function bustAllClips() {
  const bust = '?t=' + Date.now();
  document.querySelectorAll('.clip-card video').forEach(v => {
    v.src = apiUrl(new URL(v.src, window.location.href).pathname + bust);
    if (v.poster) v.poster = apiUrl(new URL(v.poster, window.location.href).pathname + bust);
    v.load();
  });
  // 開いている（編集中の）UIは未保存の入力を失わないよう触らない。
  // 閉じている loaded 済みのものだけ無効化し、次に開いた時に最新を再読込させる。
  document.querySelectorAll('.clip-editor').forEach(el => {
    if (el.hidden) el.dataset.loaded = '';
  });
}

// ===== 設定（Gemini APIキー等。アプリ版のみ。保存で再起動して反映） =====
async function openSettings() {
  const m = document.getElementById('settingsModal');
  m.hidden = false;
  document.getElementById('settingsMsg').textContent = '';
  if (electron && electron.getSettings) {
    try {
      const s = (await electron.getSettings()) || {};
      document.getElementById('setLlmPlan').value = s.llmProvider || 'gemini';
      if (s.whisperModel) document.getElementById('setWhisper').value = s.whisperModel;
      document.getElementById('setOutputDir').value = s.outputDir || '';
      document.getElementById('setHandle').value = s.tiktokHandle || '';
      document.getElementById('setLogo').value = s.logoPath || '';
      document.getElementById('setVocab').value = s.customVocab || '';
      applyBrandSettings(s);
      document.getElementById('setCorrect').checked = !!s.correctSubtitles;
    } catch (_) {}
  } else {
    document.getElementById('settingsMsg').textContent = '※ブラウザ版では backend/.env の設定を使用します。';
    ['outputDirField', 'logoField'].forEach(id => {
      const f = document.getElementById(id);
      if (f) f.style.display = 'none';
    });
  }
  refreshPresetSelect();   // プリセットは設定モーダルに移設
  // GPU/NVENC 検出に応じて Whisper モデルの注記を更新（GPU無しで large-v3 選択時は警告）
  const sel = document.getElementById('setWhisper');
  if (sel && !sel._capBound) { sel._capBound = true; sel.addEventListener('change', refreshCapabilities); }
  refreshCapabilities();
}

let _caps = null;
async function refreshCapabilities() {
  const note = document.getElementById('whisperGpuNote');
  if (!note) return;
  try {
    if (!_caps) _caps = await (await fetch('/api/capabilities')).json();
  } catch (_) { return; }
  const cap = _caps || {};
  const sel = document.getElementById('setWhisper');
  const cur = sel ? sel.value : '';
  if (!cap.gpu && cur === 'large-v3') {
    note.innerHTML = '⚠️ <b>GPU未検出</b>なのに large-v3 を選択中：CPUでは書き起こしが非常に遅くなります。'
      + '<b>「自動」</b>か kotoba-whisper を推奨します。';
    return;
  }
  const dev = cap.gpu ? 'GPUを検出' : 'GPU未検出（CPUで実行）';
  const enc = cap.nvenc ? '・NVENCで書き出しも高速化' : '';
  note.innerHTML = `<b>${dev}</b>${enc}。<b>自動</b>では「${cap.default_model || (cap.gpu ? 'large-v3' : 'kotoba-whisper')}」を使用します。`
    + '手動指定も可。初回はモデルDLあり。';
}
async function pickLogo() {
  if (!(electron && electron.selectLogo)) return;
  const p = await electron.selectLogo();
  if (p) document.getElementById('setLogo').value = p;
}
function clearLogo() { document.getElementById('setLogo').value = ''; }
function updateBrandHint() {
  const hint = document.getElementById('brandHint');
  if (!hint) return;
  hint.textContent = electron
    ? '＠ハンドル・ロゴ画像は上で登録し、表示ON/OFF・位置もここで設定します（保存・再起動後に全クリップへ反映）。'
    : 'ブラウザ版では @ハンドル / ロゴは backend/.env（TIKTOKCUT_HANDLE / TIKTOKCUT_LOGO）で設定します。';
}
async function pickOutputDir() {
  if (!(electron && electron.selectFolder)) return;
  const dir = await electron.selectFolder();
  if (dir) document.getElementById('setOutputDir').value = dir;
}
function closeSettings() { document.getElementById('settingsModal').hidden = true; }
async function saveSettings() {
  if (!(electron && electron.saveSettings)) {
    document.getElementById('settingsMsg').textContent = 'アプリ版でのみ保存できます。';
    return;
  }
  const plan = document.getElementById('setLlmPlan').value;
  const s = {
    llmProvider: plan,
    whisperModel: document.getElementById('setWhisper').value,
    outputDir: document.getElementById('setOutputDir').value || undefined,
    tiktokHandle: document.getElementById('setHandle').value.trim() || undefined,
    logoPath: document.getElementById('setLogo').value.trim() || undefined,
    customVocab: document.getElementById('setVocab').value.trim() || undefined,
    correctSubtitles: document.getElementById('setCorrect').checked,
    watermarkOn: document.getElementById('wmOn').checked,
    watermarkPos: document.getElementById('wmPos').value,
    logoOn: document.getElementById('logoOn').checked,
    logoPos: document.getElementById('logoPos').value,
  };
  document.getElementById('settingsMsg').textContent = '保存中... アプリを再起動します';
  await electron.saveSettings(s);
}

// ウォーターマーク/ロゴ の表示ON/OFF・位置を設定値から UI に反映（設定ページのみで管理）。
// 起動時にも呼び、設定を開かなくても startProcess が正しい値を読めるようにする。
async function applyBrandSettings(s) {
  try {
    if (!s && electron && electron.getSettings) s = (await electron.getSettings()) || {};
  } catch (_) { /* ブラウザ版等 */ }
  s = s || {};
  const set = (id, fn) => { const e = document.getElementById(id); if (e) fn(e); };
  set('wmOn', e => { e.checked = !!s.watermarkOn; });
  set('logoOn', e => { e.checked = !!s.logoOn; });
  set('wmPos', e => { if (s.watermarkPos) e.value = s.watermarkPos; });
  set('logoPos', e => { if (s.logoPos) e.value = s.logoPos; });
}
