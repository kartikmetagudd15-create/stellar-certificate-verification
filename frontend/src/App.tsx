import { useMemo, useState, type CSSProperties } from 'react';
import {
  getAddress,
  isConnected,
  isAllowed,
  requestAccess,
  signTransaction,
} from '@stellar/freighter-api';
import { Networks, SorobanRpc, TransactionBuilder } from 'stellar-sdk';

type IssueResponse = {
  certificate: {
    id: string;
    studentName: string;
    courseName: string;
    issuedOn: string;
    issuerPublicKey: string;
    hashHex: string;
    createdAt: string;
  };
  unsignedTxXdr: string;
  networkPassphrase: string;
  sorobanRpcUrl: string;
  contractId: string;
};

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';

type CertificateRecord = IssueResponse['certificate'];

type CertificateStatus = 'VERIFIED' | 'INVALID' | 'NOT_ON_CHAIN' | 'ERROR';
type CertificateWithStatus = CertificateRecord & {
  onChainHashHex: string | null;
  status: CertificateStatus;
  match: boolean;
  error?: string;
};

function cls(...parts: Array<string | false | undefined>) {
  return parts.filter(Boolean).join(' ');
}

async function submitSorobanTx(opts: {
  rpcUrl: string;
  signedTxXdr: string;
  networkPassphrase: string;
}) {
  const server = new SorobanRpc.Server(opts.rpcUrl, { allowHttp: false });
  const tx = TransactionBuilder.fromXDR(opts.signedTxXdr, opts.networkPassphrase);
  const send = await server.sendTransaction(tx);
  if (send.status !== 'PENDING') return send;

  // Poll until it lands.
  for (let i = 0; i < 25; i++) {
    // eslint-disable-next-line no-await-in-loop
    const res = await server.getTransaction(send.hash);
    if (res.status !== 'NOT_FOUND') return res;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 1000));
  }
  return send;
}

export function App() {
  const [tab, setTab] = useState<'issue' | 'verify' | 'dashboard'>('issue');
  const [adminLoggedIn, setAdminLoggedIn] = useState<boolean>(() => {
    return localStorage.getItem('adminLoggedIn') === 'true';
  });
  const [adminPasscode, setAdminPasscode] = useState('');

  const [walletPublicKey, setWalletPublicKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string>('');

  const [studentName, setStudentName] = useState('');
  const [courseName, setCourseName] = useState('Blockchain AAT');
  const [issuedOn, setIssuedOn] = useState(() => new Date().toISOString());

  const [verifyId, setVerifyId] = useState('');
  const [verifyResult, setVerifyResult] = useState<any>(null);

  const [dashboardBusy, setDashboardBusy] = useState(false);
  const [dashboardError, setDashboardError] = useState<string>('');
  const [certs, setCerts] = useState<CertificateWithStatus[]>([]);
  const [statusFilter, setStatusFilter] = useState<
    'ALL' | CertificateStatus
  >('ALL');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const networkPassphrase = useMemo(() => {
    const n = (import.meta.env.VITE_STELLAR_NETWORK as string) || 'testnet';
    return n === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
  }, []);

  async function connectWallet() {
    setLog('');
    const connected = await isConnected();
    if (!connected) {
      setLog('Freighter not detected. Install/enable Freighter, then refresh.');
      return;
    }

    const allowed = await isAllowed();
    if (allowed.error) {
      setLog(`Freighter error: ${String(allowed.error)}`);
      return;
    }
    if (!allowed.isAllowed) {
      const access = await requestAccess();
      if ((access as any).error) {
        setLog(`Freighter access error: ${JSON.stringify((access as any).error)}`);
        return;
      }
    }

    const res = await getAddress();
    if (res.error) {
      setLog(`Freighter error: ${String(res.error)}`);
      return;
    }
    setWalletPublicKey(res.address);
  }

  function loginAdmin() {
    // Simple login: passcode check (demo-safe). Update passcode anytime.
    const expected = (import.meta.env.VITE_ADMIN_PASSCODE as string) || 'admin123';
    if (adminPasscode.trim() !== expected) {
      setLog('Invalid admin passcode.');
      return;
    }
    localStorage.setItem('adminLoggedIn', 'true');
    setAdminLoggedIn(true);
    setAdminPasscode('');
    setLog('Admin login successful.');
  }

  function logoutAdmin() {
    localStorage.removeItem('adminLoggedIn');
    setAdminLoggedIn(false);
    setLog('Logged out.');
  }

  async function issueCertificate() {
    if (!adminLoggedIn) {
      setLog('Please login as Admin to issue certificates.');
      return;
    }
    if (!walletPublicKey) {
      setLog('Connect Freighter first.');
      return;
    }
    setBusy(true);
    setLog('');
    try {
      const resp = await fetch(`${apiBaseUrl}/api/certificates/issue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentName,
          courseName,
          issuedOn,
          issuerPublicKey: walletPublicKey,
        }),
      });
      if (!resp.ok) throw new Error(await resp.text());

      const data = (await resp.json()) as IssueResponse;
      setLog(`Created certificate id: ${data.certificate.id}`);

      const signed = await signTransaction(data.unsignedTxXdr, {
        networkPassphrase: data.networkPassphrase || networkPassphrase,
        address: walletPublicKey,
      });
      if ((signed as any).error) {
        throw new Error(`Freighter sign error: ${JSON.stringify((signed as any).error)}`);
      }

      const submitRes = await submitSorobanTx({
        rpcUrl:
          import.meta.env.VITE_SOROBAN_RPC_URL ||
          data.sorobanRpcUrl ||
          'https://soroban-testnet.stellar.org',
        signedTxXdr: signed.signedTxXdr,
        networkPassphrase: data.networkPassphrase || networkPassphrase,
      });

      setLog((prev) =>
        [
          prev,
          '',
          'Submitted to Soroban:',
          JSON.stringify(submitRes, null, 2),
        ].join('\n'),
      );
    } catch (e) {
      setLog(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  async function verifyCertificate() {
    setBusy(true);
    setVerifyResult(null);
    setLog('');
    try {
      const resp = await fetch(
        `${apiBaseUrl}/api/certificates/${encodeURIComponent(verifyId)}/verify`,
      );
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      setVerifyResult(data);
    } catch (e) {
      setLog(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  async function loadDashboard() {
    setDashboardBusy(true);
    setDashboardError('');
    try {
      const resp = await fetch(`${apiBaseUrl}/api/certificates?includeStatus=true`);
      if (!resp.ok) throw new Error(await resp.text());
      const data = (await resp.json()) as { certificates: CertificateWithStatus[] };
      setCerts(data.certificates || []);
      setSelectedId((prev) => {
        if (!prev) return data.certificates?.[0]?.id ?? null;
        return data.certificates?.some((c) => c.id === prev)
          ? prev
          : data.certificates?.[0]?.id ?? null;
      });
    } catch (e) {
      setDashboardError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setDashboardBusy(false);
    }
  }

  const filteredCerts = useMemo(() => {
    if (statusFilter === 'ALL') return certs;
    return certs.filter((c) => c.status === statusFilter);
  }, [certs, statusFilter]);

  const counts = useMemo(() => {
    const base: Record<CertificateStatus, number> = {
      VERIFIED: 0,
      INVALID: 0,
      NOT_ON_CHAIN: 0,
      ERROR: 0,
    };
    for (const c of certs) base[c.status] += 1;
    return base;
  }, [certs]);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    return certs.find((c) => c.id === selectedId) || null;
  }, [certs, selectedId]);

  function statusPill(s: CertificateStatus) {
    const map: Record<
      CertificateStatus,
      { bg: string; fg: string; bd: string; label: string }
    > = {
      VERIFIED: { bg: '#dcfce7', fg: '#166534', bd: '#86efac', label: 'VERIFIED' },
      INVALID: { bg: '#fee2e2', fg: '#991b1b', bd: '#fecaca', label: 'INVALID' },
      NOT_ON_CHAIN: {
        bg: '#ffedd5',
        fg: '#9a3412',
        bd: '#fed7aa',
        label: 'NOT ON CHAIN',
      },
      ERROR: { bg: '#e5e7eb', fg: '#111827', bd: '#d1d5db', label: 'ERROR' },
    };
    const v = map[s];
    return (
      <span
        style={{
          fontSize: 12,
          fontWeight: 700,
          padding: '4px 10px',
          borderRadius: 999,
          background: v.bg,
          color: v.fg,
          border: `1px solid ${v.bd}`,
          whiteSpace: 'nowrap',
        }}
      >
        {v.label}
      </span>
    );
  }

  return (
    <div
      style={{
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial',
        padding: 24,
        maxWidth: 980,
        margin: '0 auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ margin: 0 }}>Certificate Registry</h2>
        <span
          style={{
            fontSize: 12,
            padding: '4px 10px',
            borderRadius: 999,
            background: '#eef2ff',
            color: '#3730a3',
          }}
        >
          Stellar Soroban + Freighter
        </span>
      </div>

      <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button
          onClick={() => setTab('issue')}
          disabled={busy}
          style={tab === 'issue' ? tabBtnActive : tabBtn}
        >
          Issue
        </button>
        <button
          onClick={() => setTab('verify')}
          disabled={busy}
          style={tab === 'verify' ? tabBtnActive : tabBtn}
        >
          Verify
        </button>
        <button
          onClick={() => {
            setTab('dashboard');
            void loadDashboard();
          }}
          disabled={busy || dashboardBusy}
          style={tab === 'dashboard' ? tabBtnActive : tabBtn}
        >
          Dashboard
        </button>
      </div>

      <div
        style={{
          marginTop: 16,
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <div
          style={{
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: 12, color: '#6b7280' }}>Admin:</span>
          {adminLoggedIn ? (
            <>
              <span
                style={{
                  fontSize: 12,
                  padding: '4px 10px',
                  borderRadius: 999,
                  background: '#dcfce7',
                  color: '#166534',
                }}
              >
                Logged in
              </span>
              <button
                onClick={logoutAdmin}
                disabled={busy}
                style={{
                  border: '1px solid #e5e7eb',
                  background: 'white',
                  color: '#111827',
                  padding: '8px 12px',
                  borderRadius: 10,
                  cursor: 'pointer',
                }}
              >
                Logout
              </button>
            </>
          ) : (
            <>
              <input
                value={adminPasscode}
                onChange={(e) => setAdminPasscode(e.target.value)}
                placeholder="Passcode (default: admin123)"
                type="password"
                style={{ ...inputStyle, width: 220, marginTop: 0 }}
              />
              <button
                onClick={loginAdmin}
                disabled={busy || !adminPasscode}
                style={{
                  border: '1px solid #111827',
                  background: '#111827',
                  color: 'white',
                  padding: '8px 12px',
                  borderRadius: 10,
                  cursor: 'pointer',
                }}
              >
                Login
              </button>
            </>
          )}
        </div>

        <button
          onClick={connectWallet}
          disabled={busy}
          style={{
            border: '1px solid #111827',
            background: '#111827',
            color: 'white',
            padding: '10px 14px',
            borderRadius: 10,
            cursor: 'pointer',
          }}
        >
          {walletPublicKey ? 'Freighter Connected' : 'Connect Freighter'}
        </button>
        <div style={{ fontSize: 14, color: '#374151' }}>
          {walletPublicKey ? (
            <code>{walletPublicKey}</code>
          ) : (
            'No wallet connected'
          )}
        </div>
      </div>

      {tab === 'dashboard' ? (
        <div
          style={{
            border: '1px solid #e5e7eb',
            borderRadius: 14,
            padding: 16,
            marginTop: 20,
          }}
        >
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0 }}>Dashboard</h3>
            <button
              onClick={() => void loadDashboard()}
              disabled={dashboardBusy}
              style={{
                border: '1px solid #e5e7eb',
                background: 'white',
                color: '#111827',
                padding: '8px 12px',
                borderRadius: 10,
                cursor: 'pointer',
              }}
            >
              Refresh
            </button>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: '#6b7280' }}>
                Verified: <b>{counts.VERIFIED}</b>
              </span>
              <span style={{ fontSize: 12, color: '#6b7280' }}>
                Invalid: <b>{counts.INVALID}</b>
              </span>
              <span style={{ fontSize: 12, color: '#6b7280' }}>
                Not on-chain: <b>{counts.NOT_ON_CHAIN}</b>
              </span>
              <span style={{ fontSize: 12, color: '#6b7280' }}>
                Error: <b>{counts.ERROR}</b>
              </span>
            </div>

            <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: '#6b7280' }}>Filter:</span>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as any)}
                style={{
                  border: '1px solid #e5e7eb',
                  borderRadius: 10,
                  padding: '8px 10px',
                  background: 'white',
                }}
              >
                <option value="ALL">All</option>
                <option value="VERIFIED">Verified</option>
                <option value="INVALID">Invalid</option>
                <option value="NOT_ON_CHAIN">Not on-chain</option>
                <option value="ERROR">Error</option>
              </select>
            </div>
          </div>

          {dashboardError ? (
            <pre
              style={{
                marginTop: 12,
                background: '#111827',
                color: '#f9fafb',
                padding: 12,
                borderRadius: 12,
                overflow: 'auto',
                fontSize: 12,
              }}
            >
              {dashboardError}
            </pre>
          ) : null}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1.3fr 1fr',
              gap: 14,
              marginTop: 14,
            }}
          >
            <div
              style={{
                border: '1px solid #e5e7eb',
                borderRadius: 12,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '10px 12px',
                  borderBottom: '1px solid #e5e7eb',
                  background: '#f9fafb',
                  fontSize: 12,
                  color: '#6b7280',
                }}
              >
                <span>
                  Showing <b>{filteredCerts.length}</b> certificate(s)
                </span>
                <span>{dashboardBusy ? 'Loading…' : ''}</span>
              </div>

              <div style={{ maxHeight: 430, overflow: 'auto' }}>
                {filteredCerts.length === 0 ? (
                  <div style={{ padding: 12, fontSize: 12, color: '#6b7280' }}>
                    No certificates found.
                  </div>
                ) : (
                  filteredCerts.map((c) => {
                    const active = c.id === selectedId;
                    return (
                      <button
                        key={c.id}
                        onClick={() => setSelectedId(c.id)}
                        style={{
                          display: 'flex',
                          width: '100%',
                          textAlign: 'left',
                          gap: 10,
                          padding: '10px 12px',
                          border: 'none',
                          borderBottom: '1px solid #f3f4f6',
                          background: active ? '#eef2ff' : 'white',
                          cursor: 'pointer',
                          alignItems: 'center',
                        }}
                      >
                        <div style={{ minWidth: 120 }}>
                          <div style={{ fontSize: 12, color: '#6b7280' }}>ID</div>
                          <div style={{ fontWeight: 700, color: '#111827' }}>{c.id}</div>
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, color: '#6b7280' }}>Student</div>
                          <div
                            style={{
                              fontWeight: 600,
                              color: '#111827',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {c.studentName}
                          </div>
                          <div
                            style={{
                              fontSize: 12,
                              color: '#6b7280',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              marginTop: 2,
                            }}
                          >
                            {c.courseName}
                          </div>
                        </div>
                        {statusPill(c.status)}
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            <div
              style={{
                border: '1px solid #e5e7eb',
                borderRadius: 12,
                padding: 12,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <h4 style={{ margin: 0 }}>Certificate details</h4>
                {selected ? statusPill(selected.status) : null}
              </div>

              {!selected ? (
                <div style={{ marginTop: 10, fontSize: 12, color: '#6b7280' }}>
                  Select a certificate from the list to view details.
                </div>
              ) : (
                <>
                  <div style={{ marginTop: 10, fontSize: 12, color: '#6b7280' }}>Student</div>
                  <div style={{ fontWeight: 700 }}>{selected.studentName}</div>

                  <div style={{ marginTop: 10, fontSize: 12, color: '#6b7280' }}>Course</div>
                  <div style={{ fontWeight: 700 }}>{selected.courseName}</div>

                  <div style={{ marginTop: 10, fontSize: 12, color: '#6b7280' }}>Issued On</div>
                  <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                    {selected.issuedOn}
                  </div>

                  <div style={{ marginTop: 10, fontSize: 12, color: '#6b7280' }}>Issuer</div>
                  <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                    {selected.issuerPublicKey}
                  </div>

                  <div style={{ marginTop: 10, fontSize: 12, color: '#6b7280' }}>Expected hash</div>
                  <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                    {selected.hashHex}
                  </div>

                  <div style={{ marginTop: 10, fontSize: 12, color: '#6b7280' }}>On-chain hash</div>
                  <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                    {selected.onChainHashHex ?? '(none)'}
                  </div>

                  {selected.error ? (
                    <>
                      <div style={{ marginTop: 10, fontSize: 12, color: '#6b7280' }}>Error</div>
                      <div style={{ fontSize: 12, color: '#991b1b' }}>{selected.error}</div>
                    </>
                  ) : null}

                  <div style={{ marginTop: 12, display: 'flex', gap: 10 }}>
                    <button
                      onClick={() => {
                        setTab('verify');
                        setVerifyId(selected.id);
                        setVerifyResult(null);
                        setLog('');
                      }}
                      style={{
                        border: '1px solid #111827',
                        background: '#111827',
                        color: 'white',
                        padding: '10px 12px',
                        borderRadius: 10,
                        cursor: 'pointer',
                        flex: 1,
                      }}
                    >
                      Open in Verify
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 16,
            marginTop: 20,
          }}
        >
          <div
            style={{
              border: '1px solid #e5e7eb',
              borderRadius: 14,
              padding: 16,
              opacity: adminLoggedIn ? 1 : 0.6,
              display: tab === 'issue' ? 'block' : 'none',
            }}
          >
            <h3 style={{ marginTop: 0 }}>Issue certificate</h3>
            {!adminLoggedIn ? (
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
                Login as Admin to enable issuance.
              </div>
            ) : null}
            <label style={{ display: 'block', fontSize: 12, color: '#6b7280' }}>
              Student name
            </label>
            <input
              value={studentName}
              onChange={(e) => setStudentName(e.target.value)}
              placeholder="e.g., Rahul Patil"
              className={cls('input')}
              style={inputStyle}
              disabled={!adminLoggedIn}
            />

            <label
              style={{
                display: 'block',
                marginTop: 10,
                fontSize: 12,
                color: '#6b7280',
              }}
            >
              Course
            </label>
            <input
              value={courseName}
              onChange={(e) => setCourseName(e.target.value)}
              className={cls('input')}
              style={inputStyle}
              disabled={!adminLoggedIn}
            />

            <label
              style={{
                display: 'block',
                marginTop: 10,
                fontSize: 12,
                color: '#6b7280',
              }}
            >
              Issued on (ISO)
            </label>
            <input
              value={issuedOn}
              onChange={(e) => setIssuedOn(e.target.value)}
              className={cls('input')}
              style={inputStyle}
              disabled={!adminLoggedIn}
            />

            <button
              onClick={issueCertificate}
              disabled={busy || !adminLoggedIn || !studentName || !courseName}
              style={{
                marginTop: 12,
                border: '1px solid #2563eb',
                background: '#2563eb',
                color: 'white',
                padding: '10px 14px',
                borderRadius: 10,
                cursor: 'pointer',
                width: '100%',
              }}
            >
              Issue (Freighter will sign)
            </button>
          </div>

          <div
            style={{
              border: '1px solid #e5e7eb',
              borderRadius: 14,
              padding: 16,
              display: tab === 'verify' ? 'block' : 'none',
            }}
          >
            <h3 style={{ marginTop: 0 }}>Verify certificate</h3>
            <label style={{ display: 'block', fontSize: 12, color: '#6b7280' }}>
              Certificate ID
            </label>
            <input
              value={verifyId}
              onChange={(e) => setVerifyId(e.target.value)}
              placeholder="Paste certificate id here"
              style={inputStyle}
            />
            <button
              onClick={verifyCertificate}
              disabled={busy || !verifyId}
              style={{
                marginTop: 12,
                border: '1px solid #16a34a',
                background: '#16a34a',
                color: 'white',
                padding: '10px 14px',
                borderRadius: 10,
                cursor: 'pointer',
                width: '100%',
              }}
            >
              Verify (checks on-chain hash)
            </button>

            {verifyResult ? (
              <div style={{ marginTop: 12 }}>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: verifyResult.match ? '#166534' : '#991b1b',
                    background: verifyResult.match ? '#dcfce7' : '#fee2e2',
                    border: `1px solid ${verifyResult.match ? '#86efac' : '#fecaca'}`,
                    borderRadius: 10,
                    padding: '8px 10px',
                  }}
                >
                  {verifyResult.match ? 'VALID CERTIFICATE' : 'INVALID CERTIFICATE'}
                </div>
                <pre
                  style={{
                    marginTop: 10,
                    background: '#0b1020',
                    color: '#e5e7eb',
                    padding: 12,
                    borderRadius: 12,
                    overflow: 'auto',
                    fontSize: 12,
                  }}
                >
                  {JSON.stringify(verifyResult, null, 2)}
                </pre>
              </div>
            ) : (
              <div style={{ marginTop: 12, fontSize: 12, color: '#6b7280' }}>
                Verification result will appear here.
              </div>
            )}
          </div>
        </div>
      )}

      {log ? (
        <pre
          style={{
            marginTop: 16,
            background: '#111827',
            color: '#f9fafb',
            padding: 12,
            borderRadius: 12,
            overflow: 'auto',
            fontSize: 12,
          }}
        >
          {log}
        </pre>
      ) : null}
    </div>
  );
}

const inputStyle: CSSProperties = {
  width: '100%',
  border: '1px solid #e5e7eb',
  borderRadius: 10,
  padding: '10px 12px',
  marginTop: 6,
  outline: 'none',
};

const tabBtn: CSSProperties = {
  border: '1px solid #e5e7eb',
  background: 'white',
  color: '#111827',
  padding: '8px 12px',
  borderRadius: 10,
  cursor: 'pointer',
};

const tabBtnActive: CSSProperties = {
  ...tabBtn,
  border: '1px solid #111827',
  background: '#111827',
  color: 'white',
};

