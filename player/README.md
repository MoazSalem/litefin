# @jellyfin/player

A standalone, high-performance video player for Jellyfin clients, featuring a unified settings system and native Tizen support.

## Features

- **Dual Backends**: Playback via standard HTML5/HLS.js (Web) or `tizen.avplay` (Tizen TV).
- **Unified Settings**: Built-in settings management for audio, video, subtitles, and playback behavior.
- **Embedded UI**: Includes OSD controls and a dedicated Settings UI.
- **Wrapper Friendly**: Designed to be hosted in a WebView with a simple message-passing API.

## Installation

```bash
npm install @jellyfin/player
```

## Integration Guide

### 1. Basic Setup

Include the compiled bundle and CSS in your WebView:

```html
<link rel="stylesheet" href="dist/jellyfin-player.css">
<script src="dist/jellyfin-player.min.js"></script>
```

### 2. Initialization

The player exposes a global `JellyfinPlayer` object. Initialize it with your container and credentials:

```javascript
/* In your host app (WebView controller) */

const player = window.JellyfinPlayer.init({
    serverUrl: 'https://demo.jellyfin.org',
    authToken: 'YOUR_AUTH_TOKEN',
    container: document.getElementById('player-root'),
    
    // Optional: Force a specific backend
    useTizenPlayer: true // or false, or omit for auto-detect
});
```

### 3. Playback

Send playback commands to the player:

```javascript
await player.play({
    itemId: '38a40...',    // Jellyfin Item ID
    startPositionTicks: 0, // Resume position (optional)
    mediaSourceId: '...',  // Specific source (optional)
    audioStreamIndex: 1,   // (optional)
    subtitleStreamIndex: 2 // (optional)
});
```

### 4. Communication (Bridge)

The player communicates with the host app via `postMessage`.

**From Host to Player:**
You can call methods directly on `player` instance if you have access to the window execution context, or use `postMessage` if cross-origin (though usually local file):

```javascript
// 1. Direct control (if same origin)
player.pause();

// 2. Cross-origin / WebView (postMessage)
window.postMessage({
    command: 'pause',
    target: 'jellyfin-player'
}, '*');

/* Play Example via postMessage */
window.postMessage({
    command: 'play',
    target: 'jellyfin-player',
    itemId: '38a40...',
    startPositionTicks: 0
}, '*');
```

**From Player to Host:**
Listen for events from the player:

```javascript
window.addEventListener('message', (event) => {
    const msg = event.data;
    
    switch (msg.type) {
        case 'playbackStart':
            console.log('Media started');
            break;
        case 'playbackProgress':
            // msg.positionTicks
            break;
        case 'playbackStop':
            // Save progress?
            break;
        case 'settingsSaved':
            console.log('New settings:', msg.settings);
            break;
    }
});
```

## Settings UI

To load the settings page, simply navigate the WebView to `settings.html` (bundled with the package). It will automatically load current settings and notify the host app on save.

```javascript
// Example: Load settings page
webview.loadUrl('path/to/dist/settings.html');
```

## Building

```bash
npm install
npm run build
```

## License
GPL-2.0
