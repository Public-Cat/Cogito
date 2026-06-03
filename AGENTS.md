# Cogito — Agent Guide

## Workflow rules
- **Never leave this directory.** The workspace root is `/home/agents/cogito`. Use `./tmp` instead of `/tmp` for temporary files.
- **Always start new changes in a distinct feature branch.** Branch from `main`.
- **Commit often, commit early, commit atomically.** Follow Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`).

## Stack
- **Runtime**: Node.js v20+, ES Modules (`"type": "module"` in package.json). No `.cjs`/`.mjs` — all `.js` files use `import`/`export`.
- **Backend**: Express + Socket.IO. No other backend framework.
- **Frontend**: Vanilla HTML/CSS/JS served as static files by Express. No build tools, no bundler, no framework.
- **No TypeScript anywhere. No database. No ORM.** All game state lives in memory.

## Commands
| Command | What |
|---|---|
| `npm start` | `node server/index.js` |
| `npm run dev` | `node --watch server/index.js` (auto-restart on change) |
| `node tests/e2e.mjs` | Run a socket-level E2E test (no test framework — plain Node) |
| `node tests/full-game.mjs` | Full game flow through voting + end |
| `node tests/rejoin.mjs` | Tests player reconnection mid-game |
| `node tests/ui-interactive.mjs` | Playwright-based full UI test (2 humans + 1 AI) |
| `node tests/ui-6p4ai.mjs` | Playwright test (6 humans + 4 AIs, 2 vote rounds) |
| `docker compose up --build` | Production build + run |
| **No lint/typecheck/build scripts exist.** |

## Test prerequisites
- A running game server (e.g. `npm run dev` or Docker) at `http://192.168.1.32:3000`
- Ollama accessible with at least one model pulled (default: `http://192.168.1.30:11434`)
- All test scripts hardcode `192.168.1.32:3000` as the server URL
- `ui-interactive.mjs` and `ui-6p4ai.mjs` require `npm install` (devDependencies include `playwright` and `socket.io-client`)
- Playwright tests expect `qwen2.5:7b` as the AI model name
- There is no test watcher/runner — tests are run directly with `node`
- After each test run, the server session is dirty; tests emit `lobby:reset` or `game:returnToLobby` to clean up

## Ollama configuration
- Default URL in code: `http://192.168.1.30:11434` (not `host.docker.internal`; configured via `OLLAMA_BASE_URL` env var)
- In Docker, `docker-compose.yml` uses `extra_hosts: ["host.docker.internal:host-gateway"]` — but the compose file currently points to a hardcoded IP instead
- Model list is polled every 30s server-side; cached in `OllamaClient.js`
- Chat timeout: 30s; model list timeout: 5s
- On Ollama failure, returns fallback `"..."`, does not crash the game

## Architecture

### Game state machine
`LOBBY → PLAYING → VOTING_SOON (5s) → VOTING (10s timeout) → PLAYING (loop) → ENDED`

### Key files
| File | Role |
|---|---|
| `server/index.js` | Express app, Socket.IO init, static file serving, `/api/models` endpoint |
| `server/game/GameManager.js` | Singleton session holder — `currentSession`, `reset()`, `generatePlayerId()` |
| `server/game/GameSession.js` | Full game state machine, turn logic, vote resolution, win conditions |
| `server/game/Player.js` | Player model |
| `server/ollama/OllamaClient.js` | HTTP wrapper for Ollama `/api/chat` and `/api/tags` |
| `server/ollama/prompts.js` | `buildSystemPrompt`, `buildVotePrompt`, `buildNamePrompt` |
| `server/socket/handlers.js` | All Socket.IO event handlers |

### Socket events (see `DEVELOPMENT.md` for the full table)
Client→Server: `lobby:setName`, `lobby:start`, `game:sendMessage`, `game:vote`, `game:returnToLobby`, `lobby:reset`, `game:rejoin`
Server→Client: `lobby:state`, `host:assigned`, `game:state`, `game:newMessage`, `game:voteStart`, `game:voteResult`, `game:ended`, `error`, `game:votingSoon`

### Socket event payload validation
- Player names: `/^[a-zA-Z0-9 ]{1,20}$/`, sanitized for HTML (`<>&"'` stripped)
- Messages: max 500 characters, sanitized
- All event handlers wrapped in try/catch, emit `error` on failure

### AI memory management
- Each AI player has `messageHistory[]` on its `Player` instance
- Round transcripts appended as single `user` entry per round, not per-message
- `lastMessageIndex` prevents re-sending old messages on each turn (avoids quadratic growth)
- Voting prompt appended to existing history, not rebuilt from scratch

### Disconnect handling
- **In lobby**: player removed; host reassigned if needed
- **During game**: marked `isDisconnected`, turn auto-advances if it was their turn; `game:rejoin` reconnects them via `playerId`
- Rejoining mid-game sets `isDisconnected=false`, emits full `game:state`

## Docker notes
- `Dockerfile`: `node:20-alpine`, `npm ci --omit=dev` (devDependencies excluded)
- `docker-compose.yml` currently binds `192.168.1.32:3000:3000` (specific IP, not `0.0.0.0`)
- `cap_drop: ALL` and `no-new-privileges:true` for security
- Uses a custom Docker network (`cogito-net`, bridge)
- `.dockerignore` excludes `node_modules/`, `.git/`, `tmp/`, `*.md`

## Conventions
- No TypeScript. Plain JS ES modules with `import`/`export`.
- No frontend build tools. No CSS frameworks. No frontend JS frameworks.
- One-line file header comment describing purpose; JSDoc on functions >10 lines or non-obvious params.
- All prompts in `server/ollama/prompts.js` — never inline prompt strings.
- Validation on every socket event payload before processing.
- Game state never stored in socket handlers — lives in `GameSession.js` only.
- Full `game:state` snapshot emitted after every state transition (for reconnection support).
