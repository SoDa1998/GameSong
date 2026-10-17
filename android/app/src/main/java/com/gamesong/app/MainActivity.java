package com.gamesong.app;

import android.content.Intent;
import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GameSongPlugin.class);
        super.onCreate(savedInstanceState);

        // Back button: let the app close sheets / Now Playing / go back a page first.
        // If it has nothing to go back to, send the app to the background (music keeps playing).
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView wv = getBridge() == null ? null : getBridge().getWebView();
                if (wv == null) { moveTaskToBack(true); return; }
                wv.evaluateJavascript("(window.__gsBack && window.__gsBack()) ? 1 : 0", (r) -> {
                    if (!"1".equals(r)) moveTaskToBack(true);
                });
            }
        });
    }

    @Override
    public void onDestroy() {
        if (isFinishing()) stopService(new Intent(this, MediaService.class));
        super.onDestroy();
    }
}
