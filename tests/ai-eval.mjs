// Model-comparison harness: scripts a human accusation, measures AI dynamism + rule-following.
import { io } from "socket.io-client";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";

const BASE = process.env.EVAL_BASE || "http://192.168.1.32:3000";
const MODELS = (process.env.MODELS || "qwen2.5:7b,mistral,mistral-nemo,llama3.1:8b,gemma3")
  .split(",").map(s => s.trim()).filter(Boolean);
const AI_COUNT = parseInt(process.env.AI_COUNT || "3", 10);
const OUT_DIR = process.env.OUT_DIR || "./tmp";
const TOPIC = process.env.TOPIC || "Is pineapple on pizza acceptable?";
const SERVER_LOG = process.env.SERVER_LOG || null; // optional path to server stdout log
const OLLAMA_URL = process.env.OLLAMA_URL || "http://192.168.1.30:11434";
const MAX_VOTE_ROUNDS = parseInt(process.env.MAX_VOTE_ROUNDS || "2", 10);
const MODEL_WALL_MS = parseInt(process.env.MODEL_WALL_MS || "180000", 10);
const LABEL = process.env.LABEL || "run"; // e.g. "baseline" / "improved"

const SUSPICION = ["human", "suspicious", "suspect", "pretend", "impostor", "imposter",
  "agree", "defend", "sus", "bot", "robot", "accus", "vote", "fake", "lying", "lie"];
const SIDE_TAKING = ["i agree", "agreed", "you're right", "youre right", "no way", "disagree",
  "i don't buy", "i dont buy", "exactly", "good point", "i think you're", "nah", "for sure",
  "i'm with", "im with", "back off", "leave", "reaching"];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toISOString().replace(/[:.]/g, "-");
const sanitize = (s) => s.replace(/[^a-zA-Z0-9._-]/g, "_");
const words = (t) => t.trim().split(/\s+/).filter(Boolean).length;
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const stddev = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map(x => (x - m) ** 2)));
};

// Warm a model into memory so cold-load latency never pollutes the timed game.
async function warmup(model) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 150000);
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "say ok" }], stream: false, keep_alive: "10m" }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    await res.json();
    return res.ok;
  } catch (e) {
    console.log(`  warmup(${model}) failed: ${e.message}`);
    return false;
  }
}

async function connectNamed(name) {
  const s = io(BASE, { forceNew: true });
  await new Promise(r => s.on("connect", r));
  const ls = await new Promise(r => { s.emit("lobby:setName", { name }); s.once("lobby:state", r); });
  return { socket: s, id: ls.myId, name, isHost: ls.isHost };
}

function logSnapshot() {
  if (!SERVER_LOG || !existsSync(SERVER_LOG)) return 0;
  return readFileSync(SERVER_LOG, "utf8").length;
}
function logSince(offset) {
  if (!SERVER_LOG || !existsSync(SERVER_LOG)) return null;
  return readFileSync(SERVER_LOG, "utf8").slice(offset);
}

// Build the accusation script for a given round, target, and the two human names.
function accuserLine(round, target) {
  if (round === 0) return `not wasting time, ${target} reads way too clean. i think ${target} is the human. calling it now.`;
  return `still on ${target} for me. too polished to be one of us. anyone else seeing it?`;
}
function otherHumanLine(round, target, accuser) {
  if (round === 0) return `eh i'll watch a bit before calling anyone. ${target} seems chill to me honestly.`;
  return `idk ${accuser}, you're kinda reaching on ${target}. what actually tipped you off?`;
}

async function runGameForModel(model) {
  const result = {
    model, ok: false, error: null, topic: TOPIC,
    roster: [], events: [], messages: [], eliminations: [], winner: null,
    revealDelays: [], droppedRounds: 0, firstAccusationRound: 0,
    rankParsedOk: 0, rankCouldNotParse: 0,
  };

  // Warm the model so the game's first round isn't cold-load-bound
  console.log(`  warming ${model}...`);
  const warmStart = Date.now();
  await warmup(model);
  console.log(`  warm in ${((Date.now() - warmStart) / 1000).toFixed(1)}s`);

  // Reset stale session
  const rs = io(BASE, { forceNew: true });
  await new Promise(r => rs.on("connect", r));
  rs.emit("lobby:reset");
  await sleep(400);
  rs.disconnect();

  const alice = await connectNamed("Alice");
  if (!alice.isHost) throw new Error("Alice should be host after reset");
  const bob = await connectNamed("Bob");
  const sA = alice.socket;

  const logOffset = logSnapshot();

  // State + capture
  let latestState = null;
  let ended = null;
  let submitStart = 0;
  let currentRound = 0;
  let firstMsgThisRound = true;

  sA.on("game:state", (st) => { latestState = st; });
  sA.on("game:ended", (d) => { ended = d; });
  sA.on("game:voteResult", (r) => {
    result.eliminations.push({
      round: currentRound,
      name: r.eliminated ? r.eliminated.name : null,
      isHuman: r.eliminated ? r.eliminated.isHuman : null,
    });
  });
  sA.on("game:newMessage", (msg) => {
    const now = Date.now();
    if (firstMsgThisRound && submitStart) {
      result.revealDelays.push({ round: currentRound, ms: now - submitStart });
      firstMsgThisRound = false;
    }
    const isHuman = latestState
      ? !!latestState.players.find(p => p.id === msg.playerId && p.isHuman)
      : (msg.playerName === "Alice" || msg.playerName === "Bob");
    result.messages.push({
      round: currentRound, playerName: msg.playerName, isHuman,
      text: msg.text, wc: words(msg.text), ellipsis: msg.text === "...",
    });
  });

  // Start game
  const gsPromise = new Promise(r => sA.once("game:state", r));
  await new Promise(r => sA.emit("lobby:start", {
    topic: TOPIC,
    aiPlayers: Array.from({ length: AI_COUNT }, () => ({ model })),
  }, r));
  latestState = await gsPromise;
  result.roster = latestState.players.map(p => ({ name: p.name, isHuman: p.isHuman }));
  const aiNames = latestState.players.filter(p => !p.isHuman).map(p => p.name);
  if (aiNames.length === 0) throw new Error("no AI players spawned");

  const aliveHumans = () => latestState.players
    .filter(p => p.isHuman && !p.isEliminated && !p.isDisconnected).map(p => p.name);
  const aliveAIs = () => latestState.players
    .filter(p => !p.isHuman && !p.isEliminated && !p.isDisconnected).map(p => p.name);

  const waitState = () => new Promise(r => sA.once("game:state", r));
  const start = Date.now();
  let voteRounds = 0;
  let phases = 0;

  while (!ended) {
    if (Date.now() - start > MODEL_WALL_MS) { result.events.push("WALL_CLOCK_CAP"); break; }
    if (++phases > 60) { result.events.push("PHASE_CAP"); break; }
    const phase = latestState.phase;

    if (phase === "SUBMITTING") {
      currentRound = latestState.round;
      submitStart = Date.now();
      firstMsgThisRound = true;
      const target = aliveAIs()[0] || aiNames[0];
      const humans = aliveHumans();
      const accuser = humans.includes("Alice") ? "Alice" : humans[0];
      const other = humans.find(h => h !== accuser);
      const next = waitState();
      // accuser (Alice) leads the accusation; other human (Bob) defends/questions
      if (accuser === "Alice") sA.emit("game:sendMessage", { text: accuserLine(currentRound, target) });
      else if (accuser === "Bob") bob.socket.emit("game:sendMessage", { text: accuserLine(currentRound, target) });
      if (other === "Bob") bob.socket.emit("game:sendMessage", { text: otherHumanLine(currentRound, target, accuser) });
      else if (other === "Alice") sA.emit("game:sendMessage", { text: otherHumanLine(currentRound, target, accuser) });
      latestState = await next;

    } else if (phase === "REVEALING" || phase === "VOTING_SOON") {
      latestState = await waitState();

    } else if (phase === "VOTING") {
      voteRounds++;
      await new Promise(r => sA.once("game:voteResult", r));
      const next = await Promise.race([
        waitState().then(s => ({ type: "state", s })),
        new Promise(r => sA.once("game:ended", d => r({ type: "ended", d }))),
        sleep(25000).then(() => ({ type: "timeout" })),
      ]);
      if (next.type === "state") latestState = next.s;
      else if (next.type === "ended") ended = next.d;
      else { result.events.push("POST_VOTE_TIMEOUT"); break; }
      if (voteRounds >= MAX_VOTE_ROUNDS && !ended) { result.events.push("MAX_VOTE_ROUNDS"); break; }

    } else {
      result.events.push("UNKNOWN_PHASE:" + phase);
      break;
    }
  }

  if (ended) { result.winner = ended.winner; }
  result.voteRounds = voteRounds;

  // Ranking parse validity from server log (read-only)
  const logTail = logSince(logOffset);
  if (logTail !== null) {
    for (const line of logTail.split("\n")) {
      if (/\[AI\].*ranked:/.test(line)) result.rankParsedOk++;
      else if (/could not parse/.test(line)) result.rankCouldNotParse++;
    }
  }

  // Dropped-AI rounds: rounds where fewer AI messages arrived than AIs alive at submit
  const aiMsgByRound = {};
  for (const m of result.messages) if (!m.isHuman) aiMsgByRound[m.round] = (aiMsgByRound[m.round] || 0) + 1;
  // best-effort: compare against AI_COUNT minus eliminations before that round
  let eliminatedAIsBefore = 0;
  const elimByRound = {};
  for (const e of result.eliminations) if (e.isHuman === false) elimByRound[e.round] = true;
  const rounds = [...new Set(result.messages.map(m => m.round))].sort((a, b) => a - b);
  for (const r of rounds) {
    const expected = AI_COUNT - eliminatedAIsBefore;
    if ((aiMsgByRound[r] || 0) < expected) result.droppedRounds++;
    if (elimByRound[r]) eliminatedAIsBefore++;
  }

  // Cleanup
  try { await new Promise(r => { sA.emit("game:returnToLobby"); sA.once("lobby:state", r); }); } catch {}
  sA.disconnect(); bob.socket.disconnect();
  result.ok = true;
  return result;
}

function score(result) {
  const ai = result.messages.filter(m => !m.isHuman);
  const rosterNames = result.roster.map(r => r.name);
  const accused = result.roster.find(r => !r.isHuman)?.name; // first AI = the target
  const post = ai.filter(m => m.round >= result.firstAccusationRound + 0); // accusation starts round 0
  const hasAccused = (t) => accused && t.toLowerCase().includes(accused.toLowerCase());
  const hasSuspicion = (t) => SUSPICION.some(k => t.toLowerCase().includes(k));
  const hasName = (t, self) => rosterNames.some(n => n !== self && t.toLowerCase().includes(n.toLowerCase()));
  const hasSide = (t) => SIDE_TAKING.some(k => t.toLowerCase().includes(k));

  // Accusation engagement (tightened): an AI message counts only if it actually engages the
  // accusation thread — names the accused alongside an identity/stance word, OR is the accused
  // defending themselves with such a word. Loose elimination chatter ("Alice revealed as human")
  // and friendly name-drops ("@Emily what topping?") do NOT count.
  const STANCE = ["human", "suspicious", "suspect", "impostor", "imposter", "pretend", "fake",
    "innocent", "real person", "not an ai", "bot", "sus", "defend", "reaching", "accus",
    "agree", "disagree", "back off", "you're right", "youre right", "not buying", "trust"];
  const engages = (m) => {
    const t = m.text.toLowerCase();
    if (!STANCE.some(k => t.includes(k))) return false;
    return hasAccused(m.text) || m.playerName === accused;
  };
  const engagement = post.length ? post.filter(engages).length / post.length : 0;
  const directAddress = ai.length ? ai.filter(m => hasName(m.text, m.playerName)).length / ai.length : 0;
  const sideTaking = ai.length ? ai.filter(m => hasSide(m.text)).length / ai.length : 0;
  const questionRate = ai.length ? ai.filter(m => m.text.includes("?")).length / ai.length : 0;
  const ellipsisRate = ai.length ? ai.filter(m => m.ellipsis).length / ai.length : 0;
  const lens = ai.filter(m => !m.ellipsis).map(m => m.wc);
  const delays = result.revealDelays.map(d => d.ms);
  const delayMax = delays.length ? Math.max(...delays) : 0;
  const within15 = delayMax > 0 && delayMax < 14500 && result.droppedRounds === 0;
  const rankTotal = result.rankParsedOk + result.rankCouldNotParse;
  const rankValidity = rankTotal ? result.rankParsedOk / rankTotal : null;

  // Composite 0-100: engagement .40, directAddress .20, latency-gate .25, rankValidity .15
  const latGate = within15 ? 1 : (delayMax > 0 ? Math.max(0, 1 - (delayMax - 14500) / 15000) - result.droppedRounds * 0.3 : 0);
  const rv = rankValidity == null ? 0.5 : rankValidity;
  const composite = Math.round(100 * (0.40 * engagement + 0.20 * directAddress + 0.25 * Math.max(0, latGate) + 0.15 * rv));

  return {
    aiMsgCount: ai.length, engagement, directAddress, sideTaking, questionRate, ellipsisRate,
    lenMean: mean(lens), lenStddev: stddev(lens), delayMeanMs: mean(delays), delayMaxMs: delayMax,
    within15, droppedRounds: result.droppedRounds, rankValidity, accused, composite,
  };
}

function writeTranscript(result, sc, outPath) {
  const L = [];
  L.push(`# AI Eval — ${result.model} (${LABEL})`);
  L.push(`\nTopic: ${result.topic}`);
  L.push(`Winner: ${result.winner || "(unfinished)"}  |  Vote rounds: ${result.voteRounds}  |  Events: ${result.events.join(", ") || "none"}`);
  L.push(`Accused (target AI): **${sc.accused}**`);
  L.push(`\nRoster: ` + result.roster.map(r => `${r.name}${r.isHuman ? "(H)" : "(AI)"}`).join(", "));
  L.push(`\n## Transcript\n`);
  let lastRound = -1;
  for (const m of result.messages) {
    if (m.round !== lastRound) { L.push(`\n--- Round ${m.round} ---`); lastRound = m.round; }
    const tag = m.isHuman ? (m.playerName === "Alice" ? "HUMAN-ACCUSER" : "HUMAN") : "AI";
    L.push(`[${tag}] ${m.playerName} (${m.wc}w): ${m.text}`);
  }
  L.push(`\n## Eliminations`);
  for (const e of result.eliminations) L.push(`- round ${e.round}: ${e.name ? `${e.name} (${e.isHuman ? "HUMAN" : "AI"})` : "no elimination"}`);
  L.push(`\n## Rubric`);
  L.push(`- AI messages: ${sc.aiMsgCount}`);
  L.push(`- **Post-accusation engagement: ${(sc.engagement * 100).toFixed(0)}%**`);
  L.push(`- Direct-address rate: ${(sc.directAddress * 100).toFixed(0)}%`);
  L.push(`- Side-taking rate: ${(sc.sideTaking * 100).toFixed(0)}%`);
  L.push(`- Question rate: ${(sc.questionRate * 100).toFixed(0)}%`);
  L.push(`- Ellipsis ('...') rate: ${(sc.ellipsisRate * 100).toFixed(0)}%`);
  L.push(`- Length mean/stddev (words): ${sc.lenMean.toFixed(1)} / ${sc.lenStddev.toFixed(1)}`);
  L.push(`- Reveal delay mean/max: ${(sc.delayMeanMs / 1000).toFixed(1)}s / ${(sc.delayMaxMs / 1000).toFixed(1)}s`);
  L.push(`- Within 15s window: ${sc.within15}  |  Dropped-AI rounds: ${sc.droppedRounds}`);
  L.push(`- Ranking parse validity: ${sc.rankValidity == null ? "n/a (no server log)" : (sc.rankValidity * 100).toFixed(0) + "%"}`);
  L.push(`- **Composite score: ${sc.composite}/100**`);
  writeFileSync(outPath, L.join("\n"));
}

async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const stamp = ts();
  console.log(`=== AI Eval (${LABEL}) over ${MODELS.length} models, ${AI_COUNT} AIs each ===`);
  if (SERVER_LOG) console.log(`Server log scrape: ${SERVER_LOG}`);
  const summary = [];

  for (const model of MODELS) {
    console.log(`\n--- ${model} ---`);
    try {
      const result = await runGameForModel(model);
      const sc = score(result);
      const out = resolve(OUT_DIR, `ai-eval-${sanitize(model)}-${LABEL}-${stamp}.md`);
      writeTranscript(result, sc, out);
      console.log(`  engagement=${(sc.engagement * 100).toFixed(0)}% directAddr=${(sc.directAddress * 100).toFixed(0)}% ` +
        `delayMax=${(sc.delayMaxMs / 1000).toFixed(1)}s dropped=${sc.droppedRounds} ` +
        `rankValid=${sc.rankValidity == null ? "n/a" : (sc.rankValidity * 100).toFixed(0) + "%"} composite=${sc.composite}`);
      console.log(`  transcript: ${out}`);
      summary.push({ model, sc, winner: result.winner, events: result.events });
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
      summary.push({ model, error: err.message });
    }
    await sleep(800);
  }

  // Summary table
  const S = [];
  S.push(`# AI Eval Summary (${LABEL}) — ${stamp}`);
  S.push(`\nTopic: ${TOPIC}  |  AIs/game: ${AI_COUNT}  |  Models: ${MODELS.length}\n`);
  S.push(`| Model | Engage% | DirectAddr% | Side% | Q% | Ellipsis% | LenMean/SD | DelayMax(s) | <15s | Dropped | RankValid% | Composite |`);
  S.push(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of summary) {
    if (r.error) { S.push(`| ${r.model} | ERROR: ${r.error} |||||||||||`); continue; }
    const s = r.sc;
    S.push(`| ${r.model} | ${(s.engagement * 100).toFixed(0)} | ${(s.directAddress * 100).toFixed(0)} | ` +
      `${(s.sideTaking * 100).toFixed(0)} | ${(s.questionRate * 100).toFixed(0)} | ${(s.ellipsisRate * 100).toFixed(0)} | ` +
      `${s.lenMean.toFixed(0)}/${s.lenStddev.toFixed(0)} | ${(s.delayMaxMs / 1000).toFixed(1)} | ${s.within15 ? "Y" : "N"} | ` +
      `${s.droppedRounds} | ${s.rankValidity == null ? "n/a" : (s.rankValidity * 100).toFixed(0)} | ${s.composite} |`);
  }
  const sumPath = resolve(OUT_DIR, `ai-eval-summary-${LABEL}-${stamp}.md`);
  writeFileSync(sumPath, S.join("\n"));
  console.log(`\n=== Summary written: ${sumPath} ===`);
  process.exit(0);
}

main().catch(err => { console.error("HARNESS FAILED:", err); process.exit(1); });
