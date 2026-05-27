import { io } from "socket.io-client";

const BASE = "http://192.168.1.32:3000";

async function main() {
  console.log("=== Rejoin Test ===\n");
  const t = (msg) => { console.log("  [" + (Date.now() % 100000) + "] " + msg); };

  // 1. Two players join lobby
  t("Player A joining...");
  const sA = io(BASE);
  await new Promise(r => sA.on("connect", r));
  const la = await new Promise(r => { sA.emit("lobby:setName", { name: "Alice" }); sA.once("lobby:state", r); });
  t("A joined, myId=" + la.myId + ", isHost=" + la.isHost);

  const sB = io(BASE);
  await new Promise(r => sB.on("connect", r));
  const lb = await new Promise(r => { sB.emit("lobby:setName", { name: "Bob" }); sB.once("lobby:state", r); });
  t("B joined, myId=" + lb.myId);

  // 2. Game starts
  const gsPromiseA = new Promise(r => sA.once("game:state", r));
  await new Promise(r => sA.emit("lobby:start", {
    topic: "Test topic?", aiPlayers: [{ model: "qwen2.5:7b" }],
  }, r));
  await gsPromiseA;
  const myId = la.myId;
  t("Game started, myId=" + myId);

  // 3. Simulate page navigation: disconnect and rejoin
  t("Simulating page navigation — disconnecting and rejoining...");
  sA.disconnect();
  await new Promise(r => setTimeout(r, 200));

  const sA2 = io(BASE);
  await new Promise(r => sA2.on("connect", r));
  t("New socket connected, sending game:rejoin...");

  const rejoinState = await new Promise(r => {
    sA2.emit("game:rejoin", { playerId: myId });
    sA2.once("game:state", r);
  });
  t("Rejoin received: phase=" + rejoinState.phase + ", players=" + rejoinState.players.length + ", myId=" + rejoinState.myId);
  if (rejoinState.phase !== "PLAYING") throw new Error("FAIL: Should be PLAYING");
  if (rejoinState.myId !== myId) throw new Error("FAIL: myId mismatch");
  if (rejoinState.players.length !== 3) throw new Error("FAIL: Should have 3 players");

  // 4. Verify can send messages on new socket
  const currentPlayer = rejoinState.players.find(p => p.id === rejoinState.currentTurn);
  t("Current turn: " + currentPlayer.name + " (human: " + currentPlayer.isHuman + ")");

  if (currentPlayer.isHuman && currentPlayer.id === myId) {
    const msgP = new Promise(r => sA2.once("game:newMessage", r));
    sA2.emit("game:sendMessage", { text: "Rejoined and ready!" });
    const m = await msgP;
    t("Message sent after rejoin: [" + m.playerName + "] " + m.text);
  }

  // Cleanup: reset server session, then cleanly close sockets
  sA2.emit("game:returnToLobby");
  await new Promise(r => setTimeout(r, 200));
  sA2.disconnect();
  sB.disconnect();

  console.log("\n=== REJOIN TEST PASSED ===");
}

main().catch(err => {
  console.error("\n=== TEST FAILED ===", err.message);
  process.exit(1);
});
