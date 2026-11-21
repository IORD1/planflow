# Planflow

Cards on a canvas, linked by dragging one of a card's blue handles (one per side, shown
when the pointer comes near the card) onto another card. What a card and a link mean
depends on what the board is for, its **mode**:

| Mode | A card is | A link A → B means | The side panel shows |
| --- | --- | --- | --- |
| **Tasks** | something to do | B waits for A | what is ready, blocked and done |
| **Ideas** | an idea, a link, a picture | A and B go together | the piles and the loose ideas |
| **Planning** | a heading or a point | B is a part of A | the cards as an outline |
| **Workflow** | a step or a decision | after A comes B | the flow, step by step |

A new board asks which one it is, and the mode button in the top bar switches it at any
time without losing anything. On a **tasks** board a task lights up **Ready** when
everything it waits for is done, and the panel always lists what you can start right
now. Paste an image or a link and it becomes the card's cover, Trello-style. Deleting
takes two clicks and can be undone.

The home page shows every plan as a card, YouTube style: a coloured thumbnail with the
plan's flow sketched on it, each card leaning a little. Drag a card anywhere and it
stays there; drag it onto the cardboard box in the bottom-left corner to archive it, and
click the box to get archived plans back.
The ☀ / ☾ button in the top bar switches between day and dark mode.

Node's built-in HTTP server, PostgreSQL through the `pg` driver (the only dependency), vanilla JS frontend.

- **[HOW-IT-WORKS.md](HOW-IT-WORKS.md)**: using the board, the four modes, the ready/blocked/done rules, and what the code does.
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
| Open a plan | click its card on the home page (the Planflow logo always goes back home). A plan's address is `#/board/<id>`, so bookmarks and the back button work |
| New plan | `+ New plan` on the home page, or `N` there: pick what it is for (tasks, ideas, planning, workflow), then name it |
| Change what a board is for | the mode button next to the board name (on a phone: `⋯` → `What it is for…`, or the line under the board's name in the list). The toast's `Undo` or `Ctrl+Z` switches back. Nothing is lost: checkboxes a mode hides are still ticked when you return |
| Move a plan's card | drag it anywhere on the home page; the spot is remembered. `Back into the grid` in its ⋯ menu forgets it |
| Archive a plan | drag its card onto the box bottom left, or `Archive` in the card's ⋯ menu (long-press on a phone) or the board menu. The toast's `Undo` or `Ctrl+Z` brings it back |
| Archived plans | click the box: a list with `Restore` and `Delete` (two clicks) |
| Day / dark mode | the ☀ / ☾ button in the top bar. Follows the system until you choose |
| Add a task | `+ Task`, press `N`, double-click or middle-click empty canvas, or right-click → `Add task here`. Then just type: the caret is already in the new card's title |
| Rename a task | double-click it (or select it and press `Enter`), type, `Enter`. Or edit in the side panel |
| Give a task a cover | select it and paste an image or a link (`Ctrl+V`), or drop one on its card. With nothing selected, the paste makes a new card. Links get their title and picture fetched |
| Move a task | drag it |
| Make B wait for A | move the mouse near A and drag any of its blue ● handles onto B; the arrow attaches to the side of B you drop nearest to |
| Move an arrow to another side | click the link, then pick the sides in the side panel |
| Remove a link | click or right-click the link, then `Unlink` |
| Complete a task | click its circle (only when nothing it waits for is unfinished) |
| Tick an idea off | ideas board: the circle in the card's corner (shown on hover, or when the card is selected), or `Tick off` in the panel. Watched, bought, used; nothing waits for it |
| Write on a link | double-click it and type, or select it and use `Written on it` in the panel. On a workflow `Yes` and `No` are one click (panel or right-click) |
| Make a decision | workflow board: end the card's title with `?` (or start it with `Is`, `Are`, `Does`, `Did`, `Should`, `If`), or write on the arrows that leave it |
| Copy the outline / the steps | planning or workflow board, nothing selected: `Copy as text` at the top of the panel's list. A Markdown list, ready to paste |
| Delete a task | `Delete` (panel or right-click) turns into **Really?**, click again. Or press `Delete` twice. `Ctrl+Z` or the toast's `Undo` brings it back, links included |
| Task menu | right-click a task: mark done, rename, add next step, open link / remove cover, delete |
| Delete a board | board menu (next to the board name), `Delete board` turns red, click again. Boards are not in the trash: this one is for good |
| Edit title / notes | click the task, edit in the side panel |
| Tidy the layout | `Arrange` / `A` — columns by dependency depth. On an ideas board the cards with no links are packed into a block underneath |
| Zoom / pan | scroll wheel or pinch / drag empty space, `F` fits everything (on a phone it stops at 60%, so cards stay readable) |
| On a phone | `List` in the top bar shows the board as lists (ready / blocked / done, or the piles, the outline, the steps, by mode); tap a card for its details (mark done, notes, links, cover), `← Back` returns. `Board` goes back to the canvas. Tapping a card on the canvas opens its details as a bottom sheet |

On a tasks board and in an outline, links can never form a loop; the server rejects it and
the UI warns before trying. A workflow may loop back (a retry) and ideas may link in a
circle, and such a board cannot become a tasks board or an outline until one of those
links is removed: the app says which cards and selects a link to cut.

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

All JSON. A link goes `from` → `to` (on a tasks board `from` blocks `to`); `from_side`/`to_side`
(`left`/`right`/`top`/`bottom`) say where the arrow is attached and `label` is the words on it.
A board's `mode` is `tasks`, `ideas`, `plan` or `flow`.

```
GET    /api/boards                       list boards with mode and done/total counts
GET    /api/overview                     every board with its cards and links (the home page)
POST   /api/boards          {name, mode?}
PATCH  /api/boards/:id      {name?, mode?, archived?, home_x?, home_y?}
                                          mode tasks/plan is 409 while the links loop ({error, loop: [ids]})
DELETE /api/boards/:id
GET    /api/boards/:id                   {board, tasks, deps}
POST   /api/boards/:id/tasks {title, notes?, x?, y?}
POST   /api/boards/:id/positions {positions:[{id,x,y}]}
POST   /api/boards/:id/deps  {from, to, from_side?, to_side?, label?}
                                          409 on a cycle (tasks and plan boards only)
PATCH  /api/tasks/:id       {title?, notes?, status?, x?, y?, force?}
                                          status:'done' is 409 while blocked unless force:true
                                          (tasks boards only: nothing is blocked elsewhere)
DELETE /api/tasks/:id                    to the trash (kept 7 days), links and cover with it
POST   /api/tasks/:id/restore            undo: {task, deps}; where loops are not allowed, a link that would now loop is dropped
POST   /api/tasks/:id/cover              image bytes (Content-Type image/*, ?name=&w=&h=)
                                          or {url, rename?}: fetches title/picture; rename renames the task
DELETE /api/tasks/:id/cover
GET    /api/tasks/:id/cover-image        the picture (?v=cover.v to cache it)
PATCH  /api/deps/:from/:to  {from_side?, to_side?, label?}   label '' or null takes the words off
DELETE /api/deps/:from/:to
```

A task's `cover` is `null` or `{kind: 'image'|'link', url, title, description, site, image, width, height, v}`.
