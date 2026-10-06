import {
  collection,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  getDocsFromServer,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  where,
} from 'https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js';
import { db } from './firebase-init.js?v=11';

/**
 * Live-subscribe to all equipmentTypes, sorted by name.
 * The initial snapshot is the one full read of the collection; afterwards
 * (and across sessions, thanks to the persistent cache) only changed
 * documents are read from the server.
 * Returns the unsubscribe function.
 */
export function subscribeEquipmentTypes(onTypes, onError) {
  const q = query(collection(db, 'equipmentTypes'), orderBy('name'));
  return onSnapshot(
    q,
    (snap) => onTypes(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError
  );
}

/**
 * One-time fetch of the equipmentTypes in a single section. Fallback for
 * deep links / refreshes on the section page when the sessionStorage
 * handoff from the main inventory page is empty. Reads only that
 * section's type documents. Sorted client-side to avoid needing a
 * composite index.
 */
export async function getEquipmentTypesBySection(section) {
  const q = query(collection(db, 'equipmentTypes'), where('section', '==', section));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * Unit counts for one equipment type via count() aggregations — 1 billed
 * read per aggregation regardless of how many unit documents match.
 * Pass includeTotal: false when the total is already known (totals only
 * change when units are added/removed, never on checkout).
 */
export async function getUnitCounts(typeId, includeTotal) {
  const units = collection(db, 'equipmentUnits');
  const availableQ = query(
    units,
    where('typeId', '==', typeId),
    where('status', '==', 'available')
  );
  const jobs = [getCountFromServer(availableQ)];
  if (includeTotal) {
    jobs.push(getCountFromServer(query(units, where('typeId', '==', typeId))));
  }
  const [availableSnap, totalSnap] = await Promise.all(jobs);
  return {
    available: availableSnap.data().count,
    total: totalSnap ? totalSnap.data().count : undefined,
  };
}

/**
 * Split availability for the checkout distribution note: units in the
 * teacher's own room vs everywhere else. Two count() aggregations in
 * parallel (1 billed read each); total available = home + other. With no
 * room number everything counts as "other" and this costs a single read.
 */
export async function getRoomSplitCounts(typeId, roomNumber) {
  const units = collection(db, 'equipmentUnits');
  if (roomNumber == null || roomNumber === '') {
    const snap = await getCountFromServer(query(
      units,
      where('typeId', '==', typeId),
      where('status', '==', 'available')
    ));
    return { home: 0, other: snap.data().count };
  }

  const homeQ = query(
    units,
    where('typeId', '==', typeId),
    where('status', '==', 'available'),
    where('homeRoom', '==', roomNumber)
  );
  const otherQ = query(
    units,
    where('typeId', '==', typeId),
    where('status', '==', 'available'),
    where('homeRoom', '!=', roomNumber)
  );
  const [homeSnap, otherSnap] = await Promise.all([
    getCountFromServer(homeQ),
    getCountFromServer(otherQ),
  ]);
  return { home: homeSnap.data().count, other: otherSnap.data().count };
}

/**
 * Per-room availability of one type outside the teacher's room, sorted by
 * count descending. getDocs is deliberate — each unit's homeRoom is needed
 * to group — so this bills 1 read per matching unit. The caller caches it
 * and triggers it at most once per type selection.
 */
export async function getOtherRoomsBreakdown(typeId, roomNumber) {
  const units = collection(db, 'equipmentUnits');
  const clauses = [
    where('typeId', '==', typeId),
    where('status', '==', 'available'),
  ];
  if (roomNumber != null && roomNumber !== '') {
    clauses.push(where('homeRoom', '!=', roomNumber));
  }
  const snap = await getDocs(query(units, ...clauses));

  const byRoom = new Map();
  for (const d of snap.docs) {
    const room = d.data().homeRoom;
    byRoom.set(room, (byRoom.get(room) || 0) + 1);
  }
  return [...byRoom.entries()]
    .map(([room, count]) => ({ room, count }))
    .sort((a, b) => b.count - a.count || String(a.room).localeCompare(String(b.room)));
}

/**
 * Display name of the teacher whose users doc has this roomNumber, or null
 * if none matches. Callers cache — at most 1 lookup per unique room.
 */
export async function getTeacherNameByRoom(roomNumber) {
  const snap = await getDocs(query(
    collection(db, 'users'),
    where('roomNumber', '==', roomNumber),
    limit(1)
  ));
  if (snap.empty) return null;
  return snap.docs[0].data().displayName || null;
}

export const NOT_ENOUGH_UNITS_MSG =
  'Not enough units available, please try a lower quantity';

export const CHECKOUT_NOT_FOUND_MSG = 'This checkout no longer exists.';
export const CHECKOUT_ALREADY_RETURNED_MSG = 'This checkout has already been fully returned.';

/** Checkout statuses that still have units out in the world. */
export const ACTIVE_CHECKOUT_STATUSES = ['in-use', 'partial'];

/**
 * Live-subscribe to every checkout that still has units outstanding. The
 * status filter is the read-light part: fully-returned checkouts accumulate
 * forever, and this never reads them. The dashboard splits the result into
 * "mine" and "department" client-side, so one listener feeds both sections.
 *
 * Deliberately no orderBy — an `in` filter plus an orderBy on a different
 * field would require a composite index. The result set is small (only
 * outstanding loans), so the dashboard sorts it in memory instead.
 * Returns the unsubscribe function.
 */
export function subscribeActiveCheckouts(onCheckouts, onError) {
  const q = query(
    collection(db, 'checkouts'),
    where('status', 'in', ACTIVE_CHECKOUT_STATUSES)
  );
  return onSnapshot(
    q,
    (snap) => onCheckouts(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError
  );
}

/**
 * One-time fetch of a teacher's users document. Tries the doc keyed by the
 * auth UID first; falls back to a uid-field query in case profile docs use
 * auto-generated IDs. Callers cache the result in sessionStorage — this
 * should run at most once per session.
 */
export async function getUserProfile(uid) {
  const direct = await getDoc(doc(db, 'users', uid));
  if (direct.exists()) return { id: direct.id, ...direct.data() };

  const snap = await getDocs(
    query(collection(db, 'users'), where('uid', '==', uid), limit(1))
  );
  if (snap.empty) {
    throw new Error('No user profile found for this account. Ask an administrator to set one up.');
  }
  const d = snap.docs[0];
  return { id: d.id, ...d.data() };
}

/**
 * Check out `quantity` units of one equipment type, preferring units whose
 * homeRoom is the teacher's own room.
 *
 * The web client SDK cannot run queries inside runTransaction —
 * transaction.get() only accepts document refs — so candidates are found
 * with normal queries first, then every candidate is re-read inside the
 * transaction to confirm it is still available. That re-read is what makes
 * double-booking impossible: if another checkout grabs a unit between the
 * candidate query and the commit, this transaction observes the change
 * (Firestore retries it) and aborts with NOT_ENOUGH_UNITS_MSG.
 *
 * Returns { checkoutId, units: [{ id, homeRoom }] }.
 */
export async function checkoutEquipment({
  uid,
  teacherName,
  roomNumber,
  typeId,
  typeName,
  quantity,
  expectedReturnDate, // Date
  notes,
}) {
  const units = collection(db, 'equipmentUnits');
  const candidates = [];

  if (roomNumber != null && roomNumber !== '') {
    // Step 1: units that live in the teacher's own room.
    const homeSnap = await getDocs(query(
      units,
      where('typeId', '==', typeId),
      where('status', '==', 'available'),
      where('homeRoom', '==', roomNumber),
      limit(quantity)
    ));
    candidates.push(...homeSnap.docs);

    // Step 2: make up the shortfall from other rooms.
    const shortfall = quantity - candidates.length;
    if (shortfall > 0) {
      const otherSnap = await getDocs(query(
        units,
        where('typeId', '==', typeId),
        where('status', '==', 'available'),
        where('homeRoom', '!=', roomNumber),
        limit(shortfall)
      ));
      candidates.push(...otherSnap.docs);
    }
  } else {
    // Profile has no room number — no home-room preference possible.
    const anySnap = await getDocs(query(
      units,
      where('typeId', '==', typeId),
      where('status', '==', 'available'),
      limit(quantity)
    ));
    candidates.push(...anySnap.docs);
  }

  if (candidates.length < quantity) {
    throw new Error(NOT_ENOUGH_UNITS_MSG);
  }

  return runTransaction(db, async (tx) => {
    // All reads must precede writes in a Firestore transaction.
    const fresh = await Promise.all(candidates.map((d) => tx.get(d.ref)));
    const chosen = fresh.filter((s) => s.exists() && s.data().status === 'available');
    if (chosen.length < quantity) {
      throw new Error(NOT_ENOUGH_UNITS_MSG);
    }

    const checkoutRef = doc(collection(db, 'checkouts'));
    tx.set(checkoutRef, {
      teacherUid: uid,
      teacherName,
      equipmentTypeId: typeId,
      equipmentTypeName: typeName,
      unitIds: chosen.map((s) => s.id),
      returnedUnitIds: [],
      quantity,
      checkoutDate: serverTimestamp(),
      expectedReturnDate: Timestamp.fromDate(expectedReturnDate),
      returnedDate: null,
      status: 'in-use',
      notes: notes || '',
      returnNotes: null,
    });

    for (const s of chosen) {
      tx.update(s.ref, {
        status: 'checked-out',
        assignedTo: uid,
        checkoutId: checkoutRef.id,
      });
    }

    return {
      checkoutId: checkoutRef.id,
      units: chosen.map((s) => ({ id: s.id, homeRoom: s.data().homeRoom })),
    };
  });
}

/**
 * Return `quantity` units from one checkout, in a single transaction.
 *
 * Unlike checkoutEquipment, no pre-transaction candidate query is needed —
 * the units to return are already determined by the checkout doc itself
 * (unitIds minus returnedUnitIds), so every read in this transaction is a
 * read-by-ID, never a query, same as the read-light rule for checkout.
 *
 * Marks the checkout "returned" once every unit is back, otherwise
 * "partial". Throws if the checkout was deleted, already fully returned, or
 * `quantity` exceeds what's still outstanding — e.g. two tabs racing to
 * return the same checkout: Firestore retries the loser's transaction, which
 * then sees the winner's write and re-evaluates against the fresh data.
 *
 * Returns { fullyReturned, returned }.
 */
export async function returnEquipment({ checkoutId, quantity, returnNotes }) {
  const checkoutRef = doc(db, 'checkouts', checkoutId);

  return runTransaction(db, async (tx) => {
    // All reads must precede writes in a Firestore transaction.
    const checkoutSnap = await tx.get(checkoutRef);
    if (!checkoutSnap.exists()) {
      throw new Error(CHECKOUT_NOT_FOUND_MSG);
    }
    const checkout = checkoutSnap.data();
    if (checkout.status === 'returned') {
      throw new Error(CHECKOUT_ALREADY_RETURNED_MSG);
    }

    const alreadyReturned = checkout.returnedUnitIds || [];
    const allUnitIds = checkout.unitIds || [];
    const outstandingIds = allUnitIds.filter((id) => !alreadyReturned.includes(id));
    if (quantity > outstandingIds.length) {
      throw new Error(`Only ${outstandingIds.length} unit(s) still outstanding.`);
    }

    const idsToReturn = outstandingIds.slice(0, quantity);
    for (const unitId of idsToReturn) {
      tx.update(doc(db, 'equipmentUnits', unitId), {
        status: 'available',
        assignedTo: null,
        checkoutId: null,
      });
    }

    const returnedUnitIds = [...alreadyReturned, ...idsToReturn];
    const fullyReturned = returnedUnitIds.length === allUnitIds.length;
    const update = {
      returnedUnitIds,
      status: fullyReturned ? 'returned' : 'partial',
    };
    if (fullyReturned) update.returnedDate = serverTimestamp();
    if (returnNotes) update.returnNotes = returnNotes;
    tx.update(checkoutRef, update);

    return { fullyReturned, returned: idsToReturn.length };
  });
}

// ── Inventory management: add / remove units, create / delete types ──
//
// Every change is atomic (one batch or transaction) and writes one
// inventoryLog doc alongside it, so the log can never disagree with what
// actually happened. Every change to a type's units also bumps the type's
// `unitsVersion`; the live equipmentTypes listener carries that to other
// teachers' browsers, which is how their cached unit totals know to refresh.
//
// Checked-out units are never removed: only units whose status is
// "available" are candidates, and each is re-read inside the transaction
// (same double-booking guard as checkoutEquipment).
//
// Every query here uses getDocsFromServer, never getDocs: with the
// persistent cache, getDocs quietly answers from the local cache when the
// connection drops, and a partial cached list of units could show a teacher
// wrong counts or let a delete miss units. getDocsFromServer fails instead.
// Writes all go through runTransaction for the same reason: a transaction
// fails when offline, whereas a batch is queued locally and its promise
// never settles, which would leave the dialog stuck on "Saving…".

/** Room numbers are 4 digits starting with 1 or 2, matching the import. */
export const ROOM_RE = /^[12]\d{3}$/;

/**
 * Cap on units written or deleted in one change. A Firestore batch or
 * transaction holds at most 500 writes; this leaves room for the type doc
 * and the log entry.
 */
export const MAX_UNITS_PER_CHANGE = 400;

export const TYPE_GONE_MSG = 'This equipment type no longer exists — someone may have just deleted it.';
export const UNITS_CHANGED_MSG =
  'Some of those units were just checked out or removed by someone else. Please review the updated counts and try again.';

/** A log entry for one inventory change. `rooms` is [{ room, quantity }]. */
function logEntry({ action, type, rooms, actor }) {
  return {
    action,
    typeId: type.id,
    typeName: type.name,
    section: type.section ?? null,
    rooms,
    quantity: rooms.reduce((n, r) => n + r.quantity, 0),
    teacherUid: actor.uid,
    teacherName: actor.teacherName,
    at: serverTimestamp(),
  };
}

function newUnit(typeId, typeName, homeRoom) {
  return {
    typeId,
    typeName,
    homeRoom,
    status: 'available',
    assignedTo: null,
    checkoutId: null,
  };
}

/** Validates [{ room, quantity }] and returns the total quantity. */
function checkRooms(rooms, { allowEmpty = false } = {}) {
  if (!Array.isArray(rooms) || (!allowEmpty && rooms.length === 0)) {
    throw new Error('Enter at least one room and quantity.');
  }
  const seen = new Set();
  let total = 0;
  for (const { room, quantity } of rooms) {
    if (!ROOM_RE.test(room)) throw new Error(`"${room}" isn't a valid room number.`);
    if (seen.has(room)) throw new Error(`Room ${room} is listed twice.`);
    seen.add(room);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new Error(`Quantity for room ${room} must be a whole number of at least 1.`);
    }
    total += quantity;
  }
  if (total > MAX_UNITS_PER_CHANGE) {
    throw new Error(`At most ${MAX_UNITS_PER_CHANGE} units can be changed at once.`);
  }
  return total;
}

/**
 * Every unit of one type, grouped by room: [{ room, available, checkedOut }]
 * sorted by room. Bills 1 read per unit — only called when a teacher opens
 * the manage panel for a single type.
 */
export async function getTypeRoomBreakdown(typeId) {
  const snap = await getDocsFromServer(query(
    collection(db, 'equipmentUnits'),
    where('typeId', '==', typeId)
  ));
  const byRoom = new Map();
  for (const d of snap.docs) {
    const { homeRoom, status } = d.data();
    const room = homeRoom ?? '';
    if (!byRoom.has(room)) byRoom.set(room, { room, available: 0, checkedOut: 0 });
    if (status === 'available') byRoom.get(room).available++;
    else byRoom.get(room).checkedOut++;
  }
  return [...byRoom.values()].sort((a, b) => String(a.room).localeCompare(String(b.room)));
}

/**
 * Create a new equipment type plus its first units, in one transaction.
 * Rejects a name that already exists (exact match; callers also check
 * case-insensitively against the types they already have in memory).
 *
 * Returns the new type: { id, name, section, category, unitsVersion }.
 */
export async function createEquipmentType({ name, section, category, rooms, actor }) {
  checkRooms(rooms);

  const existing = await getDocsFromServer(query(
    collection(db, 'equipmentTypes'),
    where('name', '==', name),
    limit(1)
  ));
  if (!existing.empty) {
    throw new Error(`An equipment type named "${name}" already exists.`);
  }

  return runTransaction(db, async (tx) => {
    const typeRef = doc(collection(db, 'equipmentTypes'));
    const type = { id: typeRef.id, name, section, category, unitsVersion: 1 };
    tx.set(typeRef, {
      name,
      section,
      category,
      unitsVersion: 1,
      createdAt: serverTimestamp(),
    });
    for (const { room, quantity } of rooms) {
      for (let i = 0; i < quantity; i++) {
        tx.set(doc(collection(db, 'equipmentUnits')), newUnit(typeRef.id, name, room));
      }
    }
    tx.set(doc(collection(db, 'inventoryLog')), logEntry({ action: 'create-type', type, rooms, actor }));
    return type;
  });
}

/**
 * Add units of an existing type to one or more rooms.
 * Returns { unitsVersion } — the type's new version.
 */
export async function addUnits({ type, rooms, actor }) {
  checkRooms(rooms);
  const typeRef = doc(db, 'equipmentTypes', type.id);

  return runTransaction(db, async (tx) => {
    const typeSnap = await tx.get(typeRef);
    if (!typeSnap.exists()) throw new Error(TYPE_GONE_MSG);
    const unitsVersion = (typeSnap.data().unitsVersion || 0) + 1;

    for (const { room, quantity } of rooms) {
      for (let i = 0; i < quantity; i++) {
        tx.set(doc(collection(db, 'equipmentUnits')), newUnit(type.id, type.name, room));
      }
    }
    tx.update(typeRef, { unitsVersion: increment(1) });
    tx.set(doc(collection(db, 'inventoryLog')), logEntry({ action: 'add-units', type, rooms, actor }));
    return { unitsVersion };
  });
}

/**
 * Remove available (on-the-shelf) units of one type from specific rooms.
 * Candidates are found per room with a query, then re-read inside the
 * transaction: if any was checked out or removed in the meantime the whole
 * change aborts with UNITS_CHANGED_MSG and nothing is deleted.
 *
 * Returns { unitsVersion }.
 */
export async function removeUnits({ type, rooms, actor }) {
  checkRooms(rooms);
  const units = collection(db, 'equipmentUnits');

  const candidates = [];
  for (const { room, quantity } of rooms) {
    const snap = await getDocsFromServer(query(
      units,
      where('typeId', '==', type.id),
      where('status', '==', 'available'),
      where('homeRoom', '==', room),
      limit(quantity)
    ));
    if (snap.size < quantity) {
      throw new Error(
        `Room ${room} only has ${snap.size} available to remove ` +
        '(checked-out units can’t be removed until they’re returned).'
      );
    }
    candidates.push(...snap.docs);
  }

  const typeRef = doc(db, 'equipmentTypes', type.id);
  return runTransaction(db, async (tx) => {
    const typeSnap = await tx.get(typeRef);
    if (!typeSnap.exists()) throw new Error(TYPE_GONE_MSG);
    const fresh = await Promise.all(candidates.map((d) => tx.get(d.ref)));
    if (fresh.some((s) => !s.exists() || s.data().status !== 'available')) {
      throw new Error(UNITS_CHANGED_MSG);
    }
    const unitsVersion = (typeSnap.data().unitsVersion || 0) + 1;

    for (const s of fresh) tx.delete(s.ref);
    tx.update(typeRef, { unitsVersion: increment(1) });
    tx.set(doc(collection(db, 'inventoryLog')), logEntry({ action: 'remove-units', type, rooms, actor }));
    return { unitsVersion };
  });
}

/**
 * Delete an equipment type and every one of its units. Refused while any
 * unit is checked out — the active checkout would otherwise point at units
 * that no longer exist.
 *
 * After the transaction, one sweep deletes any available units that were
 * added between the unit query and the commit (a transaction can't run
 * queries, so those wouldn't have been in its read set).
 */
export async function deleteEquipmentType({ type, actor }) {
  const units = collection(db, 'equipmentUnits');
  const unitSnap = await getDocsFromServer(query(units, where('typeId', '==', type.id)));

  const out = unitSnap.docs.filter((d) => d.data().status !== 'available').length;
  if (out > 0) {
    throw new Error(
      `${out} unit${out === 1 ? ' is' : 's are'} still checked out. ` +
      'This type can be deleted once everything has been returned.'
    );
  }
  if (unitSnap.size > MAX_UNITS_PER_CHANGE) {
    throw new Error(
      `This type has ${unitSnap.size} units — remove some first ` +
      `(at most ${MAX_UNITS_PER_CHANGE} can be deleted at once).`
    );
  }

  const byRoom = new Map();
  for (const d of unitSnap.docs) {
    const room = d.data().homeRoom ?? '';
    byRoom.set(room, (byRoom.get(room) || 0) + 1);
  }
  const rooms = [...byRoom.entries()].map(([room, quantity]) => ({ room, quantity }));

  const typeRef = doc(db, 'equipmentTypes', type.id);
  await runTransaction(db, async (tx) => {
    const typeSnap = await tx.get(typeRef);
    if (!typeSnap.exists()) throw new Error(TYPE_GONE_MSG);
    const fresh = await Promise.all(unitSnap.docs.map((d) => tx.get(d.ref)));
    if (fresh.some((s) => s.exists() && s.data().status !== 'available')) {
      throw new Error(UNITS_CHANGED_MSG);
    }

    for (const s of fresh) if (s.exists()) tx.delete(s.ref);
    tx.delete(typeRef);
    tx.set(doc(collection(db, 'inventoryLog')), logEntry({ action: 'delete-type', type, rooms, actor }));
  });

  // The type is already gone at this point, so a failed sweep must not
  // surface as "delete failed" — log it and move on.
  try {
    const strays = await getDocsFromServer(query(
      units,
      where('typeId', '==', type.id),
      where('status', '==', 'available')
    ));
    if (!strays.empty) {
      await runTransaction(db, async (tx) => {
        strays.docs.slice(0, 500).forEach((d) => tx.delete(d.ref));
      });
    }
  } catch (err) {
    console.warn(`Stray-unit sweep after deleting type ${type.id} failed:`, err);
  }
}
