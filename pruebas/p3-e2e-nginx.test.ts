// Persona 3 — prueba de la sección 6 contra el sistema completo (nginx :80 → app ×8 → redis).
// Solo corre si se pide, porque necesita `docker compose up -d --build` y el puerto 6379 publicado
// (docker-compose.override.yml local con `ports: ["6379:6379"]` en el servicio redis):
//
//   E2E_URL=http://localhost E2E_REDIS_URL=redis://localhost:6379 npx vitest run pruebas/p3-e2e-nginx.test.ts
//
// Abre conexiones a través de nginx hasta que X-Instancia difiera (round-robin, sin sticky) y
// pide la misma acta desde las dos a la vez.
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claves } from '../compartido/claves.js';
import type { WsServidorCliente } from '../compartido/contratos.js';
import { sembrarDudosas } from '../scripts/dudosas-demo.js';
import { conectar, esperar, type ClienteWs } from './ayuda/p3.js';

const E2E_URL = process.env.E2E_URL;
const URL_WS = E2E_URL?.replace(/^http/, 'ws') + '/ws/verificacion';

describe.runIf(Boolean(E2E_URL))('E2E a través de nginx', () => {
  let r: Redis;
  const abiertos: ClienteWs[] = [];
  let acta = '';

  beforeAll(async () => {
    r = new Redis(process.env.E2E_REDIS_URL ?? 'redis://localhost:6379');
    const [primera] = await sembrarDudosas(r, 10);
    acta = primera!.acta;
  });
  afterAll(async () => {
    for (const c of abiertos) c.ws.terminate();
    await r.del(claves.lock(acta));
    await r.quit();
  });

  async function enOtraInstancia(que: string, auditor: string): Promise<ClienteWs> {
    for (let i = 0; i < 32; i++) {
      const c = await conectar(URL_WS, auditor);
      if (c.instancia && c.instancia !== que) {
        abiertos.push(c);
        return c;
      }
      c.ws.terminate();
    }
    throw new Error('nginx siempre devolvió la misma instancia: ¿hay sticky o una sola réplica?');
  }

  it('dos auditores en instancias distintas no toman la misma acta', async () => {
    const c1 = await conectar(URL_WS, 'AUD-E2E1');
    abiertos.push(c1);
    expect(c1.instancia).toBeTruthy();
    const c2 = await enOtraInstancia(c1.instancia!, 'AUD-E2E2');
    expect(c2.instancia).not.toBe(c1.instancia);
    await Promise.all([c1.esperar((m) => m.t === 'cola'), c2.esperar((m) => m.t === 'cola')]);

    c1.enviar({ t: 'tomar', acta });
    c2.enviar({ t: 'tomar', acta });
    const esTomado = (m: WsServidorCliente) => m.t === 'tomado' && m.acta === acta;
    const t1 = await c1.esperar(esTomado);
    const t2 = await c2.esperar(esTomado);
    expect(t1).toEqual(t2);
    await esperar(300);
    const errores = [...c1.mensajes, ...c2.mensajes].filter((m) => m.t === 'error' && m.motivo === 'ya_tomado');
    expect(errores).toHaveLength(1);
  });
});
