import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js';
import { auth } from './firebase-init.js?v=10';
import { signOut } from './auth.js?v=10';
import { subscribeActiveCheckouts, returnEquipment } from './firestore.js?v=10';
import { esc, showToast, readProfileFromSession, invalidateCachedAvail } from './ui-common.js?v=10';

const statusEl = document.getElementById('dashboard-status');
const myEl = document.getElementById('my-checkouts');
const mySummaryEl = document.getElementById('my-summary');
const deptEl = document.getElementById('dept-checkouts');
const deptSummaryEl = document.getElementById('dept-summary');

// Version-skew guard: if the browser cached a stale copy of this page's HTML
// (or JS), required elements are missing. Fail loudly instead of blank.
if (!statusEl || !myEl || !mySummaryEl || !deptEl || !deptSummaryEl) {
  document.body.insertAdjacentHTML(
    'beforeend',
    '<p style="margin:2rem;padding:1rem;border:1px solid #dc2626;border-radius:8px;color:#dc2626;background:#fff">' +
      'This page is out of date. Please hard-refresh: <b>Cmd+Shift+R</b> (Mac) or <b>Ctrl+Shift+R</b> (Windows).</p>'
  );
  throw new Error('dashboard.html/js version skew — hard refresh required');
}

const STATUS_LABELS = { 'in-use': 'In Use', partial: 'Partial Return' };
const STATUS_CLASSES = { 'in-use': 'badge--in-use', partial: 'badge--partial' };

const state = {
  uid: null,
  teacherName: '',
  checkouts: [],
  loaded: false,
};

// ── Return form UI state (per checkout, survives re-renders) ──
// Keyed by checkout id rather than baked into `state.checkouts` because the
// live checkout data is replaced wholesale on every onSnapshot fire (e.g. a
// department-mate's unrelated checkout changing), while an in-progress
// return form's open/typed state must not be wiped out by that.
const returnUi = new Map();

function getReturnUi(id) {
  if (!returnUi.has(id)) {
    returnUi.set(id, { open: false, quantity: 1, notes: '', submitting: false, error: null });
  }
  return returnUi.get(id);
}

// ── Auth guard ──
let unsubscribe = null;

onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.href = 'index.html';
    return;
  }
  document.getElementById('user-email').textContent = user.email;
  if (unsubscribe) return;

  // The auth uid is exactly the `teacherUid` stored on every checkout, so this
  // page needs no profile read at all. The cached profile is used only for a
  // nicer display name when it already happens to be in sessionStorage.
  state.uid = user.uid;
  const profile = readProfileFromSession(user.uid);
  state.teacherName = profile?.teacherName || user.email;

  unsubscribe = subscribeActiveCheckouts(onCheckouts, onError);
});

document.getElementById('sign-out-btn').addEventListener('click', async () => {
  await signOut();
  window.location.href = 'index.html';
});

// ── Live checkouts (one listener feeds both sections) ──
function onCheckouts(checkouts) {
  state.checkouts = checkouts;
  state.loaded = true;
  statusEl.hidden = true;
  render();
}

function onError(err) {
  statusEl.hidden = false;
  statusEl.className = 'status status--error';
  statusEl.textContent = `Couldn't load checkouts: ${err.message}`;
}

// ── Rendering ──
let renderedDay = null;

function render() {
  if (!state.loaded) return;
  const now = new Date();
  renderedDay = startOfDay(now).getTime();

  const mine = state.checkouts
    .filter((c) => c.teacherUid === state.uid)
    .sort(byDueDate);

  renderMine(mine, now);
  renderDept(state.checkouts, now);
}

function renderMine(mine, now) {
  mySummaryEl.innerHTML = summaryHtml(mine, now);

  if (mine.length === 0) {
    myEl.innerHTML = emptyHtml('You have nothing checked out right now.');
    return;
  }
  myEl.innerHTML = `<div class="co-cards">${mine.map((c) => myCardHtml(c, now)).join('')}</div>`;
}

function renderDept(all, now) {
  deptSummaryEl.innerHTML = summaryHtml(all, now);

  if (all.length === 0) {
    deptEl.innerHTML = emptyHtml('No equipment is currently checked out.');
    return;
  }

  // Group by teacher, keyed on uid rather than name so two teachers who happen
  // to share a name never collapse into one group.
  const groups = new Map();
  for (const c of all) {
    const key = c.teacherUid || `name:${c.teacherName || ''}`;
    if (!groups.has(key)) {
      groups.set(key, {
        name: c.teacherName || 'Unknown teacher',
        isMe: Boolean(state.uid) && c.teacherUid === state.uid,
        items: [],
      });
    }
    groups.get(key).items.push(c);
  }

  const sorted = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const g of sorted) g.items.sort(byDueDate);

  deptEl.innerHTML = sorted.map((g) => `
    <div class="teacher-group">
      <h4 class="teacher-group__name">
        ${esc(g.name)}${g.isMe ? '<span class="teacher-group__you">you</span>' : ''}
      </h4>
      <div class="rows-panel">
        ${g.items.map((c) => deptRowHtml(c, now)).join('')}
      </div>
    </div>`).join('');
}

function myCardHtml(c, now) {
  const due = dueInfo(toDate(c.expectedReturnDate), now);
  const total = Number(c.quantity) || 0;
  const checkedOutOn = toDate(c.checkoutDate);
  const out = outstanding(c);
  const ui = getReturnUi(c.id);

  return `
    <article class="co-card${due.overdue ? ' co-card--overdue' : ''}" data-checkout-id="${esc(c.id)}">
      <div class="co-card__head">
        <span class="co-card__name">${esc(c.equipmentTypeName || 'Unknown equipment')}</span>
        ${statusBadge(c.status)}
      </div>
      <dl class="co-card__facts">
        <div>
          <dt>Still out</dt>
          <dd><strong>${out}</strong> of ${total}</dd>
        </div>
        <div>
          <dt>Checked out</dt>
          <dd>${esc(checkedOutOn ? formatDate(checkedOutOn) : 'Just now')}</dd>
        </div>
        <div>
          <dt>Due back</dt>
          <dd class="${due.cls}">${esc(due.label)}</dd>
        </div>
      </dl>
      ${ui.open ? returnFormHtml(c, out, ui) : `
      <div class="co-card__actions">
        <button type="button" class="btn-secondary btn-secondary--sm" data-return>Return</button>
      </div>`}
    </article>`;
}

function returnFormHtml(c, out, ui) {
  const qty = Math.min(Math.max(Math.floor(Number(ui.quantity)) || 1, 1), out);
  return `
    <form class="return-form" data-return-form novalidate>
      <label for="return-qty-${esc(c.id)}">Quantity to return</label>
      <input type="number" id="return-qty-${esc(c.id)}" data-return-qty
             min="1" max="${out}" step="1" inputmode="numeric"
             value="${qty}" ${ui.submitting ? 'disabled' : ''}>

      <label for="return-notes-${esc(c.id)}">Return notes <span class="optional">(optional)</span></label>
      <textarea id="return-notes-${esc(c.id)}" data-return-notes rows="2"
                ${ui.submitting ? 'disabled' : ''}>${esc(ui.notes)}</textarea>

      ${ui.error ? `<p class="error">${esc(ui.error)}</p>` : ''}

      <div class="button-row return-form__actions">
        <button type="submit" class="btn-primary btn-secondary--sm" ${ui.submitting ? 'disabled' : ''}>
          ${ui.submitting ? 'Returning…' : 'Confirm Return'}
        </button>
        <button type="button" class="btn-secondary btn-secondary--sm" data-return-cancel ${ui.submitting ? 'disabled' : ''}>
          Cancel
        </button>
      </div>
    </form>`;
}

function deptRowHtml(c, now) {
  const due = dueInfo(toDate(c.expectedReturnDate), now);
  return `
    <div class="co-row">
      <span class="co-row__name">${esc(c.equipmentTypeName || 'Unknown equipment')}</span>
      <span class="co-row__qty">${outstanding(c)} out</span>
      <span class="co-row__due ${due.cls}">${esc(due.label)}</span>
      ${statusBadge(c.status)}
    </div>`;
}

function statusBadge(status) {
  const label = STATUS_LABELS[status] || status || 'Unknown';
  const cls = STATUS_CLASSES[status] || 'badge--checked-out';
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function summaryHtml(items, now) {
  if (items.length === 0) return '';
  const units = items.reduce((n, c) => n + outstanding(c), 0);
  const overdue = items.filter((c) => dueInfo(toDate(c.expectedReturnDate), now).overdue).length;
  const base = `${units} ${units === 1 ? 'unit' : 'units'} out`;
  return overdue > 0
    ? `${base}<span class="overdue-pill">${overdue} overdue</span>`
    : base;
}

function emptyHtml(message) {
  return `<p class="empty-state">${esc(message)}</p>`;
}

// ── Return flow ──
// The form lives inline in the card rather than a modal (no modal pattern
// exists elsewhere in this app). Opening/cancelling/submitting all go through
// getReturnUi() + render() so the UI stays a pure function of state + returnUi;
// typing (the 'input' listener below) mutates returnUi directly without a
// render(), so the browser's own text input keeps focus and cursor position.
myEl.addEventListener('click', (e) => {
  const openBtn = e.target.closest('[data-return]');
  if (openBtn) {
    const id = openBtn.closest('[data-checkout-id]')?.dataset.checkoutId;
    const c = id && state.checkouts.find((x) => x.id === id);
    if (!c) return;
    const ui = getReturnUi(id);
    ui.open = true;
    ui.error = null;
    ui.quantity = outstanding(c); // default: return everything still out
    ui.notes = '';
    render();
    return;
  }

  const cancelBtn = e.target.closest('[data-return-cancel]');
  if (cancelBtn) {
    const id = cancelBtn.closest('[data-checkout-id]')?.dataset.checkoutId;
    if (id) returnUi.delete(id);
    render();
  }
});

myEl.addEventListener('input', (e) => {
  const qtyInput = e.target.closest('[data-return-qty]');
  if (qtyInput) {
    const id = qtyInput.closest('[data-checkout-id]')?.dataset.checkoutId;
    if (!id) return;
    const c = state.checkouts.find((x) => x.id === id);
    const out = c ? outstanding(c) : Infinity;
    if (Number(qtyInput.value) > out) qtyInput.value = out;
    getReturnUi(id).quantity = qtyInput.value;
    return;
  }

  const notesInput = e.target.closest('[data-return-notes]');
  if (notesInput) {
    const id = notesInput.closest('[data-checkout-id]')?.dataset.checkoutId;
    if (id) getReturnUi(id).notes = notesInput.value;
  }
});

myEl.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-return-form]');
  if (!form) return;
  e.preventDefault();

  const id = form.closest('[data-checkout-id]')?.dataset.checkoutId;
  const c = id && state.checkouts.find((x) => x.id === id);
  if (!c) return;
  const ui = getReturnUi(id);
  if (ui.submitting) return;

  const out = outstanding(c);
  const quantity = Math.floor(Number(ui.quantity));
  if (!Number.isFinite(quantity) || quantity < 1) {
    ui.error = 'Quantity must be at least 1.';
    render();
    return;
  }
  if (quantity > out) {
    ui.error = `Only ${out} unit(s) outstanding.`;
    render();
    return;
  }

  ui.submitting = true;
  ui.error = null;
  render();

  try {
    const result = await returnEquipment({
      checkoutId: id,
      quantity,
      returnNotes: ui.notes.trim(),
    });
    // Close the form and let the live listener refresh the card: the
    // transaction's write fires onSnapshot, which re-renders with the
    // updated (or, if fully returned, removed) checkout.
    returnUi.delete(id);
    // Units just went back to "available" — bust the inventory/section
    // pages' 5-minute availability cache so they don't keep showing the
    // pre-return count (same reason checkout.js invalidates it on checkout).
    invalidateCachedAvail(c.equipmentTypeId);
    showToast(
      result.fullyReturned
        ? `Returned all ${quantity} unit(s) — checkout closed.`
        : `Returned ${quantity} unit(s) — ${out - quantity} still outstanding.`
    );
  } catch (err) {
    console.error('Return failed:', err);
    ui.submitting = false;
    ui.error = err.message || 'Return failed. Please try again.';
    render();
  }
});

// A dashboard left open overnight would keep showing yesterday's "due today".
// Re-render only when the calendar day actually rolls over — costs no reads,
// and never disturbs the page during the school day.
setInterval(() => {
  if (state.loaded && startOfDay(new Date()).getTime() !== renderedDay) render();
}, 60 * 1000);

// ── Checkout helpers ──
function outstanding(c) {
  const returned = Array.isArray(c.returnedUnitIds) ? c.returnedUnitIds.length : 0;
  return Math.max(0, (Number(c.quantity) || 0) - returned);
}

function byDueDate(a, b) {
  const first = toDate(a.expectedReturnDate);
  const second = toDate(b.expectedReturnDate);
  if (!first && !second) return 0;
  if (!first) return 1;   // undated loans sink to the bottom
  if (!second) return -1;
  return first - second;
}

// ── Date helpers ──
const DAY_MS = 24 * 60 * 60 * 1000;

// Firestore Timestamp | Date | parseable value -> Date, or null. checkoutDate
// is written with serverTimestamp(), so it reads back null on the writer's own
// local snapshot until the server confirms it.
function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Whole calendar days from `from` to `to`, rounded because DST makes some days
// 23 or 25 hours long.
function daysBetween(from, to) {
  return Math.round((startOfDay(to) - startOfDay(from)) / DAY_MS);
}

function formatDate(d) {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * How a due date should read, and whether it counts as late.
 *
 * expectedReturnDate is stored as local midnight of the day the teacher picked,
 * so lateness is measured in whole days rather than against the raw timestamp —
 * a literal `expectedReturnDate < now` would turn every loan red at 12:01am on
 * the very morning it is due back.
 */
function dueInfo(due, now) {
  if (!due) return { overdue: false, label: 'No due date', cls: 'due due--none' };

  const dateText = formatDate(due);
  const daysLate = daysBetween(due, now);

  if (daysLate > 0) {
    return {
      overdue: true,
      label: `${dateText} · ${daysLate} ${daysLate === 1 ? 'day' : 'days'} overdue`,
      cls: 'due due--overdue',
    };
  }
  if (daysLate === 0) {
    return { overdue: false, label: `${dateText} · due today`, cls: 'due due--soon' };
  }
  const daysLeft = -daysLate;
  return {
    overdue: false,
    label: `${dateText} · in ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'}`,
    cls: 'due',
  };
}
