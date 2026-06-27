# Local Caddy test harness

A self-contained reproduction of the production reverse-proxy path, used to
test the **LAN realm → host privileges** security feature end-to-end. Unlike
`deploy/Caddyfile` (a snippet for your own Caddy), the `Caddyfile` here is a
complete, standalone config that Caddy runs by itself, exposing only the LAN
vhost `cogito.home.arpa` and stamping `X-Cogito-Realm: lan`.

## Bring it up

From the repo root:

```bash
# .env must set ALLOWED_ORIGINS=https://cogito.home.arpa (see .env.example)
docker compose up -d                                           # app on cogito-net (no host port)
docker compose -f deploy/local/docker-compose.caddy.yml up -d  # Caddy on :80/:443
```

`cogito.home.arpa` must resolve to the host running Caddy (add an A record, or
the test can be run from a container with `--add-host`, see below).

## Run the join test

```bash
node tests/join.mjs            # connects to https://cogito.home.arpa
```

If DNS isn't pointed at this host yet, run the test from a throwaway container
that resolves the name to the Caddy container:

```bash
CADDY_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' cogito-caddy)
docker run --rm --network cogito-net --add-host "cogito.home.arpa:$CADDY_IP" \
  -v "$PWD:/app" -w /app node:20-alpine node tests/join.mjs
```

Expect `JOIN TEST PASSED`, and `docker logs cogito | grep realm` should show
`realm: lan` for the connections.

For the **visual** check (the join page must not show the session-code box to
LAN players), run the Playwright test (needs `npx playwright install chromium`):

```bash
node tests/ui-realm-code.mjs   # loads https://cogito.home.arpa, asserts code box hidden
```

Note: the client UI is baked into the `cogito` image, so after editing
`client/` re-run `docker compose up -d --build` before testing.

## Tear down

```bash
docker compose -f deploy/local/docker-compose.caddy.yml down
docker compose down
```

---

## Full-stack cloudflare tunnel test

`docker-compose.full-stack.yml` extends the LAN-only harness above with a
`cloudflare/cloudflared` container, so you can verify the complete production
path — public Cloudflare domain → cloudflared → Caddy → app — without touching
your real server.

### One-time setup

**1. Create your env file** (gitignored):

```bash
cp deploy/local/.env.cloudflared.example deploy/local/.env.cloudflared
# Edit it: fill in TUNNEL_TOKEN and COGITO_PUBLIC_DOMAIN
```

Get `TUNNEL_TOKEN` from the Cloudflare Zero Trust dashboard:
Networks → Tunnels → your tunnel → Overview → "Install connector" → copy the
token from the Docker command.

**2. Add the public domain to `ALLOWED_ORIGINS`** in the root `.env`:

```
ALLOWED_ORIGINS=https://cogito.home.arpa,https://your.domain.com
```

**3. Configure tunnel routing in the Cloudflare dashboard** (Networks → Tunnels
→ your tunnel → Public Hostname):

| Field | Value |
|---|---|
| Hostname | your.domain.com |
| Service | `https://cogito-caddy:443` |
| TLS → No TLS Verify | ✓ enabled (Caddy uses an internal CA) |

`cogito-caddy` resolves inside Docker because cloudflared and Caddy share the
`cogito-net` network.

### Bring it up

```bash
docker compose up -d --build                                              # app
docker compose -f deploy/local/docker-compose.full-stack.yml up -d       # caddy + cloudflared
```

This file is an **alternative** to `docker-compose.caddy.yml`, not an overlay.
Don't run both at the same time — they share the container name `cogito-caddy`.

### Verify

Watch cloudflared connect:

```bash
docker logs -f cogito-cloudflared
# Look for: "Registered tunnel connection" and no errors
```

Then hit your public domain in a browser or with curl:

```bash
curl -I https://your.domain.com/
```

And confirm the realm header on the cogito side:

```bash
docker logs cogito | grep realm
# Should show realm: public for the public-domain requests
# and realm: lan for any cogito.home.arpa requests
```

### Tear down

```bash
docker compose -f deploy/local/docker-compose.full-stack.yml down
docker compose down
```

## Gotcha: editing the Caddyfile

The Caddyfile is bind-mounted as a single file. If you edit it with an editor
that replaces the file (write-new-inode + rename — most do), the running
container keeps seeing the **old** inode. Recreate Caddy to pick up edits:

```bash
docker compose -f deploy/local/docker-compose.caddy.yml up -d --force-recreate
```

## Why `header_up X-Cogito-Realm` has no `-` strip line

See DEPLOY.md Section 1 — Caddy applies deletes after sets, so a strip line
wipes the realm value the set just added. One `header_up X-Cogito-Realm lan`
line is both sufficient and safe.
