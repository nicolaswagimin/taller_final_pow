/**
 * Módulo de jurados — DUEÑO: Persona 1.
 *   POST /api/actas               → tabla 4.3 (siempre inequívoca)
 *   GET  /api/actas/:acta/estado  → { acta, version_vigente, estado, motivo? } (polling del jurado)
 */
import type { ErrorRequestHandler, Express } from 'express';
import { claves, TTL } from '../../compartido/claves.js';
import type { Ctx } from '../../compartido/contexto.js';
import type { EstadoActa, RespuestaEstadoActa, RespuestaPostActa } from '../../compartido/contratos.js';
import { aplicarActa, contarRechazo, publicarMetricas } from './aplicar.js';
import { validarActa } from './validar.js';

export { aplicarActa, nuevaVersionDesde, generarIdem } from './aplicar.js';
export type { Origen, ResultadoAplicar } from './aplicar.js';

const LIMITE_POR_MINUTO = 30;
const NO_DISPONIBLE: RespuestaPostActa = { estado: 'no_disponible' };

export function montarJurados(app: Express, ctx: Ctx): void {
  const listo = () => ctx.redis.status === 'ready';

  app.post('/api/actas', async (req, res) => {
    const v = validarActa(req.body);
    if ('motivo' in v) {
      contarRechazo(ctx, 'invalida');
      res.status(400).json({ estado: 'invalida', motivo: v.motivo } satisfies RespuestaPostActa);
      return;
    }
    if (!listo()) {
      contarRechazo(ctx, 'no_disponible');
      res.status(503).json(NO_DISPONIBLE);
      return;
    }

    // Límite de tasa: INCR rl:{jurado}:{minuto}; > 30 → 429 + Retry-After
    const ahora = Date.now();
    const minuto = Math.floor(ahora / 60_000);
    let envios: number;
    try {
      const r = await ctx.redis.multi().incr(claves.rl(v.acta.jurado, minuto)).expire(claves.rl(v.acta.jurado, minuto), TTL.rlSeg).exec();
      envios = Number(r?.[0]?.[1]);
    } catch {
      contarRechazo(ctx, 'no_disponible');
      res.status(503).json(NO_DISPONIBLE);
      return;
    }
    if (envios > LIMITE_POR_MINUTO) {
      contarRechazo(ctx, 'limite');
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(((minuto + 1) * 60_000 - ahora) / 1000))));
      res.status(429).json({ estado: 'limite' } satisfies RespuestaPostActa);
      return;
    }

    const { http, respuesta } = await aplicarActa(ctx, v.acta, 'jurado');
    res.status(http).json(respuesta);
  });

  app.get('/api/actas/:acta/estado', async (req, res) => {
    if (!listo()) {
      res.status(503).json(NO_DISPONIBLE);
      return;
    }
    try {
      const [version, estado, motivo] = await ctx.redis.hmget(claves.acta(req.params.acta), 'version', 'estado', 'motivo');
      if (!version) {
        res.status(404).json({ acta: req.params.acta, motivo: 'no_encontrada' });
        return;
      }
      const cuerpo: RespuestaEstadoActa = { acta: req.params.acta, version_vigente: Number(version), estado: estado as EstadoActa };
      if (motivo) cuerpo.motivo = motivo;
      res.setHeader('Cache-Control', 'no-store');
      res.json(cuerpo);
    } catch {
      res.status(503).json(NO_DISPONIBLE);
    }
  });

  // JSON mal formado (lo detecta express.json antes de llegar a la ruta) → 400 "invalida"
  const errorJson: ErrorRequestHandler = (err, _req, res, next) => {
    const status = (err as { status?: number }).status ?? 500;
    if (status >= 400 && status < 500) {
      contarRechazo(ctx, 'invalida');
      res.status(400).json({ estado: 'invalida', motivo: 'json' } satisfies RespuestaPostActa);
      return;
    }
    next(err);
  };
  app.use('/api/actas', errorJson);

  const t = setInterval(() => publicarMetricas(ctx), 2_000);
  t.unref();
}
