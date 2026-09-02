# Editing and deploying Planflow

## Where things are

| Place | What |
| --- | --- |
| `~/Project/planflow` on the laptop | the source. Edit here |
| `~/planflow` on thundertrident | the deployed copy, synced from the laptop |
| `~/planflow/data/planflow.db` on thundertrident | the live database (plus `-wal` and `-shm` files) |
| http://thundertrident:8090 | the running app, reachable on the Tailscale network |

Project layout:

```
server.js            HTTP server, API, SQLite schema and seed
public/index.html    page skeleton, top bar, SVG arrow markers
public/app.js        all frontend logic
public/style.css     all styling (colour tokens at the top in :root)
Dockerfile           node:24-alpine, copies server.js + public/
docker-compose.yml   one service, port 8090, ./data mounted at /data
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

The server is reached as `iord@thundertrident` over Tailscale. Docker and Compose are
already there and `iord` can use Docker without sudo.

1. Sync the source (never sync `data/`, that is the live database):

   ```sh
   rsync -az --delete --exclude data --exclude .git ~/Project/planflow/ iord@thundertrident:planflow/
   ```

2. Rebuild and restart the container:

   ```sh
   ssh iord@thundertrident 'cd ~/planflow && docker compose up -d --build'
   ```

   The build takes a few seconds. Existing data is untouched because it lives in the
   mounted `./data` folder, not in the image.

3. Check it:

   ```sh
   curl http://thundertrident:8090/api/health        # {"ok":true}
   ssh iord@thundertrident 'docker logs --tail 20 planflow'
   ```

Frontend-only changes still need step 2, since the files are copied into the image.

Useful commands on the server (all from `~/planflow`):

```sh
docker compose ps                 # status and health
docker compose logs -f            # follow logs
docker compose restart
docker compose down               # stop and remove the container, keeps data/
docker compose up -d              # start again without rebuilding
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
