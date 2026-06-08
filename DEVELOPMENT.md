# 🛠️ DEVELOPMENT.md — Coding Agent Instructions

This document is the authoritative guide for the coding agent implementing Cogito. Read it entirely before writing a single line of code. Follow every instruction precisely.

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
│   │   ├── GameSession.js        # Game state machine (lobby → playing → voting → ended)
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
- When a game ends and all players return to the lobby, `GameManager` resets and is ready for a new session.

### Host Assignment

- The **first human** to connect (via Socket.IO) is assigned as Host.
- Host status is tracked server-side in `GameSession` and in `GameManager` (for pre-session assignment).
- If the Host disconnects **during the lobby**, the next connected human is promoted to Host. Emit a `host:assigned` event to the new host's socket.
- If the Host disconnects **during the game**, they are treated as any other disconnected player. No host promotion during gameplay.
- The server sends `isHost: true/false` to each client on connection and on host reassignment.

### Socket.IO Events

Define and implement these events precisely. Do not rename them.

#### Client → Server

| Event | Payload | Description |
|---|---|---|
| `lobby:setName` | `{ name: string }` | Human player sets their display name |
| `lobby:start` | — | Host starts the game |
| `game:sendMessage` | `{ text: string }` | Player sends their turn message |
| *(removed)* | — | Humans no longer vote — only AIs vote |
| `game:returnToLobby` | — | Player confirms they saw the end screen |

#### Server → Client

| Event | Payload | Description |
|---|---|---|
| `lobby:state` | `{ players: Player[], isHost: bool, models: string[] }` | Full lobby state snapshot |
| `host:assigned` | — | Sent to the new host socket only |
| `game:state` | `{ players, messages, round, phase, turnOrder, currentTurn }` | Full game state snapshot |
| `game:newMessage` | `{ playerId, playerName, text, timestamp }` | A new chat message |
| `game:voteStart` | `{ roundNumber }` | Voting phase has begun |
| `game:voteResult` | `{ eliminated: Player\|null }` | Vote resolution (single eliminated player) |
| `game:ended` | `{ winner: 'humans'\|'ais', players: Player[] }` | Game over |
| `error` | `{ message: string }` | Server-side error to display to client |

### Game State Machine

`GameSession` has these states. Transitions are enforced server-side:

```
LOBBY → PLAYING → VOTING → PLAYING (loop) → ENDED
```

- **LOBBY**: Players joining, host configuring. No messages.
- **PLAYING**: Round-robin messages. After each full round, check if we've hit round 2 yet. If yes, transition to VOTING after the last player's message.
- **VOTING**: Only AIs vote (via Ollama API calls, made server-side). Humans are spectators. Once all AI votes collected (or 10s timeout), resolve, emit `game:voteResult`, check win condition. If game continues, transition to PLAYING.
- **ENDED**: Emit `game:ended`. Wait for all clients to confirm `game:returnToLobby`, then reset `GameManager`.

---

## 4. AI Player Implementation

### Name Generation

When the host presses START, before the first round begins, for each AI player:
1. Call Ollama `/api/chat` with a short prompt instructing the model to respond with only a realistic human first name.
2. Strip any extra text from the response. Use the name as the AI player's display name.
3. Ensure no two AI players share the same name. Retry if a duplicate is generated.

### Conversational Memory (Per-AI Persistent History)

Each AI player maintains a **persistent message history array** (`player.messageHistory`) that lives on the `Player` instance for the entire game. This is the array passed directly to Ollama's `/api/chat` each turn — Ollama uses it to maintain contextual memory without needing a full chat dump.

Lifecycle:
1. **At game start**, each AI player's history is initialized with a single system message:
   ```js
   player.messageHistory = [
     { role: "system", content: buildSystemPrompt(playerName, topic, allPlayerNames) }
   ];
   ```
2. **After every round** (once all players have sent their message), append that round's messages to every AI player's history as a single `user` turn, formatted as a readable transcript:
   ```
   [PlayerA]: their message
   [PlayerB]: their message
   [PlayerC]: their message
   ```
   This keeps the history compact — one `user` entry per round, not one per message.
3. **When it is an AI player's turn to speak**, append a `user` prompt like `"It is your turn to respond."` to their history, call `/api/chat` with the full `player.messageHistory`, then append the model's reply as an `assistant` entry to their history.
4. **Do not** rebuild or replay the entire chat log each turn. The history grows naturally and Ollama retains context across turns.

### Turn Generation

When it is an AI player's turn:
1. Append the latest round transcript to `player.messageHistory` (as described above).
2. Append `{ role: "user", content: "It is your turn to respond." }` to `player.messageHistory`.
3. Call `/api/chat` with `stream: false`, passing `player.messageHistory` as the `messages` array.
4. Append the model's reply as `{ role: "assistant", content: reply }` to `player.messageHistory`.
5. Emit the response as `game:newMessage` to all clients.

### Voting

When the voting phase begins:
1. For each AI player, append a `user` message to their `player.messageHistory` containing the voting prompt (from `buildVotePrompt()`), which instructs the model to vote for the player it believes is most likely human.
2. The prompt must instruct the model to respond with **only the exact player name** — nothing else.
3. Call `/api/chat` with the player's existing `player.messageHistory` — do not rebuild history from scratch. The model already has full context from the game.
4. Append the model's vote response as `{ role: "assistant", content: reply }` to their history.
5. Parse the response, match it against the active player list (case-insensitive), and record the vote.
6. If the response cannot be matched to a valid active player, the AI's vote is considered **abstained** (not counted).
7. All AI votes are collected in parallel (use `Promise.all`).

### Prompts

All prompts live in `server/ollama/prompts.js`. No prompt strings should appear anywhere else. Export named functions:

```js
export function buildSystemPrompt(playerName, topic, allPlayerNames) { ... }
export function buildVotePrompt(playerName, activePlayerNames) { ... }
export function buildNamePrompt() { ... }
```

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
- This is implemented by the server emitting `game:newMessage` to **all clients including the sender**, but the sender's client checks `message.playerId === myPlayerId` and skips the animation for their own messages only.
- This ensures no client can distinguish human from AI messages by animation behavior.
- Add a faint `>` prefix to all messages in the terminal style.

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
- **Top bar**: Game topic, current round number, phase indicator (DISCUSSION / VOTING).
- **Chat area**: Scrollable message history. Each message: `[PlayerName] > message text`. Eliminated players' messages are visually dimmed (50% opacity). Eliminated players have a `[TERMINATED]` tag next to their name.
- **Input area**: Text input + SEND button. Disabled when it is not the current player's turn. Shows whose turn it currently is.
- **Player list sidebar** (desktop) / **collapsible panel** (mobile): Shows all players, their status (active / eliminated), and whose turn it is (highlighted).
- **Voting overlay**: Full-screen modal that appears during voting phase. Shows a list of active players with VOTE buttons. Human players submit one vote. Countdown timer (30 seconds). After voting or timeout, show "WAITING FOR VOTES..." spinner.
- **End screen overlay**: Full-screen takeover. Shows WIN or LOSE in giant glitchy text. Lists all players with their true identity revealed. RETURN button.

---

## 6. Ollama Integration Details

### OllamaClient.js

```js
// Implement these methods:
export async function getModels() { ... }           // GET /api/tags → string[]
export async function chat(model, messages) { ... } // POST /api/chat → string (assistant reply)
```

- `chat()` must handle Ollama errors gracefully. If Ollama is unreachable or returns an error, log the error server-side and return a fallback string like `"..."` so the game is not blocked.
- Set a **timeout of 30 seconds** on all Ollama requests. If exceeded, return the fallback.
- The `messages` array passed to `/api/chat` must include the system prompt as the first message with `role: "system"`.

### Docker Network

- In `docker-compose.yml`, add `extra_hosts: ["host.docker.internal:host-gateway"]` to allow the container to reach the host's Ollama instance.
- The Ollama base URL must be configurable via an environment variable `OLLAMA_BASE_URL` (default: `http://host.docker.internal:11434`).

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
version: '3.9'
services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - OLLAMA_BASE_URL=http://host.docker.internal:11434
      - PORT=3000
    extra_hosts:
      - "host.docker.internal:host-gateway"
    restart: unless-stopped
```

No database. No volumes. No external services other than Ollama.

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

Use **GitHub Flow** (simple, linear):

- `main` — always deployable. Protected. No direct commits.
- `feat/<feature-name>` — feature branches.
- `fix/<issue>` — bug fix branches.

Merge via pull requests only.

### Commit Message Format

Use **Conventional Commits**:

```
<type>(<scope>): <short description>

[optional body]
```

Types: `feat`, `fix`, `chore`, `docs`, `style`, `refactor`, `test`

Examples:
```
feat(game): implement round-robin turn order
fix(ollama): handle timeout on chat API call
chore(docker): add host-gateway extra_hosts config
docs(readme): update quick start instructions
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
- [ ] `server/ollama/OllamaClient.js` — `getModels()` and `chat()`
- [ ] `server/ollama/prompts.js` — all prompt builder functions
- [ ] REST endpoint `GET /api/models` on the Express server (calls `getModels()`)
- [ ] Verify: hitting `/api/models` returns the list of local Ollama models

### Phase 3 — Lobby
- [ ] `server/game/Player.js` — Player model
- [ ] `server/game/GameManager.js` — singleton session manager
- [ ] `server/game/GameSession.js` — LOBBY state, player list, host assignment
- [ ] `server/game/topics.js` — topic list
- [ ] `server/socket/handlers.js` — `lobby:setName`, `lobby:configure`, `lobby:start` events
- [ ] `client/js/lobby.js` — join form, host config panel, player list, model dropdowns
- [ ] Matrix CSS — full theme applied to lobby screen
- [ ] Verify: two browser tabs can join, one is host, host can configure AI players, start button works

### Phase 4 — Game Loop
- [ ] `GameSession.js` — PLAYING state, round-robin turns, message storage
- [ ] Socket handlers — `game:sendMessage`, AI turn triggering
- [ ] `client/js/game.js` — chat display, turn indicator, input gating
- [ ] Typing animation for AI messages
- [ ] Verify: full round-robin works with humans and AIs taking turns

### Phase 5 — Voting
- [ ] `GameSession.js` — VOTING state, AI vote collection, human vote collection, resolution
- [x] Socket handlers — `game:vote` (removed — humans no longer vote)
- [ ] `client/js/game.js` — voting overlay, countdown timer
- [ ] Verify: voting resolves correctly, reveal shows, game continues

### Phase 6 — Win / Loss & Reset
- [ ] `GameSession.js` — ENDED state, win condition checks
- [ ] End screen overlay in `game.html`
- [ ] `game:returnToLobby` handler and `GameManager` reset
- [ ] Verify: both win and lose paths work and return to lobby

### Phase 7 — Polish
- [ ] Matrix rain canvas (`matrixRain.js`)
- [ ] Scanline overlay, flicker animations, glow effects
- [ ] Sound effects via Web Audio API (`sfx.js`)
- [ ] Mobile responsiveness (collapsible player list, touch-friendly vote buttons)
- [ ] Host disconnection → host reassignment
- [ ] Player disconnection handling mid-game
- [ ] Edge case: all AIs on a voting tie

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
| `OLLAMA_BASE_URL` | `http://host.docker.internal:11434` | Base URL for the Ollama API |
| `NODE_ENV` | `development` | Set to `production` in Docker |

Read via `process.env` in `server/index.js`. No `.env` file is required — defaults are hardcoded as fallbacks.

---

*This document is the single source of truth for the coding agent. When in doubt, prefer simplicity, prefer server-side logic, and prefer the Matrix aesthetic.*
