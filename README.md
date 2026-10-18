# Original

A separate personal website for browsing the Kinopk catalog and opening its Alloha player. Uses Node.js 24 and native browser JavaScript; there are no runtime package dependencies.

**Current status: live player pages are connected through Kinopk’s public embed route. Automatic Original audio selection is not implemented. The full catalog is still unavailable through the server-side metadata connection.**

## Run

```sh
cd /workspace/randomstuff
npm ci --cache /workspace/.npm-cache --ignore-scripts
npm start
```

The server listens on port 3000. `PORT` and `HOST` can override its address. `npm run dev` restarts the server after edits. The start command respects the environment's configured HTTP/HTTPS proxies. No build step, API key, database, or subtitle service is required to run the app server.

## Open the playback version

```sh
npm run build
```

Open `dist/playback.html`. Paste a Kinopk movie URL and click **Open player**, or use **Try the movie you shared** to open title 258687. Choose **Alloha** in the embedded player selector if needed, choose **Original / Оригинальный** in the soundtrack menu, and press Play.

This file embeds the actual public page at `https://kinopk.web.app/embed/:id`. It needs Internet access but no application server, API key, or copied player token. It uses the source site's regular player controls; video is never downloaded or proxied through this project. The page does not claim video is playing just because its iframe loaded.

`dist/index.html` contains the full site layout and the same movie-link entry. Both generated files include styles, script, and icon. Their app navigation uses URL fragments. They do not call this project's metadata API; the full catalog is labeled disconnected. Opening a title explicitly loads the external live player page.

An HTML viewer, private-browsing mode, or strict browser privacy settings may block nested players or their storage. The page includes an ordinary link back to the title on Kinopk if embedding is unavailable. Do not disable browser security features to make it work.

## GitHub Pages

The user selected GitHub Pages in `DanielKalika/randomstuff`. The Pages branch is `gh-pages`, containing the built single-file pages and `.nojekyll`. Publish that branch from its root. The application source is on `codex/original-playback-site`; the existing `main` branch and its user files are preserved.

Use the public Pages HTTPS address in a normal browser tab to test the player. The chat visualization can block external iframe content even when the same site works on ordinary hosting. An iframe load event is not confirmation that the provider page or video is available.

`public/index.html` is the server's template and references companion files. Opening that template alone in a file viewer will not load the application correctly; use the standalone preview instead.

## Implemented

- Responsive catalog, movie/series filters, pagination, search, and watch pages.
- Server-side adapters for the same public metadata routes used by Kinopk: `/movies/navigator`, `/movies/search/`, `/movies/:id`, and `/players?kinopoisk=:id` on `https://api.kinobox.tv/api`.
- Movie-link entry supporting source `/movie/:id`, `/film/:id`, and `/embed/:id` URLs; it rejects other origins and never accepts arbitrary iframe addresses.
- Playback through the source's public embed page, with fullscreen permission, a reload control, and clear manual Alloha/Original instructions. The source player chooses its available providers.
- Optional title details load independently; a metadata failure does not prevent the live iframe from opening.
- Short-lived metadata caching; errors are not cached. Media streams are never fetched or proxied by this server.

The catalog is loaded from the source at runtime. There are no fictional catalog entries or tokenized provider URLs in the code. The example button uses only the movie ID from the link the user supplied. A successful health response at `/api/health` verifies this server only.

## Live evidence and remaining limitations

Inspected on October 18, 2026:

1. A real browser loaded the source's dedicated `/embed/258687` route inside a separate-origin page, which loaded the actual Alloha player. After selecting Original with the visible control, the video advanced to 9.30 seconds in this app and beyond five seconds in two standalone-page checks, with `paused=false` and `readyState=4`. This demonstrated media playback, rather than just an iframe or open port. Some source requests failed during earlier sessions; a controlled shared-browser check confirmed both versions returned the same provider URL and the app played successfully. The cause of the earlier failures is unconfirmed. Provider availability can still vary.
2. Direct server-side metadata requests still return HTTP 503 in this environment. The same source player metadata request succeeds when the source app runs normally in a browser. Its public embed route lets the playback page use that normal source flow without relying on our server-side metadata requests.
3. Reusing a raw tokenized Alloha URL from this site's origin previously returned 404. The implemented flow instead loads the source's actual public embed page. No source referrer or origin is fabricated.
4. The player's cross-origin messaging exposes playback controls, but no verified soundtrack setter. Original selection remains manual. Its per-title resume feature can remember a chosen translation after more than five seconds of playback, but does not provide a global preferred soundtrack across movies. No guessed audio parameter is shipped.

The remaining work for the original goal is restoring full catalog access and obtaining a supported way to select Original automatically. Publishing the current version does not add those missing capabilities. Not every title, browser, or provider has been tested.

Tokenized research URLs and downloaded provider scripts are not stored in this repository. No third-party source, credentials, media, or authentication workaround is included.

## Validation

```sh
npm test
npm run test:browser
```

Server tests exercise local upstream fixtures, normalization, request validation, caching and recovery, timeouts, and static-file safety. Browser tests cover catalog navigation, Unicode/punctuation search, pagination, history, source iframe insertion, metadata failure, URL validation, reload controls, honest audio status, standalone playback routing, and mobile keyboard use. They use explicitly labeled fixtures and block external media. Passing them does **not** establish live provider access or Original audio automation; the separate live check is described above.

Browser tests use `/usr/bin/chromium` in this cloud environment. On another machine, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an installed Chromium binary, or install Playwright's browser with `npx playwright install chromium`.

Each cloud task already has an isolated checkout. Continue in the existing checkout; do not create a Git worktree unless explicitly requested.
