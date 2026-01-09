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
const WALLET_STORAGE_KEY = 'evorape_wallets_v2'
const AUTH_STORAGE_KEY = 'evorape_auth_v1'

type WalletBundle = {
  id: string
  label: string
  wallets: WalletRef[]
}

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
  const [bundles, setBundles] = useState<WalletBundle[]>([])
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

  // Restore persisted bundles on load (fallback to legacy list if present)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(WALLET_STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw)

      if (Array.isArray(parsed)) {
        // legacy flat list
        const restored = parsed.map((w: { name: string; secret: string }, idx: number) => ({
          name: w.name || `wallet-${idx + 1}`,
          keypair: Keypair.fromSecretKey(bs58.decode(w.secret)),
        }))
        const legacyBundle: WalletBundle = {
          id: `bundle-${Date.now()}`,
          label: 'Bundle 1',
          wallets: restored,
        }
        setBundles([legacyBundle])
        setSelected(restored.map((w) => w.name))
        return
      }

      if (parsed && Array.isArray(parsed.bundles)) {
        const restoredBundles: WalletBundle[] = parsed.bundles.map((b: any, bIdx: number) => ({
          id: b.id || `bundle-${bIdx + 1}`,
          label: b.label || `Bundle ${bIdx + 1}`,
          wallets: (b.wallets || []).map((w: any, idx: number) => ({
            name: w.name || `${b.label || 'bundle'}-${idx + 1}`,
            keypair: Keypair.fromSecretKey(bs58.decode(w.secret)),
          })),
        }))
        setBundles(restoredBundles)
        setSelected(restoredBundles.flatMap((b) => b.wallets.map((w) => w.name)))
      }
    } catch (err) {
      console.error('Wallet restore failed', err)
    }
  }, [])

  // Persist bundles when they change
  useEffect(() => {
    if (!bundles.length) {
      localStorage.removeItem(WALLET_STORAGE_KEY)
      return
    }
    const payload = {
      bundles: bundles.map((b) => ({
        id: b.id,
        label: b.label,
        wallets: b.wallets.map((w) => ({
          name: w.name,
          secret: bs58.encode(w.keypair.secretKey),
        })),
      })),
    }
    localStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify(payload))
  }, [bundles])

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

  const allWallets = useMemo(() => bundles.flatMap((b) => b.wallets), [bundles])

  const selectedWallets = useMemo(
    () =>
      selected.length
        ? allWallets.filter((w) => selected.includes(w.name))
        : allWallets,
    [selected, allWallets],
  )

  const handleGenerateWallets = () => {
    const count = Math.max(1, Math.min(MAX_WALLETS, Math.floor(generateCount)))
    const bundleIndex = bundles.length + 1
    const bundleId = `bundle-${Date.now()}`
    const bundleLabel = `Bundle ${bundleIndex}`

    const generated: WalletRef[] = Array.from({ length: count }, (_, idx) => ({
      name: `${bundleLabel.toLowerCase().replace(/\s+/g, '-')}-${idx + 1}`,
      keypair: Keypair.generate(),
    }))

    const nextBundles = [...bundles, { id: bundleId, label: bundleLabel, wallets: generated }]
    setBundles(nextBundles)
    setSelected((prev) => [...prev, ...generated.map((w) => w.name)])
    setError(null)
    void refreshBalances(nextBundles.flatMap((b) => b.wallets))
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
    if (!allWallets.length) return
    void refreshBalances(allWallets)
  }, [allWallets, apiBaseTrimmed])

  const handleDownloadBundle = (bundle: WalletBundle) => {
    if (!bundle.wallets.length) return
    const lines: string[] = []
    lines.push(bundle.label)
    bundle.wallets.forEach((w, idx) => {
      lines.push(`${idx + 1}. ${w.name}: ${bs58.encode(w.keypair.secretKey)}`)
    })
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${bundle.label.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}.txt`
    link.click()
    URL.revokeObjectURL(url)
  }

  const clipAddress = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address)
    } catch (err) {
      console.error('Clipboard failed', err)
    }
  }

  const shortAddress = (address: string) => {
    if (address.length <= 8) return address
    return `${address.slice(0, 4)}...${address.slice(-4)}`
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
              <button
                className="ghost"
                onClick={() => refreshBalances(allWallets)}
                disabled={isLoadingBalances}
              >
                  {isLoadingBalances ? 'Loading...' : 'Refresh balances'}
                </button>
            </div>
          </div>
          <p className="hint">Generate a bundle, expand to see wallets, click address to copy.</p>
          {bundles.length === 0 && <p className="muted">No bundles yet.</p>}
          {bundles.length > 0 && (
            <div className="bundles">
              <div className="wallets-head">
                <span>{bundles.length} bundle{bundles.length > 1 ? 's' : ''}</span>
                <button
                  className="ghost"
                  onClick={() => setSelected(allWallets.map((w) => w.name))}
                  disabled={!allWallets.length}
                >
                  Select all
                </button>
              </div>
              {bundles.map((bundle, bIdx) => {
                const bundleWallets = bundle.wallets
                const bundleBalance = bundleWallets.reduce((sum, w) => {
                  const lamports = balances[w.keypair.publicKey.toBase58()] ?? 0
                  return sum + lamports
                }, 0)

                return (
                  <details key={bundle.id} className="bundle-card">
                    <summary className="bundle-head">
                      <div>
                        <p className="eyebrow">{bundle.label}</p>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {bundleWallets.length} wallets • {(bundleBalance / 1_000_000_000).toFixed(4)} SOL total
                        </div>
                      </div>
                      <div className="bundle-actions">
                        <button
                          type="button"
                          className="icon-btn"
                          title="Save keys"
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            handleDownloadBundle(bundle)
                          }}
                        >
                          💾
                        </button>
                        <span className="muted" style={{ fontSize: 12 }}>
                          Bundle {bIdx + 1}
                        </span>
                      </div>
                    </summary>
                    <div className="wallet-list">
                      {bundleWallets.map((w, idx) => {
                        const addr = w.keypair.publicKey.toBase58()
                        const bal = balances[addr]
                        const isSelected = selected.includes(w.name)
                        return (
                          <div key={w.name} className="wallet-row">
                            <label className="pill" style={{ justifyContent: 'space-between', width: '100%' }}>
                              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => toggleWallet(w.name)}
                                />
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                  <span>{idx + 1}. {w.name}</span>
                                  <button
                                    type="button"
                                    className="address-chip"
                                    onClick={() => clipAddress(addr)}
                                    title="Click to copy"
                                  >
                                    {shortAddress(addr)}
                                  </button>
                                </div>
                              </div>
                              <span className="metric" style={{ fontSize: 13 }}>
                                {bal !== undefined ? `${(bal / 1_000_000_000).toFixed(4)} SOL` : '…'}
                              </span>
                            </label>
                          </div>
                        )
                      })}
                    </div>
                  </details>
                )
              })}
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
