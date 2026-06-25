import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getModels } from './ollama/OllamaClient.js';
import { registerHandlers } from './socket/handlers.js';
import { topics } from './game/topics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

// CORS allow-list: restrict Socket.IO handshakes to known origins. Override
// via ALLOWED_ORIGINS (comma-separated) for self-hosted domains/LAN names.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://cogito.example.com,https://cogito.home.arpa').split(',').map(s => s.trim());

const RULES_PATH = path.join(__dirname, '..', 'RULES.md');
let rulesText = '';
try {
  rulesText = fs.readFileSync(RULES_PATH, 'utf-8');
} catch {
  console.error('Could not load RULES.md');
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'] },
});

app.use(express.static(path.join(__dirname, '..', 'client')));

app.get('/api/models', async (_req, res) => {
  const models = await getModels();
  res.json({ models });
});

app.get('/api/rules', (_req, res) => {
  res.type('text/plain').send(rulesText || 'Game rules not available.');
});

app.get('/api/topics', (_req, res) => {
  res.json({ topics });
});

io.on('connection', (socket) => {
  // Realm stamping: only a reverse proxy on the LAN is trusted to set this
  // header, so default to 'public' (fail safe) when it's absent or wrong.
  socket.data.realm = socket.handshake.headers['x-cogito-realm'] === 'lan' ? 'lan' : 'public';
  console.log(`Socket connected: ${socket.id} (realm: ${socket.data.realm})`);
  // Tell the client its realm so the join UI can hide the session-code field
  // for LAN players (they bypass the code gate). Not sensitive — the server
  // still enforces realm; this only drives presentation.
  socket.emit('client:hello', { realm: socket.data.realm });
  registerHandlers(io, socket);
});

httpServer.listen(PORT, HOST, () => {
  console.log(`Cogito server listening on ${HOST}:${PORT}`);
});
