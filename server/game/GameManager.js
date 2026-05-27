import { GameSession } from './GameSession.js';

const gameManager = {
  currentSession: null,
  playerCounter: 0,

  getOrCreateSession() {
    if (!this.currentSession) {
      this.currentSession = new GameSession();
    }
    return this.currentSession;
  },

  getSession() {
    return this.currentSession;
  },

  generatePlayerId() {
    this.playerCounter++;
    return `player_${this.playerCounter}`;
  },

  reset() {
    this.currentSession = null;
    this.playerCounter = 0;
  },
};

export default gameManager;
