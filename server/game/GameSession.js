import { Player } from './Player.js';
import { topics as topicList } from './topics.js';
import { chat } from '../ollama/OllamaClient.js';
import { buildSystemPrompt, buildTurnPrompt, buildRankingPrompt, buildNamePrompt } from '../ollama/prompts.js';

const PERSONALITIES = ['skeptical', 'enthusiastic', 'thoughtful', 'dry', 'curious', 'anxious'];

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
    this.players = [];
    this.messages = [];
    this.topic = '';
    this.round = 0;
    this.aiRankings = new Map();
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
    this.bordaHistory = new Map();
    this.lastElimination = null;
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
    const humans = this.players.filter(p => p.isHuman);
    for (const p of this.players) p.isHost = false;
    if (humans.length > 0) {
      humans[0].isHost = true;
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
        // Don't early-resolve on disconnect — let the 15s timer fire
        // so reconnecting players have a window to rejoin. Early resolve
        // still happens via handleHumanSubmit when remaining players submit.
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
    };
  }

  async startGame(config) {
    this.topic = config.topic || topicList[Math.floor(Math.random() * topicList.length)];
    this.messages = [];
    for (const p of this.players) {
      p.isHost = false;
      p.isEliminated = false;
    }
    const aiConfigs = config.aiPlayers || [];
    await Promise.all(aiConfigs.map(async (cfg) => {
      const aiPlayer = this.addPlayer(`ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, false, null);
      aiPlayer.model = cfg.model;
      try {
        const nameResponse = await chat(aiPlayer.model, [
          { role: 'user', content: buildNamePrompt() },
        ]);
        let name = nameResponse.trim().split('\n')[0].trim();
        if (!name || name === '...') throw new Error('invalid name');
        const existingNames = this.players.filter(p => p !== aiPlayer).map(p => p.name.toLowerCase());
        let attempt = 0;
        while (existingNames.includes(name.toLowerCase()) && attempt < 10) {
          const retryResponse = await chat(aiPlayer.model, [
            { role: 'user', content: buildNamePrompt() },
          ]);
          name = retryResponse.trim().split('\n')[0].trim();
          if (!name || name === '...') throw new Error('invalid name');
          attempt++;
        }
        aiPlayer.name = name;
        console.log(`[AI] ${aiPlayer.name} (${aiPlayer.model}) chose name`);
      } catch {
        aiPlayer.name = `AI-${Math.random().toString(36).slice(2, 6)}`;
        console.log(`[AI] ${aiPlayer.model} using fallback name "${aiPlayer.name}"`);
      }
      aiPlayer.personality = PERSONALITIES[Math.floor(Math.random() * PERSONALITIES.length)];
      aiPlayer.messageHistory = [
        { role: 'system', content: buildSystemPrompt(aiPlayer.name, this.topic, this.players.map(p => p.name), aiPlayer.personality) },
      ];
    }))

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
    for (const ai of activeAIs) {
      this.generateAIMessage(ai);
    }

    this.submitTimer = setTimeout(() => this.resolveSubmitPhase(), 15000);
  }

  async generateAIMessage(ai) {
    const turnPrompt = this.lastElimination
      ? buildTurnPrompt(this.lastElimination)
      : buildTurnPrompt();
    const messages = [...ai.messageHistory, { role: 'user', content: turnPrompt }];
    const reply = await chat(ai.model, messages);
    if (this.state !== STATES.SUBMITTING) return;

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
    this.voteTimeout = null;
    this.aiRankingsResolved = false;
    this.emitToAll('game:voteStart', { roundNumber: this.round });
    this.emitGameState();
    this.collectAIRankings();
    this.voteTimeout = setTimeout(() => {
      console.log(`[GAME] Voting timeout reached — forcing resolution`);
      this.aiRankingsResolved = true;
      this.tryResolveRankings();
    }, 10000);
  }

  async collectAIRankings() {
    const aiPlayers = this.getActiveAIs();
    const activePlayers = this.getActivePlayers();
    const activePlayerNames = activePlayers.map(p => p.name);

    const rankingPromises = aiPlayers.map(async (ai) => {
      try {
        const prompt = buildRankingPrompt(activePlayerNames, this.lastElimination);
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
      } catch (err) {
        console.error(`AI ranking failed for ${ai.name}:`, err.message);
        this.aiRankings.set(ai.id, []);
      }
    });

    await Promise.allSettled(rankingPromises);
    this.aiRankingsResolved = true;
    this.tryResolveRankings();
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
      const match = candidates.find(p =>
        !seen.has(p.id) && token.toLowerCase().includes(p.name.toLowerCase())
      );
      if (match) {
        seen.add(match.id);
        ranked.push(match.id);
      }
    }
    return ranked;
  }

  tryResolveRankings() {
    if (this.state !== STATES.VOTING) return;
    if (!this.aiRankingsResolved) return;
    if (this.voteTimeout) {
      clearTimeout(this.voteTimeout);
      this.voteTimeout = null;
    }
    this.resolveRankings();
  }

  resolveRankings() {
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

    const tiedNames = tiedPlayerIds.map(id => this.getPlayer(id)?.name).join(', ');
    console.log(`[GAME] No elimination (Borda tie unresolved after cumulative history: ${tiedNames})`);
    return null;
  }

  checkWinCondition() {
    const aliveHumans = this.players.filter(p => p.isHuman && !p.isEliminated && !p.isDisconnected);
    const aliveAIs = this.players.filter(p => !p.isHuman && !p.isEliminated);

    if (aliveHumans.length === 0) {
      this.endGame('ais');
    } else if (aliveAIs.length === 0) {
      if (aliveHumans.length === 1) {
        this.endGame('solo', aliveHumans[0]);
      } else {
        this.endGame('humans');
      }
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
    if (this.voteTimeout) {
      clearTimeout(this.voteTimeout);
      this.voteTimeout = null;
    }
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
    this.emitToAll('game:ended', payload);
  }

  determineWinner() {
    const aliveHumans = this.players.filter(p => p.isHuman && !p.isEliminated && !p.isDisconnected);
    const aliveAIs = this.players.filter(p => !p.isHuman && !p.isEliminated);
    if (aliveAIs.length === 0) {
      if (aliveHumans.length === 1) return { type: 'solo', player: aliveHumans[0] };
      return { type: 'humans' };
    }
    return { type: 'ais' };
  }

  emitGameState() {
    const state = this.getGameState();
    for (const p of this.players) {
      if (p.socketId) {
        this.emitToSocket(p.socketId, 'game:state', { ...state, myId: p.id });
      }
    }
  }
}
