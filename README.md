# Echo Atlas

Echo Atlas is a local multiplayer geography game. Everyone in a room hears the same Freesound preview, clicks a precise location on a 3D Earth, and scores points according to geographic distance. Matches support 1–8 players and 1–10 rounds.

## Run locally

Requires Node.js 20.19+ (or 22.12+), npm, and a modern browser with WebGL.

```sh
npm install
```

Copy `.env.example` to `.env` and replace the placeholder with a [Freesound API key](https://freesound.org/apiv2/apply):

```text
FREESOUND_API_KEY=your_real_key
```

Then run:

```sh
npm run dev
```

Open **http://localhost:5173**. Vite serves the frontend on port 5173 and proxies API and Socket.IO traffic to the Node server on port 3001. Both bind to the local network. For another device on the same LAN, open `http://YOUR_COMPUTER_LAN_IP:5173`; allow the ports through the computer's firewall if needed. Browser requests use the page's origin, so other devices do not need to resolve `localhost` on the host computer.

Without a key, the menu and lobby still work, but starting real audio gameplay is disabled with a clear message. Restart the server and refresh the page after adding a key. There are no bundled demo recordings.

## Play a match

1. Enter a nickname and choose **Create a game**. Copy the five-character room code.
2. Open another browser window, private window, or LAN device. Enter another nickname, choose **Join a room**, and enter the code. Solo play also works.
3. The host selects the round count and **Casual** or **Curated**, then starts the match.
4. Wait for the remote preview to load. The server starts the official 30-second deadline when clients report audio ready. Browser autoplay may require pressing **Play**.
5. Drag or pinch to rotate Earth; scroll or pinch to zoom. Click land at the exact location you want and press **Confirm guess**. Ocean clicks do not count. Locked guesses cannot be changed.
6. When everyone confirms or the server deadline expires, all clients see the answer, player markers, distances, round points, and source attribution. Results advance automatically after about eight seconds; the host can advance sooner.
7. After the final leaderboard, the host can play again in the same room with scores reset.

The server calculates Haversine distance using Earth radius 6371 km and awards `round(100 × max(0, 1 − distanceKm / 3185.5))` points. Ties on the final board are sorted by name, then stable player ID.

## Sound discovery and review

The server searches the [current Freesound API v2 search endpoint](https://freesound.org/docs/api/resources_apiv2.html) with token authentication, geotag and duration filters, and metadata fields in one request. Discovery searches several field-recording themes and stores only metadata in `server/data/sounds.json` (ignored by Git). The pool is capped at 500 entries and refreshed at most once per ten minutes during automatic selection. A match preselects unique recordings and favors variety in countries and categories. If the pool is too small, starting the game reports the problem instead of inventing sounds.

The **Sound administration** link on the main menu opens a local development panel. It can search, filter, remotely preview, inspect a small location map, and approve, reject, or mark candidates provisional. It also shows pool counts by category, country, and status. Administration is disabled in production. Locally it is restricted to the host computer; set `ADMIN_TOKEN` to a long secret to authorize administration from another LAN device, then enter that token in the panel.

Casual mode allows plausible uploader geotags marked **provisional**. Curated mode uses only sounds manually marked **approved** in the admin panel. Approval is an editorial action; the software does not independently prove a recording's origin. Automatic discovery currently uses `recording_location` only. Music, dialogue, and broadcast origins can be represented in metadata but are not inferred from ambiguous recordings. Obvious title/location contradictions and unsuitable metadata are filtered, but uploader descriptions can still be wrong.

Country matching uses a local copy of Natural Earth 1:50m country polygons from `world-atlas` and a point-in-polygon check; coordinates are never assigned by broad longitude bands. A lighter Natural Earth 1:110m map draws the globe's country outlines. The 1:50m map can omit tiny islands or place coast-adjacent points outside land, so those recordings are excluded. Players are scored by the original coordinates, not country centers.

## Remote audio and licenses

Audio is played directly from Freesound's remote preview URL using the browser's audio element. No MP3, WAV, FLAC, or OGG is downloaded into the repository or written to the server's disk. Browser memory buffering is normal. The API key stays on the backend; it is not present in frontend assets.

The [Freesound API terms](https://freesound.org/help/tos_api/) do not clearly grant this application permission to relay previews through its own server, so Echo Atlas uses direct playback. **A determined local player can inspect the preview URL or sound ID and look up the answer before reveal.** Casual rooms are intended for friendly play; do not claim cheat resistance. The admin panel deliberately exposes full metadata to authorized local reviewers.

Automatic selection allows Creative Commons 0 and Attribution recordings. Reveal screens show the real title, uploader, license, and Freesound source link. Follow each recording's license and [Freesound attribution guidance](https://freesound.org/help/faq/) if you share or publish a game. Free Freesound API use is for noncommercial purposes under its API terms.

## Development and validation

```sh
npm run typecheck
npm run test
npm run build
npm run smoke:browser
npm run smoke:game
```

`npm run test` uses mocked Freesound responses plus a temporary two-client Socket.IO server with mock metadata. It never requests or saves audio. `npm run smoke:browser` expects `npm run dev` already running and uses the locally installed Chrome browser; set `CHROME_PATH` to another Chrome executable if needed. The browser smoke test creates a room and joins it from a second browser context. `npm run smoke:game` requires a prior `npm run build`; it launches a temporary server and drives a one-round browser match with preview responses mocked entirely in memory. On Windows, Vitest and Vite's config loader may need to run outside a restricted filesystem sandbox.

The project uses React, TypeScript, Vite, Three.js/react-globe.gl, Socket.IO, Express, and shared geographic and game types. The server owns rounds, deadlines, answers, score calculation, reconnection identity, and host migration. Rooms live in memory; restarting the server clears active matches. Browsers need network access to Freesound's preview CDN and WebGL support. Audio preview availability can change after discovery; coordinated replacement is attempted up to three times before the room returns to the lobby with an error.

`npm run build` produces a static frontend in `dist/` and a server bundle in `dist-server/`. `npm start` serves both locally on port 3001 with admin disabled. No deployment is configured. If you later host the frontend separately, set `VITE_SERVER_URL` when building the frontend and `CLIENT_ORIGIN` on the backend to that frontend origin. The backend still needs a reachable Socket.IO endpoint and the Freesound key.

**Live Freesound verification:** A valid API key was not available during development, so actual third-party discovery and preview playback still need to be checked with your key. The local socket match and metadata handling are covered by deterministic tests.
