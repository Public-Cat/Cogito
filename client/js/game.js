import { playVote, playEliminated, playWin, playLose } from './sfx.js';

const socket = io();

let myId = localStorage.getItem('cogito_myId') || null;
let gameState = null;
let voteSoonCountdown = null;
let voteSoonInterval = null;

const app = document.getElementById('app');

function render() {
  app.innerHTML = `
    <div id="topBar" class="panel" style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <span id="topicDisplay" style="color:var(--color-primary);">connecting...</span>
      <span id="roundDisplay" style="color:var(--color-text-dim);">round 0</span>
      <span id="phaseDisplay" style="color:var(--color-warning);">WAITING</span>
    </div>
    <div style="display:flex;gap:8px;height:calc(100vh - 100px);">
      <div id="chatArea" class="panel" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;padding:8px;">
        <div id="messages" style="flex:1;overflow-y:auto;"></div>
        <div id="inputArea" style="display:flex;gap:8px;padding-top:8px;border-top:1px solid var(--color-primary-dim);">
          <span style="color:var(--color-text-dim);">></span>
          <input type="text" id="msgInput" maxlength="500" placeholder="type your message..." style="flex:1;" disabled>
          <button id="sendBtn" disabled>> SEND</button>
        </div>
        <div id="turnIndicator" style="color:var(--color-text-dim);font-size:12px;margin-top:4px;"></div>
      </div>
      <button id="sidebarToggle">[+]</button>
      <div id="playerSidebar" class="panel" style="width:200px;overflow-y:auto;display:none;"></div>
    </div>
    <div id="votingOverlay" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.95);z-index:100;justify-content:center;align-items:center;flex-direction:column;">
      <h2 style="color:var(--color-warning);margin-bottom:24px;">> VOTING PHASE</h2>
      <p id="voteTimer" style="color:var(--color-text-dim);margin-bottom:16px;">5</p>
      <div id="voteTargets" style="display:flex;flex-wrap:wrap;gap:12px;justify-content:center;max-width:600px;"></div>
      <div id="voteWaiting" style="display:none;color:var(--color-text-dim);margin-top:24px;">> WAITING FOR VOTES...</div>
    </div>
    <div id="eliminationOverlay" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.95);z-index:150;justify-content:center;align-items:center;flex-direction:column;">
      <h2 style="color:var(--color-warning);margin-bottom:24px;">> ELIMINATION</h2>
      <div id="eliminationContent" style="max-width:500px;width:100%;text-align:center;"></div>
    </div>
    <div id="endOverlay" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.95);z-index:200;justify-content:center;align-items:center;flex-direction:column;">
      <h1 id="endTitle" style="font-size:3em;margin-bottom:24px;"></h1>
      <div id="endReveal" style="max-width:500px;width:100%;"></div>
      <button id="returnBtn" style="margin-top:24px;padding:12px 24px;">> RETURN TO LOBBY</button>
    </div>
  `;

  document.getElementById('sendBtn').addEventListener('click', sendMessage);
  document.getElementById('msgInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
  document.getElementById('returnBtn').addEventListener('click', () => {
    socket.emit('game:returnToLobby');
  });

  document.getElementById('sidebarToggle').addEventListener('click', () => {
    const sidebar = document.getElementById('playerSidebar');
    sidebar.classList.toggle('open');
    const btn = document.getElementById('sidebarToggle');
    btn.textContent = sidebar.classList.contains('open') ? '[-]' : '[+]';
  });
}

function sendMessage() {
  const input = document.getElementById('msgInput');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('game:sendMessage', { text });
  input.value = '';
  input.disabled = true;
  document.getElementById('sendBtn').disabled = true;
}

function updateUI(state) {
  gameState = state;
  if (state.myId) {
    myId = state.myId;
  }

  document.getElementById('topicDisplay').textContent = `> ${state.topic || 'no topic'}`;
  document.getElementById('roundDisplay').textContent = `round ${state.round}`;
  document.getElementById('phaseDisplay').textContent = state.phase;

  const isMyTurn = state.currentTurn === myId;
  const input = document.getElementById('msgInput');
  const sendBtn = document.getElementById('sendBtn');
  const turnIndicator = document.getElementById('turnIndicator');

  if (state.phase === 'PLAYING') {
    document.getElementById('eliminationOverlay').style.display = 'none';
    input.disabled = !isMyTurn;
    sendBtn.disabled = !isMyTurn;
    if (isMyTurn) {
      turnIndicator.textContent = '> your turn';
      input.focus();
    } else {
      const currentPlayer = state.players.find(p => p.id === state.currentTurn);
      turnIndicator.textContent = currentPlayer ? `> waiting for ${currentPlayer.name}...` : '> waiting...';
    }
  } else if (state.phase === 'VOTING_SOON') {
    input.disabled = true;
    sendBtn.disabled = true;
    const remaining = voteSoonCountdown !== null ? voteSoonCountdown : 5;
    turnIndicator.textContent = `> voting in ${remaining}s...`;
  } else {
    input.disabled = true;
    sendBtn.disabled = true;
    turnIndicator.textContent = '';
  }

  renderPlayerList(state.players, state.currentTurn);
}

function renderPlayerList(players, currentTurnId) {
  const sidebar = document.getElementById('playerSidebar');
  sidebar.style.display = 'block';
  sidebar.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <h3 style="color:var(--color-text-dim);margin:0;">players</h3>
      <button id="sidebarClose" style="background:none;border:none;color:var(--color-text);cursor:pointer;font-family:var(--font-mono);font-size:16px;padding:2px 6px;">X</button>
    </div>
  `;
  const closeBtn = sidebar.querySelector('#sidebarClose');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      sidebar.classList.remove('open');
      document.getElementById('sidebarToggle').textContent = '[+]';
    });
  }
  players.forEach(p => {
    const div = document.createElement('div');
    div.style.padding = '4px 0';
    div.style.display = 'flex';
    div.style.justifyContent = 'space-between';
    div.style.alignItems = 'center';
    if (p.isEliminated) div.style.opacity = '0.4';
    if (p.id === currentTurnId) {
      div.style.borderLeft = '2px solid var(--color-primary)';
      div.style.paddingLeft = '4px';
    }
    const nameSpan = document.createElement('span');
    nameSpan.textContent = `> ${p.name}`;
    if (p.isEliminated) {
      const termTag = document.createElement('span');
      termTag.textContent = ' [TERMINATED]';
      termTag.style.color = 'var(--color-danger)';
      nameSpan.appendChild(termTag);
    } else if (p.isDisconnected) {
      const discTag = document.createElement('span');
      discTag.textContent = ' [DISCONNECTED]';
      discTag.style.color = 'var(--color-warning)';
      nameSpan.appendChild(discTag);
    }
    div.appendChild(nameSpan);
    sidebar.appendChild(div);
  });
}

function addMessage(msg, animate = true) {
  const container = document.getElementById('messages');
  const div = document.createElement('div');
  div.style.marginBottom = '4px';
  div.style.wordBreak = 'break-word';

  if (animate && msg.playerId !== myId) {
    const prefix = document.createElement('span');
    prefix.style.color = 'var(--color-text-dim)';
    prefix.textContent = `[${msg.playerName}] > `;
    div.appendChild(prefix);

    const textSpan = document.createElement('span');
    textSpan.textContent = '';
    div.appendChild(textSpan);
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;

    let idx = 0;
    const chars = msg.text.split('');
    function typeChar() {
      if (idx < chars.length) {
        textSpan.textContent += chars[idx];
        idx++;
        container.scrollTop = container.scrollHeight;
        const delay = 10 + Math.random() * 30;
        setTimeout(typeChar, delay);
      }
    }
    typeChar();
  } else {
    const playerInState = gameState ? gameState.players.find(p => p.id === msg.playerId) : null;
    const isEliminated = playerInState ? playerInState.isEliminated : false;
    if (isEliminated) div.style.opacity = '0.4';
    div.textContent = `[${msg.playerName}] > ${msg.text}`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }
}

function showVotingOverlay() {
  const overlay = document.getElementById('votingOverlay');
  overlay.style.display = 'flex';
  const targetsDiv = document.getElementById('voteTargets');
  targetsDiv.innerHTML = '<p style="color:var(--color-text-dim);">> AI players are voting...</p>';
  document.getElementById('voteTimer').textContent = '10';
  document.getElementById('voteWaiting').style.display = 'none';

  if (gameState) {
    const activePlayers = gameState.players.filter(p => !p.isEliminated && !p.isDisconnected);
    const list = document.createElement('div');
    list.style.marginTop = '16px';
    list.style.textAlign = 'left';
    list.innerHTML = '<h3 style="color:var(--color-text-dim);margin-bottom:8px;text-align:center;">players:</h3>';
    activePlayers.forEach(p => {
      const div = document.createElement('div');
      div.style.padding = '2px 0';
      div.style.color = 'var(--color-text-dim)';
      div.textContent = `> ${p.name}`;
      list.appendChild(div);
    });
    targetsDiv.appendChild(list);
  }

  document.querySelectorAll('#voteTargets button').forEach(b => b.disabled = true);

  let timeLeft = 10;
  const timer = setInterval(() => {
    timeLeft--;
    document.getElementById('voteTimer').textContent = timeLeft;
    if (timeLeft <= 0) {
      clearInterval(timer);
    }
  }, 1000);
}

function showVoteResult(result) {
  document.getElementById('votingOverlay').style.display = 'none';
  const overlay = document.getElementById('eliminationOverlay');
  const content = document.getElementById('eliminationContent');

  if (result.eliminated) {
    const p = result.eliminated;
    const type = p.isHuman ? 'HUMAN' : 'AI';
    content.innerHTML = `
      <div style="margin:12px 0;padding:16px 24px;border:1px solid var(--color-danger);color:var(--color-danger);font-size:1.3em;text-align:center;box-shadow:0 0 8px var(--color-danger);">
        > ${p.name} TERMINATED (${type})
      </div>`;
  } else {
    content.innerHTML = '<p style="color:var(--color-text-dim);font-size:1.2em;">> NO ELIMINATION THIS ROUND</p>';
  }

  overlay.style.display = 'flex';

  const container = document.getElementById('messages');
  const div = document.createElement('div');
  div.style.margin = '8px 0';
  div.style.padding = '8px';
  div.style.border = '1px solid var(--color-primary-dim)';
  if (result.eliminated) {
    const p = result.eliminated;
    const type = p.isHuman ? 'HUMAN' : 'AI';
    div.innerHTML = `<div style="color:var(--color-warning);">> VOTE RESULT</div><div>Eliminated: ${p.name} (${type})</div>`;
  } else {
    div.innerHTML = '<div style="color:var(--color-warning);">> VOTE RESULT</div><div style="color:var(--color-text-dim);">No elimination (tie)</div>';
  }
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function showEndScreen(data) {
  document.getElementById('eliminationOverlay').style.display = 'none';
  document.getElementById('endOverlay').style.display = 'flex';
  const title = document.getElementById('endTitle');
  if (data.winner === 'humans') {
    title.textContent = '> HUMANS WIN';
    title.style.color = 'var(--color-primary)';
  } else {
    title.textContent = '> AIs WIN';
    title.style.color = 'var(--color-danger)';
  }
  const revealDiv = document.getElementById('endReveal');
  revealDiv.innerHTML = '<h3 style="margin-bottom:12px;color:var(--color-text-dim);">player identities:</h3>';
  data.players.forEach(p => {
    const div = document.createElement('div');
    div.style.padding = '4px 0';
    const identity = p.isHuman ? 'HUMAN' : `AI (${p.model || 'unknown'})`;
    const color = p.isHuman ? 'var(--color-primary)' : 'var(--color-warning)';
    div.innerHTML = `<span>> ${p.name}</span> <span style="color:${color};">${identity}</span>`;
    revealDiv.appendChild(div);
  });
}

socket.on('game:state', (state) => {
  updateUI(state);
  const container = document.getElementById('messages');
  if (container && state.messages) {
    container.innerHTML = '';
    state.messages.forEach(msg => addMessage(msg, false));
  }
});

socket.on('game:newMessage', (msg) => {
  addMessage(msg, true);
  if (gameState) {
    gameState.messages.push(msg);
  }
});

socket.on('game:votingSoon', ({ delay }) => {
  const container = document.getElementById('messages');
  const div = document.createElement('div');
  div.style.margin = '8px 0';
  div.style.padding = '8px';
  div.style.border = '1px solid var(--color-warning)';
  div.style.color = 'var(--color-warning)';
  div.textContent = `> VOTING IN ${delay}s...`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;

  if (voteSoonInterval) clearInterval(voteSoonInterval);
  voteSoonCountdown = delay;
  const turnIndicator = document.getElementById('turnIndicator');
  turnIndicator.textContent = `> voting in ${voteSoonCountdown}s...`;
  voteSoonInterval = setInterval(() => {
    voteSoonCountdown--;
    if (voteSoonCountdown > 0) {
      turnIndicator.textContent = `> voting in ${voteSoonCountdown}s...`;
    } else {
      turnIndicator.textContent = '> voting...';
      clearInterval(voteSoonInterval);
      voteSoonInterval = null;
    }
  }, 1000);
});

socket.on('game:voteStart', () => {
  if (voteSoonInterval) {
    clearInterval(voteSoonInterval);
    voteSoonInterval = null;
  }
  voteSoonCountdown = null;
  playVote();
  showVotingOverlay();
});

socket.on('game:voteResult', (result) => {
  if (result.aiEliminated || result.humanEliminated) {
    playEliminated();
  }
  showVoteResult(result);
});

socket.on('game:ended', (data) => {
  if (data.winner === 'humans') {
    playWin();
  } else {
    playLose();
  }
  showEndScreen(data);
});

socket.on('lobby:state', () => {
  window.location.href = 'index.html';
});

socket.on('error', ({ message }) => {
  const container = document.getElementById('messages');
  if (container) {
    const div = document.createElement('div');
    div.style.color = 'var(--color-danger)';
    div.textContent = `> ERROR: ${message}`;
    container.appendChild(div);
  }
});

render();

if (myId) {
  socket.emit('game:rejoin', { playerId: myId });
}
