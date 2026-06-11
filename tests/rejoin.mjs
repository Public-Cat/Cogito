import { io } from "socket.io-client";

const BASE = "http://192.168.1.32:3000";

async function main() {
  console.log("=== Rejoin Test: Mid-Game Reconnection ===\n");
  const t = (msg) => console.log("  [" + (Date.now() % 100000) + "] " + msg);

  // 0. Reset any stale session
  t("Resetting stale session...");
  const resetSocket = io(BASE);
  await new Promise(r => resetSocket.on("connect", r));
  resetSocket.emit("lobby:reset");
  await new Promise(r => setTimeout(r, 300));
  resetSocket.disconnect();

  // 1. Two players join lobby
  t("Player A joining...");
  const sA = io(BASE);
  await new Promise(r => sA.on("connect", r));
  const la = await new Promise(r => {
    sA.emit("lobby:setName", { name: "Alice" });
    sA.once("lobby:state", r);
  });
  const aliceId = la.myId;
  t("A joined, myId=" + aliceId + ", isHost=" + la.isHost);
  if (!la.isHost) throw new Error("FAIL: Player A should be host");

  const sB = io(BASE);
  await new Promise(r => sB.on("connect", r));
  const lb = await new Promise(r => {
    sB.emit("lobby:setName", { name: "Bob" });
    sB.once("lobby:state", r);
  });
  t("B joined, myId=" + lb.myId);
  if (lb.isHost) throw new Error("FAIL: Player B should not be host");

  // 2. Game starts
  t("Starting game with 1 AI (qwen2.5:7b)...");
  const gsPromiseA = new Promise(r => sA.once("game:state", r));
  await new Promise(r => {
    sA.emit("lobby:start", {
      topic: "What is the best book you have ever read?",
      aiPlayers: [{ model: "qwen2.5:7b" }],
    }, r);
  });
  const gsA = await gsPromiseA;
  t("Game started, phase=" + gsA.phase + ", players=" + gsA.players.length);
  if (gsA.phase !== "SUBMITTING") throw new Error("FAIL: Phase should be SUBMITTING, got " + gsA.phase);
  if (gsA.players.length !== 3) throw new Error("FAIL: Should have 3 players");

  // 3. Simulate page navigation: disconnect and rejoin
  t("Simulating page navigation — disconnecting and rejoining...");
  sA.disconnect();
  await new Promise(r => setTimeout(r, 300));

  const sA2 = io(BASE);
  await new Promise(r => sA2.on("connect", r));
  t("New socket connected, sending game:rejoin...");

  const rejoinState = await new Promise(r => {
    sA2.emit("game:rejoin", { playerId: aliceId });
    sA2.once("game:state", r);
  });
  t("Rejoin: phase=" + rejoinState.phase + ", players=" + rejoinState.players.length + ", myId=" + rejoinState.myId);
  if (rejoinState.phase !== "SUBMITTING") throw new Error("FAIL: Should be SUBMITTING, got " + rejoinState.phase);
  if (rejoinState.myId !== aliceId) throw new Error("FAIL: myId mismatch — expected " + aliceId + ", got " + rejoinState.myId);
  if (rejoinState.players.length !== 3) throw new Error("FAIL: Should have 3 players, got " + rejoinState.players.length);

  // Verify reconnected player is not marked as disconnected
  const me = rejoinState.players.find(p => p.id === aliceId);
  if (!me) throw new Error("FAIL: Reconnected player not found in player list");
  if (me.isDisconnected) throw new Error("FAIL: Reconnected player should not be isDisconnected");

  // 4. Verify can send messages on new socket (both players submit)
  t("Both humans submitting after rejoin...");
  const revealPromise = new Promise(r => sA2.once("game:state", r));

  sA2.emit("game:sendMessage", { text: "Rejoined and ready to discuss!" });
  sB.emit("game:sendMessage", { text: "Glad you're back, let's keep going." });

  const revealState = await revealPromise;
  t("Reveal phase reached after rejoin: " + revealState.phase);
  if (revealState.phase !== "REVEALING") throw new Error("FAIL: Should reach REVEALING after rejoin, got " + revealState.phase);

  // Verify messages from both players exist
  const msgs = revealState.messages;
  const aliceRejoined = msgs.find(m => m.playerName === "Alice");
  const bobRejoined = msgs.find(m => m.playerName === "Bob");
  if (!aliceRejoined) throw new Error("FAIL: Alice's post-rejoin message not found");
  if (!bobRejoined) throw new Error("FAIL: Bob's message not found");
  t("Alice after rejoin: \"" + aliceRejoined.text.slice(0, 50) + "\"");
  t("Bob: \"" + bobRejoined.text.slice(0, 50) + "\"");

  // 5. Cleanup
  t("Returning to lobby...");
  await new Promise(r => {
    sA2.emit("game:returnToLobby");
    sA2.once("lobby:state", r);
  });
  sA2.disconnect();
  sB.disconnect();

  console.log("\n=== REJOIN TEST PASSED ===");
  process.exit(0);
}

main().catch(err => {
  console.error("\n=== TEST FAILED ===", err.message);
  process.exit(1);
});
