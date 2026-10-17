// Android implementation of the `window.khi` API that the shared UI (app.js) uses.
// On desktop the same API comes from Electron's preload.js + main.js; here it is backed
// by the native GameSong Capacitor plugin (android/app/src/main/java/com/gamesong/app).
import { registerPlugin } from './vendor/capacitor-core.js';

const Native = registerPlugin('GameSong');
const BASE = 'https://downloads.khinsider.com';
const MEDIA_HOST = /(^|\.)vgmtreasurechest\.com$/i;

// ---------------------------------------------------------------- "connecting" banner
// The first request after install (or after the clearance cookie expires) has to pass the
// site's Cloudflare check, which can take ~30 s. Say so instead of showing a silent spinner.
let banner;
Native.addListener('proxyStatus', ({ checking }) => {
  if (checking && !banner) {
    banner = document.createElement('div');
    banner.className = 'connect-banner';
    banner.innerHTML = '<span class="spinner"></span><div><b>Connecting to KHInsider…</b><br>One-time security check, this can take up to 30 seconds.</div>';
    document.body.appendChild(banner);
  } else if (!checking && banner) {
    banner.remove();
    banner = null;
  }
});

// ---------------------------------------------------------------- pages
// Pages are fetched by a hidden WebView sitting on the khinsider origin, so requests use
// Chromium's network stack and pass Cloudflare (plain HTTP clients are blocked).
const pageCache = new Map();
const PAGE_TTL = 10 * 60 * 1000;

async function getPage(p, { fresh = false } = {}) {
  const u = new URL(p, BASE);
  if (u.hostname !== 'downloads.khinsider.com') throw new Error('Blocked host: ' + u.hostname);
  const url = u.toString();
  const hit = pageCache.get(url);
  if (!fresh && hit && Date.now() - hit.at < PAGE_TTL) return { url: hit.finalUrl, html: hit.html };
  const r = await Native.fetchPage({ url });
  if (r.status >= 400 && r.status !== 404) throw new Error(`HTTP ${r.status} for ${url}`);
  const finalUrl = r.url || url;
  if (!/^\/random-/.test(u.pathname)) {
    pageCache.set(url, { at: Date.now(), html: r.html, finalUrl });
    if (pageCache.size > 200) pageCache.delete(pageCache.keys().next().value);
  }
  return { url: finalUrl, html: r.html };
}

// ---------------------------------------------------------------- song resolution
const songCache = new Map();
const decodeEntities = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'");
async function resolveSong(songPath) {
  if (songCache.has(songPath)) return songCache.get(songPath);
  const { html } = await getPage(songPath);
  const re = /<a\s+href="([^"]+)"[^>]*>\s*<span class="songDownloadLink">[\s\S]*?download as\s+([A-Za-z0-9]+)[\s\S]*?<\/a>\s*(?:\(([^)]+)\))?/gi;
  const links = [];
  let m;
  while ((m = re.exec(html))) links.push({ format: m[2].toUpperCase(), url: decodeEntities(m[1]), size: m[3] || '' });
  if (!links.length) {
    const a = html.match(/<audio[^>]+src="([^"]+)"/i);
    if (a) { const url = decodeEntities(a[1]); links.push({ format: (url.split('.').pop() || 'MP3').toUpperCase(), url, size: '' }); }
  }
  if (!links.length) throw new Error('No download links found on song page');
  const result = { links };
  songCache.set(songPath, result);
  return result;
}

// ---------------------------------------------------------------- downloads
// Files are saved by Android's DownloadManager into Music/GameSong/<Album>/ (shows in any
// music player and in the system Downloads app). We resolve URLs, then hand them over.
const sanitize = (s) => String(s || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 120) || 'Untitled';
const dlListeners = [];
const emit = (u) => dlListeners.forEach((cb) => cb(u));
const queue = [];
const cancelled = new Set();
const nativeToOurs = new Map(); // DownloadManager id -> our id
const oursToNative = new Map();
let resolving = 0;
const settings = { downloadDir: 'Internal storage › Music › GameSong', concurrency: Number(localStorage.getItem('gs:concurrency')) || 3 };

function pump() {
  while (resolving < settings.concurrency && queue.length) {
    const item = queue.shift();
    if (cancelled.has(item.id)) continue;
    resolving++;
    startDownload(item).finally(() => { resolving--; pump(); });
  }
}
async function startDownload(item) {
  try {
    emit({ id: item.id, state: 'resolving' });
    let url = item.url, format = item.format;
    if (!url) {
      const { links } = await resolveSong(item.songPath);
      const pick = links.find((l) => l.format === String(item.format).toUpperCase()) || links[0];
      url = pick.url; format = pick.format;
    }
    if (!MEDIA_HOST.test(new URL(url).hostname)) throw new Error('Unexpected media host');
    if (cancelled.has(item.id)) return;
    const filename = sanitize(item.filename || decodeURIComponent(new URL(url).pathname.split('/').pop()));
    const { downloadId } = await Native.download({ url, folder: sanitize(item.folder), filename });
    nativeToOurs.set(String(downloadId), item.id);
    oursToNative.set(item.id, downloadId);
    emit({ id: item.id, state: 'downloading', received: 0, total: 0, format });
  } catch (e) {
    emit({ id: item.id, state: 'error', error: String(e.message || e) });
  }
}
Native.addListener('download', (d) => {
  const id = nativeToOurs.get(String(d.downloadId));
  if (!id) return;
  const map = { pending: 'downloading', running: 'downloading', paused: 'downloading', successful: 'done', failed: 'error' };
  const state = map[d.status] || 'downloading';
  emit({ id, state, received: d.received || 0, total: d.total || 0, file: d.file || '', error: state === 'error' ? (d.reason || 'Download failed') : '' });
  if (state === 'done' || state === 'error') { nativeToOurs.delete(String(d.downloadId)); oursToNative.delete(id); }
});

// ---------------------------------------------------------------- lyrics (LRCLIB)
async function searchLyrics(params = {}) {
  const q = new URLSearchParams();
  for (const k of ['q', 'track_name', 'artist_name', 'album_name']) {
    const v = String(params[k] || '').trim().slice(0, 200);
    if (v) q.set(k, v);
  }
  if (![...q.keys()].length) return [];
  let res, lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 600 * attempt));
    try {
      res = await Native.httpGet({ url: 'https://lrclib.net/api/search?' + q });
      if (res.status < 500) break;
      lastErr = new Error('Lyrics service returned HTTP ' + res.status);
    } catch (e) { lastErr = e; res = null; }
  }
  if (!res || res.status >= 400) throw lastErr || new Error('Lyrics service returned HTTP ' + res?.status);
  const list = JSON.parse(res.body || '[]');
  return (Array.isArray(list) ? list : []).slice(0, 25).map((r) => ({
    id: r.id, track: r.trackName || '', artist: r.artistName || '', album: r.albumName || '',
    duration: r.duration || 0, instrumental: !!r.instrumental, plain: r.plainLyrics || '', synced: r.syncedLyrics || '',
  }));
}

// ---------------------------------------------------------------- media notification
const mediaListeners = [];
Native.addListener('mediaAction', (e) => mediaListeners.forEach((cb) => cb(e.action, e)));

window.khi = {
  platform: 'android',
  coverBase: '/_gscover/', // resized, cached covers served by CoverWebViewClient
  getPage,
  resolveSong,
  enqueueDownloads: async (items) => {
    for (const it of items) { queue.push(it); emit({ id: it.id, state: 'queued' }); }
    pump();
    return true;
  },
  cancelDownload: async (id) => {
    cancelled.add(id);
    const i = queue.findIndex((q) => q.id === id);
    if (i >= 0) queue.splice(i, 1);
    const nid = oursToNative.get(id);
    if (nid != null) { await Native.cancelDownload({ downloadId: nid }).catch(() => {}); nativeToOurs.delete(String(nid)); oursToNative.delete(id); }
    emit({ id, state: 'cancelled' });
    return true;
  },
  reveal: () => Native.openDownloads(),
  onDownloadUpdate: (cb) => dlListeners.push(cb),
  getSettings: async () => ({ ...settings }),
  setSettings: async (patch) => {
    if (patch && typeof patch.concurrency === 'number') { settings.concurrency = Math.min(6, Math.max(1, patch.concurrency | 0)); localStorage.setItem('gs:concurrency', settings.concurrency); }
    return { ...settings };
  },
  chooseDownloadDir: async () => ({ ...settings }),
  openExternal: (url) => {
    const u = new URL(url);
    if (u.protocol === 'https:' && /khinsider\.com$/.test(u.hostname)) return Native.openUrl({ url: u.toString() });
  },
  searchLyrics,
  setFullscreen: async () => false,
  onFullscreen: () => {},
  mediaUpdate: (m) => Native.mediaUpdate(m).catch(() => {}),
  onMediaAction: (cb) => mediaListeners.push(cb),
};

await import('./app.js');
