# How Planflow works

Planflow is a todo list drawn as a flow chart. Every task is a box on a canvas.
A link between two boxes means **"the second task waits for the first"**. A task
can only be started once everything it waits for is done, so the board always tells
you what you can work on right now.

## The three states

Every task is in exactly one of these states. Nothing is stored for this; it is
worked out from the links and the done flags each time the board renders.

| State | Looks like | Meaning |
| --- | --- | --- |
| **Ready** | blue border, `Ready` badge | not done, and every task it waits for is done (or it waits for nothing) |
| **Blocked** | grey dashed border, `Blocked by N` | not done, and at least one task it waits for is still unfinished |
| **Done** | green border, struck-through title | finished. Its outgoing links turn green |

Rules that follow from this:

- A task with no incoming links is always ready (until you finish it).
- Finishing a task can flip its dependents to ready. A toast tells you which ones unlocked.
- A blocked task cannot be marked done from the circle on the box or the `Mark done`
  button. If you really need to, the side panel has a small `Mark done anyway` link.
- Reopening a done task does not undo its dependents. They keep whatever state they had.
- Links can never form a loop (A waits for B waits for A). The app refuses before it
  even asks the server, and the server checks again.

## Using the canvas

| What you want | How |
| --- | --- |
| Add a task | `+ Task` button, press `N`, double-click or **middle-click** empty canvas, or right-click it and choose `Add task here`. The new card appears with the caret already in its title, so just type the name and press `Enter` |
| Rename it | double-click the card (or select it and press `Enter`), type, `Enter`. `Esc` also finishes. Or edit in the side panel; both save as you type |
| Add notes | click the task, type in the side panel. Saves as you type |
| Give it a cover | select the task and paste an image or a link (`Ctrl+V`), or drop an image file or a link on its card. The panel's `Image…` and `Link…` buttons do the same. See [Covers](#covers-pictures-and-links-on-cards) |
| Move a task | drag it anywhere |
| Make B wait for A | move the mouse near A so its four blue **●** handles appear (one per side; on a phone, tap the box to select it), drag one of them and drop it on B. The arrow attaches to whichever side of B you drop nearest to |
| Move an arrow to another side | click the link, then pick the sides in the side panel (`Leaves the first card from its…` / `Enters the second card at its…`) |
| Remove a link | click the link line, then press `Unlink` (or `Delete`), or right-click it and choose `Unlink`. `Ctrl+Z` puts it back |
| Finish a task | click the circle on the box, `Mark done` in the panel, or right-click the box |
| Reopen a task | click the green circle again, or `Reopen` in the panel |
| Delete a task | press `Delete` in the panel or the right-click menu: it turns into a red **Really?**; press it again. Or select the task and hit the `Delete` key twice. See [Deleting and undo](#deleting-and-undo) |
| Undo a delete | `Ctrl+Z`, or the `Undo` button in the toast that appears |
| Add the next step | right-click a task and choose `Add next step`. A new task appears to its right, already linked, ready to be named |
| Tidy the layout | `Arrange` or `A`. Columns by dependency depth; links that skip a column get their own lane. Arrows keep the sides you chose |
| See everything | `Fit` or `F` |
| Zoom | scroll wheel, or pinch on a phone |
| Pan | drag empty canvas, or drag with the middle button |
| Deselect | click empty canvas or press `Esc` |

While you drag a link, the box under your finger gets a blue dashed outline when the
drop is allowed and a red one when it would make a loop or already exists. The handle
on the side the arrow will attach to grows and glows, and the arrow already snaps to it,
so you see the result before letting go. Arrows can leave and enter on any of the four
sides, which makes it easy to draw a setup diagram: for example two app boxes side by
side, each with an arrow going down into the same database box.

### Naming a new card

Every way of adding a task ends the same: the card is selected and its title is being
edited **on the card itself**, with the placeholder `New task` selected so that typing
replaces it. `Enter` or clicking elsewhere keeps what you typed; an empty title becomes
`Untitled`. Keys pressed in the short moment before the server has answered are not lost:
they are kept and become the start of the title. On a phone the panel's title field is
focused instead, because the bottom sheet would cover the card.

### Deleting and undo

There is no confirmation dialog. A delete control asks for a second click instead:
the first click turns it into a red **Really?** (the panel button, the right-click item,
or the `Delete` key, which arms the panel button), the second click within four seconds
deletes. Clicking anything else, or waiting, disarms it.

A deleted task goes to a trash on the server rather than away: its links and its cover
go with it. A toast offers `Undo`, `Ctrl+Z` does the same, and the right-click menu on
empty canvas shows the last undo. Restoring brings the task back with the same id, the
same done date, its cover, and its links, except a link that would now form a loop
(possible if you linked around the gap while it was deleted); that one is dropped.
The trash is emptied of tasks deleted more than seven days ago, and it is per browser
tab: after a reload the toast is gone, but the task is still restorable through the API.
Unlinking is undoable the same way. Deleting a **board** still asks with a dialog; it
really is gone afterwards.

### Covers: pictures and links on cards

A task can carry one cover, shown at the top of its card like a Trello card cover, and
in the side panel under **Cover**:

- **An image.** Paste a screenshot or an image file (`Ctrl+V`), drop an image file on
  the card or the canvas, or use `Image…` in the panel. The browser shrinks it to at
  most 1280 px on the long side before uploading. On the card it is shown full width,
  at most 160 px tall (taller pictures are cropped, not squashed).
- **A link.** Paste a web address, drop a link from another tab, or use `Link…`. The
  server fetches the page once and keeps its title, description, site name and preview
  picture (the `og:image`), so the card shows the picture with the title and site under
  it. Click the title on the card, the link in the panel, or `Open link` in the
  right-click menu to open it in a new tab. A link straight to a picture becomes an
  image cover. If the page cannot be fetched (offline, private, no such site), the
  card still gets a plain link cover with the host name.

Where it goes: with a task **selected**, the paste becomes that task's cover (an
existing cover is replaced). With **nothing selected**, a new task is created in the
middle of the view: named after the image file, or after the page title for a link.
A drop lands on the card under the pointer, or makes a new card where it was dropped.
Plain text pasted with nothing selected also makes a new card: the first line is the
title, the rest goes into the notes. Pasting into the panel's fields is just a normal
paste. `Remove` in the panel or `Remove cover` in the right-click menu takes it off.

### Right-click menu

Right-clicking (or long-pressing on a phone) opens a small menu that depends on what is
under the pointer:

- **Empty canvas**: `Add task here`, `Arrange`, `Fit view`, and `Undo: …` when there is
  something to undo.
- **A task**: `Mark done` / `Reopen` (or `Mark done anyway` while it is blocked),
  `Rename`, `Add next step`, `Open link` and `Remove cover` when it has a cover, and
  `Delete task` (two clicks). Right-clicking also selects the task.
- **A link**: `Unlink`.

A **middle-click** on the canvas adds a task under the pointer and lets you type its
name at once. Dragging with the middle button pans instead, so nothing is added unless
the pointer stays still.

## The side panel

With nothing selected it shows the board overview: counts of ready, blocked, and done
tasks, then three lists. **Ready to start** is the useful one. Clicking any entry
selects the task and scrolls the canvas to it.

With a task selected it becomes the editor: title, notes, the done and delete buttons,
the **Cover** section (the picture or link preview, `Image…`, `Link…`, `Remove`) and two
lists. **Waits for** are the tasks that must finish first (each has an ✕ to unlink).
**Unlocks** are the tasks that are waiting on this one.

On a phone the panel is a bottom sheet. It slides up when you tap a task and can be
toggled with the ☰ button.

## Boards

The dropdown in the top bar switches between boards. Each board is a separate canvas
with its own tasks and links, meant for one project or app. The `⋯` button next to it
creates, renames, or deletes a board. Deleting a board deletes all of its tasks.

The app remembers which board you had open and the pan/zoom of each board in the
browser's local storage, so every device has its own view position.

## What happens under the hood

There are two parts. Everything lives in two files plus a stylesheet.

### Server (`server.js`)

A plain Node HTTP server, no framework; the only npm package is the `pg` Postgres driver. It does three things:

1. Serves the static frontend from `public/`.
2. Answers the JSON API under `/api/`.
3. Stores everything in a PostgreSQL database (`db.js` holds the connection and the schema).
   On thundertrident that is the shared Postgres server every app on the box uses,
   in a database called `planflow`.

The database has four tables:

```
boards  id, name, created_at
tasks   id, board_id, title, notes, status ('todo' | 'done'), x, y,
        created_at, updated_at, done_at, deleted_at
deps    board_id, from_id, to_id, from_side, to_side   -- "to waits for from"
covers  task_id, kind ('image' | 'link'), url, title, description, site,
        mime, image (the picture bytes), width, height, updated_at
```

`x` and `y` are the box position on the canvas in canvas units. Deleting a board
cascades to its tasks, and deleting a task cascades to its links and its cover. The
picture of a cover lives in the database as bytes, so the nightly Postgres dumps include
it and nothing needs a file volume.

The server enforces these rules (the frontend checks the first two as well):

- `PATCH /api/tasks/:id` with `status: "done"` returns `409` while the task has an
  unfinished blocker, unless the body also has `force: true`.
- `POST /api/boards/:id/deps` returns `409` if the new link would make a cycle.
  The check (`cycleIn`) walks the existing links from the target task and refuses if
  it can reach the source task.
- `DELETE /api/tasks/:id` does not delete the row: it sets `deleted_at`. Every read
  skips such rows (the board's tasks, its links, the counts, `PATCH`, linking), so to
  the rest of the app the task is gone. `POST /api/tasks/:id/restore` clears the stamp,
  re-checks the task's links against the links added meanwhile, deletes any that would
  close a loop, and returns the task with the links that survived. Rows older than
  seven days are really deleted at start-up and after each delete.
- `POST /api/tasks/:id/cover` with an `image/*` body stores the bytes after checking
  the file's magic number (PNG, JPEG, GIF, WebP, AVIF, BMP; up to 8 MiB) and reads the
  width and height from the header. With a JSON `{url}` body it fetches the page itself
  (8 s per request, first 512 KB of HTML, a `User-Agent` naming Planflow), takes
  `og:title` / `<title>`, `og:description`, `og:site_name` and `og:image`, downloads the
  picture (up to 4 MiB), and stores it all in one `covers` row. A fetch that fails
  leaves a link cover with only the host name; it never fails the request.
  `GET /api/tasks/:id/cover-image` serves the bytes with a one-year cache header; the
  client appends `?v=<cover.v>` (the cover's update time) so a replaced picture is a
  new URL.

On first start with an empty database it seeds an example board so the app is not blank.

### Frontend (`public/app.js`, `public/index.html`, `public/style.css`)

Vanilla JavaScript, one file, no build step. The important pieces:

- **State** is one object: the board's tasks (a `Map` by id), the list of links, the
  current selection, and the view (`x`, `y` offset and scale `s`).
- **Derived state**: `stateOf(task)` returns `ready`, `blocked`, or `done` by looking at
  the task's blockers. `reaches(a, b)` walks the links for the cycle check.
- **The canvas** is a `#viewport` div with a `#world` div inside it. Panning and zooming
  just set a CSS `transform: translate(...) scale(...)` on `#world`. Boxes are plain
  `div.node` elements positioned with `left`/`top`; inside, a `.cover` block (hidden
  when the task has none) sits above the `.body` grid with the circle, title and badge.
  Links are SVG paths (cubic béziers)
  in an SVG that sits under the boxes. Each link remembers which side of each box it is
  attached to (`from_side`, `to_side`; the default is right → left), and the curve leaves
  each side straight out before bending toward the other end, so an arrow into the top
  of a box arrives pointing down. A second, invisible, wide path per link is the click
  target.
- **Covers** are drawn by `renderCover()`, which rebuilds the block only when the
  task's `cover` changed so the picture is not reloaded on every redraw. The `<img>`
  gets `aspect-ratio: width / height` from the stored size, so the card has its final
  height before the picture arrives (links and Arrange measure real card heights).
  A `paste` listener on the document and `drop` on the canvas call `addCover()`, which
  picks the target (dropped-on card, selected card, or a new card) and then
  `setImageCover()` (shrinks the image on a canvas, uploads it as WebP or JPEG) or
  `setLinkCover()` (shows the card at once with "fetching preview…", then swaps in the
  server's answer).
- **Inline titles**: `editTitle()` makes the card's `.title` a `contenteditable`
  (`plaintext-only`) and selects its text; `endEdit()` on blur, `Enter` or `Esc`
  trims it and saves. Keys pressed while a task is still being created are collected in
  `typeAhead` and become the title. Pointer-downs inside the editable title are left to
  the browser so the caret can be placed.
- **Two-click delete**: `armedDelete()` remembers one armed task id for four seconds; the
  panel button, the right-click item and the `Delete` key all go through it, so any of
  them can be the second click.
- **Undo** is a small stack of `{label, run}` entries (`pushUndo()`), filled by task
  deletes (run: `POST …/restore`) and unlinks (run: add the link back). The toast shows
  an `Undo` button for the newest entry; `Ctrl+Z` runs it. The stack is cleared when you
  switch boards.
- **Gestures** all go through pointer events on `#viewport`, so mouse and touch behave
  the same. A pointer-down decides what it is: on a **●** handle it starts a link drag from that side (on release, the side of the target box nearest the pointer becomes the entry side);
  on a box it starts a move; on a link line it selects it; on empty canvas it pans.
  A pointer that moves less than 4 px counts as a click (select or deselect; a click on
  a link cover's title also opens the page). The middle
  button starts a pan too, and if it never moves the release adds a task under the
  pointer. Two touch pointers switch to a pinch-zoom around the midpoint. Wheel events
  zoom around the cursor. Because the viewport captures the pointer, the browser
  delivers `dblclick` to the viewport rather than the card, so the double-click handler
  hit-tests under the pointer to decide between "rename this card" and "new task here".
  The `contextmenu` event (right-click or long-press) cancels
  any gesture in progress and opens the menu for whatever is under the pointer.
- **Saving** is immediate for moves, links, done toggles and covers (one request each).
  Title and notes edits are debounced half a second so typing does not spam the server.
- **Arrange** computes each task's depth (longest chain of blockers behind it) and puts
  each depth in a column. A link that skips columns (A → C while A → B → C also exists)
  gets an invisible zero-height "lane" item in every column it skips, so the cards in
  those columns are pushed aside and the link has clear space instead of running under
  a card. Each column is then ordered so every item sits level with the average centre
  of the items it follows, stacked without overlapping using real rendered heights, and
  all positions are sent to the server in one request.
- **Link routing**: before drawing a link, the app samples the curve and checks whether
  it would pass under any card it is not attached to (with a 10 px margin). If so, the
  link is redrawn as a detour that goes over or under the offending cards, whichever is
  closer. This keeps links visible in hand-made layouts too, for example when you drag a
  card onto a straight link. Detours only apply to the usual right → left links; arrows
  attached to other sides are drawn as plain curves.
- **Refresh**: when the tab becomes visible again the board is reloaded from the server,
  so changes made from your phone show up on the laptop when you come back to it
  (not while a title is being typed).

### API summary

All requests and responses are JSON, except the two picture routes. In every link,
`from` is the task that must
finish first and `to` is the one that waits. `from_side` and `to_side` (`left`, `right`,
`top` or `bottom`) say where the arrow is attached; they default to `right` and `left`.
A task's `cover` is `null` or `{kind, url, title, description, site, image, width, height, v}`
where `kind` is `image` or `link`, `image` says whether there is a picture, and `v`
is the cache key for it.

```
GET    /api/boards                     boards with total/done counts
POST   /api/boards                     {name}
PATCH  /api/boards/:id                 {name}
DELETE /api/boards/:id
GET    /api/boards/:id                 {board, tasks, deps}
POST   /api/boards/:id/tasks           {title, notes?, x?, y?}
POST   /api/boards/:id/positions       {positions: [{id, x, y}]}
POST   /api/boards/:id/deps            {from, to, from_side?, to_side?}
PATCH  /api/tasks/:id                  {title?, notes?, status?, x?, y?, force?}
DELETE /api/tasks/:id                  to the trash; 404 afterwards for every other route
POST   /api/tasks/:id/restore          {task, deps}, the links that came back with it
POST   /api/tasks/:id/cover            body: image bytes with Content-Type image/* (?name=&w=&h=),
                                       or JSON {url, rename?}; returns the task
DELETE /api/tasks/:id/cover            returns the task
GET    /api/tasks/:id/cover-image      the picture bytes (?v= for caching)
PATCH  /api/deps/:from/:to             {from_side?, to_side?}
DELETE /api/deps/:from/:to
GET    /api/health
```

Errors come back as `{"error": "message"}` with a fitting status: `400` bad input,
`404` unknown id, `409` rule violation (blocked task, cycle), `413` body too large.
