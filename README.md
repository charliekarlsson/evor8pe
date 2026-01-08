# Solana Multi-Wallet Executor (Browser + Railway API)

Browser dashboard controls up to 30 Solana wallets in parallel. Wallets stay client-side and persist across refresh (stored in localStorage). A tiny backend (Express) runs on Railway and holds your private Helius RPC to fetch blockhashes and relay signed transactions. Access is gated by a client-side password; backend calls are protected with a shared API key.

## Features
- Import up to 30 wallets (base58 or JSON secret key per line, optional `name:` prefix)
- Client-side signing; backend only forwards blockhash/sendRaw to Helius
- Priority fee (μlamports), bounded concurrency, per-wallet status
- Idempotent ATA creation for destinations; retries on blockhash expiry
- Wallets persist locally (base58-encoded in localStorage) so they survive refresh

## Setup (local dev)
1. Node 18+ recommended.
2. Install deps: `npm install`.
3. Create `.env` (copy `.env.example`) and set:
	- `VITE_API_BASE=http://localhost:8787` (frontend)
	- `VITE_API_KEY=your-shared-secret` (sent as x-api-key)
	- `VITE_DASH_PASSWORD=your-ui-password`
	- `HELIUS_RPC_URL=...` (backend)
	- `API_KEY=your-shared-secret` (must match VITE_API_KEY)
	- `ALLOWED_ORIGIN=http://localhost:5173` (or your domain)
4. Run backend: `npm run server` (listens on 8787).
5. Run frontend: `npm run dev` (http://localhost:5173).
6. Combined dev: `npm run dev:full` (runs both).
7. Build frontend: `npm run build`; Preview: `npm run preview`; Lint: `npm run lint`.

## Deploy to Railway (backend)
- Deploy the `server/` folder as a Node service (entry `server/index.mjs`).
- Set env: `HELIUS_RPC_URL`, `API_KEY` (match frontend), `ALLOWED_ORIGIN` (your Cloudflare domain), `PORT` (Railway provides).
- Point the frontend `VITE_API_BASE` to the deployed URL (e.g., `https://your-app.up.railway.app`).

## Deploy to Cloudflare Pages (frontend)
- Build (`npm run build`) and deploy `dist/` to Pages.
- Set Pages env vars: `VITE_API_BASE` (Railway URL), `VITE_API_KEY` (shared secret), `VITE_DASH_PASSWORD` (UI password).

## Usage
- Unlock with the dashboard password.
- Paste wallets (one per line) and **Load wallets**. Secrets are kept in localStorage (clearable by clearing browser storage).
- Fill API base (Railway), SPL mint, destination owner, amount + decimals, priority fee, and concurrency (1–30).
- Click **Execute batch** to send parallel transfers. Results show per-wallet signatures/errors.

## Notes
- Amount is in token units; decimals required (e.g., USDC=6).
- Priority fee uses compute unit price; compute budget set to 200k CU.
- Concurrency clamped 1–30 to respect RPC limits.
- For fresh tokens without destination ATA, the app uses idempotent ATA creation before transfer.
