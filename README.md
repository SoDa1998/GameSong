# GameSong

GameSong is a desktop player for the [KHInsider](https://downloads.khinsider.com/) video game music archive. It has a simple, modern, lightweight design. You can stream any album, and download songs or whole albums in every format the site offers (MP3, FLAC, OGG, M4A…).

## Get started

You need [Node.js](https://nodejs.org/) 20 or newer.

```bash
git clone <this repo's URL>
cd <repo folder>
npm install
npm start
```

## Build for Windows

```bash
npm run dist
```

This builds two files in `dist/`:

**`GameSong-Setup-<version>.exe`: standalone installer**
- Works offline, because the whole app is inside the installer.
- Installs for the current user only, so it doesn't need admin rights. You can choose the install folder.
- Adds Desktop and Start Menu shortcuts, and can open GameSong when it finishes.
- Adds an uninstaller to Windows **Settings → Apps**. Uninstalling keeps your likes and settings.
- Stores your data in `%APPDATA%\GameSong`, and downloads to `Music\GameSong` by default.

**`GameSong-Portable-<version>.exe`: no install**
- A single file you can put in any folder, such as on a USB drive.
- Keeps everything next to itself:
  - `GameSong Data/` holds likes, library, history, settings and lyric choices.
  - `GameSong Downloads/` is the default download folder.
- Each launch takes a few seconds while the exe unpacks itself.

Neither file is code-signed, so Windows SmartScreen may warn you the first time. Choose **More info → Run anyway**.

## Features

- **Home**: a featured carousel, recently played albums, fresh additions, the Top 40 and popular series.
- **Search**: shows a top result. Filter by album type and sort by relevance, popularity, date or year.
- **Browse**: by album type, by platform, or A–Z.
- **Charts**: the site's chart pages, such as the Top 40, Most favorited and the all-time Top 1000.
- **Your Library**: Liked Songs, saved albums, recently played albums and downloads.
- **Now Playing screen**: opens from the player bar's expand button, the cover art, or the `N` key.
  - Large blurred-art backdrop with full-resolution cover art.
  - Playback controls centered under the seek bar.
  - Volume and the lyrics icon in the row below the controls, plus the next three songs in the queue.
  - Full-screen mode (the button, or `F11`). Text and controls scale with the screen.
- **Lyrics** (from [LRCLIB](https://lrclib.net), a free, open lyrics database):
  - The album art fades out and the lyrics fade in.
  - Synced lyrics highlight the current line and scroll with the song. Click a line to jump to that point.
  - Instrumental tracks are labeled as instrumental.
  - If GameSong can't find a confident match, you can search by hand and pick the right result. GameSong remembers your choice for that song.
- **Downloads**:
  - Click a format chip on any track (for example `FLAC 7.5 MB`) to download it in that format.
  - **Download album** lists every format with its total size and saves the cover art too.
  - The Downloads page shows live progress.
  - Files go into a folder per album. The portable exe uses `GameSong Downloads/<Album>/` next to itself; `npm start` uses `Music/GameSong/<Album>/`. You can change the folder in Settings.

## Shortcuts

| Key | Action |
| --- | --- |
| Space | Play / pause |
| Ctrl + ← / → | Previous / next |
| Ctrl + ↑ / ↓ | Volume |
| Ctrl + K or `/` | Search |
| N | Open or close Now Playing |
| L | Show or hide lyrics |
| F11 | Full screen |
| Esc | Leave full screen, then close Now Playing |
| Alt + ← / → | Back / forward |

## How it works

- `main.js` (the Electron main process) fetches khinsider pages through Chromium's network stack (`net.fetch`), which Cloudflare accepts. If a page still comes back as a challenge, it loads that page in a hidden browser window instead. This process also finds each song's download links for every format, runs the download queue, and sends lyrics searches to LRCLIB.
- `renderer/scraper.js` turns the site's HTML into data.
- `renderer/app.js` contains the UI: router, views, player, Now Playing, lyrics and downloads.
- `tools/build-assets.mjs` (`npm run assets`) copies the bundled **Inter** font and builds `renderer/icons.js` from **Lucide** icons (ISC license). `npm run dist` runs it automatically.

## Disclaimer

GameSong is an unofficial, fan-made client. It isn't affiliated with or endorsed by KHInsider, LRCLIB, or any game publisher. It hosts no music: everything is streamed from KHInsider, and all music belongs to its respective owners. KHInsider is funded by donations, so please [support them](https://downloads.khinsider.com/forums/index.php?account/upgrades) if you use this.

## License

The code is released under the [MIT License](LICENSE). Bundled third-party assets keep their own licenses: [Inter](https://github.com/rsms/inter) (SIL Open Font License 1.1) and [Lucide](https://lucide.dev) icons (ISC).
