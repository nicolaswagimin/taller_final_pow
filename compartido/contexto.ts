import type { Redis } from 'ioredis';
import type { Metricas } from '../src/metricas/index.js';

/** Contexto que recibe cada módulo en su función de montaje (sección 3). */
export type Ctx = {
  redis: Redis;
  redisSub: Redis;
  instancia: string;
  metricas: Metricas;
};
