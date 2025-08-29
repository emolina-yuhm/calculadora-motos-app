// server.js
import express from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = process.env.PORT || 5175
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'changeme'

// ──────────────────────────────────────────────
// CORS seguro por env (puede haber varios orígenes)
// Ej: ALLOWED_ORIGINS="https://tu-app.netlify.app,https://otra.com"
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

const corsOptions = {
  origin: (origin, cb) => {
    // Permite herramientas tipo curl/postman (sin origin)
    if (!origin) return cb(null, true)
    if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
      return cb(null, true)
    }
    return cb(new Error('Not allowed by CORS'))
  },
  methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
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
// Responder preflight global
app.options('*', cors(corsOptions))

app.use(express.json())

// ──────────────────────────────────────────────
// MODO SUPABASE (persistente)
const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || ''
const useSupabase = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE)
const supabase = useSupabase ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE) : null

// ──────────────────────────────────────────────
// MODO ARCHIVO (solo si NO hay Supabase)
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
// Auth helper
function getSecret(req) {
  return req.get('x-admin-secret') || req.get('X-Admin-Secret') || ''
}
function checkAuth(req, res) {
  const secret = getSecret(req)
  if (secret !== ADMIN_SECRET) {
    res.status(401).json({ error: 'unauthorized' })
    return false
  }
  return true
}

// ──────────────────────────────────────────────
// Rutas
app.get('/', (_req, res) => {
  res.type('text/plain').send('OK. Usá /cards para ver/guardar la configuración.')
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

// Reemplaza TODO el dataset (mantenido por compatibilidad)
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
    await writeCards(newPayload, prev)
    res.json({ ok: true })
  } catch {
    res.status(500).json({ error: 'write_failed' })
  }
})

// NUEVO: fusiona por id (no borra lo no enviado)
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
    await writeCards(next, prev)
    res.json({ ok: true, version: next.version, updated: body.cards.length })
  } catch (e) {
    console.error('[UPSERT] error:', e)
    res.status(500).json({ error: 'write_failed' })
  }
})

app.listen(PORT, () => {
  console.log(`API running on http://0.0.0.0:${PORT}`)
})
