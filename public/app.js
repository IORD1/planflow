'use strict';
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const viewport = $('#viewport'), world = $('#world'), edgeLayer = $('#edgeLayer'), nodesLayer = $('#nodes');
  const panel = $('#panel'), toastEl = $('#toast'), boardSelect = $('#boardSelect'), edgeUnlink = $('#edgeUnlink');
  const boardMenu = $('#boardMenu'), zoomLabel = $('#zoomLabel');
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
  }

  const state = {
    boards: [], boardId: null, board: null,
    tasks: new Map(), deps: [],           // deps: [{from, to, from_side, to_side}]  "from must be done before to"
    selected: null,                       // {type:'task', id} | {type:'edge', from, to}
    view: { x: 40, y: 40, s: 1 },
  };
  const nodeEls = new Map();
  const pointers = new Map();
  let gesture = null;

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
    if (!res.ok) throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
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
  function stateOf(t) {
    if (t.status === 'done') return 'done';
    return blockersOf(t.id).some((b) => b.status !== 'done') ? 'blocked' : 'ready';
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
    const el = h('div', { class: 'node', 'data-id': t.id },
      h('div', { class: 'cover', hidden: true }),
      h('div', { class: 'body' },
        h('button', { class: 'check', 'aria-label': 'Toggle done' }, '✓'),
        h('div', { class: 'title' }),
        h('div', { class: 'meta' }, h('span', { class: 'badge' }))),
      ...SIDES.map((s) => h('div', { class: 'port ' + s, 'data-side': s, title: 'Drag onto another task: that task will wait for this one' })));
    updateNode(el, t);
    return el;
  }
  function updateNode(el, t) {
    const st = stateOf(t);
    el.className = 'node ' + st + (isSel('task', t.id) ? ' selected' : '');
    el.style.left = t.x + 'px'; el.style.top = t.y + 'px';
    const title = $('.title', el);
    if (title.textContent !== t.title) title.textContent = t.title;   // leave the caret alone while it is being typed
    renderCover(el, t);
    const n = blockersOf(t.id).filter((b) => b.status !== 'done').length;
    $('.badge', el).textContent = st === 'done' ? 'Done' : st === 'ready' ? 'Ready' : `Blocked by ${n}`;
    $('.check', el).title = st === 'blocked' ? 'Finish its blockers first' : st === 'done' ? 'Reopen' : 'Mark done';
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
    endEdit();
    nodesLayer.replaceChildren(); nodeEls.clear();
    for (const t of state.tasks.values()) { const el = makeNode(t); nodesLayer.appendChild(el); nodeEls.set(t.id, el); }
    renderEdges(); renderPanel(); renderProgress();
  }
  function refreshNodes() {
    for (const [id, el] of nodeEls) updateNode(el, state.tasks.get(id));
    renderEdges(); renderPanel(); renderProgress();
  }
  function renderProgress() {
    const total = state.tasks.size;
    const done = [...state.tasks.values()].filter((t) => t.status === 'done').length;
    $('#progress .bar').style.width = total ? (done / total * 100) + '%' : '0';
    $('#progress .label').textContent = total ? `${done} / ${total} done` : 'no tasks yet';
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
  function renderEdges() {
    edgeLayer.replaceChildren();
    edgeUnlink.hidden = true;
    for (const d of state.deps) {
      if (!nodeEls.has(d.from) || !nodeEls.has(d.to)) continue;
      const sel = isSel('edge', d);
      const kind = sel ? 'selected' : state.tasks.get(d.from).status === 'done' ? 'satisfied' : 'pending';
      const dAttr = edgePath(d);
      const p = svgEl('path', { d: dAttr, class: `edge ${kind}`, 'marker-end': `url(#arrow-${kind})` });
      edgeLayer.append(p, svgEl('path', { d: dAttr, class: 'edge-hit', 'data-from': d.from, 'data-to': d.to }));
      if (sel) {
        const m = p.getPointAtLength(p.getTotalLength() / 2);
        edgeUnlink.style.left = m.x + 'px'; edgeUnlink.style.top = m.y + 'px'; edgeUnlink.hidden = false;
      }
    }
    if (gesture && gesture.type === 'link' && gesture.cur && nodeEls.has(gesture.from)) {
      const a = anchor(gesture.from, gesture.fromSide);
      const b = gesture.target && nodeEls.has(gesture.target) ? anchor(gesture.target, gesture.targetSide)   // snap to the drop side
        : { ...gesture.cur, dir: { x: -a.dir.x, y: -a.dir.y } };
      edgeLayer.append(svgEl('path', { d: pathD(a, b), class: 'edge temp', 'marker-end': 'url(#arrow-temp)' }));
    }
  }

  // ---------------------------------------------------------------- selection + panel
  function select(sel) {
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
  function taskRow(t, extra) {
    const st = stateOf(t);
    return h('li', { class: 'clickable', onclick: () => { select({ type: 'task', id: t.id }); if (!inList()) centerOn(t.id); } },
      h('span', { class: 'dot ' + st }), h('span', { class: 't' }, t.title), extra);
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
      const st = stateOf(t);
      const blockers = blockersOf(t.id), dependents = dependentsOf(t.id);
      const unlinkBtn = (from, to) => h('button', { class: 'unlink', title: 'Remove link', onclick: (e) => { e.stopPropagation(); deleteDep(from, to); } }, '✕');
      const titleInput = h('input', { type: 'text', class: 'title-input', value: t.title, maxlength: 300, placeholder: 'Task title',
        oninput: (e) => { t.title = e.target.value; updateNode(nodeEls.get(t.id), { ...t, title: t.title || 'Untitled' }); renderEdges(); scheduleSave(t.id, { title: t.title.trim() || 'Untitled' }); },
        onblur: flushSave, onkeydown: (e) => { if (e.key === 'Enter') { e.target.blur(); } } });
      const notes = h('textarea', { placeholder: 'Notes, links, acceptance criteria…',
        oninput: (e) => { t.notes = e.target.value; scheduleSave(t.id, { notes: t.notes }); }, onblur: flushSave });
      notes.value = t.notes || '';
      const armedNow = isArmed(t.id);
      setPanel(
        h('div', { class: 'panel-head' }, h('span', { class: 'badge ' + st }, st === 'done' ? 'Done' : st === 'ready' ? 'Ready to start' : `Blocked by ${blockers.filter((b) => b.status !== 'done').length}`), h('span', { class: 'spacer' }), closeBtn),
        titleInput, notes,
        h('div', { class: 'row' },
          st === 'blocked'
            ? h('button', { disabled: true, title: 'Finish its blockers first' }, 'Blocked')
            : h('button', { class: st === 'done' ? '' : 'primary', onclick: () => setDone(t.id, st !== 'done') }, st === 'done' ? 'Reopen' : 'Mark done'),
          h('button', { class: 'danger delete' + (armedNow ? ' armed' : ''), 'data-label': 'Delete', title: 'Click twice. Deleting can be undone.',
            onclick: (e) => armedDelete(t.id, e.currentTarget) }, armedNow ? 'Really?' : 'Delete')),
        st === 'blocked' ? h('div', { class: 'small' }, h('button', { class: 'link', onclick: () => setDone(t.id, true, true) }, 'Mark done anyway')) : null,
        coverSection(t),
        h('section', {}, h('h4', {}, `Waits for (${blockers.length})`),
          blockers.length ? h('ul', {}, blockers.map((b) => taskRow(b, unlinkBtn(b.id, t.id)))) : h('div', { class: 'empty' }, 'Nothing. This task can start any time.')),
        h('section', {}, h('h4', {}, `Unlocks (${dependents.length})`),
          dependents.length ? h('ul', {}, dependents.map((d) => taskRow(d, unlinkBtn(t.id, d.id)))) : h('div', { class: 'empty' }, 'Nothing depends on this yet. Drag its ● handle onto a task to link.')),
        h('div', { class: 'muted small' }, `Created ${fmtDate(t.created_at)}` + (t.done_at ? ` · Done ${fmtDate(t.done_at)}` : '')));
      if (armedNow) armed.btn = $('button.delete', panel);
      return;
    }
    const d = sel && sel.type === 'edge' ? state.deps.find((x) => x.from === sel.from && x.to === sel.to) : null;
    const a = d && state.tasks.get(d.from), b = d && state.tasks.get(d.to);
    if (d && a && b) {
      const pick = (key, label) => h('label', { class: 'side-pick' }, h('span', {}, label),
        h('select', { onchange: (e) => setDepSides(d, { [key]: e.target.value }) },
          ...SIDES.map((s) => h('option', { value: s, selected: (d[key] || (key === 'from_side' ? 'right' : 'left')) === s }, s))));
      setPanel(
        h('div', { class: 'panel-head' }, h('span', { class: 'badge' }, 'Link'), h('span', { class: 'spacer' }), closeBtn),
        h('section', {}, h('h4', {}, 'Must finish first'), h('ul', {}, taskRow(a))),
        h('section', {}, h('h4', {}, 'Then this can start'), h('ul', {}, taskRow(b))),
        h('section', {}, h('h4', {}, 'Arrow sides'),
          h('div', { class: 'sides' }, pick('from_side', 'Leaves the first card from its'), pick('to_side', 'Enters the second card at its'))),
        h('div', { class: 'row' }, h('button', { class: 'danger', onclick: () => deleteDep(d.from, d.to) }, 'Unlink')),
        h('div', { class: 'muted small' }, 'Drag a ● handle on any side of a card onto another card to make a new link; it attaches to the side you drop nearest to.'));
      return;
    }
    const tasks = [...state.tasks.values()];
    const groups = { ready: [], blocked: [], done: [] };
    for (const x of tasks) groups[stateOf(x)].push(x);
    const byTitle = (a, b) => a.title.localeCompare(b.title);
    groups.ready.sort(byTitle); groups.blocked.sort(byTitle);
    groups.done.sort((a, b) => (b.done_at || '').localeCompare(a.done_at || ''));
    const list = (arr, empty) => arr.length ? h('ul', {}, arr.map((x) => taskRow(x))) : h('div', { class: 'empty' }, empty);
    setPanel(
      h('div', { class: 'panel-head' }, h('h3', {}, state.board ? state.board.name : 'Board'), inList() ? h('button', { class: 'primary', onclick: addAtCenter }, '+ Task') : closeBtn),
      h('div', { class: 'stats' },
        h('div', { class: 'stat ready' }, h('b', {}, groups.ready.length), h('span', {}, 'ready')),
        h('div', { class: 'stat' }, h('b', {}, groups.blocked.length), h('span', {}, 'blocked')),
        h('div', { class: 'stat done' }, h('b', {}, groups.done.length), h('span', {}, 'done'))),
      h('section', {}, h('h4', {}, 'Ready to start'), list(groups.ready, tasks.length ? 'Nothing is ready. Finish or unlink something.' : 'Add a task to get going.')),
      h('section', {}, h('h4', {}, 'Blocked'), list(groups.blocked, 'No blocked tasks.')),
      h('section', {}, h('h4', {}, 'Done'), list(groups.done, 'Nothing done yet.')),
      h('div', { class: 'tips' },
        h('div', {}, h('kbd', {}, 'N'), ' new task, then just type its name · ', h('kbd', {}, 'A'), ' arrange · ', h('kbd', {}, 'F'), ' fit view'),
        h('div', {}, h('kbd', {}, 'Del'), ' twice removes the selected task (', h('kbd', {}, 'Ctrl+Z'), ' undoes) · ', h('kbd', {}, 'Enter'), ' rename · ', h('kbd', {}, 'Esc'), ' deselect'),
        h('div', {}, 'Right-click a task, a link, or empty space for a menu · middle-click adds a task under the cursor.'),
        h('div', {}, 'Paste an image or a link (', h('kbd', {}, 'Ctrl+V'), ') to give the selected task a cover, or to make a new task when nothing is selected.'),
        h('div', {}, 'A link A → B means B waits for A. Tasks light up blue when everything they wait for is done.')));
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
      const t = await api('POST', `/api/boards/${state.boardId}/tasks`, { title: opts.title || 'New task', notes: opts.notes || '', x: Math.round(x), y: Math.round(y) });
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
      if (done) {
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
    if (state.deps.some((d) => d.from === from && d.to === to)) { toast('Already linked.'); return; }
    if (reaches(to, from)) { toast("Can't link: that would make a loop."); return; }
    try {
      const fromSide = opts.fromSide || 'right', toSide = opts.toSide || 'left';
      const r = await api('POST', `/api/boards/${state.boardId}/deps`, { from, to, from_side: fromSide, to_side: toSide });
      state.deps.push({ from, to, from_side: (r && r.from_side) || fromSide, to_side: (r && r.to_side) || toSide });
      refreshNodes();
      if (!opts.quiet) toast(`"${titleOf(to)}" now waits for "${titleOf(from)}"`);
    } catch (e) { toast(e.message); }
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
      if (d) pushUndo({ label: `Unlinked "${titleOf(from)}" → "${titleOf(to)}"`, run: () => addDep(from, to, { fromSide: d.from_side, toSide: d.to_side, quiet: true }) });
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
    const tasks = [...state.tasks.values()]; if (!tasks.length) return;
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
      v.preds.push(prev.key);
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
        const ok = !!target && tid !== gesture.from && !reaches(tid, gesture.from) && !state.deps.some((d) => d.from === gesture.from && d.to === tid);
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
    if (!under || under.closest('.edge-hit, #edgeUnlink, .check, .port') || under.isContentEditable) return;
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
  edgeUnlink.addEventListener('click', () => { const s = state.selected; if (s && s.type === 'edge') deleteDep(s.from, s.to); });

  // ---------------------------------------------------------------- context menu (right click / long press)
  const ctxMenu = h('div', { class: 'menu ctx', hidden: true });
  document.body.appendChild(ctxMenu);
  function hideCtx() { ctxMenu.hidden = true; }
  // An item with `arm: taskId` is a two-click delete: the first click relabels it "Really?".
  function showCtx(items, cx, cy) {
    ctxMenu.replaceChildren(...items.map((it) => {
      if (it === '-') return h('div', { class: 'sep' });
      const btn = h('button', { class: it.danger ? 'danger' : '', disabled: !!it.disabled, title: it.title }, it.label);
      btn.addEventListener('click', () => { if (it.arm) { armedDelete(it.arm, btn); return; } hideCtx(); it.run(); });
      return btn;
    }));
    ctxMenu.hidden = false;
    ctxMenu.style.left = Math.max(4, Math.min(cx, window.innerWidth - ctxMenu.offsetWidth - 4)) + 'px';
    ctxMenu.style.top = Math.max(4, Math.min(cy, window.innerHeight - ctxMenu.offsetHeight - 4)) + 'px';
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
      const st = stateOf(t);
      showCtx([
        st === 'done' ? { label: 'Reopen', run: () => setDone(id, false) }
          : st === 'blocked' ? { label: 'Mark done anyway', title: 'It still waits for unfinished tasks', run: () => setDone(id, true, true) }
          : { label: 'Mark done', run: () => setDone(id, true) },
        { label: 'Rename', run: () => editTitle(id) },
        { label: 'Add next step →', title: 'New task to the right that waits for this one', run: () => createTask(t.x + NODE_W + 90, t.y, { after: id }) },
        t.cover && t.cover.kind === 'link' ? { label: 'Open link ↗', run: () => window.open(t.cover.url, '_blank', 'noopener') } : null,
        t.cover ? { label: 'Remove cover', run: () => removeCover(id) } : null,
        '-',
        { label: 'Delete task', danger: true, arm: id, title: 'Click twice. Can be undone with Ctrl+Z.' },
      ].filter(Boolean), e.clientX, e.clientY);
    } else if (hit) {
      const from = +hit.dataset.from, to = +hit.dataset.to;
      select({ type: 'edge', from, to });
      showCtx([{ label: 'Unlink', danger: true, run: () => deleteDep(from, to) }], e.clientX, e.clientY);
    } else {
      const w = clientToWorld(e.clientX, e.clientY);
      showCtx([
        { label: 'Add task here', run: () => createTask(w.x - NODE_W / 2, w.y - 24) },
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
  function renderBoards() {
    boardSelect.replaceChildren(...state.boards.map((b) => h('option', { value: b.id, selected: b.id === state.boardId }, b.name)));
  }
  async function loadBoards() { state.boards = await api('GET', '/api/boards'); renderBoards(); }
  async function openBoard(id, keepView = false) {
    flushSave();
    const data = await api('GET', `/api/boards/${id}`);
    if (state.boardId !== id) { undoStack.length = 0; disarm(); }
    state.boardId = id; state.board = data.board;
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
  async function newBoard() {
    const name = prompt('Board name', 'New project'); if (!name || !name.trim()) return;
    try { const b = await api('POST', '/api/boards', { name: name.trim() }); await loadBoards(); await openBoard(b.id); } catch (e) { toast(e.message); }
  }
  async function renameBoard() {
    const name = prompt('Rename board', state.board.name); if (!name || !name.trim() || name.trim() === state.board.name) return;
    try { await api('PATCH', `/api/boards/${state.boardId}`, { name: name.trim() }); await loadBoards(); state.board.name = name.trim(); renderPanel(); } catch (e) { toast(e.message); }
  }
  // Second click on the board menu's Delete (see armedDelete). Unlike a task, a board is gone for good.
  async function deleteBoard() {
    disarm(); boardMenu.hidden = true;
    try {
      await api('DELETE', `/api/boards/${state.boardId}`);
      await loadBoards();
      if (!state.boards.length) { const b = await api('POST', '/api/boards', { name: 'My project' }); await loadBoards(); await openBoard(b.id); }
      else await openBoard(state.boards[0].id);
    } catch (e) { toast(e.message); }
  }
  boardSelect.addEventListener('change', () => openBoard(+boardSelect.value).catch((e) => toast(e.message)));
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
      if (!armedDelete(boardArmId(), btn, deleteBoard)) toast(`Press Delete board again to delete "${state.board.name}" and its ${state.tasks.size} tasks. This cannot be undone.`, { ms: ARM_MS });
      return;
    }
    closeBoardMenu();
    if (act === 'new') newBoard(); else if (act === 'rename') renameBoard();
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#boardMenu, #btnBoardMenu')) closeBoardMenu(); if (!e.target.closest('.menu.ctx')) hideCtx(); });
  window.addEventListener('resize', hideCtx);

  $('#btnAdd').addEventListener('click', addAtCenter);
  $('#btnArrange').addEventListener('click', arrange);
  $('#btnFit').addEventListener('click', () => fitView(true));
  $('#btnList').addEventListener('click', () => setListMode(!listMode));
  setListMode(listMode);
  window.addEventListener('resize', () => { if (!isMobile()) { document.body.classList.remove('list'); panel.classList.remove('open'); } else setListMode(listMode); });

  // Installable on the phone: the service worker (sw.js) caches the shell and never the API.
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('service worker:', e.message));

  // Re-sync when the tab comes back (e.g. edited from the phone meanwhile).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.boardId && !gesture && !editing) {
      loadBoards().then(() => openBoard(state.boardId, true)).catch(() => {});
    }
  });
  window.addEventListener('beforeunload', flushSave);

  // ---------------------------------------------------------------- boot
  (async () => {
    try {
      await loadBoards();
      if (!state.boards.length) { const b = await api('POST', '/api/boards', { name: 'My project' }); await loadBoards(); await openBoard(b.id); return; }
      const saved = store.get('planflow.board');
      const id = state.boards.some((b) => b.id === saved) ? saved : state.boards[0].id;
      await openBoard(id);
    } catch (e) { toast('Could not load: ' + e.message); console.error(e); }
  })();
})();
