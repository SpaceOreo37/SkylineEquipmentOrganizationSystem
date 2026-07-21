import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js';
import { auth } from './firebase-init.js?v=5';
import { signOut } from './auth.js?v=5';
import { subscribeEquipmentTypes } from './firestore.js?v=5';
import {
  esc,
  showToast,
  sectionAccent,
  saveTypesToSession,
  countsHtml,
  createCountPool,
} from './ui-common.js?v=5';

const contentEl = document.getElementById('content');
const statusEl = document.getElementById('inventory-status');
const searchInput = document.getElementById('search-input');

// Version-skew guard: if the browser cached a stale copy of this page's HTML
// (or JS), required elements are missing. Fail loudly instead of blank.
if (!contentEl || !statusEl || !searchInput) {
  document.body.insertAdjacentHTML(
    'beforeend',
    '<p style="margin:2rem;padding:1rem;border:1px solid #dc2626;border-radius:8px;color:#dc2626;background:#fff">' +
      'This page is out of date. Please hard-refresh: <b>Cmd+Shift+R</b> (Mac) or <b>Ctrl+Shift+R</b> (Windows).</p>'
  );
  throw new Error('inventory.html/js version skew — hard refresh required');
}

// Searching with one or two letters can match hundreds of types; cap what we
// render (and therefore what count queries we spend) until the query narrows.
const MAX_SEARCH_RESULTS = 50;

const state = {
  types: [],   // all equipmentTypes, in memory for the whole session
  loaded: false,
  query: '',
};

const pool = createCountPool({
  onResult: patchRowCounts,
  isStillNeeded: (typeId) =>
    Boolean(contentEl.querySelector(`[data-type-id="${CSS.escape(typeId)}"]`)),
});

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
  saveTypesToSession(types); // hand-off so section pages never re-fetch
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
    render();
  }, 200);
});

// ── Rendering ──
function render() {
  if (!state.loaded) return;

  if (state.types.length === 0) {
    contentEl.innerHTML = '<p class="status">No equipment types exist yet.</p>';
    return;
  }

  const q = state.query.trim().toLowerCase();
  contentEl.innerHTML = q ? searchResultsHtml(q) : sectionCardsHtml();

  if (q) {
    for (const row of contentEl.querySelectorAll('[data-type-id]')) {
      pool.request(row.dataset.typeId);
    }
  }
}

function sectionCardsHtml() {
  const bySection = new Map();
  for (const t of state.types) {
    const section = t.section || 'Uncategorized';
    bySection.set(section, (bySection.get(section) || 0) + 1);
  }

  // Busiest sections first
  const sections = [...bySection.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  );

  return `
    <div class="section-grid">
      ${sections.map(([section, count]) => `
        <a class="section-card ${sectionAccent(section)}"
           href="sections/section.html?section=${encodeURIComponent(section)}">
          <span class="section-card__badge" aria-hidden="true">${esc(section.charAt(0).toUpperCase())}</span>
          <span class="section-card__name">${esc(section)}</span>
          <span class="section-card__meta">${count} ${count === 1 ? 'type' : 'types'}</span>
        </a>
      `).join('')}
    </div>`;
}

function searchResultsHtml(q) {
  const matches = state.types.filter((t) => t.name.toLowerCase().includes(q));

  if (matches.length === 0) {
    return `<p class="status">No equipment matches “${esc(state.query.trim())}”.</p>`;
  }

  const shown = matches.slice(0, MAX_SEARCH_RESULTS);
  const overflow = matches.length - shown.length;

  return `
    <div class="rows-panel">
      ${shown.map((t) => `
        <a class="type-row type-row--link" data-type-id="${esc(t.id)}"
           href="sections/section.html?section=${encodeURIComponent(t.section || 'Uncategorized')}">
          <span class="type-row__name">
            ${esc(t.name)}
            <span class="type-row__section">${esc(t.section || 'Uncategorized')}</span>
          </span>
          <span class="type-row__counts">${countsHtml(pool.get(t.id))}</span>
        </a>
      `).join('')}
    </div>
    ${overflow > 0
      ? `<p class="status">Showing ${shown.length} of ${matches.length} matches — keep typing to narrow.</p>`
      : ''}`;
}

function patchRowCounts(typeId, counts) {
  const row = contentEl.querySelector(`[data-type-id="${CSS.escape(typeId)}"]`);
  if (!row) return;
  row.querySelector('.type-row__counts').innerHTML = countsHtml(counts);
}

// Retry failed count loads (event delegation; the row itself is a link,
// so stop the click from navigating).
contentEl.addEventListener('click', (e) => {
  const retryBtn = e.target.closest('[data-retry]');
  if (!retryBtn) return;
  e.preventDefault();
  const typeId = retryBtn.closest('[data-type-id]').dataset.typeId;
  patchRowCounts(typeId, undefined); // back to loading state
  pool.retry(typeId);
});
