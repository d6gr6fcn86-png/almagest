'use strict';
const cfg = window.ALMAGEST_CONFIG;
const db = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const digits = (v) => (v || '').replace(/\D/g, '');
const last9 = (v) => digits(v).slice(-9);
const code = (n) => 'C-' + String(n).padStart(4, '0');
const KINDS = { particular: 'Particular', empresa: 'Empresa', comunidad: 'Comunidad' };

function show(view) {
  for (const v of ['login', 'recovery', 'app']) $('#v-' + v).hidden = v !== view;
}
let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isErr ? 'err' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

/* ---------- Gestión de Pestañas ---------- */
document.addEventListener('DOMContentLoaded', () => {
  const tabs = document.querySelectorAll('header nav .tab');
  const sections = document.querySelectorAll('.tab-section');

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      if (tab.hasAttribute('disabled')) return;
      
      tabs.forEach(t => t.classList.remove('on'));
      tab.classList.add('on');

      const target = tab.dataset.target;
      sections.forEach(sec => {
        sec.hidden = sec.id !== `sec-${target}`;
      });

      // Si se pulsa en clientes, cargamos los datos de la tabla
      if (target === 'clientes') {
        loadClients();
      }
    });
  });
});

/* ---------- Sesión ---------- */
let appShown = false;
db.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') { appShown = false; return show('recovery'); }
  if (!session) { appShown = false; return show('login'); }
  if (!appShown) {
    appShown = true;
    show('app');
    setTimeout(loadClients, 0);
  }
});

$('#f-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { error } = await db.auth.signInWithPassword({ email: $('#l-email').value.trim(), password: $('#l-pass').value });
  if (error) toast('Correo o contraseña incorrectos', true);
});
$('#b-reset').addEventListener('click', async () => {
  const email = $('#l-email').value.trim();
  if (!email) return toast('Escribe tu correo y vuelve a pulsar', true);
  const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  if (error) return toast('No se pudo enviar el correo. Inténtalo más tarde', true);
  toast('Si el correo existe, recibirás un enlace para cambiar la contraseña');
});
$('#f-recovery').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { error } = await db.auth.updateUser({ password: $('#r-pass').value });
  if (error) return toast(error.message, true);
  toast('Contraseña actualizada');
  appShown = true;
  show('app');
  loadClients();
});
$('#b-logout').addEventListener('click', () => db.auth.signOut());

/* ---------- Formulario Presupuestos ---------- */
$('#f-presupuesto').addEventListener('submit', (e) => {
  e.preventDefault();
  toast('Presupuesto generado correctamente (Simulación)');
  e.target.reset();
});

/* ---------- Clientes ---------- */
let clients = [];
async function loadClients() {
  const searchInput = $('#search');
  const q = searchInput ? searchInput.value.trim() : '';
  const { data, error } = q
    ? await db.rpc('search_clients', { q })
    : await db.from('clients').select('*').order('created_at', { ascending: false }).limit(30);
  if (error) return toast(error.message, true);
  clients = data;
  
  const emptyEl = $('#empty');
  if (emptyEl) {
    emptyEl.hidden = clients.length > 0;
    emptyEl.textContent = q ? 'Ningún cliente coincide con la búsqueda.' : 'Aún no hay clientes. Crea el primero con «Nuevo cliente».';
  }
  
  const rowsEl = $('#rows');
  if (rowsEl) {
    rowsEl.innerHTML = clients.map((c) =>
      `<tr data-id="${esc(c.id)}" tabindex="0">
         <td onclick="event.stopPropagation()"><input type="checkbox" class="row-select" value="${esc(c.id)}" aria-label="Seleccionar cliente"></td>
         <td>${code(c.code_num)}</td>
         <td>${esc(c.name)}</td>
         <td>${esc(c.phone)}</td>
         <td>${esc(c.locality)}</td>
         <td>${esc(KINDS[c.kind] || c.kind)}</td>
       </tr>`
    ).join('');
  }

  actualizarBotonEliminarMultiples();
}

let searchTimer;
const searchEl = $('#search');
if (searchEl) {
  searchEl.addEventListener('input', () => { 
    clearTimeout(searchTimer); 
    searchTimer = setTimeout(loadClients, 250); 
  });
}

// Abrir ficha al hacer clic en la fila (excepto si se hace clic en el checkbox)
const openFromRow = (e) => {
  if (e.target.type === 'checkbox') return;
  const tr = e.target.closest('tr[data-id]');
  if (tr) openForm(clients.find((c) => c.id === tr.dataset.id));
};

const rowsEl = $('#rows');
if (rowsEl) {
  rowsEl.addEventListener('click', openFromRow);
  rowsEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') openFromRow(e); });
}

const bNewEl = $('#b-new');
if (bNewEl) bNewEl.addEventListener('click', () => openForm(null));

const dCancelEl = $('#d-cancel');
if (dCancelEl) dCancelEl.addEventListener('click', () => $('#dlg').close());

function openForm(c) {
  const f = $('#f-client');
  f.reset();
  f.dataset.id = c ? c.id : '';
  $('#d-title').textContent = c ? `${code(c.code_num)} · Editar cliente` : 'Nuevo cliente';
  for (const k of ['name', 'phone', 'email', 'locality', 'address', 'nif', 'kind', 'notes']) {
    f.elements[k].value = c?.[k] ?? (k === 'kind' ? 'particular' : '');
  }
  $('#d-err').hidden = true;
  
  const btnDelete = $('#d-delete');
  if (btnDelete) {
    btnDelete.hidden = !c;
  }

  $('#dlg').showModal();
}

async function findDuplicates(v) {
  const found = new Map();
  for (const q of [last9(v.phone), v.email].filter(Boolean)) {
    const { data } = await db.rpc('search_clients', { q });
    (data || []).forEach((c) => found.set(c.id, c));
  }
  return [...found.values()].filter((c) =>
    last9(c.phone) === last9(v.phone) || (v.email && (c.email || '').toLowerCase() === v.email.toLowerCase()));
}

$('#f-client').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = (m) => { $('#d-err').textContent = m; $('#d-err').hidden = false; };
  const v = Object.fromEntries(new FormData(f));
  for (const k in v) v[k] = v[k].trim();
  if (digits(v.phone).length < 9) return err('El teléfono debe tener al menos 9 dígitos.');
  if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) return err('El correo no es válido.');
  for (const k of ['email', 'address', 'nif', 'notes']) v[k] = v[k] || null;

  const id = f.dataset.id;
  const btn = $('#d-save');
  btn.disabled = true;
  try {
    if (!id) {
      const dup = await findDuplicates(v);
      if (dup.length && !confirm('Ya existe: ' + dup.map((c) => `${code(c.code_num)} ${c.name} (${c.phone})`).join('; ') + '\n\n¿Crear otro cliente de todos modos?')) return;
    }
    const { error } = id ? await db.from('clients').update(v).eq('id', id) : await db.from('clients').insert(v);
    if (error) return err(error.message);
    $('#dlg').close();
    toast(id ? 'Cliente actualizado' : 'Cliente creado');
    loadClients();
  } finally {
    btn.disabled = false;
  }
});

/* ---------- Eliminar Cliente Individual (desde la ficha) ---------- */
const btnDelete = $('#d-delete');
if (btnDelete) {
  btnDelete.addEventListener('click', async () => {
    const f = $('#f-client');
    const id = f.dataset.id;
    if (!id) return;

    if (!confirm('¿Estás seguro de que deseas eliminar este cliente? Esta acción no se puede deshacer.')) return;

    btnDelete.disabled = true;
    try {
      const { error } = await db.from('clients').delete().eq('id', id);
      if (error) {
        $('#d-err').textContent = error.message;
        $('#d-err').hidden = false;
        return;
      }
      $('#dlg').close();
      toast('Cliente eliminado correctamente');
      loadClients();
    } finally {
      btnDelete.disabled = false;
    }
  });
}

/* ---------- Selección múltiple y borrado masivo de clientes ---------- */
function actualizarBotonEliminarMultiples() {
  const seleccionados = document.querySelectorAll('.row-select:checked');
  const btnMulti = $('#b-delete-selected');
  if (btnMulti) {
    btnMulti.hidden = seleccionados.length === 0;
  }
}

if (rowsEl) {
  rowsEl.addEventListener('change', (e) => {
    if (e.target.classList.contains('row-select')) {
      actualizarBotonEliminarMultiples();
    }
  });
}

const selectAllCheckbox = $('#select-all');
if (selectAllCheckbox) {
  selectAllCheckbox.addEventListener('change', (e) => {
    const checkboxes = document.querySelectorAll('.row-select');
    checkboxes.forEach(chk => chk.checked = e.target.checked);
    actualizarBotonEliminarMultiples();
  });
}

const btnDeleteSelected = $('#b-delete-selected');
if (btnDeleteSelected) {
  btnDeleteSelected.addEventListener('click', async () => {
    const seleccionados = Array.from(document.querySelectorAll('.row-select:checked')).map(chk => chk.value);
    if (seleccionados.length === 0) return;

    if (!confirm(`¿Estás seguro de eliminar los ${seleccionados.length} clientes seleccionados?`)) return;

    btnDeleteSelected.disabled = true;
    try {
      const { error } = await db.from('clients').delete().in('id', seleccionados);
      if (error) {
        toast(error.message, true);
        return;
      }
      toast('Clientes seleccionados eliminados correctamente');
      if (selectAllCheckbox) selectAllCheckbox.checked = false;
      loadClients();
    } finally {
      btnDeleteSelected.disabled = false;
    }
  });
}
