import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import session from 'express-session';
import multer from 'multer';
import fs from 'fs';

import { db, initDb, getActiveEventId, ensureActiveEvent } from './db.js';
import bcrypt from 'bcryptjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(morgan('dev'));

app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public')));

const uploadMemory = multer({ storage: multer.memoryStorage() });
const uploadDisk = multer({ storage: multer.diskStorage({
  destination: (req, file, cb)=> cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb)=>{
    const ext = (file.originalname||'').split('.').pop();
    const name = Date.now() + '-' + Math.random().toString(36).slice(2) + (ext?'.'+ext:'');
    cb(null, name);
  }
})});

// --- Configuración de Multer para subida de fotos ---
const FOTOS_DIR = 'public/fotos';
if (!fs.existsSync(FOTOS_DIR)){
    fs.mkdirSync(FOTOS_DIR, { recursive: true });
}
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, FOTOS_DIR);
  },
  filename: function (req, file, cb) {
    // Usar la cédula como nombre de archivo para evitar duplicados
    const cedula = req.body.cedula || 'sin-cedula';
    const extension = path.extname(file.originalname);
    cb(null, `${cedula}${extension}`);
  }
});
const upload = multer({ storage: storage });


// --- Auth ---
const authRequired = (req, res, next) => {
  const token = req.cookies.token;
  if (!token) {
    return res.status(401).json({ error: 'No autenticado' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // Adjuntar datos del usuario al request
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido' });
  }
};

function requireAdmin(req,res,next){ if(req.user && (req.user.role==='admin' || req.user.role==='superadmin')) return next(); return res.status(403).json({ error: 'Solo admin' }); }
function requireSuper(req,res,next){ if(req.user && req.user.role==='superadmin') return next(); return res.status(403).json({ error: 'Solo superadmin' }); }
function requireCanDelete(req,res,next){ if(req.user && req.user.can_delete) return next(); return res.status(403).json({ error: 'No tienes permiso para borrar' }); }

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    }
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role, can_delete: !!user.can_delete }, JWT_SECRET, { expiresIn: '1d' });
    res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/' });
    res.json({ id: user.id, username: user.username, role: user.role });
  } catch (e) {
    console.error('Error en login:', e);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/api/auth/logout', (req,res)=>{
  res.clearCookie('token');
  res.json({ ok:true });
});
app.get('/api/auth/me', authRequired, (req,res)=>{
  return res.json({ id:req.user.id, username:req.user.username, role:req.user.role, can_delete:!!req.user.can_delete });
});

// --- Settings ---
app.get('/api/settings', authRequired, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {}; for(const r of rows) out[r.key] = r.value; res.json(out);
});
app.put('/api/settings', authRequired, requireSuper, (req, res) => {
  const entries = Object.entries(req.body || {});
  const up = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const tx = db.transaction((pairs)=>{ for(const [k,v] of pairs) up.run(k, String(v)); });
  tx(entries);
  res.json({ ok: true });
});

// --- Users ---
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

// --- Eventos ---
app.get('/api/events', authRequired, (req, res) => {
  const rows = db.prepare('SELECT * FROM events ORDER BY fecha DESC, id DESC').all();
  res.json(rows);
});
app.post('/api/events', authRequired, (req, res) => {
  const { nombre, fecha } = req.body;
  if(!nombre) return res.status(400).json({ error: 'nombre es requerido' });
  const info = db.prepare('INSERT INTO events(nombre, fecha, activo) VALUES(?,?,0)').run(nombre, fecha || new Date().toISOString().slice(0,10));
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

// --- Estudiantes ---
app.get('/api/students', authRequired, async (req, res) => {
  const { search } = req.query;
  const rows = db.prepare(`SELECT * FROM students WHERE nombre LIKE ? OR cedula LIKE ? ORDER BY nombre LIMIT 50`).all(`%${search}%`, `%${search}%`);
  res.json(rows);
});
app.get('/api/students/:id', authRequired, (req, res) => {
  const st = db.prepare('SELECT * FROM students WHERE id=?').get(Number(req.params.id));
  if(!st) return res.status(404).json({ error: 'Estudiante no encontrado' });
  res.json(st);
});
app.post('/api/students', authRequired, upload.single('foto'), (req, res) => {
  const { nombre, cedula, grupo } = req.body;
  if (!nombre || !cedula) {
    return res.status(400).json({ error: 'Nombre y cédula son requeridos' });
  }
  try {
    const fotoPath = req.file ? `fotos/${req.file.filename}` : null;
    const info = db.prepare('INSERT INTO students(cedula, nombre, grupo, foto, created_at) VALUES(?,?,?,?,?)')
                   .run(cedula, nombre, grupo, fotoPath, new Date().toISOString());
    const newStudent = db.prepare('SELECT * FROM students WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(newStudent);
  } catch (e) {
    if (String(e).includes('UNIQUE')) {
        return res.status(409).json({ error: 'La cédula ya existe' });
    }
    console.error('Error al crear estudiante:', e);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});
app.put('/api/students/:id', authRequired, (req, res) => {
  const id = Number(req.params.id);
  const { cedula, nombre, email, telefono, grupo } = req.body || {};
  const st = db.prepare('SELECT * FROM students WHERE id=?').get(id);
  if(!st) return res.status(404).json({ error: 'Estudiante no encontrado' });
  try{
    db.prepare('UPDATE students SET cedula=COALESCE(?,cedula), nombre=COALESCE(?,nombre), email=COALESCE(?,email), telefono=COALESCE(?,telefono), grupo=COALESCE(?,grupo) WHERE id=?')
      .run(cedula, nombre, email, telefono, grupo, id);
    res.json(updatedStudent);
  }catch(e){ if(String(e).includes('UNIQUE')) return res.status(409).json({ error: 'Cédula ya existe' }); throw e; }
});
app.delete('/api/students/:id', authRequired, (req, res) => {
  if(!(req.user && (req.user.role==='superadmin' || req.user.role==='admin'))) return res.status(403).json({ error:'Solo admin o superior' });
  const id = Number(req.params.id);
  db.prepare('DELETE FROM students WHERE id=?').run(id);
  res.json({ ok: true });
});

// --- Attendance ---
app.post('/api/attendance/ingreso', authRequired, (req, res) => {
  try {
    const { cedula } = req.body;
    if (!cedula) return res.status(400).json({ error: 'Cédula es requerida' });

    const activeEvent = db.prepare('SELECT * FROM events WHERE activo = 1').get();
    if (!activeEvent) return res.status(400).json({ error: 'No hay un evento activo' });

    const student = db.prepare('SELECT id, nombre FROM students WHERE cedula = ?').get(cedula);
    if (!student) return res.status(404).json({ error: 'Estudiante no encontrado' });

    const existingEntry = db.prepare('SELECT id FROM attendance WHERE student_id = ? AND event_id = ?').get(student.id, activeEvent.id);
    if (existingEntry) {
      return res.status(200).json({ message: 'Ya tiene un ingreso registrado', nombre: student.nombre, cedula });
    }

    db.prepare('INSERT INTO attendance (student_id, event_id, ingreso_at) VALUES (?, ?, ?)')
      .run(student.id, activeEvent.id, new Date().toISOString());

    res.json({ message: 'Ingreso registrado', nombre: student.nombre, cedula });
  } catch (e) {
    console.error('Error en ingreso:', e);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/api/attendance/salida', authRequired, (req, res) => {
  try {
    const { cedula } = req.body;
    if (!cedula) return res.status(400).json({ error: 'Cédula es requerida' });

    const activeEvent = db.prepare('SELECT * FROM events WHERE activo = 1').get();
    if (!activeEvent) return res.status(400).json({ error: 'No hay un evento activo' });

    const student = db.prepare('SELECT id, nombre FROM students WHERE cedula = ?').get(cedula);
    if (!student) return res.status(404).json({ error: 'Estudiante no encontrado' });

    const result = db.prepare('UPDATE attendance SET salida_at = ? WHERE student_id = ? AND event_id = ? AND salida_at IS NULL')
      .run(new Date().toISOString(), student.id, activeEvent.id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'No se encontró un ingreso previo para registrar la salida', nombre: student.nombre });
    }

    res.json({ message: 'Salida registrada', nombre: student.nombre, cedula });
  } catch (e) {
    console.error('Error en salida:', e);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});


app.delete('/api/attendance/:id', authRequired, requireCanDelete, (req,res)=>{
  const id = Number(req.params.id);
  db.prepare('DELETE FROM attendance WHERE id=?').run(id);
  res.json({ ok:true });
});

// --- Stats / Dashboard ---
app.get('/api/attendance/stats', authRequired, (req, res) => {
  const total = db.prepare('SELECT COUNT(id) as total FROM students').get().total;
  const eventId = getActiveEventId();
  
  if (!eventId) {
    return res.json({ presentes: 0, ausentes: total, total, adentro: 0, salidas: 0 });
  }

  const presentes = db.prepare('SELECT COUNT(id) as total FROM attendance WHERE event_id = ?').get(eventId).total;
  const adentro = db.prepare('SELECT COUNT(id) as total FROM attendance WHERE event_id = ? AND salida_at IS NULL').get(eventId).total;
  const salidas = db.prepare('SELECT COUNT(id) as total FROM attendance WHERE event_id = ? AND salida_at IS NOT NULL').get(eventId).total;
  
  res.json({
    presentes,
    ausentes: total - presentes,
    total,
    adentro,
    salidas
  });
});

app.get('/api/attendance/list', authRequired, (req, res) => {
  const eventId = getActiveEventId();
  if (!eventId) return res.json([]);
  
  const status = req.query.status;
  let rows;
  if (status === 'current') {
    rows = db.prepare(`
      SELECT s.nombre, s.cedula, a.ingreso_at, a.salida_at 
      FROM attendance a JOIN students s ON a.student_id = s.id 
      WHERE a.event_id = ? AND a.salida_at IS NULL 
      ORDER BY a.ingreso_at DESC LIMIT 20
    `).all(eventId);
  } else {
    rows = db.prepare(`
      SELECT s.nombre, s.cedula, a.ingreso_at, a.salida_at 
      FROM attendance a JOIN students s ON a.student_id = s.id 
      WHERE a.event_id = ? 
      ORDER BY a.ingreso_at DESC LIMIT 20
    `).all(eventId);
  }
  res.json(rows);
});

app.get('/api/stats/students-by-group', authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT grupo, COUNT(id) as total 
    FROM students 
    WHERE grupo IS NOT NULL AND grupo != '' 
    GROUP BY grupo ORDER BY grupo
  `).all();
  res.json(rows);
});

app.get('/api/stats/attendance-by-group', authRequired, (req, res) => {
  const eventId = getActiveEventId();
  if (!eventId) return res.json([]);

  const rows = db.prepare(`
    SELECT 
      s.grupo, 
      COUNT(s.id) as total,
      SUM(CASE WHEN a.id IS NOT NULL THEN 1 ELSE 0 END) as presentes
    FROM students s
    LEFT JOIN attendance a ON s.id = a.student_id AND a.event_id = ?
    WHERE s.grupo IS NOT NULL AND s.grupo != ''
    GROUP BY s.grupo
    ORDER BY s.grupo
  `).all(eventId);

  const result = rows.map(r => ({
    grupo: r.grupo,
    presentes: r.presentes,
    ausentes: r.total - r.presentes
  }));
  res.json(result);
});


// --- Export/Reportes ---
function minutesDiff(a, b){ try{ return Math.round((new Date(b) - new Date(a)) / 60000); }catch{ return null; } }
function rangeFromTo(from, to){ let start = from ? new Date(from + 'T00:00:00') : new Date('1970-01-01T00:00:00'); let end = to ? new Date(to + 'T23:59:59.999') : new Date('2999-12-31T23:59:59.999'); return { start: start.toISOString(), end: end.toISOString() }; }

app.get('/api/reports/attendance', authRequired, (req, res) => {
  const eventId = req.query.eventId ? Number(req.query.eventId) : getActiveEventId();
  const { from, to } = req.query; const { start, end } = rangeFromTo(from, to);
  const rows = db.prepare(`SELECT a.*, s.nombre, s.cedula, s.grupo, e.nombre as evento_nombre, e.fecha as evento_fecha FROM attendance a JOIN students s ON s.id=a.student_id JOIN events e ON e.id=a.event_id WHERE a.event_id=? AND a.ingreso_at BETWEEN ? AND ? ORDER BY a.ingreso_at ASC`).all(eventId, start, end);
  const withDur = rows.map(r=>({ ...r, duracion_min: r.salida_at ? minutesDiff(r.ingreso_at, r.salida_at) : null }));
  res.json(withDur);
});
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

// --- Rutas de páginas (gating server-side) ---
app.get('/login', (req,res)=>{ res.sendFile(path.join(__dirname,'public','login.html')); });
app.get('/', (req,res)=>{
  const token = req.cookies.token;
  if(!token) return res.redirect('/login');
  try{ jwt.verify(token, JWT_SECRET); return res.sendFile(path.join(__dirname,'public','index.html')); }
  catch{ return res.redirect('/login'); }
});
app.get('*', (req,res)=>{ return res.redirect('/'); });

app.listen(PORT, ()=> console.log(`✅ Servidor en http://localhost:${PORT}`));
