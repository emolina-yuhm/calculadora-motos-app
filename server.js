import express from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = process.env.PORT || 5175
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'changeme'
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'cards.json')

app.use(cors({ origin: true }))
app.use(express.json())

// Asegurar archivo y carpeta
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true })
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ version: 1, cards: [] }, null, 2))
}

// GET: leer configuración compartida
app.get('/cards', (req, res) => {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.json(JSON.parse(raw))
  } catch (e) {
    res.status(500).json({ error: 'read_failed' })
  }
})

// PUT: reemplazar configuración completa (requiere admin)
app.put('/cards', (req, res) => {
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
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2))
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: 'write_failed' })
  }
})

app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`)
})
