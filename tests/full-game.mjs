import { io } from "socket.io-client";

const BASE = "http://192.168.1.32:3000";

function waitForState(socket) {
  return new Promise(r => socket.once("game:state", r));
}

function waitForVoteResult(socket) {
  return new Promise(r => socket.once("game:voteResult", r));
}

function waitForEnded(socket) {
  return new Promise(r => socket.once("game:ended", r));
}

async function main() {
  console.log("=== Full Game Flow Test: Voting + End ===\n");
  const t = (msg) => console.log("  [" + (Date.now() % 100000) + "] " + msg);

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

  // 2. Start game — set up listener BEFORE emitting
  t("Starting game with 1 AI (qwen2.5:7b)...");
  const gsAPromise = waitForState(sA);
  await new Promise(r => sA.emit("lobby:start", {
    topic: "Is pineapple on pizza acceptable?",
    aiPlayers: [{ model: "qwen2.5:7b" }],
  }, r));

  let state = await gsAPromise;
  t("Game started: phase=" + state.phase + ", players=" + state.players.length +
    " (H:" + state.players.filter(p => p.isHuman).length +
    " AI:" + state.players.filter(p => !p.isHuman).length + ")");
  if (state.phase !== "PLAYING") throw new Error("FAIL: Phase should be PLAYING");

  // 3. Play through all turns until voting
  // Use a persistent voteStart flag instead of Promise.race to avoid missing game:state
  let voteStarted = false;
  sA.on("game:voteStart", () => { voteStarted = true; });

  let turnCount = 0;
  const maxTurns = 20;

  while (state.phase === "PLAYING" && turnCount < maxTurns) {
    turnCount++;
    const current = state.players.find(p => p.id === state.currentTurn);
    t("Turn " + turnCount + ": " + current.name + " (human=" + current.isHuman + ", round=" + state.round + ")");

    const statePromise = waitForState(sA);

    if (current.isHuman) {
      const sender = current.id === aliceId ? sA : sB;
      sender.emit("game:sendMessage", {
        text: current.name + "'s thought on pineapple pizza: it's a controversial topic with valid points on both sides.",
      });
    }

    state = await statePromise;

    if (voteStarted) {
      t("Voting phase triggered!");
      break;
    }
  }

  sA.removeListener("game:voteStart");

  if (!state || state.phase !== "VOTING") {
    throw new Error("FAIL: Expected VOTING phase, got " + (state ? state.phase : "null"));
  }

  t("In voting phase at round " + state.round + ", " + state.players.filter(p => !p.isEliminated).length + " active players");

  // 4. Submit votes — both humans vote for the AI player
  const aiPlayer = state.players.find(p => !p.isHuman);
  if (!aiPlayer) throw new Error("FAIL: No AI player found");
  t("AI player: " + aiPlayer.name + " (" + aiPlayer.id + ")");

  const voteResultPromise = waitForVoteResult(sA);

  sA.emit("game:vote", { targetId: aiPlayer.id });
  t("Alice voted for " + aiPlayer.name);
  await new Promise(r => setTimeout(r, 200));

  sB.emit("game:vote", { targetId: aiPlayer.id });
  t("Bob voted for " + aiPlayer.name);

  // 5. Wait for vote result
  const voteResult = await voteResultPromise;
  t("Vote result: AI eliminated=" + (voteResult.aiEliminated ? voteResult.aiEliminated.name : "none") +
    ", Human eliminated=" + (voteResult.humanEliminated ? voteResult.humanEliminated.name : "none"));

  // 6. Wait for game end
  const endData = await waitForEnded(sA);
  t("Game ended! Winner: " + endData.winner);
  endData.players.forEach(p => {
    t("  " + p.name + " — " + (p.isHuman ? "HUMAN" : "AI (" + (p.model || "?") + ")") + (p.isEliminated ? " [ELIMINATED]" : ""));
  });

  if (endData.winner !== "humans") throw new Error("FAIL: Humans should win");

  // Cleanup: wait for server to acknowledge reset before closing
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
