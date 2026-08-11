# Remote Host Support via Discord Webhook

**Date:** 2026-06-26
**Status:** TODO

## Problem

Cogito's current security model requires a LAN-realm player to act as host — only they can start games, reset sessions, and configure AI slots. This works when the server operator is home, but breaks entirely when everyone (including the operator) is remote. The goal is to allow a fully remote group to play while keeping the same access-control guarantees: uninvited strangers can't join, and only a trusted person controls the session.

## Design

Introduce a **rotating host secret**, generated at server startup and posted to a configured Discord webhook. The secret rotates daily at midnight (server time). The operator forwards the secret to a designated friend; that friend presents it in the existing `code` field at `lobby:setName` time and receives host privileges.

The session join code continues to be generated inside `GameSession` when the host joins — player join logic is not changed. The session code is never posted to Discord; the host reads it from the UI and shares it with the group manually.

The LAN realm path is preserved unchanged — if the operator is home, they join as a LAN player with no code required and become host as before.

## User Flow

1. Server starts → generates host secret → POSTs to Discord (if `DISCORD_WEBHOOK_URL` is set)
2. Operator sees Discord message, DMs designated friend the host secret
3. Friend enters name + host secret → becomes host, session is created, session code is generated
4. Host reads session code from the UI → shares it with the group
5. Everyone else enters name + session code → joins as regular player (unchanged from today)

## Rotation Events

| Trigger | Discord reason label |
|---|---|
| Server startup | `startup` |
| Daily at midnight (server time) | `daily rotation` |

That's it. `lobby:reset` and `game:returnToLobby` do **not** rotate the host secret — only a full server restart or the clock hitting midnight does.

Daily rotation fires unconditionally — mid-game rotation is harmless since joining is blocked during gameplay. If a host-secret-authed host is already in the lobby at rotation time, they remain host (they were already authenticated). Only new joiners must present the new secret.

Implementation: on startup, compute ms until next midnight and schedule a one-shot timer; on fire, rotate then schedule the next midnight.

## Discord Message Format

```
🎮 Cogito host secret rotated [startup]
Host secret: ABCDEF123456
```

If `DISCORD_WEBHOOK_URL` is unset or the POST fails, the host secret falls back to stdout. No hard dependency on Discord — the game runs without it.

The session code is **never** posted to Discord. The host reads it from the UI.

## Code Specs

- **Host secret**: 12-char random string, same charset as today's join code (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`)
- **Session code**: unchanged — 6-char, generated inside `GameSession` constructor when the host joins

## Files to Create / Modify

| File | Change |
|---|---|
| `server/HostSecretManager.js` | **New.** Owns host secret generation, rotation, Discord posting, midnight timer. Exposes `getSecret()` and `check(secret)` for use by socket handlers. |
| `server/discord.js` | **New.** Single `postToDiscord(hostSecret, reason)` function; HTTP POST to webhook. Called by `HostSecretManager` only. |
| `server/socket/handlers.js` | `lobby:setName`: check host secret before session code; `requireLanHost()`: also accept host-secret-authed players. Set `player.hostSecretAuthed = true` on successful host-secret join. |
| `server/index.js` | Initialize `HostSecretManager` on startup (before `httpServer.listen`). |
| `server/game/Player.js` | Add `hostSecretAuthed` boolean field (default `false`). |
| `server/game/GameManager.js` | No changes |
| `server/game/GameSession.js` | `assignHost()`: expand eligibility from LAN-only to LAN OR `hostSecretAuthed` |

## New Environment Variable

| Variable | Default | Description |
|---|---|---|
| `DISCORD_WEBHOOK_URL` | *(not set)* | If set, sends host secret to this webhook on every rotation. Falls back to stdout if unset or POST fails. |

## Detailed Behavior

### `HostSecretManager`

```js
// Singleton, initialized once at server startup.
const hostSecretManager = {
  _secret: null,        // current 12-char host secret
  _midnightTimer: null, // timeout handle

  init(discordWebhookUrl) {
    this._webhookUrl = discordWebhookUrl || null;
    this._rotate('startup');
    this._scheduleMidnight();
  },

  _rotate(reason) {
    this._secret = generateHostSecret(); // 12-char random from CODE_CHARS
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
    const ms = midnight - now;
    this._midnightTimer = setTimeout(() => {
      this._rotate('daily rotation');
      this._scheduleMidnight();
    }, ms).unref();
  },

  getSecret() { return this._secret; },
  check(secret) { return safeEqual(secret, this._secret); },
};
```

### `lobby:setName` — modified join gate

Present logic (abbreviated, public-realm path):
```
if realm === 'public' && (!session || code != session.sessionCode) → reject
```

New logic:
```
if realm === 'public':
  if code matches current host secret → allow, set player.hostSecretAuthed = true
  else if !session || code != session.sessionCode → reject
  else → allow as regular player (unchanged)
```

The host secret check has priority: a player presenting the host secret bypasses the session code check entirely and can create a session if none exists (just like a LAN player today).

### `requireLanHost()` — modified authorization gate

Present logic:
```
player.isHost && socket.data.realm === 'lan'
```

New logic:
```
player.isHost && (socket.data.realm === 'lan' || player.hostSecretAuthed)
```

This gates `lobby:start`, `lobby:reset`, and `game:returnToLobby`.

### Host assignment

`assignHost()` currently only picks LAN-realm humans. It must be widened to also consider `hostSecretAuthed` players:

```js
// Before (current):
const lanHumans = this.players.filter(p => p.isHuman && p.realm === 'lan');

// After:
const eligible = this.players.filter(p =>
  p.isHuman && (p.realm === 'lan' || p.hostSecretAuthed)
);
```

The first eligible human by join order gets host. A host-secret-authed player who joins before any LAN player becomes host. If a LAN player joins first (existing behavior), they become host and the host secret is never consumed (it sits unused until the next rotation). A LAN player joining after a host-secret player does NOT steal host — first-to-join wins.

### `GameSession` / `GameManager` — no changes

Session code generation, storage, the `sessionCode` property, and the public-realm session code check are untouched. The `getOrCreateSession()` path is not modified.

### Rotation does not kick existing hosts

Daily rotation only changes `HostSecretManager._secret`. It does not iterate players or revoke `hostSecretAuthed`. An existing host stays host. If they disconnect and rejoin, they use their rejoin token (mid-game) or re-present the new host secret (if in lobby after a reset).

## Security Notes

- Host secret is 12 chars (vs 6 for join code) to reduce guessability
- Discord webhook URL is sensitive and must be kept in env — never logged or broadcast
- Host secret never appears in any client-side socket payload (only sent by the client as the `code` field, same as session codes today)
- Session code continues to never appear in any client-side socket payload except to the host
- Session code is never posted to Discord
- If webhook fails, host secret falls back to stdout (SSH fallback)
- LAN realm path is unchanged — LAN players always bypass code checks
- Host secret rotation does not affect mid-game rejoin (which uses per-player rejoin tokens, not codes)

## Verification Checklist

1. Start server without `DISCORD_WEBHOOK_URL` → host secret appears in stdout
2. Set `DISCORD_WEBHOOK_URL` → Discord message appears on startup with host secret
3. Join from public realm with host secret → becomes host, can start game, sees session code in UI
4. Join from public realm with session code → regular player, cannot start/reset (unchanged)
5. Join from public realm with wrong code → rejected with error (unchanged)
6. Join from public realm with host secret when no session exists → creates session, becomes host
7. Trigger `lobby:reset` → host secret does **not** change; new session code generated when next host joins (unchanged)
8. Trigger `game:returnToLobby` → host secret does **not** change; same as above
9. Confirm LAN-realm join still works with no code, still becomes host (existing behaviour unchanged)
10. Mock midnight → rotation fires, new host secret sent to Discord; existing host-secret-authed host in lobby stays host; new joiners need the new secret
11. Restart server → new host secret generated on startup; old secret rejected
