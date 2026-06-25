import fetch from 'node-fetch';

const BASE_URL = process.env.OLLAMA_BASE_URL || 'http://192.168.1.30:11434';
const CHAT_TIMEOUT_MS = 60000;
const LIST_TIMEOUT_MS = 5000;

let cachedModels = [];
let lastModelFetch = 0;
let refreshPromise = null;
const MODEL_CACHE_TTL = 30000;

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    return response;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

async function refreshModels() {
  try {
    const response = await fetchWithTimeout(`${BASE_URL}/api/tags`, {}, LIST_TIMEOUT_MS);
    if (!response.ok) {
      cachedModels = [];
      return;
    }
    const data = await response.json();
    cachedModels = (data.models || []).map(m => m.name);
    lastModelFetch = Date.now();
  } catch (err) {
    if (cachedModels.length === 0) {
      console.error('Ollama getModels error:', err.message);
    }
  }
}

export function getCachedModels() {
  return cachedModels;
}

setInterval(() => {
  refreshModels();
}, MODEL_CACHE_TTL);

refreshModels();

export async function getModels() {
  if (Date.now() - lastModelFetch < MODEL_CACHE_TTL && cachedModels.length > 0) {
    return cachedModels;
  }
  if (!refreshPromise) {
    refreshPromise = refreshModels().finally(() => { refreshPromise = null; });
  }
  await refreshPromise;
  return cachedModels;
}

export async function chat(model, messages) {
  try {
    const response = await fetchWithTimeout(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false }),
    }, CHAT_TIMEOUT_MS);
    if (!response.ok) {
      console.error('Ollama chat error:', response.status, response.statusText);
      return '...';
    }
    const data = await response.json();
    return data.message?.content || '...';
  } catch (err) {
    console.error('Ollama chat error:', err.message);
    return '...';
  }
}
