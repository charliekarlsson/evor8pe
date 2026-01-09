import express from 'express'
import cors from 'cors'
import { Connection, PublicKey } from '@solana/web3.js'
import dotenv from 'dotenv'

dotenv.config()

const PORT = process.env.PORT || 8787
const RPC_URL = process.env.HELIUS_RPC_URL
const API_KEY = process.env.API_KEY
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN

if (!RPC_URL) {
  // eslint-disable-next-line no-console
  console.warn('HELIUS_RPC_URL is not set. Set it in Railway/ENV for backend RPC access.')
}

const connection = new Connection(RPC_URL || 'https://api.mainnet-beta.solana.com', {
  commitment: 'finalized',
})

const app = express()
app.use(
  cors({
    origin: ALLOWED_ORIGIN ? [ALLOWED_ORIGIN] : '*',
  }),
)
app.use(express.json({ limit: '1mb' }))

app.use((req, res, next) => {
  if (!API_KEY) return next()
  const presented = req.header('x-api-key')
  if (presented !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  return next()
})

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

app.get('/blockhash', async (_req, res) => {
  try {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized')
    res.json({ blockhash, lastValidBlockHeight })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/sendRaw', async (req, res) => {
  try {
    const { tx, blockhash, lastValidBlockHeight } = req.body || {}
    if (!tx) return res.status(400).json({ error: 'tx (base64) required' })

    const raw = Buffer.from(tx, 'base64')
    const sig = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 0 })

    const bh = blockhash || (await connection.getLatestBlockhash('finalized')).blockhash
    const lvh = lastValidBlockHeight || (await connection.getLatestBlockhash('finalized')).lastValidBlockHeight

    await connection.confirmTransaction({ signature: sig, blockhash: bh, lastValidBlockHeight: lvh }, 'finalized')

    res.json({ signature: sig })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/balances', async (req, res) => {
  try {
    const { pubkeys } = req.body || {}
    if (!Array.isArray(pubkeys)) return res.status(400).json({ error: 'pubkeys array required' })
    if (pubkeys.length === 0) return res.json({ balances: {} })
    if (pubkeys.length > 30) return res.status(400).json({ error: 'max 30 pubkeys' })

    const keys = pubkeys.map((p) => new PublicKey(p))
    const infos = await connection.getMultipleAccountsInfo(keys, { commitment: 'processed' })
    const balances = keys.reduce((acc, key, idx) => {
      acc[key.toBase58()] = infos[idx]?.lamports ?? 0
      return acc
    }, {})
    res.json({ balances })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on :${PORT}`)
})
