# Run your own relay

The relay is a small Node service (`relay/src/server.mjs`) that forwards encrypted packets between your devices and your Mac. It has no database and cannot read conversations. The apps use a hosted relay by default; run your own if you prefer not to depend on it, or need higher limits.

## Deploy

Any host that runs a container and terminates TLS works (Railway, Fly.io, Render, a VPS behind Caddy or nginx).

1. Run `node scripts/prepare-relay.mjs`. It prints a `build/relay-deploy-*` directory containing only the relay code, `Dockerfile` and `package.json`.
2. Deploy that directory as a container. The relay listens on `0.0.0.0:$PORT` (default 8790) and expects TLS to terminate at the ingress. Use **one replica** (routing state is in memory) and disable sleeping.
3. Check `https://YOUR-RELAY/healthz` returns `{"ok":true,"protocol":1}`.
4. Point your Mac at it, then quit and reopen Agent Remote:

   ```sh
   "/Applications/Agent Remote.app/Contents/Resources/runtime/arm64/bin/node" \
     "/Applications/Agent Remote.app/Contents/Resources/service/desktop/src/admin.mjs" configure wss://YOUR-RELAY
   ```

   (Use `runtime/x64` on an Intel Mac, or `npm run configure -- wss://YOUR-RELAY` from a source checkout.)
5. Pair your devices again: each pairing records the relay it was made through.

## Limits

Set these environment variables to change the defaults:

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_MAX_CONNECTIONS` | 5000 | Open WebSocket connections across all Macs and devices |
| `RELAY_HOST_DAILY_BYTES` | 2000000000 | Bytes carried for one Mac (requests plus responses) per 24 hours; over it, requests get `relay_quota` |

Fixed limits: 64 requests in flight per Mac, 4 per device, 600 messages a minute per connection, and 120 new connections a minute per IP address.

## Local tests

```sh
npm test
xcrun swiftc -parse-as-library \
  ios/AgentRemote/RelayCrypto.swift \
  ios/AgentRemote/RelayTransport.swift \
  scripts/native-relay-smoke.swift -o build/native-relay-smoke
node scripts/test-native-relay.mjs
```

These tests require localhost sockets. They create isolated temporary state and fixture sessions, not agent prompts against the user’s real projects.

## Operation

- `/healthz` returns service liveness without revealing host inventory.
- Production logging includes startup/status only, not message payloads, QR codes, device credentials, or ciphertext bodies.
- A relay restart temporarily disconnects devices; Mac agents continue locally and reconnect. The phone reconnects on subsequent requests.
- There is no relay-side durable storage and no multi-replica routing yet.
- Many Macs can share one relay; each keeps its own identity, paired devices, data and providers.

## Push notifications through the relay (optional, not yet deployed)

The relay can send Apple Push alerts for Macs that have no APNs key of their own. It turns on only when all three variables are set on the Railway `relay` service:

| Variable | Value |
|---|---|
| `APNS_KEY_P8` | Full PEM text of the `AuthKey_<KEYID>.p8` file, including the `-----BEGIN PRIVATE KEY-----` lines. Multi-line values and `\n`-escaped single-line values both work. |
| `APNS_KEY_ID` | The 10-character key ID (from the file name). |
| `APNS_TEAM_ID` | `YA9PU25M2S` |
| `APNS_TOPICS` (optional) | Comma-separated allowed bundle IDs. Default `com.agentremote.iphone`. |

Deploy as usual (`node scripts/prepare-relay.mjs`, then `railway up --service relay --ci` from the generated directory); no new files or dependencies are needed. The startup log line ends `Push: enabled for com.agentremote.iphone.` (or `not configured`, or `Push disabled: …` when the key does not parse). `/healthz` and the protocol version are unchanged.

How it works:

- On registration the relay tells each Mac `capabilities:['push']` and the allowed topics. Older Macs ignore the extra fields. A Mac sends `{type:'push'}` only after seeing the capability, so new Macs keep working against a relay without the variables.
- A Mac with its own `push-config.json` still sends directly to Apple. Without one, it sends `{type:'push',id,token,environment,topic,alert:{kind,title,body},session,hostId}` and waits up to 20 s for `{type:'push-result',id,ok,status,reason}`.
- The relay checks every request: topic in `APNS_TOPICS`, a 64–200 character hex token, `kind` one of `reply`/`question`/`test`/`auth`, title ≤ 64 and body ≤ 180 characters, payload ≤ 2 KB. Each Mac may send 30 alerts a minute and 500 a day. The ES256 provider token is re-signed every 50 minutes, or straight away if Apple rejects it. One HTTP/2 connection per APNs environment is reused.
- Apple's status and reason are passed back. A 410 or `Unregistered`/`BadDeviceToken` makes the Mac delete that registration.
- The relay logs only failed deliveries, as the alert kind, the APNs status and the reason. It never logs device tokens or alert text. The alert text is the same generic text the Mac sends today.
