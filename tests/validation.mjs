// Handler input-validation branches (server/socket/handlers.js) that the other
// integration tests never exercise: bad names, joins during a game, full lobby,
// lobby:start config validation, bad messages, votes outside VOTING, no-session.
//
// Requires a running server (COGITO_URL, default http://192.168.1.32:3000) and,
// for the game-in-progress scenario, Ollama reachable — same prerequisites as
// tests/e2e.mjs. Run: node tests/validation.mjs
import { io } from "socket.io-client";
import { resetSession, sleep } from "./_utils.mjs";

const BASE = process.env.COGITO_URL || "http://192.168.1.32:3000";
const LAN_HEADERS = { extraHeaders: { "X-Cogito-Realm": "lan" }, rejectUnauthorized: false };
const AI_MODEL = "qwen2.5:7b";

const sockets = [];
const track = (s) => { sockets.push(s); return s; };
const disconnectAll = () => sockets.forEach(s => { try { s.disconnect(); } catch {} });
const t = (msg) => console.log("  [" + (Date.now() % 100000) + "] " + msg);

async function connect() {
  return track(io(BASE, LAN_HEADERS));
}

async function join(name) {
  const s = await connect();
  const state = await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("join timeout: " + name)), 5000);
    const onState = (st) => { clearTimeout(to); s.off("error", onErr); res(st); };
    const onErr = (e) => { clearTimeout(to); s.off("lobby:state", onState); rej(new Error("join error for " + name + ": " + (e && e.message))); };
    s.once("lobby:state", onState);
    s.once("error", onErr);
    s.emit("lobby:setName", { name });
  });
  return { socket: s, state };
}

// Reset the lobby from the current host's socket. Required between scenarios:
// resetSession() only works on an empty lobby (its Resetter must become host),
// so a scenario that leaves players behind must reset before the next one runs.
async function resetLobby(hostSocket) {
  hostSocket.emit("lobby:reset");
  await sleep(300);
}

// Emit `emit()` on `socket` and require the server to send an `error` whose
// message contains `expected`. Rejects on timeout (no error = bug) or mismatch.
async function expectError(socket, label, expected, emit) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() =>
      reject(new Error(`FAIL: ${label} — expected error containing "${expected}", got none (timeout)`)), 3000);
    socket.once("error", (e) => {
      clearTimeout(to);
      const msg = (e && e.message) || "";
      if (!msg.includes(expected)) {
        reject(new Error(`FAIL: ${label} — expected error containing "${expected}", got "${msg}"`));
      } else {
        t(`${label} -> "${msg}"`);
        resolve(e);
      }
    });
    emit();
  });
}

// Scenario 1: events before any session exists
async function scenarioNoSession() {
  console.log("--- Scenario 1: No active session ---\n");
  const s = await connect();
  await expectError(s, "sendMessage with no session", "No active game session",
    () => s.emit("game:sendMessage", { text: "hi" }));
  await expectError(s, "castVote with no session", "No active game session",
    () => s.emit("game:castVote", { targetId: "whatever" }));
  console.log("  PASS: no-session events rejected\n");
}

// Scenario 2: lobby:setName name validation + existing-player rename
async function scenarioNameValidation() {
  console.log("--- Scenario 2: Name validation + rename ---\n");
  await resetSession();
  const alice = await join("Alice");
  if (!alice.state.isHost) throw new Error("FAIL: Alice should be host");
  const aliceId = alice.state.myId;

  await expectError(alice.socket, "empty name", "Name must be 1-20 characters",
    () => alice.socket.emit("lobby:setName", { name: "" }));
  await expectError(alice.socket, "special chars", "Name must be 1-20 characters",
    () => alice.socket.emit("lobby:setName", { name: "Bob!" }));
  await expectError(alice.socket, "name too long", "Name must be 1-20 characters",
    () => alice.socket.emit("lobby:setName", { name: "A".repeat(21) }));

  // Same socket renames — allowed, broadcast to all lobby players.
  const renamed = new Promise(r => alice.socket.once("lobby:state", r));
  alice.socket.emit("lobby:setName", { name: "AlicePrime" });
  const updated = await renamed;
  const me = updated.players.find(p => p.id === aliceId);
  if (!me || me.name !== "AlicePrime") {
    throw new Error("FAIL: rename not reflected: " + JSON.stringify(updated.players));
  }
  console.log("  PASS: invalid names rejected; rename accepted and broadcast\n");
  await resetLobby(alice.socket);
}

// Scenario 3: brand-new join while a game is in progress
async function scenarioJoinDuringGame() {
  console.log("--- Scenario 3: Join while game in progress ---\n");
  await resetSession();
  const host = await join("HostA");
  const bob = await join("Bob");

  const gsPromise = new Promise(r => host.socket.once("game:state", r));
  const startRes = await new Promise(r =>
    host.socket.emit("lobby:start", { topic: "test topic", aiPlayers: [{ model: AI_MODEL }] }, r));
  if (!startRes || !startRes.ok) throw new Error("FAIL: start should succeed: " + JSON.stringify(startRes));
  await gsPromise; // game is now SUBMITTING

  const intruder = await connect();
  await expectError(intruder, "join during game", "Game is already in progress",
    () => intruder.emit("lobby:setName", { name: "Intruder" }));

  // Must return to lobby before the next scenario's resetSession can run.
  await new Promise(r => { host.socket.emit("game:returnToLobby"); host.socket.once("lobby:state", r); });
  console.log("  PASS: join during game rejected\n");
}

// Scenario 4: lobby:start config validation
async function scenarioStartValidation() {
  console.log("--- Scenario 4: lobby:start validation ---\n");
  await resetSession();
  const host = await join("HostV");
  if (!host.state.isHost) throw new Error("FAIL: HostV should be host");

  await expectError(host.socket, "start with 1 human", "Need at least 2 human players",
    () => host.socket.emit("lobby:start", { topic: "t", aiPlayers: [{ model: AI_MODEL }] }, () => {}));

  await join("BobV");
  await expectError(host.socket, "start with 0 AIs", "Need at least 1 AI player",
    () => host.socket.emit("lobby:start", { topic: "t", aiPlayers: [] }, () => {}));
  await expectError(host.socket, "malformed model", "Each AI player must specify a valid model",
    () => host.socket.emit("lobby:start", { topic: "t", aiPlayers: [{ model: "not a valid model" }] }, () => {}));
  console.log("  PASS: lobby:start validation branches\n");
  await resetLobby(host.socket);
}

// Scenario 5: game:sendMessage + game:castVote validation
async function scenarioMessageAndVoteValidation() {
  console.log("--- Scenario 5: sendMessage + castVote validation ---\n");
  await resetSession();
  const host = await join("MsgA");
  const bob = await join("MsgB");

  // 1 msg/sec per player — sleep between the two bad-text emits from MsgA.
  await expectError(host.socket, "empty message", "Message must be 1-500 characters",
    () => host.socket.emit("game:sendMessage", { text: "" }));
  await sleep(1100);
  await expectError(host.socket, "500+ char message", "Message must be 1-500 characters",
    () => host.socket.emit("game:sendMessage", { text: "x".repeat(501) }));

  // Connected but never joined -> no player record.
  const ghost = await connect();
  await expectError(ghost, "player not found", "Player not found",
    () => ghost.emit("game:sendMessage", { text: "hello" }));

  // Voting outside the VOTING phase (still in lobby).
  await expectError(host.socket, "vote outside VOTING", "Not in voting phase",
    () => host.socket.emit("game:castVote", { targetId: bob.state.myId }));
  console.log("  PASS: sendMessage/castVote validation\n");
  await resetLobby(host.socket);
}

// Scenario 6: lobby at MAX_HUMAN_PLAYERS (12) rejects the 13th
async function scenarioFullLobby() {
  console.log("--- Scenario 6: Lobby full ---\n");
  // lobby:setName is rate-limited to 20/10s per client IP and all sockets here
  // share one bucket; let the window slide before hammering 13 joins.
  await sleep(10000);
  await resetSession();
  const players = [];
  for (let i = 0; i < 12; i++) players.push(await join("P" + i));

  // Fresh socket — the host socket would take the rename path instead.
  const overflow = await connect();
  await expectError(overflow, "13th player", "Lobby is full",
    () => overflow.emit("lobby:setName", { name: "P13" }));
  console.log("  PASS: 13th player rejected (max 12)\n");
  await resetLobby(players[0].socket);
}

async function main() {
  console.log("=== Validation Tests: Handler Input Validation ===\n");
  try {
    await resetSession(); // ensure a clean slate (previous tests may have dirtied state)
    await scenarioNoSession();
    await scenarioNameValidation();
    await scenarioJoinDuringGame();
    await scenarioStartValidation();
    await scenarioMessageAndVoteValidation();
    await scenarioFullLobby();
    console.log("\n=== ALL VALIDATION TESTS PASSED ===");
    disconnectAll();
    process.exit(0);
  } catch (err) {
    console.error("\n=== TEST FAILED ===", err.message);
    disconnectAll();
    process.exit(1);
  }
}

main();
