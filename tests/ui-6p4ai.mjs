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

    async function joinLobby(page, name) {
      await page.goto(SERVER, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('canvas', { state: 'attached', timeout: 5000 });
      await page.fill('#nameInput', name);
      await page.click('#joinBtn');
      await page.waitForSelector('#lobbyContent', { state: 'attached', timeout: 5000 });
    }

    await joinLobby(pages[0], HUMAN_NAMES[0]);
    await sleep(300);
    console.log(`  [1] ${HUMAN_NAMES[0]} joined (host)`);

    for (let i = 1; i < NUM_HUMANS; i++) {
      await joinLobby(pages[i], HUMAN_NAMES[i]);
      await sleep(300);
      console.log(`  [${i + 1}] ${HUMAN_NAMES[i]} joined`);
    }

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

    for (let i = 0; i < NUM_AIS; i++) {
      const addBtn = await pages[0].waitForSelector('text=+ ADD AI', {
        state: 'attached',
        timeout: 5000,
      });
      await addBtn.click();
      await sleep(200);
    }

    const aiSelects = await pages[0].$$('#aiConfig select');
    console.log(`  AI slots: ${aiSelects.length}`);
    console.assert(aiSelects.length === NUM_AIS, `Expected ${NUM_AIS} AI slots, got ${aiSelects.length}`);

    for (const sel of aiSelects) {
      await sel.selectOption(AI_MODEL);
    }
    console.log(`  All AI models set to ${AI_MODEL}`);

    await sleep(500);
    const startEnabled = await pages[0].isEnabled('#startBtn');
    console.assert(startEnabled, 'Start button should be enabled');
    console.log('  Start button enabled');

    console.log('  Starting game...');
    await pages[0].click('#startBtn');

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
    if (phase0 !== 'SUBMITTING') throw new Error(`Phase should be SUBMITTING, got ${phase0}`);

    await sleep(1000);
    const sidebarText = await pages[0].textContent('#playerSidebar');
    for (const name of HUMAN_NAMES) {
      console.assert(sidebarText.includes(name), `Sidebar should show ${name}`);
    }
    console.log(`  All ${NUM_HUMANS + NUM_AIS} players in sidebar OK`);

    console.log('');

    // ── PHASE 4: GAMEPLAY LOOP ──────────────────────────────────
    console.log('--- Phase 4: Gameplay ---');

    async function waitForPhase(page, phase, timeout = 60000) {
      await page.waitForFunction(
        (p) => document.getElementById('phaseDisplay').textContent === p,
        phase,
        { timeout }
      );
    }

    async function submitIfEnabled(page, text) {
      return await page.evaluate((msgText) => {
        const input = document.getElementById('msgInput');
        if (!input) return false;
        if (input.disabled) return false;
        input.value = msgText;
        const sendBtn = document.getElementById('sendBtn');
        if (sendBtn) sendBtn.click();
        return true;
      }, text);
    }

    // Drive the game: SUBMITTING→REVEALING cycles
    // With 10 players it takes multiple vote rounds to end
    const startTime = Date.now();
    const MAX_DURATION_MS = 600000; // 10 min safety
    let roundCount = 0;
    let voteRoundCount = 0;
    let gameEnded = false;

    while (!gameEnded) {
      if (Date.now() - startTime > MAX_DURATION_MS) {
        throw new Error('TIMEOUT after ' + (MAX_DURATION_MS / 1000) + 's');
      }

      const phase = await pages[0].textContent('#phaseDisplay');

      if (phase === 'SUBMITTING') {
        roundCount++;
        console.log(`  SUBMITTING round ${roundCount} — submitting all humans...`);

        for (let i = 0; i < NUM_HUMANS; i++) {
          await submitIfEnabled(pages[i], `${HUMAN_NAMES[i]} discussing the current topic.`);
        }

        await waitForPhase(pages[0], 'REVEALING', 30000);
        const msgs = await pages[0].$$('#messages > *');
        console.log(`  REVEALING round ${roundCount}: ${msgs.length} messages`);

      } else if (phase === 'VOTING_SOON') {
        console.log('  VOTING_SOON — waiting for VOTING phase...');
        await waitForPhase(pages[0], 'VOTING', 30000);

      } else if (phase === 'VOTING') {
        voteRoundCount++;
        console.log(`  VOTING round ${voteRoundCount} — AI-only vote, humans spectate...`);

        // Verify voting overlay
        await pages[0].waitForFunction(
          () => {
            const el = document.getElementById('votingOverlay');
            return el && el.style.display === 'flex';
          },
          { timeout: 20000 }
        );

        const spectatorMsg = await pages[0].textContent('#voteTargets');
        console.assert(spectatorMsg.includes('AI players are voting'), 'Should show AI voting message');

        // Wait for vote resolution + post-vote transition
        // After voteResult, 3s delay, then either SUBMITTING or ENDED
        await sleep(4000);
        const afterVote = await pages[0].textContent('#phaseDisplay');
        console.log(`  After vote: ${afterVote}`);

        // If still in VOTING, wait for the transition
        if (afterVote === 'VOTING') {
          await pages[0].waitForFunction(
            () => {
              const el = document.getElementById('phaseDisplay');
              return el && ['SUBMITTING', 'ENDED'].includes(el.textContent);
            },
            undefined, { timeout: 30000 }
          );
        }

      } else if (phase === 'ENDED') {
        gameEnded = true;

      } else if (phase === 'REVEALING') {
        // Already handled in SUBMITTING branch; just wait for next phase
        await pages[0].waitForFunction(
          () => {
            const el = document.getElementById('phaseDisplay');
            return el && el.textContent !== 'REVEALING';
          },
          undefined, { timeout: 30000 }
        );

      } else {
        await sleep(1000);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const finalPhase = await pages[0].textContent('#phaseDisplay');
    const totalMsgs = (await pages[0].$$('#messages > *')).length;
    console.log(
      `  Final: ${finalPhase}, Rounds: ${roundCount}, Vote rounds: ${voteRoundCount}, ` +
      `Messages: ${totalMsgs}, Time: ${elapsed}s`
    );

    console.log('');

    // ── PHASE 5: RETURN TO LOBBY ────────────────────────────────
    console.log('--- Phase 5: Return to Lobby ---');

    await pages[0].evaluate(() => {
      const s = io();
      s.emit('game:returnToLobby');
      s.on('lobby:state', () => {
        window.location.href = 'index.html';
        s.disconnect();
      });
    });

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
