import { io } from "socket.io-client";

const BASE = "http://192.168.1.32:3000";

async function main() {
  console.log("=== E2E Test: Lobby + One Submit/Reveal Cycle ===\n");
  const t = (msg) => console.log("  [" + (Date.now() % 100000) + "] " + msg);

  // 0. Reset any stale session
  t("Resetting stale session...");
  const resetSocket = io(BASE);
  await new Promise(r => resetSocket.on("connect", r));
  resetSocket.emit("lobby:reset");
  await new Promise(r => setTimeout(r, 300));
  resetSocket.disconnect();

  // 1. Player A (host) joins
  t("Player A (host) joining...");
  const socketA = io(BASE);
  await new Promise(r => socketA.on("connect", r));

  const lobbyA = await new Promise(r => {
    socketA.emit("lobby:setName", { name: "Alice" });
    socketA.once("lobby:state", r);
  });
  t("isHost: " + lobbyA.isHost + ", myId: " + lobbyA.myId + ", players: " + lobbyA.players.length);
  if (!lobbyA.isHost) throw new Error("FAIL: Player A should be host");
  if (lobbyA.players.length !== 1) throw new Error("FAIL: Should see 1 player");

  // 2. Player B joins
  t("Player B joining...");
  const socketB = io(BASE);
  await new Promise(r => socketB.on("connect", r));

  const lobbyB = await new Promise(r => {
    socketB.emit("lobby:setName", { name: "Bob" });
    socketB.once("lobby:state", r);
  });
  t("isHost: " + lobbyB.isHost + ", myId: " + lobbyB.myId);
  if (lobbyB.isHost) throw new Error("FAIL: Player B should not be host");

  // Host gets updated lobby state
  const hostUpdate = await new Promise(r => socketA.once("lobby:state", r));
  t("Host sees " + hostUpdate.players.length + " players");
  if (hostUpdate.players.length !== 2) throw new Error("FAIL: Host should see 2 players");

  // 3. Host starts game
  t("Starting game with 1 AI (qwen2.5:7b)...");

  // Set up listeners BEFORE emitting start
  const gsPromiseA = new Promise(r => socketA.once("game:state", r));
  const gsPromiseB = new Promise(r => socketB.once("game:state", r));

  const startResult = await new Promise(r => {
    socketA.emit("lobby:start", {
      topic: "What makes a great leader?",
      aiPlayers: [{ model: "qwen2.5:7b" }],
    }, r);
  });
  t("Start result: " + JSON.stringify(startResult));
  if (!startResult || !startResult.ok) throw new Error("FAIL: Start should succeed");

  const gsA = await gsPromiseA;
  const gsB = await gsPromiseB;
  t("Phase: " + gsA.phase + ", round: " + gsA.round + ", players: " + gsA.players.length +
    " (H:" + gsA.players.filter(p => p.isHuman).length +
    " AI:" + gsA.players.filter(p => !p.isHuman).length + ")");
  if (gsA.phase !== "SUBMITTING") throw new Error("FAIL: Phase should be SUBMITTING, got " + gsA.phase);
  if (gsA.players.length !== 3) throw new Error("FAIL: Should have 3 players (2 humans + 1 AI)");

  // Verify per-player fields in game state
  if (!gsA.submittedBy) throw new Error("FAIL: State should include submittedBy[]");
  if (typeof gsA.activePlayerCount !== "number") throw new Error("FAIL: State should include activePlayerCount");

  // 4. Both humans submit messages simultaneously
  t("Both humans submitting messages...");
  const revealPromise = new Promise(r => socketA.once("game:state", r));

  socketA.emit("game:sendMessage", { text: "A great leader listens more than they speak." });
  socketB.emit("game:sendMessage", { text: "I think empathy is the most important quality." });

  // 5. Wait for REVEALING phase
  const revealState = await revealPromise;
  t("Reveal phase: " + revealState.phase + ", messages: " + revealState.messages.length);
  if (revealState.phase !== "REVEALING") throw new Error("FAIL: Phase should be REVEALING, got " + revealState.phase);

  // Messages should be in the reveal state
  const msgs = revealState.messages;
  if (msgs.length < 2) throw new Error("FAIL: Should have at least 2 messages, got " + msgs.length);

  const aliceMsg = msgs.find(m => m.playerName === "Alice");
  const bobMsg = msgs.find(m => m.playerName === "Bob");
  if (!aliceMsg) throw new Error("FAIL: Alice's message not found");
  if (!bobMsg) throw new Error("FAIL: Bob's message not found");
  t("Alice: \"" + aliceMsg.text.slice(0, 60) + "\"");
  t("Bob: \"" + bobMsg.text.slice(0, 60) + "\"");

  // 6. Cleanup
  t("Returning to lobby...");
  await new Promise(r => {
    socketA.emit("game:returnToLobby");
    socketA.once("lobby:state", r);
  });
  socketA.disconnect();
  socketB.disconnect();

  console.log("\n=== ALL E2E TESTS PASSED ===");
  process.exit(0);
}

main().catch(err => {
  console.error("\n=== TEST FAILED ===", err.message);
  process.exit(1);
});
