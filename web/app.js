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
function savePrefs() {
  try { localStorage.setItem('tkc_prefs', JSON.stringify(_prefs)); } catch (_) {}
  if (_prefsTimer) clearTimeout(_prefsTimer);
  _prefsTimer = setTimeout(() => {
    fetch('/api/prefs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(_prefs),
    }).catch(() => {});
  }, 400);
}

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
  fd.append('effect', document.getElementById('effectSelect').value);
  fd.append('animate', animV === 'none' ? '0' : '1');
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
  fd.append('box', document.getElementById('boxOn').checked ? '1' : '0');
  fd.append('box_color', document.getElementById('cBox').value);
  fd.append('box_pad', document.getElementById('boxPad').value);
  fd.append('watermark', document.getElementById('wmOn').checked ? '1' : '0');
  fd.append('watermark_pos', document.getElementById('wmPos').value);
  fd.append('logo', document.getElementById('logoOn').checked ? '1' : '0');
  fd.append('logo_pos', document.getElementById('logoPos').value);
  fd.append('laugh', document.getElementById('laughOn').checked ? '1' : '0');
  fd.append('comment', document.getElementById('commentOn').checked ? '1' : '0');
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
  btn.textContent = '作成開始';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderClips(clips) {
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
        '<a class="dl-btn" href="#" onclick="return downloadClip(\'' + encodeURI(c.file_path) + '\',\'' + esc((c.title || 'clip')).replace(/'/g, '') + '\')">動画をダウンロード</a>' +
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
};
function _animSel() { const e = document.getElementById('animSelect'); return e ? e.value : 'default'; }
function _effSel() { const e = document.getElementById('effectSelect'); return e ? e.value : 'none'; }

// 作成タブ・編集UIで共有するアニメ/エフェクトの選択肢
const ANIM_OPTS = [['default', 'ポップイン（標準）'], ['none', 'なし'], ['fade', 'フェード'],
  ['pop', 'ポップ'], ['bounce', 'バウンス'], ['slide', 'スライドイン（パン）'],
  ['wipe', 'ワイプ'], ['breathe', 'ブリーズ'], ['wave', 'ウェーブ（近似）'],
  ['flip', 'フリップ'], ['zoombig', 'ズーム特大'], ['shake', 'シェイク'], ['spin', 'スピン'], ['blurin', 'ブラー']];
const EFFECT_OPTS = [['none', 'なし'], ['glow', '光彩'], ['sparkle', 'キラキラ（近似）'], ['horror', 'ホラー']];
function optionsHtml(list, sel) {
  return list.map(([v, l]) => '<option value="' + v + '"' + (v === sel ? ' selected' : '') + '>' + l + '</option>').join('');
}
// テロップ個別アニメの選択肢（''=クリップ既定に従う）
const TANIM_OPTS = [['', '（既定）']].concat(ANIM_OPTS.filter(o => o[0] !== 'default'));

// ===== 字幕＋効果音 インライン縦タイムライン（動画エディタ風・ed._telops/ed._sfx をライブ編集） =====
const ED_PX = 80, ED_SNAP = 0.1, ED_MIN_DUR = 0.2, ED_MIN_PX = 14;
function edT2y(t) { return t * ED_PX; }
function edY2t(ed, y) { return Math.max(0, Math.min(ed._dur || 0, y / ED_PX)); }
function edSnap(t) { return Math.round(t / ED_SNAP) * ED_SNAP; }
function edClamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function edFmt(s) { const m = Math.floor(s / 60), ss = Math.floor(s % 60); return m + ':' + ('0' + ss).slice(-2); }
function edClone(arr) {
  return (arr || []).map(t => ({ start: +t.start || 0, end: +t.end || 0, text: t.text || '',
    style: t.style || '', emphasis: !!t.emphasis, animation: t.animation || '',
    layer: +t.layer || 0, pos: (t.pos && t.pos.x != null) ? { x: +t.pos.x, y: +t.pos.y } : null }));
}
function edTip(e, msg) { const tip = document.getElementById('subTooltip'); if (!tip) return; tip.textContent = msg; tip.hidden = false; tip.style.left = (e.clientX + 12) + 'px'; tip.style.top = (e.clientY + 12) + 'px'; }
function edTipHide() { const t = document.getElementById('subTooltip'); if (t) t.hidden = true; }

function edRenderTimeline(ed) {
  const tl = ed.querySelector('.ed-tl'); if (!tl) return;
  const H = Math.max(140, edT2y(ed._dur || 0));
  tl.style.height = H + 'px';
  ed.querySelectorAll('.ed-tl-gutter, .ed-tl-lane').forEach(n => { n.style.height = H + 'px'; });
  edRenderGutter(ed);
  edRenderTelopBlocks(ed);
  edRenderSfxBlocks(ed);
  edRenderCuts(ed);
}
function edRenderGutter(ed) {
  const g = ed.querySelector('.ed-tl-gutter'); if (!g) return;
  g.querySelectorAll('.ed-tick').forEach(n => n.remove());
  const dur = ed._dur || 0, step = dur > 40 ? 5 : 1;
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
      '<div class="ed-block-body"><textarea class="ed-block-text" rows="1" placeholder="字幕">' + esc(tp.text || '') + '</textarea></div>' +
      '<div class="ed-grip ed-grip-bot"></div>';
    if (hh < 22) el.querySelectorAll('.ed-grip').forEach(gp => gp.style.height = Math.max(4, hh * 0.3) + 'px');
    edWireTelopBlock(ed, el, i);
    lane.appendChild(el);
  });
}
function edWireTelopBlock(ed, el, i) {
  let mode = null, startY = 0, t0s = 0, t0e = 0;
  const topG = el.querySelector('.ed-grip-top'), botG = el.querySelector('.ed-grip-bot');
  const ta = el.querySelector('.ed-block-text');
  topG.addEventListener('pointerenter', e => edTip(e, 'ドラッグで開始時刻を変更'));
  topG.addEventListener('pointerleave', edTipHide);
  botG.addEventListener('pointerenter', e => edTip(e, 'ドラッグで終了時刻を変更'));
  botG.addEventListener('pointerleave', edTipHide);
  el.addEventListener('pointerdown', e => {
    if (e.target.classList.contains('ed-block-text') || e.target.classList.contains('ed-block-del')) return;
    edSelectTelop(ed, i);
    mode = e.target.classList.contains('ed-grip-top') ? 'top' : e.target.classList.contains('ed-grip-bot') ? 'bot' : 'move';
    const tp = ed._telops[i]; t0s = tp.start; t0e = tp.end; startY = e.clientY;
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault(); e.stopPropagation();
  });
  el.addEventListener('pointermove', e => {
    if (!mode) return;
    const tp = ed._telops[i]; if (!tp) return;
    const dt = edSnap((e.clientY - startY) / ED_PX);
    if (mode === 'move') { const len = t0e - t0s; const s = edClamp(t0s + dt, 0, (ed._dur || 0) - len); tp.start = +s.toFixed(2); tp.end = +(s + len).toFixed(2); }
    else if (mode === 'top') { tp.start = +edClamp(t0s + dt, 0, tp.end - ED_MIN_DUR).toFixed(2); }
    else { tp.end = +edClamp(t0e + dt, tp.start + ED_MIN_DUR, ed._dur || 0).toFixed(2); }
    el.style.top = edT2y(tp.start) + 'px';
    el.style.height = Math.max(ED_MIN_PX, edT2y(tp.end) - edT2y(tp.start)) + 'px';
    edSeekVideo(ed, mode === 'bot' ? tp.end : tp.start);
    edRenderSelTelop(ed);
  });
  const up = e => { if (!mode) return; mode = null; try { el.releasePointerCapture(e.pointerId); } catch (_) {} renderPreviewTelops(ed); updateEditorPreview(ed); };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  ta.addEventListener('input', () => { if (ed._telops[i]) { ed._telops[i].text = ta.value; renderPreviewTelops(ed); } });
  ta.addEventListener('pointerdown', e => e.stopPropagation());
  ta.addEventListener('focus', () => edSelectTelop(ed, i));
  el.querySelector('.ed-block-del').addEventListener('click', e => {
    e.stopPropagation();
    ed._telops.splice(i, 1);
    if (ed._selTelop === i) ed._selTelop = -1;
    else if (ed._selTelop > i) ed._selTelop--;   // splice で下の index がずれるので選択も追従
    edRenderTelopBlocks(ed); edRenderSelTelop(ed); renderPreviewTelops(ed); updateEditorPreview(ed);
  });
}
function edSelectTelop(ed, i) {
  ed._selTelop = i; ed._selSfx = null;
  ed.querySelectorAll('.ed-tl-tel .ed-block').forEach(n => n.classList.toggle('sel', +n.dataset.i === i));
  ed.querySelectorAll('.ed-tl-sfx .ed-block').forEach(n => n.classList.remove('sel'));
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
  panel.innerHTML =
    '<span class="ed-sel-cap">選択中の字幕</span>' +
    '<label>開始<input class="ed-t-s" type="number" step="0.1" min="0" value="' + (+tp.start).toFixed(1) + '"></label>' +
    '<label>終了<input class="ed-t-e" type="number" step="0.1" min="0" value="' + (+tp.end).toFixed(1) + '"></label>' +
    '<label>アニメ<select class="ed-t-anim">' + optionsHtml(TANIM_OPTS, tp.animation || '') + '</select></label>' +
    '<label>層<input class="ed-t-layer" type="number" min="0" max="9" value="' + (tp.layer || 0) + '"></label>' +
    '<label class="ed-flag"><input type="checkbox" class="ed-emph-cb"' + (tp.emphasis ? ' checked' : '') + '>強調</label>' +
    '<label class="ed-flag"><input type="checkbox" class="ed-alert-cb"' + (tp.style === 'alert' ? ' checked' : '') + '>ｱﾗｰﾄ</label>';
}
function edWireSelTelop(ed) {
  const panel = ed.querySelector('.ed-sel-tel'); if (!panel || panel.dataset.wired) return;
  panel.dataset.wired = '1';
  panel.addEventListener('input', e => {
    const tp = (ed._telops || [])[ed._selTelop]; if (!tp) return;
    if (e.target.classList.contains('ed-t-s')) {
      tp.start = edClamp(+e.target.value || 0, 0, ed._dur || 0);
      if (tp.start > tp.end - ED_MIN_DUR) tp.end = Math.min(ed._dur || 0, tp.start + ED_MIN_DUR);
      edRenderTelopBlocks(ed); renderPreviewTelops(ed);
    }
    else if (e.target.classList.contains('ed-t-e')) {
      tp.end = edClamp(+e.target.value || 0, ED_MIN_DUR, ed._dur || 0);
      if (tp.end < tp.start + ED_MIN_DUR) tp.start = Math.max(0, tp.end - ED_MIN_DUR);
      edRenderTelopBlocks(ed); renderPreviewTelops(ed);
    }
    else if (e.target.classList.contains('ed-t-layer')) { tp.layer = Math.max(0, Math.min(9, +e.target.value || 0)); renderPreviewTelops(ed); }
  });
  panel.addEventListener('change', e => {
    const tp = (ed._telops || [])[ed._selTelop]; if (!tp) return;
    if (e.target.classList.contains('ed-emph-cb')) { tp.emphasis = e.target.checked; renderPreviewTelops(ed); }
    else if (e.target.classList.contains('ed-alert-cb')) { tp.style = e.target.checked ? 'alert' : (tp.style === 'alert' ? '' : tp.style); renderPreviewTelops(ed); }
    else if (e.target.classList.contains('ed-t-anim')) { tp.animation = e.target.value; renderPreviewTelops(ed, true); }
  });
}
// --- 効果音レーン ---
function edRenderSfxPalette(ed) {
  const pal = ed.querySelector('.ed-sfx-pal'); if (!pal) return;
  const list = Object.values(ed._sfxById || {});
  pal.innerHTML = '<span class="ed-pal-lbl">効果音を追加（再生位置に）:</span>' + list.map(s =>
    '<button type="button" class="sfx-chip" data-id="' + esc(s.id) + '">' + (s.emoji ? s.emoji + ' ' : '') + esc(s.label || s.id) +
    '<span class="sfx-dur">' + (+s.dur || 0).toFixed(1) + 's</span></button>').join('');
  pal.querySelectorAll('.sfx-chip').forEach(b => b.addEventListener('click', () => edAddSfxAtPlayhead(ed, b.dataset.id)));
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
      '<button type="button" class="ed-block-del" tabindex="-1">✕</button>';
    el.title = (meta.label || b.id) + ' @' + b.at.toFixed(2) + 's';
    edWireSfxBlock(ed, el, b);
    lane.appendChild(el);
  });
}
function edWireSfxBlock(ed, el, b) {
  let dragging = false, grabOff = 0;
  el.querySelector('.ed-block-del').addEventListener('click', e => {
    e.stopPropagation();
    ed._sfx = (ed._sfx || []).filter(x => x.uid !== b.uid);
    if (ed._selSfx === b.uid) ed._selSfx = null;
    edRenderSfxBlocks(ed); edRenderSelSfx(ed);
  });
  el.addEventListener('pointerdown', e => {
    if (e.target.classList.contains('ed-block-del')) return;   // ✕ はドラッグしない
    edSelectSfx(ed, b.uid, true);
    const lane = ed.querySelector('.ed-tl-sfx'); const r = lane.getBoundingClientRect();
    grabOff = (e.clientY - r.top) - edT2y(b.at);
    dragging = true;
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault(); e.stopPropagation();
  });
  el.addEventListener('pointermove', e => {
    if (!dragging) return;
    const lane = ed.querySelector('.ed-tl-sfx'); const r = lane.getBoundingClientRect();
    const t = edSnap(edClamp(edY2t(ed, (e.clientY - r.top) - grabOff), 0, ed._dur || 0));
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
  (ed._sfx = ed._sfx || []).push(b);
  edRenderSfxBlocks(ed); edSelectSfx(ed, b.uid, true);
}
function edSelectSfx(ed, uid, audition) {
  ed._selSfx = uid; ed._selTelop = -1;
  ed.querySelectorAll('.ed-tl-sfx .ed-block').forEach(n => n.classList.toggle('sel', n.dataset.uid === uid));
  ed.querySelectorAll('.ed-tl-tel .ed-block').forEach(n => n.classList.remove('sel'));
  edRenderSelTelop(ed); edRenderSelSfx(ed);
  const b = (ed._sfx || []).find(x => x.uid === uid);
  if (b && audition) _auditionSfx(((ed._sfxById || {})[b.id] || {}).file, b.gain);
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
      if (e.target.classList.contains('ed-sfx-gain')) { bb.gain = (+e.target.value || 0) / 100; const o = panel.querySelector('.ed-sfx-gain-o'); if (o) o.textContent = e.target.value + '%'; }
    });
    panel.addEventListener('click', e => {
      const bb = (ed._sfx || []).find(x => x.uid === ed._selSfx); if (!bb) return;
      if (e.target.classList.contains('ed-sfx-prev')) { _auditionSfx(((ed._sfxById || {})[bb.id] || {}).file, bb.gain); }
      else if (e.target.classList.contains('ed-sfx-del')) {
        ed._sfx = (ed._sfx || []).filter(x => x.uid !== bb.uid); ed._selSfx = null;
        edRenderSfxBlocks(ed); edRenderSelSfx(ed);
      }
    });
  }
}
// --- スクラブ / プレイヘッド / 追加 ---
function edSeekVideo(ed, t) {
  const v = _clipVideo(ed); if (v) { try { v.currentTime = Math.max(0, t + 0.02); } catch (_) {} }
  edPlayheadTo(ed, t);
  const r = ed.querySelector('.ed-tl-time'); if (r) r.textContent = t.toFixed(1) + 's';
  renderPreviewTelops(ed);
}
function edPlayheadTo(ed, t) { const p = ed.querySelector('.ed-tl-playhead'); if (p) p.style.top = edT2y(t) + 'px'; }
function edWireLaneScrub(ed) {
  ed.querySelectorAll('.ed-tl-tel, .ed-tl-sfx').forEach(lane => {
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
  // プレビュー再生中に効果音をその時刻で鳴らす（at を跨いだら再生）
  const prev = ed._lastSfxT;
  ed._lastSfxT = t;
  if (prev == null || t < prev || t - prev > 0.5) return;   // 初回/巻戻し/シーク跳びは鳴らさない
  (ed._sfx || []).forEach(b => { if (b.at > prev && b.at <= t) _auditionSfx(((ed._sfxById || {})[b.id] || {}).file, b.gain); });
}
function edFollowScroll(ed, t) {
  // 再生に合わせてタイムラインを自動スクロール（プレイヘッドを可視域内に保つ）
  const wrap = ed.querySelector('.ed-tl-wrap'); if (!wrap) return;
  const y = edT2y(t), view = wrap.clientHeight, top = wrap.scrollTop;
  if (y < top + view * 0.25 || y > top + view * 0.75) {
    wrap.scrollTop = Math.max(0, y - view * 0.4);
  }
}
function edWirePlayheadSync(ed) {
  const v = _clipVideo(ed); if (!v || v._edTlWired) return; v._edTlWired = true;
  const place = () => {
    const e = document.getElementById('detailEditor'); if (!e || !e.dataset.loaded) return;
    const t = v.currentTime || 0;
    edPlayheadTo(e, t);
    const r = e.querySelector('.ed-tl-time'); if (r) r.textContent = t.toFixed(1) + 's';
    if (!v.paused) { edFollowScroll(e, t); edPlaySfxAt(e, t); }   // 再生中: 追従＋効果音をプレビュー再生
    else e._lastSfxT = t;
  };
  v.addEventListener('timeupdate', place); v.addEventListener('seeking', () => { const e = document.getElementById('detailEditor'); if (e) e._lastSfxT = v.currentTime; place(); }); v.addEventListener('seeked', place);
  let raf = null; const tick = () => { if (!v.isConnected) { raf = null; return; } place(); raf = requestAnimationFrame(tick); };
  v.addEventListener('play', () => { if (!raf) tick(); });
  v.addEventListener('pause', () => { if (raf) { cancelAnimationFrame(raf); raf = null; } place(); });
  place();
}
// スペースキーで詳細編集の動画を再生/停止（入力中は無効）
document.addEventListener('keydown', e => {
  if (e.code !== 'Space' && e.key !== ' ') return;
  const dt = document.getElementById('tab-detail');
  if (!dt || !dt.classList.contains('active')) return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)) return;
  const v = document.getElementById('detailVideo'); if (!v) return;
  e.preventDefault();
  if (v.paused) v.play().catch(() => {}); else v.pause();
});
function edTlReset(btn) {
  const ed = btn.closest('.clip-editor'); if (!ed) return;
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
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault(); e.stopPropagation();
  });
  el.addEventListener('pointermove', e => {
    if (!mode) return;
    const c = ed._cuts[i]; if (!c) return;
    const dt = edSnap((e.clientY - startY) / ED_PX);
    if (mode === 'move') { const len = c0e - c0s; const s = edClamp(c0s + dt, 0, (ed._dur || 0) - len); c.start = +s.toFixed(2); c.end = +(s + len).toFixed(2); }
    else if (mode === 'top') { c.start = +edClamp(c0s + dt, 0, c.end - 0.2).toFixed(2); }
    else { c.end = +edClamp(c0e + dt, c.start + 0.2, ed._dur || 0).toFixed(2); }
    el.style.top = edT2y(c.start) + 'px'; el.style.height = Math.max(10, edT2y(c.end) - edT2y(c.start)) + 'px';
    edSeekVideo(ed, mode === 'bot' ? c.end : c.start);
  });
  const up = e => { if (!mode) return; mode = null; try { el.releasePointerCapture(e.pointerId); } catch (_) {} };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.querySelector('.ed-cut-del').addEventListener('click', e => { e.stopPropagation(); ed._cuts.splice(i, 1); edRenderCuts(ed); });
}
function edAddCut(btn) {
  const ed = btn.closest('.clip-editor'); if (!ed) return;
  const v = _clipVideo(ed);
  const s = edClamp(v ? (v.currentTime || 0) : 0, 0, Math.max(0, (ed._dur || 0) - 0.5));
  const len = Math.min(1.0, Math.max(0.3, (ed._dur || 0) - s));
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
  const keeps = _dispKeepsToOrig(dispKeeps, ed._keeps, ed._origDur || dispDur);
  const removed = dispDur - dispKeeps.reduce((s, k) => s + (k[1] - k[0]), 0);
  const clip_duration = +dispKeeps.reduce((s, k) => s + (k[1] - k[0]), 0).toFixed(3);
  return { telops, sfx, keeps, clip_duration, removed: +removed.toFixed(3) };
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
function addTelopBtn(btn) { const ed = btn.closest('.clip-editor'); const v = _clipVideo(ed); edAddTelopAt(ed, v ? v.currentTime : 0); }
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
    el.classList.remove('pv-eff-glow', 'pv-eff-horror', 'pv-eff-sparkle');
    if (e === 'glow') el.classList.add('pv-eff-glow');
    else if (e === 'horror') el.classList.add('pv-eff-horror');
    else if (e === 'sparkle') el.classList.add('pv-eff-sparkle');
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
        og.appendChild(o);
        if (f.bundled && f.file) {
          css += `@font-face{font-family:'${f.family}';src:url('/fonts/${encodeURIComponent(f.file)}');font-display:swap;}`;
        }
      });
      sel.appendChild(og);
    });
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    sel.addEventListener('change', updateFontPreview);
    restoreLastStyle();   // 前回のフォント/色/サイズ/縁取りを復元（options 構築後）
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
                    ['boxPad', 'boxPadOut']];
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
function savePresets(p) { _prefs.presets = p; savePrefs(); }
function refreshPresetSelect() {
  const sel = document.getElementById('presetSelect');
  const cur = sel.value;
  sel.innerHTML = '<option value="">（プリセットを選択）</option>';
  loadPresets().forEach(p => {
    const o = document.createElement('option'); o.value = p.name; o.textContent = p.name; sel.appendChild(o);
  });
  sel.value = cur;
}
function currentStyleObj() {
  const v = id => document.getElementById(id).value;
  return {
    font: v('fontSelect'), sub: v('cSub'), hi: v('cHi'), out: v('cOut'), title: v('cTitle'),
    capSize: +v('capSize'), capOutline: +v('capOutline'),
    titleSize: +v('titleSize'), titleOutline: +v('titleOutline'),
    animation: v('animSelect'), effect: v('effectSelect'),
    box: document.getElementById('boxOn').checked, boxColor: v('cBox'), boxPad: +v('boxPad'),
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
  set('effectSelect', s.effect != null ? s.effect : 'none');
  if (typeof s.box === 'boolean') document.getElementById('boxOn').checked = s.box;
  syncSliderLabels(); updateFontPreview(); updatePreviewColors(); applyPreviewFx();
}
function applyPreset() {
  const p = loadPresets().find(x => x.name === document.getElementById('presetSelect').value);
  if (p) applyStyleObj(p.style);
}
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
  if (!name) return;
  savePresets(loadPresets().filter(x => x.name !== name));
  refreshPresetSelect();
}

// ===== 直近のスタイルを記憶（次回の既定に） =====
function saveLastStyle() { _prefs.laststyle = currentStyleObj(); savePrefs(); }
function restoreLastStyle() {
  try { if (_prefs.laststyle) applyStyleObj(_prefs.laststyle); } catch (_) {}
}
function wireStyleMemory() {
  ['fontSelect', 'cSub', 'cHi', 'cOut', 'cTitle', 'capSize', 'capOutline',
   'titleSize', 'titleOutline', 'animSelect', 'effectSelect', 'boxOn', 'cBox', 'boxPad'].forEach(id => {
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
  if (!ed.dataset.loaded) return;
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
    payload.keeps = cut.keeps; payload.clip_duration = cut.clip_duration;
    cutReload = true;
  } else {
    payload.keeps = ed._keeps || null;   // 既存/リセット後の残し区間を維持
  }
  const reload = !!(payload.extend_start || payload.extend_end) || cutReload;
  const st = document.getElementById('detailSaveStatus');
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
    if (reload) { ed.dataset.loaded = ''; loadEditor(ed); }   // 延長/追加指示でテロップが変わる
  } catch (e) {
    _vRestore(cap, job, cid);   // 失敗時もプレビューを復帰（ディスクは未変更）
    st.textContent = 'エラー: ' + e.message;
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
function toggleEditor(btn) {
  const ed = btn.parentElement.querySelector('.clip-editor');
  if (!ed) return;
  if (!ed.hidden) { ed.hidden = true; return; }
  ed.hidden = false;
  if (!ed.dataset.loaded) loadEditor(ed);
}

async function loadEditor(ed) {
  const job = ed.dataset.job, cid = ed.dataset.cid;
  // 素早くクリップを切り替えた際、先発の遅い fetch が後発の状態を上書きしないよう世代番号で防ぐ
  const gen = (ed._loadGen = (ed._loadGen || 0) + 1);
  ed.innerHTML = '<div class="ed-loading">読み込み中...</div>';
  try {
    const data = await (await fetch('/api/clip/' + job + '/' + cid)).json();
    if (ed._loadGen !== gen) return;   // 別クリップの読込が始まっていたら破棄
    ed._dur = +data.clip_duration || 0;
    const _mkTelop = t => ({
      start: +t.start || 0, end: +t.end || 0, text: t.text || '',
      style: t.style || '', emphasis: !!t.emphasis, animation: t.animation || '',
      layer: +t.layer || 0, pos: (t.pos && t.pos.x != null) ? { x: +t.pos.x, y: +t.pos.y } : null,
    });
    ed._telops = (data.telops || []).map(_mkTelop);
    ed._telopsOrig = (data.telops_orig || []).map(_mkTelop);   // 「初期設定に戻す」用の原字幕
    ed._telopsPristine = _subClone(ed._telops);   // 初期に戻す用スナップショット
    // 効果音（インラインタイムラインの効果音レーン）
    ed._sfx = (data.sfx || []).map(s => ({ uid: 'b' + (_uidN++), id: s.id, at: +s.at || 0, gain: s.gain == null ? 1 : +s.gain }));
    ed._sfxById = {};
    try { const _sl = await getSfxList(); ed._sfxById = Object.fromEntries(_sl.map(s => [s.id, s])); } catch (_) {}
    ed._selTelop = -1; ed._selSfx = null;
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
    const animV = st.animation || 'default';
    const effV = st.effect || 'none';
    // WYSIWYG プレビュー用に、クリップのフォント・色・枠を控える（再描画前の見た目確認）
    ed._pv = {
      font: st.font || '', sub: st.subtitle_color || '#FFFFFF', out: st.outline_color || '#000000',
      title: st.title_color || '#FFFFFF', titleOut: st.title_outline_color || st.outline_color || '#000000',
      box: !!st.box, boxColor: st.box_color || '#000000', emph: st.emphasis_color || '#FFE600',
    };
    const tp0 = ed._titlePos || { x: 0.5, y: 0.16 };
    ed._reframe = data.reframe || 'crop';
    ed._lbColor = data.letterbox_color || '#000000';
    let h =
      '<label class="ed-label">表示スタイル <span class="opt">（プレビューは左の動画。テロップは左の動画上をドラッグで移動／字幕欄の行を触ると移動）</span></label>' +
      '<div class="ed-pos">' +
        '<div class="ed-pos-side">' +
          '<button type="button" class="mini-btn" onclick="resetPos(this)">位置を初期化</button>' +
          '<label class="slider-item">字幕サイズ <b class="ed-capsz-o">' + capSz + '</b>' +
            '<input type="range" class="ed-capsz" min="48" max="120" step="2" value="' + capSz + '"></label>' +
          '<label class="slider-item">字幕の縁取り <b class="ed-capol-o">' + capOl + '</b>' +
            '<input type="range" class="ed-capol" min="0" max="16" step="1" value="' + capOl + '"></label>' +
          '<label class="slider-item">タイトルサイズ <b class="ed-ttlsz-o">' + ttlSz + '</b>' +
            '<input type="range" class="ed-ttlsz" min="50" max="140" step="2" value="' + ttlSz + '"></label>' +
          '<label class="slider-item">タイトルの縁取り <b class="ed-ttlol-o">' + ttlOl + '</b>' +
            '<input type="range" class="ed-ttlol" min="0" max="20" step="1" value="' + ttlOl + '"></label>' +
          '<label class="slider-item">アニメーション' +
            '<select class="ed-anim">' + optionsHtml(ANIM_OPTS, animV) + '</select></label>' +
          '<label class="slider-item">エフェクト' +
            '<select class="ed-effect">' + optionsHtml(EFFECT_OPTS, effV) + '</select></label>' +
          '<label class="slider-item">画面構成(9:16)' +
            '<select class="ed-reframe">' + optionsHtml([['crop', '中央クロップ'], ['blur', '背景ぼかし'], ['letterbox', 'レターボックス']], data.reframe || 'crop') + '</select></label>' +
          '<label class="slider-item ed-lb-field"' + ((data.reframe || 'crop') !== 'letterbox' ? ' style="display:none"' : '') + '>帯の色' +
            '<input type="color" class="ed-lb-color" value="' + (data.letterbox_color || '#000000') + '"></label>' +
        '</div>' +
      '</div>' +
      '<label class="ed-label">タイトル</label>' +
      '<input class="ed-title" type="text" value="' + esc(data.title || '') + '">' +
      '<div class="ed-tl-head">' +
        '<label class="ed-label" style="margin:0;">字幕・効果音タイムライン <span class="opt">（ブロックをドラッグで移動・上下端で時間・空きクリックで追加）</span></label>' +
        '<div class="ed-tel-tools">' +
          '<button type="button" class="mini-btn" onclick="edAddCut(this)" title="再生位置にカット範囲を追加。やり直すときはカット範囲の✕で個別取消、または「初期に戻す」で全部戻せます">✂ カット範囲</button>' +
          '<button type="button" class="mini-btn" onclick="edTlReset(this)" title="字幕・カットを生成直後の状態に戻します（カットしすぎたときもこれで元に戻せます）">初期に戻す</button>' +
          '<select class="ed-bulk-anim" onchange="edBulkAnim(this)">' +
            '<option value="">全テロップのアニメ…</option>' + optionsHtml(ANIM_OPTS, '_skip_') + '</select>' +
        '</div>' +
      '</div>' +
      '<div class="ed-sfx-pal"></div>' +
      '<div class="ed-tl-colhead"><span></span><span>字幕</span><span>効果音</span></div>' +
      '<div class="ed-tl-wrap"><div class="ed-tl">' +
        '<div class="ed-tl-gutter"></div>' +
        '<div class="ed-tl-lane ed-tl-tel"></div>' +
        '<div class="ed-tl-lane ed-tl-sfx"></div>' +
        '<div class="ed-tl-playhead"></div>' +
      '</div></div>' +
      '<div class="ed-tl-readout"><span class="ed-tl-time">0.0s</span></div>' +
      '<div class="ed-suboff">' +
        '<label>字幕タイミング <span class="opt">（秒・＋で字幕を遅らせる）</span> <b class="ed-suboff-val">0.00</b></label>' +
        '<input type="range" class="ed-suboff-range" min="-1" max="1" step="0.05" value="0">' +
        '<span class="hint" style="display:block;margin-top:2px;">音声より字幕が早い/遅いと感じたら調整→「保存して再作成」で反映。</span>' +
      '</div>' +
      '<div class="ed-sel-tel" hidden></div>' +
      '<div class="ed-sel-sfx" hidden></div>' +
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
    if (ed._frame) ed._frame.classList.remove('pv-playing');   // クリップ切替時にリセット
    if (ed._frame) {
      ed._frame.innerHTML = '<div class="ed-chip ed-wys ed-ct" style="left:' + (tp0.x * 100) + '%;top:' + (tp0.y * 100) + '%"></div>';
    }
    initPosEditor(ed);
    wireEditorPreview(ed);
    wireReframe(ed);
    edRenderTimeline(ed);        // 字幕＋効果音 インライン縦タイムライン
    edRenderSfxPalette(ed);
    edWireLaneScrub(ed);
    edWireSelTelop(ed);
    edWirePlayheadSync(ed);
    // 字幕タイミング スライダー（per-clip・プレビュー即反映）
    (function () {
      const sr = ed.querySelector('.ed-suboff-range'), sv = ed.querySelector('.ed-suboff-val');
      if (!sr) return;
      sr.value = ed._subOffset; if (sv) sv.textContent = (+ed._subOffset).toFixed(2);
      sr.addEventListener('input', () => { ed._subOffset = +sr.value || 0; if (sv) sv.textContent = ed._subOffset.toFixed(2); renderPreviewTelops(ed); });
    })();
    updateEditorPreview(ed);
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
  ['.ed-capsz', '.ed-capol', '.ed-ttlsz', '.ed-ttlol'].forEach(s => {
    const e = ed.querySelector(s); if (e) e.addEventListener('input', upd);
  });
  const eAnim = ed.querySelector('.ed-anim');
  if (eAnim) eAnim.addEventListener('change', () => { updateEditorPreview(ed); renderPreviewTelops(ed, true); });
  const eEff = ed.querySelector('.ed-effect');
  if (eEff) eEff.addEventListener('change', upd);
  // 動画の再生位置に同期してプレビューのテロップを更新（全変更を反映）。
  // 再生中は動画自体に字幕が焼き込まれているため、編集用オーバーレイを隠して
  // 二重表示（見づらさ）を防ぐ。停止中だけ編集チップを重ねる。
  const v = _clipVideo(ed);
  if (v && !v._edPreviewWired) {
    v._edPreviewWired = true;
    const _re = () => { const e = document.getElementById('detailEditor'); if (e && e.dataset.loaded) renderPreviewTelops(e); };
    v.addEventListener('timeupdate', _re);
    v.addEventListener('seeking', _re);
    v.addEventListener('play', () => {
      const f = _edFrame(ed); if (f) f.classList.add('pv-playing');
      _re();
    });
    v.addEventListener('pause', () => {
      const f = _edFrame(ed); if (f) f.classList.remove('pv-playing');
      _re();
    });
  }
}

// render(_wrap_static) と同様に文字数で折返す近似（プレビューの行数を実描画に合わせ位置一致）
function _pvWrap(text, maxChars, maxLines) {
  // 手動改行（\n）は行構成として尊重（実描画の _wrap_static と同じ規則・最大4行）
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
  ct.innerHTML = _pvWrapHtml(titleTxt, Math.max(6, Math.floor(1080 * 0.66 / ttlSz)), 2);   // 0.66=実描画の_WIDTH_RATIOと一致（行数一致→位置一致）
  ct.style.fontFamily = ff;
  ct.style.color = pv.title;
  ct.style.fontSize = Math.max(7, ttlSz * sc) + 'px';
  ct.style.webkitTextStroke = Math.max(0, num('.ed-ttlol', 8) * sc).toFixed(1) + 'px ' + pv.titleOut;
  ct.style.background = 'transparent'; ct.style.padding = '0';
  renderPreviewTelops(ed);   // 再生位置にアクティブな全テロップを実スタイルで表示
  applyEditorFx(ed);
}

// 再生位置にアクティブな全テロップを、各テロップの位置・スタイルで表示（個別ドラッグ可）
// replay=true でアニメを再生（アニメ変更時のみ。timeupdate では再生せずチラつき回避）
// opts.frame/opts.telops/opts.noDrag で 字幕調整モーダル（#subFrame・_subDraft・ドラッグ無し）にも流用。
function renderPreviewTelops(ed, replay, opts) {
  opts = opts || {};
  const frame = opts.frame || _edFrame(ed);
  if (!frame) return;
  // 再生中は動画の焼き込み字幕が本物のプレビュー。編集チップを重ねると二重表示で
  // 見づらいため、停止中のみチップを描く（モーダル(opts.frame)や強制時は除外）。
  if (!opts.frame && !opts.force) {
    const vp = _clipVideo(ed);
    if (vp && !vp.paused && !vp.ended) {
      frame.querySelectorAll('.ed-tel-chip').forEach(n => n.remove());
      return;
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
  const capOl = (() => { const e = ed.querySelector('.ed-capol'); const n = e ? +e.value : NaN; return isNaN(n) ? 6 : n; })();
  const ff = pv.font ? `'${pv.font}', sans-serif` : 'sans-serif';
  const soff = +ed._subOffset || 0;   // 字幕タイミング（プレビューを実描画に合わせてずらす）
  telops.forEach((tp, ti) => {
    if (!tp.text || !tp.text.trim()) return;
    if (!(tp.start + soff <= t + 0.02 && t < tp.end + soff)) return;   // アクティブなテロップのみ（offset反映）
    const pos = tp.pos || def;
    const chip = document.createElement('div');
    chip.className = 'ed-chip ed-wys ed-tel-chip';
    chip.dataset.ti = ti;
    chip.style.left = (pos.x * 100) + '%'; chip.style.top = (pos.y * 100) + '%';
    chip.style.zIndex = 10 + (tp.layer || 0);
    chip.style.fontFamily = ff;
    let size = capSz, color = pv.sub;
    if (tp.emphasis) { size = capSz * 1.5; color = pv.emph || '#FFE600'; }
    else if (tp.style === 'laugh') { color = '#27E36B'; }
    else if (tp.style === 'comment') { color = '#202020'; }
    chip.innerHTML = _pvWrapHtml(tp.text, Math.max(6, Math.floor(1080 * 0.66 / size)), 2);   // 0.66=実描画の_WIDTH_RATIOと一致
    chip.style.color = color;
    chip.style.fontSize = Math.max(7, size * sc) + 'px';
    if (tp.style === 'comment') {
      chip.style.background = '#fff'; chip.style.padding = '2px 6px'; chip.style.borderRadius = '4px'; chip.style.webkitTextStroke = '0px transparent';
    } else if (pv.box && !tp.emphasis && !tp.style) {
      chip.style.background = hexToRgba(pv.boxColor, 0.5); chip.style.padding = '1px 5px'; chip.style.borderRadius = '4px'; chip.style.webkitTextStroke = '0px transparent';
    } else {
      chip.style.webkitTextStroke = Math.max(0, capOl * sc).toFixed(1) + 'px ' + (tp.emphasis ? '#000' : pv.out);
    }
    // クリップのエフェクト（光彩/ホラー/キラキラ）を静的に反映（入場アニメは付けずチラつき回避）
    const eff = ((ed.querySelector('.ed-effect') || {}).value) || 'none';
    if (eff === 'glow') chip.classList.add('pv-eff-glow');
    else if (eff === 'horror') chip.classList.add('pv-eff-horror');
    else if (eff === 'sparkle') chip.classList.add('pv-eff-sparkle');
    if (replay && !tp.emphasis) {   // アニメ変更時に入場アニメを再生
      const cfg = PV_ANIM[tp.animation || clipAnim] || PV_ANIM.default;
      if (cfg.name) { void chip.offsetWidth; chip.style.animation = `${cfg.name} ${cfg.dur}s ease-out ${cfg.iter || '1'} both`; }
    }
    if (!noDrag) _attachTelopChipDrag(ed, chip, ti);
    frame.appendChild(chip);
  });
}
function _attachTelopChipDrag(ed, chip, ti) {
  const frame = _edFrame(ed);
  let dragging = false;
  chip.addEventListener('pointerdown', e => {
    dragging = true; try { chip.setPointerCapture(e.pointerId); } catch (_) {} e.preventDefault();
  });
  chip.addEventListener('pointermove', e => {
    if (!dragging) return;
    const r = frame.getBoundingClientRect();
    const x = Math.max(0.03, Math.min(0.97, (e.clientX - r.left) / r.width));
    const y = Math.max(0.03, Math.min(0.97, (e.clientY - r.top) / r.height));
    chip.style.left = (x * 100) + '%'; chip.style.top = (y * 100) + '%';
    const tp = ed._telops[ti]; if (tp) tp.pos = { x: +x.toFixed(3), y: +y.toFixed(3) };
  });
  const up = e => { dragging = false; try { chip.releasePointerCapture(e.pointerId); } catch (_) {} };
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

/* ===== 字幕調整（縦タイムライン）モーダル ===== */
let _subEd = null, _subDraft = [], _subPristine = null, _subDur = 0, _subSelIdx = -1;
const SUB_PX_PER_SEC = 80, SUB_SNAP = 0.1, SUB_MIN_DUR = 0.2, SUB_MIN_BLOCK_PX = 14;

function _subClone(arr) {
  return (arr || []).map(t => ({
    start: +t.start || 0, end: +t.end || 0, text: t.text || '',
    style: t.style || '', emphasis: !!t.emphasis, animation: t.animation || '',
    layer: +t.layer || 0, pos: (t.pos && t.pos.x != null) ? { x: +t.pos.x, y: +t.pos.y } : null,
  }));
}
function _subVideo() { return document.getElementById('detailVideo'); }
function _subY2t(y) { return Math.max(0, Math.min(_subDur, y / SUB_PX_PER_SEC)); }
function _subT2y(t) { return t * SUB_PX_PER_SEC; }
function _subSnap(t) { return Math.round(t / SUB_SNAP) * SUB_SNAP; }
function _subClamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function _subFmt(s) { const m = Math.floor(s / 60), ss = Math.floor(s % 60); return m + ':' + ('0' + ss).slice(-2); }

function openSubModal() {
  const ed = document.getElementById('detailEditor');
  if (!ed || !ed._telops) return;   // クリップ未読込
  _subEd = ed;
  _subDur = ed._dur || 60;
  _subDraft = _subClone(ed._telops);
  if (!ed._telopsPristine) ed._telopsPristine = _subClone(ed._telops);   // 初回スナップショット
  _subPristine = (ed._telopsOrig && ed._telopsOrig.length) ? ed._telopsOrig : ed._telopsPristine;
  _subSelIdx = -1;
  const f = document.getElementById('subFrame');
  if (f) f.style.backgroundImage = ed._poster ? ('url(' + ed._poster + ')') : '';
  _subRenderTimeline();
  _subWireScrub();
  // 先にモーダルを表示してレイアウトを確定させる（#subFrame の実幅 200px を得てからプレビュー描画）
  document.getElementById('subModal').hidden = false;
  _subRenderPreview();
}
function subCancel() { document.getElementById('subModal').hidden = true; _subEd = null; }
function subReset() {
  _subDraft = _subClone(_subPristine || []);
  _subSelIdx = -1; _subRenderBlocks(); _subRenderPreview();
}
function subCommit() {
  if (_subEd) {
    _subDraft.sort((a, b) => a.start - b.start);
    _subEd._telops = _subClone(_subDraft);
    edRenderTelopBlocks(_subEd);
    if (typeof _syncTimelineTelops === 'function') { try { _syncTimelineTelops(_subEd); } catch (_) {} }
    renderPreviewTelops(_subEd, false);
  }
  document.getElementById('subModal').hidden = true; _subEd = null;
}

function _subRenderTimeline() {
  const track = document.getElementById('subTrack'), gutter = document.getElementById('subGutter');
  const h = Math.max(140, _subT2y(_subDur));
  track.style.height = h + 'px'; gutter.style.height = h + 'px';
  gutter.querySelectorAll('.sub-tick').forEach(n => n.remove());
  const step = _subDur > 40 ? 5 : 1;
  for (let s = 0; s <= Math.ceil(_subDur); s += step) {
    const tick = document.createElement('div');
    tick.className = 'sub-tick'; tick.style.top = _subT2y(s) + 'px';
    tick.innerHTML = '<span class="sub-tick-label">' + _subFmt(s) + '</span>';
    gutter.appendChild(tick);
  }
  _subRenderBlocks();
}
function _subRenderBlocks() {
  const track = document.getElementById('subTrack');
  track.querySelectorAll('.sub-block').forEach(n => n.remove());   // #subPlayhead は残す
  _subDraft.forEach((tp, i) => {
    const top = _subT2y(tp.start);
    const hh = Math.max(SUB_MIN_BLOCK_PX, _subT2y(tp.end) - _subT2y(tp.start));
    const el = document.createElement('div');
    el.className = 'sub-block' + (i === _subSelIdx ? ' sel' : '');
    el.style.top = top + 'px'; el.style.height = hh + 'px'; el.dataset.i = i;
    el.innerHTML =
      '<div class="sub-grip sub-grip-top"></div>' +
      '<button type="button" class="sub-del" tabindex="-1">✕</button>' +
      '<div class="sub-block-body"><textarea class="sub-block-text" rows="1" placeholder="字幕を入力">' +
        esc(tp.text || '') + '</textarea></div>' +
      '<div class="sub-grip sub-grip-bot"></div>';
    if (hh < 22) el.querySelectorAll('.sub-grip').forEach(g => g.style.height = Math.max(4, hh * 0.3) + 'px');
    _subWireBlock(el, i);
    track.appendChild(el);
  });
}
function _subMarkSel() {
  document.querySelectorAll('#subTrack .sub-block').forEach(n => n.classList.toggle('sel', +n.dataset.i === _subSelIdx));
}
function _subWireBlock(el, i) {
  let mode = null, startY = 0, t0s = 0, t0e = 0;
  const topG = el.querySelector('.sub-grip-top'), botG = el.querySelector('.sub-grip-bot');
  const ta = el.querySelector('.sub-block-text');
  topG.addEventListener('pointerenter', e => _subTip(e, 'ドラッグで開始時刻を変更'));
  topG.addEventListener('pointerleave', _subTipHide);
  botG.addEventListener('pointerenter', e => _subTip(e, 'ドラッグで終了時刻を変更'));
  botG.addEventListener('pointerleave', _subTipHide);
  el.addEventListener('pointerdown', e => {
    if (e.target.classList.contains('sub-block-text') || e.target.classList.contains('sub-del')) return;
    _subSelIdx = i; _subMarkSel();
    mode = e.target.classList.contains('sub-grip-top') ? 'top'
         : e.target.classList.contains('sub-grip-bot') ? 'bot' : 'move';
    const tp = _subDraft[i]; t0s = tp.start; t0e = tp.end; startY = e.clientY;
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault(); e.stopPropagation();
  });
  el.addEventListener('pointermove', e => {
    if (!mode) return;
    const tp = _subDraft[i]; if (!tp) return;
    const dt = _subSnap((e.clientY - startY) / SUB_PX_PER_SEC);
    if (mode === 'move') {
      const len = t0e - t0s;
      const s = _subClamp(t0s + dt, 0, _subDur - len);
      tp.start = +s.toFixed(2); tp.end = +(s + len).toFixed(2);
    } else if (mode === 'top') {
      tp.start = +_subClamp(t0s + dt, 0, tp.end - SUB_MIN_DUR).toFixed(2);
    } else {
      tp.end = +_subClamp(t0e + dt, tp.start + SUB_MIN_DUR, _subDur).toFixed(2);
    }
    el.style.top = _subT2y(tp.start) + 'px';
    el.style.height = Math.max(SUB_MIN_BLOCK_PX, _subT2y(tp.end) - _subT2y(tp.start)) + 'px';
    _subSyncScrubToBlock(tp, mode);
  });
  const up = e => { if (!mode) return; mode = null; try { el.releasePointerCapture(e.pointerId); } catch (_) {} _subRenderPreview(); };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  ta.addEventListener('input', () => { if (_subDraft[i]) { _subDraft[i].text = ta.value; _subRenderPreview(); } });
  ta.addEventListener('pointerdown', e => e.stopPropagation());
  el.querySelector('.sub-del').addEventListener('click', e => {
    e.stopPropagation();
    _subDraft.splice(i, 1);
    if (_subSelIdx === i) _subSelIdx = -1;
    _subRenderBlocks(); _subRenderPreview();
  });
}
function _subAddAt(t) {
  const s = _subSnap(_subClamp(t, 0, _subDur - SUB_MIN_DUR));
  const len = Math.min(1.5, Math.max(SUB_MIN_DUR, _subDur - s));
  _subDraft.push({ start: +s.toFixed(2), end: +(s + len).toFixed(2), text: '',
    style: '', emphasis: false, animation: '', layer: 0, pos: null });
  _subDraft.sort((a, b) => a.start - b.start);
  _subSelIdx = _subDraft.findIndex(x => Math.abs(x.start - s) < 1e-6);
  _subRenderBlocks();
  const inp = document.querySelector('.sub-block[data-i="' + _subSelIdx + '"] .sub-block-text');
  if (inp) inp.focus();
}
function _subWireScrub() {
  const modal = document.getElementById('subModal');
  if (modal.dataset.wired) return; modal.dataset.wired = '1';
  const track = document.getElementById('subTrack');
  let downY = null, moved = false;
  track.addEventListener('pointerdown', e => {
    if (e.target.closest('.sub-block')) return;
    downY = e.clientY; moved = false;
    try { track.setPointerCapture(e.pointerId); } catch (_) {}
  });
  track.addEventListener('pointermove', e => {
    if (downY == null) return;
    if (Math.abs(e.clientY - downY) > 4) moved = true;
    if (moved) _subScrubTo(e.clientY);
  });
  track.addEventListener('pointerup', e => {
    if (downY == null) return;
    if (!moved && !e.target.closest('.sub-block')) {
      const r = track.getBoundingClientRect();
      _subAddAt(_subY2t(e.clientY - r.top));
    }
    downY = null; try { track.releasePointerCapture(e.pointerId); } catch (_) {}
  });
}
function _subScrubTo(clientY) {
  const r = document.getElementById('subTrack').getBoundingClientRect();
  const t = _subY2t(clientY - r.top);
  const v = _subVideo(); if (v) { try { v.currentTime = t; } catch (_) {} }
  _subPlayheadTo(t); _subRenderPreview();
  document.getElementById('subTimeRead').textContent = t.toFixed(1) + 's';
}
function _subPlayheadTo(t) { const p = document.getElementById('subPlayhead'); if (p) p.style.top = _subT2y(t) + 'px'; }
function _subSyncScrubToBlock(tp, mode) {
  const t = (mode === 'bot') ? tp.end : tp.start;
  const v = _subVideo(); if (v) { try { v.currentTime = Math.max(0, t + 0.02); } catch (_) {} }
  _subPlayheadTo(t);
  document.getElementById('subTimeRead').textContent = t.toFixed(1) + 's';
  _subRenderPreview();
}
function _subRenderPreview() {
  if (!_subEd) return;
  const frame = document.getElementById('subFrame');
  renderPreviewTelops(_subEd, false, { frame: frame, telops: _subDraft, noDrag: true });
}
function _subTip(e, msg) {
  const tip = document.getElementById('subTooltip');
  tip.textContent = msg; tip.hidden = false;
  tip.style.left = (e.clientX + 12) + 'px'; tip.style.top = (e.clientY + 12) + 'px';
}
function _subTipHide() { const t = document.getElementById('subTooltip'); if (t) t.hidden = true; }

function applyEditorFx(ed) {
  const a = (ed.querySelector('.ed-anim') || {}).value || 'default';
  const e = (ed.querySelector('.ed-effect') || {}).value || 'none';
  const cfg = PV_ANIM[a] || PV_ANIM.default;
  // タイトルに入場アニメ＋エフェクト（テロップチップは renderPreviewTelops が静的に装飾）
  const _fr = _edFrame(ed);
  const el = _fr && _fr.querySelector('.ed-ct');
  if (el) {
    el.classList.remove('pv-eff-glow', 'pv-eff-horror', 'pv-eff-sparkle');
    if (e === 'glow') el.classList.add('pv-eff-glow');
    else if (e === 'horror') el.classList.add('pv-eff-horror');
    else if (e === 'sparkle') el.classList.add('pv-eff-sparkle');
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
    let dragging = false, resizing = false, rz = null;
    const move = (cx, cy) => {
      const r = frame.getBoundingClientRect();
      const x = Math.max(0.03, Math.min(0.97, (cx - r.left) / r.width));
      const y = Math.max(0.03, Math.min(0.97, (cy - r.top) / r.height));
      chip.style.left = (x * 100) + '%'; chip.style.top = (y * 100) + '%';
      const pos = { x: +x.toFixed(3), y: +y.toFixed(3) };
      if (isTitle) ed._titlePos = pos; else ed._capPos = pos;
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
      try { chip.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
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
      else if (dragging) move(e.clientX, e.clientY);
    });
    const up = e => { dragging = false; resizing = false; try { chip.releasePointerCapture(e.pointerId); } catch (_) {} };
    chip.addEventListener('pointerup', up);
    chip.addEventListener('pointercancel', up);
  });
  const bind = (sel, out) => {
    const i = ed.querySelector(sel), o = ed.querySelector(out);
    if (i && o) i.addEventListener('input', () => { o.textContent = i.value; });
  };
  bind('.ed-capsz', '.ed-capsz-o'); bind('.ed-ttlsz', '.ed-ttlsz-o');
  bind('.ed-capol', '.ed-capol-o'); bind('.ed-ttlol', '.ed-ttlol-o');
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
    if (tp.layer) o.layer = tp.layer;
    if (tp.pos && tp.pos.x != null) o.pos = { x: tp.pos.x, y: tp.pos.y };
    return o;
  });
  const style = {};
  const q = (sel, key) => { const e = ed.querySelector(sel); if (e) style[key] = +e.value; };
  q('.ed-capsz', 'caption_size'); q('.ed-ttlsz', 'title_size');
  q('.ed-capol', 'outline_width'); q('.ed-ttlol', 'title_outline_width');
  const qs = (sel, key) => { const e = ed.querySelector(sel); if (e) style[key] = e.value; };
  qs('.ed-anim', 'animation'); qs('.ed-effect', 'effect');
  const num = sel => { const e = ed.querySelector(sel); return e ? (+e.value || 0) : 0; };
  const out = {
    title, telops, style,
    caption_pos: ed._capPos, title_pos: ed._titlePos,
    extend_start: num('.ed-ext-s'), extend_end: num('.ed-ext-e'),
  };
  const rf = ed.querySelector('.ed-reframe'); if (rf) out.reframe = rf.value;          // 画面構成
  const lb = ed.querySelector('.ed-lb-color'); if (lb) out.letterbox_color = lb.value;  // 帯の色
  if (ed._subOffset != null) out.sub_offset = +ed._subOffset || 0;                     // 字幕タイミング
  return out;
}
function _timelineSfx(tl) {
  return (tl._blocks || []).map(b => ({ id: b.id, at: +b.at.toFixed(3), gain: +b.gain.toFixed(3) }));
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
    if (reload) { ed.dataset.loaded = ''; loadEditor(ed); }
  } catch (e) {
    _vRestore(cap, job, cid);   // 失敗時もプレビューを復帰
    st.textContent = 'エラー: ' + e.message;
  }
  btn.disabled = false;
}

// ===== 効果音タイムライン（per-clip。サーバ波形＋ドラッグ配置→amixで焼き込み） =====
let _sfxListCache = null;
let _uidN = 1;
let _tlAudio = null;   // 試聴用 <audio> は1つだけ使い回す
async function getSfxList() {
  if (!_sfxListCache) _sfxListCache = await (await fetch('/api/sfx')).json();
  return _sfxListCache;
}
function _auditionSfx(file, gain) {
  if (!file) return;
  if (!_tlAudio) _tlAudio = new Audio();
  const url = '/sfx/' + encodeURIComponent(file);
  if (_tlAudio.src.indexOf('/sfx/' + encodeURIComponent(file)) < 0) _tlAudio.src = url;
  _tlAudio.volume = Math.max(0, Math.min(1, gain));   // <audio>.volume は最大1（>1はffmpeg側で適用）
  try { _tlAudio.currentTime = 0; } catch (_) {}
  _tlAudio.play().catch(() => {});
}
function _tlVideo(tl) { return _clipVideo(tl); }
function _selBlock(tl) { return (tl._blocks || []).find(b => b.uid === tl._selUid) || null; }

function toggleTimeline(btn) {
  const tl = btn.parentElement.querySelector('.clip-timeline');
  if (!tl) return;
  if (!tl.hidden) { tl.hidden = true; return; }
  tl.hidden = false;
  if (!tl.dataset.loaded) loadTimeline(tl);
}

async function loadTimeline(tl) {
  const job = tl.dataset.job, cid = tl.dataset.cid;
  tl.innerHTML = '<div class="ed-loading">読み込み中...</div>';
  try {
    const [clip, wf, list] = await Promise.all([
      fetch('/api/clip/' + job + '/' + cid).then(r => r.json()),
      fetch('/api/clip/' + job + '/' + cid + '/waveform').then(r => r.json()),
      getSfxList(),
    ]);
    tl._dur = wf.duration || clip.clip_duration || 0;
    tl._peaks = wf.peaks || [];
    tl._byId = Object.fromEntries(list.map(s => [s.id, s]));
    tl._blocks = (clip.sfx || []).map(s => ({
      uid: 'b' + (_uidN++), id: s.id, at: +s.at || 0, gain: s.gain == null ? 1 : +s.gain,
    }));
    tl._selUid = null;
    renderTimeline(tl, list);
    tl.dataset.loaded = '1';
  } catch (e) {
    tl.innerHTML = '<div class="ed-loading">読み込みに失敗しました</div>';
  }
}

function renderTimeline(tl, list) {
  const pal = list.map(s =>
    '<button type="button" class="sfx-chip" data-id="' + esc(s.id) + '">' +
    (s.emoji ? s.emoji + ' ' : '') + esc(s.label) +
    '<span class="sfx-dur">' + (s.dur || 0).toFixed(1) + 's</span></button>'
  ).join('');
  tl.innerHTML =
    '<div class="tl-help">上段＝<b>テロップ</b>（青・ドラッグで時間移動・「＋テロップ」で追加→字幕欄に反映）／下段＝<b>効果音</b>（パレットで再生位置に追加）。波形をドラッグで再生位置移動。</div>' +
    '<div class="tl-pal"><button type="button" class="mini-btn tl-addtel">＋テロップ</button>' + pal + '</div>' +
    '<div class="tl-area">' +
      '<div class="tl-tel-track"></div>' +
      '<canvas class="tl-wave" height="48"></canvas>' +
      '<div class="tl-track"></div>' +
      '<div class="tl-ruler"></div>' +
      '<div class="tl-playhead"></div>' +
    '</div>' +
    '<div class="tl-sel" hidden>' +
      '<label class="slider-item">選択中の音量 <b class="tl-gain-o">100%</b>' +
        '<input type="range" class="tl-gain" min="0" max="200" step="5" value="100"></label>' +
      '<button type="button" class="mini-btn tl-prev">▶ 試聴</button>' +
      '<button type="button" class="mini-btn tl-snap">再生位置へ</button>' +
      '<button type="button" class="mini-btn tl-del">削除</button>' +
    '</div>' +
    '<div class="ed-actions"><button class="ed-save" onclick="saveTimeline(this)">効果音を反映して再作成</button>' +
      '<span class="ed-status"></span></div>';

  tl.querySelectorAll('.sfx-chip').forEach(b =>
    b.addEventListener('click', () => addSfxBlock(tl, b.dataset.id)));
  const addTel = tl.querySelector('.tl-addtel');
  if (addTel) addTel.addEventListener('click', () => {
    const ed = document.getElementById('detailEditor');
    if (ed && ed.dataset.loaded) { const v = _tlVideo(tl); addTelop(ed, v ? v.currentTime : 0); }
  });
  const gain = tl.querySelector('.tl-gain');
  gain.addEventListener('input', () => {
    const b = _selBlock(tl); if (!b) return;
    b.gain = (+gain.value) / 100;
    tl.querySelector('.tl-gain-o').textContent = gain.value + '%';
  });
  tl.querySelector('.tl-prev').addEventListener('click', () => {
    const b = _selBlock(tl); if (b) _auditionSfx((tl._byId[b.id] || {}).file, b.gain);
  });
  tl.querySelector('.tl-snap').addEventListener('click', () => {
    const b = _selBlock(tl), v = _tlVideo(tl); if (!b || !v) return;
    b.at = Math.max(0, Math.min(tl._dur, v.currentTime || 0));
    layoutBlocks(tl);
  });
  tl.querySelector('.tl-del').addEventListener('click', () => {
    const b = _selBlock(tl); if (!b) return;
    tl._blocks = tl._blocks.filter(x => x.uid !== b.uid);
    tl._selUid = null; tl.querySelector('.tl-sel').hidden = true; layoutBlocks(tl);
  });

  drawWave(tl);
  layoutBlocks(tl);
  layoutTelopBlocks(tl, document.getElementById('detailEditor'));
  wireTimeline(tl);
}

// タイムラインのテロップトラック（編集UI ed._telops を可視化・ドラッグで時刻変更・追加と同期）
function layoutTelopBlocks(tl, ed) {
  const track = tl.querySelector('.tl-tel-track');
  if (!track) return;
  track.innerHTML = '';
  if (!ed || !ed._telops) return;
  const dur = tl._dur || ed._dur || 1;
  let maxLayer = 0;
  ed._telops.forEach(t => { maxLayer = Math.max(maxLayer, t.layer || 0); });
  // 高レイヤーを上の段に（前面）。各レイヤーごとに行を作り、重なるテロップを段で分離。
  for (let L = maxLayer; L >= 0; L--) {
    const row = document.createElement('div');
    row.className = 'tl-tel-row'; row.dataset.layer = L;
    ed._telops.forEach((tp, i) => {
      if ((tp.layer || 0) !== L) return;
      const el = document.createElement('div');
      el.className = 'tl-tel-block';
      el.style.left = (Math.max(0, tp.start) / dur * 100) + '%';
      el.style.width = Math.max(2, (Math.max(0.2, tp.end - tp.start)) / dur * 100) + '%';
      el.textContent = 'L' + L + ' ' + (tp.text || '（空）').slice(0, 10);
      el.title = tp.text || '';
      el.dataset.i = i;
      _attachTelopDrag(tl, ed, el, i, track);
      row.appendChild(el);
    });
    track.appendChild(row);
  }
}
function _attachTelopDrag(tl, ed, el, i, track) {
  track = track || tl.querySelector('.tl-tel-track');
  let dragging = false, dur0 = 0, rows = 1;
  el.addEventListener('pointerdown', e => {
    dragging = true; dur0 = (ed._telops[i].end - ed._telops[i].start) || 1;
    rows = track.querySelectorAll('.tl-tel-row').length || 1;
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault(); e.stopPropagation();
  });
  el.addEventListener('pointermove', e => {
    if (!dragging) return;
    const tp = ed._telops[i]; if (!tp) return;
    const r = track.getBoundingClientRect();
    const dur = tl._dur || ed._dur || 1;
    const s = Math.max(0, Math.min(dur - 0.2, (e.clientX - r.left) / r.width * dur));
    tp.start = +s.toFixed(2); tp.end = +Math.min(dur, s + dur0).toFixed(2);
    el.style.left = (s / dur * 100) + '%';
    const row = ed.querySelector('.ed-row[data-i="' + i + '"]');   // 該当行の時刻入力だけ同期
    if (row) {
      const si = row.querySelector('.ed-t-s'), ei = row.querySelector('.ed-t-e');
      if (si) si.value = tp.start.toFixed(1);
      if (ei) ei.value = tp.end.toFixed(1);
    }
  });
  const up = e => {
    if (!dragging) return; dragging = false;
    try { el.releasePointerCapture(e.pointerId); } catch (_) {}
    const tp = ed._telops[i];
    // 離した縦位置からレイヤーを決定（上の段＝高レイヤー＝前面）
    if (tp && rows > 1) {
      const r = track.getBoundingClientRect();
      const idxTop = Math.max(0, Math.min(rows - 1, Math.floor((e.clientY - r.top) / (r.height / rows))));
      const newLayer = (rows - 1) - idxTop;
      if (tp.layer !== newLayer) {
        tp.layer = newLayer;
        layoutTelopBlocks(tl, ed); edRenderTelopBlocks(ed); updateEditorPreview(ed);
        return;
      }
    }
    updateEditorPreview(ed);
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

function drawWave(tl) {
  const c = tl.querySelector('.tl-wave');
  if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = c.clientWidth || (c.parentElement ? c.parentElement.clientWidth : 0) || 600;
  const cssH = c.clientHeight || 56;
  c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr);
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const peaks = tl._peaks || [];
  if (!peaks.length) return;
  const bw = cssW / peaks.length, mid = cssH / 2;
  ctx.fillStyle = 'rgba(37,244,238,.45)';
  for (let i = 0; i < peaks.length; i++) {
    const h = Math.max(1, peaks[i] * (cssH - 4));
    ctx.fillRect(i * bw, mid - h / 2, Math.max(1, bw - 1), h);
  }
}

function layoutBlocks(tl) {
  const track = tl.querySelector('.tl-track');
  if (!track) return;
  track.innerHTML = '';
  const dur = tl._dur || 1;
  (tl._blocks || []).forEach(b => {
    const meta = tl._byId[b.id] || {};
    const el = document.createElement('div');
    el.className = 'sfx-block' + (b.uid === tl._selUid ? ' sel' : '');
    el.style.left = (b.at / dur * 100) + '%';
    el.style.width = Math.max(2.5, (meta.dur || 0.3) / dur * 100) + '%';
    el.textContent = meta.emoji || '♪';
    el.title = (meta.label || b.id) + ' @' + b.at.toFixed(2) + 's';
    el.dataset.uid = b.uid;
    _attachBlockDrag(tl, el, b);
    track.appendChild(el);
  });
}

function _attachBlockDrag(tl, el, b) {
  const track = tl.querySelector('.tl-track');
  let dragging = false;
  el.addEventListener('pointerdown', e => {
    dragging = true;
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    _selectBlock(tl, b.uid, true); e.preventDefault(); e.stopPropagation();   // 選択＝試聴
  });
  el.addEventListener('pointermove', e => {
    if (!dragging) return;
    const r = track.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    b.at = +(x * (tl._dur || 0)).toFixed(3);
    el.style.left = (x * 100) + '%';
    el.title = ((tl._byId[b.id] || {}).label || b.id) + ' @' + b.at.toFixed(2) + 's';
  });
  const end = e => {
    if (!dragging) return; dragging = false;
    try { el.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

function _selectBlock(tl, uid, audition) {
  tl._selUid = uid;
  tl.querySelectorAll('.sfx-block').forEach(n => n.classList.toggle('sel', n.dataset.uid === uid));
  const b = _selBlock(tl);
  const sel = tl.querySelector('.tl-sel');
  sel.hidden = !b;
  if (b) {
    const g = tl.querySelector('.tl-gain');
    g.value = Math.round(b.gain * 100);
    tl.querySelector('.tl-gain-o').textContent = g.value + '%';
    if (audition) _auditionSfx((tl._byId[b.id] || {}).file, b.gain);   // 選択で試聴
  }
}

function addSfxBlock(tl, id) {
  const v = _tlVideo(tl);
  const at = v ? Math.max(0, Math.min(tl._dur, v.currentTime || 0)) : 0;
  const b = { uid: 'b' + (_uidN++), id: id, at: +at.toFixed(3), gain: 1 };
  (tl._blocks = tl._blocks || []).push(b);
  layoutBlocks(tl);
  _selectBlock(tl, b.uid);
  _auditionSfx((tl._byId[id] || {}).file, 1);
}

function wireTimeline(tl) {
  const v = _tlVideo(tl);
  const area = tl.querySelector('.tl-area');
  const head = tl.querySelector('.tl-playhead');
  if (!v || !area || !head) return;
  const place = () => {
    head.style.left = (tl._dur ? Math.max(0, Math.min(1, v.currentTime / tl._dur)) * 100 : 0) + '%';
  };
  v.addEventListener('timeupdate', place);
  v.addEventListener('seeking', place);
  v.addEventListener('seeked', place);
  let raf = null;
  const tick = () => { place(); raf = requestAnimationFrame(tick); };   // 再生中はrAFでなめらか
  v.addEventListener('play', () => { if (!raf) tick(); });
  v.addEventListener('pause', () => { if (raf) { cancelAnimationFrame(raf); raf = null; } place(); });

  // スクラブ＝タイムライン全域(波形＋ルーラー)をドラッグで再生位置移動。ブロック上は無視。
  let scrubbing = false;
  const scrubAt = cx => {
    const r = area.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (cx - r.left) / r.width));
    v.currentTime = x * (tl._dur || 0);
    place();
  };
  area.addEventListener('pointerdown', e => {
    if (e.target.closest('.sfx-block')) return;     // ブロックは移動操作なのでスクラブしない
    scrubbing = true;
    try { area.setPointerCapture(e.pointerId); } catch (_) {}
    scrubAt(e.clientX); e.preventDefault();
  });
  area.addEventListener('pointermove', e => { if (scrubbing) scrubAt(e.clientX); });
  const endScrub = e => { if (!scrubbing) return; scrubbing = false; try { area.releasePointerCapture(e.pointerId); } catch (_) {} };
  area.addEventListener('pointerup', endScrub);
  area.addEventListener('pointercancel', endScrub);
  place();
  if (!tl._rzWired) {
    window.addEventListener('resize', () => {
      if (tl.hidden) return;
      clearTimeout(tl._rzT);
      tl._rzT = setTimeout(() => { drawWave(tl); place(); }, 100);
    });
    tl._rzWired = true;
  }
}

async function saveTimeline(btn) {
  const tl = btn.closest('.clip-timeline');
  const job = tl.dataset.job, cid = tl.dataset.cid;
  const st = tl.querySelector('.ed-status');
  st.textContent = '効果音をミックスして再作成中...';
  btn.disabled = true;
  const cap = _vCaps(_clipVideo(tl));   // 再作成前に解放（WinError5対策）
  _vRelease(cap);
  try {
    const resp = await fetch('/api/clip/' + job + '/' + cid, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sfx: _timelineSfx(tl) }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || '失敗しました');
    _vRestore(cap, job, cid);
    if (!tl.closest('.clip-card')) _bustGridCard(job, cid);   // 詳細ページ→グリッドも更新
    st.textContent = '✓ 効果音を反映しました';
  } catch (e) {
    _vRestore(cap, job, cid);   // 失敗時もプレビューを復帰
    st.textContent = 'エラー: ' + e.message;
  }
  btn.disabled = false;
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
    effect: v('effectSelect'),
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
  [t, c].forEach(el => {
    el.classList.remove('pv-eff-glow', 'pv-eff-horror', 'pv-eff-sparkle');
    if (s.effect === 'glow') el.classList.add('pv-eff-glow');
    else if (s.effect === 'horror') el.classList.add('pv-eff-horror');
    else if (s.effect === 'sparkle') el.classList.add('pv-eff-sparkle');
  });
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
  document.querySelectorAll('.clip-editor, .clip-timeline').forEach(el => {
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
