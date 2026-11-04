# Roles y reparto del trabajo

Complementa a [DISEÑO.md](DISEÑO.md) (la fuente de verdad). Si algo aquí contradice a DISEÑO.md, manda DISEÑO.md.

| Persona | GitHub | Rol | Rama | Etiqueta |
|---|---|---|---|---|
| Persona 1 | [@nicolaswagimin](https://github.com/nicolaswagimin) | Jurados y acumulados | `p1-jurados` | `persona-1` |
| Persona 2 | [@DMaTeoG](https://github.com/DMaTeoG) | Público y difusión | `p2-publico` | `persona-2` |
| Persona 3 | [@Jhoan-Pd](https://github.com/Jhoan-Pd) | Auditores y operación | `p3-verificacion` | `persona-3` |

Cada requisito tiene un issue en GitHub con la etiqueta de su dueño. Cierra el issue desde el PR (`Closes #N`).

---

## Persona 1 — Jurados y acumulados (@nicolaswagimin)

### Le pertenece

- `src/jurados/`
- `lua/aplicar_acta.lua`
- `web/jurado.html`
- `scripts/semilla.ts` (catálogo de mesas en Redis)
- Claves Redis que escribe (tabla 4.4): `cat:*`, `idem:*`, `acta:*`, `tot:*`, `rank:*`, `ev:*`, `pub:mun:*`/`pub:dep`, `rl:*`; agrega a `cola:verif`.

### Requisitos que sustenta (sección 5)

- [ ] **RF-1**: clave `idem` + comparación de versión, ambas dentro del Lua.
- [ ] **RF-2**: gana la versión mayor; versión tardía → `obsoleta`; corrección = revertir la anterior + aplicar la nueva en el mismo script.
- [ ] **RF-3**: un solo `EVALSHA` actualiza los 4 niveles + ranking + stream.
- [ ] **RF-10a (jurado)**: Redis caído → 503 `no_disponible`; el acta queda **pendiente** en la cola local.
- [ ] **Límite de tasa**: `INCR rl:{jurado}:{minuto}`; > 30 → 429 + `Retry-After`.
- [ ] **RT-6**: cola en `localStorage` del jurado; reintento al evento `online` y con backoff; estados visibles: pendiente / enviada / dudosa / contada.

### Pruebas mínimas (sección 6)

- [ ] La misma acta enviada 5 veces suma una vez.
- [ ] Las versiones 1, 3, 2 en ese orden terminan igual que 1, 2, 3.
- [ ] Tras miles de actas aleatorias, la suma de municipios == departamento.
- [ ] Un descuadre deja el acta como dudosa.

### Depende de

- **P3**: `src/servidor.ts` monta `montarJurados(app, ctx)`; `ctx.metricas` para reportar actas por minuto y la latencia.
- **Todos**: los tipos de `compartido/contratos.ts` (`Acta`, `RespuestaPostActa`, `EventoCambio`) y `compartido/claves.ts`.

### Entrega a otros

- **A P3**: exporta `aplicarActa(ctx, acta)` desde `src/jurados/`. P3 lo llama al **aprobar** un acta dudosa con valores corregidos (versión siguiente, `idem` nuevo), así toda escritura de acumulados pasa por un solo lugar (4.7).
- **A P3**: agrega las actas dudosas a `cola:verif` (ZSET acta → prioridad, mayor descuadre primero).
- **A P2**: escribe `ev:mun:{m}` y `ev:dep` (stream, formato 4.6) y publica el id en `pub:mun:{m}` / `pub:dep`.
- **A P2**: mantiene `tot:*`, `rank:*` y `cat:total:*`, que P2 lee para el `Snapshot`.
- **A P2**: el catálogo semilla (`npm run semilla`), que P2 necesita para la prueba de carga.

### Prompt de arranque (pegar en Claude Code, en la rama `p1-jurados`)

```text
Soy la Persona 1 (Jurados y acumulados) del repo taller_final_pow. Estoy en la rama p1-jurados.

1. Lee docs/DISEÑO.md completo y docs/ROLES.md (mi sección).
2. Trabaja SOLO en mis carpetas: src/jurados/, lua/aplicar_acta.lua, web/jurado.html y
   scripts/semilla.ts. No toques src/publico/, src/verificacion/, src/servidor.ts ni la infraestructura.
3. Respeta los contratos de la sección 4 tal cual: usa los tipos de compartido/contratos.ts y las
   claves de compartido/claves.ts (nunca escribas strings de clave a mano). Si un contrato tiene que
   cambiar, detente y dímelo: se cambia por PR que actualice DISEÑO.md.
4. Mi módulo se monta con montarJurados(app, ctx), ctx = { redis, redisSub, instancia, metricas }.
   Si algún día necesito WebSocket, uso registrarUpgrade de src/upgrade.ts; nunca escucho
   server.on('upgrade') yo mismo.
5. Escribe PRIMERO las pruebas de la sección 6 para P1 (vitest, en pruebas/): la misma acta 5 veces
   suma una vez; versiones 1,3,2 == 1,2,3; suma de municipios == departamento tras miles de actas
   aleatorias; descuadre → dudosa. Que fallen, y luego implementa hasta que pasen.
6. Orden: scripts/semilla.ts → lua/aplicar_acta.lua (sección 4.5) → POST /api/actas con las
   respuestas de la tabla 4.3 → GET /api/actas/:acta/estado → límite de tasa → web/jurado.html con
   la cola en localStorage (RT-6). Exporta aplicarActa(ctx, acta) para que la use la Persona 3.
7. Reporta métricas con ctx.metricas.incrementar('actas') y ctx.metricas.registrar(...).
8. Antes de terminar: npm run build, npm test y docker compose up -d --build sin errores.
```

---

## Persona 2 — Público y difusión (@DMaTeoG)

### Le pertenece

- `src/publico/`
- `web/publico.html`
- `carga/` (prueba de carga, simulador de jornada y cliente lento)
- Lee (no escribe) `tot:*`, `rank:*`, `ev:*`; se suscribe a `pub:mun:*` / `pub:dep`.

### Requisitos que sustenta (sección 5)

- [ ] **RF-4**: ventana de 2 s por tópico; un mensaje serializado una vez y escrito en **lotes de 500** conexiones con `await setImmediate` entre lotes; `perf_hooks.monitorEventLoopDelay` (ya en `src/metricas/`). Contador de mensajes emitidos contra el ingenuo (`actas × clientes`).
- [ ] **RF-5**: `Map<tópico, Set<conexión>>` por instancia; la instancia solo se suscribe a `pub:mun:{m}` de los municipios que tiene abiertos.
- [ ] **RF-6**: cursor = id del stream (`Last-Event-ID`); `XRANGE` desde el cursor; si el cursor ya salió de la ventana o faltan más de 500 eventos → `snapshot`.
- [ ] **RF-9**: vigilar `res.writableLength`: > 64 KB → `snapshot` en `drain`; > 512 KB → `event: reconecta` y cerrar. Demostrarlo con un cliente lento en `carga/`.
- [ ] **RF-10a (público)**: Redis caído → evento `estado` `{ degradado: true }` ("datos en pausa desde HH:MM").
- [ ] **RF-10b**: reconexión con backoff exponencial y **full jitter**; bandera `?jitter=0` para la gráfica comparativa.
- [ ] **RT-9**: `publico.html` sin framework, DOM actualizado una vez por `requestAnimationFrame`; medir INP con DevTools (CPU 6×).
- [ ] **RT-7 / RT-8 (carga)**: prueba de carga de la sección 7 (≥ 20.000 SSE, simulador de jornada, CSV, comparación SSE contra polling).

### Pruebas mínimas (sección 6)

- [ ] Un cliente que se desconecta 30 s y vuelve con `Last-Event-ID` queda igual a uno que nunca se desconectó.
- [ ] Un cursor viejo recibe `snapshot`.
- [ ] Un cliente lento recibe `snapshot` o se desconecta.
- [ ] El retraso del Event Loop se mantiene acotado con 2.500+ conexiones por instancia.

### Depende de

- **P1**: los eventos en `ev:mun:{m}` / `ev:dep` (formato 4.6) y los avisos en `pub:mun:{m}` / `pub:dep`; los acumulados `tot:*` / `rank:*`; el catálogo semilla. Mientras P1 no termine, P2 puede escribir eventos de prueba en el stream con el mismo formato.
- **P3**: `src/servidor.ts` monta `montarPublico(app, ctx, server)`; `ctx.metricas` (conexiones `sse`/`polling`, mensajes emitidos); nginx ya tiene `/sse` sin buffer.

### Entrega a otros

- **A P3**: métricas en `met:{instancia}` (conexiones SSE, mensajes emitidos/s, reconexiones/s) que se ven en `tablero.html`.
- **A todos**: el simulador de jornada de `carga/`, que alimenta las demos de P1 (RF-1/2/3) y de P3 (caídas).
- **Al informe**: CSV de mensajes emitidos contra el ingenuo, reconexiones con/sin jitter y comparación SSE contra polling.

### Prompt de arranque (pegar en Claude Code, en la rama `p2-publico`)

```text
Soy la Persona 2 (Público y difusión) del repo taller_final_pow. Estoy en la rama p2-publico.

1. Lee docs/DISEÑO.md completo y docs/ROLES.md (mi sección).
2. Trabaja SOLO en mis carpetas: src/publico/, web/publico.html y carga/. No toques src/jurados/,
   src/verificacion/, src/servidor.ts ni la infraestructura.
3. Respeta los contratos de la sección 4 tal cual: usa los tipos de compartido/contratos.ts
   (Snapshot, MensajeSseDelta, MensajeSse, EventoCambio) y las claves de compartido/claves.ts. Si un
   contrato tiene que cambiar, detente y dímelo: se cambia por PR que actualice DISEÑO.md.
4. Mi módulo se monta con montarPublico(app, ctx, server), ctx = { redis, redisSub, instancia,
   metricas }. Uso ctx.redisSub para SUBSCRIBE. Si necesito WebSocket uso registrarUpgrade de
   src/upgrade.ts; nunca escucho server.on('upgrade') yo mismo.
5. Escribe PRIMERO las pruebas de la sección 6 para P2 (vitest, en pruebas/): reconexión de 30 s con
   Last-Event-ID == cliente que nunca se desconectó; cursor viejo → snapshot; cliente lento →
   snapshot o desconexión; retraso del Event Loop acotado con 2.500+ conexiones. Mientras la Persona 1
   no termine, genera eventos de prueba con XADD en ev:mun:{m} con el formato de la sección 4.6.
6. Orden: GET /api/snapshot (con ETag = seq) → GET /sse con tópicos y Map<tópico, Set<conexión>> →
   ventana de 2 s + lotes de 500 → Last-Event-ID / ?desde= → RF-9 (writableLength) → estado degradado
   → web/publico.html con full jitter (RF-10b) y requestAnimationFrame → carga/.
7. Reporta con ctx.metricas.conexionAbierta('sse') / conexionCerrada('sse') e incrementar(...).
8. Antes de terminar: npm run build, npm test y docker compose up -d --build sin errores.
```

---

## Persona 3 — Auditores y operación (@Jhoan-Pd)

### Le pertenece

- `src/servidor.ts`, `src/upgrade.ts`
- `src/verificacion/`
- `src/metricas/`
- `lua/bloqueos.lua`
- `web/auditor.html`, `web/tablero.html`
- `docker-compose.yml`, `Dockerfile`, `nginx/`, `deploy/`
- Claves Redis (tabla 4.4): `lock:acta:*`, `pub:verif`, `pres:*`, `pres:idx`, `met:*`, `met:idx`; consume `cola:verif`.

### Requisitos que sustenta (sección 5)

- [ ] **RF-7**: `SET lock NX PX 30000` con dueño aleatorio; renovar cada 10 s solo si hubo actividad en los últimos 10 min; renovar/liberar con Lua que compara el dueño.
- [ ] **RF-8**: latido cada 10 s → `pres:{auditor} EX 30` y `pres:idx`; el coordinador ve los latidos de los últimos 30 s.
- [ ] **RF-10a (auditor)**: Redis caído → la consola de auditores deshabilita las acciones.
- [ ] **RT-1**: `GET /api/instancia` → `{ instancia }` (hecho en el esqueleto; falta demostrarlo en EC2).
- [ ] **RT-2**: sin sticky; cualquier instancia atiende cualquier petición porque todo el estado vive en Redis.
- [ ] **RT-7 / RT-8 (métricas)**: cada instancia escribe cada 2 s en `met:{instancia}`; `tablero.html` las muestra todas.
- [ ] Despliegue en EC2 (sección 2) y demo de la caída de Redis y de una instancia.

### Pruebas mínimas (sección 6)

- [ ] Dos auditores en instancias distintas no toman la misma acta.
- [ ] Un bloqueo expirado no puede ser liberado por su antiguo dueño.
- [ ] Un auditor que cierra el navegador desaparece de la presencia en ≤ 30 s.

### Depende de

- **P1**: `aplicarActa(ctx, acta)` exportado desde `src/jurados/` (para reaplicar un acta aprobada con valores corregidos) y las actas dudosas en `cola:verif`.
- **P2**: el simulador de `carga/` para las demos de caída y las métricas de SSE en `met:{instancia}`.

### Entrega a otros

- **A P1 y P2**: `src/servidor.ts` (monta sus módulos), `ctx`, `registrarUpgrade`, `metricas`, `docker-compose.yml` y nginx (ya en `main`).
- **A todos**: `tablero.html` con las métricas de las 8 instancias y la EC2 desplegada para la sustentación.
- **Al informe**: la demo de caída de Redis y de una instancia.

### Prompt de arranque (pegar en Claude Code, en la rama `p3-verificacion`)

```text
Soy la Persona 3 (Auditores y operación) del repo taller_final_pow. Estoy en la rama p3-verificacion.

1. Lee docs/DISEÑO.md completo y docs/ROLES.md (mi sección).
2. Trabaja SOLO en mis carpetas: src/verificacion/, src/metricas/, src/servidor.ts, src/upgrade.ts,
   lua/bloqueos.lua, web/auditor.html, web/tablero.html, docker-compose.yml, Dockerfile, nginx/ y
   deploy/. No toques src/jurados/ ni src/publico/.
3. Respeta los contratos de la sección 4 tal cual: usa WsClienteServidor / WsServidorCliente /
   Presencia de compartido/contratos.ts y las claves de compartido/claves.ts. Si un contrato tiene
   que cambiar, detente y dímelo: se cambia por PR que actualice DISEÑO.md.
4. El WebSocket de /ws/verificacion ya está registrado con registrarUpgrade (src/upgrade.ts) sobre
   un WebSocketServer en modo noServer: sigue así, sin escuchar server.on('upgrade') en otro lugar.
5. Escribe PRIMERO las pruebas de la sección 6 para P3 (vitest, en pruebas/): dos auditores en
   instancias distintas no toman la misma acta; un bloqueo expirado no puede ser liberado por su
   antiguo dueño; un auditor que cierra el navegador desaparece de la presencia en ≤ 30 s.
6. Orden: lua/bloqueos.lua (renovar/liberar comparando dueño) → mensajes tomar/liberar/resolver/
   latido (4.7) → presencia → pub:verif entre instancias → web/auditor.html (deshabilitar acciones
   si Redis cae) → aprobar con aplicarActa de la Persona 1 → despliegue EC2 (deploy/README.md).
7. Reporta con ctx.metricas.conexionAbierta('ws') / conexionCerrada('ws').
8. Antes de terminar: npm run build, npm test y docker compose up -d --build sin errores.
```

---

## Plan de tiempo (sección 8, ≈ 90 min)

| Minuto | Persona 1 | Persona 2 | Persona 3 |
|---|---|---|---|
| 0–10 | leer contratos, catálogo semilla | leer contratos | esqueleto en `main` (servidor, compose, nginx, compartido) |
| 10–55 | `aplicar_acta.lua`, `POST /api/actas`, `jurado.html` | SSE, tópicos, ventana de 2 s, lotes, reconexión | WebSocket, bloqueos, presencia, `auditor.html`, métricas |
| 55–70 | PRs a `main` e integración en local | | lanzar EC2 y desplegar |
| 70–90 | pruebas de RF-1/2/3 en vivo | prueba de carga 20 mil + gráfica jitter | tablero, caída de Redis y de una instancia |

Si falta tiempo se recorta, en este orden: comparación de transportes, cliente lento (RF-9), gráfica sin jitter.

## Reglas

1. **Ningún contrato de la sección 4 se cambia sin un PR que actualice `docs/DISEÑO.md`** en el mismo
   PR y con la etiqueta `contrato`. Avisar a las otras dos personas antes de abrirlo.
2. `main` está protegida: todo entra por **PR con 1 aprobación de otra persona del grupo**. `.github/CODEOWNERS` pide la revisión al dueño de cada carpeta automáticamente, pero su aprobación no es obligatoria (si lo fuera, nadie podría aprobar un PR que solo toca carpetas propias).
3. Cada quien trabaja en su rama (`p1-jurados`, `p2-publico`, `p3-verificacion`) y solo en sus carpetas.
4. Antes de abrir el PR: `npm run build && npm test` y `docker compose up -d --build` en local.
