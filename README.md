<h1 align="center">Litefin</h1>
<h3 align="center">A High-Performance, Native Jellyfin Client for Samsung Tizen and LG web-OS TVs</h3>

[![GitHub release (latest by date)](https://img.shields.io/github/v/release/MoazSalem/litefin?color=blue&label=version&style=flat-square)](https://github.com/MoazSalem/litefin/releases)
[![GitHub all releases](https://img.shields.io/github/downloads/MoazSalem/litefin/total?color=blue&style=flat-square)](https://github.com/MoazSalem/litefin/releases)
[![GitHub Repo stars](https://img.shields.io/github/stars/MoazSalem/litefin?color=blue&style=flat-square)](https://github.com/MoazSalem/litefin/stargazers)
[![GitHub license](https://img.shields.io/github/license/MoazSalem/litefin?color=blue&style=flat-square)](https://github.com/MoazSalem/litefin/blob/main/LICENSE)
[![GitHub issues](https://img.shields.io/github/issues/MoazSalem/litefin?color=blue&style=flat-square)](https://github.com/MoazSalem/litefin/issues)

![Litefin Banner](./Docs/Previews/banner.png)

Litefin is designed to provide a premium media browsing and playback experience, even on legacy hardware. It features a robust dual-backend player, advanced subtitle support, and a highly optimized UI engine.

## Documentation

Comprehensive documentation is available in the `Docs` directory:

- [**Overview**](./Docs/Overview.md): Project introduction and the 8x build strategy.
- [**Architecture**](./Docs/Architecture.md): Framework details (EventBus, FocusManager, Plugins).
- [**Playback**](./Docs/Playback.md): Tizen AVPlay, web-OS adapters, and Subtitle Manager.
- [**Features**](./Docs/Features.md): Categorized list of all implemented functionality.
- [**UI & UX**](./Docs/UI_UX.md): Design system, components, and animation principles.
- [**Screenshots**](./Docs/Screenshots.md): Visual previews of the application.
- [**Development**](./Docs/Development.md): Build pipeline, variants, and deployment guide.

## Quick Start (Development)

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Add your Tizen certificates to the .sign folder

# Build all packages
npm run package
```

## Quick Installation

For the easiest installation on Samsung Tizen TVs, it is recommended to use the **Jellyfin2Samsung** installer:

1. Download the latest `.wgt` from the releases or build it yourself.
2. Use [**Jellyfin2Samsung**](https://github.com/Jellyfin2Samsung/Samsung-Jellyfin-Installer) to sideload the application to your TV.

## Support

If Litefin is useful to you, please consider supporting the development:

- [**Sponsor this project on GitHub**](https://github.com/sponsors/MoazSalem)

## License

Litefin is subject to the terms of the **Mozilla Public License, v. 2.0**. See the [LICENSE](LICENSE) file for more details.
