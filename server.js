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
// MODO SUPABASE (persistente y gratis)
// Si están estas 2 vars, usamos BD y NO usamos archivo
// ──────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || ''
const useSupabase = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE)
const supabase = useSupabase ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE) : null

// ──────────────────────────────────────────────
// MODO ARCHIVO (solo si NO hay Supabase)
// Si Render te “pide” DATA_FILE, poné un dummy: /tmp/unused.json
// ──────────────────────────────────────────────
let DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'cards.json')

app.use(cors({ origin: true }))
app.use(express.json())

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

// Solo preparo archivo si NO uso Supabase
if (!useSupabase) {
  DATA_FILE = ensureDataFile(DATA_FILE)
}

// ──────────────────────────────────────────────
// Storage helpers
// ─────────────────────────────────────────────-
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

async function writeCards(payload) {
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

// ──────────────────────────────────────────────
// Rutas
// ─────────────────────────────────────────────-
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

app.put('/cards', async (req, res) => {
  const secret = req.header('x-admin-secret')
  if (secret !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  const body = req.body
  if (!body || !Array.isArray(body.cards)) {
    return res.status(400).json({ error: 'invalid_body' })
  }
  const payload = { version: Number(body.version || 1), cards: body.cards }
  try {
    await writeCards(payload)
    res.json({ ok: true })
  } catch {
    res.status(500).json({ error: 'write_failed' })
  }
})

app.listen(PORT, () => {
  console.log(`API running on http://0.0.0.0:${PORT}`)
})
