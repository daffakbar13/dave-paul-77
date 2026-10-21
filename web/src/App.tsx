import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, hasToken, setToken, UNAUTHORIZED, type Account, type Analysis, type Colors, type News, type OrderRow, type SymbolItem } from './api.ts';
import { Chart } from './components/Chart.tsx';
import { ExecuteModal } from './components/ExecuteModal.tsx';
import { PendingModal } from './components/PendingModal.tsx';
import { SettingsModal } from './components/SettingsModal.tsx';
import { ago, fmtMoney, fmtWib } from './format.ts';

const ACCOUNT_KEY = 'dp77-account';
const SYMBOL_KEY = 'dp77-symbol';

function remember(key: string, value?: string): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    // per-viewer convenience only
  }
  return null;
}

export function App() {
  const [signedIn, setSignedIn] = useState(hasToken());
  useEffect(() => {
    const out = () => setSignedIn(false);
    window.addEventListener(UNAUTHORIZED, out);
    return () => window.removeEventListener(UNAUTHORIZED, out);
  }, []);
  return signedIn ? <Main onLogout={() => { setToken(null); setSignedIn(false); }} /> : <Login onDone={() => setSignedIn(true)} />;
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      setToken((await api.login(password)).token);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="login">
      <form onSubmit={submit}>
        <h1>DavePaul77</h1>
        <label className="field">
          <span>Password</span>
          <input type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="primary" disabled={busy || !password}>
          {busy ? 'Masuk…' : 'Masuk'}
        </button>
      </form>
    </main>
  );
}

type ModalKind = 'pending' | 'execute' | 'settings' | null;

function Main({ onLogout }: { onLogout: () => void }) {
  const [symbols, setSymbols] = useState<SymbolItem[]>([]);
  const [colors, setColors] = useState<Colors>({ sr: '#FFD60A', entry: '#FFFFFF', sltp: '#FF453A' });
  const [symbol, setSymbol] = useState<string | null>(remember(SYMBOL_KEY));
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState<string | null>(remember(ACCOUNT_KEY));
  const [aggressive, setAggressive] = useState(false);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [news, setNews] = useState<News[]>([]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [onlyFocused, setOnlyFocused] = useState(false);
  const [modal, setModal] = useState<ModalKind>(null);
  const [error, setError] = useState<string | null>(null);
  // analysis waits for the account list so a remembered, deleted account is never sent
  const [ready, setReady] = useState(false);
  const tabsRef = useRef<HTMLDivElement>(null);

  const loadMeta = useCallback(async () => {
    try {
      const [s, a, n] = await Promise.all([api.symbols(), api.accounts(), api.news()]);
      const active = s.symbols.filter((x) => x.active);
      setSymbols(active);
      setColors(s.colors);
      setAccounts(a.accounts);
      setNews(n.news);
      setSymbol((cur) => (cur && active.some((x) => x.name === cur) ? cur : active[0]?.name ?? null));
      setAccountId((cur) => (cur && a.accounts.some((x) => x.id === cur) ? cur : a.accounts[0]?.id ?? null));
      setReady(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const loadAnalysis = useCallback(async () => {
    if (!symbol || !ready) return;
    try {
      setAnalysis(await api.analysis(symbol, accountId ?? undefined, aggressive));
      setError(null);
    } catch (e) {
      setAnalysis(null);
      setError((e as Error).message);
    }
  }, [symbol, accountId, aggressive, ready]);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);
  useEffect(() => {
    void loadAnalysis();
    const id = setInterval(() => void loadAnalysis(), 60_000);
    return () => clearInterval(id);
  }, [loadAnalysis]);
  useEffect(() => setFocusId(null), [symbol]);
  useEffect(() => {
    if (symbol) remember(SYMBOL_KEY, symbol);
  }, [symbol]);
  useEffect(() => {
    if (accountId) remember(ACCOUNT_KEY, accountId);
  }, [accountId]);

  const refresh = () => {
    void loadMeta();
    void loadAnalysis();
  };

  const cancel = async (row: OrderRow) => {
    try {
      await api.cancel(row.id);
      if (focusId === row.id) setFocusId(null);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const account = accounts.find((a) => a.id === accountId) ?? null;
  const stale = account && (!account.balanceAt || analysis?.account?.stale);

  return (
    <div className="app">
      <header className="toolbar">
        <div className="acct tabular">
          <label>
            <span className="sr-only">Akun</span>
            <select value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value || null)} aria-label="Akun">
              {!accounts.length && <option value="">Belum ada akun</option>}
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  Akun: {a.name}
                </option>
              ))}
            </select>
          </label>
          {account && (
            <span className={stale ? 'warn' : 'muted'}>
              Balance {fmtMoney(account.balance)} {account.currency ?? ''} (sinkron {ago(account.balanceAt)})
            </span>
          )}
        </div>
        <div className="tool-actions">
          <button type="button" className={aggressive ? 'aggr-on' : ''} aria-pressed={aggressive} onClick={() => setAggressive((v) => !v)}>
            Aggressive{aggressive && account ? ` ${account.aggressiveMultiplier}x` : ''}
          </button>
          <button type="button" onClick={() => setModal('pending')}>
            Pending Orders
          </button>
          <button type="button" className="primary" onClick={() => setModal('execute')}>
            Execute
          </button>
          <button type="button" className="icon" aria-label="Pengaturan" title="Pengaturan" onClick={() => setModal('settings')}>
            ⚙
          </button>
          <button type="button" className="link" onClick={onLogout}>
            Keluar
          </button>
        </div>
      </header>

      {news.length > 0 && (
        <div className="news" role="status">
          {news.map((n) => (
            <span key={n.id}>
              Berita merah {n.currency} {fmtWib(n.at)}: {n.title}
            </span>
          ))}
          {aggressive ? ' Aggressive aktif.' : ''}
        </div>
      )}
      {error && <div className="error-bar">{error}</div>}

      <main className="stage">
        {analysis && analysis.symbol === symbol ? (
          <>
            <Chart analysis={analysis} colors={colors} focusId={focusId} onlyFocused={onlyFocused} onFocus={setFocusId} onCancel={cancel} />
            <div className="chart-tools">
              <span className="muted tabular">
                {analysis.lines.length} garis · {analysis.rows.filter((r) => r.status === 'valid').length} order valid · candle terakhir{' '}
                {ago(analysis.lastCandleAt)}
              </span>
              <div className="seg">
                <button type="button" aria-pressed={!onlyFocused} onClick={() => setOnlyFocused(false)}>
                  Semua
                </button>
                <button type="button" aria-pressed={onlyFocused} disabled={!focusId} onClick={() => setOnlyFocused(true)}>
                  Hanya dipilih
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="empty muted">{symbol ? 'Memuat…' : 'Belum ada pair aktif. Atur di Pengaturan.'}</div>
        )}
      </main>

      <nav className="tabs" ref={tabsRef} aria-label="Pair">
        {symbols.map((s) => (
          <button key={s.name} type="button" className={s.name === symbol ? 'active' : ''} aria-current={s.name === symbol} onClick={() => setSymbol(s.name)}>
            {s.name}
            {s.candidates > 0 && <span className="dot" aria-label={`${s.candidates} kandidat`}>•</span>}
          </button>
        ))}
      </nav>

      {modal === 'pending' && <PendingModal account={account} accounts={accounts} aggressive={aggressive} onClose={() => setModal(null)} onChanged={refresh} />}
      {modal === 'execute' && (
        <ExecuteModal accounts={accounts} initialAccountId={accountId} aggressive={aggressive} onClose={() => setModal(null)} onChanged={refresh} />
      )}
      {modal === 'settings' && <SettingsModal onClose={() => setModal(null)} onChanged={refresh} />}
    </div>
  );
}
