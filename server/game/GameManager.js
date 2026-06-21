import { randomUUID } from 'node:crypto';
import { GameSession } from './GameSession.js';

const gameManager = {
  currentSession: null,

  getOrCreateSession() {
    if (!this.currentSession) {
      this.currentSession = new GameSession();
    }
    return this.currentSession;
  },

  getSession() {
    return this.currentSession;
  },

  // Random UUID instead of a sequential counter — prevents enumerating
  // other players' ids (e.g. player_1, player_2, ...) to hijack rejoin.
  generatePlayerId() {
    return randomUUID();
  },

  reset() {
    if (this.currentSession) {
      this.currentSession.clearTimers();
    }
    this.currentSession = null;
  },
};

export default gameManager;
