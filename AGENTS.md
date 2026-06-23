# Cogito — Agent Guide

## Workflow
- **Never leave workspace root.** Use `./tmp` for temp files (already gitignored).
- **All features branch from `develop`** and merge back to `develop`. Never touch `main`.
- Use git worktrees for parallel features:
  `git worktree add -b <branch-name> ./worktrees/<branch-name> develop`
- `worktrees/` is in `.gitignore`.
- When finished, fetch/rebase, merge back to `develop`, delete branch.
- **Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`).

## Stack
- **ES Modules** (`"type": "module"`). App source `.js`, tests `.mjs`.
- Express + Socket.IO + `node-fetch` for Ollama. No TS, no DB, no ORM. All state in memory.

## Commands
| Command | What |
|---|---|
| `npm start` | `node server/index.js` |
| `npm run dev` | `node --watch server/index.js` |
| `node tests/e2e.mjs` | Core lobby + one submit/reveal cycle |
| `node tests/full-game.mjs` | Full game flow through voting + end |
| `node tests/rejoin.mjs` | Player reconnection mid-game |
| `node tests/disconnect.mjs` | Disconnect edge cases (lobby host, mid-game, AI asymmetry) |
| `node tests/ui-interactive.mjs` | Playwright UI test (2 humans + 1 AI) |
| `node tests/ui-6p4ai.mjs` | Playwright UI test (6 humans + 4 AIs) |
| `docker compose up --build` | Production build + run |

All tests are plain Node scripts (no framework), exit via `process.exit(0|1)`. No lint/typecheck/build scripts exist.

## Test prerequisites
- Server running at `PORT` (default `3000`).
- Ollama at `OLLAMA_BASE_URL` (default `http://192.168.1.30:11434`) with `qwen2.5:7b` pulled.
- `npm install` (devDeps: `playwright`, `socket.io-client`).
- Playwright UI tests also need `npx playwright install chromium` for browser binary.
- Server session is dirty after each test; clean up with `lobby:reset` or `game:returnToLobby`.
- Tests connect to `http://192.168.1.32:3000` (dev server port 3000, not Docker port 3008).

## Game state machine
`LOBBY → SUBMITTING (15s) → REVEALING (10s) → (loop, round<2) → VOTING_SOON (5s) → VOTING (20s) → (3s delay) → SUBMITTING or ENDED`

Minimum **2 humans + 1 AI** to start. Voting starts round ≥ 2, then every round.

## Key files
| File | Role |
|---|---|
| `server/index.js` | Express app, Socket.IO init, static files, `/api/models`, `/api/rules` |
| `server/game/GameManager.js` | Singleton — `getOrCreateSession()`, `reset()`, `generatePlayerId()` |
| `server/game/GameSession.js` | State machine, submit/reveal phases, combined AI+human vote resolution, win conditions |
| `server/game/Player.js` | Player model (`isHuman`, `isEliminated`, `isDisconnected`, `messageHistory[]`, `model`, `currentVote`) |
| `server/game/topics.js` | ~15 discussion topics |
| `server/ollama/prompts.js` | All AI prompts — never inline |
| `server/ollama/OllamaClient.js` | HTTP wrapper for Ollama `/api/chat` and `/api/tags` |
| `server/socket/handlers.js` | All Socket.IO event handlers |
| `client/js/lobby.js` | Lobby screen logic |
| `client/js/game.js` | In-game screen logic |
| `client/js/matrixRain.js` | Canvas rain background |
| `client/js/sfx.js` | Programmatic sound effects (Web Audio API) |

## Key conventions
- **Validation**: Names `/^[a-zA-Z0-9 ]{1,20}$/`, messages ≤500 chars, both HTML-sanitized (`<>&"'` stripped). All handlers wrapped in try/catch.
- **Game state** lives only in `GameSession.js` — never in socket handlers.
- **`emitToAll` / `emitToSocket`** must be set by `lobby:start` handler *before* calling `startGame()`. `startSubmitPhase()` → `emitGameState()` needs them. Crashes if unset.
- **AI disconnect asymmetry**: `getActiveAIs()` filters only by `isEliminated` — disconnected AIs still generate messages and vote. Only humans lose active status on disconnect (`getActivePlayers()` checks `isDisconnected`).
- **AI vote parsing**: Ranking responses split on `[,;\n]`, then fuzzy case-insensitive `includes()` match against player names (longest-first), deduplicated. Unparseable = empty ranking (zero points).
- **Vote resolution**: Combined AI+human Borda count. Each AI ranks all other players from most suspicious to least (points: first = N-1, ..., last = 0). Each active, non-disconnected human casts a single vote for one other player (self-votes rejected server-side) — counted as a full N-1 "first place" pick, same weight as an AI's top choice. All points sum into one score per player; highest total eliminated. Tiebreaker: among tied players, the one ranked/voted highest (earliest) in more individual AI rankings or human votes wins. 3rd-level: cumulative Borda history across all prior voting rounds breaks remaining ties. If still tied, no elimination. Disconnected humans don't vote (humans have no input device while offline, unlike autonomous AIs).
- **Human vote casting**: `game:castVote { targetId }` → `GameSession.castHumanVote(player, targetId)`. Rejects votes outside VOTING phase, from eliminated/disconnected players, self-votes, or invalid/eliminated targets. No early-resolve on full participation — votes are collected for the full 10s window like AI rankings, then resolved at the existing `voteTimeout`.
- **AI memory**: `messageHistory[]` per AI (system prompt + turn prompts + round transcripts of others' messages).
- **AI name generation**: Via `buildNamePrompt()`, retries on duplicates (up to 10 tries), fallback `AI-xxxx`.
- **Client rejoin**: lobby.js stores `cogito_myId` in localStorage, both pages emit `game:rejoin` on load. Either can win depending on page load order.
- **Disconnect handler** emits `host:assigned` to host even during in-game disconnect (handlers.js:197-201), but `GameSession.handleDisconnect()` never reassigns host outside lobby — this event is a harmless no-op mid-game.

## Socket events
**Client→Server**: `lobby:setName` (`{ name, code }`), `lobby:start` (callback), `game:sendMessage`, `game:castVote`, `game:returnToLobby`, `lobby:reset`, `game:rejoin` (`{ playerId, token }`)

**Server→Client**: `lobby:state` (+ per-recipient `myToken`), `host:assigned`, `game:state` (+ per-player `myId`, `myToken`, `submittedBy[]`, `activePlayerCount`), `game:newMessage` (batched at REVEALING start), `game:votingSoon`, `game:voteStart`, `game:voteProgress` (`votedCount`/`totalEligible`, after each human vote), `game:voteResult`, `game:ended`, `error`

Full `game:state` emitted after every state transition. `game:ended.players` includes `model` for each AI. `myToken` (the per-player `rejoinToken`) is sent ONLY to its owning socket — never broadcast or attached to other players' entries.

**Reset distinction**: `lobby:reset` calls `gameManager.reset()` + broadcasts empty `lobby:state` to ALL connected sockets. `game:returnToLobby` does not broadcast — emits `lobby:state` with `isHost: true` only to the caller. **Both now require a LAN-realm host** (`requireLanHost()`); a public-realm or non-host socket is rejected with `error`.

## Security / access control
Built for public hosting via **Cloudflare Tunnel → Caddy → app**. See `deploy/DEPLOY.md`, `deploy/Caddyfile`, `deploy/cloudflared-config.yml`.
- **Realm**: `server/index.js` sets `socket.data.realm` from the `X-Cogito-Realm` header (`'lan'` only if exactly `lan`, else `'public'` — fail safe). Caddy strip-then-sets this header per vhost; this repo doesn't run Caddy itself — `cogito` publishes no host port and is only reachable from the external `caddy-net` Docker network it joins (intended to hold just the operator's own Caddy container), which is what makes the header trustworthy. Only `lan` humans can become host (`assignHost()` filters by realm).
- **Join gate**: `SESSION_CODE` env — when set, public-realm `lobby:setName` must send a matching `code`; LAN bypasses; unset = no code (tests/dev keep working).
- **Identity**: `generatePlayerId()` = random UUID; per-player `rejoinToken`; `game:rejoin` verifies `{ playerId, token }`.
- **Limits**: CORS `ALLOWED_ORIGINS`; `lobby:start` validates models vs cached Ollama list (skipped if cache empty), caps AI at `MAX_AI_PLAYERS=8`, sanitizes/caps `topic` (≤120); `promisePool` caps Ollama concurrency at 4; per-socket rate limits on `lobby:setName`, `game:sendMessage`, `game:castVote`, `game:rejoin`.
- **Tests**: host client must connect with `extraHeaders: { 'X-Cogito-Realm': 'lan' }`; `tests/security.mjs` covers the access-control surface.

## Ollama
- Default URL configurable via `OLLAMA_BASE_URL`. Model list polled every 30s, cached. Timeouts: chat 30s, model list 5s.
- On failure, returns `"..."` — does not crash.

## Docker
- `node:20-alpine`, `npm ci --omit=dev`, runs as non-root (`USER node`). Service `cogito` publishes no host port; reachable only via the external `caddy-net` Docker network shared with the operator's own pre-existing Caddy instance (see `deploy/DEPLOY.md`) — `read_only: true` + `tmpfs: /tmp`, `cap_drop: ALL`, `no-new-privileges:true`, `restart: unless-stopped`.
- Env: `HOST=0.0.0.0` (listen on the container interface; isolation comes from having no published port and being on `caddy-net`, not from HOST), plus `SESSION_CODE`, `ALLOWED_ORIGINS`, `OLLAMA_BASE_URL`. Set real values before deploying (see `deploy/DEPLOY.md`).
- `.dockerignore` excludes `*.md` but preserves `!RULES.md` — `RULES.md` is included in the image to serve via `GET /api/rules`.

## Historical bugs (don't reintroduce)
| Bug | Fix |
|---|---|
| `updateUI()` hides `votingOverlay` on every `game:state` | Guard with `if (state.phase !== 'VOTING')` before hiding |
| `GameManager.reset()` orphaned session timers | `reset()` must call `session.clearTimers()` before nulling session |
| Lobby `disconnect` didn't broadcast to remaining players | Iterate remaining players and emit `lobby:state` per-player |
| `game:rejoin` only emitted to rejoining socket | Must call `session.emitGameState()` which sends to all players |
| Shared localStorage `myId` → multi-tab collision | Key is `cogito_myId`, emitted per-player via `game:state.myId` |
| Borda single-player ranking gave 0 points (N-1 where N=1) | Edge case: ranking only 1 player → give 1 point |
| Borda ties stalled games with even AI splits | Add cumulative Borda history as 3rd-level tiebreaker |
