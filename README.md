# Preconteo electoral en tiempo real

Taller de WebSockets · POW. Diseño y contratos: **[docs/DISEÑO.md](docs/DISEÑO.md)** (fuente de verdad).

nginx (round-robin, sin sticky) → 8 instancias Node/TS → Redis. Jurados por HTTP, público por SSE,
auditores por WebSocket.

## Correr en local

Requisitos: Node 22+, Docker.

```bash
npm install
npm run build && npm test

# Todo el sistema (nginx :80 + app ×8 + redis)
docker compose up -d --build
for i in $(seq 16); do curl -s localhost/api/instancia; echo; done   # 8 instancias distintas
open http://localhost/tablero.html

# Desarrollo de un solo proceso con recarga (necesita un Redis en localhost:6379)
docker compose up -d redis   # o: docker run -p 6379:6379 redis:7-alpine
REDIS_URL=redis://localhost:6379 npm run dev   # http://localhost:3000
```

Para `npm run dev` contra el Redis de compose, publica el puerto agregando `ports: ["6379:6379"]`
al servicio `redis` en un `docker-compose.override.yml` local (no se sube).

Scripts: `dev` (tsx watch), `build` (tsc → `dist/`), `start` (`node dist/src/servidor.js`),
`test` (vitest), `semilla` (carga catálogo, Persona 1).

## Dueños (sección 3)

| Ruta | Dueño |
|---|---|
| `docs/DISEÑO.md` | todos (cambios por PR) |
| `compartido/` (`contratos.ts`, `claves.ts`, `redis.ts`, `contexto.ts`) | todos |
| `src/servidor.ts`, `src/upgrade.ts` | Persona 3 |
| `src/jurados/` | Persona 1 |
| `src/publico/` | Persona 2 |
| `src/verificacion/` | Persona 3 |
| `src/metricas/` | Persona 3 (cada módulo reporta con `ctx.metricas.registrar(...)`) |
| `lua/aplicar_acta.lua` | Persona 1 |
| `lua/bloqueos.lua` | Persona 3 |
| `web/jurado.html` | Persona 1 |
| `web/publico.html` | Persona 2 |
| `web/auditor.html`, `web/tablero.html` | Persona 3 |
| `carga/` | Persona 2 |
| `scripts/semilla.ts` | Persona 1 |
| `docker-compose.yml`, `nginx/`, `deploy/`, `Dockerfile` | Persona 3 |

Cada módulo exporta una sola función de montaje, que recibe `ctx = { redis, redisSub, instancia, metricas }`:

```ts
montarJurados(app, ctx)
montarPublico(app, ctx, server)
montarVerificacion(app, ctx, server)
```

Para WebSocket, cada módulo registra su path con `registrarUpgrade(server, '/ws/...', manejador)`
(`src/upgrade.ts`). `servidor.ts` es el único que escucha `server.on('upgrade')`. Las claves de Redis se
construyen siempre con `compartido/claves.ts` y los tipos salen de `compartido/contratos.ts`.

## Flujo de ramas

1. `main` está protegida. Nadie hace push directo después del esqueleto.
2. Cada persona crea su rama desde `main`:
   ```bash
   git switch main && git pull
   git switch -c p1-jurados        # Persona 1
   git switch -c p2-publico        # Persona 2
   git switch -c p3-verificacion   # Persona 3
   ```
3. Trabaja solo en sus carpetas. Si necesita cambiar un contrato (`compartido/` o `docs/DISEÑO.md`
   sección 4), avisa a las otras dos y lo incluye en el mismo PR.
4. `git push -u origin <rama>` y abre un PR a `main`. Basta con la revisión de otra persona.
5. Antes del PR: `npm run build && npm test`, y `docker compose up -d --build` en local.
