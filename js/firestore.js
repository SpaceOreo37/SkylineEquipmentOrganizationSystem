import {
  collection,
  getDocs,
  orderBy,
  query,
} from 'https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js';
import { db } from './firebase-init.js';

export async function getEquipment() {
  const q = query(collection(db, 'equipment'), orderBy('name'));
  const snapshot = await getDocs(q);
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}
