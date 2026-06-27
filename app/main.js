// Electron メインプロセス。
// 1) 空きポートを確保 → 2) Python バックエンド(FastAPI)を spawn → 3) BACKEND_READY を待つ
// → 4) localhost をウィンドウに読み込む。ネイティブのファイル選択/保存も提供する。
const { app, BrowserWindow, ipcMain, dialog, safeStorage } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');

// ===== ライセンス（オフライン検証: HMAC-SHA256(secret, email)）=====
// 注: secret は同梱コードに埋め込まれるため強固な保護ではない（初期運用向け）。将来はサーバ検証へ。
const LICENSE_SECRET = '6c96f5f60e9d70d42b82a552e06c890bcddeddf00c9d5f4f48ab36557437f408';
function _normEmail(e) { return String(e || '').trim().toLowerCase(); }
function _fmtKey(hex) { return hex.slice(0, 16).toUpperCase().replace(/(.{4})/g, '$1-').replace(/-$/, ''); }
function _licKeyFor(email) {
  return _fmtKey(crypto.createHmac('sha256', LICENSE_SECRET).update(_normEmail(email)).digest('hex'));
}
const MASTER_KEY = _fmtKey(crypto.createHmac('sha256', LICENSE_SECRET).update('::MASTER::').digest('hex'));
function _normKey(k) { return String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function validateLicense(email, key) {
  const nk = _normKey(key);
  if (!nk) return false;
  if (nk === _normKey(MASTER_KEY)) return true;        // マスターキーは任意メールで通る
  if (!_normEmail(email)) return false;
  return nk === _normKey(_licKeyFor(email));
}

const PROJECT_ROOT = path.join(__dirname, '..');

// バックエンドと一致させる出力先（パッケージ版は書き込み可能な LOCALAPPDATA 配下）
function resolveOutputRoot() {
  const s = loadSettings();
  if (s.outputDir) return s.outputDir;   // ユーザー指定の保存先を優先
  if (app.isPackaged) {
    const base = process.env.LOCALAPPDATA || app.getPath('home');
    return path.join(base, 'TikTok-Cut', 'output');
  }
  return path.join(PROJECT_ROOT, 'output');
}
// UI(web) の場所。パッケージ版は extraResources の web を使う（UI 更新を再ビルド不要に）
function resolveWebDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(PROJECT_ROOT, 'web');
}
const OUTPUT_ROOT = resolveOutputRoot();

// ユーザー設定（Gemini APIキー等）は userData/settings.json に保存
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch (_) {
    return {};
  }
}
function saveSettings(obj) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(obj || {}, null, 2), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

// API キーは OS の暗号化(DPAPI)で保存。平文 "AIza…" を残さず、セキュリティ製品の隔離を回避。
function decodeKey(s) {
  try {
    if (s.geminiKeyEnc && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(s.geminiKeyEnc, 'base64'));
    }
  } catch (_) { /* ignore */ }
  if (s.geminiKeyB64) return Buffer.from(s.geminiKeyB64, 'base64').toString('utf8');
  return s.geminiKey || '';
}
function encodeKey(raw) {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { geminiKeyEnc: safeStorage.encryptString(raw).toString('base64') };
    }
  } catch (_) { /* ignore */ }
  return { geminiKeyB64: Buffer.from(raw, 'utf8').toString('base64') };
}

let backendProc = null;
let mainWindow = null;
let splashWindow = null;
let backendPort = null;
let updateWindow = null;

// 起動演出: バックエンド準備中（初回はモデルDLで長め）に出すスプラッシュ。
function createSplash() {
  splashWindow = new BrowserWindow({
    width: 440, height: 520,
    frame: false, resizable: false, movable: true, center: true,
    alwaysOnTop: true, skipTaskbar: false, backgroundColor: '#0e0f13',
    title: 'TikTok-Cut',
    icon: path.join(PROJECT_ROOT, 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'), { search: `v=${app.getVersion()}` });
  splashWindow.on('closed', () => { splashWindow = null; });
}
function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    try { splashWindow.close(); } catch (_) { /* ignore */ }
  }
  splashWindow = null;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// バックエンド起動コマンドを解決（パッケージ版は同梱 exe、開発版は python -m backend.server）
function backendCommand(port) {
  const exe = path.join(process.resourcesPath || '', 'backend', 'TikTok-Cut-Backend.exe');
  if (app.isPackaged && fs.existsSync(exe)) {
    return { cmd: exe, args: ['--port', String(port)] };
  }
  const py = process.platform === 'win32' ? 'python' : 'python3';
  return { cmd: py, args: ['-m', 'backend.server', '--port', String(port)] };
}

function startBackend(port) {
  return new Promise((resolve, reject) => {
    const { cmd, args } = backendCommand(port);
    const s = loadSettings();
    const extra = {};
    const proxyUrl = s.geminiProxyUrl || 'https://dssutndhlawyjvyneyft.supabase.co/functions/v1/gemini-proxy';
    extra.GEMINI_PROXY_URL = proxyUrl;
    if (s.llmProvider) extra.LLM_PROVIDER = s.llmProvider;
    if (s.llmModel) extra.LLM_MODEL = s.llmModel;
    if (s.whisperModel) extra.WHISPER_MODEL = s.whisperModel;
    if (s.tiktokHandle) extra.TIKTOKCUT_HANDLE = String(s.tiktokHandle);
    if (s.logoPath) extra.TIKTOKCUT_LOGO = String(s.logoPath);
    if (s.customVocab) extra.TIKTOKCUT_VOCAB = String(s.customVocab);
    extra.CORRECT_SUBTITLES = s.correctSubtitles ? '1' : '0';
    backendProc = spawn(cmd, args, {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env, PYTHONUTF8: '1',
        TIKTOKCUT_OUTPUT: OUTPUT_ROOT,
        TIKTOKCUT_WEB: resolveWebDir(),
        ...extra,
      },
      windowsHide: true,
    });

    // バックエンドの出力をログファイルにも残す（パッケージ版は stdout が見えないため診断用）
    let logStream = null;
    try {
      const logDir = app.isPackaged
        ? path.join(process.env.LOCALAPPDATA || app.getPath('home'), 'TikTok-Cut')
        : OUTPUT_ROOT;
      fs.mkdirSync(logDir, { recursive: true });
      logStream = fs.createWriteStream(path.join(logDir, 'backend.log'), { flags: 'a' });
      logStream.write(`\n===== ${new Date().toISOString()} backend start (port ${port}) =====\n`);
    } catch (_) { /* ignore */ }
    const writeLog = (s) => { try { if (logStream) logStream.write(s); } catch (_) {} };

    let stderrTail = '';
    const onLine = (buf) => {
      const text = buf.toString();
      process.stdout.write(`[backend] ${text}`);
      writeLog(text);
      if (text.includes(`BACKEND_READY:${port}`)) resolve();
    };
    backendProc.stdout.on('data', onLine);
    backendProc.stderr.on('data', (b) => {
      const t = b.toString();
      process.stdout.write(`[backend:err] ${t}`);
      writeLog(t);
      stderrTail = (stderrTail + t).slice(-4000);
      if (t.includes(`BACKEND_READY:${port}`)) resolve(); // uvicorn は stderr に出す場合あり
    });
    backendProc.on('error', (e) => reject(new Error(`バックエンド起動失敗: ${e.message}`)));
    backendProc.on('exit', (code) => {
      writeLog(`\n===== backend exited (code ${code}) =====\n`);
      if (code) reject(new Error(`バックエンドが終了しました (code ${code})\n${stderrTail}`));
    });
    setTimeout(() => reject(new Error('バックエンドの起動がタイムアウトしました')), 120000);
  });
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 880,
    minHeight: 680,
    show: false,            // 準備完了まで隠し、スプラッシュから滑らかに切り替える
    backgroundColor: '#0e0f13',
    title: `TikTok-Cut v${app.getVersion()}`,
    icon: path.join(PROJECT_ROOT, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL(`http://127.0.0.1:${port}`);
  // UI 読み込み完了でメインを表示しスプラッシュを閉じる（白画面のチラつきを防ぐ）。
  mainWindow.webContents.once('did-finish-load', () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
    closeSplash();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function killBackend() {
  if (backendProc && !backendProc.killed) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(backendProc.pid), '/f', '/t'], { windowsHide: true });
      } else {
        backendProc.kill('SIGTERM');
      }
    } catch (_) { /* ignore */ }
    backendProc = null;
  }
}

// ---- IPC: ネイティブファイル選択 ----
ipcMain.handle('select-video', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '配信アーカイブ動画を選択',
    properties: ['openFile'],
    filters: [{ name: '動画', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi'] }],
  });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
});

// ---- IPC: 生成クリップの保存 ----
ipcMain.handle('save-file', async (_e, serverPath, saveName) => {
  const abs = path.join(OUTPUT_ROOT, serverPath);
  if (!fs.existsSync(abs)) return { error: 'ファイルが見つかりません' };
  const res = await dialog.showSaveDialog(mainWindow, {
    defaultPath: saveName || path.basename(abs),
    filters: [{ name: 'MP4 動画', extensions: ['mp4'] }],
  });
  if (res.canceled) return { cancelled: true };
  fs.copyFileSync(abs, res.filePath);
  return { ok: true, path: res.filePath };
});

// ---- IPC: 保存先フォルダ選択 ----
ipcMain.handle('select-folder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '保存先フォルダを選択', properties: ['openDirectory', 'createDirectory'],
  });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
});

// ---- IPC: ロゴ画像選択 ----
ipcMain.handle('select-logo', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'ロゴ画像を選択（透過PNG推奨）', properties: ['openFile'],
    filters: [{ name: '画像', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
});

// ---- IPC: ライセンス ----
ipcMain.handle('get-license', () => {
  const s = loadSettings();
  const lic = s.license || null;
  return { licensed: lic ? validateLicense(lic.email, lic.key) : false, email: lic ? lic.email : '' };
});
ipcMain.handle('validate-license', (_e, email, key) => ({ ok: validateLicense(email, key) }));
ipcMain.handle('save-license', (_e, email, key) => {
  if (!validateLicense(email, key)) return { ok: false };
  const s = loadSettings();
  s.license = { email: String(email).trim(), key: String(key).trim().toUpperCase() };
  saveSettings(s);
  return { ok: true };
});

ipcMain.on('get-app-version', (e) => { e.returnValue = app.getVersion(); });

// ---- IPC: 設定（Gemini APIキー等） ----
ipcMain.handle('get-settings', () => {
  const s = loadSettings();
  s.geminiKey = decodeKey(s);   // UI 表示用に復号
  delete s.geminiKeyEnc;
  delete s.geminiKeyB64;
  return s;
});
ipcMain.handle('save-settings', (_e, s) => {
  const out = { llmProvider: s.llmProvider || 'gemini', llmModel: s.llmModel, whisperModel: s.whisperModel };
  if (s.outputDir) out.outputDir = s.outputDir;
  if (s.tiktokHandle) out.tiktokHandle = String(s.tiktokHandle);
  if (s.logoPath) out.logoPath = String(s.logoPath);
  if (s.customVocab) out.customVocab = String(s.customVocab);
  out.correctSubtitles = !!s.correctSubtitles;
  out.watermarkOn = !!s.watermarkOn;
  out.watermarkPos = s.watermarkPos || 'tr';
  out.logoOn = !!s.logoOn;
  out.logoPos = s.logoPos || 'br';
  if (s.geminiKey) Object.assign(out, encodeKey(String(s.geminiKey)));  // 暗号化保存
  const cur = loadSettings();
  if (cur.license) out.license = cur.license;   // ライセンスを消さない（上書き保存で消えるバグ回避）
  const ok = saveSettings(out);
  if (ok) { app.relaunch(); app.exit(0); }   // 保存後に再起動して反映
  return ok;
});

// アップデート中のモーダル（操作をブロックする）
function createUpdateModal(version) {
  if (updateWindow && !updateWindow.isDestroyed()) return;
  updateWindow = new BrowserWindow({
    parent: mainWindow,
    modal: true,
    width: 420,
    height: 180,
    frame: false,
    resizable: false,
    movable: true,
    center: true,
    backgroundColor: '#0e0f13',
    icon: path.join(PROJECT_ROOT, 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0e0f13;color:#f4f5f7;font-family:"Segoe UI","Yu Gothic UI",sans-serif;
display:flex;flex-direction:column;align-items:center;justify-content:center;
height:100vh;-webkit-user-select:none;user-select:none;-webkit-app-region:drag;}
.brand{font-size:1.1rem;font-weight:800;margin-bottom:6px;
background:linear-gradient(90deg,#ff2d55,#25f4ee);
-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;}
.msg{font-size:.88rem;color:#8b909b;margin-bottom:14px;}
.bar{width:260px;height:7px;border-radius:4px;background:rgba(255,255,255,.10);overflow:hidden;}
.fill{height:100%;border-radius:4px;width:0%;transition:width .3s;
background:linear-gradient(90deg,#ff2d55,#25f4ee);}
.pct{margin-top:8px;font-size:.82rem;color:#c0c3cb;}
</style></head><body>
<div class="brand">TikTok‑Cut</div>
<div class="msg">v${version} をダウンロード中…</div>
<div class="bar"><div class="fill" id="f"></div></div>
<div class="pct" id="p">0%</div>
</body></html>`;
  updateWindow.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  updateWindow.on('closed', () => { updateWindow = null; });
}
function setUpdateProgress(percent) {
  if (!updateWindow || updateWindow.isDestroyed()) return;
  const p = Math.round(percent);
  updateWindow.webContents.executeJavaScript(
    `document.getElementById('f').style.width='${p}%';document.getElementById('p').textContent='${p}%';`
  ).catch(() => {});
}
function closeUpdateModal() {
  if (updateWindow && !updateWindow.isDestroyed()) {
    try { updateWindow.close(); } catch (_) {}
  }
  updateWindow = null;
}

// 起動時の自動アップデート（GitHub Releases から新版を取得）。
// パッケージ版のみ・リポ未設定や通信失敗でもアプリは正常に動く（エラーは握り潰す）。
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (_) { return; }
  autoUpdater.autoDownload = false;
  autoUpdater.on('update-available', (info) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const ver = (info && info.version) || '';
    dialog.showMessageBox(mainWindow, {
      type: 'info', title: 'アップデート',
      message: `TikTok-Cut v${ver} が利用可能です。`,
      detail: '差分のみダウンロードして更新します。',
      buttons: ['更新する', 'あとで'], defaultId: 0, cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) {
        createUpdateModal(ver);
        autoUpdater.downloadUpdate();
      }
    }).catch(() => {});
  });
  autoUpdater.on('download-progress', (p) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(p.percent / 100);
    setUpdateProgress(p.percent);
  });
  autoUpdater.on('update-downloaded', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(-1);
    closeUpdateModal();
    dialog.showMessageBox(mainWindow, {
      type: 'info', title: '更新準備完了',
      message: '更新のインストール準備ができました。',
      detail: '再起動して更新を適用します。',
      buttons: ['再起動'], defaultId: 0,
    }).then(() => { autoUpdater.quitAndInstall(); }).catch(() => {});
  });
  autoUpdater.on('error', (e) => {
    closeUpdateModal();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(-1);
    try { console.error('[updater]', e && e.message); } catch (_) {}
  });
  try { Promise.resolve(autoUpdater.checkForUpdates()).catch(() => {}); } catch (_) {}
}

app.whenReady().then(async () => {
  createSplash();   // まず演出を出す（バックエンド起動を待つ間ワクワクさせる）
  try {
    backendPort = await findFreePort();
    await startBackend(backendPort);
    createWindow(backendPort);
    setTimeout(setupAutoUpdate, 4000);   // 起動を妨げないよう少し遅らせて更新チェック
  } catch (e) {
    closeSplash();
    dialog.showErrorBox('起動エラー', e.message);
    app.quit();
  }
});

app.on('window-all-closed', () => { killBackend(); app.quit(); });
app.on('before-quit', killBackend);
