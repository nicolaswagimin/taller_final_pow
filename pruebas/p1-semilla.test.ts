// Persona 1 — catálogo y semilla. Corre contra el Redis del docker compose (db 14, aislada).
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generarCatalogo, TOTAL_MESAS, TOTAL_MUNICIPIOS, TOTAL_PUESTOS } from '../scripts/catalogo.js';
import { sembrar } from '../scripts/semilla.js';

const URL = process.env.REDIS_TEST_URL_SEMILLA ?? 'redis://localhost:6379/14';
let redis: Redis;

async function volcarCatalogo(r: Redis): Promise<Record<string, unknown>> {
  const todas: string[] = [];
  let cursor = '0';
  do {
    const [sig, claves] = await r.scan(cursor, 'MATCH', 'cat:*', 'COUNT', 2000);
    cursor = sig;
    todas.push(...claves);
  } while (cursor !== '0');
  const pipe = r.pipeline();
  // cat:mesa:* son HASH; cat:total:* son STRING.
  for (const k of todas) k.startsWith('cat:mesa:') ? pipe.hgetall(k) : pipe.get(k);
  const res = (await pipe.exec()) ?? [];
  const salida: Record<string, unknown> = {};
  todas.forEach((k, i) => (salida[k] = res[i]![1]));
  return salida;
}

beforeAll(async () => {
  redis = new Redis(URL);
  await redis.flushdb();
});
afterAll(async () => {
  await redis.flushdb();
  await redis.quit();
});

describe('catálogo sintético', () => {
  const cat = generarCatalogo();

  it('tiene 40 municipios, 1.842 puestos y 6.400 mesas', () => {
    expect(cat.municipios).toHaveLength(TOTAL_MUNICIPIOS);
    expect(cat.municipios.flatMap((m) => m.puestos)).toHaveLength(TOTAL_PUESTOS);
    expect(cat.mesas).toHaveLength(TOTAL_MESAS);
    expect([TOTAL_MUNICIPIOS, TOTAL_PUESTOS, TOTAL_MESAS]).toEqual([40, 1842, 6400]);
  });

  it('es determinista', () => {
    expect(generarCatalogo()).toEqual(cat);
  });

  it('todo puesto tiene al menos una mesa y los ids son únicos', () => {
    for (const m of cat.municipios) for (const p of m.puestos) expect(p.mesas.length).toBeGreaterThan(0);
    expect(new Set(cat.mesas.map((x) => x.mesa)).size).toBe(TOTAL_MESAS);
    expect(new Set(cat.mesas.map((x) => x.acta)).size).toBe(TOTAL_MESAS);
  });

  it('está repartido de forma desigual: pocos municipios grandes concentran la mayoría', () => {
    const tam = cat.municipios.map((m) => m.mesas).sort((a, b) => b - a);
    const top5 = tam.slice(0, 5).reduce((a, b) => a + b, 0);
    expect(top5 / TOTAL_MESAS).toBeGreaterThan(0.5);
    expect(tam[0]! / tam[tam.length - 1]!).toBeGreaterThan(20);
  });
});

describe('semilla en Redis', () => {
  it('escribe cat:mesa:{mesa} y cat:total:dep|mun|pue', async () => {
    await sembrar(redis);
    expect(await redis.get('cat:total:dep')).toBe('6400');
    const cat = generarCatalogo();
    const m = cat.mesas[1234]!;
    expect(await redis.hgetall(`cat:mesa:${m.mesa}`)).toEqual({
      puesto: String(m.puesto),
      municipio: String(m.municipio),
    });
    let sumaMun = 0;
    for (const mun of cat.municipios) {
      const total = Number(await redis.get(`cat:total:mun:${mun.id}`));
      expect(total).toBe(mun.mesas);
      sumaMun += total;
      for (const p of mun.puestos) expect(Number(await redis.get(`cat:total:pue:${p.id}`))).toBe(p.mesas.length);
    }
    expect(sumaMun).toBe(6400);
  });

  it('es idempotente: correrla dos veces da lo mismo', async () => {
    const primera = await volcarCatalogo(redis);
    await sembrar(redis);
    const segunda = await volcarCatalogo(redis);
    expect(Object.keys(primera)).toHaveLength(6400 + 1842 + 40 + 1);
    expect(segunda).toEqual(primera);
  });
});
