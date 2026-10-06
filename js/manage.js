// Inventory management dialogs: create an equipment type, and add units to /
// remove units from / delete an existing one. Shared by the inventory page
// and the section page; each page passes callbacks to update its own view.
//
// Every destructive action is two-step: the form's button opens a separate
// confirmation dialog that spells out exactly what will be deleted, and
// nothing is written until that is confirmed.
import { auth } from './firebase-init.js?v=11';
import {
  ROOM_RE,
  MAX_UNITS_PER_CHANGE,
  TYPE_GONE_MSG,
  getTypeRoomBreakdown,
  createEquipmentType,
  addUnits,
  removeUnits,
  deleteEquipmentType,
} from './firestore.js?v=11';
import { esc, loadProfile, readProfileFromSession } from './ui-common.js?v=11';

const ROOM_HINT = 'Room numbers are 4 digits, e.g. 1111 or 2045.';

/** The signed-in teacher, for the inventory log. One cached profile read. */
async function getActor() {
  const user = auth.currentUser;
  if (!user) throw new Error('You are signed out. Please sign in again.');
  try {
    const p = await loadProfile(user);
    return { uid: p.uid, teacherName: p.teacherName };
  } catch {
    // No users doc — still allow the change, logged under the email.
    return { uid: user.uid, teacherName: user.email };
  }
}

function ownRoom() {
  const user = auth.currentUser;
  const room = user && readProfileFromSession(user.uid)?.roomNumber;
  return room && ROOM_RE.test(String(room)) ? String(room) : '';
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const roomsSummary = (rooms) =>
  rooms.map((r) => `${r.quantity} in room ${esc(r.room)}`).join(', ');

// ── Dialog plumbing ──

function makeDialog(className = '') {
  const dlg = document.createElement('dialog');
  dlg.className = `modal ${className}`.trim();
  document.body.appendChild(dlg);
  // While a write is in flight, Escape must not close the dialog and lose
  // track of the result.
  dlg.addEventListener('cancel', (e) => {
    if (dlg.dataset.busy) e.preventDefault();
  });
  dlg.addEventListener('close', () => dlg.remove());
  return dlg;
}

/** Close and remove now, without waiting for the (possibly delayed) close event. */
function closeDialog(dlg) {
  delete dlg.dataset.busy;
  if (dlg.open) dlg.close();
  dlg.remove();
}

function setBusy(dlg, busy) {
  if (busy) dlg.dataset.busy = '1';
  else delete dlg.dataset.busy;
  for (const el of dlg.querySelectorAll('input, button, select')) {
    if (busy) {
      el.dataset.wasDisabled = el.disabled ? '1' : '';
      el.disabled = true;
    } else {
      el.disabled = el.dataset.wasDisabled === '1';
      delete el.dataset.wasDisabled;
    }
  }
}

/**
 * Second-step confirmation. Resolves true only if the teacher clicks the
 * confirm button; Escape, Cancel, or closing the dialog all resolve false.
 */
export function confirmAction({ title, bodyHtml, confirmLabel }) {
  return new Promise((resolve) => {
    const dlg = makeDialog('modal--confirm');
    dlg.setAttribute('role', 'alertdialog');
    dlg.innerHTML = `
      <h3 class="modal__title">${esc(title)}</h3>
      <div class="modal__body">${bodyHtml}</div>
      <div class="modal__actions">
        <button type="button" class="btn-secondary" data-cancel>Cancel</button>
        <button type="button" class="btn-danger" data-confirm>${esc(confirmLabel)}</button>
      </div>`;
    // Resolve straight from the buttons. The dialog's `close` event is only
    // the fallback for Escape: browsers can hold that event back while the
    // tab is hidden, and the confirmed action must not hang on it.
    const finish = (confirmed) => {
      resolve(confirmed); // later calls are no-ops
      closeDialog(dlg);
    };
    dlg.querySelector('[data-cancel]').addEventListener('click', () => finish(false));
    dlg.querySelector('[data-confirm]').addEventListener('click', () => finish(true));
    dlg.addEventListener('close', () => resolve(false));
    dlg.showModal();
    // Safe default: focus lands on Cancel, so a stray Enter doesn't confirm.
    dlg.querySelector('[data-cancel]').focus();
  });
}

// ── Room + quantity rows (used by "new type" and "add units") ──

function roomRowHtml(room = '') {
  return `
    <div class="room-row" data-room-row>
      <input class="room-row__room" type="text" inputmode="numeric" maxlength="4"
             placeholder="Room" aria-label="Room number" list="eos-room-options"
             value="${esc(room)}" autocomplete="off">
      <input class="room-row__qty" type="number" min="1" max="${MAX_UNITS_PER_CHANGE}"
             step="1" placeholder="Qty" aria-label="Quantity">
      <button type="button" class="room-row__remove" data-remove-row
              aria-label="Remove this room">×</button>
    </div>`;
}

function roomEditorHtml(knownRooms) {
  const options = [...new Set(knownRooms.filter((r) => ROOM_RE.test(r)))].sort();
  return `
    <div class="room-editor">
      <div class="room-editor__head" aria-hidden="true"><span>Room</span><span>Quantity</span></div>
      <div data-room-rows>${roomRowHtml(ownRoom())}</div>
      <button type="button" class="link-btn" data-add-row>+ Another room</button>
      <datalist id="eos-room-options">
        ${options.map((r) => `<option value="${esc(r)}"></option>`).join('')}
      </datalist>
    </div>`;
}

function wireRoomEditor(root) {
  const rowsEl = root.querySelector('[data-room-rows]');
  // The profile may not be cached yet on this page: fetch it (once per
  // session) and fill the first room if the teacher hasn't typed one.
  if (!ownRoom()) {
    getActor().then(() => {
      const first = rowsEl.querySelector('.room-row__room');
      if (first && !first.value && ownRoom()) first.value = ownRoom();
    }).catch(() => { /* no profile — the field just starts empty */ });
  }
  const syncRemoveButtons = () => {
    const rows = rowsEl.querySelectorAll('[data-room-row]');
    rows.forEach((r) => { r.querySelector('[data-remove-row]').hidden = rows.length === 1; });
  };
  root.querySelector('[data-add-row]').addEventListener('click', () => {
    rowsEl.insertAdjacentHTML('beforeend', roomRowHtml());
    syncRemoveButtons();
    rowsEl.lastElementChild.querySelector('.room-row__room').focus();
  });
  rowsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-row]');
    if (!btn) return;
    btn.closest('[data-room-row]').remove();
    syncRemoveButtons();
  });
  syncRemoveButtons();
}

/**
 * Reads the room rows into [{ room, quantity }]. Rows left completely blank
 * are skipped; anything else invalid throws a message for the form.
 */
function readRoomRows(root) {
  const merged = new Map();
  for (const row of root.querySelectorAll('[data-room-row]')) {
    const room = row.querySelector('.room-row__room').value.trim();
    const qtyRaw = row.querySelector('.room-row__qty').value.trim();
    if (!room && !qtyRaw) continue;
    if (!ROOM_RE.test(room)) {
      throw new Error(room ? `"${room}" isn't a valid room. ${ROOM_HINT}` : `Enter a room for every quantity. ${ROOM_HINT}`);
    }
    const qty = Number(qtyRaw);
    if (!qtyRaw || !Number.isInteger(qty) || qty < 1) {
      throw new Error(`Enter a whole-number quantity of at least 1 for room ${room}.`);
    }
    // Same room entered twice → combine rather than reject.
    merged.set(room, (merged.get(room) || 0) + qty);
  }
  const rooms = [...merged.entries()].map(([room, quantity]) => ({ room, quantity }));
  if (rooms.length === 0) throw new Error('Enter at least one room and quantity.');
  const total = rooms.reduce((n, r) => n + r.quantity, 0);
  if (total > MAX_UNITS_PER_CHANGE) {
    throw new Error(`At most ${MAX_UNITS_PER_CHANGE} units can be added at once (you entered ${total}).`);
  }
  return rooms;
}

// ── New equipment type ──

/**
 * @param sections        existing section names, for the picker
 * @param presetSection   pre-filled section (section page), or ''
 * @param existingTypes   types already known in memory, for a
 *                        case-insensitive duplicate-name check
 * @param onCreated(type) called after a successful create
 */
export function openAddTypeDialog({ sections, presetSection = '', existingTypes = [], onCreated }) {
  const sortedSections = [...new Set(sections.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const dlg = makeDialog();
  dlg.setAttribute('aria-labelledby', 'add-type-title');
  dlg.innerHTML = `
    <form class="modal__form" novalidate>
      <h3 class="modal__title" id="add-type-title">Add equipment type</h3>

      <label for="new-type-name">Name</label>
      <input id="new-type-name" type="text" maxlength="150" autocomplete="off" required
             placeholder="e.g. Bunsen Burner">

      <label for="new-type-section">Section</label>
      <input id="new-type-section" type="text" maxlength="80" list="eos-section-options"
             autocomplete="off" required value="${esc(presetSection)}"
             placeholder="Pick one or type a new section">
      <datalist id="eos-section-options">
        ${sortedSections.map((s) => `<option value="${esc(s)}"></option>`).join('')}
      </datalist>
      <p class="field-hint" data-section-hint hidden></p>

      <label for="new-type-category">Category <span class="optional">(optional)</span></label>
      <input id="new-type-category" type="text" maxlength="80" autocomplete="off"
             placeholder="Defaults to the name before “ - ”, e.g. Copper">

      <p class="field-label">Units by room</p>
      ${roomEditorHtml([ownRoom()])}

      <p class="error" data-error hidden></p>

      <div class="modal__actions">
        <button type="button" class="btn-secondary" data-close>Cancel</button>
        <button type="submit" class="btn-primary" data-submit>Create equipment type</button>
      </div>
    </form>`;

  const form = dlg.querySelector('form');
  const nameEl = dlg.querySelector('#new-type-name');
  const sectionEl = dlg.querySelector('#new-type-section');
  const categoryEl = dlg.querySelector('#new-type-category');
  const hintEl = dlg.querySelector('[data-section-hint]');
  const errorEl = dlg.querySelector('[data-error]');
  wireRoomEditor(dlg);

  const tidy = (s) => s.trim().replace(/\s+/g, ' ');
  // "chemistry" → "Chemistry" if that section exists, so a casing slip
  // doesn't create a second card on the inventory page.
  const matchSection = (value) =>
    sortedSections.find((s) => s.toLowerCase() === value.toLowerCase());

  sectionEl.addEventListener('input', () => {
    const value = tidy(sectionEl.value);
    const isNew = value && !matchSection(value);
    hintEl.hidden = !isNew;
    hintEl.textContent = isNew ? `“${value}” is a new section — it will get its own card on the Inventory page.` : '';
  });

  dlg.querySelector('[data-close]').addEventListener('click', () => closeDialog(dlg));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;

    const name = tidy(nameEl.value);
    const sectionRaw = tidy(sectionEl.value);
    const section = matchSection(sectionRaw) || sectionRaw;
    // Same rule as the import: "Copper - medium cylinder" → category "Copper".
    const category = tidy(categoryEl.value) || name.split(' - ')[0].trim() || name;
    let rooms;
    try {
      if (!name) throw new Error('Enter a name for the equipment type.');
      if (!section) throw new Error('Choose or enter a section.');
      const dupe = existingTypes.find((t) => t.name.toLowerCase() === name.toLowerCase());
      if (dupe) {
        throw new Error(`“${dupe.name}” already exists${dupe.section ? ` in ${dupe.section}` : ''}. Use Manage on that type to add units instead.`);
      }
      rooms = readRoomRows(dlg);
    } catch (err) {
      showError(errorEl, err.message);
      return;
    }

    setBusy(dlg, true);
    const submitBtn = dlg.querySelector('[data-submit]');
    submitBtn.textContent = 'Creating…';
    try {
      const actor = await getActor();
      const type = await createEquipmentType({ name, section, category, rooms, actor });
      const total = rooms.reduce((n, r) => n + r.quantity, 0);
      closeDialog(dlg);
      onCreated?.(type, total);
    } catch (err) {
      console.error('Create equipment type failed:', err);
      setBusy(dlg, false);
      submitBtn.textContent = 'Create equipment type';
      showError(errorEl, err.message);
    }
  });

  dlg.showModal();
  nameEl.focus();
}

function showError(el, message) {
  el.textContent = message;
  el.hidden = false;
}

// ── Manage one existing type ──

/**
 * @param type                     { id, name, section, ... }
 * @param onUnitsChanged(type, v)  units added/removed; v = new unitsVersion
 * @param onDeleted(type, info)    the type and its units are gone;
 *                                 info.byOther: someone else deleted it first
 * @param onCountsSeen(type, c)    exact { available, total } just read, so
 *                                 the page can correct a stale cached row
 */
export function openManageDialog({ type, onUnitsChanged, onDeleted, onCountsSeen }) {
  const dlg = makeDialog('modal--wide');
  dlg.setAttribute('aria-labelledby', 'manage-title');
  const state = {
    rooms: null,  // [{ room, available, checkedOut }] once loaded
    loadError: null,
    mode: 'overview', // 'overview' | 'add' | 'remove' | 'delete'
    flash: '',    // success note shown on the overview after a change
  };

  dlg.innerHTML = `
    <h3 class="modal__title" id="manage-title">${esc(type.name)}</h3>
    ${type.section ? `<p class="modal__subtitle">${esc(type.section)}</p>` : ''}
    <div data-manage-body></div>`;
  const bodyEl = dlg.querySelector('[data-manage-body]');

  const totals = () => {
    const rooms = state.rooms || [];
    return {
      available: rooms.reduce((n, r) => n + r.available, 0),
      checkedOut: rooms.reduce((n, r) => n + r.checkedOut, 0),
    };
  };

  async function load() {
    state.rooms = null;
    state.loadError = null;
    render();
    try {
      state.rooms = await getTypeRoomBreakdown(type.id);
      const t = totals();
      onCountsSeen?.(type, { available: t.available, total: t.available + t.checkedOut });
    } catch (err) {
      console.error('Room breakdown failed:', err);
      state.loadError = err.message;
    }
    render();
  }

  function breakdownHtml() {
    if (state.loadError) {
      return `<p class="error">Couldn't load units: ${esc(state.loadError)}
        <button type="button" class="link-btn" data-reload>Retry</button></p>`;
    }
    if (!state.rooms) return '<p class="status">Loading units…</p>';
    if (state.rooms.length === 0) {
      return '<p class="status">No units yet — use <b>Add units</b> to put some in a room.</p>';
    }
    const t = totals();
    return `
      <table class="room-table">
        <thead><tr><th scope="col">Room</th><th scope="col">On shelf</th><th scope="col">Checked out</th></tr></thead>
        <tbody>
          ${state.rooms.map((r) => `
            <tr>
              <th scope="row">${esc(r.room || '—')}</th>
              <td>${r.available}</td>
              <td>${r.checkedOut || '<span class="muted">0</span>'}</td>
            </tr>`).join('')}
        </tbody>
        <tfoot><tr><th scope="row">Total</th><td>${t.available}</td><td>${t.checkedOut}</td></tr></tfoot>
      </table>`;
  }

  function render() {
    const loaded = Boolean(state.rooms);
    if (!loaded && state.mode !== 'overview') {
      bodyEl.innerHTML = `${breakdownHtml()}
        <div class="modal__actions"><button type="button" class="btn-secondary" data-back>Back</button></div>`;
      return;
    }
    if (state.mode === 'overview') {
      bodyEl.innerHTML = `
        ${state.flash ? `<p class="flash" role="status">${state.flash}</p>` : ''}
        ${breakdownHtml()}
        <div class="manage-actions">
          <button type="button" class="btn-primary" data-mode="add">Add units</button>
          <button type="button" class="btn-secondary" data-mode="remove" ${loaded && totals().available > 0 ? '' : 'disabled'}>Remove units</button>
          <button type="button" class="btn-danger-outline" data-mode="delete" ${loaded ? '' : 'disabled'}>Delete type</button>
        </div>
        <div class="modal__actions">
          <button type="button" class="btn-secondary" data-close>Close</button>
        </div>`;
      return;
    }
    if (state.mode === 'add') return renderAdd();
    if (state.mode === 'remove') return renderRemove();
    if (state.mode === 'delete') return renderDelete();
  }

  function backToOverview(flash = '') {
    state.mode = 'overview';
    state.flash = flash;
    render();
  }

  // Add units
  function renderAdd() {
    bodyEl.innerHTML = `
      <form class="modal__form" novalidate>
        <p class="field-label">Add units by room</p>
        ${roomEditorHtml([ownRoom(), ...(state.rooms || []).map((r) => r.room)])}
        <p class="error" data-error hidden></p>
        <div class="modal__actions">
          <button type="button" class="btn-secondary" data-back>Back</button>
          <button type="submit" class="btn-primary" data-submit>Add units</button>
        </div>
      </form>`;
    wireRoomEditor(bodyEl);
    const errorEl = bodyEl.querySelector('[data-error]');
    bodyEl.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      let rooms;
      try {
        rooms = readRoomRows(bodyEl);
      } catch (err) {
        showError(errorEl, err.message);
        return;
      }
      await runChange(errorEl, 'Adding…', async () => {
        const { unitsVersion } = await addUnits({ type, rooms, actor: await getActor() });
        const total = rooms.reduce((n, r) => n + r.quantity, 0);
        onUnitsChanged?.(type, unitsVersion);
        return `Added ${plural(total, 'unit')} — ${roomsSummary(rooms)}.`;
      });
    });
    bodyEl.querySelector('.room-row__qty')?.focus();
  }

  // Remove units — pick how many to take from each room
  function renderRemove() {
    const removable = (state.rooms || []).filter((r) => r.available > 0 || r.checkedOut > 0);
    bodyEl.innerHTML = `
      <form class="modal__form" novalidate>
        <p class="field-label">Choose how many to remove from each room</p>
        <table class="room-table room-table--remove">
          <thead><tr><th scope="col">Room</th><th scope="col">On shelf</th><th scope="col">Checked out</th><th scope="col">Remove</th></tr></thead>
          <tbody>
            ${removable.map((r) => `
              <tr>
                <th scope="row">${esc(r.room || '—')}</th>
                <td>${r.available}</td>
                <td>${r.checkedOut || '<span class="muted">0</span>'}</td>
                <td>
                  <input type="number" class="remove-qty" min="0" max="${r.available}" step="1"
                         placeholder="0" data-room="${esc(r.room)}" data-max="${r.available}"
                         aria-label="Units to remove from room ${esc(r.room)}"
                         ${r.available === 0 || !ROOM_RE.test(r.room) ? 'disabled' : ''}>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
        ${totals().checkedOut > 0
          ? '<p class="field-hint">Checked-out units can’t be removed until they’re returned.</p>'
          : ''}
        <p class="remove-total" data-remove-total>Removing 0 units</p>
        <p class="error" data-error hidden></p>
        <div class="modal__actions">
          <button type="button" class="btn-secondary" data-back>Back</button>
          <button type="submit" class="btn-danger" data-submit disabled>Remove units…</button>
        </div>
      </form>`;

    const errorEl = bodyEl.querySelector('[data-error]');
    const submitBtn = bodyEl.querySelector('[data-submit]');
    const totalEl = bodyEl.querySelector('[data-remove-total]');

    const readSelection = () => {
      const rooms = [];
      let invalid = null;
      for (const input of bodyEl.querySelectorAll('.remove-qty:not(:disabled)')) {
        const raw = input.value.trim();
        const n = raw === '' ? 0 : Number(raw);
        const max = Number(input.dataset.max);
        if (!Number.isInteger(n) || n < 0) invalid = `Enter a whole number for room ${input.dataset.room}.`;
        else if (n > max) invalid = `Room ${input.dataset.room} only has ${max} on the shelf.`;
        else if (n > 0) rooms.push({ room: input.dataset.room, quantity: n });
      }
      return { rooms, invalid, total: rooms.reduce((n, r) => n + r.quantity, 0) };
    };

    bodyEl.querySelector('form').addEventListener('input', () => {
      const { invalid, total } = readSelection();
      totalEl.textContent = `Removing ${plural(total, 'unit')}`;
      submitBtn.disabled = Boolean(invalid) || total === 0;
      if (invalid) showError(errorEl, invalid);
      else errorEl.hidden = true;
    });

    bodyEl.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const { rooms, invalid, total } = readSelection();
      if (invalid || total === 0) return;
      if (total > MAX_UNITS_PER_CHANGE) {
        showError(errorEl, `At most ${MAX_UNITS_PER_CHANGE} units can be removed at once.`);
        return;
      }
      const ok = await confirmAction({
        title: `Remove ${plural(total, 'unit')}?`,
        bodyHtml: `
          <p>This permanently removes <b>${plural(total, 'unit')}</b> of <b>${esc(type.name)}</b>:</p>
          <ul class="confirm-list">${rooms.map((r) => `<li>${plural(r.quantity, 'unit')} from room ${esc(r.room)}</li>`).join('')}</ul>
          <p>This can’t be undone.</p>`,
        confirmLabel: `Remove ${plural(total, 'unit')}`,
      });
      if (!ok) return;
      await runChange(errorEl, 'Removing…', async () => {
        const { unitsVersion } = await removeUnits({ type, rooms, actor: await getActor() });
        onUnitsChanged?.(type, unitsVersion);
        return `Removed ${plural(total, 'unit')} — ${roomsSummary(rooms)}.`;
      }, { refreshOnError: true });
    });
    bodyEl.querySelector('.remove-qty:not(:disabled)')?.focus();
  }

  // Delete the whole type
  function renderDelete() {
    const t = totals();
    const blocked = t.checkedOut > 0;
    const total = t.available + t.checkedOut;
    bodyEl.innerHTML = `
      <div class="modal__form">
        ${blocked
          ? `<p class="error">${plural(t.checkedOut, 'unit')} ${t.checkedOut === 1 ? 'is' : 'are'} still checked out.
             This type can be deleted once everything has been returned.</p>`
          : `<p>Deleting <b>${esc(type.name)}</b> removes the equipment type and
             ${total === 0 ? 'it has no units' : `<b>all ${plural(total, 'unit')}</b> in ${plural(state.rooms.length, 'room')}`}.
             It will no longer appear in the inventory or be available to check out.</p>`}
        <p class="error" data-error hidden></p>
        <div class="modal__actions">
          <button type="button" class="btn-secondary" data-back>Back</button>
          <button type="button" class="btn-danger" data-submit ${blocked ? 'disabled' : ''}>Delete type…</button>
        </div>
      </div>`;

    const errorEl = bodyEl.querySelector('[data-error]');
    bodyEl.querySelector('[data-submit]').addEventListener('click', async () => {
      const ok = await confirmAction({
        title: `Delete “${type.name}”?`,
        bodyHtml: `
          <p>This permanently deletes the equipment type
          ${total > 0 ? `and all <b>${plural(total, 'unit')}</b>:` : '(it has no units).'}</p>
          ${total > 0 ? `<ul class="confirm-list">${state.rooms.map((r) => `<li>${plural(r.available, 'unit')} in room ${esc(r.room || '—')}</li>`).join('')}</ul>` : ''}
          <p>This can’t be undone.</p>`,
        confirmLabel: 'Delete permanently',
      });
      if (!ok) return;

      setBusy(dlg, true);
      const btn = bodyEl.querySelector('[data-submit]');
      btn.textContent = 'Deleting…';
      try {
        await deleteEquipmentType({ type, actor: await getActor() });
        closeDialog(dlg);
        onDeleted?.(type);
      } catch (err) {
        console.error('Delete equipment type failed:', err);
        if (closeIfGone(err)) return;
        setBusy(dlg, false);
        // Counts may have changed (e.g. someone checked one out): reload,
        // then show why on the refreshed delete view.
        await load();
        const freshError = bodyEl.querySelector('[data-error]');
        if (freshError) showError(freshError, err.message);
      }
    });
  }

  /**
   * Run one write with the dialog locked. On success, reload the breakdown
   * and return to the overview with a success note; on failure, keep the
   * form (and what was typed) and show why. With refreshOnError the form is
   * rebuilt from freshly loaded counts first (removing: the counts that made
   * it fail are what the teacher needs to see).
   */
  async function runChange(errorEl, busyLabel, work, { refreshOnError = false } = {}) {
    const submitBtn = bodyEl.querySelector('[data-submit]');
    const label = submitBtn.textContent;
    setBusy(dlg, true);
    submitBtn.textContent = busyLabel;
    try {
      const flash = await work();
      setBusy(dlg, false);
      state.mode = 'overview';
      state.flash = flash;
      await load();
    } catch (err) {
      console.error('Inventory change failed:', err);
      if (closeIfGone(err)) return;
      setBusy(dlg, false);
      submitBtn.textContent = label;
      if (refreshOnError) {
        await load();
        errorEl = bodyEl.querySelector('[data-error]') || errorEl;
      }
      showError(errorEl, err.message);
    }
  }

  /** Someone else deleted this type mid-way: close and drop its row. */
  function closeIfGone(err) {
    if (err.message !== TYPE_GONE_MSG) return false;
    closeDialog(dlg);
    onDeleted?.(type, { byOther: true });
    return true;
  }

  bodyEl.addEventListener('click', (e) => {
    if (dlg.dataset.busy) return;
    if (e.target.closest('[data-close]')) closeDialog(dlg);
    else if (e.target.closest('[data-back]')) backToOverview();
    else if (e.target.closest('[data-reload]')) load();
    else {
      const modeBtn = e.target.closest('[data-mode]');
      if (modeBtn && !modeBtn.disabled) {
        state.mode = modeBtn.dataset.mode;
        state.flash = '';
        render();
      }
    }
  });

  dlg.showModal();
  load();
}
