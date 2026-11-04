/**
 * Módulo público — DUEÑO: Persona 2.
 */
import type { Server } from 'node:http';
import type { Express } from 'express';
import type { Ctx } from '../../compartido/contexto.js';
import { GestorSse } from './gestor-sse.js';
import { manejarSnapshot } from './snapshot.js';
import { manejarSse } from './sse.js';

let gestorSseSingleton: GestorSse | undefined;

export function obtenerGestorSse(ctx?: Ctx): GestorSse {
  if (!gestorSseSingleton && ctx) {
    gestorSseSingleton = new GestorSse(ctx);
  }
  if (!gestorSseSingleton) {
    throw new Error('GestorSse no ha sido inicializado');
  }
  return gestorSseSingleton;
}

export function montarPublico(app: Express, ctx: Ctx, _server: Server): void {
  const gestor = obtenerGestorSse(ctx);

  app.get('/api/snapshot', (req, res) => {
    void manejarSnapshot(req, res, ctx.redis);
  });

  app.get('/sse', (req, res) => {
    manejarSse(req, res, gestor);
  });
}
