/**
 * Módulo de verificación (auditores, WebSocket 4.7) — DUEÑO: Persona 3.
 * RF-7 (bloqueo con dueño), RF-8 (presencia), RF-10a (Redis caído), RT-2 (sin sticky).
 *
 *   GET /ws/verificacion?auditor=AUD-XXX   (upgrade, registrado con registrarUpgrade)
 *
 * RT-2: nginx reparte sin sticky, así que dos auditores que miran la misma acta casi siempre
 * están en instancias distintas. Por eso NINGÚN estado importante vive en esta instancia: el
 * dueño de cada acta está en lock:acta:{acta}, la presencia en pres:{auditor} / pres:idx y los
 * eventos cruzan instancias por pub:verif. Lo único local es el token de cada conexión (que
 * prueba que el lock es suyo) y la lista de sockets a los que reenviar.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Express } from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { claves, TTL } from '../../compartido/claves.js';
import type { Ctx } from '../../compartido/contexto.js';
import {
  CANDIDATOS,
  type Acta,
  type AuditorPresente,
  type ItemColaVerif,
  type Presencia,
  type RespuestaPostActa,
  type Votos,
  type WsClienteServidor,
  type WsServidorCliente,
} from '../../compartido/contratos.js';
import { registrarUpgrade } from '../upgrade.js';
import { duenoDe, liberarLock, renovarLock, tomarLock, valorLock } from './bloqueos.js';

export const RUTA_WS_VERIFICACION = '/ws/verificacion';
const RE_AUDITOR = /^AUD-[A-Za-z0-9_-]{1,32}$/;
const RE_ACTA = /^[A-Za-z0-9_-]{1,64}$/;

export interface OpcionesVerificacion {
  /** PX del lock (RF-7). */
  lockMs: number;
  /** EX de pres:{auditor} (RF-8). */
  presSeg: number;
  /** El coordinador ve los latidos de esta ventana (RF-8). */
  ventanaPresenciaMs: number;
  /** Cada cuánto se revisan locks vencidos, la cola y la presencia. */
  tickMs: number;
  /** Máximo de actas que se envían en "cola". */
  colaMax: number;
  /** Cómo se aprueba un acta; por defecto aplicarActa de la Persona 1. */
  aprobador: Aprobador;
}

export type ResultadoAprobar =
  | { ok: true }
  | { ok: false; motivo: 'redis_caido' | 'no_aplicada'; detalle?: string };

/** Reaplica el acta con los votos aprobados (4.7: versión siguiente, idem nuevo). */
export type Aprobador = (ctx: Ctx, acta: string, votos: Votos | undefined, auditor: string) => Promise<ResultadoAprobar>;

// ---------------------------------------------------------------------------
// Aprobar con aplicarActa de la Persona 1
// ---------------------------------------------------------------------------

/** Interfaz que exporta src/jurados/aplicar.ts (rama p1-jurados). */
interface ModuloAplicarP1 {
  aplicarActa(ctx: Ctx, acta: Acta, origen: 'jurado' | 'auditor', motivo?: string): Promise<{ http: number; respuesta: RespuestaPostActa }>;
  nuevaVersionDesde(ctx: Ctx, actaId: string, votos: Votos, opciones?: { sufragantes?: number; jurado?: string }): Promise<Acta>;
}

let moduloP1: Promise<ModuloAplicarP1 | null> | undefined;
function cargarModuloP1(): Promise<ModuloAplicarP1 | null> {
  // TODO(Persona 1 → main): cuando p1-jurados esté fusionada, cambiar por
  //   import { aplicarActa, nuevaVersionDesde } from '../jurados/aplicar.js';
  // Mientras tanto se carga en caliente para que esta rama compile sin ese archivo.
  const ruta = '../jurados/aplicar.js';
  moduloP1 ??= import(ruta).then(
    (m: Partial<ModuloAplicarP1>) => (m.aplicarActa && m.nuevaVersionDesde ? (m as ModuloAplicarP1) : null),
    () => null,
  );
  return moduloP1;
}

const suma = (v: Votos) => CANDIDATOS.reduce((a, c) => a + v[c], 0);

export const aprobarConAplicarActa: Aprobador = async (ctx, acta, votos, auditor) => {
  const guardados = await ctx.redis.hget(claves.acta(acta), 'votos');
  const finales: Votos | null = votos ?? (guardados ? (JSON.parse(guardados) as Votos) : null);
  if (!finales) return { ok: false, motivo: 'no_aplicada', detalle: 'acta_sin_votos' };
  const p1 = await cargarModuloP1();
  if (!p1) {
    // TODO(Persona 1): sin aplicarActa todavía no se suma nada; solo se resuelve el caso.
    console.warn(`[verificacion] ${acta} aprobada por ${auditor} SIN sumar: falta src/jurados/aplicar.ts (P1)`);
    return { ok: true };
  }
  // El auditor certifica los votos contados, así que sufragantes = suma(votos): la versión
  // nueva cuadra y aplicar_acta.lua la suma (y hace ZREM cola:verif).
  const nueva = await p1.nuevaVersionDesde(ctx, acta, finales, { sufragantes: suma(finales) });
  const { respuesta } = await p1.aplicarActa(ctx, nueva, 'auditor', `aprobada por ${auditor}`);
  if (respuesta.estado === 'registrada' || respuesta.estado === 'duplicada') return { ok: true };
  if (respuesta.estado === 'no_disponible') return { ok: false, motivo: 'redis_caido' };
  return { ok: false, motivo: 'no_aplicada', detalle: respuesta.estado };
};

// ---------------------------------------------------------------------------
// Validación de mensajes del cliente (4.7)
// ---------------------------------------------------------------------------

function esVotos(x: unknown): x is Votos {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    Object.keys(o).length === CANDIDATOS.length &&
    CANDIDATOS.every((c) => Number.isInteger(o[c]) && (o[c] as number) >= 0)
  );
}

function leerMensaje(datos: unknown): WsClienteServidor | null {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(String(datos)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object') return null;
  const actaOk = typeof m.acta === 'string' && RE_ACTA.test(m.acta);
  switch (m.t) {
    case 'tomar':
    case 'liberar':
      return actaOk ? { t: m.t, acta: m.acta as string } : null;
    case 'latido':
      return { t: 'latido', activo: m.activo === true };
    case 'resolver':
      if (!actaOk || (m.decision !== 'aprobar' && m.decision !== 'rechazar')) return null;
      if (m.votos !== undefined && !esVotos(m.votos)) return null;
      return { t: 'resolver', acta: m.acta as string, decision: m.decision, votos: m.votos as Votos | undefined };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Montaje
// ---------------------------------------------------------------------------

interface Conexion {
  ws: WebSocket;
  auditor: string;
  /** "{auditor}:{token}". El token (crypto.randomUUID) vive solo aquí, en memoria. */
  valor: string;
  /** actas cuyo lock tiene esta conexión → desde cuándo (ms) */
  actas: Map<string, number>;
  conectadoDesde: number;
  vivo: boolean;
}

/** Instantánea de la cola: acta → auditor dueño del lock (o null). */
type Foto = Map<string, string | null>;

export function montarVerificacion(
  app: Express,
  ctx: Ctx,
  server: Server,
  opcionesParciales: Partial<OpcionesVerificacion> = {},
): { cerrar(): void } {
  const op: OpcionesVerificacion = {
    lockMs: TTL.lockMs,
    presSeg: TTL.presSeg,
    ventanaPresenciaMs: TTL.presSeg * 1_000,
    tickMs: 5_000,
    colaMax: 200,
    aprobador: aprobarConAplicarActa,
    ...opcionesParciales,
  };
  const { redis, redisSub, instancia, metricas } = ctx;
  const conexiones = new Set<Conexion>();
  let fotoAnterior: Foto | null = null;
  let redisCaido = redis.status !== 'ready';

  // --- Envío ---------------------------------------------------------------
  function enviarCrudo(c: Conexion, texto: string): void {
    if (c.ws.readyState !== WebSocket.OPEN) return;
    c.ws.send(texto);
    metricas.incrementar('ws_mensajes_emitidos');
  }
  const enviar = (c: Conexion, m: WsServidorCliente) => enviarCrudo(c, JSON.stringify(m));
  function difundirLocal(m: WsServidorCliente | string): void {
    const texto = typeof m === 'string' ? m : JSON.stringify(m); // se serializa una sola vez
    for (const c of conexiones) enviarCrudo(c, texto);
  }
  async function publicar(m: WsServidorCliente): Promise<void> {
    await redis.publish(claves.pubVerif(), JSON.stringify(m));
  }

  function reportarMetricas(locksActivos?: number): void {
    metricas.registrar('con_auditor', conexiones.size);
    let propios = 0;
    for (const c of conexiones) propios += c.actas.size;
    metricas.registrar('locks_propios', propios);
    if (locksActivos !== undefined) metricas.registrar('locks_activos', locksActivos);
  }

  // --- RF-10a: Redis caído ---------------------------------------------------
  function marcarCaido(): void {
    if (redisCaido) return;
    redisCaido = true;
    fotoAnterior = null;
    difundirLocal({ t: 'error', motivo: 'redis_caido' });
  }
  function marcarSano(): void {
    if (!redisCaido) return;
    redisCaido = false;
    // Cola y presencia frescas: la consola quita el banner rojo al recibir "cola".
    void refrescarTodos();
  }
  const alCaer = () => marcarCaido();
  const alVolver = () => {
    marcarSano();
    void suscribir();
  };
  redis.on('close', alCaer);
  redis.on('end', alCaer);
  redis.on('ready', alVolver);

  /** Corre una acción contra Redis; si falla, avisa redis_caido a esa conexión. */
  async function conRedis(c: Conexion, accion: () => Promise<void>): Promise<void> {
    if (redisCaido || redis.status !== 'ready') {
      enviar(c, { t: 'error', motivo: 'redis_caido' });
      return;
    }
    try {
      await accion();
    } catch (e) {
      console.warn(`[verificacion:${instancia}] ${(e as Error).message}`);
      enviar(c, { t: 'error', motivo: 'redis_caido' });
      if (redis.status !== 'ready') marcarCaido();
    }
  }

  // --- Lecturas --------------------------------------------------------------
  async function leerCola(): Promise<ItemColaVerif[]> {
    const plano = await redis.zrevrange(claves.colaVerif(), 0, op.colaMax - 1, 'WITHSCORES');
    const ids: string[] = [];
    const prioridades: number[] = [];
    for (let i = 0; i < plano.length; i += 2) {
      ids.push(plano[i]!);
      prioridades.push(Number(plano[i + 1]));
    }
    if (ids.length === 0) return [];
    const pipe = redis.pipeline();
    for (const id of ids) {
      pipe.get(claves.lock(id));
      pipe.hmget(claves.acta(id), 'version', 'mesa', 'puesto', 'municipio', 'votos', 'sufragantes', 'motivo', 'jurado');
    }
    const res = (await pipe.exec()) ?? [];
    return ids.map((acta, i) => {
      const [errL, lock] = res[2 * i] ?? [];
      const [errH, h] = res[2 * i + 1] ?? [];
      if (errL || errH) throw errL ?? errH;
      const [version, mesa, puesto, municipio, votos, sufragantes, motivo, jurado] = (h as Array<string | null>) ?? [];
      const num = (x: string | null | undefined) => (x == null ? null : Number(x));
      let votosObj: Votos | null = null;
      try {
        votosObj = votos ? (JSON.parse(votos) as Votos) : null;
      } catch {
        votosObj = null;
      }
      return {
        acta,
        prioridad: prioridades[i]!,
        auditor: duenoDe(lock as string | null),
        version: num(version),
        mesa: num(mesa),
        puesto: num(puesto),
        municipio: num(municipio),
        sufragantes: num(sufragantes),
        votos: votosObj,
        motivo: motivo ?? null,
        jurado: jurado ?? null,
      };
    });
  }

  async function leerPresencia(): Promise<AuditorPresente[]> {
    const limite = Date.now() - op.ventanaPresenciaMs;
    const [, [, ids]] = (await redis
      .multi()
      .zremrangebyscore(claves.presIdx(), '-inf', `(${limite}`)
      .zrangebyscore(claves.presIdx(), limite, '+inf')
      .exec()) as [[Error | null, number], [Error | null, string[]]];
    if (!ids || ids.length === 0) return [];
    const valores = await redis.mget(...ids.map((a) => claves.pres(a)));
    const salida: AuditorPresente[] = [];
    ids.forEach((auditor, i) => {
      const v = valores[i];
      if (!v) return; // pres:{auditor} ya expiró (EX)
      try {
        salida.push({ auditor, ...(JSON.parse(v) as Presencia) });
      } catch {
        /* valor corrupto: se ignora */
      }
    });
    return salida;
  }

  function fotoDe(items: ItemColaVerif[]): Foto {
    return new Map(items.map((i) => [i.acta, (i.auditor as string | null) ?? null]));
  }

  async function refrescarTodos(): Promise<void> {
    try {
      const [items, auditores] = await Promise.all([leerCola(), leerPresencia()]);
      fotoAnterior = fotoDe(items);
      difundirLocal({ t: 'cola', items });
      difundirLocal({ t: 'presencia', auditores });
    } catch {
      marcarCaido();
    }
  }

  // --- Presencia (RF-8) ------------------------------------------------------
  function presenciaDe(c: Conexion): Presencia {
    let acta: string | null = null;
    let desde = c.conectadoDesde;
    for (const [a, t] of c.actas) {
      if (acta === null || t >= desde) {
        acta = a;
        desde = t;
      }
    }
    return { instancia, acta, desde };
  }
  async function registrarPresencia(c: Conexion): Promise<void> {
    await redis
      .multi()
      .set(claves.pres(c.auditor), JSON.stringify(presenciaDe(c)), 'EX', op.presSeg)
      .zadd(claves.presIdx(), Date.now(), c.auditor)
      .exec();
  }

  // --- pub:verif: UNA suscripción por instancia que reenvía a sus auditores ----
  async function suscribir(): Promise<void> {
    if (redisSub.status !== 'ready') return;
    try {
      await redisSub.subscribe(claves.pubVerif()); // idempotente; ioredis la repite al reconectar
    } catch {
      /* se reintenta en el próximo 'ready' */
    }
  }
  const alMensaje = (canal: string, texto: string) => {
    if (canal !== claves.pubVerif()) return; // P2 puede compartir redisSub con sus canales
    let m: WsServidorCliente;
    try {
      m = JSON.parse(texto) as WsServidorCliente;
    } catch {
      return;
    }
    // Mantener la foto al día evita repetir en el próximo tick lo que ya llegó por pub/sub.
    if (m.t === 'tomado' || m.t === 'liberado' || m.t === 'resuelto') {
      if (fotoAnterior?.has(m.acta)) {
        if (m.t === 'tomado') fotoAnterior.set(m.acta, m.auditor);
        else if (m.t === 'liberado') fotoAnterior.set(m.acta, null);
        else fotoAnterior.delete(m.acta);
      }
      for (const c of conexiones) {
        if (m.t !== 'tomado' || m.auditor !== c.auditor) c.actas.delete(m.acta);
      }
    }
    difundirLocal(texto);
  };
  redisSub.on('message', alMensaje);
  redisSub.on('ready', suscribir);
  void suscribir();

  // --- Tick cada 5 s: locks vencidos, actas nuevas y presencia ----------------
  async function tick(): Promise<void> {
    if (conexiones.size === 0) {
      fotoAnterior = null;
      reportarMetricas();
      return;
    }
    if (redis.status !== 'ready') {
      marcarCaido();
      return;
    }
    let items: ItemColaVerif[];
    let auditores: AuditorPresente[];
    try {
      [items, auditores] = await Promise.all([leerCola(), leerPresencia()]);
    } catch {
      marcarCaido();
      return;
    }
    marcarSano();
    const foto = fotoDe(items);
    const previa = fotoAnterior;
    fotoAnterior = foto;

    if (previa) {
      const mismaCola = previa.size === foto.size && [...foto.keys()].every((a) => previa.has(a));
      if (!mismaCola) {
        // Entró un acta dudosa nueva (P1 hace ZADD sin avisar) o salió alguna: cola completa.
        difundirLocal({ t: 'cola', items });
      } else {
        for (const [acta, dueno] of foto) {
          const antes = previa.get(acta) ?? null;
          if (antes === dueno) continue;
          // Lock vencido (nadie mandó latido activo en lockMs): esta instancia avisa a SUS
          // auditores. Cada instancia lo detecta por su cuenta en vez de hacer PUBLISH, así no
          // llegan 8 copias y el aviso sale aunque la instancia del antiguo dueño haya muerto.
          if (dueno === null) difundirLocal({ t: 'liberado', acta });
          else difundirLocal({ t: 'tomado', acta, auditor: dueno });
        }
      }
    }
    // Las conexiones locales olvidan los locks que ya no son suyos (vencieron o los tomó otro).
    for (const c of conexiones) {
      for (const acta of c.actas.keys()) if (foto.get(acta) !== c.auditor) c.actas.delete(acta);
    }
    difundirLocal({ t: 'presencia', auditores });
    reportarMetricas([...foto.values()].filter((d) => d !== null).length);
  }
  let enTick = false;
  const temporizador = setInterval(() => {
    if (enTick) return;
    enTick = true;
    void tick().finally(() => (enTick = false));
  }, op.tickMs);
  temporizador.unref();

  // Ping de WebSocket: detecta sockets muertos (sin FIN) para que las métricas no mientan.
  const ping = setInterval(() => {
    for (const c of conexiones) {
      if (!c.vivo) {
        c.ws.terminate();
        continue;
      }
      c.vivo = false;
      c.ws.ping();
    }
  }, 30_000);
  ping.unref();

  // --- Acciones del protocolo 4.7 --------------------------------------------
  async function tomar(c: Conexion, acta: string): Promise<void> {
    const ahora = Date.now();
    const res = await tomarLock(redis, {
      acta,
      auditor: c.auditor,
      valor: c.valor,
      presencia: { instancia, acta, desde: ahora },
      ttlMs: op.lockMs,
      presSeg: op.presSeg,
      ahora,
    });
    if (res.ok) {
      c.actas.set(acta, ahora);
      reportarMetricas();
      await publicar({ t: 'tomado', acta, auditor: c.auditor });
    } else if (res.motivo === 'ya_tomado') {
      enviar(c, { t: 'error', motivo: 'ya_tomado' });
    } else {
      enviar(c, { t: 'resuelto', acta }); // ya no está en cola:verif: su vista estaba vieja
    }
  }

  async function latido(c: Conexion, activo: boolean): Promise<void> {
    // Solo se renueva si hubo teclado o mouse en los últimos 10 min (lo decide la consola).
    // Si no, el lock vence solo en ≤ lockMs y el caso vuelve a la cola.
    for (const acta of [...c.actas.keys()]) {
      const sigue = activo
        ? await renovarLock(redis, acta, c.valor, op.lockMs)
        : (await redis.get(claves.lock(acta))) === c.valor; // sin renovar: solo mirar si sigue
      if (!sigue) c.actas.delete(acta);
    }
    await registrarPresencia(c); // siempre: SET pres:{auditor} EX + ZADD pres:idx
  }

  async function liberar(c: Conexion, acta: string): Promise<void> {
    if ((await liberarLock(redis, acta, c.valor)) !== 'ok') {
      c.actas.delete(acta);
      enviar(c, { t: 'error', motivo: 'no_eres_dueno' });
      return;
    }
    c.actas.delete(acta);
    reportarMetricas();
    await publicar({ t: 'liberado', acta });
    await registrarPresencia(c);
  }

  async function resolver(c: Conexion, acta: string, decision: 'aprobar' | 'rechazar', votos?: Votos): Promise<void> {
    // Renovar comparando dueño sirve de comprobación y da tiempo a aplicarActa.
    if (!(await renovarLock(redis, acta, c.valor, op.lockMs))) {
      c.actas.delete(acta);
      enviar(c, { t: 'error', motivo: 'no_eres_dueno' });
      return;
    }
    if (decision === 'rechazar') {
      await redis
        .multi()
        .hset(claves.acta(acta), { estado: 'rechazada', motivo: `rechazada por ${c.auditor}` })
        .zrem(claves.colaVerif(), acta)
        .exec();
    } else {
      const r = await op.aprobador(ctx, acta, votos, c.auditor);
      if (!r.ok && r.motivo === 'redis_caido') {
        enviar(c, { t: 'error', motivo: 'redis_caido' });
        return; // el lock sigue siendo suyo: puede reintentar
      }
      if (!r.ok) {
        // No se aplicó (p. ej. llegó una versión mayor del jurado): el caso vuelve a la cola.
        console.warn(`[verificacion:${instancia}] ${acta} no se aplicó: ${r.detalle ?? r.motivo}`);
        await liberar(c, acta);
        return;
      }
      await redis.zrem(claves.colaVerif(), acta); // aplicar_acta ya lo hace; es idempotente
    }
    await liberarLock(redis, acta, c.valor);
    c.actas.delete(acta);
    reportarMetricas();
    await publicar({ t: 'resuelto', acta });
    await registrarPresencia(c);
  }

  // --- Conexiones -------------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  // Muestra qué instancia aceptó el upgrade (RT-2: sin sticky, puede ser cualquiera).
  wss.on('headers', (headers) => headers.push(`X-Instancia: ${instancia}`));

  registrarUpgrade(server, RUTA_WS_VERIFICACION, (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const auditor = new URL(req.url ?? '/', 'http://x').searchParams.get('auditor') ?? '';
    if (!RE_AUDITOR.test(auditor)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, auditor));
  });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, auditor: string) => {
    const c: Conexion = {
      ws,
      auditor,
      valor: valorLock(auditor, randomUUID()),
      actas: new Map(),
      conectadoDesde: Date.now(),
      vivo: true,
    };
    conexiones.add(c);
    metricas.conexionAbierta('ws');
    reportarMetricas();
    ws.on('pong', () => (c.vivo = true));

    // Al cerrarse el socket NO se libera nada de inmediato: puede ser un bache de red y el
    // auditor volverá en segundos (a otra instancia, porque no hay sticky). Si de verdad se
    // fue, sin latidos el lock vence solo en lockMs (30 s) y pres:{auditor} en presSeg (30 s);
    // el tick de cualquier instancia avisa "liberado" y lo saca de la presencia.
    // El token muere con la conexión: la nueva conexión no puede renovar el lock viejo, así que
    // el caso vuelve a la cola en ≤ 30 s y el auditor lo puede volver a tomar.
    ws.once('close', () => {
      conexiones.delete(c);
      metricas.conexionCerrada('ws');
      reportarMetricas();
    });

    ws.on('message', (datos) => {
      c.vivo = true;
      const m = leerMensaje(datos);
      if (!m) return;
      void conRedis(c, async () => {
        switch (m.t) {
          case 'tomar':
            return tomar(c, m.acta);
          case 'latido':
            return latido(c, m.activo);
          case 'liberar':
            return liberar(c, m.acta);
          case 'resolver':
            return resolver(c, m.acta, m.decision, m.votos);
        }
      });
    });

    // Estado inicial: cola + presencia (o el aviso de Redis caído).
    void conRedis(c, async () => {
      await registrarPresencia(c);
      const [items, auditores] = await Promise.all([leerCola(), leerPresencia()]);
      fotoAnterior ??= fotoDe(items); // referencia para avisar lo que cambie desde aquí
      enviar(c, { t: 'cola', items });
      enviar(c, { t: 'presencia', auditores });
    });
  });

  // GET sin upgrade: no hay nada que servir por HTTP plano.
  app.get(RUTA_WS_VERIFICACION, (_req, res) => {
    res.status(426).setHeader('Upgrade', 'websocket').json({ error: 'usar WebSocket' });
  });

  return {
    cerrar() {
      clearInterval(temporizador);
      clearInterval(ping);
      redis.off('close', alCaer);
      redis.off('end', alCaer);
      redis.off('ready', alVolver);
      redisSub.off('message', alMensaje);
      redisSub.off('ready', suscribir);
      for (const c of conexiones) c.ws.terminate();
      wss.close();
    },
  };
}
