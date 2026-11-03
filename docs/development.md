# Agent Remote — developer notes

Run Claude Code and Codex on your Mac, and direct them from your phone. The Mac does the work. The phone starts tasks, follows progress, answers the agent's questions and opens the files it makes. A local knowledge base learns from your conversations, so the next agent doesn't need everything explained again.

Website and downloads: https://smatt989.github.io/agentremote-site/ · Help: [support page](https://smatt989.github.io/agentremote-site/support.html)

## Quickstart

1. **Install the Mac app.** Download the DMG from the website, drag **Agent Remote** to Applications, and open it. It needs macOS 13.5 or later and lives in the menu bar.
2. **Connect an agent.** In the Agent Remote window, install or sign in to Claude Code or Codex. You need at least one. Existing sign-ins are reused.
3. **Get the companion app.** Use the iPhone app (public beta coming soon) or **Agent Remote Client** on a second Mac (macOS 14 or later, from the website's download section).
4. **Pair.** On the Mac, click **Show pairing code**. In the app, tap **Pair this iPhone → Scan QR code**, then **Pair Mac**. No VPN, port forwarding or server address is needed.
5. **Start a chat.** Tap the compose button, pick an agent and a folder, and send a task.

Keep the Mac awake, online and running Agent Remote. Quitting the app stops remote access and ends running agents.

## Things to try

- **Several tasks at once.** Start a second chat while the first is still working.
- **Files and pictures.** Attach photos or files from the phone. Files and charts an agent saves show up in the chat.
- **Pick up at your desk.** Click **Enable Terminal Access** on the Mac, then run `pickup` in a new Terminal tab to continue a phone chat there.
- **Knowledge.** The Knowledge tab collects what agents have learned about you and your work, with sources. Correct anything by saying so in a chat.
- **Your browser and screen.** Agents can use your signed-in Chrome or Safari tabs and take screenshots once macOS permissions are granted (see [Browser setup](#browser-setup)).

## Good to know

- **A paired phone is a key to your Mac.** Chats started from Agent Remote run with full access and no approval prompts. Pair only devices you trust.
- **The relay can't read your work.** Requests, replies and files are end-to-end encrypted between your paired devices.
- **Background learning uses your provider.** Building the knowledge base sends excerpts to your Claude or Codex account and counts toward its usage. See [memory behavior](docs/memory.md).

## For developers

See the [architecture diagram and security explanation](docs/architecture-and-security.md). 

## Implemented

- SwiftUI iPhone app with multiple paired Macs, session search, conversation history, expandable tool activity, and interrupt/end controls.
- Native Mac conversation window with shared history, activity, Markdown, question buttons/free text, new sessions, interrupt/end/delete and attachment downloads. Uses a private local credential; it does not add a phone pairing or put credentials in URLs.
- Local Codex App Server integration and Claude CLI streaming integration. New sessions request full access with no agent approval prompts, subject to provider/admin/macOS restrictions.
- Discovery of local Codex history and Claude CLI transcripts, including sessions created outside this app.
- One authenticated loopback WebSocket Codex app-server shared by Agent Remote and the original terminal UI. Terminal connection credentials are available only to the local Mac launcher, never through the phone relay.
- Upload photos and files, receive inline images and charts, and export artifacts through the iOS share sheet. Maximum transfer size: 20 MB per file.
- Tap the microphone to record, tap again to insert the transcript, then send. Read replies aloud individually or enable “Speak replies.” On-device recognition is preferred when supported.
- Persistent desktop history, resumable foreground polling, and durable message IDs to avoid duplicate submissions after a lost connection. The Mac continues working when the phone backgrounds.
- Scan a single-use, five-minute QR code to pair. The Mac and iPhone derive a device-specific key using X25519 and HKDF, then encrypt requests and files with AES-256-GCM before they reach the relay.
- The Mac opens an outbound WebSocket connection and reconnects automatically. The native phone client multiplexes encrypted requests over a persistent WebSocket. No router changes, VPN app, or server address entry on the phone.
- Per-device revocation, encryption keys and tokens in iOS Keychain, private Mac state with mode 0600, and a loopback-only desktop HTTP listener. The public relay only handles routing headers and ciphertext.
- Chrome/Safari tools using existing signed-in tabs, plus desktop screenshots through a local MCP server. macOS permissions must be granted before these can work.
- Local model selection through Codex’s Ollama/LM Studio providers; a suitable installed model and running local inference server are required. This route has not yet been exercised here.

## Session control: current limits

The requirement to control **every already-running session from any coding app** is not complete. Session formats and live-control protocols differ by provider.

| Session source | Current behavior |
| --- | --- |
| Codex started here | Create, send, stream, interrupt, end; verified with a real model response. |
| Codex launched through terminal integration | Real native terminal → phone API → same open terminal tested; shared history, context and response events. |
| Codex in another independent process | Discover/read history. Resume only when the provider permits acquiring the session; an existing writer can prevent control. |
| Claude started here | Create, send, stream, interrupt/end; verified with a real model response. |
| Saved Claude CLI conversation | Discover/read its transcript and resume with its session ID. |
| Claude running in another client | Display as external/live when reported by `claude agents --json`. Sending and stopping are blocked rather than silently forking. Claude’s documented `/remote-control` connects to its own clients; a universal custom-client attach protocol has not been established. |
| Claude desktop, cloud, arbitrary model apps | Not universally discovered or controlled. These require additional provider-specific adapters. |

**Model defaults:** tap the gear on the sessions screen to set Codex, Claude, and local model defaults for the selected Mac. These settings apply to future Agent Remote sessions from every paired phone. Blank cloud-model defaults inherit the Mac provider configuration. You can override the model when creating a session; existing sessions retain their model.

**End and delete:** swipe left on a session, long-press it, or open the conversation’s ••• menu. “End” interrupts work and releases managed activity while keeping conversation history. “Delete session” asks for confirmation, stops the session, and permanently deletes its saved conversation and Agent Remote attachments. Codex uses its native `thread/delete` API, which also deletes spawned descendant sessions. Claude removes the exact session transcript and its associated child-history directory. Project working files are kept. External live Claude sessions must first be stopped in their original client. Failed provider deletion is reported and local history is retained for retry; completed deletions are remembered so discovery and delayed events cannot restore them. A disconnected phone does not end a session. A Mac reboot/service crash can interrupt work; the prototype never automatically replays commands with an ambiguous outcome.

## Connect without Tailscale

The one-time **operator setup** is complete for this installation: the shared relay is hosted and its public address is bundled with the Mac service. Each person then starts the Mac service and scans its QR code from the phone. They do not need a hosting account, VPN account, router changes, or a relay address.

### Operator: deploy the relay once

The relay has a Dockerfile, Railway configuration, health check, connection heartbeat, host identity verification, and bounded pending queues. It stores no conversations, files, provider credentials, or encryption keys. It requires one always-running instance behind a TLS-terminating ingress that supports WebSockets.

```sh
npm ci
node scripts/prepare-relay.mjs
```

The command creates an isolated directory under `build/relay-deploy-*` containing only deployment files. Sign into Railway and create a **new** project/service from that directory; do not link to an existing production service. Deploy it with `railway up`, generate an HTTPS domain, and verify `/healthz` returns `{"ok":true,"protocol":1}`. See [deployment instructions](docs/relay-deployment.md).

After deployment, bundle the address once:

```sh
node scripts/set-relay-default.mjs wss://YOUR-RELAY-DOMAIN
```

This writes `desktop/relay-default.json`, which contains a public address, not a credential. New Mac installs use it automatically. Existing local configuration can be overridden with `npm run configure -- wss://YOUR-RELAY-DOMAIN`.

### Install the Mac app from a DMG

The notarized installer is published at https://github.com/smatt989/agentremote-site/releases (see the latest release) and linked from https://smatt989.github.io/agentremote-site/. It is a native menu-bar app with both Apple Silicon and Intel Node runtimes and all service dependencies. Requires macOS 13.5 or newer. No Node, npm, Homebrew, Xcode, or relay setup is needed on the receiving Mac.

1. Open the DMG and drag **Agent Remote** to **Applications**.
2. Open the app. It is signed with a Developer ID and notarized by Apple.
3. Use the app’s Codex/Claude setup buttons if those command-line clients are missing or need sign-in. The app runs the official installer and launches browser sign-in. A Manual setup option opens Terminal if needed. The service uses that Mac’s existing accounts and files.
4. Click **Show pairing code**. In the iPhone app, tap **Pair this iPhone → Scan QR code** (or **Pair another Mac** in the gear menu), then **Pair Mac**. For a laptop, use the phone's gear menu → **Add a device… → Send link** and AirDrop it to the laptop (or **Copy pairing link** in the Mac app); the link opens in Agent Remote Client, then **Pair Mac**.
5. Enable **Start at login** if desired; approve the Login Items entry if prompted.

Closing the setup window keeps the menu-bar app and service running. Quitting stops remote access and may interrupt managed work. To update, quit, replace the app in Applications, then reopen it. State and pairing stay in the user’s Application Support folder. Disable Start at login before removing the app.

The app recognizes the earlier Terminal-installed login service without interrupting it. Its **Use this app to manage the service** button switches over after checking for active managed sessions and keeps a backup of the older launch definition. The iPhone app is still installed separately.

Build a fresh DMG on a development Mac:

```sh
python3 scripts/build-mac-app.py
```

The script fetches pinned official Node.js distributions, checks their published SHA-256 hashes, installs production dependencies into an allowlisted bundle, compiles a universal native app, applies local ad-hoc integrity signatures (no Apple account), and creates the DMG. The runtime’s Node license and dependency licenses are included. No private state, provider credentials, QR invitations, or development databases are packaged.

### On each Mac (Terminal setup)

Requires Node 24+, signed-in Codex/Claude CLIs, and the shared relay address bundled by the operator:

```sh
cd ~/Projects/AgentRemote
npm ci
npm start
```

In another terminal:

```sh
npm run pair
```

Open the local HTML file printed by that command, or double-click **Pair iPhone.command** in the project folder to generate and open it in one step. In the iPhone app, choose **Pair this iPhone → Scan QR code**, scan the Mac’s code, and tap **Pair Mac**. The app confirms the Mac’s name before pairing. A **Paste pairing code** alternative is available with `node desktop/src/admin.mjs pair-code` for testing or a phone without camera access. Treat an unused code as a short-lived invitation to control the Mac.

After pairing, the Mac appears whenever it is awake and online. Provider credentials stay on the Mac. The relay is used for text, operations, images, and other files. Disconnecting or backgrounding the phone does not stop the agents.

Device revocation:

```sh
npm run devices
node desktop/src/admin.mjs revoke DEVICE_ID
```

The service stores data in `~/Library/Application Support/AgentRemote/`. `AGENT_REMOTE_STATE` selects another state directory; `AGENT_REMOTE_PORT` changes its loopback port; `AGENT_REMOTE_RELAY` overrides the relay URL. `AGENT_REMOTE_CODEX` and `AGENT_REMOTE_CLAUDE` select CLI executable paths. Old direct connections remain readable for migration, but the new pairing screen uses the encrypted relay.

### Start after login

```sh
node scripts/install-service.mjs
```

This writes a LaunchAgent plist and prints the exact `launchctl bootstrap` command. Run that command after stopping any foreground `npm start` instance. It is a per-user login agent so it can use that user’s keychain, browser, and files. It cannot control the browser before the user logs in or while the Mac is asleep. The relay address is read from bundled/persisted configuration. The generated plist does not capture shell-specific provider environment variables.

### Local relay development

```sh
npm run relay
npm run configure -- ws://127.0.0.1:8790
npm start
npm run pair
```

Plain `ws://` is accepted only for localhost. This mode works from a simulator on the same Mac, not a physical iPhone on another network. The public deployment uses `wss://` and validates its normal TLS certificate.

### Browser setup

The local `agent_remote_mac` MCP server offers:

- `browser_tabs`: list existing Chrome/Safari tabs.
- `browser_navigate`: navigate a specified existing tab.
- `browser_javascript`: read or interact with its page DOM.
- `desktop_screenshot`: produce a PNG in the session’s artifact directory.

The first actual browser operation may trigger a macOS Automation prompt. Screenshot access requires Screen Recording permission. JavaScript requires the browser’s “Allow JavaScript from Apple Events” setting (Safari: Developer settings; Chrome: View → Developer). These tools are registered for new managed sessions; their GUI operations have not yet been tested on this Mac. Existing provider tools and project configuration are also loaded through the local CLI.

## Build the iPhone app

Open `ios/AgentRemote.xcodeproj` in Xcode. Choose the AgentRemote target, set a unique bundle identifier and your signing team, connect the iPhone, and run. Physical-device installation and TestFlight distribution require your Apple signing setup. 

Use Xcode 26 or later.

```sh
env DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild -quiet -project ios/AgentRemote.xcodeproj \
  -scheme AgentRemote -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -configuration Debug -derivedDataPath build/xcode164 \
  CODE_SIGNING_ALLOWED=NO build
```

The project generator is optional: `python3 scripts/generate-xcode-project.py`. Regenerating resets project build/signing settings, so use it before making local signing customizations.

## Validation

On a fresh Mac checkout, install Node 24+ and Xcode Command Line Tools, then run
`npm ci`. `npm test` builds the native terminal helper from source before running
the tests; compiled binaries and local runtime state are excluded from Git.

```sh
npm test
node scripts/smoke-session-lifecycle.mjs codex
node scripts/smoke-session-lifecycle.mjs claude
node scripts/probe.mjs
node scripts/smoke-codex.mjs
node scripts/smoke-codex.mjs claude
```

`probe.mjs` only reads provider history and prints counts. The smoke checks each create a separate temporary project/session and make one small real model request using the Mac’s existing sign-in. The lifecycle checks verify end and permanent deletion on only the disposable sessions they create. The other provider smoke checks leave provider-native test history. Tests cover pairing, expiry/revocation, duplicate messages, history pagination, artifact isolation, authenticated HTTP transfers, stream aggregation, and refusing unsupported external-live control.

The app was built, installed, and launched on an iPhone 16 Pro simulator running iOS 18.6. See [the captured native screen](docs/iphone-welcome.png). The native Swift transport was also tested against the Node relay: QR-data pairing, X25519/HKDF agreement, encrypted API calls, duplicate-message suppression, and a 512 KB artifact upload/download all passed. Public WSS hosting and a native encrypted transfer through it are verified. Physical QR scanning/microphone behavior, cellular reconnect, browser operations, image understanding, and local model execution still need device/integration tests. See [the encrypted transport protocol](docs/relay-protocol.md).

## Before team release

1. Resolve live external-session control per provider and validate session ownership. Keep the UI honest about read-only/resumable/controllable states.
2. Background notifications: the Mac sends APNs alerts for completed replies and for questions that need an answer once the developer's APNs key is configured (`scripts/configure-push.py`) and a push-enabled iPhone build (TestFlight) is installed; see docs/reply-notifications.md. Without that setup the app catches up on foregrounding. Background audio is declared only for actual spoken playback.
3. Persist phone drafts and pending request IDs across app termination, and add explicit recovery UI for interrupted/ambiguous submissions. Current retry deduplication survives network failure in the active conversation; a killed app loses its pending ID.
4. Add incremental transcript indexing and complete provider-native history pagination. Claude currently reads the last 2 MB per transcript; Codex imports up to 100 recent turns when paginated. The app can page history already imported into its local service.
5. Add device-management UI, install packaging, artifact retention, app icons, accessibility/device QA, and provider version compatibility checks. QR pairing is implemented.
6. Each teammate runs their own Mac service and pairs their own phone. A paired device has full access to that Mac’s exposed sessions; this prototype is not a shared multi-user server with per-project access controls.

## Version notes

The [knowledge wiki](docs/knowledge-wiki.md) now maintains canonical subject articles across conversations, with inline links, overviews, breadcrumbs, and source evidence in the Mac and iPhone readers.

See the [current architecture diagram and security explanation](docs/architecture-and-security.md) for the Mac 0.6.7 / iPhone 0.4.4 design, including shared Claude terminals without Channels, automatic local memory, and the trust boundaries of phone access. The version notes below include earlier milestones.

Mac version **0.5** adds the normal **Codex terminal → phone → same terminal** workflow. On this Mac, open a new Terminal tab and run `codex` normally. On another Mac, click **Enable Codex in Terminal** once in Agent Remote first. The real terminal UI and phone connect to one authenticated local Codex server; no need to use the Mac conversation window. Existing independent sessions are unchanged. `command codex` bypasses integration. Noninteractive invocations and maintenance commands keep using the original CLI directly.

Claude terminal Channels were tested but the current organization reports **Channels are not enabled for your org**. An organization owner/admin must enable Channels before that integration can be completed. Claude is not wrapped or changed in this release.

Mac version 0.4 added a native **Conversations…** window in the menu bar and Setup window; version 0.8.2 replaced it with **Open Agent Remote Client…**, so chats on the host Mac use the same client as other Macs. Start or resume a conversation there, open the same conversation on your paired phone, and continue on either device. Both interfaces use one running agent and one history; closing the Mac window leaves work running. Existing iPhone version 0.3.1 is compatible. Sessions still owned by an independent terminal must be closed there once before resuming in Agent Remote. This does not provide universal takeover of arbitrary live clients.

Version 0.3.1 improves conversation Markdown, native Claude question cards, activity indicators and jump-to-latest scrolling. Independently launched live Claude clients remain read-only; exit that client before resuming the same history here.

Version 0.3 adds automatic local memory and in-chat clarification choices. Start talking normally; no context selection or explicit remembering is needed. Memory stays on the Mac, while selected excerpts are processed through the existing model provider. See [memory behavior, storage, and limitations](docs/memory.md).

A native iPhone client and a Mac service for working with local coding agents. Connections now go through an **end-to-end encrypted relay**, with QR pairing and no VPN requirement. This is a working **development prototype**, not a finished team release.

**Deployment status:** the relay is live at `wss://relay-production-077c.up.railway.app`. The exact native Swift client passed encrypted pairing, API, retry, and 512 KB file-transfer tests through this public endpoint. The native Mac wrapper owns the running service and reports `Relay: connected`; the old LaunchAgent remains disabled. Real-provider Mac → phone → Mac API tests passed for Codex and Claude; manual device interaction checks remain useful.

## References

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Claude session management](https://code.claude.com/docs/en/sessions)
- [Claude Remote Control](https://code.claude.com/docs/en/remote-control)
- [Apple CryptoKit](https://developer.apple.com/documentation/cryptokit)
- [Node crypto](https://nodejs.org/api/crypto.html)
- [Railway public networking](https://docs.railway.com/networking/public-networking)
- [Apple background execution](https://developer.apple.com/documentation/xcode/configuring-background-execution-modes)
- [Safari developer settings](https://developer.apple.com/documentation/safari-developer-tools/developer-settings)

### Shared Claude terminals (Mac 0.6 / iPhone 0.4)

In the Mac setup window, choose **Enable Terminal Access** once, then open a new
Terminal tab and type `claude` normally. The original Claude CLI runs inside a
Mac-owned pseudo-terminal, preserving its working directory, shell environment,
model, project settings, permissions, slash commands and native compaction. No
Channels configuration is needed. Codex retains its structured shared-server path.

On iPhone 0.4.3+ with Mac 0.6.2+, open the conversation and use the normal
message box and **Send**. Either device can type into the same Claude process;
there is no input-control handoff. The Mac validates that the native input is
blank, then keeps the phone's paste and Enter together. Desktop keystrokes arriving
during that short operation follow it. A desktop draft or changed input causes the
phone send to be rejected instead of mixing the two messages. Network retries
reuse one request ID so a message is not submitted twice.

Native Claude questions (AskUserQuestion) in a shared terminal appear as question
cards on the phone and Mac (Mac 0.7.1+). Answering a card drives the terminal
dialog for you: Agent Remote presses the numbered option, toggles multi-select
choices, types free text into the dialog's own text field, and confirms the
review step, verifying each step on the rendered screen before the next key. If
the screen no longer shows that question, the answer is refused and the card stays
until the transcript records the outcome. For native approvals or unfinished
desktop input, choose **Terminal controls** from the conversation menu. The optional terminal has arrow, Space,
Tab, Escape, Type and Enter controls. The shared terminal follows the desktop window dimensions; scroll
horizontally or rotate the phone to see more (iPhone 0.4.5+). You can continue typing directly
on the Mac at any time; no Ctrl-] or Take control button is needed.

Conversations sort by the latest completed sent or received text message. Status
polls and streaming chunks do not move them around. The phone follows incoming
replies while at the bottom; scrolling up pauses that behavior. The jump-to-bottom
button appears only while away from the bottom.

Closing the phone view or the Mac Terminal tab detaches; Claude keeps running while
Agent Remote runs. Reattach from Terminal with `claude --resume FULL-SESSION-UUID`.
The UUID is the part after `claude:` in the session ID (also visible in native Claude
session information).

To continue any conversation in Terminal (Mac 0.7.6+), run `pickup`. It lists recent
Agent Remote conversations in phone order, Claude and Codex. Choose one by number or
search words, e.g. `pickup clog`; a single match opens directly. `claude --resume`
(or `-r`) without a full ID uses the same picker for Claude conversations from any
directory. The launcher switches to the conversation's own directory, since Claude
only finds a transcript from there. A phone conversation keeps its Claude process
between turns; Terminal stops that idle process and takes over the same history, or
asks you to wait while it is still replying. Afterwards the conversation is a shared
terminal: keep typing on either device. A newly enabled terminal integration gets the
command automatically; an existing one is refreshed when the app starts. End stops the process but retains history; Delete additionally
removes the transcript, local memory and terminal buffer. Quitting Agent Remote
stops its hosted processes. Relaunching does not resurrect a stopped process.

Existing independent Claude processes need a one-time exit and resume through the
launcher. Interactive resume pickers, named resumes, `--continue`, and fork flags
are not supported by this launcher yet; use an explicit UUID, or `command claude`
to bypass it. Noninteractive/maintenance commands bypass the launcher. There is no
attempt to send keystrokes into arbitrary existing Terminal windows.

Local memory tools and hidden instructions are added at startup; conversation
history remains eligible for automatic local memory learning. Native Claude asks
clarifications in its own terminal; the same question is shown as an answerable card
(see above). Claude's other prompts — folder trust after a restart, permission and
confirmation dialogs — also become tap-to-answer cards with only their own options. If a
shared terminal's Claude login expires, the chat shows the sign-in card; after signing in, the
idle terminal is ended so the chat continues in Agent Remote with the new login. Voice prompts work through the ordinary chat composer. File/photo submission is
not available for shared terminals yet; existing Agent Remote chat sessions retain it.

Terminal bytes use the existing authenticated, encrypted relay. A generation-based
input owner prevents stale/queued input from the other device; each input has an ID
for duplicate suppression. Terminal startup is local-desktop-only. The bundled
xterm.js emulator handles screen updates and reconnect snapshots locally, without
a CDN or remote webpage. A universal native PTY helper is included in the DMG;
Python, tmux, Channels and additional software installation are not required.
