# Cogito — Agent Guide

## Workflow
- **Never leave workspace root.** Use `./tmp` for temp files.
- **All features branch from `develop`** and merge back to `develop`. Never touch `main`.
- Use git worktrees for parallel features:
  `git worktree add -b <branch-name> ./worktrees/<branch-name> develop`
- `worktrees/` is in `.gitignore` — created and managed by agents.
- **Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`).

## Stack
- **Runtime**: Node.js v20+, ES Modules (`"type": "module"`). No `.cjs`/`.mjs`.
- **Backend**: Express + Socket.IO. No other framework.
- **Frontend**: Vanilla HTML/CSS/JS in `client/`, served as static files. No build tools, bundlers, or frameworks.
- **No TypeScript, no database, no ORM.** All game state in memory.

## Commands
| Command | What |
|---|---|
| `npm start` | `node server/index.js` |
| `npm run dev` | `node --watch server/index.js` |
| `node tests/e2e.mjs` | Socket-level E2E |
| `node tests/full-game.mjs` | Full game flow through voting + end |
| `node tests/rejoin.mjs` | Player reconnection mid-game |
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
`LOBBY → PLAYING → VOTING_SOON (5s) → VOTING (10s timeout) → PLAYING (loop) → ENDED`

Minimum **2 humans + 1 AI** to start. Voting starts after round 2, then every round.
Human votes visible to all humans; AI votes are private.

## Key files
| File | Role |
|---|---|
| `server/index.js` | Express app, Socket.IO init, static files, `/api/models` |
| `server/game/GameManager.js` | Singleton — `getOrCreateSession()`, `reset()`, `generatePlayerId()` |
| `server/game/GameSession.js` | State machine, turn logic, vote resolution, win conditions |
| `server/game/Player.js` | Player model (isHuman, isEliminated, isDisconnected, messageHistory[]) |
| `server/game/topics.js` | Array of ~15 discussion topics |
| `server/ollama/OllamaClient.js` | HTTP wrapper for Ollama `/api/chat` and `/api/tags` |
| `server/ollama/prompts.js` | All AI prompts — never inline |
| `server/socket/handlers.js` | All Socket.IO event handlers |
| `client/js/matrixRain.js` | Self-installing canvas rain background |
| `client/js/sfx.js` | Programmatic sounds (Web Audio API, no audio files) |

## Socket events
**Client→Server:**
- `lobby:setName({ name })` — join or rename
- `lobby:start({ topic, aiPlayers })` — host starts game (`aiPlayers: [{ model }]`)
- `game:sendMessage({ text })` — submit turn message
- `game:vote({ targetId })` — human player votes
- `game:returnToLobby` — return after end screen
- `lobby:reset` — force server reset
- `game:rejoin({ playerId })` — reconnect mid-game

**Server→Client:**
- `lobby:state`, `host:assigned`, `game:state`, `game:newMessage`, `game:votingSoon`, `game:voteStart`, `game:voteResult`, `game:ended`, `error`

Full `game:state` emitted after every state transition (for reconnection support).

## Key conventions
- **Validation**: Player names `/^[a-zA-Z0-9 ]{1,20}$/`, messages ≤500 chars, both HTML-sanitized. All handlers wrapped in try/catch.
- **Game state** lives only in `GameSession.js` — never in socket handlers.
- **All prompts** in `server/ollama/prompts.js` — never inline.
- **AI memory**: `messageHistory[]` per AI player, round transcripts as single `user` entry, `lastMessageIndex` prevents resends.
- **AI vote parsing**: Fuzzy case-insensitive `includes()` match against player names, sorted longest-first to avoid partial-name collisions.
- **Disconnect**: lobby → removed + host reassigned. Mid-game → `isDisconnected`, turn auto-advances. Rejoin via `game:rejoin({ playerId })`.
- **`isDisconnected`** players are skipped in turn order (treated like eliminated).

## Ollama
- Default URL: `http://192.168.1.30:11434` (configurable via `OLLAMA_BASE_URL`)
- Model list polled every 30s, cached. Timeouts: chat 30s, model list 5s.
- On failure, returns `"..."` — does not crash.

## Docker
- `node:20-alpine`, `npm ci --omit=dev`, `EXPOSE 3000`
- Binds `192.168.1.32:3000:3000` (specific IP), custom bridge `cogito-net`
- Security: `cap_drop: ALL`, `no-new-privileges:true`
- `.dockerignore` excludes `node_modules/`, `.git/`, `tmp/`, `*.md`
