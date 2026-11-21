# How Planflow works

Planflow is cards on a canvas with links between them. What a board is for, its
**mode**, decides what a card and a link mean there: things to do in order, a pile of
ideas, an outline, or a workflow (see "Modes" below). It started as a todo list drawn as
a flow chart, and that is still the mode a board has unless you choose another: every
task is a box, a link between two boxes means **"the second task waits for the first"**,
and a task can only be started once everything it waits for is done, so the board always
tells you what you can work on right now.

## The three states

This section is about a **tasks** board. Every task is in exactly one of these states.
Nothing is stored for this; it is worked out from the links and the done flags each time
the board renders.

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

## Modes

A board is one of four things. The cards, the links and everything stored about them are
the same in all four; the mode only changes how they are read, so a board can be switched
back and forth and nothing is lost (a checkbox that a mode hides is still ticked when you
come back).

| | Tasks | Ideas | Planning | Workflow |
| --- | --- | --- | --- | --- |
| A card is | a task | an idea, a link, a picture | a heading or a point | a step or a decision |
| A link A → B | B waits for A | A and B go together | B is a part of A | after A comes B |
| Drawn as | an arrow, green once A is done | a dotted thread, no head | a branch ending in a bud | an arrow |
| Checkbox | yes, and it can be blocked | a quiet tick, never blocked | none | none |
| Loops | refused | allowed | refused | allowed (a retry) |
| The panel lists | ready, blocked, done | the piles, then the loose ideas | the cards as an outline | the flow, step by step |
| Top bar says | `+ Task`, `3 / 7 done` | `+ Idea`, `20 ideas` | `+ Point`, `24 points` | `+ Step`, `48 steps` |

**Choosing.** `+ New plan` asks what the plan is for before it asks for a name. On a
board, the button next to the board's name shows the mode and opens the same list; on a
phone it is `What it is for…` in the `⋯` menu, and the line under the board's name in the
list. A switch shows a toast with `Undo` (`Ctrl+Z` works too).

**Ideas.** For collecting: films to watch, things to buy, pages that caught your eye.
Cards lean a little, each by its own fixed amount, like the plan cards on the home page;
the selected one sits straight. Nothing is ever blocked. A card with links going out is a
**pile** (heavier border, `7 in this pile`) and the panel lists each pile with what is in
it, then the ideas on their own, newest first; a row with a link cover has a ↗ that opens
the page. The tick in a card's corner appears when the pointer is on the card or the card
is selected, and stays once ticked: watched, bought, used. Ticked ideas sink to the end of
their list. `Arrange` lays the linked cards out in columns and packs the unlinked ones
into a block underneath, shortest column first, so pictures of different heights fit.

**Planning.** For breaking a thing down. A card's level comes from its links: a card that
nothing points to and that points to others is the top of an outline (a block of ink,
large type), the cards it points to are sections (a heavy left edge), anything deeper is
a point (a light left edge), and a card with no links is a loose point (dashed). A card
with cards under it says how many. The panel shows the outline indented, in the order the
cards are laid out (top to bottom when siblings are stacked, left to right when they are
side by side), and `Copy as text` puts it on the clipboard as a Markdown list, link
covers included.

**Workflow.** For how something runs. A card's part is read off its title and its links:

- a **start** (a green pill with ▶) is a card that nothing leads to;
- an **end** (a pill with ■) is a card that leads nowhere;
- a **decision** (six sides, orange) is a card that asks something, meaning its title
  ends in `?` or begins with `Is`, `Are`, `Does`, `Did`, `Should` or `If`, or a card
  whose arrows out carry words. A card that simply feeds two others is a plain step.

Arrows can carry **words** (40 characters at most): double-click an arrow and type, or
select it and use `Written on it` in the panel, where `Yes`, `No` and `None` are one
click each (also in the arrow's right-click menu). `Yes`-like words are green and
`No`-like words red. Words on links work in every mode; only a workflow reads them as
making a decision. The panel walks the flow from each start: steps numbered in the order
the walk reaches them, the branches of a decision indented under it with the word on
their arrow in front, `↩ back to step 3` where an arrow loops back, and `→ joins step 3`
where two branches meet. `Copy as text` gives the same walk as a numbered list.

**Loops.** A workflow may loop back and ideas may link in a circle. A tasks board and an
outline may not, so a board whose links loop cannot be switched to either: the server
answers `409` naming the cards in the circle, the toast repeats it, and one link of the
loop is selected so `Unlink` is one click away.

## The home page

The app opens on the home page: every plan (board) as a card in a grid, most recently
edited first. A card's thumbnail is a colour or gradient picked from the plan's id (so it
never changes) with the plan's flow sketched on it: a box where each task card sits
(taller if the card has a cover), the links between them as the same curves the canvas
draws, done tasks filled in white, blocked ones dashed. Every card leans 1 to 5 degrees,
clockwise or anticlockwise, again from the id, and straightens when the pointer is on it.
`done / total` sits in the corner and a thin green bar under the title shows progress.

That is a tasks board. Each card says what kind of plan it is (top left of the thumbnail)
and the sketch follows the mode: leaning boxes on dotted threads for ideas, the top of an
outline filled in for planning, pills for a workflow's starts and ends and six-sided
decisions. The other three have no progress to show, so the corner counts cards
(`20 ideas`) and the line under the title gives one fact instead: how many are ticked
off, how many cards are at the top, how many decisions.

The page is a free surface, not a fixed grid: drag a card (mouse or pen) and drop it
anywhere, and that is where it stays (`home_x` / `home_y` on the board). Cards that were
never moved take the next free cell of a grid, row by row, most recently edited first,
skipping any cell a placed card covers; those automatic spots are not saved, so they
reflow with the window. `Back into the grid` in a card's ⋯ menu forgets its spot. On a
phone the cards are a plain grid and the spots are ignored.

The cardboard box bottom left is the archive. Drag a card onto it (with a mouse or pen:
the card shrinks into the box as the flaps open) and the plan leaves the grid; a toast
offers `Undo`. On a phone a finger scrolls the grid, so use the card's ⋯ button or a long
press for the menu (`Open`, `Rename`, `Archive`, `Delete plan`). Clicking the box lists
the archived plans with `Restore` and a two-click `Delete`. An archived plan is not in
the board switcher and nothing else changes about it: its tasks and links stay as they
were, and `archived_at` on the board row is all the server records.

Where you are is in the URL: `#/` is the home page and `#/board/<id>` a plan, so the
browser's back button, bookmarks and the PWA's start page all behave.

## Day and dark mode

The ☀ / ☾ button in the top bar switches themes; the choice is kept in this browser
(`localStorage` key `planflow.theme`). Until you press it the app follows the system
setting and changes with it. All colours are tokens at the top of `style.css`; the
light set is the `:root[data-theme="light"]` block. A tiny script in `index.html`
sets `data-theme` before the stylesheet loads so the page never flashes the other theme.

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
deletes. Clicking anything else, or waiting, disarms it. The board menu's `Delete board`
works the same way (the menu stays open, red, for the second click), and that one has no
undo: the board and its tasks are gone.

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
selects the task and scrolls the canvas to it. On the other kinds of board the overview
is that mode's reading of the board (the piles, the outline, the steps; see "Modes"),
under a line that says the mode and changes it.

With a task selected it becomes the editor: title, notes, the done and delete buttons,
the **Cover** section (the picture or link preview, `Image…`, `Link…`, `Remove`) and two
lists. **Waits for** are the tasks that must finish first (each has an ✕ to unlink).
**Unlocks** are the tasks that are waiting on this one. The two lists are named for what
a link means in the mode: one list, **Goes with**, on an ideas board; **Part of** and
**Breaks into** in an outline; **Comes after** and **Then** in a workflow. Where there is
nothing to finish, the done button is `+ Point under it` or `+ Next step` instead.

With a link selected it shows the two cards, **Written on it** (the words on the link),
the sides the arrow is attached to, and `Unlink`.

On a phone the panel is a bottom sheet that slides up when you tap a task. The `List`
button in the top bar switches to **list mode**: the panel fills the screen (ready,
blocked and done lists, or the mode's own lists, with a `+ Task` button; a task's details with `← Back`) and the
canvas is hidden, which is the comfortable way to work through a board with a thumb.
`Board` brings the canvas back. The choice is remembered on that phone. `Fit` on a phone
never goes below 60%, so cards stay readable; the rest of the board is a pan away. Touch
targets (the done circle, the link handles, list rows, buttons) are larger on touch screens.

## Boards

The dropdown in the top bar switches between boards. Each board is a separate canvas
with its own tasks and links, meant for one project or app. The `⋯` button next to it
creates, renames, archives or deletes a board, and says what it is for. Creating one
(here or with `+ New plan` on the home page) first asks what it is for. Deleting a board
deletes all of its tasks.

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
boards  id, name, created_at, archived_at, home_x, home_y,
        mode ('tasks' | 'ideas' | 'plan' | 'flow')
tasks   id, board_id, title, notes, status ('todo' | 'done'), x, y,
        created_at, updated_at, done_at, deleted_at
deps    board_id, from_id, to_id, from_side, to_side,  -- "to waits for from" on a tasks board
        label                                          -- the words on the arrow, or NULL
covers  task_id, kind ('image' | 'link'), url, title, description, site,
        mime, image (the picture bytes), width, height, updated_at
```

A card is a row in `tasks` whatever the board is for, and `status` is the checkbox
whether or not the mode shows it. `mode` and `label` were added on 2026-11-21 with
`ALTER TABLE … ADD COLUMN IF NOT EXISTS` at start-up; every board that existed became a
tasks board, so nothing changed until a mode was switched.

`x` and `y` are the box position on the canvas in canvas units. Deleting a board
cascades to its tasks, and deleting a task cascades to its links and its cover. The
picture of a cover lives in the database as bytes, so the nightly Postgres dumps include
it and nothing needs a file volume.

The server enforces these rules (the frontend checks the first two as well). The first
three depend on the board's mode (`MODES` and `NO_LOOPS` at the top of `server.js`):

- `PATCH /api/tasks/:id` with `status: "done"` returns `409` while the task has an
  unfinished blocker, unless the body also has `force: true`. Only on a tasks board:
  elsewhere nothing is blocked.
- `POST /api/boards/:id/deps` returns `409` if the new link would make a cycle.
  The check (`cycleIn`) walks the existing links from the target task and refuses if
  it can reach the source task. Only on a tasks board and in an outline: a workflow and
  an ideas board may loop.
- `PATCH /api/boards/:id` with `mode` `tasks` or `plan` returns `409` while the board's
  links loop. `findLoop` walks the links depth first and returns one loop; the answer is
  `{error, loop: [ids]}` with the cards' titles in the message. A `PATCH` checks all of
  its fields before it saves any of them.
- `DELETE /api/tasks/:id` does not delete the row: it sets `deleted_at`. Every read
  skips such rows (the board's tasks, its links, the counts, `PATCH`, linking), so to
  the rest of the app the task is gone. `POST /api/tasks/:id/restore` clears the stamp,
  re-checks the task's links against the links added meanwhile, deletes any that would
  close a loop (on a board that cannot have loops), and returns the task with the links
  that survived. Rows older than
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
- **Modes**: the `MODES` table holds each mode's words (the add button, the hint, what a
  new link's toast says, the panel's list names) and `applyMode()` puts the open board's
  mode on `body[data-mode]`, which is all `style.css` needs to restyle cards and links.
  `stateOf()` answers `open` or `done` on an ideas board and always `open` in an outline
  or a workflow, so the tasks-only code paths (blocked, unlocked, `Mark done anyway`)
  never run there. `graph()` works out, once per redraw, the links into and out of each
  card and each card's distance from a card nothing points to; `levelOf()` (outline) and
  `roleFrom()` (workflow: decision, start, end, step) read a card's look off it, and
  `updateNode()` turns that into classes (`lv0`…, `start`, `decision`, `hub`).
  `linkProblem()` is the one place that says whether a new link is allowed (loops only
  where the mode permits). `leanOf(id)` is an idea card's fixed tilt, and `anchor()` turns
  a leaning card's link ends with it. The panel's overview is one function per mode in
  `OVERVIEW`; `outline()` and `walk()` produce the rows for the outline and the
  step-by-step list, and `outlineText()` / `flowText()` the copied text. `setMode()`
  switches (one `PATCH`, then a full redraw) and pushes the switch back onto the undo
  stack; `showModeMenu()` is the list of four, used for switching and for a new plan.
- **Words on links** are `div.edge-label` elements in `#edgeLabels`, a layer between the
  SVG of links and the cards, placed on the middle of each labelled path by
  `renderEdges()`. `setDepLabel()` shows the words at once and saves them half a second
  after the typing stops (`flushLabel()`); it also redraws the card the arrow leaves,
  because on a workflow the words make that card a decision.
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
  each depth in a column. An arrow that loops back (workflow, ideas) is left out of the
  placing, and on an ideas board the cards with no links go into a block of columns
  under the rest. A link that skips columns (A → C while A → B → C also exists)
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

All requests and responses are JSON, except the two picture routes. A link goes from
`from` to `to`; on a tasks board `from` is the task that must
finish first and `to` is the one that waits. `from_side` and `to_side` (`left`, `right`,
`top` or `bottom`) say where the arrow is attached; they default to `right` and `left`.
`label` is the words on the link (40 characters at most, `null` for none). A board's
`mode` is `tasks`, `ideas`, `plan` or `flow`.
A task's `cover` is `null` or `{kind, url, title, description, site, image, width, height, v}`
where `kind` is `image` or `link`, `image` says whether there is a picture, and `v`
is the cache key for it.

```
GET    /api/boards                     boards with mode and total/done counts
GET    /api/overview                   {boards}: each with its cards (id, title, x, y, status, cover)
                                       and links, for the home page's sketches
POST   /api/boards                     {name, mode?}
PATCH  /api/boards/:id                 {name?, mode?, archived?, home_x?, home_y?}
DELETE /api/boards/:id
GET    /api/boards/:id                 {board, tasks, deps}
POST   /api/boards/:id/tasks           {title, notes?, x?, y?}
POST   /api/boards/:id/positions       {positions: [{id, x, y}]}
POST   /api/boards/:id/deps            {from, to, from_side?, to_side?, label?}
PATCH  /api/tasks/:id                  {title?, notes?, status?, x?, y?, force?}
DELETE /api/tasks/:id                  to the trash; 404 afterwards for every other route
POST   /api/tasks/:id/restore          {task, deps}, the links that came back with it
POST   /api/tasks/:id/cover            body: image bytes with Content-Type image/* (?name=&w=&h=),
                                       or JSON {url, rename?}; returns the task
DELETE /api/tasks/:id/cover            returns the task
GET    /api/tasks/:id/cover-image      the picture bytes (?v= for caching)
PATCH  /api/deps/:from/:to             {from_side?, to_side?, label?}   '' or null takes the words off
DELETE /api/deps/:from/:to
GET    /api/health
```

Errors come back as `{"error": "message"}` with a fitting status: `400` bad input,
`404` unknown id, `409` rule violation (blocked task, cycle, a mode that cannot have
the board's loop), `413` body too large.
