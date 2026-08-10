# Cogito — Agent Guide

## Workflow
- **Never leave workspace root.** Use `./tmp` for temp files (already gitignored).
- **Branch from `develop`**, merge back to `develop`. Never touch `main`.
- Git worktrees for parallel features: `git worktree add -b <name> ./worktrees/<name> develop`
- `worktrees/` is in `.gitignore`.
- Fetch/rebase, merge to `develop`, delete branch when done.
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
| `node tests/security.mjs` | Access-control surface (realm/code/token/rejoin) |
| `node tests/join.mjs` | LAN join test via Caddy (see deploy/README.md section 2) |
| `node tests/ui-realm-code.mjs` | Playwright: session-code hidden for LAN realm |
| `node tests/ai-eval.mjs` | Model-comparison eval (env: MODELS, AI_COUNT, TOPIC, etc.) |
| `node tests/win-condition.mjs` | Unit test — no server/Ollama needed, runs GameSession directly |
| `docker compose up --build` | Production build + run |

All tests are plain Node scripts, exit via `process.exit(0|1)`. Don't run concurrently — single in-memory session leaves stale state.

## Test prerequisites
- Server running at `PORT` (default `3000`).
- Ollama at `OLLAMA_BASE_URL` (default `http://192.168.1.30:11434`) with `qwen2.5:7b` pulled.
- `npm install` (devDeps: `playwright`, `socket.io-client`).
- Playwright UI tests also need `npx playwright install chromium`.
- Session is dirty after each test; clean up with `lobby:reset` or `game:returnToLobby`.
- Tests connect to `http://192.168.1.32:3000` (dev server port 3000, not Docker port 3008).

## Game state machine
`LOBBY → SUBMITTING (120s) → REVEALING (10s) → (loop, round<2) → VOTING_SOON (45s) → VOTING (40s) → (3s delay) → SUBMITTING or ENDED`

Minimum **2 humans + 1 AI** to start. Voting starts round ≥ 2, then every round.

## Key files
| File | Role |
|---|---|
| `server/index.js` | Express, Socket.IO, static files, `/api/models`, `/api/rules`, `/api/topics` |
| `server/game/GameManager.js` | Singleton — `getOrCreateSession()`, `reset()`, `generatePlayerId()` |
| `server/game/GameSession.js` | State machine, phase transitions, vote resolution, win conditions |
| `server/game/Player.js` | Player model (`isHuman`, `isEliminated`, `isDisconnected`, `messageHistory[]`, `model`, `currentVote`) |
| `server/game/topics.js` | ~15 discussion topics |
| `server/ollama/prompts.js` | All AI prompts — do not inline prompt strings elsewhere |
| `server/ollama/OllamaClient.js` | HTTP wrapper for Ollama `/api/chat` and `/api/tags` |
| `server/socket/handlers.js` | All Socket.IO event handlers |
| `client/js/lobby.js` | Lobby screen |
| `client/js/game.js` | In-game screen |
| `client/js/matrixRain.js` | Canvas rain background |
| `client/js/sfx.js` | Web Audio API sound effects |

## Key conventions
- **Validation**: Names `/^[a-zA-Z0-9 ]{1,20}$/`, messages ≤500 chars, sanitized (`<>&"'` stripped). All handlers wrapped in try/catch.
- **Game state** lives only in `GameSession.js` — never in socket handlers.
- **`emitToAll` / `emitToSocket`** must be set by `lobby:start` handler *before* `startGame()`. Crashes if unset.
- **AI disconnect asymmetry**: `getActiveAIs()` filters only by `isEliminated` — disconnected AIs still generate and vote. `getActivePlayers()` checks `isDisconnected`, so only humans lose active status on disconnect.
- **AI vote parsing**: Split on `[,;\n]`, fuzzy `includes()` match against player names (longest-first with `\b` word boundaries), deduplicated. Unparseable = empty ranking (zero points).
- **Vote resolution**: Combined AI+human Borda count. AI ranks players most→least suspicious (first = N-2 points, last = 0). Humans cast single vote = full N-2 weight. Highest total eliminated. Tiebreakers: (1) highest-rank count across individual rankings/votes, (2) cumulative Borda history across all prior voting rounds. If still tied → no elimination. Disconnected humans don't vote.
- **Human vote casting**: `game:castVote { targetId }` → `GameSession.castHumanVote()`. Rejects outside VOTING, eliminated/disconnected/self/invalid targets. Early resolve when AIs done AND all active humans voted; otherwise 40s `voteTimeout` fires.
- **AI memory**: `messageHistory[]` per AI (system prompt + turn prompts + round transcripts).
- **AI personality**: Random `personality` from `PERSONALITIES` injected into `buildSystemPrompt()`.
- **AI name generation**: `buildNamePrompt()`, retries on duplicates (10 tries), fallback `AI-xxxx`.
- **Client rejoin**: `cogito_myId` + `cogito_myToken_<id>` in localStorage. Both pages emit `game:rejoin` on load.
- **Disconnect handler**: `GameSession.handleDisconnect()` only reassigns host in LOBBY. `host:assigned` emitted mid-game too but is a harmless no-op.

## Socket events
**Client→Server**: `lobby:setName { name, code }`, `lobby:start (callback)`, `game:sendMessage`, `game:castVote`, `game:returnToLobby`, `lobby:reset`, `game:rejoin { playerId, token }`

**Server→Client**: `client:hello { realm }`, `lobby:state` (+ per-recipient `myToken`, host-only `sessionCode`), `host:assigned`, `game:state` (+ per-player `myId`, `myToken`, `submittedBy[]`, `activePlayerCount`), `game:newMessage`, `game:votingSoon`, `game:voteStart`, `game:voteProgress { votedCount, totalEligible }`, `game:voteResult`, `game:ended`, `error`

Full `game:state` emits after every state transition. `game:ended.players` includes `model` for each AI. `myToken` and `sessionCode` are scoped to their owning socket only.

**Privileged events** (`lobby:reset`, `game:returnToLobby`, `lobby:start`): gated by `requireLanHost()` — only LAN-realm hosts. Both reset events call `gameManager.reset()`, broadcast empty `lobby:state` to all; `game:returnToLobby` then sends `isHost:true` to the caller.

## Security / access control
Built for **Cloudflare Tunnel → Caddy → app**. See `deploy/README.md`.
- **Realm**: `X-Cogito-Realm` header set by Caddy per vhost. Only `'lan'` grants host privileges; default `'public'` (fail safe). `cogito` publishes no host port — accessible only via the `cogito-net` Docker network, making the header trustworthy.
- **Join gate**: Auto-generated 6-char session code (`A-Z`+`2-9` minus `O/0/I/1/L`). LAN bypasses; public realm must match. Code sent only to host, regenerated on every reset.
- **Identity**: `randomUUID()` player IDs; per-player `rejoinToken`; `game:rejoin` verifies `{ playerId, token }`.
- **Limits**: CORS `ALLOWED_ORIGINS`; `MAX_AI_PLAYERS=8`; `MAX_HUMAN_PLAYERS=12`; topic ≤120 chars; Ollama concurrency capped at 4; per-socket rate limits on join, message, vote, rejoin events.
- **Tests**: host client uses `extraHeaders: { 'X-Cogito-Realm': 'lan' }`; `tests/security.mjs` covers access-control surface.

## Ollama
- URL via `OLLAMA_BASE_URL`. Model list polled every 30s, cached. Timeouts: chat 105s, list 5s.
- On failure, returns `"..."` — does not crash.

## Docker
- `node:20-alpine`, `npm ci --omit=dev`, runs as non-root (`USER node`).
- No published host port; reachable via `cogito-net` Docker network only.
- `read_only: true`, `tmpfs: /tmp`, `cap_drop: ALL`, `no-new-privileges:true`, `restart: unless-stopped`.
- Env: `HOST=0.0.0.0`, `ALLOWED_ORIGINS`, `OLLAMA_BASE_URL`.
- `.dockerignore` excludes `*.md` but preserves `!RULES.md`.

## Historical bugs (don't reintroduce)
| Bug | Fix |
|---|---|
| `updateUI()` hides `votingOverlay` on every `game:state` | Guard with `if (state.phase !== 'VOTING')` before hiding |
| `GameManager.reset()` orphaned session timers | `reset()` must call `session.clearTimers()` before nulling session |
| Lobby `disconnect` didn't broadcast to remaining players | Iterate remaining players and emit `lobby:state` per-player |
| `game:rejoin` only emitted to rejoining socket | Must call `session.emitGameState()` which sends to all players |
| Shared localStorage `myId` → multi-tab collision | Key is `cogito_myId`, emitted per-player via `game:state.myId` |
| Borda single-player ranking gave 0 points (N-1 where N=1) | Edge case: ranking only 1 player → give 1 point |
| Borda ties stalled games with even AI splits | Add cumulative Borda history as 2nd-level tiebreaker |
