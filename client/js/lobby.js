const socket = io();

let scrambleIntervals = [];

const app = document.getElementById('app');
const SCRAMBLE_CHARS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomChar() {
  return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
}

function scrambleName(length) {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += randomChar();
  }
  return result;
}

function startScramble(el, length) {
  const interval = setInterval(() => {
    el.textContent = '> ' + scrambleName(length);
  }, 120);
  scrambleIntervals.push(interval);
}

function clearScrambles() {
  scrambleIntervals.forEach(clearInterval);
  scrambleIntervals = [];
}

function render() {
  app.innerHTML = `
    <div class="panel" style="max-width:600px;margin:40px auto;">
      <h1 style="text-align:center;font-size:2em;margin-bottom:16px;">> COGITO</h1>
      <p style="text-align:center;margin-bottom:24px;color:var(--color-text-dim);">cogito ergo sum. but do you?</p>
      <div id="joinPanel">
        <label for="nameInput">enter designation:</label><br>
        <input type="text" id="nameInput" maxlength="20" placeholder="your name" style="width:100%;margin:8px 0;">
        <button id="joinBtn" style="width:100%;">> JOIN</button>
      </div>
      <div id="lobbyContent" style="display:none;">
        <div id="waitingMsg" style="color:var(--color-text-dim);">waiting for host to start...</div>
        <div id="hostPanel" style="display:none;">
          <h2>host controls</h2>
          <label for="topicSelect">topic:</label>
          <select id="topicSelect" style="width:100%;margin:4px 0 12px;"></select>
          <div id="aiConfig"></div>
          <button id="startBtn" disabled style="width:100%;margin-top:12px;">> START GAME</button>
        </div>
        <div id="playerCount" style="margin-top:12px;color:var(--color-text-dim);"></div>
        <h3 style="margin-top:12px;">players in lobby:</h3>
        <div id="playerList"></div>
      </div>
      <div style="margin-top:12px;text-align:center;">
        <button id="resetBtn" style="color:var(--color-danger);border-color:var(--color-danger);width:100%;">> HARD RESET</button>
      </div>
    </div>
  `;

  document.getElementById('joinBtn').addEventListener('click', joinLobby);
  document.getElementById('nameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinLobby();
  });
  document.getElementById('resetBtn').addEventListener('click', () => {
    if (confirm('Reset all sessions and kick all players?')) {
      socket.emit('lobby:reset');
    }
  });
}

function joinLobby() {
  const name = document.getElementById('nameInput').value.trim();
  if (!name) return;
  socket.emit('lobby:setName', { name });
}

function showLobby(state) {
  clearScrambles();
  const joinPanel = document.getElementById('joinPanel');
  const lobbyContent = document.getElementById('lobbyContent');

  if (!state.players || state.players.length === 0) {
    joinPanel.style.display = 'block';
    lobbyContent.style.display = 'none';
    document.getElementById('playerCount').textContent = '';
    document.getElementById('playerList').innerHTML = '';
    return;
  }

  joinPanel.style.display = 'none';
  lobbyContent.style.display = 'block';

  const waitingMsg = document.getElementById('waitingMsg');
  const hostPanel = document.getElementById('hostPanel');

  if (state.isHost) {
    waitingMsg.style.display = 'none';
    hostPanel.style.display = 'block';
    setupHostPanel(state);
  } else {
    waitingMsg.style.display = 'block';
    hostPanel.style.display = 'none';
  }

  renderPlayerList(state.players);
}

function setupHostPanel(state) {
  // Replace start button to strip stale listeners (accumulated from repeated lobby:state calls)
  const oldBtn = document.getElementById('startBtn');
  if (oldBtn) {
    const newBtn = oldBtn.cloneNode(true);
    oldBtn.parentNode.replaceChild(newBtn, oldBtn);
    newBtn.id = 'startBtn';
    newBtn.disabled = true;
  }

  const prevModels = Array.from(document.querySelectorAll('#aiConfig select')).map(sel => sel.value);
  const prevTopic = document.getElementById('topicSelect')?.value || '';

  const topicSelect = document.getElementById('topicSelect');
  topicSelect.innerHTML = '<option value="">-- random --</option>';
  const topics = [
    'Would you rather live in the city or the countryside?',
    'What makes a piece of music unforgettable?',
    'Is it ever okay to lie to someone you love?',
    'What makes a great leader?',
    'If you could master one skill instantly, what would it be?',
    'What is the most important quality in a friend?',
    'Should animals have the same rights as humans?',
    'What does it mean to live a good life?',
    'Is technology making us more or less connected?',
    'What is the best book you have ever read and why?',
    'If you could travel anywhere, where would you go?',
    'What is the most important invention in human history?',
    'Is it better to be talented or hardworking?',
    'What is your earliest memory?',
    'If you could have dinner with any historical figure, who would it be?',
  ];
  topics.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    topicSelect.appendChild(opt);
  });
  if (prevTopic) topicSelect.value = prevTopic;

  const aiConfigDiv = document.getElementById('aiConfig');
  aiConfigDiv.innerHTML = '<label>AI players:</label>';
  prevModels.forEach(model => {
    const slot = document.createElement('div');
    slot.style.display = 'flex';
    slot.style.gap = '8px';
    slot.style.margin = '4px 0';
    const select = document.createElement('select');
    if (state.models.length === 0) {
      const opt = document.createElement('option');
      opt.value = 'llama3';
      opt.textContent = 'llama3 (default)';
      select.appendChild(opt);
    } else {
      state.models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        select.appendChild(opt);
      });
    }
    select.value = model;
    select.style.flex = '1';
    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'X';
    removeBtn.addEventListener('click', () => {
      slot.remove();
      updateStartBtn(state);
    });
    slot.appendChild(select);
    slot.appendChild(removeBtn);
    aiConfigDiv.appendChild(slot);
  });
  const addAiBtn = document.createElement('button');
  addAiBtn.textContent = '+ ADD AI';
  addAiBtn.style.margin = '4px 0';
  addAiBtn.addEventListener('click', () => addAiSlot(state.models));
  aiConfigDiv.appendChild(addAiBtn);

  const startBtn = document.getElementById('startBtn');
  updateStartBtn(state);
  startBtn.addEventListener('click', () => {
    const aiSlots = document.querySelectorAll('#aiConfig select');
    const aiPlayers = Array.from(aiSlots).map(select => ({ model: select.value }));
    const topicSelect = document.getElementById('topicSelect');
    const topic = topicSelect.value || null;
    socket.emit('lobby:start', { topic, aiPlayers }, (response) => {
      if (response && response.ok) {
        clearScrambles();
        document.getElementById('lobbyContent').innerHTML = '<p style="text-align:center;color:var(--color-primary);">GAME STARTING...</p>';
      }
    });
  });
}

function addAiSlot(models) {
  const container = document.getElementById('aiConfig');
  const slot = document.createElement('div');
  slot.style.display = 'flex';
  slot.style.gap = '8px';
  slot.style.margin = '4px 0';
  const select = document.createElement('select');
  if (models.length === 0) {
    const opt = document.createElement('option');
    opt.value = 'llama3';
    opt.textContent = 'llama3 (default)';
    select.appendChild(opt);
  } else {
    models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      select.appendChild(opt);
    });
  }
  select.style.flex = '1';
  const removeBtn = document.createElement('button');
  removeBtn.textContent = 'X';
  removeBtn.addEventListener('click', () => {
    slot.remove();
    const state = { players: getCurrentPlayers(), models };
    updateStartBtn(state);
  });
  slot.appendChild(select);
  slot.appendChild(removeBtn);
  container.appendChild(slot);
  const state = { players: getCurrentPlayers(), models };
  updateStartBtn(state);
}

function getCurrentPlayers() {
  const list = document.getElementById('playerList');
  if (!list) return [];
  const items = list.querySelectorAll('.player-entry');
  return Array.from(items).map(el => ({
    isHuman: el.dataset.isHuman === 'true',
  }));
}

function updateStartBtn(state) {
  const startBtn = document.getElementById('startBtn');
  if (!startBtn) return;
  const humans = (state.players || []).filter(p => p.isHuman).length;
  const aiSlots = document.querySelectorAll('#aiConfig select').length;
  startBtn.disabled = !(humans >= 2 && aiSlots >= 1);
}

function renderPlayerList(players) {
  const countDiv = document.getElementById('playerCount');
  const humanCount = players.filter(p => p.isHuman).length;
  const aiCount = players.filter(p => !p.isHuman).length;
  countDiv.textContent = `> HUMANS: ${humanCount}  |  AIs: ${aiCount}`;

  const list = document.getElementById('playerList');
  list.innerHTML = '';
  players.forEach(p => {
    const div = document.createElement('div');
    div.className = 'player-entry';
    div.dataset.isHuman = p.isHuman;
    div.style.display = 'flex';
    div.style.justifyContent = 'space-between';
    div.style.padding = '4px 0';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = '> ' + scrambleName(p.name.length);
    div.appendChild(nameSpan);

    list.appendChild(div);

    startScramble(nameSpan, p.name.length);
  });
}

socket.on('lobby:state', (state) => {
  showLobby(state);
});

socket.on('host:assigned', () => {
  const waitingMsg = document.getElementById('waitingMsg');
  if (waitingMsg) waitingMsg.textContent = 'you are now the host';
});

socket.on('game:state', (state) => {
  clearScrambles();
  sessionStorage.setItem('cogito_myId', state.myId || '');
  window.location.href = 'game.html';
});

socket.on('error', ({ message }) => {
  const errDiv = document.createElement('div');
  errDiv.style.color = 'var(--color-danger)';
  errDiv.style.textAlign = 'center';
  errDiv.style.marginTop = '8px';
  errDiv.textContent = `> ERROR: ${message}`;
  app.appendChild(errDiv);
});

render();
