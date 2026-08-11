import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js';
import { auth } from './firebase-init.js?v=8';
import { signOut } from './auth.js?v=8';
import { subscribeActiveCheckouts } from './firestore.js?v=8';
import { esc, showToast, readProfileFromSession } from './ui-common.js?v=8';

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

  return `
    <article class="co-card${due.overdue ? ' co-card--overdue' : ''}" data-checkout-id="${esc(c.id)}">
      <div class="co-card__head">
        <span class="co-card__name">${esc(c.equipmentTypeName || 'Unknown equipment')}</span>
        ${statusBadge(c.status)}
      </div>
      <dl class="co-card__facts">
        <div>
          <dt>Still out</dt>
          <dd><strong>${outstanding(c)}</strong> of ${total}</dd>
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
      <div class="co-card__actions">
        <button type="button" class="btn-secondary btn-secondary--sm" data-return>Return</button>
      </div>
    </article>`;
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

// Returns land as a "coming soon" toast until the return flow is built.
myEl.addEventListener('click', (e) => {
  if (e.target.closest('[data-return]')) {
    showToast('Returns are coming soon.');
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
