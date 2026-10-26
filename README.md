# bookdelver-server

Run your own server for Bookdelver tables. You host it for your own group:
it is not ours and not a service of Sidequestered.

Your group joins it from the app, and each player plays the fight on their
own phone. The server only puts everyone's choices in order and passes them
on. It never runs a fight itself, so a $5 VPS, a home PC or a Raspberry Pi
is plenty.

- **Tables only, for now.** Players open tables and others join them. A
  library of scenarios and the host's tools in the app come later.
- **Sealed, like homebrew.** Nothing played on a server reaches anyone's
  library, Records or rankings.
- **Plain files.** Everything lives in one folder (`--data`). A backup is a
  copy of that folder.
- **One dependency:** `ws`, the standard WebSocket library for Node. The
  server needs Node 24 or newer.

The protocol is published in `docs/server-protocol.md`, so anyone may write
another server from it.

## Installing and running it

Any one of these three ways works.

**With Node 24 or newer**, straight from npm:

```
npx bookdelver-server --data ./bookdelver-data --url wss://tables.example.net
```

**With Docker**, using the published image:

```
docker run -d --name bookdelver -p 8787:8787 -v bookdelver-data:/data \
  -e BOOKDELVER_URL=wss://tables.example.net ghcr.io/cwpetrich/bookdelver-server
```

**With Docker Compose**, using this repository's `compose.yaml`, Caddy in
front for HTTPS (see "A VPS: Caddy" below):

```
docker compose up -d
```

**From source**, in a checkout of this repository: run `npm ci`, then
`node src/main.ts --data ./bookdelver-data`.

On its first start the server prints an **owner invite**, a code that
begins `bdinv1.`. In the app, go to **Homebrew > Servers > Paste invite**
and paste it. Whoever uses it first owns the server. Every start prints it
again until it has been used.

To invite the others, either:

- share invites from the app (coming in a later version), or
- make one on the server's machine:

```
npx bookdelver-server invite --data ./bookdelver-data --url wss://tables.example.net --uses 5 --hours 168
```

In Docker, use `docker exec bookdelver node dist/bookdelver-server.mjs invite --data /data --url wss://… --uses 5`.

| Setting              | Environment variable | Default                                       |
| -------------------- | -------------------- | --------------------------------------------- |
| `--url`              | `BOOKDELVER_URL`     | `ws://localhost:<port>`: this machine only    |
| `--port`             | `BOOKDELVER_PORT`    | 8787                                          |
| `--host`             | `BOOKDELVER_HOST`    | every interface                               |
| `--data`             | `BOOKDELVER_DATA`    | `./bookdelver-data`                           |
| `--name`, `--notice` | `BOOKDELVER_NAME`, … | "Bookdelver server", none (first start only)  |
| `--join`             | `BOOKDELVER_JOIN`    | `invite` (or `open`: anyone with the address) |
| `--cert`, `--key`    | `BOOKDELVER_CERT`, … | none: HTTPS is usually Caddy's or a tunnel's  |

The data folder holds two kinds of file:

- `server.json`: the settings, the members and the invites. A member's secret
  is kept only as its SHA-256.
- `rooms/<code>.jsonl`: each open table's log. A table is deleted after 24
  hours with nothing happening.

### Trying it on one machine

```
npx bookdelver-server --data /tmp/bd --port 8787 --host 127.0.0.1
```

The owner invite then points at `ws://localhost:8787`. The app accepts that
address only on the same machine (the dev server in a browser). Every other
address must be `wss://`.

## HTTPS: the app connects only to `wss://`

Phones refuse plain `ws://` from the app, so your server needs an HTTPS
name. Here are three ways, best first. None of them opens a port at home.

### A VPS: Caddy

Caddy gets and renews a Let's Encrypt certificate by itself.

1. Point a domain or a free dynamic-DNS name at the VPS.
2. Edit `Caddyfile` and `compose.yaml` in this folder: put your name in
   both, and in `BOOKDELVER_URL` as `wss://your.name`.
3. Run `docker compose up -d` from this folder.

Without Docker, run the server with `--host 127.0.0.1` and point Caddy at
it:

```
tables.example.net {
	reverse_proxy 127.0.0.1:8787
}
```

### A home PC or Pi: a tunnel

- **Cloudflare Tunnel** (`cloudflared`, free) puts a public name on your own
  domain. Make a tunnel in Cloudflare's dashboard and route its name to
  `http://localhost:8787` (or to `http://bookdelver:8787` from
  `compose.yaml`'s commented `cloudflared` service). Start the server with
  `--url wss://<that name>`.
- **Tailscale Funnel** (free personal plan) gives you
  `https://<machine>.<tailnet>.ts.net`, with no domain needed. Run
  `tailscale funnel 8787` on the machine, then start the server with
  `--url wss://<machine>.<tailnet>.ts.net`. `compose.yaml` has a commented
  service for it too.

### A one-click host

Hosts like Fly.io, Render and Railway give you a name with HTTPS
(`<app>.fly.dev`). Templates for them come later.

**Not recommended:**

- Opening ports on a home router. It exposes your home's address, and many
  home connections can't be reached that way at all.
- Cloudflare's quick tunnels (`trycloudflare.com`). Their name changes on
  every restart, which breaks every invite.

## What the server holds, and what you're responsible for

- **Each member's details:** a name they chose, a role, when they joined,
  and the SHA-256 of a secret their phone made for this server alone. No
  email, no account, nothing about the device.
- **Each open table:** the scenario's code, the heroes' copies and every
  move. As the operator, you can read all of it, including a scenario's
  hidden monsters.
- **Forgetting:** a member who uses **Forget this server** and asks the
  server to forget them is deleted from `server.json`.
- **Your server, your responsibility:** you answer for what's on it and for
  the law where you are.

The program comes with no warranty (see `LICENSE`).

## Limits

| Limit                          | Value                                  |
| ------------------------------ | -------------------------------------- |
| A message                      | 1,000,000 characters                   |
| Messages from one connection   | 100 a second (more closes it)          |
| Moves from one connection      | 20 a second (more are refused, `slow`) |
| A table's log                  | 5,000 entries                          |
| Tables at once; members        | 200; 1,000                             |
| A table with nothing happening | closed after 24 hours                  |

## Releases

- **npm:** `bookdelver-server`.
- **The image:** `ghcr.io/cwpetrich/bookdelver-server`. It is built for amd64
  and arm64 on each version tag by `.github/workflows/image.yml`.
- **The tests:** `npm ci && npm test` runs the conformance suite against a
  server started on a free port of this machine.

## Licence

MIT (`LICENSE`), copyright Sidequestered. The five files in `src/shared/`
are shared with the Bookdelver app under the same licence: the relay, the
protocol's envelope and session layer, and their reader and codec.
