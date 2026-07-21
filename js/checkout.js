import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js';
import { auth } from './firebase-init.js?v=5';
import { signOut } from './auth.js?v=5';
import {
  checkoutEquipment,
  getOtherRoomsBreakdown,
  getRoomSplitCounts,
  getTeacherNameByRoom,
  getUserProfile,
  NOT_ENOUGH_UNITS_MSG,
} from './firestore.js?v=5';
import {
  esc,
  loadTypesFromSession,
  invalidateCachedAvail,
} from './ui-common.js?v=5';

const statusEl = document.getElementById('checkout-status');
const formEl = document.getElementById('checkout-form');
const searchEl = document.getElementById('type-search');
const optionsEl = document.getElementById('type-options');
const availabilityEl = document.getElementById('availability');
const quantityEl = document.getElementById('quantity');
const noteEl = document.getElementById('distribution-note');
const returnDateEl = document.getElementById('return-date');
const notesEl = document.getElementById('notes');
const submitBtn = document.getElementById('submit-btn');
const formErrorEl = document.getElementById('form-error');
const successEl = document.getElementById('success-view');

// Version-skew guard: if the browser cached a stale copy of this page's HTML
// (or JS), required elements are missing. Fail loudly instead of blank.
if (!statusEl || !formEl || !searchEl || !optionsEl || !quantityEl || !noteEl || !returnDateEl) {
  document.body.insertAdjacentHTML(
    'beforeend',
    '<p style="margin:2rem;padding:1rem;border:1px solid #dc2626;border-radius:8px;color:#dc2626;background:#fff">' +
      'This page is out of date. Please hard-refresh: <b>Cmd+Shift+R</b> (Mac) or <b>Ctrl+Shift+R</b> (Windows).</p>'
  );
  throw new Error('checkout.html/js version skew — hard refresh required');
}

const MAX_OPTIONS = 20;

const state = {
  profile: null,       // { uid, teacherName, roomNumber }
  types: null,         // equipmentTypes from sessionStorage, or null
  selectedType: null,  // { id, name }
  available: null,     // fresh count for the selected type (home + other)
  split: null,         // { home, other } counts for the distribution note
  breakdown: null,     // { rooms: [{ room, count, label }] } | { error: true }
  breakdownLoading: false,
  submitting: false,
};

// ── Auth guard ──
let started = false;
onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.href = 'index.html';
    return;
  }
  document.getElementById('user-email').textContent = user.email;
  if (!started) {
    started = true;
    init(user);
  }
});

document.getElementById('sign-out-btn').addEventListener('click', async () => {
  await signOut();
  window.location.href = 'index.html';
});

// ── Teacher profile (users doc) — one fetch per session, then sessionStorage ──
const PROFILE_KEY = 'eos:profile:v1';

async function loadProfile(user) {
  try {
    const cached = JSON.parse(sessionStorage.getItem(PROFILE_KEY));
    if (cached && cached.uid === user.uid) return cached;
  } catch { /* corrupt — refetch */ }

  const p = await getUserProfile(user.uid);
  const profile = {
    uid: user.uid,
    teacherName: p.displayName || user.email,
    roomNumber: p.roomNumber ?? null,
  };
  try { sessionStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch { /* fine */ }
  return profile;
}

// ── Init ──
async function init(user) {
  try {
    state.profile = await loadProfile(user);
  } catch (err) {
    statusEl.className = 'status status--error';
    statusEl.textContent = `Couldn't load your profile: ${err.message}`;
    return;
  }

  state.types = loadTypesFromSession();

  // Pre-select the type handed over from the section page's Check Out button.
  const params = new URLSearchParams(window.location.search);
  const typeId = params.get('typeId');
  const typeName = params.get('typeName');

  if (state.types && typeId) {
    const t = state.types.find((x) => x.id === typeId);
    state.selectedType = t ? { id: t.id, name: t.name } : null;
  }
  if (!state.selectedType && typeId && typeName) {
    state.selectedType = { id: typeId, name: typeName };
  }

  // No type list to search and nothing pre-selected — the read-light rule is
  // to never re-fetch all types here, so send the teacher through inventory.
  if (!state.types && !state.selectedType) {
    statusEl.className = 'status status--error';
    statusEl.innerHTML =
      'Please start from the <a href="inventory.html">inventory page</a> and pick equipment to check out.';
    return;
  }

  statusEl.hidden = true;
  formEl.hidden = false;
  returnDateEl.min = dateToInputValue(addDays(new Date(), 1));

  if (state.selectedType) {
    searchEl.value = state.selectedType.name;
    refreshAvailability();
  }
  if (!state.types) {
    // Deep link with a pre-selected type but no session type list: the type
    // is locked; searching would require a full re-fetch we refuse to spend.
    searchEl.readOnly = true;
  }
}

// ── Equipment combobox ──
function openOptions(matches) {
  optionsEl.innerHTML = matches.map((t) => `
    <button type="button" class="combobox__option" data-id="${esc(t.id)}" data-name="${esc(t.name)}">
      ${esc(t.name)}<span class="combobox__option-section">${esc(t.section || 'Uncategorized')}</span>
    </button>`).join('');
  optionsEl.hidden = matches.length === 0;
  searchEl.setAttribute('aria-expanded', String(matches.length > 0));
}

function closeOptions() {
  optionsEl.hidden = true;
  searchEl.setAttribute('aria-expanded', 'false');
}

function matchTypes(q) {
  return state.types
    .filter((t) => t.name.toLowerCase().includes(q))
    .slice(0, MAX_OPTIONS);
}

searchEl.addEventListener('input', () => {
  // Any edit invalidates the current selection.
  state.selectedType = null;
  state.available = null;
  state.split = null;
  state.breakdown = null;
  availabilityEl.hidden = true;
  noteEl.hidden = true;
  updateSubmitState();

  if (!state.types) return;
  const q = searchEl.value.trim().toLowerCase();
  if (!q) {
    closeOptions();
    return;
  }
  openOptions(matchTypes(q));
});

searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const first = optionsEl.querySelector('.combobox__option');
    if (first && !optionsEl.hidden) selectType(first.dataset.id, first.dataset.name);
  } else if (e.key === 'Escape') {
    closeOptions();
  }
});

// mousedown (not click) so selection wins over the input's blur.
optionsEl.addEventListener('mousedown', (e) => {
  const btn = e.target.closest('.combobox__option');
  if (btn) {
    e.preventDefault();
    selectType(btn.dataset.id, btn.dataset.name);
  }
});

searchEl.addEventListener('blur', () => closeOptions());

function selectType(id, name) {
  state.selectedType = { id, name };
  searchEl.value = name;
  closeOptions();
  refreshAvailability();
}

// ── Availability (two count() aggregations — home room + other rooms) ──
// available is derived as home + other, so the availability display costs
// the same 2 reads that the distribution note needs anyway.
let availReq = 0;

async function refreshAvailability() {
  const type = state.selectedType;
  if (!type) return;
  const reqId = ++availReq;

  state.available = null;
  state.split = null;
  state.breakdown = null;
  updateSubmitState();
  availabilityEl.hidden = false;
  availabilityEl.className = 'availability availability--muted';
  availabilityEl.textContent = 'Checking availability…';
  setNote(true, 'Calculating availability...');

  try {
    const split = await getRoomSplitCounts(type.id, state.profile.roomNumber);
    if (reqId !== availReq || state.selectedType !== type) return;
    state.split = split;
    const available = split.home + split.other;
    state.available = available;
    if (available === 0) {
      availabilityEl.className = 'availability availability--zero';
      availabilityEl.textContent = 'None available — all units are currently checked out.';
      noteEl.hidden = true; // the availability line already says it all
    } else {
      availabilityEl.className = 'availability availability--ok';
      availabilityEl.textContent = `${available} available`;
      quantityEl.max = available;
      if (Number(quantityEl.value) > available) quantityEl.value = available;
      renderDistributionNote();
    }
  } catch (err) {
    if (reqId !== availReq) return;
    availabilityEl.className = 'availability availability--zero';
    availabilityEl.textContent = `Couldn't check availability: ${err.message}`;
    setNote(false, 'Unable to calculate distribution, please check with your department');
  }
  updateSubmitState();
}

// ── Distribution note ──
// Rendered purely from the in-memory split counts on every quantity change
// (zero reads). The per-room breakdown of other rooms is fetched at most
// once per type selection, and teacher-name lookups are cached per room
// for the whole page lifetime.
const roomTeacherCache = new Map(); // homeRoom -> displayName | null
let breakdownReq = 0;

function setNote(muted, text) {
  noteEl.hidden = false;
  noteEl.className = muted ? 'distribution-note distribution-note--muted' : 'distribution-note';
  noteEl.textContent = text;
}

function joinWithAnd(parts) {
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

function renderDistributionNote() {
  const type = state.selectedType;
  if (!type || !state.split || !state.available) {
    noteEl.hidden = true;
    return;
  }

  const { home } = state.split;
  const room = state.profile.roomNumber;
  let qty = Math.floor(Number(quantityEl.value));
  if (!Number.isFinite(qty) || qty < 1) qty = 1;
  if (qty > state.available) qty = state.available;

  // Case 1 — the teacher's own room covers the whole request.
  if (qty <= home) {
    setNote(false,
      `All ${qty} ${qty === 1 ? 'unit is' : 'units are'} in your room (Room ${room}), grab them from there.`);
    return;
  }

  // Case 2 — needs the per-room breakdown of other rooms (fetched once).
  if (!state.breakdown) {
    if (!state.breakdownLoading) loadBreakdown(type);
    setNote(true, 'Calculating availability...');
    return;
  }
  if (state.breakdown.error) {
    setNote(false, 'Unable to calculate distribution, please check with your department');
    return;
  }

  const fromHome = Math.min(qty, home);
  let remaining = qty - fromHome;
  const parts = [];
  for (const r of state.breakdown.rooms) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, r.count);
    parts.push(`${take} from ${r.label}`);
    remaining -= take;
  }

  if (parts.length === 0) {
    // qty is clamped to available, so this only happens on stale counts.
    setNote(false, 'Unable to calculate distribution, please check with your department');
    return;
  }

  if (fromHome === 0) {
    setNote(false, `No units in your room. Get ${joinWithAnd(parts)}.`);
  } else {
    setNote(false,
      `Take ${fromHome} from your room (Room ${room}), then ${joinWithAnd(parts)}.`);
  }
}

async function loadBreakdown(type) {
  const reqId = ++breakdownReq;
  state.breakdownLoading = true;
  try {
    const rooms = await getOtherRoomsBreakdown(type.id, state.profile.roomNumber);
    // Resolve teacher names for every room in the breakdown up front so
    // later quantity changes never trigger reads. Cache hits are free.
    const withLabels = await Promise.all(rooms.map(async (r) => {
      if (!roomTeacherCache.has(r.room)) {
        let name = null;
        try { name = await getTeacherNameByRoom(r.room); } catch { /* label falls back to room */ }
        roomTeacherCache.set(r.room, name);
      }
      const name = roomTeacherCache.get(r.room);
      return { ...r, label: name ? `${name}'s room (Room ${r.room})` : `Room ${r.room}` };
    }));
    if (reqId !== breakdownReq || state.selectedType !== type) return;
    state.breakdown = { rooms: withLabels };
  } catch (err) {
    if (reqId !== breakdownReq || state.selectedType !== type) return;
    console.warn('Distribution breakdown failed:', err);
    state.breakdown = { error: true };
  } finally {
    if (reqId === breakdownReq) state.breakdownLoading = false;
  }
  renderDistributionNote();
}

function updateSubmitState() {
  submitBtn.disabled =
    state.submitting || !state.selectedType || !state.available;
}

quantityEl.addEventListener('input', () => {
  if (state.available && Number(quantityEl.value) > state.available) {
    quantityEl.value = state.available;
  }
  renderDistributionNote();
});

// ── Submit ──
function showFormError(message) {
  formErrorEl.textContent = message;
  formErrorEl.hidden = false;
}

formEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.submitting) return;
  formErrorEl.hidden = true;

  const type = state.selectedType;
  if (!type) {
    showFormError('Please pick an equipment type from the list.');
    return;
  }

  const quantity = Math.floor(Number(quantityEl.value));
  if (!Number.isFinite(quantity) || quantity < 1) {
    showFormError('Quantity must be at least 1.');
    return;
  }
  if (state.available !== null && quantity > state.available) {
    showFormError(`Only ${state.available} available — please lower the quantity.`);
    return;
  }

  const returnDate = parseDateInput(returnDateEl.value);
  if (!returnDate) {
    showFormError('Please pick an expected return date.');
    return;
  }
  if (returnDate <= endOfToday()) {
    showFormError('Expected return date must be in the future.');
    return;
  }

  state.submitting = true;
  updateSubmitState();
  submitBtn.textContent = 'Checking out…';

  try {
    const result = await checkoutEquipment({
      uid: state.profile.uid,
      teacherName: state.profile.teacherName,
      roomNumber: state.profile.roomNumber,
      typeId: type.id,
      typeName: type.name,
      quantity,
      expectedReturnDate: returnDate,
      notes: notesEl.value.trim(),
    });
    invalidateCachedAvail(type.id);
    showSuccess(type, quantity, returnDate, result.units);
  } catch (err) {
    console.error('Checkout failed:', err);
    showFormError(
      err.message === NOT_ENOUGH_UNITS_MSG
        ? NOT_ENOUGH_UNITS_MSG
        : `Checkout failed: ${err.message}`
    );
    refreshAvailability(); // count likely changed if someone beat us to it
  } finally {
    state.submitting = false;
    submitBtn.textContent = 'Check Out';
    updateSubmitState();
  }
});

// ── Success ──
function showSuccess(type, quantity, returnDate, units) {
  const roomCounts = new Map();
  for (const u of units) {
    const room = u.homeRoom ?? 'Unknown room';
    roomCounts.set(room, (roomCounts.get(room) || 0) + 1);
  }
  const roomsText = [...roomCounts.entries()]
    .map(([room, n]) => `Room ${esc(String(room))} × ${n}`)
    .join(', ');

  const dueText = returnDate.toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  formEl.hidden = true;
  successEl.hidden = false;
  successEl.innerHTML = `
    <h3>✓ Checked out</h3>
    <dl class="success-card__details">
      <dt>Equipment</dt><dd>${esc(type.name)}</dd>
      <dt>Quantity</dt><dd>${quantity}</dd>
      <dt>From</dt><dd>${roomsText}</dd>
      <dt>Due back</dt><dd>${esc(dueText)}</dd>
    </dl>
    <a class="btn-primary" href="inventory.html">Back to Inventory</a>`;
}

// ── Date helpers ──
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function dateToInputValue(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Parse yyyy-mm-dd as a local date (new Date(string) would treat it as UTC).
function parseDateInput(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function endOfToday() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}
