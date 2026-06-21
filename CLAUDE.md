# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm install
OLLAMA_BASE_URL=http://localhost:11434 npm run dev   # node --watch server/index.js
npm start                                             # node server/index.js (no reload)

# Tests (server must be running; Ollama with qwen2.5:7b must be reachable)
node tests/e2e.mjs           # Lobby + one submit/reveal cycle
node tests/full-game.mjs     # Full game through voting + end
node tests/rejoin.mjs        # Player reconnection mid-game
node tests/disconnect.mjs    # Disconnect edge cases
node tests/ui-interactive.mjs  # Playwright: 2 humans + 1 AI (needs chromium)
node tests/ui-6p4ai.mjs        # Playwright: 6 humans + 4 AIs

# Model-comparison eval: scripts a human accusation, scores AI dynamism + rule-following
# Configurable via env: MODELS, AI_COUNT, TOPIC, EVAL_BASE, OLLAMA_URL, OUT_DIR (writes to ./tmp)
node tests/ai-eval.mjs

# Install Playwright browser binary before UI tests
npx playwright install chromium

# Production
docker compose up --build
```

Tests are plain Node scripts — no test framework. They exit `process.exit(0|1)`. Tests connect to `http://192.168.1.32:3000` (dev port 3000, not Docker port 3008). The host client must connect with `extraHeaders: { 'X-Cogito-Realm': 'lan' }` or no one can become host (see Security). After each test, reset server state with `lobby:reset` or `game:returnToLobby` — both now require a joined LAN-realm host. `tests/security.mjs` covers the access-control surface. Don't set `SESSION_CODE` in the test env (keeps the join gate bypassed). Don't run test scripts concurrently against one server — the single in-memory session leaves stale state.

## Architecture

**Cogito** is a real-time social deduction game: humans and LLMs share a chat room and try to identify each other. The server is stateful (one game at a time, all state in memory), with no database.

> Deeper references live in the repo: `AGENTS.md` (authoritative socket-event reference and current gotchas), `DEVELOPMENT.md` (full architecture/implementation spec), `RULES.md` (player-facing rules, served via `GET /api/rules`). Keep this file in sync with `AGENTS.md` when behavior changes.

### Backend (`server/`)

- **`index.js`** — Express app entry, Socket.IO init, serves static client files, exposes `GET /api/models` and `GET /api/rules`.
- **`game/GameManager.js`** — Singleton. Holds one `GameSession` instance (or `null`). Has `getOrCreateSession()`, `reset()`, `generatePlayerId()` (returns a random UUID — never a guessable sequential id). `reset()` must call `session.clearTimers()` before nulling the session.
- **`game/GameSession.js`** — The core state machine. Owns all game state. Never store game state in socket handlers. `assignHost()` only promotes **LAN-realm** humans (see Security). Ollama calls are bounded by a `promisePool` (max 4 in flight).
- **`game/Player.js`** — Player model. Key fields: `isHuman`, `isEliminated`, `isDisconnected`, `messageHistory[]`, `model`, `currentVote`, `realm` (`'lan'`|`'public'`), `rejoinToken` (per-player secret). Disconnected AIs remain active (generate messages, vote); disconnected humans are excluded from active players and cannot vote.
- **`game/topics.js`** — Array of ~15 discussion topics.
- **`ollama/OllamaClient.js`** — HTTP wrapper for Ollama `/api/chat` and `/api/tags`. Timeouts: 30s chat, 5s model list. On failure returns `"..."` — never crashes the game. Model list polled every 30s.
- **`ollama/prompts.js`** — All AI prompts. No prompt strings anywhere else.
- **`socket/handlers.js`** — All Socket.IO event handlers. Wrap every handler in try/catch, emit `error` back on failure.

### Game State Machine

```
LOBBY → SUBMITTING (15s) → REVEALING (10s) → [loop if round<2] → VOTING_SOON (5s) → VOTING (10s) → [3s delay] → SUBMITTING or ENDED
```

Minimum **2 humans + 1 AI** to start. Voting begins at round ≥ 2.

`emitToAll` and `emitToSocket` are set by the `lobby:start` handler *after* `session.startGame()` returns. `startSubmitPhase()` → `emitGameState()` requires them — crashes if unset.

### AI Behavior

- **Message generation**: All AIs run `generateAIMessage()` in parallel during SUBMITTING. Each AI gets `[...messageHistory, turnPrompt]` sent to Ollama; the turn prompt is not appended to history until after a successful reply. After all messages are revealed, each AI's history gets a single `user` transcript entry with other players' messages from that round.
- **Voting (combined AI + human Borda count)**: `collectAIRankings()` runs all AI rankings in parallel (`Promise.allSettled`, 10s timeout); each AI ranks all active players from most suspicious to least (position 0 = N-1 points, ..., last = 0). In parallel, each active, connected human casts one vote via `game:castVote` → `castHumanVote()`, counted as a full first-place pick (N-1 points), same weight as an AI's top choice. Self-votes and votes from eliminated/disconnected players are rejected. All points sum into one score; highest eliminated. No early-resolve — votes collected for the full 10s window, then `resolveRankings()`. Tiebreaker 1: ranked/voted highest (earliest) in more individual AI rankings or human votes. Tiebreaker 2: cumulative Borda history across all prior rounds. If still tied, no elimination.
- **Prompts**: `buildSystemPrompt`, `buildTurnPrompt`, `buildRankingPrompt`, `buildNamePrompt` — all in `prompts.js`.

### Frontend (`client/`)

Two HTML pages: `index.html` (lobby/join) and `game.html` (in-game). Vanilla JS ES Modules, no framework, no build step. Socket.IO client served from backend CDN (`/socket.io/socket.io.js`).

- **`lobby.js`** — Join panel, host config panel (topic selector, AI slots with model dropdowns), player list.
- **`game.js`** — Chat display, phase transitions, voting overlay (spectator), end screen. Messages animate character-by-character for all players except the sender. Client stores `cogito_myId` in localStorage; both pages emit `game:rejoin` on load.
- **`matrixRain.js`** — Shared canvas rain background (loaded on both pages).
- **`sfx.js`** — Programmatic Web Audio API sound effects: `playVote()`, `playEliminated()`, `playWin()`, `playLose()`.

CSS lives entirely in `client/css/matrix.css`. No external CSS frameworks.

### Socket Events

**Client → Server**: `lobby:setName` (`{ name, code }`), `lobby:start` (callback), `game:sendMessage`, `game:castVote` (`{ targetId }`), `game:returnToLobby`, `lobby:reset`, `game:rejoin` (`{ playerId, token }`)

**Server → Client**: `lobby:state` (+ per-recipient `myToken`), `host:assigned`, `game:state` (+ per-player `myId`, `myToken`, `submittedBy[]`, `activePlayerCount`), `game:newMessage`, `game:votingSoon`, `game:voteStart`, `game:voteProgress` (`{ votedCount, totalEligible }`, after each human vote), `game:voteResult`, `game:ended`, `error`

`game:state` is emitted after every state transition. `lobby:reset` broadcasts empty `lobby:state` to all sockets; `game:returnToLobby` emits only to the caller. **Both `lobby:reset` and `game:returnToLobby` require a LAN-realm host** (see Security). `myToken` is sent only to its owning socket — never broadcast.

### Security & Access Control

Designed for public hosting via **Cloudflare Tunnel → Caddy (HTTPS) → app** (no open firewall ports). Three layers:

- **Realm gating (host privileges).** Caddy serves two vhosts and stamps a trusted `X-Cogito-Realm` header (strip-then-set, so clients can't forge it): a public vhost (`origin` header `public`) for friends, and a LAN-only vhost (`lan`, e.g. `cogito.home.arpa`) for the host. `server/index.js` reads the header into `socket.data.realm` (defaults to `public` — fail safe). Only `lan` players can become host or call `lobby:reset` / `game:returnToLobby` (`requireLanHost()` in `handlers.js`). The app binds to `127.0.0.1` (`HOST` env) so the header is only trustworthy because nothing reaches it except Caddy.
- **Public join gate (who can play).** `SESSION_CODE` env: when set, public-realm joins must send a matching `code` in `lobby:setName`; LAN realm bypasses. Unset = no code required (keeps dev/tests working).
- **Identity / abuse.** Player ids are random UUIDs; each player gets a `rejoinToken` and `game:rejoin` must present `{ playerId, token }`. CORS restricted via `ALLOWED_ORIGINS`. `lobby:start` validates model names against the cached Ollama list, caps AI players at `MAX_AI_PLAYERS` (8), and sanitizes/length-caps `topic`. Per-socket rate limits on `lobby:setName`, `game:sendMessage`, `game:castVote`, `game:rejoin`.

Operator runbook + Caddy/Cloudflare/Docker configs live in `deploy/` (`DEPLOY.md`, `Caddyfile`, `cloudflared-config.yml`).

## Conventions

- **ES Modules** throughout (`"type": "module"`). Server files `.js`, test files `.mjs`.
- **No TypeScript**, no frontend build tools, no CSS frameworks, no database.
- Validation: names must match `/^[a-zA-Z0-9 ]{1,20}$/`, messages ≤ 500 chars; both are HTML-sanitized (`<>&"'` stripped) before broadcast.
- Every file has a one-line comment at the top. Functions longer than 10 lines or with non-obvious params get JSDoc.
- **Branching**: all features branch from `develop`, merge back to `develop`. Never touch `main`. Use `git worktree add -b <branch> ./worktrees/<branch> develop` for parallel work. Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`). Use `./tmp` for scratch files (gitignored).

## Known Bugs (Do Not Reintroduce)

| Bug | Fix |
|---|---|
| `updateUI()` hides `votingOverlay` on every `game:state` | Guard with `if (state.phase !== 'VOTING')` before hiding |
| `GameManager.reset()` orphaned session timers | `reset()` must call `session.clearTimers()` before nulling session |
| Lobby `disconnect` didn't broadcast to remaining players | Iterate remaining players and emit `lobby:state` per-player |
| `game:rejoin` only emitted to rejoining socket | Must call `session.emitGameState()` which sends to all players |
| Shared localStorage `myId` → multi-tab collision | Key is `cogito_myId`, emitted per-player via `game:state.myId` |
| Borda single-player ranking gave 0 points | Edge case: ranking only 1 player → give 1 point |
| Borda ties stalled games with even AI splits | Add cumulative Borda history as 3rd-level tiebreaker |
