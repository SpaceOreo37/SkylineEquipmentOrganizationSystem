import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js';
import { auth } from './firebase-init.js?v=11';
import { signOut } from './auth.js?v=11';
import { getEquipmentTypesBySection } from './firestore.js?v=11';
import {
  esc,
  showToast,
  loadTypesFromSession,
  upsertTypeInSession,
  removeTypeFromSession,
  forgetCachedCounts,
  countsHtml,
  createCountPool,
} from './ui-common.js?v=11';
import { openAddTypeDialog, openManageDialog } from './manage.js?v=11';

const titleEl = document.getElementById('section-title');
const statusEl = document.getElementById('section-status');
const listEl = document.getElementById('type-list');
const addTypeBtn = document.getElementById('add-type-btn');

// Version-skew guard: if the browser cached a stale copy of this page's HTML
// (or JS), required elements are missing. Fail loudly instead of blank.
if (!titleEl || !statusEl || !listEl || !addTypeBtn) {
  document.body.insertAdjacentHTML(
    'beforeend',
    '<p style="margin:2rem;padding:1rem;border:1px solid #dc2626;border-radius:8px;color:#dc2626;background:#fff">' +
      'This page is out of date. Please hard-refresh: <b>Cmd+Shift+R</b> (Mac) or <b>Ctrl+Shift+R</b> (Windows).</p>'
  );
  throw new Error('section.html/js version skew — hard refresh required');
}

const section = new URLSearchParams(window.location.search).get('section');

const state = {
  types: [],     // this section's equipmentTypes only
  resolved: new Set(), // typeIds whose first count lookup has finished
  sorted: false,
};

const pool = createCountPool({
  onResult: onCounts,
});

// ── Auth guard ──
let started = false;
onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.href = '../index.html';
    return;
  }
  document.getElementById('user-email').textContent = user.email;
  if (!started) {
    started = true;
    init();
  }
});

document.getElementById('sign-out-btn').addEventListener('click', async () => {
  await signOut();
  window.location.href = '../index.html';
});

// ── Load this section's types ──
async function init() {
  if (!section) {
    statusEl.className = 'status status--error';
    statusEl.textContent = 'No section specified.';
    return;
  }
  titleEl.textContent = section;
  document.title = `Skyline EOS — ${section}`;

  // Normal path: types were handed over from the inventory page (0 reads).
  const cached = loadTypesFromSession();
  if (cached) {
    state.types = cached.filter((t) => (t.section || 'Uncategorized') === section);
  }

  // Deep link / refresh fallback: fetch just this section's types.
  if (!cached) {
    try {
      state.types = await getEquipmentTypesBySection(section);
    } catch (err) {
      statusEl.className = 'status status--error';
      statusEl.textContent = `Couldn't load equipment: ${err.message}`;
      return;
    }
  }

  statusEl.hidden = true;
  addTypeBtn.hidden = false;

  // Initial render alphabetically with loading placeholders; a single
  // re-sort happens once every count has resolved (no rows jumping
  // around while numbers stream in).
  state.types.sort((a, b) => a.name.localeCompare(b.name));
  renderList();
  for (const t of state.types) pool.request(t.id, t.unitsVersion || 0);
}

// ── Rendering ──
function rowHtml(t) {
  const counts = pool.get(t.id);
  const zero = Boolean(counts && !counts.error && counts.available === 0);
  return `
    <div class="type-row" data-type-id="${esc(t.id)}">
      <span class="type-row__name">${esc(t.name)}</span>
      <span class="type-row__counts">${countsHtml(counts)}</span>
      <button class="type-row__manage" data-manage>Manage</button>
      <button class="type-row__checkout" data-checkout ${zero ? 'disabled' : ''}>Check Out</button>
    </div>`;
}

function renderList() {
  if (state.types.length === 0) {
    listEl.innerHTML = `
      <p class="status">No equipment in this section yet. Use <b>+ Add equipment type</b> to add some,
      or <a href="../inventory.html">go back to all sections</a>.</p>`;
    return;
  }

  // Before all counts resolve: flat alphabetical list with placeholders.
  if (!state.sorted) {
    listEl.innerHTML = `<div class="rows-panel">${state.types.map(rowHtml).join('')}</div>`;
    return;
  }

  // Three groups: available (most first), fully checked out, not in inventory.
  const byName = (a, b) => a.name.localeCompare(b.name);
  const availOf = (t) => pool.get(t.id).available;
  const available = [];
  const checkedOut = [];
  const notInInventory = [];
  const unknown = []; // count query failed — keep visible with retry button
  for (const t of state.types) {
    const c = pool.get(t.id);
    if (!c || c.error) unknown.push(t);
    else if (c.available > 0) available.push(t);
    else if (c.total > 0) checkedOut.push(t);
    else notInInventory.push(t);
  }
  available.sort((a, b) => availOf(b) - availOf(a) || byName(a, b));
  checkedOut.sort(byName);
  notInInventory.sort(byName);
  unknown.sort(byName);

  const mainRows = [...available, ...checkedOut, ...unknown];
  let html = `<div class="rows-panel">${mainRows.map(rowHtml).join('')}</div>`;
  if (notInInventory.length > 0) {
    html += `
      <p class="group-divider">Not currently in inventory</p>
      <div class="rows-panel">${notInInventory.map(rowHtml).join('')}</div>`;
  }
  listEl.innerHTML = html;
}

function onCounts(typeId, counts) {
  if (state.sorted) {
    // Only retries resolve after grouping — re-render to regroup the row.
    renderList();
    return;
  }

  const row = listEl.querySelector(`[data-type-id="${CSS.escape(typeId)}"]`);
  if (row) {
    row.querySelector('.type-row__counts').innerHTML = countsHtml(counts);
    row.querySelector('.type-row__checkout').disabled =
      Boolean(counts && !counts.error && counts.available === 0);
  }

  state.resolved.add(typeId);
  maybeFinishSorting();
}

function maybeFinishSorting() {
  if (state.sorted) return;
  if (state.types.every((t) => state.resolved.has(t.id))) {
    state.sorted = true;
    renderList(); // single re-render into the three groups
  }
}

// ── Inventory changes (manage / add type dialogs) ──
function onUnitsChanged(type, unitsVersion) {
  const t = state.types.find((x) => x.id === type.id);
  if (t) t.unitsVersion = unitsVersion;
  upsertTypeInSession({ ...type, unitsVersion });
  forgetCachedCounts(type.id);
  const row = listEl.querySelector(`[data-type-id="${CSS.escape(type.id)}"]`);
  if (row) row.querySelector('.type-row__counts').innerHTML = countsHtml(undefined);
  pool.retry(type.id, unitsVersion);
}

// The manage dialog just counted every unit of this type. If the row is
// showing a cached number that has drifted, refetch it.
function onCountsSeen(type, exact) {
  const shown = pool.get(type.id);
  if (!shown || shown.error) return;
  if (shown.available !== exact.available || shown.total !== exact.total) {
    forgetCachedCounts(type.id);
    pool.retry(type.id);
  }
}

function onDeleted(type, { byOther = false } = {}) {
  state.types = state.types.filter((t) => t.id !== type.id);
  state.resolved.delete(type.id);
  pool.forget(type.id);
  forgetCachedCounts(type.id);
  removeTypeFromSession(type.id);
  renderList();
  maybeFinishSorting();
  showToast(byOther
    ? `“${type.name}” was already deleted by someone else`
    : `Deleted “${type.name}”`);
}

function onCreated(type, total) {
  upsertTypeInSession(type);
  if (type.section === section) {
    state.types.push(type);
    if (!state.sorted) state.types.sort((a, b) => a.name.localeCompare(b.name));
    renderList();
    pool.request(type.id, type.unitsVersion);
  }
  showToast(
    type.section === section
      ? `Created “${type.name}” with ${total} unit${total === 1 ? '' : 's'}`
      : `Created “${type.name}” in ${type.section}`
  );
}

addTypeBtn.addEventListener('click', () => {
  const allTypes = loadTypesFromSession() || state.types;
  openAddTypeDialog({
    sections: [section, ...allTypes.map((t) => t.section || 'Uncategorized')],
    presetSection: section,
    existingTypes: allTypes,
    onCreated,
  });
});

// ── Interaction ──
listEl.addEventListener('click', (e) => {
  const retryBtn = e.target.closest('[data-retry]');
  if (retryBtn) {
    const typeId = retryBtn.closest('[data-type-id]').dataset.typeId;
    const row = listEl.querySelector(`[data-type-id="${CSS.escape(typeId)}"]`);
    if (row) row.querySelector('.type-row__counts').innerHTML = countsHtml(undefined);
    pool.retry(typeId);
    return;
  }
  if (e.target.closest('[data-manage]')) {
    const typeId = e.target.closest('[data-type-id]').dataset.typeId;
    const type = state.types.find((t) => t.id === typeId);
    if (type) openManageDialog({ type, onUnitsChanged, onDeleted, onCountsSeen });
    return;
  }
  if (e.target.closest('[data-checkout]')) {
    const typeId = e.target.closest('[data-type-id]').dataset.typeId;
    const type = state.types.find((t) => t.id === typeId);
    if (!type) return;
    window.location.href =
      `../checkout.html?typeId=${encodeURIComponent(type.id)}` +
      `&typeName=${encodeURIComponent(type.name)}`;
  }
});
