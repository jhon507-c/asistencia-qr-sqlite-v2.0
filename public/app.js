// --- Auth guard unificado ---
async function me(){
  const res = await fetch('/api/auth/me', { credentials:'include' });
  if(!res.ok){ location.href = '/login'; throw new Error('401'); }
  return await res.json(); // { id, username, role, can_delete }
}
let currentUser = null;

// --- Navegación ---
const navButtons = document.querySelectorAll('nav button[data-section]');
const sections = document.querySelectorAll('.section');
navButtons.forEach(btn=>{
  btn.addEventListener('click', ()=>{
    navButtons.forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    sections.forEach(s=>s.classList.remove('visible'));
    document.getElementById('section-' + btn.dataset.section).classList.add('visible');
    if(btn.dataset.section === 'dashboard'){ loadDashboard(); renderCharts(); }
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

// --- Header + evento + permisos ---
async function refreshHeader(){
  const ev = await api('/api/events/active');
  document.getElementById('active-event-name').textContent = ev?.nombre || 'Sin evento';
  // usuario
  currentUser = await me();
  if(currentUser.role==='superadmin') document.getElementById('tab-usuarios').style.display='inline-block';
}

// --- Dashboard / Charts ---
let chartAlumnos, chartAsistencia;
async function loadDashboard(){
  const s = await api('/api/attendance/stats');
  document.getElementById('m-total-estudiantes').textContent = s.totalEstudiantes;
  document.getElementById('m-total-marcados').textContent = s.totalMarcados;
  document.getElementById('m-presentes').textContent = s.presentes;
  document.getElementById('m-salidas').textContent = s.salidas;

  const list = await api('/api/attendance/list?status=current');
  const tbody = document.getElementById('tabla-presentes');
  tbody.innerHTML = '';
  for(const r of list){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.nombre||''}</td><td>${r.cedula||''}</td><td>${r.grupo||''}</td><td>${fmtDate(r.ingreso_at)}</td>`;
    tbody.appendChild(tr);
  }
}
async function renderCharts(){
  const byGroup = await api('/api/stats/students-by-group').catch(()=>[]);
  if(byGroup.length){
    const labels1 = byGroup.map(x=>x.grupo); const data1 = byGroup.map(x=>x.total);
    const ctx1 = document.getElementById('chart-alumnos').getContext('2d');
    if(chartAlumnos) chartAlumnos.destroy();
    chartAlumnos = new Chart(ctx1, { type:'bar', data:{ labels: labels1, datasets:[{ label:'Total', data:data1, backgroundColor:'#16a34a' }] }, options:{ responsive:true, maintainAspectRatio:false } });
  }
  const aByGroup = await api('/api/stats/attendance-by-group').catch(()=>[]);
  if(aByGroup.length){
    const labels2 = aByGroup.map(x=>x.grupo);
    const presentes = aByGroup.map(x=>x.presentes); const ausentes = aByGroup.map(x=>x.ausentes);
    const ctx2 = document.getElementById('chart-asistencia').getContext('2d');
    if(chartAsistencia) chartAsistencia.destroy();
    chartAsistencia = new Chart(ctx2, { type:'bar', data:{ labels:labels2, datasets:[{label:'Presentes', data:presentes, backgroundColor:'#16a34a'},{label:'Ausentes', data:ausentes, backgroundColor:'#6b9080'}] }, options:{ responsive:true, maintainAspectRatio:false, scales:{ x:{ stacked:true }, y:{ stacked:true } } } });
  }
}

// --- Estudiantes (resumen para gráficos) ---
document.getElementById('btn-buscar-estudiantes')?.addEventListener('click', loadEstudiantes);
const tablaEstudiantes = document.getElementById('tabla-estudiantes');
async function loadEstudiantes(){
  const q = document.getElementById('buscar-estudiantes').value.trim();
  const url = q? `/api/students?search=${encodeURIComponent(q)}` : '/api/students';
  const rows = await api(url);
  tablaEstudiantes.innerHTML='';
  for(const st of rows){
    const tr=document.createElement('tr');
    tr.innerHTML = `<td><input type="checkbox" data-chk="${st.id}"></td><td>${st.nombre||''}</td><td>${st.grupo||''}</td><td>${st.cedula||''}</td>
      <td><button class="action-btn" data-edit="${st.id}">Editar</button>
      <button class="action-btn danger" data-del="${st.id}">Eliminar</button></td>`;
    tablaEstudiantes.appendChild(tr);
  }
}

tablaEstudiantes?.addEventListener('click', async (e)=>{
  const idDel = e.target.getAttribute('data-del');
  if(idDel){ if(confirm('¿Eliminar estudiante?')){ try{ await api(`/api/students/${idDel}`, { method:'DELETE' }); loadEstudiantes(); }catch(err){ alert(err.message); } } }
});

// --- Usuarios (solo superadmin) ---
const tablaUsuarios = document.getElementById('tabla-usuarios');
async function loadUsuarios(){ if(currentUser.role!=='superadmin') return; const rows = await api('/api/users'); tablaUsuarios.innerHTML=''; for(const u of rows){ const tr=document.createElement('tr'); tr.innerHTML = `<td>${u.username}</td><td>${u.role}</td><td>${u.can_delete? '✅':''}</td><td><button class="action-btn" data-uedit="${u.id}">Editar</button> ${u.username!=='root'?`<button class="action-btn danger" data-udel="${u.id}">Eliminar</button>`:''}</td>`; tablaUsuarios.appendChild(tr);} }

tablaUsuarios?.addEventListener('click', async (e)=>{ const idD=e.target.getAttribute('data-udel'); if(idD){ if(confirm('¿Eliminar usuario?')){ await api('/api/users/'+idD,{ method:'DELETE' }); loadUsuarios(); } } });

// --- Init ---
(async function init(){ try{ await refreshHeader(); await loadDashboard(); await renderCharts(); await loadEstudiantes(); }catch(e){ /* redirige a /login si 401 */ } })();
