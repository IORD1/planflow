# Planflow

A todo board where tasks can block other tasks. Tasks are boxes on a canvas; drag a
box's blue handle onto another box to say "that one waits for this one". A task lights
up **Ready** when everything it waits for is done, and the side panel always lists what
you can start right now.

Zero dependencies: Node's built-in HTTP server and `node:sqlite`. Vanilla JS frontend.

- **[HOW-IT-WORKS.md](HOW-IT-WORKS.md)**: using the board, the ready/blocked/done rules, and what the code does.
- **[DEVELOPMENT.md](DEVELOPMENT.md)**: running locally, making changes, deploying to thundertrident, backups.

## Run

```sh
node server.js                 # http://localhost:8090, data in ./data/planflow.db
PORT=9000 DB_PATH=/tmp/x.db node server.js
```

Needs Node 22.13+ (for `node:sqlite`).

## Deploy (Docker)

```sh
docker compose up -d --build   # serves on :8090, database in ./data/
```

Backup = copy `data/planflow.db` (stop the container first, or use `sqlite3 data/planflow.db ".backup out.db"`).

## Using it

| Action | How |
| --- | --- |
| Add a task | `+ Task`, press `N`, or double-click empty canvas |
| Move a task | drag it |
| Make B wait for A | drag A's blue ● handle onto B |
| Remove a link | click the link, then `Unlink` (or `Del`) |
| Complete a task | click its circle (only when nothing it waits for is unfinished) |
| Edit title / notes | click the task, edit in the side panel |
| Tidy the layout | `Arrange` / `A` — columns by dependency depth |
| Zoom / pan | scroll wheel or pinch / drag empty space, `F` fits everything |

Links can never form a loop; the server rejects it and the UI warns before trying.

## API

All JSON. `from` blocks `to` in every link.

```
GET    /api/boards                       list boards with done/total counts
POST   /api/boards          {name}
PATCH  /api/boards/:id      {name}
DELETE /api/boards/:id
GET    /api/boards/:id                   {board, tasks, deps}
POST   /api/boards/:id/tasks {title, notes?, x?, y?}
POST   /api/boards/:id/positions {positions:[{id,x,y}]}
POST   /api/boards/:id/deps  {from, to}  409 on cycle
PATCH  /api/tasks/:id       {title?, notes?, status?, x?, y?, force?}
                                          status:'done' is 409 while blocked unless force:true
DELETE /api/tasks/:id
DELETE /api/deps/:from/:to
```
