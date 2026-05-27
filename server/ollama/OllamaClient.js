import fetch from 'node-fetch';

const BASE_URL = process.env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434';
const TIMEOUT_MS = 30000;

async function fetchWithTimeout(url, options, timeoutMs = TIMEOUT_MS) {
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

export async function getModels() {
  try {
    const response = await fetchWithTimeout(`${BASE_URL}/api/tags`);
    if (!response.ok) return [];
    const data = await response.json();
    return (data.models || []).map(m => m.name);
  } catch (err) {
    console.error('Ollama getModels error:', err.message);
    return [];
  }
}

export async function chat(model, messages) {
  try {
    const response = await fetchWithTimeout(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false }),
    });
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
