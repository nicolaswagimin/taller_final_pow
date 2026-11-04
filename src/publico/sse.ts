import type { Request, Response } from 'express';
import type { Topico } from '../../compartido/contratos.js';
import type { GestorSse } from './gestor-sse.js';
import { esTopicoValido } from './snapshot.js';

export function manejarSse(req: Request, res: Response, gestor: GestorSse): void {
  const topicoParam = req.query.topico;
  if (typeof topicoParam !== 'string' || !esTopicoValido(topicoParam)) {
    res.status(400).json({ error: 'Parámetro "topico" requerido y debe ser dep, mun:{m} o pue:{p}' });
    return;
  }

  const topico: Topico = topicoParam;
  void gestor.altaConexion(topico, req, res);
}
