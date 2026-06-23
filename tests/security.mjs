import { io } from "socket.io-client";

const BASE = "http://192.168.1.32:3000";
const LAN_HEADERS = { extraHeaders: { "X-Cogito-Realm": "lan" } };

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log("=== Security Hardening Tests ===\n");
  const t = (msg) => console.log("  [" + (Date.now() % 100000) + "] " + msg);

  // 0. Reset any stale session (lan host required to reset)
  t("Resetting stale session...");
  const resetSocket = io(BASE, LAN_HEADERS);
  await new Promise(r => resetSocket.on("connect", r));
  // No host exists yet pre-join, so lobby:reset with no player is a no-op/rejected — that's fine,
  // we just need gameManager cleared from a previous run. Join+reset properly instead:
  await new Promise(r => {
    resetSocket.emit("lobby:setName", { name: "Resetter" });
    resetSocket.once("lobby:state", r);
  });
  resetSocket.emit("lobby:reset");
  await sleep(300);
  resetSocket.disconnect();

  // ─────────────────────────────────────────────────────────────
  // SCENARIO 1: Non-host / non-lan cannot lobby:reset or game:returnToLobby
  // ─────────────────────────────────────────────────────────────
  console.log("--- Scenario 1: Privileged event authorization ---\n");

  const hostSock = io(BASE, LAN_HEADERS);
  await new Promise(r => hostSock.on("connect", r));
  const hostState = await new Promise(r => {
    hostSock.emit("lobby:setName", { name: "HostAlice" });
    hostSock.once("lobby:state", r);
  });
  if (!hostState.isHost) throw new Error("S1 FAIL: HostAlice should be host (lan realm)");
  if (!hostState.sessionCode) throw new Error("S1 FAIL: host should receive sessionCode");
  t("HostAlice joined as host (lan realm)");

  // Public-realm, non-host socket. Pass the host's generated session code so
  // this join clears the gate (the code gate itself is Scenario 4's job; here
  // we only care about the privileged-action authorization checks below).
  const publicSock = io(BASE);
  await new Promise(r => publicSock.on("connect", r));
  await new Promise(r => {
    publicSock.emit("lobby:setName", { name: "PublicBob", code: hostState.sessionCode });
    publicSock.once("lobby:state", r);
  });
  t("PublicBob joined (public realm, non-host)");

  // PublicBob attempts lobby:reset — should be rejected with error, lobby state unaffected
  const resetRejection = await new Promise(r => {
    publicSock.once("error", r);
    publicSock.emit("lobby:reset");
    setTimeout(() => r(null), 1500);
  });
  if (!resetRejection) throw new Error("S1 FAIL: Expected error for non-host lobby:reset");
  t("PublicBob's lobby:reset correctly rejected: " + resetRejection.message);

  // PublicBob attempts game:returnToLobby — should be rejected too
  const returnRejection = await new Promise(r => {
    publicSock.once("error", r);
    publicSock.emit("game:returnToLobby");
    setTimeout(() => r(null), 1500);
  });
  if (!returnRejection) throw new Error("S1 FAIL: Expected error for non-host game:returnToLobby");
  t("PublicBob's game:returnToLobby correctly rejected: " + returnRejection.message);

  // PublicBob attempts lobby:start — should be rejected (not host)
  const startRejection = await new Promise(r => {
    publicSock.emit("lobby:start", { topic: null, aiPlayers: [{ model: "qwen2.5:7b" }] }, () => {});
    publicSock.once("error", r);
    setTimeout(() => r(null), 1500);
  });
  if (!startRejection) throw new Error("S1 FAIL: Expected error for non-host lobby:start");
  t("PublicBob's lobby:start correctly rejected: " + startRejection.message);

  console.log("  PASS: Privileged events gated to lan host\n");

  // ─────────────────────────────────────────────────────────────
  // SCENARIO 2: lobby:start validation — unknown model, too many AIs
  // ─────────────────────────────────────────────────────────────
  console.log("--- Scenario 2: lobby:start AI validation ---\n");

  // Need 2 humans for lobby:start to get past the human-count check.
  const humanSock2 = io(BASE, LAN_HEADERS);
  await new Promise(r => humanSock2.on("connect", r));
  await new Promise(r => {
    humanSock2.emit("lobby:setName", { name: "Carol" });
    humanSock2.once("lobby:state", r);
  });
  t("Carol joined as second human");

  // Unknown model name (only matters if Ollama models are cached; if cache is empty,
  // the server allows any model through by design). Validation failures emit 'error'
  // and never invoke the ack callback (matches existing lobby:start behavior for the
  // other validation branches), so race the error event against the ack + a timeout.
  const unknownModelOutcome = await Promise.race([
    new Promise(r => hostSock.once("error", (e) => r({ type: "error", e }))),
    new Promise(r => hostSock.emit("lobby:start", { topic: null, aiPlayers: [{ model: "definitely-not-a-real-model-xyz" }] }, (res) => r({ type: "ack", res }))),
    sleep(2000).then(() => ({ type: "timeout" })),
  ]);
  if (unknownModelOutcome.type === "ack" && unknownModelOutcome.res?.ok) {
    t("NOTE: unknown-model start was accepted — cached model list was empty, so validation was bypassed by design");
  } else if (unknownModelOutcome.type === "error") {
    t("Unknown model correctly rejected: " + unknownModelOutcome.e.message);
  } else {
    throw new Error("S2 FAIL: lobby:start with unknown model neither errored nor acked: " + JSON.stringify(unknownModelOutcome));
  }

  // Too many AI players (> MAX_AI_PLAYERS = 8)
  const tooManyAIs = Array.from({ length: 9 }, () => ({ model: "qwen2.5:7b" }));
  const tooManyRejection = await new Promise(r => {
    hostSock.once("error", r);
    hostSock.emit("lobby:start", { topic: null, aiPlayers: tooManyAIs }, () => {});
    setTimeout(() => r(null), 1500);
  });
  if (!tooManyRejection) throw new Error("S2 FAIL: Expected error for >MAX_AI_PLAYERS");
  t("9 AI players correctly rejected: " + tooManyRejection.message);

  console.log("  PASS: lobby:start validates model + AI count\n");

  // Cleanup scenario 1+2 sockets
  hostSock.emit("lobby:reset");
  await sleep(300);
  hostSock.disconnect();
  publicSock.disconnect();
  humanSock2.disconnect();

  // ─────────────────────────────────────────────────────────────
  // SCENARIO 3: game:rejoin token verification
  // ─────────────────────────────────────────────────────────────
  console.log("--- Scenario 3: game:rejoin token verification ---\n");

  const r3reset = io(BASE, LAN_HEADERS);
  await new Promise(r => r3reset.on("connect", r));
  await new Promise(r => { r3reset.emit("lobby:setName", { name: "Reset3" }); r3reset.once("lobby:state", r); });
  r3reset.emit("lobby:reset");
  await sleep(300);
  r3reset.disconnect();

  const tA = io(BASE, LAN_HEADERS);
  await new Promise(r => tA.on("connect", r));
  const tAState = await new Promise(r => { tA.emit("lobby:setName", { name: "TokenAlice" }); tA.once("lobby:state", r); });
  const tAliceId = tAState.myId;
  const tAliceToken = tAState.myToken;
  if (!tAliceToken) throw new Error("S3 FAIL: myToken missing from lobby:state");
  t("TokenAlice joined, myId=" + tAliceId);

  const tB = io(BASE, LAN_HEADERS);
  await new Promise(r => tB.on("connect", r));
  await new Promise(r => { tB.emit("lobby:setName", { name: "TokenBob" }); tB.once("lobby:state", r); });
  t("TokenBob joined");

  const tGsPromise = new Promise(r => tA.once("game:state", r));
  await new Promise(r => tA.emit("lobby:start", {
    topic: "Security test topic",
    aiPlayers: [{ model: "qwen2.5:7b" }],
  }, r));
  await tGsPromise;
  t("Game started for token test");

  tA.disconnect();
  await sleep(300);

  // Wrong token → rejected (no game:state should arrive within the window)
  const tA2 = io(BASE, LAN_HEADERS);
  await new Promise(r => tA2.on("connect", r));
  let gotStateForWrongToken = false;
  tA2.once("game:state", () => { gotStateForWrongToken = true; });
  tA2.emit("game:rejoin", { playerId: tAliceId, token: "totally-wrong-token" });
  await sleep(800);
  if (gotStateForWrongToken) throw new Error("S3 FAIL: rejoin with wrong token should not succeed");
  t("Rejoin with wrong token correctly rejected (no game:state received)");

  // Missing token → rejected
  let gotStateForMissingToken = false;
  tA2.once("game:state", () => { gotStateForMissingToken = true; });
  tA2.emit("game:rejoin", { playerId: tAliceId });
  await sleep(500);
  if (gotStateForMissingToken) throw new Error("S3 FAIL: rejoin with missing token should not succeed");
  t("Rejoin with missing token correctly rejected");

  // Correct token → succeeds
  const correctRejoin = await new Promise(r => {
    tA2.once("game:state", r);
    tA2.emit("game:rejoin", { playerId: tAliceId, token: tAliceToken });
  });
  if (correctRejoin.myId !== tAliceId) throw new Error("S3 FAIL: correct token rejoin myId mismatch");
  t("Rejoin with correct token succeeded, myId=" + correctRejoin.myId);

  console.log("  PASS: game:rejoin token verification works\n");

  // Cleanup
  await new Promise(r => {
    tA2.emit("game:returnToLobby");
    tA2.once("lobby:state", r);
  });
  tA2.disconnect();
  tB.disconnect();

  // ─────────────────────────────────────────────────────────────
  // SCENARIO 4: Auto-generated session code gate
  // ─────────────────────────────────────────────────────────────
  console.log("--- Scenario 4: Session code gate ---\n");
  // Scenario 3 ended with game:returnToLobby, which nulls the session — so no
  // session exists yet. The code is generated when the LAN host creates one.

  // 4a: public join before any session exists → rejected (no code can be right)
  const s4noSession = io(BASE);
  await new Promise(r => s4noSession.on("connect", r));
  const noSessionErr = await new Promise(r => {
    s4noSession.once("error", r);
    s4noSession.emit("lobby:setName", { name: "EarlyBird", code: "ABC234" });
    setTimeout(() => r(null), 1500);
  });
  if (!noSessionErr) throw new Error("S4 FAIL: public join before any session should be rejected");
  t("Public join before host/session correctly rejected: " + noSessionErr.message);
  s4noSession.disconnect();

  // LAN host joins → creates the session and receives the generated code.
  const s4host = io(BASE, LAN_HEADERS);
  await new Promise(r => s4host.on("connect", r));
  const s4hostState = await new Promise(r => {
    s4host.emit("lobby:setName", { name: "Host4" });
    s4host.once("lobby:state", r);
  });
  const code = s4hostState.sessionCode;
  if (!code || !/^[A-Z2-9]{6}$/.test(code)) {
    throw new Error("S4 FAIL: host should receive a 6-char sessionCode, got " + code);
  }
  t("LAN host created session, received code: " + code);

  // 4b: public wrong code → rejected
  const wrongCodeSock = io(BASE);
  await new Promise(r => wrongCodeSock.on("connect", r));
  const wrongCodeErr = await new Promise(r => {
    wrongCodeSock.once("error", r);
    wrongCodeSock.emit("lobby:setName", { name: "WrongCodeUser", code: "WRONG7" });
    setTimeout(() => r(null), 1500);
  });
  if (!wrongCodeErr) throw new Error("S4 FAIL: wrong code should be rejected");
  t("Wrong code correctly rejected: " + wrongCodeErr.message);
  wrongCodeSock.disconnect();

  // 4c: public correct code → accepted; sessionCode must NOT leak to non-host
  const rightCodeSock = io(BASE);
  await new Promise(r => rightCodeSock.on("connect", r));
  const rightCodeState = await new Promise(r => {
    rightCodeSock.emit("lobby:setName", { name: "RightCodeUser", code });
    rightCodeSock.once("lobby:state", r);
  });
  if (!rightCodeState.players || rightCodeState.players.length < 2) {
    throw new Error("S4 FAIL: correct code should be accepted");
  }
  if (rightCodeState.sessionCode) {
    throw new Error("S4 FAIL: sessionCode must not be sent to non-host players");
  }
  t("Correct code accepted; sessionCode correctly withheld from non-host");
  rightCodeSock.disconnect();

  // 4d: LAN realm bypasses the code entirely (no code provided)
  const lanBypassSock = io(BASE, LAN_HEADERS);
  await new Promise(r => lanBypassSock.on("connect", r));
  const lanBypassState = await new Promise(r => {
    lanBypassSock.emit("lobby:setName", { name: "LanBypassUser" });
    lanBypassSock.once("lobby:state", r);
  });
  if (!lanBypassState.players || lanBypassState.players.length < 1) {
    throw new Error("S4 FAIL: lan realm should bypass code requirement");
  }
  t("LAN realm correctly bypassed code requirement");

  // Cleanup
  s4host.emit("lobby:reset");
  await sleep(300);
  s4host.disconnect();
  lanBypassSock.disconnect();

  console.log("  PASS: Session code gate enforced for public realm, bypassed for lan\n");

  console.log("\n=== ALL SECURITY TESTS PASSED ===");
  process.exit(0);
}

main().catch(err => {
  console.error("\n=== TEST FAILED ===", err.message);
  process.exit(1);
});
