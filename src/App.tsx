import { useEffect, useMemo, useState } from 'react'
import { PublicKey, Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import {
  executeBatch,
  fetchBalances,
  type WalletRef,
  type WalletSendResult,
} from './lib/solana'
import './App.css'

const envApi = (import.meta.env.VITE_API_BASE ?? 'http://localhost:8787').trim().replace(/\/$/, '')
const envApiKey = import.meta.env.VITE_API_KEY ?? ''
const envGate = import.meta.env.VITE_DASH_PASSWORD ?? ''
const MAX_WALLETS = 30
const DEFAULT_CONCURRENCY = 8
const WALLET_STORAGE_KEY = 'evorape_wallets_v1'
const AUTH_STORAGE_KEY = 'evorape_auth_v1'

function toRawAmount(amount: string, decimals: number): bigint {
  const normalized = amount.trim()
  if (!normalized) throw new Error('Amount is required')
  const [whole, frac = ''] = normalized.split('.')
  const safeWhole = whole || '0'
  if (!/^\d+$/.test(safeWhole) || !/^\d*$/.test(frac)) {
    throw new Error('Amount must be numeric')
  }
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals)
  return (
    BigInt(safeWhole) * 10n ** BigInt(decimals) + BigInt(padded || '0')
  )
}

function App() {
  const [wallets, setWallets] = useState<WalletRef[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [generateCount, setGenerateCount] = useState(5)
  const [balances, setBalances] = useState<Record<string, number>>({})
  const [isLoadingBalances, setIsLoadingBalances] = useState(false)
  const [mint, setMint] = useState('')
  const [destination, setDestination] = useState('')
  const [amount, setAmount] = useState('')
  const [decimals, setDecimals] = useState(6)
  const [priorityFee, setPriorityFee] = useState(0)
  const [concurrency, setConcurrency] = useState(DEFAULT_CONCURRENCY)
  const [results, setResults] = useState<WalletSendResult[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isAuthed, setIsAuthed] = useState(false)
  const [gateInput, setGateInput] = useState('')
  const [gateError, setGateError] = useState<string | null>(null)
  const apiBaseTrimmed = useMemo(() => envApi, [])

  // Restore persisted wallets on load
  useEffect(() => {
    try {
      const raw = localStorage.getItem(WALLET_STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as { name: string; secret: string }[]
      const restored = parsed.map((w) => ({
        name: w.name,
        keypair: Keypair.fromSecretKey(bs58.decode(w.secret)),
      }))
      setWallets(restored)
      setSelected(restored.map((w) => w.name))
    } catch (err) {
      console.error('Wallet restore failed', err)
    }
  }, [])

  // Persist wallets when they change
  useEffect(() => {
    if (!wallets.length) {
      localStorage.removeItem(WALLET_STORAGE_KEY)
      return
    }
    const payload = wallets.map((w) => ({
      name: w.name,
      secret: bs58.encode(w.keypair.secretKey),
    }))
    localStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify(payload))
  }, [wallets])

  // Restore auth
  useEffect(() => {
    const ok = localStorage.getItem(AUTH_STORAGE_KEY)
    if (ok === 'true') setIsAuthed(true)
  }, [])

  const handleGate = () => {
    if (envGate && gateInput !== envGate) {
      setGateError('Incorrect password')
      return
    }
    setGateError(null)
    setIsAuthed(true)
    localStorage.setItem(AUTH_STORAGE_KEY, 'true')
  }

  const selectedWallets = useMemo(
    () =>
      selected.length
        ? wallets.filter((w) => selected.includes(w.name))
        : wallets,
    [selected, wallets],
  )

  const handleGenerateWallets = () => {
    const count = Math.max(1, Math.min(MAX_WALLETS, Math.floor(generateCount)))
    const generated: WalletRef[] = Array.from({ length: count }, (_, idx) => ({
      name: `bundle-${Date.now()}-${idx + 1}`,
      keypair: Keypair.generate(),
    }))

    setWallets(generated)
    setSelected(generated.map((w) => w.name))
    setError(null)
  }

  const refreshBalances = async (current: WalletRef[]) => {
    if (!current.length || !apiBaseTrimmed) {
      setBalances({})
      return
    }
    setIsLoadingBalances(true)
    try {
      const pubkeys = current.map((w) => w.keypair.publicKey)
      const fetched = await fetchBalances(pubkeys, apiBaseTrimmed, envApiKey || undefined)
      setBalances(fetched)
    } catch (err) {
      console.error('Balance fetch failed', err)
      setBalances({})
    } finally {
      setIsLoadingBalances(false)
    }
  }

  useEffect(() => {
    if (!wallets.length) return
    void refreshBalances(wallets)
  }, [wallets, apiBaseTrimmed])

  const handleDownloadKeys = () => {
    if (!wallets.length) return
    const text = wallets
      .map((w, idx) => `${idx + 1}. ${w.name}: ${bs58.encode(w.keypair.secretKey)}`)
      .join('\n')
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `wallet-bundle-${Date.now()}.txt`
    link.click()
    URL.revokeObjectURL(url)
  }

  const toggleWallet = (name: string) => {
    setSelected((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    )
  }

  const handleExecute = async () => {
    setError(null)
    setResults([])

    try {
      if (!apiBaseTrimmed) throw new Error('API base URL is required')
      if (!mint || !destination) throw new Error('Mint and destination are required')
      if (!selectedWallets.length) throw new Error('Select at least one wallet')

      const mintPk = new PublicKey(mint)
      const destPk = new PublicKey(destination)
      const decimalsInt = Math.max(0, Math.floor(Number(decimals)))
      const amountRaw = toRawAmount(amount, decimalsInt)
      const planPriority = Number(priorityFee) || 0
      const safeConcurrency = Math.min(
        MAX_WALLETS,
        Math.max(1, concurrency || 1),
      )

      setIsRunning(true)

      await executeBatch(
        selectedWallets,
        {
          mint: mintPk,
          destination: destPk,
          amountRaw,
          priorityFeeMicrolamports: planPriority > 0 ? planPriority : undefined,
        },
        safeConcurrency,
        apiBaseTrimmed,
        envApiKey || undefined,
        (res) =>
          setResults((prev) => {
            const others = prev.filter((p) => p.wallet !== res.wallet)
            return [...others, res]
          }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsRunning(false)
    }
  }

  if (!isAuthed) {
    return (
      <div className="page">
        <div className="card" style={{ maxWidth: 420, margin: '4rem auto' }}>
          <div className="card-head">
            <div>
              <p className="eyebrow">Access</p>
              <h2>Enter password</h2>
            </div>
          </div>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={gateInput}
              onChange={(e) => setGateInput(e.target.value)}
              placeholder="Password"
            />
          </label>
          {gateError && <div className="error">{gateError}</div>}
          <button className="primary" onClick={handleGate}>
            Unlock
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <header className="hero">
        <p className="eyebrow">Meme ops console</p>
        <h1>Batch wallets. Quick fire.</h1>
        <p className="lede">Generate bundles, watch SOL, and push parallel transfers fast.</p>
      </header>

      <section className="grid">
        <div className="card">
          <div className="card-head">
            <div>
              <p className="eyebrow">API backend</p>
              <h2>Railway endpoint</h2>
            </div>
          </div>
          <label className="field">
            <span>API base URL</span>
            <input value={apiBaseTrimmed} readOnly />
          </label>
          <div className="row">
            <label className="field">
              <span>Concurrency</span>
              <input
                type="number"
                min={1}
                max={MAX_WALLETS}
                value={concurrency}
                onChange={(e) => {
                  const next = Number(e.target.value)
                  setConcurrency(Number.isNaN(next) ? 1 : next)
                }}
              />
            </label>
            <label className="field">
              <span>Priority fee (μlamports)</span>
              <input
                type="number"
                min={0}
                value={priorityFee}
                onChange={(e) => {
                  const next = Number(e.target.value)
                  setPriorityFee(Number.isNaN(next) ? 0 : next)
                }}
                placeholder="0"
              />
            </label>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <p className="eyebrow">Token action</p>
              <h2>Transfer setup</h2>
            </div>
          </div>
          <label className="field">
            <span>SPL Mint</span>
            <input
              value={mint}
              onChange={(e) => setMint(e.target.value)}
              placeholder="Token mint address"
            />
          </label>
          <label className="field">
            <span>Destination owner</span>
            <input
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              placeholder="Destination wallet for all transfers"
            />
          </label>
          <div className="row">
            <label className="field">
              <span>Amount (token units)</span>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="e.g. 1.25"
              />
            </label>
            <label className="field">
              <span>Decimals</span>
              <input
                type="number"
                min={0}
                max={12}
                value={decimals}
                onChange={(e) => {
                  const next = Number(e.target.value)
                  setDecimals(Number.isNaN(next) ? 0 : next)
                }}
              />
            </label>
          </div>
        </div>
      </section>

      <section className="grid">
        <div className="card">
          <div className="card-head">
            <div>
              <p className="eyebrow">Wallets</p>
              <h2>Generate up to 30</h2>
            </div>
            <div className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
              <label className="field" style={{ width: 120 }}>
                <span>Generate</span>
                <input
                  type="number"
                  min={1}
                  max={MAX_WALLETS}
                  value={generateCount}
                  onChange={(e) => {
                    const next = Number(e.target.value)
                    setGenerateCount(Number.isNaN(next) ? 1 : next)
                  }}
                />
              </label>
              <button className="ghost" onClick={handleGenerateWallets}>
                Generate
              </button>
                <button className="ghost" onClick={() => refreshBalances(wallets)} disabled={isLoadingBalances}>
                  {isLoadingBalances ? 'Loading...' : 'Refresh balances'}
                </button>
                <button className="ghost" onClick={handleDownloadKeys} disabled={!wallets.length}>
                  Download keys
                </button>
            </div>
          </div>
            <p className="hint">Generate a bundle, view balances, download secrets as txt.</p>
          {wallets.length > 0 && (
            <div className="wallets">
              <div className="wallets-head">
                  <span>{wallets.length} generated</span>
                <button
                  className="ghost"
                  onClick={() => setSelected(wallets.map((w) => w.name))}
                >
                  Select all
                </button>
              </div>
                <div className="wallet-grid">
                  {wallets.map((w, idx) => (
                    <label key={w.name} className="pill" style={{ justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <input
                            type="checkbox"
                            checked={selected.includes(w.name)}
                            onChange={() => toggleWallet(w.name)}
                          />
                          <span>{idx + 1}. {w.name}</span>
                        </div>
                        <span className="muted" style={{ fontSize: 12 }}>
                          {w.keypair.publicKey.toBase58()}
                        </span>
                      </div>
                      <span className="metric" style={{ fontSize: 14 }}>
                        {balances[w.keypair.publicKey.toBase58()] !== undefined
                          ? `${(balances[w.keypair.publicKey.toBase58()]! / 1_000_000_000).toFixed(4)} SOL`
                          : '…'}
                      </span>
                    </label>
                  ))}
                </div>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <p className="eyebrow">Execution</p>
              <h2>Status</h2>
            </div>
            <button
              className="primary"
              onClick={handleExecute}
              disabled={isRunning}
            >
              {isRunning ? 'Running...' : 'Execute batch'}
            </button>
          </div>
          {error && <div className="error">{error}</div>}
          <div className="summary">
            <div>
              <p className="muted">Selected wallets</p>
              <p className="metric">{selectedWallets.length}</p>
            </div>
            <div>
              <p className="muted">Concurrency</p>
              <p className="metric">{concurrency}</p>
            </div>
            <div>
              <p className="muted">Priority fee</p>
              <p className="metric">{priorityFee || 0} μlamports</p>
            </div>
          </div>
          <div className="results">
            {results.length === 0 && (
              <p className="muted">No transactions yet.</p>
            )}
            {results
              .slice()
              .sort((a, b) => a.wallet.localeCompare(b.wallet))
              .map((res) => (
                <div key={res.wallet} className="result-row">
                  <div>
                    <p className="muted">{res.wallet}</p>
                    {res.signature && <p className="sig">{res.signature}</p>}
                    {res.error && <p className="error-text">{res.error}</p>}
                  </div>
                  <span className={`status ${res.error ? 'bad' : 'good'}`}>
                    {res.error ? 'Failed' : 'Confirmed'}
                  </span>
                </div>
              ))}
          </div>
        </div>
      </section>
    </div>
  )
}

export default App
