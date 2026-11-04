/** Validación de forma del Acta (contrato 4.1) — DUEÑO: Persona 1. */
import { CANDIDATOS, type Acta, type Votos } from '../../compartido/contratos.js';

const RE_ACTA = /^E14-(\d+)-(\d{4})-(\d{2})$/;
const RE_IDEM = /^[A-Za-z0-9_-]{8,64}$/;

const entero = (x: unknown, min: number): x is number => Number.isInteger(x) && (x as number) >= min;
const texto = (x: unknown, max: number): x is string => typeof x === 'string' && x.length > 0 && x.length <= max;

/** Devuelve el Acta normalizada, o un motivo de rechazo. */
export function validarActa(cuerpo: unknown): { acta: Acta } | { motivo: string } {
  if (typeof cuerpo !== 'object' || cuerpo === null || Array.isArray(cuerpo)) return { motivo: 'json' };
  const b = cuerpo as Record<string, unknown>;

  if (!texto(b.acta, 64)) return { motivo: 'acta' };
  const m = RE_ACTA.exec(b.acta);
  if (!m) return { motivo: 'acta_formato' };
  for (const campo of ['mesa', 'puesto', 'municipio', 'version'] as const) {
    if (!entero(b[campo], 1)) return { motivo: campo };
  }
  if (Number(m[1]) !== b.puesto) return { motivo: 'acta_puesto' };
  if (!texto(b.jurado, 64)) return { motivo: 'jurado' };
  if (!entero(b.ts_cierre, 0)) return { motivo: 'ts_cierre' };
  if (!entero(b.sufragantes, 0)) return { motivo: 'sufragantes' };
  if (typeof b.hash_foto !== 'string' || b.hash_foto.length > 128) return { motivo: 'hash_foto' };
  if (typeof b.idem !== 'string' || !RE_IDEM.test(b.idem)) return { motivo: 'idem' };

  const v = b.votos;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { motivo: 'votos' };
  const vv = v as Record<string, unknown>;
  if (Object.keys(vv).length !== CANDIDATOS.length) return { motivo: 'votos_candidatos' };
  for (const c of CANDIDATOS) if (!entero(vv[c], 0)) return { motivo: `votos_${c}` };

  return {
    acta: {
      acta: b.acta,
      mesa: b.mesa as number,
      puesto: b.puesto as number,
      municipio: b.municipio as number,
      version: b.version as number,
      jurado: b.jurado,
      ts_cierre: b.ts_cierre,
      votos: Object.fromEntries(CANDIDATOS.map((c) => [c, vv[c]])) as Votos,
      sufragantes: b.sufragantes,
      hash_foto: b.hash_foto,
      idem: b.idem,
    },
  };
}
