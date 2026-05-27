import gameManager from '../game/GameManager.js';
import { getCachedModels } from '../ollama/OllamaClient.js';

const NAME_REGEX = /^[a-zA-Z0-9 ]{1,20}$/;
const MAX_MESSAGE_LENGTH = 500;

function sanitize(str) {
  return str.replace(/[<>&"']/g, '');
}

export function registerHandlers(io, socket) {
  const session = gameManager.getOrCreateSession();

  socket.on('lobby:setName', async ({ name } = {}) => {
    try {
      if (!name || !NAME_REGEX.test(name)) {
        socket.emit('error', { message: 'Name must be 1-20 characters, alphanumeric with spaces.' });
        return;
      }
      const sanitizedName = sanitize(name.trim());

      const existingPlayer = session.getPlayerBySocket(socket.id);
      if (existingPlayer) {
        existingPlayer.name = sanitizedName;
      } else {
        const playerId = gameManager.generatePlayerId();
        const newPlayer = session.addPlayer(playerId, true, socket.id);
        newPlayer.name = sanitizedName;
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

      await session.startGame(config);

      const gameState = session.getGameState();
      for (const p of session.players) {
        if (p.socketId) {
          io.to(p.socketId).emit('game:state', { ...gameState, myId: p.id });
        }
      }

      session.emitToAll = (event, data) => {
        io.emit(event, data);
      };
      session.emitToSocket = (socketId, event, data) => {
        io.to(socketId).emit(event, data);
      };

      if (typeof callback === 'function') callback({ ok: true });

      setTimeout(() => {
        const firstPlayer = session.turnOrder[0];
        if (firstPlayer && !firstPlayer.isHuman) {
          session.handleTurn();
        }
      }, 500);
    } catch (err) {
      console.error('lobby:start error:', err);
      socket.emit('error', { message: 'Failed to start game.' });
    }
  });

  socket.on('game:sendMessage', ({ text } = {}) => {
    try {
      if (!text || text.length > MAX_MESSAGE_LENGTH) {
        socket.emit('error', { message: 'Message must be 1-500 characters.' });
        return;
      }

      const player = session.getPlayerBySocket(socket.id);
      if (!player) {
        socket.emit('error', { message: 'Player not found.' });
        return;
      }

      if (session.state !== 'PLAYING') {
        socket.emit('error', { message: 'Not in playing phase.' });
        return;
      }

      const currentPlayer = session.turnOrder[session.currentTurnIndex];
      if (!currentPlayer || currentPlayer.id !== player.id) {
        socket.emit('error', { message: 'It is not your turn.' });
        return;
      }

      const sanitizedText = sanitize(text.trim());
      const message = {
        playerId: player.id,
        playerName: player.name,
        text: sanitizedText,
        timestamp: Date.now(),
      };
      session.messages.push(message);
      io.emit('game:newMessage', message);

      session.advanceTurn();
    } catch (err) {
      console.error('game:sendMessage error:', err);
      socket.emit('error', { message: 'Failed to send message.' });
    }
  });

  socket.on('game:vote', ({ targetId } = {}) => {
    try {
      const player = session.getPlayerBySocket(socket.id);
      if (!player) {
        socket.emit('error', { message: 'Player not found.' });
        return;
      }

      if (session.state !== 'VOTING') {
        socket.emit('error', { message: 'Not in voting phase.' });
        return;
      }

      const target = session.getPlayer(targetId);
      if (!target || target.isEliminated) {
        socket.emit('error', { message: 'Invalid vote target.' });
        return;
      }

      session.submitHumanVote(player.id, targetId);
    } catch (err) {
      console.error('game:vote error:', err);
      socket.emit('error', { message: 'Failed to submit vote.' });
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
      const gameState = currentSession.getGameState();
      socket.emit('game:state', { ...gameState, myId: player.id });
    } catch (err) {
      console.error('game:rejoin error:', err);
    }
  });

  socket.on('disconnect', () => {
    try {
      const currentSession = gameManager.getSession();
      if (currentSession) {
        currentSession.handleDisconnect(socket.id);
        const host = currentSession.getHost();
        if (host && host.socketId) {
          io.to(host.socketId).emit('host:assigned');
        }
      }
    } catch (err) {
      console.error('disconnect error:', err);
    }
  });
}
