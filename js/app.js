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
  facturado: 'background:#e2e3e5;color:#383d41', caducado: 'background:#e2e3e5;color:#383d41',
};
const fmt = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
const eur = (n) => fmt.format(n);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const priceLabel = (l) => (l.unit === '%' ? `${Number(l.unit_price)} %` : eur(l.unit_price));
const delMsg = (e) => (e.code === '23503' ? 'No se puede eliminar: tiene presupuestos asociados. Se conservan en el historial.' : e.message);

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
/* Número para wa.me: respeta prefijos internacionales y añade 34 a los de 9 cifras */
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
  (document.querySelector('dialog[open]') || document.body).appendChild(t); // visible también sobre los diálogos
  t.textContent = msg;
  t.className = isErr ? 'err' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

/* ---------- Datos de empresa (tabla settings) ---------- */
let company = { company_name: '', phone: '', email: '', iva_pct: 21, valid_days: 30, terms: '' };
async function loadCompany() {
  const { data } = await db.from('settings').select('*').maybeSingle();
  if (data) company = { ...company, ...data };
  renderPreview();
}
document.body.insertAdjacentHTML('beforeend', `
<dialog id="dlg-company"><form id="f-company"><h2>Datos de empresa</h2>
  <div class="grid">
    <label class="full">Nombre comercial / razón social<input name="company_name" maxlength="120"></label>
    <label>Teléfono<input name="phone" maxlength="25"></label>
    <label>Correo<input name="email" type="email" maxlength="120"></label>
    <label>IVA (%)<input name="iva_pct" type="number" step="0.01" min="0" max="100" required></label>
    <label>Validez del presupuesto (días)<input name="valid_days" type="number" step="1" min="1" max="365" required></label>
    <label class="full">Condiciones (pie del presupuesto)<textarea name="terms" rows="3" maxlength="600"></textarea></label>
  </div>
  <p id="d-company-err" class="error" hidden></p>
  <div class="actions"><button id="d-company-cancel" class="btn ghost" type="button">Cancelar</button><button class="btn" type="submit">Guardar</button></div>
</form></dialog>`);
$('.sidebar-section').insertAdjacentHTML('beforeend', '<button class="nav-btn" id="b-company" type="button">Datos de empresa</button>');
$('#b-company').addEventListener('click', () => {
  const f = $('#f-company');
  for (const k of ['company_name', 'phone', 'email', 'iva_pct', 'valid_days', 'terms']) f.elements[k].value = company[k] ?? '';
  $('#d-company-err').hidden = true;
  $('#dlg-company').showModal();
});
$('#d-company-cancel').addEventListener('click', () => $('#dlg-company').close());
$('#f-company').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const v = {
    company_name: f.elements.company_name.value.trim() || null, phone: f.elements.phone.value.trim() || null,
    email: f.elements.email.value.trim() || null, terms: f.elements.terms.value.trim() || null,
    iva_pct: parseFloat(f.elements.iva_pct.value), valid_days: parseInt(f.elements.valid_days.value, 10),
  };
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

/* ---------- Presupuesto en curso ---------- */
let lines = [];
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
  if (b) { lines.splice(+b.dataset.rm, 1); renderPreview(); }
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
}

$('#chk-toggle-extra').addEventListener('change', (e) => {
  $('#extra-fields-container').style.display = e.target.checked ? 'block' : 'none';
  if (!e.target.checked) { $('#pres_extra_concept').value = ''; $('#pres_extra_price').value = ''; }
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
});

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
});
$('#b-reset-presupuesto').addEventListener('click', () => { resetQuoteForm(); toast('Formulario y presupuesto restablecidos'); });

/* Búsqueda de cliente por teléfono */
let phoneTimer;
const suggestions = new Map();
const hideSug = () => ($('#phone-suggestions').style.display = 'none');
$('#pres_phone').addEventListener('input', (e) => {
  clearTimeout(phoneTimer);
  clearClient();            // al cambiar el teléfono se descarta el cliente elegido antes
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
  lockClientFields(true);   // los datos de una ficha existente se editan en Clientes
  hideSug();
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
      await db.from('quotes').delete().eq('id', q.id); // no se deja un presupuesto sin líneas
      return toast('No se pudieron guardar las líneas: ' + lErr.message, true);
    }
    resetQuoteForm();
    toast(`Presupuesto ${quoteCode(q.quote_no)} generado`);
    openQuotePreview(q.id);
  } finally {
    btn.disabled = false;
  }
});

/* ---------- Historial ---------- */
async function loadHistory() {
  const q = $('#search-history').value.trim();
  let query = db.from('quotes').select('*, clients(name, phone, email, locality)').order('created_at', { ascending: false }).limit(100);
  const st = $('#filter-history-status').value;
  if (st !== 'todos') query = query.eq('status', st);
  let data = [];
  if (q) {
    const m = q.match(/^(?:p-?)?0*(\d{1,6})$/i); // «P-0012» o «12» buscan por número
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
  $('#rows-history').innerHTML = data.map((x) => `<tr>
    <td><strong>${quoteCode(x.quote_no)}</strong></td><td>${new Date(x.created_at).toLocaleDateString('es-ES')}</td>
    <td><a href="#" class="link" data-client="${esc(x.client_id)}" title="Abrir ficha del cliente"><strong>${esc(x.clients?.name || 'Cliente')}</strong></a></td>
    <td><span style="padding:3px 8px;border-radius:4px;font-size:11px;font-weight:600;${STATUS_STYLE[x.status] || ''}">${esc(x.status.toUpperCase())}</span></td>
    <td><strong>${eur(x.total)}</strong></td>
    <td><button class="btn ghost" type="button" data-open="${esc(x.id)}" style="padding:4px 10px;font-size:12px">Ver / Enviar PDF</button></td></tr>`).join('');
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
  const contact = [company.phone && 'Tel: ' + company.phone, company.email].filter(Boolean).map(esc).join(' · ');
  const line = (a, b, s = '') => `<div style="display:flex;justify-content:space-between;padding:4px 0;${s}"><span>${a}</span><span>${b}</span></div>`;
  return `
  <div style="display:flex;justify-content:space-between;border-bottom:2px solid #164B38;padding-bottom:15px;margin-bottom:20px">
    <div><h1 style="color:#164B38;font-size:22px;margin:0">${esc(company.company_name || 'Presupuesto')}</h1>
      <p style="margin:6px 0 0;font-size:11px;color:#4A6A5A">${contact}</p></div>
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
  active = { id, code: quoteCode(q.quote_no), name: q.clients?.name || 'Cliente', phone: q.clients?.phone || '', email: q.clients?.email || '', total: Number(q.total) };
  $('#preview-modal-title').textContent = `Presupuesto ${active.code}`;
  $('#quote-status-select').value = q.status;
  $('#pdf-printable-area').innerHTML = pdfHtml(q, ls);
  $('#dlg-quote-preview').showModal();
}
async function setStatus(id, status) {
  const patch = { status };
  if (status === 'emitido') patch.sent_at = new Date().toISOString(); // base de las alertas «sin respuesta»
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

/* ---------- Navegación ---------- */
$$('.sidebar .nav-btn[data-target]').forEach((btn) => btn.addEventListener('click', () => {
  $$('.sidebar .nav-btn[data-target]').forEach((b) => b.classList.toggle('on', b === btn));
  const target = btn.dataset.target;
  $$('.main-content .tab-section').forEach((sec) => (sec.hidden = sec.id !== `sec-${target}`));
  if (target === 'presupuestos') cacheServices();
  if (target === 'clientes') loadClients();
  if (target === 'services') loadServicesTable();
  if (target === 'historial') loadHistory();
}));

/* ---------- Sesión ---------- */
let appShown = false;
db.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') { appShown = false; return show('recovery'); }
  if (!session) { appShown = false; services = []; lines = []; clients = []; active = null; company = { ...company, company_name: '', phone: '', email: '', terms: '' }; return show('login'); }
  if (!appShown) {
    appShown = true;
    show('app');
    setTimeout(() => { loadCompany(); cacheServices(); loadClients(); }, 0);
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
  loadCompany(); cacheServices(); loadClients();
});
$('#b-logout').addEventListener('click', () => db.auth.signOut());

/* ---------- Selección múltiple y borrado masivo ---------- */
function wireBulk({ table, rowsSel, chk, btnSel, allSel, label, reload }) {
  const refresh = () => { $(btnSel).hidden = !$$(`.${chk}:checked`).length; };
  $(rowsSel).addEventListener('change', (e) => { if (e.target.classList.contains(chk)) refresh(); });
  $(allSel).addEventListener('change', (e) => { $$(`.${chk}`).forEach((c) => (c.checked = e.target.checked)); refresh(); });
  $(btnSel).addEventListener('click', async () => {
    const ids = $$(`.${chk}:checked`).map((c) => c.value);
    if (!ids.length || !confirm(`¿Eliminar ${ids.length} ${label} seleccionados?`)) return;
    const { error } = await db.from(table).delete().in('id', ids);
    if (error) return toast(delMsg(error), true);
    $(allSel).checked = false;
    toast('Eliminados correctamente');
    await reload();
  });
  return refresh;
}

/* ---------- Catálogo de servicios ---------- */
let refreshServicesBulk = () => {};
async function loadServicesTable() {
  const { data, error } = await db.from('services').select('*').order('category').order('name');
  if (error) return toast(error.message, true);
  $('#empty-services').hidden = data.length > 0;
  $('#rows-services').innerHTML = data.map((s) => `<tr>
    <td><input type="checkbox" class="service-row-select" value="${esc(s.id)}" aria-label="Seleccionar servicio"></td>
    <td>${esc(s.category || 'General')}</td>
    <td><strong>${esc(s.name)}</strong>${s.description ? `<br><small class="muted">${esc(s.description)}</small>` : ''}</td>
    <td>${esc(s.unit)}</td><td>${s.price === null ? 'A medida' : priceLabel({ unit: s.unit, unit_price: s.price })}</td>
    <td><button class="btn ghost" type="button" data-edit="${esc(s.id)}" style="padding:4px 8px;font-size:11px;margin-right:4px">Editar</button>
        <button class="btn ghost red" type="button" data-del="${esc(s.id)}" style="padding:4px 8px;font-size:11px">Eliminar</button></td></tr>`).join('');
  refreshServicesBulk();
}
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
  $('#dlg').showModal();
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
