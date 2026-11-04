/**
 * Módulo público — DUEÑO: Persona 2.
 * TODO(Persona 2): GET /api/snapshot (Snapshot + ETag = seq) y GET /sse (flujo 4.6,
 *                  Last-Event-ID / ?desde=, ventana de 2 s, lotes, RF-9).
 * `server` queda disponible por si el módulo necesita upgrades (registrarUpgrade en ../upgrade.ts).
 */
import type { Server } from 'node:http';
import type { Express } from 'express';
import type { Ctx } from '../../compartido/contexto.js';

export function montarPublico(app: Express, _ctx: Ctx, _server: Server): void {
  const pendiente = { pendiente: 'Persona 2' };
  app.get('/api/snapshot', (_req, res) => {
    res.status(501).json(pendiente);
  });
  app.get('/sse', (_req, res) => {
    res.status(501).json(pendiente);
  });
}
