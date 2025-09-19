import Database from 'better-sqlite3';
import fs from 'fs';

// Asegurar directorios persistentes
fs.mkdirSync('storage', { recursive: true });
fs.mkdirSync('uploads', { recursive: true });

export const db = new Database('storage/data.sqlite');
db.pragma('journal_mode = WAL');

echoPragma();
function echoPragma(){ try{ db.pragma('foreign_keys = ON'); }catch{} }

export function initDb(){
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cedula TEXT UNIQUE,
      nombre TEXT,
      email TEXT,
      telefono TEXT,
      grupo TEXT,
      foto TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      fecha TEXT NOT NULL,
      activo INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      event_id INTEGER NOT NULL,
      ingreso_at TEXT NOT NULL,
      salida_at TEXT,
      FOREIGN KEY(student_id) REFERENCES students(id),
      FOREIGN KEY(event_id) REFERENCES events(id)
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      can_delete INTEGER NOT NULL DEFAULT 0,
      created_at TEXT
    );
  `);

  // Migraciones ligeras para columnas nuevas
  try{ db.exec(`ALTER TABLE students ADD COLUMN grupo TEXT`); }catch{}
  try{ db.exec(`ALTER TABLE students ADD COLUMN foto TEXT`); }catch{}
  try{ db.exec(`ALTER TABLE users ADD COLUMN can_delete INTEGER NOT NULL DEFAULT 0`); }catch{}

  seedRootUser();
  ensureActiveEvent();
}

function seedRootUser(){
  const root = db.prepare('SELECT * FROM users WHERE username=?').get('root');
  if(!root){
    // hash precomputado de @dM!n!25 usando bcryptjs equivalente? No usamos bcryptjs para evitar nativo: generamos en server con bcryptjs.
    // Aquí insertamos temporalmente un marcador y el server lo actualizará si detecta placeholder.
    const placeholder = 'PLACEHOLDER_HASH_TO_BE_SET_AT_RUNTIME';
    db.prepare('INSERT INTO users(username,password_hash,role,can_delete,created_at) VALUES(?,?,?,?,?)')
      .run('root', placeholder, 'superadmin', 1, new Date().toISOString());
  }
}

export function getActiveEventId(){
  const row = db.prepare('SELECT id FROM events WHERE activo=1').get();
  if(row) return row.id;
  ensureActiveEvent();
  return db.prepare('SELECT id FROM events WHERE activo=1').get().id;
}

export function ensureActiveEvent(){
  const active = db.prepare('SELECT * FROM events WHERE activo=1').get();
  if(!active){
    const today = new Date().toISOString().slice(0,10);
    db.prepare('INSERT INTO events(nombre, fecha, activo) VALUES(?,?,1)').run('Evento activo', today);
  }
}
