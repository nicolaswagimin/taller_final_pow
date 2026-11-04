-- aplicar_acta.lua — DUEÑO: Persona 1 (secciones 4.3–4.6 de docs/DISEÑO.md).
-- Una sola ejecución atómica: Redis no intercala otros comandos mientras corre.
-- No hay rollback: TODO se valida antes de la primera escritura.
--
-- KEYS (todas las claves y canales llegan desde src/jurados/script.ts, construidos con claves.ts)
--   1 idem:{idem}        2 acta:{acta}        3 cat:mesa:{mesa}
--   4 tot:mesa:{mesa}    5 tot:pue:{p}        6 tot:mun:{m}       7 tot:dep
--   8 rank:pue:{p}       9 rank:mun:{m}      10 rank:dep
--  11 ev:mun:{m}        12 ev:dep           13 pub:mun:{m}      14 pub:dep
--  15 cola:verif
-- ARGV
--   1 acta (JSON, contrato 4.1)   2 ts_recibido (ms)   3 origen ("jurado" | "auditor")
--   4 motivo de la corrección ("" si no hay)   5 candidatos (JSON array)
--   6 TTL de idem (s)   7 MAXLEN ev:mun   8 MAXLEN ev:dep
-- Devuelve: JSON de la respuesta (tabla 4.3).

local function invalida(motivo)
  return cjson.encode({ estado = 'invalida', motivo = motivo })
end

-- 1. idem ya visto → misma respuesta original, con estado "duplicada"
local original = redis.call('GET', KEYS[1])
if original then
  local r = cjson.decode(original)
  r.estado = 'duplicada'
  return cjson.encode(r)
end

-- Validación de forma (la ruta ya validó; esto protege a otros llamadores, p. ej. la Persona 3)
local ok, a = pcall(cjson.decode, ARGV[1])
if not ok or type(a) ~= 'table' then return invalida('json') end
local candidatos = cjson.decode(ARGV[5])

local function entero(x, min)
  return type(x) == 'number' and x == math.floor(x) and x >= min
end
if type(a.acta) ~= 'string' or type(a.jurado) ~= 'string' or type(a.idem) ~= 'string'
   or not entero(a.version, 1) or not entero(a.mesa, 1) or not entero(a.puesto, 1)
   or not entero(a.municipio, 1) or not entero(a.sufragantes, 0) or type(a.votos) ~= 'table' then
  return invalida('forma')
end
local nVotos = 0
for _ in pairs(a.votos) do nVotos = nVotos + 1 end
if nVotos ~= #candidatos then return invalida('candidatos') end
local suma = 0
for _, c in ipairs(candidatos) do
  if not entero(a.votos[c], 0) then return invalida('votos') end
  suma = suma + a.votos[c]
end

-- Catálogo: la mesa existe y su puesto/municipio coinciden
local cat = redis.call('HMGET', KEYS[3], 'puesto', 'municipio')
if not cat[1] then return invalida('mesa_inexistente') end
if tonumber(cat[1]) ~= a.puesto or tonumber(cat[2]) ~= a.municipio then
  return invalida('mesa_no_coincide')
end

-- 2. Versión: gana siempre la mayor
local prev = redis.call('HMGET', KEYS[2], 'version', 'estado', 'votos', 'respuesta', 'mesa')
local vPrev = tonumber(prev[1])
if prev[5] and tonumber(prev[5]) ~= a.mesa then return invalida('acta_de_otra_mesa') end
if vPrev then
  if a.version < vPrev then
    return cjson.encode({ estado = 'obsoleta', acta = a.acta, version_vigente = vPrev })
  end
  if a.version == vPrev then
    local r = prev[4] and cjson.decode(prev[4]) or { acta = a.acta, version = vPrev }
    r.estado = 'duplicada'
    return cjson.encode(r)
  end
end

-- ---- A partir de aquí solo se escribe ----
local contadaPrev = prev[2] == 'contada'
local votosPrev = {}
if contadaPrev then votosPrev = cjson.decode(prev[3]) end

local niveles_tot = { KEYS[4], KEYS[5], KEYS[6], KEYS[7] }
local niveles_rank = { KEYS[8], KEYS[9], KEYS[10] }

local function aplicarDelta(delta)
  for _, c in ipairs(candidatos) do
    local d = delta[c] or 0
    for _, k in ipairs(niveles_tot) do redis.call('HINCRBY', k, c, d) end
    for _, k in ipairs(niveles_rank) do redis.call('ZINCRBY', k, d, c) end
  end
end

-- Solo los candidatos que cambian; {} si ninguno
local function soloCambios(delta)
  local t = {}
  for _, c in ipairs(candidatos) do
    if (delta[c] or 0) ~= 0 then t[c] = delta[c] end
  end
  if next(t) == nil then return '{}' end
  return cjson.encode(t)
end

local function emitir(tipo, delta, informadas, motivo)
  local campos = {
    'tipo', tipo, 'acta', a.acta, 'version', tostring(a.version), 'mesa', tostring(a.mesa),
    'puesto', tostring(a.puesto), 'municipio', tostring(a.municipio), 'delta', soloCambios(delta),
    'informadas', tostring(informadas), 'ts_recibido', ARGV[2],
  }
  if motivo and motivo ~= '' then
    campos[#campos + 1] = 'motivo'
    campos[#campos + 1] = motivo
  end
  -- Mismo id en ambos streams: todo id de ev:mun es también un id de ev:dep, así que el id
  -- recién generado en ev:dep siempre es mayor que el último de ev:mun.
  local id = redis.call('XADD', KEYS[12], 'MAXLEN', '~', ARGV[8], '*', unpack(campos))
  redis.call('XADD', KEYS[11], 'MAXLEN', '~', ARGV[7], id, unpack(campos))
  redis.call('PUBLISH', KEYS[13], id)
  redis.call('PUBLISH', KEYS[14], id)
  return id
end

local respuesta, estado, motivoActa
if suma ~= a.sufragantes then
  -- 3. No cuadra → dudosa: no suma; a la cola de verificación
  estado = 'dudosa'
  motivoActa = 'descuadre: suma(votos)=' .. suma .. ' sufragantes=' .. a.sufragantes
  redis.call('ZADD', KEYS[15], math.abs(suma - a.sufragantes), a.acta)
  if contadaPrev then
    local delta = {}
    for _, c in ipairs(candidatos) do delta[c] = -(votosPrev[c] or 0) end
    aplicarDelta(delta)
    emitir('reversion', delta, 0, motivoActa)
  end
  respuesta = { estado = 'dudosa', acta = a.acta, version = a.version, motivo = motivoActa }
else
  -- 4. Cuadra → restar la anterior contada y sumar la nueva en los 4 niveles
  estado = 'contada'
  motivoActa = ''
  local delta = {}
  for _, c in ipairs(candidatos) do delta[c] = a.votos[c] - (votosPrev[c] or 0) end
  aplicarDelta(delta)
  local primera = redis.call('HEXISTS', KEYS[4], '_informadas') == 0
  if primera then
    for _, k in ipairs(niveles_tot) do redis.call('HINCRBY', k, '_informadas', 1) end
  end
  local tipo, motivoEv = 'aplicada', ARGV[4]
  if contadaPrev then
    tipo = 'correccion'
    if motivoEv == '' then motivoEv = 'correccion v' .. vPrev .. ' -> v' .. a.version end
  end
  -- 5. Stream + avisos
  local seq = emitir(tipo, delta, primera and 1 or 0, motivoEv)
  redis.call('ZREM', KEYS[15], a.acta)
  respuesta = { estado = 'registrada', acta = a.acta, version = a.version, seq = seq }
end

local respJson = cjson.encode(respuesta)
redis.call('HSET', KEYS[2],
  'version', a.version, 'estado', estado, 'votos', cjson.encode(a.votos),
  'mesa', a.mesa, 'puesto', a.puesto, 'municipio', a.municipio, 'jurado', a.jurado,
  -- extra (no contractual): para el polling del jurado y las respuestas "duplicada"
  'motivo', motivoActa, 'sufragantes', a.sufragantes, 'origen', ARGV[3], 'respuesta', respJson)

-- 6. idem → respuesta original
redis.call('SET', KEYS[1], respJson, 'EX', ARGV[6])
return respJson
