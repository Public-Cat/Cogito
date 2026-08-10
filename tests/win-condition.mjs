// Unit test (no server/Ollama needed): reproduces the last-human-alive stall bug.
import { GameSession } from '../server/game/GameSession.js';

function makeSession() {
  const session = new GameSession();
  session.emitToAll = () => {};
  session.emitToSocket = () => {};
  // Skip real Ollama calls for message generation; just mark the AI as submitted.
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
  session.startVoting();
  for (const [aiId, ranking] of aiRankings) session.aiRankings.set(aiId, ranking);
  for (const [voterId, targetId] of humanVotes) session.humanVotes.set(voterId, targetId);
  session.aiRankingsResolved = true;
  session.tryResolveRankings();
  session.checkWinCondition(); // normally fired 3s later by postVoteTimer
}

function test1v1StandoffProducesNoElimination() {
  // When all tiebreakers are exhausted (symmetric 1v1 standoff: each side votes
  // the other every round, scores and history stay identical), no one is eliminated.
  const session = makeSession();
  const h1 = session.addPlayer('h1', true, 's1'); h1.name = 'Bob';
  const ai1 = session.addPlayer('ai1', false, null); ai1.name = 'Eve'; ai1.messageHistory = [];
  session.round = 5;

  runVotingRound(session, {
    aiRankings: [[ai1.id, [h1.id]]],
    humanVotes: [[h1.id, ai1.id]],
  });

  if (h1.isEliminated || ai1.isEliminated) {
    throw new Error(`FAIL: perfect tie should produce no elimination (h1.isEliminated=${h1.isEliminated}, ai1.isEliminated=${ai1.isEliminated})`);
  }
  // checkWinCondition() correctly ends the game via sole-survivor rule (1 human still
  // alive after the tied round), so session.state may be ENDED — that's expected.
  console.log('  PASS: symmetric 1v1 standoff produces no elimination');
}

function testSoloWinTriggersInstantlyEvenWithAIsAlive() {
  // RULES.md: "vote out other humans to become the sole survivor" is a win
  // path distinct from "vote out every AI for a Humans Win" — becoming the
  // last human standing must end the game immediately, even with AIs alive.
  const session = makeSession();
  const h1 = session.addPlayer('h1', true, 's1'); h1.name = 'Alice';
  const h2 = session.addPlayer('h2', true, 's2'); h2.name = 'Bob';
  const ai1 = session.addPlayer('ai1', false, null); ai1.name = 'Eve'; ai1.messageHistory = [];
  const ai2 = session.addPlayer('ai2', false, null); ai2.name = 'Mallory'; ai2.messageHistory = [];

  runVotingRound(session, { aiRankings: [], humanVotes: [] }); // round 1: no voting yet
  if (session.state === 'ENDED') throw new Error('FAIL: game ended before any vote');

  // Round 2: vote out Alice, leaving 1 human (Bob) + 2 AIs still alive.
  runVotingRound(session, {
    aiRankings: [[ai1.id, [h1.id, h2.id]], [ai2.id, [h1.id, h2.id]]],
    humanVotes: [[h2.id, h1.id]],
  });

  if (!h1.isEliminated) throw new Error('FAIL: expected Alice to be eliminated in round 2');
  if (session.state !== 'ENDED') {
    throw new Error(`FAIL: expected instant solo win once Bob became the sole survivor, got state=${session.state}`);
  }
  const result = session.determineWinner();
  if (result.type !== 'solo' || result.player.id !== h2.id) {
    throw new Error(`FAIL: expected solo win for Bob, got ${JSON.stringify(result)}`);
  }
  console.log('  PASS: sole survivor wins instantly with AIs still alive');
}

function testDisconnectedHumanDoesNotTriggerSoloWin() {
  // A human who disconnects (transient, supported rejoin path) but is NOT
  // eliminated must NOT trigger a solo win. Previously checkWinCondition() and
  // determineWinner() excluded isDisconnected from aliveHumans, so a refresh
  // during the 3s postVoteTimer window spuriously ended the game.
  const session = makeSession();
  const h1 = session.addPlayer('h1', true, 's1'); h1.name = 'Alice';
  const h2 = session.addPlayer('h2', true, 's2'); h2.name = 'Bob';
  const ai1 = session.addPlayer('ai1', false, null); ai1.name = 'Eve'; ai1.messageHistory = [];

  // h2 disconnects (browser refresh) — NOT eliminated
  h2.isDisconnected = true;

  // With the fix, both Alice (connected) and Bob (disconnected) count as alive.
  // No win condition should fire — the game should continue.
  session.round = 3;
  session.state = 'VOTING'; // simulate state just before checkWinCondition is called
  session.checkWinCondition();

  if (session.state === 'ENDED') {
    throw new Error('FAIL: disconnected-not-eliminated human spuriously triggered solo win');
  }
  console.log('  PASS: disconnected-not-eliminated human does not trigger solo win');
}

function testSoleNonEliminatedHumanWinsEvenIfDisconnected() {
  // The sole surviving human wins even if they happen to be disconnected at the
  // moment checkWinCondition fires — being disconnected is transient, not a
  // disqualification from the solo win.
  const session = makeSession();
  const h1 = session.addPlayer('h1', true, 's1'); h1.name = 'Alice';
  const h2 = session.addPlayer('h2', true, 's2'); h2.name = 'Bob';
  const ai1 = session.addPlayer('ai1', false, null); ai1.name = 'Eve'; ai1.messageHistory = [];

  // Eliminate h1 (voted out)
  h1.isEliminated = true;
  // h2 is the sole non-eliminated human but happens to be disconnected right now
  h2.isDisconnected = true;

  session.round = 3;
  session.state = 'VOTING';
  session.checkWinCondition();

  if (session.state !== 'ENDED') {
    throw new Error(`FAIL: expected solo win for disconnected-but-alive Bob, got state=${session.state}`);
  }
  if (!session.endResult || session.endResult.winner !== 'solo' || session.endResult.winnerPlayerId !== h2.id) {
    throw new Error(`FAIL: expected solo win for Bob, got endResult=${JSON.stringify(session.endResult)}`);
  }
  console.log('  PASS: sole non-eliminated human wins even while temporarily disconnected');
}

function testPartialAIParsingDoesNotLetHumanVotesDominate() {
  // Bug: when LLM output only yields 1 name (partial parse, ranking.length=1),
  // the n===1 branch fires, giving AI's top pick just 1 pt. Meanwhile
  // humanVotePoints = N-2 = 3, so 2 human votes (6 pts) beat 3 AI top-picks
  // (3 pts) and the wrong player is eliminated.
  const session = makeSession();
  const h1 = session.addPlayer('h1', true, 's1'); h1.name = 'Alice';
  const h2 = session.addPlayer('h2', true, 's2'); h2.name = 'Bob';
  const ai1 = session.addPlayer('ai1', false, null); ai1.name = 'Eve'; ai1.messageHistory = [];
  const ai2 = session.addPlayer('ai2', false, null); ai2.name = 'Mallory'; ai2.messageHistory = [];
  const ai3 = session.addPlayer('ai3', false, null); ai3.name = 'Zara'; ai3.messageHistory = [];

  session.round = 1; // resolveRevealPhase increments to 2, triggering voting

  runVotingRound(session, {
    aiRankings: [
      [ai1.id, [h1.id]], // partial parse: only top pick listed (n=1)
      [ai2.id, [h1.id]],
      [ai3.id, [h1.id]],
    ],
    humanVotes: [
      [h1.id, ai1.id],
      [h2.id, ai1.id],
    ],
  });

  if (!h1.isEliminated) {
    throw new Error(
      `FAIL: 3 AI top-picks for h1 should outweigh 2 human votes for ai1 ` +
      `(h1.isEliminated=${h1.isEliminated}, ai1.isEliminated=${ai1.isEliminated})`
    );
  }
  console.log('  PASS: 3 concentrated AI top-picks beat 2 human votes even with partial rankings');
}

function testSecondaryAIVotesAccumulateCorrectly() {
  // Secondary Borda positions are intentional: if 2 AIs also suspect ai1 (rank
  // it second) and 2 humans vote for ai1, that combined signal should outweigh
  // 3 AIs having h1 as their top pick. N=5: top-pick worth 3 pts, second 2 pts.
  // h1 total = 3×3 = 9; ai1 total = 2 secondary (2+2) + 2 human (3+3) = 10.
  const session = makeSession();
  const h1 = session.addPlayer('h1', true, 's1'); h1.name = 'Alice';
  const h2 = session.addPlayer('h2', true, 's2'); h2.name = 'Bob';
  const ai1 = session.addPlayer('ai1', false, null); ai1.name = 'Eve'; ai1.messageHistory = [];
  const ai2 = session.addPlayer('ai2', false, null); ai2.name = 'Mallory'; ai2.messageHistory = [];
  const ai3 = session.addPlayer('ai3', false, null); ai3.name = 'Zara'; ai3.messageHistory = [];

  session.round = 1;

  runVotingRound(session, {
    aiRankings: [
      [ai1.id, [h1.id, h2.id, ai2.id, ai3.id]],         // h1 #1
      [ai2.id, [h1.id, ai1.id, h2.id, ai3.id]],          // h1 #1, ai1 #2
      [ai3.id, [h1.id, ai1.id, h2.id, ai2.id]],          // h1 #1, ai1 #2
    ],
    humanVotes: [
      [h1.id, ai1.id],
      [h2.id, ai1.id],
    ],
  });

  // ai1 should be eliminated: 10 pts (4 secondary AI + 6 human) > h1's 9 pts (3 primary AI picks)
  if (!ai1.isEliminated) {
    throw new Error(
      `FAIL: ai1 (10 pts) should beat h1 (9 pts) when secondary AI + human votes accumulate ` +
      `(h1.isEliminated=${h1.isEliminated}, ai1.isEliminated=${ai1.isEliminated})`
    );
  }
  console.log('  PASS: secondary AI Borda votes correctly accumulate with human votes');
}

console.log('=== Win Condition Tests ===');
let failures = 0;
for (const test of [
  test1v1StandoffProducesNoElimination,
  testSoloWinTriggersInstantlyEvenWithAIsAlive,
  testDisconnectedHumanDoesNotTriggerSoloWin,
  testSoleNonEliminatedHumanWinsEvenIfDisconnected,
  testPartialAIParsingDoesNotLetHumanVotesDominate,
  testSecondaryAIVotesAccumulateCorrectly,
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
console.log('\nAll win-condition tests passed.');
process.exit(0);
