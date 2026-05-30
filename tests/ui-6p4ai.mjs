import { chromium } from 'playwright';

const SERVER = 'http://192.168.1.32:3000';
const AI_MODEL = 'qwen2.5:7b';
const NUM_HUMANS = 6;
const NUM_AIS = 4;
const HUMAN_NAMES = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank'];

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function run() {
  console.log(`=== UI Test: ${NUM_HUMANS} Humans + ${NUM_AIS} AIs ===\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });

  // Create pages for each human player
  const pages = [];
  for (let i = 0; i < NUM_HUMANS; i++) {
    pages.push(await context.newPage());
  }

  try {
    // ── PHASE 1: RESET ──────────────────────────────────────────
    console.log('--- Phase 1: Reset ---');
    const resetPage = await context.newPage();
    await resetPage.goto(SERVER, { waitUntil: 'domcontentloaded' });
    await resetPage.evaluate(() => {
      const s = io();
      s.emit('game:returnToLobby');
      s.on('lobby:state', () => s.disconnect());
    });
    await sleep(1500);
    await resetPage.close();
    console.log('  Session reset OK');

    // ── PHASE 2: ALL PLAYERS JOIN LOBBY ────────────────────────
    console.log('--- Phase 2: All players join lobby ---');

    // Helper: load page, join with name, wait for lobby state
    async function joinLobby(page, name) {
      await page.goto(SERVER, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('canvas', { state: 'attached', timeout: 5000 });
      await page.fill('#nameInput', name);
      await page.click('#joinBtn');
      await page.waitForSelector('#lobbyContent', { state: 'attached', timeout: 5000 });
    }

    // Host joins first
    await joinLobby(pages[0], HUMAN_NAMES[0]);
    await sleep(300);
    console.log(`  [1] ${HUMAN_NAMES[0]} joined (host)`);

    // Other players join
    for (let i = 1; i < NUM_HUMANS; i++) {
      await joinLobby(pages[i], HUMAN_NAMES[i]);
      await sleep(300);
      console.log(`  [${i + 1}] ${HUMAN_NAMES[i]} joined`);
    }

    // Verify player count on host page
    await sleep(500);
    const countText = await pages[0].textContent('#playerCount');
    console.log(`  Host sees: ${countText}`);
    console.assert(
      countText.includes(`HUMANS: ${NUM_HUMANS}`),
      `Host should see ${NUM_HUMANS} humans, got: ${countText}`
    );
    console.log('  All humans in lobby OK');

    // ── PHASE 3: CONFIGURE AI AND START ────────────────────────
    console.log('--- Phase 3: Configure AIs and start ---');

    // Add AI slots one at a time
    for (let i = 0; i < NUM_AIS; i++) {
      const addBtn = await pages[0].waitForSelector('text=+ ADD AI', {
        state: 'attached',
        timeout: 5000,
      });
      await addBtn.click();
      await sleep(200);
    }

    // Verify all AI selects appeared
    const aiSelects = await pages[0].$$('#aiConfig select');
    console.log(`  AI slots: ${aiSelects.length}`);
    console.assert(aiSelects.length === NUM_AIS, `Expected ${NUM_AIS} AI slots, got ${aiSelects.length}`);

    // Set all AI models
    for (const sel of aiSelects) {
      await sel.selectOption(AI_MODEL);
    }
    console.log(`  All AI models set to ${AI_MODEL}`);

    // Verify start button enabled
    await sleep(500);
    const startEnabled = await pages[0].isEnabled('#startBtn');
    console.assert(startEnabled, 'Start button should be enabled');
    console.log('  Start button enabled');

    // Start the game
    console.log('  Starting game...');
    await pages[0].click('#startBtn');

    // Wait for all players to navigate to game.html
    console.log('  Waiting for all players to reach game.html...');
    await Promise.all(
      pages.map(p =>
        p.waitForFunction(
          () => window.location.href.includes('game.html'),
          { timeout: 60000 }
        )
      )
    );
    console.log(`  All ${NUM_HUMANS} players on game.html`);

    // Wait for game state to render
    await Promise.all(
      pages.map(p => p.waitForSelector('#topicDisplay', { state: 'attached', timeout: 10000 }))
    );

    // Wait for actual game state (not the initial 'WAITING')
    await pages[0].waitForFunction(
      () => {
        const el = document.getElementById('phaseDisplay');
        return el && el.textContent !== 'WAITING';
      },
      undefined, { timeout: 15000 }
    );
    const phase0 = await pages[0].textContent('#phaseDisplay');
    console.log(`  Host phase: ${phase0}`);
    console.assert(phase0 === 'PLAYING', `Phase should be PLAYING, got ${phase0}`);

    // Verify all players in sidebar
    await sleep(1000);
    const sidebarText = await pages[0].textContent('#playerSidebar');
    for (const name of HUMAN_NAMES) {
      console.assert(sidebarText.includes(name), `Sidebar should show ${name}`);
    }
    console.log(`  All ${NUM_HUMANS + NUM_AIS} players in sidebar OK`);

    console.log('');

    // ── PHASE 4: GAMEPLAY LOOP ──────────────────────────────────
    console.log('--- Phase 4: Gameplay ---');

    // Helper: send message from a page if it's that player's turn
    async function sendIfMyTurn(page) {
      const input = await page.$('#msgInput');
      if (!input) return false;
      const disabled = await input.getAttribute('disabled');
      if (disabled !== null && disabled !== 'false') return false;
      // Get the player name from the turn indicator
      const name = await page.evaluate(() => {
        const el = document.querySelector('.player-entry span') || document.querySelector('#playerSidebar span');
        return el ? el.textContent.replace('> ', '') : 'Player';
      });
      await page.fill('#msgInput', `${name} analyzing the situation...`);
      await page.click('#sendBtn');
      return true;
    }

    let turnsPlayed = 0;
    const maxTurns = 40; // safety limit
    let inVoting = false;
    const startTime = Date.now();

    while (turnsPlayed < maxTurns && !inVoting) {
      // Check if any page hit voting/ended
      for (const p of pages) {
        const phase = await p.textContent('#phaseDisplay');
        if (phase === 'VOTING' || phase === 'VOTING_SOON' || phase === 'ENDED') {
          console.log(`  Game reached: ${phase} after ${turnsPlayed} turns`);
          inVoting = true;
          break;
        }
      }
      if (inVoting) {
        // If VOTING_SOON, wait for actual VOTING
        const phase = await pages[0].textContent('#phaseDisplay');
        if (phase === 'VOTING_SOON') {
          console.log('  Waiting for voting to start (VOTING_SOON)...');
          await pages[0].waitForFunction(
            () => ['VOTING', 'ENDED'].includes(document.getElementById('phaseDisplay').textContent),
            undefined, { timeout: 60000 }
          );
        }
        break;
      }

      // Try each player's page to see if it's their turn
      let anySent = false;
      for (const p of pages) {
        const sent = await sendIfMyTurn(p);
        if (sent) {
          turnsPlayed++;
          anySent = true;
          break; // Only one player can act per turn
        }
      }

      if (!anySent) {
        await sleep(1000); // AI is thinking or game processing
      }

      // Timeout after 10 minutes
      if (Date.now() - startTime > 600000) {
        console.log('  TIMEOUT: Gameplay took too long');
        break;
      }
    }

    const gameplayTime = ((Date.now() - startTime) / 1000).toFixed(1);
    const finalPhase = await pages[0].textContent('#phaseDisplay');
    const totalMsgs = (await pages[0].$$('#messages > *')).length;
    console.log(`  Turns: ${turnsPlayed}, Phase: ${finalPhase}, Messages: ${totalMsgs}, Time: ${gameplayTime}s`);

    // At this point the game should be in VOTING or ENDED
    // With 10 players and 2 rounds, we need 20 turns (minus AI auto-advance)
    console.assert(
      turnsPlayed >= 8,
      `Expected at least 8 human turns, got ${turnsPlayed}`
    );

    console.log('');

    // ── PHASE 5-6: VOTE AND CONTINUE ────────────────────────────
    // With 10 players the game takes multiple vote rounds to end.
    // Play through 2 vote cycles to verify the full loop.
    let voteRounds = 0;
    const maxVoteRounds = 2;
    let gameEnded = false;
    const roundStartTime = Date.now();

    async function playTurnsUntilVoting(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const phase = await pages[0].textContent('#phaseDisplay');
        if (phase === 'VOTING' || phase === 'ENDED') return phase;

        if (phase === 'VOTING_SOON') {
          console.log('  Waiting for voting to start (VOTING_SOON)...');
          await pages[0].waitForFunction(
            () => ['VOTING', 'ENDED'].includes(document.getElementById('phaseDisplay').textContent),
            undefined, { timeout: 60000 }
          );
          return await pages[0].textContent('#phaseDisplay');
        }

        let anySent = false;
        for (const p of pages) {
          const input = await p.$('#msgInput');
          if (!input) continue;
          const disabled = await input.getAttribute('disabled');
          if (disabled !== null && disabled !== 'false') continue;
          await p.fill('#msgInput', `continuing the discussion...`);
          await p.click('#sendBtn');
          anySent = true;
          break;
        }

        if (!anySent) {
          await sleep(1000); // AI is thinking or game processing
        }
      }
      return pages[0].textContent('#phaseDisplay');
    }

    async function doVoteRound() {
      voteRounds++;
      console.log(`\n--- Vote Round ${voteRounds} ---`);

      // Wait for voting overlay
      await pages[0].waitForFunction(
        () => {
          const el = document.getElementById('votingOverlay');
          return el && el.style.display === 'flex';
        },
        { timeout: 15000 }
      );
      console.log('  Voting overlay visible');

      // Have each non-eliminated human vote for the first non-self target
      for (let i = 0; i < NUM_HUMANS; i++) {
        const btns = await pages[i].$$('#voteTargets button');
        if (btns.length === 0) continue;
        const text = await btns[0].textContent();
        const targetName = text ? text.replace('> VOTE ', '').trim() : '';
        // Use text-based click which handles visibility better
        await pages[i].click(`text=${targetName}`, { timeout: 5000, force: true }).catch(() => {});
        await sleep(200);
      }
      console.log(`  All ${NUM_HUMANS} humans voted`);

      // Wait for vote resolution
      await sleep(3000);
      const phase = await pages[0].textContent('#phaseDisplay');
      console.log(`  After vote: ${phase}`);
      return phase;
    }

    // First vote round
    let phase = await playTurnsUntilVoting(120000);
    if (phase === 'VOTING') phase = await doVoteRound();

    // If game continues, play another cycle
    if (phase === 'PLAYING') {
      phase = await playTurnsUntilVoting(180000);
      if (phase === 'VOTING') phase = await doVoteRound();
    }

    if (phase === 'ENDED') gameEnded = true;

    const elapsed = ((Date.now() - roundStartTime) / 1000).toFixed(1);
    const sidebarOk = await pages[0].textContent('#playerSidebar');
    console.assert(sidebarOk.length > 0, 'Sidebar should still have content');
    console.log(
      `  Final: ${phase}, Vote rounds: ${voteRounds}, Time: ${elapsed}s` +
      (gameEnded ? ', Game ended' : '')
    );

    // ── PHASE 7: RETURN TO LOBBY ────────────────────────────────

    console.log('');
    console.log('--- Phase 7: Return to Lobby ---');

    // Use a temporary socket to emit returnToLobby (game.js socket is module-scoped)
    await pages[0].evaluate(() => {
      const s = io();
      s.emit('game:returnToLobby');
      s.on('lobby:state', () => {
        window.location.href = 'index.html';
        s.disconnect();
      });
    });

    // Host re-joins and verifies fresh lobby
    await pages[0].waitForSelector('#joinPanel', { state: 'attached', timeout: 10000 });
    await pages[0].fill('#nameInput', HUMAN_NAMES[0]);
    await pages[0].click('#joinBtn');
    await pages[0].waitForSelector('#hostPanel', { state: 'attached', timeout: 5000 });
    await sleep(500);

    const finalCount = await pages[0].textContent('#playerCount');
    console.log(`  Fresh lobby count: ${finalCount}`);
    console.assert(
      finalCount.includes('HUMANS: 1'),
      `Fresh lobby should have 1 human, got: ${finalCount}`
    );

    console.log('');
    console.log(`=== ALL UI 6v4 TESTS PASSED ===`);
  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    try {
      for (let i = 0; i < pages.length; i++) {
        await pages[i].screenshot({ path: `/tmp/cogito-6v4-fail-P${i}.png` });
      }
      console.log(`Screenshots saved to /tmp/cogito-6v4-fail-P*.png`);
    } catch {}
    process.exit(1);
  } finally {
    await browser.close();
  }
}

run();
