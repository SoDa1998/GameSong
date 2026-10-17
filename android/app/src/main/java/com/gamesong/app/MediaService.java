package com.gamesong.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.wifi.WifiManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Foreground "media playback" service: shows the playback notification and lock-screen
 * controls (via a MediaSession), and keeps the CPU / Wi-Fi awake while music plays so the
 * WebView's audio keeps streaming with the screen off. Audio itself plays in the WebView.
 */
public class MediaService extends Service {
    static MediaService instance;

    static final String CHANNEL = "playback";
    static final int NOTIFICATION_ID = 1001;
    static final String ACTION_PLAY_PAUSE = "com.gamesong.app.PLAY_PAUSE";
    static final String ACTION_NEXT = "com.gamesong.app.NEXT";
    static final String ACTION_PREV = "com.gamesong.app.PREV";

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService artLoader = Executors.newSingleThreadExecutor();
    private MediaSessionCompat session;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    private String title = "", album = "", artUrl = "", loadedArtUrl = "";
    private Bitmap art;
    private boolean playing = false;
    private long positionMs = 0, durationMs = 0;
    private boolean inForeground = false;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;

        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Playback", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Shows what's playing, with playback controls");
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);

        session = new MediaSessionCompat(this, "GameSong");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { GameSongPlugin.emitMediaAction("play", 0); }
            @Override public void onPause() { GameSongPlugin.emitMediaAction("pause", 0); }
            @Override public void onStop() { GameSongPlugin.emitMediaAction("pause", 0); }
            @Override public void onSkipToNext() { GameSongPlugin.emitMediaAction("next", 0); }
            @Override public void onSkipToPrevious() { GameSongPlugin.emitMediaAction("prev", 0); }
            @Override public void onSeekTo(long pos) { GameSongPlugin.emitMediaAction("seek", pos / 1000.0); }
        });
        session.setActive(true);

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "GameSong:playback");
        wakeLock.setReferenceCounted(false);
        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "GameSong:playback");
        wifiLock.setReferenceCounted(false);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            handleAction(intent.getAction());
            Bundle meta = intent.getBundleExtra("meta");
            if (meta != null) update(meta);
            else if (!inForeground) refresh(); // a foreground-service start must call startForeground
        }
        return START_NOT_STICKY;
    }

    void update(Bundle b) {
        title = b.getString("title", "");
        album = b.getString("album", "");
        playing = b.getBoolean("playing", false);
        positionMs = (long) (b.getDouble("position", 0) * 1000);
        durationMs = (long) (b.getDouble("duration", 0) * 1000);
        String url = b.getString("art", "");
        if (!url.equals(artUrl)) {
            artUrl = url;
            art = null;
            loadArt(url);
        }
        refresh();
    }

    private void loadArt(String url) {
        if (url == null || !url.startsWith("https://")) return;
        artLoader.execute(() -> {
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(10_000);
                c.setReadTimeout(15_000);
                try (InputStream in = c.getInputStream()) {
                    Bitmap bmp = BitmapFactory.decodeStream(in);
                    main.post(() -> {
                        if (url.equals(artUrl) && bmp != null) {
                            art = bmp;
                            loadedArtUrl = url;
                            refresh();
                        }
                    });
                }
            } catch (Exception ignored) {
            } finally {
                if (c != null) c.disconnect();
            }
        });
    }

    private void refresh() {
        MediaMetadataCompat.Builder md = new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, album)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, album)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs);
        if (art != null) md.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, art);
        session.setMetadata(md.build());
        session.setPlaybackState(new PlaybackStateCompat.Builder()
            .setActions(PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE | PlaybackStateCompat.ACTION_PLAY_PAUSE
                | PlaybackStateCompat.ACTION_SKIP_TO_NEXT | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS | PlaybackStateCompat.ACTION_SEEK_TO)
            .setState(playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED, positionMs, playing ? 1f : 0f)
            .build());

        Notification n = buildNotification();
        if (playing) {
            try {
                ServiceCompat.startForeground(this, NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
                inForeground = true;
            } catch (Exception e) {
                // Android may refuse to promote to foreground from the background; still show it.
                notifySafely(n);
            }
            if (!wakeLock.isHeld()) wakeLock.acquire(6 * 60 * 60 * 1000L);
            if (!wifiLock.isHeld()) wifiLock.acquire();
        } else {
            if (!inForeground && !playing) {
                // Started for a paused track: must still enter the foreground once, then drop it.
                try { ServiceCompat.startForeground(this, NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK); } catch (Exception ignored) { }
            }
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_DETACH);
            inForeground = false;
            notifySafely(n);
            if (wakeLock.isHeld()) wakeLock.release();
            if (wifiLock.isHeld()) wifiLock.release();
        }
    }

    private void notifySafely(Notification n) {
        try {
            NotificationManagerCompat.from(this).notify(NOTIFICATION_ID, n);
        } catch (SecurityException ignored) {
            // Notifications permission not granted; playback is unaffected.
        }
    }

    private PendingIntent actionIntent(String action, int code) {
        Intent i = new Intent(this, MediaActionReceiver.class).setAction(action);
        return PendingIntent.getBroadcast(this, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_gamesong)
            .setContentTitle(title.isEmpty() ? "GameSong" : title)
            .setContentText(album)
            .setLargeIcon(art)
            .setContentIntent(content)
            .setOngoing(playing)
            .setSilent(true)
            .setShowWhen(false)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .addAction(R.drawable.ic_media_prev, "Previous", actionIntent(ACTION_PREV, 1))
            .addAction(playing ? R.drawable.ic_media_pause : R.drawable.ic_media_play, playing ? "Pause" : "Play", actionIntent(ACTION_PLAY_PAUSE, 2))
            .addAction(R.drawable.ic_media_next, "Next", actionIntent(ACTION_NEXT, 3))
            .setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                .setMediaSession(session.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2))
            .build();
    }

    void handleAction(String action) {
        if (ACTION_PLAY_PAUSE.equals(action)) GameSongPlugin.emitMediaAction(playing ? "pause" : "play", 0);
        else if (ACTION_NEXT.equals(action)) GameSongPlugin.emitMediaAction("next", 0);
        else if (ACTION_PREV.equals(action)) GameSongPlugin.emitMediaAction("prev", 0);
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // App swiped away from recents: stop playback service and its notification.
        stopSelf();
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        if (session != null) { session.setActive(false); session.release(); }
        artLoader.shutdownNow();
        NotificationManagerCompat.from(this).cancel(NOTIFICATION_ID);
        instance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
