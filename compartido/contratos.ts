/**
 * Contratos compartidos — copia fiel de docs/DISEÑO.md, sección 4.
 * NO cambiar sin avisar a las otras dos personas y actualizar DISEÑO.md en el mismo PR.
 */

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------

/** Candidatos y categorías especiales del catálogo sintético (sección 1, supuestos). */
export const CANDIDATOS = ['C1', 'C2', 'C3', 'BLANCO', 'NULO', 'NO_MARCADO'] as const;
export type Candidato = (typeof CANDIDATOS)[number];

/** candidato → votos */
export type Votos = Record<Candidato, number>;
/** candidato → variación (puede ser negativa); solo trae los candidatos que cambiaron */
export type Delta = Partial<Record<Candidato, number>>;

/** Tópicos públicos: departamento, municipio o puesto. */
export type Topico = 'dep' | `mun:${number}` | `pue:${number}`;

// ---------------------------------------------------------------------------
// 4.1 Acta (entrada del jurado)
// ---------------------------------------------------------------------------

export interface Acta {
  /** `E14-{puesto}-{mesa}-{corporacion}` */
  acta: string;
  mesa: number;
  puesto: number;
  municipio: number;
  version: number;
  jurado: string;
  /** epoch en segundos */
  ts_cierre: number;
  votos: Votos;
  /** Regla contable: suma(votos) == sufragantes; si no cuadra → dudosa */
  sufragantes: number;
  hash_foto: string;
  /** clave de idempotencia */
  idem: string;
}

// ---------------------------------------------------------------------------
// 4.2 Endpoints HTTP
// ---------------------------------------------------------------------------

export type EstadoActa = 'contada' | 'dudosa' | 'rechazada';

/** GET /api/actas/:acta/estado */
export interface RespuestaEstadoActa {
  acta: string;
  version_vigente: number;
  estado: EstadoActa;
  motivo?: string;
}

/** GET /api/instancia */
export interface RespuestaInstancia {
  instancia: string;
}

// ---------------------------------------------------------------------------
// 4.3 Respuestas de POST /api/actas
// ---------------------------------------------------------------------------

/** 201 — se aplicó esta versión */
export interface RespuestaRegistrada {
  estado: 'registrada';
  acta: string;
  version: number;
  seq: string;
}
/** 200 — ya se había recibido este idem (o esta misma versión): misma respuesta original */
export interface RespuestaDuplicada {
  estado: 'duplicada';
  acta: string;
  version: number;
  /** presente si la respuesta original fue `registrada` */
  seq?: string;
  /** presente si la respuesta original fue `dudosa` */
  motivo?: string;
}
/** 200 — ya hay una versión mayor aplicada */
export interface RespuestaObsoleta {
  estado: 'obsoleta';
  acta: string;
  version_vigente: number;
}
/** 202 — registrada pero no suma: va a verificación */
export interface RespuestaDudosa {
  estado: 'dudosa';
  acta: string;
  version: number;
  motivo: string;
}
/** 400 — JSON mal formado o mesa inexistente */
export interface RespuestaInvalida {
  estado: 'invalida';
  motivo?: string;
}
/** 429 — más de 30 envíos por minuto por jurado (cabecera Retry-After) */
export interface RespuestaLimite {
  estado: 'limite';
}
/** 503 — Redis no responde; el jurado deja el acta "pendiente" y reintenta */
export interface RespuestaNoDisponible {
  estado: 'no_disponible';
}

export type RespuestaPostActa =
  | RespuestaRegistrada
  | RespuestaDuplicada
  | RespuestaObsoleta
  | RespuestaDudosa
  | RespuestaInvalida
  | RespuestaLimite
  | RespuestaNoDisponible;

export type EstadoPostActa = RespuestaPostActa['estado'];

/** Código HTTP de cada estado de POST /api/actas (tabla 4.3). */
export const HTTP_POR_ESTADO: Record<EstadoPostActa, number> = {
  registrada: 201,
  duplicada: 200,
  obsoleta: 200,
  dudosa: 202,
  invalida: 400,
  limite: 429,
  no_disponible: 503,
};

// ---------------------------------------------------------------------------
// 4.6 Evento de cambio (stream ev:*) y mensajes SSE
// ---------------------------------------------------------------------------

export type TipoEvento = 'aplicada' | 'correccion' | 'reversion';

/**
 * Entrada del stream `ev:mun:{m}` / `ev:dep`. En Redis todos los campos son texto;
 * esta es la forma ya interpretada.
 */
export interface EventoCambio {
  tipo: TipoEvento;
  acta: string;
  version: number;
  mesa: number;
  puesto: number;
  municipio: number;
  delta: Delta;
  /** 1 si es la primera vez que la mesa informa, 0 si no */
  informadas: 0 | 1;
  /** ms */
  ts_recibido: number;
  /** texto si es corrección */
  motivo?: string;
}

/** Campos tal como se guardan en el stream (todo string). */
export type EventoCambioCrudo = { [K in keyof EventoCambio]-?: string };

export interface Correccion {
  acta: string;
  motivo: string;
}

/** GET /api/snapshot y evento SSE `snapshot` (4.5/4.6) */
export interface Snapshot {
  topico: Topico;
  /** id del stream; también es el ETag */
  seq: string;
  totales: Votos;
  /** ordenado de mayor a menor */
  ranking: Array<{ candidato: Candidato; votos: number }>;
  informadas: number;
  total_mesas: number;
}

/** data del evento SSE `delta` (uno por ventana de 2 s y por tópico) */
export interface MensajeSseDelta {
  topico: Topico;
  seq: string;
  delta: Delta;
  informadas: number;
  total_mesas: number;
  /** explicación obligatoria cuando un número baja */
  correcciones: Correccion[];
}

/** data del evento SSE `estado` (RF-10) */
export interface MensajeSseEstado {
  degradado: boolean;
}

/** data del evento SSE `reconecta` (RF-9: cliente demasiado lento) */
export type MensajeSseReconecta = Record<string, never>;

export type EventoSse = 'delta' | 'snapshot' | 'estado' | 'reconecta';

/** Mensaje SSE completo: `id:`, `event:`, `retry:`, `data:` */
export type MensajeSse =
  | { id: string; event: 'delta'; retry?: number; data: MensajeSseDelta }
  | { id: string; event: 'snapshot'; retry?: number; data: Snapshot }
  | { id?: string; event: 'estado'; retry?: number; data: MensajeSseEstado }
  | { id?: string; event: 'reconecta'; retry?: number; data: MensajeSseReconecta };

// ---------------------------------------------------------------------------
// 4.7 Protocolo WebSocket de verificación
// ---------------------------------------------------------------------------

export type DecisionVerificacion = 'aprobar' | 'rechazar';

export type WsClienteServidor =
  | { t: 'tomar'; acta: string }
  | { t: 'latido'; activo: boolean }
  | { t: 'resolver'; acta: string; decision: DecisionVerificacion; votos?: Votos }
  | { t: 'liberar'; acta: string };

/** Elemento de la cola de verificación (cola:verif → acta con prioridad). */
export interface ItemColaVerif {
  acta: string;
  prioridad: number;
  [k: string]: unknown;
}

/** Contenido de pres:{auditor} */
export interface Presencia {
  instancia: string;
  acta: string | null;
  desde: number;
}

export interface AuditorPresente extends Presencia {
  auditor: string;
}

export type MotivoErrorWs = 'ya_tomado' | 'no_eres_dueno';

export type WsServidorCliente =
  | { t: 'cola'; items: ItemColaVerif[] }
  | { t: 'tomado'; acta: string; auditor: string }
  | { t: 'liberado'; acta: string }
  | { t: 'resuelto'; acta: string }
  | { t: 'presencia'; auditores: AuditorPresente[] }
  | { t: 'error'; motivo: MotivoErrorWs };
