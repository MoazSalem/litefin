# Plugin System

Litefin features a modular plugin system that allows extending the application's functionality without modifying the core codebase. Plugins can inject UI elements, listen to playback events, and communicate with Jellyfin server plugins.

## Architecture

The plugin system is built around three main components:

1.  **PluginManager** (`src/plugins/PluginManager.js`): The central hub that loads bundled plugins, manages their lifecycle (init/enable/disable/destroy), and broadcasts app events.
2.  **PluginAPI** (`src/plugins/PluginAPI.js`): A sandboxed interface provided to each plugin. Plugins should only interact with Litefin through this API to ensure stability and compatibility.
3.  **ServerPluginClient** (`src/plugins/ServerPluginClient.js`): A specialized client that detects and communicates with server-side Jellyfin plugins (like Intro Skipper) via hybrid detection strategy (admin `/Plugins` query + endpoint probing for non-admin users).

## Bundled Plugins

Litefin ships with 4 bundled plugins registered in `PluginManager.js`:

| Plugin ID         | Description                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `skip-intro`      | Skip buttons for TV show intros and recaps via server-side Intro Skipper                          |
| `syncplay`        | Real-time synchronized group playback via WebSockets                                              |
| `local-intros`    | Play custom local video files before media content                                                |
| `mdblist-ratings` | Fetch and display IMDb, Rotten Tomatoes, Metacritic, Trakt, TMDB, and Letterboxd ratings on cards |

## Creating a Plugin

### 1. Directory Structure

Create a new directory for your plugin in `src/plugins/installed/`:

```
src/plugins/installed/my-plugin/
├── index.js      (Main entry point)
└── styles.css    (Optional styling)
```

### 2. Plugin Implementation

Your `index.js` must export a default object that implements the plugin interface:

```javascript
export default {
    id: 'my-plugin',
    name: 'My Awesome Plugin',
    version: '1.0.0',
    description: 'Adds a custom button to the OSD.',

    // Optional: Declare a dependency on a server-side plugin
    serverDependency: 'intro-skipper',

    async init(api) {
        api.log.info('Plugin initialized!');

        // Listen to playback events
        api.on('player:timeupdate', (data) => {
            // handle update
        });

        // Add a widget to the Player OSD
        api.addOSDWidget({
            id: 'my-widget',
            render: () => {
                const btn = document.createElement('div');
                btn.className = 'osd-button';
                btn.innerText = 'Click Me';
                return btn;
            },
            onSelect: () => {
                api.showToast('Button clicked!');
            }
        });
    },

    onPlayerStart(item, api) {
        api.log.info('Playback started:', item.Name);
    },

    destroy(api) {
        api.log.info('Plugin shutting down');
    }
};
```

### 3. Lifecycle Hooks

- `init(api)`: Called when the plugin is loaded and enabled.
- `prepareItemPlayback(item, playbackContext, api)`: Called before playback starts, allowing the plugin to modify the playback context or item.
- `onPlayerStart(item, player, osd, api)`: Triggered when a new media item starts playing.
- `onTimeUpdate(pos, dur, api)`: High-frequency update during playback (via `notifyTimeUpdate`).
- `onPlayerStop(api)`: Cleanup when playback ends.
- `onPageLoad(pageId, pageEl, api)`: Triggered when a non-player page (e.g., 'home', 'details') is loaded.
- `onPageUnload(pageId, api)`: Triggered when a page is closed.
- `destroy(api)`: Final cleanup (automatic subscriptions are cleaned up by the API).

Additional PluginManager methods: `getPlugin(pluginId)`, `isEnabled(pluginId)`, `getPluginIds()`, `getPluginList()`, `setPluginEnabled(pluginId, enabled)`, `checkServerDependency(pluginId)`, `handleWidgetKey(key, focusedEl)`.

### 4. Registration

Register your plugin in `src/plugins/PluginManager.js` by adding it to the `BUNDLED_PLUGINS` array:

```javascript
const BUNDLED_PLUGINS = [
    // ... existing plugins
    {
        id: 'my-plugin',
        load: () => import('./installed/my-plugin/index.js')
    }
];
```

## Integrating with Server Plugins

Litefin uses a **Hybrid Detection Strategy** to find server-side plugins:

1.  **Admin Users**: Litefin queries `/Plugins` to get a list of all installed server plugins.
2.  **Non-Admin Users**: Since regular users cannot view the plugin list, Litefin performs **Endpoint Probing**. It attempts to call a characteristic endpoint of the server plugin. A successful response confirms the plugin is present.

### Adding a Server Probe

If your Litefin plugin depends on a new server plugin, register a probe in `src/plugins/ServerPluginClient.js`:

```javascript
const KNOWN_PROBES = {
    'my-server-plugin': {
        probeEndpoint: (itemId) => `/Items/${itemId}/MyPluginData`
    }
};
```

### Using Server Data in a Plugin

Once a `serverDependency` is declared, your plugin's `init()` will only be called if the server plugin is detected. You can then use the `api.serverPlugins` client:

```javascript
async onPlayerStart(item, api) {
    const data = await api.serverPlugins.call(`/Episode/${item.Id}/MyData`);
    // ...
}
```

## Security & Sandbox

Plugins are **sandboxed** via the `PluginAPI`.

- **DO NOT** import internal Litefin modules directly (e.g., `src/core/Router.js`).
- **DO** use `api.on()` (auto-unsubscribed), `api.showToast()`, `api.getStorage()`, `api.addOSDWidget()`, and `api.serverPlugins` for all operations.
- This ensures your plugin doesn't break if Litefin's internal directory structure changes.
