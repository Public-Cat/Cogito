import gameManager from '../game/GameManager.js';
import { getCachedModels } from '../ollama/OllamaClient.js';

const NAME_REGEX = /^[a-zA-Z0-9 ]{1,20}$/;
const MAX_MESSAGE_LENGTH = 500;

function sanitize(str) {
  return str.replace(/[<>&"']/g, '');
}

export function registerHandlers(io, socket) {
  socket.on('lobby:setName', async ({ name } = {}) => {
    try {
      const session = gameManager.getOrCreateSession();
      if (!name || !NAME_REGEX.test(name)) {
        socket.emit('error', { message: 'Name must be 1-20 characters, alphanumeric with spaces.' });
        return;
      }
      const sanitizedName = sanitize(name.trim());

      const existingPlayer = session.getPlayerBySocket(socket.id);
      if (existingPlayer) {
        existingPlayer.name = sanitizedName;
        console.log(`[HUMAN] Player "${sanitizedName}" updated name`);
      } else {
        const playerId = gameManager.generatePlayerId();
        const newPlayer = session.addPlayer(playerId, true, socket.id);
        newPlayer.name = sanitizedName;
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
        models,
        isHost: session.getHost()?.socketId === socket.id,
      };
      socket.emit('lobby:state', state);

      const host = session.getHost();
      if (host && host.socketId !== socket.id) {
        const hostState = {
          ...state,
          myId: host.id,
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

      if (!aiPlayers || aiPlayers.length < 1) {
        socket.emit('error', { message: 'Need at least 1 AI player.' });
        return;
      }

      const config = { topic: topic || null, aiPlayers };

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

  socket.on('lobby:reset', () => {
    try {
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

  socket.on('game:rejoin', ({ playerId } = {}) => {
    try {
      const currentSession = gameManager.getSession();
      if (!currentSession || currentSession.state === 'LOBBY') return;
      const player = currentSession.getPlayer(playerId);
      if (!player) return;
      player.socketId = socket.id;
      player.isDisconnected = false;
      player.isActive = true;
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
          const lobbyState = currentSession.getLobbyState();
          const models = getCachedModels();
          for (const p of currentSession.players) {
            if (p.socketId) {
              io.to(p.socketId).emit('lobby:state', {
                ...lobbyState, models, myId: p.id,
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
