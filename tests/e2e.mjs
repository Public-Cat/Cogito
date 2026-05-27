import { io } from "socket.io-client";

const BASE = "http://192.168.1.32:3000";

async function main() {
  console.log("=== E2E Test: Full game flow ===\n");

  const t = (msg) => { console.log("  [" + (Date.now() % 100000) + "] " + msg); };

  // 1. Player A (host) joins
  t("Player A (host) joining...");
  const socketA = io(BASE);
  await new Promise(r => socketA.on("connect", r));
  t("Socket A connected: " + socketA.id);

  const lobbyA = await new Promise(r => {
    socketA.emit("lobby:setName", { name: "Alice" });
    socketA.once("lobby:state", r);
  });
  t("isHost: " + lobbyA.isHost + ", models: " + lobbyA.models.length + ", myId: " + lobbyA.myId);
  if (!lobbyA.isHost) throw new Error("FAIL: Player A should be host");

  // 2. Player B joins
  t("Player B joining...");
  const socketB = io(BASE);
  await new Promise(r => socketB.on("connect", r));
  t("Socket B connected: " + socketB.id);

  const lobbyB = await new Promise(r => {
    socketB.emit("lobby:setName", { name: "Bob" });
    socketB.once("lobby:state", r);
  });
  t("isHost: " + lobbyB.isHost + ", myId: " + lobbyB.myId);
  if (lobbyB.isHost) throw new Error("FAIL: Player B should not be host");

  const hostUpdate = await new Promise(r => socketA.once("lobby:state", r));
  t("Host sees " + hostUpdate.players.length + " players");
  if (hostUpdate.players.length !== 2) throw new Error("FAIL: Host should see 2 players");

  // 3. Host starts game
  t("Starting game with 1 AI (qwen2.5:7b)...");
  const gameStatePromiseA = new Promise(r => socketA.once("game:state", r));
  const gameStatePromiseB = new Promise(r => socketB.once("game:state", r));

  const startResult = await new Promise(r => {
    socketA.emit("lobby:start", {
      topic: "What makes a great leader?",
      aiPlayers: [{ model: "qwen2.5:7b" }],
    }, r);
  });
  t("Start result: " + JSON.stringify(startResult));
  if (!startResult || !startResult.ok) throw new Error("FAIL: Start should succeed");

  const gsA = await gameStatePromiseA;
  const gsB = await gameStatePromiseB;
  t("Phase: " + gsA.phase + ", players: " + gsA.players.length +
    " (H:" + gsA.players.filter(p => p.isHuman).length +
    " AI:" + gsA.players.filter(p => !p.isHuman).length +
    "), myId: " + gsA.myId);
  if (gsA.phase !== "PLAYING") throw new Error("FAIL: Phase should be PLAYING");

  // 4. Handle first turn — send message if it's a human's turn
  const currentPlayer = gsA.players.find(p => p.id === gsA.currentTurn);
  t("First turn: " + currentPlayer.name + " (human: " + currentPlayer.isHuman + ")");

  const msgPromise = new Promise(r => socketA.once("game:newMessage", r));

  if (currentPlayer.isHuman) {
    const sender = gsA.myId === currentPlayer.id ? socketA : socketB;
    t(currentPlayer.name + "'s turn — sending message...");
    sender.emit("game:sendMessage", { text: "A great leader listens more than they speak." });
  }

  // 5. Wait for message
  const msg = await msgPromise;
  t("Message from [" + msg.playerName + "]: " + msg.text.slice(0, 80));
  if (!msg.playerName || !msg.text) throw new Error("FAIL: Message invalid");

  // 6. Verify turn advances
  const advancePromise = new Promise(r => socketA.once("game:state", r));
  const state2 = await advancePromise;
  const nextPlayer = state2.players.find(p => p.id === state2.currentTurn);
  t("Turn advanced to " + (nextPlayer ? nextPlayer.name : "?") + " (round " + state2.round + ")");

  // Cleanup: reset server session for next test
  socketA.emit("game:returnToLobby");
  await new Promise(r => setTimeout(r, 100));
  socketA.disconnect();
  socketB.disconnect();

  console.log("\n=== ALL E2E TESTS PASSED ===");
  process.exit(0);
}

main().catch(err => {
  console.error("\n=== TEST FAILED ===", err.message);
  process.exit(1);
});
