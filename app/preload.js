// レンダラ（web/）へ安全な API だけを公開する。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  appVersion: ipcRenderer.sendSync('get-app-version'),
  // ネイティブのファイル選択ダイアログ → 選んだ動画の絶対パスを返す（アップロード不要）
  selectVideo: () => ipcRenderer.invoke('select-video'),
  // 生成済みクリップ（サーバ相対パス）を任意の場所へ保存
  saveFile: (serverPath, saveName) => ipcRenderer.invoke('save-file', serverPath, saveName),
  // 設定（Gemini APIキー等）の取得/保存（保存後アプリ再起動で反映）
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  // 保存先フォルダ選択
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  // ロゴ画像（ウォーターマーク）選択 → 絶対パスを返す
  selectLogo: () => ipcRenderer.invoke('select-logo'),
  // ライセンス（オフライン検証）
  getLicense: () => ipcRenderer.invoke('get-license'),
  validateLicense: (email, key) => ipcRenderer.invoke('validate-license', email, key),
  saveLicense: (email, key) => ipcRenderer.invoke('save-license', email, key),
});
