# 📜 RULES.md — Cogito: Game Rules & Flow

---

## Overview

Cogito is a **social deduction game** played between human players and AI players (LLMs running on a local Ollama instance). All players communicate through a shared chat interface on a randomly selected topic. The goal is simple — figure out who is real, and survive.

---

## Players

| Type | Description |
|---|---|
| **Human Players** | Real people joining via browser. Minimum 2, maximum 16. |
| **AI Players** | LLMs configured by the host. Minimum 1, maximum 8. |
| **Host** | The first human to open the app. Has special lobby configuration powers. Is still a regular player during the game. |

A game cannot start with fewer than 2 human players and 1 AI player.

---

## Game Flow

### Phase 0 — Lobby

1. The **first human** to visit the app URL is assigned as **Host**.
2. The Host configures the game:
   - Select a **discussion topic**, or leave it on **random**.
   - Choose the **number of AI players** (minimum 1, maximum 8).
   - For each AI slot, select a **model** from the list of available Ollama models.
3. Other human players visit the same URL, see the lobby, and **choose their own names**.
4. The Host can see the **full player list**, including which entries are human and which are AI (only the host sees this distinction in the lobby).
5. The **START button** is disabled until at least 2 humans and 1 AI are in the lobby.
6. When the Host is satisfied, they press **START**. AI players **automatically generate their own names** at this point.

---

### Phase 1 — Discussion Rounds

- All players (human and AI) take turns sending **one message per round** in a fixed **round-robin order**.
- Turn order is randomized at game start and stays fixed for the entire game.
- Eliminated players are skipped in the turn order.
- The shared **discussion topic** is displayed at the top of the chat at all times.
- AI players receive the full chat history and are prompted to respond naturally, mimicking a human participant.
- All players can see the **entire chat history** at all times.

**Round counting:**
- A "round" is complete when every active player has sent one message.
- Voting does **not** begin until **2 full rounds** have been completed (i.e. voting first occurs after round 2, starting from round 3).

---

### Phase 2 — Voting (Begins After Round 2, Repeats Every Round)

After every round starting from round 3, a **Voting Phase** occurs. It has two simultaneous sub-votes:

#### 🤖 AI Vote (LLMs vote out a human)
- Each AI player independently votes for the player they believe is **most likely human**.
- Votes are submitted privately and simultaneously — human players cannot see individual AI votes.
- The player receiving the **most AI votes** is eliminated.
- On a **tie**, no one is eliminated from this vote.

#### 🧠 Human Vote (Humans vote out an AI)
- Each surviving human player votes for the player they believe is **most likely an AI**.
- Votes are submitted through the UI and are **visible to all human players** as they come in.
- The player receiving the **most human votes** is eliminated.
- On a **tie**, no one is eliminated from this vote.

#### Vote Resolution Order
Both votes are collected simultaneously. Resolution follows this order:
1. All human votes are collected (30-second window).
2. All AI votes are collected in parallel.
3. Both votes are resolved at the same time. A player eliminated by the AI vote still has their human vote counted — votes are not retracted on elimination.
4. The **reveal screen** is shown.

#### 📢 Reveal
After both votes are resolved, a **reveal screen** shows:
- Who (if anyone) was eliminated by AI vote — and whether they were **Human** or **AI**.
- Who (if anyone) was eliminated by human vote — and whether they were **Human** or **AI**.

All players see this reveal simultaneously before the next round begins.

---

### Phase 3 — Win / Loss Conditions

The game ends **immediately** after a voting phase resolves:

| Condition | Result |
|---|---|
| All **AI players** have been eliminated | 🏆 **Humans Win** |
| All **Human players** have been eliminated | 💀 **AIs Win** |
| The last remaining AI and last remaining Human are eliminated in the same vote | 💀 **AIs Win** (tie goes to the machines — if no humans survive, there is no one left to claim victory) |

- If neither condition is met after a vote, the game continues into the next discussion round.
- There is **no round limit** — the game ends only when one side is fully eliminated.

---

## Win & Loss Screens

- All connected human players see a **Win** or **Loss** screen simultaneously.
- The screen includes a full list of all players and their true identities (Human / AI + model name).
- After a short delay (or when all players confirm), **everyone is returned to the lobby/join screen**.
- The game session resets. A new host is assigned to whoever joins first.

---

## Topic Selection

Topics are pulled from a pre-defined list of neutral, discussion-friendly subjects. Examples:

- "Would you rather live in the city or the countryside?"
- "What makes a piece of music unforgettable?"
- "Is it ever okay to lie to someone you love?"
- "What makes a great leader?"
- "If you could master one skill instantly, what would it be?"

The Host may override the random selection with any topic from the list, or leave it to chance.

---

## AI Player Behavior

- AI players are given a **system prompt** that instructs them to:
  - Behave as a human participant in a casual conversation.
  - Not reveal they are an AI.
  - Engage naturally with the topic and with other players' messages.
  - Cast their vote based on analyzing which players seem most human.
- AI players' **names are self-generated** at game start — the model is prompted to choose a realistic human first name before the first round begins.
- AI players vote **independently and simultaneously** — they do not coordinate with each other.
- As the number of active AI players decreases, the AI vote becomes proportionally less powerful. There is no minimum threshold — a single remaining AI casts a single vote, which can only eliminate a human on a majority of one (i.e. no other human received a vote).

---

## Host Privileges (Lobby Only)

The host has exclusive access to:
- Topic configuration panel
- AI player count (1–8) and model selection
- The START button (enabled only when the lobby has ≥ 2 humans and ≥ 1 AI)
- Full visibility of which lobby entries are human vs. AI

Once the game starts, **the host is just another player**. No special powers in-game.

---

## Edge Cases

| Scenario | Behavior |
|---|---|
| A human disconnects mid-game | They are treated as eliminated and skipped in turn order. Their slot is marked as disconnected. |
| Only one player remains (any type) | Game ends immediately. AIs win if the last player is AI; Humans win if the last player is Human. |
| Host disconnects in lobby | The next human in the lobby is promoted to Host. |
| Host disconnects during the game | They are treated as a disconnected player. No host promotion occurs during gameplay. |
| No AI models available in Ollama | The lobby shows an error. The host cannot configure AI players until Ollama is reachable. |
| A human is eliminated by AI vote during the same round they cast their human vote | Their human vote is still counted — votes are not retracted on elimination. |
| Two AI players generate the same name | The server retries name generation until all AI names are unique before the game begins. |
