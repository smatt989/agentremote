# Desktop knowledge browser

Choose **Knowledge wiki…** in Agent Remote, or open **Agent Remote Knowledge** in `~/Applications` (also available through its Desktop shortcut). Agent Remote must be running on this Mac.

Start from a subject or search. Inline article links stay inside the wiki. Breadcrumbs, child topics, related articles, backlinks, contents, and back/forward controls support exploration. Sources and evidence are expandable. Refresh with Command-R. Both Mac entry points use the same reader and live API as iPhone.

Build the standalone app with `python3 scripts/build-knowledge-browser.py`; build the integrated reader with `python3 scripts/build-mac-app.py --app-only --output-dir build/wiki-mac`. The standalone app reads the private desktop token and service port from Application Support, and uses authenticated GET knowledge routes on loopback. No credentials are embedded in the app or URLs. Learned links cannot launch local files or external URL schemes.

See [Knowledge wiki](knowledge-wiki.md) for architecture, migration, and validation details.
