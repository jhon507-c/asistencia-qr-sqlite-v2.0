# Sistema de Asistencia (QR / Nombre / Cédula) — con Login, Reportes y Coolify Ready

Aplicación **Node.js + Express + SQLite + HTML/CSS/JS** para controlar asistencia en eventos con:

- Autenticación (**login**, JWT en cookie) y **roles** (superadmin/admin/user).
- **Super‑admin** por defecto: `root` / `@dM!n!25`.
- Gestión de **usuarios** (solo super‑admin), con permiso de **borrar** asistencia.
- Registro de asistencia por **QR** y **manual** (cédula/nombre).
- **Dashboard** con **gráficos** (Chart.js): estudiantes por grupo (aula), presentes/ausentes por grupo.
- **Grupos** (aulas) y **foto de perfil** opcional por estudiante.
- **Exportar** asistencia a **CSV/Excel**; **reportes** por rango.
- **Importar CSV** de estudiantes y **generar QRs** (por lista o por selección).
- Diseño **responsive** y paleta basada en **verde**.

> **Base de datos** y **fotos** se guardan en carpetas persistentes (`/app/storage` y `/app/uploads`).

---

## Requisitos
- **Node.js 20** (fijado por Nixpacks en despliegue)
- macOS, Linux o Windows

## Ejecutar en local (VS Code)

```bash
# 1) Instalar dependencias
npm install

# 2) Iniciar
npm start

# 3) Abrir
http://localhost:3000
```

### Credenciales
- **Super‑admin**: usuario `root`, contraseña `@dM!n!25`.

---

## Estructura
```
.
├── package.json
├── server.js             # Servidor Express (API + Auth)
├── db.js                 # SQLite + migraciones + seed root
├── storage/              # (se crea en runtime) DB SQLite
├── uploads/              # (se crea en runtime) fotos
└── public/
    ├── index.html        # SPA protegida (redirige a /login si no hay sesión)
    ├── login.html        # Página de login
    ├── styles.css        # Paleta verde, responsive
    ├── app.js            # Lógica de UI + llamadas API + charts + QR
    └── login.js          # Lógica de login
```

---

## Seguridad
- **JWT** en cookie **httpOnly** (secure cuando hay `COOLIFY_URL`).
- **Roles**: `superadmin` (todo), `admin` (gestión estudiantes/eventos), `user` (operación de asistencia).
- **Permisos de borrado** de asistencia: `can_delete`, asignable desde **Usuarios** (solo super‑admin). Las rutas de borrado validan el permiso.

---

## Campos de Estudiante
- `grupo` (aula), `foto` (URL relativa en `/uploads/*`).
- Edición en **Editar → Estudiantes**. La foto es **opcional**.

---

## Importar CSV
- Endpoint: `POST /api/import/students` (campo `file`).
- Formato sugerido:
  ```csv
  cedula,nombre,email,telefono,grupo
  12345678,Juan Pérez,juan@ejemplo.com,555-1234,10-A
  ```
- **Upsert por cédula**.

---

## Despliegue en **Coolify** (Producción)

1) **Conectar repositorio Git** (público o privado por GitHub App). Nixpacks detecta Node.
2) **Build Pack**: **Nixpacks**.
3) **Node**: fija versión a **20** (cualquiera de estas opciones):
   - Variable de **Build**: `NIXPACKS_NODE_VERSION=20`.
   - o en `package.json`: `"engines": { "node": "20.x" }`.
   - o `.nvmrc` con `20`.
4) **Start command**: `npm start`.
5) **Port expose**: `3000`.
6) **Is it a static site?**: **NO** (es app Node con API).
7) **Environment Variables**:
   - `JWT_SECRET` = una cadena segura.
   - (opcional) `FLOW_URL` o `FLOW_URL_CHECKIN` / `FLOW_URL_CHECKOUT` (Power Automate).
   - (opcional) `COOLIFY_URL` = `https://tu-dominio` (activa cookie `secure`).
   - (build, opcional) `NIXPACKS_NODE_VERSION=20`.
8) **Persistent Storage** (antes del primer deploy):
   - Volume → **Destination Path**: `/app/storage` (SQLite).
   - Volume → **Destination Path**: `/app/uploads` (fotos).
9) **Dominio + SSL**:
   - Añade tu **dominio** en **Domains**, marca **Enable SSL** (Let’s Encrypt) y **Force HTTPS**.
10) **Deploy**.

> Si el build intenta compilar módulos nativos y necesitas toolchain (por ejemplo, si se forzara la compilación de `better-sqlite3`), añade un `nixpacks.toml` con `python3`, `gcc` y `gnumake` en `phases.setup`. En la configuración estándar, **no hace falta**: Nixpacks usa Node 20 y `better-sqlite3` descarga prebuilds.

---

## Páginas y funciones
- **Login**: `/login`.
- **Dashboard**: métricas + gráficos (filtrables por rango) y presentes actuales.
- **Ingreso/Salida**: escaneo QR + manual, y **últimos 10** movimientos.
- **Editar**: CRUD estudiantes/eventos, import CSV, foto, filtro por grupo, **generación de QRs** por lista y **por selección**.
- **Usuarios** (solo super‑admin): CRUD usuarios, rol, `can_delete`.
- **Perfil**: nombre de la organización, nota sobre permisos.

---

## Buenas prácticas aplicadas
- Código modular (API REST limpia, middlewares, transacciones en bulk).
- UI responsive (CSS grid/flex, mobile‑first), paleta verde.
- Evita dependencias nativas en auth (`bcryptjs`).
- Persistencia de datos/fotos en volúmenes dedicados.
- Comentarios y nombres claros.

---

## Troubleshooting (Coolify)
- **App arranca y se detiene**: revisa **Application Logs** en Coolify; confirma `PORT=3000`, `Start command=npm start`.
- **`libnode.so.72`**: mismatch de binarios nativos; fuerza Node 20 y *no* `build_from_source`; si compilas, añade toolchain en `nixpacks.toml`.
- **Volúmenes**: asegúrate de montar **directorios** (`/app/storage`, `/app/uploads`), no archivos.

---

## Licencia
MIT
