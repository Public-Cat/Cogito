// Socket.IO event handlers — all game and lobby interactions flow through here.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import gameManager from '../game/GameManager.js';
import { getCachedModels } from '../ollama/OllamaClient.js';

const NAME_REGEX = /^[a-zA-Z0-9 ]{1,20}$/;
// Ollama model names: word chars plus the separators real tags/namespaces use
// (`qwen2.5:7b`, `registry/library/llama3:latest`). Excludes <>&"' and spaces,
// so a model string can never carry HTML into the client end-screen render.
const MODEL_REGEX = /^[\w.:/-]{1,100}$/;
const MAX_MESSAGE_LENGTH = 500;
const MAX_AI_PLAYERS = 8;
const MAX_HUMAN_PLAYERS = 12;
const MAX_TOPIC_LENGTH = 120;

function sanitize(str) {
  return str.replace(/[<>&"']/g, '');
}

// ---- Lightweight per-address rate limiting (no deps) ----
// Map<clientKey, Map<eventName, number[]>> — timestamps (ms) of recent hits.
// Keyed by socket.handshake.address (client IP) so reconnecting clients don't
// bypass limits by getting a new socket.id. Buckets are never cleared on
// disconnect; a periodic sweep removes stale entries to bound memory growth.
const rateBuckets = new Map();

/**
 * Token-bucket-ish fixed-window limiter: allow at most `max` calls of
 * `event` per `windowMs` for a given client key. Returns true if allowed.
 * @param {string} key - Client identity key (IP address or socket.id fallback).
 * @param {string} event
 * @param {number} max
 * @param {number} windowMs
 * @returns {boolean}
 */
function allowRate(key, event, max, windowMs) {
  let perClient = rateBuckets.get(key);
  if (!perClient) {
    perClient = new Map();
    rateBuckets.set(key, perClient);
  }
  const now = Date.now();
  const hits = (perClient.get(event) || []).filter(t => now - t < windowMs);
  if (hits.length >= max) {
    perClient.set(event, hits);
    return false;
  }
  hits.push(now);
  perClient.set(event, hits);
  return true;
}

// Periodically prune rate-bucket entries that have had no recent activity.
// Windows are at most 10 s; 60 s is a safe cleanup threshold.
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [key, perClient] of rateBuckets) {
    const hasRecent = [...perClient.values()].some(hits => hits.some(t => t > cutoff));
    if (!hasRecent) rateBuckets.delete(key);
  }
}, 5 * 60_000).unref();

/**
 * Constant-time string equality using crypto.timingSafeEqual.
 * Returns false when either argument is not a string or lengths differ.
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
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

/**
 * Build the per-recipient lobby:state payload for a single player.
 * Scopes myToken and sessionCode to the owning player only — these are
 * never broadcast to other players.
 * @param {object} session - The current GameSession.
 * @param {object} player - The recipient Player.
 * @param {string[]} models - Cached Ollama model list.
 * @returns {object}
 */
function lobbyStateFor(session, player, models) {
  const base = session.getLobbyState();
  const host = session.getHost();
  const isHost = host?.socketId === player.socketId;
  return {
    ...base,
    models,
    myId: player.id,
    myToken: player.rejoinToken || null,
    isHost,
    sessionCode: isHost ? session.sessionCode : undefined,
  };
}

export function registerHandlers(io, socket) {
  // Key rate-limit buckets by client IP so a reconnect doesn't reset the counter.
  const rateKey = socket.handshake.address || socket.id;

  socket.on('lobby:setName', async ({ name, code } = {}) => {
    try {
      if (!allowRate(rateKey, 'lobby:setName', 5, 10000)) {
        socket.emit('error', { message: 'Too many requests — slow down.' });
        return;
      }

      // Public-realm join gate: must present the current session's code.
      // LAN realm (trusted reverse proxy) bypasses this and is what creates
      // the session — so a public player can never spin up a session, and
      // there's nothing to join until the LAN host has joined.
      const existing = gameManager.getSession();
      if (socket.data.realm === 'public' && (!existing || !safeEqual(code, existing.sessionCode))) {
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
        // Existing player updating their name — always allowed.
        player.name = sanitizedName;
        console.log(`[HUMAN] Player "${sanitizedName}" updated name`);
      } else {
        // Brand-new join — only permitted while in the lobby, and within the cap.
        if (session.state !== 'LOBBY') {
          socket.emit('error', { message: 'Game is already in progress.' });
          return;
        }
        const humanCount = session.players.filter(p => p.isHuman).length;
        if (humanCount >= MAX_HUMAN_PLAYERS) {
          socket.emit('error', { message: `Lobby is full (max ${MAX_HUMAN_PLAYERS} human players).` });
          return;
        }
        const playerId = gameManager.generatePlayerId();
        player = session.addPlayer(playerId, true, socket.id);
        player.name = sanitizedName;
        player.realm = socket.data.realm;
        player.rejoinToken = randomBytes(16).toString('hex');
        console.log(`[HUMAN] Player "${sanitizedName}" joined lobby`);
      }

      session.assignHost();
      const models = getCachedModels();
      socket.emit('lobby:state', lobbyStateFor(session, player, models));

      const host = session.getHost();
      if (host && host.socketId !== socket.id) {
        io.to(host.socketId).emit('lobby:state', lobbyStateFor(session, host, models));
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
      // Starting a game is a privileged host action — gate it on the LAN realm
      // like lobby:reset / game:returnToLobby, not just on isHost.
      if (!requireLanHost(session, socket)) return;

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

      const wellFormed = aiPlayers.every(cfg => cfg && typeof cfg === 'object' && typeof cfg.model === 'string' && MODEL_REGEX.test(cfg.model));
      if (!wellFormed) {
        socket.emit('error', { message: 'Each AI player must specify a valid model.' });
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
      if (!allowRate(rateKey, 'game:sendMessage', 1, 1000)) {
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
      if (!allowRate(rateKey, 'game:castVote', 5, 10000)) {
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
      // The host ending the game wipes the single shared session. Notify every
      // socket so all players return to the lobby instead of being stranded on
      // a now-defunct end screen (guests can no longer self-trigger this, since
      // it's LAN-host gated). The caller gets isHost:true as the returning host.
      io.emit('lobby:state', {
        players: [],
        models: [],
        isHost: false,
      });
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
      if (!allowRate(rateKey, 'game:rejoin', 5, 10000)) {
        socket.emit('error', { message: 'Too many requests — slow down.' });
        return;
      }

      const currentSession = gameManager.getSession();
      if (!currentSession || currentSession.state === 'LOBBY') return;
      const player = currentSession.getPlayer(playerId);
      if (!player) return;
      if (!player.rejoinToken || !safeEqual(token, player.rejoinToken)) {
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
      const currentSession = gameManager.getSession();
      if (currentSession) {
        const disconnectedPlayer = currentSession.getPlayerBySocket(socket.id);
        if (disconnectedPlayer) console.log(`[HUMAN] Player "${disconnectedPlayer.name}" disconnected`);
        currentSession.handleDisconnect(socket.id);
        if (currentSession.state === 'LOBBY') {
          const models = getCachedModels();
          for (const p of currentSession.players) {
            if (p.socketId) {
              io.to(p.socketId).emit('lobby:state', lobbyStateFor(currentSession, p, models));
            }
          }
        } else {
          const host = currentSession.getHost();
          if (host && host.socketId) {
            io.to(host.socketId).emit('host:assigned');
          }
          // Push updated disconnect status to all clients immediately so they
          // don't wait until the next phase transition to see the [DISCONNECTED]
          // marker and updated vote-eligibility counts.
          currentSession.emitGameState();
        }
      }
    } catch (err) {
      console.error('disconnect error:', err);
    }
  });
}
