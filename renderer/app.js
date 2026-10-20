import { parseHome, parseList, parseAlbum } from './scraper.js';
import { ICONS } from './icons.js';
import { PlaybackEngine } from './engine.js';

const api = window.khi;
const SITE = 'https://downloads.khinsider.com';
const SUPPORT_URL = SITE + '/forums/index.php?account/upgrades';   // KHInsider donations / VIP
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const LOSSLESS = new Set(['FLAC', 'WAV', 'ALAC', 'APE', 'WV']);

// ------------------------------------------------------------------ icons (Lucide)
const ic = (n) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ''}</svg>`;
const icSpan = (n) => `<span class="ico" data-icon="${n}">${ic(n)}</span>`;
function hydrateIcons(root = document) {
  $$('[data-icon]', root).forEach((el) => { if (!el.querySelector(':scope > svg')) el.insertAdjacentHTML('afterbegin', ic(el.dataset.icon)); });
}
function setIcon(el, n) {
  if (!el || el.dataset.icon === n) return;
  el.dataset.icon = n;
  el.querySelector(':scope > svg')?.remove();
  el.insertAdjacentHTML('afterbegin', ic(n));
}

const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#232428"/><g transform="translate(20 20)" fill="none" stroke="#55565c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS.music}</g></svg>`);

// Album art. The CDN only has 60px / 117px thumbnails or the ~1000px original, so the native
// process (gscover://, see main.js) serves the original resized to the
// requested size and caches it. px: ~256 for small rows, 512 for cards, 800 for page headers;
// 1000+ means the untouched original.
const fullCover = (src) => (src || '').replace(/\/thumbs(_small)?\//, '/');
function art(src, px = 512) {
  if (!src || src.startsWith('data:')) return src || '';
  const full = fullCover(src);
  if (!/^https:\/\/([\w-]+\.)*vgmtreasurechest\.com\//.test(full)) return src;
  if (!api.coverBase || px >= 1000) return full;
  return api.coverBase + px + '/' + encodeURIComponent(full);
}
const imgSrc = (s, px = 512) => esc(art(s, px) || PLACEHOLDER);

// Fallbacks for broken artwork: resized/full cover -> CDN thumbnail -> small thumbnail -> placeholder.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.getAttribute('src')) return;
  const src = img.src;
  if (!img.dataset.fb0 && (/gscover/.test(src) || (/vgmtreasurechest\.com\//.test(src) && !/\/thumbs(_small)?\//.test(src)))) {
    img.dataset.fb0 = '1';
    const m = src.match(/\/\d+\/(https?%3A.+)$/i);
    const full = m ? decodeURIComponent(m[1]) : src;
    img.src = full.replace(/\/([^/]+)$/, '/thumbs/$1');
  } else if (src.includes('/thumbs/') && !img.dataset.fb) { img.dataset.fb = '1'; img.src = src.replace('/thumbs/', '/thumbs_small/'); }
  else if (src !== PLACEHOLDER) img.src = PLACEHOLDER;
}, true);

// ------------------------------------------------------------------ persistence
const store = {
  get(k, d) { try { const v = localStorage.getItem('gs:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('gs:' + k, JSON.stringify(v)); } catch {} },
};
const state = {
  liked: store.get('liked', []),
  saved: store.get('saved', []),
  recent: store.get('recent', []),
  history: store.get('history', []),     // songs played, newest first: slimTrack + playedAt
  searches: store.get('searches', []),   // { q, at }, newest first
  prefs: Object.assign({ stream: 'MP3', volume: 0.8, muted: false, shuffle: false, repeat: 'off', queueOpen: false, npLyrics: false }, store.get('prefs', {})),
  settings: { downloadDir: '', concurrency: 3 },
};
const likedIds = () => new Set(state.liked.map((t) => t.id));
let likedSet = likedIds();
const savePrefs = () => store.set('prefs', state.prefs);
const slimTrack = (t) => ({ id: t.id, songPath: t.songPath, name: t.name, duration: t.duration, durSec: t.durSec, num: t.num, cd: t.cd, sizes: t.sizes, albumPath: t.albumPath, albumTitle: t.albumTitle, cover: t.cover });
const slimAlbum = (a) => ({ path: a.path, title: a.title, thumb: a.thumb || a.cover || '', year: a.year || a.meta?.Year || '', type: a.type || a.meta?.['Album type'] || '' });

// ------------------------------------------------------------------ data
const albumCache = new Map();
async function getAlbum(path) {
  if (albumCache.has(path)) return albumCache.get(path);
  const { html } = await api.getPage(path);
  const album = parseAlbum(html, path);
  albumCache.set(path, album);
  return album;
}

// ------------------------------------------------------------------ toasts & menus
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2600);
}

let menuEl = null;
function closeMenu() {
  const m = menuEl;
  menuEl = null;
  if (!m) return;
  m.classList.add('closing');
  setTimeout(() => m.remove(), 130);
}
/** items: { label, icon, right, onClick } | 'hr' | { header } */
function openMenu(at, items) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'menu';
  m.innerHTML = items.map((it, i) => {
    if (it === 'hr') return '<hr>';
    if (it.header) return `<div class="m-label">${esc(it.header)}</div>`;
    return `<button data-mi="${i}">${it.icon ? icSpan(it.icon) : ''}<span>${esc(it.label)}</span>${it.right ? `<span class="m-right">${esc(it.right)}</span>` : ''}</button>`;
  }).join('');
  m.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mi]');
    if (!b) return;
    const it = items[+b.dataset.mi];
    closeMenu();
    it.onClick?.();
  });
  $('#menuLayer').appendChild(m);
  menuEl = m;
  let x, y;
  if (at instanceof Element) {
    const r = at.getBoundingClientRect();
    x = r.right - m.offsetWidth; y = r.bottom + 6;
    if (x < 8) x = r.left;
    if (y + m.offsetHeight > innerHeight - 8) y = r.top - 6 - m.offsetHeight;
  } else {
    x = at.x; y = at.y;
    if (y + m.offsetHeight > innerHeight - 8) y = y - m.offsetHeight;
  }
  m.style.left = Math.max(8, Math.min(x, innerWidth - m.offsetWidth - 8)) + 'px';
  m.style.top = Math.max(8, y) + 'px';
}
document.addEventListener('mousedown', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }, true);
window.addEventListener('resize', closeMenu);

// ------------------------------------------------------------------ router
const view = $('#view');
const nav = { stack: [], idx: -1 };
let renderToken = 0;
let viewTracks = []; // tracks shown in the current view (for row actions)
let viewContext = null;
let heroTimer = null;

function go(route, { replace = false } = {}) {
  closeMenu();
  if (!$('#np').hidden) closeNP();
  if (nav.idx >= 0) nav.stack[nav.idx].scroll = view.scrollTop;
  if (replace && nav.idx >= 0) nav.stack[nav.idx] = route;
  else { nav.stack = nav.stack.slice(0, nav.idx + 1); nav.stack.push(route); nav.idx++; }
  render();
}
function back() { if (nav.idx > 0) { nav.stack[nav.idx].scroll = view.scrollTop; nav.idx--; render(true); } }
function forward() { if (nav.idx < nav.stack.length - 1) { nav.stack[nav.idx].scroll = view.scrollTop; nav.idx++; render(true); } }

async function render(restore = false) {
  const route = nav.stack[nav.idx];
  const tk = ++renderToken;
  clearInterval(heroTimer);
  $('#navBack').disabled = nav.idx <= 0;
  $('#navFwd').disabled = nav.idx >= nav.stack.length - 1;
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.nav === route.name));
  if (route.name !== 'search' && document.activeElement !== $('#searchInput')) $('#searchInput').value = '';
  viewTracks = []; viewContext = null;
  try {
    await VIEWS[route.name](route, tk);
  } catch (err) {
    if (tk !== renderToken) return;
    console.error(err);
    setView(`<div class="empty">${icSpan('warning')}<h3>Couldn't load this page</h3><p>${esc(err.message || err)}</p><button class="pill-btn primary" data-act="retry">Try again</button></div>`);
  }
  if (tk !== renderToken) return;
  if (restore && route.scroll) view.scrollTop = route.scroll;
  renderLibrary();
  markPlaying();
}
const live = (tk) => tk === renderToken;
// Redraw Settings in place after a change made on it: no fade, same scroll position.
function refreshSettings() {
  if (nav.stack[nav.idx]?.name !== 'settings') return;
  const top = view.scrollTop;
  setView.quiet = true;
  try { VIEWS.settings(); } finally { setView.quiet = false; }
  view.scrollTop = top;
}
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Swap the main view's content. With `animate` (navigation), the old content fades out from
 * where it was scrolled to while the new content fades in from the top. The old nodes are
 * moved (not copied) into a temporary layer above the view, so this stays cheap.
 * Live refreshes (download progress) pass animate:false and keep their scroll position.
 */
function setView(html, { animate = !setView.quiet } = {}) {
  if (animate && !reduceMotion() && view.firstChild) {
    $$('.view-ghost').forEach((g) => g.remove());
    const ghost = document.createElement('div');
    ghost.className = 'view-ghost';
    ghost.style.top = view.offsetTop + 'px';
    ghost.style.height = view.clientHeight + 'px';
    const inner = document.createElement('div');
    inner.style.transform = `translateY(${-view.scrollTop}px)`;
    while (view.firstChild) inner.appendChild(view.firstChild);
    ghost.appendChild(inner);
    view.parentElement.appendChild(ghost);
    setTimeout(() => ghost.remove(), 220);
  }
  view.innerHTML = html;
  hydrateIcons(view);
  if (animate) {
    view.scrollTop = 0;
    if (!reduceMotion()) {
      view.classList.remove('view-in');
      void view.offsetWidth; // restart the animation
      view.classList.add('view-in');
      clearTimeout(setView.t);
      setView.t = setTimeout(() => view.classList.remove('view-in'), 400);
    }
  }
}

// ------------------------------------------------------------------ building blocks
function hashHue(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; }
const tintFor = (s) => `--tint: hsl(${hashHue(s)} 30% 22%)`;

function card(a, sub) {
  const s = sub ?? ([a.year, a.type].filter(Boolean).join(' · ') || a.platforms || 'Album');
  return `<div class="card" data-act="album" data-path="${esc(a.path)}">
    <div class="card-art"><img loading="lazy" src="${imgSrc(a.thumb)}" alt="">
      <button class="card-play" data-act="play-album" data-path="${esc(a.path)}" title="Play">${ic('play')}</button></div>
    <div class="card-title" title="${esc(a.title)}">${esc(a.title)}</div>
    <div class="card-sub">${esc(s)}</div></div>`;
}
const row = (albums) => `<div class="row">${albums.map((a) => card(a)).join('')}</div>`;
const grid = (albums) => `<div class="grid">${albums.map((a) => card(a)).join('')}</div>`;
const skCards = (n = 12) => `<div class="grid">${Array.from({ length: n }, () => `<div class="card"><div class="card-art sk"></div><div class="sk" style="height:12px;width:80%"></div><div class="sk" style="height:11px;width:50%;margin-top:8px"></div></div>`).join('')}</div>`;
const skHead = () => `<div class="page-head"><div class="backdrop tint"></div><div class="head-art sk"></div><div class="head-text" style="flex:1"><div class="sk" style="height:12px;width:90px"></div><div class="sk" style="height:48px;width:60%;margin:10px 0"></div><div class="sk" style="height:12px;width:40%"></div></div></div>`;

function sectionHead(title, linkAttrs = '') {
  return `<div class="section-head"><h2 class="section-title">${esc(title)}</h2>${linkAttrs ? `<a class="see-all" ${linkAttrs}>See all${icSpan('chevronRight')}</a>` : ''}</div>`;
}
function rankRow(a, n) {
  return `<div class="rank ${n == null ? 'compact' : ''}" data-act="album" data-path="${esc(a.path)}">
    ${n == null ? '' : `<div class="r-n">${n}</div>`}<img loading="lazy" src="${imgSrc(a.thumb, 256)}" alt="">
    <div style="min-width:0"><div class="r-title">${esc(a.title)}</div><div class="r-sub">${esc([a.type, a.platforms].filter(Boolean).join(' · ') || 'Album')}</div></div>
    ${n == null ? '' : `<div class="r-meta">${esc(a.year || '')}</div>`}
    <button class="card-play" data-act="play-album" data-path="${esc(a.path)}" title="Play">${ic('play')}</button></div>`;
}
function pager(page, pages) {
  return `<div class="pager"><button class="icon-btn" data-act="page" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>${ic('chevronLeft')}</button>
    <span>Page <b>${page}</b> of ${pages}</span>
    <button class="icon-btn" data-act="page" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>${ic('chevronRight')}</button></div>`;
}

const CHARTS = [
  { id: 'top40', path: '/top40', label: 'Top 40' },
  { id: 'month6', path: '/last-6-months-top-100', label: 'Top 100 · 6 months' },
  { id: 'new100', path: '/top-100-newly-added', label: 'Top 100 · New' },
  { id: 'fav', path: '/most-favorites', label: 'Most favorited' },
  { id: 'viewing', path: '/currently-viewed', label: 'Currently viewed' },
  { id: 'all1000', path: '/all-time-top-1000', label: 'Top 1000 · All time' },
];
const TYPES = [
  { path: '/game-soundtracks/ost', name: 'Soundtracks', color: '#e8613c' },
  { path: '/game-soundtracks/gamerips', name: 'Gamerips', color: '#4f7cff' },
  { path: '/game-soundtracks/arrangements', name: 'Arrangements', color: '#a36bff' },
  { path: '/game-soundtracks/remixes', name: 'Remixes', color: '#ff5c8a' },
  { path: '/game-soundtracks/singles', name: 'Singles', color: '#3ccf7a' },
  { path: '/game-soundtracks/compilations', name: 'Compilations', color: '#f0a03a' },
  { path: '/game-soundtracks/inspired-by', name: 'Inspired By', color: '#38c3d6' },
];
const PLATFORMS = [
  ['nintendo-switch', 'Switch', '#e60012'], ['switch-2', 'Switch 2', '#ff3b4f'], ['playstation-5', 'PS5', '#3b6cff'], ['playstation-4', 'PS4', '#2d5bd6'],
  ['windows', 'Windows', '#2f9bff'], ['steam', 'Steam', '#66c0f4'], ['xbox-series-x', 'Xbox Series X/S', '#3fbf3f'], ['xbox-one', 'Xbox One', '#2ea043'],
  ['nintendo-snes', 'SNES', '#8b7cf6'], ['nintendo-nes', 'NES', '#d6453a'], ['nintendo-64', 'N64', '#22b35a'], ['nintendo-gamecube', 'GameCube', '#7a6cf0'],
  ['nintendo-wii', 'Wii', '#9aa5ae'], ['nintendo-wii-u', 'Wii U', '#1fb3e6'], ['gameboy', 'Game Boy', '#a5b07a'], ['gameboy-advance', 'GBA', '#7b4dd6'],
  ['nintendo-ds', 'DS', '#a0a0a0'], ['nintendo-3ds', '3DS', '#e3383f'], ['playstation', 'PS1', '#b0b0b0'], ['playstation-2', 'PS2', '#3a55d6'],
  ['playstation-3', 'PS3', '#8a8a8a'], ['playstation-portable-psp', 'PSP', '#7a7ad6'], ['playstation-vita', 'PS Vita', '#4a8ae0'], ['xbox', 'Xbox', '#4caf50'],
  ['xbox-360', 'Xbox 360', '#7fd13b'], ['sega-mega-drive-genesis', 'Genesis', '#3a7bd5'], ['sega-saturn', 'Saturn', '#6060d0'], ['sega-dreamcast', 'Dreamcast', '#f26a2e'],
  ['arcade', 'Arcade', '#ff3d7f'], ['neo-geo', 'Neo Geo', '#d4a017'], ['commodore-64', 'C64', '#8a7ce0'], ['android', 'Android', '#3ddc84'],
  ['ios', 'iOS', '#9a9a9a'], ['mac-os', 'macOS', '#b0b0b0'], ['linux', 'Linux', '#f0a500'], ['roblox', 'Roblox', '#ff4a3d'], ['virtual-reality', 'VR', '#9b5cff'],
].map(([slug, name, color]) => ({ path: '/game-soundtracks/' + slug, name, color }));
const LETTERS = ['0-9', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

function browseAll() {
  const tile = (t) => `<div class="cat" style="--c:${t.color}" data-act="list" data-path="${t.path}" data-title="${esc(t.name)}">${esc(t.name)}</div>`;
  return `<section class="section">${sectionHead('Album types')}<div class="cat-grid">${TYPES.map(tile).join('')}</div></section>
    <section class="section">${sectionHead('Platforms')}<div class="cat-grid">${PLATFORMS.map(tile).join('')}</div></section>
    <section class="section">${sectionHead('A – Z')}<div class="letter-grid">${LETTERS.map((l) => `<button class="letter" data-act="list" data-path="/game-soundtracks/browse/${l}" data-title="${l === '0-9' ? '#' : l}">${l === '0-9' ? '#' : l}</button>`).join('')}</div></section>
    <section class="section">${sectionHead('Charts')}<div class="chips-row">${CHARTS.map((c) => `<button class="chip" data-act="chart" data-which="${c.id}">${c.label}</button>`).join('')}<button class="chip" data-act="random">Surprise me</button></div></section>`;
}

// ------------------------------------------------------------------ views
const VIEWS = {
  async home(r, tk) {
    setView(`<div class="page"><div class="hero sk"></div><section class="section">${skCards(6)}</section></div>`);
    const [home, top] = await Promise.all([
      api.getPage('/').then((p) => parseHome(p.html)),
      api.getPage('/top40').then((p) => parseList(p.html)).catch(() => null),
    ]);
    if (!live(tk)) return;
    const fresh = home.sections[0]?.albums || [];
    const trending = top?.albums || [];
    const slides = [
      ...fresh.slice(0, 3).map((a) => ({ ...a, eyebrow: 'New this week' })),
      ...trending.slice(0, 2).map((a) => ({ ...a, eyebrow: 'Trending now' })),
    ];
    const hero = slides.length ? `<div class="hero" id="hero">${slides.map((s, i) => `
      <div class="slide ${i === 0 ? 'active' : ''}" data-i="${i}">
        <div class="slide-bg"><img src="${imgSrc(s.thumb, 256)}" alt=""></div>
        <div class="slide-text"><div class="eyebrow">${esc(s.eyebrow)}</div>
          <h2 class="slide-title">${esc(s.title)}</h2>
          <div class="slide-sub">${esc([s.type, s.year, s.platforms].filter(Boolean).join(' · ') || 'Video game soundtrack')}</div>
          <div class="slide-actions"><button class="pill-btn primary" data-act="play-album" data-path="${esc(s.path)}">${icSpan('play')}Play</button>
          <button class="pill-btn glass" data-act="album" data-path="${esc(s.path)}">View album</button></div></div>
        <img class="slide-art" src="${imgSrc(s.thumb)}" alt="">
      </div>`).join('')}
      <div class="dots">${slides.map((_, i) => `<button class="dot ${i === 0 ? 'active' : ''}" data-act="hero-dot" data-i="${i}" title="Slide ${i + 1}"></button>`).join('')}</div></div>` : '';

    let html = `<div class="page">${hero}`;
    if (state.history.length) html += `<section class="section">${sectionHead('Listen history', 'data-nav="history"')}${historyGrid(state.history.slice(0, 8))}</section>`;
    if (state.recent.length) html += `<section class="section">${sectionHead('Recently Played', 'data-act="collection" data-key="recent"')}${row(state.recent.slice(0, 12))}</section>`;
    if (fresh.length) html += `<section class="section">${sectionHead('Fresh additions', 'data-act="collection" data-key="fresh"')}${row(fresh)}</section>`;
    if (trending.length) html += `<section class="section">${sectionHead('Trending · Top 40', 'data-act="chart" data-which="top40"')}${row(trending.map((a) => ({ ...a, type: '' })))}</section>`;
    home.sections.slice(1, 4).forEach((s, i) => {
      html += `<section class="section">${sectionHead(`Added ${s.title}`, `data-act="collection" data-key="day${i + 1}"`)}${row(s.albums)}</section>`;
    });
    if (home.series.length) html += `<section class="section">${sectionHead('Popular series')}<div class="chips-row">${home.series.map((s) => `<button class="chip" data-act="list" data-path="${esc(s.path)}" data-title="${esc(s.name)}">${esc(s.name)}</button>`).join('')}</div></section>`;
    if (home.stats.length) html += `<p class="muted" style="margin-top:48px;font-size:12px">${esc(home.stats[0])} albums · ${esc(home.stats[1] || '')} songs in the archive. Music courtesy of KHInsider.</p>`;
    setView(html + '</div>');
    view._collections = { fresh: { title: 'Fresh additions', albums: fresh }, ...Object.fromEntries(home.sections.slice(1, 4).map((s, i) => [`day${i + 1}`, { title: `Added ${s.title}`, albums: s.albums }])) };
    startHero();
  },

  async collection(r) {
    const albums = r.key === 'recent' ? state.recent : r.albums || [];
    setView(`<div class="page"><h1 class="page-title">${esc(r.title)}</h1>${albums.length ? grid(albums) : `<div class="empty">${icSpan('disc')}<h3>Nothing here yet</h3></div>`}</div>`);
  },

  async library(r) {
    const tab = r.tab || 'albums';
    const albums = tab === 'recent' ? state.recent : state.saved;
    const tabs = `<div class="tabs"><button class="chip ${tab === 'albums' ? 'active' : ''}" data-act="lib-tab" data-tab="albums">Saved albums</button><button class="chip ${tab === 'recent' ? 'active' : ''}" data-act="lib-tab" data-tab="recent">Recently played</button>
      <button class="chip" data-act="nav" data-view="liked">Liked Songs</button><button class="chip" data-act="nav" data-view="downloads">Downloads</button></div>`;
    const empty = `<div class="empty">${icSpan(tab === 'recent' ? 'clock' : 'library')}<h3>${tab === 'recent' ? 'Nothing played yet' : 'No saved albums yet'}</h3><p>${tab === 'recent' ? 'Albums you play show up here.' : 'Tap the ⊕ button on any album to save it here.'}</p><button class="pill-btn primary" data-act="nav" data-view="search">Browse music</button></div>`;
    setView(`<div class="page"><h1 class="page-title">Your Library</h1>${tabs}${albums.length ? grid(albums) : empty}</div>`);
  },

  async search(r, tk) {
    const q = (r.q || '').trim();
    $('#searchInput').value = q;
    if (!q) { setView(`<div class="page">${searchHistoryHtml()}<h1 class="page-title">Browse all</h1>${browseAll()}</div>`); return; }
    const atypes = [['', 'All'], ['1', 'Soundtracks'], ['2', 'Gamerips'], ['3', 'Singles'], ['5', 'Arrangements'], ['4', 'Remixes'], ['6', 'Compilations'], ['7', 'Inspired By']];
    const sorts = [['relevance', 'Relevance'], ['popularity', 'Popularity'], ['timestamp', 'Date added'], ['year', 'Year'], ['name', 'Name']];
    const filters = `<div class="chips-row" style="margin-bottom:28px">${atypes.map(([v, l]) => `<button class="chip ${String(r.atype || '') === v ? 'active' : ''}" data-act="search-filter" data-k="atype" data-v="${v}">${l}</button>`).join('')}
      <span style="flex:1"></span><select class="select" id="sortSel">${sorts.map(([v, l]) => `<option value="${v}" ${(r.sort || 'relevance') === v ? 'selected' : ''}>Sort: ${l}</option>`).join('')}</select></div>`;
    setView(`<div class="page">${filters}${skCards(12)}</div>`);
    const params = new URLSearchParams({ search: q, type: 'album', sort: r.sort || 'relevance', album_type: r.atype || '' });
    const res = parseList((await api.getPage('/search?' + params)).html);
    if (!live(tk)) return;
    pushSearch(q);
    const albums = res.albums;
    let body;
    if (!albums.length) {
      body = `<div class="empty">${icSpan('search')}<h3>No results for “${esc(q)}”</h3><p>Check the spelling, or try fewer or different keywords.</p></div>`;
    } else {
      const [first, ...rest] = albums;
      body = `<div class="top-result"><section>${sectionHead('Top result')}<div class="top-card" data-act="album" data-path="${esc(first.path)}"><img src="${imgSrc(first.thumb)}" alt=""><div class="tc-title">${esc(first.title)}</div><div class="tc-sub"><span>${esc([first.year, first.platforms].filter(Boolean).join(' · '))}</span><span class="tag">${esc(first.type || 'Album')}</span></div><button class="card-play" data-act="play-album" data-path="${esc(first.path)}">${ic('play')}</button></div></section>
        <section>${sectionHead('Albums')}<div class="rank-list">${rest.slice(0, 4).map((a) => rankRow(a, null)).join('')}</div></section></div>
        <section class="section">${sectionHead(`All results · ${res.count || albums.length}`)}<div id="moreGrid">${grid(albums.slice(0, 60))}</div>${albums.length > 60 ? `<div class="pager"><button class="pill-btn" data-act="more-results">Show all ${albums.length}</button></div>` : ''}</section>`;
      view._results = albums;
    }
    setView(`<div class="page">${filters}${body}</div>`);
    $('#sortSel').addEventListener('change', (e) => go({ ...r, sort: e.target.value }, { replace: true }));
  },

  async list(r, tk) {
    setView(skHead() + `<div class="page">${skCards(12)}</div>`);
    const page = r.page || 1;
    const res = parseList((await api.getPage(r.path + (page > 1 ? `?page=${page}` : ''))).html);
    if (!live(tk)) return;
    const isLetter = r.path.startsWith('/game-soundtracks/browse/');
    const heading = r.title || res.title.replace(/^Top \d+\s*/i, '').replace(/\s*Albums$/i, '') || 'Albums';
    const cover = res.featured[0]?.thumb || res.albums[0]?.thumb;
    let html = `<div class="page-head"><div class="backdrop">${cover ? `<img src="${imgSrc(cover, 256)}" alt="">` : ''}</div>
      ${cover ? `<img class="head-art" style="width:168px;height:168px;cursor:default" src="${imgSrc(cover)}" alt="">` : ''}
      <div class="head-text"><div class="eyebrow">${isLetter ? 'Browse A–Z' : 'Collection'}</div><h1 class="head-title">${esc(heading)}</h1>
      <div class="head-meta"><span>Page <b>${res.page}</b> of ${res.pages}</span><span>${plural(res.albums.length, 'album')} on this page</span></div></div></div><div class="page">`;
    if (isLetter) html += `<div class="letter-grid" style="margin-bottom:32px">${LETTERS.map((l) => `<button class="letter ${r.path.endsWith('/' + l) ? 'active' : ''}" data-act="list" data-path="/game-soundtracks/browse/${l}" data-title="${l === '0-9' ? '#' : l}">${l === '0-9' ? '#' : l}</button>`).join('')}</div>`;
    if (page === 1 && res.featured.length) html += `<section class="section">${sectionHead('Most popular')}${row(res.featured)}</section>`;
    html += `<section class="section">${sectionHead(isLetter ? 'All albums' : 'Albums')}${grid(res.albums)}</section>`;
    if (res.pages > 1) html += pager(res.page, res.pages);
    setView(html + '</div>');
  },

  async charts(r, tk) {
    const which = CHARTS.find((c) => c.id === r.which) || CHARTS[0];
    const tabs = `<div class="chips-row" style="margin-bottom:24px">${CHARTS.map((c) => `<button class="chip ${c === which ? 'active' : ''}" data-act="chart" data-which="${c.id}">${c.label}</button>`).join('')}</div>`;
    const head = `<div class="page"><h1 class="page-title">Charts</h1>${tabs}`;
    setView(`${head}<div class="rank-list">${Array.from({ length: 10 }, () => '<div class="rank"><div></div><div class="sk" style="width:48px;height:48px"></div><div class="sk" style="height:14px;width:50%"></div></div>').join('')}</div></div>`);
    const res = parseList((await api.getPage(which.path)).html);
    if (!live(tk)) return;
    const shown = res.albums.slice(0, 200);
    setView(`${head}<div class="rank-list">${shown.map((a, i) => rankRow(a, i + 1)).join('')}</div>${res.albums.length > shown.length ? `<p class="muted" style="text-align:center;margin-top:24px">Showing the top ${shown.length} of ${res.albums.length}</p>` : ''}</div>`);
  },

  async album(r, tk) {
    setView(skHead() + `<div class="page">${skCards(6)}</div>`);
    const a = await getAlbum(r.path);
    if (!live(tk)) return;
    viewTracks = a.tracks; viewContext = 'album:' + a.path;
    const saved = state.saved.some((s) => s.path === a.path);
    const m = a.meta;
    const metaBits = [
      m['Platforms'] ? `<span>${esc(m['Platforms'])}</span>` : '',
      m['Year'] ? `<span><b>${esc(m['Year'])}</b></span>` : '',
      `<span>${plural(a.tracks.length, 'song')}${a.totalTime ? ', ' + esc(a.totalTime) : ''}</span>`,
      a.formats.length ? `<span>${a.formats.map(esc).join(' / ')}</span>` : '',
    ].join('');
    setView(`
      <div class="page-head"><div class="backdrop"><img src="${imgSrc(a.cover, 256)}" alt=""></div>
        ${a.cover ? `<img class="head-art" data-act="lightbox" data-src="${esc(a.images[0]?.full)}" src="${imgSrc(a.cover, 800)}" alt="">` : `<div class="head-art">${ic('disc')}</div>`}
        <div class="head-text"><div class="eyebrow">${esc(m['Album type'] || 'Album')}</div><h1 class="head-title ${a.title.length > 38 ? 'long' : ''}" title="${esc(a.title)}">${esc(a.title)}</h1>
        <div class="head-meta">${metaBits}</div></div></div>
      <div class="action-bar">
        <button class="play-btn" data-act="album-play" title="Play">${ic('play')}</button>
        <button class="icon-btn" data-act="album-shuffle" title="Shuffle play">${ic('shuffle')}</button>
        <button class="icon-btn ${saved ? 'on-save' : ''}" data-act="album-save" title="${saved ? 'Remove from Your Library' : 'Save to Your Library'}">${ic(saved ? 'checkCircle' : 'plusCircle')}</button>
        <button class="icon-btn" data-act="album-more" title="More options">${ic('more')}</button>
        <button class="pill-btn" data-act="album-dl-menu">${icSpan('download')}Download album${icSpan('chevronDown')}</button>
      </div>
      ${trackTable(a.tracks, { formats: a.formats, discs: a.multiDisc })}
      <div class="page" style="padding-top:16px">
        ${a.images.length > 1 ? `<section class="section">${sectionHead('Artwork')}<div class="gallery">${a.images.map((im) => `<img loading="lazy" src="${imgSrc(im.thumb)}" data-act="lightbox" data-src="${esc(im.full)}" alt="">`).join('')}</div></section>` : ''}
        <section class="section">${sectionHead('About this album')}<div class="details-grid">${Object.entries(m).map(([k, v]) => `<div class="detail"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('')}
          ${Object.entries(a.totalSizes).filter(([, v]) => v).map(([f, v]) => `<div class="detail"><div class="k">${esc(f)} total</div><div class="v">${esc(v)}</div></div>`).join('')}</div></section>
      </div>`);
  },

  async liked() {
    viewTracks = state.liked; viewContext = 'liked';
    const head = `<div class="page-head"><div class="backdrop tint" style="--tint:#2c2a44"></div>
      <div class="head-art" style="background:linear-gradient(135deg,#4b4f6b,#2a2b33)">${ic('heart')}</div>
      <div class="head-text"><div class="eyebrow">Playlist</div><h1 class="head-title">Liked Songs</h1><div class="head-meta"><span>${plural(state.liked.length, 'song')}</span></div></div></div>`;
    if (!state.liked.length) {
      setView(`${head}<div class="empty">${icSpan('heart')}<h3>Songs you like will appear here</h3><p>Save songs with the heart button.</p><button class="pill-btn primary" data-act="nav" data-view="search">Find songs</button></div>`);
      return;
    }
    const formats = [...new Set(state.liked.flatMap((t) => Object.keys(t.sizes || {})))];
    setView(`${head}<div class="action-bar"><button class="play-btn" data-act="album-play" title="Play">${ic('play')}</button><button class="icon-btn" data-act="album-shuffle" title="Shuffle play">${ic('shuffle')}</button>
      <button class="pill-btn" data-act="liked-dl-menu">${icSpan('download')}Download all${icSpan('chevronDown')}</button></div>
      ${trackTable(state.liked, { formats, showAlbum: true })}`);
  },

  async history() {
    viewTracks = state.history; viewContext = 'history';
    const head = `<div class="page-head"><div class="backdrop tint" style="--tint:#283240"></div>
      <div class="head-art" style="background:linear-gradient(135deg,#3f5468,#262a31)">${ic('clock')}</div>
      <div class="head-text"><div class="eyebrow">Your activity</div><h1 class="head-title">Listen history</h1><div class="head-meta"><span>${plural(state.history.length, 'song')}</span></div></div></div>`;
    if (!state.history.length) {
      setView(`${head}<div class="empty">${icSpan('clock')}<h3>Nothing played yet</h3><p>Songs you listen to show up here.</p><button class="pill-btn primary" data-act="nav" data-view="search">Browse music</button></div>`);
      return;
    }
    const formats = [...new Set(state.history.flatMap((t) => Object.keys(t.sizes || {})))];
    setView(`${head}<div class="action-bar"><button class="play-btn" data-act="album-play" title="Play">${ic('play')}</button><button class="icon-btn" data-act="album-shuffle" title="Shuffle play">${ic('shuffle')}</button>
      <button class="pill-btn" data-act="history-clear">${icSpan('trash')}Clear history</button></div>
      ${trackTable(state.history, { formats, showAlbum: true, group: (t) => dayLabel(t.playedAt) })}`);
  },

  async downloads() { setView(downloadsHtml()); },

  async settings() {
    const s = state.settings;
    const p = state.prefs;
    const theme = p.theme || 'dark';
    const seg = (act, cur, opts) => `<div class="seg">${opts.map(([v, l]) => `<button class="${cur === v ? 'on' : ''}" data-act="${act}" data-v="${v}">${l}</button>`).join('')}</div>`;
    const swatches = (key, list, cur, { withDefault = false } = {}) => `<div class="swatches">
      ${withDefault ? `<button class="swatch default ${!isHex(cur) ? 'on' : ''}" data-act="appearance" data-k="${key}" data-v="" title="Default (no colour)"></button>` : ''}
      ${list.map((c) => `<button class="swatch ${cur?.toLowerCase() === c ? 'on' : ''}" style="--sw:${c}" data-act="appearance" data-k="${key}" data-v="${c}" title="${c}"></button>`).join('')}
      <label class="swatch picker ${isHex(cur) && !list.includes(cur.toLowerCase()) ? 'on' : ''}" title="Pick any colour" ${isHex(cur) && !list.includes(cur.toLowerCase()) ? `style="--sw:${cur}"` : ''}><input type="color" data-appearance="${key}" value="${isHex(cur) ? cur : list[0]}"></label></div>`;
    const transparency = p.glassTransparency ?? 40;
    setView(`<div class="page settings"><h1 class="page-title">Settings</h1>
      <h2 class="settings-group">Appearance</h2>
      <div class="setting"><div><div class="s-title">Display mode</div><div class="s-desc">System follows Windows' light or dark mode. Custom builds the whole theme from one colour.</div></div>
        ${seg('theme', theme, [['dark', 'Dark'], ['light', 'Light'], ['system', 'System'], ['custom', 'Custom']])}</div>
      ${theme === 'custom' ? `<div class="setting sub"><div><div class="s-title">Theme colour</div><div class="s-desc">The background colour. Dark colours make a dark theme, light colours a light one.</div></div>
        ${swatches('themeColor', THEME_COLORS, p.themeColor)}</div>` : ''}
      <div class="setting"><div><div class="s-title">Accent colour</div><div class="s-desc">Play buttons, progress bars, selected chips and liked songs. Default keeps it black and white.</div></div>
        ${swatches('accent', ACCENTS, p.accent, { withDefault: true })}</div>
      <div class="setting"><div><div class="s-title">Frosted glass</div><div class="s-desc">${glassSupported ? 'Makes the window translucent and blurs your desktop behind it.' : 'Needs Windows 11 (version 22H2 or newer).'}</div></div>
        ${glassSupported ? seg('glass', p.glass ? '1' : '0', [['0', 'Off'], ['1', 'On']]) : '<div class="seg disabled"><button class="on">Off</button><button disabled>On</button></div>'}</div>
      ${glassSupported && p.glass ? `<div class="setting sub"><div><div class="s-title">Transparency</div><div class="s-desc">How much of the desktop shows through.</div></div>
        <div class="range-row"><input type="range" class="range" min="0" max="90" step="5" value="${transparency}" data-appearance="glassTransparency"><span class="range-val" id="glassVal">${transparency}%</span></div></div>` : ''}
      <h2 class="settings-group">Playback and downloads</h2>
      <div class="setting"><div><div class="s-title">Streaming quality</div><div class="s-desc">Lossless uses FLAC when an album offers it, and falls back to MP3.</div></div>
        <div class="seg"><button class="${p.stream === 'MP3' ? 'on' : ''}" data-act="pref" data-k="stream" data-v="MP3">Normal · MP3</button><button class="${p.stream === 'FLAC' ? 'on' : ''}" data-act="pref" data-k="stream" data-v="FLAC">Lossless · FLAC</button></div></div>
      ${exclusiveAvailable ? `<div class="setting"><div><div class="s-title">Exclusive mode (bit-perfect)</div><div class="s-desc">Streams the FLAC version straight to your audio device in WASAPI exclusive mode, skipping the Windows mixer: no resampling, mixing or volume processing. While it's on, other apps can't play sound on that device, and the volume slider controls the device itself. Albums without FLAC play normally.</div></div>
        <div class="seg"><button class="${!p.exclusive ? 'on' : ''}" data-act="exclusive" data-v="0">Off</button><button class="${p.exclusive ? 'on' : ''}" data-act="exclusive" data-v="1">On</button></div></div>` : ''}
      <div class="setting"><div style="min-width:0"><div class="s-title">Download location</div><div class="s-desc" style="word-break:break-all">${esc(s.downloadDir)}</div></div>
        <div style="display:flex;gap:8px;flex:none"><button class="pill-btn" data-act="dl-open-folder">${icSpan('folder')}Open</button><button class="pill-btn primary" data-act="choose-dir">Change</button></div></div>
      <div class="setting"><div><div class="s-title">Simultaneous downloads</div><div class="s-desc">How many files download at the same time.</div></div>
        <select class="select" id="concSel">${[1, 2, 3, 4, 5, 6].map((n) => `<option ${s.concurrency === n ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <h2 class="settings-group">History and data</h2>
      <div class="setting"><div><div class="s-title">Listening history</div><div class="s-desc">${plural(state.history.length, 'song')} in your listen history, ${plural(state.recent.length, 'recently played album')}.</div></div><button class="pill-btn" data-act="clear-recent">Clear</button></div>
      <div class="setting"><div><div class="s-title">Search history</div><div class="s-desc">${plural(state.searches.length, 'recent search')}.</div></div><button class="pill-btn" data-act="searches-clear">Clear</button></div>
      <div class="setting"><div><div class="s-title">Saved lyric choices</div><div class="s-desc">Lyrics you picked by hand for ${plural(Object.keys(LYR.choices).length, 'song')}.</div></div><button class="pill-btn" data-act="clear-lyrics">Clear</button></div>
      <h2 class="settings-group">About</h2>
      <div class="setting"><div><div class="s-title">GameSong</div><div class="s-desc">GameSong is an unofficial player for the KHInsider video game music archive. Music is streamed from downloads.khinsider.com; lyrics come from LRCLIB. Icons by Lucide, typeface Inter.</div></div>
        <button class="pill-btn" data-act="open-site" data-url="${SITE}/">${icSpan('external')}KHInsider</button></div>
      <div class="setting"><div class="s-desc"><b style="color:var(--text);font-weight:500">Shortcuts</b> · Space play/pause · Ctrl+←/→ previous/next · Ctrl+↑/↓ volume · Ctrl+K search · Ctrl+B sidebar · N Now Playing · L lyrics · F11 full screen · Alt+← back</div></div>
    </div>`);
    $('#concSel').addEventListener('change', async (e) => { state.settings = await api.setSettings({ concurrency: +e.target.value }); toast('Saved'); });
  },
};

// Hero carousel
function startHero() {
  clearInterval(heroTimer);
  const hero = $('#hero');
  if (!hero) return;
  heroTimer = setInterval(() => {
    if (!document.body.contains(hero)) return clearInterval(heroTimer);
    if (hero.matches(':hover')) return;
    const n = $$('.slide', hero).length;
    showSlide(((+$('.slide.active', hero)?.dataset.i || 0) + 1) % n);
  }, 7000);
}
function showSlide(i) {
  $$('#hero .slide').forEach((s) => s.classList.toggle('active', +s.dataset.i === i));
  $$('#hero .dot').forEach((d) => d.classList.toggle('active', +d.dataset.i === i));
}

function trackTable(tracks, { formats = [], showAlbum = false, discs = false, group = null } = {}) {
  const fmtW = Math.max(120, formats.length * 108);
  let lastCd = null, lastGroup = null;
  const rows = tracks.map((t, i) => {
    let pre = '';
    if (discs && t.cd !== lastCd) { lastCd = t.cd; pre = `<div class="disc-head">${icSpan('disc')}Disc ${esc(t.cd)}</div>`; }
    if (group) { const g = group(t); if (g !== lastGroup) { lastGroup = g; pre = `<div class="disc-head">${icSpan('clock')}${esc(g)}</div>`; } }
    const liked = likedSet.has(t.id);
    const fm = Object.entries(t.sizes || {}).map(([f, s]) => `<span class="fmt ${LOSSLESS.has(f) ? 'lossless' : ''}" data-act="dl-fmt" data-fmt="${esc(f)}" title="Download ${esc(f)} (${esc(s)})">${esc(f)} <span>${esc(s)}</span></span>`).join('');
    return pre + `<div class="track" data-idx="${i}" data-id="${esc(t.id)}">
      <div class="num"><span class="n">${showAlbum ? i + 1 : esc(t.num)}</span><span class="eqw"><span class="eq"><i></i><i></i><i></i></span></span><button class="play-ico" data-act="track-play" title="Play">${ic('play')}</button></div>
      <div class="t-main">${showAlbum ? `<img loading="lazy" src="${imgSrc(t.cover, 256)}" alt="">` : ''}<div class="t-text"><div class="t-name">${esc(t.name)}</div>
        ${showAlbum ? `<div class="t-sub"><a data-act="album" data-path="${esc(t.albumPath)}">${esc(t.albumTitle)}</a></div>` : ''}</div></div>
      <div class="fmts">${fm}</div>
      <div class="dur">${esc(t.duration)}</div>
      <div class="t-actions"><button class="icon-btn ${liked ? 'liked' : ''}" data-act="track-like" title="${liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}">${ic('heart')}</button>
        <button class="icon-btn" data-act="track-dl-menu" title="Download">${ic('download')}</button>
        <button class="icon-btn" data-act="track-more" title="More options">${ic('more')}</button></div></div>`;
  }).join('');
  return `<div class="tracks" style="--fmt-cols:${fmtW}px"><div class="track-head"><div class="num">#</div><div>Title</div><div class="fmts">Download</div><div class="dur">${icSpan('clock')}</div><div></div></div>${rows}</div>`;
}

// Compact listen-history tiles for Home: art, song, album and when it was played.
function historyGrid(items) {
  return `<div class="hist-grid">${items.map((t, i) => `<div class="hist-item" data-act="hist-play" data-i="${i}" data-id="${esc(t.id)}" title="${esc(t.name)}">
    <img loading="lazy" src="${imgSrc(t.cover, 256)}" alt="">
    <div class="hi-text"><div class="hi-name">${esc(t.name)}</div><div class="hi-sub"><a data-act="album" data-path="${esc(t.albumPath)}">${esc(t.albumTitle)}</a></div></div>
    <span class="hi-when">${esc(timeAgo(t.playedAt))}</span>
    <span class="hi-play">${ic('play')}</span></div>`).join('')}</div>`;
}
// Recent searches, shown on the Search page before you type.
function searchHistoryHtml() {
  if (!state.searches.length) return '';
  return `<section class="section"><div class="section-head"><h2 class="section-title">Recent searches</h2><a class="see-all" data-act="searches-clear">Clear all</a></div>
    <div class="chips-row">${state.searches.map((s, i) => `<span class="chip search-chip" data-act="search-again" data-q="${esc(s.q)}" title="Search “${esc(s.q)}”">${icSpan('clock')}<span>${esc(s.q)}</span><button class="sc-x" data-act="search-forget" data-i="${i}" title="Remove">${ic('close')}</button></span>`).join('')}</div></section>`;
}

// ------------------------------------------------------------------ sidebar
function renderLibrary() {
  const cur = nav.stack[nav.idx] || {};
  const activeDl = [...DL.values()].filter((d) => ['queued', 'resolving', 'downloading'].includes(d.state)).length;
  const doneDl = [...DL.values()].filter((d) => d.state === 'done').length;
  const playingAlbum = P.current?.albumPath;
  const fixed = `
    <div class="side-item ${cur.name === 'liked' ? 'active' : ''}" data-act="nav" data-view="liked" title="Liked Songs"><div class="side-art" style="background:linear-gradient(135deg,#4b4f6b,#2a2b33)">${ic('heart')}</div><div class="side-text"><div class="side-name">Liked Songs</div><div class="side-sub">${plural(state.liked.length, 'song')}</div></div></div>
    <div class="side-item ${cur.name === 'downloads' ? 'active' : ''}" data-act="nav" data-view="downloads" title="Downloads"><div class="side-art">${ic('download')}</div><div class="side-text"><div class="side-name">Downloads</div><div class="side-sub">${activeDl ? `${activeDl} in progress` : plural(doneDl, 'file')}</div></div></div>`;
  const albums = state.saved.map((a) => `<div class="side-item ${cur.name === 'album' && cur.path === a.path ? 'active' : ''}" data-act="album" data-path="${esc(a.path)}" title="${esc(a.title)}"><img class="side-art" loading="lazy" src="${imgSrc(a.thumb, 256)}" alt=""><div class="side-text"><div class="side-name ${playingAlbum === a.path ? 'playing' : ''}">${esc(a.title)}</div><div class="side-sub">${esc(['Album', a.year].filter(Boolean).join(' · '))}</div></div></div>`).join('');
  const hint = state.saved.length ? '' : '<div class="side-empty">Save albums with the ⊕ button and they’ll appear here.</div>';
  $('#libraryList').innerHTML = fixed + albums + hint;
}

// ------------------------------------------------------------------ player
// Normal mode plays through the browser's <audio>; Exclusive mode (Windows) streams the FLAC
// through the native WASAPI exclusive player. See engine.js.
const audio = new PlaybackEngine(api.exclusive);
let exclusiveAvailable = false;   // set at boot: Windows + gs-exclusive.exe present
const P = { queue: [], idx: -1, unshuffled: null, context: null, current: null, format: '', tok: 0, loading: false, resumeAt: 0 };

function shuffleArr(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function playList(tracks, start = 0, context = null, { forceShuffle = false } = {}) {
  if (!tracks.length) return;
  if (forceShuffle && !state.prefs.shuffle) { state.prefs.shuffle = true; savePrefs(); updateModeButtons(); }
  P.queue = tracks.map(slimTrack); P.context = context; P.unshuffled = null;
  if (state.prefs.shuffle) {
    P.unshuffled = P.queue.slice();
    const first = forceShuffle ? P.queue.splice(Math.floor(Math.random() * P.queue.length), 1)[0] : P.queue.splice(start, 1)[0];
    P.queue = [first, ...shuffleArr(P.queue)];
    start = 0;
  }
  P.idx = start;
  loadAndPlay();
}

function pickStream(links) {
  const want = state.prefs.stream;
  return links.find((l) => l.format === want) || links.find((l) => l.format === 'MP3') || links[0];
}

async function loadAndPlay(autoplay = true, startAt = 0) {
  const t = P.queue[P.idx];
  if (!t) return;
  const tok = ++P.tok;
  P.current = t;
  setLoading(true);
  updateNowPlaying();
  try {
    const { links } = await api.resolveSong(t.songPath);
    if (tok !== P.tok) return;
    const flac = links.find((l) => l.format === 'FLAC');
    let exclusive = false;
    if (exclusiveWanted() && flac) {
      try {
        await audio.loadExclusive(flac.url, startAt, autoplay);
        if (tok !== P.tok) return;
        exclusive = true;
        P.format = 'FLAC';
      } catch (e) {
        if (tok !== P.tok || e.code === 'superseded') return;
        explainExclusiveFailure(e);
      }
    } else if (exclusiveWanted() && !flac) {
      noteOnce(`noflac:${t.albumPath}`, 'No FLAC for this album, so Exclusive mode is skipped and it plays normally.');
    }
    if (!exclusive) {
      const link = pickStream(links);
      P.format = link.format;
      audio.loadHtml(link.url, startAt);
    }
    applyVolume();
    updateNowPlaying();
    if (autoplay && !exclusive) await audio.play();
    pushRecent({ path: t.albumPath, title: t.albumTitle, thumb: t.cover });
    persistSession(true);
    const nxt = P.queue[P.idx + 1];
    if (nxt) api.resolveSong(nxt.songPath).catch(() => {});
  } catch (e) {
    if (tok !== P.tok || e?.name === 'AbortError') return;
    console.error(e);
    toast(`Couldn't play “${t.name}”`, 'err');
    if (autoplay && P.idx < P.queue.length - 1) setTimeout(() => { if (tok === P.tok) next(); }, 900);
  } finally {
    if (tok === P.tok) setLoading(false);
  }
}

// ------------------------------------------------------------------ exclusive mode
const exclusiveWanted = () => exclusiveAvailable && !!state.prefs.exclusive;
const noted = new Set();
function noteOnce(key, msg) { if (!noted.has(key)) { noted.add(key); toast(msg); } }

function explainExclusiveFailure(e) {
  const why = {
    notallowed: 'Windows has exclusive access turned off for this device (Sound settings › device › Properties › Advanced).',
    busy: 'another app is using the device exclusively.',
    unsupported: "the device can't play this file's format bit-perfectly.",
    network: "the FLAC couldn't be downloaded.",
    decode: "the FLAC couldn't be decoded.",
  }[e.code] || e.message;
  toast(`Exclusive mode unavailable: ${why} Playing normally instead.`, 'err');
}

/** Turns Exclusive mode on/off; the current track switches over at the same position. */
function setExclusive(on) {
  state.prefs.exclusive = !!on;
  savePrefs();
  updateExclusiveUI();
  if (!P.current || !audio.src) { if (!on) audio.releaseExclusive(); return; }
  const at = audio.currentTime || 0;
  const wasPlaying = !audio.paused;
  if (!on) audio.releaseExclusive();
  loadAndPlay(wasPlaying, at);
  toast(on ? 'Exclusive mode on: FLAC plays bit-perfect, straight to your device.' : 'Exclusive mode off: the device is shared again.');
}

function updateExclusiveUI() {
  const b = $('#btnExclusive');
  b.hidden = !exclusiveAvailable;
  b.classList.toggle('on', exclusiveWanted());
  b.title = exclusiveWanted() ? 'Exclusive mode on (bit-perfect FLAC) - click to turn off' : 'Exclusive mode: play FLAC bit-perfect, straight to your device';
}

// Mid-playback failure (device unplugged, driver reset...): carry on in normal mode.
audio.addEventListener('exclusiveerror', (e) => {
  if (!P.current) return;
  toast(`Exclusive playback stopped: ${e.detail.message} Playing normally instead.`, 'err');
  const at = audio.currentTime || 0;
  audio.releaseExclusive();
  loadAndPlayNormal(at);
});
async function loadAndPlayNormal(at) {
  const t = P.current;
  try {
    const { links } = await api.resolveSong(t.songPath);
    const link = pickStream(links);
    P.format = link.format;
    audio.loadHtml(link.url, at);
    applyVolume();
    updateNowPlaying();
    await audio.play();
  } catch { toast(`Couldn't play “${t.name}”`, 'err'); }
}

function togglePlay() {
  if (!P.current) { if (viewTracks.length) playList(viewTracks, 0, viewContext); return; }
  if (!audio.src) { loadAndPlay(true, P.resumeAt || 0); P.resumeAt = 0; return; }
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}
function next(auto = false) {
  if (!P.queue.length) return;
  if (auto && state.prefs.repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
  if (P.idx < P.queue.length - 1) P.idx++;
  else if (state.prefs.repeat === 'all') P.idx = 0;
  else { if (auto) { audio.pause(); audio.currentTime = 0; } return; }
  loadAndPlay();
}
function prev() {
  if (audio.currentTime > 3 || P.idx <= 0) { audio.currentTime = 0; return; }
  P.idx--; loadAndPlay();
}
function playAt(i) { P.idx = i; loadAndPlay(); }

function toggleShuffle() {
  state.prefs.shuffle = !state.prefs.shuffle; savePrefs();
  if (P.current) {
    if (state.prefs.shuffle) {
      P.unshuffled = P.queue.slice();
      P.queue = [...P.queue.slice(0, P.idx + 1), ...shuffleArr(P.queue.slice(P.idx + 1))];
    } else if (P.unshuffled) {
      const i = P.unshuffled.findIndex((t) => t.id === P.current.id);
      P.queue = P.unshuffled; P.idx = Math.max(0, i); P.unshuffled = null;
    }
  }
  updateModeButtons(); renderQueue(); persistSession(true);
}
function cycleRepeat() {
  const order = ['off', 'all', 'one'];
  state.prefs.repeat = order[(order.indexOf(state.prefs.repeat) + 1) % 3]; savePrefs();
  updateModeButtons();
}
function updateModeButtons() {
  $$('.js-shuffle').forEach((b) => { b.classList.toggle('on', state.prefs.shuffle); b.title = state.prefs.shuffle ? 'Disable shuffle' : 'Enable shuffle'; });
  $$('.js-repeat').forEach((b) => {
    setIcon(b, state.prefs.repeat === 'one' ? 'repeatOne' : 'repeat');
    b.classList.toggle('on', state.prefs.repeat !== 'off');
    b.title = { off: 'Enable repeat', all: 'Enable repeat one', one: 'Disable repeat' }[state.prefs.repeat];
  });
}

function addToQueue(tracks, nextUp = false) {
  const items = tracks.map(slimTrack);
  if (!P.current) { playList(items, 0, null); return; }
  if (nextUp) P.queue.splice(P.idx + 1, 0, ...items); else P.queue.push(...items);
  if (P.unshuffled) P.unshuffled.push(...items);
  renderQueue(); renderNPNext(); persistSession(true);
  toast(nextUp ? 'Playing next' : 'Added to queue');
}

function setLoading(on) { P.loading = on; $$('.js-play').forEach((b) => b.classList.toggle('loading', on)); }

function updateNowPlaying() {
  const t = P.current;
  $('#npArt').src = t?.cover ? art(t.cover, 256) : '';
  $('#npTitle').textContent = t?.name || '';
  $('#npSub').textContent = t?.albumTitle || '';
  $('#miniArt').style.visibility = t ? 'visible' : 'hidden';
  const liked = t && likedSet.has(t.id);
  $$('.js-like').forEach((b) => { b.classList.toggle('liked', !!liked); b.style.visibility = t ? 'visible' : 'hidden'; b.title = liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'; });
  const exInfo = audio.mode === 'exclusive' ? audio.info : null;
  $$('.js-quality').forEach((q) => {
    q.textContent = !t || !audio.src ? '' : exInfo ? 'Exclusive' : P.format;
    q.classList.toggle('lossless', LOSSLESS.has(P.format) && !exInfo);
    q.classList.toggle('exclusive', !!exInfo);
    q.title = exInfo
      ? `Bit-perfect: ${exInfo.source} → ${exInfo.device} (${exInfo.format}, WASAPI exclusive mode)`
      : t && audio.src ? `Streaming ${P.format} through the Windows mixer` : '';
  });
  document.title = t ? `${t.name} · GameSong` : 'GameSong';
  if ('mediaSession' in navigator && t) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.name, artist: t.albumTitle, album: t.albumTitle, artwork: t.cover ? [{ src: fullCover(t.cover), sizes: '1000x1000' }] : [] });
  }
  markPlaying(); renderQueue(); renderLibrary(); renderNP();
}

function markPlaying() {
  const id = P.current?.id;
  const paused = audio.paused;
  $$('.track.playing').forEach((r) => r.classList.remove('playing'));
  if (id) $$(`.track[data-id="${CSS.escape(id)}"]`).forEach((r) => { r.classList.add('playing'); r.querySelector('.eq')?.classList.toggle('paused', paused); });
  $$('.card-play, .action-bar .play-btn, .slide-actions .pill-btn.primary').forEach((b) => {
    const isCur = !!P.current && (b.dataset.path === P.current.albumPath || (b.dataset.act === 'album-play' && viewContext && viewContext === P.context));
    const playing = isCur && !paused;
    b.classList.toggle('is-playing', playing);
    const holder = b.querySelector(':scope > .ico') || b;
    setIcon(holder, playing ? 'pause' : 'play');
  });
}

function onPlayState() {
  $$('.js-play').forEach((b) => { setIcon(b, audio.paused ? 'play' : 'pause'); b.title = audio.paused ? 'Play' : 'Pause'; });
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
  markPlaying();
}
audio.addEventListener('play', onPlayState);
audio.addEventListener('pause', onPlayState);
audio.addEventListener('ended', () => next(true));
audio.addEventListener('waiting', () => setLoading(true));
audio.addEventListener('playing', () => { setLoading(false); pushHistory(P.current); });
audio.addEventListener('error', () => {
  if (!audio.src || !P.current) return;
  setLoading(false);
  toast(`Playback error on “${P.current.name}”`, 'err');
});

const fmtTime = (s) => { if (!isFinite(s) || s < 0) s = 0; s = Math.floor(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
let seeking = false;
function paintProgress(frac) {
  const pct = Math.min(100, Math.max(0, frac * 100)) + '%';
  $$('.js-seek').forEach((s) => { s.querySelector('.slider-fill').style.width = pct; s.querySelector('.slider-thumb').style.left = pct; });
}
const setText = (sel, v) => $$(sel).forEach((e) => { e.textContent = v; });
audio.addEventListener('timeupdate', () => {
  const d = audio.duration || P.current?.durSec || 0;
  if (!seeking) { paintProgress(d ? audio.currentTime / d : 0); setText('.js-cur', fmtTime(audio.currentTime)); }
  setText('.js-dur', fmtTime(d));
  syncLyrics();
  persistSession();
});
audio.addEventListener('progress', () => {
  const d = audio.duration;
  if (d && audio.buffered.length) {
    const pct = (audio.buffered.end(audio.buffered.length - 1) / d) * 100 + '%';
    $$('.js-seek .slider-buffer').forEach((b) => { b.style.width = pct; });
  }
});
audio.addEventListener('loadedmetadata', () => { setText('.js-dur', fmtTime(audio.duration)); $$('.js-seek .slider-buffer').forEach((b) => { b.style.width = '0'; }); });

function makeSlider(el, { onInput, onCommit }) {
  const frac = (e) => { const r = el.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId); el.classList.add('dragging'); onInput(frac(e));
    const move = (ev) => onInput(frac(ev));
    const up = (ev) => { el.classList.remove('dragging'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); onCommit?.(frac(ev)); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  });
}
$$('.js-seek').forEach((el) => makeSlider(el, {
  onInput: (f) => { seeking = true; paintProgress(f); setText('.js-cur', fmtTime(f * (audio.duration || P.current?.durSec || 0))); },
  onCommit: (f) => { seeking = false; if (audio.duration) audio.currentTime = f * audio.duration; },
}));
// Volume. On Windows the slider *is* the system volume of the default playback device (read at
// startup, kept in sync when Windows changes it, and never touched by song changes); the in-app
// player stays at 100%. Exclusive streams get no software volume anyway, so the same slider works
// in both modes (on a DAC with hardware volume, Exclusive playback stays bit-perfect).
// Elsewhere (no native helper) it falls back to an in-app volume saved in prefs.
let systemVolume = false;                         // true once the native helper reports the system volume
const sys = { level: 1, muted: false };
const currentVolume = () => (systemVolume ? sys.level : state.prefs.volume);
const isMuted = () => (systemVolume ? sys.muted : state.prefs.muted);

function setVolume(v, persist = true) {
  v = Math.min(1, Math.max(0, v));
  if (systemVolume) {
    sys.level = v;
    if (v > 0) sys.muted = false;
    api.exclusive.send({ cmd: 'volume', value: v });
  } else {
    if (v > 0) state.prefs.muted = false;
    state.prefs.volume = v;
    if (persist) savePrefs();
  }
  applyVolume();
}
function toggleMute() {
  if (systemVolume) {
    sys.muted = !sys.muted;
    api.exclusive.send({ cmd: 'mute', value: sys.muted });
    if (!sys.muted && sys.level === 0) setVolume(0.5);
  } else {
    state.prefs.muted = !state.prefs.muted;
    if (!state.prefs.muted && state.prefs.volume === 0) state.prefs.volume = 0.5;
    savePrefs();
  }
  applyVolume();
}
function applyVolume() {
  const exclusive = audio.mode === 'exclusive';
  const v = isMuted() ? 0 : currentVolume();
  audio.setVolume(systemVolume ? 1 : v);
  const usable = !exclusive || audio.info?.hardwareVolume !== false;
  $$('.js-vol').forEach((s) => {
    s.querySelector('.slider-fill').style.width = v * 100 + '%';
    s.querySelector('.slider-thumb').style.left = v * 100 + '%';
    s.classList.toggle('disabled', !usable);
    s.title = !usable ? "This device has no hardware volume: use its own volume control (Exclusive mode keeps the signal untouched)"
      : systemVolume ? `System volume: ${Math.round(v * 100)}%` : '';
  });
  $$('.js-mute').forEach((b) => setIcon(b, v === 0 ? 'volumeOff' : v < 0.5 ? 'volumeLow' : 'volume'));
}
$$('.js-vol').forEach((el) => makeSlider(el, { onInput: (f) => setVolume(f, false), onCommit: (f) => setVolume(f) }));

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => togglePlay());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('previoustrack', prev);
  navigator.mediaSession.setActionHandler('nexttrack', () => next());
}

let lastPersist = 0;
function persistSession(force = false) {
  const now = Date.now();
  if (!force && now - lastPersist < 3000) return;
  lastPersist = now;
  store.set('session', { queue: P.queue.slice(0, 500), idx: P.idx, context: P.context, at: audio.currentTime || 0 });
}
function restoreSession() {
  const s = store.get('session', null);
  if (!s?.queue?.length) return;
  P.queue = s.queue; P.idx = Math.min(s.idx, s.queue.length - 1); P.context = s.context; P.current = P.queue[P.idx]; P.resumeAt = s.at || 0;
  updateNowPlaying();
  const d = P.current?.durSec;
  if (d) { setText('.js-dur', fmtTime(d)); setText('.js-cur', fmtTime(P.resumeAt)); paintProgress(P.resumeAt / d); }
}

// ------------------------------------------------------------------ queue drawer
const qItem = (x, i, cur = false, removable = true) => `<div class="q-item ${cur ? 'current' : ''}" data-act="q-play" data-i="${i}"><img src="${imgSrc(x.cover, 256)}" alt=""><div class="q-t"><div class="q-n">${esc(x.name)}</div><div class="q-s">${esc(x.albumTitle)}</div></div>${cur || !removable ? '' : `<button class="icon-btn" data-act="q-remove" data-i="${i}" title="Remove from queue">${ic('close')}</button>`}</div>`;
function renderQueue() {
  const panel = $('#queuePanel');
  // The drawer slides/fades via the .open class; its content stays during the closing animation.
  panel.classList.toggle('open', !!state.prefs.queueOpen);
  panel.setAttribute('aria-hidden', String(!state.prefs.queueOpen));
  $('#btnQueue').classList.toggle('on', state.prefs.queueOpen);
  if (!state.prefs.queueOpen) return;
  const t = P.current;
  const upcoming = P.queue.slice(P.idx + 1, P.idx + 101);
  panel.innerHTML = `<div class="q-head"><span>Queue</span><button class="icon-btn" data-act="queue-close" title="Close">${ic('close')}</button></div>
    <div class="q-body">${t ? `<div class="q-label">Now playing</div>${qItem(t, P.idx, true)}` : '<div class="empty" style="padding:40px 10px"><p>Nothing playing yet.</p></div>'}
    ${upcoming.length ? `<div class="q-label"><span>Next up</span><a data-act="queue-clear">Clear</a></div>${upcoming.map((x, k) => qItem(x, P.idx + 1 + k)).join('')}` : ''}
    ${P.queue.length > P.idx + 101 ? `<div class="muted" style="padding:8px">+ ${P.queue.length - P.idx - 101} more</div>` : ''}</div>`;
}

// ------------------------------------------------------------------ Now Playing screen
const np = $('#np');
function openNP({ lyrics } = {}) {
  if (!P.current) { toast('Play something first'); return; }
  if (typeof lyrics === 'boolean') { state.prefs.npLyrics = lyrics; savePrefs(); }
  closeMenu();
  np.classList.remove('closing');
  np.hidden = false;
  applyTheme();   // light title-bar buttons over the (always dark) Now Playing screen
  renderNP();
}
function closeNP() {
  if (np.hidden) return;
  np.classList.add('closing');
  setTimeout(() => { if (np.classList.contains('closing')) { np.hidden = true; np.classList.remove('closing'); } }, 240);
  applyTheme();
  if (document.body.classList.contains('fs')) api.setFullscreen(false);
}
const npOpen = () => !np.hidden && !np.classList.contains('closing');
function setLyricsMode(on) {
  state.prefs.npLyrics = on; savePrefs();
  renderNP();
}
function renderNP() {
  if (np.hidden) return;
  const t = P.current;
  if (!t) { closeNP(); return; }
  setNPArt(t);
  $('#npBigTitle').textContent = t.name;
  $('#npBigAlbum').textContent = t.albumTitle;
  $('#npCtx').textContent = t.albumTitle;
  np.classList.toggle('lyrics-on', !!state.prefs.npLyrics);
  $('#npLyricsToggle').classList.toggle('on', !!state.prefs.npLyrics);
  $('#npLyricsToggle').title = state.prefs.npLyrics ? 'Hide lyrics' : 'Show lyrics';
  renderNPNext();
  if (state.prefs.npLyrics) { ensureLyrics(t); renderLyrics(); }
}
// Show the (usually already cached) 512px cover immediately, then swap in the full-size
// original once it has loaded, so the large / full-screen artwork stays sharp.
let npArtFor = null;
function setNPArt(t) {
  if (npArtFor === t.albumPath) return;
  npArtFor = t.albumPath;
  if (!t.cover) { $('#npBigArt').src = PLACEHOLDER; $('#npBg').src = PLACEHOLDER; return; }
  $('#npBigArt').src = art(t.cover, 512);
  $('#npBg').src = art(t.cover, 256);
  const full = art(t.cover, 1600);
  const img = new Image();
  img.onload = () => { if (npArtFor === t.albumPath) $('#npBigArt').src = full; };
  img.src = full;
}
// The whole queue in a fixed-height list (three rows tall): played tracks above, the current
// one scrolled to the top, upcoming below. Click any row to jump to it.
function renderNPNext() {
  if (np.hidden) return;
  const box = $('#npNext');
  if (!P.queue.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="q-label"><span>Playing Queue</span><span class="q-count">${P.idx + 1} / ${P.queue.length}</span></div>
    <div class="np-queue">${P.queue.map((x, i) => qItem(x, i, i === P.idx, false).replace('class="q-item', `class="q-item${i < P.idx ? ' played' : ''}`)).join('')}</div>`;
  const list = box.querySelector('.np-queue');
  const cur = list.querySelector('.q-item.current');
  if (cur) list.scrollTop = cur.offsetTop; // .np-queue is position:relative, so this is list-relative
}

// ------------------------------------------------------------------ lyrics (LRCLIB)
const LYR = {
  cache: new Map(), // trackId -> { status: 'loading'|'found'|'none'|'error', result, candidates, query, searching }
  choices: store.get('lyricsChoice', {}), // trackId -> chosen LRCLIB result
  activeIdx: -1,
};
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
function gameName(albumTitle) {
  return String(albumTitle || '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(original|official|video game|game|complete|deluxe|extended|edition|soundtrack|ost|gamerip|music|sound ?track|collection|vol(ume)?\.? ?\d*)\b/gi, ' ')
    .replace(/[-–:~]+\s*$/, '').replace(/\s+/g, ' ').trim();
}
function parseLrc(s) {
  const out = [];
  for (const line of String(s).split(/\r?\n/)) {
    const tags = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!tags.length) continue;
    const text = line.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of tags) out.push({ t: +m[1] * 60 + +m[2], text });
  }
  return out.sort((a, b) => a.t - b.t);
}
function scoreResult(r, t) {
  let sc = 0;
  if (norm(r.track) === norm(t.name)) sc += 4; else if (norm(r.track).includes(norm(t.name))) sc += 1;
  if (t.durSec && r.duration) { const d = Math.abs(r.duration - t.durSec); if (d <= 3) sc += 4; else if (d <= 8) sc += 1; else sc -= 3; }
  const g = norm(gameName(t.albumTitle));
  if (g && (norm(r.album).includes(g) || g.includes(norm(r.album)))) sc += 3;
  if (r.synced) sc += 1;
  return sc;
}
async function ensureLyrics(t, { force = false } = {}) {
  const have = LYR.cache.get(t.id);
  if (have && !force) return;
  const chosen = LYR.choices[t.id];
  if (chosen) { LYR.cache.set(t.id, { status: 'found', result: chosen, query: t.name }); return; }
  const entry = { status: 'loading', query: `${t.name} ${gameName(t.albumTitle)}`.trim() };
  LYR.cache.set(t.id, entry);
  // Generic names ("Track 01", "BGM 3") can't be matched reliably.
  if (/^(track|bgm|song|music|sound|theme|untitled)?\s*\d+$/i.test(t.name.trim())) { entry.status = 'none'; renderLyricsIf(t); return; }
  try {
    const game = gameName(t.albumTitle);
    const queries = [{ track_name: t.name, album_name: game }, { q: `${t.name} ${game}` }, { track_name: t.name }];
    let best = null, candidates = [], failures = 0, lastErr = null;
    for (const q of queries) {
      let res;
      try { res = await api.searchLyrics(q); } catch (err) { failures++; lastErr = err; continue; }
      candidates = candidates.concat(res.filter((r) => !candidates.some((c) => c.id === r.id)));
      const scored = res.map((r) => ({ r, s: scoreResult(r, t) })).sort((a, b) => b.s - a.s);
      if (scored[0] && scored[0].s >= 7) { best = scored[0].r; break; }
    }
    if (failures === queries.length) throw lastErr;
    entry.candidates = candidates.slice(0, 12);
    if (best) { entry.status = 'found'; entry.result = best; } else entry.status = 'none';
  } catch (e) {
    console.error(e);
    entry.status = 'error';
    entry.error = /HTTP 5\d\d/.test(e.message) ? 'LRCLIB is busy right now. Try again in a moment.' : 'Check your internet connection and try again.';
  }
  renderLyricsIf(t);
}
function renderLyricsIf(t) { if (P.current?.id === t.id) renderLyrics(); }

function renderLyrics() {
  const box = $('#npLyrics');
  const t = P.current;
  if (!t || np.hidden || !state.prefs.npLyrics) return;
  const e = LYR.cache.get(t.id) || { status: 'loading' };
  LYR.activeIdx = -1;
  const searchForm = (val) => `<form class="lyr-search" data-lyr-search><input name="q" value="${esc(val)}" placeholder="Song title, game…" spellcheck="false"><button class="pill-btn primary" type="submit">${icSpan('search')}Search</button></form>`;
  const results = (list) => list?.length ? `<div class="lyr-results">${list.map((r, i) => `<div class="lyr-result" data-act="lyr-pick" data-i="${i}">${icSpan(r.instrumental ? 'music' : 'lyrics')}<div class="lr-t"><div class="lr-n">${esc(r.track)}</div><div class="lr-s">${esc([r.artist, r.album, r.duration ? fmtTime(r.duration) : '', r.synced ? 'Synced' : r.instrumental ? 'Instrumental' : 'Plain'].filter(Boolean).join(' · '))}</div></div></div>`).join('')}</div>` : '';
  const foot = (extra = '') => `<div class="lyr-foot"><span>Lyrics from LRCLIB</span>${extra}</div>`;

  if (e.searching) {
    box.innerHTML = `<div class="lyr-msg">${icSpan('search')}<h3>Search lyrics</h3><p>Search the LRCLIB lyrics library and pick the right match.</p>${searchForm(e.query)}${e.busy ? '<div class="spinner"></div>' : results(e.results)}${e.results && !e.results.length && !e.busy ? '<p>No matches. Try a shorter title.</p>' : ''}<a class="see-all" data-act="lyr-cancel">Cancel</a></div>`;
  } else if (e.status === 'loading') {
    box.innerHTML = `<div class="lyr-msg"><div class="spinner"></div><p>Looking for lyrics…</p></div>`;
  } else if (e.status === 'found' && e.result.instrumental) {
    box.innerHTML = `<div class="lyr-msg">${icSpan('music')}<h3>Instrumental</h3><p>This track has no lyrics — just enjoy the music.</p><a class="see-all" data-act="lyr-search-open">Wrong? Search lyrics</a></div>`;
  } else if (e.status === 'found' && e.result.synced) {
    const lines = parseLrc(e.result.synced);
    box.dataset.mode = 'synced';
    box._lines = lines;
    box.innerHTML = `<div class="lyr-scroll">${lines.map((l, i) => `<p class="lyr-line" data-act="lyr-seek" data-t="${l.t}" data-li="${i}">${esc(l.text) || '♪'}</p>`).join('')}</div>${foot('<a data-act="lyr-search-open">Wrong lyrics?</a>')}`;
    syncLyrics(true);
    return;
  } else if (e.status === 'found' && e.result.plain) {
    box.innerHTML = `<div class="lyr-scroll lyr-plain" style="padding-top:12%;padding-bottom:20%">${e.result.plain.split(/\r?\n/).map((l) => `<p class="lyr-line">${esc(l) || '&nbsp;'}</p>`).join('')}</div>${foot('<a data-act="lyr-search-open">Wrong lyrics?</a>')}`;
  } else if (e.status === 'error') {
    box.innerHTML = `<div class="lyr-msg">${icSpan('warning')}<h3>Couldn't reach the lyrics service</h3><p>${esc(e.error || '')}</p><button class="pill-btn" data-act="lyr-retry">${icSpan('retry')}Try again</button></div>`;
  } else {
    box.innerHTML = `<div class="lyr-msg">${icSpan('lyrics')}<h3>No lyrics found</h3><p>Most game music is instrumental. If this one has vocals, search for it below.</p>${searchForm(e.query || t.name)}${results(e.candidates?.slice(0, 5))}</div>`;
    box._results = e.candidates?.slice(0, 5);
  }
  box.dataset.mode = '';
  box._lines = null;
  if (e.searching) box._results = e.results;
}
function syncLyrics(force = false) {
  const box = $('#npLyrics');
  if (np.hidden || !state.prefs.npLyrics || box.dataset.mode !== 'synced' || !box._lines) return;
  const ct = audio.currentTime + 0.25;
  const lines = box._lines;
  let i = -1;
  for (let k = 0; k < lines.length; k++) { if (lines[k].t <= ct) i = k; else break; }
  if (i === LYR.activeIdx && !force) return;
  LYR.activeIdx = i;
  const els = $$('.lyr-line', box);
  els.forEach((el, k) => { el.classList.toggle('active', k === i); el.classList.toggle('past', k < i); });
  const scroller = $('.lyr-scroll', box);
  const target = els[Math.max(0, i)];
  if (scroller && target) scroller.scrollTo({ top: target.offsetTop - scroller.clientHeight / 2 + target.offsetHeight / 2, behavior: force ? 'auto' : 'smooth' });
}
async function runLyricsSearch(q) {
  const t = P.current;
  if (!t) return;
  const e = LYR.cache.get(t.id) || {};
  Object.assign(e, { searching: true, busy: true, query: q, results: null });
  LYR.cache.set(t.id, e);
  renderLyrics();
  try { e.results = await api.searchLyrics({ q }); } catch (err) { e.results = []; toast("Couldn't reach the lyrics service", 'err'); }
  e.busy = false;
  renderLyricsIf(t);
}
function pickLyrics(r) {
  const t = P.current;
  if (!t || !r) return;
  LYR.choices[t.id] = r;
  store.set('lyricsChoice', LYR.choices);
  LYR.cache.set(t.id, { status: 'found', result: r, query: t.name });
  renderLyrics();
  toast('Lyrics saved for this song');
}
function showLyricsFor(t) {
  if (P.current?.id !== t.id) {
    const i = viewTracks.findIndex((x) => x.id === t.id);
    i >= 0 ? playList(viewTracks, i, viewContext) : playList([t]);
  }
  openNP({ lyrics: true });
}

// ------------------------------------------------------------------ likes & library
function toggleLike(t) {
  const i = state.liked.findIndex((x) => x.id === t.id);
  if (i >= 0) { state.liked.splice(i, 1); toast('Removed from Liked Songs'); }
  else { state.liked.unshift(slimTrack(t)); toast('Added to Liked Songs'); }
  store.set('liked', state.liked); likedSet = likedIds();
  $$(`.track[data-id="${CSS.escape(t.id)}"] [data-act="track-like"]`).forEach((b) => b.classList.toggle('liked', likedSet.has(t.id)));
  updateNowPlaying();
}
function toggleSave(album) {
  const i = state.saved.findIndex((s) => s.path === album.path);
  if (i >= 0) { state.saved.splice(i, 1); toast('Removed from Your Library'); }
  else { state.saved.unshift(slimAlbum(album)); toast('Saved to Your Library'); }
  store.set('saved', state.saved);
  renderLibrary();
  const b = $('[data-act="album-save"]');
  if (b) { const on = i < 0; setIcon(b, on ? 'checkCircle' : 'plusCircle'); b.classList.toggle('on', false); b.title = on ? 'Remove from Your Library' : 'Save to Your Library'; }
}
// Listen history: every song that actually starts playing, newest first (see the 'playing'
// listener). Resuming after a pause, or repeat-one, doesn't add a duplicate.
function pushHistory(t) {
  if (!t?.id || state.history[0]?.id === t.id) return;
  const entry = { ...slimTrack(t), playedAt: Date.now() };
  state.history = [entry, ...state.history].slice(0, 200);
  store.set('history', state.history);
}
// Search history. Searches run as you type, so a query that extends (or trims) the one
// saved a few seconds ago replaces it: typing "zelda" saves "zelda", not "z", "ze", "zel"...
function pushSearch(q) {
  const k = q.toLowerCase();
  const [last, ...rest] = state.searches;
  const lk = last?.q.toLowerCase();
  const typing = last && Date.now() - last.at < 15000 && (k.startsWith(lk) || lk.startsWith(k));
  const older = (typing ? rest : state.searches).filter((s) => s.q.toLowerCase() !== k);
  state.searches = [{ q, at: Date.now() }, ...older].slice(0, 20);
  store.set('searches', state.searches);
}
function timeAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return plural(Math.floor(s / 3600), 'hour') + ' ago';
  if (s < 7 * 86400) return plural(Math.floor(s / 86400), 'day') + ' ago';
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
function dayLabel(ts) {
  const d = new Date(ts); d.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((today - d) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}
function pushRecent(a) {
  if (!a.path) return;
  const known = albumCache.get(a.path);
  const entry = known ? slimAlbum(known) : a;
  state.recent = [entry, ...state.recent.filter((r) => r.path !== a.path)].slice(0, 30);
  store.set('recent', state.recent);
}

// ------------------------------------------------------------------ downloads
const DL = new Map(store.get('downloads', []).map((d) => [d.id, ['done', 'error', 'cancelled'].includes(d.state) ? d : { ...d, state: 'error', error: 'Interrupted' }]));
function persistDownloads() {
  store.set('downloads', [...DL.values()].filter((d) => ['done', 'error', 'cancelled'].includes(d.state)).slice(-400).map(({ id, title, album, format, state: st, file, total, error, at, songPath, url, folder, filename }) => ({ id, title, album, format, state: st, file, total, error, at, songPath, url, folder, filename })));
}
function enqueue(items, label) {
  for (const it of items) DL.set(it.id, { ...it, state: 'queued', at: Date.now(), received: 0, total: 0 });
  api.enqueueDownloads(items.map(({ id, songPath, url, format, folder, filename }) => ({ id, songPath, url, format, folder, filename })));
  toast(label || `Downloading ${plural(items.length, 'file')}`);
  refreshDownloads(); renderLibrary();
}
function downloadTracks(tracks, fmt, { cover } = {}) {
  const items = tracks.map((t) => ({ id: uid(), songPath: t.songPath, format: fmt, folder: t.albumTitle, title: t.name, album: t.albumTitle }));
  if (cover && tracks[0]) {
    const ext = (cover.split('.').pop() || 'jpg').split(/[?#]/)[0].slice(0, 4);
    items.push({ id: uid(), url: cover, folder: tracks[0].albumTitle, filename: 'cover.' + ext, title: 'Cover art', album: tracks[0].albumTitle, format: ext.toUpperCase() });
  }
  enqueue(items, tracks.length === 1 ? `Downloading “${tracks[0].name}” as ${fmt}` : `Downloading ${tracks.length} songs as ${fmt}`);
}
async function trackDownloadMenu(at, t) {
  let fmts = Object.entries(t.sizes || {});
  if (!fmts.length) {
    try { fmts = (await api.resolveSong(t.songPath)).links.map((l) => [l.format, l.size]); } catch { fmts = [['MP3', '']]; }
  }
  openMenu(at, [{ header: 'Download as' }, ...fmts.map(([f, s]) => ({ label: f + (LOSSLESS.has(f) ? ' · Lossless' : ''), right: s, icon: 'download', onClick: () => downloadTracks([t], f) }))]);
}
function albumDownloadMenu(at, a) {
  const fmts = a.formats.length ? a.formats : ['MP3'];
  openMenu(at, [
    { header: `Download ${a.tracks.length} songs as` },
    ...fmts.map((f) => ({ label: f + (LOSSLESS.has(f) ? ' · Lossless' : ''), right: a.totalSizes[f] || '', icon: 'download', onClick: () => downloadTracks(a.tracks, f, { cover: a.images[0]?.full }) })),
    'hr',
    { label: 'Open download folder', icon: 'folder', onClick: () => api.reveal() },
  ]);
}
const fmtBytes = (b) => !b ? '' : b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : (b / 1e3).toFixed(0) + ' KB';

function dlRow(d) {
  const pct = d.total ? Math.round((d.received / d.total) * 100) : 0;
  const st = { queued: 'Queued', resolving: 'Preparing…', downloading: d.total ? `${pct}% · ${fmtBytes(d.received)}` : fmtBytes(d.received), done: `Done · ${fmtBytes(d.total)}`, error: d.error || 'Failed', cancelled: 'Cancelled' }[d.state] || d.state;
  const active = ['queued', 'resolving', 'downloading'].includes(d.state);
  return `<div class="dl-item" data-dl="${esc(d.id)}"><div style="min-width:0"><div class="dl-name"><span>${esc(d.title)}</span><span class="fmt ${LOSSLESS.has(d.format) ? 'lossless' : ''}">${esc(d.format || '')}</span></div><div class="dl-sub">${esc(d.album)}</div></div>
    <div class="bar ${d.state === 'resolving' || (d.state === 'downloading' && !d.total) ? 'indet' : ''}"><i style="width:${d.state === 'done' ? 100 : pct}%;${d.state === 'error' ? 'background:var(--danger)' : ''}"></i></div>
    <div class="dl-state ${d.state}">${esc(st)}</div>
    <div>${active ? `<button class="icon-btn" data-act="dl-cancel" data-id="${esc(d.id)}" title="Cancel">${ic('close')}</button>` : d.state === 'done' ? `<button class="icon-btn" data-act="dl-reveal" data-id="${esc(d.id)}" title="Show in folder">${ic('folder')}</button>` : `<button class="icon-btn" data-act="dl-retry" data-id="${esc(d.id)}" title="Retry">${ic('retry')}</button>`}</div></div>`;
}
function downloadsHtml() {
  const all = [...DL.values()].sort((a, b) => b.at - a.at);
  const active = all.filter((d) => ['queued', 'resolving', 'downloading'].includes(d.state));
  const done = all.filter((d) => d.state === 'done');
  const other = all.filter((d) => d.state === 'error' || d.state === 'cancelled');
  const list = (title, arr) => arr.length ? `<section class="section">${sectionHead(title)}${arr.map(dlRow).join('')}</section>` : '';
  return `<div class="page"><h1 class="page-title">Downloads</h1><div class="dl-toolbar"><div class="dl-path">${icSpan('folder')}<code>${esc(state.settings.downloadDir)}</code></div>
    <button class="pill-btn" data-act="choose-dir">Change folder</button><button class="pill-btn" data-act="dl-open-folder">Open folder</button>
    ${done.length || other.length ? '<button class="pill-btn" data-act="dl-clear">Clear finished</button>' : ''}</div>
    <p class="muted" style="margin:12px 0 0">${plural(done.length, 'file')} saved · ${fmtBytes(done.reduce((s, d) => s + (d.total || 0), 0)) || '0 MB'}</p>
    <div id="dlLists">${list(`In progress · ${active.length}`, active)}${list('Failed or cancelled', other)}${list('Completed', done.slice(0, 200))}
    ${!all.length ? `<div class="empty">${icSpan('download')}<h3>No downloads yet</h3><p>Open any album and pick a format — MP3, FLAC, or whatever the album offers — to save songs to your computer.</p></div>` : ''}</div></div>`;
}
let dlRefreshPending = false;
function refreshDownloads() {
  if (nav.stack[nav.idx]?.name !== 'downloads' || dlRefreshPending) return;
  dlRefreshPending = true;
  requestAnimationFrame(() => {
    dlRefreshPending = false;
    if (nav.stack[nav.idx]?.name !== 'downloads') return;
    const top = view.scrollTop;
    setView(downloadsHtml(), { animate: false });
    view.scrollTop = top;
  });
}
api.onDownloadUpdate((u) => {
  const d = DL.get(u.id);
  if (!d) return;
  const prevState = d.state;
  Object.assign(d, u);
  if (['done', 'error', 'cancelled'].includes(u.state)) {
    persistDownloads();
    if (u.state === 'error') toast(`Download failed: ${d.title}`, 'err');
    const stillActive = [...DL.values()].some((x) => ['queued', 'resolving', 'downloading'].includes(x.state));
    if (!stillActive && u.state === 'done' && prevState !== 'done') toast('All downloads finished');
  }
  const rowEl = $(`.dl-item[data-dl="${CSS.escape(u.id)}"]`);
  if (rowEl && u.state === prevState) { const tmp = document.createElement('div'); tmp.innerHTML = dlRow(d); rowEl.replaceWith(tmp.firstElementChild); }
  else refreshDownloads();
  if (u.state !== prevState) renderLibrary();
});

// ------------------------------------------------------------------ track / album menus
function trackMenu(at, t, { inAlbum = false } = {}) {
  const liked = likedSet.has(t.id);
  const fmts = Object.entries(t.sizes || {});
  openMenu(at, [
    { label: 'Play', icon: 'play', onClick: () => { const i = viewTracks.findIndex((x) => x.id === t.id); i >= 0 ? playList(viewTracks, i, viewContext) : playList([t]); } },
    { label: 'Play next', icon: 'playNext', onClick: () => addToQueue([t], true) },
    { label: 'Add to queue', icon: 'addQueue', onClick: () => addToQueue([t]) },
    { label: liked ? 'Remove from Liked Songs' : 'Save to Liked Songs', icon: 'heart', onClick: () => toggleLike(t) },
    { label: 'Show lyrics', icon: 'lyrics', onClick: () => showLyricsFor(t) },
    'hr',
    ...(fmts.length ? fmts.map(([f, s]) => ({ label: `Download ${f}`, right: s, icon: 'download', onClick: () => downloadTracks([t], f) })) : [{ label: 'Download…', icon: 'download', onClick: () => trackDownloadMenu(at, t) }]),
    'hr',
    ...(inAlbum ? [] : [{ label: 'Go to album', icon: 'disc', onClick: () => go({ name: 'album', path: t.albumPath }) }]),
    { label: 'Copy song link', icon: 'copy', onClick: () => { navigator.clipboard.writeText(SITE + t.songPath); toast('Link copied'); } },
    { label: 'Open on KHInsider', icon: 'external', onClick: () => api.openExternal(SITE + t.songPath) },
  ]);
}
function albumMenu(at, path) {
  const saved = state.saved.some((s) => s.path === path);
  openMenu(at, [
    { label: 'Play', icon: 'play', onClick: () => playAlbum(path) },
    { label: 'Add to queue', icon: 'addQueue', onClick: async () => addToQueue((await getAlbum(path)).tracks) },
    { label: saved ? 'Remove from Your Library' : 'Save to Your Library', icon: saved ? 'checkCircle' : 'plusCircle', onClick: async () => toggleSave(await getAlbum(path)) },
    { label: 'Download…', icon: 'download', onClick: async () => albumDownloadMenu(at instanceof Element && document.contains(at) ? at : { x: at.x, y: at.y }, await getAlbum(path)) },
    'hr',
    { label: 'Copy album link', icon: 'copy', onClick: () => { navigator.clipboard.writeText(SITE + path); toast('Link copied'); } },
    { label: 'Open on KHInsider', icon: 'external', onClick: () => api.openExternal(SITE + path) },
  ]);
}
async function playAlbum(path, shuffle = false) {
  if (P.current?.albumPath === path && P.context === 'album:' + path && !shuffle) { togglePlay(); return; }
  try {
    const a = await getAlbum(path);
    playList(a.tracks, 0, 'album:' + path, { forceShuffle: shuffle });
  } catch { toast("Couldn't load album", 'err'); }
}
async function randomAlbum() {
  toast('Finding something good…');
  try {
    const { url, html } = await api.getPage('/random-album', { fresh: true });
    // The site serves the album at /random-album itself; recover its real path from its links.
    let path = new URL(url).pathname;
    if (!/^\/game-soundtracks\/album\/[^/]+$/.test(path)) {
      const m = html.match(/href="(\/game-soundtracks\/album\/[^/"]+)\/(?:change_log|[^"]+\.(?:mp3|flac|ogg|m4a))"/i);
      if (!m) throw new Error('No album');
      path = m[1];
    }
    albumCache.set(path, parseAlbum(html, path));
    go({ name: 'album', path });
  } catch (e) { console.error(e); toast("Couldn't fetch a random album", 'err'); }
}

// ------------------------------------------------------------------ events
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act], [data-nav], [data-action]');
  if (!el) { $$('.track.selected').forEach((r) => r.classList.remove('selected')); return; }
  const act = el.dataset.act || (el.dataset.nav ? 'nav' : el.dataset.action);
  const rowEl = el.closest('.track');
  const t = rowEl ? viewTracks[+rowEl.dataset.idx] : null;
  const curRoute = nav.stack[nav.idx];
  switch (act) {
    case 'nav': {
      const v = el.dataset.view || el.dataset.nav;
      if (v === 'search') { $('#searchInput').focus(); if (curRoute?.name !== 'search') go({ name: 'search', q: '' }); }
      else if (v === 'charts') go({ name: 'charts', which: 'top40' });
      else go({ name: v });
      break;
    }
    case 'album': if (curRoute?.name === 'album' && curRoute.path === el.dataset.path && np.hidden) break; go({ name: 'album', path: el.dataset.path }); break;
    case 'play-album': e.stopPropagation(); playAlbum(el.dataset.path); break;
    case 'list': go({ name: 'list', path: el.dataset.path, title: el.dataset.title, page: 1 }); break;
    case 'collection': {
      if (el.dataset.key === 'recent') go({ name: 'collection', key: 'recent', title: 'Recently Played' });
      else { const c = view._collections?.[el.dataset.key]; if (c) go({ name: 'collection', title: c.title, albums: c.albums }); }
      break;
    }
    case 'lib-tab': go({ name: 'library', tab: el.dataset.tab }, { replace: true }); break;
    case 'hero-dot': showSlide(+el.dataset.i); startHero(); break;
    case 'chart': go({ name: 'charts', which: el.dataset.which }, { replace: curRoute?.name === 'charts' }); break;
    case 'page': go({ ...curRoute, page: +el.dataset.page }); break;
    case 'random': randomAlbum(); break;
    case 'retry': render(); break;
    case 'search-filter': go({ ...curRoute, [el.dataset.k]: el.dataset.v }, { replace: true }); break;
    case 'more-results': $('#moreGrid').innerHTML = grid(view._results); el.closest('.pager').remove(); markPlaying(); break;
    case 'track-play': if (t) playList(viewTracks, +rowEl.dataset.idx, viewContext); break;
    case 'track-like': if (t) toggleLike(t); break;
    case 'track-dl-menu': if (t) trackDownloadMenu(el, t); break;
    case 'track-more': if (t) trackMenu(el, t, { inAlbum: curRoute.name === 'album' }); break;
    case 'dl-fmt': if (t) downloadTracks([t], el.dataset.fmt); break;
    case 'album-play':
      if (viewContext && P.context === viewContext && P.current) togglePlay();
      else playList(viewTracks, 0, viewContext);
      break;
    case 'album-shuffle': playList(viewTracks, 0, viewContext, { forceShuffle: true }); break;
    case 'album-save': toggleSave(await getAlbum(curRoute.path)); break;
    case 'album-dl-menu': albumDownloadMenu(el, await getAlbum(curRoute.path)); break;
    case 'liked-dl-menu': {
      const fmts = [...new Set(state.liked.flatMap((x) => Object.keys(x.sizes || {})))];
      openMenu(el, [{ header: `Download ${plural(state.liked.length, 'liked song')} as` }, ...(fmts.length ? fmts : ['MP3']).map((f) => ({ label: f, icon: 'download', onClick: () => downloadTracks(state.liked, f) }))]);
      break;
    }
    case 'album-more': albumMenu(el, curRoute.path); break;
    case 'lightbox': if (el.dataset.src) openLightbox(el.dataset.src); break;
    case 'q-play': if (!e.target.closest('[data-act="q-remove"]')) playAt(+el.dataset.i); break;
    case 'q-remove': { e.stopPropagation(); P.queue.splice(+el.dataset.i, 1); renderQueue(); renderNPNext(); persistSession(true); break; }
    case 'queue-clear': P.queue = P.queue.slice(0, P.idx + 1); P.unshuffled = null; renderQueue(); renderNPNext(); persistSession(true); break;
    case 'queue-close': state.prefs.queueOpen = false; savePrefs(); renderQueue(); break;
    case 'dl-cancel': api.cancelDownload(el.dataset.id); break;
    case 'dl-reveal': api.reveal(DL.get(el.dataset.id)?.file); break;
    case 'dl-retry': {
      const d = DL.get(el.dataset.id);
      if (d) { DL.delete(d.id); enqueue([{ ...d, id: uid() }], `Retrying “${d.title}”`); }
      break;
    }
    case 'dl-clear': for (const [id, d] of DL) if (!['queued', 'resolving', 'downloading'].includes(d.state)) DL.delete(id); persistDownloads(); render(); break;
    case 'dl-open-folder': api.reveal(); break;
    case 'choose-dir': state.settings = await api.chooseDownloadDir(); render(); break;
    case 'pref': state.prefs[el.dataset.k] = el.dataset.v; savePrefs(); refreshSettings(); toast(el.dataset.v === 'FLAC' ? 'Lossless streaming on — applies from the next song' : 'Streaming MP3'); break;
    case 'exclusive': setExclusive(el.dataset.v === '1'); refreshSettings(); break;
    case 'theme': {
      const v = el.dataset.v;
      setAppearancePref({ theme: v, ...(v === 'custom' && !isHex(state.prefs.themeColor) ? { themeColor: THEME_COLORS[0] } : {}) });
      break;
    }
    case 'appearance': setAppearancePref({ [el.dataset.k]: el.dataset.v }); break;
    case 'glass': setAppearancePref({ glass: el.dataset.v === '1' }); break;
    case 'clear-recent': state.recent = []; store.set('recent', []); state.history = []; store.set('history', []); render(); break;
    case 'history-clear': state.history = []; store.set('history', []); render(); toast('Listen history cleared'); break;
    case 'hist-play': if (!e.target.closest('a')) playList(state.history, +el.dataset.i, 'history'); break;
    case 'search-again': go({ name: 'search', q: el.dataset.q }, { replace: curRoute?.name === 'search' }); break;
    case 'search-forget': e.stopPropagation(); state.searches.splice(+el.dataset.i, 1); store.set('searches', state.searches); render(); break;
    case 'searches-clear': state.searches = []; store.set('searches', []); render(); break;
    case 'clear-lyrics': LYR.choices = {}; store.set('lyricsChoice', {}); LYR.cache.clear(); render(); break;
    case 'open-site': api.openExternal(el.dataset.url); break;
    case 'support': api.openExternal(SUPPORT_URL); break;
    // Now Playing
    case 'np-close': closeNP(); break;
    case 'np-lyrics': setLyricsMode(!state.prefs.npLyrics); break;
    case 'np-fullscreen': api.setFullscreen(); break;
    case 'np-download': if (P.current) trackDownloadMenu(el, P.current); break;
    case 'np-more': if (P.current) trackMenu(el, P.current); break;
    case 'lyr-seek': if (audio.src) { audio.currentTime = +el.dataset.t; if (audio.paused) audio.play(); } break;
    case 'lyr-pick': pickLyrics(($('#npLyrics')._results || [])[+el.dataset.i]); break;
    case 'lyr-search-open': { const c = LYR.cache.get(P.current?.id); if (c) { c.searching = true; c.results = c.candidates || []; renderLyrics(); } break; }
    case 'lyr-cancel': { const c = LYR.cache.get(P.current?.id); if (c) { c.searching = false; renderLyrics(); } break; }
    case 'lyr-retry': if (P.current) { LYR.cache.delete(P.current.id); ensureLyrics(P.current); renderLyrics(); } break;
  }
});
document.addEventListener('submit', (e) => {
  if (!e.target.matches('[data-lyr-search]')) return;
  e.preventDefault();
  const q = e.target.q.value.trim();
  if (q) runLyricsSearch(q);
});

// Track rows: select, double-click to play, right-click menus.
view.addEventListener('mousedown', (e) => {
  const r = e.target.closest('.track');
  if (!r || e.button !== 0) return;
  $$('.track.selected').forEach((x) => x !== r && x.classList.remove('selected'));
  r.classList.add('selected');
});
view.addEventListener('dblclick', (e) => {
  const r = e.target.closest('.track');
  if (r && !e.target.closest('button, .fmt, a')) playList(viewTracks, +r.dataset.idx, viewContext);
});
document.addEventListener('contextmenu', (e) => {
  const r = e.target.closest('.track');
  const albumEl = e.target.closest('.card[data-path], .rank[data-path], .side-item[data-path], .top-card[data-path]');
  if (r) { e.preventDefault(); trackMenu({ x: e.clientX, y: e.clientY }, viewTracks[+r.dataset.idx], { inAlbum: nav.stack[nav.idx]?.name === 'album' }); }
  else if (albumEl) { e.preventDefault(); albumMenu({ x: e.clientX, y: e.clientY }, albumEl.dataset.path); }
});

// Artwork viewer: fades in and out.
const lightbox = $('#lightbox');
function openLightbox(src) {
  lightbox.querySelector('img').src = src;
  lightbox.classList.remove('closing');
  lightbox.hidden = false;
}
function closeLightbox() {
  if (lightbox.hidden || lightbox.classList.contains('closing')) return;
  lightbox.classList.add('closing');
  setTimeout(() => { if (lightbox.classList.contains('closing')) { lightbox.hidden = true; lightbox.classList.remove('closing'); } }, 180);
}
lightbox.addEventListener('click', closeLightbox);

// ------------------------------------------------------------------ appearance
// Display mode (dark / light / follow Windows / custom colour), accent colour and frosted glass.
// Every theme colour is a CSS custom property on <html>; this computes and sets them all.
const hexRgb = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const rgbHex = (c) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const mixRgb = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const luminance = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const isHex = (s) => /^#[0-9a-f]{6}$/i.test(s || '');

const ACCENTS = ['#1ed760', '#4f8cff', '#a36bff', '#ff5c8a', '#ff8a3d', '#e7c46a', '#2ec4b6', '#f0544f'];
const THEME_COLORS = ['#1b2a3d', '#2a1f3d', '#1d3326', '#3a1f24', '#33291a', '#e9e4da', '#dde7f0', '#ece3f2'];

// A full palette from one base colour: surfaces step toward white on dark bases, toward black
// on light ones. The built-in Dark and Light themes are just two fixed bases run through this.
function paletteFrom(base) {
  const b = hexRgb(base);
  const dark = luminance(b) < 0.4;
  const ink = dark ? [255, 255, 255] : [0, 0, 0];
  const m = (t) => rgbHex(mixRgb(b, ink, t));
  const lift = (t) => rgbHex(mixRgb(b, [255, 255, 255], t));
  return {
    dark,
    bg: base, side: m(dark ? 0.025 : 0.03),
    surface: dark ? m(0.045) : lift(0.6), 'surface-2': m(dark ? 0.075 : 0.07), 'surface-3': m(dark ? 0.11 : 0.11), line: m(dark ? 0.065 : 0.09),
    text: dark ? '#f1f1f3' : '#17181b', sub: m(dark ? 0.56 : 0.6), muted: m(dark ? 0.36 : 0.42),
    'menu-bg': dark ? m(0.065) : lift(0.75), 'menu-line': m(dark ? 0.1 : 0.1),
    'sk-a': m(dark ? 0.04 : 0.05), 'sk-b': m(dark ? 0.075 : 0.025),
    'slider-buffer': m(dark ? 0.2 : 0.2), 'focus-line': m(dark ? 0.24 : 0.3), 'fmt-line': m(dark ? 0.17 : 0.2),
    'toast-bg': dark ? '#f1f1f3' : '#17181b', 'toast-fg': dark ? '#111' : '#fff',
    lossless: dark ? '#e7c46a' : '#9a7414', danger: dark ? '#f0717d' : '#c8283c',
    'bg-rgb': b.join(', '), 'side-rgb': hexRgb(m(dark ? 0.025 : 0.03)).join(', '), 'fg-rgb': ink.join(', '),
  };
}
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
function themeBase() {
  const { theme = 'dark', themeColor } = state.prefs;
  if (theme === 'custom' && isHex(themeColor)) return themeColor;
  const light = theme === 'light' || (theme === 'system' && !darkQuery.matches);
  return light ? '#f6f6f8' : '#111214';
}
let glassSupported = null;   // null until main answers; until then trust the saved pref (first paint)
let lastAppearance = '';
function applyTheme() {
  const p = state.prefs;
  const pal = paletteFrom(themeBase());
  const root = document.documentElement;
  const glass = !!p.glass && glassSupported !== false;
  const vars = { ...pal };
  delete vars.dark;
  // Accent: "default" is monochrome (the text colour), otherwise the chosen colour everywhere.
  const acc = isHex(p.accent) ? p.accent : null;
  const onFor = (hex) => (luminance(hexRgb(hex)) > 0.45 ? '#111' : '#fff');
  vars.accent = acc || pal.text;
  vars['on-accent'] = onFor(vars.accent);
  vars['accent-np'] = acc || '#ffffff';
  vars['on-accent-np'] = onFor(vars['accent-np']);
  vars.liked = vars.accent;
  if (glass) {
    // Translucent surfaces so the frosted backdrop shows through cards and inputs too.
    const ink = pal['fg-rgb'];
    Object.assign(vars, {
      surface: `rgba(${ink}, .06)`, 'surface-2': `rgba(${ink}, .1)`, 'surface-3': `rgba(${ink}, .14)`, line: `rgba(${ink}, .09)`,
    });
  }
  vars['glass-a'] = String(1 - Math.min(90, Math.max(0, p.glassTransparency ?? 40)) / 100);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty('--' + k, v);
  root.style.colorScheme = pal.dark ? 'dark' : 'light';
  root.dataset.theme = pal.dark ? 'dark' : 'light';
  root.classList.toggle('glass', glass);
  // Tell the window: backdrop material, background colour, and title-bar button colour
  // (Now Playing is always dark, so the buttons go light while it's open).
  const a = { glass, dark: pal.dark || npOpen(), bg: pal.bg };
  const key = JSON.stringify(a);
  if (glassSupported !== null && key !== lastAppearance) { lastAppearance = key; api.setAppearance?.(a); }
}
darkQuery.addEventListener('change', () => { if ((state.prefs.theme || 'dark') === 'system') applyTheme(); });
function setAppearancePref(patch, { rerender = true } = {}) {
  Object.assign(state.prefs, patch);
  savePrefs();
  if (rerender && !reduceMotion()) {
    const root = document.documentElement;
    root.classList.add('theme-fade');
    clearTimeout(setAppearancePref.t);
    setAppearancePref.t = setTimeout(() => root.classList.remove('theme-fade'), 350);
  }
  applyTheme();
  if (rerender) refreshSettings();
}
const THEME_NAMES = { dark: 'Dark', light: 'Light', system: 'System', custom: 'Custom' };
// Colour pickers and the transparency slider preview live while you drag; Settings re-renders
// (to move the selection ring) once you let go.
document.addEventListener('input', (e) => {
  const k = e.target.dataset?.appearance;
  if (!k) return;
  if (k === 'glassTransparency') {
    setAppearancePref({ glassTransparency: +e.target.value }, { rerender: false });
    const v = $('#glassVal'); if (v) v.textContent = e.target.value + '%';
  } else {
    setAppearancePref({ [k]: e.target.value }, { rerender: false });
  }
});
document.addEventListener('change', (e) => { if (e.target.dataset?.appearance && e.target.type === 'color') refreshSettings(); });
applyTheme();   // first paint; boot() re-applies once main says whether glass is supported

// Collapsible sidebar (desktop): icons only when collapsed; remembered between launches.
function applySidebar() {
  const collapsed = !!state.prefs.sidebarCollapsed;
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  const b = $('#sidebarToggle');
  setIcon(b, collapsed ? 'sidebarOpen' : 'sidebarClose');
  b.title = collapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)';
}
function toggleSidebar() {
  state.prefs.sidebarCollapsed = !state.prefs.sidebarCollapsed;
  savePrefs();
  applySidebar();
}
$('#sidebarToggle').addEventListener('click', toggleSidebar);

// Options menu (bottom of the sidebar): quick toggles and shortcuts to app-level pages.
function openOptions() {
  const btn = $('#btnOptions');
  const onOff = (v) => (v ? 'On' : 'Off');
  const items = [{ header: 'Playback' }];
  const onSettings = () => nav.stack[nav.idx]?.name === 'settings';
  if (exclusiveAvailable) items.push({ label: 'Exclusive mode (bit-perfect)', icon: 'exclusive', right: onOff(state.prefs.exclusive), onClick: () => { setExclusive(!state.prefs.exclusive); if (onSettings()) render(); } });
  items.push(
    {
      label: 'Streaming quality', icon: 'music', right: state.prefs.stream === 'FLAC' ? 'Lossless' : 'MP3',
      onClick: () => {
        state.prefs.stream = state.prefs.stream === 'FLAC' ? 'MP3' : 'FLAC';
        savePrefs();
        toast(state.prefs.stream === 'FLAC' ? 'Lossless streaming on: applies from the next song' : 'Streaming MP3');
        if (onSettings()) render();
      },
    },
    { header: 'Appearance' },
    {
      label: 'Display mode', icon: 'theme', right: THEME_NAMES[state.prefs.theme || 'dark'],
      onClick: () => {
        // Cycle Dark → Light → System (→ Custom, if a custom colour was picked before).
        const order = ['dark', 'light', 'system', ...(isHex(state.prefs.themeColor) ? ['custom'] : [])];
        const next = order[(order.indexOf(state.prefs.theme || 'dark') + 1) % order.length];
        setAppearancePref({ theme: next });
        toast(`Display mode: ${THEME_NAMES[next]}`);
      },
    },
    ...(glassSupported ? [{ label: 'Frosted glass', icon: 'glass', right: onOff(state.prefs.glass), onClick: () => setAppearancePref({ glass: !state.prefs.glass }) }] : []),
    { label: 'Customize appearance…', icon: 'palette', onClick: () => go({ name: 'settings' }) },
    'hr',
    { label: 'Downloads', icon: 'download', onClick: () => go({ name: 'downloads' }) },
    { label: 'Open download folder', icon: 'folder', onClick: () => api.reveal() },
    { label: 'Random album', icon: 'dice', onClick: randomAlbum },
    { label: state.prefs.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar', icon: state.prefs.sidebarCollapsed ? 'sidebarOpen' : 'sidebarClose', right: 'Ctrl+B', onClick: toggleSidebar },
    'hr',
    { label: 'Settings', icon: 'settings', onClick: () => go({ name: 'settings' }) },
    { label: 'Visit KHInsider', icon: 'external', onClick: () => api.openExternal(SITE + '/') },
    { label: 'Support KHInsider', icon: 'support', onClick: () => api.openExternal(SUPPORT_URL) },
  );
  openMenu(btn, items);
  const m = optionsMenu = menuEl;
  m.classList.add('options-menu');
  btn.classList.add('open');
  // Un-highlight once the menu goes away (picked, clicked outside, resize...).
  new MutationObserver((_, obs) => { if (menuEl !== m) { btn.classList.remove('open'); obs.disconnect(); } })
    .observe(m, { attributes: true, attributeFilter: ['class'] });
}
// The outside-click handler closes the menu on mousedown (it stays in the DOM while
// it fades out), so a second click on the button should close it, not reopen it.
let optionsMenu = null, optionsWasOpen = false;
$('#btnOptions').addEventListener('mousedown', () => { optionsWasOpen = !!optionsMenu?.isConnected; });
$('#btnOptions').addEventListener('click', () => {
  if (optionsWasOpen) { optionsWasOpen = false; return; }
  openOptions();
});

// Fade images in once they've loaded instead of popping in.
document.addEventListener('load', (e) => {
  if (e.target instanceof HTMLImageElement) e.target.classList.add('is-loaded');
}, true);
$('#navBack').addEventListener('click', back);
$('#navFwd').addEventListener('click', forward);
window.addEventListener('mouseup', (e) => { if (e.button === 3) back(); if (e.button === 4) forward(); });

$$('.js-play').forEach((b) => b.addEventListener('click', togglePlay));
$$('.js-next').forEach((b) => b.addEventListener('click', () => next()));
$$('.js-prev').forEach((b) => b.addEventListener('click', prev));
$$('.js-shuffle').forEach((b) => b.addEventListener('click', toggleShuffle));
$$('.js-repeat').forEach((b) => b.addEventListener('click', cycleRepeat));
$$('.js-like').forEach((b) => b.addEventListener('click', () => P.current && toggleLike(P.current)));
$$('.js-mute').forEach((b) => b.addEventListener('click', toggleMute));
$('#btnExclusive').addEventListener('click', () => setExclusive(!state.prefs.exclusive));
$('#btnQueue').addEventListener('click', () => { state.prefs.queueOpen = !state.prefs.queueOpen; savePrefs(); renderQueue(); });
$('#btnLyrics').addEventListener('click', () => { if (npOpen() && state.prefs.npLyrics) closeNP(); else openNP({ lyrics: true }); });
$('#btnNowPlaying').addEventListener('click', () => (npOpen() ? closeNP() : openNP()));
// Mini player: the art opens Now Playing; the title / album link to the album.
$('.np-mini').addEventListener('click', (e) => {
  if (!P.current || e.target.closest('.js-like')) return;
  if (e.target.closest('#miniArt')) openNP();
  else if (e.target.closest('#npTitle, #npSub')) go({ name: 'album', path: P.current.albumPath });
});
$('#npBigAlbum').addEventListener('click', () => P.current && go({ name: 'album', path: P.current.albumPath }));
$('#npCtx').addEventListener('click', () => P.current && go({ name: 'album', path: P.current.albumPath }));
$('#npStage').addEventListener('click', (e) => { if (!state.prefs.npLyrics && e.target.id === 'npBigArt') setLyricsMode(true); });

api.onFullscreen((on) => {
  document.body.classList.toggle('fs', on);
  setIcon($('#npFsBtn'), on ? 'minimize' : 'maximize');
  $('#npFsBtn').title = on ? 'Exit full screen' : 'Full screen';
  if (on && !npOpen() && P.current) openNP();
});

// Search box
let searchTimer;
const searchInput = $('#searchInput');
function runSearch(immediate) {
  clearTimeout(searchTimer);
  const doIt = () => {
    const q = searchInput.value.trim();
    const cur = nav.stack[nav.idx];
    if (cur?.name === 'search' && (cur.q || '') === q) return;
    go({ name: 'search', q, sort: cur?.name === 'search' ? cur.sort : undefined, atype: cur?.name === 'search' ? cur.atype : undefined }, { replace: cur?.name === 'search' });
  };
  if (immediate) doIt(); else searchTimer = setTimeout(doIt, 450);
}
searchInput.addEventListener('input', () => runSearch(false));
searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(true); if (e.key === 'Escape') searchInput.blur(); });
searchInput.addEventListener('focus', () => { if (nav.stack[nav.idx]?.name !== 'search') go({ name: 'search', q: searchInput.value }); });

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  const mod = e.ctrlKey || e.metaKey; // Ctrl on Windows, Cmd on macOS
  if ((mod && e.key.toLowerCase() === 'k') || (e.key === '/' && !typing)) { e.preventDefault(); closeNP(); searchInput.focus(); searchInput.select(); return; }
  if (e.key === 'F11') { e.preventDefault(); api.setFullscreen(); return; }
  if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSidebar(); return; }
  if (e.key === 'Escape') {
    if (menuEl) return closeMenu();
    if (!$('#lightbox').hidden) { closeLightbox(); return; }
    if (document.body.classList.contains('fs')) { api.setFullscreen(false); return; }
    if (npOpen()) { closeNP(); return; }
  }
  if (e.altKey && e.key === 'ArrowLeft') { back(); return; }
  if (e.altKey && e.key === 'ArrowRight') { forward(); return; }
  if (typing) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (mod && e.key === 'ArrowRight') next();
  else if (mod && e.key === 'ArrowLeft') prev();
  else if (mod && e.key === 'ArrowUp') { e.preventDefault(); setVolume(currentVolume() + 0.1); }
  else if (mod && e.key === 'ArrowDown') { e.preventDefault(); setVolume(currentVolume() - 0.1); }
  else if (!mod && !e.altKey && e.key.toLowerCase() === 'n') { npOpen() ? closeNP() : openNP(); }
  else if (!mod && !e.altKey && e.key.toLowerCase() === 'l') { if (npOpen()) setLyricsMode(!state.prefs.npLyrics); else openNP({ lyrics: true }); }
  else if (e.key === 'Enter') { const r = $('.track.selected'); if (r) playList(viewTracks, +r.dataset.idx, viewContext); }
});
view.addEventListener('scroll', closeMenu, { passive: true });

// ------------------------------------------------------------------ boot
(async function boot() {
  document.body.classList.add('platform-' + api.platform);
  if (api.platform === 'darwin') $('.search-box kbd').textContent = '⌘ K';
  hydrateIcons();
  state.settings = await api.getSettings();
  glassSupported = !!(await api.glassSupported?.().catch(() => false));
  applyTheme();
  exclusiveAvailable = !!(await api.exclusive?.available?.().catch(() => false));
  updateExclusiveUI();
  if (exclusiveAvailable) {
    // Mirror the Windows system volume: first value now, then whenever it changes outside the app.
    systemVolume = true;
    api.exclusive.onEvent((ev) => {
      if (ev.event !== 'volume') return;
      if ($('.js-vol.dragging')) return; // the user is moving our slider; their value wins
      sys.level = Math.min(1, Math.max(0, ev.level));
      sys.muted = !!ev.muted;
      applyVolume();
    });
    api.exclusive.send({ cmd: 'getvolume' });
  }
  applyVolume();
  applySidebar();
  updateModeButtons();
  restoreSession();
  if (!P.current) updateNowPlaying();
  renderQueue();
  go({ name: 'home' });
})();
