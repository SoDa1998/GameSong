package com.gamesong.app;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Serves album art at https://localhost/_gscover/<px>/<encoded full-size URL>.
 * KHInsider's CDN only has 60px/117px thumbnails or the full ~1000px original, so this
 * downloads the original once, scales it to <px> on its longest side, and caches a JPEG in
 * the app's cache folder. Everything else goes to Capacitor's normal handler.
 */
public class CoverWebViewClient extends BridgeWebViewClient {
    private static final String PREFIX = "/_gscover/";
    private final File cacheDir;
    private final Map<String, Object> locks = new ConcurrentHashMap<>();

    public CoverWebViewClient(Bridge bridge, Context ctx) {
        super(bridge);
        cacheDir = new File(ctx.getCacheDir(), "covers");
        cacheDir.mkdirs();
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri u = request.getUrl();
        String path = u.getEncodedPath();
        if ("localhost".equals(u.getHost()) && path != null && path.startsWith(PREFIX)) {
            return serveCover(path.substring(PREFIX.length()));
        }
        return super.shouldInterceptRequest(view, request);
    }

    // Runs on a WebView background thread, so blocking I/O is fine here.
    private WebResourceResponse serveCover(String rest) {
        try {
            int slash = rest.indexOf('/');
            int px = Math.max(64, Math.min(1600, Integer.parseInt(rest.substring(0, slash))));
            String src = Uri.decode(rest.substring(slash + 1));
            Uri srcUri = Uri.parse(src);
            String host = srcUri.getHost();
            if (!"https".equals(srcUri.getScheme()) || host == null
                || !(host.equals("vgmtreasurechest.com") || host.endsWith(".vgmtreasurechest.com"))) {
                return error(403);
            }
            File out = new File(cacheDir, sha1(src) + "-" + px + ".jpg");
            Object lock = locks.computeIfAbsent(out.getName(), k -> new Object());
            synchronized (lock) {
                if (!out.exists()) {
                    byte[] original = download(src);
                    if (original == null) return error(404);
                    byte[] scaled = scale(original, px);
                    if (scaled == null) {
                        // Format Android can't decode here: hand back the original bytes.
                        return ok(guessType(src), new ByteArrayInputStream(original));
                    }
                    File tmp = new File(cacheDir, out.getName() + ".tmp");
                    try (FileOutputStream fo = new FileOutputStream(tmp)) { fo.write(scaled); }
                    if (!tmp.renameTo(out)) return ok("image/jpeg", new ByteArrayInputStream(scaled));
                }
            }
            locks.remove(out.getName());
            return ok("image/jpeg", new FileInputStream(out));
        } catch (Exception e) {
            return error(500);
        }
    }

    private static byte[] download(String src) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(src).openConnection();
        c.setConnectTimeout(15_000);
        c.setReadTimeout(30_000);
        c.setRequestProperty("User-Agent", "GameSong/1.3 (Android)");
        try {
            if (c.getResponseCode() != 200) return null;
            try (InputStream in = c.getInputStream(); ByteArrayOutputStream bo = new ByteArrayOutputStream()) {
                byte[] buf = new byte[32768];
                int n;
                while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
                return bo.toByteArray();
            }
        } finally {
            c.disconnect();
        }
    }

    private static byte[] scale(byte[] data, int px) {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(data, 0, data.length, bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;
        int longest = Math.max(bounds.outWidth, bounds.outHeight);
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = 1;
        while (longest / (opts.inSampleSize * 2) >= px) opts.inSampleSize *= 2; // cheap first pass
        Bitmap bmp = BitmapFactory.decodeByteArray(data, 0, data.length, opts);
        if (bmp == null) return null;
        int w = bmp.getWidth(), h = bmp.getHeight();
        float k = (float) px / Math.max(w, h);
        if (k < 1f) {
            Bitmap s = Bitmap.createScaledBitmap(bmp, Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)), true);
            if (s != bmp) bmp.recycle();
            bmp = s;
        }
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        bmp.compress(Bitmap.CompressFormat.JPEG, 88, bo);
        bmp.recycle();
        return bo.toByteArray();
    }

    private static WebResourceResponse ok(String type, InputStream body) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "max-age=31536000");
        return new WebResourceResponse(type, null, 200, "OK", headers, body);
    }

    private static WebResourceResponse error(int status) {
        return new WebResourceResponse("text/plain", "utf-8", status, "Error", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    private static String guessType(String src) {
        String s = src.toLowerCase();
        if (s.endsWith(".png")) return "image/png";
        if (s.endsWith(".webp")) return "image/webp";
        if (s.endsWith(".gif")) return "image/gif";
        return "image/jpeg";
    }

    private static String sha1(String s) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-1").digest(s.getBytes("UTF-8"));
        StringBuilder sb = new StringBuilder();
        for (byte b : d) sb.append(String.format("%02x", b));
        return sb.toString();
    }
}
