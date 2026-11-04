/**
 * Módulo de jurados — DUEÑO: Persona 1.
 * TODO(Persona 1): POST /api/actas (tabla 4.3, aplicar_acta.lua) y
 *                  GET /api/actas/:acta/estado (polling del jurado).
 */
import type { Express } from 'express';
import type { Ctx } from '../../compartido/contexto.js';

export function montarJurados(app: Express, _ctx: Ctx): void {
  const pendiente = { pendiente: 'Persona 1' };
  app.post('/api/actas', (_req, res) => {
    res.status(501).json(pendiente);
  });
  app.get('/api/actas/:acta/estado', (_req, res) => {
    res.status(501).json(pendiente);
  });
}
