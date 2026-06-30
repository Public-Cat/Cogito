import { randomInt } from 'node:crypto';
import { Player } from './Player.js';
import { topics as topicList } from './topics.js';
import { chat } from '../ollama/OllamaClient.js';
import { buildSystemPrompt, buildTurnPrompt, buildRankingPrompt, buildNamePrompt } from '../ollama/prompts.js';

const PERSONALITIES = ['skeptical', 'enthusiastic', 'thoughtful', 'dry', 'curious', 'anxious'];

// Charset for shareable session codes: uppercase A-Z + digits 2-9, minus the
// visually ambiguous O/0/I/1/L so codes are easy to read aloud and type.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Generate a random 6-character session code from CODE_CHARS. */
function generateSessionCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_CHARS[randomInt(CODE_CHARS.length)];
  return code;
}

// Duration of the VOTING phase before rankings/votes are force-resolved.
const VOTE_TIMEOUT_MS = 40000;
const SUBMIT_PHASE_MS = 45000;

// Max simultaneous in-flight requests to Ollama. Bounds load when many AIs
// are configured; semantics (results/timeouts per task) are unchanged —
// this only throttles how many run at once.
const MAX_CONCURRENT_OLLAMA_CALLS = 4;

/**
 * Run `tasks` (functions returning promises) with at most `limit` in flight
 * at a time. Resolves to an array of results in the same order as `tasks`,
 * matching Promise.all's contract (rejects on first rejection).
 * @param {Array<() => Promise<any>>} tasks
 * @param {number} limit
 * @returns {Promise<any[]>}
 */
function promisePool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  return Promise.all(workers).then(() => results);
}

const STATES = {
  LOBBY: 'LOBBY',
  SUBMITTING: 'SUBMITTING',
  REVEALING: 'REVEALING',
  VOTING_SOON: 'VOTING_SOON',
  VOTING: 'VOTING',
  ENDED: 'ENDED',
};

export class GameSession {
  constructor() {
    this.state = STATES.LOBBY;
    // Per-session join code, shown only to the host so they can share it with
    // public-realm friends. Regenerated whenever a new session is created
    // (i.e. on reset / return-to-lobby, which null and recreate the session).
    this.sessionCode = generateSessionCode();
    this.players = [];
    this.messages = [];
    this.topic = '';
    this.round = 0;
    this.aiRankings = new Map();
    this.humanVotes = new Map();
    this.emitToAll = null;
    this.emitToSocket = null;
    this.submittedPlayerIds = new Set();
    this.pendingMessages = [];
    this.submitTimer = null;
    this.revealTimer = null;
    this.voteSoonTimer = null;
    this.voteTimeout = null;
    this.postVoteTimer = null;
    this.aiRankingsResolved = false;
    // Idempotency guard for resolveRankings — set true when a voting round is
    // resolved, reset in startVoting, so a late AI ranking arriving in the 3s
    // postVoteTimer window cannot double-eliminate or duplicate game:voteResult.
    this.votingResolved = false;
    this.bordaHistory = new Map();
    this.lastElimination = null;
    this.lastRoundMessages = [];
    // Set once by endGame() so a player who refreshes after the game ends
    // (re-entering via game:rejoin, which only replays game:state) still
    // gets the winner/reveal payload instead of being stuck in the chat view.
    this.endResult = null;
  }

  addPlayer(id, isHuman, socketId) {
    const player = new Player(id, isHuman, socketId);
    this.players.push(player);
    return player;
  }

  removePlayer(socketId) {
    const idx = this.players.findIndex(p => p.socketId === socketId);
    if (idx === -1) return null;
    const player = this.players[idx];
    this.players.splice(idx, 1);
    return player;
  }

  getPlayerBySocket(socketId) {
    return this.players.find(p => p.socketId === socketId) || null;
  }

  getPlayer(id) {
    return this.players.find(p => p.id === id) || null;
  }

  getActiveHumans() {
    return this.players.filter(p => p.isHuman && !p.isEliminated && !p.isDisconnected);
  }

  getActiveAIs() {
    return this.players.filter(p => !p.isHuman && !p.isEliminated);
  }

  getActivePlayers() {
    return this.players.filter(p => !p.isEliminated && !p.isDisconnected);
  }

  assignHost() {
    // Only LAN-realm humans (trusted, behind the reverse proxy's header) may
    // host — hosting grants privileged control (lobby:reset, lobby:start).
    // Public-realm players never become host; if none qualify, no host is
    // assigned (the game simply can't be started by a public player).
    const lanHumans = this.players.filter(p => p.isHuman && p.realm === 'lan');
    for (const p of this.players) p.isHost = false;
    if (lanHumans.length > 0) {
      lanHumans[0].isHost = true;
    }
  }

  getHost() {
    return this.players.find(p => p.isHost) || null;
  }

  handleDisconnect(socketId) {
    const player = this.getPlayerBySocket(socketId);
    if (!player) return;
    if (this.state === STATES.LOBBY) {
      this.removePlayer(socketId);
      if (player.isHost) this.assignHost();
    } else if (this.state === STATES.SUBMITTING || this.state === STATES.REVEALING
      || this.state === STATES.VOTING || this.state === STATES.VOTING_SOON) {
      player.isDisconnected = true;
      if (this.state === STATES.SUBMITTING) {
        this.submittedPlayerIds.delete(player.id);
        // If the remaining active players (excluding the now-disconnected one,
        // since isDisconnected was set above) have all submitted, resolve now
        // rather than idling for the full 45s timer. This prevents a submit-phase
        // stall when a player disconnects after everyone else has already sent.
        const remaining = this.getActivePlayers();
        if (remaining.length > 0 && remaining.every(p => this.submittedPlayerIds.has(p.id))) {
          this.resolveSubmitPhase();
        }
      }
    }
  }

  getLobbyState() {
    return {
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        isHuman: p.isHuman,
        isHost: p.isHost,
      })),
      models: [],
    };
  }

  getGameState() {
    return {
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        isHuman: p.isHuman,
        isEliminated: p.isEliminated,
        isDisconnected: p.isDisconnected,
      })),
      messages: this.messages,
      round: this.round,
      phase: this.state,
      topic: this.topic,
      submittedBy: [...this.submittedPlayerIds],
      activePlayerCount: this.getActivePlayers().length,
      endResult: this.state === STATES.ENDED ? this.endResult : null,
    };
  }

  /**
   * Ask the model for a human first name not already in `taken` (lowercased, case-insensitive).
   * Sanitizes to the allowed name charset, retries on duplicates/invalid/failed responses, and
   * falls back to a unique AI-xxxx handle if the model won't produce a fresh distinct name
   * (e.g. a model that deterministically returns the same name).
   * @param {string} model
   * @param {Set<string>} taken - lowercased names already in use
   * @returns {Promise<string>}
   */
  async generateUniqueAIName(model, taken) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const res = await chat(model, [{ role: 'user', content: buildNamePrompt() }]);
      const name = res.trim().split('\n')[0].replace(/[^a-zA-Z0-9 ]/g, '').trim().slice(0, 20);
      if (name && name !== '...' && !taken.has(name.toLowerCase())) return name;
    }
    let fallback;
    do { fallback = `AI-${Math.random().toString(36).slice(2, 6)}`; } while (taken.has(fallback.toLowerCase()));
    console.log(`[AI] ${model} name fallback "${fallback}" (no fresh distinct name)`);
    return fallback;
  }

  async startGame(config) {
    this.topic = config.topic || topicList[Math.floor(Math.random() * topicList.length)];
    this.messages = [];
    // isHost is intentionally left untouched here — it must remain stable
    // through the game so privileged mid-game actions (game:returnToLobby)
    // can still verify the original host. Only eliminated status resets.
    for (const p of this.players) {
      p.isEliminated = false;
    }
    const aiConfigs = config.aiPlayers || [];
    // Assign names sequentially so each AI's dedup sees the names already taken (a parallel
    // Promise.all races: siblings' names aren't set yet, so every AI collides — e.g. gemma3,
    // which always answers "Ethan"). Reserve names in a shared set as they're chosen.
    const takenNames = new Set(this.players.map(p => p.name.toLowerCase()));
    const aiPlayers = [];
    for (const cfg of aiConfigs) {
      const aiPlayer = this.addPlayer(`ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, false, null);
      aiPlayer.model = cfg.model;
      aiPlayer.name = await this.generateUniqueAIName(aiPlayer.model, takenNames);
      takenNames.add(aiPlayer.name.toLowerCase());
      aiPlayer.personality = PERSONALITIES[Math.floor(Math.random() * PERSONALITIES.length)];
      aiPlayers.push(aiPlayer);
      console.log(`[AI] ${aiPlayer.name} (${aiPlayer.model}) joined`);
    }
    // Build system prompts only after every name exists, so the "other AIs" list is complete.
    const allPlayerNames = this.players.map(p => p.name);
    for (const ai of aiPlayers) {
      ai.messageHistory = [
        { role: 'system', content: buildSystemPrompt(ai.name, this.topic, allPlayerNames, ai.personality) },
      ];
    }

    this.round = 0;
    this.bordaHistory = new Map();
    console.log(`[GAME] Game started | Topic: "${this.topic}" | Players: [${this.players.map(p => p.name).join(', ')}]`);
    this.startSubmitPhase();
  }

  startSubmitPhase() {
    this.state = STATES.SUBMITTING;
    this.submittedPlayerIds = new Set();
    this.pendingMessages = [];
    this.emitGameState();

    const activePlayers = this.getActivePlayers();
    if (activePlayers.length <= 1) {
      this.endGame();
      return;
    }

    const activeAIs = activePlayers.filter(p => !p.isHuman);
    // Fire-and-forget, but bounded: each generateAIMessage() already resolves
    // its own state independently, so we don't await this pool's result.
    promisePool(activeAIs.map(ai => () => this.generateAIMessage(ai)), MAX_CONCURRENT_OLLAMA_CALLS)
      .catch(err => console.error('AI message pool error:', err));

    this.submitTimer = setTimeout(() => this.resolveSubmitPhase(), SUBMIT_PHASE_MS);
  }

  /**
   * Build a one-line salience cue from last round's messages so an AI's next message
   * lands on the live thread (esp. accusations). Deterministic, no LLM call. Derived
   * ONLY from already-resolved prior-round messages — never the current round — so it
   * adds no information the AI wouldn't already have, preserving simultaneous-submit fairness.
   * @param {Player} ai - the AI about to generate
   * @returns {string|null} hint like "Alice suspects Sophia is the human", or null
   */
  buildDiscussionHint(ai) {
    const recent = this.lastRoundMessages;
    if (!recent || recent.length === 0) return null;
    const names = this.players.map(p => p.name);
    const SUSPICION = ['human', 'suspicious', 'suspect', 'pretend', 'impostor', 'imposter',
      'sus', 'bot', 'fake', 'accus', 'not an ai', 'is a human', 'real person'];

    // Prefer an active accusation: someone naming another player alongside a suspicion word.
    for (const m of recent) {
      if (m.playerId === ai.id) continue;
      const lower = m.text.toLowerCase();
      if (!SUSPICION.some(k => lower.includes(k))) continue;
      const named = names.find(n => n !== m.playerName && lower.includes(n.toLowerCase()));
      if (named) return `${m.playerName} suspects ${named} is the human`;
    }

    // Fallback: surface the last thing another player said so the AI replies to it.
    const others = recent.filter(m => m.playerId !== ai.id);
    const humanMsgs = others.filter(m => this.getPlayer(m.playerId)?.isHuman);
    const pick = (humanMsgs.length ? humanMsgs : others).slice(-1)[0];
    if (!pick) return null;
    const snippet = pick.text.split(/\s+/).slice(0, 12).join(' ');
    return `${pick.playerName} said: "${snippet}"`;
  }

  async generateAIMessage(ai) {
    // Capture the round counter before the async Ollama call so we can detect
    // stale replies that arrive after a round transition. CHAT_TIMEOUT_MS (60s)
    // > SUBMIT_PHASE_MS (45s), so a round-N chat can return during round-N+1
    // SUBMITTING and inject a stale message without this guard.
    const round = this.round;
    const turnPrompt = buildTurnPrompt(this.lastElimination, this.buildDiscussionHint(ai), this.round === 0);
    const messages = [...ai.messageHistory, { role: 'user', content: turnPrompt }];
    const reply = await chat(ai.model, messages);
    if (this.state !== STATES.SUBMITTING || this.round !== round) return;

    ai.messageHistory.push({ role: 'user', content: turnPrompt });
    ai.messageHistory.push({ role: 'assistant', content: reply });

    const msg = {
      playerId: ai.id,
      playerName: ai.name,
      text: reply,
      timestamp: Date.now(),
    };
    this.pendingMessages.push(msg);
    this.submittedPlayerIds.add(ai.id);

    if (this.submittedPlayerIds.size >= this.getActivePlayers().length) {
      this.resolveSubmitPhase();
    }
  }

  handleHumanSubmit(player, text) {
    if (this.state !== STATES.SUBMITTING) return false;
    if (player.isEliminated || player.isDisconnected) return false;
    if (this.submittedPlayerIds.has(player.id)) return false;

    const msg = {
      playerId: player.id,
      playerName: player.name,
      text,
      timestamp: Date.now(),
    };
    this.pendingMessages.push(msg);
    this.submittedPlayerIds.add(player.id);

    if (this.submittedPlayerIds.size >= this.getActivePlayers().length) {
      this.resolveSubmitPhase();
    }
    return true;
  }

  resolveSubmitPhase() {
    if (this.state !== STATES.SUBMITTING) return;
    this.clearTimers();

    for (const ai of this.getActiveAIs()) {
      const othersMsgs = this.pendingMessages.filter(m => m.playerId !== ai.id);
      if (othersMsgs.length > 0) {
        const transcript = othersMsgs.map(m => `[${m.playerName}]: ${m.text}`).join('\n');
        ai.messageHistory.push({ role: 'user', content: transcript });
      }
    }

    this.lastRoundMessages = [...this.pendingMessages];

    for (const msg of this.pendingMessages) {
      this.messages.push(msg);
      this.emitToAll('game:newMessage', msg);
    }
    this.pendingMessages = [];
    this.submittedPlayerIds = new Set();

    this.startRevealPhase();
  }

  startRevealPhase() {
    this.state = STATES.REVEALING;
    this.emitGameState();
    this.revealTimer = setTimeout(() => this.resolveRevealPhase(), 10000);
  }

  resolveRevealPhase() {
    if (this.state !== STATES.REVEALING) return;
    this.clearTimers();
    this.round++;
    console.log(`[GAME] Round ${this.round} completed`);

    const activePlayers = this.getActivePlayers();
    if (activePlayers.length <= 1) {
      this.endGame();
      return;
    }

    if (this.round >= 2) {
      this.state = STATES.VOTING_SOON;
      console.log(`[GAME] Round ${this.round} — voting starts in 5s`);
      this.emitToAll('game:votingSoon', { delay: 5 });
      this.emitGameState();
      this.voteSoonTimer = setTimeout(() => this.startVoting(), 5000);
    } else {
      this.startSubmitPhase();
    }
  }

  startVoting() {
    if (this.state !== STATES.VOTING_SOON) return;
    this.state = STATES.VOTING;
    console.log(`[GAME] Voting started (Round ${this.round})`);
    this.aiRankings = new Map();
    this.humanVotes = new Map();
    for (const human of this.getActiveHumans()) human.currentVote = null;
    this.voteTimeout = null;
    this.aiRankingsResolved = false;
    this.votingResolved = false;
    this.emitToAll('game:voteStart', { roundNumber: this.round });
    this.emitGameState();
    this.collectAIRankings();
    this.voteTimeout = setTimeout(() => {
      console.log(`[GAME] Voting timeout reached — forcing resolution`);
      this.aiRankingsResolved = true;
      this.tryResolveRankings();
    }, VOTE_TIMEOUT_MS);
  }

  async collectAIRankings() {
    const aiPlayers = this.getActiveAIs();
    const activePlayers = this.getActivePlayers();

    const rankingTasks = aiPlayers.map(ai => async () => {
      try {
        const othersNames = activePlayers.filter(p => p.id !== ai.id).map(p => p.name);
        const prompt = buildRankingPrompt(othersNames, this.lastElimination);
        ai.messageHistory.push({ role: 'user', content: prompt });
        const rankingResponse = await chat(ai.model, ai.messageHistory);
        ai.messageHistory.push({ role: 'assistant', content: rankingResponse });

        const parsed = this.parseRankingResponse(rankingResponse, activePlayers, ai.id);
        this.aiRankings.set(ai.id, parsed);
        if (parsed.length > 0) {
          console.log(`[AI] ${ai.name} ranked: [${parsed.map(id => this.getPlayer(id)?.name).join(', ')}]`);
        } else {
          console.log(`[AI] ${ai.name} ranking: could not parse from "${rankingResponse}"`);
        }
        this.emitVoteProgress();
      } catch (err) {
        console.error(`AI ranking failed for ${ai.name}:`, err.message);
        this.aiRankings.set(ai.id, []);
        this.emitVoteProgress();
      }
    });

    // Each task already catches its own errors, so the pool (built on
    // Promise.all over workers) is equivalent to the prior Promise.allSettled.
    await promisePool(rankingTasks, MAX_CONCURRENT_OLLAMA_CALLS);
    this.aiRankingsResolved = true;
    // If all *currently active* humans already voted while AIs were ranking, resolve early.
    // Count only votes from players still connected and not eliminated — stale votes
    // from since-disconnected humans must not prematurely trigger resolution.
    const activeHumanVoteCount = [...this.humanVotes.keys()].filter(id => {
      const p = this.getPlayer(id);
      return p && !p.isEliminated && !p.isDisconnected;
    }).length;
    if (activeHumanVoteCount >= this.getActiveHumans().length) {
      this.tryResolveRankings();
    }
  }

  parseRankingResponse(response, activePlayers, excludeId) {
    const candidates = activePlayers
      .filter(p => p.id !== excludeId)
      .slice()
      .sort((a, b) => b.name.length - a.name.length);

    const tokens = response
      .split(/[,;\n]+/)
      .map(t => t.trim())
      .filter(t => t.length > 0);

    const seen = new Set();
    const ranked = [];
    for (const token of tokens) {
      // Use word-boundary regex rather than unbounded substring so short names
      // ("Al", "Ed", "Sam") don't false-match words like "also"/"predicted"/"same".
      // Names are [a-zA-Z0-9 ], so \b correctly anchors at the name's edges.
      const match = candidates.find(p => {
        if (seen.has(p.id)) return false;
        const escaped = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${escaped}\\b`, 'i').test(token);
      });
      if (match) {
        seen.add(match.id);
        ranked.push(match.id);
      }
    }
    return ranked;
  }

  castHumanVote(player, targetId) {
    if (this.state !== STATES.VOTING) return false;
    if (!player.isHuman || player.isEliminated || player.isDisconnected) return false;
    if (targetId === player.id) return false;

    const target = this.getPlayer(targetId);
    if (!target || target.isEliminated || target.isDisconnected) return false;

    this.humanVotes.set(player.id, targetId);
    player.currentVote = targetId;
    console.log(`[HUMAN] ${player.name} voted for ${target.name}`);
    this.emitVoteProgress();
    // If all *currently active* humans are in and AI rankings finished, resolve early.
    // Count only votes from still-active voters so a stale vote from a since-disconnected
    // human doesn't prematurely satisfy the "everyone voted" condition.
    const activeHumanVoteCount = [...this.humanVotes.keys()].filter(id => {
      const p = this.getPlayer(id);
      return p && !p.isEliminated && !p.isDisconnected;
    }).length;
    if (this.aiRankingsResolved && activeHumanVoteCount >= this.getActiveHumans().length) {
      this.tryResolveRankings();
    }
    return true;
  }

  emitVoteProgress() {
    this.emitToAll('game:voteProgress', {
      votedCount: this.humanVotes.size + this.aiRankings.size,
      totalEligible: this.getActivePlayers().length,
    });
  }

  tryResolveRankings() {
    if (this.state !== STATES.VOTING) return;
    if (!this.aiRankingsResolved) return;
    // Idempotency guard: a late AI ranking completing in the 3s postVoteTimer window
    // must not trigger a second resolveRankings() call (double elimination, duplicate
    // game:voteResult events, orphaned timer). votingResolved is set in resolveRankings
    // and reset in startVoting.
    if (this.votingResolved) return;
    if (this.voteTimeout) {
      clearTimeout(this.voteTimeout);
      this.voteTimeout = null;
    }
    this.resolveRankings();
  }

  resolveRankings() {
    // Mark this voting round as resolved so any concurrent tryResolveRankings
    // call (e.g. a late AI ranking completing during the 3s postVoteTimer) is
    // a no-op. Reset in startVoting for the next round.
    this.votingResolved = true;
    const activePlayers = this.getActivePlayers();
    const bordaScores = new Map();

    for (const p of activePlayers) {
      bordaScores.set(p.id, 0);
    }

    for (const ranking of this.aiRankings.values()) {
      const n = ranking.length;
      for (let i = 0; i < n; i++) {
        // Standard Borda: first gets n-1, last gets 0.
        // Edge case: ranking only 1 player (only 2 active, one is the AI itself) → give 1 point.
        const points = n === 1 ? 1 : (n - 1 - i);
        bordaScores.set(ranking[i], (bordaScores.get(ranking[i]) || 0) + points);
      }
    }

    // Human votes match an AI's top-pick weight. Each AI ranks N-1 others and
    // awards N-2 points to first place, so human votes are worth Math.max(1, N-2)
    // — the same as an AI's highest pick. Floor at 1 so the tiny-game edge case
    // (2 active players) still awards a point.
    // Only count votes from players still active (connected, not eliminated) and
    // only toward targets still in bordaScores (active at resolution time), so a
    // vote cast before a player disconnected doesn't skew the tally.
    const humanVotePoints = Math.max(1, activePlayers.length - 2);
    const activeHumanIds = new Set(this.getActiveHumans().map(p => p.id));
    for (const [voterId, targetId] of this.humanVotes.entries()) {
      if (!activeHumanIds.has(voterId)) continue; // voter has since disconnected
      if (!bordaScores.has(targetId)) continue;    // target is no longer active
      bordaScores.set(targetId, (bordaScores.get(targetId) || 0) + humanVotePoints);
    }

    // Accumulate into cumulative Borda history for future tiebreaker use
    for (const [playerId, score] of bordaScores) {
      this.bordaHistory.set(playerId, (this.bordaHistory.get(playerId) || 0) + score);
    }

    let eliminated = null;
    const maxScore = Math.max(...bordaScores.values(), 0);

    if (maxScore > 0) {
      const tiedPlayers = [...bordaScores.entries()]
        .filter(([, score]) => score === maxScore)
        .map(([id]) => id);

      if (tiedPlayers.length === 1) {
        eliminated = this.getPlayer(tiedPlayers[0]);
      } else {
        eliminated = this.resolveBordaTie(tiedPlayers);
      }
    }

    if (eliminated) {
      eliminated.isEliminated = true;
      const type = eliminated.isHuman ? 'human' : 'AI';
      console.log(`[GAME] "${eliminated.name}" eliminated (${type}, Borda score: ${maxScore})`);
    }

    const remainingHumans = this.players.filter(p => p.isHuman && !p.isEliminated && !p.isDisconnected).length;
    const remainingAIs = this.players.filter(p => !p.isHuman && !p.isEliminated).length;

    this.lastElimination = {
      eliminated: eliminated ? { name: eliminated.name, isHuman: eliminated.isHuman } : null,
      remainingHumans,
      remainingAIs,
    };

    this.emitToAll('game:voteResult', {
      eliminated: eliminated ? { id: eliminated.id, name: eliminated.name, isHuman: eliminated.isHuman } : null,
      remainingHumans,
      remainingAIs,
    });

    this.postVoteTimer = setTimeout(() => this.checkWinCondition(), 3000);
  }

  resolveBordaTie(tiedPlayerIds) {
    // Level 2 tiebreaker: which tied player appears earliest (highest rank) in more individual AI rankings
    const firstPlaceCounts = new Map();
    for (const id of tiedPlayerIds) {
      firstPlaceCounts.set(id, 0);
    }

    for (const ranking of this.aiRankings.values()) {
      let earliestPos = Infinity;
      let earliestPlayer = null;
      for (const id of tiedPlayerIds) {
        const pos = ranking.indexOf(id);
        if (pos !== -1 && pos < earliestPos) {
          earliestPos = pos;
          earliestPlayer = id;
        }
      }
      if (earliestPlayer !== null) {
        firstPlaceCounts.set(earliestPlayer, firstPlaceCounts.get(earliestPlayer) + 1);
      }
    }

    // A human's single vote is always their "first place" pick, so it counts
    // toward this tiebreaker the same way an AI's top-ranked pick does.
    // Skip stale votes from since-disconnected voters (same filter as resolveRankings).
    const activeHumanIds = new Set(this.getActiveHumans().map(p => p.id));
    for (const [voterId, targetId] of this.humanVotes.entries()) {
      if (!activeHumanIds.has(voterId)) continue;
      if (firstPlaceCounts.has(targetId)) {
        firstPlaceCounts.set(targetId, firstPlaceCounts.get(targetId) + 1);
      }
    }

    const maxCount = Math.max(...firstPlaceCounts.values());
    const leaders = [...firstPlaceCounts.entries()].filter(([, c]) => c === maxCount);

    if (leaders.length === 1) {
      const tiedNames = tiedPlayerIds.map(id => this.getPlayer(id)?.name).join(', ');
      const winner = this.getPlayer(leaders[0][0]);
      console.log(`[GAME] Borda tie resolved via pairwise: ${winner.name} wins among [${tiedNames}]`);
      return winner;
    }

    // Level 3 tiebreaker: cumulative Borda history across all prior voting rounds
    leaders.sort((a, b) => (this.bordaHistory.get(b[0]) || 0) - (this.bordaHistory.get(a[0]) || 0));
    if ((this.bordaHistory.get(leaders[0][0]) || 0) !== (this.bordaHistory.get(leaders[1][0]) || 0)) {
      const winner = this.getPlayer(leaders[0][0]);
      console.log(`[GAME] Borda tie resolved via cumulative history: ${winner.name} (${this.bordaHistory.get(leaders[0][0])} pts)`);
      return winner;
    }

    // Level 4 tiebreaker: random pick among the still-tied leaders. Without this,
    // a symmetric standoff (each side ranks/votes the other every round, most
    // notably the final 1-human-vs-1-AI endgame) ties identically forever at
    // every prior level and the game never reaches a winner.
    const tiedNames = tiedPlayerIds.map(id => this.getPlayer(id)?.name).join(', ');
    const winner = this.getPlayer(leaders[randomInt(leaders.length)][0]);
    console.log(`[GAME] Borda tie unresolved after cumulative history — random tiebreak: ${winner.name} eliminated among [${tiedNames}]`);
    return winner;
  }

  checkWinCondition() {
    // Win determination is based on ELIMINATION, not transient disconnection.
    // A human who refreshes mid-game (supported rejoin path) must not spuriously
    // trigger a solo win during the 3s postVoteTimer window while disconnected.
    // Disconnected-but-not-eliminated humans are still counted as alive here.
    // (Disconnected AIs were already excluded only by isEliminated, unchanged.)
    const aliveHumans = this.players.filter(p => p.isHuman && !p.isEliminated);
    const aliveAIs = this.players.filter(p => !p.isHuman && !p.isEliminated);

    if (aliveHumans.length === 0) {
      this.endGame('ais');
    } else if (aliveHumans.length === 1) {
      // Sole survivor: becoming the last human standing is its own win condition,
      // independent of how many AIs remain (RULES.md: "vote out other humans to
      // become the sole survivor" is a distinct path from "vote out every AI").
      this.endGame('solo', aliveHumans[0]);
    } else if (aliveAIs.length === 0) {
      this.endGame('humans');
    } else {
      console.log(`[GAME] No winner yet — continuing (Humans: ${aliveHumans.length}, AIs: ${aliveAIs.length})`);
      this.startSubmitPhase();
    }
  }

  clearTimers() {
    if (this.submitTimer) { clearTimeout(this.submitTimer); this.submitTimer = null; }
    if (this.revealTimer) { clearTimeout(this.revealTimer); this.revealTimer = null; }
    if (this.voteSoonTimer) { clearTimeout(this.voteSoonTimer); this.voteSoonTimer = null; }
    if (this.voteTimeout) { clearTimeout(this.voteTimeout); this.voteTimeout = null; }
    if (this.postVoteTimer) { clearTimeout(this.postVoteTimer); this.postVoteTimer = null; }
  }

  endGame(winnerType, winnerPlayer = null) {
    if (!winnerType) {
      const result = this.determineWinner();
      this.endGame(result.type, result.player);
      return;
    }
    this.clearTimers();
    this.state = STATES.ENDED;
    const winnerStr = winnerType === 'solo' ? `${winnerPlayer.name} (solo)` : winnerType;
    console.log(`[GAME] Game ended — ${winnerStr} win!`);
    const payload = {
      winner: winnerType,
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        isHuman: p.isHuman,
        isEliminated: p.isEliminated,
        model: p.model,
      })),
    };
    if (winnerType === 'solo' && winnerPlayer) {
      payload.winnerPlayerId = winnerPlayer.id;
      payload.winnerPlayerName = winnerPlayer.name;
    }
    this.endResult = payload;
    this.emitToAll('game:ended', payload);
  }

  determineWinner() {
    // Same elimination-only filter as checkWinCondition — disconnection is transient.
    const aliveHumans = this.players.filter(p => p.isHuman && !p.isEliminated);
    const aliveAIs = this.players.filter(p => !p.isHuman && !p.isEliminated);
    if (aliveHumans.length === 0) return { type: 'ais' };
    // Sole survivor wins outright, independent of remaining AI count — see checkWinCondition().
    if (aliveHumans.length === 1) return { type: 'solo', player: aliveHumans[0] };
    if (aliveAIs.length === 0) return { type: 'humans' };
    return { type: 'ais' };
  }

  emitGameState() {
    const state = this.getGameState();
    for (const p of this.players) {
      if (p.socketId) {
        // myToken is sent ONLY to its owner — never broadcast or attached to
        // other players' entries — so it can't be read off the wire by others.
        this.emitToSocket(p.socketId, 'game:state', { ...state, myId: p.id, myToken: p.rejoinToken || null });
      }
    }
  }
}
