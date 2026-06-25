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

- All players (human and AI) write **simultaneously** — one message per round. There is no turn order.
- The round opens with a **SUBMITTING** phase (15 seconds). All players type and send their message at the same time.
- After the timer expires (or when all active players have submitted), messages are **revealed together** in a **REVEALING** phase (10 seconds).
- Eliminated players and disconnected players are excluded from submission.
- The shared **discussion topic** is displayed at the top of the chat at all times.
- AI players receive the full chat history and are prompted to respond naturally, mimicking a human participant.
- All players can see the **entire chat history** at all times.

**Round counting:**
- A "round" is complete when every active player has sent one message.
- Voting does **not** begin until **2 full rounds** have been completed (i.e. voting first occurs after round 2, starting from round 3).

---

### Phase 2 — Voting (Begins After Round 2, Repeats Every Round)

After every round starting from round 3, a **Voting Phase** occurs. There is a 5-second **VOTING_SOON** warning, followed by a **VOTING** phase (10 seconds).

#### 🗳️ Combined Vote (AIs and humans both vote)
- Each AI player independently ranks all active players from most to least suspicious (most likely human, to least).
- Each active human player casts a **single vote** for the one other player they want eliminated — you cannot vote for yourself.
- A human's vote counts as much as an AI's top pick — it's not just a tiebreaker, it can decide the outcome outright.
- Humans incentive: vote out other humans to become the **sole survivor**, or rally with other humans to vote out every AI for a **Humans Win**.
- All AI rankings and human votes are collected in parallel with a 10-second timeout. Players who don't vote in time simply contribute nothing that round.
- The player with the highest combined score is eliminated. On a tie, a tiebreak cascade applies; if it's still unresolved, no one is eliminated.

#### 📢 Reveal
After votes are resolved, a reveal shows:
- Who (if anyone) was eliminated — and whether they were **Human** or **AI**.

All players see this reveal simultaneously. The game continues with a 3-second delay before the next round begins.

---

### Phase 3 — Win / Loss Conditions

The game ends **immediately** after a voting phase resolves:

| Condition | Result |
|---|---|---|
| Only **one human player** remains | 🏆 **Sole Survivor** — that human wins instantly, even if AI players are still alive |
| All **AI players** have been eliminated (2+ humans remain) | 🏆 **Humans Win** |
| All **Human players** have been eliminated | 💀 **AIs Win** |

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
  - Know they are an AI in a group chat with other AIs.
  - Know some participants are **humans pretending to be AIs** — those are the targets.
  - Engage naturally with the topic and with other players' messages.
  - Cast their vote based on analyzing which players seem most human-like.
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
| A human disconnects mid-game | They are marked as disconnected and excluded from active players. In SUBMITTING phase, remaining players may trigger early resolve when all have submitted. |
| Only one human player remains | Game ends immediately as a Sole Survivor win for that human — even if AI players are still alive. |
| Only one AI player remains, no humans left | AIs win (all humans already eliminated). |
| Host disconnects in lobby | The next human in the lobby is promoted to Host. |
| Host disconnects during the game | They are treated as a disconnected player. No host promotion occurs during gameplay. |
| No AI models available in Ollama | The lobby shows an error. The host cannot configure AI players until Ollama is reachable. |
| A human disconnects and reconnects mid-game | They can rejoin via `game:rejoin` and resume playing if not eliminated. |
| Two AI players generate the same name | The server retries name generation until all AI names are unique before the game begins. |
