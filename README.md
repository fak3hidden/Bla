# Bla

A self-hosted chat platform in the spirit of Discord — but **everything is free and
nothing is bolted to somebody else's cloud**.

- **Free accounts, no email.** Pick a username and a password. That is the whole signup.
- **Servers are free and unlimited.** Every account can create as many as it likes.
- **Every boost perk is on for everybody.** Animated icons, server banners, vanity
  URLs, invite splashes, the soundboard, 100 MB uploads, 384 kbps voice — no Nitro,
  no boosts, no payment code anywhere in the repo.
- **One process, no build step.** Node's built-in SQLite for storage, Express for the
  HTTP API, `ws` for the realtime gateway, and a plain static frontend served from
  `public/`.

```
┌──────────────┐   HTTP + WebSocket    ┌───────────────────────────────┐
│  browser     │◄─────────────────────►│  server/index.js              │
│  public/     │                       │   ├─ REST  /api/*   (express) │
│  (no build)  │                       │   ├─ WS    /gateway (ws)      │
└──────────────┘                       │   └─ SQLite data/bla.db       │
                                       └───────────────────────────────┘
```

---

## Quick start

Requires **Node.js 22.5 or newer** (for `node:sqlite`).

```bash
git clone <your-fork> bla && cd bla
npm install
npm start
```

Open <http://localhost:3000>. The first account you create automatically becomes the
**instance admin**, so do that before you expose the server to anyone else. Being
admin is not a paywall: it only unlocks the moderation panel for that one account.

```bash
npm run dev        # same thing, restarts on file changes
npm test           # boots a throwaway instance and runs ~80 end-to-end checks
npm run test:ui    # same idea, but renders the real client in jsdom (needs dev deps)
npm run reset-db   # wipe accounts/servers/messages and start over
npm run build      # pack everything into one standalone executable (see below)
```

## Building a standalone executable

`npm run build` packages Bla itself — server, dependencies and the whole web client —
into **one self-contained binary**. Someone on the receiving end needs no Node.js, no
npm and no `git clone`: they download a file, run it, and open their browser.

```bash
npm install          # once, for the build tools (esbuild + postject)
npm run build        # -> dist/bla   (dist\bla.exe on Windows)
```

```bash
./dist/bla                     # starts the server; data/ is created next to it
BLA_PORT=8080 ./dist/bla       # everything npm start understands works here too
```

On first run the executable prints its URL, creates `data/` beside itself and asks you
to claim the admin account — exactly like `npm start`. Copy that one file to any other
machine with the same OS/CPU and it runs there too: no `node_modules`, no source tree.

Useful flags:

```bash
npm run build -- --outfile /usr/local/bin/bla   # install it somewhere on PATH
npm run build -- --target win-x64               # dist/bla.exe for Windows x64
npm run build -- --no-assets                    # don't embed the web client
npm run build -- --keep                         # keep intermediate build files
npm run build -- --help                         # all options
```

How it works, in case you want to hack on it (`scripts/build.js`):

1. **esbuild** bundles `server/` + `src/` + the dependencies into a single CommonJS file.
2. `node --experimental-sea-config` packs that bundle and every file under `public/`
   into one blob (Node's official *single executable application* format).
3. **postject** copies the Node runtime you already have and injects the blob into it,
   producing `dist/bla`.

The resulting binary embeds the web client as read-only assets and unpacks them to a
cache directory on first boot, so the app still serves `index.html`, the CSS, the JS and
the logo with no files next to it. `BLA_DATA_DIR`, `BLA_PORT` and the rest of the
environment variables work identically.

> **Cross-compiling:** the JS is portable, but the executable is a copy of the *host*
> runtime, so a Linux build produces a Linux binary. Building on Windows gives you
> `bla.exe`, building in a Linux container gives you a Linux binary. `--target` tells the
> builder which suffix to use; build on the platform you are targeting for the real thing.

---

### Docker

```bash
docker compose up -d          # then visit http://localhost:3000
```

The compose file stores everything in a named volume (`bla-data`). Override the port
with `BLA_PORT=8080 docker compose up -d`. If you prefer plain Docker:

```bash
docker build -t bla .
docker run -d -p 3000:3000 -v bla-data:/data --name bla bla
```

---

## Voice and video

Voice is a **direct browser-to-browser WebRTC mesh**; the server only relays the
signalling (SDP/ICE) messages over the gateway. Audio and video never pass through the
host, so a small VPS can carry a room full of people without touching the CPU.

- Microphone, camera and screen share all work out of the box.
- STUN defaults to `stun:stun.l.google.com:19302`. For friends behind strict NATs run
  your own TURN server (for example [coturn](https://github.com/coturn/coturn)) and
  point Bla at it — one env variable:

  ```bash
  BLA_STUN_URLS="stun:turn.example.com:3478,turn:turn.example.com:3478?transport=udp"
  ```

- Voice, video and screen share are covered by the same "free forever" rule; there is
  no subscriber-only bitrate.

---

## Configuration

Everything is environment variables — no config file to keep in sync.

| Variable | Default | What it does |
| --- | --- | --- |
| `BLA_PORT` | `3000` | HTTP/WebSocket port |
| `BLA_HOST` | `0.0.0.0` | Interface to bind (use `127.0.0.1` behind a reverse proxy) |
| `BLA_DATA_DIR` | `./data` | Where the database, uploads and media live |
| `BLA_DB` | `$BLA_DATA_DIR/bla.db` | SQLite file path |
| `BLA_PUBLIC_URL` | *(inferred)* | Absolute origin for invite links and webhooks |
| `BLA_SERVER_NAME` | `Bla` | Name shown on the login screen |
| `BLA_REGISTRATION_OPEN` | `true` | Set `false` to close public signups |
| `BLA_INVITE_ONLY` | `false` | Require an invite code to register |
| `BLA_ADMINS` | *(empty)* | Comma-separated usernames that should be instance admins |
| `BLA_MAX_UPLOAD_MB` | `100` | Upload ceiling (Discord charges for this) |
| `BLA_VOICE_BITRATE` | `384000` | Advertised voice bitrate |
| `BLA_MAX_GUILDS_PER_USER` | `200` | Servers one account may own |
| `BLA_MAX_EMOJI` / `BLA_MAX_STICKERS` | `500` / `120` | Per-server expression slots |
| `BLA_STUN_URLS` | Google STUN | Comma-separated ICE servers |
| `BLA_TRUST_PROXY` | `false` | Trust `X-Forwarded-*` (set true behind nginx/Caddy) |

---

## What's inside

**Chat.** Markdown (`**bold**`, `*italic*`, `__underline__`, `~~strike~~`, `||spoilers||`,
`code`, fenced blocks), `@mentions`, `#channel` links, custom emoji (`:name:`), replies,
edits, pins, reactions, threads-lite via replies, message search per server, file
uploads with type sniffing, image/video previews, a character counter, slowmode,
typing indicators and read state (unread badges plus mention counts).

**Servers.** Roles with granular permissions and drag-free position ordering, channel
categories, per-channel permission overwrites for roles *and* individual members,
channel reordering, invites (temporary, limited uses, expiry), vanity URLs, server
banners and animated icons, custom emoji, stickers, soundboard, webhooks, audit log,
bans, timeouts, kicks, and a moderation panel with move/kick/ban from the member list.

**Extras.** Direct messages and group DMs (with audio calls), polls, friendships
(requests, blocking), a friends view with presence, presence states (online, idle, dnd,
invisible, custom status), per-instance discovery page, an admin panel for instance
settings/users/servers/invite codes/maintenance, desktop notifications, keyboard
shortcuts (`Ctrl/Cmd+K` quick switcher, `Escape` closes modals), and a dark UI that
scales down to a phone.

**Storage.** One SQLite file (`data/bla.db`) created on first run, ~30 tables, WAL
friendly. Backups are `cp data/bla.db backup-$(date +%F).db` — or stop the server and
copy the whole `data/` directory to keep uploads too.

---

## Permissions

Bla implements the familiar Discord-shaped permission set: `VIEW_CHANNEL`,
`SEND_MESSAGES`, `MANAGE_CHANNELS`, `MANAGE_ROLES`, `KICK_MEMBERS`, `BAN_MEMBERS`,
`MODERATE_MEMBERS`, `MUTE_MEMBERS`, `DEAFEN_MEMBERS`, `MOVE_MEMBERS`, `MANAGE_WEBHOOKS`,
`MANAGE_EXPRESSIONS`, `VIEW_AUDIT_LOG`, `CREATE_INSTANT_INVITE`, `ADMINISTRATOR` and
friends, stored as bitfields.

Resolution order per channel is the usual one: the `@everyone` role, then the union of
the member's roles, then any member-specific overwrite — with `ADMINISTRATOR` short
circuiting everything and the server owner always allowed.

---

## Running it for real

1. **Put it behind TLS.** Any reverse proxy works; make sure WebSocket upgrades are
   forwarded. Caddy is two lines:

   ```caddy
   chat.example.com {
     reverse_proxy 127.0.0.1:3000
   }
   ```

   With nginx, remember `proxy_set_header Upgrade $http_upgrade;` and
   `proxy_set_header Connection "upgrade";` for `/gateway`.

2. **Bind locally** — `BLA_HOST=127.0.0.1` — so only the proxy can reach Node.
3. **Close signups** once your people are in: `BLA_REGISTRATION_OPEN=false`, then hand
   out invite codes from *Instance settings → Invite codes*.
4. **Back up `data/`.** That directory is the entire instance.
5. **Update** with `git pull && npm install && npm start` (restart the process; there is
   no migration step — the schema is created or upgraded on boot).

---

## Project layout

```
server/index.js        process entry: HTTP server + gateway + shutdown
src/
  app.js               express app, middleware order, routes, SPA fallback
  gateway.js           WebSocket gateway: sessions, presence, voice signalling
  routes/              REST endpoints (auth, guilds, channels, messages, dms, ...)
  db.js                schema + tiny query helpers (node:sqlite)
  permissions.js       permission bits and channel-overwrite maths
  perms.js             per-server member/role/channel resolution
  auth.js              password hashing, sessions, cookies
public/
  index.html           the whole client (no bundler)
  css/app.css          design system
  js/                  util, state, api, gateway, render, markdown, modals, voice,
                       chat, settings, app  — loaded in that order
test/smoke.js          end-to-end test: boots a throwaway server, then hits it
test/ui.js             renders the client against a throwaway server (jsdom)
scripts/reset-db.js    wipe the instance
scripts/build.js       builder: bundles the app into one standalone executable
src/sea.js             single-executable helpers (embedded web assets)
```

The frontend intentionally has **no build step**: reload the page and you are running
your edits. Everything it needs is served from this repository, so it works offline and
on an air-gapped LAN.

---

## FAQ

**Can I hand someone a single file instead of a repo?**
Yes — `npm run build` produces `dist/bla` (`bla.exe` on Windows), a standalone binary
with the server, the dependencies and the web UI inside. See
[Building a standalone executable](#building-a-standalone-executable).

**Do I need an email server, SMTP, or any third-party service?** No. Accounts are
username + password only; password resets are an admin action, not an email flow.

**Why is everything free?** Because there is no business model here to protect. The
boost features exist in Discord to sell subscriptions; in Bla they are simply defaults.

**Can I use this with a hundred friends?** The Node process handles thousands of
concurrent sockets comfortably; voice is peer-to-peer so the host only relays small
signalling frames. The limits you will hit first are disk (uploads) and your TURN
server.

**Is there a federation / bridge to Discord?** No, and there is no plan for one. Bla is
a single instance you own.

## License

MIT — see [LICENSE](LICENSE).
