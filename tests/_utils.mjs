// Shared test helpers — keep duplication out of individual test files.
import { io } from "socket.io-client";

const BASE = process.env.COGITO_URL || "http://192.168.1.32:3000";

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const waitForState = (socket) => new Promise(r => socket.once("game:state", r));

export async function resetSession() {
  const s = io(BASE, { extraHeaders: { 'X-Cogito-Realm': 'lan' }, rejectUnauthorized: false });
  await new Promise(r => s.on("connect", r));
  await new Promise(r => { s.emit("lobby:setName", { name: "Resetter" }); s.once("lobby:state", r); });
  s.emit("lobby:reset");
  await sleep(300);
  s.disconnect();
}
