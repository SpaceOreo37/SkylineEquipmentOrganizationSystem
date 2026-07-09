import {
  collection,
  getCountFromServer,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  where,
} from 'https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js';
import { db } from './firebase-init.js?v=3';

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
