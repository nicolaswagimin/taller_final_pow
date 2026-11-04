import { describe, expect, it } from 'vitest';
import { claves } from '../compartido/claves.js';
import {
  deserializarCamposStream,
  emitirEventoFalso,
  inicializarCatalogoPrueba,
  serializarCamposStream,
} from '../carga/eventos-falsos.js';
import { crearRedisTest } from './redis-mock.js';

describe('carga/eventos-falsos', () => {
  it('serializa y deserializa campos del stream exactamente según sección 4.6', () => {
    const eventoOriginal = {
      tipo: 'aplicada' as const,
      acta: 'E14-176-4201-01',
      version: 2,
      mesa: 4201,
      puesto: 176,
      municipio: 11,
      delta: { C1: 10, C2: -3 },
      informadas: 1 as const,
      ts_recibido: 1730000000000,
      motivo: 'ajuste',
    };

    const lista = serializarCamposStream(eventoOriginal);
    expect(lista).toContain('tipo');
    expect(lista).toContain('aplicada');
    expect(lista).toContain('delta');
    expect(lista).toContain('{"C1":10,"C2":-3}');
    expect(lista).toContain('motivo');
    expect(lista).toContain('ajuste');

    const deserializado = deserializarCamposStream(lista);
    expect(deserializado).toEqual(eventoOriginal);
  });

  it('emitirEventoFalso escribe en streams, publica avisos y actualiza tot:* y rank:*', async () => {
    const { redis } = crearRedisTest();
    await inicializarCatalogoPrueba(redis, { municipios: [11] });

    const resultado = await emitirEventoFalso(redis, {
      municipio: 11,
      puesto: 176,
      mesa: 4201,
      delta: { C1: 15, C2: 5 },
      informadas: 1,
    });

    expect(resultado.seqMun).toBeDefined();
    expect(resultado.seqDep).toBeDefined();

    // Comprobar tot:mun:11
    const totMun = await redis.hgetall(claves.totMun(11));
    expect(totMun.C1).toBe('15');
    expect(totMun.C2).toBe('5');
    expect(totMun._informadas).toBe('1');

    // Comprobar tot:dep
    const totDep = await redis.hgetall(claves.totDep());
    expect(totDep.C1).toBe('15');
    expect(totDep.C2).toBe('5');
    expect(totDep._informadas).toBe('1');

    // Comprobar rank:mun:11 (ZREVRANGE con WITHSCORES)
    const rank = await redis.zrevrange(claves.rankMun(11), 0, 1, 'WITHSCORES');
    expect(rank[0]).toBe('C1');
    expect(rank[1]).toBe('15');
    expect(rank[2]).toBe('C2');
    expect(rank[3]).toBe('5');
  });
});
