# Agent Remote branding

Mint #71E4BB on charcoal #142A28. A central hub connects three remote agents.

- AgentRemote-iOS.png: opaque 1024 px App Store icon; iOS applies its own corner mask.
- AgentRemote-macOS.png and AgentRemote.icns: rounded Mac app icon with transparent margins.
- AgentRemote-logo.png and agent-remote-mark.svg: transparent logo.
- agent-remote-wordmark.svg: logo with editable system-font wordmark.
- MenuBarTemplate*.png: 22-point template image at 1x, 2x and 3x; macOS adapts the tint.
- agent-remote-monochrome.svg: scalable single-color symbol.

Regenerate PNGs with `xcrun swift scripts/make-mac-icon.swift assets/branding --brand`.
Regenerate iOS with `xcrun swift scripts/make-mac-icon.swift ios/AgentRemote/Assets.xcassets/AppIcon.appiconset --ios`.
The Mac packaging script generates the iconset and copies the menu bar templates automatically.
