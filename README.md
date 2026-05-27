# 🟢 COGITO — AI Social Deduction Game

> *"Cogito ergo sum. But do you?"*

A real-time, browser-based social deduction game where humans and LLMs engage in conversation — and everyone is trying to figure out who is real. Styled after the Matrix: neon green on black, terminal flicker, and the constant dread that the machine might be smarter than you.

---

## 🎮 What Is This?

**Cogito** is a Mafia-style social deduction game played in a shared chat room.

- **Humans** try to blend in and identify which players are AIs before the AIs identify them.
- **LLMs** try to pass as human while voting out the real humans.
- After the first two full rounds, voting occurs at the end of every subsequent round — LLMs vote out who they think is human, humans vote out who they think is AI.
- The game ends when all AIs are eliminated (humans win) or all humans are eliminated (AIs win).

Players join from their phones or browsers — no accounts, no login. Just a code, a name, and your wits.

---

## 🧱 Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express |
| Real-time | Socket.IO |
| Frontend | Vanilla HTML/CSS/JS (no framework) |
| AI Models | Ollama (local, self-hosted) |
| Containerization | Docker + Docker Compose |

See [DEVELOPMENT.md](./DEVELOPMENT.md) for architecture details and coding standards.

---

## 🚀 Quick Start

### Prerequisites

- [Docker](https://www.docker.com/) and Docker Compose installed
- [Ollama](https://ollama.ai/) running locally on port `11434`
- At least one model pulled in Ollama (e.g. `ollama pull llama3`)
- At least 2 human players and 1 AI player to start a game

### Run the Game

```bash
git clone https://github.com/yourname/cogito-game.git
cd cogito-game
docker compose up --build
```

Then open `http://localhost:3000` in your browser.

To let other players join from phones on the same network, share your local IP:

```
http://192.168.x.x:3000
```

---

## 🎲 How to Play

1. **Host** opens the app and is automatically assigned host privileges.
2. Host configures: topic (or random), number of AI players, and which Ollama model each AI uses.
3. Host hits **START** when at least 2 humans and 1 AI are in the lobby.
4. At game start, AI players automatically generate their own names.
5. **Other humans** join via the same URL and pick their names.
6. Players take turns sending one message per round on a shared topic.
7. From round 3 onwards, a voting phase occurs after every round:
   - LLMs privately and simultaneously vote on who they think is human.
   - Humans vote on who they think is AI — votes are visible to all human players.
   - The player with the majority vote from each side is eliminated (or no one, on a tie).
   - It is then revealed whether each eliminated player was human or AI.
8. Game ends when all AIs or all humans are eliminated.

Full rules: [RULES.md](./RULES.md)

---

## 🗂️ Project Structure

```
cogito-game/
├── server/                  # Node.js backend
│   ├── index.js             # Entry point
│   ├── game/                # Game state machine
│   ├── ollama/              # Ollama API integration
│   └── socket/              # Socket.IO event handlers
├── client/                  # Static frontend
│   ├── index.html           # Join/lobby screen
│   ├── game.html            # In-game chat screen
│   ├── css/
│   │   └── matrix.css       # Matrix theme
│   ├── js/
│   │   ├── lobby.js
│   │   ├── game.js
│   │   └── sfx.js           # Sound effects
│   └── assets/
│       └── sounds/          # Vote/eliminate/win/lose SFX
├── docker-compose.yml
├── Dockerfile
├── README.md
├── RULES.md
└── DEVELOPMENT.md
```

---

## 🌐 Ollama Setup

The game connects to Ollama at `http://host.docker.internal:11434` (so the Docker container can reach your local Ollama instance).

Pull models before starting:

```bash
ollama pull llama3
ollama pull mistral
ollama pull gemma
```

The host will see all available models in the game lobby configuration panel.

---

## 📜 License

MIT. Go wild. Just don't let the AIs know.
