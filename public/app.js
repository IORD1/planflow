'use strict';
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const viewport = $('#viewport'), world = $('#world'), edgeLayer = $('#edgeLayer'), nodesLayer = $('#nodes');
  const panel = $('#panel'), toastEl = $('#toast'), boardSelect = $('#boardSelect'), edgeUnlink = $('#edgeUnlink');
  const boardMenu = $('#boardMenu'), zoomLabel = $('#zoomLabel'), edgeLabels = $('#edgeLabels');
  const home = $('#home'), planGrid = $('#planGrid'), archiveBox = $('#archiveBox'), archiveDrawer = $('#archiveDrawer');
  const NODE_W = 210, MIN_S = 0.2, MAX_S = 3, DRAG_THRESHOLD = 4;
  const MOBILE_FIT_S = 0.6;   // the smallest scale Fit goes to on a phone (fitView)
  const IMAGE_MAX_PX = 1280;     // pasted images are shrunk to this on their long side before upload
  const ARM_MS = 4000;           // how long a delete button stays at "Really?"
  const isMobile = () => window.innerWidth <= 760;
  // List mode, for the phone: the panel (ready / blocked / done, then a task's details) is
  // the whole screen and the canvas is hidden. Remembered per browser; nothing on a desktop.
  let listMode = false;
  try { listMode = localStorage.getItem('planflow.list') === '1'; } catch {}
  const inList = () => isMobile() && listMode;
  function setListMode(on) {
    listMode = on;
    try { localStorage.setItem('planflow.list', on ? '1' : '0'); } catch {}
    document.body.classList.toggle('list', on);
    const b = document.getElementById('btnList');
    if (b) { b.textContent = on ? 'Board' : 'List'; b.setAttribute('aria-pressed', String(on)); }
    if (on) panel.classList.add('open');
    else if (isMobile()) panel.classList.toggle('open', !!state.selected);
    if (state.boardId) renderPanel();   // the list's header differs from the sheet's (add button instead of ✕)
  }

  // ---------------------------------------------------------------- theme (day / dark)
  // index.html already set data-theme before the first paint (the saved choice, else the system's);
  // the ☀/☾ button in the top bar flips it and remembers it in this browser.
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    const b = $('#btnTheme');
    if (b) { b.textContent = t === 'dark' ? '☀' : '☾'; b.title = t === 'dark' ? 'Day mode' : 'Dark mode'; }
    const meta = $('meta[name=theme-color]'); if (meta) meta.content = t === 'dark' ? '#0b0d10' : '#f7f9fb';
  }
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  $('#btnTheme').addEventListener('click', () => {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('planflow.theme', t); } catch {}
    applyTheme(t);
  });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {   // follow the system until a choice is made
    try { if (localStorage.getItem('planflow.theme')) return; } catch {}
    applyTheme(e.matches ? 'light' : 'dark');
  });

  const state = {
    home: false,                          // the home page (all plans) is showing instead of a board
    boards: [], boardId: null, board: null,
    tasks: new Map(), deps: [],           // deps: [{from, to, from_side, to_side}]  "from must be done before to"
    selected: null,                       // {type:'task', id} | {type:'edge', from, to}
    view: { x: 40, y: 40, s: 1 },
  };
  const nodeEls = new Map();
  const pointers = new Map();
  let gesture = null;

  // ---------------------------------------------------------------- modes
  // What a board is for (board.mode; the rules are in server.js MODES). The rows are the same in
  // every mode. The mode decides what a card and a link mean, so what they look like, what the
  // panel lists and what the app calls things. Switching never loses anything: a checkbox that
  // a mode hides is still ticked when you switch back.
  //   tasks  to-dos that wait for each other: ready / blocked / done, a link is "waits for"
  //   ideas  a pile of ideas, links and pictures: nothing blocks, a link is "goes with", a tick is optional
  //   plan   an outline: a link is "breaks into", cards are headings and points, nothing to finish
  //   flow   a workflow: a link is "then" and can carry a word, cards are steps and decisions (roleFrom), loops allowed
  const MODES = {
    tasks: {
      label: 'Tasks', one: 'task', many: 'tasks', a: 'a task', add: '+ Task', fresh: 'New task', boardName: 'New project',
      about: 'Things to do, in order. A card unlocks when everything it waits for is done.',
      switched: 'Cards wait for each other again.',
      notes: 'Notes, links, acceptance criteria…',
      next: 'Add next step →', nextTitle: 'New task to the right that waits for this one',
      port: 'Drag onto another task: that task will wait for this one',
      drag: 'onto another task to make it wait for this one',
      linked: (a, b) => `"${b}" now waits for "${a}"`,
      rule: 'A link A → B means B waits for A. Tasks light up blue when everything they wait for is done.',
    },
    ideas: {
      label: 'Ideas', one: 'idea', many: 'ideas', a: 'an idea', add: '+ Idea', fresh: 'New idea', boardName: 'Ideas',
      about: 'A pile of ideas, links and pictures. Nothing blocks anything. Tick one off once it is watched, bought or used.',
      switched: 'Nothing blocks anything now. Ticks are kept.',
      notes: 'Why it caught your eye, where it is from…',
      next: 'Add an idea that goes with it →', nextTitle: 'New idea to the right, linked to this one',
      port: 'Drag onto another idea to keep the two together',
      drag: 'onto another idea to keep the two together',
      linked: (a, b) => `"${a}" and "${b}" go together`,
      rule: 'A link only says two cards go together. A card with links going out is a pile; the panel lists what is in it.',
    },
    plan: {
      label: 'Planning', one: 'point', many: 'points', a: 'a point', add: '+ Point', fresh: 'New point', boardName: 'New plan',
      about: 'An outline. A card breaks down into the cards it points to. No checkboxes, nothing to finish.',
      switched: 'Checkboxes are hidden, not lost.',
      notes: 'What this part is about, open questions…',
      next: 'Add a point under it →', nextTitle: 'New point to the right, one level below this one',
      port: 'Drag onto another card to put that card under this one',
      drag: 'onto another card to put it under this one',
      linked: (a, b) => `"${b}" is now under "${a}"`,
      rule: 'A link A → B means B is a part of A. The panel reads the cards as an outline you can copy.',
    },
    flow: {
      label: 'Workflow', one: 'step', many: 'steps', a: 'a step', add: '+ Step', fresh: 'New step', boardName: 'New workflow',
      about: 'Steps and decisions. An arrow means "then", can carry a word such as Yes or No, and may loop back.',
      switched: 'Arrows mean "then" now. Checkboxes are hidden, not lost.',
      notes: 'What happens in this step, who or what does it…',
      next: 'Add next step →', nextTitle: 'New step to the right, after this one',
      port: 'Drag onto the step that comes next',
      drag: 'onto the step that comes next · double-click an arrow to write on it',
      linked: (a, b) => `After "${a}" comes "${b}"`,
      rule: 'An arrow A → B means B comes after A. A card that asks a question (ends in "?", starts with "Is"), or has words on its arrows, is a decision.',
    },
  };
  const MODE_IDS = Object.keys(MODES);
  const modeOf = (b) => (b && MODES[b.mode] ? b.mode : 'tasks');
  const modeId = () => modeOf(state.board);
  const M = () => MODES[modeId()];
  const loopsOk = () => modeId() === 'ideas' || modeId() === 'flow';
  const count = (n, def) => `${n} ${n === 1 ? def.one : def.many}`;
  // The small drawing that stands for a mode (top bar, menus, home page): made of the same things
  // the mode puts on the canvas, a ticked circle, loose cards, an indented outline, a decision.
  const MODE_ICON = {
    tasks: ['circle:8,8,5.6', 'M5.4 8.2l1.9 1.9 3.4-3.8'],
    ideas: ['rect:1.8,3.6,7.4,5.4,-11', 'rect:7,7.2,7.4,5.4,8'],
    plan: ['M2 3.5h7.5', 'M3.4 5.6v6.9h2', 'M3.4 8.2h2', 'M7.4 8.2h6.6', 'M7.4 12.5h4.6'],
    flow: ['M8 4.4l3.6 3.6-3.6 3.6-3.6-3.6z', 'M1.4 8h3', 'M11.6 8h3', 'M13.1 6.5l1.5 1.5-1.5 1.5'],
  };
  function modeIcon(id) {
    const svg = svgEl('svg', { viewBox: '0 0 16 16', class: 'mode-svg', 'aria-hidden': 'true' });
    for (const part of MODE_ICON[id] || MODE_ICON.tasks) {
      const [kind, nums] = part.includes(':') ? part.split(':') : ['path', part];
      if (kind === 'path') { svg.append(svgEl('path', { d: nums })); continue; }
      const v = nums.split(',').map(Number);
      if (kind === 'circle') svg.append(svgEl('circle', { cx: v[0], cy: v[1], r: v[2] }));
      else svg.append(svgEl('rect', { x: v[0], y: v[1], width: v[2], height: v[3], rx: 1.3, transform: `rotate(${v[4]} ${v[0] + v[2] / 2} ${v[1] + v[3] / 2})` }));
    }
    return svg;
  }
  // The open board's mode on the page: body[data-mode] is what style.css keys on, and the top
  // bar's words follow it (called when a board opens and when its mode is switched).
  function applyMode() {
    const id = modeId(), def = MODES[id];
    document.body.dataset.mode = id;
    const add = $('#btnAdd'); add.textContent = def.add; add.title = `Add ${def.a} (N)`;
    $('#btnMode .mode-ico').replaceChildren(modeIcon(id));
    $('#btnMode .mode-name').textContent = def.label;
    $('#hint').replaceChildren(`Right-click for actions · double-click or middle-click empty space to add ${def.a} and type its name · paste an image or a link to give a card a cover · drag a `,
      h('b', {}, '●'), ` handle (any side) ${def.drag} · scroll to zoom, drag to pan`);
  }

  // ---------------------------------------------------------------- utils
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'selected' || k === 'disabled' || k === 'hidden') el[k] = v;
      else el.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined) el.append(c.nodeType ? c : String(c));
    return el;
  }
  function svgEl(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }
  let toastTimer;
  // toast('Deleted "x"', { action: { label: 'Undo', run }, ms: 7000 }) shows a button in the toast.
  function toast(msg, opts = {}) {
    const kids = [h('span', {}, msg)];
    if (opts.action) kids.push(h('button', { class: 'toast-action', onclick: () => { toastEl.classList.remove('show'); opts.action.run(); } }, opts.action.label));
    toastEl.replaceChildren(...kids);
    toastEl.classList.toggle('actionable', !!opts.action);
    toastEl.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), opts.ms || 2800);
  }
  // JSON in and out; a Blob body (an image) is sent as-is with its own content type.
  async function api(method, url, body) {
    const blob = body instanceof Blob;
    const res = await fetch(url, {
      method, headers: body ? { 'Content-Type': blob ? (body.type || 'application/octet-stream') : 'application/json' } : undefined,
      body: body ? (blob ? body : JSON.stringify(body)) : undefined,
    });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) { const err = new Error((data && data.error) || `${res.status} ${res.statusText}`); err.data = data; throw err; }
    return data;
  }
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
  // A pasted/dropped text that is exactly one web address, normalised; else null.
  function urlIn(text) {
    const s = (text || '').trim();
    if (!/^https?:\/\/\S+$/i.test(s)) return null;
    try { return new URL(s).href; } catch { return null; }
  }

  // ---------------------------------------------------------------- graph helpers
  const blockersOf = (id) => state.deps.filter((d) => d.to === id).map((d) => state.tasks.get(d.from)).filter(Boolean);
  const dependentsOf = (id) => state.deps.filter((d) => d.from === id).map((d) => state.tasks.get(d.to)).filter(Boolean);
  // ready / blocked / done on a tasks board. On an ideas board a card is ticked ('done') or not
  // ('open') and nothing waits for anything; an outline and a workflow have nothing to finish.
  function stateOf(t) {
    const m = modeId();
    if (m === 'plan' || m === 'flow') return 'open';
    if (t.status === 'done') return 'done';
    if (m === 'ideas') return 'open';
    return blockersOf(t.id).some((b) => b.status !== 'done') ? 'blocked' : 'ready';
  }
  // Facts about the links that a card's look depends on, worked out once per redraw (renderAll and
  // refreshNodes clear it): the links into and out of each card, and how far each card is from
  // a card that nothing points to (its level in an outline).
  let graphCache = null;
  function graph() {
    if (graphCache) return graphCache;
    const ins = new Map(), outs = new Map(), depth = new Map();
    for (const id of state.tasks.keys()) { ins.set(id, []); outs.set(id, []); }
    for (const d of state.deps) { if (ins.has(d.to) && outs.has(d.from)) { ins.get(d.to).push(d); outs.get(d.from).push(d); } }
    let edge = [...state.tasks.keys()].filter((id) => !ins.get(id).length);
    for (const id of edge) depth.set(id, 0);
    while (edge.length) {
      const next = [];
      for (const id of edge) for (const d of outs.get(id)) if (!depth.has(d.to)) { depth.set(d.to, depth.get(id) + 1); next.push(d.to); }
      edge = next;
    }
    return (graphCache = { ins, outs, depth });
  }
  const insOf = (id) => graph().ins.get(id) || [];
  const outsOf = (id) => graph().outs.get(id) || [];
  // A workflow card's part in the flow, read off its title and its links. A decision is a card
  // that asks something ("Is it a GPay screenshot", "Endpoint working?") or whose arrows out
  // carry words (Yes / No): a card that simply feeds two others is a plain step, not a decision.
  // A flow starts where nothing leads in and ends where nothing leaves.
  const asks = (title) => /\?\s*$/.test(title) || /^(is|are|does|did|should|if)\s/i.test(title);
  function roleFrom(title, nin, outs) {
    if (asks(title || '') || outs.some((d) => d.label)) return 'decision';
    if (!nin && outs.length) return 'start';
    if (nin && !outs.length) return 'end';
    return 'step';
  }
  const roleOf = (t) => roleFrom(t.title, insOf(t.id).length, outsOf(t.id));
  const ROLE_LABEL = { decision: 'Decision', start: 'Start', end: 'End', step: 'Step' };
  // An outline card's level: 0 the top of an outline, 1 a section, 2 anything deeper; 'x' for a
  // card with no links at all (a loose note).
  function levelOf(t) {
    if (!insOf(t.id).length && !outsOf(t.id).length) return 'x';
    return Math.min(graph().depth.get(t.id) ?? 0, 2);
  }
  // What links two cards, for a new link from -> to: null when it is fine, else why not.
  function linkProblem(from, to) {
    if (from === to) return 'A card cannot link to itself.';
    if (state.deps.some((d) => d.from === from && d.to === to)) return 'Already linked.';
    if (modeId() === 'ideas' && state.deps.some((d) => d.from === to && d.to === from)) return 'Already linked.';
    if (!loopsOk() && reaches(to, from)) return "Can't link: that would make a loop.";
    return null;
  }
  function reaches(from, target) {           // can we walk from -> ... -> target along deps?
    const seen = new Set(); const stack = [from];
    while (stack.length) {
      const c = stack.pop();
      if (c === target) return true;
      if (seen.has(c)) continue; seen.add(c);
      for (const d of state.deps) if (d.from === c) stack.push(d.to);
    }
    return false;
  }
  const isSel = (type, a) => !!state.selected && state.selected.type === type &&
    (type === 'task' ? state.selected.id === a : state.selected.from === a.from && state.selected.to === a.to);
  const titleOf = (id) => state.tasks.get(id)?.title ?? '?';

  // ---------------------------------------------------------------- view (pan / zoom)
  let viewSaveTimer;
  function applyView() {
    const { x, y, s } = state.view;
    world.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    viewport.style.backgroundPosition = `${x}px ${y}px`;
    viewport.style.backgroundSize = `${24 * s}px ${24 * s}px`;
    zoomLabel.textContent = Math.round(s * 100) + '%';
    clearTimeout(viewSaveTimer);
    viewSaveTimer = setTimeout(() => state.boardId && store.set('planflow.view.' + state.boardId, state.view), 300);
  }
  function clientToWorld(cx, cy) {
    const r = viewport.getBoundingClientRect();
    return { x: (cx - r.left - state.view.x) / state.view.s, y: (cy - r.top - state.view.y) / state.view.s };
  }
  function zoomAt(cx, cy, factor) {
    const r = viewport.getBoundingClientRect();
    const s0 = state.view.s, s = clamp(s0 * factor, MIN_S, MAX_S);
    const px = cx - r.left, py = cy - r.top;
    state.view = { s, x: px - (px - state.view.x) * (s / s0), y: py - (py - state.view.y) * (s / s0) };
    applyView();
  }
  function animateView(fn) {
    world.classList.add('animate');
    fn();
    setTimeout(() => world.classList.remove('animate'), 320);
  }
  function fitView(animate) {
    const r = viewport.getBoundingClientRect();
    if (!nodeEls.size) { state.view = { x: 40, y: 40, s: 1 }; applyView(); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [id, el] of nodeEls) {
      const t = state.tasks.get(id);
      minX = Math.min(minX, t.x); minY = Math.min(minY, t.y);
      maxX = Math.max(maxX, t.x + el.offsetWidth); maxY = Math.max(maxY, t.y + el.offsetHeight);
    }
    const pad = isMobile() ? 24 : 60;
    // On a phone a fit that shows everything is unreadable (a board of 40 cards lands at 20%),
    // so the scale stops at MOBILE_FIT_S: the cards stay legible and the rest is a pan away.
    const s = clamp(Math.min((r.width - pad * 2) / (maxX - minX), (r.height - pad * 2) / (maxY - minY), 1.2), isMobile() ? Math.max(MIN_S, MOBILE_FIT_S) : MIN_S, MAX_S);
    const apply = () => {
      state.view = { s, x: (r.width - (maxX - minX) * s) / 2 - minX * s, y: (r.height - (maxY - minY) * s) / 2 - minY * s };
      applyView();
    };
    animate ? animateView(apply) : apply();
  }
  function centerOn(id) {
    const el = nodeEls.get(id), t = state.tasks.get(id);
    if (!el || !t) return;
    const r = viewport.getBoundingClientRect(), s = state.view.s;
    animateView(() => {
      state.view.x = r.width / 2 - (t.x + el.offsetWidth / 2) * s;
      state.view.y = r.height / 2 - (t.y + el.offsetHeight / 2) * s;
      applyView();
    });
  }
  // A free spot in the middle of the view for a new card.
  function centerSpot() {
    const r = viewport.getBoundingClientRect();
    let p = clientToWorld(r.left + r.width / 2, r.top + r.height / 2);
    p = { x: p.x - NODE_W / 2, y: p.y - 24 };
    const taken = (x, y) => [...state.tasks.values()].some((t) => Math.abs(t.x - x) < 20 && Math.abs(t.y - y) < 20);
    while (taken(p.x, p.y)) { p.x += 30; p.y += 30; }
    return p;
  }

  // ---------------------------------------------------------------- nodes
  function makeNode(t) {
    const el = h('div', { class: 'node', 'data-id': t.id, style: `--lean:${leanOf(t.id)}deg` },
      h('div', { class: 'cover', hidden: true }),
      h('div', { class: 'body' },
        h('button', { class: 'check', 'aria-label': 'Toggle done' }, '✓'),
        h('span', { class: 'role', 'aria-hidden': 'true' }),       // a workflow card's mark: start, decision, end
        h('div', { class: 'title' }),
        h('div', { class: 'meta' }, h('span', { class: 'badge' }))),
      ...SIDES.map((s) => h('div', { class: 'port ' + s, 'data-side': s, title: M().port })));
    updateNode(el, t);
    return el;
  }
  // How far an idea card leans on an ideas board, 0.6..1.6° either way: a pile of loose cards,
  // like the plan cards on the home page. Always the same for the same card (see rnd).
  const leanOf = (id) => Math.round((0.6 + rnd(id, 7)) * (rnd(id, 8) < 0.5 ? -10 : 10)) / 10;
  const leaning = (id) => modeId() === 'ideas' && !isSel('task', id);   // the selected card sits straight
  function updateNode(el, t) {
    const m = modeId(), st = stateOf(t), nout = outsOf(t.id).length;
    let cls = 'node ' + st, badge = '', check = '';
    if (m === 'tasks') {
      const n = blockersOf(t.id).filter((b) => b.status !== 'done').length;
      badge = st === 'done' ? 'Done' : st === 'ready' ? 'Ready' : `Blocked by ${n}`;
      check = st === 'blocked' ? 'Finish its blockers first' : st === 'done' ? 'Reopen' : 'Mark done';
    } else if (m === 'ideas') {
      if (nout) { cls += ' hub'; badge = `${nout} in this pile`; }
      check = st === 'done' ? 'Untick' : 'Tick off (watched, bought, used…)';
    } else if (m === 'plan') {
      cls += ' lv' + levelOf(t);
      if (nout) badge = count(nout, MODES.plan);
    } else {
      const role = roleOf(t); cls += ' ' + role;
      if (role !== 'step') badge = ROLE_LABEL[role];
    }
    el.className = cls + (t.cover ? ' has-cover' : '') + (isSel('task', t.id) ? ' selected' : '');
    el.style.left = t.x + 'px'; el.style.top = t.y + 'px';
    const title = $('.title', el);
    if (title.textContent !== t.title) title.textContent = t.title;   // leave the caret alone while it is being typed
    renderCover(el, t);
    $('.badge', el).textContent = badge;
    $('.meta', el).hidden = !badge;
    $('.check', el).title = check;
    for (const p of el.querySelectorAll('.port')) p.title = MODES[m].port;
  }
  // The picture / link preview at the top of a card. Rebuilt only when the cover changed,
  // so the image is not reloaded on every redraw.
  const coverSrc = (t) => `/api/tasks/${t.id}/cover-image?v=${t.cover.v}`;
  function renderCover(el, t) {
    const box = $('.cover', el), c = t.cover;
    const key = c ? JSON.stringify(c) : '';
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.className = 'cover' + (c ? ' ' + c.kind : '');
    box.hidden = !c;
    box.replaceChildren();
    if (!c) return;
    if (c.image) {
      const img = h('img', { src: coverSrc(t), alt: '', draggable: 'false', onload: renderEdges, onerror: (e) => { e.target.hidden = true; renderEdges(); } });
      if (c.width && c.height) img.style.aspectRatio = `${c.width} / ${c.height}`;   // reserve the space before it loads
      box.append(img);
    }
    if (c.kind === 'link') {
      box.append(h('div', { class: 'link-meta', title: 'Open ' + c.url },
        h('div', { class: 'lt' }, c.title || c.url),
        h('div', { class: 'ls' }, h('b', {}, '↗ '), c.pending ? 'fetching preview…' : (c.site || hostOf(c.url)))));
    }
  }
  function renderAll() {
    endEdit(); graphCache = null;
    nodesLayer.replaceChildren(); nodeEls.clear();
    for (const t of state.tasks.values()) { const el = makeNode(t); nodesLayer.appendChild(el); nodeEls.set(t.id, el); }
    renderEdges(); renderPanel(); renderProgress();
  }
  function refreshNodes() {
    graphCache = null;
    for (const [id, el] of nodeEls) updateNode(el, state.tasks.get(id));
    renderEdges(); renderPanel(); renderProgress();
  }
  function renderProgress() {
    const m = modeId(), def = MODES[m], total = state.tasks.size;
    const done = [...state.tasks.values()].filter((t) => t.status === 'done').length;
    // Only a tasks board has progress; an ideas board shows its ticks once there are some.
    const ticks = m === 'tasks' || (m === 'ideas' && done > 0);
    $('#progress .bar').style.width = ticks && total ? (done / total * 100) + '%' : '0';
    $('#progress .label').textContent = !total ? `no ${def.many} yet` : m === 'tasks' ? `${done} / ${total} done`
      : ticks ? `${done} / ${total} ticked` : count(total, def);
    $('#progress').title = m === 'tasks' ? 'Done / total' : ticks ? 'Ticked off / total' : 'Cards on this board';
    $('#progress').classList.toggle('plain', !ticks);
  }

  // ---------------------------------------------------------------- inline title editing
  // A new card's title is typed right on the card: the caret lands in it, "New task" is
  // selected so typing replaces it. Double-click a card (or press Enter) to rename it there.
  let editing = null;          // { id, el } while a card title is being typed on the canvas
  let pendingCreate = 0;       // tasks being created (waiting for the server)
  let typeAhead = '';          // keys typed while that wait lasts, they become the new title
  function editTitle(id, opts = {}) {
    const t = state.tasks.get(id), el = nodeEls.get(id); if (!t || !el) return;
    if (isMobile()) {           // the bottom sheet covers the canvas on a phone: type in the panel instead
      const inp = $('.title-input', panel); if (inp) { inp.focus(); inp.select(); }
      return;
    }
    if (editing && editing.id !== id) endEdit();
    const ti = $('.title', el);
    ti.setAttribute('contenteditable', 'plaintext-only');
    if (!ti.isContentEditable) ti.setAttribute('contenteditable', 'true');   // browsers without plaintext-only
    editing = { id, el: ti };
    const typed = opts.fresh ? typeAhead : ''; typeAhead = '';
    if (typed) { ti.textContent = typed; t.title = typed; scheduleSave(id, { title: typed }); syncPanelTitle(t); }
    ti.focus();
    const range = document.createRange(); range.selectNodeContents(ti);
    if (typed) range.collapse(false);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  }
  function endEdit() {
    if (!editing) return;
    const { id, el: ti } = editing; editing = null;
    ti.removeAttribute('contenteditable');
    const t = state.tasks.get(id); if (!t) return;
    t.title = (ti.textContent || '').replace(/\s+/g, ' ').trim() || 'Untitled';
    ti.textContent = t.title;
    scheduleSave(id, { title: t.title }); flushSave();
    syncPanelTitle(t); renderEdges();
  }
  function syncPanelTitle(t) {
    const inp = $('.title-input', panel);
    if (inp && isSel('task', t.id) && document.activeElement !== inp && inp.value !== t.title) inp.value = t.title;
  }
  nodesLayer.addEventListener('input', (e) => {
    if (!editing || e.target !== editing.el) return;
    const t = state.tasks.get(editing.id); if (!t) return;
    t.title = editing.el.textContent;
    scheduleSave(t.id, { title: t.title.trim() || 'Untitled' });
    syncPanelTitle(t); renderEdges();
  });
  nodesLayer.addEventListener('keydown', (e) => {
    if (!editing || e.target !== editing.el) return;
    // stopPropagation: the document handler must not see this key (Enter would start a new edit)
    if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.target.blur(); }
  });
  nodesLayer.addEventListener('focusout', (e) => { if (editing && e.target === editing.el) endEdit(); });

  // ---------------------------------------------------------------- edges
  // A link leaves its source card and enters its target card through one of four sides.
  // Old links (and "Add next step") use the defaults: out of the right side, into the left.
  const SIDES = ['right', 'left', 'top', 'bottom'];
  const DIR = { right: { x: 1, y: 0 }, left: { x: -1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } };
  // Point on the given side of a card, plus the outward direction there.
  function anchor(id, side) {
    const el = nodeEls.get(id), t = state.tasks.get(id), w = el.offsetWidth, hh = el.offsetHeight;
    const dir = DIR[side] || DIR.right;
    const p = side === 'left' ? { x: t.x, y: t.y + hh / 2 } : side === 'top' ? { x: t.x + w / 2, y: t.y }
      : side === 'bottom' ? { x: t.x + w / 2, y: t.y + hh } : { x: t.x + w, y: t.y + hh / 2 };
    if (leaning(id)) {             // the card is turned a little about its middle (ideas board): turn the point with it
      const a = leanOf(id) * Math.PI / 180, cx = t.x + w / 2, cy = t.y + hh / 2, dx = p.x - cx, dy = p.y - cy;
      p.x = cx + dx * Math.cos(a) - dy * Math.sin(a); p.y = cy + dx * Math.sin(a) + dy * Math.cos(a);
    }
    return { ...p, dir };
  }
  // Which side of card `id` is closest to world point p: a dropped link attaches there.
  function nearestSide(id, p) {
    const el = nodeEls.get(id), t = state.tasks.get(id);
    const dist = { left: Math.abs(p.x - t.x), right: Math.abs(p.x - (t.x + el.offsetWidth)),
      top: Math.abs(p.y - t.y), bottom: Math.abs(p.y - (t.y + el.offsetHeight)) };
    return SIDES.reduce((best, s) => (dist[s] < dist[best] ? s : best), 'right');
  }
  // Control points: each end leaves its card straight out of its side, then bends toward the other end.
  function bezier(a, b) {
    const da = a.dir || DIR.right, db = b.dir || DIR.left;
    const reach = (dir) => Math.max(40, (dir.x ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y)) * 0.5);
    const ka = reach(da), kb = reach(db);
    return { p1: { x: a.x + da.x * ka, y: a.y + da.y * ka }, p2: { x: b.x + db.x * kb, y: b.y + db.y * kb } };
  }
  function pathD(a, b) { const { p1, p2 } = bezier(a, b); return `M ${a.x} ${a.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${b.x} ${b.y}`; }
  const EDGE_PAD = 10;   // how close a link may come to a card it is not attached to
  function bezierAt(a, p1, p2, b, t) {
    const m = 1 - t;
    return { x: m * m * m * a.x + 3 * m * m * t * p1.x + 3 * m * t * t * p2.x + t * t * t * b.x,
             y: m * m * m * a.y + 3 * m * m * t * p1.y + 3 * m * t * t * p2.y + t * t * t * b.y };
  }
  // Path for a link. If the plain curve would run under another card, detour above or
  // below it so the link stays visible (e.g. a link that skips a column after Arrange).
  function edgePath(d) {
    const fromId = d.from, toId = d.to, fs = d.from_side || 'right', ts = d.to_side || 'left';
    const a = anchor(fromId, fs), b = anchor(toId, ts);
    if (fs !== 'right' || ts !== 'left') return pathD(a, b);  // only the usual right→left links get detours
    if (b.x - a.x < 60) return pathD(a, b);                 // backwards or very short: plain curve
    const { p1, p2 } = bezier(a, b);
    const hits = [];
    for (const [id, el] of nodeEls) {
      if (id === fromId || id === toId) continue;
      const t = state.tasks.get(id);
      const r = { l: t.x - EDGE_PAD, t: t.y - EDGE_PAD, r: t.x + el.offsetWidth + EDGE_PAD, b: t.y + el.offsetHeight + EDGE_PAD };
      if (r.r <= a.x || r.l >= b.x) continue;
      for (let i = 1; i < 24; i++) {
        const p = bezierAt(a, p1, p2, b, i / 24);
        if (p.x > r.l && p.x < r.r && p.y > r.t && p.y < r.b) { hits.push(r); break; }
      }
    }
    if (!hits.length) return pathD(a, b);
    const top = Math.min(...hits.map((r) => r.t)), bottom = Math.max(...hits.map((r) => r.b));
    const mid = (a.y + b.y) / 2;
    const y = (mid - top) <= (bottom - mid) ? top - 4 : bottom + 4;
    const x1 = Math.max(Math.min(...hits.map((r) => r.l)), a.x + 30);
    const x2 = Math.min(Math.max(...hits.map((r) => r.r)), b.x - 30);
    const d1 = Math.max(30, (x1 - a.x) * 0.5), d2 = Math.max(30, (b.x - x2) * 0.5);
    if (x2 - x1 < 10) {
      const xm = (x1 + x2) / 2;
      return `M ${a.x} ${a.y} C ${a.x + d1} ${a.y}, ${xm - d1} ${y}, ${xm} ${y} C ${xm + d2} ${y}, ${b.x - d2} ${b.y}, ${b.x} ${b.y}`;
    }
    return `M ${a.x} ${a.y} C ${a.x + d1} ${a.y}, ${x1 - d1} ${y}, ${x1} ${y} L ${x2} ${y} C ${x2 + d2} ${y}, ${b.x - d2} ${b.y}, ${b.x} ${b.y}`;
  }
  // A link is drawn by what it means on this board: an arrow that turns green once its blocker is
  // done (tasks), a dotted thread with no direction (ideas), a branch ending in a bud (plan), a
  // plain arrow (flow). Words written on a link sit on its middle, in every mode.
  const EDGE_END = { pending: 'arrow-pending', satisfied: 'arrow-satisfied', selected: 'arrow-selected', flow: 'arrow-pending', plan: 'bud' };
  function renderEdges() {
    edgeLayer.replaceChildren();
    edgeUnlink.hidden = true;
    const mode = modeId(), labels = [];
    for (const d of state.deps) {
      if (!nodeEls.has(d.from) || !nodeEls.has(d.to)) continue;
      const sel = isSel('edge', d);
      const kind = mode !== 'tasks' ? mode : state.tasks.get(d.from).status === 'done' ? 'satisfied' : 'pending';
      const end = mode === 'ideas' ? null : sel && mode === 'plan' ? 'bud-selected' : EDGE_END[sel ? 'selected' : kind];
      const dAttr = edgePath(d);
      const attrs = { d: dAttr, class: `edge ${kind}${sel ? ' selected' : ''}` };
      if (end) attrs['marker-end'] = `url(#${end})`;
      const p = svgEl('path', attrs);
      edgeLayer.append(p, svgEl('path', { d: dAttr, class: 'edge-hit', 'data-from': d.from, 'data-to': d.to }));
      if (!sel && !d.label) continue;
      const m = p.getPointAtLength(p.getTotalLength() / 2);
      if (d.label) {
        const tone = /^(yes|y|ok|true|pass(ed)?|success)$/i.test(d.label) ? ' yes' : /^(no|n|false|fail(ed)?|error)$/i.test(d.label) ? ' no' : '';
        labels.push(h('div', { class: 'edge-label edge-hit' + tone + (sel ? ' selected' : ''), 'data-from': d.from, 'data-to': d.to,
          style: `left:${m.x}px;top:${m.y}px`, title: 'Double-click to change' }, d.label));
      }
      if (sel) {     // the Unlink button sits on the middle of the link, or just under the words on it
        edgeUnlink.style.left = m.x + 'px'; edgeUnlink.style.top = (m.y + (d.label ? 28 : 0)) + 'px'; edgeUnlink.hidden = false;
      }
    }
    edgeLabels.replaceChildren(...labels);
    if (gesture && gesture.type === 'link' && gesture.cur && nodeEls.has(gesture.from)) {
      const a = anchor(gesture.from, gesture.fromSide);
      const b = gesture.target && nodeEls.has(gesture.target) ? anchor(gesture.target, gesture.targetSide)   // snap to the drop side
        : { ...gesture.cur, dir: { x: -a.dir.x, y: -a.dir.y } };
      edgeLayer.append(svgEl('path', { d: pathD(a, b), class: 'edge temp', 'marker-end': 'url(#arrow-temp)' }));
    }
  }

  // ---------------------------------------------------------------- selection + panel
  let edgePickedAt = 0;   // when a link was last selected (see the Unlink button's click)
  function select(sel) {
    flushLabel();
    if (sel && sel.type === 'edge' && !isSel('edge', sel)) edgePickedAt = performance.now();
    state.selected = sel;
    for (const [id, el] of nodeEls) el.classList.toggle('selected', isSel('task', id));
    renderEdges(); renderPanel();
    if (inList()) panel.classList.add('open');
    else if (isMobile()) panel.classList.toggle('open', !!sel);
  }
  let pendingSave = null, saveTimer;
  function scheduleSave(id, patch) {
    if (pendingSave && pendingSave.id !== id) flushSave();
    pendingSave = { id, patch: { ...(pendingSave?.patch || {}), ...patch } };
    clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 500);
  }
  function flushSave() {
    clearTimeout(saveTimer);
    if (!pendingSave) return;
    const { id, patch } = pendingSave; pendingSave = null;
    api('PATCH', `/api/tasks/${id}`, patch).then((t) => {
      const cur = state.tasks.get(id);
      if (cur) { cur.updated_at = t.updated_at; }
    }).catch((e) => toast('Save failed: ' + e.message));
  }
  // The dot in front of a card's name in the panel: its state (tasks, ideas), its part in the
  // flow (workflow) or its level (outline).
  const dotOf = (t) => (modeId() === 'flow' ? roleOf(t) : modeId() === 'plan' ? 'lv' + levelOf(t) : stateOf(t));
  // opts: before (a chip or number in front of the name), indent (levels), cls, muted
  function taskRow(t, extra, opts = {}) {
    return h('li', { class: 'clickable' + (opts.cls ? ' ' + opts.cls : ''), style: opts.indent ? `margin-left:${opts.indent * 16}px` : null,
      onclick: () => { select({ type: 'task', id: t.id }); if (!inList()) centerOn(t.id); } },
      opts.before, h('span', { class: 'dot ' + dotOf(t) }), h('span', { class: 't' }, t.title), extra);
  }
  const setPanel = (...kids) => panel.replaceChildren(...kids.filter(Boolean));
  function coverSection(t) {
    const c = t.cover;
    const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: true,
      onchange: (e) => { const f = e.target.files[0]; if (f) setImageCover(t.id, f); } });
    const askLink = () => {
      const u = prompt('Link (http…)'); if (!u) return;
      const url = urlIn(u); if (!url) { toast('That is not a web address.'); return; }
      setLinkCover(t.id, url, false);
    };
    const body = !c ? h('div', { class: 'empty' }, 'Paste an image or a link (Ctrl+V) with this task selected, or drop one on its card.')
      : c.kind === 'image' ? h('img', { class: 'cover-thumb', src: coverSrc(t), alt: '' })
      : h('div', { class: 'link-card' },
          h('a', { href: c.url, target: '_blank', rel: 'noopener' }, c.title || c.url),
          c.description ? h('div', { class: 'small muted desc' }, c.description) : null,
          h('div', { class: 'small muted' }, c.pending ? 'fetching preview…' : (c.site || hostOf(c.url))));
    return h('section', {}, h('h4', {}, 'Cover'), body,
      h('div', { class: 'row' },
        h('button', { onclick: () => fileInput.click() }, c ? 'Replace image…' : 'Image…'),
        h('button', { onclick: askLink }, 'Link…'),
        c ? h('button', { class: 'danger', onclick: () => removeCover(t.id) }, 'Remove') : null,
        fileInput));
  }
  function renderPanel() {
    const closeBtn = inList()
      ? h('button', { id: 'panelClose', class: 'icon', title: 'Back to the list', onclick: () => select(null) }, '← Back')
      : h('button', { id: 'panelClose', class: 'icon', onclick: () => panel.classList.remove('open') }, '✕');
    const sel = state.selected;
    const t = sel && sel.type === 'task' ? state.tasks.get(sel.id) : null;
    if (t) {
      const m = modeId(), def = MODES[m], st = stateOf(t);
      const blockers = blockersOf(t.id), dependents = dependentsOf(t.id);
      const unlinkBtn = (from, to) => h('button', { class: 'unlink', title: 'Remove link', onclick: (e) => { e.stopPropagation(); deleteDep(from, to); } }, '✕');
      const titleInput = h('input', { type: 'text', class: 'title-input', value: t.title, maxlength: 300, placeholder: def.fresh,
        oninput: (e) => { t.title = e.target.value; updateNode(nodeEls.get(t.id), { ...t, title: t.title || 'Untitled' }); renderEdges(); scheduleSave(t.id, { title: t.title.trim() || 'Untitled' }); },
        onblur: flushSave, onkeydown: (e) => { if (e.key === 'Enter') { e.target.blur(); } } });
      const notes = h('textarea', { placeholder: def.notes,
        oninput: (e) => { t.notes = e.target.value; scheduleSave(t.id, { notes: t.notes }); }, onblur: flushSave });
      notes.value = t.notes || '';
      const armedNow = isArmed(t.id);
      // What the card is, in this mode's words, and the one thing you do to it besides deleting.
      const role = m === 'flow' ? roleOf(t) : null, level = m === 'plan' ? levelOf(t) : null;
      const badge = m === 'tasks' ? (st === 'done' ? 'Done' : st === 'ready' ? 'Ready to start' : `Blocked by ${blockers.filter((b) => b.status !== 'done').length}`)
        : m === 'ideas' ? (st === 'done' ? 'Ticked off' : dependents.length ? 'Pile' : 'Idea')
        : m === 'plan' ? (level === 'x' ? 'Loose point' : level === 0 ? 'Top of an outline' : `Level ${graph().depth.get(t.id) + 1}`)
        : ROLE_LABEL[role];
      const badgeCls = m === 'flow' ? role : m === 'plan' ? 'open' : st;
      const act = m === 'tasks'
        ? (st === 'blocked' ? h('button', { disabled: true, title: 'Finish its blockers first' }, 'Blocked')
          : h('button', { class: st === 'done' ? '' : 'primary', onclick: () => setDone(t.id, st !== 'done') }, st === 'done' ? 'Reopen' : 'Mark done'))
        : m === 'ideas' ? h('button', { title: 'Watched, bought, used: done with it. Nothing waits for a tick.', onclick: () => setDone(t.id, st !== 'done') }, st === 'done' ? 'Untick' : 'Tick off')
        : h('button', { title: def.nextTitle, onclick: () => createTask(t.x + NODE_W + 90, t.y, { after: t.id }) }, m === 'plan' ? '+ Point under it' : '+ Next step');
      // The cards this one is linked with, said the way the mode reads a link. Each row can unlink.
      const rows = (list, unlink, opts) => h('ul', {}, list.map((x) => taskRow(x, unlinkBtn(...unlink(x)), opts ? opts(x) : undefined)));
      const part = (title, list, unlink, empty, opts) => h('section', {}, h('h4', {}, `${title} (${list.length})`),
        list.length ? rows(list, unlink, opts) : h('div', { class: 'empty' }, empty));
      const into = (b) => [b.id, t.id], out = (d) => [t.id, d.id];
      const via = (d) => { const l = state.deps.find((x) => x.from === t.id && x.to === d.id)?.label; return l ? { before: h('span', { class: 'via' }, l) } : undefined; };
      const links = m === 'tasks' ? [
          part('Waits for', blockers, into, 'Nothing. This task can start any time.'),
          part('Unlocks', dependents, out, 'Nothing depends on this yet. Drag its ● handle onto a task to link.')]
        : m === 'ideas' ? [h('section', {}, h('h4', {}, `Goes with (${blockers.length + dependents.length})`),
          blockers.length + dependents.length ? h('ul', {}, blockers.map((b) => taskRow(b, unlinkBtn(b.id, t.id))), dependents.map((d) => taskRow(d, unlinkBtn(t.id, d.id))))
            : h('div', { class: 'empty' }, 'On its own. Drag its ● handle onto another idea to keep the two together.'))]
        : m === 'plan' ? [
          part('Part of', blockers, into, 'Nothing: this is the top of an outline, or a loose point.'),
          part('Breaks into', dependents, out, 'Nothing under it yet. Drag its ● handle onto a card to put that card under this one.')]
        : [
          part('Comes after', blockers, into, 'Nothing leads here: a flow starts at this step.'),
          part('Then', dependents, out, 'The flow ends here. Drag its ● handle onto the step that comes next.', via)];
      setPanel(
        h('div', { class: 'panel-head' }, h('span', { class: 'badge ' + badgeCls }, badge), h('span', { class: 'spacer' }), closeBtn),
        titleInput, notes,
        h('div', { class: 'row' }, act,
          h('button', { class: 'danger delete' + (armedNow ? ' armed' : ''), 'data-label': 'Delete', title: 'Click twice. Deleting can be undone.',
            onclick: (e) => armedDelete(t.id, e.currentTarget) }, armedNow ? 'Really?' : 'Delete')),
        st === 'blocked' ? h('div', { class: 'small' }, h('button', { class: 'link', onclick: () => setDone(t.id, true, true) }, 'Mark done anyway')) : null,
        coverSection(t), ...links,
        h('div', { class: 'muted small' }, `Created ${fmtDate(t.created_at)}` + (t.done_at && (m === 'tasks' || m === 'ideas') ? ` · ${m === 'tasks' ? 'Done' : 'Ticked'} ${fmtDate(t.done_at)}` : '')));
      if (armedNow) armed.btn = $('button.delete', panel);
      return;
    }
    const d = sel && sel.type === 'edge' ? state.deps.find((x) => x.from === sel.from && x.to === sel.to) : null;
    const a = d && state.tasks.get(d.from), b = d && state.tasks.get(d.to);
    if (d && a && b) {
      const pick = (key, label) => h('label', { class: 'side-pick' }, h('span', {}, label),
        h('select', { onchange: (e) => setDepSides(d, { [key]: e.target.value }) },
          ...SIDES.map((s) => h('option', { value: s, selected: (d[key] || (key === 'from_side' ? 'right' : 'left')) === s }, s))));
      const m = modeId();
      const ends = m === 'tasks' ? ['Must finish first', 'Then this can start'] : m === 'plan' ? ['The bigger part', 'Breaks into']
        : m === 'flow' ? ['After this', 'Comes this'] : ['These two go together', null];
      // The words on the link. Saved as you type; Yes and No are one click on a workflow.
      const labelInput = h('input', { type: 'text', class: 'label-input', maxlength: 40, value: d.label || '',
        placeholder: m === 'flow' ? 'Yes, No, on error…' : 'A word or two on the line',
        oninput: (e) => setDepLabel(d, e.target.value), onblur: flushLabel, onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } });
      const chip = (text) => h('button', { class: 'chip' + ((d.label || '') === text ? ' on' : ''), onclick: () => { setDepLabel(d, text); flushLabel(); renderPanel(); } }, text || 'None');
      setPanel(
        h('div', { class: 'panel-head' }, h('span', { class: 'badge' }, m === 'flow' ? 'Arrow' : 'Link'), h('span', { class: 'spacer' }), closeBtn),
        h('section', {}, h('h4', {}, ends[0]), h('ul', {}, taskRow(a), ends[1] ? null : taskRow(b))),
        ends[1] ? h('section', {}, h('h4', {}, ends[1]), h('ul', {}, taskRow(b))) : null,
        h('section', {}, h('h4', {}, 'Written on it'), labelInput,
          m === 'flow' ? h('div', { class: 'chips' }, chip('Yes'), chip('No'), chip('')) : null),
        h('section', {}, h('h4', {}, m === 'ideas' ? 'Line sides' : 'Arrow sides'),
          h('div', { class: 'sides' }, pick('from_side', 'Leaves the first card from its'), pick('to_side', 'Enters the second card at its'))),
        h('div', { class: 'row' }, h('button', { class: 'danger', onclick: () => deleteDep(d.from, d.to) }, 'Unlink')),
        h('div', { class: 'muted small' }, 'Drag a ● handle on any side of a card onto another card to make a new link; it attaches to the side you drop nearest to.'));
      return;
    }
    // Nothing selected: the board at a glance, as this mode reads it. On a phone in list mode
    // this is the whole screen.
    const m = modeId(), def = MODES[m];
    const stat = (n, word, cls) => h('div', { class: 'stat' + (cls ? ' ' + cls : '') }, h('b', {}, n), h('span', {}, word));
    const view = OVERVIEW[m]();
    setPanel(
      h('div', { class: 'panel-head' }, h('h3', {}, state.board ? state.board.name : 'Board'), inList() ? h('button', { class: 'primary', onclick: addAtCenter }, def.add) : closeBtn),
      h('button', { class: 'mode-line', title: 'What this board is for. Click to change.', onclick: (e) => pickMode(e.currentTarget) },
        h('span', { class: 'mode-ico' }, modeIcon(m)), h('b', {}, def.label), h('span', { class: 'muted' }, ' · change')),
      h('div', { class: 'stats' }, view.stats.map((s) => stat(...s))),
      ...view.sections,
      h('div', { class: 'tips' },
        h('div', {}, h('kbd', {}, 'N'), ` new ${def.one}, then just type its name · `, h('kbd', {}, 'A'), ' arrange · ', h('kbd', {}, 'F'), ' fit view'),
        h('div', {}, h('kbd', {}, 'Del'), ` twice removes the selected ${def.one} (`, h('kbd', {}, 'Ctrl+Z'), ' undoes) · ', h('kbd', {}, 'Enter'), ' rename · ', h('kbd', {}, 'Esc'), ' deselect'),
        h('div', {}, `Right-click a card, a link, or empty space for a menu · middle-click adds ${def.a} under the cursor.`),
        h('div', {}, 'Paste an image or a link (', h('kbd', {}, 'Ctrl+V'), `) to give the selected card a cover, or to make a new ${def.one} when nothing is selected.`),
        h('div', {}, def.rule)));
  }

  // ---------------------------------------------------------------- the board at a glance, per mode
  // Each returns { stats: [[number, word, class?] x3], sections: [elements] } for renderPanel.
  const byTitle = (a, b) => a.title.localeCompare(b.title);
  const listOf = (arr, empty, row = (x) => taskRow(x)) => (arr.length ? h('ul', {}, arr.map(row)) : h('div', { class: 'empty' }, empty));
  // Cards that sit next to each other on the canvas are read in the order they are laid out:
  // top to bottom when they are stacked, left to right when they are side by side.
  function inLayoutOrder(cards) {
    if (cards.length < 2) return cards;
    const xs = cards.map((t) => t.x), ys = cards.map((t) => t.y);
    const tall = Math.max(...ys) - Math.min(...ys) >= Math.max(...xs) - Math.min(...xs);
    return [...cards].sort((a, b) => (tall ? a.y - b.y || a.x - b.x : a.x - b.x || a.y - b.y));
  }
  const kidsOf = (id) => inLayoutOrder(outsOf(id).map((d) => state.tasks.get(d.to)).filter(Boolean));
  const looseCards = () => [...state.tasks.values()].filter((t) => !insOf(t.id).length && !outsOf(t.id).length);
  const topCards = () => inLayoutOrder([...state.tasks.values()].filter((t) => !insOf(t.id).length && outsOf(t.id).length));
  const copyBtn = (label, text) => h('button', { class: 'link', onclick: () => copyText(text()) }, label);
  const OVERVIEW = {
    tasks() {
      const tasks = [...state.tasks.values()], groups = { ready: [], blocked: [], done: [] };
      for (const x of tasks) groups[stateOf(x)].push(x);
      groups.ready.sort(byTitle); groups.blocked.sort(byTitle);
      groups.done.sort((a, b) => (b.done_at || '').localeCompare(a.done_at || ''));
      return { stats: [[groups.ready.length, 'ready', 'ready'], [groups.blocked.length, 'blocked'], [groups.done.length, 'done', 'done']], sections: [
        h('section', {}, h('h4', {}, 'Ready to start'), listOf(groups.ready, tasks.length ? 'Nothing is ready. Finish or unlink something.' : 'Add a task to get going.')),
        h('section', {}, h('h4', {}, 'Blocked'), listOf(groups.blocked, 'No blocked tasks.')),
        h('section', {}, h('h4', {}, 'Done'), listOf(groups.done, 'Nothing done yet.'))] };
    },
    // Piles first (a card with links going out, and what it holds), then the ideas on their own,
    // newest first. Ticked ideas sink to the end of their list.
    ideas() {
      const all = [...state.tasks.values()], ticked = all.filter((t) => t.status === 'done').length;
      const sink = (arr) => [...arr].sort((a, b) => (a.status === 'done') - (b.status === 'done'));
      const piles = [...all].filter((t) => outsOf(t.id).length).sort(byTitle);
      const alone = looseCards().sort((a, b) => b.id - a.id);
      const row = (x) => taskRow(x, x.cover && x.cover.kind === 'link' ? h('a', { class: 'out', href: x.cover.url, target: '_blank', rel: 'noopener', title: 'Open the link', onclick: (e) => e.stopPropagation() }, '↗') : null);
      return { stats: [[all.length, all.length === 1 ? 'idea' : 'ideas', 'ready'], [piles.length, piles.length === 1 ? 'pile' : 'piles'], [ticked, 'ticked', 'done']], sections: [
        ...piles.map((p) => { const kids = sink(kidsOf(p.id)); return h('section', {}, h('ul', {}, taskRow(p, h('span', { class: 'n' }, kids.length), { cls: 'head' }), kids.map(row))); }),
        h('section', {}, h('h4', {}, `On their own (${alone.length})`), listOf(sink(alone), all.length ? 'Every idea is in a pile.' : 'Paste a link or a picture, or add an idea, to start the pile.', row))] };
    },
    // The cards read as an outline: every top card, then what it breaks into, indented.
    plan() {
      const all = [...state.tasks.values()], tops = topCards(), loose = inLayoutOrder(looseCards());
      const rows = outline();
      const deepest = rows.reduce((mx, r) => Math.max(mx, r.depth + 1), 0);
      return { stats: [[all.length, all.length === 1 ? 'point' : 'points', 'ready'], [tops.length, 'at the top'], [deepest, deepest === 1 ? 'level' : 'levels']], sections: [
        h('section', {}, h('h4', {}, 'Outline', rows.length ? h('span', { class: 'h4-act' }, copyBtn('Copy as text', outlineText)) : null),
          rows.length ? h('ul', { class: 'outline' }, rows.map((r) => taskRow(r.t, null, { indent: r.depth, cls: 'lv' + Math.min(r.depth, 2) })))
            : h('div', { class: 'empty' }, all.length ? 'No card is under another yet. Drag a ● handle from a card onto the card that belongs under it.' : 'Add a point, then drag its ● handle onto the points that belong under it.')),
        loose.length ? h('section', {}, h('h4', {}, `Loose points (${loose.length})`), listOf(loose, '')) : null].filter(Boolean) };
    },
    // The flow walked from each start: steps numbered in the order you reach them, a fork's
    // branches indented under it with the word on their arrow, a loop shown as "↩ back to step n"
    // and two branches meeting as "→ joins step n".
    flow() {
      const all = [...state.tasks.values()], rows = walk(), loose = inLayoutOrder(looseCards());
      const roles = all.map(roleOf);
      const n = (r) => roles.filter((x) => x === r).length;
      const row = (r) => (r.back
        ? h('li', { class: 'clickable back', style: `margin-left:${r.depth * 16}px`, onclick: () => { select({ type: 'task', id: r.t.id }); if (!inList()) centerOn(r.t.id); } },
            r.via ? h('span', { class: 'via' }, r.via) : null, h('span', { class: 't' }, `${r.loop ? '↩ back to' : '→ joins'} step ${r.back}: ${r.t.title}`))
        : taskRow(r.t, null, { indent: r.depth, before: [h('span', { class: 'num' }, r.n), r.via ? h('span', { class: 'via' }, r.via) : null] }));
      return { stats: [[all.length, all.length === 1 ? 'step' : 'steps', 'ready'], [n('decision'), n('decision') === 1 ? 'decision' : 'decisions'], [n('end'), n('end') === 1 ? 'end' : 'ends', 'done']], sections: [
        h('section', {}, h('h4', {}, 'Step by step', rows.length ? h('span', { class: 'h4-act' }, copyBtn('Copy as text', flowText)) : null),
          rows.length ? h('ul', { class: 'outline' }, rows.map(row))
            : h('div', { class: 'empty' }, all.length ? 'No step leads to another yet. Drag a ● handle from a step onto the step that comes next.' : 'Add the first step, then drag its ● handle onto what comes next.')),
        loose.length ? h('section', {}, h('h4', {}, `Not connected (${loose.length})`), listOf(loose, '')) : null].filter(Boolean) };
    },
  };
  // An outline as rows { t, depth }: each top card, then its cards in layout order, depth first.
  // A card under two parents is listed under both; a card already on the way down is not repeated.
  function outline() {
    const rows = [];
    const down = (t, depth, path) => {
      rows.push({ t, depth });
      if (path.has(t.id)) return;
      path.add(t.id); for (const k of kidsOf(t.id)) down(k, depth + 1, path); path.delete(t.id);
    };
    for (const top of topCards()) down(top, 0, new Set());
    return rows;
  }
  // A workflow as rows { t, depth, n | back, loop, via }: `n` numbers a step the first time the
  // walk reaches it; `back` is that number when another arrow arrives there, with `loop` true if
  // the arrow returns to a step the walk is still inside (a retry) and false if two branches
  // simply meet; `via` is the word on the arrow in.
  function walk() {
    const rows = [], num = new Map(), inside = new Set();
    const go = (t, depth, via) => {
      if (num.has(t.id)) { rows.push({ t, depth, via, back: num.get(t.id), loop: inside.has(t.id) }); return; }
      num.set(t.id, num.size + 1); rows.push({ t, depth, via, n: num.size });
      const outs = outsOf(t.id).map((d) => ({ d, to: state.tasks.get(d.to) })).filter((x) => x.to);
      const order = inLayoutOrder(outs.map((x) => x.to));
      outs.sort((p, q) => order.indexOf(p.to) - order.indexOf(q.to));
      inside.add(t.id);
      for (const x of outs) go(x.to, depth + (outs.length > 1 ? 1 : 0), x.d.label || null);
      inside.delete(t.id);
    };
    for (const s of topCards()) go(s, 0, null);
    // steps that only sit on a loop (no start leads to them): begin at the top-left one
    for (const t of inLayoutOrder([...state.tasks.values()].filter((x) => outsOf(x.id).length || insOf(x.id).length))) if (!num.has(t.id)) go(t, 0, null);
    return rows;
  }
  // The outline and the walk as plain text (Markdown lists), for pasting into a doc or a prompt.
  const linkOf = (t) => (t.cover && t.cover.kind === 'link' ? ` <${t.cover.url}>` : '');
  function outlineText() {
    const lines = [`# ${state.board.name}`, ''];
    for (const r of outline()) lines.push(r.depth === 0 ? `\n## ${r.t.title}${linkOf(r.t)}` : `${'  '.repeat(r.depth - 1)}- ${r.t.title}${linkOf(r.t)}`);
    const loose = inLayoutOrder(looseCards());
    if (loose.length) lines.push('\n## Loose points', ...loose.map((t) => `- ${t.title}${linkOf(t)}`));
    return lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
  }
  function flowText() {
    const lines = [`# ${state.board.name}`, ''];
    for (const r of walk()) {
      const pad = '   '.repeat(r.depth), via = r.via ? `[${r.via}] ` : '';
      lines.push(r.back ? `${pad}   ${via}${r.loop ? 'back to' : 'joins'} step ${r.back} (${r.t.title})` : `${pad}${r.n}. ${via}${r.t.title}${roleOf(r.t) === 'decision' ? '  (decision)' : ''}`);
    }
    const loose = inLayoutOrder(looseCards());
    if (loose.length) lines.push('', 'Not connected:', ...loose.map((t) => `- ${t.title}`));
    return lines.join('\n') + '\n';
  }
  // Planflow is served over plain http on the home network, where navigator.clipboard does not
  // exist (and where it does, it can still say no): fall back to a hidden textarea and execCommand.
  async function copyText(text) {
    let ok = false;
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); ok = true; } } catch { /* try the old way */ }
    if (!ok) {
      const ta = h('textarea', { style: 'position:fixed;left:-9999px;top:0', readonly: '' }); ta.value = text;
      document.body.append(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    toast(ok ? `Copied ${text.split('\n').filter((l) => l.trim()).length} lines.` : 'Could not copy: the browser refused.');
  }

  // ---------------------------------------------------------------- undo
  // Deleting a task or a link pushes an entry here; Ctrl+Z or the toast's Undo button runs it.
  const undoStack = [];
  function pushUndo(entry) {
    undoStack.push(entry); if (undoStack.length > 30) undoStack.shift();
    toast(entry.label, { action: { label: 'Undo', run: () => runUndo(entry) }, ms: 7000 });
  }
  async function runUndo(entry) {
    const i = undoStack.lastIndexOf(entry); if (i < 0) return;   // already undone
    undoStack.splice(i, 1);
    try { await entry.run(); } catch (e) { toast('Undo failed: ' + e.message); }
  }
  function undoLast() {
    if (!undoStack.length) { toast('Nothing to undo.'); return; }
    runUndo(undoStack[undoStack.length - 1]);
  }

  // ---------------------------------------------------------------- two-click delete
  // The first click on a delete control turns it into "Really?"; a second click within ARM_MS
  // deletes. The armed task is remembered here so the panel button, the context menu and the
  // Delete key all share it. The board menu's Delete uses the same two clicks (`run` is then
  // deleteBoard); there is no browser confirm() anywhere.
  let armed = null;   // { id, btn, timer }
  const isArmed = (id) => !!armed && armed.id === id;
  function disarm() {
    if (!armed) return;
    clearTimeout(armed.timer);
    const b = armed.btn; armed = null;
    if (b && b.isConnected) { b.textContent = b.dataset.label || 'Delete'; b.classList.remove('armed'); }
  }
  function armedDelete(id, btn, run = deleteTask) {
    if (isArmed(id)) { run(id); return true; }
    disarm();
    armed = { id, btn, timer: setTimeout(disarm, ARM_MS) };
    if (btn) { btn.dataset.label = btn.dataset.label || btn.textContent; btn.textContent = 'Really?'; btn.classList.add('armed'); }
    return false;
  }

  // ---------------------------------------------------------------- mutations
  // opts: after (id to link from), title, notes, focus:false to leave the title alone.
  async function createTask(x, y, opts = {}) {
    pendingCreate++;
    try {
      const t = await api('POST', `/api/boards/${state.boardId}/tasks`, { title: opts.title || M().fresh, notes: opts.notes || '', x: Math.round(x), y: Math.round(y) });
      state.tasks.set(t.id, t);
      const el = makeNode(t); nodesLayer.appendChild(el); nodeEls.set(t.id, el);
      renderProgress();
      if (opts.after && state.tasks.has(opts.after)) await addDep(opts.after, t.id, { quiet: true });
      select({ type: 'task', id: t.id });
      if (opts.focus !== false) editTitle(t.id, { fresh: true });
      return t;
    } catch (e) { toast(e.message); return null; }
    finally { pendingCreate--; if (!pendingCreate) typeAhead = ''; }
  }
  function addAtCenter() { const p = centerSpot(); createTask(p.x, p.y); }
  async function setDone(id, done, force = false) {
    const t = state.tasks.get(id); if (!t) return;
    if (done && !force && stateOf(t) === 'blocked') {
      toast('Blocked by: ' + blockersOf(id).filter((b) => b.status !== 'done').map((b) => b.title).join(', '));
      return;
    }
    try {
      const nt = await api('PATCH', `/api/tasks/${id}`, { status: done ? 'done' : 'todo', force });
      Object.assign(t, nt);
      refreshNodes();
      if (done && modeId() === 'tasks') {
        const unlocked = dependentsOf(id).filter((d) => stateOf(d) === 'ready');
        if (unlocked.length) toast('Unlocked: ' + unlocked.map((d) => d.title).join(', '));
      }
    } catch (e) { toast(e.message); }
  }
  function removeTaskLocally(id) {
    if (editing && editing.id === id) editing = null;
    state.tasks.delete(id);
    state.deps = state.deps.filter((d) => d.from !== id && d.to !== id);
    nodeEls.get(id)?.remove(); nodeEls.delete(id);
    if (isSel('task', id)) state.selected = null;
    refreshNodes();
    if (isMobile() && !inList()) panel.classList.remove('open');
  }
  // Deletes are soft on the server (a week in the trash), so undo just asks for the task back.
  async function deleteTask(id) {
    const t = state.tasks.get(id); if (!t) return;
    disarm(); hideCtx();
    if (pendingSave && pendingSave.id === id) { clearTimeout(saveTimer); pendingSave = null; }
    try {
      await api('DELETE', `/api/tasks/${id}`);
      removeTaskLocally(id);
      pushUndo({ label: `Deleted "${t.title}"`, run: () => restoreTask(id) });
    } catch (e) { toast(e.message); }
  }
  async function restoreTask(id) {
    const r = await api('POST', `/api/tasks/${id}/restore`);
    if (r.task.board_id !== state.boardId) { toast(`Restored "${r.task.title}" on its own board.`); return; }
    state.tasks.set(r.task.id, r.task);
    for (const d of r.deps) if (!state.deps.some((x) => x.from === d.from && x.to === d.to)) state.deps.push(d);
    if (!nodeEls.has(r.task.id)) { const el = makeNode(r.task); nodesLayer.appendChild(el); nodeEls.set(r.task.id, el); }
    select({ type: 'task', id: r.task.id }); refreshNodes();
    toast(`Restored "${r.task.title}"`);
  }
  async function addDep(from, to, opts = {}) {
    if (from === to) return;
    const problem = linkProblem(from, to);
    if (problem) { toast(problem); return; }
    try {
      const fromSide = opts.fromSide || 'right', toSide = opts.toSide || 'left';
      const r = await api('POST', `/api/boards/${state.boardId}/deps`, { from, to, from_side: fromSide, to_side: toSide, label: opts.label || null });
      state.deps.push({ from, to, from_side: (r && r.from_side) || fromSide, to_side: (r && r.to_side) || toSide, label: (r && r.label) || null });
      refreshNodes();
      if (!opts.quiet) toast(M().linked(titleOf(from), titleOf(to)));
    } catch (e) { toast(e.message); }
  }
  // The words on a link: shown at once, saved a moment after the typing stops (and at once when
  // the field loses focus, the selection moves or the page closes).
  let pendingLabel = null, labelTimer;
  function setDepLabel(d, text) {
    if (pendingLabel && pendingLabel !== d) flushLabel();
    d.label = String(text).replace(/\s+/g, ' ').trim().slice(0, 40) || null;
    // On a workflow, words on an arrow make the card it leaves a decision (roleFrom): redraw that card first.
    const src = nodeEls.get(d.from), srcTask = state.tasks.get(d.from);
    if (src && srcTask) updateNode(src, srcTask);
    renderEdges();
    pendingLabel = d; clearTimeout(labelTimer); labelTimer = setTimeout(flushLabel, 500);
  }
  function flushLabel() {
    clearTimeout(labelTimer);
    if (!pendingLabel) return;
    const d = pendingLabel; pendingLabel = null;
    api('PATCH', `/api/deps/${d.from}/${d.to}`, { label: d.label || '' }).catch((e) => toast('Could not save the words on the link: ' + e.message));
  }
  function focusLabel() {
    const inp = $('.label-input', panel); if (!inp) return;
    if (isMobile()) panel.classList.add('open');
    inp.focus(); inp.select();
  }
  async function setDepSides(d, patch) {
    try {
      const r = await api('PATCH', `/api/deps/${d.from}/${d.to}`, patch);
      d.from_side = r.from_side; d.to_side = r.to_side;
      renderEdges();
    } catch (e) { toast(e.message); }
  }
  async function deleteDep(from, to) {
    const d = state.deps.find((x) => x.from === from && x.to === to);
    try {
      await api('DELETE', `/api/deps/${from}/${to}`);
      state.deps = state.deps.filter((x) => !(x.from === from && x.to === to));
      if (isSel('edge', { from, to })) state.selected = null;
      refreshNodes();
      if (d) pushUndo({ label: `Unlinked "${titleOf(from)}" → "${titleOf(to)}"`, run: () => addDep(from, to, { fromSide: d.from_side, toSide: d.to_side, label: d.label, quiet: true }) });
    } catch (e) { toast(e.message); }
  }
  // Delete key: links go at once (undoable); a task needs a second press, like the button.
  function deleteSelected() {
    const s = state.selected; if (!s) return;
    if (s.type === 'edge') { deleteDep(s.from, s.to); return; }
    if (!state.tasks.has(s.id)) return;
    if (!armedDelete(s.id, $('button.delete', panel))) toast(`Press Delete again to remove "${titleOf(s.id)}"`);
  }

  // ---------------------------------------------------------------- covers (pasted images and links)
  // Shrink a pasted image in the browser so a phone screenshot does not become a 5 MB row.
  async function shrinkImage(file) {
    const bmp = await createImageBitmap(file).catch(() => null);
    if (!bmp) return { blob: file, width: null, height: null };
    const s = Math.min(1, IMAGE_MAX_PX / Math.max(bmp.width, bmp.height));
    const width = Math.max(1, Math.round(bmp.width * s)), height = Math.max(1, Math.round(bmp.height * s));
    if (s === 1 && file.size < 400 * 1024 && file.type !== 'image/svg+xml') { bmp.close(); return { blob: file, width, height }; }
    const c = document.createElement('canvas'); c.width = width; c.height = height;
    c.getContext('2d').drawImage(bmp, 0, 0, width, height); bmp.close();
    let blob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.85));
    if (!blob || blob.type !== 'image/webp') blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    return { blob: blob || file, width, height };
  }
  // A pasted image usually has no useful name ("image.png"); a chosen file does.
  const imageName = (file) => (file.name && !/^(image|blob|unknown|clipboard|pasted)[-_ ]?\w*\.\w+$/i.test(file.name) ? file.name.replace(/\.\w+$/, '') : '');
  // Merge a task the server sent back, but keep a title/notes edit that has not been saved yet.
  function applyTask(nt) {
    const t = state.tasks.get(nt.id); if (!t) return;
    const keep = pendingSave && pendingSave.id === t.id ? { title: t.title, notes: t.notes } : {};
    if (editing && editing.id === t.id) keep.title = t.title;
    Object.assign(t, nt, keep);
    const el = nodeEls.get(t.id); if (el) updateNode(el, t);
    renderEdges(); if (isSel('task', t.id)) renderPanel();
  }
  async function setImageCover(id, file) {
    const t = state.tasks.get(id); if (!t) return;
    try {
      const { blob, width, height } = await shrinkImage(file);
      const qs = new URLSearchParams();
      const name = imageName(file); if (name) qs.set('name', name);
      if (width && height) { qs.set('w', width); qs.set('h', height); }
      applyTask(await api('POST', `/api/tasks/${id}/cover?${qs}`, blob));
    } catch (e) { toast('Could not add the image: ' + e.message); }
  }
  // rename: also take the page's title as the task title (new cards made by pasting a link).
  async function setLinkCover(id, url, rename) {
    const t = state.tasks.get(id); if (!t) return;
    const before = t.cover;
    t.cover = { kind: 'link', url, site: hostOf(url), pending: true, v: 0 };   // show the card right away
    const el = nodeEls.get(id); if (el) updateNode(el, t); renderEdges(); if (isSel('task', id)) renderPanel();
    try { applyTask(await api('POST', `/api/tasks/${id}/cover`, { url, rename: !!rename })); }
    catch (e) { t.cover = before; if (el) updateNode(el, t); renderEdges(); toast('Could not add the link: ' + e.message); }
  }
  async function removeCover(id) {
    try { applyTask(await api('DELETE', `/api/tasks/${id}/cover`)); } catch (e) { toast(e.message); }
  }
  // A pasted or dropped image / link becomes the cover of task `into`, else of the selected
  // task, else of a new task (at world point `at`, or in the middle of the view).
  async function addCover({ file, url, into, at }) {
    let t = into != null ? state.tasks.get(into) : null;
    if (!t && state.selected && state.selected.type === 'task') t = state.tasks.get(state.selected.id);
    const fresh = !t;
    if (fresh) {
      const p = at ? { x: at.x - NODE_W / 2, y: at.y - 24 } : centerSpot();
      t = await createTask(p.x, p.y, { title: file ? (imageName(file) || 'Image') : hostOf(url), focus: false });
      if (!t) return;
    }
    if (file) { await setImageCover(t.id, file); if (!fresh) toast(`Image added to "${t.title}"`); }
    else if (url) { await setLinkCover(t.id, url, fresh); if (!fresh) toast(`Link added to "${t.title}"`); }
  }
  // Plain text pasted on the canvas: a new card, first line as the title, the rest as notes.
  function pasteText(text, at) {
    const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const p = at ? { x: at.x - NODE_W / 2, y: at.y - 24 } : centerSpot();
    createTask(p.x, p.y, { title: lines[0].slice(0, 300), notes: lines.slice(1).join('\n'), focus: false });
  }
  const imageIn = (dt) => [...(dt.files || [])].find((f) => f.type.startsWith('image/')) || null;
  document.addEventListener('paste', (e) => {
    const cd = e.clipboardData; if (!cd || !state.boardId) return;
    const file = imageIn(cd);
    if (file) { e.preventDefault(); addCover({ file }); return; }
    const text = cd.getData('text/plain');
    if (editing && e.target === editing.el) {       // into a card title: plain text, one line
      e.preventDefault(); document.execCommand('insertText', false, text.replace(/\s*\n\s*/g, ' '));
      return;
    }
    if (e.target.matches?.('input, textarea') || e.target.isContentEditable || !text.trim()) return;
    e.preventDefault();
    const url = urlIn(text);
    if (url) addCover({ url }); else pasteText(text);
  });
  // Dropping an image file or a link on the canvas does the same; on a card it goes to that card.
  const droppable = (dt) => dt && [...dt.types].some((t) => t === 'Files' || t === 'text/uri-list' || t === 'text/plain');
  viewport.addEventListener('dragover', (e) => { if (droppable(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  viewport.addEventListener('drop', (e) => {
    const dt = e.dataTransfer; if (!dt || !state.boardId) return;
    const file = imageIn(dt);
    const uri = (dt.getData('text/uri-list') || '').split('\n').find((l) => l.trim() && !l.startsWith('#'));
    const url = urlIn(uri) || urlIn(dt.getData('text/plain'));
    if (!file && !url) return;
    e.preventDefault();
    const node = nodeAtPoint(e.clientX, e.clientY);
    addCover({ file, url, into: node ? +node.dataset.id : null, at: clientToWorld(e.clientX, e.clientY) });
  });

  // ---------------------------------------------------------------- auto arrange
  async function arrange() {
    const all = [...state.tasks.values()]; if (!all.length) return;
    graphCache = null;
    // On an ideas board the cards with no links are a pile, not a column: they are packed into a
    // block under the linked ones (step 5). Everywhere else every card takes part in the columns.
    const pile = modeId() === 'ideas' ? all.filter((t) => !insOf(t.id).length && !outsOf(t.id).length) : [];
    const tasks = pile.length ? all.filter((t) => !pile.includes(t)) : all;
    // 1. Column = longest chain of blockers behind the task.
    const layer = new Map();
    const depth = (id, stack) => {
      if (layer.has(id)) return layer.get(id);
      if (stack.has(id)) return 0;
      stack.add(id);
      const bs = blockersOf(id);
      const d = bs.length ? 1 + Math.max(...bs.map((b) => depth(b.id, stack))) : 0;
      stack.delete(id); layer.set(id, d);
      return d;
    };
    for (const t of tasks) depth(t.id, new Set());
    const GAP_X = 90, GAP_Y = 28, X0 = 40, Y0 = 40;
    const hOf = (t) => nodeEls.get(t.id).offsetHeight;
    // 2. Items per column: the real cards plus zero-height "lane" items for every link that
    //    skips a column, so such a link gets free space instead of running under a card.
    const cols = [], items = new Map();
    const add = (it) => { items.set(it.key, it); (cols[it.col] ||= []).push(it); return it; };
    for (const t of tasks) add({ key: 't' + t.id, task: t, h: hOf(t), col: layer.get(t.id), preds: [] });
    let lanes = 0;
    for (const d of state.deps) {
      const u = items.get('t' + d.from), v = items.get('t' + d.to); if (!u || !v) continue;
      let prev = u;
      for (let c = u.col + 1; c < v.col; c++) prev = add({ key: 'l' + lanes++, lane: true, h: 0, col: c, preds: [prev.key] });
      if (u.col < v.col) v.preds.push(prev.key);   // an arrow that loops back (workflow, ideas) does not pull its target
    }
    // 3. Place column by column. Each item wants to sit level with the average centre of the
    //    items it follows (all in earlier columns); items are stacked in that order without
    //    overlapping. Lanes sort before cards on ties so a skipping link passes above the card.
    const centre = (it) => it.y + it.h / 2;
    cols.forEach((col, ci) => {
      for (const it of col) {
        const ps = it.preds.map((k) => items.get(k));
        it.bary = ps.length ? ps.reduce((sum, p) => sum + centre(p), 0) / ps.length : 0;
      }
      col.sort((p, q) => (p.bary - q.bary) || ((p.lane ? 0 : 1) - (q.lane ? 0 : 1)) || ((p.task ? p.task.id : 0) - (q.task ? q.task.id : 0)));
      let bottom = null;
      for (const it of col) {
        const want = ci === 0 ? (bottom === null ? Y0 : bottom + GAP_Y) : it.bary - it.h / 2;
        it.y = bottom === null ? want : Math.max(want, bottom + GAP_Y);
        bottom = it.y + it.h;
      }
    });
    const positions = [];
    for (const it of items.values()) if (it.task) positions.push({ id: it.task.id, x: X0 + it.col * (NODE_W + GAP_X), y: Math.round(it.y) });
    // 5. The pile (ideas board): a block of columns, each card on the shortest column so far,
    //    oldest first, so pictures of different heights pack without gaps.
    if (pile.length) {
      const top = positions.length ? Math.max(...[...items.values()].filter((it) => it.task).map((it) => it.y + it.h)) + 70 : Y0;
      const bottoms = new Array(Math.min(pile.length, Math.max(3, Math.round(Math.sqrt(pile.length * 1.8))))).fill(top);
      for (const t of pile.sort((a, b) => a.id - b.id)) {
        const c = bottoms.indexOf(Math.min(...bottoms));
        positions.push({ id: t.id, x: X0 + c * (NODE_W + 36), y: Math.round(bottoms[c]) });
        bottoms[c] += hOf(t) + GAP_Y;
      }
    }
    // 4. Animate into place, then save.
    nodesLayer.classList.add('animate');
    for (const p of positions) {
      const t = state.tasks.get(p.id); t.x = p.x; t.y = p.y;
      const el = nodeEls.get(p.id); el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
    }
    const start = performance.now();
    const tick = () => { renderEdges(); if (performance.now() - start < 340) requestAnimationFrame(tick); else { nodesLayer.classList.remove('animate'); renderEdges(); } };
    requestAnimationFrame(tick);
    fitView(true);
    try { await api('POST', `/api/boards/${state.boardId}/positions`, { positions }); } catch (e) { toast(e.message); }
  }

  // ---------------------------------------------------------------- pointer gestures
  function setDropTarget(el, ok, side) {
    for (const n of nodesLayer.querySelectorAll('.drop-target, .drop-bad')) n.classList.remove('drop-target', 'drop-bad');
    for (const p of nodesLayer.querySelectorAll('.port.hot')) p.classList.remove('hot');
    if (el) el.classList.add(ok ? 'drop-target' : 'drop-bad');
    if (el && ok && side) { const p = el.querySelector('.port.' + side); if (p) p.classList.add('hot'); }
  }
  function nodeAtPoint(cx, cy) {
    const el = document.elementFromPoint(cx, cy);
    return el ? el.closest('.node') : null;
  }
  function startPinch() {
    if (gesture && gesture.type === 'node') finishNodeDrag(gesture);
    const [a, b] = [...pointers.values()];
    gesture = { type: 'pinch', ids: [...pointers.keys()], d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)),
      mid0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view0: { ...state.view } };
    setDropTarget(null); renderEdges();
  }
  function finishNodeDrag(g) {
    const el = nodeEls.get(g.id); el?.classList.remove('dragging');
    const t = state.tasks.get(g.id); if (!t) return;
    if (!g.moved) {
      select({ type: 'task', id: g.id });
      if (g.link) window.open(g.link, '_blank', 'noopener');   // a click on a link cover's text opens the page
      return;
    }
    t.x = Math.round(t.x); t.y = Math.round(t.y);
    updateNode(el, t); renderEdges();
    api('PATCH', `/api/tasks/${t.id}`, { x: t.x, y: t.y }).catch((e) => toast('Could not save position: ' + e.message));
  }
  viewport.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
    if (e.target.closest('.check, #edgeUnlink')) return;         // handled by click
    if (e.target.isContentEditable) return;                      // typing a title on the card: let the browser place the caret
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { viewport.setPointerCapture(e.pointerId); } catch {}
    if (pointers.size === 2 && e.pointerType === 'touch') { startPinch(); return; }
    if (pointers.size > 1) return;
    boardMenu.hidden = true; hideCtx();
    const nodeEl = e.target.closest('.node');
    const hit = e.target.closest('.edge-hit');
    const base = { pid: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false };
    if (e.button === 1) {                                          // middle: drag pans, click adds a task
      gesture = { ...base, type: 'pan', ox: state.view.x, oy: state.view.y, middle: true };
      viewport.classList.add('panning');
    } else if (nodeEl && e.target.closest('.port')) {
      gesture = { ...base, type: 'link', from: +nodeEl.dataset.id, fromSide: e.target.closest('.port').dataset.side || 'right',
        cur: null, target: null, targetSide: null };
    } else if (nodeEl) {
      const t = state.tasks.get(+nodeEl.dataset.id);
      const link = e.target.closest('.link-meta') && t.cover && t.cover.kind === 'link' ? t.cover.url : null;
      gesture = { ...base, type: 'node', id: t.id, ox: t.x, oy: t.y, link };
      nodeEl.classList.add('dragging');
    } else if (hit) {
      gesture = { ...base, type: 'edge', from: +hit.dataset.from, to: +hit.dataset.to };
    } else {
      gesture = { ...base, type: 'pan', ox: state.view.x, oy: state.view.y };
      viewport.classList.add('panning');
    }
  });
  // Link handles stay hidden until the mouse comes within NEAR_PX of a card (touch users
  // see them on the selected card instead). Screen pixels, so it feels the same at any zoom.
  const NEAR_PX = 28;
  let nearPoint = null, nearRaf = null;
  function updateNear() {
    nearRaf = null;
    const pad = NEAR_PX / state.view.s;
    for (const [id, el] of nodeEls) {
      const t = state.tasks.get(id);
      const near = !!nearPoint && nearPoint.x >= t.x - pad && nearPoint.x <= t.x + el.offsetWidth + pad
        && nearPoint.y >= t.y - pad && nearPoint.y <= t.y + el.offsetHeight + pad;
      el.classList.toggle('near', near);
    }
  }
  const scheduleNear = () => { if (!nearRaf) nearRaf = requestAnimationFrame(updateNear); };
  viewport.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    nearPoint = clientToWorld(e.clientX, e.clientY); scheduleNear();
  });
  viewport.addEventListener('pointerleave', () => { nearPoint = null; scheduleNear(); });

  viewport.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId); if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    if (!gesture) return;
    if (gesture.type === 'pinch') {
      const a = pointers.get(gesture.ids[0]), b = pointers.get(gesture.ids[1]); if (!a || !b) return;
      const d = Math.hypot(a.x - b.x, a.y - b.y), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const s = clamp(gesture.view0.s * d / gesture.d0, MIN_S, MAX_S);
      const r = viewport.getBoundingClientRect();
      const w = { x: (gesture.mid0.x - r.left - gesture.view0.x) / gesture.view0.s, y: (gesture.mid0.y - r.top - gesture.view0.y) / gesture.view0.s };
      state.view = { s, x: mid.x - r.left - w.x * s, y: mid.y - r.top - w.y * s };
      applyView();
      return;
    }
    if (e.pointerId !== gesture.pid) return;
    const dx = e.clientX - gesture.sx, dy = e.clientY - gesture.sy;
    if (!gesture.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) gesture.moved = true;
    if (!gesture.moved) return;
    switch (gesture.type) {
      case 'pan':
        state.view.x = gesture.ox + dx; state.view.y = gesture.oy + dy; applyView(); break;
      case 'node': {
        const t = state.tasks.get(gesture.id); if (!t) break;
        t.x = gesture.ox + dx / state.view.s; t.y = gesture.oy + dy / state.view.s;
        const el = nodeEls.get(t.id); el.style.left = t.x + 'px'; el.style.top = t.y + 'px';
        renderEdges(); break;
      }
      case 'link': {
        gesture.cur = clientToWorld(e.clientX, e.clientY);
        const target = nodeAtPoint(e.clientX, e.clientY);
        const tid = target ? +target.dataset.id : null;
        const ok = !!target && !linkProblem(gesture.from, tid);
        gesture.target = ok ? tid : null;
        gesture.targetSide = ok ? nearestSide(tid, gesture.cur) : null;
        renderEdges();
        setDropTarget(target && tid !== gesture.from ? target : null, ok, gesture.targetSide);
        break;
      }
    }
  });
  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (!gesture) return;
    if (gesture.type === 'pinch') { if (pointers.size < 2) gesture = null; return; }
    if (e.pointerId !== gesture.pid) return;
    const g = gesture; gesture = null;
    viewport.classList.remove('panning');
    switch (g.type) {
      case 'pan':
        if (g.moved) break;
        if (g.middle) { const w = clientToWorld(e.clientX, e.clientY); createTask(w.x - NODE_W / 2, w.y - 24); }
        else select(null);
        break;
      case 'edge': select({ type: 'edge', from: g.from, to: g.to }); break;
      case 'node': finishNodeDrag(g); break;
      case 'link': {
        setDropTarget(null);
        const target = e.type === 'pointercancel' ? null : nodeAtPoint(e.clientX, e.clientY);
        renderEdges();
        if (target) {
          const tid = +target.dataset.id;
          addDep(g.from, tid, { fromSide: g.fromSide, toSide: nearestSide(tid, clientToWorld(e.clientX, e.clientY)) });
        }
        else if (g.moved) toast('Drop onto a task to link it.');
        else select({ type: 'task', id: g.from });
        break;
      }
    }
  }
  viewport.addEventListener('pointerup', endPointer);
  viewport.addEventListener('pointercancel', endPointer);
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault(); hideCtx();
    const dy = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    zoomAt(e.clientX, e.clientY, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018)));
  }, { passive: false });
  viewport.addEventListener('dblclick', (e) => {
    // Pointer capture makes the browser deliver this to the viewport, so look under the pointer, not at e.target.
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const hit = under && under.closest('.edge-hit');
    if (hit) { select({ type: 'edge', from: +hit.dataset.from, to: +hit.dataset.to }); focusLabel(); return; }   // double-click a link: write on it
    if (!under || under.closest('#edgeUnlink, .check, .port') || under.isContentEditable) return;
    const nodeEl = under.closest('.node');
    if (nodeEl) { editTitle(+nodeEl.dataset.id); return; }   // double-click a card: rename it there
    const w = clientToWorld(e.clientX, e.clientY);
    createTask(w.x - NODE_W / 2, w.y - 24);
  });
  nodesLayer.addEventListener('click', (e) => {
    const c = e.target.closest('.check'); if (!c) return;
    const id = +c.closest('.node').dataset.id, t = state.tasks.get(id);
    if (t) setDone(id, t.status !== 'done');
  });
  // The Unlink button appears on the middle of a link the moment it is selected, so the second
  // click of a double-click can land on it. That click means "write on it", not "unlink".
  edgeUnlink.addEventListener('click', () => {
    const s = state.selected; if (!s || s.type !== 'edge') return;
    if (performance.now() - edgePickedAt < 450) { focusLabel(); return; }
    deleteDep(s.from, s.to);
  });

  // ---------------------------------------------------------------- context menu (right click / long press)
  const ctxMenu = h('div', { class: 'menu ctx', hidden: true });
  document.body.appendChild(ctxMenu);
  function hideCtx() { ctxMenu.hidden = true; }
  // An item with `arm: taskId` is a two-click delete: the first click relabels it "Really?".
  function showCtx(items, cx, cy) {
    showMenuEls(items.map((it) => {
      if (it === '-') return h('div', { class: 'sep' });
      const btn = h('button', { class: it.danger ? 'danger' : '', disabled: !!it.disabled, title: it.title }, it.label);
      btn.addEventListener('click', () => { if (it.arm) { armedDelete(it.arm, btn, it.run || deleteTask); return; } hideCtx(); it.run(); });
      return btn;
    }), cx, cy);
  }
  // The menu with any elements in it, kept on screen. A menu opened by a click must survive that
  // same click reaching the document (which closes menus): ctxOpenedNow is true until it has.
  let ctxOpenedNow = false;
  function showMenuEls(els, cx, cy) {
    ctxMenu.replaceChildren(...els);
    ctxMenu.hidden = false;
    ctxMenu.style.left = Math.max(4, Math.min(cx, window.innerWidth - ctxMenu.offsetWidth - 4)) + 'px';
    ctxMenu.style.top = Math.max(4, Math.min(cy, window.innerHeight - ctxMenu.offsetHeight - 4)) + 'px';
    ctxOpenedNow = true; setTimeout(() => { ctxOpenedNow = false; }, 0);
  }

  // ---------------------------------------------------------------- mode menu
  // The four modes with a line about each: to say what a board is for (pickMode, from the top
  // bar, the panel or the board menu) or what a new plan will be (newBoard).
  function showModeMenu(at, title, current, onPick) {
    const r = at.getBoundingClientRect();
    showMenuEls([h('div', { class: 'menu-title' }, title), ...MODE_IDS.map((id) => h('button', { class: 'mode-item' + (id === current ? ' current' : ''), 'data-mode': id,
      onclick: () => { hideCtx(); onPick(id); } },
      h('span', { class: 'mode-ico' }, modeIcon(id)), h('span', { class: 'mi-name' }, MODES[id].label), h('span', { class: 'mi-now' }, id === current ? 'now' : ''),
      h('span', { class: 'mi-about' }, MODES[id].about)))], r.left, r.bottom + 6);
  }
  function pickMode(at) { if (state.boardId && !state.home) showModeMenu(at, 'This board is for', modeId(), (id) => setMode(id)); }
  // Switch what the open board is for. Nothing on the board changes, only how it is read, so the
  // toast's Undo (or Ctrl+Z) is a switch back. A board whose links loop cannot become a tasks
  // board or an outline: the server says which cards are in the circle and one of those links
  // is selected so it can be unlinked.
  async function setMode(mode, opts = {}) {
    const was = modeId(); if (mode === was || !state.boardId) return;
    flushSave(); flushLabel(); endEdit();
    try {
      const b = await api('PATCH', `/api/boards/${state.boardId}`, { mode });
      state.board.mode = b.mode;
      const listed = boardOf(state.boardId); if (listed) listed.mode = b.mode;
      applyMode(); renderAll();
      if (opts.quiet) toast(`Back to ${MODES[b.mode].label}.`);
      else pushUndo({ label: `${MODES[b.mode].label} board now. ${MODES[b.mode].switched}`, run: () => setMode(was, { quiet: true }) });
    } catch (e) {
      toast(e.message, { ms: 9000 });
      const loop = e.data && e.data.loop;
      if (loop && loop.length > 1 && state.deps.some((d) => d.from === loop[0] && d.to === loop[1])) { select({ type: 'edge', from: loop[0], to: loop[1] }); centerOn(loop[0]); }
    }
  }
  function cancelGesture() {
    if (!gesture) return;
    if (gesture.type === 'node') nodeEls.get(gesture.id)?.classList.remove('dragging');
    if (gesture.type === 'link') setDropTarget(null);
    gesture = null; pointers.clear();
    viewport.classList.remove('panning');
    renderEdges();
  }
  viewport.addEventListener('contextmenu', (e) => {
    if (e.target.isContentEditable) return;                     // the browser's own menu (paste, spelling) while typing a title
    e.preventDefault();
    if (e.target.closest('#edgeUnlink')) return;
    cancelGesture();
    boardMenu.hidden = true;
    const nodeEl = e.target.closest('.node');
    const hit = e.target.closest('.edge-hit');
    if (nodeEl) {
      const id = +nodeEl.dataset.id, t = state.tasks.get(id); if (!t) return;
      select({ type: 'task', id });
      const st = stateOf(t), m = modeId(), def = MODES[m];
      showCtx([
        m === 'tasks' ? (st === 'done' ? { label: 'Reopen', run: () => setDone(id, false) }
          : st === 'blocked' ? { label: 'Mark done anyway', title: 'It still waits for unfinished tasks', run: () => setDone(id, true, true) }
          : { label: 'Mark done', run: () => setDone(id, true) })
          : m === 'ideas' ? (st === 'done' ? { label: 'Untick', run: () => setDone(id, false) }
            : { label: 'Tick off', title: 'Watched, bought, used: done with it. Nothing waits for a tick.', run: () => setDone(id, true) })
          : null,
        { label: 'Rename', run: () => editTitle(id) },
        { label: def.next, title: def.nextTitle, run: () => createTask(t.x + NODE_W + 90, t.y, { after: id }) },
        t.cover && t.cover.kind === 'link' ? { label: 'Open link ↗', run: () => window.open(t.cover.url, '_blank', 'noopener') } : null,
        t.cover ? { label: 'Remove cover', run: () => removeCover(id) } : null,
        '-',
        { label: `Delete ${def.one}`, danger: true, arm: id, title: 'Click twice. Can be undone with Ctrl+Z.' },
      ].filter(Boolean), e.clientX, e.clientY);
    } else if (hit) {
      const from = +hit.dataset.from, to = +hit.dataset.to;
      select({ type: 'edge', from, to });
      const d = state.deps.find((x) => x.from === from && x.to === to);
      const put = (text) => () => { if (d) { setDepLabel(d, text); flushLabel(); renderPanel(); } };
      showCtx([
        { label: d && d.label ? 'Change the words on it…' : 'Write on it…', run: focusLabel },
        ...(modeId() === 'flow' ? [{ label: 'Yes', run: put('Yes') }, { label: 'No', run: put('No') }] : []),
        d && d.label ? { label: 'Take the words off', run: put('') } : null,
        '-',
        { label: 'Unlink', danger: true, run: () => deleteDep(from, to) },
      ].filter(Boolean), e.clientX, e.clientY);
    } else {
      const w = clientToWorld(e.clientX, e.clientY);
      showCtx([
        { label: `Add ${MODES[modeId()].one} here`, run: () => createTask(w.x - NODE_W / 2, w.y - 24) },
        '-',
        { label: 'Arrange', run: arrange },
        { label: 'Fit view', run: () => fitView(true) },
        undoStack.length ? { label: 'Undo: ' + undoStack[undoStack.length - 1].label, run: undoLast } : null,
      ].filter(Boolean), e.clientX, e.clientY);
    }
  });
  // Stop the browser's middle-click autoscroll / paste so middle-click can mean "new task".
  viewport.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  viewport.addEventListener('auxclick', (e) => e.preventDefault());

  // ---------------------------------------------------------------- keyboard
  document.addEventListener('keydown', (e) => {
    const inField = e.target.matches('input, textarea, select') || e.target.isContentEditable;
    if (inField) { if (e.key === 'Escape') e.target.blur(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undoLast(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (state.home) {
      if (e.key === 'Escape') { closeDrawer(); hideCtx(); disarm(); }
      else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); newBoard(); }
      return;
    }
    if (pendingCreate) {                    // a card is on its way: what is typed now becomes its title
      if (e.key.length === 1) { typeAhead += e.key; e.preventDefault(); }
      return;
    }
    switch (e.key) {
      case 'Escape': select(null); closeBoardMenu(); hideCtx(); disarm(); break;
      case 'Delete': case 'Backspace': e.preventDefault(); deleteSelected(); break;
      case 'Enter': if (state.selected && state.selected.type === 'task') { e.preventDefault(); editTitle(state.selected.id); } break;
      case 'n': case 'N': e.preventDefault(); addAtCenter(); break;
      case 'f': case 'F': fitView(true); break;
      case 'a': case 'A': arrange(); break;
    }
  });

  // ---------------------------------------------------------------- boards
  const boardOf = (id) => state.boards.find((b) => b.id === id) || null;
  // Archived boards live in the home page's archive box, not in the switcher (unless one is open).
  function renderBoards() {
    boardSelect.replaceChildren(...state.boards.filter((b) => !b.archived_at || b.id === state.boardId)
      .map((b) => h('option', { value: b.id, selected: b.id === state.boardId }, b.name)));
  }
  async function loadBoards() { state.boards = await api('GET', '/api/boards'); renderBoards(); }
  // Where you are is in the hash: #/ is the home page, #/board/<id> a board. Changing it is how
  // the app navigates (goHome / goBoard), so the back button and bookmarks work.
  function route() {
    const m = location.hash.match(/^#\/board\/(\d+)$/);
    if (m) openBoard(+m[1]).catch((e) => { toast(e.message); goHome(); });
    else showHome();
  }
  function goHome() { if (location.hash === '#/' || location.hash === '') { showHome(); } else location.hash = '#/'; }
  function goBoard(id) { const hh = '#/board/' + id; if (location.hash === hh) route(); else location.hash = hh; }
  async function openBoard(id, keepView = false) {
    flushSave(); flushLabel();
    const data = await api('GET', `/api/boards/${id}`);
    if (state.boardId !== id) { undoStack.length = 0; disarm(); }
    leaveHome();
    document.title = data.board.name + ' · Planflow';
    state.boardId = id; state.board = data.board;
    applyMode();
    state.tasks = new Map(data.tasks.map((t) => [t.id, t]));
    state.deps = data.deps;
    if (state.selected && state.selected.type === 'task' && !state.tasks.has(state.selected.id)) state.selected = null;
    if (state.selected && state.selected.type === 'edge' && !state.deps.some((d) => isSel('edge', d))) state.selected = null;
    if (!keepView) state.selected = null;
    store.set('planflow.board', id);
    renderBoards(); renderAll();
    if (keepView) return;
    const v = store.get('planflow.view.' + id);
    if (v && typeof v.s === 'number') { state.view = v; applyView(); } else fitView(false);
  }
  // A new plan starts with one question, what it is for (the mode menu, under `at` or under the
  // button that makes plans), then its name.
  function newBoard(at) {
    showModeMenu(at && at.getBoundingClientRect ? at : $(state.home ? '#btnNewBoard' : '#btnBoardMenu'), 'What is the new plan for?', null, createBoard);
  }
  async function createBoard(mode) {
    const name = prompt('Plan name', MODES[mode].boardName); if (!name || !name.trim()) return;
    try { const b = await api('POST', '/api/boards', { name: name.trim(), mode }); await loadBoards(); goBoard(b.id); } catch (e) { toast(e.message); }
  }
  async function renameBoard(id = state.boardId) {
    const b = boardOf(id); if (!b) return;
    const name = prompt('Rename plan', b.name); if (!name || !name.trim() || name.trim() === b.name) return;
    try {
      await api('PATCH', `/api/boards/${id}`, { name: name.trim() }); await loadBoards();
      if (state.board && state.board.id === id) { state.board.name = name.trim(); document.title = name.trim() + ' · Planflow'; renderPanel(); }
      if (state.home) await renderHome();
    } catch (e) { toast(e.message); }
  }
  // A board is deleted for good (unlike a task). From the board menu it is the open board and
  // the second click on Delete board (see armedDelete) lands here; the home page calls deletePlan.
  async function deleteBoard() {
    disarm(); boardMenu.hidden = true;
    try { await deletePlan(state.boardId); goHome(); } catch (e) { toast(e.message); }
  }
  async function deletePlan(id) {
    const b = boardOf(id);
    disarm(); hideCtx();
    await api('DELETE', `/api/boards/${id}`);
    if (state.boardId === id) { state.boardId = null; state.board = null; }
    await loadBoards();
    if (state.home) await renderHome();
    toast(`Deleted "${b ? b.name : 'plan'}"`);
  }
  // Into the archive box (on = true) or back out of it. Archiving is undoable from the toast / Ctrl+Z.
  async function archiveBoard(id, on = true) {
    const b = boardOf(id);
    try {
      await api('PATCH', `/api/boards/${id}`, { archived: on });
      await loadBoards();
      if (state.home) await renderHome();
      if (on) pushUndo({ label: `Archived "${b ? b.name : 'plan'}"`, run: () => archiveBoard(id, false) });
      else toast(`"${b ? b.name : 'Plan'}" is back.`);
    } catch (e) { toast(e.message); }
  }
  boardSelect.addEventListener('change', () => goBoard(+boardSelect.value));
  const boardArmId = () => 'board:' + state.boardId;
  function closeBoardMenu() { boardMenu.hidden = true; if (isArmed(boardArmId())) disarm(); }
  $('#btnBoardMenu').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!boardMenu.hidden) { closeBoardMenu(); return; }
    const r = e.currentTarget.getBoundingClientRect();
    boardMenu.style.left = Math.min(r.left, window.innerWidth - 190) + 'px'; boardMenu.style.top = (r.bottom + 6) + 'px';
    boardMenu.hidden = false;
  });
  boardMenu.addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'delete') {
      // The menu stays open, the item red, for the second click.
      if (!armedDelete(boardArmId(), btn, deleteBoard)) toast(`Press Delete board again to delete "${state.board.name}" and its ${count(state.tasks.size, M())}. This cannot be undone.`, { ms: ARM_MS });
      return;
    }
    closeBoardMenu();
    if (act === 'new') newBoard(); else if (act === 'rename') renameBoard();
    else if (act === 'mode') pickMode($('#btnBoardMenu'));
    else if (act === 'archive') archiveBoard(state.boardId).then(goHome);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#boardMenu, #btnBoardMenu')) closeBoardMenu();
    if (!ctxOpenedNow && !e.target.closest('.menu.ctx')) hideCtx();
    if (!e.target.closest('#archiveDrawer, #archiveBox')) closeDrawer();
  });
  window.addEventListener('resize', hideCtx);

  $('#btnAdd').addEventListener('click', addAtCenter);
  $('#btnNewBoard').addEventListener('click', () => newBoard());
  $('#btnMode').addEventListener('click', (e) => pickMode(e.currentTarget));
  $('#btnArrange').addEventListener('click', arrange);
  $('#btnFit').addEventListener('click', () => fitView(true));
  $('#btnList').addEventListener('click', () => setListMode(!listMode));
  setListMode(listMode);
  window.addEventListener('resize', () => { if (!isMobile()) { document.body.classList.remove('list'); panel.classList.remove('open'); } else setListMode(listMode); });

  // Installable on the phone: the service worker (sw.js) caches the shell and never the API.
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('service worker:', e.message));

  // Re-sync when the tab comes back (e.g. edited from the phone meanwhile).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (state.home) { renderHome().catch(() => {}); return; }
    if (state.boardId && !gesture && !editing) loadBoards().then(() => openBoard(state.boardId, true)).catch(() => {});
  });
  window.addEventListener('beforeunload', () => { flushSave(); flushLabel(); });

  // ---------------------------------------------------------------- home page
  // All plans as cards, YouTube style: a coloured thumbnail with the plan's flow sketched on it,
  // each card leaning a little, most recently edited first. Drag a card onto the cardboard box
  // (bottom left) to archive it; click the box for the archived ones (restore / delete).
  function showHome() {
    flushSave(); endEdit(); disarm(); hideCtx(); closeBoardMenu();
    state.home = true; document.body.classList.add('home');
    document.title = 'Planflow';
    renderHome().catch((e) => toast('Could not load: ' + e.message));
  }
  function leaveHome() {
    if (!state.home) return;
    state.home = false; document.body.classList.remove('home');
    closeDrawer(); hideCtx(); if (planDrag) endPlanDrag({ type: 'pointercancel', pointerId: planDrag.pid });
  }
  function closeDrawer() { archiveDrawer.hidden = true; }
  // The same plan always gets the same colours and tilt: a hash of its id, not Math.random(),
  // so the home page does not reshuffle on every visit. Different plans look nothing alike.
  function rnd(seed, salt) {
    let x = (Math.imul(seed, 374761393) + Math.imul(salt, 668265263)) | 0;
    x = Math.imul(x ^ (x >>> 13), 1274126177); x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
  }
  function planLook(id) {
    const h1 = Math.floor(rnd(id, 1) * 360), h2 = (h1 + 30 + Math.floor(rnd(id, 2) * 70)) % 360;
    const bg = rnd(id, 3) < 0.25 ? `hsl(${h1} 62% 48%)`    // one plan in four is a flat colour
      : `linear-gradient(${Math.floor(rnd(id, 4) * 360)}deg, hsl(${h1} 72% 54%), hsl(${h2} 72% 40%))`;
    const tilt = (1 + rnd(id, 5) * 4) * (rnd(id, 6) < 0.5 ? -1 : 1);   // 1..5°, clockwise or not
    return { bg, tilt: Math.round(tilt * 10) / 10 };
  }
  // The flow drawn small: boxes where the cards are (a cover makes one taller), links between
  // them with the real curve, done boxes filled in. Stroke widths are scaled to the thumbnail.
  const MINI_H = 52, MINI_COVER_H = 90, MINI_W_PX = 300, MINI_H_PX = 170;
  function miniFlow(b) {
    const tasks = b.tasks, byId = new Map(tasks.map((t) => [t.id, t]));
    const hOf = (t) => MINI_H + (t.cover ? MINI_COVER_H : 0);
    const svg = svgEl('svg', { class: 'mini', viewBox: '0 0 160 90', preserveAspectRatio: 'xMidYMid meet' });
    if (!tasks.length) return svg;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const t of tasks) { minX = Math.min(minX, t.x); minY = Math.min(minY, t.y); maxX = Math.max(maxX, t.x + NODE_W); maxY = Math.max(maxY, t.y + hOf(t)); }
    const pad = 24, vw = maxX - minX + pad * 2, vh = maxY - minY + pad * 2;
    svg.setAttribute('viewBox', `${minX - pad} ${minY - pad} ${vw} ${vh}`);
    const k = Math.min(MINI_W_PX / vw, MINI_H_PX / vh), sw = 2.2 / k, ah = 9 / k;   // ≈ 2px lines at the size shown
    const mid = 'ma' + b.id;
    svg.append(svgEl('defs', {}));
    const marker = svgEl('marker', { id: mid, markerUnits: 'userSpaceOnUse', markerWidth: ah, markerHeight: ah, refX: ah * 0.85, refY: ah / 2, orient: 'auto' });
    marker.append(svgEl('path', { d: `M0,0 L${ah},${ah / 2} L0,${ah} z`, class: 'ma' }));
    svg.firstChild.append(marker);
    const box = (t, side) => {   // like anchor(), with the thumbnail's heights
      const hh = hOf(t), dir = DIR[side] || DIR.right;
      const p = side === 'left' ? { x: t.x, y: t.y + hh / 2 } : side === 'top' ? { x: t.x + NODE_W / 2, y: t.y }
        : side === 'bottom' ? { x: t.x + NODE_W / 2, y: t.y + hh } : { x: t.x + NODE_W, y: t.y + hh / 2 };
      return { ...p, dir };
    };
    // Drawn the way the board itself reads its cards and links (updateNode, renderEdges), from
    // what the overview sends: arrows and done / blocked boxes for tasks, leaning cards on dotted
    // threads for ideas, filled top cards for an outline, pills and six-sided decisions for a flow.
    const mode = modeOf(b), nin = new Map(), outs = new Map();
    for (const d of b.deps) { if (!byId.has(d.from) || !byId.has(d.to)) continue; outs.set(d.from, (outs.get(d.from) || []).concat(d)); nin.set(d.to, (nin.get(d.to) || 0) + 1); }
    const blocked = new Set(b.deps.filter((d) => byId.get(d.from) && byId.get(d.from).status !== 'done').map((d) => d.to));
    for (const d of b.deps) {
      const a = byId.get(d.from), c = byId.get(d.to); if (!a || !c) continue;
      const attrs = { d: pathD(box(a, d.from_side || 'right'), box(c, d.to_side || 'left')), class: 'ml' + (mode === 'tasks' && a.status === 'done' ? ' done' : ''), 'stroke-width': sw };
      if (mode === 'tasks' || mode === 'flow') attrs['marker-end'] = `url(#${mid})`;
      if (mode === 'ideas') { attrs['stroke-dasharray'] = `${1 / k} ${6 / k}`; attrs['stroke-linecap'] = 'round'; }
      svg.append(svgEl('path', attrs));
    }
    for (const t of tasks) {
      const hh = hOf(t), out = outs.get(t.id) || [], inn = nin.get(t.id) || 0;
      const st = mode === 'tasks' ? (t.status === 'done' ? 'done' : blocked.has(t.id) ? 'blocked' : 'ready')
        : mode === 'ideas' ? (t.status === 'done' ? 'done' : 'idea')
        : mode === 'plan' ? (out.length && !inn ? 'top' : 'point')
        : roleFrom(t.title, inn, out);
      const cut = 24, x2 = t.x + NODE_W, y2 = t.y + hh, ym = t.y + hh / 2;
      const r = st === 'decision'
        ? svgEl('polygon', { points: `${t.x + cut},${t.y} ${x2 - cut},${t.y} ${x2},${ym} ${x2 - cut},${y2} ${t.x + cut},${y2} ${t.x},${ym}`, class: 'mn decision', 'stroke-width': sw })
        : svgEl('rect', { x: t.x, y: t.y, width: NODE_W, height: hh, rx: st === 'start' || st === 'end' ? Math.min(hh / 2, 26) : 5 / k, class: 'mn ' + st, 'stroke-width': sw });
      if (st === 'blocked') r.setAttribute('stroke-dasharray', `${6 / k} ${4 / k}`);
      if (mode === 'ideas') r.setAttribute('transform', `rotate(${leanOf(t.id) * 2.5} ${t.x + NODE_W / 2} ${ym})`);
      svg.append(r);
    }
    return svg;
  }
  function relTime(iso) {
    if (!iso) return '';
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 2) return 'just now';
    if (m < 60) return `${m} min ago`;
    const hh = Math.round(m / 60); if (hh < 24) return `${hh} h ago`;
    const d = Math.round(hh / 24); if (d < 7) return d === 1 ? 'yesterday' : `${d} days ago`;
    if (d < 60) return `${Math.round(d / 7)} wk ago`;
    return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
  }
  function planCard(b) {
    const { bg, tilt } = planLook(b.id);
    const ready = b.tasks.filter((t) => t.status !== 'done' && !b.deps.some((d) => d.to === t.id && b.tasks.some((f) => f.id === d.from && f.status !== 'done'))).length;
    // What kind of plan it is, and the one fact that matters for that kind, between the count and the date.
    const mode = modeOf(b), def = MODES[mode], outs = new Map(), into = new Set();
    for (const d of b.deps) { outs.set(d.from, (outs.get(d.from) || []).concat(d)); into.add(d.to); }
    const tops = b.tasks.filter((t) => outs.get(t.id) && !into.has(t.id)).length;
    const forks = mode === 'flow' ? b.tasks.filter((t) => roleFrom(t.title, into.has(t.id) ? 1 : 0, outs.get(t.id) || []) === 'decision').length : 0;
    const fact = mode === 'tasks' ? `${ready} ready` : mode === 'ideas' ? (b.done ? `${b.done} ticked off` : '')
      : mode === 'plan' ? (tops ? `${tops} at the top` : '') : (forks ? `${forks} decision${forks === 1 ? '' : 's'}` : '');
    const meta = b.total ? [count(b.total, def), fact, `edited ${relTime(b.updated_at || b.created_at)}`].filter(Boolean).join(' · ') : `empty · made ${relTime(b.created_at)}`;
    return h('article', { class: 'plan', 'data-id': b.id, 'data-mode': mode, style: `--tilt:${tilt}deg`, tabindex: 0, role: 'link', 'aria-label': `Open ${b.name} (${def.label})` },
      h('div', { class: 'thumb', style: 'background:' + bg }, miniFlow(b),
        h('span', { class: 'thumb-mode', title: def.about }, modeIcon(mode), def.label),
        b.total ? h('span', { class: 'thumb-count' }, mode === 'tasks' ? `${b.done} / ${b.total}` : count(b.total, def)) : h('span', { class: 'thumb-empty' }, 'Empty plan')),
      h('div', { class: 'plan-body' }, h('div', { class: 'plan-title' }, b.name), h('div', { class: 'plan-meta' }, meta),
        // only a tasks board has progress; the others keep the bar's space so every card is the same height
        h('div', { class: 'plan-bar' + (mode === 'tasks' ? '' : ' none') }, h('div', { class: 'fill', style: `width:${b.total ? b.done / b.total * 100 : 0}%` }))),
      h('button', { class: 'icon plan-menu', title: 'Plan options', 'aria-label': 'Plan options',
        onclick: (e) => { e.stopPropagation(); planMenu(b, e.clientX, e.clientY); } }, '⋯'));
  }
  // Cards sit where they were last dropped (home_x / home_y on the board). A card that was never
  // moved takes the next free cell of a grid, row by row, most recently edited first, skipping
  // cells that a placed card covers; those automatic spots are not saved, so they reflow with
  // the window. On a phone the cards are a plain grid (CSS) and the positions are ignored.
  const PLAN_W = 260, PLAN_H = 230, PLAN_GAP_X = 32, PLAN_GAP_Y = 40;
  let homeCards = [];   // [{ b, el }] in recency order, for layoutHome()
  function layoutHome() {
    if (!homeCards.length) { planGrid.style.minHeight = ''; return; }
    const cols = Math.max(1, Math.floor((planGrid.clientWidth + PLAN_GAP_X) / (PLAN_W + PLAN_GAP_X)));
    const placed = homeCards.filter(({ b }) => b.home_x != null && b.home_y != null).map(({ b }) => ({ l: b.home_x, t: b.home_y, r: b.home_x + PLAN_W, btm: b.home_y + PLAN_H }));
    const free = (l, t) => !placed.some((p) => l < p.r && l + PLAN_W > p.l && t < p.btm && t + PLAN_H > p.t);
    let cell = 0, bottom = 0;
    for (const { b, el } of homeCards) {
      let x, y;
      if (b.home_x != null && b.home_y != null) { x = b.home_x; y = b.home_y; }
      else {
        for (;; cell++) { x = (cell % cols) * (PLAN_W + PLAN_GAP_X); y = Math.floor(cell / cols) * (PLAN_H + PLAN_GAP_Y); if (free(x, y)) { cell++; break; } }
      }
      el.style.left = x + 'px'; el.style.top = y + 'px';
      bottom = Math.max(bottom, y + PLAN_H);
    }
    planGrid.style.minHeight = (bottom + PLAN_GAP_Y) + 'px';
  }
  window.addEventListener('resize', () => { if (state.home) layoutHome(); });
  async function renderHome() {
    const { boards } = await api('GET', '/api/overview');
    state.boards = boards.map(({ tasks, deps, ...b }) => b); renderBoards();   // the switcher stays in step with the cards
    const when = (b) => b.updated_at || b.created_at || '';
    const live = boards.filter((b) => !b.archived_at).sort((a, b) => when(b).localeCompare(when(a)));
    const archived = boards.filter((b) => b.archived_at).sort((a, b) => b.archived_at.localeCompare(a.archived_at));
    $('#homeCount').textContent = `${live.length} plan${live.length === 1 ? '' : 's'}` + (archived.length ? ` · ${archived.length} archived` : '');
    homeCards = live.map((b) => ({ b, el: planCard(b) }));
    planGrid.replaceChildren(...(live.length ? homeCards.map((c) => c.el)
      : [h('div', { class: 'home-empty' }, h('div', {}, archived.length ? 'Every plan is in the archive box.' : 'No plans yet. A plan is a board of cards: things to do in order, a pile of ideas, an outline or a workflow.'),
          h('button', { class: 'primary', onclick: (e) => newBoard(e.currentTarget) }, '+ New plan'))]));
    layoutHome();
    const cnt = $('.archive-count', archiveBox); cnt.textContent = archived.length; cnt.hidden = !archived.length;
    archiveDrawer.replaceChildren(h('h4', {}, `Archived (${archived.length})`),
      archived.length ? h('ul', {}, archived.map((b) => h('li', {},
          h('span', { class: 't' }, b.name, h('span', { class: 'small muted' }, ` · ${count(b.total, MODES[modeOf(b)])}`)),
          h('button', { onclick: () => archiveBoard(b.id, false) }, 'Restore'),
          h('button', { class: 'danger', 'data-label': 'Delete', title: 'Click twice. Gone for good.',
            onclick: (e) => armedDelete('board:' + b.id, e.currentTarget, () => deletePlan(b.id).catch((err) => toast(err.message))) }, 'Delete'))))
        : h('div', { class: 'empty' }, 'Nothing here. Drag a plan onto the box to archive it.'));
  }
  async function placePlan(id, x, y) {
    try { await api('PATCH', `/api/boards/${id}`, { home_x: x, home_y: y }); if (state.home) await renderHome(); } catch (e) { toast(e.message); }
  }
  function planMenu(b, x, y) {
    if (!b) return;
    showCtx([
      { label: 'Open', run: () => goBoard(b.id) },
      { label: 'Rename', run: () => renameBoard(b.id) },
      b.archived_at ? { label: 'Take out of the archive', run: () => archiveBoard(b.id, false) } : { label: 'Archive', run: () => archiveBoard(b.id) },
      b.home_x != null && !isMobile() ? { label: 'Back into the grid', title: 'Forget where this card was dropped', run: () => placePlan(b.id, null, null) } : null,
      '-',
      { label: 'Delete plan', danger: true, arm: 'board:' + b.id, title: 'Click twice. Cannot be undone.', run: () => deletePlan(b.id).catch((e) => toast(e.message)) },
    ], x, y);
  }
  // Mouse / pen: drag a card anywhere on the page and it stays there (saved on the board), or
  // onto the box to archive it; a plain click opens the plan. A finger scrolls the grid as
  // usual, so on touch the card's ⋯ menu (or a long press) has Archive instead.
  let planDrag = null;   // { id, el, pid, sx, sy, ox, oy, touch, timer, moving, over }
  planGrid.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const el = e.target.closest('.plan'); if (!el || e.target.closest('.plan-menu')) return;
    hideCtx(); closeDrawer();
    planDrag = { id: +el.dataset.id, el, pid: e.pointerId, sx: e.clientX, sy: e.clientY, ox: parseFloat(el.style.left) || 0, oy: parseFloat(el.style.top) || 0,
      touch: e.pointerType === 'touch' || isMobile(), timer: null, moving: false, over: false };
    if (planDrag.touch) planDrag.timer = setTimeout(() => { const d = planDrag; if (d && !d.moving) { planDrag = null; planMenu(boardOf(d.id), d.sx, d.sy); } }, 550);
  });
  function movePlan(d, e) {
    const x = Math.max(0, d.ox + e.clientX - d.sx), y = Math.max(0, d.oy + e.clientY - d.sy);
    d.el.style.left = x + 'px'; d.el.style.top = y + 'px';
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const over = !!(under && under.closest('#archiveBox'));
    if (over !== d.over) { d.over = over; archiveBox.classList.toggle('hot', over); d.el.classList.toggle('over', over); }
    const need = y + PLAN_H + PLAN_GAP_Y;   // let the page grow so a card can be dropped below everything
    if (need > parseFloat(planGrid.style.minHeight || 0)) planGrid.style.minHeight = need + 'px';
  }
  planGrid.addEventListener('pointermove', (e) => {
    const d = planDrag; if (!d || e.pointerId !== d.pid) return;
    if (!d.moving) {
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < DRAG_THRESHOLD) return;
      if (d.touch) { clearTimeout(d.timer); planDrag = null; return; }   // a moving finger is scrolling
      try { planGrid.setPointerCapture(e.pointerId); } catch {}
      d.moving = true; d.el.classList.add('lifted'); document.body.classList.add('plan-dragging');
    }
    movePlan(d, e);
  });
  function endPlanDrag(e) {
    const d = planDrag; if (!d || e.pointerId !== d.pid) return;
    planDrag = null; clearTimeout(d.timer);
    if (!d.moving) { if (e.type === 'pointerup') goBoard(d.id); return; }
    archiveBox.classList.remove('hot'); d.el.classList.remove('lifted', 'over'); document.body.classList.remove('plan-dragging');
    if (e.type === 'pointerup' && d.over) { archiveBoard(d.id); return; }
    if (e.type !== 'pointerup') { layoutHome(); return; }   // cancelled: back where it was
    const x = Math.round(parseFloat(d.el.style.left)), y = Math.round(parseFloat(d.el.style.top));
    for (const b of [boardOf(d.id), homeCards.find((c) => c.b.id === d.id)?.b]) if (b) { b.home_x = x; b.home_y = y; }
    layoutHome();
    api('PATCH', `/api/boards/${d.id}`, { home_x: x, home_y: y }).catch((err) => toast('Could not save the spot: ' + err.message));
  }
  planGrid.addEventListener('pointerup', endPlanDrag);
  planGrid.addEventListener('pointercancel', endPlanDrag);
  planGrid.addEventListener('keydown', (e) => {
    const el = e.target.closest('.plan'); if (!el || e.target !== el) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goBoard(+el.dataset.id); }
  });
  planGrid.addEventListener('contextmenu', (e) => {
    const el = e.target.closest('.plan'); if (!el) return;
    e.preventDefault(); planDrag = null;
    planMenu(boardOf(+el.dataset.id), e.clientX, e.clientY);
  });
  archiveBox.addEventListener('click', () => { archiveDrawer.hidden = !archiveDrawer.hidden; });

  // ---------------------------------------------------------------- boot
  (async () => {
    try { await loadBoards(); } catch (e) { toast('Could not load: ' + e.message); console.error(e); }
    window.addEventListener('hashchange', route);
    route();   // the hash says where to start: a board, or (the usual case) the home page
  })();
})();
