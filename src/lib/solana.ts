import bs58 from 'bs58'
import pLimit from 'p-limit'
import { Buffer } from 'buffer'
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddress,
} from '@solana/spl-token'

export type WalletRef = { name: string; keypair: Keypair }

export type TransferPlan = {
  mint: PublicKey
  destination: PublicKey
  amountRaw: bigint
  priorityFeeMicrolamports?: number
}

export type WalletSendResult = {
  wallet: string
  signature?: string
  error?: string
}

export async function fetchBalances(
  pubkeys: PublicKey[],
  apiBase: string,
  apiKey?: string,
): Promise<Record<string, number>> {
  if (!pubkeys.length) return {}
  const res = await fetch(`${apiBase}/balances`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    },
    body: JSON.stringify({ pubkeys: pubkeys.map((p) => p.toBase58()) }),
  })
  if (!res.ok) throw new Error(`Balance fetch failed: ${res.status}`)
  const data = (await res.json()) as { balances: Record<string, number> }
  return data.balances || {}
}

type BlockhashInfo = { blockhash: string; lastValidBlockHeight: number }

async function fetchBlockhash(apiBase: string, apiKey?: string): Promise<BlockhashInfo> {
  const res = await fetch(`${apiBase}/blockhash`, {
    headers: apiKey ? { 'x-api-key': apiKey } : undefined,
  })
  if (!res.ok) throw new Error(`Blockhash fetch failed: ${res.status}`)
  return res.json()
}

export function parseSecretKey(input: string): Uint8Array {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('Empty secret key input')

  // Try JSON array of numbers
  try {
    const parsed = JSON.parse(trimmed) as number[]
    if (Array.isArray(parsed) && parsed.length > 0) {
      return Uint8Array.from(parsed)
    }
  } catch (_) {
    // fall through
  }

  // Try base58
  try {
    return bs58.decode(trimmed)
  } catch (_) {
    throw new Error('Secret key must be JSON array or base58-encoded')
  }
}

export function parseWalletBatch(raw: string): WalletRef[] {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (!lines.length) return []

  if (lines.length > 30) {
    throw new Error('Provide at most 30 wallets')
  }

  return lines.map((line, idx) => {
    const [maybeName, maybeKey] = line.includes(':')
      ? [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)]
      : [undefined, line]

    const name = (maybeName || `wallet-${idx + 1}`).trim()
    const secret = parseSecretKey(maybeKey || line)
    if (secret.length !== 64) {
      throw new Error(`Wallet ${name}: secret key must be 64 bytes, got ${secret.length}`)
    }
    return { name, keypair: Keypair.fromSecretKey(secret) }
  })
}

function applyBlockhash(tx: Transaction, signer: Keypair, info: BlockhashInfo) {
  tx.recentBlockhash = info.blockhash
  tx.lastValidBlockHeight = info.lastValidBlockHeight
  tx.sign(signer)
}

async function buildTransferTx(
  from: Keypair,
  plan: TransferPlan,
  blockhashInfo: BlockhashInfo,
): Promise<Transaction> {
  const fromAta = await getAssociatedTokenAddress(plan.mint, from.publicKey)
  const toAta = await getAssociatedTokenAddress(plan.mint, plan.destination)

  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(
      from.publicKey,
      toAta,
      plan.destination,
      plan.mint,
    ),
    createTransferInstruction(fromAta, toAta, from.publicKey, plan.amountRaw),
  ]

  const tx = new Transaction()
  if (plan.priorityFeeMicrolamports && plan.priorityFeeMicrolamports > 0) {
    tx.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: plan.priorityFeeMicrolamports,
      }),
    )
  }

  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ...ixs,
  )

  tx.feePayer = from.publicKey
  applyBlockhash(tx, from, blockhashInfo)
  return tx
}

export async function sendWithRetry(
  tx: Transaction,
  walletName: string,
  signer: Keypair,
  apiBase: string,
  apiKey: string | undefined,
  getBlockhash: () => Promise<BlockhashInfo>,
  maxRetries = 3,
): Promise<WalletSendResult> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${apiBase}/sendRaw`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'x-api-key': apiKey } : {}),
        },
        body: JSON.stringify({
          tx: Buffer.from(tx.serialize()).toString('base64'),
          blockhash: tx.recentBlockhash,
          lastValidBlockHeight: tx.lastValidBlockHeight,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `sendRaw failed: ${res.status}`)
      }
      const data = (await res.json()) as { signature: string }
      return { wallet: walletName, signature: data.signature }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const needsHash = /BlockhashNotFound|blockhash|expired/i.test(msg)
      if (needsHash) {
        const fresh = await getBlockhash()
        applyBlockhash(tx, signer, fresh)
      }
      if (attempt === maxRetries) {
        return { wallet: walletName, error: msg }
      }
      const backoffMs = 150 * attempt
      await new Promise((res) => setTimeout(res, backoffMs))
    }
  }

  return { wallet: walletName, error: 'exhausted retries' }
}

export async function executeBatch(
  wallets: WalletRef[],
  plan: TransferPlan,
  concurrency: number,
  apiBase: string,
  apiKey: string | undefined,
  onResult?: (r: WalletSendResult) => void,
): Promise<WalletSendResult[]> {
  const getBh = () => fetchBlockhash(apiBase, apiKey)
  let cachedBh: BlockhashInfo | null = null
  const nextBh = async () => {
    cachedBh = await getBh()
    return cachedBh
  }
  cachedBh = await nextBh()

  const limit = pLimit(Math.max(1, concurrency))
  const tasks = wallets.map((wallet) =>
    limit(async () => {
      const tx = await buildTransferTx(wallet.keypair, plan, cachedBh!)
      const res = await sendWithRetry(
        tx,
        wallet.name,
        wallet.keypair,
        apiBase,
        apiKey,
        nextBh,
      )
      onResult?.(res)
      return res
    }),
  )

  return Promise.all(tasks)
}
