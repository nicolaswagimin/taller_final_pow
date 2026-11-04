/**
 * Punto de entrada — Persona 3.
 * Arranca HTTP, monta las rutas de los 3 módulos y enruta los upgrades WebSocket.
 */
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { redis, redisSub, redisDisponible, cerrarRedis } from '../compartido/redis.js';
import type { Ctx } from '../compartido/contexto.js';
import type { RespuestaInstancia } from '../compartido/contratos.js';
import { metricas, montarMetricas } from './metricas/index.js';
import { enrutarUpgrades, cerrarUpgrades } from './upgrade.js';
import { montarJurados } from './jurados/index.js';
import { montarPublico } from './publico/index.js';
import { montarVerificacion } from './verificacion/index.js';

const PUERTO = Number(process.env.PORT ?? 3000);
const instancia = process.env.HOSTNAME ?? `local-${process.pid}`;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const server = http.createServer(app);
const ctx: Ctx = { redis, redisSub, instancia, metricas };

// Cabecera útil para ver qué instancia atendió cada petición (RT-1/RT-2).
app.use((_req, res, next) => {
  res.setHeader('X-Instancia', instancia);
  next();
});

app.get('/api/instancia', (_req, res) => {
  const cuerpo: RespuestaInstancia = { instancia };
  res.json(cuerpo);
});

app.get('/salud', async (_req, res) => {
  let ok = redisDisponible();
  if (ok) {
    try {
      ok = (await redis.ping()) === 'PONG';
    } catch {
      ok = false;
    }
  }
  res.status(ok ? 200 : 503).json({ instancia, redis: ok ? 'ok' : 'caido' });
});

montarMetricas(app, redis);

enrutarUpgrades(server);
montarJurados(app, ctx);
montarPublico(app, ctx, server);
montarVerificacion(app, ctx, server);

app.use(express.static(path.resolve(process.cwd(), 'web'), { extensions: ['html'] }));

metricas.iniciar(redis, instancia);

server.listen(PUERTO, () => {
  console.log(`[${instancia}] escuchando en :${PUERTO}`);
});

// --- Cierre ordenado ---
let cerrando = false;
async function cerrar(senal: string): Promise<void> {
  if (cerrando) return;
  cerrando = true;
  console.log(`[${instancia}] ${senal}: cerrando`);
  metricas.detener();
  server.close();
  cerrarUpgrades();
  server.closeIdleConnections();
  const forzar = setTimeout(() => server.closeAllConnections(), 5_000);
  forzar.unref();
  await cerrarRedis();
  setTimeout(() => process.exit(0), 100).unref();
}
process.on('SIGTERM', () => void cerrar('SIGTERM'));
process.on('SIGINT', () => void cerrar('SIGINT'));
