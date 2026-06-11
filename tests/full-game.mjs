import { io } from "socket.io-client";

const BASE = "http://192.168.1.32:3000";

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log("=== Full Game Flow Test: Voting + End ===\n");
  const t = (msg) => console.log("  [" + (Date.now() % 100000) + "] " + msg);

  // 0. Reset any stale session
  t("Resetting stale session...");
  const resetSocket = io(BASE);
  await new Promise(r => resetSocket.on("connect", r));
  resetSocket.emit("lobby:reset");
  await sleep(500);
  resetSocket.disconnect();

  // 1. Join as 2 humans
  t("Joining Player A (host)...");
  const sA = io(BASE);
  await new Promise(r => sA.on("connect", r));
  const la = await new Promise(r => {
    sA.emit("lobby:setName", { name: "Alice" });
    sA.once("lobby:state", r);
  });
  const aliceId = la.myId;
  t("Alice joined, myId=" + aliceId + ", isHost=" + la.isHost);
  if (!la.isHost) throw new Error("FAIL: Alice should be host");

  t("Joining Player B...");
  const sB = io(BASE);
  await new Promise(r => sB.on("connect", r));
  const lb = await new Promise(r => {
    sB.emit("lobby:setName", { name: "Bob" });
    sB.once("lobby:state", r);
  });
  const bobId = lb.myId;
  t("Bob joined, myId=" + bobId);
  if (lb.isHost) throw new Error("FAIL: Bob should not be host");

  // 2. Start game — set up listener BEFORE emitting
  t("Starting game with 1 AI (qwen2.5:7b)...");
  const gsAPromise = new Promise(r => sA.once("game:state", r));
  await new Promise(r => {
    sA.emit("lobby:start", {
      topic: "Is pineapple on pizza acceptable?",
      aiPlayers: [{ model: "qwen2.5:7b" }],
    }, r);
  });

  let state = await gsAPromise;
  t("Game started: phase=" + state.phase + ", players=" + state.players.length +
    " (H:" + state.players.filter(p => p.isHuman).length +
    " AI:" + state.players.filter(p => !p.isHuman).length + ")");
  if (state.phase !== "SUBMITTING") throw new Error("FAIL: Phase should be SUBMITTING, got " + state.phase);

  // 3. Drive the game through phases until it ends
  let endedData = null;
  let voteCount = 0;
  let totalPhases = 0;

  // Persistent game:ended listener (catches end from any branch)
  sA.on("game:ended", (data) => { endedData = data; });

  function waitForState(socket) {
    return new Promise(r => socket.once("game:state", r));
  }

  const startTime = Date.now();
  const MAX_DURATION_MS = 300000; // 5 min safety

  while (!endedData) {
    if (Date.now() - startTime > MAX_DURATION_MS) {
      throw new Error("TIMEOUT after " + (MAX_DURATION_MS / 1000) + "s");
    }

    totalPhases++;
    if (totalPhases > 50) {
      throw new Error("Too many phase transitions, possible infinite loop");
    }

    if (state.phase === "SUBMITTING") {
      t("SUBMITTING round " + state.round + " — both humans submitting...");

      // Set up listener BEFORE submitting to avoid race
      const nextState = waitForState(sA);
      sA.emit("game:sendMessage", { text: "Alice exploring different angles on this topic." });
      sB.emit("game:sendMessage", { text: "Bob considering the implications of what's been said." });
      state = await nextState;

    } else if (state.phase === "REVEALING") {
      t("REVEALING round " + state.round + " — waiting...");
      state = await waitForState(sA);

    } else if (state.phase === "VOTING_SOON") {
      t("VOTING_SOON — 5s until vote...");
      state = await waitForState(sA);

    } else if (state.phase === "VOTING") {
      voteCount++;
      t("VOTING round " + voteCount + " — waiting for AI votes...");

      // Wait for vote result
      const result = await new Promise(r => sA.once("game:voteResult", r));
      t("Vote result: " + (result.eliminated
        ? result.eliminated.name + " (" + (result.eliminated.isHuman ? "human" : "AI") + ")"
        : "no elimination"));

      // After voteResult: 3s delay → either game:state(SUBMITTING) or game:ended.
      // Race both with a timeout to avoid hanging.
      const next = await Promise.race([
        waitForState(sA).then(s => ({ type: "state", state: s })),
        new Promise(r => sA.once("game:ended", d => ({ type: "ended", data: d }))),
        sleep(25000).then(() => ({ type: "timeout" })),
      ]);

      if (next.type === "state") {
        state = next.state;
      } else if (next.type === "ended") {
        endedData = next.data;
      } else {
        throw new Error("Timeout waiting for post-vote transition");
      }
    } else {
      throw new Error("Unexpected phase: " + state.phase);
    }
  }

  // 4. Verify the end state
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  t("Game ended after " + voteCount + " vote round(s), " + elapsed + "s. Winner: " + endedData.winner);
  endedData.players.forEach(p => {
    t("  " + p.name + " — " + (p.isHuman ? "HUMAN" : "AI (" + (p.model || "?") + ")") +
      (p.isEliminated ? " [ELIMINATED]" : ""));
  });

  if (!endedData.winner) throw new Error("FAIL: Missing winner field");
  if (!["humans", "ais", "solo"].includes(endedData.winner)) {
    throw new Error("FAIL: Invalid winner: " + endedData.winner);
  }
  if (!endedData.players || endedData.players.length < 2) {
    throw new Error("FAIL: Missing or invalid players list");
  }
  if (voteCount < 1) throw new Error("FAIL: Expected at least 1 vote round, got " + voteCount);

  // 5. Cleanup
  t("Returning to lobby...");
  await new Promise(r => {
    sA.emit("game:returnToLobby");
    sA.once("lobby:state", r);
  });
  sA.disconnect();
  sB.disconnect();

  console.log("\n=== FULL GAME TEST PASSED ===");
  process.exit(0);
}

main().catch(err => {
  console.error("\n=== TEST FAILED ===", err.message);
  process.exit(1);
});
