// Persona 1 — lua/aplicar_acta.lua (secciones 4.3–4.6 y 6). Redis del docker compose, db 15 (aislada).
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CANDIDATOS, type RespuestaPostActa } from '../compartido/contratos.js';
import { ejecutarAplicarActa } from '../src/jurados/script.js';
import { sembrar } from '../scripts/semilla.js';
import { prng } from '../scripts/catalogo.js';
import { catalogo, estadoAcumulado, nuevaActa } from './ayuda/p1.js';

const URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379/15';
let redis: Redis;
const aplicar = (a: Parameters<typeof ejecutarAplicarActa>[1], motivo = '') =>
  ejecutarAplicarActa(redis, a, { tsRecibido: Date.now(), origen: 'jurado', motivo });

async function limpiar() {
  await redis.flushdb();
  await sembrar(redis);
}

beforeAll(async () => {
  redis = new Redis(URL);
});
beforeEach(limpiar);
afterAll(async () => {
  await redis.flushdb();
  await redis.quit();
});

const mesa = catalogo.mesas[100]!;
const VOTOS = { C1: 184, C2: 97, C3: 311, BLANCO: 22, NULO: 9, NO_MARCADO: 4 };

describe('RF-1: idempotencia', () => {
  it('la misma acta enviada 5 veces suma una sola vez y las 5 respuestas son inequívocas', async () => {
    const acta = nuevaActa(mesa, 1, VOTOS);
    const respuestas: RespuestaPostActa[] = [];
    for (let i = 0; i < 5; i++) respuestas.push(await aplicar(acta));

    const [primera, ...resto] = respuestas;
    expect(primera).toMatchObject({ estado: 'registrada', acta: acta.acta, version: 1 });
    const seq = (primera as { seq: string }).seq;
    expect(seq).toMatch(/^\d+-\d+$/);
    for (const r of resto) expect(r).toEqual({ estado: 'duplicada', acta: acta.acta, version: 1, seq });

    for (const k of [`tot:mesa:${mesa.mesa}`, `tot:pue:${mesa.puesto}`, `tot:mun:${mesa.municipio}`, 'tot:dep']) {
      const h = await redis.hgetall(k);
      expect(Number(h.C1)).toBe(184);
      expect(Number(h._informadas)).toBe(1);
    }
    expect(await redis.xlen(`ev:mun:${mesa.municipio}`)).toBe(1);
    expect(await redis.xlen('ev:dep')).toBe(1);
  });

  it('la misma versión con otro idem también es duplicada (no suma)', async () => {
    const r1 = await aplicar(nuevaActa(mesa, 1, VOTOS));
    const r2 = await aplicar(nuevaActa(mesa, 1, VOTOS));
    expect(r2).toEqual({ ...r1, estado: 'duplicada' });
    expect(await redis.hget('tot:dep', 'C1')).toBe('184');
  });

  it('guarda idem:{idem} con EX 86400', async () => {
    const acta = nuevaActa(mesa, 1, VOTOS);
    await aplicar(acta);
    const ttl = await redis.ttl(`idem:${acta.idem}`);
    expect(ttl).toBeGreaterThan(86_000);
    expect(ttl).toBeLessThanOrEqual(86_400);
  });

  it('un reintento con el mismo idem tras SCRIPT FLUSH (NOSCRIPT) sigue siendo duplicada', async () => {
    const acta = nuevaActa(mesa, 1, VOTOS);
    const r1 = await aplicar(acta);
    await redis.script('FLUSH');
    expect(await aplicar(acta)).toEqual({ ...r1, estado: 'duplicada' });
  });
});

describe('RF-2: gana la versión mayor', () => {
  const v1 = { C1: 10, C2: 20, C3: 30, BLANCO: 1, NULO: 1, NO_MARCADO: 1 };
  const v2 = { C1: 12, C2: 18, C3: 30, BLANCO: 1, NULO: 1, NO_MARCADO: 1 };
  const v3 = { C1: 15, C2: 18, C3: 25, BLANCO: 2, NULO: 1, NO_MARCADO: 0 };

  async function correr(orden: number[]) {
    await limpiar();
    const porVersion: Record<number, typeof v1> = { 1: v1, 2: v2, 3: v3 };
    const res = [];
    for (const v of orden) res.push(await aplicar(nuevaActa(mesa, v, porVersion[v]!)));
    return { res, estado: await estadoAcumulado(redis) };
  }

  it('versiones 1,3,2 y 1,2,3 dejan exactamente el mismo estado', async () => {
    const a = await correr([1, 3, 2]);
    const b = await correr([1, 2, 3]);
    expect(a.estado).toEqual(b.estado);
    expect(a.res[2]).toEqual({ estado: 'obsoleta', acta: mesa.acta, version_vigente: 3 });
    expect(await redis.hgetall('tot:dep')).toMatchObject({ C1: '15', C3: '25', _informadas: '1' });
  });

  it('una corrección emite evento tipo correccion con el delta y no vuelve a sumar _informadas', async () => {
    await aplicar(nuevaActa(mesa, 1, v1));
    await aplicar(nuevaActa(mesa, 2, v2), 'error de transcripción');
    const ev = await redis.xrange(`ev:mun:${mesa.municipio}`, '-', '+');
    expect(ev).toHaveLength(2);
    const campos = Object.fromEntries(chunk(ev[1]![1]));
    expect(campos).toMatchObject({ tipo: 'correccion', version: '2', informadas: '0', motivo: 'error de transcripción' });
    expect(JSON.parse(campos.delta!)).toEqual({ C1: 2, C2: -2 });
    expect(await redis.hget('tot:dep', '_informadas')).toBe('1');
  });
});

describe('RF-2: _informadas no depende del orden (informada ⇔ versión vigente contada)', () => {
  const c1 = { C1: 10, C2: 20, C3: 30, BLANCO: 1, NULO: 1, NO_MARCADO: 1 };
  const c3 = { C1: 11, C2: 19, C3: 30, BLANCO: 1, NULO: 1, NO_MARCADO: 1 };
  const versiones: Record<number, () => ReturnType<typeof nuevaActa>> = {
    1: () => nuevaActa(mesa, 1, c1), // contada
    2: () => ({ ...nuevaActa(mesa, 2, c1), sufragantes: 999 }), // dudosa
    3: () => nuevaActa(mesa, 3, c3), // contada
  };
  const permutaciones = (xs: number[]): number[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutaciones([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
  const totales = async () => {
    const salida: Record<string, Record<string, string>> = {};
    for (const k of await redis.keys('tot:*')) salida[k] = await redis.hgetall(k);
    return salida;
  };
  async function correr(orden: number[]) {
    await limpiar();
    for (const v of orden) await aplicar(versiones[v]!());
    return totales();
  }

  it.each([
    ['{v1 contada, v2 dudosa, v3 contada}', [1, 2, 3], '1'],
    ['{v1 contada, v2 dudosa}', [1, 2], '0'],
  ])('todas las permutaciones de %s dejan tot:* idéntico', async (_n, conjunto, informadasFinal) => {
    const perms = permutaciones(conjunto as number[]);
    const resultados = [];
    for (const p of perms) resultados.push({ p: p.join(','), tot: await correr(p) });
    for (const r of resultados) expect({ p: r.p, tot: r.tot }).toEqual({ p: r.p, tot: resultados[0]!.tot });
    for (const k of ['tot:mesa:' + mesa.mesa, 'tot:pue:' + mesa.puesto, 'tot:mun:' + mesa.municipio, 'tot:dep']) {
      expect(resultados[0]!.tot[k]?._informadas).toBe(informadasFinal);
    }
  });

  it('contada → dudosa resta 1 a _informadas en los 4 niveles y el evento lleva informadas=-1', async () => {
    await aplicar(versiones[1]!());
    await aplicar(versiones[2]!());
    for (const k of ['tot:mesa:' + mesa.mesa, 'tot:pue:' + mesa.puesto, 'tot:mun:' + mesa.municipio, 'tot:dep']) {
      expect(await redis.hget(k, '_informadas')).toBe('0');
    }
    const [ultimo] = await redis.xrevrange('ev:dep', '+', '-', 'COUNT', 1);
    expect(Object.fromEntries(chunk(ultimo![1]))).toMatchObject({ tipo: 'reversion', informadas: '-1' });
    // y al volver a contar, +1
    await aplicar(versiones[3]!());
    expect(await redis.hget('tot:dep', '_informadas')).toBe('1');
    const [otro] = await redis.xrevrange('ev:dep', '+', '-', 'COUNT', 1);
    expect(Object.fromEntries(chunk(otro![1]))).toMatchObject({ tipo: 'aplicada', informadas: '1' });
  });
});

describe('RF-3 y sección 4.6: eventos', () => {
  it('escribe ev:mun:{m} y ev:dep con el mismo id (= seq) y los campos exactos', async () => {
    const r = (await aplicar(nuevaActa(mesa, 1, VOTOS))) as { seq: string };
    const [mun] = await redis.xrange(`ev:mun:${mesa.municipio}`, '-', '+');
    const [dep] = await redis.xrange('ev:dep', '-', '+');
    expect(mun![0]).toBe(r.seq);
    expect(dep![0]).toBe(r.seq);
    const campos = Object.fromEntries(chunk(mun![1]));
    expect(Object.keys(campos).sort()).toEqual(
      ['acta', 'delta', 'informadas', 'mesa', 'municipio', 'puesto', 'tipo', 'ts_recibido', 'version'].sort(),
    );
    expect(campos).toMatchObject({
      tipo: 'aplicada', acta: mesa.acta, version: '1', mesa: String(mesa.mesa),
      puesto: String(mesa.puesto), municipio: String(mesa.municipio), informadas: '1',
    });
    expect(JSON.parse(campos.delta!)).toEqual(VOTOS);
    expect(Number(campos.ts_recibido)).toBeGreaterThan(1_700_000_000_000);
    expect(dep![1]).toEqual(mun![1]);
  });

  it('publica el id del stream en pub:mun:{m} y pub:dep', async () => {
    const sub = redis.duplicate();
    const recibidos: Array<[string, string]> = [];
    sub.on('message', (canal, msg) => recibidos.push([canal, msg]));
    await sub.subscribe(`pub:mun:${mesa.municipio}`, 'pub:dep');
    const r = (await aplicar(nuevaActa(mesa, 1, VOTOS))) as { seq: string };
    await new Promise((ok) => setTimeout(ok, 100));
    await sub.quit();
    // Pub/sub no está aislado por db: otros archivos de prueba publican en paralelo; filtramos por seq.
    expect(recibidos.filter(([, m]) => m === r.seq).sort()).toEqual([[`pub:dep`, r.seq], [`pub:mun:${mesa.municipio}`, r.seq]].sort());
  });

  it('actualiza ranking en puesto, municipio y departamento', async () => {
    await aplicar(nuevaActa(mesa, 1, VOTOS));
    for (const k of [`rank:pue:${mesa.puesto}`, `rank:mun:${mesa.municipio}`, 'rank:dep']) {
      expect(await redis.zrevrange(k, 0, 1)).toEqual(['C3', 'C1']);
      expect(await redis.zcard(k)).toBe(CANDIDATOS.length);
    }
  });

  it('tras 2.000 actas aleatorias: Σ municipios == departamento y Σ puestos de cada municipio == municipio', async () => {
    const azar = prng(42);
    const elegir = <T>(xs: T[]) => xs[Math.floor(azar() * xs.length)]!;
    for (let i = 0; i < 2000; i++) {
      const m = elegir(catalogo.mesas);
      const v = Object.fromEntries(CANDIDATOS.map((c) => [c, Math.floor(azar() * 200)]));
      const a = nuevaActa(m, 1 + Math.floor(azar() * 3), v);
      if (azar() < 0.08) a.sufragantes += 1 + Math.floor(azar() * 10); // dudosa
      await aplicar(a);
    }
    const campos = [...CANDIDATOS, '_informadas'];
    const leer = async (k: string) => {
      const h = await redis.hgetall(k);
      return Object.fromEntries(campos.map((c) => [c, Number(h[c] ?? 0)]));
    };
    const sumar = (xs: Record<string, number>[]) =>
      Object.fromEntries(campos.map((c) => [c, xs.reduce((a, x) => a + x[c]!, 0)]));

    const muns = [];
    for (const mun of catalogo.municipios) {
      const totMun = await leer(`tot:mun:${mun.id}`);
      const puestos = await Promise.all(mun.puestos.map((p) => leer(`tot:pue:${p.id}`)));
      expect(sumar(puestos)).toEqual(totMun);
      muns.push(totMun);
    }
    const dep = await leer('tot:dep');
    expect(sumar(muns)).toEqual(dep);
    expect(dep.C1).toBeGreaterThan(0);
    // ranking == acumulado
    for (const c of CANDIDATOS) expect(Number(await redis.zscore('rank:dep', c))).toBe(dep[c]);
  }, 60_000);
});

describe('regla contable: dudosas', () => {
  it('descuadre → dudosa, no suma y entra a cola:verif con prioridad = |descuadre|', async () => {
    const a = nuevaActa(mesa, 1, VOTOS);
    a.sufragantes -= 7;
    const r = await aplicar(a);
    expect(r).toMatchObject({ estado: 'dudosa', acta: a.acta, version: 1 });
    expect((r as { motivo: string }).motivo).toMatch(/descuadre/);
    const dep = await redis.hgetall('tot:dep');
    expect(Object.values(dep).every((x) => x === '0')).toBe(true); // no suma (campos en 0)
    expect(await redis.zscore('cola:verif', a.acta)).toBe('7');
    expect(await redis.hget(`acta:${a.acta}`, 'estado')).toBe('dudosa');
    expect(await redis.xlen('ev:dep')).toBe(0);
    expect(await aplicar(a)).toEqual({ ...r, estado: 'duplicada' });
  });

  it('si había versión contada, la revierte y emite evento reversion', async () => {
    await aplicar(nuevaActa(mesa, 1, VOTOS));
    const a2 = nuevaActa(mesa, 2, { ...VOTOS, C1: 200 });
    a2.sufragantes = 500;
    expect(await aplicar(a2)).toMatchObject({ estado: 'dudosa' });
    const dep = await redis.hgetall('tot:dep');
    for (const c of CANDIDATOS) expect(dep[c]).toBe('0');
    const ev = await redis.xrevrange('ev:dep', '+', '-', 'COUNT', 1);
    const campos = Object.fromEntries(chunk(ev[0]![1]));
    expect(campos.tipo).toBe('reversion');
    expect(JSON.parse(campos.delta!)).toEqual(Object.fromEntries(Object.entries(VOTOS).map(([k, v]) => [k, -v])));
    expect(campos.motivo).toMatch(/descuadre/);
  });

  it('una versión que cuadra saca el acta de cola:verif', async () => {
    const a = nuevaActa(mesa, 1, VOTOS);
    a.sufragantes += 3;
    await aplicar(a);
    await aplicar(nuevaActa(mesa, 2, VOTOS));
    expect(await redis.zscore('cola:verif', mesa.acta)).toBeNull();
    expect(await redis.hget('tot:dep', 'C1')).toBe('184');
  });
});

describe('validación (sin escribir nada)', () => {
  it('mesa inexistente o que no coincide con el catálogo → invalida', async () => {
    expect(await aplicar(nuevaActa(mesa, 1, VOTOS, { mesa: 999_999 }))).toMatchObject({ estado: 'invalida' });
    expect(await aplicar(nuevaActa(mesa, 1, VOTOS, { municipio: mesa.municipio + 1 }))).toMatchObject({ estado: 'invalida' });
    const claves = await redis.keys('*');
    expect(claves.filter((k) => !k.startsWith('cat:'))).toEqual([]);
  });
});

describe('catálogo ausente (Redis reiniciado sin semilla)', () => {
  it('no culpa al acta: no_disponible (503) en vez de invalida, para que el jurado reintente', async () => {
    await redis.flushdb();
    expect(await aplicar(nuevaActa(mesa, 1, VOTOS))).toEqual({ estado: 'no_disponible' });
    expect(await redis.dbsize()).toBe(0);
  });
});

function chunk(xs: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < xs.length; i += 2) out.push([xs[i]!, xs[i + 1]!]);
  return out;
}
