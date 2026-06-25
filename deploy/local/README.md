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

## Gotcha: editing the Caddyfile

The Caddyfile is bind-mounted as a single file. If you edit it with an editor
that replaces the file (write-new-inode + rename — most do), the running
container keeps seeing the **old** inode. Recreate Caddy to pick up edits:

```bash
docker compose -f deploy/local/docker-compose.caddy.yml up -d --force-recreate
```

## Why `header_up X-Cogito-Realm` has no `-` strip line

Caddy applies header **deletes after sets**, so a `header_up -X-Cogito-Realm`
"strip first" line removes the realm value the very next `set` adds — the
upstream then receives no header and the app falls back to `realm=public`
(LAN clients silently lose host privileges). `header_up`'s Set already
*replaces* any value a client tried to forge, so a single set line is both
sufficient and safe. This was the root cause of "joining from LAN doesn't grant
host" — see the fixed `deploy/Caddyfile`.
