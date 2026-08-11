// Session-edge integration tests: GameSession rejection branches + lifecycle edges.
// Covers: duplicate submit, castVote outside VOTING, self-vote, vote for eliminated
// target, eliminated player submitting, game:voteProgress events, disconnect during
// VOTING and VOTING_SOON. Requires server + Ollama (qwen2.5:7b) like the other e2e tests.
import { io } from "socket.io-client";
import { resetSession, sleep, waitForState } from "./_utils.mjs";

const BASE = process.env.COGITO_URL || "http://192.168.1.32:3000";
const LAN = { extraHeaders: { 'X-Cogito-Realm': 'lan' }, rejectUnauthorized: false };

const t = (msg) => console.log("  [" + (Date.now() % 100000) + "] " + msg);

function connect() {
  const s = io(BASE, LAN);
  return new Promise(r => s.on("connect", () => r(s)));
}

async function join(s, name) {
  return new Promise(r => { s.emit("lobby:setName", { name }); s.once("lobby:state", r); });
}

/** Call fn() and resolve with the error message if an `error` event arrives, else null. */
function expectError(socket, fn, windowMs = 2500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (done) return; done = true; clearTimeout(to); socket.off("error", onErr); resolve(val); };
    const to = setTimeout(() => finish(null), windowMs);
    const onErr = (e) => finish((e && e.message) || String(e));
    socket.on("error", onErr);
    fn();
  });
}

/** Resolve with the next game:state whose phase matches `phase`. */
function waitForPhase(socket, phase, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { socket.off("game:state", on); reject(new Error("TIMEOUT waiting for phase " + phase)); }, timeoutMs);
    const on = (st) => {
      if (st.phase === phase) { clearTimeout(to); socket.off("game:state", on); resolve(st); }
    };
    socket.on("game:state", on);
  });
}

// Scenario 1: submit/vote rejection branches + voteProgress + disconnect during VOTING.
// 3 humans + 1 AI: round 2 votes out Carol (2 human votes = 4 pts > AI top pick = 2 pts),
// game continues (2 humans + AI alive), so eliminated Carol can try (and fail) to submit.
async function scenarioRejectionAndVoteEdges() {
  console.log("--- Scenario 1: submit/vote rejections, voteProgress, VOTING disconnect ---\n");
  await resetSession();

  const sA = await connect();
  const la = await join(sA, "Alice");
  if (!la.isHost) throw new Error("FAIL: Alice should be host");

  const sB = await connect();
  const lb = await join(sB, "Bob");
  const sC = await connect();
  const lc = await join(sC, "Carol");
  const bobId = lb.myId;
  const carolId = lc.myId;

  const gsP = waitForState(sA);
  await new Promise(r => sA.emit("lobby:start", {
    topic: "Are cats better than dogs?",
    aiPlayers: [{ model: "qwen2.5:7b" }],
  }, r));
  let state = await gsP;
  if (state.phase !== "SUBMITTING") throw new Error("FAIL: expected SUBMITTING, got " + state.phase);
  t("Game started, round " + state.round + ", players=" + state.players.length);

  // Gap 2: duplicate submit while already submitted this round → error.
  t("Duplicate submit test...");
  sA.emit("game:sendMessage", { text: "Alice's first message." });
  await sleep(1200); // game:sendMessage is rate-limited to 1/sec
  const dupErr = await expectError(sA, () => sA.emit("game:sendMessage", { text: "Alice's second message." }));
  if (!dupErr) throw new Error("FAIL: duplicate submit should error");
  t("Duplicate submit rejected: " + dupErr);

  // Gap 3: castVote outside VOTING phase → error.
  t("castVote outside VOTING test...");
  const earlyVoteErr = await expectError(sA, () => sA.emit("game:castVote", { targetId: carolId }));
  if (!earlyVoteErr) throw new Error("FAIL: castVote outside VOTING should error");
  t("castVote outside VOTING rejected: " + earlyVoteErr);

  // Finish round 1: Bob + Carol submit → REVEALING → round 2 SUBMITTING.
  const revealP = waitForState(sA);
  sB.emit("game:sendMessage", { text: "Bob round one." });
  sC.emit("game:sendMessage", { text: "Carol round one." });
  state = await revealP;
  if (state.phase !== "REVEALING") throw new Error("FAIL: expected REVEALING, got " + state.phase);
  t("Round 1 revealed");

  state = await waitForPhase(sA, "SUBMITTING", 20000);
  t("Round 2 SUBMITTING, round=" + state.round);

  // Round 2: all submit → REVEALING → VOTING_SOON → VOTING.
  const reveal2P = waitForState(sA);
  sA.emit("game:sendMessage", { text: "Alice round two." });
  sB.emit("game:sendMessage", { text: "Bob round two." });
  sC.emit("game:sendMessage", { text: "Carol round two." });
  state = await reveal2P;
  if (state.phase !== "REVEALING") throw new Error("FAIL: expected REVEALING round 2");
  t("Round 2 revealed");

  state = await waitForPhase(sA, "VOTING_SOON", 20000);
  t("VOTING_SOON round " + state.round);

  const voteStartP = new Promise(r => sA.once("game:voteStart", r));
  state = await waitForPhase(sA, "VOTING", 70000);
  await voteStartP;
  t("VOTING round " + state.round);

  // Gap 6: collect game:voteProgress events.
  const progressEvents = [];
  const onProgress = (p) => progressEvents.push(p);
  sA.on("game:voteProgress", onProgress);

  // Gap 4: vote for self → error.
  t("Self-vote test...");
  const selfErr = await expectError(sB, () => sB.emit("game:castVote", { targetId: bobId }));
  if (!selfErr) throw new Error("FAIL: self-vote should error");
  t("Self-vote rejected: " + selfErr);

  // Gap 7: Bob (non-host) disconnects during VOTING → game must continue.
  t("Bob disconnecting during VOTING...");
  sB.disconnect();
  await sleep(300);

  // Alice + Carol vote Carol out (2 human votes x 2 pts beats the AI's single top pick).
  const voteResultP = new Promise(r => sA.once("game:voteResult", r));
  sA.emit("game:castVote", { targetId: carolId });
  sC.emit("game:castVote", { targetId: carolId });
  const result = await Promise.race([voteResultP, sleep(90000).then(() => null)]);
  if (!result) throw new Error("FAIL: no game:voteResult within 90s");
  if (!result.eliminated || result.eliminated.name !== "Carol" || !result.eliminated.isHuman) {
    throw new Error("FAIL: expected Carol (human) eliminated, got " + JSON.stringify(result.eliminated));
  }
  t("Carol eliminated (human) despite Bob's disconnect");

  // Gap 6 assertions: voteProgress fired, totalEligible reflects active players
  // (3 after Bob's disconnect), votedCount reached 2+ once both humans voted.
  await sleep(500);
  sA.off("game:voteProgress", onProgress);
  if (progressEvents.length === 0) throw new Error("FAIL: no game:voteProgress events observed");
  if (!progressEvents.some(p => p.totalEligible === 3)) {
    throw new Error("FAIL: expected voteProgress totalEligible=3 after disconnect, got " + JSON.stringify(progressEvents));
  }
  if (Math.max(...progressEvents.map(p => p.votedCount)) < 2) {
    throw new Error("FAIL: voteProgress should reach votedCount>=2, got " + JSON.stringify(progressEvents));
  }
  t("voteProgress OK: " + progressEvents.length + " events, max votedCount=" + Math.max(...progressEvents.map(p => p.votedCount)));

  // voteResult → 3s postVoteTimer; state stays VOTING during that window.
  // Attach the round-3 listener now, then use the window for the eliminated-target vote.
  const round3P = waitForPhase(sA, "SUBMITTING", 15000);

  // Gap 5: vote for the just-eliminated Carol → error.
  t("Vote for eliminated target test...");
  const elimTargetErr = await expectError(sA, () => sA.emit("game:castVote", { targetId: carolId }), 2000);
  if (!elimTargetErr) throw new Error("FAIL: vote for eliminated target should error");
  t("Vote for eliminated target rejected: " + elimTargetErr);

  // Game continues to round 3 (2 humans + 1 AI alive, no win condition).
  state = await round3P;
  t("Round 3 SUBMITTING, round=" + state.round);
  const bobInState = state.players.find(p => p.name === "Bob");
  const carolInState = state.players.find(p => p.name === "Carol");
  if (!bobInState || !bobInState.isDisconnected) throw new Error("FAIL: Bob should be isDisconnected");
  if (!carolInState || !carolInState.isEliminated) throw new Error("FAIL: Carol should be isEliminated");
  t("State reflects Bob disconnected + Carol eliminated");

  // Gap 1: eliminated Carol tries to submit next round → error.
  t("Eliminated player submit test...");
  const elimSubmitErr = await expectError(sC, () => sC.emit("game:sendMessage", { text: "Can I still talk?" }));
  if (!elimSubmitErr) throw new Error("FAIL: eliminated player submit should error");
  t("Eliminated player submit rejected: " + elimSubmitErr);

  // Cleanup.
  await new Promise(r => { sA.emit("game:returnToLobby"); sA.once("lobby:state", r); });
  sA.disconnect();
  sC.disconnect();
  console.log("  PASS: Scenario 1\n");
}

// Scenario 2: disconnect during VOTING_SOON → voting still starts on schedule.
async function scenarioDisconnectDuringVotingSoon() {
  console.log("--- Scenario 2: disconnect during VOTING_SOON ---\n");
  await resetSession();

  const sA = await connect();
  await join(sA, "Alice");
  const sB = await connect();
  await join(sB, "Bob");

  const gsP = waitForState(sA);
  await new Promise(r => sA.emit("lobby:start", {
    topic: "Is cereal a soup?",
    aiPlayers: [{ model: "qwen2.5:7b" }],
  }, r));
  let state = await gsP;
  if (state.phase !== "SUBMITTING") throw new Error("FAIL: expected SUBMITTING");

  // Round 1.
  let revealP = waitForState(sA);
  sA.emit("game:sendMessage", { text: "Alice round one." });
  sB.emit("game:sendMessage", { text: "Bob round one." });
  state = await revealP;
  if (state.phase !== "REVEALING") throw new Error("FAIL: expected REVEALING");
  state = await waitForPhase(sA, "SUBMITTING", 20000);

  // Round 2 → VOTING_SOON.
  revealP = waitForState(sA);
  sA.emit("game:sendMessage", { text: "Alice round two." });
  sB.emit("game:sendMessage", { text: "Bob round two." });
  state = await revealP;
  state = await waitForPhase(sA, "VOTING_SOON", 20000);
  t("VOTING_SOON round " + state.round);

  // Bob disconnects during VOTING_SOON (non-host; host is never reassigned mid-game).
  t("Bob disconnecting during VOTING_SOON...");
  const votingP = waitForPhase(sA, "VOTING", 70000);
  sB.disconnect();
  await sleep(300);

  state = await votingP;
  t("VOTING started despite disconnect, round=" + state.round);
  const bob = state.players.find(p => p.name === "Bob");
  if (!bob || !bob.isDisconnected) throw new Error("FAIL: Bob should be isDisconnected in VOTING");

  // Alice (only active human) votes the AI → resolution + game continues.
  const aiId = state.players.find(p => !p.isHuman).id;
  const voteResultP = new Promise(r => sA.once("game:voteResult", r));
  sA.emit("game:castVote", { targetId: aiId });
  const result = await Promise.race([voteResultP, sleep(90000).then(() => null)]);
  if (!result) throw new Error("FAIL: no game:voteResult after VOTING_SOON disconnect");
  t("voteResult: " + (result.eliminated ? result.eliminated.name + " eliminated" : "no elimination"));

  // Round 3 reached — game kept running (Bob disconnected ≠ eliminated, no win yet).
  state = await waitForPhase(sA, "SUBMITTING", 15000);
  t("Round 3 reached, round=" + state.round);

  await new Promise(r => { sA.emit("game:returnToLobby"); sA.once("lobby:state", r); });
  sA.disconnect();
  console.log("  PASS: Scenario 2\n");
}

async function main() {
  console.log("=== Session Edge Case Tests ===\n");
  await scenarioRejectionAndVoteEdges();
  await scenarioDisconnectDuringVotingSoon();
  console.log("=== ALL SESSION EDGE TESTS PASSED ===");
  process.exit(0);
}

main().catch(err => {
  console.error("\n=== TEST FAILED ===", err.message);
  process.exit(1);
});
