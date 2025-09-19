import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import ExcelJS from 'exceljs';
import QRCode from 'qrcode';
import { parse as csvParse } from 'csv-parse/sync';
import { db, initDb, getActiveEventId, ensureActiveEvent } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(morgan('dev'));

// Static
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer (memoria para CSV; disco para fotos)
const uploadMemory = multer({ storage: multer.memoryStorage() });
const uploadDisk = multer({ storage: multer.diskStorage({
  destination: (req, file, cb)=> cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb)=>{
    const ext = (file.originalname||'').split('.').pop();
    const name = Date.now() + '-' + Math.random().toString(36).slice(2) + (ext?'.'+ext:'');
    cb(null, name);
  }
})});

// Inicializa DB
initDb();

// Asegurar hash de root en tiempo de ejecución usando bcryptjs
import bcrypt from 'bcryptjs';
const root = db.prepare('SELECT * FROM users WHERE username=?').get('root');
if(root && root.password_hash === 'PLACEHOLDER_HASH_TO_BE_SET_AT_RUNTIME'){
  const hash = bcrypt.hashSync('@dM!n!25', 10);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, root.id);
}

// Utils
function nowISO(){ return new Date().toISOString(); }
function sign(user){ return jwt.sign({ id: user.id, role: user.role, can_delete: !!user.can_delete, username: user.username }, JWT_SECRET, { expiresIn: '12h' }); }
function authRequired(req, res, next){
  const token = req.cookies.token;
  if(!token) return res.status(401).json({ error: 'No autenticado' });
  try{ const payload = jwt.verify(token, JWT_SECRET); req.user = payload; next(); }
  catch{ return res.status(401).json({ error: 'Token inválido' }); }
}
function requireSuper(req,res,next){ if(req.user?.role==='superadmin') return next(); return res.status(403).json({ error: 'Solo superadmin' }); }
function requireCanDelete(req,res,next){ if(req.user?.role==='superadmin' || req.user?.can_delete) return next(); return res.status(403).json({ error: 'Sin permisos para borrar' }); }

// ---- Auth ----
app.post('/api/auth/login', async (req,res)=>{
  const { username, password } = req.body || {};
  if(!username || !password) return res.status(400).json({ error:'Usuario y contraseña requeridos' });
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username));
  if(!u) return res.status(401).json({ error:'Credenciales inválidas' });
  const ok = bcrypt.compareSync(String(password), u.password_hash);
  if(!ok) return res.status(401).json({ error:'Credenciales inválidas' });
  const token = sign(u);
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', secure: !!process.env.COOLIFY_URL });
  res.json({ ok:true, user: { id: u.id, username: u.username, role: u.role, can_delete: !!u.can_delete } });
});

app.get('/api/auth/me', (req,res)=>{
  const token = req.cookies.token; if(!token) return res.status(401).json({ error:'No autenticado' });
  try{
    const p = jwt.verify(token, JWT_SECRET);
    res.json({ id: p.id, username: p.username, role: p.role, can_delete: !!p.can_delete });
  }catch{ return res.status(401).json({ error:'Token inválido' }); }
});

app.post('/api/auth/logout', (req,res)=>{ res.clearCookie('token'); res.json({ ok:true }); });

// ---- Usuarios (solo superadmin) ----
app.get('/api/users', authRequired, requireSuper, (req,res)=>{
  const rows = db.prepare('SELECT id, username, role, can_delete, created_at FROM users ORDER BY username ASC').all();
  res.json(rows);
});
app.post('/api/users', authRequired, requireSuper, (req,res)=>{
  const { username, password, role='user', can_delete=false } = req.body||{};
  if(!username || !password) return res.status(400).json({ error:'username y password requeridos' });
  const hash = bcrypt.hashSync(String(password),10);
  try{
    const info = db.prepare('INSERT INTO users(username,password_hash,role,can_delete,created_at) VALUES(?,?,?,?,?)').run(String(username), hash, String(role), can_delete?1:0, nowISO());
    res.json({ ok:true, id: info.lastInsertRowid });
  }catch(e){ if(String(e).includes('UNIQUE')) return res.status(409).json({ error:'username ya existe' }); throw e; }
});
app.put('/api/users/:id', authRequired, requireSuper, (req,res)=>{
  const id = Number(req.params.id);
  const { password, role, can_delete } = req.body||{};
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id); if(!u) return res.status(404).json({ error:'No existe' });
  const hash = password? bcrypt.hashSync(String(password),10) : undefined;
  db.prepare('UPDATE users SET password_hash=COALESCE(?,password_hash), role=COALESCE(?,role), can_delete=COALESCE(?,can_delete) WHERE id=?')
    .run(hash, role, (typeof can_delete==='boolean')?(can_delete?1:0):undefined, id);
  res.json({ ok:true });
});
app.delete('/api/users/:id', authRequired, requireSuper, (req,res)=>{
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id); if(!u) return res.status(404).json({ error:'No existe' });
  if(u.username==='root') return res.status(400).json({ error:'No se puede eliminar root' });
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  res.json({ ok:true });
});

// ---- Settings ----
app.get('/api/settings', authRequired, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {}; for(const r of rows) out[r.key] = r.value; res.json(out);
});
app.put('/api/settings', authRequired, (req, res) => {
  const entries = Object.entries(req.body || {});
  const up = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const tx = db.transaction((pairs)=>{ for(const [k,v] of pairs) up.run(k, String(v)); });
  tx(entries);
  res.json({ ok: true });
});

// ---- Eventos ----
app.get('/api/events', authRequired, (req, res) => {
  const rows = db.prepare('SELECT * FROM events ORDER BY fecha DESC, id DESC').all();
  res.json(rows);
});
app.post('/api/events', authRequired, (req, res) => {
  const { nombre, fecha } = req.body;
  if(!nombre) return res.status(400).json({ error: 'nombre es requerido' });
  const info = db.prepare('INSERT INTO events(nombre, fecha, activo) VALUES(?,?,0)')
    .run(nombre, fecha || new Date().toISOString().slice(0,10));
  res.json({ ok: true, id: info.lastInsertRowid });
});
app.put('/api/events/:id', authRequired, (req, res) => {
  const id = Number(req.params.id);
  const { nombre, fecha, activo } = req.body || {};
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(id);
  if(!ev) return res.status(404).json({ error: 'Evento no encontrado' });
  if(nombre || fecha){ db.prepare('UPDATE events SET nombre=COALESCE(?,nombre), fecha=COALESCE(?,fecha) WHERE id=?').run(nombre, fecha, id); }
  if(typeof activo !== 'undefined'){
    const tx = db.transaction((id, activo)=>{ if(activo){ db.prepare('UPDATE events SET activo=0').run(); } db.prepare('UPDATE events SET activo=? WHERE id=?').run(activo?1:0, id); });
    tx(id, activo);
  }
  res.json({ ok: true });
});
app.get('/api/events/active', authRequired, (req, res) => {
  ensureActiveEvent();
  const ev = db.prepare('SELECT * FROM events WHERE activo=1').get();
  res.json(ev);
});

// ---- Estudiantes ----
app.get('/api/students', authRequired, (req, res) => {
  const { search, grupo } = req.query;
  let rows;
  if(search){
    const s = `%${String(search).toLowerCase()}%`;
    if(grupo){
      rows = db.prepare(`SELECT * FROM students WHERE (lower(nombre) LIKE ? OR lower(cedula) LIKE ?) AND grupo=? ORDER BY nombre ASC LIMIT 200`).all(s, s, grupo);
    } else {
      rows = db.prepare(`SELECT * FROM students WHERE lower(nombre) LIKE ? OR lower(cedula) LIKE ? ORDER BY nombre ASC LIMIT 200`).all(s, s);
    }
  } else if(grupo){
    rows = db.prepare('SELECT * FROM students WHERE grupo=? ORDER BY nombre ASC LIMIT 200').all(grupo);
  } else {
    rows = db.prepare('SELECT * FROM students ORDER BY nombre ASC LIMIT 200').all();
  }
  res.json(rows);
});
app.get('/api/students/:id', authRequired, (req, res) => {
  const st = db.prepare('SELECT * FROM students WHERE id=?').get(Number(req.params.id));
  if(!st) return res.status(404).json({ error: 'Estudiante no encontrado' });
  res.json(st);
});
app.post('/api/students', authRequired, (req, res) => {
  let { cedula, nombre, email, telefono, grupo } = req.body || {};
  if(!cedula) return res.status(400).json({ error: 'cedula es requerida' });
  nombre = nombre || 'Sin nombre';
  try{
    const info = db.prepare('INSERT INTO students(cedula, nombre, email, telefono, grupo, created_at) VALUES(?,?,?,?,?,?)')
      .run(String(cedula), String(nombre), email||null, telefono||null, grupo||null, nowISO());
    res.json({ ok: true, id: info.lastInsertRowid });
  }catch(e){ if(String(e).includes('UNIQUE')) return res.status(409).json({ error: 'Cédula ya existe' }); throw e; }
});
app.put('/api/students/:id', authRequired, (req, res) => {
  const id = Number(req.params.id);
  const { cedula, nombre, email, telefono, grupo } = req.body || {};
  const st = db.prepare('SELECT * FROM students WHERE id=?').get(id);
  if(!st) return res.status(404).json({ error: 'Estudiante no encontrado' });
  try{
    db.prepare('UPDATE students SET cedula=COALESCE(?,cedula), nombre=COALESCE(?,nombre), email=COALESCE(?,email), telefono=COALESCE(?,telefono), grupo=COALESCE(?,grupo) WHERE id=?')
      .run(cedula, nombre, email, telefono, grupo, id);
    res.json({ ok: true });
  }catch(e){ if(String(e).includes('UNIQUE')) return res.status(409).json({ error: 'Cédula ya existe' }); throw e; }
});
app.delete('/api/students/:id', authRequired, (req, res) => {
  // Permitir solo superadmin o admin
  if(!(req.user?.role==='superadmin' || req.user?.role==='admin')) return res.status(403).json({ error:'Solo admin o superior' });
  const id = Number(req.params.id);
  db.prepare('DELETE FROM students WHERE id=?').run(id);
  res.json({ ok: true });
});

// Foto de estudiante
app.post('/api/students/:id/photo', authRequired, uploadDisk.single('foto'), (req,res)=>{
  if(!req.file) return res.status(400).json({ error:'Archivo requerido (foto)' });
  const id = Number(req.params.id);
  const st = db.prepare('SELECT * FROM students WHERE id=?').get(id);
  if(!st) return res.status(404).json({ error:'Estudiante no encontrado' });
  const rel = '/uploads/' + req.file.filename;
  db.prepare('UPDATE students SET foto=? WHERE id=?').run(rel, id);
  res.json({ ok:true, foto: rel });
});

// ---- Asistencia ----
app.get('/api/attendance/stats', authRequired, (req, res) => {
  const eventId = Number(req.query.eventId) || getActiveEventId();
  const totalEstudiantes = db.prepare('SELECT COUNT(*) as c FROM students').get().c;
  const totalMarcados = db.prepare('SELECT COUNT(*) as c FROM attendance WHERE event_id=?').get(eventId).c;
  const presentes = db.prepare('SELECT COUNT(*) as c FROM attendance WHERE event_id=? AND salida_at IS NULL').get(eventId).c;
  const salidas = totalMarcados - presentes;
  res.json({ eventId, totalEstudiantes, totalMarcados, presentes, salidas });
});
app.get('/api/attendance/list', authRequired, (req, res) => {
  const eventId = Number(req.query.eventId) || getActiveEventId();
  const { status } = req.query; // 'current' o 'all'
  let rows;
  if(status === 'current'){
    rows = db.prepare(`SELECT a.*, s.nombre, s.cedula, s.grupo FROM attendance a JOIN students s ON s.id=a.student_id WHERE a.event_id=? AND a.salida_at IS NULL ORDER BY a.ingreso_at DESC`).all(eventId);
  } else {
    rows = db.prepare(`SELECT a.*, s.nombre, s.cedula, s.grupo FROM attendance a JOIN students s ON s.id=a.student_id WHERE a.event_id=? ORDER BY a.ingreso_at DESC`).all(eventId);
  }
  res.json(rows);
});
app.post('/api/attendance/checkin', authRequired, async (req, res) => {
  const { cedula, studentId, nombre, grupo } = req.body || {};
  if(!cedula && !studentId) return res.status(400).json({ error: 'cedula o studentId requerido' });
  const eventId = getActiveEventId();
  let st;
  if(studentId){ st = db.prepare('SELECT * FROM students WHERE id=?').get(Number(studentId)); }
  else {
    st = db.prepare('SELECT * FROM students WHERE cedula=?').get(String(cedula));
    if(!st){ const info = db.prepare('INSERT INTO students(cedula, nombre, grupo, created_at) VALUES(?,?,?,?)').run(String(cedula), nombre || 'Sin nombre', grupo||null, nowISO()); st = db.prepare('SELECT * FROM students WHERE id=?').get(info.lastInsertRowid); }
  }
  if(!st) return res.status(404).json({ error: 'Estudiante no encontrado' });

  const existing = db.prepare('SELECT * FROM attendance WHERE event_id=? AND student_id=? AND salida_at IS NULL').get(eventId, st.id);
  if(existing){
    await postToFlow('checkin', { type:'checkin', attendanceId: existing.id, event:{ id: eventId }, student:{ id: st.id, cedula: st.cedula, nombre: st.nombre }, ingreso_at: existing.ingreso_at, salida_at: existing.salida_at, server_time: nowISO() });
    return res.json({ ok: true, message: 'Ingreso ya registrado (presente)', student: st, attendanceId: existing.id });
  } else {
    const info = db.prepare('INSERT INTO attendance(student_id, event_id, ingreso_at) VALUES(?,?,?)').run(st.id, eventId, nowISO());
    await postToFlow('checkin', { type:'checkin', attendanceId: info.lastInsertRowid, event:{ id: eventId }, student:{ id: st.id, cedula: st.cedula, nombre: st.nombre }, ingreso_at: nowISO(), salida_at: null, server_time: nowISO() });
    return res.json({ ok: true, message: 'Ingreso registrado', student: st, attendanceId: info.lastInsertRowid });
  }
});
app.post('/api/attendance/checkout', authRequired, async (req, res) => {
  const { cedula, studentId } = req.body || {};
  if(!cedula && !studentId) return res.status(400).json({ error: 'cedula o studentId requerido' });
  const eventId = getActiveEventId();
  let st;
  if(studentId){ st = db.prepare('SELECT * FROM students WHERE id=?').get(Number(studentId)); }
  else { st = db.prepare('SELECT * FROM students WHERE cedula=?').get(String(cedula)); }
  if(!st) return res.status(404).json({ error: 'Estudiante no encontrado' });
  const att = db.prepare('SELECT * FROM attendance WHERE event_id=? AND student_id=? AND salida_at IS NULL ORDER BY ingreso_at DESC LIMIT 1').get(eventId, st.id);
  if(!att) return res.status(404).json({ error: 'No hay ingreso activo para registrar salida' });
  const now = nowISO();
  db.prepare('UPDATE attendance SET salida_at=? WHERE id=?').run(now, att.id);
  await postToFlow('checkout', { type:'checkout', attendanceId: att.id, event:{ id: eventId }, student:{ id: st.id, cedula: st.cedula, nombre: st.nombre }, ingreso_at: att.ingreso_at, salida_at: now, server_time: nowISO() });
  res.json({ ok: true, message: 'Salida registrada', student: st, attendanceId: att.id });
});

// Borrar asistencia (según permisos)
app.delete('/api/attendance/:id', authRequired, requireCanDelete, (req,res)=>{
  const id = Number(req.params.id);
  db.prepare('DELETE FROM attendance WHERE id=?').run(id);
  res.json({ ok:true });
});

// Últimos escaneos
app.get('/api/attendance/recent', authRequired, (req,res)=>{
  const { type='checkin', limit=10 } = req.query;
  const eventId = getActiveEventId();
  let rows;
  if(type==='checkout'){
    rows = db.prepare(`SELECT a.*, s.nombre, s.cedula, s.grupo FROM attendance a JOIN students s ON s.id=a.student_id WHERE a.event_id=? AND a.salida_at IS NOT NULL ORDER BY a.salida_at DESC LIMIT ?`).all(eventId, Number(limit));
  } else {
    rows = db.prepare(`SELECT a.*, s.nombre, s.cedula, s.grupo FROM attendance a JOIN students s ON s.id=a.student_id WHERE a.event_id=? ORDER BY a.ingreso_at DESC LIMIT ?`).all(eventId, Number(limit));
  }
  res.json(rows);
});

// ---- Reportes y Export ----
function minutesDiff(a, b){ try{ return Math.round((new Date(b) - new Date(a)) / 60000); }catch{ return null; } }
function rangeFromTo(from, to){ let start = from ? new Date(from + 'T00:00:00') : new Date('1970-01-01T00:00:00'); let end = to ? new Date(to + 'T23:59:59.999') : new Date('2999-12-31T23:59:59.999'); return { start: start.toISOString(), end: end.toISOString() }; }

app.get('/api/reports/attendance', authRequired, (req, res) => {
  const eventId = req.query.eventId ? Number(req.query.eventId) : getActiveEventId();
  const { from, to } = req.query; const { start, end } = rangeFromTo(from, to);
  const rows = db.prepare(`SELECT a.*, s.nombre, s.cedula, s.grupo, e.nombre as evento_nombre, e.fecha as evento_fecha FROM attendance a JOIN students s ON s.id=a.student_id JOIN events e ON e.id=a.event_id WHERE a.event_id=? AND a.ingreso_at BETWEEN ? AND ? ORDER BY a.ingreso_at ASC`).all(eventId, start, end);
  const withDur = rows.map(r=>({ ...r, duracion_min: r.salida_at ? minutesDiff(r.ingreso_at, r.salida_at) : null }));
  res.json(withDur);
});

// Estadísticas por grupo
app.get('/api/stats/students-by-group', authRequired, (req,res)=>{
  const rows = db.prepare('SELECT COALESCE(grupo, "Sin grupo") as grupo, COUNT(*) as total FROM students GROUP BY grupo ORDER BY grupo').all();
  res.json(rows);
});
app.get('/api/stats/attendance-by-group', authRequired, (req,res)=>{
  const eventId = req.query.eventId ? Number(req.query.eventId) : getActiveEventId();
  const { from, to } = req.query; const { start, end } = rangeFromTo(from, to);
  const totals = db.prepare('SELECT COALESCE(grupo, "Sin grupo") as grupo, COUNT(*) as total FROM students GROUP BY grupo').all();
  const present = db.prepare(`SELECT COALESCE(s.grupo, "Sin grupo") as grupo, COUNT(DISTINCT a.student_id) as presentes FROM attendance a JOIN students s ON s.id=a.student_id WHERE a.event_id=? AND a.ingreso_at BETWEEN ? AND ? GROUP BY s.grupo`).all(eventId, start, end);
  const mapP = Object.fromEntries(present.map(r=>[r.grupo, r.presentes]));
  const out = totals.map(t=>({ grupo: t.grupo, total: t.total, presentes: mapP[t.grupo]||0, ausentes: t.total - (mapP[t.grupo]||0) }));
  res.json(out);
});

// Export CSV/XLSX (de asistencia)
app.get('/api/export/attendance.csv', authRequired, (req, res) => {
  const eventId = req.query.eventId ? Number(req.query.eventId) : getActiveEventId();
  const { from, to } = req.query; const { start, end } = rangeFromTo(from, to);
  const rows = db.prepare(`SELECT a.*, s.nombre, s.cedula, s.grupo, e.nombre as evento_nombre, e.fecha as evento_fecha FROM attendance a JOIN students s ON s.id=a.student_id JOIN events e ON e.id=a.event_id WHERE a.event_id=? AND a.ingreso_at BETWEEN ? AND ? ORDER BY a.ingreso_at ASC`).all(eventId, start, end);
  const head = ['evento','fecha_evento','nombre','cedula','grupo','ingreso_at','salida_at','duracion_min'];
  const lines = [head.join(',')];
  for(const r of rows){ const dur = r.salida_at ? minutesDiff(r.ingreso_at, r.salida_at) : ''; const row = [(r.evento_nombre||'').replaceAll(',', ' '), r.evento_fecha||'', (r.nombre||'').replaceAll(',', ' '), r.cedula||'', r.grupo||'', r.ingreso_at||'', r.salida_at||'', dur]; lines.push(row.join(',')); }
  const csv = lines.join('\n');
  res.setHeader('Content-Type','text/csv; charset=utf-8'); res.setHeader('Content-Disposition','attachment; filename="reporte_asistencia.csv"'); res.send(csv);
});
app.get('/api/export/attendance.xlsx', authRequired, async (req,res)=>{
  const eventId = req.query.eventId ? Number(req.query.eventId) : getActiveEventId();
  const { from,to } = req.query; const { start,end } = rangeFromTo(from,to);
  const rows = db.prepare(`SELECT a.*, s.nombre, s.cedula, s.grupo, e.nombre as evento_nombre, e.fecha as evento_fecha FROM attendance a JOIN students s ON s.id=a.student_id JOIN events e ON e.id=a.event_id WHERE a.event_id=? AND a.ingreso_at BETWEEN ? AND ? ORDER BY a.ingreso_at ASC`).all(eventId,start,end);
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Asistencia');
  ws.columns = [ {header:'Evento',key:'evento'}, {header:'Fecha evento',key:'fecha_evento'}, {header:'Nombre',key:'nombre'}, {header:'Cédula',key:'cedula'}, {header:'Grupo',key:'grupo'}, {header:'Ingreso',key:'ingreso_at'}, {header:'Salida',key:'salida_at'}, {header:'Duración (min)',key:'duracion_min'} ];
  for(const r of rows){ ws.addRow({ evento:r.evento_nombre, fecha_evento:r.evento_fecha, nombre:r.nombre, cedula:r.cedula, grupo:r.grupo, ingreso_at:r.ingreso_at, salida_at:r.salida_at, duracion_min: r.salida_at? minutesDiff(r.ingreso_at,r.salida_at):'' }); }
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition','attachment; filename="reporte_asistencia.xlsx"'); await wb.xlsx.write(res); res.end();
});

// Import CSV (memoria)
app.post('/api/import/students', authRequired, uploadMemory.single('file'), (req, res) => {
  if(!req.file) return res.status(400).json({ error: 'Archivo CSV requerido (campo "file")' });
  let text = req.file.buffer.toString('utf-8'); text = text.replace(/\r\n/g,'\n');
  let records = []; try{ records = csvParse(text, { columns:true, skip_empty_lines:true, delimiter:',' }); }catch{ records = csvParse(text,{ columns:true, skip_empty_lines:true, delimiter:';' }); }
  const up = db.prepare(`INSERT INTO students(cedula, nombre, email, telefono, grupo, created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(cedula) DO UPDATE SET nombre=excluded.nombre, email=COALESCE(excluded.email, students.email), telefono=COALESCE(excluded.telefono, students.telefono), grupo=COALESCE(excluded.grupo, students.grupo)`);
  const tx = db.transaction((rows)=>{ for(const r of rows){ const cedula = (r.cedula || r.Cedula || r.CÉDULA || r.Cédula || '').toString().trim(); if(!cedula) continue; const nombre=(r.nombre||r.Nombre||r.NOMBRE||'Sin nombre').toString().trim(); const email=(r.email||r.Email||'')||null; const telefono=(r.telefono||r.Teléfono||r.Telefono||'')||null; const grupo=(r.grupo||r.Grupo||'')||null; up.run(cedula, nombre, email, telefono, grupo, nowISO()); } });
  tx(records);
  res.json({ ok:true, total: records.length });
});

// Generador de QRs (imprimible)
app.get('/export/qrs', authRequired, async (req, res) => {
  let students = [];
  if(req.query.ids){ const ids = req.query.ids.split(',').map(x=>Number(x)).filter(Boolean); if(ids.length){ const placeholders = ids.map(()=>'?').join(','); students = db.prepare(`SELECT * FROM students WHERE id IN (${placeholders}) ORDER BY nombre ASC`).all(...ids); } }
  if(!students.length){ if(req.query.search){ const s = `%${String(req.query.search).toLowerCase()}%`; students = db.prepare(`SELECT * FROM students WHERE lower(nombre) LIKE ? OR lower(cedula) LIKE ? ORDER BY nombre ASC LIMIT 200`).all(s, s); } else { students = db.prepare('SELECT * FROM students ORDER BY nombre ASC LIMIT 100').all(); } }
  const cards = [];
  for(const st of students){ const text = st.cedula || String(st.id); const dataUrl = await QRCode.toDataURL(text, { width: 256, margin: 1 }); cards.push({ nombre: st.nombre||'', cedula: st.cedula||'', grupo: st.grupo||'', dataUrl }); }
  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>QRs para imprimir</title><style>body{font-family:system-ui,Arial,sans-serif;} .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:16px;} .card{border:1px solid #ddd;padding:10px;text-align:center;} img{width:220px;height:220px} .name{font-weight:600;margin-top:8px} .id{color:#374151;font-size:12px}</style></head><body><button onclick="window.print()">Imprimir</button><div class="grid">${cards.map(c=>`<div class=card><img src="${c.dataUrl}"/><div class=name>${c.nombre}</div><div class=id>${c.cedula} ${c.grupo?(' - '+c.grupo):''}</div></div>`).join('')}</div></body></html>`;
  res.setHeader('Content-Type','text/html; charset=utf-8'); res.send(html);
});

// Webhook Power Automate (opcional)
async function postToFlow(type, payload){ try{ const url = (type==='checkin' ? (process.env.FLOW_URL_CHECKIN||process.env.FLOW_URL) : (process.env.FLOW_URL_CHECKOUT||process.env.FLOW_URL)); if(!url) return; const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) }); }catch(e){} }
app.post('/api/webhook/test', authRequired, async (req,res)=>{ const payload = { type:'test', server_time: nowISO(), echo: req.body||{} }; await postToFlow('checkin', payload); res.json({ ok:true, sent:true }); });

// Health
app.get('/api/health', (req,res)=> res.json({ ok:true, time: nowISO() }));

// 404 API
app.use('/api', (req,res)=> res.status(404).json({ error:'Ruta no encontrada' }));

// SPA: sirve index.html para rutas no API
app.get('/login', (req,res)=>{ res.sendFile(path.join(__dirname,'public','login.html')); });
app.get('*', (req,res)=>{ res.sendFile(path.join(__dirname, 'public', 'index.html')); });

app.listen(PORT, ()=> console.log(`✅ Servidor en http://localhost:${PORT}`));
