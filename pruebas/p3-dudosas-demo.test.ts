// Persona 3 — scripts/dudosas-demo.ts. Redis db 12.
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { claves } from '../compartido/claves.js';
import { CANDIDATOS } from '../compartido/contratos.js';
import { sembrarDudosas } from '../scripts/dudosas-demo.js';

const URL = process.env.REDIS_TEST_URL_P3 ?? 'redis://localhost:6379/12';
let r: Redis;

beforeAll(() => {
  r = new Redis(URL);
});
beforeEach(async () => {
  await r.flushdb();
});
afterAll(async () => {
  await r.flushdb();
  await r.quit();
});

describe('dudosas-demo', () => {
  it('inserta 10 actas dudosas en cola:verif y acta:* con descuadre como prioridad', async () => {
    const actas = await sembrarDudosas(r);
    expect(actas).toHaveLength(10);
    expect(await r.zcard(claves.colaVerif())).toBe(10);
    for (const a of actas) {
      const h = await r.hgetall(claves.acta(a.acta));
      expect(h).toMatchObject({ estado: 'dudosa', version: '1', mesa: String(a.mesa) });
      const votos = JSON.parse(h.votos!);
      const suma = CANDIDATOS.reduce((s, c) => s + votos[c], 0);
      expect(Math.abs(suma - Number(h.sufragantes))).toBe(a.descuadre);
      expect(a.descuadre).toBeGreaterThan(0); // no cuadra → dudosa
      expect(Number(await r.zscore(claves.colaVerif(), a.acta))).toBe(a.descuadre);
      expect(await r.exists(claves.catMesa(a.mesa))).toBe(1);
    }
  });

  it('es idempotente: volver a correrla no duplica y borra los locks viejos', async () => {
    const [primera] = await sembrarDudosas(r);
    await r.set(claves.lock(primera!.acta), 'AUD-001:x', 'PX', 30_000);
    await r.zadd(claves.colaVerif(), 3, 'E14-176-0042-03'); // un acta real no se toca
    await sembrarDudosas(r);
    expect(await r.zcard(claves.colaVerif())).toBe(11);
    expect(await r.exists(claves.lock(primera!.acta))).toBe(0);
  });
});
