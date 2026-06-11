import { Player } from './Player.js';
import { topics as topicList } from './topics.js';
import { chat } from '../ollama/OllamaClient.js';
import { buildSystemPrompt, buildTurnPrompt, buildVotePrompt, buildNamePrompt } from '../ollama/prompts.js';

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
    this.aiVotes = new Map();
    this.emitToAll = null;
    this.emitToSocket = null;
    this.submittedPlayerIds = new Set();
    this.pendingMessages = [];
    this.submitTimer = null;
    this.revealTimer = null;
    this.voteSoonTimer = null;
    this.voteTimeout = null;
    this.aiVotesResolved = false;
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

  getAlivePlayers() {
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
      player.isActive = false;
      if (this.state === STATES.SUBMITTING) {
        this.submittedPlayerIds.delete(player.id);
        if (this.submittedPlayerIds.size >= this.getActivePlayers().length) {
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
      aiPlayer.messageHistory = [
        { role: 'system', content: buildSystemPrompt(aiPlayer.name, this.topic, this.players.map(p => p.name)) },
      ];
    }))

    this.round = 0;
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
    const messages = [...ai.messageHistory, { role: 'user', content: buildTurnPrompt() }];
    const reply = await chat(ai.model, messages);
    if (this.state !== STATES.SUBMITTING) return;

    ai.messageHistory.push({ role: 'user', content: buildTurnPrompt() });
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
      ai.lastMessageIndex = this.messages.length + this.pendingMessages.length;
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
    this.aiVotes = new Map();
    this.voteTimeout = null;
    this.aiVotesResolved = false;
    this.emitToAll('game:voteStart', { roundNumber: this.round });
    this.emitGameState();
    this.collectAIVotes();
    this.voteTimeout = setTimeout(() => {
      console.log(`[GAME] Voting timeout reached — forcing resolution`);
      this.aiVotesResolved = true;
      this.tryResolveVotes();
    }, 10000);
  }

  async collectAIVotes() {
    const aiPlayers = this.getActiveAIs();
    const activePlayers = this.getActivePlayers();
    const activePlayerNames = activePlayers.map(p => p.name);

    const votePromises = aiPlayers.map(async (ai) => {
      try {
        const prompt = buildVotePrompt(activePlayerNames);
        ai.messageHistory.push({ role: 'user', content: prompt });
        const voteResponse = await chat(ai.model, ai.messageHistory);
        ai.messageHistory.push({ role: 'assistant', content: voteResponse });
        const voteTarget = activePlayers
          .filter(p => p.id !== ai.id)
          .slice()
          .sort((a, b) => b.name.length - a.name.length)
          .find(p => voteResponse.toLowerCase().includes(p.name.toLowerCase()));
        if (voteTarget) {
          this.aiVotes.set(ai.id, voteTarget.id);
          console.log(`[AI] ${ai.name} voted for "${voteTarget.name}"`);
        } else {
          console.log(`[AI] ${ai.name} vote: could not parse target from "${voteResponse}"`);
        }
      } catch (err) {
        console.error(`AI vote failed for ${ai.name}:`, err.message);
      }
    });

    await Promise.allSettled(votePromises);
    this.aiVotesResolved = true;
    this.tryResolveVotes();
  }

  tryResolveVotes() {
    if (this.state !== STATES.VOTING) return;
    if (!this.aiVotesResolved) return;
    if (this.voteTimeout) {
      clearTimeout(this.voteTimeout);
      this.voteTimeout = null;
    }
    this.resolveVotes();
  }

  resolveVotes() {
    const voteCounts = new Map();

    for (const targetId of this.aiVotes.values()) {
      voteCounts.set(targetId, (voteCounts.get(targetId) || 0) + 1);
    }

    let eliminated = null;

    const maxVotes = Math.max(...voteCounts.values(), 0);

    if (maxVotes > 0) {
      const targets = [...voteCounts.entries()].filter(([, c]) => c === maxVotes);
      if (targets.length === 1) {
        eliminated = this.getPlayer(targets[0][0]);
      } else {
        const tiedNames = targets.map(([id]) => this.getPlayer(id)?.name).join(', ');
        console.log(`[GAME] No elimination (tie: ${tiedNames})`);
      }
    }

    if (eliminated) {
      eliminated.isEliminated = true;
      const type = eliminated.isHuman ? 'human' : 'AI';
      console.log(`[GAME] "${eliminated.name}" eliminated (${type}, votes: ${maxVotes})`);
    }

    this.emitToAll('game:voteResult', {
      eliminated: eliminated ? { id: eliminated.id, name: eliminated.name, isHuman: eliminated.isHuman } : null,
    });

    setTimeout(() => this.checkWinCondition(), 3000);
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
