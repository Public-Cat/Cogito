import { randomBytes } from 'node:crypto';
import gameManager from '../game/GameManager.js';
import { getCachedModels } from '../ollama/OllamaClient.js';

const NAME_REGEX = /^[a-zA-Z0-9 ]{1,20}$/;
const MAX_MESSAGE_LENGTH = 500;
const MAX_AI_PLAYERS = 8;
const MAX_TOPIC_LENGTH = 120;

// Public-realm joins require this code when set (e.g. SESSION_CODE=abc123).
// LAN-realm joins always bypass it. Null means no code is required at all,
// so existing tests/dev flows that omit a code keep working.
const SESSION_CODE = process.env.SESSION_CODE || null;

function sanitize(str) {
  return str.replace(/[<>&"']/g, '');
}

// ---- Lightweight per-socket rate limiting (no deps) ----
// Map<socketId, Map<eventName, number[]>> — timestamps (ms) of recent hits.
const rateBuckets = new Map();

/**
 * Token-bucket-ish fixed-window limiter: allow at most `max` calls of
 * `event` per `windowMs` for a given socket. Returns true if allowed.
 * @param {string} socketId
 * @param {string} event
 * @param {number} max
 * @param {number} windowMs
 * @returns {boolean}
 */
function allowRate(socketId, event, max, windowMs) {
  let perSocket = rateBuckets.get(socketId);
  if (!perSocket) {
    perSocket = new Map();
    rateBuckets.set(socketId, perSocket);
  }
  const now = Date.now();
  const hits = (perSocket.get(event) || []).filter(t => now - t < windowMs);
  if (hits.length >= max) {
    perSocket.set(event, hits);
    return false;
  }
  hits.push(now);
  perSocket.set(event, hits);
  return true;
}

function clearRateBucket(socketId) {
  rateBuckets.delete(socketId);
}

/**
 * Gate a privileged action to the lobby host on the trusted LAN realm.
 * Emits 'error' and returns false if the caller doesn't qualify.
 */
function requireLanHost(session, socket) {
  const player = session.getPlayerBySocket(socket.id);
  if (!player || !player.isHost || socket.data.realm !== 'lan') {
    socket.emit('error', { message: 'Not authorized.' });
    return false;
  }
  return true;
}

export function registerHandlers(io, socket) {
  socket.on('lobby:setName', async ({ name, code } = {}) => {
    try {
      if (!allowRate(socket.id, 'lobby:setName', 5, 10000)) {
        socket.emit('error', { message: 'Too many requests — slow down.' });
        return;
      }

      // Public-realm join gate: require the session code when one is configured.
      // LAN realm (trusted reverse proxy) always bypasses this check.
      if (socket.data.realm === 'public' && SESSION_CODE && code !== SESSION_CODE) {
        socket.emit('error', { message: 'Invalid session code.' });
        return;
      }

      const session = gameManager.getOrCreateSession();
      if (!name || !NAME_REGEX.test(name)) {
        socket.emit('error', { message: 'Name must be 1-20 characters, alphanumeric with spaces.' });
        return;
      }
      const sanitizedName = sanitize(name.trim());

      let player = session.getPlayerBySocket(socket.id);
      if (player) {
        player.name = sanitizedName;
        console.log(`[HUMAN] Player "${sanitizedName}" updated name`);
      } else {
        const playerId = gameManager.generatePlayerId();
        player = session.addPlayer(playerId, true, socket.id);
        player.name = sanitizedName;
        player.realm = socket.data.realm;
        player.rejoinToken = randomBytes(16).toString('hex');
        console.log(`[HUMAN] Player "${sanitizedName}" joined lobby`);
      }

      session.assignHost();
      const models = getCachedModels();
      const myId = session.getPlayerBySocket(socket.id)?.id || null;
      const state = {
        players: session.players.map(p => ({
          id: p.id,
          name: p.name,
          isHuman: p.isHuman,
          isHost: p.isHost,
        })),
        myId,
        myToken: player.rejoinToken,
        models,
        isHost: session.getHost()?.socketId === socket.id,
      };
      socket.emit('lobby:state', state);

      const host = session.getHost();
      if (host && host.socketId !== socket.id) {
        const hostState = {
          ...state,
          myId: host.id,
          myToken: host.rejoinToken,
          isHost: true,
        };
        io.to(host.socketId).emit('lobby:state', hostState);
        io.to(host.socketId).emit('host:assigned');
      }
    } catch (err) {
      console.error('lobby:setName error:', err);
      socket.emit('error', { message: 'Failed to set name.' });
    }
  });

  socket.on('lobby:start', async ({ topic, aiPlayers } = {}, callback) => {
    try {
      const session = gameManager.getOrCreateSession();
      const player = session.getPlayerBySocket(socket.id);
      if (!player || !player.isHost) {
        socket.emit('error', { message: 'Only the host can start the game.' });
        return;
      }

      const humans = session.players.filter(p => p.isHuman);

      if (humans.length < 2) {
        socket.emit('error', { message: 'Need at least 2 human players.' });
        return;
      }

      if (!Array.isArray(aiPlayers) || aiPlayers.length < 1) {
        socket.emit('error', { message: 'Need at least 1 AI player.' });
        return;
      }

      if (aiPlayers.length > MAX_AI_PLAYERS) {
        socket.emit('error', { message: `Cannot configure more than ${MAX_AI_PLAYERS} AI players.` });
        return;
      }

      const wellFormed = aiPlayers.every(cfg => cfg && typeof cfg === 'object' && typeof cfg.model === 'string' && cfg.model.length > 0);
      if (!wellFormed) {
        socket.emit('error', { message: 'Each AI player must specify a model.' });
        return;
      }

      // Validate model names against the cached Ollama model list. If the
      // cache is empty (Ollama unreachable), allow through rather than
      // blocking offline dev/testing where the model list can't be fetched.
      const cachedModels = getCachedModels();
      if (cachedModels.length > 0) {
        const unknown = aiPlayers.find(cfg => !cachedModels.includes(cfg.model));
        if (unknown) {
          socket.emit('error', { message: `Unknown model: ${unknown.model}` });
          return;
        }
      }

      let sanitizedTopic = null;
      if (topic) {
        sanitizedTopic = sanitize(String(topic).slice(0, MAX_TOPIC_LENGTH).trim());
      }

      const config = { topic: sanitizedTopic, aiPlayers };

      session.emitToAll = (event, data) => {
        io.emit(event, data);
      };
      session.emitToSocket = (socketId, event, data) => {
        io.to(socketId).emit(event, data);
      };

      await session.startGame(config);

      // emitGameState() inside startSubmitPhase() already emitted game:state per-player

      if (typeof callback === 'function') callback({ ok: true });
    } catch (err) {
      console.error('lobby:start error:', err);
      socket.emit('error', { message: 'Failed to start game.' });
    }
  });

  socket.on('game:sendMessage', ({ text } = {}) => {
    try {
      if (!allowRate(socket.id, 'game:sendMessage', 1, 1000)) {
        socket.emit('error', { message: 'Sending too fast — slow down.' });
        return;
      }

      const session = gameManager.getSession();
      if (!session) {
        socket.emit('error', { message: 'No active game session.' });
        return;
      }
      if (!text || text.length > MAX_MESSAGE_LENGTH) {
        socket.emit('error', { message: 'Message must be 1-500 characters.' });
        return;
      }

      const player = session.getPlayerBySocket(socket.id);
      if (!player) {
        socket.emit('error', { message: 'Player not found.' });
        return;
      }

      const sanitizedText = sanitize(text.trim());
      const submitted = session.handleHumanSubmit(player, sanitizedText);
      if (!submitted) {
        socket.emit('error', { message: 'Cannot submit right now.' });
        return;
      }

      console.log(`[HUMAN] ${player.name} submitted: "${sanitizedText}"`);
    } catch (err) {
      console.error('game:sendMessage error:', err);
      socket.emit('error', { message: 'Failed to send message.' });
    }
  });

  socket.on('game:castVote', ({ targetId } = {}) => {
    try {
      if (!allowRate(socket.id, 'game:castVote', 5, 10000)) {
        socket.emit('error', { message: 'Too many requests — slow down.' });
        return;
      }

      const session = gameManager.getSession();
      if (!session) {
        socket.emit('error', { message: 'No active game session.' });
        return;
      }
      const player = session.getPlayerBySocket(socket.id);
      if (!player) {
        socket.emit('error', { message: 'Player not found.' });
        return;
      }
      if (session.state !== 'VOTING') {
        socket.emit('error', { message: 'Not in voting phase.' });
        return;
      }

      const success = session.castHumanVote(player, targetId);
      if (!success) {
        socket.emit('error', { message: 'Invalid vote target.' });
      }
    } catch (err) {
      console.error('game:castVote error:', err);
      socket.emit('error', { message: 'Failed to submit vote.' });
    }
  });

  socket.on('lobby:reset', () => {
    try {
      const session = gameManager.getSession();
      if (!session || !requireLanHost(session, socket)) return;
      gameManager.reset();
      io.emit('lobby:state', {
        players: [],
        models: [],
        isHost: false,
      });
    } catch (err) {
      console.error('lobby:reset error:', err);
    }
  });

  socket.on('game:returnToLobby', () => {
    try {
      const session = gameManager.getSession();
      if (!session || !requireLanHost(session, socket)) return;
      gameManager.reset();
      socket.emit('lobby:state', {
        players: [],
        models: [],
        isHost: true,
      });
    } catch (err) {
      console.error('game:returnToLobby error:', err);
    }
  });

  socket.on('game:rejoin', ({ playerId, token } = {}) => {
    try {
      if (!allowRate(socket.id, 'game:rejoin', 5, 10000)) {
        socket.emit('error', { message: 'Too many requests — slow down.' });
        return;
      }

      const currentSession = gameManager.getSession();
      if (!currentSession || currentSession.state === 'LOBBY') return;
      const player = currentSession.getPlayer(playerId);
      if (!player) return;
      if (!player.rejoinToken || token !== player.rejoinToken) {
        socket.emit('error', { message: 'Invalid rejoin token.' });
        return;
      }
      player.socketId = socket.id;
      player.isDisconnected = false;
      console.log(`[HUMAN] Player "${player.name}" reconnected`);
      currentSession.emitGameState();
    } catch (err) {
      console.error('game:rejoin error:', err);
    }
  });

  socket.on('disconnect', () => {
    try {
      clearRateBucket(socket.id);
      const currentSession = gameManager.getSession();
      if (currentSession) {
        const disconnectedPlayer = currentSession.getPlayerBySocket(socket.id);
        if (disconnectedPlayer) console.log(`[HUMAN] Player "${disconnectedPlayer.name}" disconnected`);
        currentSession.handleDisconnect(socket.id);
        if (currentSession.state === 'LOBBY') {
          const lobbyState = currentSession.getLobbyState();
          const models = getCachedModels();
          for (const p of currentSession.players) {
            if (p.socketId) {
              io.to(p.socketId).emit('lobby:state', {
                ...lobbyState, models, myId: p.id, myToken: p.rejoinToken || null,
                isHost: currentSession.getHost()?.socketId === p.socketId,
              });
            }
          }
        } else {
          const host = currentSession.getHost();
          if (host && host.socketId) {
            io.to(host.socketId).emit('host:assigned');
          }
        }
      }
    } catch (err) {
      console.error('disconnect error:', err);
    }
  });
}
