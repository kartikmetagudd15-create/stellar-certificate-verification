# Certificate Issuance & Verification (Stellar Soroban + Freighter)

A full-stack app to **issue** and **verify** certificates by storing a tamper-evident record (a SHA-256 hash) on the **Stellar Soroban** smart-contract platform, signed from the browser with **Freighter**.

- **Issue**: enter certificate details → backend builds an unsigned Soroban transaction → Freighter signs → hash is written on-chain.
- **Verify**: fetch expected hash from backend → read on-chain hash from the contract → compare and show **VALID / INVALID**.

---

## Key features
- **Freighter wallet flow**
  - Connect wallet
  - Sign Soroban transactions in-browser
- **Soroban smart contract**
  - Registry mapping `certificateId -> hash`
- **Backend API (Node/Express + TypeScript)**
  - Builds unsigned XDR for contract calls
  - Stores an off-chain index in `backend/data/db.json` (LowDB)
- **Frontend UI (React + Vite + TypeScript)**
  - Issue certificate
  - Verify certificate by id
  - Dashboard to list all certificates + status (Verified / Invalid / Not on-chain)

---

## Tech stack
- **Frontend**: React + Vite + TypeScript
- **Backend**: Node.js + Express + TypeScript
- **Smart contract**: Soroban (Rust)
- **Wallet**: Freighter
- **Network**: Stellar **Testnet** (Soroban RPC)

---

## Project structure

```text
stellar-certificate-verification/
  backend/
  frontend/
  contracts/
    cert_registry/
```

---

## Prerequisites
- Node.js 18+
- npm (or pnpm/yarn)
- Rust toolchain
- Soroban CLI (`soroban`)
- Freighter wallet extension

---

## Setup & run (local)

### 1) Build & deploy the smart contract (Testnet)

```bash
cd contracts/cert_registry
make build
make deploy
```

Copy the printed **Contract ID** for the next steps.

### 2) Configure environment variables

Create `backend/.env`:

```bash
PORT=4000
STELLAR_NETWORK=testnet
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
SOROBAN_CONTRACT_ID=__PASTE_CONTRACT_ID__
```

Create `frontend/.env`:

```bash
VITE_API_BASE_URL=http://localhost:4000
VITE_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
VITE_SOROBAN_CONTRACT_ID=__PASTE_CONTRACT_ID__
VITE_STELLAR_NETWORK=testnet
VITE_ADMIN_PASSCODE=change-me
```

### 3) Run backend

```bash
cd backend
npm install
npm run dev
```

Backend: `http://localhost:4000` (health: `GET /health`)

### 4) Run frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend: `http://localhost:5173`

---

## How to use

### Issue a certificate
1. Open the frontend.
2. Login with the admin passcode.
3. Connect Freighter.
4. Fill in certificate details and click **Issue**.
5. Freighter will prompt you to **sign** a Soroban transaction.

### Verify a certificate
1. Paste a certificate id.
2. Click **Verify**.
3. The app compares the expected hash (off-chain) vs the on-chain hash and shows the result.

### Dashboard (list + view)
1. Open the frontend.
2. Go to **Dashboard**.
3. Use filters to show **VERIFIED / INVALID / NOT_ON_CHAIN / ERROR** certificates.
4. Click any row to **view** full certificate details and hashes.

---

## API overview
- **POST** `/api/certificates/issue`
  - Body: `{ studentName, courseName, issuedOn, issuerPublicKey }`
  - Returns: `{ certificate, unsignedTxXdr, networkPassphrase, sorobanRpcUrl, contractId }`
- **GET** `/api/certificates`
  - Returns: `{ certificates: CertificateRecord[] }` (from off-chain DB)
- **GET** `/api/certificates?includeStatus=true`
  - Returns: `{ certificates: (CertificateRecord & { status, onChainHashHex, match, error? })[] }`
  - Status meanings:
    - `VERIFIED`: on-chain hash exists and matches expected hash
    - `INVALID`: on-chain hash exists but does not match expected hash
    - `NOT_ON_CHAIN`: no on-chain hash found for that id
    - `ERROR`: backend could not read from Soroban RPC / simulate call
- **GET** `/api/certificates/:id`
- **GET** `/api/certificates/:id/verify`
- **GET** `/health`

---

## Notes & gotchas
- **Admin passcode is UI-only**: `VITE_ADMIN_PASSCODE` is a frontend env var and **not a secure auth mechanism**. For real deployments, move auth server-side.
- **Verification reads from Soroban RPC**: the backend simulates a `get_hash` call against `SOROBAN_RPC_URL`. If RPC is down or rate-limited, verification may fail.
- **Off-chain store**: issued certificate metadata is stored in `backend/data/db.json` for lookup and to know what hash to expect.

---

## Team members
- Student 1: __________________ (Roll No: ________)
- Student 2: __________________ (Roll No: ________)


## License

MIT (or update this section to match your institution’s requirements).

