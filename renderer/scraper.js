// Turns khinsider HTML into plain data. Pages are fetched by the main process.
const BASE = 'https://downloads.khinsider.com';
const ALBUM_RE = /^\/game-soundtracks\/album\/[^/]+$/;
const TYPE_RE = /^(Soundtracks?|Gamerips?|Arrangements?|Remix(es)?|Singles?|Compilations?|Inspired By)$/i;

const parse = (html) => new DOMParser().parseFromString(html, 'text/html');
const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

export function pathOf(href) {
  try { return new URL(href, BASE).pathname; } catch { return null; }
}
function abs(src) {
  try { return src ? new URL(src, BASE).toString() : ''; } catch { return ''; }
}
/** Album list thumbnails are tiny; the /thumbs/ variant is the same image at a usable size. */
export const bigThumb = (src) => (src ? src.replace('/thumbs_small/', '/thumbs/') : '');

export function parseAlbumRows(root) {
  const out = [];
  const seen = new Set();
  root.querySelectorAll('tr').forEach((tr) => {
    if (tr.querySelector('td.albumIconLarge')) return; // "Top 12" tile rows, handled by parseLargeTiles
    const links = [...tr.querySelectorAll('a[href]')].filter((a) => ALBUM_RE.test(pathOf(a.getAttribute('href'))));
    // The icon cell can hold a placeholder icon whose text ("audiotrack") isn't the title.
    const titleA = links.find((a) => !a.closest('td.albumIcon') && !a.querySelector('.material-icons') && text(a));
    if (!titleA) return;
    const path = pathOf(titleA.getAttribute('href'));
    if (seen.has(path)) return;
    seen.add(path);
    let year = '', type = '', platforms = '';
    for (const td of tr.children) {
      const t = text(td);
      if (/^\d{4}$/.test(t)) year = t;
      else if (TYPE_RE.test(t)) type = t;
      else if (td.querySelector('a[href*="/game-soundtracks/"]:not([href*="/album/"])')) platforms = t;
    }
    const img = tr.querySelector('td.albumIcon img')?.getAttribute('src') || '';
    out.push({ path, title: text(titleA), thumb: bigThumb(abs(img)), year, type, platforms });
  });
  return out;
}

function parseLargeTiles(root) {
  return [...root.querySelectorAll('td.albumIconLarge a[href]')].map((a) => ({
    path: pathOf(a.getAttribute('href')),
    title: text(a.querySelector('p')) || text(a),
    thumb: abs(a.querySelector('img')?.getAttribute('src')),
  })).filter((a) => ALBUM_RE.test(a.path));
}

function parsePagination(root) {
  const m = text(root.querySelector('.pagination .counter')).match(/Page (\d+) of (\d+)/i);
  return m ? { page: +m[1], pages: +m[2] } : { page: 1, pages: 1 };
}

export function parseHome(html) {
  const doc = parse(html);
  const pc = doc.querySelector('#pageContent') || doc.body;
  const sections = [];
  pc.querySelectorAll('h3.latestSoundtrackHeading').forEach((h) => {
    let el = h.nextElementSibling;
    while (el && !el.querySelector?.('table') && el.tagName !== 'TABLE' && el.tagName !== 'H3') el = el.nextElementSibling;
    if (!el || el.tagName === 'H3') return;
    const albums = parseAlbumRows(el);
    if (albums.length) sections.push({ title: text(h), albums });
  });
  const series = [...pc.querySelectorAll('#homepagePopularSeries a[href]')].map((a) => ({ name: text(a), path: pathOf(a.getAttribute('href')) }));
  const stats = [...pc.querySelectorAll('#homepageText b')].slice(0, 3).map(text);
  return { sections, series, stats };
}

export function parseList(html) {
  const doc = parse(html);
  const pc = doc.querySelector('#pageContent') || doc.body;
  const featured = parseLargeTiles(pc);
  const albums = parseAlbumRows(pc);
  const found = text(pc).match(/Found ([\d,]+) matching albums?/i);
  const headings = [...pc.querySelectorAll('h2')].map(text).filter(Boolean);
  return {
    title: headings.find((h) => !/^Top \d+/i.test(h)) || headings[0] || '',
    featured,
    albums,
    count: found ? found[1] : '',
    ...parsePagination(pc),
  };
}

function durationToSec(d) {
  const p = (d || '').split(':').map(Number);
  if (p.some(isNaN) || !p.length) return 0;
  return p.reduce((acc, n) => acc * 60 + n, 0);
}

export function parseAlbum(html, path) {
  const doc = parse(html);
  const pc = doc.querySelector('#pageContent') || doc.body;
  const title = text(pc.querySelector('h2'));

  // Metadata paragraph: "Key: value" lines separated by <br>.
  const meta = {};
  const metaP = [...pc.querySelectorAll('p')].find((p) => /Number of Files|Total Filesize|Date Added/i.test(p.textContent));
  if (metaP) {
    metaP.innerHTML.split(/<br\s*\/?>/i).forEach((chunk) => {
      const line = text(parse(`<div>${chunk}</div>`).body).replace(/\s*\|\s*Change Log.*$/i, '');
      const i = line.indexOf(':');
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    });
  }

  const images = [...pc.querySelectorAll('.albumImage a[href]')].map((a) => ({
    full: abs(a.getAttribute('href')),
    thumb: abs(a.querySelector('img')?.getAttribute('src')),
  }));
  const cover = images[0]?.thumb || '';

  const table = pc.querySelector('#songlist');
  const headers = table ? [...table.querySelectorAll('#songlist_header th')].map(text) : [];
  const hasCD = headers.includes('CD');
  const nameIdx = headers.findIndex((h) => /Song Name/i.test(h));
  const formats = headers.slice(nameIdx + 1).filter((h) => /^[A-Z0-9]{2,5}$/.test(h) && h !== 'CD');

  const tracks = [];
  table?.querySelectorAll('tr').forEach((tr) => {
    if (tr.id === 'songlist_header' || tr.id === 'songlist_footer') return;
    const clickable = [...tr.querySelectorAll('td.clickable-row')];
    if (!clickable.length) return;
    const a = clickable[0].querySelector('a[href]');
    if (!a) return;
    const tds = [...tr.children];
    const pre = tds.slice(0, tds.indexOf(clickable[0])).filter((td) => !td.querySelector('.playTrack'));
    const hasDuration = clickable.length >= formats.length + 2;
    const duration = hasDuration ? text(clickable[1]) : '';
    const sizeCells = clickable.slice(hasDuration ? 2 : 1);
    const sizes = {};
    formats.forEach((f, i) => { const s = text(sizeCells[i]); if (s) sizes[f] = s; });
    const numTd = pre.filter((td) => /^\d+\.?$/.test(text(td))).pop();
    tracks.push({
      id: pathOf(a.getAttribute('href')),
      songPath: a.getAttribute('href'),
      name: text(a),
      duration,
      durSec: durationToSec(duration),
      cd: hasCD && pre[0] ? text(pre[0]) : '',
      num: numTd ? text(numTd).replace('.', '') : String(tracks.length + 1),
      sizes,
      albumPath: path,
      albumTitle: title,
      cover,
    });
  });

  const footer = table?.querySelector('#songlist_footer');
  const totals = footer ? [...footer.querySelectorAll('th')].map(text).filter((t) => t && t !== 'Total:') : [];
  const discs = new Set(tracks.map((t) => t.cd).filter(Boolean));

  return {
    path, title, meta, images, cover, formats, tracks,
    totalTime: totals[0] || '',
    totalSizes: Object.fromEntries(formats.map((f, i) => [f, totals[i + 1] || ''])),
    multiDisc: discs.size > 1,
  };
}
