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
| Add a task | `+ Task` button, press `N`, double-click or **middle-click** empty canvas, or right-click it and choose `Add task here` |
| Rename it, add notes | click the task, edit in the side panel. Saves as you type |
| Move a task | drag it anywhere |
| Make B wait for A | drag A's blue **●** handle (right edge) and drop it on B |
| Remove a link | click the link line, then press `Unlink` (or `Delete`), or right-click it and choose `Unlink` |
| Finish a task | click the circle on the box, `Mark done` in the panel, or right-click the box |
| Reopen a task | click the green circle again, or `Reopen` in the panel |
| Delete a task | right-click it and choose `Delete task`, or select it and press `Delete`, or use the panel button |
| Add the next step | right-click a task and choose `Add next step`. A new task appears to its right, already linked |
| Tidy the layout | `Arrange` or `A`. Columns by dependency depth |
| See everything | `Fit` or `F` |
| Zoom | scroll wheel, or pinch on a phone |
| Pan | drag empty canvas, or drag with the middle button |
| Deselect | click empty canvas or press `Esc` |

While you drag a link, the box under your finger gets a blue dashed outline when the
drop is allowed and a red one when it would make a loop or already exists.

### Right-click menu

Right-clicking (or long-pressing on a phone) opens a small menu that depends on what is
under the pointer:

- **Empty canvas**: `Add task here`, `Arrange`, `Fit view`.
- **A task**: `Mark done` / `Reopen` (or `Mark done anyway` while it is blocked),
  `Add next step`, and `Delete task`. Right-clicking also selects the task.
- **A link**: `Unlink`.

A **middle-click** on the canvas adds a task under the pointer. Dragging with the middle
button pans instead, so nothing is added unless the pointer stays still.

## The side panel

With nothing selected it shows the board overview: counts of ready, blocked, and done
tasks, then three lists. **Ready to start** is the useful one. Clicking any entry
selects the task and scrolls the canvas to it.

With a task selected it becomes the editor: title, notes, the done button, and two
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

A plain Node HTTP server, no framework, no npm packages. It does three things:

1. Serves the static frontend from `public/`.
2. Answers the JSON API under `/api/`.
3. Stores everything in one SQLite file through Node's built-in `node:sqlite`.

The database has three tables:

```
boards  id, name, created_at
tasks   id, board_id, title, notes, status ('todo' | 'done'), x, y,
        created_at, updated_at, done_at
deps    board_id, from_id, to_id        -- "to waits for from"
```

`x` and `y` are the box position on the canvas in canvas units. Deleting a board
cascades to its tasks, and deleting a task cascades to its links.

The server enforces two rules the frontend also checks:

- `PATCH /api/tasks/:id` with `status: "done"` returns `409` while the task has an
  unfinished blocker, unless the body also has `force: true`.
- `POST /api/boards/:id/deps` returns `409` if the new link would make a cycle.
  The check (`wouldCycle`) walks the existing links from the target task and refuses if
  it can reach the source task.

On first start with an empty database it seeds an example board so the app is not blank.

### Frontend (`public/app.js`, `public/index.html`, `public/style.css`)

Vanilla JavaScript, one file, no build step. The important pieces:

- **State** is one object: the board's tasks (a `Map` by id), the list of links, the
  current selection, and the view (`x`, `y` offset and scale `s`).
- **Derived state**: `stateOf(task)` returns `ready`, `blocked`, or `done` by looking at
  the task's blockers. `reaches(a, b)` walks the links for the cycle check.
- **The canvas** is a `#viewport` div with a `#world` div inside it. Panning and zooming
  just set a CSS `transform: translate(...) scale(...)` on `#world`. Boxes are plain
  `div.node` elements positioned with `left`/`top`. Links are SVG paths (cubic
  béziers from the right edge of one box to the left edge of the other) in an SVG that
  sits under the boxes. A second, invisible, wide path per link is the click target.
- **Gestures** all go through pointer events on `#viewport`, so mouse and touch behave
  the same. A pointer-down decides what it is: on a **●** handle it starts a link drag;
  on a box it starts a move; on a link line it selects it; on empty canvas it pans.
  A pointer that moves less than 4 px counts as a click (select or deselect). The middle
  button starts a pan too, and if it never moves the release adds a task under the
  pointer. Two touch pointers switch to a pinch-zoom around the midpoint. Wheel events
  zoom around the cursor. The `contextmenu` event (right-click or long-press) cancels
  any gesture in progress and opens the menu for whatever is under the pointer.
- **Saving** is immediate for moves, links, and done toggles (one request each). Title
  and notes edits are debounced half a second so typing does not spam the server.
- **Arrange** computes each task's depth (longest chain of blockers behind it), puts
  each depth in a column, orders each column by the average row of its blockers to
  reduce crossings, then stacks boxes using their real rendered heights and sends all
  positions to the server in one request.
- **Refresh**: when the tab becomes visible again the board is reloaded from the server,
  so changes made from your phone show up on the laptop when you come back to it.

### API summary

All requests and responses are JSON. In every link, `from` is the task that must
finish first and `to` is the one that waits.

```
GET    /api/boards                     boards with total/done counts
POST   /api/boards                     {name}
PATCH  /api/boards/:id                 {name}
DELETE /api/boards/:id
GET    /api/boards/:id                 {board, tasks, deps}
POST   /api/boards/:id/tasks           {title, notes?, x?, y?}
POST   /api/boards/:id/positions       {positions: [{id, x, y}]}
POST   /api/boards/:id/deps            {from, to}
PATCH  /api/tasks/:id                  {title?, notes?, status?, x?, y?, force?}
DELETE /api/tasks/:id
DELETE /api/deps/:from/:to
GET    /api/health
```

Errors come back as `{"error": "message"}` with a fitting status: `400` bad input,
`404` unknown id, `409` rule violation (blocked task, cycle), `413` body too large.
