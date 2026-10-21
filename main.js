// GameSong — Electron main process.
// All requests to khinsider go through Chromium's network stack (net.fetch), which
// Cloudflare accepts where plain Node/curl clients get blocked. If a page still comes
// back as a Cloudflare challenge we fall back to loading it in a hidden browser window.
const { app, BrowserWindow, ipcMain, net, dialog, shell, protocol, nativeImage, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

// gscover://img/<px>/<encoded full-size URL> serves resized, cached album art (see serveCover).
protocol.registerSchemesAsPrivileged([{ scheme: 'gscover', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// Portable build: electron-builder's portable exe sets PORTABLE_EXECUTABLE_DIR to the folder the
// exe lives in. Keep all app data (and downloads, by default) beside it instead of in AppData.
const PORTABLE_DIR = process.env.PORTABLE_EXECUTABLE_DIR || '';
if (PORTABLE_DIR) app.setPath('userData', path.join(PORTABLE_DIR, 'GameSong Data'));

const BASE = 'https://downloads.khinsider.com';
const ALLOWED_MEDIA_HOST = /(^|\.)vgmtreasurechest\.com$/i;

let win;

// ---------------------------------------------------------------- settings
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = {};
function loadSettings() {
  try { settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { settings = {}; }
  settings.downloadDir ||= PORTABLE_DIR ? path.join(PORTABLE_DIR, 'GameSong Downloads') : path.join(app.getPath('music'), 'GameSong');
  settings.concurrency ||= 3;
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch {}
}

// ---------------------------------------------------------------- page fetching
const pageCache = new Map(); // url -> { at, html }
const PAGE_TTL = 10 * 60 * 1000;

function toKhiUrl(p) {
  const u = new URL(p, BASE);
  if (u.hostname !== 'downloads.khinsider.com') throw new Error('Blocked host: ' + u.hostname);
  u.protocol = 'https:';
  return u.toString();
}

const isChallenge = (status, html) =>
  status === 403 || status === 503 ||
  /<title>(Just a moment|Attention Required)/i.test(html);

let windowFetchChain = Promise.resolve();
function fetchViaWindow(url) {
  // Serialize: one hidden window at a time.
  const job = windowFetchChain.then(() => new Promise((resolve, reject) => {
    const w = new BrowserWindow({ show: false, webPreferences: { javascript: true, images: false } });
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); clearInterval(poll); if (!w.isDestroyed()) w.destroy(); fn(v); };
    const timer = setTimeout(() => finish(reject, new Error('Timed out loading page')), 30000);
    let poll;
    w.webContents.on('did-finish-load', () => {
      clearInterval(poll);
      // Challenge pages redirect themselves; poll until real content shows up.
      poll = setInterval(async () => {
        try {
          const html = await w.webContents.executeJavaScript('document.documentElement.outerHTML');
          if (!isChallenge(200, html) && html.includes('pageContent')) finish(resolve, html);
        } catch (e) { finish(reject, e); }
      }, 400);
    });
    w.loadURL(url).catch(() => {});
  }));
  windowFetchChain = job.catch(() => {});
  return job;
}

async function fetchHtml(p, { fresh = false } = {}) {
  const url = toKhiUrl(p);
  const hit = pageCache.get(url);
  if (!fresh && hit && Date.now() - hit.at < PAGE_TTL) return { url: hit.finalUrl, html: hit.html };

  let html, status, finalUrl = url;
  try {
    const res = await net.fetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    status = res.status;
    finalUrl = res.url || url; // e.g. /random-album redirects to a real album
    html = await res.text();
  } catch (e) {
    status = 0; html = '';
  }
  if (isChallenge(status, html) || status === 0) html = await fetchViaWindow(url);
  else if (status >= 400 && status !== 404) throw new Error(`HTTP ${status} for ${url}`);

  if (!/^\/random-/.test(new URL(url).pathname)) {
    pageCache.set(url, { at: Date.now(), html, finalUrl });
    if (pageCache.size > 300) pageCache.delete(pageCache.keys().next().value);
  }
  return { url: finalUrl, html };
}

// ---------------------------------------------------------------- song resolution
// A song page lists one direct CDN link per available format (MP3, FLAC, OGG, M4A...).
const songCache = new Map();
const decodeEntities = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'");

async function resolveSong(songPath) {
  if (songCache.has(songPath)) return songCache.get(songPath);
  const { html } = await fetchHtml(songPath);
  const re = /<a\s+href="([^"]+)"[^>]*>\s*<span class="songDownloadLink">[\s\S]*?download as\s+([A-Za-z0-9]+)[\s\S]*?<\/a>\s*(?:\(([^)]+)\))?/gi;
  const links = [];
  let m;
  while ((m = re.exec(html))) {
    links.push({ format: m[2].toUpperCase(), url: decodeEntities(m[1]), size: m[3] || '' });
  }
  if (!links.length) {
    const a = html.match(/<audio[^>]+src="([^"]+)"/i);
    if (a) {
      const url = decodeEntities(a[1]);
      links.push({ format: (url.split('.').pop() || 'MP3').toUpperCase(), url, size: '' });
    }
  }
  if (!links.length) throw new Error('No download links found on song page');
  const result = { links };
  songCache.set(songPath, result);
  return result;
}

// ---------------------------------------------------------------- downloads
const sanitize = (s) => String(s || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 150) || 'Untitled';

const dlQueue = [];
const dlActive = new Map(); // id -> AbortController
const dlCancelled = new Set();

function sendDl(update) {
  if (win && !win.isDestroyed()) win.webContents.send('dl:update', update);
}

function pump() {
  while (dlActive.size < settings.concurrency && dlQueue.length) {
    const item = dlQueue.shift();
    if (dlCancelled.has(item.id)) continue;
    runDownload(item);
  }
}

async function runDownload(item) {
  const ac = new AbortController();
  dlActive.set(item.id, ac);
  let tmp;
  try {
    sendDl({ id: item.id, state: 'resolving' });
    let url = item.url;
    let format = item.format;
    if (!url) {
      const { links } = await resolveSong(item.songPath);
      const pick = links.find((l) => l.format === String(item.format).toUpperCase()) || links[0];
      url = pick.url; format = pick.format;
    }
    const host = new URL(url).hostname;
    if (!ALLOWED_MEDIA_HOST.test(host)) throw new Error('Unexpected media host ' + host);

    const dir = path.join(settings.downloadDir, sanitize(item.folder));
    await fs.promises.mkdir(dir, { recursive: true });
    let name = item.filename || decodeURIComponent(new URL(url).pathname.split('/').pop());
    const file = path.join(dir, sanitize(name));
    tmp = file + '.part';

    const res = await net.fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const total = Number(res.headers.get('content-length')) || 0;
    const ws = fs.createWriteStream(tmp);
    const reader = res.body.getReader();
    let received = 0, lastSent = 0;
    sendDl({ id: item.id, state: 'downloading', received, total, format });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!ws.write(Buffer.from(value))) await new Promise((r) => ws.once('drain', r));
      const now = Date.now();
      if (now - lastSent > 200) { lastSent = now; sendDl({ id: item.id, state: 'downloading', received, total }); }
    }
    await new Promise((r, j) => ws.end((e) => (e ? j(e) : r())));
    await fs.promises.rename(tmp, file);
    sendDl({ id: item.id, state: 'done', received, total: total || received, file, format });
  } catch (e) {
    if (tmp) fs.promises.unlink(tmp).catch(() => {});
    const cancelled = ac.signal.aborted || dlCancelled.has(item.id);
    sendDl({ id: item.id, state: cancelled ? 'cancelled' : 'error', error: cancelled ? '' : String(e.message || e) });
  } finally {
    dlActive.delete(item.id);
    pump();
  }
}

// ---------------------------------------------------------------- IPC
function registerIpc() {
  ipcMain.handle('page:get', async (_e, p, opts) => fetchHtml(p, opts));
  ipcMain.handle('song:resolve', async (_e, songPath) => resolveSong(songPath));

  ipcMain.handle('dl:enqueue', (_e, items) => {
    for (const it of items) { dlQueue.push(it); sendDl({ id: it.id, state: 'queued' }); }
    pump();
    return true;
  });
  ipcMain.handle('dl:cancel', (_e, id) => {
    dlCancelled.add(id);
    const i = dlQueue.findIndex((q) => q.id === id);
    if (i >= 0) { dlQueue.splice(i, 1); sendDl({ id, state: 'cancelled' }); }
    dlActive.get(id)?.abort();
    return true;
  });
  ipcMain.handle('dl:reveal', (_e, file) => {
    if (file && fs.existsSync(file)) shell.showItemInFolder(file);
    else shell.openPath(settings.downloadDir);
  });

  ipcMain.handle('settings:get', () => settings);
  // Only picks a folder; the renderer saves it with settings:set (now, or on Save when Autosave is off).
  ipcMain.handle('settings:chooseDir', async (_e, current) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: typeof current === 'string' && current ? current : settings.downloadDir });
    return !r.canceled && r.filePaths[0] ? r.filePaths[0] : null;
  });
  ipcMain.handle('settings:set', (_e, patch) => {
    if (patch && typeof patch.concurrency === 'number') settings.concurrency = Math.min(6, Math.max(1, patch.concurrency | 0));
    if (patch && typeof patch.downloadDir === 'string' && path.isAbsolute(patch.downloadDir)) {
      try { fs.mkdirSync(patch.downloadDir, { recursive: true }); settings.downloadDir = patch.downloadDir; } catch {}
    }
    saveSettings();
    return settings;
  });
  ipcMain.handle('open:external', (_e, url) => {
    const u = new URL(url);
    if (u.protocol === 'https:' && /khinsider\.com$/.test(u.hostname)) shell.openExternal(u.toString());
  });

  ipcMain.handle('lyrics:search', async (_e, params) => searchLyrics(params));

  ipcMain.handle('win:glassSupported', () => glassSupported());
  ipcMain.on('win:appearance', (_e, a) => applyAppearance(a));

  ipcMain.handle('excl:available', () => exclusiveAvailable());
  ipcMain.on('excl:cmd', (_e, cmd) => exclusiveCommand(cmd));

  ipcMain.handle('win:fullscreen', (_e, on) => {
    if (!win) return false;
    win.setFullScreen(typeof on === 'boolean' ? on : !win.isFullScreen());
    return win.isFullScreen();
  });
}

// ---------------------------------------------------------------- album art
// KHInsider's CDN only has 60px / 117px thumbnails or the full ~1000px original (often a
// 0.5-1 MB PNG). Download the original once, scale it to the size the UI asks for, and keep
// a JPEG in userData/covers so covers stay sharp without re-downloading megabytes.
const coverDir = () => path.join(app.getPath('userData'), 'covers');
const coverJobs = new Map();

async function serveCover(request) {
  const u = new URL(request.url);
  const [, pxStr, ...rest] = u.pathname.split('/');
  const px = Math.max(64, Math.min(1600, parseInt(pxStr, 10) || 512));
  const src = decodeURIComponent(rest.join('/'));
  let host;
  try { host = new URL(src).hostname; } catch { return new Response(null, { status: 400 }); }
  if (!src.startsWith('https://') || !ALLOWED_MEDIA_HOST.test(host)) return new Response(null, { status: 403 });

  const file = path.join(coverDir(), `${crypto.createHash('sha1').update(src).digest('hex')}-${px}.jpg`);
  const headers = { 'content-type': 'image/jpeg', 'cache-control': 'max-age=31536000' };
  if (fs.existsSync(file)) return new Response(fs.readFileSync(file), { headers });

  if (!coverJobs.has(file)) {
    coverJobs.set(file, (async () => {
      const res = await net.fetch(src);
      if (!res.ok) return { status: res.status };
      const original = Buffer.from(await res.arrayBuffer());
      let img = nativeImage.createFromBuffer(original);
      // nativeImage can't decode every format (e.g. WebP): pass the original through.
      if (img.isEmpty()) return { body: original, type: res.headers.get('content-type') || 'image/jpeg' };
      const { width, height } = img.getSize();
      if (Math.max(width, height) > px) img = img.resize(width >= height ? { width: px, quality: 'best' } : { height: px, quality: 'best' });
      const out = img.toJPEG(88);
      await fs.promises.mkdir(coverDir(), { recursive: true });
      await fs.promises.writeFile(file, out);
      return { body: out, type: 'image/jpeg' };
    })().finally(() => setTimeout(() => coverJobs.delete(file), 1000)));
  }
  try {
    const r = await coverJobs.get(file);
    if (!r.body) return new Response(null, { status: r.status || 502 });
    return new Response(r.body, { headers: { ...headers, 'content-type': r.type } });
  } catch {
    return new Response(null, { status: 502 });
  }
}

// Keep the cover cache bounded: drop the oldest files beyond ~4000 (a few hundred MB at most).
function pruneCovers() {
  fs.promises.readdir(coverDir()).then(async (names) => {
    if (names.length <= 4000) return;
    const stats = await Promise.all(names.map(async (n) => ({ n, t: (await fs.promises.stat(path.join(coverDir(), n))).mtimeMs })));
    stats.sort((a, b) => a.t - b.t).slice(0, names.length - 3000).forEach(({ n }) => fs.promises.unlink(path.join(coverDir(), n)).catch(() => {}));
  }).catch(() => {});
}

// ---------------------------------------------------------------- exclusive mode
// Chromium's audio always goes through the Windows mixer, so bit-perfect FLAC playback uses a
// small native helper (native/exclusive → gs-exclusive.exe) that opens the device in WASAPI
// exclusive mode. It speaks JSON lines on stdin/stdout; events are forwarded to the renderer.
const exclusiveExe = () => app.isPackaged
  ? path.join(process.resourcesPath, 'gs-exclusive.exe')
  : path.join(__dirname, 'native', 'bin', 'gs-exclusive.exe');
const exclusiveAvailable = () => process.platform === 'win32' && fs.existsSync(exclusiveExe());
let exclusiveProc = null;

// The helper can outlive the window during quit, so only message a window that still exists.
function toRenderer(ev) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('excl:event', ev);
}

function ensureExclusive() {
  if (exclusiveProc && exclusiveProc.exitCode === null) return exclusiveProc;
  const proc = spawn(exclusiveExe(), [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { toRenderer(JSON.parse(line)); } catch {}
    }
  });
  proc.on('exit', (code) => {
    if (exclusiveProc === proc) exclusiveProc = null;
    toRenderer({ event: 'exit', code });
  });
  proc.stdin.on('error', () => {});
  exclusiveProc = proc;
  return proc;
}

function exclusiveCommand(cmd) {
  if (!exclusiveAvailable() || !cmd || typeof cmd.cmd !== 'string') return;
  if (cmd.cmd === 'load') {
    let u;
    try { u = new URL(cmd.url); } catch { return; }
    if (u.protocol !== 'https:' || !ALLOWED_MEDIA_HOST.test(u.hostname)) return;
  }
  // Releasing the device doesn't need a process that isn't running.
  if ((cmd.cmd === 'stop' || cmd.cmd === 'quit') && !exclusiveProc) return;
  ensureExclusive().stdin.write(JSON.stringify(cmd) + '\n');
}

function shutdownExclusive() {
  const p = exclusiveProc;
  if (!p) return;
  try { p.stdin.write('{"cmd":"quit"}\n'); } catch {}
  setTimeout(() => { try { p.kill(); } catch {} }, 800);
}

// ---------------------------------------------------------------- lyrics
// LRCLIB (https://lrclib.net) is a free, open lyrics database with time-synced lyrics.
const LYRICS_UA = 'GameSong/1.0 (https://downloads.khinsider.com client)';
async function searchLyrics(params = {}) {
  const q = new URLSearchParams();
  for (const k of ['q', 'track_name', 'artist_name', 'album_name']) {
    const v = String(params[k] || '').trim().slice(0, 200);
    if (v) q.set(k, v);
  }
  if (![...q.keys()].length) return [];
  // LRCLIB occasionally answers 5xx under load; retry those (and network errors) with a short backoff.
  let res, lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 600 * attempt));
    try {
      res = await net.fetch('https://lrclib.net/api/search?' + q, { headers: { 'User-Agent': LYRICS_UA, Accept: 'application/json' } });
      if (res.ok || res.status < 500) break;
      lastErr = new Error('Lyrics service returned HTTP ' + res.status);
    } catch (e) { lastErr = e; res = null; }
  }
  if (!res || !res.ok) throw lastErr || new Error('Lyrics service returned HTTP ' + res?.status);
  const list = await res.json();
  return (Array.isArray(list) ? list : []).slice(0, 25).map((r) => ({
    id: r.id,
    track: r.trackName || '',
    artist: r.artistName || '',
    album: r.albumName || '',
    duration: r.duration || 0,
    instrumental: !!r.instrumental,
    plain: r.plainLyrics || '',
    synced: r.syncedLyrics || '',
  }));
}

// ---------------------------------------------------------------- window
// Frosted glass = the OS blurs the desktop behind the window: Windows 11 22H2+ (acrylic
// backdrop material) or macOS (vibrancy). The renderer then paints its panels translucent.
function glassSupported() {
  if (process.platform === 'darwin') return true;
  if (process.platform !== 'win32') return false;
  const build = +String(require('os').release()).split('.')[2] || 0;
  return build >= 22621;
}
// Appearance is chosen in the renderer; main keeps the last one so the next launch starts
// with the right window colour, title-bar button colour and backdrop (no dark flash in light mode).
const HEX = /^#[0-9a-f]{6}$/i;
function readAppearance() {
  const a = settings.appearance || {};
  const dark = a.dark !== false;
  return {
    glass: !!a.glass && glassSupported(),
    dark,                                                      // title-bar buttons (light while Now Playing is open)
    themeDark: typeof a.themeDark === 'boolean' ? a.themeDark : dark,   // the app theme itself
    followSystem: !!a.followSystem,
    bg: HEX.test(a.bg) ? a.bg : '#111214',
  };
}
const symbolColor = (dark) => (dark ? '#c4c5ca' : '#3b3c42');
// The acrylic/vibrancy backdrop is tinted by the window's light/dark mode, which follows
// nativeTheme. Pin it to the app's theme so a light theme gets a light frosted backdrop (and
// a dark one a dark backdrop) whatever Windows uses; "System" leaves it following Windows.
function applyNativeTheme(a) {
  nativeTheme.themeSource = a.followSystem ? 'system' : (a.themeDark ? 'dark' : 'light');
}
function applyAppearance(raw) {
  if (!raw || typeof raw !== 'object') return;
  settings.appearance = {
    glass: !!raw.glass, dark: !!raw.dark, themeDark: !!raw.themeDark, followSystem: !!raw.followSystem,
    bg: HEX.test(raw.bg) ? raw.bg : '#111214',
  };
  saveSettings();
  applyNativeTheme(readAppearance());
  if (!win || win.isDestroyed()) return;
  const a = readAppearance();
  if (process.platform === 'win32') {
    win.setBackgroundMaterial(a.glass ? 'acrylic' : 'none');
    win.setTitleBarOverlay({ color: '#00000000', symbolColor: symbolColor(a.dark), height: 56 });
  } else if (process.platform === 'darwin') {
    win.setVibrancy(a.glass ? (a.themeDark ? 'under-window' : 'sidebar') : null);
  }
  win.setBackgroundColor(a.glass ? '#00000000' : a.bg);
}

function createWindow() {
  const a = readAppearance();
  applyNativeTheme(a);
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: a.glass ? '#00000000' : a.bg,
    ...(a.glass && process.platform === 'win32' ? { backgroundMaterial: 'acrylic' } : {}),
    ...(a.glass && process.platform === 'darwin' ? { vibrancy: a.dark ? 'under-window' : 'sidebar' } : {}),
    titleBarStyle: 'hidden',
    // Windows/Linux draw min/max/close over the top-right; macOS keeps its traffic lights top-left.
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 20, y: 20 } }
      // Transparent so the buttons blend with whatever is behind them (main view or Now Playing art)
      : { titleBarOverlay: { color: '#00000000', symbolColor: symbolColor(a.dark), height: 56 } }),
    title: 'GameSong',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (process.env.KHI_DEBUG) {
    win.webContents.on('console-message', (e) => console.log('[renderer]', e.message));
  }
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('enter-full-screen', () => win.webContents.send('win:fs', true));
  win.on('leave-full-screen', () => win.webContents.send('win:fs', false));
}

// Drop the "Electron/x" and app tokens so requests look like stock Chrome.
app.userAgentFallback = app.userAgentFallback
  .replace(/\s?Electron\/\S+/, '')
  .replace(/\s?(khi-music|gamesong)\/\S+/i, '');

app.whenReady().then(() => {
  loadSettings();
  protocol.handle('gscover', serveCover);
  pruneCovers();
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', shutdownExclusive);
