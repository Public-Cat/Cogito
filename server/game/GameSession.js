import { Player } from './Player.js';
import { topics as topicList } from './topics.js';
import { chat } from '../ollama/OllamaClient.js';
import { buildSystemPrompt, buildVotePrompt, buildNamePrompt } from '../ollama/prompts.js';

const STATES = {
  LOBBY: 'LOBBY',
  PLAYING: 'PLAYING',
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
    this.turnOrder = [];
    this.currentTurnIndex = 0;
    this.humanVotes = new Map();
    this.aiVotes = new Map();
    this.emitToAll = null;
    this.emitToSocket = null;
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
    return this.players.filter(p => p.isHuman && !p.isEliminated);
  }

  getActiveAIs() {
    return this.players.filter(p => !p.isHuman && !p.isEliminated);
  }

  getActivePlayers() {
    return this.players.filter(p => !p.isEliminated);
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
    } else if (this.state === STATES.PLAYING || this.state === STATES.VOTING) {
      player.isDisconnected = true;
      player.isActive = false;
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
    const currentPlayer = this.turnOrder[this.currentTurnIndex] || null;
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
      turnOrder: this.turnOrder.map(p => p.id),
      currentTurn: currentPlayer ? currentPlayer.id : null,
      topic: this.topic,
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
        const existingNames = this.players.filter(p => p !== aiPlayer).map(p => p.name.toLowerCase());
        let attempt = 0;
        while (existingNames.includes(name.toLowerCase()) && attempt < 10) {
          const retryResponse = await chat(aiPlayer.model, [
            { role: 'user', content: buildNamePrompt() },
          ]);
          name = retryResponse.trim().split('\n')[0].trim();
          attempt++;
        }
        aiPlayer.name = name;
      } catch {
        aiPlayer.name = `AI-${Math.random().toString(36).slice(2, 6)}`;
      }
      aiPlayer.messageHistory = [
        { role: 'system', content: buildSystemPrompt(aiPlayer.name, this.topic, this.players.filter(p => p.isHuman).map(p => p.name)) },
      ];
    }))

    const humanPlayers = this.players.filter(p => p.isHuman);
    const aiPlayers = this.players.filter(p => !p.isHuman);
    this.turnOrder = [...humanPlayers, ...aiPlayers].sort(() => Math.random() - 0.5);
    this.currentTurnIndex = 0;
    this.round = 0;
    this.state = STATES.PLAYING;
  }

  async handleTurn() {
    if (this.state !== STATES.PLAYING) return;
    const activePlayers = this.players.filter(p => !p.isEliminated);
    if (activePlayers.length <= 1) {
      this.endGame();
      return;
    }
    if (activePlayers.every(p => p.isDisconnected)) return;

    const currentPlayer = this.turnOrder[this.currentTurnIndex];
    if (!currentPlayer || currentPlayer.isEliminated || currentPlayer.isDisconnected) {
      this.advanceTurn();
      return;
    }

    if (!currentPlayer.isHuman) {
      const transcript = this.buildRoundTranscript();
      if (transcript) {
        currentPlayer.messageHistory.push({ role: 'user', content: transcript });
      }
      currentPlayer.messageHistory.push({ role: 'user', content: 'It is your turn to respond.' });
      const reply = await chat(currentPlayer.model, currentPlayer.messageHistory);
      if (this.state !== STATES.PLAYING) return;
      currentPlayer.messageHistory.push({ role: 'assistant', content: reply });
      const message = {
        playerId: currentPlayer.id,
        playerName: currentPlayer.name,
        text: reply,
        timestamp: Date.now(),
      };
      this.messages.push(message);
      this.emitToAll('game:newMessage', message);
      this.advanceTurn();
    }
  }

  advanceTurn() {
    if (this.state !== STATES.PLAYING) return;
    const activePlayers = this.players.filter(p => !p.isEliminated);
    if (activePlayers.length <= 1) {
      this.endGame();
      return;
    }
    if (activePlayers.every(p => p.isDisconnected)) return;

    this.currentTurnIndex++;
    if (this.currentTurnIndex >= this.turnOrder.length) {
      this.currentTurnIndex = 0;
      this.round++;
      if (this.round >= 2) {
        this.startVoting();
        return;
      }
    }

    while (this.currentTurnIndex < this.turnOrder.length) {
      const p = this.turnOrder[this.currentTurnIndex];
      if (p && !p.isEliminated && !p.isDisconnected) break;
      this.currentTurnIndex++;
    }
    if (this.currentTurnIndex >= this.turnOrder.length) {
      this.currentTurnIndex = 0;
    }

    this.emitGameState();
    const currentPlayer = this.turnOrder[this.currentTurnIndex];
    if (!currentPlayer || currentPlayer.isEliminated || currentPlayer.isDisconnected) {
      this.advanceTurn();
      return;
    }

    if (!currentPlayer.isHuman) {
      this.handleTurn();
    }
  }

  buildRoundTranscript() {
    if (this.messages.length === 0) return null;
    const roundMessages = [];
    for (const msg of this.messages) {
      roundMessages.push(`[${msg.playerName}]: ${msg.text}`);
    }
    return roundMessages.join('\n');
  }

  startVoting() {
    this.state = STATES.VOTING;
    this.humanVotes = new Map();
    this.aiVotes = new Map();
    this.voteTimeout = null;
    this.aiVotesResolved = false;
    this.humanVotesResolved = false;
    this.emitToAll('game:voteStart', { roundNumber: this.round });
    this.emitGameState();
    this.collectAIVotes();
    this.voteTimeout = setTimeout(() => {
      this.humanVotesResolved = true;
      this.tryResolveVotes();
    }, 30000);
  }

  async collectAIVotes() {
    const aiPlayers = this.getActiveAIs();
    const activePlayers = this.getActivePlayers();
    const activePlayerNames = activePlayers.map(p => p.name);

    const votePromises = aiPlayers.map(async (ai) => {
      const prompt = buildVotePrompt(ai.name, activePlayerNames);
      ai.messageHistory.push({ role: 'user', content: prompt });
      const voteResponse = await chat(ai.model, ai.messageHistory);
      ai.messageHistory.push({ role: 'assistant', content: voteResponse });
      const voteTarget = activePlayers.find(p => p.name.toLowerCase() === voteResponse.trim().toLowerCase());
      if (voteTarget) {
        this.aiVotes.set(ai.id, voteTarget.id);
      }
    });

    await Promise.all(votePromises);
    this.aiVotesResolved = true;
    this.tryResolveVotes();
  }

  submitHumanVote(voterId, targetId) {
    this.humanVotes.set(voterId, targetId);
    if (this.humanVotes.size >= this.getActiveHumans().length) {
      this.humanVotesResolved = true;
      this.tryResolveVotes();
    }
  }

  tryResolveVotes() {
    if (this.state !== STATES.VOTING) return;
    if (!this.aiVotesResolved || !this.humanVotesResolved) {
      return;
    }
    if (this.voteTimeout) {
      clearTimeout(this.voteTimeout);
      this.voteTimeout = null;
    }
    this.resolveVotes();
  }

  resolveVotes() {
    const activePlayers = this.getActivePlayers();
    const aiVoteCounts = new Map();
    const humanVoteCounts = new Map();

    for (const targetId of this.aiVotes.values()) {
      aiVoteCounts.set(targetId, (aiVoteCounts.get(targetId) || 0) + 1);
    }
    for (const targetId of this.humanVotes.values()) {
      humanVoteCounts.set(targetId, (humanVoteCounts.get(targetId) || 0) + 1);
    }

    let aiEliminated = null;
    let humanEliminated = null;

    const maxAiVotes = Math.max(...aiVoteCounts.values(), 0);
    if (maxAiVotes > 0) {
      const aiTargets = [...aiVoteCounts.entries()].filter(([, c]) => c === maxAiVotes);
      if (aiTargets.length === 1) {
        aiEliminated = this.getPlayer(aiTargets[0][0]);
      }
    }

    const maxHumanVotes = Math.max(...humanVoteCounts.values(), 0);
    if (maxHumanVotes > 0) {
      const humanTargets = [...humanVoteCounts.entries()].filter(([, c]) => c === maxHumanVotes);
      if (humanTargets.length === 1) {
        humanEliminated = this.getPlayer(humanTargets[0][0]);
      }
    }

    if (aiEliminated) aiEliminated.isEliminated = true;
    if (humanEliminated) humanEliminated.isEliminated = true;

    this.emitToAll('game:voteResult', {
      aiEliminated: aiEliminated ? { id: aiEliminated.id, name: aiEliminated.name, isHuman: aiEliminated.isHuman } : null,
      humanEliminated: humanEliminated ? { id: humanEliminated.id, name: humanEliminated.name, isHuman: humanEliminated.isHuman } : null,
    });

    this.checkWinCondition();
  }

  checkWinCondition() {
    const aliveHumans = this.players.filter(p => p.isHuman && !p.isEliminated);
    const aliveAIs = this.players.filter(p => !p.isHuman && !p.isEliminated);

    if (aliveHumans.length === 0) {
      this.endGame('ais');
    } else if (aliveAIs.length === 0) {
      this.endGame('humans');
    } else {
      this.state = STATES.PLAYING;
      while (this.currentTurnIndex < this.turnOrder.length) {
        const p = this.turnOrder[this.currentTurnIndex];
        if (p && !p.isEliminated && !p.isDisconnected) break;
        this.currentTurnIndex++;
      }
      if (this.currentTurnIndex >= this.turnOrder.length) {
        this.currentTurnIndex = 0;
        this.round++;
      }
      this.emitGameState();
      if (this.turnOrder[this.currentTurnIndex] && !this.turnOrder[this.currentTurnIndex].isHuman) {
        this.handleTurn();
      }
    }
  }

  endGame(winner) {
    this.state = STATES.ENDED;
    if (this.voteTimeout) {
      clearTimeout(this.voteTimeout);
      this.voteTimeout = null;
    }
    this.emitToAll('game:ended', {
      winner: winner || this.determineWinner(),
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        isHuman: p.isHuman,
        isEliminated: p.isEliminated,
        model: p.model,
      })),
    });
  }

  determineWinner() {
    const aliveHumans = this.players.filter(p => p.isHuman && !p.isEliminated);
    const aliveAIs = this.players.filter(p => !p.isHuman && !p.isEliminated);
    if (aliveAIs.length === 0) return 'humans';
    return 'ais';
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
