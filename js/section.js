import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js';
import { auth } from './firebase-init.js?v=8';
import { signOut } from './auth.js?v=8';
import { getEquipmentTypesBySection } from './firestore.js?v=8';
import {
  esc,
  loadTypesFromSession,
  countsHtml,
  createCountPool,
} from './ui-common.js?v=8';

const titleEl = document.getElementById('section-title');
const statusEl = document.getElementById('section-status');
const listEl = document.getElementById('type-list');

// Version-skew guard: if the browser cached a stale copy of this page's HTML
// (or JS), required elements are missing. Fail loudly instead of blank.
if (!titleEl || !statusEl || !listEl) {
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
  resolved: 0,   // how many count lookups have finished (success or error)
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

  if (state.types.length === 0) {
    listEl.innerHTML = `
      <p class="status">No equipment in this section.
      <a href="../inventory.html">Back to all sections</a></p>`;
    return;
  }

  // Initial render alphabetically with loading placeholders; a single
  // re-sort happens once every count has resolved (no rows jumping
  // around while numbers stream in).
  state.types.sort((a, b) => a.name.localeCompare(b.name));
  renderList();
  for (const t of state.types) pool.request(t.id);
}

// ── Rendering ──
function rowHtml(t) {
  const counts = pool.get(t.id);
  const zero = Boolean(counts && !counts.error && counts.available === 0);
  return `
    <div class="type-row" data-type-id="${esc(t.id)}">
      <span class="type-row__name">${esc(t.name)}</span>
      <span class="type-row__counts">${countsHtml(counts)}</span>
      <button class="type-row__checkout" data-checkout ${zero ? 'disabled' : ''}>Check Out</button>
    </div>`;
}

function renderList() {
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

  state.resolved++;
  if (state.resolved >= state.types.length) {
    state.sorted = true;
    renderList(); // single re-render into the three groups
  }
}

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
  if (e.target.closest('[data-checkout]')) {
    const typeId = e.target.closest('[data-type-id]').dataset.typeId;
    const type = state.types.find((t) => t.id === typeId);
    if (!type) return;
    window.location.href =
      `../checkout.html?typeId=${encodeURIComponent(type.id)}` +
      `&typeName=${encodeURIComponent(type.name)}`;
  }
});
