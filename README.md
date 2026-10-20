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

**`GameSong-<version>-Portable.rar`: no install**
- A single RAR file you can put in any folder, such as on a USB drive.
- Keeps everything next to itself:
  - `GameSong Downloads/` is the default download folder.
- Just extract the archive and open **"GameSong.exe"**.

Neither file is code-signed, so Windows SmartScreen may warn you the first time. Choose **More info → Run anyway**.

## Features

- **Home**: a featured carousel, your listen history, recently played albums, fresh additions, the Top 40 and popular series.
- **Listen history**: every song you play, newest first. Home shows the latest eight; **See all** opens the full history (up to 200 songs) grouped by day, where you can replay, download or clear it.
- **Search**: shows a top result. Filter by album type and sort by relevance, popularity, date or year.
  - Before you type, it's also where you browse: by album type, by platform, A–Z, or the charts.
  - **Recent searches** appear on the Search page before you type. Click one to search again, or × to remove it. Searches made while typing are saved once, as the finished query.
- **Charts**: the site's chart pages, such as the Top 40, Most favorited and the all-time Top 1000.
- **Your Library**: Liked Songs, saved albums, recently played albums and downloads.
- **Sidebar**: collapses to an icon-only rail with the button next to the logo or `Ctrl + B`.
- **Options menu** (bottom-left of the sidebar): quick toggles for Exclusive mode and streaming quality, plus Downloads, the download folder, a random album, collapsing the sidebar, Settings and the KHInsider site.
- **Support KHInsider** (above Options): opens KHInsider's donation page in your browser. The site runs on donations, and every song in GameSong comes from it.
- **Now Playing screen**: opens from the player bar's expand button, the cover art, or the `N` key.
  - Large blurred-art backdrop with full-resolution cover art.
  - Playback controls centered under the seek bar, with the lyrics button in the like / download row.
  - A scrollable **Playing Queue** with the whole queue: played tracks above, the current one highlighted, upcoming below. Click any row to play it.
  - Full-screen mode (the button, or `F11`). Text and controls scale with the screen.
- **Appearance** (Settings → Appearance, or the Options menu):
  - **Display mode**: Dark, Light, System (follows Windows' light or dark mode, live), or Custom, which builds the whole theme from one colour you pick. Dark colours give a dark theme, light colours a light one.
  - **Accent colour**: preset swatches or any colour, used for play buttons, progress bars, selected chips and liked songs. Default keeps the app black and white.
  - **Frosted glass** (Windows 11 22H2 or newer): the window turns translucent and blurs the desktop behind it, with a **Transparency** slider from 0 to 90%. It works with every display mode.
  - Now Playing and the Home carousel stay dark in every theme, because they sit on top of album art.
- **Volume** (Windows): the slider *is* the system volume of your default playback device. It matches Windows at startup, follows changes made in Windows (volume flyout, keyboard keys), and never changes when songs change. Mute is the system mute. GameSong's own player always runs at 100%.
- **Exclusive mode** (Windows, bit-perfect FLAC): see below.
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

## Exclusive mode (bit-perfect FLAC)

Turn it on with the headphones button in the player bar or in **Settings**. While it's on, albums that have FLAC stream the FLAC straight to your audio device in **WASAPI exclusive mode**:

- **Bit-perfect:** the Windows mixer is skipped, so nothing is resampled, mixed or volume-scaled. The device runs at the file's own format (for example 24-bit / 44.1 kHz). 16-bit audio is only zero-padded if the device wants a bigger container, which is lossless.
- **The gold `EXCLUSIVE` badge** shows it's active. Hover it to see the exact source format, output format and device.
- **The volume slider** is still the system volume. On a DAC with hardware volume it changes the DAC itself, so playback stays bit-perfect. If the device has no hardware volume, Windows can't change an exclusive stream's level, so use the device's own volume control.
- **Other apps can't play sound** on that device while GameSong holds it. Turning Exclusive mode off, or quitting, releases it.

GameSong plays normally instead, and says why, when:
- an album has no FLAC;
- Windows has exclusive access turned off for the device (Sound settings › device › Properties › Advanced);
- another app is using the device exclusively;
- the device can't play the file's sample rate.

Exclusive playback uses a small native player, `gs-exclusive.exe` (`native/exclusive`). It's C# built with the compiler that ships with Windows (`npm run native`; `npm run dist` runs it), so there's no SDK or extra download. It:
- streams the FLAC over HTTP;
- decodes it with its own FLAC decoder, verified bit-identical to ffmpeg, including after seeking;
- feeds the device from a real-time audio thread.

The WASAPI device code is adapted from the SoDaPlayer project.

## Shortcuts

| Key | Action |
| --- | --- |
| Space | Play / pause |
| Ctrl + ← / → | Previous / next |
| Ctrl + ↑ / ↓ | Volume |
| Ctrl + K or `/` | Search |
| Ctrl + B | Collapse or expand the sidebar |
| N | Open or close Now Playing |
| L | Show or hide lyrics |
| F11 | Full screen |
| Esc | Leave full screen, then close Now Playing |
| Alt + ← / → | Back / forward |

## How it works

- `main.js` (the Electron main process) fetches khinsider pages through Chromium's network stack (`net.fetch`), which Cloudflare accepts. If a page still comes back as a challenge, it loads that page in a hidden browser window instead. This process also finds each song's download links for every format, runs the download queue, and sends lyrics searches to LRCLIB.
- `renderer/scraper.js` turns the site's HTML into data.
- `renderer/app.js` contains the UI: router, views, player, Now Playing, lyrics and downloads.
- `renderer/engine.js` is the playback engine: the browser's `<audio>` normally, or the native exclusive-mode player.
- `native/exclusive/` is the WASAPI exclusive-mode FLAC player (`gs-exclusive.exe`), started by `main.js` on demand.
- `tools/build-assets.mjs` (`npm run assets`) copies the bundled **Inter** font and builds `renderer/icons.js` from **Lucide** icons (ISC license). `npm run dist` runs it automatically.

## Disclaimer

GameSong is an unofficial, fan-made client. It isn't affiliated with or endorsed by KHInsider, LRCLIB, or any game publisher. It hosts no music: everything is streamed from KHInsider, and all music belongs to its respective owners. KHInsider is funded by donations, so please [support them](https://downloads.khinsider.com/forums/index.php?account/upgrades) if you use this.

## License

The code is released under the [MIT License](LICENSE). Bundled third-party assets keep their own licenses: [Inter](https://github.com/rsms/inter) (SIL Open Font License 1.1) and [Lucide](https://lucide.dev) icons (ISC).
