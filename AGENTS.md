# Cogito — Agent Guide

## Workflow
- **Never leave workspace root.** Use `./tmp` for temp files (already gitignored).
- **All features branch from `develop`** and merge back to `develop`. Never touch `main`.
- Use git worktrees for parallel features:
  `git worktree add -b <branch-name> ./worktrees/<branch-name> develop`
- `worktrees/` is in `.gitignore` — created and managed by agents.
- **When finished, merge back to `develop` and delete the branch.** Fetch/rebase first.
- **Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`).

## Stack
- **Runtime**: Node.js v20+, ES Modules (`"type": "module"`). App source uses `.js`; test scripts use `.mjs`.
- **Backend**: Express + Socket.IO. No other framework.
- **Frontend**: Vanilla HTML/CSS/JS in `client/`, served as static files. No build tools.
- **Dependencies**: `express`, `socket.io`, `node-fetch` (for Ollama). **No TypeScript, no database, no ORM.**
- All game state lives in memory on the server.

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
| **No lint/typecheck/build scripts exist.** |

All tests are plain Node scripts (no framework), exit via `process.exit(0|1)`.

## Test prerequisites
- Server running at `http://192.168.1.32:3000` (configurable via `PORT`).
- Ollama at `http://192.168.1.30:11434` (configurable via `OLLAMA_BASE_URL`) with `qwen2.5:7b` pulled.
- Playwright tests need `npm install` (devDeps: `playwright`, `socket.io-client`).
- Server session is dirty after each test; clean up with `lobby:reset` or `game:returnToLobby`.

## Environment variables
| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `OLLAMA_BASE_URL` | `http://192.168.1.30:11434` | Ollama API base URL |
| `NODE_ENV` | `development` | Set to `production` in Docker |

Defaults are hardcoded fallbacks in `server/index.js` and `server/ollama/OllamaClient.js`. No `.env` file.

## Game state machine
`LOBBY → SUBMITTING (15s) → REVEALING (10s) → SUBMITTING (loop, round<2) → VOTING_SOON (5s) → VOTING (10s) → (3s delay) → SUBMITTING or ENDED`

Minimum **2 humans + 1 AI** to start. Voting starts after round 2 (i.e. round counter ≥ 2), then every round. After `resolveVotes`, a 3s `setTimeout` before `checkWinCondition`.

## Key files
| File | Role |
|---|---|
| `server/index.js` | Express app, Socket.IO init, static files, `/api/models`, `/api/rules` |
| `server/game/GameManager.js` | Singleton — `getOrCreateSession()`, `reset()`, `generatePlayerId()` |
| `server/game/GameSession.js` | State machine, submit/reveal phases, AI vote resolution, win conditions |
| `server/game/Player.js` | Player model (isHuman, isEliminated, isDisconnected, messageHistory[], model) |
| `server/game/topics.js` | Array of 15 discussion topics |
| `server/ollama/OllamaClient.js` | HTTP wrapper for Ollama `/api/chat` and `/api/tags` |
| `server/ollama/prompts.js` | All AI prompts — never inline |
| `server/socket/handlers.js` | All Socket.IO event handlers |
| `client/js/lobby.js` | Lobby screen logic |
| `client/js/game.js` | In-game screen logic |

## Socket events
**Client→Server:**
- `lobby:setName({ name })` — join or rename
- `lobby:start({ topic, aiPlayers })` — host starts game (`aiPlayers: [{ model }]`). Uses **callback** for confirmation.
- `game:sendMessage({ text })` — submit message in SUBMITTING phase
- `game:returnToLobby` — return after end screen (resets session via `GameManager.reset()`)
- `lobby:reset` — force server reset
- `game:rejoin({ playerId })` — reconnect mid-game

**Server→Client:**
- `lobby:state`, `host:assigned`, `game:state` (+ `myId`, `submittedBy[]`, `activePlayerCount`), `game:newMessage`, `game:votingSoon` (`{ delay: 5 }`), `game:voteStart` (`{ roundNumber }`), `game:voteResult` (`{ eliminated: {id,name,isHuman}|null, remainingHumans, remainingAIs }`), `game:ended` (`{ winner, players[], winnerPlayerId?, winnerPlayerName? }`), `error`

Full `game:state` emitted after every state transition. `game:newMessage` is emitted in batch at start of REVEALING, not per-message in real-time. `game:ended.players` includes `model` for each AI.

## Key conventions
- **Validation**: Player names `/^[a-zA-Z0-9 ]{1,20}$/`, messages ≤500 chars, both HTML-sanitized (`<>&"'` stripped). All handlers wrapped in try/catch.
- **Game state** lives only in `GameSession.js` — never in socket handlers.
- **`emitToAll` / `emitToSocket`** must be set by `lobby:start` handler *before* calling `startGame()`, because `startSubmitPhase()` → `emitGameState()` needs them. Crashes if unset.
- **All prompts** in `server/ollama/prompts.js` — never inline. Exports: `buildSystemPrompt`, `buildTurnPrompt`, `buildVotePrompt`, `buildNamePrompt`.
- **AI memory**: `messageHistory[]` per AI player (system prompt + turn prompts + round transcripts). Round transcripts (others' messages only) appended in `resolveSubmitPhase`.
- **AI name generation**: Via `buildNamePrompt()`, retries on duplicates (up to 10 tries), fallback to `AI-xxxx`.
- **AI vote parsing**: Fuzzy case-insensitive `includes()` match against player names, sorted longest-first to avoid partial-name collisions.
- **Vote resolution**: AI-only. Majority eliminates; ties eliminate no one.
- **Disconnect**: lobby → removed + host reassigned. Mid-game → `isDisconnected`. In SUBMITTING, remaining players may trigger early resolve. Rejoin via `game:rejoin({ playerId })`.
- **`isDisconnected`** players excluded from `getActivePlayers()` (treated like eliminated).
- **AI disconnect asymmetry**: `getActiveAIs()` filters only by `isEliminated` — disconnected AIs still generate messages and vote. Only humans lose active status on disconnect.
- **Client page flow**: lobby.js stores `cogito_myId` in localStorage, emits `game:rejoin` with 2s timeout — if no `game:state` received, renders lobby fresh. game.js also emits `game:rejoin` on load. On `game:state`, lobby.js redirects to `game.html`. On `lobby:state`, game.js redirects to `index.html`. Either rejoin strategy can win depending on page load order.
- **Dead code** (don't rely on): `GameSession.getAlivePlayers()` (identical to `getActivePlayers()`, unused). `Player.isActive` is set in `handleDisconnect`/`game:rejoin` but never read — only `isDisconnected` is checked in game logic. `Player.lastMessageIndex` is set but never read.

## Ollama
- Default URL: `http://192.168.1.30:11434` (configurable via `OLLAMA_BASE_URL` env var).
- Model list polled every 30s, cached. Timeouts: chat 30s, model list 5s.
- On failure, returns `"..."` — does not crash.

## Docker
- `node:20-alpine`, `npm ci --omit=dev`, `EXPOSE 3000`
- Binds `192.168.1.32:3000:3000` (specific IP), custom bridge `cogito-net`
- Security: `cap_drop: ALL`, `no-new-privileges:true`
- `.dockerignore` excludes `*.md` — `RULES.md` won't be present in the image, so `GET /api/rules` returns fallback text in Docker.

## Historical bugs (don't reintroduce)
| Bug | Context |
|---|---|
| `updateUI()` hides `votingOverlay` on every `game:state` | Guard with `if (state.phase !== 'VOTING')` before hiding |
| `GameManager.reset()` orphaned session timers | `reset()` must call `session.clearTimers()` before nulling session |
| Lobby `disconnect` handler didn't broadcast to remaining players | Must iterate remaining players and emit `lobby:state` per-player |
| `game:rejoin` only emitted to rejoining socket | Must call `session.emitGameState()` which sends to all players |
| Shared localStorage `myId` → multi-tab collision | Key is `cogito_myId`, emitted per-player via `game:state.myId` |

## References
- **`DEVELOPMENT.md`** — comprehensive architecture reference (partially stale: file tree lists nonexistent `client/assets/sounds/`). Use alongside AGENTS.md.
