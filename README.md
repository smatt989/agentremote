# Agent Remote

Claude Code and Codex run on your Mac. Drive them from your phone.

Agent Remote is a Mac app that keeps your coding agents running on your own machine, with your files, tools and logins, and lets you start, follow and answer them from your iPhone or another computer. Messages are end-to-end encrypted; there are no accounts and no analytics.

**Downloads:** https://smatt989.github.io/agentremote-site/

## How it works

1. **Install Agent Remote on your Mac** (macOS 13.5+). It runs Claude Code and Codex with the sign-ins you already have.
2. **Pair your iPhone or a laptop** by scanning a QR code. The devices agree on a key with X25519; every request, reply and file is encrypted with AES-256-GCM.
3. **Work from anywhere.** Start sessions, follow replies, send files, and answer questions and permission prompts. Run `pickup` in Terminal on the Mac to continue the same live session there.

```
iPhone / laptop  ⇄  relay (forwards ciphertext)  ⇄  your Mac — Claude Code, Codex, your files
```

The relay only routes encrypted packets. You can use the hosted one or [run your own](docs/relay-deployment.md). The full design and threat model are in [docs/architecture-and-security.md](docs/architecture-and-security.md).

**A paired device can direct agents with full access to your Mac.** Pair only your own devices; you can revoke any of them.

## Repository

| Path | What it is |
|---|---|
| `desktop/` | The Mac service (Node): sessions, providers, encryption, knowledge base |
| `macos/` | The Mac app (Swift): menu bar, setup, permissions, updater, terminal host |
| `ios/` | The iPhone app, also built for Mac Catalyst as Agent Remote Client |
| `relay/` | The relay service (Node), deployable anywhere that runs a container |
| `shared/` | Code shared by the service and relay (secure channel) |
| `website/` | The download page |
| `scripts/`, `docs/` | Build, test and release scripts; design notes |

## Build from source

Requirements: macOS, Node 24+, Xcode 26+.

```sh
npm ci
npm test                                   # service and relay tests
python3 scripts/build-mac-app.py --output-dir build/packages/mac --app-only
```

Open `ios/AgentRemote.xcodeproj` to build the iPhone app or the Mac Catalyst client; set your own bundle identifier and signing team. More detail, including running a local relay, is in [docs/development.md](docs/development.md).

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
