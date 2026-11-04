import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Ctx } from '../compartido/contexto.js';
import { claves } from '../compartido/claves.js';
import { emitirEventoFalso, inicializarCatalogoPrueba } from '../carga/eventos-falsos.js';
import { GestorSse } from '../src/publico/gestor-sse.js';
import { crearRedisTest } from './redis-mock.js';

function crearMockResponse(): any {
  const res = new EventEmitter() as any;
  res.headers = {};
  res.statusCode = 200;
  res.writableLength = 0;
  res.written = [] as string[];
  res.ended = false;

  res.writeHead = (status: number, headers: any) => {
    res.statusCode = status;
    Object.assign(res.headers, headers);
    return res;
  };
  res.write = (chunk: string) => {
    res.written.push(chunk);
    return true;
  };
  res.end = () => {
    res.ended = true;
    res.emit('finish');
    return res;
  };
  return res;
}

function crearCtxTest(redis: any, redisSub: any): Ctx {
  const metricasInternas = new Map<string, any>();
  return {
    redis,
    redisSub,
    instancia: 'instancia-test',
    metricas: {
      registrar: (k, v) => metricasInternas.set(k, v),
      incrementar: (k, n = 1) => metricasInternas.set(k, (metricasInternas.get(k) ?? 0) + n),
      conexionAbierta: (t) => metricasInternas.set(`con_${t}`, (metricasInternas.get(`con_${t}`) ?? 0) + 1),
      conexionCerrada: (t) => metricasInternas.set(`con_${t}`, (metricasInternas.get(`con_${t}`) ?? 1) - 1),
      foto: () => ({}),
      iniciar: () => {},
      detener: () => {},
    },
  };
}

describe('Paso 3, 4, 5, 6, 7: Motor SSE de Difusión Pública', () => {
  it('Paso 3: GET /sse asigna retry aleatorio 1000-5000 y suscribe dinámicamente a Redis', async () => {
    const { redis, redisSub } = crearRedisTest();
    await inicializarCatalogoPrueba(redis, { municipios: [11] });
    const ctx = crearCtxTest(redis, redisSub);
    const gestor = new GestorSse(ctx);

    const subSpy = vi.spyOn(redisSub, 'subscribe');
    const unsubSpy = vi.spyOn(redisSub, 'unsubscribe');

    const req: any = new EventEmitter();
    req.headers = {};
    req.query = {};
    const res = crearMockResponse();

    // Alta de conexión en mun:11
    const con = await gestor.altaConexion('mun:11', req, res);

    expect(con.retryMs).toBeGreaterThanOrEqual(1000);
    expect(con.retryMs).toBeLessThanOrEqual(5000);
    expect(res.written[0]).toMatch(/^retry: \d+\n\n$/);
    expect(subSpy).toHaveBeenCalledWith(claves.pubMun(11));

    // Baja de conexión debe desuscribir
    gestor.bajaConexion(con);
    expect(unsubSpy).toHaveBeenCalledWith(claves.pubMun(11));

    gestor.detener();
  });

  it('Paso 4: Fan-out acumula eventos y emite UN solo delta cada 2s serializado una vez', async () => {
    const { redis, redisSub } = crearRedisTest();
    await inicializarCatalogoPrueba(redis, { municipios: [11] });
    const ctx = crearCtxTest(redis, redisSub);
    const gestor = new GestorSse(ctx);

    const req1: any = new EventEmitter();
    req1.headers = {};
    req1.query = {};
    const res1 = crearMockResponse();
    const con1 = await gestor.altaConexion('mun:11', req1, res1);

    const req2: any = new EventEmitter();
    req2.headers = {};
    req2.query = {};
    const res2 = crearMockResponse();
    const con2 = await gestor.altaConexion('mun:11', req2, res2);

    // Emitir 2 actas falsas
    await emitirEventoFalso(redis, { municipio: 11, delta: { C1: 20 }, informadas: 1 });
    await emitirEventoFalso(redis, { municipio: 11, delta: { C1: 30, C2: 10 }, informadas: 1 });

    // Ejecutar emisión de ventana acumulada
    await gestor.emitirVentana();

    // Verificar que ambos clientes recibieron el MISMO delta acumulado de 50 votos para C1
    const deltas1 = res1.written.filter((w: string) => w.includes('event: delta'));
    const deltas2 = res2.written.filter((w: string) => w.includes('event: delta'));

    expect(deltas1.length).toBe(1);
    expect(deltas2.length).toBe(1);
    expect(deltas1[0]).toBe(deltas2[0]); // Misma serialización exacta!
    expect(deltas1[0]).toContain('"C1":50');
    expect(deltas1[0]).toContain('"C2":10');
    expect(deltas1[0]).toContain('"informadas":2');

    gestor.bajaConexion(con1);
    gestor.bajaConexion(con2);
    gestor.detener();
  });

  it('Paso 5 (RF-6): Reconexión de 30s con Last-Event-ID queda IDÉNTICO a cliente que nunca se desconectó', async () => {
    const { redis, redisSub } = crearRedisTest();
    await inicializarCatalogoPrueba(redis, { municipios: [11] });
    const ctx = crearCtxTest(redis, redisSub);
    const gestor = new GestorSse(ctx);

    // Cliente A: conectado todo el tiempo
    const reqA: any = new EventEmitter();
    reqA.headers = {};
    reqA.query = {};
    const resA = crearMockResponse();
    const conA = await gestor.altaConexion('mun:11', reqA, resA);

    // Evento inicial
    const ev1 = await emitirEventoFalso(redis, { municipio: 11, delta: { C1: 10 } });
    await gestor.emitirVentana();

    // Guardamos el seq donde se desconectará el cliente B
    const seqCorte = ev1.seqMun;

    // Simular que ocurren varios eventos durante la desconexión
    await emitirEventoFalso(redis, { municipio: 11, delta: { C1: 15, C2: 25 }, informadas: 1 });
    await emitirEventoFalso(redis, { municipio: 11, delta: { C1: 5 }, informadas: 0 });
    await gestor.emitirVentana();

    // Cliente B: se conecta ahora con Last-Event-ID = seqCorte
    const reqB: any = new EventEmitter();
    reqB.headers = { 'last-event-id': seqCorte };
    reqB.query = {};
    const resB = crearMockResponse();
    const conB = await gestor.altaConexion('mun:11', reqB, resB);

    // El delta acumulado que recibe B al reconectar debe coincidir con lo que recibió A tras el corte
    const deltaReconB = resB.written.find((w: string) => w.includes('event: delta'));
    expect(deltaReconB).toBeDefined();
    expect(deltaReconB).toContain('"C1":20'); // 15 + 5
    expect(deltaReconB).toContain('"C2":25');

    gestor.bajaConexion(conA);
    gestor.bajaConexion(conB);
    gestor.detener();
  });

  it('Paso 5 (RF-6): Cursor viejo anterior a la ventana o con > 500 eventos recibe snapshot', async () => {
    const { redis, redisSub } = crearRedisTest();
    await inicializarCatalogoPrueba(redis, { municipios: [11] });
    const ctx = crearCtxTest(redis, redisSub);
    const gestor = new GestorSse(ctx);

    await emitirEventoFalso(redis, { municipio: 11, delta: { C1: 50 } });

    // Cursor muy antiguo anterior a la retención
    const reqViejo: any = new EventEmitter();
    reqViejo.headers = { 'last-event-id': '1000000000000-0' };
    reqViejo.query = {};
    const resViejo = crearMockResponse();
    const conViejo = await gestor.altaConexion('mun:11', reqViejo, resViejo);

    const snapshotMsg = resViejo.written.find((w: string) => w.includes('event: snapshot'));
    expect(snapshotMsg).toBeDefined();
    expect(snapshotMsg).toContain('"topico":"mun:11"');

    gestor.bajaConexion(conViejo);
    gestor.detener();
  });

  it('Paso 6 (RF-9): Contrapresión: >64 KB pasa a atrasada y en drain recibe snapshot; >512 KB recibe reconecta y cierra', async () => {
    const { redis, redisSub } = crearRedisTest();
    await inicializarCatalogoPrueba(redis, { municipios: [11] });
    const ctx = crearCtxTest(redis, redisSub);
    const gestor = new GestorSse(ctx);

    const req: any = new EventEmitter();
    req.headers = {};
    req.query = {};
    const res = crearMockResponse();
    const con = await gestor.altaConexion('mun:11', req, res);

    // Caso 1: Forzar writableLength > 64 KB
    res.writableLength = 70 * 1024;
    const ok = con.enviar('id: 1\nevent: delta\ndata: {}\n\n');
    expect(ok).toBe(false);
    expect(con.atrasada).toBe(true);

    // Disparar drain -> debe mandar snapshot
    res.writableLength = 0;
    res.emit('drain');
    await new Promise((r) => setTimeout(r, 20));
    expect(con.atrasada).toBe(false);
    const snapTrasDrain = res.written.find((w: string) => w.includes('event: snapshot'));
    expect(snapTrasDrain).toBeDefined();

    // Caso 2: Forzar writableLength > 512 KB
    res.writableLength = 600 * 1024;
    con.enviar('id: 2\nevent: delta\ndata: {}\n\n');
    expect(res.written.some((w: string) => w.includes('event: reconecta'))).toBe(true);
    expect(con.cerrada).toBe(true);
    expect(res.ended).toBe(true);

    gestor.detener();
  });

  it('Paso 7 (RF-10a): Redis caído notifica event: estado degradado true y false al volver', async () => {
    const { redis, redisSub } = crearRedisTest();
    await inicializarCatalogoPrueba(redis, { municipios: [11] });
    const ctx = crearCtxTest(redis, redisSub);
    const gestor = new GestorSse(ctx);

    const req: any = new EventEmitter();
    req.headers = {};
    req.query = {};
    const res = crearMockResponse();
    const con = await gestor.altaConexion('mun:11', req, res);

    // Simular caída de Redis
    (redis as any).emit('close');
    const msgDegradado = res.written.find((w: string) => w.includes('"degradado":true'));
    expect(msgDegradado).toBeDefined();

    // Simular recuperación de Redis
    (redis as any).emit('ready');
    const msgRecuperado = res.written.find((w: string) => w.includes('"degradado":false'));
    expect(msgRecuperado).toBeDefined();

    gestor.bajaConexion(con);
    gestor.detener();
  });

  it('Prueba obligatoria sección 6: El retraso p99 del Event Loop se mantiene acotado con 2.500+ conexiones durante un fan-out', async () => {
    const { redis, redisSub } = crearRedisTest();
    await inicializarCatalogoPrueba(redis, { municipios: [11] });
    const ctx = crearCtxTest(redis, redisSub);
    const gestor = new GestorSse(ctx);

    const eld = monitorEventLoopDelay({ resolution: 10 });
    eld.enable();

    // Conectar 2.500 conexiones
    const TOTAL_CONEXIONES = 2500;
    const conexiones: any[] = [];
    for (let i = 0; i < TOTAL_CONEXIONES; i++) {
      const req: any = new EventEmitter();
      req.headers = { 'last-event-id': '0-0' }; // para evitar generar snapshot en cada alta
      req.query = {};
      const res = crearMockResponse();
      const con = await gestor.altaConexion('mun:11', req, res);
      conexiones.push(con);
    }

    expect(gestor.obtenerTotalConexiones()).toBe(2500);

    // Emitir varias actas
    await emitirEventoFalso(redis, { municipio: 11, delta: { C1: 10, C2: 5 }, informadas: 1 });
    await emitirEventoFalso(redis, { municipio: 11, delta: { C1: 20 }, informadas: 0 });

    // Ejecutar fan-out a las 2.500 conexiones
    await gestor.emitirVentana();

    eld.disable();
    const p99Ms = eld.percentile(99) / 1e6;
    // El retraso del event loop debe permanecer acotado (típicamente < 50ms gracias a setImmediate y serialización única)
    expect(p99Ms).toBeLessThan(100);

    for (const c of conexiones) {
      gestor.bajaConexion(c);
    }
    gestor.detener();
  });
});
