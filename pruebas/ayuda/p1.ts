// Utilidades de prueba de la Persona 1.
import type { Redis } from 'ioredis';
import { CANDIDATOS, type Acta, type Votos } from '../../compartido/contratos.js';
import { generarCatalogo, type MesaCatalogo } from '../../scripts/catalogo.js';

export const catalogo = generarCatalogo();
let contadorIdem = 0;

export function votos(v: Partial<Votos> = {}): Votos {
  return { C1: 0, C2: 0, C3: 0, BLANCO: 0, NULO: 0, NO_MARCADO: 0, ...v };
}

export function nuevaActa(m: MesaCatalogo, version: number, v: Partial<Votos>, extra: Partial<Acta> = {}): Acta {
  const vv = votos(v);
  const suma = CANDIDATOS.reduce((a, c) => a + vv[c], 0);
  return {
    acta: m.acta,
    mesa: m.mesa,
    puesto: m.puesto,
    municipio: m.municipio,
    version,
    jurado: `JUR-${m.mesa}`,
    ts_cierre: 1793577600,
    votos: vv,
    sufragantes: suma,
    hash_foto: 'sin-foto',
    idem: `prueba-${process.pid}-${++contadorIdem}`,
    ...extra,
  };
}

/** Estado acumulado comparable: tot:*, rank:*, acta:* (version/estado/votos), cola:verif. */
export async function estadoAcumulado(r: Redis): Promise<Record<string, unknown>> {
  const salida: Record<string, unknown> = {};
  for (const patron of ['tot:*', 'rank:*', 'acta:*']) {
    let cursor = '0';
    do {
      const [sig, ks] = await r.scan(cursor, 'MATCH', patron, 'COUNT', 1000);
      cursor = sig;
      for (const k of ks) {
        if (k.startsWith('rank:')) salida[k] = await r.zrange(k, 0, -1, 'WITHSCORES');
        else if (k.startsWith('acta:')) {
          const [version, estado, votosJson] = await r.hmget(k, 'version', 'estado', 'votos');
          salida[k] = { version, estado, votos: JSON.parse(votosJson ?? '{}') };
        } else salida[k] = await r.hgetall(k);
      }
    } while (cursor !== '0');
  }
  salida['cola:verif'] = await r.zrange('cola:verif', 0, -1, 'WITHSCORES');
  return salida;
}
