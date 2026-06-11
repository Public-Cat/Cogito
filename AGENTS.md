# Cogito — Agent Guide

## Workflow
- **Never leave workspace root.** Use `./tmp` for temp files.
- **All features branch from `develop`** and merge back to `develop`. Never touch `main`.
- Use git worktrees for parallel features:
  `git worktree add -b <branch-name> ./worktrees/<branch-name> develop`
- `worktrees/` is in `.gitignore` — created and managed by agents.
- **Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`).

## Stack
- **Runtime**: Node.js v20+, ES Modules (`"type": "module"` in package.json). App source uses `.js`; test scripts use `.mjs`. `node --watch` requires Node 18+.
- **Backend**: Express + Socket.IO. No other framework.
- **Frontend**: Vanilla HTML/CSS/JS in `client/`, served as static files. No build tools, bundlers, or frameworks.
- **No TypeScript, no database, no ORM.** All game state in memory.
- **`/api/models`** Express endpoint proxies `OllamaClient.getModels()` for the lobby.

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
- Server running at `http://192.168.1.32:3000` (`npm run dev` or Docker)
- Ollama at `http://192.168.1.30:11434` with `qwen2.5:7b` pulled
- Playwright tests need `npm install` (devDeps: `playwright`, `socket.io-client`)
- Server session is dirty after each test; clean up with `lobby:reset` or `game:returnToLobby`

## Game state machine
`LOBBY → SUBMITTING (15s) → REVEALING (10s) → SUBMITTING (loop, round<2) → VOTING_SOON (5s) → VOTING (10s) → (3s delay) → SUBMITTING or ENDED`

All players (humans + AIs) write simultaneously during SUBMITTING phase (15s). All responses are revealed together in REVEALING phase (10s). Minimum **2 humans + 1 AI** to start. Voting starts after round 2, then every round. After votes resolve (`resolveVotes`), there's a **3-second `setTimeout`** before `checkWinCondition` transitions to the next phase — this lets the UI show the vote result before continuing.

## Key files
| File | Role |
|---|---|
| `server/index.js` | Express app, Socket.IO init, static files, `/api/models` (proxies `getModels()`) |
| `server/game/GameManager.js` | Singleton — `getOrCreateSession()`, `reset()`, `generatePlayerId()` |
| `server/game/GameSession.js` | State machine, submit/reveal phases, AI vote resolution, win conditions |
| `server/game/Player.js` | Player model (isHuman, isEliminated, isDisconnected, messageHistory[], lastMessageIndex, model) |
| `server/game/topics.js` | Array of ~15 discussion topics |
| `server/ollama/OllamaClient.js` | HTTP wrapper for Ollama `/api/chat` and `/api/tags` |
| `server/ollama/prompts.js` | All AI prompts — never inline |
| `server/socket/handlers.js` | All Socket.IO event handlers |
| `client/js/matrixRain.js` | Self-installing canvas rain background |
| `client/js/sfx.js` | Programmatic sounds (Web Audio API, no audio files) |

## Socket events
**Client→Server:**
- `lobby:setName({ name })` — join or rename
- `lobby:start({ topic, aiPlayers })` — host starts game (`aiPlayers: [{ model }]`). Uses **callback** for confirmation.
- `game:sendMessage({ text })` — submit message in SUBMITTING phase. Server validates: active, not yet submitted.
- `game:returnToLobby` — return after end screen (resets session)
- `lobby:reset` — force server reset
- `game:rejoin({ playerId })` — reconnect mid-game

**Server→Client:**
- `lobby:state`, `host:assigned`, `game:state` (+ `myId`, `submittedBy[]`, `activePlayerCount`), `game:newMessage`, `game:votingSoon` (`{ delay: 5 }`), `game:voteStart`, `game:voteResult` (`{ eliminated: {id,name,isHuman}|null }`), `game:ended` (`{ winner: 'humans'|'ais'|'solo', players[], winnerPlayerId?, winnerPlayerName? }`), `error`

Full `game:state` emitted after every state transition (for reconnection support). `game:newMessage` is emitted in batch at start of REVEALING phase, not per-message in real-time.

## References
- **`DEVELOPMENT.md`** — comprehensive architecture reference. Has been reconciled with the current codebase. Use alongside AGENTS.md for deeper context.

## Key conventions
- **Validation**: Player names `/^[a-zA-Z0-9 ]{1,20}$/`, messages ≤500 chars, both HTML-sanitized. All handlers wrapped in try/catch.
- **Game state** lives only in `GameSession.js` — never in socket handlers.
- **`emitToAll` / `emitToSocket`** must be set by `lobby:start` handler *before* calling `startGame()`, because `startSubmitPhase()` → `emitGameState()` uses them. If not set, crashes as `emitToSocket is not a function`.
- **All prompts** in `server/ollama/prompts.js` — never inline. Exports: `buildSystemPrompt`, `buildTurnPrompt`, `buildVotePrompt`, `buildNamePrompt`.
- **AI memory**: `messageHistory[]` per AI player (system prompt + turn prompts + round transcripts). Round transcripts (others' messages only) appended in `resolveSubmitPhase`. `model` field on Player stores which Ollama model they use. `lastMessageIndex` is set but unused (dead field).
- **AI name generation**: At game start via `buildNamePrompt()`, retries on duplicates (up to 10 tries), fallback to `AI-xxxx`.
- **AI vote parsing**: Fuzzy case-insensitive `includes()` match against player names, sorted longest-first to avoid partial-name collisions.
- **Vote resolution**: AI-only. Majority vote eliminates; ties eliminate no one.
- **Disconnect**: lobby → removed + host reassigned. Mid-game → `isDisconnected`. In SUBMITTING phase, remaining players may trigger early resolve. Rejoin via `game:rejoin({ playerId })`.
- **`isDisconnected`** players are excluded from `getActivePlayers()` (treated like eliminated).
- **AI disconnect asymmetry**: `getActiveAIs()` filters only by `isEliminated` — disconnected AIs still generate messages and vote. Only humans lose active status on disconnect.
- **Client rejoin**: `client/js/lobby.js` stores `cogito_myId` in localStorage. On page load, emits `game:rejoin` with a 2s timeout — if no `game:state` received, renders lobby fresh.
- **Dead code**: `GameSession.getAlivePlayers()` (line 68) is identical to `getActivePlayers()` and unused.

## Ollama
- Default URL: `http://192.168.1.30:11434` (configurable via `OLLAMA_BASE_URL`)
- Model list polled every 30s, cached. Timeouts: chat 30s, model list 5s.
- On failure, returns `"..."` — does not crash.

## Docker
- `node:20-alpine`, `npm ci --omit=dev`, `EXPOSE 3000`
- Binds `192.168.1.32:3000:3000` (specific IP), custom bridge `cogito-net`
- Security: `cap_drop: ALL`, `no-new-privileges:true`
- `.dockerignore` excludes `node_modules/`, `.git/`, `tmp/`, `*.md`
