// Persona 1 — rutas HTTP de jurados (tablas 4.2 y 4.3). Redis del compose, db 12.
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import express from 'express';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../compartido/contexto.js';
import { montarJurados } from '../src/jurados/index.js';
import { metricas } from '../src/metricas/index.js';
import { sembrar } from '../scripts/semilla.js';
import { catalogo, nuevaActa } from './ayuda/p1.js';

const URL = process.env.REDIS_TEST_URL_RUTAS ?? 'redis://localhost:6379/12';
const VOTOS = { C1: 50, C2: 40, C3: 30, BLANCO: 3, NULO: 2, NO_MARCADO: 1 };
const mesa = catalogo.mesas[3000]!;

async function levantar(ctx: Ctx) {
  const app = express();
  app.use(express.json());
  montarJurados(app, ctx);
  const server = http.createServer(app);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base };
}

let redis: Redis;
let base: string;
let server: http.Server;

const post = (cuerpo: unknown, crudo = false) =>
  fetch(`${base}/api/actas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: crudo ? (cuerpo as string) : JSON.stringify(cuerpo),
  });

beforeAll(async () => {
  redis = new Redis(URL, { enableOfflineQueue: false });
  await new Promise((ok) => redis.once('ready', ok));
  ({ server, base } = await levantar({ redis, redisSub: redis, instancia: 'prueba', metricas }));
});
beforeEach(async () => {
  await redis.flushdb();
  await sembrar(redis);
});
afterAll(async () => {
  server.close();
  await redis.flushdb();
  await redis.quit();
});

describe('POST /api/actas', () => {
  it('la misma acta 5 veces: 201 registrada y luego 200 duplicada con la misma respuesta', async () => {
    const acta = nuevaActa(mesa, 1, VOTOS);
    const res = [];
    for (let i = 0; i < 5; i++) {
      const r = await post(acta);
      res.push({ status: r.status, cuerpo: await r.json() });
    }
    expect(res[0]!.status).toBe(201);
    expect(res[0]!.cuerpo).toMatchObject({ estado: 'registrada', acta: acta.acta, version: 1 });
    for (const r of res.slice(1)) {
      expect(r.status).toBe(200);
      expect(r.cuerpo).toEqual({ ...res[0]!.cuerpo, estado: 'duplicada' });
    }
    expect(await redis.hget('tot:dep', 'C1')).toBe('50');
  });

  it('obsoleta → 200 con version_vigente; dudosa → 202 con motivo', async () => {
    await post(nuevaActa(mesa, 2, VOTOS));
    const r1 = await post(nuevaActa(mesa, 1, VOTOS));
    expect([r1.status, await r1.json()]).toEqual([200, { estado: 'obsoleta', acta: mesa.acta, version_vigente: 2 }]);
    const d = nuevaActa(mesa, 3, VOTOS);
    d.sufragantes += 2;
    const r2 = await post(d);
    expect(r2.status).toBe(202);
    expect(await r2.json()).toMatchObject({ estado: 'dudosa', version: 3, motivo: expect.stringMatching(/descuadre/) });
  });

  it.each([
    ['JSON mal formado', '{"acta": ', true],
    ['sin votos', { ...nuevaActa(mesa, 1, VOTOS), votos: undefined }, false],
    ['votos negativos', nuevaActa(mesa, 1, { ...VOTOS, C1: -1 }), false],
    ['candidato desconocido', { ...nuevaActa(mesa, 1, VOTOS), votos: { ...VOTOS, C9: 1 } }, false],
    ['versión 0', nuevaActa(mesa, 0, VOTOS), false],
    ['id de acta que no corresponde al puesto', nuevaActa(mesa, 1, VOTOS, { acta: 'E14-999999-0001-03' }), false],
    ['mesa inexistente', nuevaActa(mesa, 1, VOTOS, { mesa: 999_999 }), false],
  ])('%s → 400 invalida', async (_n, cuerpo, crudo) => {
    const r = await post(cuerpo, crudo as boolean);
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ estado: 'invalida' });
  });

  it('más de 30 envíos por minuto del mismo jurado → 429 con Retry-After', async () => {
    const acta = nuevaActa(mesa, 1, VOTOS);
    // Evita cruzar el cambio de minuto en medio de la prueba.
    const s = new Date().getSeconds();
    if (s > 55) await new Promise((ok) => setTimeout(ok, (61 - s) * 1000));
    const estados = [];
    for (let i = 0; i < 31; i++) estados.push((await post(acta)).status);
    expect(estados.slice(0, 30).every((x) => x !== 429)).toBe(true);
    const r = await post(acta);
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ estado: 'limite' });
    const ra = Number(r.headers.get('retry-after'));
    expect(ra).toBeGreaterThanOrEqual(1);
    expect(ra).toBeLessThanOrEqual(60);
  }, 15_000);

  it('con Redis detenido devuelve 503 no_disponible', async () => {
    const caido = new Redis('redis://127.0.0.1:1', { enableOfflineQueue: false, lazyConnect: true, retryStrategy: () => null });
    const otro = await levantar({ redis: caido, redisSub: caido, instancia: 'prueba', metricas });
    const r = await fetch(`${otro.base}/api/actas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(nuevaActa(mesa, 1, VOTOS)),
    });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ estado: 'no_disponible' });
    const e = await fetch(`${otro.base}/api/actas/${mesa.acta}/estado`);
    expect(e.status).toBe(503);
    otro.server.close();
    caido.disconnect();
  });
});

describe('GET /api/actas/:acta/estado', () => {
  it('contada, dudosa (con motivo) y no encontrada', async () => {
    await post(nuevaActa(mesa, 1, VOTOS));
    let r = await fetch(`${base}/api/actas/${mesa.acta}/estado`);
    expect(await r.json()).toEqual({ acta: mesa.acta, version_vigente: 1, estado: 'contada' });

    const d = nuevaActa(mesa, 2, VOTOS);
    d.sufragantes += 5;
    await post(d);
    r = await fetch(`${base}/api/actas/${mesa.acta}/estado`);
    expect(await r.json()).toEqual({
      acta: mesa.acta, version_vigente: 2, estado: 'dudosa', motivo: expect.stringMatching(/descuadre/),
    });

    r = await fetch(`${base}/api/actas/E14-1-9999-03/estado`);
    expect(r.status).toBe(404);
  });
});
