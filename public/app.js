'use strict';
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const viewport = $('#viewport'), world = $('#world'), edgeLayer = $('#edgeLayer'), nodesLayer = $('#nodes');
  const panel = $('#panel'), toastEl = $('#toast'), boardSelect = $('#boardSelect'), edgeUnlink = $('#edgeUnlink');
  const boardMenu = $('#boardMenu'), zoomLabel = $('#zoomLabel');
  const NODE_W = 210, MIN_S = 0.2, MAX_S = 3, DRAG_THRESHOLD = 4;
  const isMobile = () => window.innerWidth <= 760;

  const state = {
    boards: [], boardId: null, board: null,
    tasks: new Map(), deps: [],           // deps: [{from, to}]  "from must be done before to"
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
  function toast(msg) {
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2800);
  }
  async function api(method, url, body) {
    const res = await fetch(url, {
      method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
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
    const s = clamp(Math.min((r.width - pad * 2) / (maxX - minX), (r.height - pad * 2) / (maxY - minY), 1.2), MIN_S, MAX_S);
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

  // ---------------------------------------------------------------- nodes
  function makeNode(t) {
    const el = h('div', { class: 'node', 'data-id': t.id },
      h('button', { class: 'check', 'aria-label': 'Toggle done' }, '✓'),
      h('div', { class: 'title' }),
      h('div', { class: 'meta' }, h('span', { class: 'badge' })),
      h('div', { class: 'port', title: 'Drag onto another task: that task will wait for this one' }));
    updateNode(el, t);
    return el;
  }
  function updateNode(el, t) {
    const st = stateOf(t);
    el.className = 'node ' + st + (isSel('task', t.id) ? ' selected' : '');
    el.style.left = t.x + 'px'; el.style.top = t.y + 'px';
    $('.title', el).textContent = t.title;
    const n = blockersOf(t.id).filter((b) => b.status !== 'done').length;
    $('.badge', el).textContent = st === 'done' ? 'Done' : st === 'ready' ? 'Ready' : `Blocked by ${n}`;
    $('.check', el).title = st === 'blocked' ? 'Finish its blockers first' : st === 'done' ? 'Reopen' : 'Mark done';
  }
  function renderAll() {
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

  // ---------------------------------------------------------------- edges
  function anchors(id) {
    const el = nodeEls.get(id), t = state.tasks.get(id);
    return { out: { x: t.x + el.offsetWidth, y: t.y + el.offsetHeight / 2 }, in: { x: t.x, y: t.y + el.offsetHeight / 2 } };
  }
  function bezier(a, b) {
    const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
    return { p1: { x: a.x + dx, y: a.y }, p2: { x: b.x - dx, y: b.y } };
  }
  function pathD(a, b) { const { p1, p2 } = bezier(a, b); return `M ${a.x} ${a.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${b.x} ${b.y}`; }
  function midpoint(a, b) { const { p1, p2 } = bezier(a, b); return { x: (a.x + 3 * p1.x + 3 * p2.x + b.x) / 8, y: (a.y + 3 * p1.y + 3 * p2.y + b.y) / 8 }; }
  function renderEdges() {
    edgeLayer.replaceChildren();
    edgeUnlink.hidden = true;
    for (const d of state.deps) {
      if (!nodeEls.has(d.from) || !nodeEls.has(d.to)) continue;
      const a = anchors(d.from).out, b = anchors(d.to).in;
      const sel = isSel('edge', d);
      const kind = sel ? 'selected' : state.tasks.get(d.from).status === 'done' ? 'satisfied' : 'pending';
      edgeLayer.append(
        svgEl('path', { d: pathD(a, b), class: `edge ${kind}`, 'marker-end': `url(#arrow-${kind})` }),
        svgEl('path', { d: pathD(a, b), class: 'edge-hit', 'data-from': d.from, 'data-to': d.to }));
      if (sel) {
        const m = midpoint(a, b);
        edgeUnlink.style.left = m.x + 'px'; edgeUnlink.style.top = m.y + 'px'; edgeUnlink.hidden = false;
      }
    }
    if (gesture && gesture.type === 'link' && gesture.cur && nodeEls.has(gesture.from)) {
      edgeLayer.append(svgEl('path', { d: pathD(anchors(gesture.from).out, gesture.cur), class: 'edge temp', 'marker-end': 'url(#arrow-temp)' }));
    }
  }

  // ---------------------------------------------------------------- selection + panel
  function select(sel, opts = {}) {
    state.selected = sel;
    for (const [id, el] of nodeEls) el.classList.toggle('selected', isSel('task', id));
    renderEdges(); renderPanel(opts);
    if (isMobile()) panel.classList.toggle('open', !!sel);
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
    return h('li', { class: 'clickable', onclick: () => { select({ type: 'task', id: t.id }); centerOn(t.id); } },
      h('span', { class: 'dot ' + st }), h('span', { class: 't' }, t.title), extra);
  }
  const setPanel = (...kids) => panel.replaceChildren(...kids.filter(Boolean));
  function renderPanel(opts = {}) {
    const closeBtn = h('button', { id: 'panelClose', class: 'icon', onclick: () => panel.classList.remove('open') }, '✕');
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
      setPanel(
        h('div', { class: 'panel-head' }, h('span', { class: 'badge ' + st }, st === 'done' ? 'Done' : st === 'ready' ? 'Ready to start' : `Blocked by ${blockers.filter((b) => b.status !== 'done').length}`), h('span', { class: 'spacer' }), closeBtn),
        titleInput, notes,
        h('div', { class: 'row' },
          st === 'blocked'
            ? h('button', { disabled: true, title: 'Finish its blockers first' }, 'Blocked')
            : h('button', { class: st === 'done' ? '' : 'primary', onclick: () => setDone(t.id, st !== 'done') }, st === 'done' ? 'Reopen' : 'Mark done'),
          h('button', { class: 'danger', onclick: () => deleteTask(t.id) }, 'Delete')),
        st === 'blocked' ? h('div', { class: 'small' }, h('button', { class: 'link', onclick: () => setDone(t.id, true, true) }, 'Mark done anyway')) : null,
        h('section', {}, h('h4', {}, `Waits for (${blockers.length})`),
          blockers.length ? h('ul', {}, blockers.map((b) => taskRow(b, unlinkBtn(b.id, t.id)))) : h('div', { class: 'empty' }, 'Nothing. This task can start any time.')),
        h('section', {}, h('h4', {}, `Unlocks (${dependents.length})`),
          dependents.length ? h('ul', {}, dependents.map((d) => taskRow(d, unlinkBtn(t.id, d.id)))) : h('div', { class: 'empty' }, 'Nothing depends on this yet. Drag its ● handle onto a task to link.')),
        h('div', { class: 'muted small' }, `Created ${fmtDate(t.created_at)}` + (t.done_at ? ` · Done ${fmtDate(t.done_at)}` : '')));
      if (opts.focusTitle) { titleInput.focus(); titleInput.select(); }
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
      h('div', { class: 'panel-head' }, h('h3', {}, state.board ? state.board.name : 'Board'), closeBtn),
      h('div', { class: 'stats' },
        h('div', { class: 'stat ready' }, h('b', {}, groups.ready.length), h('span', {}, 'ready')),
        h('div', { class: 'stat' }, h('b', {}, groups.blocked.length), h('span', {}, 'blocked')),
        h('div', { class: 'stat done' }, h('b', {}, groups.done.length), h('span', {}, 'done'))),
      h('section', {}, h('h4', {}, 'Ready to start'), list(groups.ready, tasks.length ? 'Nothing is ready. Finish or unlink something.' : 'Add a task to get going.')),
      h('section', {}, h('h4', {}, 'Blocked'), list(groups.blocked, 'No blocked tasks.')),
      h('section', {}, h('h4', {}, 'Done'), list(groups.done, 'Nothing done yet.')),
      h('div', { class: 'tips' },
        h('div', {}, h('kbd', {}, 'N'), ' new task · ', h('kbd', {}, 'A'), ' arrange · ', h('kbd', {}, 'F'), ' fit view'),
        h('div', {}, h('kbd', {}, 'Del'), ' remove selected task or link · ', h('kbd', {}, 'Esc'), ' deselect'),
        h('div', {}, 'Right-click a task, a link, or empty space for a menu · middle-click adds a task under the cursor.'),
        h('div', {}, 'A link A → B means B waits for A. Tasks light up blue when everything they wait for is done.')));
  }

  // ---------------------------------------------------------------- mutations
  async function createTask(x, y, opts = {}) {
    try {
      const t = await api('POST', `/api/boards/${state.boardId}/tasks`, { title: 'New task', x: Math.round(x), y: Math.round(y) });
      state.tasks.set(t.id, t);
      const el = makeNode(t); nodesLayer.appendChild(el); nodeEls.set(t.id, el);
      renderProgress();
      if (opts.after && state.tasks.has(opts.after)) await addDep(opts.after, t.id, { quiet: true });
      select({ type: 'task', id: t.id }, { focusTitle: !isMobile() });
      if (isMobile()) { const inp = $('.title-input', panel); if (inp) { inp.focus(); inp.select(); } }
    } catch (e) { toast(e.message); }
  }
  function addAtCenter() {
    const r = viewport.getBoundingClientRect();
    let p = clientToWorld(r.left + r.width / 2, r.top + r.height / 2);
    p = { x: p.x - NODE_W / 2, y: p.y - 24 };
    const taken = (x, y) => [...state.tasks.values()].some((t) => Math.abs(t.x - x) < 20 && Math.abs(t.y - y) < 20);
    while (taken(p.x, p.y)) { p.x += 30; p.y += 30; }
    createTask(p.x, p.y);
  }
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
  async function deleteTask(id) {
    const t = state.tasks.get(id); if (!t) return;
    if (!confirm(`Delete "${t.title}"?`)) return;
    try {
      await api('DELETE', `/api/tasks/${id}`);
      state.tasks.delete(id);
      state.deps = state.deps.filter((d) => d.from !== id && d.to !== id);
      nodeEls.get(id)?.remove(); nodeEls.delete(id);
      if (isSel('task', id)) state.selected = null;
      refreshNodes();
      if (isMobile()) panel.classList.remove('open');
    } catch (e) { toast(e.message); }
  }
  async function addDep(from, to, opts = {}) {
    if (from === to) return;
    if (state.deps.some((d) => d.from === from && d.to === to)) { toast('Already linked.'); return; }
    if (reaches(to, from)) { toast("Can't link: that would make a loop."); return; }
    try {
      await api('POST', `/api/boards/${state.boardId}/deps`, { from, to });
      state.deps.push({ from, to });
      refreshNodes();
      if (!opts.quiet) toast(`"${titleOf(to)}" now waits for "${titleOf(from)}"`);
    } catch (e) { toast(e.message); }
  }
  async function deleteDep(from, to) {
    try {
      await api('DELETE', `/api/deps/${from}/${to}`);
      state.deps = state.deps.filter((d) => !(d.from === from && d.to === to));
      if (isSel('edge', { from, to })) state.selected = null;
      refreshNodes();
    } catch (e) { toast(e.message); }
  }
  function deleteSelected() {
    const s = state.selected; if (!s) return;
    if (s.type === 'edge') deleteDep(s.from, s.to); else deleteTask(s.id);
  }

  // ---------------------------------------------------------------- auto arrange
  async function arrange() {
    const tasks = [...state.tasks.values()]; if (!tasks.length) return;
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
    const cols = [];
    for (const t of tasks) (cols[layer.get(t.id)] ||= []).push(t);
    const row = new Map();
    const bary = (t) => { const bs = blockersOf(t.id).filter((b) => row.has(b.id)); return bs.length ? bs.reduce((s, b) => s + row.get(b.id), 0) / bs.length : 0; };
    cols.forEach((col, ci) => {
      col.sort((a, b) => (ci ? bary(a) - bary(b) : 0) || a.id - b.id);
      col.forEach((t, i) => row.set(t.id, i));
    });
    const GAP_X = 90, GAP_Y = 28, X0 = 40, Y0 = 40;
    const hOf = (t) => nodeEls.get(t.id).offsetHeight;
    const colH = cols.map((col) => col.reduce((s, t) => s + hOf(t), 0) + GAP_Y * (col.length - 1));
    const maxH = Math.max(...colH);
    const positions = [];
    cols.forEach((col, ci) => {
      let y = Y0 + (maxH - colH[ci]) / 2;
      for (const t of col) { positions.push({ id: t.id, x: X0 + ci * (NODE_W + GAP_X), y: Math.round(y) }); y += hOf(t) + GAP_Y; }
    });
    nodesLayer.classList.add('animate');
    for (const p of positions) {
      const t = state.tasks.get(p.id); t.x = p.x; t.y = p.y;
      const el = nodeEls.get(p.id); el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
    }
    const start = performance.now();
    const tick = () => { renderEdges(); if (performance.now() - start < 340) requestAnimationFrame(tick); else nodesLayer.classList.remove('animate'); };
    requestAnimationFrame(tick);
    fitView(true);
    try { await api('POST', `/api/boards/${state.boardId}/positions`, { positions }); } catch (e) { toast(e.message); }
  }

  // ---------------------------------------------------------------- pointer gestures
  function setDropTarget(el, ok) {
    for (const n of nodesLayer.querySelectorAll('.drop-target, .drop-bad')) n.classList.remove('drop-target', 'drop-bad');
    if (el) el.classList.add(ok ? 'drop-target' : 'drop-bad');
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
    if (!g.moved) { select({ type: 'task', id: g.id }); return; }
    t.x = Math.round(t.x); t.y = Math.round(t.y);
    updateNode(el, t); renderEdges();
    api('PATCH', `/api/tasks/${t.id}`, { x: t.x, y: t.y }).catch((e) => toast('Could not save position: ' + e.message));
  }
  viewport.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
    if (e.target.closest('.check, #edgeUnlink')) return;         // handled by click
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
      gesture = { ...base, type: 'link', from: +nodeEl.dataset.id, cur: null };
    } else if (nodeEl) {
      const t = state.tasks.get(+nodeEl.dataset.id);
      gesture = { ...base, type: 'node', id: t.id, ox: t.x, oy: t.y };
      nodeEl.classList.add('dragging');
    } else if (hit) {
      gesture = { ...base, type: 'edge', from: +hit.dataset.from, to: +hit.dataset.to };
    } else {
      gesture = { ...base, type: 'pan', ox: state.view.x, oy: state.view.y };
      viewport.classList.add('panning');
    }
  });
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
        renderEdges();
        const target = nodeAtPoint(e.clientX, e.clientY);
        const tid = target ? +target.dataset.id : null;
        setDropTarget(target && tid !== gesture.from ? target : null,
          !!target && !reaches(tid, gesture.from) && !state.deps.some((d) => d.from === gesture.from && d.to === tid));
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
        if (target) addDep(g.from, +target.dataset.id);
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
    if (e.target.closest('.node, .edge-hit, #edgeUnlink')) return;
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
  function showCtx(items, cx, cy) {
    ctxMenu.replaceChildren(...items.map((it) => it === '-' ? h('div', { class: 'sep' })
      : h('button', { class: it.danger ? 'danger' : '', disabled: !!it.disabled, title: it.title,
        onclick: () => { hideCtx(); it.run(); } }, it.label)));
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
        { label: 'Add next step \u2192', title: 'New task to the right that waits for this one', run: () => createTask(t.x + NODE_W + 90, t.y, { after: id }) },
        '-',
        { label: 'Delete task', danger: true, run: () => deleteTask(id) },
      ], e.clientX, e.clientY);
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
      ], e.clientX, e.clientY);
    }
  });
  // Stop the browser's middle-click autoscroll / paste so middle-click can mean "new task".
  viewport.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  viewport.addEventListener('auxclick', (e) => e.preventDefault());

  // ---------------------------------------------------------------- keyboard
  document.addEventListener('keydown', (e) => {
    const inField = e.target.matches('input, textarea, select') || e.target.isContentEditable;
    if (inField) { if (e.key === 'Escape') e.target.blur(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case 'Escape': select(null); boardMenu.hidden = true; hideCtx(); break;
      case 'Delete': case 'Backspace': e.preventDefault(); deleteSelected(); break;
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
  async function deleteBoard() {
    if (!confirm(`Delete board "${state.board.name}" and all ${state.tasks.size} of its tasks? This cannot be undone.`)) return;
    try {
      await api('DELETE', `/api/boards/${state.boardId}`);
      await loadBoards();
      if (!state.boards.length) { const b = await api('POST', '/api/boards', { name: 'My project' }); await loadBoards(); await openBoard(b.id); }
      else await openBoard(state.boards[0].id);
    } catch (e) { toast(e.message); }
  }
  boardSelect.addEventListener('change', () => openBoard(+boardSelect.value).catch((e) => toast(e.message)));
  $('#btnBoardMenu').addEventListener('click', (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    boardMenu.style.left = Math.min(r.left, window.innerWidth - 190) + 'px'; boardMenu.style.top = (r.bottom + 6) + 'px';
    boardMenu.hidden = !boardMenu.hidden;
  });
  boardMenu.addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act; boardMenu.hidden = true;
    if (act === 'new') newBoard(); else if (act === 'rename') renameBoard(); else if (act === 'delete') deleteBoard();
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#boardMenu, #btnBoardMenu')) boardMenu.hidden = true; if (!e.target.closest('.menu.ctx')) hideCtx(); });
  window.addEventListener('resize', hideCtx);

  $('#btnAdd').addEventListener('click', addAtCenter);
  $('#btnArrange').addEventListener('click', arrange);
  $('#btnFit').addEventListener('click', () => fitView(true));
  $('#btnPanel').addEventListener('click', () => panel.classList.toggle('open'));

  // Re-sync when the tab comes back (e.g. edited from the phone meanwhile).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.boardId && !gesture) {
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
