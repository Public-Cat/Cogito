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
- Playwright tests need `npm install` (devDeps: `playwright`, `socket.io-client`).
- Server session is dirty after each test; clean up with `lobby:reset` or `game:returnToLobby`.
- Tests connect to `http://192.168.1.32:3000` (dev server port 3000, not Docker port 3008).

## Game state machine
`LOBBY → SUBMITTING (15s) → REVEALING (10s) → (loop, round<2) → VOTING_SOON (5s) → VOTING (10s) → (3s delay) → SUBMITTING or ENDED`

Minimum **2 humans + 1 AI** to start. Voting starts round ≥ 2, then every round.

## Key files
| File | Role |
|---|---|
| `server/index.js` | Express app, Socket.IO init, static files, `/api/models`, `/api/rules` |
| `server/game/GameManager.js` | Singleton — `getOrCreateSession()`, `reset()`, `generatePlayerId()` |
| `server/game/GameSession.js` | State machine, submit/reveal phases, AI vote resolution, win conditions |
| `server/game/Player.js` | Player model (`isHuman`, `isEliminated`, `isDisconnected`, `messageHistory[]`, `model`) |
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
- **AI vote parsing**: Fuzzy case-insensitive `includes()` match against player names, sorted longest-first to avoid partial-name collisions.
- **Vote resolution**: AI-only. Majority eliminates; ties eliminate no one.
- **AI memory**: `messageHistory[]` per AI (system prompt + turn prompts + round transcripts of others' messages).
- **AI name generation**: Via `buildNamePrompt()`, retries on duplicates (up to 10 tries), fallback `AI-xxxx`.
- **Client rejoin**: lobby.js stores `cogito_myId` in localStorage, both pages emit `game:rejoin` on load. Either can win depending on page load order.
- **Dead code** (don't rely on): `GameSession.getAlivePlayers()` (identical to `getActivePlayers()`, unused). `Player.isActive` set but never read. `Player.lastMessageIndex` set but never read.
- **Disconnect handler** emits `host:assigned` to host even during in-game disconnect (handlers.js:197-201), but `GameSession.handleDisconnect()` never reassigns host outside lobby — this event is a harmless no-op mid-game.

## Socket events
**Client→Server**: `lobby:setName`, `lobby:start` (callback), `game:sendMessage`, `game:returnToLobby`, `lobby:reset`, `game:rejoin`

**Server→Client**: `lobby:state`, `host:assigned`, `game:state` (+ per-player `myId`, `submittedBy[]`, `activePlayerCount`), `game:newMessage` (batched at REVEALING start), `game:votingSoon`, `game:voteStart`, `game:voteResult`, `game:ended`, `error`

Full `game:state` emitted after every state transition. `game:ended.players` includes `model` for each AI.

**Reset distinction**: `lobby:reset` calls `gameManager.reset()` + broadcasts empty `lobby:state` to ALL connected sockets. `game:returnToLobby` does not broadcast — emits `lobby:state` with `isHost: true` only to the caller, making them the new host.

## Ollama
- Default URL configurable via `OLLAMA_BASE_URL`. Model list polled every 30s, cached. Timeouts: chat 30s, model list 5s.
- On failure, returns `"..."` — does not crash.

## Docker
- `node:20-alpine`, `npm ci --omit=dev`, service `cogito` binds `192.168.1.32:3008:3000`, custom bridge `cogito-net`, `cap_drop: ALL`, `no-new-privileges:true`, `restart: unless-stopped`.
- `.dockerignore` excludes `*.md` but preserves `!RULES.md` — `RULES.md` is included in the image to serve via `GET /api/rules`.

## Historical bugs (don't reintroduce)
| Bug | Fix |
|---|---|
| `updateUI()` hides `votingOverlay` on every `game:state` | Guard with `if (state.phase !== 'VOTING')` before hiding |
| `GameManager.reset()` orphaned session timers | `reset()` must call `session.clearTimers()` before nulling session |
| Lobby `disconnect` didn't broadcast to remaining players | Iterate remaining players and emit `lobby:state` per-player |
| `game:rejoin` only emitted to rejoining socket | Must call `session.emitGameState()` which sends to all players |
| Shared localStorage `myId` → multi-tab collision | Key is `cogito_myId`, emitted per-player via `game:state.myId` |
