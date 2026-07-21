import {
  collection,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  where,
} from 'https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js';
import { db } from './firebase-init.js?v=5';

export async function getEquipment() {
  const q = query(collection(db, 'equipment'), orderBy('name'));
  const snapshot = await getDocs(q);
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

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
