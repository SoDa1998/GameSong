// Renders build/icon.svg into build/icon.png (Windows, 512px, full bleed) and
// build/icon.icns (macOS, PNG-based, padded to Apple's 824/1024 icon grid).
// Run with: npx electron tools/make-icons.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'utf8');

async function render(win, size, inset) {
  const inner = size - inset * 2;
  const html = `<html><body style="margin:0;background:transparent;width:${size}px;height:${size}px">
    <div style="position:absolute;left:${inset}px;top:${inset}px;width:${inner}px;height:${inner}px">
    ${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></body></html>`;
  win.setContentSize(size, size);
  await win.loadURL('data:text/html,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  return img.resize({ width: size, height: size, quality: 'best' });
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, useContentSize: true, enableLargerThanScreen: true, webPreferences: { offscreen: true } });

  fs.writeFileSync(path.join(root, 'build', 'icon.png'), (await render(win, 512, 0)).toPNG());

  // macOS: artwork occupies the central 824/1024 of the canvas.
  const big = await render(win, 1024, 100);
  const entries = [['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]];
  const chunks = entries.map(([type, size]) => {
    const png = (size === 1024 ? big : big.resize({ width: size, height: size, quality: 'best' })).toPNG();
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);
  fs.writeFileSync(path.join(root, 'build', 'icon.icns'), Buffer.concat([header, body]));

  console.log('Wrote build/icon.png and build/icon.icns');
  app.quit();
});
