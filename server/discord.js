import fetch from 'node-fetch';

const DISCORD_AVATAR = 'https://raw.githubusercontent.com/earendil-works/cogito/main/client/favicon.ico';

export async function postToDiscord(hostSecret, reason) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;

  const body = JSON.stringify({
    username: 'Cogito',
    avatar_url: DISCORD_AVATAR,
    content: `🎮 Cogito host secret rotated [${reason}]\nHost secret: \`${hostSecret}\``,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Discord webhook returned ${res.status}: ${text.slice(0, 200)}`);
  }
}
