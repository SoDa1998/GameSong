// Assembles mobile/www (the web bundle Capacitor ships in the Android app) from the shared
// desktop UI in renderer/, plus the Android implementation of window.khi.
// Run with: npm run mobile:web
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'mobile', 'www');

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'renderer'), out, { recursive: true });
fs.mkdirSync(path.join(out, 'vendor'), { recursive: true });
fs.copyFileSync(path.join(root, 'node_modules', '@capacitor', 'core', 'dist', 'index.js'), path.join(out, 'vendor', 'capacitor-core.js'));
fs.copyFileSync(path.join(root, 'mobile', 'src', 'android-bridge.js'), path.join(out, 'android-bridge.js'));

// index.html: Capacitor injects its native bridge as an inline script, which the desktop CSP
// (script-src 'self') would block, so the Android build drops the CSP meta. Then load the
// Android bridge, which defines window.khi and imports app.js itself.
const indexPath = path.join(out, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
html = html.replace(/\s*<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '');
const before = html;
html = html.replace('<script type="module" src="app.js"></script>', '<script type="module" src="android-bridge.js"></script>');
if (html === before) throw new Error('app.js script tag not found in index.html');
fs.writeFileSync(indexPath, html);

console.log('Built mobile/www');
