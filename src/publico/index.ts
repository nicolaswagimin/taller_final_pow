/**
 * Módulo público — DUEÑO: Persona 2.
 */
import type { Server } from 'node:http';
import type { Express } from 'express';
import type { Ctx } from '../../compartido/contexto.js';
import { manejarSnapshot } from './snapshot.js';

export function montarPublico(app: Express, ctx: Ctx, _server: Server): void {
  app.get('/api/snapshot', (req, res) => {
    void manejarSnapshot(req, res, ctx.redis);
  });

  const pendiente = { pendiente: 'Persona 2' };
  app.get('/sse', (_req, res) => {
    res.status(501).json(pendiente);
  });
}
