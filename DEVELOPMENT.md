# Editing and deploying Planflow

## Where things are

| Place | What |
| --- | --- |
| `~/Project/planflow` on the laptop | the source. Edit here |
| `~/planflow` on thundertrident | the deployed copy, a git clone that auto-updates from GitHub |
| `planflow` database in the shared Postgres on thundertrident | the live data. Server: `~/homelab/postgres`, data on the SSD, dumps on the HDD |
| `~/planflow/.env` on thundertrident | `DATABASE_URL` for that database (git-ignored) |
| http://thundertrident:8090 | the running app, reachable on the Tailscale network |
| https://github.com/IORD1/planflow | the repo. Pushing to `main` deploys within 10 minutes |

Project layout:

```
server.js            HTTP server, API, queries and seed
db.js                Postgres connection pool, schema (CREATE TABLE IF NOT EXISTS), helpers
scripts/             api-test.mjs + ui-test.mjs (run against a local server), migrate-sqlite.js (one-off import)
public/index.html    page skeleton, top bar, SVG arrow markers
public/app.js        all frontend logic
public/style.css     all styling (colour tokens at the top in :root)
Dockerfile           node:24-alpine, npm ci, copies server.js + db.js + public/
docker-compose.yml   one service, port 8090, joins the external `homelab` network
deploy/              auto-deploy script, systemd units and config used on the server
```

## Running locally

Needs Node 22 or newer and a Postgres database to point at. The easiest is a throwaway
database on the shared server, created over Tailscale:

```sh
ssh iord@thundertrident '~/homelab/postgres/new-db.sh planflow_dev'   # prints a DATABASE_URL
cd ~/Project/planflow
npm install
DATABASE_URL='postgres://planflow_dev:...@thundertrident:5432/planflow_dev' node server.js
# → http://localhost:8090, tables are created on first start, an example board is seeded
```

Use `PORT=8095` to pick another port. Drop the throwaway database when done:
`ssh iord@thundertrident 'docker exec postgres psql -U postgres -c "DROP DATABASE planflow_dev" -c "DROP ROLE planflow_dev"'`.

Never point a local run at the live `planflow` database unless you mean to edit real data.

## Making changes

**Frontend only** (most changes): edit files in `public/`, reload the browser.
There is no build step and no cache, the server sends files fresh each time.

- Colours, sizes, and the mobile breakpoint (760 px) live in `public/style.css`.
  The box width is `--node-w` there and `NODE_W` at the top of `app.js`; keep them equal.
- Keyboard shortcuts are in the `keydown` handler near the end of `app.js`.
- The side panel is built entirely in `renderPanel()`. The overview and the task
  editor are the two branches of that function.
- How a box looks is `makeNode()` and `updateNode()`.

**Server or schema changes**: edit `server.js` (routes and queries) or `db.js` (schema).

- New routes: add a `route('METHOD', '/api/path/:id', handler)` line. Numeric path
  parts become `params`, the parsed JSON body is `body`. Return a value for a 200, or
  `[status, value]` for something else. Throw `new HttpError(409, 'why')` for errors.
- New columns: add them to the `CREATE TABLE` in `db.js` **and** add an
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` line after it for databases that
  already exist, because `CREATE TABLE IF NOT EXISTS` does nothing on an existing table.
  Then extend the queries in `q`, the `taskOut()` shape, and the frontend.
- Queries use `$1, $2, ...` placeholders. `COUNT(*)` comes back as a string from
  Postgres, so cast it (`COUNT(*)::int`) when the frontend expects a number.
  Timestamps come back as `Date` objects and serialise to ISO strings, which is what
  the frontend sorts and formats.

Before deploying, at least syntax-check both files:

```sh
node --check server.js && node --check public/app.js
```

Quick API smoke test against a local instance:

```sh
B=http://localhost:8090
curl -s $B/api/health
curl -s $B/api/boards
curl -s -X POST $B/api/boards/1/tasks -H 'Content-Type: application/json' -d '{"title":"Try it","x":100,"y":100}'
```

There are two proper test scripts in `scripts/`. Both create a board, exercise it, and
delete it again, so run them **only against a local server on a throwaway database**
(see "Running it locally" below), never against the live app:

```sh
PLANFLOW_URL=http://localhost:8093 node scripts/api-test.mjs   # link endpoints, sides, cycles
PLANFLOW_URL=http://localhost:8093 node scripts/ui-test.mjs    # drives headless Chrome through the real UI
```

`ui-test.mjs` needs Google Chrome at `/usr/bin/google-chrome` (or set `CHROME=`). It drags
links between cards with synthetic mouse events, checks what the server stored and what
the SVG drew, and leaves a screenshot `sides.png` in `$SCRATCH` (default: the temp dir).

## Deploying to thundertrident

### Auto-deploy in plain words

Nothing runs on the laptop. The laptop only pushes commits to GitHub.

The checking job lives **on the server** (thundertrident). It is a systemd *timer*,
which is the modern Ubuntu equivalent of a cron job. Every 10 minutes it wakes up, and for
every app listed in `/etc/autodeploy.conf` it asks GitHub: "does `main` have a commit I
don't have yet?"

```
 laptop                    GitHub                     thundertrident (server)
 ------                    ------                     -----------------------
 git push  ───────────►  IORD1/planflow             every 10 min, autodeploy.timer fires:
                          main: 0d268c2   ◄───────   git fetch  ("any new commit on main?")
                                                        │
                                              no ◄──────┴──────► yes
                                              exit                git reset --hard origin/main
                                              (nothing            docker compose up -d --build
                                               happens)           container now runs the new commit
```

So the answer to "which machine checks?" is: the server checks, by pulling. GitHub never
contacts the server, which is why this works even though thundertrident has no public
address and is only reachable over Tailscale.

The timeline after a push is therefore:

1. `git push` finishes on the laptop. GitHub has the commit.
2. Within at most 10 minutes the timer on the server fires and notices the new commit.
   In a hurry? `ssh iord@thundertrident 'sudo systemctl start autodeploy.service'` runs
   the check right now.
3. The server resets its checkout to that commit and rebuilds the image (about 5 to 10
   seconds for this app). If the image actually changed, Compose replaces the running
   container. If only docs changed, the image is identical and the container is left alone.
4. The app on http://thundertrident:8090 is the new version.

To watch it happen: `ssh iord@thundertrident 'journalctl -u autodeploy -f'` in one
terminal, then push from another.

**Deploys are automatic.** Push to `main` and thundertrident rebuilds within ten minutes:

```sh
git push
```

That is the whole deploy. What happens on the server:

1. A systemd timer (`autodeploy.timer`) runs `/usr/local/bin/autodeploy` every 10 minutes.
2. The script reads `/etc/autodeploy.conf`, one app per line. For each, it runs
   `git fetch` in that directory using a read-only deploy key.
3. If `origin/main` moved since that directory was last deployed, it does
   `git reset --hard origin/main` and, when files under that directory changed,
   `docker compose up -d --build --remove-orphans`, then prunes old images.
4. Nothing happens when there is no new commit, so the timer is cheap.

The last deployed commit is remembered per directory in `~/.local/state/autodeploy/`
on the server. That is what lets several stacks share one repo (the IORD1/homelab repo
holds `postgres`, `redis`, `sure` and `securo`): a push touching only one folder deploys
only that folder. A directory with no stamp yet is deployed once regardless.

The server checkout is `~/planflow` on thundertrident, a normal git clone whose remote
uses the SSH alias `github.com-planflow` (see `~/.ssh/config` there). The `.env` file
holding `DATABASE_URL` is git-ignored, so a reset never touches it, and the data itself
lives in the Postgres container, not in this directory.

The script and unit files are kept in this repo under `deploy/` so the setup can be
rebuilt or copied to another machine.

### Checking a deploy

```sh
ssh iord@thundertrident 'journalctl -u autodeploy -n 20 --no-pager'   # what it did and when
ssh iord@thundertrident 'cd ~/planflow && git log -1 --oneline'        # commit running on the server
ssh iord@thundertrident 'systemctl list-timers autodeploy.timer'       # next check time
curl http://thundertrident:8090/api/health                             # {"ok":true}
```

A failed build logs `DEPLOY FAILED`; the previous container keeps running in that case,
and the deploy is retried on every run (every 10 minutes) until it succeeds.
Fix the problem, push again, and the next tick retries. The interval lives in
`deploy/autodeploy.timer` (`OnUnitActiveSec`); after changing it, reinstall the file to
`/etc/systemd/system/` and run `sudo systemctl daemon-reload`.

### Adding another app to auto-deploy

1. Clone it on the server, e.g. `git clone git@github.com-<app>:IORD1/<app>.git ~/<app>`,
   with its own deploy key and `~/.ssh/config` alias (GitHub allows a deploy key on one
   repo only). Generate the key with `ssh-keygen -t ed25519 -f ~/.ssh/<app>_deploy -N ''`
   and add it with `gh repo deploy-key add ~/.ssh/<app>_deploy.pub --repo IORD1/<app>`
   from the laptop.
2. Make sure the repo has a `docker-compose.yml` at its root.
3. If it needs a database: `~/homelab/postgres/new-db.sh <app>` on the server, put the
   printed `DATABASE_URL` in `~/<app>/.env`, and join the `homelab` network in its compose
   file (see the `homelab` repo README).
4. Add a line to `/etc/autodeploy.conf`: `/home/iord/<app> main`.

### Manual deploy (fallback)

If the timer is stopped or you want to deploy a branch by hand:

```sh
ssh iord@thundertrident 'cd ~/planflow && git fetch && git reset --hard origin/main && docker compose up -d --build'
```

Or run the script once: `ssh iord@thundertrident 'sudo systemctl start autodeploy.service'`.

Useful commands on the server (all from `~/planflow`):

```sh
docker compose ps                 # status and health
docker compose logs -f            # follow logs
docker compose restart
docker compose down               # stop and remove the container; the data stays in Postgres
docker compose up -d              # start again without rebuilding
sudo systemctl stop autodeploy.timer    # pause auto-deploys; start to resume
```

### Changing the port

Edit the `ports:` line in `docker-compose.yml` to `"NEWPORT:8090"` and run
`docker compose up -d`. The left side is the host port; the app inside always
listens on 8090. Ports already taken on thundertrident: 80 (Apache), 2283 (Immich),
19999 (Netdata), 5432 (Postgres), 8090 (this app), 8091 (Adminer, the database web UI).

### Backups

The shared Postgres dumps every database to the HDD four times a day
(`/mnt/immich-storage/postgres-backups/<date_time>/planflow.dump`, kept 30 days).
Nothing to do here. To take one right now, or to restore:

```sh
ssh iord@thundertrident '~/homelab/postgres/backup.sh'
ssh iord@thundertrident 'docker exec -i postgres pg_restore -U postgres -d planflow --clean --if-exists \
  < /mnt/immich-storage/postgres-backups/2026-09-03_00-30/planflow.dump'
```

To look at the data directly, open Adminer through
http://thundertrident:8091/?pgsql=postgres&username=planflow (this link preselects
PostgreSQL; the plain URL defaults to MySQL and fails) and enter the password from
`~/planflow/.env`. Leave Database empty.

Before 2026-09-03 the app stored its data in a SQLite file; `scripts/migrate-sqlite.js`
is the one-off importer that moved it into Postgres.

## Troubleshooting

- **Container keeps restarting**: `docker compose logs planflow`. A syntax error in
  `server.js` shows up here. Run `node --check server.js` locally.
- **`startup failed` / `postgres not ready` in the logs**: the container cannot reach
  the database. Check `docker ps` shows `postgres` healthy, that `~/planflow/.env` has
  the right `DATABASE_URL` (host `postgres`, not `thundertrident`, from inside a
  container), and that the `homelab` network exists (`docker network ls`). The app
  retries for a minute and then exits; Docker restarts it.
- **Port already in use**: something else took 8090. `ss -tlnp | grep 8090` on the
  server, then change the port as above.
- **Old page after deploy**: a hard refresh (Ctrl+Shift+R). Files are sent with
  `no-cache`, but a browser can still hold onto an open tab's script.
- **The app is blank / "Could not load"**: the API is failing. Open
  http://thundertrident:8090/api/boards in the browser; the error message says why.
