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

  t("Joining Player B...");
  const sB = io(BASE);
  await new Promise(r => sB.on("connect", r));
  const lb = await new Promise(r => {
    sB.emit("lobby:setName", { name: "Bob" });
    sB.once("lobby:state", r);
  });
  const bobId = lb.myId;
  t("Bob joined, myId=" + bobId + ", isHost=" + lb.isHost);
  if (lb.isHost) throw new Error("FAIL: Bob should not be host");

  // 2. Start game
  t("Starting game with 1 AI (qwen2.5:7b)...");
  const gsAPromise = new Promise(r => sA.once("game:state", r));
  const gsBPromise = new Promise(r => sB.once("game:state", r));
  sA.emit("lobby:start", {
    topic: "Is pineapple on pizza acceptable?",
    aiPlayers: [{ model: "qwen2.5:7b" }],
  });

  let state = await Promise.race([
    gsAPromise,
    sleep(60000).then(() => { throw new Error("Timeout game:state"); }),
  ]);
  await gsBPromise.catch(() => {});

  t("Game started: phase=" + state.phase + ", players=" + state.players.length +
    " (H:" + state.players.filter(p => p.isHuman).length +
    " AI:" + state.players.filter(p => !p.isHuman).length + ")");
  if (state.phase !== "PLAYING") throw new Error("FAIL: Phase should be PLAYING");

  // 3. Set up persistent listeners
  let pendingEndData = null;
  sA.on("game:ended", (data) => { pendingEndData = data; });

  // We drive the game via game:state changes.
  // To avoid races, we chain: set up listener → take action → await listener.
  // For AI turns, we simply wait for the next game:state (the AI auto-advances).

  let voteCount = 0;

  while (!pendingEndData) {
    // Determine what to do based on current state
    const current = state.players.find(p => p.id === state.currentTurn);

    if (state.phase === "PLAYING" && current && current.isHuman) {
      t("Turn: " + current.name + " (human, round " + state.round + ")");
      // Set up listener for the state change our message will trigger
      const nextState = new Promise(r => sA.once("game:state", r));
      const sender = current.id === aliceId ? sA : sB;
      sender.emit("game:sendMessage", {
        text: current.name + "'s thought: discussing the topic casually.",
      });
      state = await nextState;
      continue;
    }

    // For AI turns, VOTING_SOON, VOTING, or after-vote transitions:
    // Just wait for the next game:state
    const nextState = new Promise(r => sA.once("game:state", r));

    if (state.phase === "VOTING") {
      // Wait for vote result
      const vrPromise = new Promise(r => sA.once("game:voteResult", r));
      const result = await vrPromise;
      voteCount++;
      t("Vote round " + voteCount + ": eliminated=" + (result.eliminated
        ? result.eliminated.name + " (" + (result.eliminated.isHuman ? "human" : "AI") + ")"
        : "none"));
      // After vote result, game transitions (3s delay + checkWinCondition).
      // It may emit game:state (PLAYING) or game:ended (game over).
      // Race both to avoid hanging.
      const afterVote = await Promise.race([
        nextState.then(s => ({ type: "state", state: s })),
        sleep(15000).then(() => ({ type: "timeout" })),
      ]);
      if (afterVote.type === "state") {
        state = afterVote.state;
      }
      continue;
    }

    if (state.phase === "VOTING_SOON") {
      state = await nextState;
      continue;
    }

    // PLAYING + AI turn (or PLAYING + no current found)
    // AI will auto-advance; wait for the state change
    if (current) {
      t("Waiting for " + current.name + " (AI, round " + state.round + ")...");
    }
    state = await nextState;
  }

  t("Game ended after " + voteCount + " vote round(s)! Winner: " + pendingEndData.winner);
  pendingEndData.players.forEach(p => {
    t("  " + p.name + " — " + (p.isHuman ? "HUMAN" : "AI (" + (p.model || "?") + ")") +
      (p.isEliminated ? " [ELIMINATED]" : ""));
  });

  // Cleanup
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
