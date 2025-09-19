// --- Guard de autenticación ---
async function me(){
  try{ const res = await fetch('/api/auth/me', { credentials:'include' }); if(!res.ok) throw new Error('401'); return await res.json(); }catch{ location.href = '/login'; throw new Error('redirect'); }
}
let currentUser = null;

// --- Navegación simple ---
const navButtons = document.querySelectorAll('nav button[data-section]');
const sections = document.querySelectorAll('.section');
navButtons.forEach(btn=>{
  btn.addEventListener('click', ()=>{
    navButtons.forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    sections.forEach(s=>s.classList.remove('visible'));
    document.getElementById('section-' + btn.dataset.section).classList.add('visible');
    if(btn.dataset.section === 'dashboard'){ loadDashboard(); }
    if(btn.dataset.section === 'usuarios'){ loadUsuarios(); }
  });
});

document.getElementById('btn-logout').addEventListener('click', async ()=>{
  await fetch('/api/auth/logout', { method:'POST' });
  location.href = '/login';
});

// --- Utils ---
async function api(path, opts={}){
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, credentials:'include', ...opts });
  if(!res.ok){ let err='Error'; try{ err=(await res.json()).error||err; }catch{} throw new Error(err); }
  return res.json();
}
function setStatus(el, msg, ok=true){ el.classList.remove('ok','err'); el.classList.add(ok?'ok':'err'); el.textContent = msg; }
function fmtDate(str){ try{ return new Date(str).toLocaleString(); }catch{ return str; } }

// --- Header: evento activo + nombre org ---
async function refreshHeader(){
  const ev = await api('/api/events/active');
  document.getElementById('active-event-name').textContent = ev?.nombre || 'Sin evento';
  const settings = await api('/api/settings');
  const org = settings.org_nombre || '';
  if(org){ document.querySelector('header h1').textContent = `Control de Asistencia — ${org}`; }
  // permisos
  currentUser = await me();
  if(currentUser.role==='superadmin'){ document.getElementById('tab-usuarios').style.display='inline-block'; }
}

// --- Dashboard ---
let chartAlumnos, chartAsistencia;
async function loadDashboard(){
  // métricas generales
  const s = await api('/api/attendance/stats');
  document.getElementById('m-total-estudiantes').textContent = s.totalEstudiantes;
  document.getElementById('m-total-marcados').textContent = s.totalMarcados;
  document.getElementById('m-presentes').textContent = s.presentes;
  document.getElementById('m-salidas').textContent = s.salidas;

  // presentes
  const list = await api('/api/attendance/list?status=current');
  const tbody = document.getElementById('tabla-presentes');
  tbody.innerHTML = '';
  for(const r of list){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.nombre||''}</td><td>${r.cedula||''}</td><td>${r.grupo||''}</td><td>${fmtDate(r.ingreso_at)}</td>`;
    tbody.appendChild(tr);
  }

  // llenar select de grupos (filtro)
  const grupos = await api('/api/stats/students-by-group');
  const sel = document.getElementById('filtro-grupo');
  const sel2 = document.getElementById('filtro-estudiantes-grupo');
  const options = [''].concat(grupos.map(g=>g.grupo)).filter((v,i,a)=>a.indexOf(v)===i);
  sel.innerHTML = '<option value="">Todos</option>' + options.filter(x=>x!=='').map(g=>`<option>${g}</option>`).join('');
  sel2.innerHTML = '<option value="">Todos los grupos</option>' + options.filter(x=>x!=='').map(g=>`<option>${g}</option>`).join('');

  await renderCharts();
}

async function renderCharts(){
  const byGroup = await api('/api/stats/students-by-group');
  const from = document.getElementById('rep-from').value; const to = document.getElementById('rep-to').value;
  const aByGroup = await api(`/api/stats/attendance-by-group?${new URLSearchParams({ from: from||'', to: to||'' })}`);

  // Chart alumnos
  const labels1 = byGroup.map(x=>x.grupo); const data1 = byGroup.map(x=>x.total);
  const ctx1 = document.getElementById('chart-alumnos').getContext('2d');
  if(chartAlumnos) chartAlumnos.destroy();
  chartAlumnos = new Chart(ctx1, { type:'bar', data:{ labels: labels1, datasets:[{ label:'Total', data:data1, backgroundColor:'#16a34a' }] }, options:{ responsive:true, maintainAspectRatio:false } });

  // Chart asistencia
  const labels2 = aByGroup.map(x=>x.grupo);
  const presentes = aByGroup.map(x=>x.presentes); const ausentes = aByGroup.map(x=>x.ausentes);
  const ctx2 = document.getElementById('chart-asistencia').getContext('2d');
  if(chartAsistencia) chartAsistencia.destroy();
  chartAsistencia = new Chart(ctx2, { type:'bar', data:{ labels:labels2, datasets:[{label:'Presentes', data:presentes, backgroundColor:'#16a34a'},{label:'Ausentes', data:ausentes, backgroundColor:'#6b9080'}] }, options:{ responsive:true, maintainAspectRatio:false, scales:{ x:{ stacked:true }, y:{ stacked:true } } });
}

document.getElementById('btn-aplicar-filtros').addEventListener('click', ()=>{ renderCharts(); loadReporte(); });

// --- Reportes
const repFrom = document.getElementById('rep-from');
const repTo = document.getElementById('rep-to');
const tablaReporte = document.getElementById('tabla-reporte');

async function loadReporte(){
  const params = new URLSearchParams(); if(repFrom.value) params.set('from', repFrom.value); if(repTo.value) params.set('to', repTo.value);
  const rows = await api('/api/reports/attendance?' + params.toString());
  tablaReporte.innerHTML = '';
  for(const r of rows){ const tr = document.createElement('tr'); tr.innerHTML = `<td>${r.evento_nombre||''}</td><td>${r.nombre||''}</td><td>${r.grupo||''}</td><td>${r.cedula||''}</td><td>${fmtDate(r.ingreso_at)}</td><td>${r.salida_at?fmtDate(r.salida_at):''}</td><td>${r.duracion_min??''}</td>`; tablaReporte.appendChild(tr); }
}

document.getElementById('btn-ver-reporte').addEventListener('click', loadReporte);
document.getElementById('btn-export-csv').addEventListener('click', ()=>{ const p=new URLSearchParams(); if(repFrom.value)p.set('from',repFrom.value); if(repTo.value)p.set('to',repTo.value); window.open('/api/export/attendance.csv?'+p.toString(),'_blank'); });
document.getElementById('btn-export-xlsx').addEventListener('click', ()=>{ const p=new URLSearchParams(); if(repFrom.value)p.set('from',repFrom.value); if(repTo.value)p.set('to',repTo.value); window.open('/api/export/attendance.xlsx?'+p.toString(),'_blank'); });

// --- Ingreso: QR + manual + últimos 10
let ingresoStream, salidaStream, ingresoScanTimer, salidaScanTimer;
async function startCamera(videoEl){ const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); videoEl.srcObject = stream; await videoEl.play(); return stream; }
async function stopCamera(stream, videoEl){ if(stream){ stream.getTracks().forEach(t=>t.stop()); } if(videoEl){ videoEl.srcObject = null; } }
async function scanLoop(videoEl, onCode){ const detector = ('BarcodeDetector' in window) ? new BarcodeDetector({ formats: ['qr_code'] }) : null; if(!detector){ document.getElementById('qr-hint').textContent = 'Tu navegador no soporta BarcodeDetector. Usa ingreso manual o instala Chrome/Edge recientes.'; return null; } const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d'); const tick = async ()=>{ if(videoEl.readyState >= 2){ canvas.width = videoEl.videoWidth; canvas.height = videoEl.videoHeight; ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height); try{ const barcodes = await detector.detect(canvas); if(barcodes && barcodes.length){ onCode(barcodes[0].rawValue); } }catch(e){} } }; return setInterval(tick, 400); }
function parseCedulaFromQR(text){ try{ const u = new URL(text); const c = u.searchParams.get('cedula') || u.searchParams.get('id'); if(c) return c; }catch{} return text; }

const videoIngreso = document.getElementById('video-ingreso');
const statusIngreso = document.getElementById('status-ingreso');
const ulIngresos = document.getElementById('ultimos-ingresos');

document.getElementById('btn-start-ingreso').addEventListener('click', async ()=>{
  try{ ingresoStream = await startCamera(videoIngreso); clearInterval(ingresoScanTimer); ingresoScanTimer = await scanLoop(videoIngreso, async (raw)=>{ const cedula = parseCedulaFromQR(raw); try{ const r = await api('/api/attendance/checkin', { method:'POST', body: JSON.stringify({ cedula }) }); setStatus(statusIngreso, `${r.message}: ${r.student?.nombre||''} (${r.student?.cedula||''})`, true); loadDashboard(); loadRecent('checkin'); }catch(e){ setStatus(statusIngreso, e.message, false); } }); setStatus(statusIngreso, 'Cámara activa. Escanea un QR...', true);}catch(e){ setStatus(statusIngreso, 'No se pudo iniciar la cámara: ' + e.message, false); }
});

document.getElementById('btn-stop-ingreso').addEventListener('click', ()=>{ stopCamera(ingresoStream, videoIngreso); clearInterval(ingresoScanTimer); setStatus(statusIngreso, 'Cámara detenida.', true); });

const cedulaIngreso = document.getElementById('cedula-ingreso');
const nombreIngreso = document.getElementById('nombre-ingreso');
const grupoIngreso = document.getElementById('grupo-ingreso');
const statusIngresoManual = document.getElementById('status-ingreso-manual');

document.getElementById('btn-registrar-ingreso').addEventListener('click', async ()=>{
  const cedula = cedulaIngreso.value.trim(); const nombre = nombreIngreso.value.trim(); const grupo = grupoIngreso.value.trim(); if(!cedula){ setStatus(statusIngresoManual, 'Ingresa una cédula', false); return; }
  try{ const r = await api('/api/attendance/checkin', { method:'POST', body: JSON.stringify({ cedula, nombre: nombre||undefined, grupo: grupo||undefined }) }); setStatus(statusIngresoManual, `${r.message}: ${r.student?.nombre||''} (${r.student?.cedula||''})`, true); cedulaIngreso.value=''; nombreIngreso.value=''; grupoIngreso.value=''; loadDashboard(); loadRecent('checkin'); }catch(e){ setStatus(statusIngresoManual, e.message, false); }
});

// --- Salida + últimos 10 ---
const videoSalida = document.getElementById('video-salida');
const statusSalida = document.getElementById('status-salida');
const ulSalidas = document.getElementById('ultimos-salidas');

document.getElementById('btn-start-salida').addEventListener('click', async ()=>{
  try{ salidaStream = await startCamera(videoSalida); clearInterval(salidaScanTimer); salidaScanTimer = await scanLoop(videoSalida, async (raw)=>{ const cedula = parseCedulaFromQR(raw); try{ const r = await api('/api/attendance/checkout', { method:'POST', body: JSON.stringify({ cedula }) }); setStatus(statusSalida, `${r.message}: ${r.student?.nombre||''} (${r.student?.cedula||''})`, true); loadDashboard(); loadRecent('checkout'); }catch(e){ setStatus(statusSalida, e.message, false); } }); setStatus(statusSalida, 'Cámara activa. Escanea un QR...', true);}catch(e){ setStatus(statusSalida, 'No se pudo iniciar la cámara: ' + e.message, false); }
});

document.getElementById('btn-stop-salida').addEventListener('click', ()=>{ stopCamera(salidaStream, videoSalida); clearInterval(salidaScanTimer); setStatus(statusSalida, 'Cámara detenida.', true); });

const cedulaSalida = document.getElementById('cedula-salida');
const statusSalidaManual = document.getElementById('status-salida-manual');

document.getElementById('btn-registrar-salida').addEventListener('click', async ()=>{
  const cedula = cedulaSalida.value.trim(); if(!cedula){ setStatus(statusSalidaManual, 'Ingresa una cédula', false); return; }
  try{ const r = await api('/api/attendance/checkout', { method:'POST', body: JSON.stringify({ cedula }) }); setStatus(statusSalidaManual, `${r.message}: ${r.student?.nombre||''} (${r.student?.cedula||''})`, true); cedulaSalida.value=''; loadDashboard(); loadRecent('checkout'); }catch(e){ setStatus(statusSalidaManual, e.message, false); }
});

async function loadRecent(type){
  const rows = await api(`/api/attendance/recent?type=${type}&limit=10`);
  const list = (type==='checkout')? ulSalidas : ulIngresos;
  list.innerHTML='';
  for(const r of rows){ const li=document.createElement('li'); li.textContent = `${r.nombre||''} (${r.cedula||''}) — ${type==='checkout'?fmtDate(r.salida_at):fmtDate(r.ingreso_at)}${r.grupo?' — '+r.grupo:''}`; list.appendChild(li); }
}

// --- Editar: Estudiantes ---
const tablaEstudiantes = document.getElementById('tabla-estudiantes');
const buscarEstudiantes = document.getElementById('buscar-estudiantes');
const filtroEstudiantesGrupo = document.getElementById('filtro-estudiantes-grupo');

document.getElementById('btn-buscar-estudiantes').addEventListener('click', loadEstudiantes);

async function loadEstudiantes(){
  const q = buscarEstudiantes.value.trim(); const g = filtroEstudiantesGrupo.value;
  const url = new URLSearchParams(); if(q) url.set('search',q); if(g) url.set('grupo',g);
  const rows = await api('/api/students?'+url.toString());
  tablaEstudiantes.innerHTML = '';
  for(const st of rows){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input type="checkbox" data-chk="${st.id}"></td><td>${st.nombre||''}</td><td>${st.grupo||''}</td><td>${st.cedula||''}</td>
      <td>
        <button class="action-btn" data-edit="${st.id}">Editar</button>
        <button class="action-btn danger" data-del="${st.id}">Eliminar</button>
      </td>`;
    tablaEstudiantes.appendChild(tr);
  }
}

document.getElementById('chk-all').addEventListener('change', (e)=>{
  const chks = document.querySelectorAll('input[type=checkbox][data-chk]');
  chks.forEach(c=> c.checked = e.target.checked);
});

tablaEstudiantes.addEventListener('click', async (e)=>{
  const idEdit = e.target.getAttribute('data-edit');
  const idDel = e.target.getAttribute('data-del');
  if(idEdit){ const st = await api(`/api/students/${idEdit}`); document.getElementById('st-id').value = st.id; document.getElementById('st-nombre').value = st.nombre||''; document.getElementById('st-cedula').value = st.cedula||''; document.getElementById('st-email').value = st.email||''; document.getElementById('st-telefono').value = st.telefono||''; document.getElementById('st-grupo').value = st.grupo||''; }
  if(idDel){ if(confirm('¿Eliminar estudiante?')){ try{ await api(`/api/students/${idDel}`, { method:'DELETE' }); loadEstudiantes(); }catch(e){ alert(e.message); } } }
});

// Guardar estudiante
const btnGuardarStudent = document.getElementById('btn-guardar-student');
btnGuardarStudent.addEventListener('click', async ()=>{
  const id = document.getElementById('st-id').value;
  const payload = { nombre: document.getElementById('st-nombre').value.trim(), cedula: document.getElementById('st-cedula').value.trim(), email: document.getElementById('st-email').value.trim()||undefined, telefono: document.getElementById('st-telefono').value.trim()||undefined, grupo: document.getElementById('st-grupo').value.trim()||undefined };
  try{
    if(id){ await api(`/api/students/${id}`, { method:'PUT', body: JSON.stringify(payload) }); }
    else { await api('/api/students', { method:'POST', body: JSON.stringify(payload) }); }
    // foto
    const file = document.getElementById('st-foto').files[0];
    if(file){ const f = new FormData(); f.append('foto', file); await fetch(`/api/students/${id || 'last'}`, { method:'POST' }); /* ignore */ }
    clearStudentForm(); loadEstudiantes();
  }catch(e){ alert(e.message); }
});

// Subida de foto tras guardar (si hay id)
document.getElementById('st-foto').addEventListener('change', async ()=>{
  const id = document.getElementById('st-id').value; if(!id) return; const file = document.getElementById('st-foto').files[0]; if(!file) return; const form = new FormData(); form.append('foto', file); const res = await fetch(`/api/students/${id}/photo`, { method:'POST', body: form, credentials:'include' }); if(!res.ok){ alert('Error subiendo foto'); }
});

document.getElementById('btn-limpiar-student').addEventListener('click', clearStudentForm);
function clearStudentForm(){ document.getElementById('st-id').value=''; ['st-nombre','st-cedula','st-email','st-telefono','st-grupo','st-foto'].forEach(id=>{ const el=document.getElementById(id); if(el.type==='file') el.value=null; else el.value=''; }); }

// Generar QRs seleccionados
const btnQRSeleccion = document.getElementById('btn-generar-qrs-seleccion');
btnQRSeleccion.addEventListener('click', ()=>{
  const ids = Array.from(document.querySelectorAll('input[type=checkbox][data-chk]:checked')).map(c=> c.getAttribute('data-chk'));
  if(ids.length===0){ alert('Selecciona al menos un estudiante'); return; }
  window.open('/export/qrs?ids=' + ids.join(','), '_blank');
});

document.getElementById('btn-generar-qrs-lista').addEventListener('click', ()=>{
  const ids = Array.from(document.querySelectorAll('#tabla-estudiantes tr')).map(tr=>{ const editBtn = tr.querySelector('button[data-edit]'); return editBtn ? editBtn.getAttribute('data-edit') : null; }).filter(Boolean);
  if(ids.length===0){ alert('No hay estudiantes en la lista'); return; }
  window.open('/export/qrs?ids=' + ids.join(','), '_blank');
});

// Import CSV
const csvFileInput = document.getElementById('csv-file');
document.getElementById('btn-importar-csv').addEventListener('click', async ()=>{
  if(!csvFileInput.files || !csvFileInput.files[0]){ alert('Selecciona un archivo CSV'); return; }
  const form = new FormData(); form.append('file', csvFileInput.files[0]);
  try{ const res = await fetch('/api/import/students', { method:'POST', body: form, credentials:'include' }); if(!res.ok){ const e = await res.json(); throw new Error(e.error||'Error importando'); } const data = await res.json(); alert('Importación completa. Registros procesados: ' + data.total); csvFileInput.value = ''; loadEstudiantes(); }catch(e){ alert(e.message); }
});

document.getElementById('btn-descargar-plantilla').addEventListener('click', ()=>{ const sample = 'cedula,nombre,email,telefono,grupo\n12345678,Juan Pérez,juan@ejemplo.com,555-1234,10-A\n'; const blob = new Blob([sample], { type:'text/csv;charset=utf-8;' }); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='plantilla_estudiantes.csv'; a.click(); URL.revokeObjectURL(url); });

// --- Eventos ---
const tablaEventos = document.getElementById('tabla-eventos');
async function loadEventos(){ const rows = await api('/api/events'); tablaEventos.innerHTML = ''; for(const ev of rows){ const tr=document.createElement('tr'); tr.innerHTML = `<td>${ev.nombre}</td><td>${ev.fecha}</td><td>${ev.activo? '✅':''}</td><td><button class="action-btn" data-activar="${ev.id}">Activar</button></td>`; tablaEventos.appendChild(tr);} }

tablaEventos.addEventListener('click', async (e)=>{ const idAct = e.target.getAttribute('data-activar'); if(idAct){ await api(`/api/events/${idAct}`, { method:'PUT', body: JSON.stringify({ activo: true }) }); await refreshHeader(); await loadEventos(); await loadDashboard(); } });

const evNombre = document.getElementById('ev-nombre');
const evFecha = document.getElementById('ev-fecha');
document.getElementById('btn-crear-evento').addEventListener('click', async ()=>{ const nombre=evNombre.value.trim(); const fecha=evFecha.value||undefined; if(!nombre) return alert('Ingresa un nombre'); await api('/api/events',{ method:'POST', body: JSON.stringify({ nombre, fecha }) }); evNombre.value=''; evFecha.value=''; loadEventos(); });

// --- Usuarios (solo superadmin) ---
const tablaUsuarios = document.getElementById('tabla-usuarios');
async function loadUsuarios(){ if(currentUser.role!=='superadmin') return; const rows = await api('/api/users'); tablaUsuarios.innerHTML=''; for(const u of rows){ const tr=document.createElement('tr'); tr.innerHTML = `<td>${u.username}</td><td>${u.role}</td><td>${u.can_delete? '✅':''}</td><td><button class="action-btn" data-uedit="${u.id}">Editar</button> ${u.username!=='root'?`<button class="action-btn danger" data-udel="${u.id}">Eliminar</button>`:''}</td>`; tablaUsuarios.appendChild(tr);} }

tablaUsuarios.addEventListener('click', async (e)=>{ const idE=e.target.getAttribute('data-uedit'); const idD=e.target.getAttribute('data-udel'); if(idE){ const u=(await api('/api/users')).find(x=>x.id==idE); document.getElementById('usr-id').value=u.id; document.getElementById('usr-username').value=u.username; document.getElementById('usr-role').value=u.role; document.getElementById('usr-can-delete').checked=!!u.can_delete; } if(idD){ if(confirm('¿Eliminar usuario?')){ await api('/api/users/'+idD,{ method:'DELETE' }); loadUsuarios(); } } });

document.getElementById('btn-guardar-usuario').addEventListener('click', async ()=>{ const id=document.getElementById('usr-id').value; const username=document.getElementById('usr-username').value.trim(); const password=document.getElementById('usr-password').value.trim(); const role=document.getElementById('usr-role').value; const can_delete=document.getElementById('usr-can-delete').checked; try{ if(id){ await api('/api/users/'+id,{ method:'PUT', body: JSON.stringify({ password: password||undefined, role, can_delete }) }); } else { if(!username||!password) return alert('Usuario y contraseña requeridos'); await api('/api/users',{ method:'POST', body: JSON.stringify({ username, password, role, can_delete }) }); } document.getElementById('usr-id').value=''; document.getElementById('usr-username').value=''; document.getElementById('usr-password').value=''; document.getElementById('usr-role').value='user'; document.getElementById('usr-can-delete').checked=false; loadUsuarios(); }catch(e){ alert(e.message); }
});

document.getElementById('btn-limpiar-usuario').addEventListener('click', ()=>{ document.getElementById('usr-id').value=''; document.getElementById('usr-username').value=''; document.getElementById('usr-password').value=''; document.getElementById('usr-role').value='user'; document.getElementById('usr-can-delete').checked=false; });

// --- Init ---
(async function init(){ try{ await me(); await refreshHeader(); await loadDashboard(); await loadEstudiantes(); await loadEventos(); loadRecent('checkin'); loadRecent('checkout'); }catch(e){ /* redirect handled in me() */ } })();
