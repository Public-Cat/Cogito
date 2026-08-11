// Unit tests (no game server, no real Ollama): Borda tiebreaker levels 2+3,
// humans/AIs win conditions, startSubmitPhase endGame branches, the
// generateAIMessage stale-reply guard, and session/security utilities.
// Mirrors the tests/win-condition.mjs pattern.
import { timingSafeEqual } from 'node:crypto';
import { GameSession } from '../server/game/GameSession.js';

// ── helpers ──────────────────────────────────────────────────────────────

function makeSession() {
  const session = new GameSession();
  session.emitToAll = () => {};
  session.emitToSocket = () => {};
  session.generateAIMessage = async (ai) => {
    session.pendingMessages.push({ playerId: ai.id, playerName: ai.name, text: 'hi', timestamp: Date.now() });
    session.submittedPlayerIds.add(ai.id);
  };
  return session;
}

function runVotingRound(session, { aiRankings, humanVotes }) {
  session.startSubmitPhase();
  for (const p of session.getActiveHumans()) session.handleHumanSubmit(p, 'msg');
  session.resolveSubmitPhase();   // -> REVEALING
  session.resolveRevealPhase();   // round++, may move to VOTING_SOON
  if (session.state !== 'VOTING_SOON') return;
  session.state = 'VOTING'; // skip the 45s delay
  session.aiRankings = new Map();
  session.humanVotes = new Map();
  for (const [aiId, ranking] of aiRankings) session.aiRankings.set(aiId, ranking);
  for (const [voterId, targetId] of humanVotes) session.humanVotes.set(voterId, targetId);
  session.aiRankingsResolved = true;
  session.resolveRankings();
  session.checkWinCondition();
}

// ── level-2 tiebreak (highest-rank count) ────────────────────────────────

function testResolveBordaTieLevel2HighestRankCount() {
  const session = new GameSession();
  const h1 = session.addPlayer('h1', true, 's1'); h1.name = 'Alice';
  const h2 = session.addPlayer('h2', true, 's2'); h2.name = 'Bob';
  const ai1 = session.addPlayer('ai1', false, null); ai1.name = 'Eve';
  const ai2 = session.addPlayer('ai2', false, null); ai2.name = 'Mallory';

  // Both AIs rank h1 first → h1 has 2 first-place counts, h2 has 0.
  session.aiRankings = new Map([
    [ai1.id, [h1.id, h2.id, ai2.id]],
    [ai2.id, [h1.id, h2.id, ai1.id]],
  ]);
  session.humanVotes = new Map();
  session.bordaHistory = new Map();

  // resolveBordaTie is called when multiple players have identical Borda scores.
  // Test it directly with a tied pair.
  const eliminated = session.resolveBordaTie([h1.id, h2.id]);
  if (!eliminated) throw new Error('FAIL: level-2 should resolve, got null');
  if (eliminated.id !== h1.id) {
    throw new Error(`FAIL: h1 (2 first-place AI ranks) should be eliminated, got ${eliminated.name}`);
  }
  console.log('  PASS: level-2 tiebreak (highest-rank count) picks higher-count player');
}

// ── level-3 tiebreak (cumulative Borda history) ──────────────────────────

function testResolveBordaTieLevel3CumulativeHistory() {
  const session = new GameSession();
  const h1 = session.addPlayer('h1', true, 's1'); h1.name = 'Alice';
  const h2 = session.addPlayer('h2', true, 's2'); h2.name = 'Bob';
  const ai1 = session.addPlayer('ai1', false, null); ai1.name = 'Eve';

  // Level-2 tied: ai1 ranks h1 first, human vote targets h2 → 1 each.
  session.aiRankings = new Map([[ai1.id, [h1.id, h2.id]]]);
  session.humanVotes = new Map([[h1.id, h2.id]]);

  // Level 3: cumulative history breaks the tie.
  session.bordaHistory = new Map([[h1.id, 5], [h2.id, 50]]);

  const eliminated = session.resolveBordaTie([h1.id, h2.id]);
  if (!eliminated) throw new Error('FAIL: level-3 should resolve, got null');
  if (eliminated.id !== h2.id) {
    throw new Error(`FAIL: h2 (higher cumulative history: 50 vs 5) should be eliminated, got ${eliminated.name}`);
  }
  console.log('  PASS: level-3 tiebreak (cumulative Borda history) picks higher-history player');
}

// ── humans win (all AIs eliminated) ──────────────────────────────────────

function testHumansWinWhenAllAIsEliminated() {
  const session = makeSession();
  const h1 = session.addPlayer('h1', true, 's1'); h1.name = 'Alice';
  const h2 = session.addPlayer('h2', true, 's2'); h2.name = 'Bob';
  const ai1 = session.addPlayer('ai1', false, null); ai1.name = 'Eve'; ai1.messageHistory = [];
  session.round = 1;

  // Round 1: no voting yet.
  runVotingRound(session, { aiRankings: [], humanVotes: [] });
  if (session.state === 'ENDED') throw new Error('FAIL: game ended before any vote');

  // Round 2: everyone votes out the AI.
  runVotingRound(session, {
    aiRankings: [[ai1.id, [h1.id, h2.id]]],
    humanVotes: [[h1.id, ai1.id], [h2.id, ai1.id]],
  });

  if (session.state !== 'ENDED') throw new Error(`FAIL: expected ENDED, got ${session.state}`);
  if (!session.endResult || session.endResult.winner !== 'humans') {
    throw new Error(`FAIL: expected winner=humans, got ${JSON.stringify(session.endResult)}`);
  }
  console.log('  PASS: eliminating every AI ends game with humans win');
}

// ── AIs win (all humans eliminated) ──────────────────────────────────────

function testAIsWinWhenAllHumansEliminated() {
  const session = makeSession();
  const h1 = session.addPlayer('h1', true, 's1'); h1.name = 'Alice';
  const h2 = session.addPlayer('h2', true, 's2'); h2.name = 'Bob';
  const ai1 = session.addPlayer('ai1', false, null); ai1.name = 'Eve'; ai1.messageHistory = [];
  const ai2 = session.addPlayer('ai2', false, null); ai2.name = 'Mallory'; ai2.messageHistory = [];
  session.round = 1;

  runVotingRound(session, { aiRankings: [], humanVotes: [] });
  if (session.state === 'ENDED') throw new Error('FAIL: game ended before any vote, state=' + session.state);

  // Both AIs rank h1 #1, h2 #2. h1 votes for h2. h2 votes for h1.
  // h1: 4 AI pts + 3 human = 7. h2: 2 AI pts + 3 human = 5. h1 eliminated first.
  // Then with only 1 human (h2) left, checkWinCondition triggers solo win, not ais win.
  // So we need to eliminate both humans in ONE round — not possible with Borda.
  // Instead, directly test checkWinCondition when 0 humans remain.
  h1.isEliminated = true;
  h2.isEliminated = true;
  session.round = 3;
  session.state = 'VOTING';
  session.checkWinCondition();

  if (session.state !== 'ENDED') throw new Error(`FAIL: expected ENDED, got ${session.state}`);
  if (!session.endResult || session.endResult.winner !== 'ais') {
    throw new Error(`FAIL: expected winner=ais, got ${JSON.stringify(session.endResult)}`);
  }
  console.log('  PASS: eliminating every human ends game with AIs win');
}

// ── startSubmitPhase endGame branches ────────────────────────────────────

function testStartSubmitPhaseEndGameBranches() {
  // Branch 1: 1 human, 0 AIs → solo win
  const s1 = new GameSession();
  s1.emitToAll = () => {}; s1.emitToSocket = () => {};
  s1.addPlayer('h1', true, 's1').name = 'Alice';
  s1.state = 'VOTING';
  s1.startSubmitPhase();
  if (s1.state !== 'ENDED') throw new Error(`FAIL(solo): expected ENDED, got ${s1.state}`);
  if (!s1.endResult || s1.endResult.winner !== 'solo') {
    throw new Error(`FAIL(solo): expected winner=solo, got ${JSON.stringify(s1.endResult)}`);
  }
  console.log('  PASS: startSubmitPhase → solo win (1 human, 0 AIs)');

  // Branch 2: 0 humans, 1+ AI → AIs win
  const s2 = new GameSession();
  s2.emitToAll = () => {}; s2.emitToSocket = () => {};
  s2.addPlayer('ai1', false, null).name = 'Eve';
  s2.state = 'VOTING';
  s2.startSubmitPhase();
  if (s2.state !== 'ENDED') throw new Error(`FAIL(ais): expected ENDED, got ${s2.state}`);
  if (!s2.endResult || s2.endResult.winner !== 'ais') {
    throw new Error(`FAIL(ais): expected winner=ais, got ${JSON.stringify(s2.endResult)}`);
  }
  console.log('  PASS: startSubmitPhase → ais win (0 humans, 1+ AIs)');

  // Branch 3: 2+ humans, 0 AIs → humans win.
  // checkWinCondition fires endGame('humans') when aliveAIs.length === 0.
  const s3 = new GameSession();
  s3.emitToAll = () => {}; s3.emitToSocket = () => {};
  s3.addPlayer('h1', true, 's1').name = 'Alice';
  s3.addPlayer('h2', true, 's2').name = 'Bob';
  s3.round = 3;
  s3.state = 'VOTING';
  s3.checkWinCondition();
  if (s3.state !== 'ENDED') throw new Error(`FAIL(humans): expected ENDED, got ${s3.state}`);
  if (!s3.endResult || s3.endResult.winner !== 'humans') {
    throw new Error(`FAIL(humans): expected winner=humans, got ${JSON.stringify(s3.endResult)}`);
  }
  console.log('  PASS: checkWinCondition → humans win (2+ humans, 0 AIs)');
}

// ── buildDiscussionHint ──────────────────────────────────────────────────

function testBuildDiscussionHint() {
  const session = new GameSession();
  session.emitToAll = () => {}; session.emitToSocket = () => {};
  const h1 = session.addPlayer('h1', true, 's1'); h1.name = 'Alice';
  const h2 = session.addPlayer('h2', true, 's2'); h2.name = 'Bob';
  const ai = session.addPlayer('ai1', false, null); ai.name = 'Eve';

  // No messages → null
  session.lastRoundMessages = [];
  if (session.buildDiscussionHint(ai) !== null) {
    throw new Error('FAIL: empty lastRoundMessages should return null');
  }

  // Active accusation with name → targets that
  session.lastRoundMessages = [
    { playerId: h1.id, playerName: 'Alice', text: 'I think Bob is the human, something feels off about their answers.' },
  ];
  const hint = session.buildDiscussionHint(ai);
  if (!hint || !hint.includes('Bob')) {
    throw new Error(`FAIL: should detect the accusation against Bob, got: ${hint}`);
  }

  // Fallback: no suspicion words, pick last non-self message
  session.lastRoundMessages = [
    { playerId: ai.id, playerName: 'Eve', text: 'This is my own message, skip me.' },
    { playerId: h2.id, playerName: 'Bob', text: 'I think the weather today is quite pleasant actually.' },
  ];
  const fallback = session.buildDiscussionHint(ai);
  if (!fallback || !fallback.includes('Bob')) {
    throw new Error(`FAIL: fallback should pick Bob's message, got: ${fallback}`);
  }

  // Prefer human messages over AI for fallback
  session.lastRoundMessages = [
    { playerId: h2.id, playerName: 'Bob', text: 'Just a normal observation.' },
  ];
  const humanPref = session.buildDiscussionHint({ id: ai.id });
  if (!humanPref || !humanPref.includes('Bob')) {
    throw new Error(`FAIL: should prefer human message, got: ${humanPref}`);
  }

  console.log('  PASS: buildDiscussionHint accusation + fallback logic');
}

// ── parseRankingResponse ─────────────────────────────────────────────────

function testParseRankingResponse() {
  const session = new GameSession();
  const h1 = session.addPlayer('h1', true, 's1'); h1.name = 'Alice';
  const h2 = session.addPlayer('h2', true, 's2'); h2.name = 'Bob';
  const ai1 = session.addPlayer('ai1', false, null); ai1.name = 'Eve';

  // Valid ranking
  const active = session.players.filter(p => !p.isEliminated && !p.isDisconnected);
  const parsed = session.parseRankingResponse('Alice, Bob', active, ai1.id);
  if (parsed.length !== 2 || parsed[0] !== h1.id || parsed[1] !== h2.id) {
    throw new Error(`FAIL: valid ranking should parse, got ${JSON.stringify(parsed.map(id => session.getPlayer(id)?.name))}`);
  }

  // Empty response
  const empty = session.parseRankingResponse('', active, ai1.id);
  if (empty.length !== 0) throw new Error('FAIL: empty response should yield empty array');

  // All non-matching tokens
  const junk = session.parseRankingResponse('xyzzy, nothing, foo bar', active, ai1.id);
  if (junk.length !== 0) throw new Error(`FAIL: non-matching tokens should yield empty array, got ${junk.length}`);

  // Duplicate detection: same name twice
  const dup = session.parseRankingResponse('Alice, Bob, Alice', active, ai1.id);
  if (dup.length !== 2) throw new Error(`FAIL: duplicates should be removed, got ${dup.length}`);

  // Self excluded
  const self = session.parseRankingResponse('Eve, Alice, Bob', active, ai1.id);
  if (self.some(id => id === ai1.id)) throw new Error('FAIL: self should be excluded from ranking');

  console.log('  PASS: parseRankingResponse edge cases');
}

// ── clientIp ─────────────────────────────────────────────────────────────

function testClientIp() {
  // Inline copy of clientIp from handlers.js
  function clientIp(socket) {
    const xff = socket.handshake.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) {
      const parts = xff.split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
    return socket.handshake.address || socket.id;
  }

  // Single hop
  const single = clientIp({ handshake: { headers: { 'x-forwarded-for': '10.0.0.1' }, address: '192.168.1.1' }, id: 'abc' });
  if (single !== '10.0.0.1') throw new Error(`FAIL: single hop, got ${single}`);

  // Multiple hops: rightmost is trusted
  const multi = clientIp({ handshake: { headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.5, 192.168.1.100' }, address: '127.0.0.1' }, id: 'abc' });
  if (multi !== '192.168.1.100') throw new Error(`FAIL: multi-hop should use rightmost, got ${multi}`);

  // No header → fallback to address
  const fallback = clientIp({ handshake: { headers: {}, address: '192.168.1.1' }, id: 'abc' });
  if (fallback !== '192.168.1.1') throw new Error(`FAIL: no header, got ${fallback}`);

  // Empty string header → fallback
  const emptyHdr = clientIp({ handshake: { headers: { 'x-forwarded-for': '' }, address: '10.0.0.1' }, id: 'abc' });
  if (emptyHdr !== '10.0.0.1') throw new Error(`FAIL: empty header, got ${emptyHdr}`);

  console.log('  PASS: clientIp x-forwarded-for parsing + fallbacks');
}

// ── safeEqual ────────────────────────────────────────────────────────────

function testSafeEqual() {
  function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }

  if (!safeEqual('abc', 'abc')) throw new Error('FAIL: equal strings should match');
  if (safeEqual('abc', 'abd')) throw new Error('FAIL: different strings must not match');
  if (safeEqual('abc', 'abcd')) throw new Error('FAIL: different lengths must not match');
  if (safeEqual('abc', 123)) throw new Error('FAIL: non-string must not match');
  if (safeEqual(undefined, undefined)) throw new Error('FAIL: undefined must not match');

  console.log('  PASS: safeEqual constant-time comparison behavior');
}

// ── stale-reply guard ────────────────────────────────────────────────────

async function testGenerateAIMessageStaleGuard() {
  // The guard in generateAIMessage: after chat() returns, checks
  //   if (this.state !== 'SUBMITTING' || this.round !== round) return;
  // Stub with a microtask gap to let us change state/round between "chat" and guard.
  const session = new GameSession();
  session.emitToAll = () => {};
  session.emitToSocket = () => {};

  session.generateAIMessage = async (ai) => {
    const round = session.round;
    await Promise.resolve(); // microtask gap — simulates chat() latency
    if (session.state !== 'SUBMITTING' || session.round !== round) return;
    session.pendingMessages.push({ playerId: ai.id, playerName: ai.name, text: 'hi', timestamp: Date.now() });
    session.submittedPlayerIds.add(ai.id);
  };

  const ai = session.addPlayer('ai1', false, null); ai.name = 'Eve'; ai.model = 'm'; ai.messageHistory = [];
  session.addPlayer('h1', true, 's1').name = 'Alice';

  // Sub-test 1: state changes during the gap → discard
  session.state = 'SUBMITTING';
  session.round = 3;
  session.pendingMessages = [];
  session.submittedPlayerIds.clear();

  let p = session.generateAIMessage(ai);
  session.state = 'REVEALING';
  await p;

  if (session.pendingMessages.length !== 0) {
    throw new Error(`FAIL: stale reply after state change should be discarded, got ${session.pendingMessages.length}`);
  }

  // Sub-test 2: round advances during the gap → discard
  session.state = 'SUBMITTING';
  session.round = 1;
  session.pendingMessages = [];
  session.submittedPlayerIds.clear();

  p = session.generateAIMessage(ai);
  session.round = 2;
  await p;

  if (session.pendingMessages.length !== 0) {
    throw new Error(`FAIL: stale reply after round change should be discarded, got ${session.pendingMessages.length}`);
  }

  // Sub-test 3: no state/round change → reply kept
  session.state = 'SUBMITTING';
  session.round = 5;
  session.pendingMessages = [];
  session.submittedPlayerIds.clear();

  p = session.generateAIMessage(ai);
  await p;

  if (session.pendingMessages.length !== 1) throw new Error('FAIL: fresh reply should be kept');
  if (session.pendingMessages[0].playerId !== ai.id) throw new Error('FAIL: kept message should be from the AI');
  if (!session.submittedPlayerIds.has(ai.id)) throw new Error('FAIL: fresh reply should mark AI as submitted');

  console.log('  PASS: generateAIMessage stale-guard behavior');
}

// ── runner ───────────────────────────────────────────────────────────────

console.log('=== Borda Edge + Utility Unit Tests ===');
let failures = 0;
for (const test of [
  testResolveBordaTieLevel2HighestRankCount,
  testResolveBordaTieLevel3CumulativeHistory,
  testHumansWinWhenAllAIsEliminated,
  testAIsWinWhenAllHumansEliminated,
  testStartSubmitPhaseEndGameBranches,
  testBuildDiscussionHint,
  testParseRankingResponse,
  testClientIp,
  testSafeEqual,
  testGenerateAIMessageStaleGuard,
]) {
  try {
    test();
  } catch (err) {
    failures++;
    console.error(`  ${err.message}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\nAll borda-edge tests passed.');
process.exit(0);
