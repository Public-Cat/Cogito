# Cogito — secure self-hosting runbook

Operator guide for exposing Cogito to friends over the internet without
opening any firewall ports, while keeping a privileged LAN-only path for
the host. Read this fully before going live.

## 1. Overview

This repo does **not** provision or manage Caddy — it assumes you already
run your own Caddy instance (Docker or host install) fronting other
services, and shows how to plug Cogito into it.

Two layers, each independently restricting access:

```
Internet ──(Cloudflare Tunnel, outbound-only)──► Your Caddy ──► Docker network (cogito-net) ──► App
LAN ───────────────────────────────────────────► Your Caddy (cogito.home.arpa) ──► Docker network (cogito-net) ──► App
```

- **Cloudflare Tunnel**: `cloudflared` makes an outbound connection from
  your host to Cloudflare — no inbound firewall ports are ever opened.
  Only `cogito.example.com` is published through it.
- **Your Caddy instance**: terminates TLS for two vhosts (added to your
  existing Caddyfile — see section 3):
  - `cogito.example.com` — public, reached via the tunnel. Treated as the
    `public` realm. Gated by the in-app `SESSION_CODE`.
  - `cogito.home.arpa` — LAN-only, never tunneled. Treated as the `lan`
    realm, which the app should grant host/admin privileges to.
- **App/Docker**: the `cogito` container publishes no port to the host at
  all. It's only reachable from whatever else is attached to the
  `cogito-net` Docker network it's on (defined in `docker-compose.yml`) —
  which should be just your Caddy container, connected per section 3.

The split-horizon design means the *hostname you use* determines your
privilege level. Caddy enforces this by stripping any client-supplied
`X-Cogito-Realm` header and re-setting it itself per vhost (strip-then-set
— see `deploy/Caddyfile`). The app must trust this header only because
Caddy is the sole thing on `cogito-net` that can reach it.

## 2. App environment

Set these in `docker-compose.yml` (or an `.env` file consumed by it):

- `SESSION_CODE` — shared secret friends need to join via the public link
  (e.g. `https://cogito.example.com/?code=...`). **Change the `changeme`
  placeholder before going live.** Rotate at any time by editing the env
  value and running:
  ```bash
  docker compose up -d
  ```
- `ALLOWED_ORIGINS` — comma-separated list of origins allowed to connect
  (CORS / Socket.IO origin check). Must list **both** vhost URLs exactly as
  friends/you will use them:
  ```
  ALLOWED_ORIGINS=https://cogito.example.com,https://cogito.home.arpa
  ```
- `HOST=0.0.0.0` — this only controls which network interface the Node
  process binds to *inside the container*. It does **not** expose the app
  to the LAN or internet: no port is published to the host at all. The
  actual access restriction is that the `cogito` container is only on the
  `cogito-net` network — only your Caddy container, once connected to it
  (see section 3), can reach it.

## 3. Caddy (integrating with your existing instance)

This repo doesn't run Caddy for you. `docker-compose.yml` defines the
`cogito-net` Docker network Cogito sits on; these steps connect your
existing Caddy container to it:

1. **Bring Cogito up** so `cogito-net` exists:
   ```bash
   docker compose up -d
   ```
2. **Connect your Caddy container to `cogito-net`** so it can reach
   `cogito` by name:
   ```bash
   docker network connect cogito-net <your-caddy-container>
   ```
   If your Caddy runs via its own `docker-compose.yml`, you can instead add
   `cogito-net` as an external network there so it reconnects automatically
   on every `up`:
   ```yaml
   services:
     caddy:
       networks:
         - cogito-net   # plus whatever networks it already has
   networks:
     cogito-net:
       external: true
   ```
3. **Copy the two vhost blocks from `deploy/Caddyfile`** into your own
   Caddyfile (or an imported snippet file, if your setup uses Caddy's
   `import` directive). They already target `reverse_proxy cogito:3000`,
   which resolves now that both containers share `cogito-net`. Edit
   `cogito.example.com` to your real domain.
4. **Reload your Caddy** however you normally do — e.g.
   `docker exec <your-caddy-container> caddy reload --config /etc/caddy/Caddyfile`,
   or your existing compose/systemd workflow. Not something this repo
   dictates.
5. **`tls internal` CA trust for `cogito.home.arpa`**: if your Caddy
   already issues other `tls internal` certs you've trusted on the host,
   there's nothing more to do. Otherwise, extract its root cert from
   wherever your Caddy persists its data (typically
   `.../data/caddy/pki/authorities/local/root.crt` inside its data
   volume/mount) and import it into your host OS/browser trust store —
   steps vary per OS.

Friends never see this certificate; they only hit the publicly-trusted
Cloudflare-issued cert on `cogito.example.com`.

## 4. LAN DNS

Add an A record so `cogito.home.arpa` resolves to your host's LAN IP, on
whatever resolves DNS for your LAN (router admin page, Pi-hole, Unbound,
dnsmasq, etc.):

```
cogito.home.arpa.   A   192.168.1.X   ; your host's LAN IP
```

`.home.arpa` is reserved by RFC 8375 for exactly this purpose (home
networks), so it won't collide with any real public TLD. Friends' devices,
using public DNS, simply cannot resolve this name — they have no path to
the LAN vhost even if they guessed it.

## 5. Cloudflare Tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create cogito
# Note the TUNNEL_ID printed — use it below and in deploy/cloudflared-config.yml

cloudflared tunnel route dns cogito cogito.example.com
```

Copy `deploy/cloudflared-config.yml` to `/etc/cloudflared/config.yml`,
fill in `<TUNNEL_ID>` (both the `tunnel:` field and the credentials-file
path) and your real domain, then run:

```bash
sudo cloudflared service install   # or: cloudflared tunnel run cogito
```

Only `cogito.example.com` appears in the ingress list — `cogito.home.arpa`
is intentionally absent and must **never** be added to this file. The
tunnel has no inbound firewall requirement; `cloudflared` only makes
outbound connections to Cloudflare's edge.

## 6. Verification checklist

Run these after deploying to confirm each layer behaves as designed:

1. **Realm strip-then-set** (proves a client can't spoof host privileges
   through the public vhost):
   ```bash
   curl -H 'X-Cogito-Realm: lan' https://cogito.example.com/
   ```
   The app must treat this request as `public` — Caddy's `header_up
   -X-Cogito-Realm` strips the attempted spoof before forcing `public`.

2. **No host port published** (proves the LAN/internet can't bypass Caddy
   and hit the app directly):
   ```bash
   docker compose port cogito 3000
   ```
   Expect empty output / an error — `cogito` has no published port. Then
   confirm the `cogito-net` path works instead:
   ```bash
   docker exec <your-caddy-container> wget -qO- http://cogito:3000
   ```
   Expect a successful response — this is the *only* way to reach the app.

3. **Full play loop**:
   - A friend opens `https://cogito.example.com/?code=<SESSION_CODE>` and
     joins as a player (public realm).
   - You open `https://cogito.home.arpa` from the host (or another
     CA-trusted machine on the LAN) and join with host privileges.
   - Confirm both can see the same lobby/game state, and that only the
     `lan`-realm session gets host controls.
