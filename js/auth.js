import {
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
} from 'https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js';
import { auth } from './firebase-init.js?v=8';

export function signIn(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

export function signOut() {
  return firebaseSignOut(auth);
}
