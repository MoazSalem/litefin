---
name: Bug report
about: Create a report to help us improve Litefin
title: '[BUG] Bug title'
labels: bug
assignees: MoazSalem
---

**Priority**: (1-10)
From a scale of 1 to 10 (1 = minor annoyance, 10 = critical crash/unusable blocker), how urgently should this be addressed?

**Describe the bug**
A clear and concise description of what the bug is.

**Special Settings**
If you changed any settings, specially in playback tab, include them here [e.g. Force Direct playback, TrueHD/DTS passthrough], it recommended you backup your settings, and reset them to see if you can reproduce the issue with default settings. 

**To Reproduce**
Steps to reproduce the behavior:

1. Go to '...'
2. Select / Click on '....'
3. Scroll down / navigate to '....'
4. See error

**Expected behavior**
A clear and concise description of what you expected to happen.

**Client & Device Information (Mandatory)**

- **Platform**: [e.g. Android TV, Android Mobile, Fire OS, Samsung Tizen, LG webOS, Windows, Linux, macOS, Web Plugin (Jellyfin/Emby), Web Browser]
- **Device Model / Specs**: [e.g. Chromecast with Google TV 4K, Nvidia Shield Pro, Pixel 8, Samsung QN90A, LG C2, PC / Mac hardware]
- **OS / Firmware Version**: [e.g. Android 14, Tizen 6.5, webOS 7.0, Windows 11 23H2, Ubuntu 24.04, macOS 15.0]
- **Litefin Distribution / Package**: [e.g. Android APK, Tizen WGT, webOS IPK, Windows (.exe/.msi), Linux (.deb/.AppImage), macOS (.dmg), Jellyfin Web Plugin (.zip)]
- **Litefin Build Variant**: [e.g. Modern (Most builds are modern unless stated otherwise), Normal, Legacy, Ultra-Legacy, Desktop/Native]
- **Litefin Version**: [e.g. 2.0.0]

**Server Information**

- **Server Software**: [e.g. Jellyfin, Emby]
- **Server Version**: [e.g. 12.2.0, 10.10.x, Emby 4.8.x]
- **Server OS & Deployment**: [e.g. Docker (Linux), Windows, TrueNAS, Unraid]
- **Litefin Server Plugin**: [e.g. Installed v1.9.82, Not installed, N/A]

**Additional Context**
Add any other context about the problem here (e.g., container format, video/audio codecs like AV1/HEVC/TrueHD, transcode vs direct play, network setup, custom themes).

**Screenshots & Diagnostic Logs**
For **playback and rendering issues**, logs are critical:
Enable logging in Litefin **Settings > Debug**, restart the app, reproduce the bug, then return to **Settings > Debug** and select **Send to Server** (logs will show in your Jellyfin dashboard). Remember to disable logging afterwards.
