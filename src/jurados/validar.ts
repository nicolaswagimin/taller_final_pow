/** Validación de forma del Acta (contrato 4.1) — DUEÑO: Persona 1. */
import { CANDIDATOS, type Acta, type Votos } from '../../compartido/contratos.js';

const RE_ACTA = /^E14-(\d+)-(\d{4})-(\d{2})$/;
const RE_IDEM = /^[A-Za-z0-9_-]{8,64}$/;

type Cuerpo = Record<string, unknown>;
type Resultado = { acta: Acta } | { motivo: string };

const entero = (x: unknown, min: number): x is number => Number.isInteger(x) && (x as number) >= min;
const texto = (x: unknown, max: number): x is string => typeof x === 'string' && x.length > 0 && x.length <= max;
const esObjeto = (x: unknown): x is Cuerpo => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Id de acta, ubicación y versión. Devuelve el motivo del primer error, o null. */
function errorDeIdentidad(b: Cuerpo): string | null {
  if (!texto(b.acta, 64)) return 'acta';
  const m = RE_ACTA.exec(b.acta);
  if (!m) return 'acta_formato';
  const campo = (['mesa', 'puesto', 'municipio', 'version'] as const).find((c) => !entero(b[c], 1));
  if (campo) return campo;
  return Number(m[1]) === b.puesto ? null : 'acta_puesto';
}

/** Campos escalares del jurado. */
function errorDeMetadatos(b: Cuerpo): string | null {
  const reglas: Array<[string, boolean]> = [
    ['jurado', texto(b.jurado, 64)],
    ['ts_cierre', entero(b.ts_cierre, 0)],
    ['sufragantes', entero(b.sufragantes, 0)],
    ['hash_foto', typeof b.hash_foto === 'string' && b.hash_foto.length <= 128],
    ['idem', typeof b.idem === 'string' && RE_IDEM.test(b.idem)],
  ];
  return reglas.find(([, ok]) => !ok)?.[0] ?? null;
}

/** Exactamente los 6 candidatos, enteros ≥ 0. */
function errorDeVotos(v: unknown): string | null {
  if (!esObjeto(v)) return 'votos';
  if (Object.keys(v).length !== CANDIDATOS.length) return 'votos_candidatos';
  const malo = CANDIDATOS.find((c) => !entero(v[c], 0));
  return malo ? `votos_${malo}` : null;
}

/** Devuelve el Acta normalizada, o un motivo de rechazo. */
export function validarActa(cuerpo: unknown): Resultado {
  if (!esObjeto(cuerpo)) return { motivo: 'json' };
  const motivo = errorDeIdentidad(cuerpo) ?? errorDeMetadatos(cuerpo) ?? errorDeVotos(cuerpo.votos);
  if (motivo) return { motivo };
  const b = cuerpo as unknown as Acta;
  return {
    acta: {
      acta: b.acta,
      mesa: b.mesa,
      puesto: b.puesto,
      municipio: b.municipio,
      version: b.version,
      jurado: b.jurado,
      ts_cierre: b.ts_cierre,
      votos: Object.fromEntries(CANDIDATOS.map((c) => [c, b.votos[c]])) as Votos,
      sufragantes: b.sufragantes,
      hash_foto: b.hash_foto,
      idem: b.idem,
    },
  };
}
