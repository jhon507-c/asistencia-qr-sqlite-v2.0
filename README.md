# Asistencia QR — Parche (login y navegación)

Este paquete corrige:
- **Gating de login** del lado **servidor**: `/` redirige a **/login** si no hay cookie JWT válida.
- **/api/auth/me** devuelve **401** si no hay sesión y, si la hay, el **objeto de usuario** directo `{ id, username, role, can_delete }`.
- **Frontend (`public/app.js`)** usa un `me()` consistente y navega correctamente entre secciones.

## Ejecutar local
```bash
npm install
npm start
# abrir http://localhost:3000
# login: root / @dM!n!25
```

## Requisitos
- Node.js **18 o 20**. Recomendado **20** (en producción/Coolify fija `NIXPACKS_NODE_VERSION=20`).

## Persistencia (Coolify)
- Monta volúmenes en **directorios**:
  - `/app/storage` (SQLite)
  - `/app/uploads` (fotos)
- No marques “Is it a static site?”. Start: `npm start`. Port: `3000`.
- SSL: agrega dominio en **Domains** y habilita **Let’s Encrypt**.
