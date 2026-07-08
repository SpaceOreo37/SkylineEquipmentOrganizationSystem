import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js';
import { auth } from './firebase-init.js';
import { signOut } from './auth.js';
import { subscribeEquipmentTypes, getUnitCounts } from './firestore.js';

const sectionsEl = document.getElementById('sections');
const statusEl = document.getElementById('inventory-status');
const searchInput = document.getElementById('search-input');
const toastEl = document.getElementById('toast');

// ── State ──
// All equipmentTypes live in memory for the session; counts are fetched
// lazily per visible type and cached so re-expanding a section is free.
const state = {
  types: [],
  loaded: false,
  query: '',
  openSections: new Set(),   // manually opened (normal browsing)
  searchClosed: new Set(),   // manually closed while a search is active
};
const countCache = new Map(); // typeId -> { available, total } | { error: true }
const inflight = new Set();

// Totals only change when units are added/removed (never on checkout), so
// they are cached across sessions. Availability is re-fetched each session.
const TOTALS_KEY = 'eos:typeTotals:v1';
const TOTALS_TTL_MS = 24 * 60 * 60 * 1000;
const totals = loadTotals();
let totalsSaveTimer = null;

let unsubscribeTypes = null;

// ── Auth guard ──
onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.href = 'index.html';
    return;
  }
  document.getElementById('user-email').textContent = user.email;
  if (!unsubscribeTypes) {
    unsubscribeTypes = subscribeEquipmentTypes(onTypesUpdate, onTypesError);
  }
});

document.getElementById('sign-out-btn').addEventListener('click', async () => {
  await signOut();
  window.location.href = 'index.html';
});

// ── Live equipmentTypes ──
function onTypesUpdate(types) {
  state.types = types;
  state.loaded = true;
  statusEl.hidden = true;
  render();
}

function onTypesError(err) {
  statusEl.hidden = false;
  statusEl.className = 'status status--error';
  statusEl.textContent = `Couldn't load inventory: ${err.message}`;
}

// ── Search ──
let searchTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = searchInput.value;
    state.searchClosed.clear();
    render();
  }, 200);
});

// ── Rendering ──
function render() {
  if (!state.loaded) return;

  const q = state.query.trim().toLowerCase();
  const visibleTypes = q
    ? state.types.filter((t) => t.name.toLowerCase().includes(q))
    : state.types;

  if (state.types.length === 0) {
    sectionsEl.innerHTML = '<p class="status">No equipment types exist yet.</p>';
    return;
  }
  if (visibleTypes.length === 0) {
    sectionsEl.innerHTML = `<p class="status">No equipment matches “${esc(state.query.trim())}”.</p>`;
    return;
  }

  const bySection = new Map();
  for (const t of visibleTypes) {
    const section = t.section || 'Uncategorized';
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section).push(t);
  }

  const html = [...bySection.keys()].sort().map((section) => {
    const items = bySection.get(section);
    // While searching, sections with matches auto-expand (unless the teacher
    // collapsed them); otherwise expansion is manual.
    const open = q
      ? !state.searchClosed.has(section)
      : state.openSections.has(section);
    return `
      <section class="inv-section">
        <button class="inv-section__header" data-section="${esc(section)}" aria-expanded="${open}">
          <span class="inv-section__chevron">${open ? '▾' : '▸'}</span>
          <span class="inv-section__name">${esc(section)}</span>
          <span class="inv-section__count">${items.length} ${items.length === 1 ? 'type' : 'types'}</span>
        </button>
        ${open ? renderSectionBody(items) : ''}
      </section>`;
  }).join('');

  sectionsEl.innerHTML = html;
  requestVisibleCounts();
}

function renderSectionBody(items) {
  if (items.length === 0) {
    return '<div class="inv-section__body"><p class="status">No equipment in this section.</p></div>';
  }
  return `
    <div class="inv-section__body">
      ${items.map((t) => `
        <div class="type-row" data-type-id="${esc(t.id)}">
          <span class="type-row__name">${esc(t.name)}</span>
          <span class="type-row__counts">${countsHtml(countCache.get(t.id))}</span>
          <button class="type-row__checkout" data-checkout="${esc(t.id)}"
                  ${isZeroAvailable(t.id) ? 'disabled' : ''}>Check Out</button>
        </div>
      `).join('')}
    </div>`;
}

function countsHtml(counts) {
  if (!counts) return '<span class="counts-loading">Loading…</span>';
  if (counts.error) return '<button class="counts-retry" data-retry>Couldn’t load — retry</button>';
  const availClass = counts.available === 0 ? 'count-available count-available--zero' : 'count-available';
  return `<span class="${availClass}">${counts.available} available</span>` +
         `<span class="count-total"> / ${counts.total} total</span>`;
}

function isZeroAvailable(typeId) {
  const c = countCache.get(typeId);
  return Boolean(c && !c.error && c.available === 0);
}

function patchRow(typeId) {
  const row = sectionsEl.querySelector(`.type-row[data-type-id="${CSS.escape(typeId)}"]`);
  if (!row) return;
  row.querySelector('.type-row__counts').innerHTML = countsHtml(countCache.get(typeId));
  row.querySelector('.type-row__checkout').disabled = isZeroAvailable(typeId);
}

// ── Interaction (event delegation) ──
sectionsEl.addEventListener('click', (e) => {
  const header = e.target.closest('.inv-section__header');
  if (header) {
    const section = header.dataset.section;
    const searching = state.query.trim() !== '';
    const set = searching ? state.searchClosed : state.openSections;
    const currentlyOpen = header.getAttribute('aria-expanded') === 'true';
    if (searching) {
      currentlyOpen ? set.add(section) : set.delete(section);
    } else {
      currentlyOpen ? set.delete(section) : set.add(section);
    }
    render();
    return;
  }

  const retry = e.target.closest('[data-retry]');
  if (retry) {
    const typeId = retry.closest('.type-row').dataset.typeId;
    countCache.delete(typeId);
    patchRow(typeId);
    enqueueCount(typeId);
    return;
  }

  const checkout = e.target.closest('[data-checkout]');
  if (checkout) {
    // Stub — checkout flow is built separately.
    showToast('Checkout is coming soon.');
  }
});

// ── Lazy count loading ──
// Counts are requested only for rows currently in the DOM (i.e. expanded
// sections / search matches), deduplicated, and fetched through a small
// concurrency pool so expanding a large section doesn't fire hundreds of
// simultaneous requests.
const queue = [];
let activeFetches = 0;
const MAX_CONCURRENT = 6;

function requestVisibleCounts() {
  for (const row of sectionsEl.querySelectorAll('.type-row')) {
    enqueueCount(row.dataset.typeId);
  }
}

function enqueueCount(typeId) {
  if (countCache.has(typeId) || inflight.has(typeId)) return;
  inflight.add(typeId);
  queue.push(typeId);
  pump();
}

function pump() {
  while (activeFetches < MAX_CONCURRENT && queue.length > 0) {
    const typeId = queue.shift();
    // Row may have been collapsed away while queued — skip, don't spend reads.
    if (!sectionsEl.querySelector(`.type-row[data-type-id="${CSS.escape(typeId)}"]`)) {
      inflight.delete(typeId);
      continue;
    }
    activeFetches++;
    fetchCounts(typeId).finally(() => {
      activeFetches--;
      inflight.delete(typeId);
      pump();
    });
  }
}

async function fetchCounts(typeId) {
  try {
    const knownTotal = totals.get(typeId);
    const result = await getUnitCounts(typeId, knownTotal === undefined);
    const total = knownTotal !== undefined ? knownTotal : result.total;
    if (result.total !== undefined) {
      totals.set(typeId, result.total);
      scheduleTotalsSave();
    }
    countCache.set(typeId, { available: result.available, total });
  } catch (err) {
    console.warn(`Count query failed for type ${typeId}:`, err);
    countCache.set(typeId, { error: true });
  }
  patchRow(typeId);
}

// ── Totals cache (localStorage, 24h TTL) ──
function loadTotals() {
  try {
    const raw = JSON.parse(localStorage.getItem(TOTALS_KEY));
    if (raw && Date.now() - raw.savedAt < TOTALS_TTL_MS) {
      return new Map(Object.entries(raw.totals));
    }
  } catch { /* corrupt or absent — start fresh */ }
  return new Map();
}

function scheduleTotalsSave() {
  clearTimeout(totalsSaveTimer);
  totalsSaveTimer = setTimeout(() => {
    try {
      localStorage.setItem(
        TOTALS_KEY,
        JSON.stringify({ savedAt: Date.now(), totals: Object.fromEntries(totals) })
      );
    } catch { /* storage full/unavailable — totals just re-fetch next session */ }
  }, 1000);
}

// ── Toast ──
let toastTimer = null;
function showToast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2500);
}

// ── Utils ──
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
