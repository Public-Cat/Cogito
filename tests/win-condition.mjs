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

function test1v1StandoffResolves() {
  const session = makeSession();
  const h1 = session.addPlayer('h1', true, 's1'); h1.name = 'Bob';
  const ai1 = session.addPlayer('ai1', false, null); ai1.name = 'Eve'; ai1.messageHistory = [];
  session.round = 5; // already past round 2, so every round votes

  // Each side targets the other every round — the natural, expected play —
  // which previously tied forever (first-place counts AND cumulative history
  // stay symmetric round after round) and the game never ended.
  const MAX_ROUNDS = 10;
  let rounds = 0;
  while (session.state !== 'ENDED' && rounds < MAX_ROUNDS) {
    runVotingRound(session, {
      aiRankings: [[ai1.id, [h1.id]]],
      humanVotes: [[h1.id, ai1.id]],
    });
    rounds++;
  }

  if (session.state !== 'ENDED') {
    throw new Error(`FAIL: 1-human-vs-1-AI standoff never resolved after ${MAX_ROUNDS} rounds (still ${session.state})`);
  }
  if (!h1.isEliminated && !ai1.isEliminated) {
    throw new Error('FAIL: game ended without eliminating either standoff player');
  }
  console.log(`  PASS: standoff resolved after ${rounds} round(s), state=ENDED`);
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

console.log('=== Win Condition Tests ===');
let failures = 0;
for (const test of [test1v1StandoffResolves, testSoloWinTriggersInstantlyEvenWithAIsAlive]) {
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
