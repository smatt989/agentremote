# Agent Remote download page

One static page (`index.html` + `home.css`) plus the privacy and support pages (`style.css`). No framework, remote fonts or analytics; the only script fetches the repository's star count from GitHub's public API, and the page works without it.

`config.json` holds the download URLs and repository link. Build into `build/website` with:

```sh
node website/build.mjs
```

Screenshots in `assets/screenshots` are real app screens with sample data (`screenshots/capture.py` regenerates them).
