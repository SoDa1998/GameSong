package com.gamesong.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Receives taps on the notification's previous / play-pause / next buttons. */
public class MediaActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        MediaService svc = MediaService.instance;
        if (svc != null) svc.handleAction(intent.getAction());
    }
}
