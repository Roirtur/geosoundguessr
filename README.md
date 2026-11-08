# Echo Atlas

Echo Atlas is a local multiplayer sound geography game. Everyone in a room hears the same remote recording, guesses its origin on a 3D Earth, and scores points by geographic distance. Matches support 1–8 players and 1–10 rounds.

## Run locally

Requires Node.js 20.19+ (or 22.12+), npm, and a browser with WebGL.

```sh
npm install
npm run dev
```

Open **http://localhost:5173**. No audio API key is required. Vite serves the frontend on port 5173 and proxies the API and Socket.IO to port 3001. For a second device on the same LAN, open `http://YOUR_COMPUTER_LAN_IP:5173`. Copy `.env.example` to `.env` only to customize settings. An optional `XENO_CANTO_API_KEY` enables Xeno-canto wildlife recordings; keep it on the server.

Create a room, share its five-character code, choose the number of rounds and press **Start listening**. The same sound is prepared for all players. The server starts a 30-second deadline after readiness; browsers may require a click on **Play**. Drag or pinch to rotate Earth, click land to place a precise guess, then confirm. During guessing, every connected player may vote for one broad hint. The server reveals it to everyone only after unanimous consent; it contains only a hemisphere and a wide latitude band. The server reveals the source, location, guesses and points after everyone confirms or time expires. Results advance after about eight seconds. The host can start another match in the same room.

## Audio providers and locations

- **Wikimedia Commons** supplies the initial playable set. The server fetches live file metadata for a small set of actual Commons recordings with file coordinates, then searches for more. File URLs are obtained from the [Commons MediaWiki API](https://commons.wikimedia.org/wiki/Commons:API/MediaWiki); no audio is bundled.
- **Openverse** supplies broader searches for nature, cities and culture through its [audio API](https://api.openverse.org/v1/). Results from Freesound are excluded in the API query and filtered again by source and URL. Openverse often lacks recording coordinates. Those sounds can be reviewed in Admin, but cannot enter a match without documented coordinates and location evidence.
- **Xeno-canto** is enabled only when `XENO_CANTO_API_KEY` is set. Its [API](https://xeno-canto.org/explore/api) supplies wildlife recordings and uploader coordinates. The key stays on the backend and is never part of the browser audio URL.

The initial Commons recordings have genuine Commons file coordinates and licenses. They are marked **provisional** because uploaded coordinates are not independent proof of recording origin. **Casual** mode permits these documented provisional locations. **Curated** mode requires an admin to approve each sound. Answers and source details stay on the server until reveal. During a round, clients receive only a temporary room-bound audio URL; the remote filename and title are not sent. This reduces casual metadata leaks, but cannot prevent a determined player from recognizing or fingerprinting the audio.

The server uses Natural Earth 1:50m country polygons to check coordinates against real land boundaries. It never assigns a country from a title or search term. Openverse recordings with only a place name stay out of gameplay until a reviewer enters supported coordinates. Source links, creator and license appear at reveal. Follow each recording's license terms, including attribution and share-alike where applicable.

## Sound administration

The **Sound administration** link on the menu is available in development. It searches all enabled providers, previews remote audio, shows coordinates and location evidence, and allows review. For a locationless result, save it as provisional first, then use **Save location** with coordinates, the appropriate origin type, and a specific source documenting that geographic origin. Approve only after reviewing that evidence. Discovery grows the metadata catalog automatically when a match needs more sounds. The catalog is stored in `server/data/sounds.json` (ignored by Git). Automatic entries are capped at 1,000 while admin-managed metadata is preserved. Discovery is refreshed at most once per ten minutes during automatic selection. Only metadata is stored; no audio file is downloaded or cached by the server.

Administration is disabled in production. In development it is limited to the local machine; set `ADMIN_TOKEN` to permit access from another LAN device, then enter the token in the panel. Old Freesound metadata in an existing catalog is preserved as `legacy-freesound` and excluded from gameplay. It can be inspected for migration to a live provider.

If remote audio fails during preparation or a round, the server replaces it for the whole room up to three times. If it has no replacement, the room returns to the lobby with an error. External availability and browser codec support can change, so a larger reviewed catalog improves reliability. The server streams selected audio through a temporary endpoint, supports HTTP byte ranges, and writes no audio bytes to disk. It rejects arbitrary requested URLs and private network targets.

## Development

```sh
npm run typecheck
npm run test
npm run build
npm run smoke:browser
npm run smoke:game
```

Tests mock provider responses and exercise the real Socket.IO multiplayer transport. `smoke:browser` expects `npm run dev` already running. `smoke:game` requires a prior build and uses a synthetic in-memory browser test response solely for transport testing, not as a game recording. Set `CHROME_PATH` if Chrome is elsewhere. The backend owns rooms, deadlines, answers and scoring; restarting it clears active rooms.

`npm run build` creates `dist/` and `dist-server/`; `npm start` serves both on port 3001 with Admin disabled. No deployment is configured. For separate static hosting later, set `VITE_SERVER_URL` when building and `CLIENT_ORIGIN` on the backend.
