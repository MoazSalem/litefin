package com.litefin.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.annotation.Nullable;
import androidx.webkit.WebViewAssetLoader;

/**
 * Litefin Android shell — hosts the Litefin web bundle in a WebView.
 *
 * The web bundle is served from https://appassets.androidplatform.net/assets/
 * via WebViewAssetLoader so that fetch(), XHR, localStorage, IndexedDB and
 * service workers all work exactly as they do on a real HTTP origin (this
 * sidesteps the file:// restrictions that other Litefin shells work around).
 */
public class MainActivity extends Activity {
    private static final String TAG = "MainActivity";

    /** Virtual origin serving the bundled web app (copied to assets/webapp/ by the build). */
    private static final String START_URL = "https://appassets.androidplatform.net/assets/webapp/index.html";

    private WebView webView;
    private View nativeSplash;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Fullscreen, edge-to-edge, solid dark background (the web app is dark-themed).
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setNavigationBarColor(Color.BLACK);
        getWindow().setStatusBarColor(Color.BLACK);

        webView = new WebView(this);
        setContentView(webView);

        // Native splash: a plain black view shown over the WebView until the
        // web app signals readiness via AndroidBridge.notifyAppReady().
        nativeSplash = new View(this);
        nativeSplash.setBackgroundColor(Color.BLACK);
        addContentView(nativeSplash, new android.widget.FrameLayout.LayoutParams(
                android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
                android.widget.FrameLayout.LayoutParams.MATCH_PARENT));

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setTextZoom(100); // Ignore OS font scaling — TV-style fixed layout

        // Mixed content: Jellyfin servers may be plain http on the LAN while
        // our virtual origin is https; allow loads from both.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        }

        // Optional remote debugging on chrome://inspect
        WebView.setWebContentsDebuggingEnabled(true);

        webView.setBackgroundColor(Color.BLACK);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        // Bridge — becomes window.AndroidBridge in JS
        webView.addJavascriptInterface(new LitefinBridge(this), "AndroidBridge");

        WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Keep all navigation inside the shell; external links are not
                // opened in a browser for this simple port.
                return false;
            }
        });

        if (savedInstanceState == null) {
            webView.loadUrl(START_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    /**
     * Called by LitefinBridge when the web app signals boot completion.
     * Fades out the native splash.
     */
    public void onAppReady() {
        if (nativeSplash != null && nativeSplash.getVisibility() == View.VISIBLE) {
            nativeSplash.animate().alpha(0f).setDuration(250).withEndAction(new Runnable() {
                @Override
                public void run() {
                    nativeSplash.setVisibility(View.GONE);
                }
            }).start();
        }
    }

    /**
     * Hardware Back button / gesture. The web app owns navigation history, so
     * the event is forwarded into JS (window.__litefinAndroidBack) where the
     * standard key:back pipeline handles modals, router.back(), and exit flow
     * (the web layer calls AndroidBridge.exitApp() when it wants to close).
     * If the web app has not booted yet (hook missing, e.g. during splash),
     * we fall back to moving the task to the background (never killing state).
     */
    @Override
    public void onBackPressed() {
        if (webView != null) {
            // Comma operator: invoke the hook, then report that it existed.
            webView.evaluateJavascript(
                    "(window.__litefinAndroidBack ? (window.__litefinAndroidBack(), 'handled') : '')",
                    value -> {
                        if (value == null || !value.contains("handled")) {
                            moveTaskToBack(true);
                        }
                    });
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) {
            webView.saveState(outState);
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) {
            webView.onPause();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
