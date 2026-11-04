// Persona 3 — WebSocket /ws/verificacion (4.7) con dos instancias que solo comparten Redis.
// Redis del docker compose, base 10 (P1 usa 13–15; p3-bloqueos 12; p3-dudosas 11).
// Los tiempos van escalados (lock 800 ms, ventana de presencia 1,2 s, tick 200 ms) para que las
// pruebas tarden segundos; la lógica es la misma que con 30 s / 30 s / 5 s. La última prueba usa
// los tiempos reales y solo corre con P3_LENTAS=1.
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { claves } from '../compartido/claves.js';
import type { AuditorPresente, Votos, WsServidorCliente } from '../compartido/contratos.js';
import { metricas } from '../src/metricas/index.js';
import type { Aprobador, OpcionesVerificacion } from '../src/verificacion/index.js';
import { sembrarDudosas } from '../scripts/dudosas-demo.js';
import { conectar, esperar, levantarInstancia, type ClienteWs, type Instancia } from './ayuda/p3.js';

const URL = process.env.REDIS_TEST_URL_P3_WS ?? 'redis://localhost:6379/10';
const RAPIDO: Partial<OpcionesVerificacion> = { lockMs: 800, presSeg: 2, ventanaPresenciaMs: 1_200, tickMs: 200 };

let r: Redis;
let instancias: Instancia[] = [];
let clientes: ClienteWs[] = [];
let actas: string[] = [];

async function instancia(nombre: string, opciones: Partial<OpcionesVerificacion> = {}) {
  const i = await levantarInstancia(URL, nombre, { ...RAPIDO, ...opciones });
  instancias.push(i);
  return i;
}
async function cliente(i: Instancia, auditor: string) {
  const c = await conectar(i.url, auditor);
  clientes.push(c);
  await c.esperar((m) => m.t === 'cola');
  return c;
}

const esTomado = (acta: string) => (m: WsServidorCliente): m is Extract<WsServidorCliente, { t: 'tomado' }> =>
  m.t === 'tomado' && m.acta === acta;
const esLiberado = (acta: string) => (m: WsServidorCliente) => m.t === 'liberado' && m.acta === acta;
const esResuelto = (acta: string) => (m: WsServidorCliente) => m.t === 'resuelto' && m.acta === acta;
const esError = (motivo: string) => (m: WsServidorCliente) => m.t === 'error' && m.motivo === motivo;
const presentes = (m: WsServidorCliente): AuditorPresente[] => (m.t === 'presencia' ? m.auditores : []);

beforeAll(() => {
  r = new Redis(URL);
});
beforeEach(async () => {
  await r.flushdb();
  actas = (await sembrarDudosas(r, 5)).sort((a, b) => b.descuadre - a.descuadre).map((a) => a.acta);
});
afterEach(async () => {
  for (const c of clientes) c.ws.terminate();
  await Promise.all(instancias.map((i) => i.cerrar()));
  clientes = [];
  instancias = [];
});
afterAll(async () => {
  await r.flushdb();
  await r.quit();
});

describe('al conectar', () => {
  it('envía "cola" (ZREVRANGE con prioridad, dueño del lock y datos del acta) y "presencia"', async () => {
    const a = await instancia('app-a');
    await r.set(claves.lock(actas[1]!), 'AUD-009:token', 'PX', 30_000);
    const c = await cliente(a, 'AUD-001');
    const cola = c.mensajes.find((m) => m.t === 'cola');
    expect(cola?.t === 'cola' && cola.items.map((x) => x.acta)).toEqual(actas);
    const prioridades = cola?.t === 'cola' ? cola.items.map((x) => x.prioridad) : [];
    expect(prioridades).toEqual([...prioridades].sort((x, y) => y - x));
    const item = cola?.t === 'cola' ? cola.items[1] : undefined;
    expect(item).toMatchObject({ acta: actas[1], auditor: 'AUD-009', version: 1 });
    expect(item?.votos).toBeTypeOf('object');
    const pres = await c.esperar((m) => presentes(m).some((p) => p.auditor === 'AUD-001'));
    expect(presentes(pres).find((p) => p.auditor === 'AUD-001')).toMatchObject({ instancia: 'app-a', acta: null });
  });

  it('rechaza el upgrade sin ?auditor=AUD-XXX válido', async () => {
    const a = await instancia('app-a');
    await expect(conectar(a.url, 'cualquiera')).rejects.toThrow(/400/);
  });
});

describe('sección 6 · tomar', () => {
  it('dos auditores en instancias distintas intentan tomar la misma acta: solo uno lo logra', async () => {
    const [a, b] = await Promise.all([instancia('app-a'), instancia('app-b')]);
    const c1 = await cliente(a, 'AUD-001');
    const c2 = await cliente(b, 'AUD-002');
    const acta = actas[0]!;
    const desde1 = c1.mensajes.length;
    const desde2 = c2.mensajes.length;

    c1.enviar({ t: 'tomar', acta });
    c2.enviar({ t: 'tomar', acta });

    // Ambos ven el mismo ganador (pub:verif cruza instancias)…
    const t1 = await c1.esperar(esTomado(acta), 3_000, desde1);
    const t2 = await c2.esperar(esTomado(acta), 3_000, desde2);
    expect(t1.auditor).toBe(t2.auditor);
    // …y el perdedor recibe ya_tomado.
    const perdedor = t1.auditor === 'AUD-001' ? c2 : c1;
    await perdedor.esperar(esError('ya_tomado'), 3_000);
    await esperar(150);
    const tomados = [...c1.mensajes.slice(desde1), ...c2.mensajes.slice(desde2)].filter(esTomado(acta));
    expect(new Set(tomados.map((m) => m.auditor)).size).toBe(1);
    expect((await r.get(claves.lock(acta)))!.startsWith(`${t1.auditor}:`)).toBe(true);
  });

  it('100 intentos simultáneos desde dos instancias: un único dueño', async () => {
    const [a, b] = await Promise.all([instancia('app-a'), instancia('app-b')]);
    const cs = await Promise.all(
      Array.from({ length: 10 }, (_, i) => cliente(i % 2 ? a : b, `AUD-${String(i).padStart(3, '0')}`)),
    );
    const acta = actas[2]!;
    for (let k = 0; k < 10; k++) for (const c of cs) c.enviar({ t: 'tomar', acta });
    await cs[0]!.esperar(esTomado(acta));
    await esperar(500);
    const errores = cs.flatMap((c) => c.mensajes).filter(esError('ya_tomado')).length;
    const ganadores = new Set(cs.flatMap((c) => c.mensajes).filter(esTomado(acta)).map((m) => m.auditor));
    expect(ganadores.size).toBe(1);
    expect(errores).toBe(99);
  });

  it('un acta que ya salió de la cola responde "resuelto" a quien intenta tomarla', async () => {
    const a = await instancia('app-a');
    const c = await cliente(a, 'AUD-001');
    await r.zrem(claves.colaVerif(), actas[0]!);
    c.enviar({ t: 'tomar', acta: actas[0]! });
    await c.esperar(esResuelto(actas[0]!));
    expect(await r.exists(claves.lock(actas[0]!))).toBe(0);
  });
});

describe('sección 6 · liberación segura', () => {
  it('lock expirado y tomado por otro: el antiguo dueño recibe no_eres_dueno al liberar', async () => {
    const [a, b] = await Promise.all([instancia('app-a'), instancia('app-b')]);
    const viejo = await cliente(a, 'AUD-001');
    const nuevo = await cliente(b, 'AUD-002');
    const acta = actas[0]!;

    viejo.enviar({ t: 'tomar', acta });
    await nuevo.esperar(esTomado(acta));
    // AUD-001 no manda latidos: el lock vence (800 ms) y la otra instancia avisa "liberado".
    await nuevo.esperar(esLiberado(acta), 3_000);
    nuevo.enviar({ t: 'tomar', acta });
    await viejo.esperar((m) => esTomado(acta)(m) && m.auditor === 'AUD-002');

    const desde = viejo.mensajes.length;
    viejo.enviar({ t: 'liberar', acta });
    await viejo.esperar(esError('no_eres_dueno'), 3_000, desde);
    viejo.enviar({ t: 'resolver', acta, decision: 'rechazar' });
    await viejo.esperar(esError('no_eres_dueno'), 3_000, desde + 1);
    expect((await r.get(claves.lock(acta)))!.startsWith('AUD-002:')).toBe(true);
    expect(await r.hget(claves.acta(acta), 'estado')).toBe('dudosa');
  });

  it('el dueño libera: todos reciben "liberado" y otro la puede tomar', async () => {
    const [a, b] = await Promise.all([instancia('app-a'), instancia('app-b')]);
    const c1 = await cliente(a, 'AUD-001');
    const c2 = await cliente(b, 'AUD-002');
    const acta = actas[1]!;
    c1.enviar({ t: 'tomar', acta });
    await c2.esperar(esTomado(acta));
    c1.enviar({ t: 'liberar', acta });
    await c2.esperar(esLiberado(acta));
    expect(await r.exists(claves.lock(acta))).toBe(0);
    c2.enviar({ t: 'tomar', acta });
    await c1.esperar((m) => esTomado(acta)(m) && m.auditor === 'AUD-002');
  });

  it('cerrar el socket NO libera de inmediato: el lock vence solo, sin latido', async () => {
    const [a, b] = await Promise.all([instancia('app-a'), instancia('app-b')]);
    const c1 = await cliente(a, 'AUD-001');
    const c2 = await cliente(b, 'AUD-002');
    const acta = actas[0]!;
    c1.enviar({ t: 'tomar', acta });
    await c2.esperar(esTomado(acta));
    const t0 = Date.now();
    c1.ws.terminate();
    await esperar(300);
    expect(await r.exists(claves.lock(acta))).toBe(1); // sigue tomado tras el cierre
    await c2.esperar(esLiberado(acta), 3_000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
  });
});

describe('latido (RF-7 + RF-8)', () => {
  it('activo=true renueva el lock; activo=false no y el caso vuelve solo a la cola', async () => {
    const [a, b] = await Promise.all([instancia('app-a'), instancia('app-b')]);
    const c1 = await cliente(a, 'AUD-001');
    const c2 = await cliente(b, 'AUD-002');
    const acta = actas[0]!;
    c1.enviar({ t: 'tomar', acta });
    await c2.esperar(esTomado(acta));

    // 2 s con latidos activos (cada 250 ms) > 800 ms de lock: sigue siendo de AUD-001.
    for (let k = 0; k < 8; k++) {
      c1.enviar({ t: 'latido', activo: true });
      await esperar(250);
    }
    expect(c2.mensajes.some(esLiberado(acta))).toBe(false);
    expect((await r.get(claves.lock(acta)))!.startsWith('AUD-001:')).toBe(true);

    // Sin actividad (se fue a almorzar): sigue mandando latidos pero activo=false → se libera.
    const corte = Date.now();
    const intervalo = setInterval(() => c1.enviar({ t: 'latido', activo: false }), 250);
    try {
      await c2.esperar(esLiberado(acta), 3_000);
    } finally {
      clearInterval(intervalo);
    }
    expect(Date.now() - corte).toBeLessThan(800 + 200 + 400);
    // …pero el auditor sigue presente (el latido sí refresca la presencia).
    c1.enviar({ t: 'latido', activo: false });
    const pres = await c2.esperar(
      (m) => presentes(m).some((p) => p.auditor === 'AUD-001' && p.acta === null),
      2_000,
      c2.mensajes.length,
    );
    expect(pres.t).toBe('presencia');
  });

  it('siempre hace SET pres:{auditor} EX y ZADD pres:idx', async () => {
    const a = await instancia('app-a');
    const c = await cliente(a, 'AUD-007');
    await r.del(claves.pres('AUD-007'));
    await r.zrem(claves.presIdx(), 'AUD-007');
    c.enviar({ t: 'latido', activo: false });
    await esperar(150);
    expect(JSON.parse((await r.get(claves.pres('AUD-007')))!)).toMatchObject({ instancia: 'app-a', acta: null });
    expect(await r.ttl(claves.pres('AUD-007'))).toBeGreaterThan(0);
    expect(Number(await r.zscore(claves.presIdx(), 'AUD-007'))).toBeGreaterThan(Date.now() - 1_000);
  });
});

describe('sección 6 · presencia', () => {
  it('un auditor que deja de mandar latidos desaparece de la presencia de los demás', async () => {
    const [a, b] = await Promise.all([instancia('app-a'), instancia('app-b')]);
    const coordinador = await cliente(b, 'AUD-000');
    const c = await cliente(a, 'AUD-007');
    c.enviar({ t: 'tomar', acta: actas[0]! });
    const visto = await coordinador.esperar((m) =>
      presentes(m).some((p) => p.auditor === 'AUD-007' && p.acta === actas[0] && p.instancia === 'app-a'),
    );
    expect(visto.t).toBe('presencia');
    const ultimoLatido = Date.now();
    c.ws.terminate(); // portátil sin batería: no hay más latidos ni aviso de cierre
    const desde = coordinador.mensajes.length;
    await coordinador.esperar(
      (m) => m.t === 'presencia' && !presentes(m).some((p) => p.auditor === 'AUD-007'),
      3_000,
      desde,
    );
    // ventana (1,2 s) + un tick (0,2 s) + margen. Con los valores reales: 30 s desde el último latido.
    expect(Date.now() - ultimoLatido).toBeLessThanOrEqual(1_200 + 200 + 300);
    expect(await r.zscore(claves.presIdx(), 'AUD-007')).toBeNull(); // ZREMRANGEBYSCORE de los viejos
  });
});

describe('resolver', () => {
  it('rechazar: estado=rechazada, ZREM cola:verif, libera el lock y avisa "resuelto" a todas las instancias', async () => {
    const [a, b] = await Promise.all([instancia('app-a'), instancia('app-b')]);
    const c1 = await cliente(a, 'AUD-001');
    const c2 = await cliente(b, 'AUD-002');
    const acta = actas[0]!;
    c1.enviar({ t: 'tomar', acta });
    await c1.esperar(esTomado(acta));
    c1.enviar({ t: 'resolver', acta, decision: 'rechazar' });
    await c2.esperar(esResuelto(acta));
    expect(await r.hget(claves.acta(acta), 'estado')).toBe('rechazada');
    expect(await r.zscore(claves.colaVerif(), acta)).toBeNull();
    expect(await r.exists(claves.lock(acta))).toBe(0);
  });

  it('aprobar llama a aplicarActa (vía el aprobador) con los votos corregidos', async () => {
    const llamadas: Array<{ acta: string; votos: Votos | undefined; auditor: string }> = [];
    const aprobador: Aprobador = async (ctx, acta, votos, auditor) => {
      llamadas.push({ acta, votos, auditor });
      await ctx.redis.zrem(claves.colaVerif(), acta); // lo que hace aplicar_acta.lua al registrar
      return { ok: true };
    };
    const a = await instancia('app-a', { aprobador });
    const c = await cliente(a, 'AUD-001');
    const acta = actas[0]!;
    const votos: Votos = { C1: 10, C2: 20, C3: 30, BLANCO: 1, NULO: 2, NO_MARCADO: 3 };
    c.enviar({ t: 'tomar', acta });
    await c.esperar(esTomado(acta));
    c.enviar({ t: 'resolver', acta, decision: 'aprobar', votos });
    await c.esperar(esResuelto(acta));
    expect(llamadas).toEqual([{ acta, votos, auditor: 'AUD-001' }]);
    expect(await r.exists(claves.lock(acta))).toBe(0);
    expect(await r.zscore(claves.colaVerif(), acta)).toBeNull();
  });

  it('si aplicarActa no se pudo aplicar, el caso vuelve a la cola (liberado) en vez de perderse', async () => {
    const aprobador: Aprobador = async () => ({ ok: false, motivo: 'no_aplicada', detalle: 'obsoleta' });
    const a = await instancia('app-a', { aprobador });
    const c = await cliente(a, 'AUD-001');
    const acta = actas[0]!;
    c.enviar({ t: 'tomar', acta });
    await c.esperar(esTomado(acta));
    c.enviar({ t: 'resolver', acta, decision: 'aprobar' });
    await c.esperar(esLiberado(acta));
    expect(await r.zscore(claves.colaVerif(), acta)).not.toBeNull();
  });
});

describe('cola en vivo', () => {
  it('un acta dudosa nueva (ZADD de P1, sin aviso) aparece en la cola de todos en ≤ 1 tick', async () => {
    const [a, b] = await Promise.all([instancia('app-a'), instancia('app-b')]);
    const c1 = await cliente(a, 'AUD-001');
    const c2 = await cliente(b, 'AUD-002');
    await r.zadd(claves.colaVerif(), 99, 'E14-5-0001-03');
    for (const c of [c1, c2]) {
      const cola = await c.esperar((m) => m.t === 'cola' && m.items[0]?.acta === 'E14-5-0001-03', 1_000, 1);
      expect(cola.t).toBe('cola');
    }
  });
});

describe('RF-10a · Redis caído', () => {
  it('avisa {"t":"error","motivo":"redis_caido"}, rechaza acciones y se recupera solo', async () => {
    const a = await instancia('app-a');
    const c = await cliente(a, 'AUD-001');
    const desde = c.mensajes.length;
    a.ctx.redis.disconnect(); // como un `docker stop redis` visto por esta instancia
    await c.esperar(esError('redis_caido'), 2_000, desde);

    const n = c.mensajes.length;
    c.enviar({ t: 'tomar', acta: actas[0]! });
    await c.esperar(esError('redis_caido'), 2_000, n);
    expect(await r.exists(claves.lock(actas[0]!))).toBe(0);

    await a.ctx.redis.connect();
    await c.esperar((m) => m.t === 'cola', 2_000, n + 1); // al volver, cola fresca (la consola quita el banner)
    c.enviar({ t: 'tomar', acta: actas[0]! });
    await c.esperar(esTomado(actas[0]!));
  });
});

describe('métricas', () => {
  it('reporta conexiones de auditor, locks activos y mensajes WS emitidos', async () => {
    const a = await instancia('app-a');
    const c = await cliente(a, 'AUD-001');
    c.enviar({ t: 'tomar', acta: actas[0]! });
    await c.esperar(esTomado(actas[0]!));
    await esperar(300);
    const foto = metricas.foto();
    expect(Number(foto.con_ws)).toBeGreaterThanOrEqual(1);
    expect(Number(foto.con_auditor)).toBeGreaterThanOrEqual(1);
    expect(Number(foto.locks_activos)).toBeGreaterThanOrEqual(1);
    expect(Number(foto.ws_mensajes_emitidos)).toBeGreaterThan(0);
  });
});

describe.runIf(process.env.P3_LENTAS === '1')('tiempos reales (P3_LENTAS=1)', () => {
  it('sin latidos desaparece de la presencia en ≤ 30 s (+ 1 tick de 5 s para avisar)', async () => {
    const [a, b] = await Promise.all([
      instancia('app-a', { lockMs: 30_000, presSeg: 30, ventanaPresenciaMs: 30_000, tickMs: 5_000 }),
      instancia('app-b', { lockMs: 30_000, presSeg: 30, ventanaPresenciaMs: 30_000, tickMs: 5_000 }),
    ]);
    const coordinador = await cliente(b, 'AUD-000');
    const c = await cliente(a, 'AUD-007');
    const t0 = Date.now(); // al conectar se registra la presencia (equivale al último latido)
    c.ws.terminate();
    await esperar(29_000);
    expect(await r.zscore(claves.presIdx(), 'AUD-007')).not.toBeNull(); // aún dentro de la ventana
    await coordinador.esperar(
      (m) => m.t === 'presencia' && !presentes(m).some((p) => p.auditor === 'AUD-007'),
      7_000,
      coordinador.mensajes.length,
    );
    expect(Date.now() - t0).toBeLessThanOrEqual(35_000);
  }, 45_000);
});
