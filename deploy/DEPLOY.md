# Cogito — secure self-hosting runbook

Operator guide for exposing Cogito to friends over the internet without
opening any firewall ports, while keeping a privileged LAN-only path for
the host. Read this fully before going live.

## 1. Overview

Three layers, each independently restricting access:

```
Internet ──(Cloudflare Tunnel, outbound-only)──► Caddy (HTTPS, host) ──► Docker (127.0.0.1-only) ──► App
LAN ───────────────────────────────────────────► Caddy (cogito.home.arpa) ──► Docker (127.0.0.1-only) ──► App
```

- **Cloudflare Tunnel**: `cloudflared` makes an outbound connection from
  your host to Cloudflare — no inbound firewall ports are ever opened.
  Only `cogito.example.com` is published through it.
- **Caddy**: runs on the host, terminates TLS for two vhosts:
  - `cogito.example.com` — public, reached via the tunnel. Treated as the
    `public` realm. Gated by the per-session join code (auto-generated and
    shown to the host in the lobby).
  - `cogito.home.arpa` — LAN-only, never tunneled. Treated as the `lan`
    realm, which the app should grant host/admin privileges to.
- **App/Docker**: the Node app listens inside a container whose port is
  bound to `127.0.0.1` only (`docker-compose.yml`), so nothing but Caddy
  on the same host can reach it — not the LAN, not 0.0.0.0.

The split-horizon design means the *hostname you use* determines your
privilege level. Caddy enforces this by stripping any client-supplied
`X-Cogito-Realm` header and re-setting it itself per vhost (strip-then-set
— see `deploy/Caddyfile`). The app must trust this header only because
Caddy is the sole path to it (port 3008 is loopback-only).

## 2. App environment

Set these in `docker-compose.yml` (or an `.env` file consumed by it):

- Join code — **not** an env var. A random 6-character code is generated per
  session when the LAN host joins, and shown only to the host in the lobby.
  Friends enter it on the join screen (or open
  `https://cogito.example.com/?code=<CODE>`, which prefills it). A new code is
  generated whenever the host resets / returns to the lobby. There is nothing
  to configure or rotate.
- `ALLOWED_ORIGINS` — comma-separated list of origins allowed to connect
  (CORS / Socket.IO origin check). Must list **both** vhost URLs exactly as
  friends/you will use them:
  ```
  ALLOWED_ORIGINS=https://cogito.example.com,https://cogito.home.arpa
  ```
- `HOST=0.0.0.0` — this only controls which network interface the Node
  process binds to *inside the container*. It does **not** expose the app
  to the LAN or internet. The actual access restriction is the
  `127.0.0.1:3008:3000` port binding in `docker-compose.yml` — only
  processes on the host itself (i.e. Caddy) can reach port 3008.

## 3. Caddy

Install Caddy on the host (not in Docker, so it can bind host ports 80/443
and reach `127.0.0.1:3008`):

```bash
# Debian/Ubuntu example
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudflare.com/...' # see your distro's Caddy install docs
```

Copy `deploy/Caddyfile` to `/etc/caddy/Caddyfile`, edit `cogito.example.com`
to your real domain, then:

```bash
sudo systemctl reload caddy
```

The `cogito.home.arpa` vhost uses `tls internal` — Caddy mints its own
local CA and a certificate for that name on first run. Trust that CA in
your **host browser only** (the one you'll use to reach the LAN vhost):

```bash
# Find and trust Caddy's local root CA (path varies by OS/install)
caddy trust
```

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

## 6. Container egress restriction (C4)

**Concern**: if the app container is compromised, it should not be able to
reach other devices on your LAN — only Ollama, which it legitimately needs.

Find the `cogito-net` subnet:

```bash
docker network inspect cogito-net | grep Subnet
# e.g. "Subnet": "172.20.0.0/16"
```

Example `iptables` rules using Docker's `DOCKER-USER` chain (evaluated
before Docker's own forwarding rules, so it can override them). **Adapt
the subnet and Ollama IP/port to your environment:**

```bash
# Allow cogito-net -> Ollama (adjust subnet + Ollama address)
sudo iptables -I DOCKER-USER -s 172.20.0.0/16 -d 192.168.1.30 -p tcp --dport 11434 -j ACCEPT

# Allow established return traffic (needed for the ACCEPT above to be useful)
sudo iptables -I DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# Drop all other cogito-net -> RFC1918 (LAN) traffic
sudo iptables -I DOCKER-USER -s 172.20.0.0/16 -d 10.0.0.0/8 -j DROP
sudo iptables -I DOCKER-USER -s 172.20.0.0/16 -d 172.16.0.0/12 -j DROP
sudo iptables -I DOCKER-USER -s 172.20.0.0/16 -d 192.168.0.0/16 -j DROP

# (Don't drop 172.16.0.0/12 traffic to the Docker bridge itself if your
# Ollama happens to live in that range as a container — order the ACCEPT
# rule for Ollama before the broader DROP rules, as above.)
```

These rules only constrain `cogito-net` egress; they do not affect the
loopback path Caddy uses to reach the app (`127.0.0.1:3008`), which never
traverses `DOCKER-USER`.

**Alternative**: instead of firewall rules, put Ollama on a Docker network
shared with `cogito-net` (or attach the Ollama container to `cogito-net`)
and address it by service/container name (e.g.
`OLLAMA_BASE_URL=http://ollama:11434`). This avoids needing host firewall
rules at all, at the cost of running Ollama in Docker too.

## 7. Verification checklist

Run these after deploying to confirm each layer behaves as designed:

1. **Realm strip-then-set** (proves a client can't spoof host privileges
   through the public vhost):
   ```bash
   curl -H 'X-Cogito-Realm: lan' https://cogito.example.com/
   ```
   The app must treat this request as `public` — Caddy's `header_up
   -X-Cogito-Realm` strips the attempted spoof before forcing `public`.

2. **Localhost-only publish** (proves the LAN/internet can't bypass Caddy
   and hit the app directly), from a different LAN machine:
   ```bash
   curl http://<host-ip>:3008
   ```
   Expect **connection refused** — the port is bound to `127.0.0.1` only.

3. **Egress restriction** (proves C4 works), from the host:
   ```bash
   docker exec cogito wget -qO- http://192.168.1.30:11434/api/tags   # should succeed
   docker exec cogito wget -qO- http://<some-other-lan-host>         # should hang/fail
   ```

4. **Full play loop**:
   - You open `https://cogito.home.arpa` from the host (or another
     CA-trusted machine on the LAN) and join with host privileges. Read the
     session code shown in the lobby and share it.
   - A friend opens `https://cogito.example.com/?code=<CODE>` (or enters the
     code on the join screen) and joins as a player (public realm).
   - Confirm both can see the same lobby/game state, and that only the
     `lan`-realm session gets host controls.
