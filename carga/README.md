# Carga y Simulación de Tráfico — Persona 2

Este directorio contiene las herramientas de prueba de carga, simulación de reconexión con/sin jitter, cliente lento para contrapresión (RF-9) y comparación entre SSE y Polling (secciones 5 y 7 de `docs/DISEÑO.md`).

---

## 1. Configuración de Límites del Sistema (`ulimit`)

Para sostener **20.000+ conexiones concurrentes** desde una o varias máquinas clientes y en los servidores:

### En Linux / macOS

Antes de ejecutar la prueba de carga, el límite por defecto de descriptores de archivos (típicamente 1024) provocará errores `EMFILE: too many open files`. Para elevarlo:

```bash
# Verificar límite actual
ulimit -n

# Elevar a 65.535 en la sesión actual
ulimit -n 65535

# Para persistirlo en el sistema, añadir a /etc/security/limits.conf:
# * soft nofile 65535
# * hard nofile 65535
# * soft nproc 65535
# * hard nproc 65535
```

En `/etc/sysctl.conf` para optimizar sockets efímeros:
```bash
sudo sysctl -w net.ipv4.ip_local_port_range="1024 65535"
sudo sysctl -w net.ipv4.tcp_tw_reuse=1
sudo sysctl -w net.core.somaxconn=65535
```

### En Windows (PowerShell Administrador)

Para permitir suficientes puertos locales de salida efímeros:
```powershell
netsh int ipv4 set dynamicport tcp start=1025 num=64510
```

---

## 2. Ejecución de la Prueba de Carga (`carga/carga.ts`)

La prueba soporta distribución de conexiones entre múltiples portátiles o instancias cliente:

### Parámetros Disponibles

- `--conexiones=N`: Número total de clientes a lanzar (por defecto 20.000, e.g. 7.000 por portátil).
- `--url=http://...`: Destino HTTP (e.g. `http://localhost:3000` o balanceador Nginx `http://<ec2-ip>`).
- `--modo=sse|polling`: Transporte a evaluar.
- `--duracion=S`: Duración en segundos de la fase sostenida (por defecto 30 s).

### Ejemplos de Uso

```bash
# Lanzar 20.000 conexiones SSE en local contra Nginx:
npx tsx carga/carga.ts --conexiones=20000 --url=http://localhost:80 --modo=sse

# Modo polling (evaluación comparativa con GET /api/snapshot y ETag):
npx tsx carga/carga.ts --conexiones=5000 --url=http://localhost:3000 --modo=polling

# Generar solo las curvas de comparación de reconexiones Jitter vs Sin Jitter:
SOLO_GRAFICA=1 npx tsx carga/carga.ts
```

---

## 3. Demostración de Contrapresión (RF-9)

El archivo `carga/cliente-lento.ts` demuestra de forma aislada los dos umbrales de contrapresión del servidor:

```bash
# Caso 1: > 64 KB -> servidor suspende deltas y tras 'drain' envía snapshot
npx tsx carga/cliente-lento.ts drain_snapshot

# Caso 2: > 512 KB -> servidor emite 'event: reconecta' y cierra el socket
npx tsx carga/cliente-lento.ts desconexion_512k
```

---

## 4. Comparación de Transportes: SSE vs Polling

| Métrica | SSE (Ventana 2s + Lotes 500) | Polling (`GET /api/snapshot` + ETag) | Justificación |
|---|---|---|---|
| **Conexiones** | 1 persistente por cliente | Nueva petición HTTP periódica (2s) | SSE mantiene 1 socket; polling satura el handshake TCP / HTTP |
| **Memoria por conexión** | ~10–14 KB / con | ~25–40 KB / con (ráfagas de buffers) | El estado del cliente SSE vive en memoria fija O(1) en el Gestor |
| **Retraso Event Loop (p99)** | **< 30 ms** (acotado con `setImmediate`) | > 80–150 ms bajo ráfagas concurrentes | Polling procesa routers de Express y hashing ETag masivo |
| **Latencia de actualización** | Inmediata en la ventana de 2s | Retrasada hasta el siguiente ciclo (promedio 1s) | SSE hace push en tiempo real; polling depende del intervalo |
| **Ancho de banda / Bytes** | Mínimo: deltas compactos con solo lo que cambió | Alto: headers HTTP repetidos en cada petición (incluso en 304) | SSE no retransmite cabeceras HTTP continuamente |

---

## 5. Salidas Generadas

Las corridas almacenan sus artefactos en `carga/resultados/` (ignorado por Git):
- `reconexiones_con_sin_jitter.csv`: Segundo a segundo, clientes reconectando en tormenta.
- `grafica-reconexiones.html`: Visualización interactiva con Chart.js de la curva con vs sin jitter.
