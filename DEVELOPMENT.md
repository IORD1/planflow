# Editing and deploying Planflow

## Where things are

| Place | What |
| --- | --- |
| `~/Project/planflow` on the laptop | the source. Edit here |
| `~/planflow` on thundertrident | the deployed copy, a git clone that auto-updates from GitHub |
| `~/planflow/data/planflow.db` on thundertrident | the live database (plus `-wal` and `-shm` files) |
| http://thundertrident:8090 | the running app, reachable on the Tailscale network |
| https://github.com/IORD1/planflow | the repo. Pushing to `main` deploys |

Project layout:

```
server.js            HTTP server, API, SQLite schema and seed
public/index.html    page skeleton, top bar, SVG arrow markers
public/app.js        all frontend logic
public/style.css     all styling (colour tokens at the top in :root)
Dockerfile           node:24-alpine, copies server.js + public/
docker-compose.yml   one service, port 8090, ./data mounted at /data
deploy/              auto-deploy script, systemd units and config used on the server
data/                local database when running outside Docker (git-ignored)
```

## Running locally

Needs Node 22.13 or newer (for the built-in `node:sqlite`). Nothing to install.

```sh
cd ~/Project/planflow
node --no-warnings server.js
# → http://localhost:8090, database in ./data/planflow.db
```

To try changes against a throwaway database or another port:

```sh
PORT=8091 DB_PATH=/tmp/planflow-test.db node --no-warnings server.js
```

`--no-warnings` only hides Node's "SQLite is experimental" notice.

## Making changes

**Frontend only** (most changes): edit files in `public/`, reload the browser.
There is no build step and no cache, the server sends files fresh each time.

- Colours, sizes, and the mobile breakpoint (760 px) live in `public/style.css`.
  The box width is `--node-w` there and `NODE_W` at the top of `app.js`; keep them equal.
- Keyboard shortcuts are in the `keydown` handler near the end of `app.js`.
- The side panel is built entirely in `renderPanel()`. The overview and the task
  editor are the two branches of that function.
- How a box looks is `makeNode()` and `updateNode()`.

**Server or schema changes**: edit `server.js`.

- New routes: add a `route('METHOD', '/api/path/:id', handler)` line. Numeric path
  parts become `params`, the parsed JSON body is `body`. Return a value for a 200, or
  `[status, value]` for something else. Throw `new HttpError(409, 'why')` for errors.
- New columns: add them to the `CREATE TABLE` in the schema block **and** add an
  `ALTER TABLE ... ADD COLUMN` guarded by a try/catch for existing databases, because
  `CREATE TABLE IF NOT EXISTS` does nothing on a table that already exists. Then extend
  the prepared statements in `q`, the `taskOut()` shape, and the frontend.

Before deploying, at least syntax-check both files:

```sh
node --check server.js && node --check public/app.js
```

Quick API smoke test against a local instance:

```sh
B=http://localhost:8091
curl -s $B/api/health
curl -s $B/api/boards
curl -s -X POST $B/api/boards/1/tasks -H 'Content-Type: application/json' -d '{"title":"Try it","x":100,"y":100}'
```

## Deploying to thundertrident

### Auto-deploy in plain words

Nothing runs on the laptop. The laptop only pushes commits to GitHub.

The checking job lives **on the server** (thundertrident). It is a systemd *timer*,
which is the modern Ubuntu equivalent of a cron job. Every minute it wakes up, and for
every app listed in `/etc/autodeploy.conf` it asks GitHub: "does `main` have a commit I
don't have yet?"

```
 laptop                    GitHub                     thundertrident (server)
 ------                    ------                     -----------------------
 git push  ───────────►  IORD1/planflow             every 60 s, autodeploy.timer fires:
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
2. Within at most 60 seconds the timer on the server fires and notices the new commit.
3. The server resets its checkout to that commit and rebuilds the image (about 5 to 10
   seconds for this app). If the image actually changed, Compose replaces the running
   container. If only docs changed, the image is identical and the container is left alone.
4. The app on http://thundertrident:8090 is the new version.

To watch it happen: `ssh iord@thundertrident 'journalctl -u autodeploy -f'` in one
terminal, then push from another.

**Deploys are automatic.** Push to `main` and thundertrident rebuilds within a minute:

```sh
git push
```

That is the whole deploy. What happens on the server:

1. A systemd timer (`autodeploy.timer`) runs `/usr/local/bin/autodeploy` every minute.
2. The script reads `/etc/autodeploy.conf`, one app per line. For each, it runs
   `git fetch` in that directory using a read-only deploy key.
3. If `origin/main` has moved, it does `git reset --hard origin/main` and
   `docker compose up -d --build --remove-orphans`, then prunes old images.
4. Nothing happens when there is no new commit, so the timer is cheap.

The server checkout is `~/planflow` on thundertrident, a normal git clone whose remote
uses the SSH alias `github.com-planflow` (see `~/.ssh/config` there). The database in
`~/planflow/data/` is git-ignored, so a reset never touches it.

The script and unit files are kept in this repo under `deploy/` so the setup can be
rebuilt or copied to another machine.

### Checking a deploy

```sh
ssh iord@thundertrident 'journalctl -u autodeploy -n 20 --no-pager'   # what it did and when
ssh iord@thundertrident 'cd ~/planflow && git log -1 --oneline'        # commit running on the server
ssh iord@thundertrident 'systemctl list-timers autodeploy.timer'       # next check time
curl http://thundertrident:8090/api/health                             # {"ok":true}
```

A failed build logs `DEPLOY FAILED`; the previous container keeps running in that case.
Fix the problem, push again, and the next tick retries.

### Adding another app to auto-deploy

1. Clone it on the server, e.g. `git clone git@github.com-<app>:IORD1/<app>.git ~/<app>`,
   with its own deploy key and `~/.ssh/config` alias (GitHub allows a deploy key on one
   repo only). Generate the key with `ssh-keygen -t ed25519 -f ~/.ssh/<app>_deploy -N ''`
   and add it with `gh repo deploy-key add ~/.ssh/<app>_deploy.pub --repo IORD1/<app>`
   from the laptop.
2. Make sure the repo has a `docker-compose.yml` at its root.
3. Add a line to `/etc/autodeploy.conf`: `/home/iord/<app> main`.

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
docker compose down               # stop and remove the container, keeps data/
docker compose up -d              # start again without rebuilding
sudo systemctl stop autodeploy.timer    # pause auto-deploys; start to resume
```

### Changing the port

Edit the `ports:` line in `docker-compose.yml` to `"NEWPORT:8090"` and run
`docker compose up -d`. The left side is the host port; the app inside always
listens on 8090. Ports already taken on thundertrident: 80 (Apache), 2283 (Immich),
19999 (Netdata), 8090 (this app).

### Backups

The whole state is one SQLite file. Safest copy while the app is running:

```sh
ssh iord@thundertrident 'cd ~/planflow && docker compose exec planflow node -e "
  const {DatabaseSync}=require(\"node:sqlite\");
  new DatabaseSync(\"/data/planflow.db\").exec(\"VACUUM INTO \x27/data/backup.db\x27\")"'
scp iord@thundertrident:planflow/data/backup.db ~/planflow-backup-$(date +%F).db
```

Or stop the container and copy `data/planflow.db` directly. To restore, stop the
container, replace `data/planflow.db`, delete `data/planflow.db-wal` and
`data/planflow.db-shm` if present, and start again.

## Troubleshooting

- **Container keeps restarting**: `docker compose logs planflow`. A syntax error in
  `server.js` shows up here. Run `node --check server.js` locally.
- **"permission denied" on the database**: the container runs as uid 1000 (`user:` in
  the compose file), which is `iord` on the server. `data/` must be writable by that
  user: `chown -R 1000:1000 ~/planflow/data`.
- **Port already in use**: something else took 8090. `ss -tlnp | grep 8090` on the
  server, then change the port as above.
- **Old page after deploy**: a hard refresh (Ctrl+Shift+R). Files are sent with
  `no-cache`, but a browser can still hold onto an open tab's script.
- **The app is blank / "Could not load"**: the API is failing. Open
  http://thundertrident:8090/api/boards in the browser; the error message says why.
