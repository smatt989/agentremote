# Session controls

The conversation menu on iPhone and Mac contains **Model, effort & usage**.

- Context usage is the last provider-reported context count, distinct from cumulative tokens and subscription/account quota. Missing counts, capacities and reset times are shown as unavailable.
- Native automatic compaction remains in the provider harness. Managed Claude launches explicitly use `--autocompact auto`. **Compact now** invokes Codex `thread/compact/start` or Claude `/compact` between turns.
- Confirmed terminal rate-limit failures show an in-app prompt. **Continue when it resets** schedules one continuation of unfinished work. The global **Always continue after usage resets** preference defaults off and applies to future pauses.
- Jobs persist on the Mac, which must remain running to retry. Codex account availability is checked again before retrying; an active native turn prevents retry. Claude waits for a reported reset or subsequent availability event. An unknown Claude reset with no new event remains pending; the UI says so.
- Native transient retries do not start a second job. Network/auth/context/budget failures are not classified as refreshing account limits. Cancelling, ending or manually sending supersedes the scheduled continuation. A restart during an in-flight attempt requires user review rather than replay.
- A rejected submission retains its prompt and attachment IDs. An interrupted accepted turn resumes with a continuation instruction, not a replay of tool calls.
- **Continue with Claude/Codex** creates a linked new session in the same working directory. It writes a local Markdown transcript plus file references and gives the target service a bounded recent excerpt and the transcript path. Original history is retained. This is a handoff, not conversion of native provider state. Stop active work before switching.
- Model and effort changes apply to subsequent turns. Codex choices and supported efforts come from the installed provider catalog. Claude accepts local aliases/IDs and CLI effort values; model-specific support is enforced by Claude. An idle managed Claude process restarts with the same session ID on the next send if its settings changed. External/shared Claude terminals continue to own their own controls.

APIs: `GET /sessions/:id/usage`, `GET /sessions/:id/models`; `POST /sessions/:id/configuration`, `/retry`, `/compact`, `/handoff`; `GET/POST /settings/session-preferences`. All require existing paired-device authentication and are allowed over the encrypted relay.

Protocol references: [Codex app server](https://learn.chatgpt.com/docs/app-server), installed `codex app-server generate-ts` schema, [Claude SDK messages](https://code.claude.com/docs/en/agent-sdk/typescript), and installed `claude --help`.

## Local rollout, September 9, 2026

110 backend/relay tests pass. iPhone simulator and signed device builds pass; Preview build 12 is installed on Matthew’s iPhone. The phone was locked when remote launch was attempted, so open Preview after unlocking. The active backend has the controls update; read-only usage, model catalog and preferences requests passed through the public encrypted relay. The Mac native update is built and placed for the next app launch; the current process was retained to preserve active work. These development changes have not been re-notarized or submitted to TestFlight.
