/**
 * Generador de eventos falsos para pruebas de Persona 2 (Público).
 * Permite simular las escrituras de Persona 1 según docs/DISEÑO.md (sección 4.6 y tabla 4.4).
 */
import type { Redis } from 'ioredis';
import { claves, MAXLEN } from '../compartido/claves.js';
import {
  CANDIDATOS,
  type Candidato,
  type Delta,
  type EventoCambio,
  type TipoEvento,
  type Votos,
} from '../compartido/contratos.js';

export interface OpcionesEventoFalso {
  tipo?: TipoEvento;
  acta?: string;
  version?: number;
  mesa?: number;
  puesto?: number;
  municipio?: number;
  delta?: Delta;
  informadas?: 0 | 1;
  ts_recibido?: number;
  motivo?: string;
}

/**
 * Convierte un EventoCambio en array plano de pares [campo, valor] para XADD.
 * Todos los valores son strings según sección 4.6.
 */
export function serializarCamposStream(evento: EventoCambio): string[] {
  const campos: string[] = [
    'tipo',
    evento.tipo,
    'acta',
    evento.acta,
    'version',
    String(evento.version),
    'mesa',
    String(evento.mesa),
    'puesto',
    String(evento.puesto),
    'municipio',
    String(evento.municipio),
    'delta',
    JSON.stringify(evento.delta),
    'informadas',
    String(evento.informadas),
    'ts_recibido',
    String(evento.ts_recibido),
  ];
  if (evento.motivo !== undefined) {
    campos.push('motivo', evento.motivo);
  }
  return campos;
}

/**
 * Deserializa la lista devuelta por XRANGE en un EventoCambio interpretado.
 */
export function deserializarCamposStream(lista: string[]): EventoCambio {
  const obj: Record<string, string> = {};
  for (let i = 0; i < lista.length; i += 2) {
    obj[lista[i]] = lista[i + 1];
  }
  return {
    tipo: (obj.tipo as TipoEvento) ?? 'aplicada',
    acta: obj.acta ?? '',
    version: Number(obj.version ?? 1),
    mesa: Number(obj.mesa ?? 0),
    puesto: Number(obj.puesto ?? 0),
    municipio: Number(obj.municipio ?? 0),
    delta: obj.delta ? (JSON.parse(obj.delta) as Delta) : {},
    informadas: Number(obj.informadas ?? 0) as 0 | 1,
    ts_recibido: Number(obj.ts_recibido ?? Date.now()),
    motivo: obj.motivo,
  };
}

/**
 * Escribe un evento en ev:mun:{m} y ev:dep, publica en pub:mun:{m} y pub:dep,
 * y actualiza tot:* y rank:* de forma coherente.
 */
export async function emitirEventoFalso(
  redis: Redis,
  eventoParcial: OpcionesEventoFalso = {},
): Promise<{ seqMun: string; seqDep: string; evento: EventoCambio }> {
  const m = eventoParcial.municipio ?? 11;
  const p = eventoParcial.puesto ?? 176;
  const mesa = eventoParcial.mesa ?? 4201;

  const delta: Delta =
    eventoParcial.delta ?? {
      C1: Math.floor(Math.random() * 50) + 1,
      C2: Math.floor(Math.random() * 30),
    };

  const evento: EventoCambio = {
    tipo: eventoParcial.tipo ?? 'aplicada',
    acta: eventoParcial.acta ?? `E14-${p}-${String(mesa).padStart(4, '0')}-01`,
    version: eventoParcial.version ?? 1,
    mesa,
    puesto: p,
    municipio: m,
    delta,
    informadas: eventoParcial.informadas ?? 1,
    ts_recibido: eventoParcial.ts_recibido ?? Date.now(),
    motivo: eventoParcial.motivo,
  };

  const campos = serializarCamposStream(evento);

  // 1. Escribir a ev:mun:{m} y ev:dep con retención MAXLEN
  const seqMun = (await redis.xadd(
    claves.evMun(m),
    'MAXLEN',
    '~',
    String(MAXLEN.evMun),
    '*',
    ...campos,
  )) as string;

  const seqDep = (await redis.xadd(
    claves.evDep(),
    'MAXLEN',
    '~',
    String(MAXLEN.evDep),
    '*',
    ...campos,
  )) as string;

  // 2. Publicar avisos con el seq recién escrito
  await redis.publish(claves.pubMun(m), seqMun);
  await redis.publish(claves.pubDep(), seqDep);

  // 3. Actualizar tot:* y rank:* en un pipeline multi
  const pipe = redis.multi();

  const nivelesTot = [
    claves.totDep(),
    claves.totMun(m),
    claves.totPue(p),
    claves.totMesa(mesa),
  ];
  const nivelesRank = [claves.rankDep(), claves.rankMun(m), claves.rankPue(p)];

  for (const [cand, diff] of Object.entries(evento.delta)) {
    if (diff === undefined || diff === 0) continue;
    for (const claveTot of nivelesTot) {
      pipe.hincrby(claveTot, cand, diff);
    }
    for (const claveRank of nivelesRank) {
      pipe.zincrby(claveRank, diff, cand);
    }
  }

  if (evento.informadas === 1) {
    for (const claveTot of nivelesTot) {
      pipe.hincrby(claveTot, '_informadas', 1);
    }
  }

  await pipe.exec();

  return { seqMun, seqDep, evento };
}

/** Inicializa totales y catálogos de prueba si no existen */
export async function inicializarCatalogoPrueba(
  redis: Redis,
  opciones: { municipios?: number[]; puestosPorMun?: number; mesasPorPuesto?: number } = {},
): Promise<void> {
  const municipios = opciones.municipios ?? [11, 12];
  const puestosPorMun = opciones.puestosPorMun ?? 2;
  const mesasPorPuesto = opciones.mesasPorPuesto ?? 5;

  let totalMesasDep = 0;
  const pipe = redis.multi();

  for (const m of municipios) {
    let totalMesasMun = 0;
    for (let pIdx = 1; pIdx <= puestosPorMun; pIdx++) {
      const p = m * 10 + pIdx;
      pipe.set(claves.catTotalPue(p), String(mesasPorPuesto));
      totalMesasMun += mesasPorPuesto;
    }
    pipe.set(claves.catTotalMun(m), String(totalMesasMun));
    totalMesasDep += totalMesasMun;
  }
  pipe.set(claves.catTotalDep(), String(totalMesasDep));

  // Asegura que candidatos existan en ranking con score 0 si no existen
  for (const c of CANDIDATOS) {
    pipe.zadd(claves.rankDep(), 'NX', 0, c);
    for (const m of municipios) {
      pipe.zadd(claves.rankMun(m), 'NX', 0, c);
    }
  }

  await pipe.exec();
}
