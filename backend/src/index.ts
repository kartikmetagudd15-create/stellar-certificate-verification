import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { JSONFilePreset } from 'lowdb/node';
import {
  BASE_FEE,
  Contract,
  Networks,
  SorobanRpc,
  StrKey,
  TransactionBuilder,
  xdr,
} from 'stellar-sdk';

const env = z
  .object({
    PORT: z.string().default('4000'),
    STELLAR_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet'),
    SOROBAN_RPC_URL: z.string().url(),
    SOROBAN_CONTRACT_ID: z.string().min(1),
  })
  .parse({
    PORT: process.env.PORT,
    STELLAR_NETWORK: process.env.STELLAR_NETWORK,
    SOROBAN_RPC_URL: process.env.SOROBAN_RPC_URL,
    SOROBAN_CONTRACT_ID: process.env.SOROBAN_CONTRACT_ID,
  });

const networkPassphrase =
  env.STELLAR_NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;

const rpc = new SorobanRpc.Server(env.SOROBAN_RPC_URL, { allowHttp: false });

type CertificateRecord = {
  id: string;
  studentName: string;
  courseName: string;
  issuedOn: string; // ISO
  issuerPublicKey: string;
  hashHex: string;
  createdAt: string; // ISO
};

type DbSchema = {
  certificates: Record<string, CertificateRecord>;
};

await fs.mkdir('data', { recursive: true });
const db = await JSONFilePreset<DbSchema>('data/db.json', {
  certificates: {},
});

type CertificateStatus = 'VERIFIED' | 'INVALID' | 'NOT_ON_CHAIN' | 'ERROR';

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function certHashPayload(c: {
  id: string;
  studentName: string;
  courseName: string;
  issuedOn: string;
  issuerPublicKey: string;
}): string {
  // Stable canonical payload (ordering matters for hash determinism).
  return JSON.stringify(
    {
      id: c.id,
      studentName: c.studentName,
      courseName: c.courseName,
      issuedOn: c.issuedOn,
      issuerPublicKey: c.issuerPublicKey,
    },
    null,
    0,
  );
}

function toScValStr(s: string): xdr.ScVal {
  return xdr.ScVal.scvString(s);
}

function toScValBytesFromHex(hex: string): xdr.ScVal {
  return xdr.ScVal.scvBytes(Buffer.from(hex, 'hex'));
}

async function buildInvokeTxXdr(args: {
  sourcePublicKey: string;
  method: 'set_hash' | 'get_hash';
  certificateId: string;
  hashHex?: string;
}) {
  if (!StrKey.isValidEd25519PublicKey(args.sourcePublicKey)) {
    throw new Error('Invalid source public key');
  }

  const account = await rpc.getAccount(args.sourcePublicKey);
  const contract = new Contract(env.SOROBAN_CONTRACT_ID);

  const op =
    args.method === 'set_hash'
      ? contract.call(
          args.method,
          toScValStr(args.certificateId),
          toScValBytesFromHex(args.hashHex ?? ''),
        )
      : contract.call(args.method, toScValStr(args.certificateId));

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(120)
    .build();

  const prepared = await rpc.prepareTransaction(tx);
  return prepared.toXDR();
}

async function simulateGetHash(args: {
  sourcePublicKey: string;
  certificateId: string;
}) {
  const xdrTx = await buildInvokeTxXdr({
    sourcePublicKey: args.sourcePublicKey,
    method: 'get_hash',
    certificateId: args.certificateId,
  });
  const tx = TransactionBuilder.fromXDR(xdrTx, networkPassphrase);
  const sim = (await rpc.simulateTransaction(tx)) as unknown as {
    result?: { retval?: xdr.ScVal };
    error?: unknown;
  };

  const retval = sim.result?.retval;
  if (!retval) return null;

  // Expect bytes, return as hex.
  if (retval.switch().name === 'scvBytes') {
    return Buffer.from(retval.bytes()).toString('hex');
  }
  return null;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });

  await Promise.all(workers);
  return out;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/certificates/issue', async (req, res) => {
  const bodySchema = z.object({
    studentName: z.string().min(1),
    courseName: z.string().min(1),
    issuedOn: z.string().min(1), // ISO
    issuerPublicKey: z.string().min(1),
  });

  try {
    const body = bodySchema.parse(req.body);
    if (!StrKey.isValidEd25519PublicKey(body.issuerPublicKey)) {
      return res.status(400).json({ error: 'Invalid issuerPublicKey' });
    }

    const id = nanoid(10);
    const payload = certHashPayload({ id, ...body });
    const hashHex = sha256Hex(payload);

    const unsignedTxXdr = await buildInvokeTxXdr({
      sourcePublicKey: body.issuerPublicKey,
      method: 'set_hash',
      certificateId: id,
      hashHex,
    });

    const now = new Date().toISOString();
    db.data.certificates[id] = {
      id,
      studentName: body.studentName,
      courseName: body.courseName,
      issuedOn: body.issuedOn,
      issuerPublicKey: body.issuerPublicKey,
      hashHex,
      createdAt: now,
    };
    await db.write();

    return res.json({
      certificate: db.data.certificates[id],
      unsignedTxXdr,
      networkPassphrase,
      sorobanRpcUrl: env.SOROBAN_RPC_URL,
      contractId: env.SOROBAN_CONTRACT_ID,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return res.status(500).json({ error: msg });
  }
});

app.get('/api/certificates/:id', async (req, res) => {
  const id = z.string().min(1).parse(req.params.id);
  const rec = db.data.certificates[id];
  if (!rec) return res.status(404).json({ error: 'Not found' });
  return res.json({ certificate: rec });
});

app.get('/api/certificates', async (req, res) => {
  const querySchema = z.object({
    includeStatus: z
      .union([z.literal('1'), z.literal('true')])
      .optional()
      .transform((v) => v === '1' || v === 'true'),
  });

  try {
    const q = querySchema.parse(req.query);
    const certs = Object.values(db.data.certificates).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );

    if (!q.includeStatus) {
      return res.json({ certificates: certs });
    }

    const enriched = await mapWithConcurrency(
      certs,
      5,
      async (rec): Promise<
        CertificateRecord & {
          onChainHashHex: string | null;
          status: CertificateStatus;
          match: boolean;
          error?: string;
        }
      > => {
        try {
          const onChainHashHex = await simulateGetHash({
            sourcePublicKey: rec.issuerPublicKey,
            certificateId: rec.id,
          });
          const match = Boolean(onChainHashHex) && onChainHashHex === rec.hashHex;
          const status: CertificateStatus = !onChainHashHex
            ? 'NOT_ON_CHAIN'
            : match
              ? 'VERIFIED'
              : 'INVALID';

          return { ...rec, onChainHashHex, match, status };
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Unknown error';
          return {
            ...rec,
            onChainHashHex: null,
            match: false,
            status: 'ERROR',
            error: msg,
          };
        }
      },
    );

    return res.json({ certificates: enriched });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return res.status(400).json({ error: msg });
  }
});

app.get('/api/certificates/:id/verify', async (req, res) => {
  const id = z.string().min(1).parse(req.params.id);
  const rec = db.data.certificates[id];
  if (!rec) return res.status(404).json({ error: 'Not found' });

  try {
    // Use issuer as read source; any funded account works.
    const onChainHashHex = await simulateGetHash({
      sourcePublicKey: rec.issuerPublicKey,
      certificateId: id,
    });

    return res.json({
      id,
      expectedHashHex: rec.hashHex,
      onChainHashHex,
      match: onChainHashHex ? onChainHashHex === rec.hashHex : false,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return res.status(500).json({ error: msg });
  }
});

const port = Number(env.PORT);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listening on http://localhost:${port}`);
});

