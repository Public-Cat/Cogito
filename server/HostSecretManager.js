import { randomInt, timingSafeEqual } from 'node:crypto';
import { postToDiscord } from './discord.js';

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateHostSecret() {
  let s = '';
  for (let i = 0; i < 12; i++) s += CODE_CHARS[randomInt(CODE_CHARS.length)];
  return s;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const hostSecretManager = {
  _secret: null,
  _midnightTimer: null,
  _webhookUrl: null,

  init(discordWebhookUrl) {
    this._webhookUrl = discordWebhookUrl || null;
    this._rotate('startup');
    this._scheduleMidnight();
  },

  _rotate(reason) {
    this._secret = generateHostSecret();
    console.log(`[host-secret] rotated (${reason}): ${this._secret}`);
    if (this._webhookUrl) {
      postToDiscord(this._secret, reason).catch(err =>
        console.error('[host-secret] Discord post failed:', err.message)
      );
    }
  },

  _scheduleMidnight() {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    this._midnightTimer = setTimeout(() => {
      this._rotate('daily rotation');
      this._scheduleMidnight();
    }, midnight - now).unref();
  },

  getSecret() { return this._secret; },
  check(secret) { return safeEqual(secret, this._secret); },
};

export default hostSecretManager;
