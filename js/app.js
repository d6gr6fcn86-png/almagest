'use strict';
const cfg = window.ALMAGEST_CONFIG;
const db = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const digits = (v) => (v || '').replace(/\D/g, '');
const last9 = (v) => digits(v).slice(-9);
const code = (n) => 'C-' + String(n).padStart(4, '0');
const quoteCode = (n) => 'P-' + String(n).padStart(4, '0');
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

/* ---------- Caché de Servicios y Estado del Presupuesto ---------- */
let servicesListCache = [];
let currentQuoteLines = [];

async function cacheServices() {
  const { data } = await db.from('services').select('*').eq('active', true).order('pos');
  if (data) servicesListCache = data;
}

function renderQuotePreview() {
  const tbody = $('#preview-rows');
  const subtotalEl = $('#preview-subtotal');
  const taxEl = $('#preview-tax');
  const grandTotalEl = $('#preview-grand-total');
  if (!tbody) return;

  if (currentQuoteLines.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted" style="text-align: center; padding: 20px;">Ningún servicio añadido todavía.</td></tr>`;
    subtotalEl.textContent = '0.00 €';
    taxEl.textContent = '0.00 €';
    grandTotalEl.textContent = '0.00 €';
    return;
  }

  let subtotalSum = 0;
  tbody.innerHTML = currentQuoteLines.map((line, idx) => {
    const lineTotal = line.unit_price * line.qty;
    subtotalSum += lineTotal;
    return `
      <tr>
        <td><strong>${esc(line.service_name)}</strong><br><small class="muted">${line.qty} ${esc(line.unit)}</small></td>
        <td>${line.qty}</td>
        <td>${Number(line.unit_price).toFixed(2)} €</td>
        <td><strong>${Number(lineTotal).toFixed(2)} €</strong></td>
        <td><button type="button" class="btn ghost red" style="padding: 2px 6px; font-size: 11px;" onclick="removeQuoteLine(${idx})">×</button></td>
      </tr>
    `;
  }).join('');

  const taxAmount = subtotalSum * 0.21;
  const grandTotal = subtotalSum + taxAmount;

  subtotalEl.textContent = Number(subtotalSum).toFixed(2) + ' €';
  taxEl.textContent = Number(taxAmount).toFixed(2) + ' €';
  grandTotalEl.textContent = Number(grandTotal).toFixed(2) + ' €';
}

window.removeQuoteLine = (idx) => {
  currentQuoteLines.splice(idx, 1);
  renderQuotePreview();
};

/* ---------- Historial de Presupuestos & Modal de Previsualización PDF ---------- */
let activeModalQuoteId = null;
let activeModalClientPhone = '';
let activeModalClientName = '';
let activeModalClientEmail = '';
let activeModalQuoteCode = '';
let activeModalSubtotal = 0;
let activeModalTotal = 0;

async function loadHistory() {
  const searchInput = $('#search-history');
  const qFilter = searchInput ? searchInput.value.trim().toLowerCase() : '';

  const { data, error } = await db.from('quotes').select('*, clients(name, phone, email, locality)').order('created_at', { ascending: false }).limit(50);
  if (error) return toast(error.message, true);

  let filtered = data || [];
  if (qFilter) {
    filtered = filtered.filter(q => {
      const pCode = quoteCode(q.quote_no).toLowerCase();
      const cName = (q.clients?.name || '').toLowerCase();
      return pCode.includes(qFilter) || cName.includes(qFilter);
    });
  }

  const emptyEl = $('#empty-history');
  const rowsEl = $('#rows-history');
  if (!rowsEl) return;

  emptyEl.hidden = filtered.length > 0;
  rowsEl.innerHTML = filtered.map(q => `
    <tr>
      <td><strong>${quoteCode(q.quote_no)}</strong></td>
      <td>${new Date(q.created_at).toLocaleDateString('es-ES')}</td>
      <td>${esc(q.clients?.name || 'Cliente general')}</td>
      <td><span style="padding: 2px 8px; border-radius: 4px; font-size: 11px; background: #e3f1e8; color: var(--primary);">${esc(q.status)}</span></td>
      <td><strong>${Number(q.total).toFixed(2)} €</strong></td>
      <td>
        <button class="btn ghost" type="button" onclick="openQuotePreview('${q.id}')" style="padding: 4px 10px; font-size: 12px;">Ver / Enviar PDF</button>
      </td>
    </tr>
  `).join('');
}

let historySearchTimer;
const searchHistoryEl = $('#search-history');
if (searchHistoryEl) {
  searchHistoryEl.addEventListener('input', () => {
    clearTimeout(historySearchTimer);
    historySearchTimer = setTimeout(loadHistory, 250);
  });
}

window.openQuotePreview = async (quoteId) => {
  const { data: quote, error } = await db.from('quotes').select('*, clients(*)').eq('id', quoteId).single();
  if (error || !quote) return toast('No se pudo cargar el presupuesto', true);

  const { data: lines } = await db.from('quote_lines').select('*').eq('quote_id', quoteId).order('pos');

  activeModalQuoteId = quote.id;
  activeModalClientPhone = quote.clients?.phone || '';
  activeModalClientName = quote.clients?.name || 'Cliente';
  activeModalClientEmail = quote.clients?.email || '';
  activeModalQuoteCode = quoteCode(quote.quote_no);
  
  activeModalSubtotal = parseFloat(quote.subtotal) || 0;
  activeModalTotal = parseFloat(quote.total) || 0;
  const taxAmount = activeModalTotal - activeModalSubtotal;

  $('#preview-modal-title').textContent = `Presupuesto ${activeModalQuoteCode}`;
  $('#quote-status-select').value = quote.status || 'borrador';

  $('#pdf-q-code').textContent = activeModalQuoteCode;
  $('#pdf-q-date').textContent = `Fecha: ${new Date(quote.created_at).toLocaleDateString('es-ES')}`;
  $('#pdf-client-name').textContent = quote.clients?.name || 'Cliente general';
  $('#pdf-client-phone').textContent = `Tel: ${quote.clients?.phone || '-'}`;
  $('#pdf-client-locality').textContent = `Loc: ${quote.clients?.locality || '-'}`;

  const tbody = $('#pdf-lines-tbody');
  tbody.innerHTML = (lines || []).map(l => `
    <tr>
      <td style="padding: 8px; border-bottom: 1px solid #E3ECE6;"><strong>${esc(l.service_name)}</strong></td>
      <td style="padding: 8px; text-align: center; border-bottom: 1px solid #E3ECE6;">${l.qty} ${esc(l.unit)}</td>
      <td style="padding: 8px; text-align: right; border-bottom: 1px solid #E3ECE6;">${Number(l.unit_price).toFixed(2)} €</td>
      <td style="padding: 8px; text-align: right; border-bottom: 1px solid #E3ECE6;"><strong>${Number(l.unit_price * l.qty).toFixed(2)} €</strong></td>
    </tr>
  `).join('');

  $('#pdf-q-subtotal').textContent = Number(activeModalSubtotal).toFixed(2) + ' €';
  $('#pdf-q-tax').textContent = Number(taxAmount).toFixed(2) + ' €';
  $('#pdf-q-total').textContent = Number(activeModalTotal).toFixed(2) + ' €';

  $('#dlg-quote-preview').showModal();
};

/* Cambio dinámico de estado en Supabase */
const quoteStatusSelect = $('#quote-status-select');
if (quoteStatusSelect) {
  quoteStatusSelect.addEventListener('change', async (e) => {
    if (!activeModalQuoteId) return;
    const newStatus = e.target.value;
    const { error } = await db.from('quotes').update({ status: newStatus }).eq('id', activeModalQuoteId);
    if (error) return toast('Error al actualizar el estado', true);
    toast(`Estado actualizado a: ${newStatus}`);
    loadHistory();
  });
}

/* Botón Descargar PDF */
const btnDownloadPdf = $('#b-download-pdf');
if (btnDownloadPdf) {
  btnDownloadPdf.addEventListener('click', () => {
    const element = $('#pdf-printable-area');
    const opt = {
      margin:       10,
      filename:     `Presupuesto_${activeModalQuoteCode}_AlmaGest.pdf`,
      image:        { type: 'jpeg', quality: 0.98 },
      html2canvas:  { scale: 2, useCORS: true },
      jsPDF:        { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };
    html2pdf().from(element).set(opt).save();
    toast('Descargando PDF...');
  });
}

/* Botón Enviar WhatsApp */
const btnSendWhatsapp = $('#b-send-whatsapp');
if (btnSendWhatsapp) {
  btnSendWhatsapp.addEventListener('click', async () => {
    if (!activeModalClientPhone) {
      return toast('El cliente no tiene un teléfono válido registrado.', true);
    }
    const cleanPhone = digits(activeModalClientPhone);
    const mensaje = encodeURIComponent(
      `Hola ${activeModalClientName}, le enviamos el presupuesto ${activeModalQuoteCode} de AlmaGest por un importe total de ${activeModalTotal.toFixed(2)} € (IVA incl.).\n\nAtentamente,\nAlmaGest · Aller, Asturias\nTel: +34 660 867 462`
    );
    window.open(`https://api.whatsapp.com/send?phone=34${cleanPhone}&text=${mensaje}`, '_blank');

    if (activeModalQuoteId) {
      await db.from('quotes').update({ status: 'emitido' }).eq('id', activeModalQuoteId).eq('status', 'borrador');
      $('#quote-status-select').value = 'emitido';
      loadHistory();
    }
    toast('Abriendo WhatsApp...');
  });
}

/* Botón Enviar Correo */
const btnSendEmail = $('#b-send-email');
if (btnSendEmail) {
  btnSendEmail.addEventListener('click', async () => {
    const emailRecipient = activeModalClientEmail ? encodeURIComponent(activeModalClientEmail) : '';
    const subject = encodeURIComponent(`Presupuesto ${activeModalQuoteCode} - AlmaGest`);
    const body = encodeURIComponent(
      `Estimado/a ${activeModalClientName},\n\nLe adjuntamos los detalles del presupuesto ${activeModalQuoteCode} por un importe total de ${activeModalTotal.toFixed(2)} € (IVA incluido).\n\nQuedamos a su entera disposición para cualquier aclaración.\n\nAtentamente,\nAlmaGest · Servicios Profesionales Integrales\nAller, Asturias\nTeléfono: +34 660 867 462\nEmail: danieldominguezdjamel2018@gmail.com`
    );
    
    window.location.href = `mailto:${emailRecipient}?subject=${subject}&body=${body}`;

    if (activeModalQuoteId) {
      await db.from('quotes').update({ status: 'emitido' }).eq('id', activeModalQuoteId).eq('status', 'borrador');
      $('#quote-status-select').value = 'emitido';
      loadHistory();
    }
  });
}

const bClosePreview = $('#b-close-preview');
if (bClosePreview) {
  bClosePreview.addEventListener('click', () => $('#dlg-quote-preview').close());
}

document.addEventListener('DOMContentLoaded', () => {
  cacheServices();

  const navButtons = document.querySelectorAll('.sidebar .nav-btn');
  const sections = document.querySelectorAll('.main-content .tab-section');

  navButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      navButtons.forEach(b => b.classList.remove('on'));
      btn.classList.add('on');

      const target = btn.dataset.target;
      sections.forEach(sec => {
        sec.hidden = sec.id !== `sec-${target}`;
      });

      if (target === 'clientes') loadClients();
      if (target === 'services') loadServicesTable();
      if (target === 'historial') loadHistory();
    });
  });

  const btnRefreshHistory = $('#b-refresh-history');
  if (btnRefreshHistory) {
    btnRefreshHistory.addEventListener('click', loadHistory);
  }

  const chkToggleExtra = $('#chk-toggle-extra');
  const extraContainer = $('#extra-fields-container');
  if (chkToggleExtra && extraContainer) {
    chkToggleExtra.addEventListener('change', (e) => {
      extraContainer.style.display = e.target.checked ? 'block' : 'none';
      if (!e.target.checked) {
        $('#pres_extra_concept').value = '';
        $('#pres_extra_price').value = '';
      }
    });
  }

  const btnAddExtra = $('#b-add-extra');
  if (btnAddExtra) {
    btnAddExtra.addEventListener('click', () => {
      const concept = $('#pres_extra_concept').value.trim();
      const price = parseFloat($('#pres_extra_price').value) || 0;
      if (!concept || price <= 0) {
        return toast('Introduce un concepto y un importe válido para el suplemento.', true);
      }
      currentQuoteLines.push({
        service_name: `Suplemento: ${concept}`,
        unit: 'servicio',
        qty: 1,
        unit_price: price
      });
      renderQuotePreview();
      $('#pres_extra_concept').value = '';
      $('#pres_extra_price').value = '';
      $('#chk-toggle-extra').checked = false;
      extraContainer.style.display = 'none';
      toast('Suplemento añadido al presupuesto');
    });
  }

  const categorySelect = $('#pres_category');
  const subserviceContainer = $('#subservice-container');
  const subserviceSelect = $('#pres_subservice');
  const packageContainer = $('#package-services-container');
  const packageItemsList = $('#package-items-list');

  if (categorySelect && subserviceSelect) {
    categorySelect.addEventListener('change', () => {
      const cat = categorySelect.value;
      subserviceSelect.innerHTML = '<option value="">Selecciona subtipo...</option>';
      packageContainer.style.display = 'none';
      packageItemsList.innerHTML = '';

      if (!cat) {
        subserviceContainer.style.display = 'none';
        return;
      }

      const matchingServices = servicesListCache.filter(s => s.category === cat);
      const subservices = [...new Set(matchingServices.map(s => s.description).filter(Boolean))];

      if (subservices.length > 0) {
        subserviceContainer.style.display = 'grid';
        subserviceSelect.innerHTML += subservices.map(sub => `<option value="${esc(sub)}">${esc(sub)}</option>`).join('');
      } else {
        subserviceContainer.style.display = 'none';
      }
    });

    subserviceSelect.addEventListener('change', () => {
      const cat = categorySelect.value;
      const sub = subserviceSelect.value;
      packageItemsList.innerHTML = '';

      if (!sub) {
        packageContainer.style.display = 'none';
        return;
      }

      const servicesInSub = servicesListCache.filter(s => s.category === cat && s.description === sub);

      if (servicesInSub.length > 0) {
        packageContainer.style.display = 'block';
        packageItemsList.innerHTML = servicesInSub.map(s => {
          const needsQty = s.unit && s.unit !== 'servicio' && s.unit !== 'mes';
          return `
            <div class="pkg-item-row" style="display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 0; border-bottom: 1px solid #eee;">
              <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; margin: 0; cursor: pointer; flex: 1;">
                <input type="checkbox" class="pkg-item-chk" data-name="${esc(s.name)}" data-price="${s.price}" data-unit="${esc(s.unit)}" checked style="width: auto; min-height: auto;">
                <span><strong>${esc(s.name)}</strong> <span class="muted">(${Number(s.price).toFixed(2)} € / ${esc(s.unit)})</span></span>
              </label>
              ${needsQty ? `<div style="display: flex; align-items: center; gap: 4px;"><input type="number" class="pkg-item-qty" min="1" step="1" value="1" style="width: 70px; padding: 4px; font-size: 12px;"><small class="muted">${esc(s.unit)}</small></div>` : '<input type="hidden" class="pkg-item-qty" value="1">'}
            </div>
          `;
        }).join('');
      } else {
        packageContainer.style.display = 'none';
      }
    });
  }

  const btnAddLines = $('#b-add-lines');
  if (btnAddLines) {
    btnAddLines.addEventListener('click', () => {
      const checkedRows = document.querySelectorAll('.pkg-item-row');
      let addedCount = 0;

      checkedRows.forEach((row) => {
        const chk = row.querySelector('.pkg-item-chk');
        if (chk && chk.checked) {
          const qtyInput = row.querySelector('.pkg-item-qty');
          const qty = parseFloat(qtyInput ? qtyInput.value : 1) || 1;
          const unitPrice = parseFloat(chk.dataset.price) || 0;

          currentQuoteLines.push({
            service_name: chk.dataset.name,
            unit: chk.dataset.unit,
            qty: qty,
            unit_price: unitPrice
          });
          addedCount++;
        }
      });

      if (addedCount === 0) {
        return toast('Selecciona al menos un servicio con el check.', true);
      }

      renderQuotePreview();
      toast(`${addedCount} servicio(s) añadido(s) al resumen`);
    });
  }

  const btnResetPresupuesto = $('#b-reset-presupuesto');
  const formPresupuesto = $('#f-presupuesto');
  if (btnResetPresupuesto && formPresupuesto) {
    btnResetPresupuesto.addEventListener('click', () => {
      formPresupuesto.reset();
      $('#pres_client_code').value = '';
      delete $('#pres_client_code').dataset.id;
      currentQuoteLines = [];
      renderQuotePreview();
      if (extraContainer) extraContainer.style.display = 'none';
      if (subserviceContainer) subserviceContainer.style.display = 'none';
      if (packageContainer) packageContainer.style.display = 'none';
      if (packageItemsList) packageItemsList.innerHTML = '';
      $('#pres-result-info').textContent = '';
      toast('Formulario y presupuesto restablecidos');
    });
  }

  const btnSaveQuote = $('#b-save-presupuesto');
  if (btnSaveQuote) {
    btnSaveQuote.addEventListener('click', async () => {
      const phone = $('#pres_phone').value.trim();
      const name = $('#pres_name').value.trim();
      const email = $('#pres_email').value.trim() || null;
      const locality = $('#pres_locality').value.trim() || 'No especificada';
      const notes = $('#pres_notes').value.trim() || null;

      if (digits(phone).length < 9) {
        return toast('El teléfono debe tener al menos 9 dígitos.', true);
      }
      if (!name) {
        return toast('El nombre o razón social es obligatorio.', true);
      }
      if (currentQuoteLines.length === 0) {
        return toast('Debes añadir al menos un servicio o concepto al presupuesto.', true);
      }

      btnSaveQuote.disabled = true;
      try {
        let clientId = $('#pres_client_code').dataset.id;

        if (!clientId) {
          const duplicates = await findDuplicates({ phone, email });
          if (duplicates.length > 0) {
            clientId = duplicates[0].id;
          } else {
            const newClient = { name, phone, email, locality, kind: 'particular', notes: 'Cliente registrado automáticamente.' };
            const { data: createdClient, error: clientErr } = await db.from('clients').insert(newClient).select().single();
            if (clientErr) {
              toast('Error al crear el cliente: ' + clientErr.message, true);
              return;
            }
            clientId = createdClient.id;
          }
        }

        const totalSubtotal = currentQuoteLines.reduce((acc, line) => acc + (line.unit_price * line.qty), 0);
        const totalTax = totalSubtotal * 0.21;
        const grandTotal = totalSubtotal + totalTax;

        let fullNotes = `Presupuesto con ${currentQuoteLines.length} líneas.`;
        if (notes) fullNotes += ` Notas: ${notes}`;

        const newQuote = {
          client_id: clientId,
          status: 'borrador',
          subtotal: totalSubtotal,
          total: grandTotal,
          notes: fullNotes
        };

        const { data: quoteData, error: quoteErr } = await db.from('quotes').insert(newQuote).select().single();
        if (quoteErr) {
          toast('Error al generar el presupuesto: ' + quoteErr.message, true);
          return;
        }

        for (let i = 0; i < currentQuoteLines.length; i++) {
          const line = currentQuoteLines[i];
          await db.from('quote_lines').insert({
            quote_id: quoteData.id,
            service_name: line.service_name,
            unit: line.unit,
            qty: line.qty,
            unit_price: line.unit_price,
            pos: i
          });
        }

        const numeroPresupuesto = quoteCode(quoteData.quote_no);
        $('#pres-result-info').textContent = `¡Generado! ID: ${numeroPresupuesto}`;
        toast(`¡Presupuesto ${numeroPresupuesto} generado con éxito! Abriendo previsualización...`);

        openQuotePreview(quoteData.id);

        formPresupuesto.reset();
        $('#pres_client_code').value = '';
        delete $('#pres_client_code').dataset.id;
        currentQuoteLines = [];
        renderQuotePreview();
        if (extraContainer) extraContainer.style.display = 'none';
        if (subserviceContainer) subserviceContainer.style.display = 'none';
        if (packageContainer) packageContainer.style.display = 'none';
        if (packageItemsList) packageItemsList.innerHTML = '';
      } finally {
        btnSaveQuote.disabled = false;
      }
    });
  }
});

/* ---------- Sesión y Autenticación ---------- */
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

/* ---------- Tabla de Servicios (Catálogo) ---------- */
async function loadServicesTable() {
  const { data, error } = await db.from('services').select('*').order('pos');
  if (error) return toast(error.message, true);

  const emptyEl = $('#empty-services');
  const rowsEl = $('#rows-services');
  if (!rowsEl) return;

  emptyEl.hidden = data.length > 0;
  rowsEl.innerHTML = data.map(s => 
    `<tr data-id="${s.id}" tabindex="0">
       <td onclick="event.stopPropagation()"><input type="checkbox" class="service-row-select" value="${esc(s.id)}" aria-label="Seleccionar servicio"></td>
       <td>${esc(s.category || 'General')}</td>
       <td><strong>${esc(s.name)}</strong></td>
       <td>${esc(s.unit)}</td>
       <td>${s.price !== null ? Number(s.price).toFixed(2) + ' €' : 'A medida'}</td>
       <td onclick="event.stopPropagation()">
         <button class="btn ghost" type="button" onclick="editService('${s.id}')" style="padding: 4px 8px; font-size: 11px; margin-right: 4px;">Editar</button>
         <button class="btn ghost red" type="button" onclick="deleteService('${s.id}')" style="padding: 4px 8px; font-size: 11px;">Eliminar</button>
       </td>
     </tr>`
  ).join('');

  actualizarBotonEliminarServicios();
}

function actualizarBotonEliminarServicios() {
  const sel = document.querySelectorAll('.service-row-select:checked');
  const btn = $('#b-delete-selected-services');
  if (btn) btn.hidden = sel.length === 0;
}

const serviceRowsEl = $('#rows-services');
if (serviceRowsEl) {
  serviceRowsEl.addEventListener('change', (e) => {
    if (e.target.classList.contains('service-row-select')) {
      actualizarBotonEliminarServicios();
    }
  });
}

const selectAllServicesCheckbox = $('#select-all-services');
if (selectAllServicesCheckbox) {
  selectAllServicesCheckbox.addEventListener('change', (e) => {
    document.querySelectorAll('.service-row-select').forEach(chk => chk.checked = e.target.checked);
    actualizarBotonEliminarServicios();
  });
}

const btnDeleteSelectedServices = $('#b-delete-selected-services');
if (btnDeleteSelectedServices) {
  btnDeleteSelectedServices.addEventListener('click', async () => {
    const ids = Array.from(document.querySelectorAll('.service-row-select:checked')).map(chk => chk.value);
    if (ids.length === 0) return;
    if (!confirm(`¿Eliminar los ${ids.length} servicios seleccionados?`)) return;

    btnDeleteSelectedServices.disabled = true;
    try {
      const { error } = await db.from('services').delete().in('id', ids);
      if (error) return toast(error.message, true);
      toast('Servicios eliminados correctamente');
      if (selectAllServicesCheckbox) selectAllServicesCheckbox.checked = false;
      loadServicesTable();
      cacheServices();
    } finally {
      btnDeleteSelectedServices.disabled = false;
    }
  });
}

window.deleteService = async (id) => {
  if (!confirm('¿Estás seguro de eliminar este servicio?')) return;
  const { error } = await db.from('services').delete().eq('id', id);
  if (error) return toast(error.message, true);
  toast('Servicio eliminado');
  loadServicesTable();
  cacheServices();
};

const bNewService = $('#b-new-service');
if (bNewService) {
  bNewService.addEventListener('click', () => openServiceModal(null));
}

const dServiceCancel = $('#d-service-cancel');
if (dServiceCancel) {
  dServiceCancel.addEventListener('click', () => $('#dlg-service').close());
}

function openServiceModal(s) {
  const f = $('#f-service-modal');
  f.reset();
  f.dataset.id = s ? s.id : '';
  $('#d-service-title').textContent = s ? 'Editar Servicio' : 'Nuevo Servicio';
  if (s) {
    f.elements['category'].value = s.category || '';
    f.elements['name'].value = s.name || '';
    f.elements['unit'].value = s.unit || 'servicio';
    f.elements['price'].value = s.price || '';
    f.elements['description'].value = s.description || '';
  }
  $('#d-service-err').hidden = true;
  $('#dlg-service').showModal();
}

window.editService = async (id) => {
  const { data } = await db.from('services').select('*').eq('id', id).single();
  if (data) openServiceModal(data);
};

$('#f-service-modal').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const id = f.dataset.id;
  const v = {
    category: f.elements['category'].value.trim(),
    name: f.elements['name'].value.trim(),
    unit: f.elements['unit'].value,
    price: parseFloat(f.elements['price'].value) || 0,
    description: f.elements['description'].value.trim() || null
  };

  const { error } = id 
    ? await db.from('services').update(v).eq('id', id)
    : await db.from('services').insert(v);

  if (error) {
    $('#d-service-err').textContent = error.message;
    $('#d-service-err').hidden = false;
    return;
  }

  $('#dlg-service').close();
  toast(id ? 'Servicio actualizado' : 'Servicio creado');
  loadServicesTable();
  cacheServices();
});

/* ---------- Búsqueda Dinámica por Teléfono en Presupuestos ---------- */
let phoneSearchTimer;
const presPhoneInput = $('#pres_phone');
const suggestionsBox = $('#phone-suggestions');

if (presPhoneInput && suggestionsBox) {
  presPhoneInput.addEventListener('input', (e) => {
    clearTimeout(phoneSearchTimer);
    const q = e.target.value.trim();

    if (!q) {
      suggestionsBox.style.display = 'none';
      suggestionsBox.innerHTML = '';
      $('#pres_name').value = '';
      $('#pres_email').value = '';
      $('#pres_locality').value = 'No especificada';
      $('#pres_client_code').value = '';
      delete $('#pres_client_code').dataset.id;
      return;
    }

    if (q.length < 4) {
      suggestionsBox.style.display = 'none';
      return;
    }

    phoneSearchTimer = setTimeout(async () => {
      const { data, error } = await db.rpc('search_clients', { q });
      if (error || !data || data.length === 0) {
        suggestionsBox.style.display = 'none';
        return;
      }

      suggestionsBox.innerHTML = data.map(c => 
        `<div class="suggestion-item" data-id="${c.id}" data-name="${esc(c.name)}" data-phone="${esc(c.phone)}" data-email="${esc(c.email || '')}" data-locality="${esc(c.locality)}" data-code="${code(c.code_num)}" style="padding: 10px; cursor: pointer; border-bottom: 1px solid #eee;">
           <strong>${esc(c.name)}</strong> <span class="muted">(${esc(c.phone)})</span><br>
           <small class="muted">${code(c.code_num)} · ${esc(c.locality)}</small>
         </div>`
      ).join('');
      suggestionsBox.style.display = 'block';
    }, 300);
  });

  suggestionsBox.addEventListener('click', (e) => {
    const item = e.target.closest('.suggestion-item');
    if (!item) return;

    presPhoneInput.value = item.dataset.phone;
    $('#pres_name').value = item.dataset.name;
    $('#pres_email').value = item.dataset.email;
    $('#pres_locality').value = item.dataset.locality;
    $('#pres_client_code').value = item.dataset.code;
    $('#pres_client_code').dataset.id = item.dataset.id;

    suggestionsBox.style.display = 'none';
  });

  document.addEventListener('click', (e) => {
    if (!presPhoneInput.contains(e.target) && !suggestionsBox.contains(e.target)) {
      suggestionsBox.style.display = 'none';
    }
  });
}

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

/* ---------- Eliminar Cliente Individual ---------- */
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
