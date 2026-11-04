// Persona 3 — lua/bloqueos.lua (RF-7). Redis del docker compose, base 12 (P1 usa la 13).
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { claves } from '../compartido/claves.js';
import { liberarLock, renovarLock, tomarLock, valorLock } from '../src/verificacion/bloqueos.js';

const URL = process.env.REDIS_TEST_URL_P3 ?? 'redis://localhost:6379/12';
const ACTA = 'E14-176-0042-03';
let r: Redis;

const presencia = (acta: string | null) => ({ instancia: 'prueba', acta, desde: Date.now() });

async function tomar(auditor: string, opciones: { ttlMs?: number; redis?: Redis } = {}) {
  const valor = valorLock(auditor, randomUUID());
  const res = await tomarLock(opciones.redis ?? r, {
    acta: ACTA,
    auditor,
    valor,
    presencia: presencia(ACTA),
    ttlMs: opciones.ttlMs ?? 30_000,
    presSeg: 30,
  });
  return { valor, res };
}

const esperar = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

beforeAll(() => {
  r = new Redis(URL);
});
beforeEach(async () => {
  await r.flushdb();
  await r.zadd(claves.colaVerif(), 7, ACTA);
});
afterAll(async () => {
  await r.flushdb();
  await r.quit();
});

describe('bloqueos.lua · tomar', () => {
  it('SET NX PX 30000 con valor {auditor}:{token} y actualiza la presencia', async () => {
    const { valor, res } = await tomar('AUD-001');
    expect(res).toEqual({ ok: true });
    expect(valor).toMatch(/^AUD-001:[0-9a-f-]{36}$/);
    expect(await r.get(claves.lock(ACTA))).toBe(valor);
    const pttl = await r.pttl(claves.lock(ACTA));
    expect(pttl).toBeGreaterThan(29_000);
    expect(pttl).toBeLessThanOrEqual(30_000);

    const pres = JSON.parse((await r.get(claves.pres('AUD-001')))!);
    expect(pres).toMatchObject({ instancia: 'prueba', acta: ACTA });
    expect(await r.ttl(claves.pres('AUD-001'))).toBeGreaterThan(25);
    expect(await r.zscore(claves.presIdx(), 'AUD-001')).not.toBeNull();
  });

  it('el segundo auditor recibe ya_tomado con el dueño actual y no toca su presencia', async () => {
    await tomar('AUD-001');
    const { res } = await tomar('AUD-002');
    expect(res).toEqual({ ok: false, motivo: 'ya_tomado', dueno: 'AUD-001' });
    expect(await r.get(claves.pres('AUD-002'))).toBeNull();
  });

  it('un acta que ya no está en cola:verif no se puede tomar', async () => {
    await r.zrem(claves.colaVerif(), ACTA);
    const { res } = await tomar('AUD-001');
    expect(res).toEqual({ ok: false, motivo: 'no_en_cola', dueno: null });
    expect(await r.exists(claves.lock(ACTA))).toBe(0);
  });

  it('20 auditores con conexiones distintas a la vez: exactamente uno lo logra', async () => {
    const clientes = Array.from({ length: 20 }, () => new Redis(URL));
    try {
      const resultados = await Promise.all(
        clientes.map((c, i) => tomar(`AUD-${String(i).padStart(3, '0')}`, { redis: c })),
      );
      expect(resultados.filter((x) => x.res.ok)).toHaveLength(1);
    } finally {
      await Promise.all(clientes.map((c) => c.quit()));
    }
  });
});

describe('bloqueos.lua · renovar', () => {
  it('el dueño renueva (PEXPIRE 30000)', async () => {
    const { valor } = await tomar('AUD-001', { ttlMs: 5_000 });
    expect(await renovarLock(r, ACTA, valor, 30_000)).toBe(true);
    expect(await r.pttl(claves.lock(ACTA))).toBeGreaterThan(29_000);
  });

  it('otro valor (mismo auditor, otro token) no renueva', async () => {
    await tomar('AUD-001', { ttlMs: 5_000 });
    expect(await renovarLock(r, ACTA, valorLock('AUD-001', randomUUID()), 30_000)).toBe(false);
    expect(await r.pttl(claves.lock(ACTA))).toBeLessThanOrEqual(5_000);
  });

  it('un lock expirado no se renueva (no se resucita)', async () => {
    const { valor } = await tomar('AUD-001', { ttlMs: 50 });
    await esperar(120);
    expect(await renovarLock(r, ACTA, valor, 30_000)).toBe(false);
    expect(await r.exists(claves.lock(ACTA))).toBe(0);
  });
});

describe('bloqueos.lua · liberar', () => {
  it('el dueño libera', async () => {
    const { valor } = await tomar('AUD-001');
    expect(await liberarLock(r, ACTA, valor)).toBe('ok');
    expect(await r.exists(claves.lock(ACTA))).toBe(0);
  });

  it('quien no es dueño recibe no_eres_dueno y el lock sigue', async () => {
    const { valor } = await tomar('AUD-001');
    expect(await liberarLock(r, ACTA, valorLock('AUD-002', randomUUID()))).toBe('no_eres_dueno');
    expect(await r.get(claves.lock(ACTA))).toBe(valor);
  });

  it('sección 6: lock expirado y tomado por otro → el antiguo dueño recibe no_eres_dueno', async () => {
    const viejo = await tomar('AUD-001', { ttlMs: 80 });
    await esperar(150); // expiró sin latido
    const nuevo = await tomar('AUD-002');
    expect(nuevo.res.ok).toBe(true);

    expect(await liberarLock(r, ACTA, viejo.valor)).toBe('no_eres_dueno');
    expect(await renovarLock(r, ACTA, viejo.valor, 30_000)).toBe(false);
    expect(await r.get(claves.lock(ACTA))).toBe(nuevo.valor); // el lock del nuevo dueño intacto
  });

  it('sobrevive a SCRIPT FLUSH (NOSCRIPT → se vuelve a cargar)', async () => {
    const { valor } = await tomar('AUD-001');
    await r.script('FLUSH');
    expect(await liberarLock(r, ACTA, valor)).toBe('ok');
  });
});
