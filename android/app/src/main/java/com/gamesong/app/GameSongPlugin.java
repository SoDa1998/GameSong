package com.gamesong.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.graphics.Color;
import android.graphics.Typeface;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native side of GameSong on Android. Mirrors what Electron's main.js does on desktop:
 *  - fetchPage: loads khinsider pages through a hidden WebView on the khinsider origin.
 *    WebView is Chromium, so Cloudflare accepts it where plain HTTP clients get blocked.
 *  - download / cancelDownload / openDownloads: Android DownloadManager into Music/GameSong.
 *  - httpGet: small HTTPS GETs for the LRCLIB lyrics API.
 *  - mediaUpdate + "mediaAction" events: the playback notification / lock-screen controls.
 */
@CapacitorPlugin(name = "GameSong")
public class GameSongPlugin extends Plugin {
    private static final String KHI = "https://downloads.khinsider.com/";
    private static final String UA = "GameSong/1.3 (Android)";
    private static final long FETCH_TIMEOUT_MS = 40_000;

    static GameSongPlugin instance;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newFixedThreadPool(3);

    // ---------------------------------------------------------------- page proxy
    private WebView proxy;
    private boolean proxyReady = false;
    private final ArrayDeque<String> waitingForProxy = new ArrayDeque<>();
    private final Map<String, PluginCall> pageCalls = new ConcurrentHashMap<>();
    private final Map<String, String> pageUrls = new ConcurrentHashMap<>();
    private final Set<String> retried = ConcurrentHashMap.newKeySet();
    // Cloudflare challenge fallback: navigate the proxy to the page and read the DOM.
    private final ArrayDeque<String> navQueue = new ArrayDeque<>();
    private String navId = null;
    private int navPolls = 0;

    @Override
    public void load() {
        instance = this;
        main.post(this::createProxy);
    }

    @SuppressLint({ "SetJavaScriptEnabled", "AddJavascriptInterface" })
    private void createProxy() {
        proxy = new WebView(getContext());
        WebSettings s = proxy.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setBlockNetworkImage(true);
        s.setLoadsImagesAutomatically(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(proxy, true);
        proxy.addJavascriptInterface(new ProxyBridge(), "GSProxy");
        attachProxyBehindApp();
        proxy.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                if (navId != null) {
                    navPolls = 0;
                    main.postDelayed(GameSongPlugin.this::pollNavigation, 400);
                } else if (!proxyReady) {
                    proxyReady = true;
                    while (!waitingForProxy.isEmpty()) runFetch(waitingForProxy.poll());
                }
            }
        });
        // A small same-origin document is enough to issue fetch() calls from.
        proxy.loadUrl(KHI + "robots.txt");
    }

    // A WebView that isn't attached to a window never renders, and Cloudflare's challenge
    // script needs a rendering page to finish. So the proxy lives in the layout at full size,
    // underneath the app's own (opaque) WebView, where it renders but isn't seen.
    private void attachProxyBehindApp() {
        ViewGroup root = appRoot();
        if (root == null || proxy.getParent() != null) return;
        root.addView(proxy, 0, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private ViewGroup appRoot() {
        WebView app = getBridge() == null ? null : getBridge().getWebView();
        return app != null && app.getParent() instanceof ViewGroup ? (ViewGroup) app.getParent() : null;
    }

    // If a challenge needs the user (e.g. a "verify you are human" checkbox), show the proxy
    // on top with a short explanation until it clears.
    private FrameLayout challengeBox;

    private void showChallenge() {
        ViewGroup root = appRoot();
        if (root == null || challengeBox != null) return;
        Context ctx = getContext();
        float dp = ctx.getResources().getDisplayMetrics().density;

        challengeBox = new FrameLayout(ctx);
        challengeBox.setBackgroundColor(Color.parseColor("#111214"));
        challengeBox.setClickable(true);

        LinearLayout header = new LinearLayout(ctx);
        header.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (20 * dp);
        header.setPadding(pad, pad, pad, (int) (12 * dp));
        TextView title = new TextView(ctx);
        title.setText("Quick check");
        title.setTextColor(Color.parseColor("#F1F1F3"));
        title.setTextSize(20);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        TextView sub = new TextView(ctx);
        sub.setText("KHInsider's protection wants to confirm you're human. Complete the check below; GameSong continues on its own afterwards.");
        sub.setTextColor(Color.parseColor("#9A9BA1"));
        sub.setTextSize(14);
        sub.setPadding(0, (int) (6 * dp), 0, (int) (10 * dp));
        Button cancel = new Button(ctx);
        cancel.setText("Cancel");
        cancel.setAllCaps(false);
        cancel.setOnClickListener(v -> {
            if (navId != null) finishPage(navId, null, 0, null, "Check cancelled");
            hideChallenge();
            endNavigation();
        });
        header.addView(title);
        header.addView(sub);
        header.addView(cancel, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        challengeBox.addView(header, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP));

        root.removeView(proxy);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        lp.topMargin = (int) (170 * dp);
        challengeBox.addView(proxy, lp);
        ViewCompat.setOnApplyWindowInsetsListener(challengeBox, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return insets;
        });
        root.addView(challengeBox, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        ViewCompat.requestApplyInsets(challengeBox);
        proxy.getSettings().setBlockNetworkImage(false);
        proxy.getSettings().setLoadsImagesAutomatically(true);
    }

    private void hideChallenge() {
        if (challengeBox == null) return;
        ViewGroup root = appRoot();
        challengeBox.removeView(proxy);
        if (root != null) root.removeView(challengeBox);
        challengeBox = null;
        attachProxyBehindApp();
        proxy.getSettings().setBlockNetworkImage(true);
        proxy.getSettings().setLoadsImagesAutomatically(false);
    }

    @PluginMethod
    public void fetchPage(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith(KHI)) {
            call.reject("Blocked host");
            return;
        }
        String id = UUID.randomUUID().toString();
        pageCalls.put(id, call);
        pageUrls.put(id, url);
        main.post(() -> {
            if (proxyReady) runFetch(id); else waitingForProxy.add(id);
        });
        scheduleTimeout(id, 0);
    }

    // A plain fetch gets 40 s. Requests waiting on a Cloudflare check stay alive while the
    // check runs (up to ~4 min, enough for the user to finish an interactive check).
    private void scheduleTimeout(String id, int extensions) {
        main.postDelayed(() -> {
            if (!pageCalls.containsKey(id)) return;
            boolean waitingOnCheck = id.equals(navId) || navQueue.contains(id) || navId != null;
            if (waitingOnCheck && extensions < 6) { scheduleTimeout(id, extensions + 1); return; }
            finishPage(id, null, 0, null, "Timed out loading page");
        }, FETCH_TIMEOUT_MS);
    }

    private void runFetch(String id) {
        String url = pageUrls.get(id);
        if (url == null || proxy == null) return;
        if (challengeBox == null) attachProxyBehindApp(); // in case the layout wasn't ready at load()
        String js = "(function(){var id=" + JSONObject.quote(id) + ";"
            + "fetch(" + JSONObject.quote(url) + ",{credentials:'include'})"
            + ".then(function(r){return r.text().then(function(t){GSProxy.done(id,r.status,r.url,t);});})"
            + ".catch(function(e){GSProxy.fail(id,String(e));});})();";
        proxy.evaluateJavascript(js, null);
    }

    private static boolean isChallenge(int status, String html) {
        if (status == 403 || status == 503) return true;
        return html != null && (html.contains("<title>Just a moment") || html.contains("<title>Attention Required"));
    }

    private class ProxyBridge {
        @JavascriptInterface
        public void done(String id, int status, String finalUrl, String html) {
            if (isChallenge(status, html)) {
                main.post(() -> {
                    navQueue.add(id);
                    nextNavigation();
                });
                return;
            }
            finishPage(id, html, status, finalUrl, null);
        }

        @JavascriptInterface
        public void fail(String id, String error) {
            main.post(() -> {
                if (!pageCalls.containsKey(id)) return;
                // A navigation of the proxy (for a Cloudflare check) cancels in-flight fetches;
                // endNavigation() re-issues them. Otherwise retry once before giving up.
                if (navId != null) return;
                if (retried.add(id)) main.postDelayed(() -> runFetch(id), 800);
                else finishPage(id, null, 0, null, error);
            });
        }
    }

    private void nextNavigation() {
        if (navId != null) return;
        while (!navQueue.isEmpty()) {
            String id = navQueue.poll();
            if (pageCalls.containsKey(id)) {
                navId = id;
                setChecking(true);
                proxy.loadUrl(pageUrls.get(id));
                return;
            }
        }
        setChecking(false);
    }

    // Tells the UI a Cloudflare check is running (first launch can take ~30 s).
    private boolean checking = false;

    private void setChecking(boolean on) {
        if (checking == on) return;
        checking = on;
        if (!on) CookieManager.getInstance().flush(); // keep the clearance cookie for next launch
        JSObject d = new JSObject();
        d.put("checking", on);
        notifyListeners("proxyStatus", d);
    }

    private void pollNavigation() {
        String id = navId;
        if (id == null) return;
        if (!pageCalls.containsKey(id)) { hideChallenge(); endNavigation(); return; }
        proxy.evaluateJavascript("document.documentElement.outerHTML", (value) -> {
            String html = decodeJsString(value);
            if (html != null && !isChallenge(200, html) && html.contains("pageContent")) {
                finishPage(id, html, 200, proxy.getUrl(), null);
                hideChallenge();
                endNavigation();
            } else if (++navPolls > (challengeBox != null ? 400 : 60)) {
                finishPage(id, null, 0, null, "Could not get past the site's bot check");
                hideChallenge();
                endNavigation();
            } else {
                // Usually clears on its own within ~10-25 s. Still challenged after ~30 s:
                // it probably needs a tap, so show it.
                if (navPolls == 60) showChallenge();
                main.postDelayed(this::pollNavigation, 500);
            }
        });
    }

    private void endNavigation() {
        navId = null;
        // Navigating replaced the proxy's document, which cancels any fetches that were in
        // flight in it; re-issue them now that the proxy sits on a cleared page again.
        for (String other : pageCalls.keySet()) if (!navQueue.contains(other)) runFetch(other);
        nextNavigation();
    }

    private static String decodeJsString(String jsonValue) {
        try {
            return new JSONArray("[" + jsonValue + "]").getString(0);
        } catch (Exception e) {
            return null;
        }
    }

    private void finishPage(String id, String html, int status, String finalUrl, String error) {
        PluginCall call = pageCalls.remove(id);
        String url = pageUrls.remove(id);
        retried.remove(id);
        if (call == null) return;
        if (error != null) {
            call.reject(error);
            return;
        }
        JSObject r = new JSObject();
        r.put("status", status);
        r.put("url", finalUrl != null && !finalUrl.isEmpty() ? finalUrl : url);
        r.put("html", html);
        call.resolve(r);
    }

    // ---------------------------------------------------------------- small HTTPS GETs (lyrics)
    @PluginMethod
    public void httpGet(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith("https://lrclib.net/")) {
            call.reject("Blocked host");
            return;
        }
        io.execute(() -> {
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(15_000);
                c.setReadTimeout(20_000);
                c.setRequestProperty("User-Agent", UA);
                c.setRequestProperty("Accept", "application/json");
                int status = c.getResponseCode();
                InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                JSObject r = new JSObject();
                r.put("status", status);
                r.put("body", in == null ? "" : readAll(in));
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "Network error" : e.getMessage());
            } finally {
                if (c != null) c.disconnect();
            }
        });
    }

    private static String readAll(InputStream in) throws Exception {
        try (InputStream is = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = is.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }

    // ---------------------------------------------------------------- downloads
    private final Set<Long> tracked = new HashSet<>();
    private boolean polling = false;

    private static String clean(String s) {
        String v = s == null ? "" : s.replaceAll("[<>:\"/\\\\|?*\\x00-\\x1F]", "_").trim();
        while (v.endsWith(".") || v.endsWith(" ")) v = v.substring(0, v.length() - 1);
        if (v.length() > 120) v = v.substring(0, 120);
        return v.isEmpty() ? "Untitled" : v;
    }

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url", "");
        String host = Uri.parse(url).getHost();
        if (!url.startsWith("https://") || host == null || !(host.equals("vgmtreasurechest.com") || host.endsWith(".vgmtreasurechest.com"))) {
            call.reject("Unexpected media host");
            return;
        }
        String folder = clean(call.getString("folder", "GameSong"));
        String filename = clean(call.getString("filename", "track"));
        try {
            DownloadManager dm = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setTitle(filename);
            req.setDescription(folder);
            req.addRequestHeader("User-Agent", UA);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_MUSIC, "GameSong/" + folder + "/" + filename);
            long id = dm.enqueue(req);
            synchronized (tracked) { tracked.add(id); }
            startPolling();
            JSObject r = new JSObject();
            r.put("downloadId", id);
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage() == null ? "Could not start download" : e.getMessage());
        }
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        Long id = call.getLong("downloadId");
        if (id != null) {
            ((DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE)).remove(id);
            synchronized (tracked) { tracked.remove(id); }
        }
        call.resolve();
    }

    @PluginMethod
    public void openDownloads(PluginCall call) {
        try {
            Intent i = new Intent(DownloadManager.ACTION_VIEW_DOWNLOADS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("No app to show downloads");
        }
    }

    private void startPolling() {
        if (polling) return;
        polling = true;
        main.postDelayed(this::pollDownloads, 600);
    }

    private void pollDownloads() {
        long[] ids;
        synchronized (tracked) {
            if (tracked.isEmpty()) { polling = false; return; }
            ids = new long[tracked.size()];
            int i = 0;
            for (Long id : tracked) ids[i++] = id;
        }
        io.execute(() -> {
            DownloadManager dm = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            Set<Long> seen = new HashSet<>();
            try (Cursor c = dm.query(new DownloadManager.Query().setFilterById(ids))) {
                while (c != null && c.moveToNext()) {
                    long id = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_ID));
                    int st = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                    seen.add(id);
                    JSObject d = new JSObject();
                    d.put("downloadId", id);
                    d.put("received", c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)));
                    d.put("total", Math.max(0, c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))));
                    String status;
                    switch (st) {
                        case DownloadManager.STATUS_SUCCESSFUL: status = "successful"; break;
                        case DownloadManager.STATUS_FAILED: status = "failed"; break;
                        case DownloadManager.STATUS_PAUSED: status = "paused"; break;
                        case DownloadManager.STATUS_PENDING: status = "pending"; break;
                        default: status = "running";
                    }
                    d.put("status", status);
                    if (st == DownloadManager.STATUS_SUCCESSFUL) {
                        String local = c.getString(c.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI));
                        d.put("file", local == null ? "" : Uri.decode(local));
                    }
                    if (st == DownloadManager.STATUS_FAILED) {
                        d.put("reason", "Download failed (code " + c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON)) + ")");
                    }
                    notifyListeners("download", d);
                    if (st == DownloadManager.STATUS_SUCCESSFUL || st == DownloadManager.STATUS_FAILED) {
                        synchronized (tracked) { tracked.remove(id); }
                    }
                }
            } catch (Exception ignored) {
            }
            // Downloads removed elsewhere (e.g. from the system Downloads app) count as cancelled.
            synchronized (tracked) {
                for (long id : ids) {
                    if (!seen.contains(id) && tracked.remove(id)) {
                        JSObject d = new JSObject();
                        d.put("downloadId", id);
                        d.put("status", "failed");
                        d.put("reason", "Removed");
                        notifyListeners("download", d);
                    }
                }
            }
            main.postDelayed(this::pollDownloads, 700);
        });
    }

    // ---------------------------------------------------------------- misc
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url", "");
        Uri uri = Uri.parse(url);
        if (!"https".equals(uri.getScheme()) || uri.getHost() == null || !uri.getHost().endsWith("khinsider.com")) {
            call.reject("Blocked URL");
            return;
        }
        Intent i = new Intent(Intent.ACTION_VIEW, uri);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    // ---------------------------------------------------------------- media notification
    private boolean askedNotifications = false;

    @PluginMethod
    public void mediaUpdate(PluginCall call) {
        Bundle b = new Bundle();
        b.putString("title", call.getString("title", ""));
        b.putString("album", call.getString("album", ""));
        b.putString("art", call.getString("art", ""));
        b.putBoolean("playing", Boolean.TRUE.equals(call.getBoolean("playing", false)));
        b.putDouble("position", call.getDouble("position", 0.0));
        b.putDouble("duration", call.getDouble("duration", 0.0));
        boolean playing = b.getBoolean("playing");
        main.post(() -> {
            if (playing && Build.VERSION.SDK_INT >= 33 && !askedNotifications
                && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                && getActivity() != null) {
                askedNotifications = true;
                ActivityCompat.requestPermissions(getActivity(), new String[] { Manifest.permission.POST_NOTIFICATIONS }, 7301);
            }
            MediaService svc = MediaService.instance;
            if (svc != null) {
                svc.update(b);
            } else if (playing) {
                Intent i = new Intent(getContext(), MediaService.class);
                i.putExtra("meta", b);
                try {
                    ContextCompat.startForegroundService(getContext(), i);
                } catch (Exception ignored) {
                    // Starting a foreground service from the background can be refused; playback
                    // continues, only the notification is missing until the next update.
                }
            }
        });
        call.resolve();
    }

    /** Called by MediaService / MediaActionReceiver when a notification or headset button is used. */
    static void emitMediaAction(String action, double positionSec) {
        GameSongPlugin p = instance;
        if (p == null) return;
        JSObject d = new JSObject();
        d.put("action", action);
        d.put("position", positionSec);
        p.notifyListeners("mediaAction", d);
    }

    @Override
    protected void handleOnDestroy() {
        if (proxy != null) {
            proxy.destroy();
            proxy = null;
        }
        io.shutdownNow();
        if (instance == this) instance = null;
    }
}
