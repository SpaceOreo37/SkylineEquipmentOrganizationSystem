import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "AIzaSyC6koII7YfEbx84LFsc9wThGntT50X3Lck",
  authDomain: "skyline-eos.firebaseapp.com",
  projectId: "skyline-eos",
  storageBucket: "skyline-eos.firebasestorage.app",
  messagingSenderId: "966501407480",
  appId: "1:966501407480:web:5bc5ff9f8220614220f90d"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
// Persistent cache: snapshot listeners resync only changed documents across
// sessions instead of re-reading whole collections (major read-quota saver).
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
