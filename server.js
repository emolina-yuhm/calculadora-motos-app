// server.js
import express from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'
import { createHmac, timingSafeEqual } from 'crypto'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = process.env.PORT || 5175
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'changeme'

// ──────────────────────────────────────────────
// CORS seguro por env (puede haber varios orígenes)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true)
    if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
      return cb(null, true)
    }
    return cb(new Error('Not allowed by CORS'))
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS'], // ← agregamos PATCH
  allowedHeaders: [
    'Content-Type',
    'X-Requested-With',
    'Authorization',
    'x-admin-secret',
    'X-Admin-Secret',
    'Accept'
  ],
  credentials: true
}

app.use(cors(corsOptions))
app.options('*', cors(corsOptions))
app.use(express.json())

// ──────────────────────────────────────────────
// MODO SUPABASE (persistente)
const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || ''
const useSupabase = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE)
const supabase = useSupabase ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE) : null

// ──────────────────────────────────────────────
// MODO ARCHIVO (si NO hay Supabase)
let DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'cards.json')

function ensureDataFile(filePath) {
  const dir = path.dirname(filePath)
  try {
    fs.mkdirSync(dir, { recursive: true })
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify({ version: 1, cards: [] }, null, 2))
    }
    console.log(`[DATA] Usando ${filePath}`)
    return filePath
  } catch (e) {
    console.warn(`[WARN] No se pudo usar ${dir} (${e.code}). Uso /tmp como fallback.`)
    const fallback = path.join('/tmp', 'cards.json')
    try {
      fs.mkdirSync(path.dirname(fallback), { recursive: true })
      if (!fs.existsSync(fallback)) {
        fs.writeFileSync(fallback, JSON.stringify({ version: 1, cards: [] }, null, 2))
      }
      console.log(`[DATA] Usando fallback ${fallback} (NO persistente)`)
      return fallback
    } catch (e2) {
      console.error('[FATAL] No se pudo preparar archivo de datos ni en /tmp:', e2)
      process.exit(1)
    }
  }
}

if (!useSupabase) {
  DATA_FILE = ensureDataFile(DATA_FILE)
}

// ──────────────────────────────────────────────
// Helpers de lectura/escritura + backup
async function readCards() {
  if (useSupabase) {
    const { data, error } = await supabase
      .from('configs')
      .select('payload')
      .eq('key', 'cards')
      .maybeSingle()
    if (error) {
      console.error('[SUPABASE] read error:', error)
      return { version: 1, cards: [] }
    }
    return data?.payload || { version: 1, cards: [] }
  } else {
    try {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8')
      return JSON.parse(raw)
    } catch {
      return { version: 1, cards: [] }
    }
  }
}

async function backupSnapshot(prevPayload) {
  if (useSupabase) {
    try {
      await supabase.from('configs_history').insert({
        key: 'cards',
        payload: prevPayload
      })
    } catch (e) {
      console.warn('[SUPABASE] history insert error (ignorado):', e?.message || e)
    }
  } else {
    try {
      const histDir = path.join(path.dirname(DATA_FILE), 'history')
      fs.mkdirSync(histDir, { recursive: true })
      const file = path.join(histDir, `cards_${Date.now()}.json`)
      fs.writeFileSync(file, JSON.stringify(prevPayload, null, 2))
    } catch (e) {
      console.warn('[FILE] no se pudo escribir backup local (ignorado):', e?.message || e)
    }
  }
}

async function writeCards(payload, prevPayloadForBackup = null) {
  if (prevPayloadForBackup) {
    await backupSnapshot(prevPayloadForBackup)
  }

  if (useSupabase) {
    const { error } = await supabase
      .from('configs')
      .upsert({ key: 'cards', payload }, { onConflict: 'key' })
    if (error) {
      console.error('[SUPABASE] write error:', error)
      throw new Error('write_failed')
    }
    return { ok: true }
  } else {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2))
      return { ok: true }
    } catch {
      throw new Error('write_failed')
    }
  }
}

// Merge por id (reemplaza coincidentes y agrega nuevos)
function mergeCardsById(current = [], incoming = []) {
  const map = new Map()
  for (const c of current) {
    if (c && c.id != null) map.set(String(c.id), c)
  }
  for (const n of incoming) {
    if (n && n.id != null) map.set(String(n.id), { ...map.get(String(n.id)), ...n })
  }
  return Array.from(map.values())
}

// ──────────────────────────────────────────────
// Token de sesión (HMAC, sin dependencias externas)
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000 // 8 horas

function makeToken() {
  const expires = String(Date.now() + TOKEN_TTL_MS)
  const sig = createHmac('sha256', ADMIN_SECRET).update(expires).digest('hex')
  return `${expires}.${sig}`
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false
  const dot = token.lastIndexOf('.')
  if (dot < 0) return false
  const expires = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  if (Date.now() > Number(expires)) return false
  const expected = createHmac('sha256', ADMIN_SECRET).update(expires).digest('hex')
  try {
    return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))
  } catch {
    return false
  }
}

// ──────────────────────────────────────────────
// Auth helper
function checkAuth(req, res) {
  // Bearer token (login nuevo)
  const auth = req.get('Authorization') || ''
  if (auth.startsWith('Bearer ') && verifyToken(auth.slice(7))) return true

  // x-admin-secret legacy (compatibilidad mientras se migra)
  const secret = req.get('x-admin-secret') || req.get('X-Admin-Secret') || ''
  if (secret && secret === ADMIN_SECRET) return true

  res.status(401).json({ error: 'unauthorized' })
  return false
}

// ──────────────────────────────────────────────
// Audit log
function getClientIp(req) {
  // Render (y la mayoría de proxies) pone la IP real en x-forwarded-for
  const forwarded = req.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return req.socket?.remoteAddress || 'unknown'
}

async function auditLog(req, action, details = {}) {
  const entry = {
    ts: new Date().toISOString(),
    ip: getClientIp(req),
    ua: req.get('user-agent') || '',
    action,
    ...details
  }
  console.log('[AUDIT]', JSON.stringify(entry))

  if (useSupabase) {
    try {
      await supabase.from('audit_log').insert(entry)
    } catch (e) {
      // La tabla puede no existir aún; el log en consola siempre queda
      console.warn('[AUDIT] insert error (ignorado):', e?.message || e)
    }
  }
}

// ──────────────────────────────────────────────
// Rutas
app.get('/', (_req, res) => {
  res.type('text/plain').send('OK. Usá /cards para ver/guardar la configuración.')
})

app.post('/auth/login', (req, res) => {
  const { password } = req.body || {}
  if (!password || password !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'invalid_password' })
  }
  res.json({ token: makeToken() })
})

app.get('/cards', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    const payload = await readCards()
    res.json(payload)
  } catch {
    res.status(500).json({ error: 'read_failed' })
  }
})

// Reemplaza TODO el dataset (compat)
app.put('/cards', async (req, res) => {
  if (!checkAuth(req, res)) return

  const body = req.body
  if (!body || !Array.isArray(body.cards)) {
    return res.status(400).json({ error: 'invalid_body' })
  }

  const newPayload = {
    version: Number(body.version || 1),
    cards: body.cards
  }

  try {
    const prev = await readCards()
    await auditLog(req, 'put_cards', {
      prev_count: prev.cards?.length ?? 0,
      next_count: newPayload.cards.length,
      version: newPayload.version
    })
    await writeCards(newPayload, prev)
    res.json({ ok: true })
  } catch {
    res.status(500).json({ error: 'write_failed' })
  }
})

// Upsert por id (no borra lo no enviado)
app.post('/cards/upsert', async (req, res) => {
  if (!checkAuth(req, res)) return

  const body = req.body
  if (!body || !Array.isArray(body.cards)) {
    return res.status(400).json({ error: 'invalid_body' })
  }

  try {
    const prev = await readCards()
    const merged = mergeCardsById(prev.cards || [], body.cards || [])
    const next = {
      version: Number(prev.version || 1) + 1,
      cards: merged
    }
    await auditLog(req, 'upsert_cards', {
      prev_count: prev.cards?.length ?? 0,
      next_count: merged.length,
      incoming_count: body.cards.length,
      version: next.version
    })
    await writeCards(next, prev)
    res.json({ ok: true, version: next.version, updated: body.cards.length })
  } catch (e) {
    console.error('[UPSERT] error:', e)
    res.status(500).json({ error: 'write_failed' })
  }
})

/**
 * PATCH /cards/:id
 * Edita una tarjeta existente (por id). Permite cambiar el id (rename) sin duplicar.
 * Body: { id?: string, nombre?: string, coeficientes?: object, ...camposExtra }
 * Errores:
 *  - 404 si no existe original
 *  - 409 si el nuevo id ya existe en otra tarjeta
 */
app.patch('/cards/:id', async (req, res) => {
  if (!checkAuth(req, res)) return

  const originalId = String(req.params.id || '')
  const updates = req.body
  if (!originalId || !updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'invalid_body' })
  }

  try {
    const prev = await readCards()
    const cards = Array.isArray(prev.cards) ? [...prev.cards] : []
    const idx = cards.findIndex(c => String(c?.id) === originalId)
    if (idx < 0) return res.status(404).json({ error: 'not_found' })

    const current = cards[idx]
    const nextId = updates.hasOwnProperty('id') ? String(updates.id) : current.id
    const isRename = nextId !== current.id

    if (isRename && cards.some((c, i) => i !== idx && String(c?.id) === nextId)) {
      return res.status(409).json({ error: 'id_conflict' })
    }

    const nextCard = { ...current, ...updates, id: nextId }
    cards[idx] = nextCard

    const nextPayload = {
      version: Number(prev.version || 1) + 1,
      cards
    }

    await auditLog(req, 'patch_card', {
      original_id: originalId,
      next_id: nextId,
      renamed: isRename,
      version: nextPayload.version
    })
    await writeCards(nextPayload, prev)
    res.json({ ok: true, version: nextPayload.version, card: nextCard })
  } catch (e) {
    console.error('[PATCH /cards/:id] error:', e)
    res.status(500).json({ error: 'write_failed' })
  }
})

app.listen(PORT, () => {
  console.log(`API running on http://0.0.0.0:${PORT}`)
})