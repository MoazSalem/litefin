# Architecture

Litefin is structured as a modular Web Application. The architecture is designed to handle complex navigation, focus states, and media playback asynchronously.

## Core Framework

- **EventBus**: A centralized messaging system for app-wide communication, allowing decoupled modules to react to state changes (e.g., authentication, playback updates).
- **StateManager**: Manages persistent and session-based application state, including server connections, user preferences, and in-memory caching.
- **Router**: A unified navigation system supporting client-side routing, history stacks, and robust state restoration when navigating between pages.

## UI Engine

- **FocusManager**: A critical component for TV environments. It handles D-Pad navigation, manages section memory to remember previous focus positions, and integrates deeply with virtualized lists.
- **VirtualGrid & VirtualList**: High-performance UI components that implement DOM recycling. This is essential for smooth scrolling through large media libraries on hardware with limited memory.

## Platforms

The application utilizes an abstraction layer to handle platform-specific APIs:
- **TizenAdapter**: Interfaces with Tizen WebAPIs for remote control handling, lifecycle management, and hardware playback.
- **webOSAdapter**: Similar abstraction for LG web-OS hardware.

## Plugin System

Litefin supports modular extensions to enhance the core experience:
- **Intro Skipper**: Integrates with server-side metadata to provide skip buttons for intros and recaps.
- **SyncPlay**: Implements real-time synchronized playback between multiple clients via WebSockets.

## Localization

The **Translation Manager** handles multi-language support, including dynamic key mapping from Jellyfin Web and full support for Right-to-Left (RTL) layouts.
