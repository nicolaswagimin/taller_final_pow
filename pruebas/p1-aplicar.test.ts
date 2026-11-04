// Persona 1 — aplicarActa(ctx, acta, origen): API que usa la Persona 3. Redis del compose, db 13.
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../compartido/contexto.js';
import { aplicarActa, nuevaVersionDesde } from '../src/jurados/aplicar.js';
import { metricas } from '../src/metricas/index.js';
import { sembrar } from '../scripts/semilla.js';
import { catalogo, nuevaActa } from './ayuda/p1.js';

const URL = process.env.REDIS_TEST_URL_APLICAR ?? 'redis://localhost:6379/13';
let ctx: Ctx;
const mesa = catalogo.mesas[2000]!;
const VOTOS = { C1: 50, C2: 40, C3: 30, BLANCO: 3, NULO: 2, NO_MARCADO: 1 };

beforeAll(() => {
  const redis = new Redis(URL);
  ctx = { redis, redisSub: redis, instancia: 'prueba', metricas };
});
beforeEach(async () => {
  await ctx.redis.flushdb();
  await sembrar(ctx.redis);
});
afterAll(async () => {
  await ctx.redis.flushdb();
  await ctx.redis.quit();
});

describe('aplicarActa', () => {
  it('devuelve la respuesta de la tabla 4.3 y su código HTTP', async () => {
    const r = await aplicarActa(ctx, nuevaActa(mesa, 1, VOTOS), 'jurado');
    expect(r.http).toBe(201);
    expect(r.respuesta).toMatchObject({ estado: 'registrada', version: 1 });
  });

  it('la Persona 3 aprueba una dudosa con valores corregidos: versión nueva, idem nuevo, suma', async () => {
    const a = nuevaActa(mesa, 1, VOTOS);
    a.sufragantes = 130; // descuadre de 4
    expect((await aplicarActa(ctx, a, 'jurado')).respuesta.estado).toBe('dudosa');
    expect(await ctx.redis.zscore('cola:verif', a.acta)).toBe('4');

    const corregida = await nuevaVersionDesde(ctx, a.acta, { ...VOTOS, C1: 54 });
    expect(corregida.version).toBe(2);
    expect(corregida.idem).not.toBe(a.idem);
    expect(corregida.sufragantes).toBe(130);

    const r = await aplicarActa(ctx, corregida, 'auditor', 'aprobada por AUD-001');
    expect(r).toMatchObject({ http: 201, respuesta: { estado: 'registrada', version: 2 } });
    expect(await ctx.redis.hget('tot:dep', 'C1')).toBe('54');
    expect(await ctx.redis.zscore('cola:verif', a.acta)).toBeNull();
    expect(await ctx.redis.hget(`acta:${a.acta}`, 'origen')).toBe('auditor');
  });

  it('nuevaVersionDesde falla si el acta no existe', async () => {
    await expect(nuevaVersionDesde(ctx, 'E14-1-0001-03', VOTOS)).rejects.toThrow(/no existe/);
  });

  it('reporta métricas: contadores por estado y latencia del Lua', async () => {
    await aplicarActa(ctx, nuevaActa(mesa, 1, VOTOS), 'jurado');
    const foto = metricas.foto();
    expect(Number(foto.actas_registradas)).toBeGreaterThan(0);
    expect(Number(foto.actas_por_min)).toBeGreaterThan(0);
    expect(Number(foto.lua_p99_ms)).toBeGreaterThan(0);
  });

  it('Redis caído → no_disponible (503), sin lanzar', async () => {
    const caido = new Redis('redis://127.0.0.1:1', { enableOfflineQueue: false, lazyConnect: true, retryStrategy: () => null });
    const r = await aplicarActa({ ...ctx, redis: caido }, nuevaActa(mesa, 1, VOTOS), 'jurado');
    expect(r).toEqual({ http: 503, respuesta: { estado: 'no_disponible' } });
    caido.disconnect();
  });
});
