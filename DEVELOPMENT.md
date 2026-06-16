# 🛠️ DEVELOPMENT.md — Architecture & Implementation Notes

This document describes the Cogito architecture and implementation details. For the current agent workflow and gotchas, see `AGENTS.md`.

---

## 1. Language & Framework Decisions

### Backend: Node.js + Express + Socket.IO

- Use **Node.js** (LTS, v20+) for the backend.
- Use **Express** for HTTP routing (lobby API, Ollama proxy, health check).
- Use **Socket.IO** for all real-time communication between server and clients.
- Do **not** use any backend framework other than Express. No Fastify, no Hapi, no NestJS.
- Do **not** use TypeScript. Plain **ES Modules** (`import`/`export`) with `.js` extensions throughout.

### Frontend: Vanilla HTML/CSS/JS

- The frontend is **pure HTML, CSS, and JavaScript**. No React, no Vue, no Svelte.
- JavaScript is written as **ES Modules** loaded via `<script type="module">`.
- Socket.IO client is loaded from the CDN served by the backend (`/socket.io/socket.io.js`).
- The frontend consists of exactly **two HTML pages**:
  - `client/index.html` — Lobby / Join screen
  - `client/game.html` — In-game chat screen
- CSS lives in `client/css/matrix.css`. All styling is in this one file.
- JavaScript is split into focused modules in `client/js/`.

### AI Integration: Ollama

- All AI inference goes through the **Ollama REST API** at `http://host.docker.internal:11434`.
- Use the `/api/tags` endpoint to fetch available models for the host configuration UI.
- Use the `/api/chat` endpoint (not `/api/generate`) for all AI turn generation and voting — this supports multi-turn message history.
- All Ollama calls are made **server-side only**. The frontend never talks to Ollama directly.

---

## 2. Project Structure

Implement the following file structure exactly. Do not add files or directories not listed here without a clear reason documented in a code comment.

```
cogito-game/
├── server/
│   ├── index.js                  # Express app setup, Socket.IO init, static file serving
│   ├── game/
│   │   ├── GameManager.js        # Singleton: manages the one active game session
│   │   ├── GameSession.js        # Game state machine (SUBMITTING/REVEALING/VOTING phases)
│   │   ├── Player.js             # Player model (human or AI)
│   │   └── topics.js             # Array of discussion topics
│   ├── ollama/
│   │   ├── OllamaClient.js       # Wrapper for Ollama REST API calls
│   │   └── prompts.js            # All system prompts and prompt-building functions
│   └── socket/
│       └── handlers.js           # All Socket.IO event handlers (imported by index.js)
├── client/
│   ├── index.html
│   ├── game.html
│   ├── css/
│   │   └── matrix.css
│   ├── js/
│   │   ├── lobby.js              # Lobby screen logic
│   │   ├── game.js               # In-game screen logic
│   │   └── sfx.js                # Sound effect management
│   └── assets/
│       └── sounds/
│           ├── eliminated.mp3
│           ├── vote.mp3
│           ├── win.mp3
│           └── lose.mp3
├── docker-compose.yml
├── Dockerfile
├── package.json
├── .gitignore
├── README.md
├── RULES.md
└── DEVELOPMENT.md
```

---

## 3. Architecture

### Single Game Session

- The server maintains **one game session at a time**, managed by `GameManager.js`.
- `GameManager` is a singleton module-level object. It holds a reference to the current `GameSession` instance (or `null` if no game is active).
- When a game ends and all players return to the lobby, `GameManager` resets (`this.currentSession = null; this.playerCounter = 0`).

### Host Assignment

Covered in section 3 of AGENTS.md. TL;DR: First human to connect is host. Lobby disconnect → reassign. Game disconnect → no reassign.

### Socket Events

See `AGENTS.md` for the current socket event reference — it is the authoritative source.

### Game State Machine

```
LOBBY → SUBMITTING (15s) → REVEALING (10s) → loop (round<2) → VOTING_SOON (5s) → VOTING (10s) → (3s delay) → SUBMITTING or ENDED
```

States are constants in `GameSession.js`:
```js
const STATES = { LOBBY, SUBMITTING, REVEALING, VOTING_SOON, VOTING, ENDED };
```

- **LOBBY**: Players joining, host configuring.
- **SUBMITTING**: All active players write simultaneously (15s timer). Humans type in UI; AIs generate via `generateAIMessage()` in parallel. `pendingMessages` collected until all submit or timer expires. Early resolve if all submit before timer.
- **REVEALING**: `pendingMessages` broadcast via `game:newMessage` and appended to `this.messages` (10s timer). Round counter increments.
- **Round 2+ check**: After REVEALING, if `round >= 2`, transition to `VOTING_SOON`. Otherwise, loop back to SUBMITTING.
- **VOTING_SOON**: 5-second warning. Emits `game:votingSoon`.
- **VOTING**: AI-only rankings via Ollama (`collectAIRankings()`). `Promise.allSettled` with 10s timeout. Borda count aggregates rankings; highest total eliminated. Tiebreaker: ranked highest in more individual rankings wins; still tied → no elimination. Emit `game:voteResult`. 3-second `setTimeout` then `checkWinCondition()`.
- **ENDED**: Emit `game:ended`. Players call `game:returnToLobby` → `GameManager.reset()`.

### emitToAll / emitToSocket

Set by the `lobby:start` handler after `session.startGame()` returns — not available to `GameSession` before that:

```js
session.emitToAll = (event, data) => { io.emit(event, data); };
session.emitToSocket = (socketId, event, data) => { io.to(socketId).emit(event, data); };
```

The initial `game:state` is emitted directly via `io.to(p.socketId).emit()` in the handler, not through `GameSession`.

### Game State & Reconnection

- All game state lives in `GameSession.js`. Never in socket handlers.
- `getGameState()` returns the full snapshot with `submittedBy[]`, `activePlayerCount`, `phase`, etc.
- `game:state` emitted after **every state transition** (`emitGameState()` sends per-player with `myId`).
- Reconnection via `game:rejoin({ playerId })`: updates `socketId`, clears `isDisconnected`, emits fresh `game:state`.
- AI name generation at game start (`startGame()`): duplicates retried up to 10 times, fallback `AI-xxxx`.

---

## 4. AI Player Implementation

### Name Generation

When the host presses START, before the first round begins, for each AI player:
1. Call Ollama `/api/chat` with `buildNamePrompt()` (a one-shot prompt asking for a single human first name).
2. Strip any extra text from the response. Use the name as the AI player's display name.
3. Ensure no two AI players share the same name. Retry if a duplicate is generated (up to 10 tries).
4. If all attempts fail, fall back to `AI-xxxx` (random hex).

### System Prompt Initialization

After name generation, each AI player's `messageHistory` is initialized with the system prompt:

```js
ai.messageHistory = [
  { role: "system", content: buildSystemPrompt(ai.name, topic, allPlayerNames) }
];
```

The system prompt frames AIs as AIs in a group chat where **humans are the impostors** pretending to be AIs. AIs must find and vote out the humans. The system prompt enforces a casual, short, lowercase style.

### Simultaneous Message Generation (not round-robin)

The game does **not** use round-robin turns. All AIs generate messages simultaneously during the SUBMITTING phase:

1. `startSubmitPhase()` iterates over all active AIs and calls `generateAIMessage(ai)` in parallel (no `await` — they run concurrently).
2. `generateAIMessage(ai)` does:
   - Creates a temporary messages array: `[...ai.messageHistory, { role: 'user', content: buildTurnPrompt() }]`
   - Calls `chat(ai.model, messages)` — note the turn prompt is NOT appended to history before the call (avoids mutation on failure).
   - On success: pushes `{ role: "user", content: buildTurnPrompt() }` then `{ role: "assistant", content: reply }` to `ai.messageHistory`.
   - Adds the reply to `pendingMessages` and marks the AI as submitted.
3. If all active players (humans + AIs) submit before the 15s timer, `resolveSubmitPhase()` fires early.

### Round Transcript Appending

In `resolveSubmitPhase()`:
1. For each active AI, build a transcript of **other players' messages** (excluding the AI's own message) from `pendingMessages`:
   ```
   [PlayerName]: their message
   ```
2. Push the transcript as a single `{ role: "user", content: transcript }` entry to the AI's `messageHistory`.
3. This keeps history compact — one `user` entry per round of others' messages.
4. All `pendingMessages` are then moved to the main `this.messages` array and emitted via `game:newMessage`.

### Voting (Borda Count)

When the voting phase begins (`startVoting()`):
1. `collectAIRankings()` iterates over all active AIs and calls Ollama in parallel (`Promise.allSettled`).
2. For each AI:
   - Build the ranking prompt via `buildRankingPrompt(activePlayerNames)`.
   - Push `{ role: "user", content: rankingPrompt }` to `ai.messageHistory`.
   - Call `chat(ai.model, ai.messageHistory)`.
   - Push the model's reply as `{ role: "assistant", content: reply }` to history.
   - Parse the reply: split on `[,;\n]`, then fuzzy case-insensitive `includes()` match tokens against active player names (longest-first), deduplicated. Store ordered array in `this.aiRankings` Map. Empty array if unparseable (zero points from that AI).
3. Once all AI rankings are collected (or 10s timeout fires), call `tryResolveRankings()` → `resolveRankings()`.
4. `resolveRankings()` implements **Borda count**: each AI's ranking awards `(N-1-i)` points to position `i` (first gets N-1, last gets 0). Sum across all AIs. Highest total eliminated.
5. Tiebreaker: if Borda ties, the tied player ranked highest (earliest) in more individual AI rankings wins. If still tied, no elimination.
6. Emit `game:voteResult`. After a 3-second `setTimeout`, call `checkWinCondition()`.

### Prompts

All prompts live in `server/ollama/prompts.js`. No prompt strings should appear anywhere else. Export named functions:

```js
export function buildSystemPrompt(playerName, topic, allPlayerNames) { ... }
export function buildTurnPrompt(eliminationInfo) { ... }
export function buildRankingPrompt(activePlayerNames) { ... }
export function buildNamePrompt() { ... }
```

- `buildSystemPrompt`: Establishes the AI's identity, the premise (humans are impostors), and stylistic rules (short, lowercase, no markdown).
- `buildTurnPrompt`: Simple prompt: "Keep the conversation going." Includes elimination info from prior round if available.
- `buildRankingPrompt`: Asks the AI to rank remaining players from most suspicious to least, comma-separated. Borda count resolves the aggregate ranking.
- `buildNamePrompt`: One-shot prompt for a single common human first name.

---

## 5. Frontend Implementation

### Matrix Theme (CSS)

The visual design must feel like a **1990s hacker terminal** inspired by The Matrix. Implement these visual elements:

**Color palette (CSS variables in `:root`):**
```css
--color-bg: #000000;
--color-primary: #00ff41;       /* Matrix green */
--color-primary-dim: #008f11;   /* Dimmer green */
--color-primary-glow: #00ff4180;/* Green glow */
--color-text: #00ff41;
--color-text-dim: #005c13;
--color-white: #ccffcc;
--color-danger: #ff2222;
--color-warning: #ffaa00;
--color-panel-bg: rgba(0, 20, 0, 0.85);
--font-mono: 'Share Tech Mono', 'Courier New', monospace;
```

**Required visual effects:**
1. **Matrix rain background**: A full-screen canvas element behind all UI. Render falling columns of random katakana/latin characters in green. This runs on all screens. Implement in a shared `matrixRain.js` module loaded on both pages.
2. **Scanline overlay**: A fixed `::after` pseudo-element on `body` with repeating horizontal lines at low opacity (3–5%), simulating a CRT monitor.
3. **Text flicker**: A subtle CSS animation `@keyframes flicker` applied to headings — random opacity dips to simulate phosphor decay.
4. **Typing cursor**: A blinking `|` cursor after any active input field content.
5. **Glow effects**: `text-shadow` and `box-shadow` using `--color-primary-glow` on interactive elements, panels, and important text.
6. **Panel borders**: All UI panels use a single-pixel `border: 1px solid var(--color-primary-dim)` with a subtle `box-shadow` glow. No rounded corners (brutalist/terminal aesthetic — `border-radius: 0`).

**Typography:**
- Load `Share Tech Mono` from Google Fonts. This is the only font used throughout the entire application.
- All text is monospace. Always.

**Typing animation (universal — applies to ALL messages):**
- Every message that appears in the chat — human or AI — is rendered **character by character** with a random delay between each character (10–40ms), simulating live terminal typing. This applies to all clients who did not author the message.
- **Exception**: the player who sent a message sees their own message appear instantly (they already typed it). All other clients see the typing animation.
- This is implemented by checking `msg.playerId !== myId` client-side before animating.
- This ensures no client can distinguish human from AI messages by animation behavior.
- Messages are prefixed with `[PlayerName] > text`.

### Sound Effects

Implement `client/js/sfx.js`:
- Load all sounds at startup using the Web Audio API (or `<audio>` elements as fallback).
- Export functions: `playVote()`, `playEliminated()`, `playWin()`, `playLose()`.
- `playEliminated()` plays on the `game:voteResult` event when any player is eliminated.
- `playWin()` / `playLose()` play on the `game:ended` event.
- `playVote()` plays when the `game:voteStart` event is received.
- All sounds must be **royalty-free**. Generate or source appropriate beep/glitch/static sounds. The agent should use the Web Audio API to **programmatically generate** all sound effects — do not rely on external sound files. Implement:
  - `playVote()`: short descending digital beep sequence
  - `playEliminated()`: harsh digital glitch/static burst
  - `playWin()`: ascending triumphant 8-bit fanfare
  - `playLose()`: descending minor tone sequence, ominous

### Screens

**`index.html` — Lobby/Join Screen**

Sections (conditionally shown):
1. **Join panel**: Name input + JOIN button. Shown to all new visitors before they've set a name.
2. **Waiting panel**: "Waiting for host to start..." message + current player list. Shown to non-host players after joining.
3. **Host config panel**: Shown only to the host. Contains:
   - Topic selector (dropdown of all topics + "Random" option)
   - AI player configuration (add/remove AI slots, each with a model dropdown populated from Ollama `/api/tags`)
   - Full player list (names + human/AI indicator)
   - START button (disabled until at least 2 humans + 1 AI is in the lobby)

**`game.html` — In-Game Screen**

Layout (terminal window style):
- **Top bar**: Game topic, current round number, phase indicator (SUBMITTING / REVEALING / VOTING).
- **Chat area**: Scrollable message history. Each message: `[PlayerName] > text`. Eliminated players' messages are visually dimmed (50% opacity). Eliminated players have a `[TERMINATED]` tag next to their name.
- **Input area**: Text input + SEND button. Enabled during SUBMITTING phase (if player hasn't submitted yet). Shows countdown timer and submission status.
- **Phase indicators**: During SUBMITTING, shows "write your response (Xs)". During REVEALING, shows "reading responses... (Xs)". During VOTING_SOON, shows "voting in Xs...".
- **Player list sidebar** (desktop) / **collapsible panel** (mobile): Shows all players, their status (active / eliminated / disconnected). Players who have submitted show a checkmark.
- **Voting overlay**: Full-screen modal that appears during voting phase. Shows "AI players are voting..." with a countdown timer (10 seconds). No vote buttons — AI voting is server-side only. Humans are spectators.
- **End screen overlay**: Full-screen takeover. Shows "HUMANS WIN", "AIs WIN", or "[NAME] IS THE SOLE SURVIVOR" in large text. Lists all players with their true identity revealed. RETURN button.

---

## 6. Ollama Integration Details

### OllamaClient.js

```js
export async function getModels() { ... }           // GET /api/tags → string[]
export async function chat(model, messages) { ... } // POST /api/chat → string (assistant reply)
export function getCachedModels() { ... }           // Returns cached model list
```

- `chat()` must handle Ollama errors gracefully. If Ollama is unreachable or returns an error, log the error server-side and return a fallback string `"..."` so the game is not blocked.
- Set a **timeout of 30 seconds** on chat requests, 5 seconds on model list requests (via `AbortController`).
- Model list is polled every 30s via `setInterval`, cached in a module-level variable. `getModels()` also refreshes on demand with debounce.
- The `messages` array passed to `/api/chat` must include the system prompt as the first message with `role: "system"`.
- Default Ollama URL: `http://192.168.1.30:11434` (configurable via `OLLAMA_BASE_URL`).

### Docker Network

- Docker Compose uses a fixed IP binding (`192.168.1.32:3000:3000`), custom bridge network `cogito-net`, `cap_drop: ALL`, and `no-new-privileges:true`.
- The Ollama base URL must be configurable via `OLLAMA_BASE_URL` (default: `http://192.168.1.30:11434`).
- No `extra_hosts` / `host.docker.internal` — the default Ollama URL points directly to the LAN IP of the Ollama host.

---

## 7. Docker Setup

### Dockerfile

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "server/index.js"]
```

### docker-compose.yml

```yaml
services:
  app:
    build: .
    ports:
      - "192.168.1.32:3000:3000"
    environment:
      - NODE_ENV=production
      - OLLAMA_BASE_URL=http://192.168.1.30:11434
      - PORT=3000
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    networks:
      - cogito-net
    restart: unless-stopped

networks:
  cogito-net:
    name: cogito-net
    driver: bridge
```

No database. No volumes. No external services other than Ollama. The specific IP bindings are for the deployment environment — adjust for your network.

---

## 8. Coding Standards

### General

- **No TypeScript**. Plain JavaScript ES Modules only.
- **No external CSS frameworks** (no Tailwind, no Bootstrap). All styling is hand-written in `matrix.css`.
- **No frontend build tools** (no Webpack, no Vite, no Rollup). The frontend is served as static files directly by Express.
- **No ORM, no database**. All state lives in memory on the server. If the server restarts, the game resets. This is by design.
- Every file must have a **one-line comment at the top** describing what it does.
- Functions must have **JSDoc comments** if they are longer than 10 lines or have non-obvious parameters.

### Error Handling

- All async functions must have `try/catch` blocks.
- Socket.IO event handlers must wrap their logic in `try/catch` and emit an `error` event back to the client on failure.
- Ollama failures must **never crash the game**. Always return a fallback.

### Security / Validation

- All socket event payloads must be **validated server-side** before processing. Reject malformed payloads with an `error` event.
- Sanitize all user-supplied text (player names, messages) to prevent XSS. Strip HTML tags server-side before broadcasting.
- Player names: max 20 characters, alphanumeric + spaces only.
- Messages: max 500 characters.

### State Management

- All game state lives in `GameSession.js`. Never store game state in Socket.IO event handlers.
- The server emits the **full state snapshot** (`game:state`) to newly connecting clients and after every state transition, so any reconnecting client can fully reconstruct the UI.

---

## 9. Git Workflow

### Branching Strategy

- `main` — always deployable. Protected. No direct commits.
- All feature branches branch **from `develop`** and merge back to `develop`. Never touch `main`.
- Use git worktrees for parallel features:
  `git worktree add -b <branch-name> ./worktrees/<branch-name> develop`
- `worktrees/` is in `.gitignore`.

### Commit Message Format

Use **Conventional Commits**:

```
<type>(<scope>): <short description>

[optional body]
```

Types: `feat`, `fix`, `chore`, `docs`, `style`, `refactor`, `test`

Examples:
```
feat(game): implement simultaneous submit/reveal phases
fix(ollama): handle timeout on chat API call
chore(docker): bind to specific IP for deployment
docs(readme): update game flow description
```

### What to Commit

- Commit **logical units of work** — not "WIP" dumps.
- Never commit `node_modules/`, `.env` files, or OS junk files (`.DS_Store`, `Thumbs.db`).
- The `.gitignore` must include: `node_modules/`, `.env`, `*.log`, `.DS_Store`.

---

## 10. Implementation Order

The agent must implement features in this order. Do not skip ahead. Verify each phase works before proceeding.

### Phase 1 — Skeleton
- [ ] `package.json` with all dependencies
- [ ] `Dockerfile` and `docker-compose.yml`
- [ ] `server/index.js` — Express server, static file serving, Socket.IO init
- [ ] `client/index.html` and `client/game.html` — bare HTML shells
- [ ] Verify: `docker compose up` serves both pages

### Phase 2 — Ollama Integration
- [ ] `server/ollama/OllamaClient.js` — `getModels()`, `getCachedModels()`, and `chat()`
- [ ] `server/ollama/prompts.js` — all prompt builder functions
- [ ] REST endpoint `GET /api/models` on the Express server (calls `getModels()`)
- [ ] Verify: hitting `/api/models` returns the list of local Ollama models

### Phase 3 — Lobby
- [ ] `server/game/Player.js` — Player model
- [ ] `server/game/GameManager.js` — singleton session manager
- [ ] `server/game/GameSession.js` — LOBBY state, player list, host assignment
- [ ] `server/game/topics.js` — topic list
- [ ] `server/socket/handlers.js` — `lobby:setName`, `lobby:start` events
- [ ] `client/js/lobby.js` — join form, host config panel, player list, model dropdowns
- [ ] Matrix CSS — full theme applied to lobby screen
- [ ] Verify: two browser tabs can join, one is host, host can configure AI players, start button works

### Phase 4 — Game Loop
- [ ] `GameSession.js` — SUBMITTING/REVEALING states, simultaneous AI generation, message storage
- [ ] Socket handlers — `game:sendMessage`, AI batch triggering
- [ ] `client/js/game.js` — chat display, submit input gating, countdown timers
- [ ] Typing animation for all messages (sender skips animation)
- [ ] Verify: simultaneous submit works — humans type while AIs generate, all revealed together

### Phase 5 — Voting
- [ ] `GameSession.js` — VOTING_SOON/VOTING states, AI-only vote collection via Ollama, resolution
- [ ] `client/js/game.js` — voting overlay (spectator mode), countdown timer
- [ ] Verify: voting resolves correctly, tie handling works, reveal shows

### Phase 6 — Win / Loss & Reset
- [ ] `GameSession.js` — ENDED state, win condition checks
- [ ] End screen overlay in `game.html` (solo survivor / humans win / AIs win)
- [ ] `game:returnToLobby` handler and `GameManager` reset
- [ ] Verify: both win and lose paths work and return to lobby

### Phase 7 — Polish
- [ ] Matrix rain canvas (`matrixRain.js`)
- [ ] Scanline overlay, flicker animations, glow effects
- [ ] Sound effects via Web Audio API (`sfx.js`) — programmatic, no audio files
- [ ] Mobile responsiveness (collapsible player list)
- [ ] Host disconnection → host reassignment (lobby only)
- [ ] Player disconnection and reconnection mid-game (`game:rejoin`)

---

## 11. Dependencies

```json
{
  "dependencies": {
    "express": "^4.18.0",
    "socket.io": "^4.7.0",
    "node-fetch": "^3.3.0"
  }
}
```

No other runtime dependencies. `node-fetch` is used in `OllamaClient.js` for HTTP requests to the Ollama API.

No test framework is required for this project. Manual testing per phase is sufficient.

---

## 12. Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port the server listens on |
| `OLLAMA_BASE_URL` | `http://192.168.1.30:11434` | Base URL for the Ollama API |
| `NODE_ENV` | `development` | Set to `production` in Docker |

Read via `process.env` in `server/index.js`. No `.env` file is required — defaults are hardcoded as fallbacks.

---

*For agent workflow, commands, and up-to-date gotchas, see `AGENTS.md`.*
