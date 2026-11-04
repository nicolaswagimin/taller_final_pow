# Preconteo electoral en tiempo real — Diseño y contratos

Taller de WebSockets · Programación Orientada a la Web · Grupo de 3 personas.

Este documento es **la fuente de verdad compartida**. Cada persona implementa su parte como quiera
(con Claude Code o a mano), pero **no cambia un contrato de la sección 4 sin avisar a las otras dos**
y actualizar este archivo en el mismo PR.

---

## 1. Qué construimos

Un preconteo: los jurados transmiten actas, el sistema acumula en 4 niveles (mesa, puesto, municipio,
departamento) y difunde a tres audiencias con garantías distintas, repartidas en **8 instancias Node sin
sesiones pegajosas** que solo se coordinan a través de **Redis**.

| Audiencia | Volumen | Transporte | Por qué (a confirmar con mediciones, sección 7) |
|---|---|---|---|
| Jurados | 6.400, red móvil mala | **HTTP POST** idempotente + cola local; estado de actas dudosas por **polling** cada 15 s | Petición/respuesta da la "respuesta inequívoca" de RF-1; sobrevive a cortes sin mantener conexión abierta |
| Auditores | 120 + coordinador | **WebSocket** | Bidireccional y colaborativo: tomar, liberar, ver a los demás en vivo |
| Público | hasta 400.000 | **SSE** | Una sola dirección; el navegador reconecta solo y envía `Last-Event-ID`, que usamos como cursor de continuidad (RF-6) |

Así coexisten los tres transportes (RT-5 exige al menos dos).

### Supuestos (no están en el enunciado)

- Una sola corporación; el id de acta es `E14-{puesto}-{mesa}-{corporacion}`.
- Catálogo sintético: 40 municipios, 1.842 puestos, 6.400 mesas, candidatos `C1..C3`, `BLANCO`, `NULO`, `NO_MARCADO`.
- La sección 7 del enunciado (qué medir) no fue entregada; medimos lo que pide RT-7 (sección 7 de este documento).
- Un acta **dudosa no suma** al acumulado hasta que un auditor la aprueba.

---

## 2. Despliegue (costo < 1 USD)

Una sola EC2 `t3.medium` (2 vCPU, 4 GB) con Docker Compose:

```
Internet ──► :80 nginx (round-robin, SIN ip_hash / sticky)
                 ├─► app ×8 (Node/TS, misma imagen, HOSTNAME = id de instancia)
                 └─► redis:7 (un solo nodo)
```

- Sin ElastiCache, ALB ni NAT Gateway (cobran por hora). Presupuesto AWS Budgets de 5 USD con alerta.
- Security group: 80 abierto, 22 solo a la IP del grupo. URL pública: `http://<ip-publica>` (o `http://<ip>.sslip.io`).
- **Terminar** (no solo detener) la instancia después de la sustentación.
- nginx: `proxy_buffering off` en `/sse`, cabeceras `Upgrade` en `/ws`, `proxy_read_timeout 1h`,
  `worker_connections` ≥ 65535; sysctl/ulimit de descriptores altos en el host.
- Camino a producción (para el informe, no se implementa): ALB + ECS Fargate ×8 + ElastiCache; 400.000
  clientes ≈ 50.000 por instancia exigen varias máquinas.

---

## 3. Estructura del repositorio y dueños

```
preconteo/
├── docs/DISEÑO.md              ← todos (cambios por PR)
├── compartido/                 ← todos: contratos.ts (tipos), redis.ts (cliente), claves.ts
├── src/
│   ├── servidor.ts             ← Persona 3 (arranca HTTP, monta rutas de los 3 módulos)
│   ├── jurados/                ← Persona 1
│   ├── publico/                ← Persona 2
│   ├── verificacion/           ← Persona 3
│   └── metricas/               ← Persona 3 (cada módulo reporta con metricas.registrar(...))
├── lua/                        ← Persona 1 (aplicar_acta.lua) y Persona 3 (bloqueos.lua)
├── web/
│   ├── jurado.html             ← Persona 1
│   ├── publico.html            ← Persona 2
│   ├── auditor.html            ← Persona 3
│   └── tablero.html            ← Persona 3
├── carga/                      ← Persona 2 (prueba de carga y simulador de jornada)
├── scripts/semilla.ts          ← Persona 1 (carga catálogo de mesas en Redis)
├── docker-compose.yml, nginx/  ← Persona 3
└── deploy/                     ← Persona 3 (user-data / script EC2)
```

### Flujo de GitHub

- `main` protegida; cada persona trabaja en su rama (`p1-jurados`, `p2-publico`, `p3-verificacion`) y
  abre PR. Basta con que otra persona lo revise.
- **Minuto 0–10:** la Persona 3 sube el esqueleto (`servidor.ts`, `compartido/`, `docker-compose.yml`,
  nginx) a `main` para que los otros dos ramifiquen de ahí. Mientras tanto P1 y P2 leen este documento.
- Cada módulo exporta una sola función de montaje: `montarJurados(app, ctx)`, `montarPublico(app, ctx)`,
  `montarVerificacion(app, ctx)`, donde `ctx = { redis, redisSub, instancia, metricas }`.
- Cada quien prueba en local con `docker compose up` contra el mismo Redis.

---

## 4. Contratos (lo que NO se cambia sin acuerdo)

### 4.1 Acta (entrada del jurado)

```json
{ "acta": "E14-176-0042-03", "mesa": 4201, "puesto": 176, "municipio": 11,
  "version": 1, "jurado": "JUR-88134", "ts_cierre": 1793577600,
  "votos": { "C1": 184, "C2": 97, "C3": 311, "BLANCO": 22, "NULO": 9, "NO_MARCADO": 4 },
  "sufragantes": 627, "hash_foto": "9f2c...", "idem": "8f14e45fceea167a" }
```

Regla contable: `suma(votos) == sufragantes`. Si no cuadra → dudosa.

### 4.2 Endpoints HTTP

| Método y ruta | Dueño | Respuesta |
|---|---|---|
| `POST /api/actas` | P1 | ver tabla 4.3 |
| `GET /api/actas/:acta/estado` | P1 | `{ acta, version_vigente, estado: "contada"\|"dudosa"\|"rechazada", motivo? }` (polling del jurado) |
| `GET /api/snapshot?topico=dep\|mun:11\|pue:176` | P2 | `Snapshot` (4.5), con `ETag` = `seq` (sirve también de transporte por polling para comparar) |
| `GET /sse?topico=...` (+ `Last-Event-ID` o `?desde=`) | P2 | flujo SSE (4.6) |
| `GET /ws/verificacion?auditor=AUD-001` (upgrade) | P3 | WebSocket (4.7) |
| `GET /api/instancia` | P3 | `{ instancia }` (RT-1) |
| `GET /api/metricas` | P3 | métricas de todas las instancias, leídas de Redis |
| `GET /salud` | P3 | 200, o 503 si Redis no responde |

### 4.3 Respuestas de `POST /api/actas` (RF-1, siempre inequívocas)

| HTTP | `estado` | Significado |
|---|---|---|
| 201 | `registrada` | Se aplicó esta versión. Incluye `{ acta, version, seq }` |
| 200 | `duplicada` | Ya se había recibido este `idem` (o esta misma versión). Devuelve la **misma** respuesta original |
| 200 | `obsoleta` | Ya hay una versión mayor aplicada. Incluye `version_vigente` |
| 202 | `dudosa` | Registrada pero no suma: va a verificación. Incluye `motivo` |
| 400 | `invalida` | JSON mal formado o mesa inexistente |
| 429 | `limite` | Más de 30 envíos por minuto por jurado. Cabecera `Retry-After` |
| 503 | `no_disponible` | Redis no responde. **El jurado debe dejar el acta como "pendiente" y reintentar** (RF-10) |

Caída entre registrar y confirmar: el registro y la clave `idem` se escriben **en el mismo script Lua**;
el reintento del jurado recibe `duplicada` con la respuesta original, así que nunca suma dos veces y el
jurado siempre termina sabiendo el resultado.

### 4.4 Claves de Redis

Un solo nodo. (En Redis Cluster el script atómico exigiría que todas las claves compartan slot con
hash tags; lo anotamos como restricción.)

| Clave | Tipo | Dueño | Contenido / expiración |
|---|---|---|---|
| `cat:mesa:{mesa}` | HASH | P1 | `puesto`, `municipio` (catálogo) |
| `cat:total:dep`, `cat:total:mun:{m}`, `cat:total:pue:{p}` | STRING | P1 | número de mesas del nivel |
| `idem:{idem}` | STRING | P1 | JSON de la respuesta original. `EX 86400`. Si expira antes del reintento, la comparación de versiones de `acta:*` sigue evitando el doble conteo |
| `acta:{acta}` | HASH | P1 | `version`, `estado`, `votos` (JSON), `mesa`, `puesto`, `municipio`, `jurado` |
| `tot:dep`, `tot:mun:{m}`, `tot:pue:{p}`, `tot:mesa:{mesa}` | HASH | P1 escribe, P2 lee | candidato → votos; campo `_informadas` = mesas informadas |
| `rank:dep`, `rank:mun:{m}`, `rank:pue:{p}` | ZSET | P1 escribe, P2 lee | candidato → votos (ranking con `ZREVRANGE`, sin recorrer) |
| `ev:dep`, `ev:mun:{m}` | STREAM | P1 escribe (dentro del Lua), P2 lee | historial de cambios, `XADD ... MAXLEN ~ 2000` (dep: `~ 10000`). El id del stream es el `seq` |
| `pub:mun:{m}`, `pub:dep` | canal pub/sub | P1 publica, P2 suscribe | mensaje = id del stream recién escrito (solo **aviso**; la memoria es el stream) |
| `cola:verif` | ZSET | P1 agrega, P3 consume | acta → prioridad (mayor descuadre primero) |
| `lock:acta:{acta}` | STRING | P3 | `"{auditor}:{token-aleatorio}"`, `PX 30000` |
| `pub:verif` | canal | P3 | eventos de la cola (4.7) |
| `pres:{auditor}` | STRING | P3 | JSON `{ instancia, acta, desde }`, `EX 30` |
| `pres:idx` | ZSET | P3 | auditor → último latido (ms) |
| `rl:{jurado}:{minuto}` | STRING | P1 | `INCR` + `EXPIRE 60` |
| `met:{instancia}` | HASH | P3 (todos reportan) | métricas, `EX 10`; índice `met:idx` (SET) |

### 4.5 Script atómico `aplicar_acta.lua` (RF-1, RF-2, RF-3) — P1

En **una sola ejecución** (Redis ejecuta el script sin intercalar otros comandos; con varios comandos
desde la app, un lector podría ver el municipio actualizado y el puesto todavía no):

1. Si existe `idem:{idem}` → devolver su contenido (`duplicada`).
2. Leer `acta:{acta}.version`. Si `nueva <= vigente` → `obsoleta` (o `duplicada` si es igual). Así el
   resultado depende solo del conjunto de actas: **gana siempre la versión mayor**, sin importar el orden.
3. Si no cuadra la regla contable → guardar el acta con `estado=dudosa`, `ZADD cola:verif`; si había una
   versión contada anterior, se revierte (pasa a no sumar) y se emite el evento. Responder `dudosa`.
4. Si no: restar los votos de la versión anterior (si estaba contada) y sumar los nuevos con `HINCRBY` y
   `ZINCRBY` en mesa, puesto, municipio y departamento; si es la primera vez que la mesa informa,
   `HINCRBY _informadas 1` en los cuatro niveles.
5. `XADD ev:mun:{m}` y `XADD ev:dep` con el evento (4.6); `PUBLISH` de los avisos.
6. `SET idem:{idem} <respuesta> EX 86400`. Devolver `registrada` con `seq`.

Restricciones que impone Lua y que el informe debe mencionar: bloquea Redis mientras corre (debe ser
corto), las claves deben declararse en `KEYS`, no hay rollback si falla a la mitad (validar todo antes de escribir).

### 4.6 Evento de cambio (stream y SSE) — P1 lo produce, P2 lo difunde

Entrada del stream `ev:mun:{m}` (campos de texto):

```
tipo=aplicada|correccion|reversion   acta=E14-...   version=2   mesa=4201   puesto=176   municipio=11
delta={"C1":-3,"C2":+5}   informadas=1|0   ts_recibido=<ms>   motivo=<texto si es corrección>
```

Lo que recibe el público por SSE (un mensaje por **ventana de 2 s** y por tópico, nunca uno por acta):

```
id: <id del stream del último evento incluido>
event: delta            (o "snapshot", "estado", "reconecta")
retry: <ms aleatorio 1000–5000, distinto por conexión>
data: {"topico":"mun:11","seq":"1730000000000-0","delta":{"C1":180,"C2":92},
       "informadas":12,"total_mesas":160,"correcciones":[{"acta":"E14-...","motivo":"..."}]}
```

- `correcciones` es la explicación obligatoria cuando un número baja ("el número nunca retrocede sin explicación").
- `snapshot`: `{ topico, seq, totales, ranking, informadas, total_mesas }`; se envía al conectar sin cursor,
  si el cursor ya salió de la ventana del stream, o a un cliente lento al ponerse al día (RF-9).
- `estado`: `{ degradado: true|false }` cuando Redis cae o vuelve (RF-10).
- Tópico `pue:{p}`: P2 lo deriva filtrando el stream del municipio al que pertenece el puesto.

### 4.7 Protocolo WebSocket de verificación — P3

Cliente → servidor: `{"t":"tomar","acta":...}`, `{"t":"latido","activo":true|false}`,
`{"t":"resolver","acta":...,"decision":"aprobar"|"rechazar","votos"?:{...}}`, `{"t":"liberar","acta":...}`.

Servidor → cliente: `{"t":"cola","items":[...]}`, `{"t":"tomado","acta":...,"auditor":...}`,
`{"t":"liberado","acta":...}`, `{"t":"resuelto","acta":...}`, `{"t":"presencia","auditores":[...]}`,
`{"t":"error","motivo":"ya_tomado"|"no_eres_dueno"}`.

Al **aprobar** un acta dudosa con valores corregidos, P3 la reaplica llamando al mismo `aplicar_acta`
(versión siguiente, `idem` nuevo) — así toda escritura de acumulados pasa por un solo lugar.

---

## 5. Decisiones por requisito

| Req. | Decisión | Dueño |
|---|---|---|
| RF-1 | Clave `idem` + comparación de versión, ambas dentro del Lua | P1 |
| RF-2 | Gana la versión mayor; versión tardía → `obsoleta`; corrección = revertir anterior + aplicar nueva en el mismo script | P1 |
| RF-3 | Un solo `EVALSHA` actualiza los 4 niveles + ranking + stream | P1 |
| RF-4 | Ventana de 2 s por tópico; un mensaje serializado una vez y escrito en **lotes de 500** conexiones con `await setImmediate` entre lotes; `perf_hooks.monitorEventLoopDelay` reporta p50/p99/máx. Contador de mensajes emitidos contra el ingenuo (`actas × clientes`) | P2 |
| RF-5 | `Map<tópico, Set<conexión>>` por instancia: alta/baja O(1), recorrido O(suscriptores del tópico). La instancia solo se suscribe a `pub:mun:{m}` de los municipios que tiene abiertos (canal por municipio en vez de global: el tráfico entre instancias escala con lo que cada una necesita) | P2 |
| RF-6 | Cursor = id del stream (`Last-Event-ID`). Al reconectar: `XRANGE` desde el cursor → deltas agregados; si el cursor es anterior al primer id retenido o faltan más de 500 eventos → `snapshot`. Retención `MAXLEN ~ 2000` por municipio ≈ 2000 × ~300 B ≈ 0,6 MB × 40 ≈ 24 MB. La instancia que pierde avisos de pub/sub se recupera igual leyendo el stream desde su último id procesado | P2 |
| RF-7 | `SET lock NX PX 30000` con dueño aleatorio; la consola renueva cada 10 s **solo si hubo actividad del auditor en los últimos 10 min** (resuelve la tensión: quien trabaja nunca pierde el caso, quien se fue a almorzar lo libera). Renovar y liberar con Lua que compara el dueño (`GET == mi_valor` antes de `PEXPIRE`/`DEL`), así un auditor tardío no libera el bloqueo de otro | P3 |
| RF-8 | Latido cada 10 s → `pres:{auditor} EX 30` y `pres:idx`; el coordinador lista los latidos de los últimos 30 s; un portátil sin batería desaparece solo | P3 |
| RF-9 | En SSE se vigila `res.writableLength`: > 64 KB → dejar de mandar deltas a esa conexión y mandar `snapshot` en el evento `drain`; > 512 KB → `event: reconecta` y cerrar. Demostrar con un cliente que lee lento a propósito (en `carga/`) | P2 |
| RF-10a | Redis caído (cliente con `enableOfflineQueue: false` y timeout de 500 ms): jurado recibe 503 y queda **pendiente** en su cola local; público recibe `estado degradado` ("datos en pausa desde HH:MM"); consola de auditores deshabilita acciones | P1 (jurado), P2 (público), P3 (auditor) |
| RF-10b | Reconexión con backoff exponencial y **full jitter**: `espera = random(0, min(30 s, 1 s × 2^intento))`; bandera `?jitter=0` para la gráfica comparativa. Prueba: `docker stop` de una instancia con clientes conectados | P2 |
| Límite de tasa | `INCR rl:{jurado}:{minuto}`; > 30 → 429 + `Retry-After` | P1 |
| RT-2 | Sin sticky: cualquier instancia atiende cualquier petición porque todo el estado vive en Redis. Evita instancias desbalanceadas y facilita sobrevivir a una caída; a cambio, la reconexión SSE cae en otra instancia (por eso el cursor) y el WebSocket del auditor no puede guardar estado local importante | P3 |
| RT-6 | Cola en `localStorage` del jurado; reintento al evento `online` y con backoff; estados visibles: pendiente / enviada / dudosa / contada | P1 |
| RT-9 | `publico.html` sin framework, actualización del DOM una vez por `requestAnimationFrame`; medir INP con DevTools (throttling CPU 6×) | P2 |

---

## 6. Pruebas mínimas por persona

- **P1:** el mismo acta enviada 5 veces suma una vez; versiones 1, 3, 2 en ese orden terminan igual
  que 1, 2, 3; la suma de municipios == departamento tras miles de actas aleatorias; descuadre → dudosa.
- **P2:** cliente que se desconecta 30 s y vuelve con `Last-Event-ID` queda igual a uno que nunca se
  desconectó; cursor viejo → snapshot; cliente lento → snapshot o desconexión; retraso del Event Loop acotado con 2.500+ conexiones por instancia.
- **P3:** dos auditores en instancias distintas no toman la misma acta; bloqueo expirado no puede ser
  liberado por su antiguo dueño; auditor que cierra el navegador desaparece de la presencia en ≤ 30 s.

---

## 7. Mediciones (RT-7, RT-8 y justificación de transportes)

Cada instancia escribe cada 2 s en `met:{instancia}`: conexiones por tipo, mensajes emitidos por segundo,
retraso del Event Loop (p50/p99/máx), memoria por conexión (`rss` / conexiones), actas por minuto,
latencia recepción→publicación (p50/p99, usando `ts_recibido`), reconexiones por segundo. `tablero.html`
las muestra todas.

Prueba de carga (`carga/`, P2), ejecutable desde los 3 portátiles a la vez:
- ≥ 20.000 conexiones SSE repartidas por municipio (unos pocos municipios grandes concentran la mayoría).
- Simulador de jornada comprimido (2 h → 10 min): 55 % de las actas en el primer tercio, ráfagas de 300,
  4–11 % de reenvíos, ~180 correcciones con versiones fuera de orden, 6–9 % de dudosas.
- Salida CSV: mensajes emitidos contra el ingenuo, reconexiones/s con y sin jitter.
- Comparación de transportes para el público con la misma carga: SSE contra polling de `/api/snapshot`
  (con `ETag`), midiendo memoria por conexión, CPU, retraso del Event Loop, latencia y bytes transferidos.

---

## 8. Plan de tiempo (≈ 90 min)

| Minuto | Persona 1 | Persona 2 | Persona 3 |
|---|---|---|---|
| 0–10 | leer contratos, catálogo semilla | leer contratos | esqueleto en `main` (servidor, compose, nginx, compartido) |
| 10–55 | `aplicar_acta.lua`, `POST /api/actas`, `jurado.html` | SSE, tópicos, ventana de 2 s, lotes, reconexión | WebSocket, bloqueos, presencia, `auditor.html`, métricas |
| 55–70 | PRs a `main` e integración en local | | lanzar EC2 y desplegar |
| 70–90 | pruebas de RF-1/2/3 en vivo | prueba de carga 20 mil + gráfica jitter | tablero, caída de Redis y de una instancia |

Si falta tiempo se recorta, en este orden: comparación de transportes, cliente lento (RF-9), gráfica sin jitter.
