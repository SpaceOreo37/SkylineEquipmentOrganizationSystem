import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js';
import { auth } from './firebase-init.js';
import { signOut } from './auth.js';
import { getEquipment } from './firestore.js';

const tbody = document.getElementById('equipment-tbody');

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = 'index.html';
    return;
  }
  document.getElementById('user-email').textContent = user.email;
  await loadEquipment();
});

document.getElementById('sign-out-btn').addEventListener('click', async () => {
  await signOut();
  window.location.href = 'index.html';
});

async function loadEquipment() {
  tbody.innerHTML = '<tr><td colspan="4" class="loading">Loading…</td></tr>';
  try {
    const items = await getEquipment();
    if (items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty">No equipment added yet.</td></tr>';
      return;
    }
    tbody.innerHTML = items.map(item => `
      <tr>
        <td>${esc(item.name)}</td>
        <td>${esc(item.category)}</td>
        <td><span class="badge badge--${item.status === 'available' ? 'available' : 'checked-out'}">${esc(item.status)}</span></td>
        <td>${esc(item.location)}</td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="error">Failed to load: ${esc(err.message)}</td></tr>`;
  }
}

function esc(value) {
  return String(value ?? '—')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
