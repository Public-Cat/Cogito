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
  cors: { origin: '*', methods: ['GET', 'POST'] },
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
  console.log(`Socket connected: ${socket.id}`);
  registerHandlers(io, socket);
});

httpServer.listen(PORT, () => {
  console.log(`Cogito server listening on port ${PORT}`);
});
