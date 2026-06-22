import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js';

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
export const db = getFirestore(app);
