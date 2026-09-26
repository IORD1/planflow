# Planflow

A todo board where tasks can block other tasks. Tasks are boxes on a canvas; drag one
of a box's blue handles (one per side, shown when the pointer comes near the box) onto
another box to say "that one waits for this one". A task lights
up **Ready** when everything it waits for is done, and the side panel always lists what
you can start right now. Paste an image or a link and it becomes the card's cover,
Trello-style. Deleting takes two clicks and can be undone.

Node's built-in HTTP server, PostgreSQL through the `pg` driver (the only dependency), vanilla JS frontend.

- **[HOW-IT-WORKS.md](HOW-IT-WORKS.md)**: using the board, the ready/blocked/done rules, and what the code does.
- **[DEVELOPMENT.md](DEVELOPMENT.md)**: running locally, making changes, deploying to thundertrident, backups.

## Run

```sh
npm install
DATABASE_URL=postgres://planflow:secret@thundertrident:5432/planflow node server.js   # http://localhost:8090
PORT=9000 DATABASE_URL=... node server.js
```

Needs Node 22+ and a PostgreSQL database; it creates its own tables on first start.

## Deploy (Docker)

```sh
echo DATABASE_URL=postgres://planflow:secret@postgres:5432/planflow > .env
docker compose up -d --build   # serves on :8090, talks to Postgres over the `homelab` docker network
```

On thundertrident the database is the shared Postgres from the `homelab` repo, which
dumps every database to the HDD every six hours. See [DEVELOPMENT.md](DEVELOPMENT.md).

## Using it

| Action | How |
| --- | --- |
| Add a task | `+ Task`, press `N`, double-click or middle-click empty canvas, or right-click → `Add task here`. Then just type: the caret is already in the new card's title |
| Rename a task | double-click it (or select it and press `Enter`), type, `Enter`. Or edit in the side panel |
| Give a task a cover | select it and paste an image or a link (`Ctrl+V`), or drop one on its card. With nothing selected, the paste makes a new card. Links get their title and picture fetched |
| Move a task | drag it |
| Make B wait for A | move the mouse near A and drag any of its blue ● handles onto B; the arrow attaches to the side of B you drop nearest to |
| Move an arrow to another side | click the link, then pick the sides in the side panel |
| Remove a link | click or right-click the link, then `Unlink` |
| Complete a task | click its circle (only when nothing it waits for is unfinished) |
| Delete a task | `Delete` (panel or right-click) turns into **Really?**, click again. Or press `Delete` twice. `Ctrl+Z` or the toast's `Undo` brings it back, links included |
| Task menu | right-click a task: mark done, rename, add next step, open link / remove cover, delete |
| Delete a board | board menu (next to the board name), `Delete board` turns red, click again. Boards are not in the trash: this one is for good |
| Edit title / notes | click the task, edit in the side panel |
| Tidy the layout | `Arrange` / `A` — columns by dependency depth |
| Zoom / pan | scroll wheel or pinch / drag empty space, `F` fits everything (on a phone it stops at 60%, so cards stay readable) |
| On a phone | `List` in the top bar shows the board as ready / blocked / done lists; tap a task for its details (mark done, notes, links, cover), `← Back` returns. `Board` goes back to the canvas. Tapping a card on the canvas opens its details as a bottom sheet |

Links can never form a loop; the server rejects it and the UI warns before trying.

## On the phone (PWA)

Planflow is installable: `public/manifest.webmanifest`, the icons in `public/icons/`, and a
service worker (`public/sw.js`, registered at the end of `app.js`) that caches the shell
network-first (a deploy shows on the next open, the cached copy only steps in when the
server is away) and never `/api`. Installed, it opens full screen; the `List` mode is the
one to use there. Chrome installs only from a secure origin, and http://thundertrident:8090
is not one: serve it over Tailscale HTTPS on its own port (once HTTPS certificates are
enabled for the tailnet, see "On the phone" in the Hermes README):

```sh
tailscale serve --bg --https=8090 8090     # https://thundertrident.<tailnet>.ts.net:8090
```

## API

All JSON. `from` blocks `to` in every link; `from_side`/`to_side` (`left`/`right`/`top`/`bottom`) say where the arrow is attached.

```
GET    /api/boards                       list boards with done/total counts
POST   /api/boards          {name}
PATCH  /api/boards/:id      {name}
DELETE /api/boards/:id
GET    /api/boards/:id                   {board, tasks, deps}
POST   /api/boards/:id/tasks {title, notes?, x?, y?}
POST   /api/boards/:id/positions {positions:[{id,x,y}]}
POST   /api/boards/:id/deps  {from, to, from_side?, to_side?}  409 on cycle
PATCH  /api/tasks/:id       {title?, notes?, status?, x?, y?, force?}
                                          status:'done' is 409 while blocked unless force:true
DELETE /api/tasks/:id                    to the trash (kept 7 days), links and cover with it
POST   /api/tasks/:id/restore            undo: {task, deps}; a link that would now loop is dropped
POST   /api/tasks/:id/cover              image bytes (Content-Type image/*, ?name=&w=&h=)
                                          or {url, rename?}: fetches title/picture; rename renames the task
DELETE /api/tasks/:id/cover
GET    /api/tasks/:id/cover-image        the picture (?v=cover.v to cache it)
PATCH  /api/deps/:from/:to  {from_side?, to_side?}
DELETE /api/deps/:from/:to
```

A task's `cover` is `null` or `{kind: 'image'|'link', url, title, description, site, image, width, height, v}`.
