'use strict';
const cfg = window.ALMAGEST_CONFIG;
const db = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const digits = (v) => (v || '').replace(/\D/g, '');
const last9 = (v) => digits(v).slice(-9);
const code = (n) => 'C-' + String(n).padStart(4, '0');
const quoteCode = (n) => 'P-' + String(n).padStart(4, '0');
const KINDS = { particular: 'Particular', empresa: 'Empresa', comunidad: 'Comunidad' };
const STATUS_STYLE = {
  borrador: 'background:#fff3cd;color:#856404', emitido: 'background:#d1ecf1;color:#0c5460',
  aceptado: 'background:#d4edda;color:#155724', rechazado: 'background:#f8d7da;color:#721c24',
  pagado: 'background:#c3e6cb;color:#0b3d1e', facturado: 'background:#e2e3e5;color:#383d41', caducado: 'background:#e2e3e5;color:#383d41',
};
const fmt = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
const statusLabel = (q) => (q.status === 'rechazado' && q.closed_reason ? 'RECHAZADO (SIN RESPUESTA)' : q.status.toUpperCase());
const eur = (n) => fmt.format(n);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const priceLabel = (l) => (l.unit === '%' ? `${Number(l.unit_price)} %` : eur(l.unit_price));
const delMsg = (e) => (e.code === '23503' ? 'No se puede eliminar: tiene presupuestos asociados. Se conservan en el historial.' : e.message);

/* Helper de fechas */
function addDays(dateStr, n) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d;
}
function formatDateShort(d) {
  if (!d) return '—';
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

/* Importes: cada línea se redondea a céntimos; las líneas en % se calculan sobre las demás */
function lineAmounts(lines) {
  const base = round2(lines.filter((l) => l.unit !== '%').reduce((a, l) => a + round2(l.unit_price * l.qty), 0));
  return lines.map((l) => (l.unit === '%' ? round2((base * l.unit_price) / 100) : round2(l.unit_price * l.qty)));
}
function calcTotals(lines, iva) {
  const amounts = lineAmounts(lines);
  const subtotal = round2(amounts.reduce((a, b) => a + b, 0));
  const tax = round2((subtotal * iva) / 100);
  return { amounts, subtotal, tax, total: round2(subtotal + tax) };
}

/* Número para wa.me */
function waNumber(p) {
  const d = digits(p);
  if ((p || '').trim().startsWith('+')) return d;
  if (d.startsWith('00')) return d.slice(2);
  return d.length === 9 ? '34' + d : d;
}

function show(view) { for (const v of ['login', 'recovery', 'app']) $('#v-' + v).hidden = v !== view; }
let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  (document.querySelector('dialog[open]') || document.body).appendChild(t);
  t.textContent = msg;
  t.className = isErr ? 'err' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

/* ---------- Validación visual en tiempo real ---------- */
function setupRealtimeValidation() {
  document.addEventListener('input', (e) => {
    if (!e.target.classList.contains('validate-field')) return;
    const input = e.target;
    const val = input.value.trim();
    if (!val) {
      input.classList.remove('is-valid', 'is-invalid');
      return;
    }
    if (input.type === 'tel' || input.name.includes('phone')) {
      const isValid = digits(val).length >= 9;
      input.classList.toggle('is-valid', isValid);
      input.classList.toggle('is-invalid', !isValid);
    } else if (input.type === 'email' || input.name.includes('email')) {
      const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
      input.classList.toggle('is-valid', isValid);
      input.classList.toggle('is-invalid', !isValid);
    }
  });
}

/* ---------- Datos de empresa ---------- */
let company = { company_name: '', phone: '', email: '', iva_pct: 21, valid_days: 30, terms: '', company_nif: '', company_address: '', contact1_days: 3, contact2_days: 6, close_days: 7 };
async function loadCompany() {
  const { data } = await db.from('settings').select('*').maybeSingle();
  if (data) company = { ...company, ...data };
  renderPreview();
}
document.body.insertAdjacentHTML('beforeend', `
<dialog id="dlg-company"><form id="f-company"><h2>Datos de empresa</h2>
  <div class="grid">
    <label class="full">Nombre comercial / razón social<input name="company_name" maxlength="120"></label>
    <label>NIF/CIF<input name="company_nif" maxlength="20"></label>
    <label>Dirección<input name="company_address" maxlength="160"></label>
    <label>Teléfono<input name="phone" maxlength="25"></label>
    <label>Correo<input name="email" type="email" maxlength="120"></label>
    <label>IVA (%)<input name="iva_pct" type="number" step="0.01" min="0" max="100" required></label>
    <label>Validez del presupuesto (días)<input name="valid_days" type="number" step="1" min="1" max="365" required></label>
    <label>Avisar si no responden en (días)<input name="followup_days" type="number" step="1" min="1" max="90" required></label>
    <label>Seguimiento: contacto 1 (día)<input name="contact1_days" type="number" step="1" min="1" max="60" required></label>
    <label>Seguimiento: contacto 2 (día)<input name="contact2_days" type="number" step="1" min="1" max="60" required></label>
    <label>Archivar sin respuesta (día)<input name="close_days" type="number" step="1" min="1" max="60" required></label>
    <label class="full">Condiciones (pie del presupuesto)<textarea name="terms" rows="3" maxlength="600"></textarea></label>
  </div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><button id="b-export" class="btn ghost" type="button">Exportar todos los datos</button><button id="b-pass" class="btn ghost" type="button">Cambiar contraseña</button></div>
  <p id="d-company-err" class="error" hidden></p>
  <div class="actions"><button id="d-company-cancel" class="btn ghost" type="button">Cancelar</button><button class="btn" type="submit">Guardar</button></div>
</form></dialog>`);
$('.sidebar-section').insertAdjacentHTML('beforeend', '<button class="nav-btn" id="b-company" type="button">Datos de empresa</button>');
$('#b-company').addEventListener('click', () => {
  const f = $('#f-company');
  for (const k of ['company_name', 'company_nif', 'company_address', 'phone', 'email', 'iva_pct', 'valid_days', 'followup_days', 'contact1_days', 'contact2_days', 'close_days', 'terms']) f.elements[k].value = company[k] ?? '';
  $('#d-company-err').hidden = true;
  $('#dlg-company').showModal();
});
$('#d-company-cancel').addEventListener('click', () => $('#dlg-company').close());
$('#f-company').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const v = {
    company_name: f.elements.company_name.value.trim() || null, company_nif: f.elements.company_nif.value.trim() || null, company_address: f.elements.company_address.value.trim() || null, phone: f.elements.phone.value.trim() || null,
    email: f.elements.email.value.trim() || null, terms: f.elements.terms.value.trim() || null,
    iva_pct: parseFloat(f.elements.iva_pct.value), valid_days: parseInt(f.elements.valid_days.value, 10), followup_days: parseInt(f.elements.followup_days.value, 10),
    contact1_days: parseInt(f.elements.contact1_days.value, 10), contact2_days: parseInt(f.elements.contact2_days.value, 10), close_days: parseInt(f.elements.close_days.value, 10),
  };
  if (!(v.contact1_days < v.contact2_days && v.contact2_days <= v.close_days)) { $('#d-company-err').textContent = 'Los días del seguimiento deben ir en orden: contacto 1 < contacto 2 ≤ archivar.'; $('#d-company-err').hidden = false; return; }
  const { data: ex } = await db.from('settings').select('org_id').maybeSingle();
  const { error } = ex ? await db.from('settings').update(v).eq('org_id', ex.org_id) : await db.from('settings').insert(v);
  if (error) { $('#d-company-err').textContent = error.message; $('#d-company-err').hidden = false; return; }
  $('#dlg-company').close();
  toast('Datos de empresa guardados');
  loadCompany();
});

/* ---------- Catálogo en memoria y categorías ---------- */
let services = [];
const SUB_NONE = '__general__';
const catKey = (s) => s.category || 'General';
const subKey = (s) => s.description || SUB_NONE;
async function cacheServices() {
  const { data } = await db.from('services').select('*').eq('active', true).order('category').order('pos').order('name');
  services = data || [];
  const sel = $('#pres_category');
  const cur = sel.value;
  const cats = [...new Set(services.map(catKey))];
  sel.innerHTML = '<option value="">Selecciona categoría...</option>' + cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if (cats.includes(cur)) sel.value = cur;
}

/* ---------- Autoguardado local del borrador del presupuesto ---------- */
const DRAFT_KEY = 'almagest_quote_draft_v1';
let lines = [];

function saveQuoteDraft() {
  const draft = {
    phone: $('#pres_phone').value,
    name: $('#pres_name').value,
    email: $('#pres_email').value,
    locality: $('#pres_locality').value,
    clientCode: $('#pres_client_code').value,
    clientId: $('#pres_client_code').dataset.id || '',
    notes: $('#pres_notes').value,
    extraConcept: $('#pres_extra_concept').value,
    extraPrice: $('#pres_extra_price').value,
    extraChecked: $('#chk-toggle-extra').checked,
    lines: lines,
    timestamp: Date.now()
  };
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  const badge = $('#draft-saved-badge');
  if (badge) { badge.style.display = 'inline-block'; }
}

function restoreQuoteDraft() {
  const raw = localStorage.getItem(DRAFT_KEY);
  if (!raw) return;
  try {
    const draft = JSON.parse(raw);
    if (!draft) return;
    if (draft.phone !== undefined) $('#pres_phone').value = draft.phone;
    if (draft.name !== undefined) $('#pres_name').value = draft.name;
    if (draft.email !== undefined) $('#pres_email').value = draft.email;
    if (draft.locality !== undefined) $('#pres_locality').value = draft.locality;
    if (draft.notes !== undefined) $('#pres_notes').value = draft.notes;
    if (draft.clientCode) $('#pres_client_code').value = draft.clientCode;
    if (draft.clientId) $('#pres_client_code').dataset.id = draft.clientId;
    if (draft.extraConcept) $('#pres_extra_concept').value = draft.extraConcept;
    if (draft.extraPrice) $('#pres_extra_price').value = draft.extraPrice;
    if (draft.extraChecked) {
      $('#chk-toggle-extra').checked = true;
      $('#extra-fields-container').style.display = 'block';
    }
    if (Array.isArray(draft.lines)) {
      lines = draft.lines;
    }
    renderPreview();
    $$('.validate-field').forEach((el) => el.dispatchEvent(new Event('input', { bubbles: true })));
  } catch (e) {
    console.error('Error restaurando el borrador local:', e);
  }
}

function clearQuoteDraft() {
  localStorage.removeItem(DRAFT_KEY);
  const badge = $('#draft-saved-badge');
  if (badge) { badge.style.display = 'none'; }
}

/* ---------- Presupuesto en curso ---------- */
function renderPreview() {
  const t = calcTotals(lines, +company.iva_pct);
  $('#preview-rows').innerHTML = lines.length
    ? lines.map((l, i) => `<tr><td><strong>${esc(l.service_name)}</strong><br><small class="muted">${l.unit === '%' ? 'sobre el subtotal' : l.qty + ' ' + esc(l.unit)}</small></td>
        <td>${l.unit === '%' ? '—' : l.qty}</td><td>${priceLabel(l)}</td><td><strong>${eur(t.amounts[i])}</strong></td>
        <td><button type="button" class="btn ghost red" data-rm="${i}" style="padding:2px 6px;font-size:11px" aria-label="Quitar línea">×</button></td></tr>`).join('')
    : '<tr><td colspan="5" class="muted" style="text-align:center;padding:20px">Ningún servicio añadido todavía.</td></tr>';
  $('#preview-subtotal').textContent = eur(t.subtotal);
  $('#preview-tax').previousElementSibling.textContent = `IVA (${+company.iva_pct}%):`;
  $('#preview-tax').textContent = eur(t.tax);
  $('#preview-grand-total').textContent = eur(t.total);
}
$('#preview-rows').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rm]');
  if (b) { lines.splice(+b.dataset.rm, 1); renderPreview(); saveQuoteDraft(); }
});

const clearClient = () => { const c = $('#pres_client_code'); c.value = ''; delete c.dataset.id; };
const lockClientFields = (on) => ['#pres_name', '#pres_email', '#pres_locality'].forEach((s) => ($(s).readOnly = on));
function resetQuoteForm() {
  $('#f-presupuesto').reset();
  clearClient();
  lockClientFields(false);
  lines = [];
  renderPreview();
  for (const s of ['#extra-fields-container', '#subservice-container', '#package-services-container']) $(s).style.display = 'none';
  $('#package-items-list').innerHTML = '';
  $('#pres-result-info').textContent = '';
  $$('.validate-field').forEach((el) => el.classList.remove('is-valid', 'is-invalid'));
  clearQuoteDraft();
}

$('#chk-toggle-extra').addEventListener('change', (e) => {
  $('#extra-fields-container').style.display = e.target.checked ? 'block' : 'none';
  if (!e.target.checked) { $('#pres_extra_concept').value = ''; $('#pres_extra_price').value = ''; }
  saveQuoteDraft();
});
$('#b-add-extra').addEventListener('click', () => {
  const concept = $('#pres_extra_concept').value.trim();
  const price = parseFloat($('#pres_extra_price').value);
  if (!concept || !(price > 0)) return toast('Introduce un concepto y un importe válido para el suplemento.', true);
  lines.push({ service_name: `Suplemento: ${concept}`, unit: 'servicio', qty: 1, unit_price: price });
  renderPreview();
  $('#pres_extra_concept').value = ''; $('#pres_extra_price').value = '';
  $('#chk-toggle-extra').checked = false;
  $('#extra-fields-container').style.display = 'none';
  toast('Suplemento añadido al presupuesto');
  saveQuoteDraft();
});

/* Escuchar cambios para autoguardado */
$('#f-presupuesto').addEventListener('input', () => saveQuoteDraft());
$('#f-presupuesto').addEventListener('change', () => saveQuoteDraft());

$('#pres_category').addEventListener('change', () => {
  const cat = $('#pres_category').value;
  const sub = $('#pres_subservice');
  sub.innerHTML = '<option value="">Selecciona subtipo...</option>';
  $('#package-services-container').style.display = 'none';
  $('#package-items-list').innerHTML = '';
  const subs = [...new Set(services.filter((s) => catKey(s) === cat).map(subKey))];
  $('#subservice-container').style.display = subs.length ? 'grid' : 'none';
  sub.innerHTML += subs.map((x) => `<option value="${esc(x)}">${x === SUB_NONE ? 'General' : esc(x)}</option>`).join('');
  if (subs.length === 1) { sub.value = subs[0]; sub.dispatchEvent(new Event('change')); }
});
$('#pres_subservice').addEventListener('change', () => {
  const cat = $('#pres_category').value;
  const sub = $('#pres_subservice').value;
  const list = sub ? services.filter((s) => catKey(s) === cat && subKey(s) === sub) : [];
  $('#package-services-container').style.display = list.length ? 'block' : 'none';
  $('#package-items-list').innerHTML = list.map((s) => {
    const qty = s.unit !== 'servicio' && s.unit !== '%';
    const price = s.price === null ? 0 : s.price;
    return `<div class="pkg-item-row" style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid #eee">
      <label style="display:flex;flex-direction:row;align-items:center;gap:8px;font-size:13px;margin:0;cursor:pointer;flex:1">
        <input type="checkbox" class="pkg-item-chk" data-id="${esc(s.id)}" checked style="width:auto;min-height:0;padding:0">
        <span><strong>${esc(s.name)}</strong> <span class="muted">(${priceLabel({ unit: s.unit, unit_price: price })}${s.unit === '%' ? '' : ' / ' + esc(s.unit)})</span></span>
      </label>
      ${qty ? `<div style="display:flex;align-items:center;gap:4px"><input type="number" class="pkg-item-qty" min="0.01" step="any" value="1" style="width:80px;padding:4px;font-size:12px"><small class="muted">${esc(s.unit)}</small></div>` : '<input type="hidden" class="pkg-item-qty" value="1">'}
    </div>`;
  }).join('');
});
$('#b-add-lines').addEventListener('click', () => {
  let added = 0;
  for (const row of $$('.pkg-item-row')) {
    const chk = row.querySelector('.pkg-item-chk');
    if (!chk.checked) continue;
    const s = services.find((x) => x.id === chk.dataset.id);
    const qty = parseFloat(row.querySelector('.pkg-item-qty').value);
    if (!s || !(qty > 0)) return toast('Revisa las cantidades: deben ser mayores que 0.', true);
    lines.push({ service_name: s.name, unit: s.unit, qty, unit_price: Number(s.price) || 0 });
    added++;
  }
  if (!added) return toast('Selecciona al menos un servicio con el check.', true);
  renderPreview();
  toast(`${added} servicio(s) añadido(s) al resumen`);
  saveQuoteDraft();
});
$('#b-reset-presupuesto').addEventListener('click', () => { resetQuoteForm(); toast('Formulario y borrador local restablecidos'); });

/* Búsqueda de cliente por teléfono */
let phoneTimer;
const suggestions = new Map();
const hideSug = () => ($('#phone-suggestions').style.display = 'none');
$('#pres_phone').addEventListener('input', (e) => {
  clearTimeout(phoneTimer);
  clearClient();
  lockClientFields(false);
  const q = e.target.value.trim();
  if (!q) { for (const [s, v] of [['#pres_name', ''], ['#pres_email', ''], ['#pres_locality', 'No especificada']]) $(s).value = v; }
  if (q.length < 4) return hideSug();
  phoneTimer = setTimeout(async () => {
    const { data, error } = await db.rpc('search_clients', { q });
    if (error || !data || !data.length) return hideSug();
    suggestions.clear();
    data.forEach((c) => suggestions.set(c.id, c));
    $('#phone-suggestions').innerHTML = data.map((c) =>
      `<div class="suggestion-item" data-id="${esc(c.id)}" style="padding:10px;cursor:pointer;border-bottom:1px solid #eee">
        <strong>${esc(c.name)}</strong> <span class="muted">(${esc(c.phone)})</span><br><small class="muted">${code(c.code_num)} · ${esc(c.locality)}</small></div>`).join('');
    $('#phone-suggestions').style.display = 'block';
  }, 300);
});
$('#phone-suggestions').addEventListener('click', (e) => {
  const item = e.target.closest('.suggestion-item');
  const c = item && suggestions.get(item.dataset.id);
  if (!c) return;
  $('#pres_phone').value = c.phone;
  $('#pres_name').value = c.name;
  $('#pres_email').value = c.email || '';
  $('#pres_locality').value = c.locality;
  $('#pres_client_code').value = code(c.code_num);
  $('#pres_client_code').dataset.id = c.id;
  lockClientFields(true);
  hideSug();
  $$('#pres_phone, #pres_email').forEach((el) => el.dispatchEvent(new Event('input', { bubbles: true })));
  saveQuoteDraft();
});
document.addEventListener('click', (e) => { if (!e.target.closest('#pres_phone, #phone-suggestions')) hideSug(); });

$('#b-save-presupuesto').addEventListener('click', async () => {
  const phone = $('#pres_phone').value.trim();
  const name = $('#pres_name').value.trim();
  const email = $('#pres_email').value.trim() || null;
  const locality = $('#pres_locality').value.trim() || 'No especificada';
  const notes = $('#pres_notes').value.trim() || null;
  if (digits(phone).length < 9) return toast('El teléfono debe tener al menos 9 dígitos.', true);
  if (!name) return toast('El nombre o razón social es obligatorio.', true);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast('El correo no es válido.', true);
  if (!lines.length) return toast('Debes añadir al menos un servicio o concepto al presupuesto.', true);

  const btn = $('#b-save-presupuesto');
  btn.disabled = true;
  try {
    let clientId = $('#pres_client_code').dataset.id;
    if (!clientId) {
      const dup = await findDuplicates({ phone, email });
      if (dup.length) {
        const d = dup[0];
        if (!confirm(`Ya existe el cliente ${code(d.code_num)} · ${d.name} (${d.phone}).\n\nAceptar: usar esa ficha.\nCancelar: revisar los datos.`)) return;
        clientId = d.id;
      } else {
        const { data: c, error } = await db.from('clients').insert({ name, phone, email, locality, kind: 'particular' }).select().single();
        if (error) return toast('Error al crear el cliente: ' + error.message, true);
        clientId = c.id;
      }
    }
    const iva = +company.iva_pct;
    const t = calcTotals(lines, iva);
    const until = new Date();
    until.setDate(until.getDate() + (+company.valid_days || 30));
    const { data: q, error: qErr } = await db.from('quotes').insert({
      client_id: clientId, status: 'borrador', iva_pct: iva, subtotal: t.subtotal, total: t.total,
      valid_until: new Intl.DateTimeFormat('sv-SE').format(until), notes,
    }).select().single();
    if (qErr) return toast('Error al generar el presupuesto: ' + qErr.message, true);

    const rows = lines.map((l, i) => ({ quote_id: q.id, service_name: l.service_name, unit: l.unit, qty: l.qty, unit_price: l.unit_price, pos: i }));
    const { error: lErr } = await db.from('quote_lines').insert(rows);
    if (lErr) {
      await db.from('quotes').delete().eq('id', q.id);
      return toast('No se pudieron guardar las líneas: ' + lErr.message, true);
    }
    resetQuoteForm();
    toast(`Presupuesto ${quoteCode(q.quote_no)} generado`);
    openQuotePreview(q.id);
  } finally {
    btn.disabled = false;
  }
});

/* ---------- Historial con Columnas de Recordatorios y Vencimiento ---------- */
async function loadHistory() {
  const q = $('#search-history').value.trim();
  let query = db.from('quotes').select('*, clients(name, phone, email, locality)').order('created_at', { ascending: false }).limit(100);
  const st = $('#filter-history-status').value;
  if (st !== 'todos') query = query.eq('status', st);
  let data = [];
  if (q) {
    const m = q.match(/^(?:p-?)?0*(\d{1,6})$/i);
    if (m) query = query.eq('quote_no', +m[1]);
    else {
      const { data: cl } = await db.rpc('search_clients', { q });
      const ids = (cl || []).map((c) => c.id);
      query = ids.length ? query.in('client_id', ids) : null;
    }
  }
  if (query) {
    const r = await query;
    if (r.error) return toast(r.error.message, true);
    data = r.data;
  }
  $('#empty-history').hidden = data.length > 0;

  const now = new Date();
  const c1Days = +company.contact1_days || 3;
  const c2Days = +company.contact2_days || 6;
  const closeDays = +company.close_days || 7;

  $('#rows-history').innerHTML = data.map((x) => {
    const sentBase = x.sent_at || x.created_at;
    const dRec1 = addDays(sentBase, c1Days);
    const dRec2 = addDays(sentBase, c2Days);
    const dClose = addDays(sentBase, closeDays);
    const dValid = x.valid_until ? new Date(x.valid_until + 'T00:00:00') : null;

    let r1Html = '—', r2Html = '—', closeHtml = '—', validHtml = '—';

    if (x.status === 'emitido') {
      r1Html = `<span class="date-badge ${now >= dRec1 ? 'done' : 'pending'}">${formatDateShort(dRec1)}</span>`;
      r2Html = `<span class="date-badge ${now >= dRec2 ? 'done' : 'pending'}">${formatDateShort(dRec2)}</span>`;
      closeHtml = `<span class="date-badge ${now >= dClose ? 'expired' : 'pending'}">${formatDateShort(dClose)}</span>`;
    } else {
      r1Html = `<span class="date-badge neutral">${formatDateShort(dRec1)}</span>`;
      r2Html = `<span class="date-badge neutral">${formatDateShort(dRec2)}</span>`;
      closeHtml = `<span class="date-badge neutral">${formatDateShort(dClose)}</span>`;
    }

    if (dValid) {
      const isExpired = now > dValid && (x.status === 'borrador' || x.status === 'emitido');
      validHtml = `<span class="date-badge ${isExpired ? 'expired' : 'neutral'}">${formatDateShort(dValid)}</span>`;
    }

    return `<tr>
      <td><strong>${quoteCode(x.quote_no)}</strong></td>
      <td>${new Date(x.created_at).toLocaleDateString('es-ES')}</td>
      <td><a href="#" class="link" data-client="${esc(x.client_id)}" title="Abrir ficha del cliente"><strong>${esc(x.clients?.name || 'Cliente')}</strong></a></td>
      <td><span style="padding:3px 8px;border-radius:4px;font-size:11px;font-weight:600;${STATUS_STYLE[x.status] || ''}">${esc(statusLabel(x))}</span></td>
      <td>${r1Html}</td>
      <td>${r2Html}</td>
      <td>${closeHtml}</td>
      <td>${validHtml}</td>
      <td><strong>${eur(x.total)}</strong></td>
      <td><button class="btn ghost" type="button" data-open="${esc(x.id)}" style="padding:4px 10px;font-size:12px">Ver / Enviar PDF</button></td>
    </tr>`;
  }).join('');
}
let historyTimer;
$('#search-history').addEventListener('input', () => { clearTimeout(historyTimer); historyTimer = setTimeout(loadHistory, 250); });
$('#filter-history-status').addEventListener('change', loadHistory);
$('#b-refresh-history').addEventListener('click', loadHistory);
$('#rows-history').addEventListener('click', (e) => {
  const o = e.target.closest('[data-open]');
  if (o) return openQuotePreview(o.dataset.open);
  const c = e.target.closest('[data-client]');
  if (c) { e.preventDefault(); openClientDetail(c.dataset.client); }
});
async function openClientDetail(id) {
  $('.nav-btn[data-target="clientes"]').click();
  const { data } = await db.from('clients').select('*').eq('id', id).single();
  if (data) openForm(data); else toast('No se encontró la ficha del cliente', true);
}

/* ---------- Previsualización, PDF y envío ---------- */
let active = null;
function pdfHtml(q, ls) {
  const t = calcTotals(ls, +q.iva_pct);
  const c = q.clients || {};
  const d = (x) => new Date(x).toLocaleDateString('es-ES');
  const td = 'padding:8px;border-bottom:1px solid #E3ECE6;';
  const rows = ls.map((l, i) => `<tr><td style="${td}"><strong>${esc(l.service_name)}</strong></td>
    <td style="${td}text-align:center">${l.unit === '%' ? '—' : l.qty + ' ' + esc(l.unit)}</td>
    <td style="${td}text-align:right">${priceLabel(l)}</td><td style="${td}text-align:right"><strong>${eur(t.amounts[i])}</strong></td></tr>`).join('');
  const idLine = [company.company_nif && 'NIF/CIF: ' + company.company_nif, company.company_address].filter(Boolean).map(esc).join(' · ');
  const contact = [company.phone && 'Tel: ' + company.phone, company.email].filter(Boolean).map(esc).join(' · ');
  const line = (a, b, s = '') => `<div style="display:flex;justify-content:space-between;padding:4px 0;${s}"><span>${a}</span><span>${b}</span></div>`;
  return `
  <div style="display:flex;justify-content:space-between;border-bottom:2px solid #164B38;padding-bottom:15px;margin-bottom:20px">
    <div><h1 style="color:#164B38;font-size:22px;margin:0">${esc(company.company_name || 'Presupuesto')}</h1>
      <p style="margin:6px 0 0;font-size:11px;color:#4A6A5A">${idLine}${idLine && contact ? '<br>' : ''}${contact}</p></div>
    <div style="text-align:right"><strong style="font-size:18px;color:#164B38">${quoteCode(q.quote_no)}</strong><br>
      <span style="font-size:12px;color:#4A6A5A">Fecha: ${d(q.created_at)}${q.valid_until ? '<br>Válido hasta: ' + d(q.valid_until) : ''}</span></div>
  </div>
  <div style="margin-bottom:20px;font-size:13px;background:#f8fbf9;padding:12px;border-radius:6px;border:1px solid #BFD3C6">
    <strong style="color:#164B38">DATOS DEL CLIENTE</strong><br><span style="font-weight:600">${esc(c.name || 'Cliente')}</span><br>
    ${esc(c.phone || '')}${c.locality ? ' | ' + esc(c.locality) : ''}</div>
  <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px"><thead><tr style="background:#E3F1E8;color:#164B38">
    <th style="padding:8px;text-align:left">Concepto / Servicio</th><th style="padding:8px;width:90px">Cant.</th>
    <th style="padding:8px;text-align:right;width:90px">Precio</th><th style="padding:8px;text-align:right;width:90px">Total</th></tr></thead><tbody>${rows}</tbody></table>
  <div style="display:flex;justify-content:flex-end"><div style="width:250px;font-size:13px;color:#4A6A5A">
    ${line('Base imponible:', eur(t.subtotal))}${line(`IVA (${+q.iva_pct}%):`, eur(t.tax))}
    ${line('TOTAL:', eur(t.total), 'border-top:2px solid #164B38;font-weight:bold;color:#164B38;font-size:15px;margin-top:4px;padding-top:6px')}</div></div>
  ${q.notes ? `<p style="margin-top:20px;font-size:12px"><strong>Observaciones:</strong> ${esc(q.notes)}</p>` : ''}
  ${company.terms ? `<p style="margin-top:20px;font-size:11px;color:#4A6A5A">${esc(company.terms)}</p>` : ''}`;
}
async function openQuotePreview(id) {
  const { data: q, error } = await db.from('quotes').select('*, clients(*)').eq('id', id).single();
  if (error || !q) return toast('No se pudo cargar el presupuesto', true);
  const { data: ls, error: lErr } = await db.from('quote_lines').select('*').eq('quote_id', id).order('pos');
  if (lErr) return toast('No se pudieron cargar las líneas: ' + lErr.message, true);
  active = { id, q, ls, code: quoteCode(q.quote_no), name: q.clients?.name || 'Cliente', phone: q.clients?.phone || '', email: q.clients?.email || '', total: Number(q.total) };
  $('#preview-modal-title').textContent = `Presupuesto ${active.code}`;
  $('#quote-status-select').value = q.status;
  renderQuoteActions(q);
  $('#pdf-printable-area').innerHTML = pdfHtml(q, ls);
  if (!$('#dlg-quote-preview').open) $('#dlg-quote-preview').showModal();
}
async function setStatus(id, status) {
  const patch = { status, closed_reason: null, closed_at: null };
  if (status === 'pagado') patch.paid_at = new Date().toISOString();
  if (status === 'emitido') { patch.sent_at = new Date().toISOString(); patch.paused_until = null; }
  const { error } = await db.from('quotes').update(patch).eq('id', id);
  if (error) { toast('No se pudo actualizar el estado: ' + error.message, true); return false; }
  return true;
}
async function markSent() {
  if (!active) return;
  const { data } = await db.from('quotes').select('status').eq('id', active.id).single();
  if (data?.status === 'borrador' && (await setStatus(active.id, 'emitido'))) { $('#quote-status-select').value = 'emitido'; loadHistory(); }
}
$('#quote-status-select').addEventListener('change', async (e) => {
  if (!active) return;
  if (await setStatus(active.id, e.target.value)) { toast('Estado actualizado'); loadHistory(); }
});
const signature = () => [company.company_name, company.phone && 'Tel: ' + company.phone, company.email].filter(Boolean).join('\n');
$('#b-download-pdf').addEventListener('click', () => {
  if (!active) return;
  html2pdf().from($('#pdf-printable-area')).set({
    margin: 10, filename: `Presupuesto_${active.code}.pdf`, image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true, scrollX: 0, scrollY: 0 },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }, pagebreak: { mode: ['css', 'legacy'], avoid: 'tr' },
  }).save();
  toast('Descargando PDF...');
});
$('#b-send-whatsapp').addEventListener('click', async () => {
  if (!active || !digits(active.phone)) return toast('El cliente no tiene un teléfono válido.', true);
  const msg = `Hola ${active.name}, le enviamos el presupuesto ${active.code} por un importe total de ${eur(active.total)} (IVA incl.).\n\nAtentamente,\n${signature()}`;
  window.open(`https://api.whatsapp.com/send?phone=${waNumber(active.phone)}&text=${encodeURIComponent(msg)}`, '_blank', 'noopener');
  toast('Abriendo WhatsApp. Recuerda adjuntar el PDF descargado.');
  markSent();
});
$('#b-send-email').addEventListener('click', () => {
  if (!active) return;
  const body = `Estimado/a ${active.name},\n\nLe adjuntamos el presupuesto ${active.code} por un importe total de ${eur(active.total)} (IVA incluido).\n\nQuedamos a su disposición para cualquier aclaración.\n\nAtentamente,\n${signature()}`;
  window.location.href = `mailto:${encodeURIComponent(active.email)}?subject=${encodeURIComponent(`Presupuesto ${active.code}`)}&body=${encodeURIComponent(body)}`;
  toast('Recuerda adjuntar el PDF descargado.');
  markSent();
});
$('#b-close-preview').addEventListener('click', () => $('#dlg-quote-preview').close());

/* ---------- Inicio (dashboard) con vista ampliada de facturación ---------- */
function dashStats(monthRows, pendingRows, now, validDays, followDays) {
  const ref = (q) => new Date(q.sent_at || q.created_at);
  const sum = (a) => round2(a.reduce((s, q) => s + Number(q.total), 0));
  const bucket = (offset) => {
    const a = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const b = new Date(now.getFullYear(), now.getMonth() + offset + 1, 1);
    const sent = monthRows.filter((q) => q.status !== 'borrador' && ref(q) >= a && ref(q) < b);
    const acc = sent.filter((q) => q.status === 'aceptado' || q.status === 'facturado' || q.status === 'pagado');
    return { label: new Intl.DateTimeFormat('es-ES', { month: 'short' }).format(a).replace('.', ''), sent, acc, sentTotal: sum(sent), accTotal: sum(acc) };
  };
  const series = [-5, -4, -3, -2, -1, 0].map(bucket);
  const cur = series[5];
  const pend = pendingRows.map((q) => ({ ...q, days: Math.floor((now - ref(q)) / 864e5) })).sort((a, b) => b.days - a.days);
  return {
    ...cur, series, prev: series[4],
    rate: cur.sent.length ? Math.round((cur.acc.length / cur.sent.length) * 100) : 0,
    pend, pendTotal: sum(pend),
    expired: pend.filter((q) => q.days > validDays),
    waiting: pend.filter((q) => q.days > followDays && q.days <= validDays),
  };
}
function gaugeSvg(pct, label) {
  const col = pct >= 50 ? '#2D6A4F' : pct >= 25 ? '#d9a400' : '#9B2226';
  const arc = 'M 20 100 A 80 80 0 0 1 180 100';
  return `<svg viewBox="0 0 200 118" class="gauge" role="img" aria-label="${esc(label)}: ${pct} %"><path d="${arc}" pathLength="100" class="g-bg"/>
    ${pct ? `<path d="${arc}" pathLength="100" class="g-fg" stroke="${col}" stroke-dasharray="${pct} 100"/>` : ''}
    <text x="100" y="92" class="g-v">${pct} %</text><text x="20" y="116" class="g-s">0</text><text x="180" y="116" class="g-s" text-anchor="end">100</text></svg>`;
}
function donutSvg(parts, total) {
  let off = 0;
  const segs = total ? parts.filter((p) => p.n).map((p) => {
    const pct = (p.n / total) * 100;
    const el = `<circle cx="50" cy="50" r="38" pathLength="100" class="d-seg" stroke="${p.c}" stroke-dasharray="${pct} ${100 - pct}" stroke-dashoffset="${-off}"/>`;
    off += pct;
    return el;
  }).join('') : '';
  return `<svg viewBox="0 0 100 100" class="donut" role="img" aria-label="Estado de los presupuestos enviados este mes"><circle cx="50" cy="50" r="38" class="d-bg"/>
    <g transform="rotate(-90 50 50)">${segs}</g><text x="50" y="53" class="d-v">${total}</text><text x="50" y="65" class="d-s">enviados</text></svg>`;
}

async function loadDashboard() {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const since = new Date(now.getFullYear(), now.getMonth() - 5, 1).toISOString();
  const cols = 'id, quote_no, status, total, created_at, sent_at, closed_reason, clients(name)';
  const [month, pending, recent, drafts, newClients, billingData] = await Promise.all([
    db.from('quotes').select(cols).or(`sent_at.gte.${since},created_at.gte.${since}`).limit(1000),
    db.from('quotes').select(cols).eq('status', 'emitido').limit(500),
    db.from('quotes').select(cols).order('created_at', { ascending: false }).limit(5),
    db.from('quotes').select('id', { count: 'exact', head: true }).eq('status', 'borrador'),
    db.from('clients').select('id', { count: 'exact', head: true }).gte('created_at', monthStart),
    db.from('quotes').select('status, total').in('status', ['facturado', 'pagado']),
  ]);
  const failed = [month, pending, recent, billingData].find((r) => r.error);
  if (failed) return toast('No se pudo cargar el inicio: ' + failed.error.message, true);

  const validDays = +company.valid_days || 30;
  const followDays = +company.followup_days || 7;
  const s = dashStats(month.data, pending.data, now, validDays, followDays);
  const h = now.getHours();
  const greet = h < 14 ? 'Buenos días' : h < 21 ? 'Buenas tardes' : 'Buenas noches';
  const date = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now);
  const monthName = new Intl.DateTimeFormat('es-ES', { month: 'long' }).format(now);
  const nDrafts = drafts.count || 0;
  const nNew = newClients.count || 0;

  // Cálculo de facturación y cobros
  const billedQuotes = billingData.data || [];
  const totalBilled = billedQuotes.reduce((acc, q) => acc + Number(q.total), 0);
  const totalPaid = billedQuotes.filter((q) => q.status === 'pagado').reduce((acc, q) => acc + Number(q.total), 0);
  const pendingCollection = billedQuotes.filter((q) => q.status === 'facturado').reduce((acc, q) => acc + Number(q.total), 0);

  const delta = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);
  const chip = (d) => (d === null ? '' : `<span class="chip ${d > 0 ? 'up' : d < 0 ? 'down' : 'flat'}" title="Frente al mes anterior">${d > 0 ? '▲' : d < 0 ? '▼' : '='} ${Math.abs(d)} %</span>`);
  
  const kpis = [
    { l: 'Enviados este mes', v: s.sent.length, c: chip(delta(s.sent.length, s.prev.sent.length)), s: monthName },
    { l: 'Total presupuestado', v: eur(s.sentTotal), c: chip(delta(s.sentTotal, s.prev.sentTotal)), s: 'IVA incl.' },
    { l: 'Importe aceptado', v: eur(s.accTotal), c: chip(delta(s.accTotal, s.prev.accTotal)), s: `${s.acc.length} aceptado${s.acc.length === 1 ? '' : 's'}` },
    { l: 'Pendientes de respuesta', v: s.pend.length, c: '', s: eur(s.pendTotal) + ' en juego', cls: s.expired.length ? 'err' : s.waiting.length ? 'warn' : '' },
    { l: 'Cobrado total (Pagado)', v: eur(totalPaid), c: '', s: `de ${eur(totalBilled)} facturados` },
    { l: 'Pendiente de cobro', v: eur(pendingCollection), c: '', s: 'Aún sin ingresar', cls: pendingCollection > 0 ? 'warn' : '' },
  ];

  const nPend = s.sent.filter((q) => q.status === 'emitido').length;
  const nLost = s.sent.length - s.acc.length - nPend;
  const parts = [{ n: s.acc.length, c: '#2D6A4F', t: 'Aceptados' }, { n: nPend, c: '#3B82A0', t: 'Esperando respuesta' }, { n: nLost, c: '#9B2226', t: 'Rechazados o caducados' }];
  const legend = parts.map((p) => `<li><i class="dot" style="background:${p.c}"></i>${p.t}<strong>${p.n}</strong></li>`).join('');

  const max = Math.max(1, ...s.series.map((m) => m.sentTotal));
  const bars = s.series.map((m) => `<div class="bcol" title="${esc(m.label)}: presupuestado ${eur(m.sentTotal)} · aceptado ${eur(m.accTotal)}">
    <div class="bpair"><i class="b1" style="height:${(m.sentTotal / max) * 100}%"></i><i class="b2" style="height:${(m.accTotal / max) * 100}%"></i></div><span>${esc(m.label)}</span></div>`).join('');

  const item = (q, cls, right) => `<li class="att ${cls}" data-open="${esc(q.id)}" tabindex="0"><span><strong>${quoteCode(q.quote_no)}</strong> · ${esc(q.clients?.name || 'Cliente')}</span><span>${right}</span></li>`;
  const pendList = (arr, cls) => arr.slice(0, 6).map((q) => item(q, cls, `${q.days} días · <strong>${eur(q.total)}</strong>`)).join('')
    + (arr.length > 6 ? `<li class="muted" style="padding:6px 0">y ${arr.length - 6} más en el historial</li>` : '');
  let att = '';
  if (s.expired.length) att += `<h4 class="att-h err">Vencidos: sin respuesta tras más de ${validDays} días (${s.expired.length})</h4><ul class="att-list">${pendList(s.expired, 'err')}</ul>`;
  if (s.waiting.length) att += `<h4 class="att-h warn">Sin respuesta tras más de ${followDays} días (${s.waiting.length})</h4><ul class="att-list">${pendList(s.waiting, 'warn')}</ul>`;
  if (nDrafts) att += `<p class="muted" style="margin-top:12px">📌 ${nDrafts} borrador${nDrafts > 1 ? 'es' : ''} sin enviar</p>`;
  if (!att) att = '<p class="muted">Todo al día: no hay presupuestos pendientes de seguimiento.</p>';
  const last = recent.data.length
    ? '<ul class="att-list">' + recent.data.map((q) => item(q, 'ok', `<span style="padding:2px 7px;border-radius:4px;font-size:11px;font-weight:600;${STATUS_STYLE[q.status] || ''}">${esc(statusLabel(q))}</span> <strong>${eur(q.total)}</strong>`)).join('') + '</ul>'
    : '<p class="muted">Aún no hay presupuestos.</p>';

  $('#dash').innerHTML = `
    <div class="dash-hero"><h2>${greet}</h2><p>${date[0].toUpperCase() + date.slice(1)}${company.company_name ? ' · ' + esc(company.company_name) : ''}${nNew ? ` · ${nNew} cliente${nNew > 1 ? 's' : ''} nuevo${nNew > 1 ? 's' : ''} este mes` : ''}</p></div>
    <div class="kpi-grid">${kpis.map((k) => `<div class="kpi ${k.cls || ''}"><span class="l">${k.l}</span><span class="v">${k.v}${k.c}</span><span class="s">${k.s}</span></div>`).join('')}</div>
    <div class="chart-grid">
      <div class="card"><h3>Tasa de aceptación</h3>${gaugeSvg(s.rate, 'Tasa de aceptación')}<p class="muted" style="text-align:center;margin:4px 0 0">${s.acc.length} de ${s.sent.length} enviados este mes</p></div>
      <div class="card"><h3>Estado de lo enviado</h3>${donutSvg(parts, s.sent.length)}<ul class="legend">${legend}</ul></div>
      <div class="card"><h3>Últimos 6 meses</h3><div class="bars" role="img" aria-label="Evolución mensual de lo presupuestado y lo aceptado">${bars}</div>
        <p class="muted" style="margin:8px 0 0"><i class="dot" style="background:#9CC5AE"></i> Presupuestado &nbsp; <i class="dot" style="background:#2D6A4F"></i> Aceptado</p></div>
    </div>
    <div class="dash-cols"><div class="card"><h3>Requieren atención</h3>${att}</div><div class="card"><h3>Últimos presupuestos</h3>${last}</div></div>`;
}
$('#dash').addEventListener('click', (e) => { const o = e.target.closest('[data-open]'); if (o) openQuotePreview(o.dataset.open); });
$('#dash').addEventListener('keydown', (e) => { const o = e.key === 'Enter' && e.target.closest('[data-open]'); if (o) openQuotePreview(o.dataset.open); });
$('#dlg-quote-preview').addEventListener('close', () => { if (!$('#sec-inicio').hidden) loadDashboard(); });

/* ---------- Tareas y agenda, campana y acciones ---------- */
const todayStr = () => new Intl.DateTimeFormat('sv-SE').format(new Date());
const plusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return new Intl.DateTimeFormat('sv-SE').format(d); };
const FOREVER = '2999-12-31';
document.body.insertAdjacentHTML('beforeend', `
<dialog id="dlg-task"><form id="f-task"><h2 id="d-task-title">Nueva tarea</h2>
  <div class="grid"><label class="full">Tarea *<input name="title" required maxlength="160" placeholder="Ej. Llamar a Ana para cerrar el presupuesto"></label>
  <label>Fecha<input name="due_date" type="date"></label></div>
  <p id="d-task-err" class="error" hidden></p>
  <div class="actions"><button id="d-task-delete" class="btn ghost red" type="button" hidden>Eliminar</button><span class="grow"></span>
  <button id="d-task-cancel" class="btn ghost" type="button">Cancelar</button><button class="btn" type="submit">Guardar</button></div></form></dialog>
<dialog id="dlg-pass"><form id="f-pass"><h2>Cambiar contraseña</h2>
  <label>Contraseña nueva (mínimo 8 caracteres)<input name="p1" type="password" minlength="8" autocomplete="new-password" required></label>
  <label style="margin-top:10px">Repite la contraseña<input name="p2" type="password" minlength="8" autocomplete="new-password" required></label>
  <p id="d-pass-err" class="error" hidden></p>
  <div class="actions"><button id="d-pass-cancel" class="btn ghost" type="button">Cancelar</button><button class="btn" type="submit">Guardar</button></div></form></dialog>`);

let tasks = [];
async function loadTasks() {
  const { data, error } = await db.from('tasks').select('*, clients(name), quotes(quote_no)').order('due_date', { ascending: true }).limit(300);
  if (error) return toast(error.message, true);
  tasks = data;
  const t = todayStr(), open = tasks.filter((x) => !x.done);
  const groups = [['Vencidas', open.filter((x) => x.due_date && x.due_date < t), 'err'], ['Hoy', open.filter((x) => x.due_date === t), 'warn'],
    ['Próximas', open.filter((x) => x.due_date > t), 'ok'], ['Sin fecha', open.filter((x) => !x.due_date), 'ok']];
  const row = (x, cls) => `<li class="att ${cls}"><label class="task-chk"><input type="checkbox" data-done="${esc(x.id)}" ${x.done ? 'checked' : ''}><span class="${x.done ? 'task-done' : ''}">${esc(x.title)}</span></label>
    <span class="muted">${x.due_date ? new Date(x.due_date + 'T00:00').toLocaleDateString('es-ES') : ''}${x.quotes ? ' · ' + quoteCode(x.quotes.quote_no) : ''} <button class="link" type="button" data-edit-task="${esc(x.id)}">Editar</button></span></li>`;
  const done = tasks.filter((x) => x.done).sort((a, b) => (b.done_at || '').localeCompare(a.done_at || '')).slice(0, 10);
  $('#task-list').innerHTML = (open.length
    ? groups.filter((g) => g[1].length).map(([n, a, c]) => `<div class="card" style="margin-bottom:14px"><h3>${n} (${a.length})</h3><ul class="att-list">${a.map((x) => row(x, c)).join('')}</ul></div>`).join('')
    : '<div class="card"><p class="muted">No tienes tareas pendientes. Pulsa «Nueva tarea» para añadir una.</p></div>')
    + (done.length ? `<details class="card"><summary>Completadas recientemente (${done.length})</summary><ul class="att-list" style="margin-top:8px">${done.map((x) => row(x, 'ok')).join('')}</ul></details>` : '');
}
function openTaskDialog(x, preset = {}) {
  const f = $('#f-task');
  f.reset();
  f.dataset.id = x ? x.id : '';
  f.dataset.client = x?.client_id || preset.client_id || '';
  f.dataset.quote = x?.quote_id || preset.quote_id || '';
  f.elements.title.value = x ? x.title : preset.title || '';
  f.elements.due_date.value = x ? x.due_date || '' : preset.due_date || todayStr();
  $('#d-task-title').textContent = x ? 'Editar tarea' : 'Nueva tarea';
  $('#d-task-delete').hidden = !x;
  $('#d-task-err').hidden = true;
  $('#dlg-task').showModal();
}
const reloadTasks = () => { if (!$('#sec-tareas').hidden) loadTasks(); refreshBell(); };
$('#b-new-task').addEventListener('click', () => openTaskDialog(null));
$('#d-task-cancel').addEventListener('click', () => $('#dlg-task').close());
$('#task-list').addEventListener('click', (e) => { const b = e.target.closest('[data-edit-task]'); if (b) openTaskDialog(tasks.find((x) => x.id === b.dataset.editTask)); });
$('#task-list').addEventListener('change', async (e) => {
  const id = e.target.dataset.done;
  if (!id) return;
  const { error } = await db.from('tasks').update({ done: e.target.checked, done_at: e.target.checked ? new Date().toISOString() : null }).eq('id', id);
  if (error) toast(error.message, true);
  loadTasks(); refreshBell();
});
$('#f-task').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, id = f.dataset.id;
  const v = { title: f.elements.title.value.trim(), due_date: f.elements.due_date.value || null };
  if (!v.title) return;
  if (!id) { v.client_id = f.dataset.client || null; v.quote_id = f.dataset.quote || null; }
  const { error } = id ? await db.from('tasks').update(v).eq('id', id) : await db.from('tasks').insert(v);
  if (error) { $('#d-task-err').textContent = error.message; $('#d-task-err').hidden = false; return; }
  $('#dlg-task').close();
  toast(id ? 'Tarea actualizada' : 'Tarea creada');
  reloadTasks();
});
$('#d-task-delete').addEventListener('click', async () => {
  const id = $('#f-task').dataset.id;
  if (!id || !confirm('¿Eliminar esta tarea?')) return;
  const { error } = await db.from('tasks').delete().eq('id', id);
  if (error) return toast(error.message, true);
  $('#dlg-task').close();
  toast('Tarea eliminada');
  reloadTasks();
});

/* Campana */
async function refreshBell() {
  const t = todayStr(), since = new Date(Date.now() - 7 * 864e5).toISOString();
  const [tk, cl] = await Promise.all([
    db.from('tasks').select('id,title,due_date').eq('done', false).lte('due_date', t).order('due_date').limit(20),
    db.from('quotes').select('id,quote_no,valid_until,clients(name)').eq('status', 'rechazado').eq('closed_reason', 'sin_respuesta').gte('closed_at', since).order('closed_at', { ascending: false }).limit(20),
  ]);
  const T = tk.data || [], C = cl.data || [], n = T.length + C.length;
  $('#bell-count').textContent = n > 9 ? '9+' : n;
  $('#bell-count').hidden = !n;
  document.title = (n ? `(${n}) ` : '') + 'AlmaGest';
  const tl = T.slice(0, 6).map((x) => `<li class="att ${x.due_date < t ? 'err' : 'warn'}" data-bell-task="1" tabindex="0"><span>${esc(x.title)}</span></li>`).join('');
  const cll = C.slice(0, 6).map((q) => `<li class="att err" data-open="${esc(q.id)}" tabindex="0"><span><strong>${quoteCode(q.quote_no)}</strong> · ${esc(q.clients?.name || 'Cliente')}</span><span>${q.valid_until >= t ? 'recuperable' : 'fuera de plazo'}</span></li>`).join('');
  $('#bell-panel').innerHTML = n
    ? (T.length ? `<h4 class="att-h warn">Tareas para hoy o vencidas (${T.length})</h4><ul class="att-list">${tl}</ul>` : '')
      + (C.length ? `<h4 class="att-h err">Archivados sin respuesta (${C.length})</h4><ul class="att-list">${cll}</ul>` : '')
    : '<p class="muted" style="margin:6px">Sin novedades.</p>';
}
$('#b-bell').addEventListener('click', (e) => { e.stopPropagation(); $('#bell-panel').hidden = !$('#bell-panel').hidden; });
$('#bell-panel').addEventListener('click', (e) => {
  const o = e.target.closest('[data-open]');
  if (o) { $('#bell-panel').hidden = true; openQuotePreview(o.dataset.open); }
  if (e.target.closest('[data-bell-task]')) { $('#bell-panel').hidden = true; $('.nav-btn[data-target="tareas"]').click(); }
});
document.addEventListener('click', (e) => { if (!e.target.closest('.bell-wrap')) $('#bell-panel').hidden = true; });
setInterval(() => { if (appShown) refreshBell(); }, 300000);
window.addEventListener('focus', () => { if (appShown) refreshBell(); });

/* Acciones del presupuesto */
function renderQuoteActions(q) {
  const b = (a, t, cls = 'ghost') => `<button class="btn ${cls}" type="button" data-act="${a}" style="padding:4px 10px;font-size:12px">${t}</button>`;
  let h = '';
  if (q.status === 'emitido') h += b('replied', 'Cliente respondió (pausar seguimiento)') + b('snooze', 'Posponer 3 días');
  if (q.status === 'rechazado' && q.closed_reason) {
    h += q.valid_until && q.valid_until >= todayStr() ? b('recover', 'Recuperar presupuesto', '') + b('accept', 'Marcar aceptado')
      : '<span class="muted">Archivado sin respuesta y fuera del plazo de validez: crea un presupuesto nuevo.</span>';
  }
  $('#q-actions').innerHTML = h + b('dup', 'Duplicar') + b('task', 'Crear tarea');
}
async function duplicateQuote() {
  const { q, ls } = active;
  const until = new Date();
  until.setDate(until.getDate() + (+company.valid_days || 30));
  const { data: n, error } = await db.from('quotes').insert({ client_id: q.client_id, status: 'borrador', iva_pct: q.iva_pct, subtotal: q.subtotal, total: q.total, valid_until: new Intl.DateTimeFormat('sv-SE').format(until), notes: q.notes }).select().single();
  if (error) return toast(error.message, true);
  const rows = ls.map((l, i) => ({ quote_id: n.id, service_name: l.service_name, description: l.description, unit: l.unit, qty: l.qty, unit_price: l.unit_price, pos: i }));
  const { error: e2 } = await db.from('quote_lines').insert(rows);
  if (e2) { await db.from('quotes').delete().eq('id', n.id); return toast(e2.message, true); }
  toast(`Creado ${quoteCode(n.quote_no)} como borrador`);
  await openQuotePreview(n.id);
  loadHistory();
}
$('#q-actions').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act || !active) return;
  const upd = async (patch, msg) => {
    const { error } = await db.from('quotes').update(patch).eq('id', active.id);
    if (error) return toast(error.message, true);
    toast(msg);
    await openQuotePreview(active.id);
    loadHistory(); refreshBell();
  };
  if (act === 'replied') return upd({ paused_until: FOREVER }, 'Seguimiento pausado');
  if (act === 'snooze') return upd({ paused_until: plusDays(3) }, 'Seguimiento pospuesto 3 días');
  if (act === 'recover') return upd({ status: 'emitido', closed_reason: null, closed_at: null, paused_until: FOREVER }, 'Presupuesto recuperado');
  if (act === 'accept') return upd({ status: 'aceptado', closed_reason: null, closed_at: null }, 'Marcado como aceptado');
  if (act === 'task') return openTaskDialog(null, { title: `Contactar con ${active.name}: ${active.code}`, client_id: active.q.client_id, quote_id: active.id, due_date: plusDays(1) });
  if (act === 'dup') return duplicateQuote();
});

/* Copia de seguridad y cambio de contraseña */
$('#b-export').addEventListener('click', async () => {
  const out = { exported_at: new Date().toISOString() };
  for (const t of ['clients', 'quotes', 'quote_lines', 'services', 'tasks', 'settings']) {
    out[t] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from(t).select('*').range(from, from + 999);
      if (error) return toast(`No se pudo exportar ${t}: ${error.message}`, true);
      out[t].push(...data);
      if (data.length < 1000) break;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
  a.download = `almagest_copia_${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Copia de seguridad descargada');
});
$('#b-pass').addEventListener('click', () => { $('#f-pass').reset(); $('#d-pass-err').hidden = true; $('#dlg-pass').showModal(); });
$('#d-pass-cancel').addEventListener('click', () => $('#dlg-pass').close());
$('#f-pass').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, err = (m) => { $('#d-pass-err').textContent = m; $('#d-pass-err').hidden = false; };
  if (f.elements.p1.value !== f.elements.p2.value) return err('Las dos contraseñas no coinciden.');
  const { error } = await db.auth.updateUser({ password: f.elements.p1.value });
  if (error) return err(error.message);
  $('#dlg-pass').close(); toast('Contraseña cambiada'); });  async function boot() { setupRealtimeValidation(); await loadCompany(); restoreQuoteDraft(); try { await db.rpc('run_followups'); } catch (e) { /* fallback si falta RPC */ } loadDashboard(); refreshBell(); cacheServices(); loadClients(); }  /* ---------- Navegación ---------- */ $$('.sidebar .nav-btn[data-target]').forEach((btn) => btn.addEventListener('click', () => {
  $$('.sidebar .nav-btn[data-target]').forEach((b) => b.classList.toggle('on', b === btn)); const target = btn.dataset.target; $$
('.main-content .tab-section').forEach((sec) => (sec.hidden = sec.id !== `sec-${target}`));
  if (target === 'inicio') loadDashboard();
  if (target === 'tareas') loadTasks();
  if (target === 'presupuestos') cacheServices();
  if (target === 'clientes') loadClients();
  if (target === 'services') loadServicesTable();
  if (target === 'historial') loadHistory();
}));

/* ---------- Sesión ---------- */
let appShown = false;
db.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') { appShown = false; return show('recovery'); }
  if (!session) { appShown = false; services = []; lines = []; clients = []; active = null; tasks = []; $('#dash').innerHTML = ''; $('#bell-count').hidden = true; company = { ...company, company_name: '', phone: '', email: '', terms: '', company_nif: '', company_address: '' }; return show('login'); }
  if (!appShown) {
    appShown = true;
    show('app');
    setTimeout(boot, 0);
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
  boot();
});
$('#b-logout').addEventListener('click', () => db.auth.signOut());

/* ---------- Selección múltiple y borrado masivo ---------- */
function wireBulk({ table, rowsSel, chk, btnSel, allSel, label, reload }) {
  const refresh = () => { $(btnSel).hidden = !$$(`.${chk}:checked`).length; };
  $(rowsSel).addEventListener('change', (e) => { if (e.target.classList.contains(chk)) refresh(); });
  $(allSel).addEventListener('change', (e) => {$$(`.${chk}`).forEach((c) => (c.checked = e.target.checked)); refresh(); });
  $(btnSel).addEventListener('click', async () => { const ids = $$(`.${chk}:checked`).map((c) => c.value);
    if (!ids.length || !confirm(`¿Eliminar ${ids.length} ${label} seleccionados?`)) return;
    const { error } = await db.from(table).delete().in('id', ids);
    if (error) return toast(delMsg(error), true);
    $(allSel).checked = false;
    toast('Eliminados correctamente');
    await reload();
  });
  return refresh;
}

/* ---------- Catálogo de servicios con filtro instantáneo ---------- */
let refreshServicesBulk = () => {};
async function loadServicesTable() {
  const { data, error } = await db.from('services').select('*').order('category').order('name');
  if (error) return toast(error.message, true);
  
  const searchQ = ($('#search-services')?.value || '').toLowerCase().trim();
  const filtered = searchQ
    ? data.filter((s) => (s.name || '').toLowerCase().includes(searchQ) || (s.category || '').toLowerCase().includes(searchQ) || (s.description || '').toLowerCase().includes(searchQ))
    : data;

  $('#empty-services').hidden = filtered.length > 0;
  $('#rows-services').innerHTML = filtered.map((s) => `<tr>
    <td><input type="checkbox" class="service-row-select" value="${esc(s.id)}" aria-label="Seleccionar servicio"></td>
    <td>${esc(s.category || 'General')}</td>
    <td><strong>${esc(s.name)}</strong>${s.description ? `<br><small class="muted">${esc(s.description)}</small>` : ''}</td>
    <td>${esc(s.unit)}</td><td>${s.price === null ? 'A medida' : priceLabel({ unit: s.unit, unit_price: s.price })}</td>
    <td><button class="btn ghost" type="button" data-edit="${esc(s.id)}" style="padding:4px 8px;font-size:11px;margin-right:4px">Editar</button>
        <button class="btn ghost red" type="button" data-del="${esc(s.id)}" style="padding:4px 8px;font-size:11px">Eliminar</button></td></tr>`).join('');
  refreshServicesBulk();
}

let serviceSearchTimer;
$('#search-services')?.addEventListener('input', () => {
  clearTimeout(serviceSearchTimer);
  serviceSearchTimer = setTimeout(loadServicesTable, 200);
});

refreshServicesBulk = wireBulk({ table: 'services', rowsSel: '#rows-services', chk: 'service-row-select', btnSel: '#b-delete-selected-services', allSel: '#select-all-services', label: 'servicios', reload: async () => { await loadServicesTable(); cacheServices(); } });
$('#rows-services').addEventListener('click', async (e) => {
  const ed = e.target.closest('[data-edit]');
  if (ed) { const { data } = await db.from('services').select('*').eq('id', ed.dataset.edit).single(); if (data) openServiceModal(data); return; }
  const dl = e.target.closest('[data-del]');
  if (dl && confirm('¿Estás seguro de eliminar este servicio?')) {
    const { error } = await db.from('services').delete().eq('id', dl.dataset.del);
    if (error) return toast(delMsg(error), true);
    toast('Servicio eliminado');
    loadServicesTable(); cacheServices();
  }
});
$('#b-new-service').addEventListener('click', () => openServiceModal(null));
$('#d-service-cancel').addEventListener('click', () => $('#dlg-service').close());
function openServiceModal(s) {
  const f = $('#f-service-modal');
  f.reset();
  f.dataset.id = s ? s.id : '';
  $('#d-service-title').textContent = s ? 'Editar Servicio' : 'Nuevo Servicio';
  if (s) for (const k of ['category', 'name', 'unit', 'price', 'description']) f.elements[k].value = s[k] ?? '';
  $('#d-service-err').hidden = true;
  $('#dlg-service').showModal();
}
$('#f-service-modal').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const price = parseFloat(f.elements.price.value);
  if (!isFinite(price) || price < 0) { $('#d-service-err').textContent = 'El precio debe ser un número igual o mayor que 0.'; $('#d-service-err').hidden = false; return; }
  const v = { category: f.elements.category.value.trim(), name: f.elements.name.value.trim(), unit: f.elements.unit.value, price, description: f.elements.description.value.trim() || null };
  const id = f.dataset.id;
  const { error } = id ? await db.from('services').update(v).eq('id', id) : await db.from('services').insert(v);
  if (error) { $('#d-service-err').textContent = error.message; $('#d-service-err').hidden = false; return; }
  $('#dlg-service').close();
  toast(id ? 'Servicio actualizado' : 'Servicio creado');
  loadServicesTable(); cacheServices();
});

/* ---------- Clientes ---------- */
let clients = [];
let refreshClientsBulk = () => {};
async function loadClients() {
  const q = $('#search').value.trim();
  const { data, error } = q
    ? await db.rpc('search_clients', { q })
    : await db.from('clients').select('*').order('created_at', { ascending: false }).limit(30);
  if (error) return toast(error.message, true);
  clients = data;
  $('#empty').hidden = clients.length > 0;
  $('#empty').textContent = q ? 'Ningún cliente coincide con la búsqueda.' : 'Aún no hay clientes. Crea el primero con «Nuevo cliente».';
  $('#rows').innerHTML = clients.map((c) => `<tr data-id="${esc(c.id)}" tabindex="0">
    <td><input type="checkbox" class="row-select" value="${esc(c.id)}" aria-label="Seleccionar cliente"></td>
    <td>${code(c.code_num)}</td><td>${esc(c.name)}</td><td>${esc(c.phone)}</td><td>${esc(c.locality)}</td><td>${esc(KINDS[c.kind] || c.kind)}</td></tr>`).join('');
  refreshClientsBulk();
}
refreshClientsBulk = wireBulk({ table: 'clients', rowsSel: '#rows', chk: 'row-select', btnSel: '#b-delete-selected', allSel: '#select-all', label: 'clientes', reload: loadClients });
let searchTimer;
$('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadClients, 250); });
const openFromRow = (e) => {
  if (e.target.type === 'checkbox') return;
  const tr = e.target.closest('tr[data-id]');
  if (tr) openForm(clients.find((c) => c.id === tr.dataset.id));
};
$('#rows').addEventListener('click', openFromRow);
$('#rows').addEventListener('keydown', (e) => { if (e.key === 'Enter') openFromRow(e); });
$('#b-new').addEventListener('click', () => openForm(null));
$('#d-cancel').addEventListener('click', () => $('#dlg').close());

function openForm(c) {
  const f = $('#f-client');
  f.reset();
  f.dataset.id = c ? c.id : '';
  $('#d-title').textContent = c ? `${code(c.code_num)} · Editar cliente` : 'Nuevo cliente';
  for (const k of ['name', 'phone', 'email', 'locality', 'address', 'nif', 'kind', 'notes']) f.elements[k].value = c?.[k] ?? (k === 'kind' ? 'particular' : '');
  $('#d-err').hidden = true;
  $('#d-delete').hidden = !c;
  $('#dlg').showModal(); $$('#dlg .validate-field').forEach((el) => el.dispatchEvent(new Event('input', { bubbles: true })));
}
async function findDuplicates(v) {
  const found = new Map();
  for (const q of [last9(v.phone), v.email].filter(Boolean)) {
    const { data } = await db.rpc('search_clients', { q });
    (data || []).forEach((c) => found.set(c.id, c));
  }
  return [...found.values()].filter((c) => last9(c.phone) === last9(v.phone) || (v.email && (c.email || '').toLowerCase() === v.email.toLowerCase()));
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
  } finally { btn.disabled = false; }
});
$('#d-delete').addEventListener('click', async () => {
  const id = $('#f-client').dataset.id;
  if (!id || !confirm('¿Estás seguro de que deseas eliminar este cliente? Esta acción no se puede deshacer.')) return;
  const btn = $('#d-delete');
  btn.disabled = true;
  try {
    const { error } = await db.from('clients').delete().eq('id', id);
    if (error) { $('#d-err').textContent = delMsg(error); $('#d-err').hidden = false; return; }
    $('#dlg').close();
    toast('Cliente eliminado correctamente');
    loadClients();
  } finally { btn.disabled = false; }
});
