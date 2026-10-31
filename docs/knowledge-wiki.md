# Knowledge wiki

The wiki maintains canonical subject articles across conversations. Article identity is stable and independent of extraction batches. New conversations update existing subjects; an editorial planner can create overviews, split focused subjects, merge overlapping articles, and redirect old links.

## Reading

On iPhone, open the **Knowledge** tab beside **Chats**. On Mac, choose **Knowledge wiki…** from Agent Remote's menu, or open **Agent Remote Knowledge** from Applications/Desktop.

The home page starts with subjects. Search finds articles by title, aliases, prose, and underlying evidence. Blue links in article prose open other articles in the same reader. Breadcrumbs lead to broader subjects; **Explore this topic** leads deeper; **See also** crosses subjects; **Linked from** shows incoming links. Contents jumps to sections. Mac provides back/forward and home controls; iPhone uses its navigation stack and home button. Sources are collapsed beneath the article. Long articles load completely, with revision checks to reject mixed versions.

Readers open with one lightweight call, `GET /knowledge/index`, which returns every article's ID, title, topic, kind, parent, pending flag, update time, and a short summary, but no prose or evidence. Prose and sources load only for the article being read (`GET /knowledge/page`, which app readers request with a larger `budget` so ordinary articles arrive in one call). Searching with a query still uses `GET /knowledge`, which ranks with full-text search and returns bounded previews. Reads reuse the current wiki projection; the evidence projection is rebuilt only when facts, hidden sources, or deleted sessions change on any connection (tracked by database triggers in `wiki_changes`), when a retained fact expires, or once per process start.

## Storage and maintenance

All data remains in the existing private SQLite state directory. The evidence itself is still the conversation/reference-backed `memory_facts` collection, including quotes, dates, and trust labels. Saving an assistant response is an importance signal, not verification.

- `wiki_evidence` projects retained evidence and its source identity.
- `wiki_claims` deduplicates identical normalized statements within their original scope, retaining independent source evidence. Semantic repetition is consolidated editorially. Explicit corrections may mark an older claim superseded; unresolved conflicts remain visible.
- `wiki_subjects` records stable IDs, human titles, aliases, scope descriptions, parent relationships, and redirects.
- `wiki_membership` maps claims to one or more focused articles. Parent overviews draw on child summaries rather than duplicating every detailed claim. Those summaries are explicitly labeled derived evidence, with article IDs and revisions; they are never treated as independent corroboration or written back into source facts.
- `wiki_articles` records published prose, revision, source signature, and pending work. `wiki_revisions` retains successful revisions. `wiki_planned` and `wiki_jobs` make planning incremental and resumable.

The background worker alternates conversation extraction with editorial jobs. Routing jobs place new claims into subjects; the editorial agents below maintain articles and structure. Structural validation rejects missing claim assignments, unknown evidence, invalid links, duplicate titles within a scope, hierarchy cycles, and cross-organization merges. A separate model review checks support, scope, uncertainty, and preservation of important prior coverage before a draft publishes. Model review is fallible; citations and original evidence remain essential.

Planning uses bounded evidence windows internally, but never creates pages based on window size. Large articles can be revised in multiple evidence windows while retaining their previous prose. Child articles publish before dependent overviews. Completed subject areas can publish while other areas are still being organized. Curators and the librarian replace the former monthly reset of all assignments. Claim routing uses `AGENT_REMOTE_WIKI_MODEL` (Claude default: `claude-sonnet-5-5`; the router itself still never merges across organizations, which is left to curators); the editorial roles use the models listed under Editorial agents below. Existing provider selection and Codex override remain supported. Editorial calls use low effort (curator and librarian: medium) and a bounded thinking budget, `AGENT_REMOTE_WIKI_THINKING_TOKENS` (default 4,096), without changing user-wide settings. Model calls use the configured provider, so this is local storage with provider-backed editing, not fully offline processing.

New evidence leaves the supported published article available while an update is pending. Evidence withdrawal invalidates dependent generated prose and revision history, including overviews that summarized withdrawn material; unrelated articles and revisions remain available. Original source deletion/forgetting semantics remain authoritative. Failed model calls keep evidence searchable and retry later. Repeated semantic rejection sends the specific review issues back to claim routing, with bounded repair attempts, so unrelated evidence can move to the appropriate article.

## Editorial agents and talk pages

Articles are maintained by agents that work bottom-up and top-down and coordinate through each article's **talk page**, a persistent record of proposals, decisions and their reasons (`wiki_talk`). Every talk thread has a kind, status (open, accepted, declined or recorded), the claims it concerns, an optional target article, and its posts.

- **Steward** (one article, `AGENT_REMOTE_WIKI_STEWARD_MODEL`, default `claude-sonnet-5-5`). Runs when the article's evidence changes, when someone posts on its talk page, and every two weeks as a freshness review. It decides *none* (nothing material changed: no revision is written), *edit* (replace, insert or delete specific sections; the rest stays verbatim) or *rewrite* (no prose yet, or the structure no longer fits). It also hands claims to the article they belong in, marks explicit corrections, requests verification, raises threads on other articles, and answers its own threads.
- **Curator** (one organization's subjects, `AGENT_REMOTE_WIKI_CURATOR_MODEL`, default `claude-opus-5-5`). Decides structural threads (merge, split, move, misplaced evidence) and reviews the area weekly when it changed: merges, moves, renames, new subjects and claim moves. It may merge, move or hand claims into another organization's subjects, because extraction sometimes misfiles content or invents pseudo-organizations (a top-level "firmware" or "analytics" area that belongs to one company). A merged article's prose goes to the surviving article's steward on a *merged* thread, so supported coverage carries over.
- **Librarian** (whole wiki, curator model, weekly). Finds duplicates (title heuristics plus judgment), misplaced or stuck articles and missing cross-links, and posts threads for curators. It proposes consolidating misfiled or pseudo-organization subjects into the organization they belong to, and cross-links for subjects genuinely about different organizations. It also re-checks verified evidence: when a verified file changes and no longer contains the quoted text, the verification is withdrawn and requested again.
- **Verifier** (one claim, `AGENT_REMOTE_WIKI_VERIFY_MODEL`, default `claude-sonnet-5-5`). Checks an assistant-reported or tool-derived claim against local files with read-only Read, Grep and Glob, confined to `AGENT_REMOTE_VERIFY_ROOTS` (colon-separated; default `~/development`). Code confirms the quoted excerpt is really in the file before anything is recorded. A claim confirmed by code or configuration gains evidence labelled *Verified against <file> on <date>* (trust 4); one contradicted by code is superseded by the corrected statement (user statements are never superseded this way; a conflict thread is raised instead). Markdown and text documents are often agent-written and can be stale, so a match there is recorded as *Consistent with documentation* (trust 2) and a contradiction there only raises a conflict thread. Set `AGENT_REMOTE_WIKI_VERIFY=0` to disable.
- **Reviewer** (`AGENT_REMOTE_WIKI_REVIEW_MODEL`, default `claude-sonnet-5-5`). Gates every steward revision. For an edit it judges only the changed sections; problems it notices elsewhere go on the talk page for a daily fix-up pass instead of blocking the edit.

Rules that keep this stable and keep true knowledge:

- **No silent removal.** A claim the previous revision cited must still be cited, superseded, handed off, or listed in *removals* with a reason. This is enforced in code; each removal is recorded on the talk page and the evidence stays in Sources.
- **Overviews update only for material changes.** A steward classifies its summary change as none, minor or material; only material changes bump the summary version that parent overviews depend on, so rewording a child no longer queues every ancestor.
- **Settled decisions stay settled.** Repeats of an open proposal join its thread. A declined proposal is not raised again until the evidence it concerns changes (a person's comment always can).
- **Evidence is weighed.** Each claim carries its best trust (4: user statement or file-verified; 2: tool output, reference note or saved response; 1: assistant report), newest date, age and number of independent sessions. Stewards treat the newest high-trust claim as current, date volatile facts, and keep caveats compact.
- **Backoff.** A steward whose revision keeps failing review backs off exponentially, up to a day; the reviewer's issues stay on the talk page for the next attempt.
- Expired progress notes and claims moved to another article lose their citations; the rest of the prose stays. Only forgetting or deleting a source invalidates dependent prose.

People and session agents take part too. In the Mac and iPhone readers, **Talk** shows an article's threads; a comment you post there becomes user-stated evidence on that article and calls its steward. Session agents can raise issues with the `knowledge_discuss` tool (at most 12 open threads per session).

Measure quality on a state copy with `node scripts/eval-wiki.mjs STATE_DIRECTORY [--questions QUESTIONS.json]`: churn, hedging per 1,000 words, silent claim drops between revisions, verified claims, duplicate candidates, talk activity, and question answering through the real MCP tools. Load the editors into a running service without a restart with `node scripts/hotload-wiki-editors.mjs <service pid>`.

## Migration and recovery

Legacy `topic~N` IDs resolve to `topic~1`, then follow any editorial redirects. Existing topic prose is combined into provisional canonical articles during automatic migration and replaced by reviewed revisions. Legacy generated batch files are removed; source conversation evidence is retained. New exports are `knowledge/<topic>/article.md` plus `knowledge/index.md`; files are generated views, not the editable database.

For a reviewable migration, make a consistent private SQLite backup into an isolated state directory and run:

```sh
node scripts/rebuild-wiki.mjs PRIVATE_STATE_DIRECTORY 350 3 work/acme,work/tools
```

The scope list is optional prioritization for a one-time rebuild, not a hardcoded topic taxonomy. Concurrency is capped at three; the normal app worker runs one job at a time. The command logs job IDs, timing, and outcomes, never evidence. Rejected model output is saved only inside the private state directory for diagnosis. A renewable maintenance lease defers the app’s normal editorial worker while this bulk command runs; normal conversation extraction continues. Cancellation aborts its own model processes. It does not extract or edit source conversations, change pairings, or modify provider sessions.

## Verification

Backend tests cover cross-session consolidation, large topics without batch pages, aliases and redirects, inline links and backlinks, corrections, incremental planning, rejected/stale plans, evidence withdrawal including overviews, revision consistency, and semantic review gating. Relay tests exercise authenticated encrypted phone access. `scripts/test-wiki-reader.py` exercises the production Mac model against a synthetic HTTP fixture, checks pagination and navigation, and renders a native preview without using private knowledge. `scripts/test-wiki-phone.py` exercises actual inline-link taps and back/home navigation in the iPhone simulator. `scripts/test-wiki-hotload.mjs` verifies session-preserving live loading with authentication and revision checks.
