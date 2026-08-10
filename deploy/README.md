# Cogito — secure self-hosting runbook

Operator guide for exposing Cogito to friends over the internet without
opening any inbound firewall ports, while keeping a privileged LAN-only path
for the host. Read this fully before going live. The same setup doubles as
the local test harness for the LAN-realm security feature (see "Quick start
— LAN-only" below) — there's only one path to learn.

## 1. Overview

This directory runs Caddy (TLS termination, split-horizon realm header) and,
optionally, a Cloudflare Tunnel container — both as Docker containers
alongside the app's own `docker-compose.yml` at the repo root.

```
Internet ──(Cloudflare Tunnel, outbound-only)──► cogito-caddy ──► cogito-net ──► app
LAN ───────────────────────────────────────────► cogito-caddy (cogito.home.arpa) ──► cogito-net ──► app
```

- **cloudflared container**: makes an outbound connection from your host to
  Cloudflare — no inbound firewall ports are ever opened. Only the public
  domain is routed through it; it reaches Caddy over the internal `cogito-net`
  Docker network (`cogito-caddy:80`), not through any published port. This hop
  is plain HTTP — it never leaves the private Docker network, and Cloudflare's
  edge already terminates the publicly-trusted TLS cert your friends see.
- **caddy container** (`deploy/Caddyfile`):
  - `{$COGITO_PUBLIC_DOMAIN}` — public, reached via the tunnel over plain HTTP
    (see above). Treated as the `public` realm. Gated by the app's
    per-session join code (auto-generated, shown to the host in the lobby) —
    Caddy doesn't gate this, the app does.
  - `cogito.home.arpa` — LAN-only, published on the host's `80`/`443` over
    HTTPS (Caddy's internal CA) for machines on your LAN, never tunneled.
    Treated as the `lan` realm, which the app grants host/admin privileges to.
- **App**: the `cogito` container (root `docker-compose.yml`) still publishes
  no port to the host at all — it's only reachable from whatever else is on
  `cogito-net`, i.e. `cogito-caddy`.

The split-horizon design means the *hostname you use* determines your
privilege level. Caddy enforces this by setting the `X-Cogito-Realm` header
itself per vhost with a single `header_up X-Cogito-Realm <realm>` — Caddy's
Set *replaces* any value a client tried to forge, so one line per vhost is
enough. Do not also add a `header_up -X-Cogito-Realm` "strip": Caddy applies
header deletes after sets, so it would wipe the realm and leave every client
`public` (see `deploy/Caddyfile`). The app trusts this header only because
`cogito-caddy` is the sole thing on `cogito-net` positioned to set it —
nothing external can reach the app directly to forge it.

## 2. Quick start — LAN-only

Enough to test the realm-gating layer (`tests/join.mjs`,
`tests/ui-realm-code.mjs`) without touching Cloudflare at all:

```bash
# repo root
cp .env.example .env    # set ALLOWED_ORIGINS=https://cogito.home.arpa
docker compose up -d    # app on cogito-net, no host port

# this directory
cp deploy/.env.example deploy/.env   # placeholder COGITO_PUBLIC_DOMAIN is fine
docker compose -f deploy/docker-compose.yml up -d   # caddy only, on :80/:443
```

`cogito.home.arpa` must resolve to the host running Caddy (see "LAN DNS"
below), or run tests from a throwaway container that resolves the name to the
Caddy container instead:

```bash
CADDY_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' cogito-caddy)
docker run --rm --network cogito-net --add-host "cogito.home.arpa:$CADDY_IP" \
  -v "$PWD:/app" -w /app node:20-alpine node tests/join.mjs
```

```bash
node tests/join.mjs            # connects to https://cogito.home.arpa
node tests/ui-realm-code.mjs   # Playwright; needs `npx playwright install chromium`
```

Expect `JOIN TEST PASSED`, and `docker logs cogito | grep realm` should show
`realm: lan`. Note: the client UI is baked into the `cogito` image, so after
editing `client/` re-run `docker compose up -d --build` before testing.

Tear down:

```bash
docker compose -f deploy/docker-compose.yml down
docker compose down
```

## 3. Full stack — public + LAN via Cloudflare Tunnel

This is the real production path (and, with a throwaway tunnel, also how to
test the full public route locally).

**1. Create a tunnel and get a token** (Cloudflare Zero Trust dashboard):
Networks → Tunnels → Create a tunnel → choose Docker as the connector →
copy the token shown in the `docker run` command.

**2. Configure the env file**:

```bash
cp deploy/.env.example deploy/.env
# fill in TUNNEL_TOKEN and COGITO_PUBLIC_DOMAIN
```

**3. Route the public hostname to Caddy** (same dashboard, Public Hostname
tab on your tunnel):

| Field | Value |
|---|---|
| Hostname | your real domain, matching `COGITO_PUBLIC_DOMAIN` |
| Service | `http://cogito-caddy:80` |

Plain HTTP is fine here: this hop never leaves the private `cogito-net`
Docker network — Cloudflare's edge already terminates the real, publicly-
trusted TLS cert your friends see before traffic ever reaches cloudflared.

**4. Add the public domain to `ALLOWED_ORIGINS`** in the root `.env`:

```
ALLOWED_ORIGINS=https://cogito.home.arpa,https://your.domain.com
```

**5. Bring everything up**:

```bash
docker compose up -d --build                                  # app
docker compose -f deploy/docker-compose.yml up -d             # caddy + cloudflared
```

**Verify**:

```bash
docker logs -f cogito-cloudflared
# Look for: "Registered tunnel connection" and no errors

curl -I https://your.domain.com/

docker logs cogito | grep realm
# realm: public for the public-domain requests, realm: lan for cogito.home.arpa
```

Tear down:

```bash
docker compose -f deploy/docker-compose.yml down
docker compose down
```

## 4. Already running your own Caddy?

If you already run a Caddy instance elsewhere for other services, you don't
need the `caddy` container here at all. Instead:

1. `docker network connect cogito-net <your-caddy-container>` (or add
   `cogito-net` as an `external` network in your Caddy's own compose file, so
   it reconnects on every `up`).
2. Copy the two site blocks out of `deploy/Caddyfile` into your own Caddyfile
   (or an imported snippet). They already target `reverse_proxy cogito:3000`,
   which resolves once your Caddy container shares `cogito-net`. Fill in
   `COGITO_PUBLIC_DOMAIN` and drop the duplicate global options `{ ... }`
   block if you already have one.
3. Reload your Caddy however you normally do.
4. `tls internal` CA trust for `cogito.home.arpa`: if your Caddy already
   issues other `tls internal` certs you've trusted on the host, there's
   nothing more to do. Otherwise extract its root cert (typically
   `.../data/caddy/pki/authorities/local/root.crt` in its data volume) and
   import it into your host OS/browser trust store.
5. You can still run the `cloudflared` container
   (`docker compose -f deploy/docker-compose.yml up -d cloudflared`)
   and point its Public Hostname service address at your own Caddy container
   instead of `cogito-caddy:80`.

## 5. LAN DNS

Add an A record so `cogito.home.arpa` resolves to your host's LAN IP, on
whatever resolves DNS for your LAN (router admin page, Pi-hole, Unbound,
dnsmasq, etc.):

```
cogito.home.arpa.   A   192.168.1.X   ; your host's LAN IP
```

`.home.arpa` is reserved by RFC 8375 for exactly this purpose (home
networks), so it won't collide with any real public TLD. Friends' devices,
using public DNS, simply cannot resolve this name — they have no path to the
LAN vhost even if they guessed it.

## 6. App environment

Set these in the root `.env` (consumed by the root `docker-compose.yml`):

- Join code — **not** an env var. A random 6-character code is generated per
  session when the LAN host joins, and shown only to the host in the lobby.
  Friends enter it on the join screen (or open
  `https://your.domain.com/?code=<CODE>`, which prefills it). A new code is
  generated whenever the host resets / returns to the lobby.
- `ALLOWED_ORIGINS` — comma-separated list of origins allowed to connect
  (CORS / Socket.IO origin check). Must list **both** vhost URLs exactly as
  friends/you will use them.
- `HOST=0.0.0.0` — only controls which network interface the Node process
  binds to *inside the container*. It does **not** expose the app to the
  LAN/internet: the `cogito` container still publishes no port to the host at
  all; the only access path is `cogito-net`.

## 7. Verification checklist

Run these after deploying to confirm each layer behaves as designed:

1. **Realm set wins over a forged header** (proves a client can't spoof host
   privileges through the public vhost):
   ```bash
   curl -H 'X-Cogito-Realm: lan' https://your.domain.com/
   ```
   The app must treat this request as `public` — Caddy's `header_up
   X-Cogito-Realm public` (Set) replaces the forged `lan` before proxying.

2. **No host port on the app** (proves the LAN/internet can't bypass Caddy and
   hit the app directly):
   ```bash
   docker compose port cogito 3000
   ```
   Expect empty output / an error — `cogito` has no published port. Then
   confirm the `cogito-net` path works instead:
   ```bash
   docker exec cogito-caddy wget -qO- http://cogito:3000
   ```
   Expect a successful response — this is the *only* way to reach the app.

3. **Full play loop**:
   - Open `https://cogito.home.arpa` from the host (or another CA-trusted
     machine on the LAN) and join with host privileges. Read the session
     code shown in the lobby and share it.
   - A friend opens `https://your.domain.com/?code=<CODE>` (or enters the
     code on the join screen) and joins as a player (public realm).
   - Confirm both can see the same lobby/game state, and that only the
     `lan`-realm session gets host controls.

## 8. Gotcha: editing the Caddyfile

`deploy/Caddyfile` is bind-mounted as a single file. If you edit it with an
editor that replaces the file (write-new-inode + rename — most do), the
running container keeps seeing the **old** inode. Recreate Caddy to pick up
edits:

```bash
docker compose -f deploy/docker-compose.yml up -d --force-recreate caddy
```
