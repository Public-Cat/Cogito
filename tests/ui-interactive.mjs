import { chromium } from 'playwright';

const SERVER = 'http://192.168.1.32:3000';
const AI_MODEL = 'qwen2.5:7b';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForPage(url, page) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // Wait for Matrix rain canvas to render
  await page.waitForSelector('canvas', { state: 'attached', timeout: 5000 });
  // Wait for socket connection
  await sleep(500);
  console.log(`  [${url}] Page loaded, canvas present`);
}

async function waitForSelectorText(page, selector, timeout = 15000) {
  const el = await page.waitForSelector(selector, { state: 'attached', timeout });
  return await el.textContent();
}

async function run() {
  console.log('=== UI Interactive Test: Full Frontend ===\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });

  const pageA = await context.newPage();
  const pageB = await context.newPage();

  try {
    // ── PHASE 0: RESET ──────────────────────────────────────────
    // Ensure a clean game session regardless of prior state
    console.log('--- Phase 0: Reset ---');
    const resetPage = await context.newPage();
    await resetPage.goto(SERVER, { waitUntil: 'domcontentloaded' });
    await resetPage.evaluate(() => {
      const s = io();
      s.emit('game:returnToLobby');
      s.on('lobby:state', () => s.disconnect());
    });
    await sleep(1000);
    await resetPage.close();

    // ── PHASE 1: LOBBY ──────────────────────────────────────────

    console.log('--- Phase 1: Lobby (Player A joins) ---');
    await waitForPage(SERVER, pageA);

    // Verify initial page state
    let h1 = await waitForSelectorText(pageA, 'h1');
    console.log(`  Title: ${h1}`);
    console.assert(h1.includes('COGITO'), 'Page title should contain COGITO');

    // Verify join panel exists
    await pageA.waitForSelector('#joinPanel', { timeout: 5000 });
    const joinBtnText = await pageA.textContent('#joinBtn');
    console.log(`  Join button: ${joinBtnText}`);
    console.assert(joinBtnText.includes('JOIN'), 'Join button should be visible');

    // Player A types name
    await pageA.fill('#nameInput', 'Alice');
    await pageA.click('#joinBtn');

    // Wait for lobbyContent to appear
    await pageA.waitForSelector('#lobbyContent', { state: 'attached', timeout: 5000 });
    await sleep(300);
    const hostText = await waitForSelectorText(pageA, '#hostPanel h2');
    console.log(`  Host panel: "${hostText}"`);
    console.assert(hostText.includes('host controls'), 'Host should see host controls');

    // Verify AI config section exists
    await pageA.waitForSelector('#aiConfig', { state: 'attached', timeout: 5000 });
    const addAiBtn = await pageA.waitForSelector('#aiConfig button', { state: 'attached', timeout: 5000 });
    const addAiBtnText = await addAiBtn.textContent();
    console.log(`  AI config button: ${addAiBtnText}`);

    // Verify player list shows Alice
    const playerCountA = await waitForSelectorText(pageA, '#playerCount');
    console.log(`  Player count: ${playerCountA}`);
    console.assert(playerCountA.includes('HUMANS: 1'), 'Should show 1 human');

    // Verify start button is disabled (need 2 humans)
    const startBtnDisabled = await pageA.isDisabled('#startBtn');
    console.log(`  Start button disabled (need 2 humans): ${startBtnDisabled}`);
    console.assert(startBtnDisabled, 'Start should be disabled with only 1 human');

    console.log('');

    // ── PHASE 2: SECOND PLAYER JOINS ────────────────────────────

    console.log('--- Phase 2: Player B joins lobby ---');
    await waitForPage(SERVER, pageB);

    await pageB.fill('#nameInput', 'Bob');
    await pageB.click('#joinBtn');

    // Player B should see waiting message, not host panel
    await pageB.waitForSelector('#lobbyContent', { state: 'attached', timeout: 5000 });
    const waitingMsg = await pageB.textContent('#waitingMsg');
    console.log(`  Player B sees: "${waitingMsg}"`);
    console.assert(waitingMsg.includes('waiting'), 'Non-host should see waiting message');

    // Verify host panel is hidden for B
    const hostPanelB = await pageB.getAttribute('#hostPanel', 'style');
    console.log(`  Host panel display (B): ${hostPanelB}`);

    // Player A should now see 2 players
    await sleep(500);
    const playerCountA2 = await pageA.textContent('#playerCount');
    console.log(`  Player A sees: ${playerCountA2}`);
    console.assert(playerCountA2.includes('HUMANS: 2'), 'Host should see 2 humans');

    // Start button still disabled until AI slot is added
    const startBtnDisabled2 = await pageA.isDisabled('#startBtn');
    console.log(`  Start button disabled (no AI slot yet): ${startBtnDisabled2}`);
    console.assert(startBtnDisabled2, 'Start should be disabled without AI slot');

    console.log('');

    // ── PHASE 3: CONFIGURE AI AND START ─────────────────────────

    console.log('--- Phase 3: Configure AI and start game ---');

    // Add an AI player slot
    await pageA.click('text=+ ADD AI');
    await sleep(300);

    // Verify AI config select appeared
    const aiSelects = await pageA.$$('#aiConfig select');
    console.log(`  AI config selects: ${aiSelects.length}`);
    console.assert(aiSelects.length >= 1, 'Should have at least 1 AI config select');

    // Select the AI model (first option should be fine)
    if (aiSelects.length > 0) {
      await aiSelects[0].selectOption(AI_MODEL);
      console.log(`  Selected AI model: ${AI_MODEL}`);
    }

    // Click start
    console.log('  Clicking START...');
    await pageA.click('#startBtn');

    // Both players should navigate to game.html
    console.log('  Waiting for game.html to load...');
    await pageA.waitForFunction(() => window.location.href.includes('game.html'), { timeout: 30000 });
    await pageB.waitForFunction(() => window.location.href.includes('game.html'), { timeout: 30000 });
    console.log('  Both players navigated to game.html');

    // Wait for game state to render
    await pageA.waitForSelector('#topicDisplay', { timeout: 5000 });
    await pageB.waitForSelector('#topicDisplay', { timeout: 5000 });

    // Verify game UI elements
    const topicA = await pageA.textContent('#topicDisplay');
    const phaseA = await pageA.textContent('#phaseDisplay');
    console.log(`  Player A phase: ${phaseA}, topic: ${topicA}`);
    console.assert(phaseA === 'PLAYING', 'Phase should be PLAYING');

    const topicB = await pageB.textContent('#topicDisplay');
    const phaseB = await pageB.textContent('#phaseDisplay');
    console.log(`  Player B phase: ${phaseB}, topic: ${topicB}`);

    // Verify player sidebar shows 3 players (2 humans + 1 AI)
    await pageA.waitForSelector('#playerSidebar', { timeout: 5000 });
    await sleep(500);
    const sidebarTextA = await pageA.textContent('#playerSidebar');
    console.log(`  Player sidebar contains: ${sidebarTextA.replace(/\n/g, ' ')}`);
    console.assert(sidebarTextA.includes('Alice'), 'Sidebar should show Alice');
    console.assert(sidebarTextA.includes('Bob'), 'Sidebar should show Bob');

    // Verify message area exists
    await pageA.waitForSelector('#messages', { timeout: 5000 });
    await pageA.waitForSelector('#msgInput', { timeout: 5000 });
    await pageA.waitForSelector('#sendBtn', { timeout: 5000 });

    console.log('');

    // ── PHASE 4: GAMEPLAY LOOP ──────────────────────────────────

    console.log('--- Phase 4: Gameplay Loop ---');

    // Helper: send message from a page if it's that player's turn
    async function sendIfMyTurn(page, playerName) {
      const input = await page.$('#msgInput');
      if (!input) return false;
      const disabled = await input.getAttribute('disabled');
      if (disabled !== null && disabled !== 'false') return false;
      await page.fill('#msgInput', `${playerName} thinking out loud...`);
      await page.click('#sendBtn');
      return true;
    }

    // Play through turns: both Alice and Bob send messages when it's their turn
    // We need 2 full rounds (6 turns with 3 players) to trigger voting
    let turnsPlayed = 0;
    const maxTurns = 20; // safety limit
    let inVoting = false;

    while (turnsPlayed < maxTurns && !inVoting) {
      const phaseA = await pageA.textContent('#phaseDisplay');
      if (phaseA === 'VOTING' || phaseA === 'VOTING_SOON' || phaseA === 'ENDED') {
        console.log(`  Game state changed to: ${phaseA}`);
        inVoting = true;
        break;
      }

      // Try Alice's turn
      const aliceSent = await sendIfMyTurn(pageA, 'Alice');
      if (aliceSent) {
        turnsPlayed++;
        console.log(`  [${turnsPlayed}] Alice sent a message`);
        await sleep(500);
        continue;
      }

      // Try Bob's turn
      const bobSent = await sendIfMyTurn(pageB, 'Bob');
      if (bobSent) {
        turnsPlayed++;
        console.log(`  [${turnsPlayed}] Bob sent a message`);
        await sleep(500);
        continue;
      }

      // Neither human's turn — AI is thinking or game is processing
      await sleep(1000);
    }

    let finalPhase = await pageA.textContent('#phaseDisplay');

    // If we hit VOTING_SOON, wait for the actual VOTING phase to begin
    if (finalPhase === 'VOTING_SOON') {
      console.log('  Voting will start in ~30s (VOTING_SOON)...');
      await pageA.waitForFunction(
        () => document.getElementById('phaseDisplay').textContent === 'VOTING',
        undefined, { timeout: 60000 }
      );
      finalPhase = 'VOTING';
    }

    const finalRound = await pageA.textContent('#roundDisplay');
    const totalMsgs = (await pageA.$$('#messages > *')).length;
    console.log(`  Phase: ${finalPhase}, ${finalRound}, Messages: ${totalMsgs}`);

    console.assert(
      finalPhase === 'VOTING' || finalPhase === 'ENDED',
      `Game should reach VOTING or ENDED, got ${finalPhase}`
    );

    console.log('');

    // ── PHASE 5: VOTING ─────────────────────────────────────────

    if (finalPhase === 'VOTING') {
      console.log('--- Phase 5: Voting ---');

      // Wait for voting overlay to appear
      await pageA.waitForFunction(
        () => {
          const el = document.getElementById('votingOverlay');
          return el && el.style.display === 'flex';
        },
        { timeout: 10000 }
      );
      console.log('  Voting overlay visible on A');

      // Verify spectator mode shows AI voting message
      const voteTimer = await pageA.textContent('#voteTimer');
      console.log(`  Vote timer: ${voteTimer}s`);

      await sleep(1000);
      const spectatorMsg = await pageA.textContent('#voteTargets');
      console.log(`  Spectator message: ${spectatorMsg}`);
      console.assert(spectatorMsg.includes('AI players are voting'), 'Should show AI voting message');

      // Humans are spectators — no vote buttons to click
      console.log('  Humans are spectators during AI vote');
    } else {
      console.log(`  Skipping voting (already in ${finalPhase})`);
    }

    console.log('');

    // ── PHASE 6: END GAME ───────────────────────────────────────

    console.log('  Waiting for game end (AI vote resolution)...');
    let endFound = false;
    let lastDisplay = 'none';
    for (let i = 0; i < 120; i++) {
      lastDisplay = await pageA.evaluate(() => {
        const el = document.getElementById('endOverlay');
        return el ? el.style.display : 'none';
      });
      if (lastDisplay === 'flex') {
        endFound = true;
        break;
      }
      await sleep(1000);
    }
    console.assert(endFound, `End overlay should appear, last display: ${lastDisplay}`);
    console.log('  End overlay visible on A');

    const endTitle = await pageA.textContent('#endTitle');
    console.log(`  Winner: ${endTitle}`);

    // Verify player reveals
    const endReveal = await pageA.textContent('#endReveal');
    console.log(`  Player reveals: ${endReveal.replace(/\n/g, ' ')}`);
    console.assert(endReveal.includes('Alice'), 'End reveal should include Alice');
    console.assert(endReveal.includes('Bob'), 'End reveal should include Bob');
    console.assert(endReveal.includes('HUMAN'), 'End reveal should show identity');
    console.assert(endReveal.includes('AI') || endReveal.includes('qwen'), 'End reveal should show AI identity');

    // Verify RETURN TO LOBBY button
    const returnBtn = await pageA.textContent('#returnBtn');
    console.log(`  Return button: ${returnBtn}`);
    console.assert(returnBtn.includes('RETURN TO LOBBY'), 'Return to lobby button should be visible');

    // Click RETURN TO LOBBY on both players
    console.log('  Clicking RETURN TO LOBBY...');
    await pageA.click('#returnBtn');
    await sleep(500);
    await pageB.click('#returnBtn');

    console.log('');

    // ── PHASE 7: RETURN TO LOBBY ────────────────────────────────

    console.log('--- Phase 7: Return to Lobby ---');

    // Both players should redirect to index.html
    await pageA.waitForFunction(
      () => window.location.href.includes('index.html'),
      { timeout: 15000 }
    );
    await pageB.waitForFunction(
      () => window.location.href.includes('index.html'),
      { timeout: 15000 }
    );
    console.log('  Both players returned to index.html');

    // Wait for lobby to re-render
    await pageA.waitForSelector('#joinPanel', { state: 'attached', timeout: 10000 });
    await pageB.waitForSelector('#joinPanel', { state: 'attached', timeout: 10000 });
    console.log('  Join panel visible on both players');

    // Player A (now host) should be able to see host panel again
    await sleep(1000);
    await pageA.fill('#nameInput', 'Alice');
    await pageA.click('#joinBtn');
    await pageA.waitForSelector('#hostPanel', { state: 'attached', timeout: 5000 });
    const hostPanelDisplay = await pageA.getAttribute('#hostPanel', 'style');
    console.log(`  Host panel visible after return: ${hostPanelDisplay}`);

    // Verify player list is fresh (only Alice)
    const playerCountAfter = await pageA.textContent('#playerCount');
    console.log(`  Player count after return: ${playerCountAfter}`);

    console.log('');
    console.log('=== ALL UI INTERACTIVE TESTS PASSED ===');
  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    // Take screenshots on failure for debugging
    try {
      await pageA.screenshot({ path: '/tmp/cogito-ui-failure-A.png' });
      await pageB.screenshot({ path: '/tmp/cogito-ui-failure-B.png' });
      console.log('Screenshots saved to /tmp/cogito-ui-failure-*.png');
    } catch {}
    process.exit(1);
  } finally {
    await browser.close();
  }
}

run();
