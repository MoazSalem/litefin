<h1 align="center">Litefin</h1>
<h3 align="center">A High-Performance, Native Jellyfin Client for Samsung Tizen and LG web-OS TVs</h3>

[![GitHub release (latest by date)](https://img.shields.io/github/v/release/MoazSalem/litefin?color=blue&label=version&style=flat-square)](https://github.com/MoazSalem/litefin/releases)
[![GitHub all releases](https://img.shields.io/github/downloads/MoazSalem/litefin/total?color=blue&style=flat-square)](https://github.com/MoazSalem/litefin/releases)
[![GitHub Repo stars](https://img.shields.io/github/stars/MoazSalem/litefin?color=blue&style=flat-square)](https://github.com/MoazSalem/litefin/stargazers)
[![GitHub license](https://img.shields.io/github/license/MoazSalem/litefin?color=blue&style=flat-square)](https://github.com/MoazSalem/litefin/blob/release/LICENSE)
[![GitHub issues](https://img.shields.io/github/issues/MoazSalem/litefin?color=blue&style=flat-square)](https://github.com/MoazSalem/litefin/issues)
[![Discord Link](https://img.shields.io/discord/1498618592902647818?color=blue&label=discord&logo=discord&style=flat-square)](https://discord.gg/N3VpazBtTx)

![Litefin Banner](./Docs/Previews/banner.png)

Litefin is designed to provide a premium media browsing and playback experience, even on legacy hardware. It features a robust dual-backend player, advanced subtitle support, and a highly optimized UI engine.

## Documentation

Comprehensive documentation is available in the `Docs` directory:

- [**Overview**](./Docs/Overview.md): Project introduction and the 8x build strategy.
- [**Architecture**](./Docs/Architecture.md): Framework details (EventBus, FocusManager, Plugins).
- [**Plugins**](./Docs/Plugins.md): How the plugin system works and how to create them.
- [**Playback**](./Docs/Playback.md): Tizen AVPlay, web-OS adapters, and Subtitle Manager.
- [**Features**](./Docs/Features.md): Categorized list of all implemented functionality.
- [**UI & UX**](./Docs/UI_UX.md): Design system, components, and animation principles.
- [**Screenshots**](./Docs/Screenshots.md): Visual previews of the application.
- [**Development**](./Docs/Development.md): Build pipeline, variants, and deployment guide.
- [**Localization**](./Docs/Localization.md) A doc for translation contributions

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

### Samsung Tizen TVs

The easiest way to install on a Samsung TV is with the **Jellyfin2Samsung** installer:

1. Download the latest `.wgt` from the [Releases](https://github.com/MoazSalem/litefin/releases) page.
2. Use [**Jellyfin2Samsung**](https://github.com/Jellyfin2Samsung/Samsung-Jellyfin-Installer) to sideload the `.wgt` to your TV.

### LG web-OS TVs

Litefin can be installed on LG TVs using the **Homebrew Channel**:

1. Install the [**Homebrew Channel**](https://github.com/webosbrew/webos-homebrew-channel) on your LG TV by following the instructions in its repository.
2. Either install through the Homebrew Channel UI or Download the latest `.ipk` for your hardware from the [Releases](https://github.com/MoazSalem/litefin/releases) page.
3. Open the Homebrew Channel on your TV and use the **Package Manager** to sideload the `.ipk` file.

## Support

If Litefin is useful to you, please consider supporting the development:

- [**Sponsor this project on GitHub**](https://github.com/sponsors/MoazSalem)

<p>
  A massive thank you to the individuals supporting the development of <b>LiteFin</b>!
</p>

  <table border="0">
    <tr>
      <td align="center" width="120">
        <a href="https://github.com/meric426">
          <img src="https://github.com/meric426.png?s=100" width="80" alt="Martin Ericson" />
          <br />
          <b>Martin Ericson</b>
        </a>
      </td>
      <td align="center" width="120">
        <a href="https://github.com/DatAres37">
          <img src="https://github.com/DatAres37.png?s=100" width="80" alt="DatAres37" />
          <br />
          <b>DatAres37</b>
        </a>
      </td>
      <td align="center" width="120">
        <a href="https://github.com/danitesler">
          <img src="https://github.com/danitesler.png?s=100" width="80" alt="Dani Tesler" />
          <br />
          <b>Dani Tesler</b>
        </a>
      </td>
      <td align="center" width="120">
        <a href="https://github.com/witks">
          <img src="https://github.com/witks.png?s=100" width="80" alt="witks" />
          <br />
          <b>witek</b>
        </a>
      </td>
      </tr>
    
  </table>

## License

Litefin is subject to the terms of the **Mozilla Public License, v. 2.0**. See the [LICENSE](LICENSE) file for more details.
