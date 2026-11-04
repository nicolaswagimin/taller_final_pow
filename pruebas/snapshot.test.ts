import { describe, expect, it } from 'vitest';
import express from 'express';
import { claves } from '../compartido/claves.js';
import { emitirEventoFalso, inicializarCatalogoPrueba } from '../carga/eventos-falsos.js';
import { manejarSnapshot, obtenerSnapshot } from '../src/publico/snapshot.js';
import { crearRedisTest } from './redis-mock.js';

describe('Paso 2: GET /api/snapshot', () => {
  it('genera Snapshot correcto de departamento y municipio', async () => {
    const { redis } = crearRedisTest();
    await inicializarCatalogoPrueba(redis, { municipios: [11, 12] });

    await emitirEventoFalso(redis, {
      municipio: 11,
      delta: { C1: 100, C2: 50 },
      informadas: 1,
    });

    const snapMun = await obtenerSnapshot(redis, 'mun:11');
    expect(snapMun.topico).toBe('mun:11');
    expect(snapMun.totales.C1).toBe(100);
    expect(snapMun.totales.C2).toBe(50);
    expect(snapMun.ranking[0].candidato).toBe('C1');
    expect(snapMun.ranking[0].votos).toBe(100);
    expect(snapMun.informadas).toBe(1);
    expect(snapMun.total_mesas).toBeGreaterThan(0);
    expect(snapMun.seq).not.toBe('0-0');

    const snapDep = await obtenerSnapshot(redis, 'dep');
    expect(snapDep.topico).toBe('dep');
    expect(snapDep.totales.C1).toBe(100);
    expect(snapDep.totales.C2).toBe(50);
    expect(snapDep.seq).not.toBe('0-0');
  });

  it('devuelve ETag y responde 304 si coincide If-None-Match', async () => {
    const { redis } = crearRedisTest();
    await inicializarCatalogoPrueba(redis, { municipios: [11] });
    const { seqMun } = await emitirEventoFalso(redis, { municipio: 11, delta: { C1: 10 } });

    // Simular req/res de Express
    let statusCode = 200;
    const headers: Record<string, string> = {};
    let ended = false;
    let jsonBody: any = null;

    const reqMatch: any = {
      query: { topico: 'mun:11' },
      headers: { 'if-none-match': `"${seqMun}"` },
    };

    const resMatch: any = {
      status(code: number) {
        statusCode = code;
        return resMatch;
      },
      setHeader(name: string, val: string) {
        headers[name] = val;
      },
      end() {
        ended = true;
      },
      json(body: any) {
        jsonBody = body;
      },
    };

    await manejarSnapshot(reqMatch, resMatch, redis);

    expect(statusCode).toBe(304);
    expect(ended).toBe(true);
    expect(headers.ETag).toBe(`"${seqMun}"`);

    // Petición sin If-None-Match debe dar 200 con JSON
    let status200 = 0;
    let body200: any = null;
    const reqNoMatch: any = {
      query: { topico: 'mun:11' },
      headers: {},
    };
    const res200: any = {
      status(code: number) {
        status200 = code;
        return res200;
      },
      setHeader(name: string, val: string) {
        headers[name] = val;
      },
      end() {},
      json(body: any) {
        status200 = 200;
        body200 = body;
      },
    };

    await manejarSnapshot(reqNoMatch, res200, redis);
    expect(status200).toBe(200);
    expect(body200.seq).toBe(seqMun);
    expect(body200.totales.C1).toBe(10);
  });

  it('rechaza tópicos inválidos con 400', async () => {
    const { redis } = crearRedisTest();
    let code = 0;
    let body: any = null;
    const req: any = { query: { topico: 'invalido' }, headers: {} };
    const res: any = {
      status(c: number) {
        code = c;
        return res;
      },
      setHeader() {},
      json(b: any) {
        body = b;
      },
    };

    await manejarSnapshot(req, res, redis);
    expect(code).toBe(400);
    expect(body.error).toBeDefined();
  });
});
