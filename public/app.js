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
  const search = document.getElementById('buscar-estudiantes').value;
  const students = await api('/api/students?search=' + encodeURIComponent(search));
  tablaEstudiantes.innerHTML = students.map(st => `
    <tr>
      <td><input type="checkbox" data-id="${st.id}" /></td>
      <td>${st.nombre}</td>
      <td>${st.grupo}</td>
      <td>${st.cedula}</td>
      <td>
        <button data-action="qr" data-nombre="${st.nombre}" data-cedula="${st.cedula}" class="secondary small">QR</button>
        <button data-action="edit" data-id="${st.id}" class="secondary small">Editar</button>
        <button data-action="delete" data-id="${st.id}" class="danger small">Borrar</button>
      </td>
    </tr>
  `).join('');
}

tablaEstudiantes?.addEventListener('click', async (e)=>{
  const target = e.target.closest('button');
  if(!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id;
  const idDel = target.dataset.action === 'delete' ? target.dataset.id : null;

  if (action === 'qr') {
    const nombre = target.dataset.nombre;
    const cedula = target.dataset.cedula;
    const modal = document.getElementById('modal-qr');
    document.getElementById('qr-student-name').textContent = nombre;
    document.getElementById('qr-student-cedula').textContent = `Cédula: ${cedula}`;
    const qrCanvas = document.getElementById('qr-canvas');
    new QRious({ element: qrCanvas, value: cedula, size: 250, padding: 20 });
    
    // Lógica para descargar como JPG
    const downloadBtn = document.getElementById('btn-download-qr-jpg');
    downloadBtn.href = qrCanvas.toDataURL('image/jpeg');
    downloadBtn.download = `qr-${nombre.replace(/ /g, '_')}-${cedula}.jpg`;

    modal.style.display = 'flex';
  }

  if(idDel){
    if(!confirm(`¿Seguro que quieres borrar al estudiante con cédula ${idDel}?`)) return;
    try{ await api(`/api/students/${idDel}`, { method:'DELETE' }); loadEstudiantes(); }catch(e){ alert(e.message); }
  }
});

document.getElementById('btn-close-modal-qr')?.addEventListener('click', () => {
  document.getElementById('modal-qr').style.display = 'none';
});

// Lógica para descargar múltiples QR en PDF
document.getElementById('btn-download-qr-pdf')?.addEventListener('click', () => {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const checkboxes = document.querySelectorAll('#tabla-estudiantes input[type="checkbox"]:checked');
  
  if (checkboxes.length === 0) {
    alert('Por favor, selecciona al menos un estudiante para generar el PDF.');
    return;
  }

  let y = 15; // Posición vertical inicial
  const pageHeight = doc.internal.pageSize.height;
  const qrSize = 60;
  const margin = 15;

  checkboxes.forEach((chk, index) => {
    const row = chk.closest('tr');
    const nombre = row.cells[1].textContent;
    const cedula = row.cells[3].textContent;

    if (y + qrSize + 20 > pageHeight) { // Si no cabe, nueva página
      doc.addPage();
      y = 15;
    }

    doc.setFontSize(12);
    doc.text(nombre, margin, y);
    doc.setFontSize(10);
    doc.text(`Cédula: ${cedula}`, margin, y + 5);

    const tempCanvas = document.createElement('canvas');
    new QRious({ element: tempCanvas, value: cedula, size: qrSize });
    const qrDataUrl = tempCanvas.toDataURL('image/png');
    
    doc.addImage(qrDataUrl, 'PNG', margin, y + 10, qrSize, qrSize);
    
    y += qrSize + 25; // Incrementar posición para el siguiente
  });

  doc.save('codigos-qr-estudiantes.pdf');
});

document.getElementById('btn-guardar-estudiante')?.addEventListener('click', async () => {
  const statusEl = document.getElementById('status-estudiante');
  try {
    const formData = new FormData();
    formData.append('nombre', document.getElementById('st-nombre').value);
    formData.append('cedula', document.getElementById('st-cedula').value);
    formData.append('grupo', document.getElementById('st-grupo').value);
    const fotoFile = document.getElementById('st-foto').files[0];
    if (fotoFile) {
      formData.append('foto', fotoFile);
    }

    const res = await fetch('/api/students', { method: 'POST', body: formData, credentials: 'include' });
    const result = await res.json();

    if (!res.ok) throw new Error(result.error || 'Error al guardar');

    setStatus(statusEl, 'Estudiante guardado con éxito', true);
    document.getElementById('st-nombre').value = '';
    document.getElementById('st-cedula').value = '';
    document.getElementById('st-grupo').value = '';
    document.getElementById('st-foto').value = '';
    loadEstudiantes(); // Recargar la lista
  } catch (e) {
    setStatus(statusEl, e.message, false);
  }
});


// --- Usuarios (solo superadmin) ---
const tablaUsuarios = document.getElementById('tabla-usuarios');
async function loadUsuarios(){ if(currentUser.role!=='superadmin') return; const rows = await api('/api/users'); tablaUsuarios.innerHTML=''; for(const u of rows){ const tr=document.createElement('tr'); tr.innerHTML = `<td>${u.username}</td><td>${u.role}</td><td>${u.can_delete? '✅':''}</td><td><button class="action-btn" data-uedit="${u.id}">Editar</button> ${u.username!=='root'?`<button class="action-btn danger" data-udel="${u.id}">Eliminar</button>`:''}</td>`; tablaUsuarios.appendChild(tr);} }

tablaUsuarios?.addEventListener('click', async (e)=>{ const idD=e.target.getAttribute('data-udel'); if(idD){ if(confirm('¿Eliminar usuario?')){ await api('/api/users/'+idD,{ method:'DELETE' }); loadUsuarios(); } } });

// --- Init ---
(async function init(){ try{ await refreshHeader(); await loadDashboard(); await renderCharts(); }catch(e){ console.error(e); } })();


// --- Lógica de escaneo QR ---
function setupScanner(videoId, startBtnId, stopBtnId, statusElId, listElId, endpoint) {
  const video = document.getElementById(videoId);
  const statusEl = document.getElementById(statusElId);
  const listEl = document.getElementById(listElId);
  let stream;
  let lastScanTime = 0;

  document.getElementById(startBtnId).addEventListener('click', async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = stream;
      video.style.display = 'block';
      video.play();
      requestAnimationFrame(tick);
    } catch (err) {
      statusEl.textContent = 'Error al acceder a la cámara: ' + err.message;
      console.error(err);
    }
  });

  document.getElementById(stopBtnId).addEventListener('click', () => {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      video.style.display = 'none';
      video.srcObject = null;
    }
  });

  async function handleCode(code) {
    try {
      const res = await api(endpoint, { method: 'POST', body: JSON.stringify({ cedula: code }) });
      setStatus(statusEl, `${res.nombre} - ${res.message}`, true);
      const li = document.createElement('li');
      li.textContent = `${res.nombre} (${res.cedula}) - ${fmtDate(new Date())}`;
      if (listEl.firstChild) {
        listEl.insertBefore(li, listEl.firstChild);
      } else {
        listEl.appendChild(li);
      }
      if (listEl.children.length > 10) {
        listEl.removeChild(listEl.lastChild);
      }
    } catch (e) {
      setStatus(statusEl, e.message, false);
    }
  }

  function tick() {
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });

      const now = Date.now();
      if (code && (now - lastScanTime > 3000)) { // Prevenir escaneos múltiples del mismo QR
        lastScanTime = now;
        handleCode(code.data);
      }
    }
    if (video.srcObject) {
      requestAnimationFrame(tick);
    }
  }
}

setupScanner('video-ingreso', 'btn-start-ingreso', 'btn-stop-ingreso', 'status-ingreso', 'ultimos-ingresos', '/api/attendance/ingreso');
setupScanner('video-salida', 'btn-start-salida', 'btn-stop-salida', 'status-salida', 'ultimos-salidas', '/api/attendance/salida');
