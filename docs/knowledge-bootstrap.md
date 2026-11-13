# Knowledge sources and first-run bootstrap

A new install has an empty wiki. This feature fills it from what is already on the Mac, lets the user choose what it learns from, and gives them an **About you** page to check. Code: `desktop/src/knowledge-bootstrap.mjs`, `desktop/src/chat-import.mjs`, `macos/AgentRemote/KnowledgeSetup.swift`, and `ProfileView` in `macos/KnowledgeBrowser/WikiView.swift`.

## Setup state

`settings['knowledge-setup']` holds `{done, at, excluded, instructions}`.

- **New install:** `done` is false. Chats started in Agent Remote are learned as before. Conversations that predate the install (`external: true`, found in `~/.claude/projects` or through Codex) wait until the user presses **Start learning** in the Mac app's *Build your knowledge base* step (menu bar → *Knowledge sources…*).
- **Existing install:** any install that already has learned notes is treated as set up on first start, with nothing excluded. Nothing changes for it except the new jobs below.
- **Excluded projects:** each entry is a folder path. A session is excluded when its working folder is that folder or below it. The home folder is the exception: excluding `~` covers chats run in `~` itself, not every project under it. Excluding a project deletes the notes learned from its sessions, its project overview and its instruction-file notes, and hides its raw messages from `memory_search`. The conversations themselves stay. Including it again relearns them.

Projects are the working folders of listed Claude and Codex sessions, grouped by git repository root. Folders inside `~/.claude`, `~/.codex` and system temp folders are not projects.

## Background jobs

The memory worker (`MemoryWorker.tick`) now:

1. **Loads one provider history per tick, newest first, chosen independently of extraction.** Before this, a history load happened only when every newer session had nothing to extract, so a busy Mac could leave old sessions unloaded indefinitely.
2. Once setup is done, runs **one bootstrap job per tick** before conversation extraction:
   - **Instruction files** (no model, every 10 minutes): `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, and `CLAUDE.md`, `AGENTS.md`, `CLAUDE.local.md` and `.claude/CLAUDE.md` in each included project. `@path.md` imports are followed two levels deep, inside the same folder tree. Symlinks are rejected. Each file is capped at 128 KB, with a 512 KB budget per scan. Files are stored as 1,200-character `reference` chunks under `references/instructions-*`, and the editors route them into subject articles. Changed files are re-imported and deleted files are dropped.
   - **Project overview** (one model call per project): reads the README (8 KB), build manifest (3 KB), instruction files (4 KB), the last 40 commit subjects, and the titles and opening requests of the 30 most recent conversations. It writes up to 14 cited notes. Each note's quote must appear in the named source, or it is rejected. Notes belong to a synthetic session `project:<hash>`, carry a trust label naming the file, and replace that project's previous overview. The pass is redone when the files or `HEAD` change, at most weekly. A failed pass retries after an hour.
   - **About you** (one model call): runs once the wiki has 5 written articles, then at most daily after 100 or more wiki changes, or when the user asks via *Rewrite this page*.
3. Learns imported chat exports like finished conversations, using the provider of the most recently used session.

All model calls use the existing worker settings (`claude-sonnet-5-5` by default) on the user's own plan.

## About you

The page is stored in `settings['knowledge-profile']`, not in the wiki tables. It is served as the pinned first entry of `GET /knowledge/index` and as `GET /knowledge/page?id=about-you~1`, so the iPhone and the Mac reader show it without app changes.

Each line belongs to one of four sections (Projects, Preferences, How you work, People and systems). It must link a wiki article or cite a user-stated note; lines with neither are dropped.

The Mac reader shows **Fix…** and **Not true** on each line. Either one becomes a user-stated comment on the line's first linked article (a talk thread plus `User stated` evidence), and the line updates immediately. A free-form addition, or a Talk comment on the page from the iPhone, becomes a user-stated note under `work/user-profile`. Corrections are listed as the page's Talk threads.

Routes: `GET /knowledge/profile`, `POST /knowledge/profile/correct {item?, text?, wrong?}`, `POST /knowledge/profile/refresh`.

## Chat exports

The user picks a ChatGPT or Claude.ai export zip, or the `conversations.json` inside it, in the Mac app.

- **Parsing:** done in a child Node process (`chat-import.mjs`), so a large export cannot stall the service.
  - ChatGPT conversations follow the shown branch from `current_node` to the root.
  - Claude.ai conversations use `chat_messages`.
  - Only user and assistant text is kept.
- **Preview:** lists the newest 50, 200 or 1,000 conversations, or all of them, each with an estimate of background model calls (about one per 20 KB of text).
- **Storage:** imported conversations become sessions with `provider: 'import'` and `internal: true`. They never appear in session lists, and their text is searchable immediately.
- **Removal:** removing an import deletes its conversations and everything learned from them. Re-importing the same export updates the conversations in place.

Routes (Mac desktop token only, since they read local paths): `GET/POST /knowledge/sources`, `POST /knowledge/imports/preview`, `POST /knowledge/imports`, `POST /knowledge/imports/remove`.

## Tests

`desktop/test/knowledge-bootstrap.test.mjs` covers:

- holding older chats until setup, and treating existing installs as set up
- exclusion and its effect on retrieval
- history loading behind busy sessions
- quote checking in the project pass
- instruction-file imports, symlinks and removal
- ChatGPT branch selection and Claude.ai parsing
- the hidden-import lifecycle
- profile validation and corrections
- the routes and the desktop-only guard
