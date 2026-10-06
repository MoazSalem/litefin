package com.litefin.app;

import android.webkit.JavascriptInterface;
import android.os.Build;

/**
 * Native bridge exposed to the WebView as window.AndroidBridge.
 *
 * Mirrors the surface the TV adapters (Tizen/WebOS) provide: back handling is
 * routed through the shell, exit is forwarded to the shell, and device
 * identification is supplied for the Jellyfin dashboard device list.
 */
public class LitefinBridge {
    private static final String TAG = "LitefinBridge";

    private final MainActivity activity;

    public LitefinBridge(MainActivity activity) {
        this.activity = activity;
    }

    /**
     * Called by the web app when boot completes so the shell can hide its
     * native splash. The web bundle calls this from AndroidAdapter.init().
     */
    @JavascriptInterface
    public void notifyAppReady() {
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                activity.onAppReady();
            }
        });
    }

    /**
     * Exit the application (finishes the Activity).
     */
    @JavascriptInterface
    public void exitApp() {
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                activity.finish();
            }
        });
    }

    /**
     * Device model string (Build.MODEL), e.g. "SM-S928B" on a Galaxy S24 Ultra.
     */
    @JavascriptInterface
    public String getDeviceModel() {
        return Build.MODEL;
    }

    /**
     * Device brand/manufacturer string (Build.MANUFACTURER), e.g. "samsung".
     */
    @JavascriptInterface
    public String getDeviceBrand() {
        return Build.MANUFACTURER;
    }

    /**
     * Android OS release string, e.g. "14".
     */
    @JavascriptInterface
    public String getOsVersion() {
        return Build.VERSION.RELEASE;
    }
}
