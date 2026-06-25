// tests/join.mjs — Verifies LAN players can join the game through Caddy.
//
// Unlike the other tests (which connect straight to the app on :3000 and fake
// the realm with an X-Cogito-Realm header), this test goes through the real
// Caddy LAN vhost at https://cogito.home.arpa. The realm is stamped by Caddy,
// NOT by the client — so this test deliberately sends no realm header. It
// proves the deployment path that grants host privileges actually works:
//   1. A LAN player joins with NO session code and becomes host.
//   2. A second LAN player joins with NO session code (not host).
//   3. Only the host sees the per-session sessionCode; tokens are per-player.
//
// Requires the stack up: `docker compose up -d` then
// `docker compose -f deploy/local/docker-compose.caddy.yml up -d`, and
// cogito.home.arpa resolving to the host running Caddy.
//
// Override the URL for local pre-DNS checks, e.g.:
//   COGITO_URL=https://cogito.home.arpa node tests/join.mjs   (default)
import { io } from "socket.io-client";

const BASE = process.env.COGITO_URL || "https://cogito.home.arpa";
// Caddy's `tls internal` cert is self-signed — skip TLS verification (test).
const OPTS = { rejectUnauthorized: false };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Open a socket and resolve once it's connected (rejects on connect_error). */
function connect() {
  const socket = io(BASE, OPTS);
  return new Promise((res, rej) => {
    socket.once("connect", () => res(socket));
    socket.once("connect_error", (e) => rej(new Error("connect_error: " + e.message)));
  });
}

/**
 * Emit lobby:setName and resolve with the resulting lobby:state. Rejects if the
 * server emits `error` instead (e.g. "Invalid session code" — which is exactly
 * what a misconfigured proxy would cause for a no-code join).
 * @param {object} socket connected socket.io client
 * @param {string} name player name
 * @param {string} [code] optional session code (omitted for LAN joins)
 */
function join(socket, name, code) {
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("timeout waiting for lobby:state")), 8000);
    const onState = (s) => { cleanup(); res(s); };
    const onErr = (e) => { cleanup(); rej(new Error("server error: " + (e && e.message))); };
    function cleanup() { clearTimeout(to); socket.off("lobby:state", onState); socket.off("error", onErr); }
    socket.once("lobby:state", onState);
    socket.once("error", onErr);
    socket.emit("lobby:setName", code ? { name, code } : { name });
  });
}

async function main() {
  console.log("=== Join Test: LAN players join via Caddy (" + BASE + ") ===\n");
  const t = (m) => console.log("  [" + (Date.now() % 100000) + "] " + m);

  let socketA, socketB, resetSocket;
  try {
    // 0. Reset any stale session. lobby:reset needs a LAN host, so join first.
    t("Resetting stale session...");
    resetSocket = await connect();
    await join(resetSocket, "Resetter");
    resetSocket.emit("lobby:reset");
    await sleep(400);
    resetSocket.disconnect();

    // 1. Player A joins with NO code. LAN realm must bypass the code gate, and
    //    the first LAN human must become host.
    t("Player A joining (no session code)...");
    socketA = await connect();
    const a = await join(socketA, "Alice");
    t("A: isHost=" + a.isHost + " sessionCode=" + a.sessionCode + " players=" + a.players.length);
    if (!a.isHost) throw new Error("FAIL: first LAN player should be host (realm not 'lan'?)");
    if (typeof a.sessionCode !== "string" || a.sessionCode.length !== 6)
      throw new Error("FAIL: host should see a 6-char sessionCode, got " + a.sessionCode);
    if (!a.myId || !a.myToken) throw new Error("FAIL: A should receive myId and myToken");
    if (a.players.length !== 1) throw new Error("FAIL: A should see exactly 1 player");

    // 2. Player B joins with NO code. Succeeds (LAN bypass) but is not host and
    //    must NOT see the host-only sessionCode.
    t("Player B joining (no session code)...");
    socketB = await connect();
    const hostUpdate = new Promise((r) => socketA.once("lobby:state", r));
    const b = await join(socketB, "Bob");
    t("B: isHost=" + b.isHost + " sessionCode=" + b.sessionCode);
    if (b.isHost) throw new Error("FAIL: second player should not be host");
    if (b.sessionCode !== undefined) throw new Error("FAIL: non-host must not receive sessionCode");
    if (!b.myToken) throw new Error("FAIL: B should receive its own myToken");
    if (b.myToken === a.myToken) throw new Error("FAIL: B's token must differ from A's");

    const hu = await hostUpdate;
    t("Host now sees " + hu.players.length + " players");
    if (hu.players.length !== 2) throw new Error("FAIL: host should now see 2 players");

    // 3. Cleanup: host resets the session.
    socketA.emit("lobby:reset");
    await sleep(300);
    socketA.disconnect();
    socketB.disconnect();

    console.log("\n=== JOIN TEST PASSED ===");
    process.exit(0);
  } catch (err) {
    for (const s of [socketA, socketB, resetSocket]) { try { s && s.disconnect(); } catch {} }
    console.error("\n=== JOIN TEST FAILED ===", err.message);
    process.exit(1);
  }
}

main();
