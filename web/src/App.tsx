import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, hasToken, setToken, UNAUTHORIZED, type Account, type Analysis, type Colors, type AggressiveMode, type Mt4Status, type NewsFeed, type OrderRow, type SymbolItem } from './api.ts';
import { BacktestModal } from './components/BacktestModal.tsx';
import { CalibrationModal } from './components/CalibrationModal.tsx';
import { Chart } from './components/Chart.tsx';
import { ExecuteModal } from './components/ExecuteModal.tsx';
import { JournalModal } from './components/JournalModal.tsx';
import { NewsModal } from './components/NewsModal.tsx';
import { PendingModal } from './components/PendingModal.tsx';
import { SettingsModal } from './components/SettingsModal.tsx';
import { ago, fmtDate, fmtMoney, fmtNewsTime } from './format.ts';

const ACCOUNT_KEY = 'dp77-account';
const AGGRESSIVE_KEY = 'dp77-aggressive';
const SYMBOL_KEY = 'dp77-symbol';

// Aggressive lasts for the browser session: it starts on auto every time the app is opened.
function sessionMode(value?: AggressiveMode): AggressiveMode {
  try {
    if (value) sessionStorage.setItem(AGGRESSIVE_KEY, value);
    const v = sessionStorage.getItem(AGGRESSIVE_KEY);
    if (v === 'auto' || v === 'on' || v === 'off') return v;
  } catch {
    // storage blocked: memory only
  }
  return value ?? 'auto';
}

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

type ModalKind = 'pending' | 'execute' | 'settings' | 'calibration' | 'journal' | 'news' | 'backtest' | null;

const MT4_STALE_MINUTES = 10;

function Main({ onLogout }: { onLogout: () => void }) {
  const [symbols, setSymbols] = useState<SymbolItem[]>([]);
  const [colors, setColors] = useState<Colors>({ sr: '#FFD60A', entry: '#FFFFFF', sltp: '#FF453A' });
  const [symbol, setSymbol] = useState<string | null>(remember(SYMBOL_KEY));
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState<string | null>(remember(ACCOUNT_KEY));
  const [aggressive, setAggressiveState] = useState<AggressiveMode>(() => sessionMode());
  const setAggressive = (m: AggressiveMode) => setAggressiveState(sessionMode(m));
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [feed, setFeed] = useState<NewsFeed | null>(null);
  const [mt4, setMt4] = useState<Mt4Status>(null);
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
      setMt4(s.mt4);
      setAccounts(a.accounts);
      setFeed(n);
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
  const cancelledHere = analysis?.rows.filter((r) => r.status === 'cancelled').length ?? 0;

  const restoreAll = async () => {
    try {
      await api.restoreAll(symbol ?? undefined);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // auto: on for pairs with red news ahead (accounts with auto enabled); a click turns
  // the feature off for the session, another click turns it on for every pair.
  const affected = feed?.affected ?? [];
  const newsPairs = new Set(symbols.filter((s) => affected.some((c) => s.name.includes(c))).map((s) => s.name));
  const autoActive = aggressive === 'auto' && affected.length > 0 && !!account?.aggressiveAuto;
  const aggrActive = aggressive === 'on' || autoActive;
  const mult = account ? `${account.aggressiveMultiplier}x` : '';
  const aggrLabel =
    aggressive === 'on' ? `Aggressive ${mult} semua pair` : autoActive ? `Aggressive ${mult} auto (${affected.join(', ')})` : aggressive === 'off' ? 'Aggressive mati' : 'Aggressive';
  const aggrTitle = aggrActive ? 'Klik untuk mematikan Aggressive selama sesi ini' : 'Klik untuk menyalakan Aggressive di semua pair';
  const newsNote =
    aggressive === 'off'
      ? 'Aggressive dimatikan untuk sesi ini.'
      : aggressive === 'on'
        ? 'Aggressive manual aktif untuk semua pair.'
        : autoActive
          ? 'Aggressive aktif untuk pair terkait.'
          : account && !account.aggressiveAuto
            ? 'Aggressive otomatis nonaktif untuk akun ini.'
            : '';
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
          <button
            type="button"
            className={aggrActive ? 'aggr-on' : aggressive === 'off' ? 'aggr-off' : ''}
            aria-pressed={aggrActive}
            title={aggrTitle}
            onClick={() => setAggressive(aggrActive ? 'off' : 'on')}
          >
            {aggrLabel}
          </button>
          <button type="button" onClick={() => setModal('news')}>
            Berita
          </button>
          <button type="button" onClick={() => setModal('pending')}>
            Pending Orders
          </button>
          <button type="button" className="primary" onClick={() => setModal('execute')}>
            Execute
          </button>
          <button type="button" onClick={() => setModal('journal')}>
            Jurnal
          </button>
          <button type="button" onClick={() => setModal('backtest')}>
            Backtest
          </button>
          <button type="button" onClick={() => setModal('calibration')}>
            Kalibrasi
          </button>
          <button type="button" className="icon" aria-label="Pengaturan" title="Pengaturan" onClick={() => setModal('settings')}>
            ⚙
          </button>
          <button type="button" className="link" onClick={onLogout}>
            Keluar
          </button>
        </div>
      </header>

      {feed && (feed.news.length > 0 || feed.status.error) && (
        <div className="news" role="status">
          {feed.news.map((n) => (
            <span key={n.id} className={new Date(n.at).getTime() < Date.now() ? 'past' : ''}>
              Berita merah {n.currency} {fmtNewsTime(n.at)}: {n.title}
            </span>
          ))}
          {feed.news.length > 0 && <span className="news-note">{newsNote}</span>}
          <button type="button" className="news-more" onClick={() => setModal('news')}>
            Semua berita
          </button>
          {feed.status.error && <span className="error">Kalender gagal diambil ({feed.status.error}); data terakhir dipakai.</span>}
        </div>
      )}
      {error && <div className="error-bar">{error}</div>}

      <main className="stage">
        {analysis && analysis.symbol === symbol ? (
          <>
            <Chart analysis={analysis} colors={colors} focusId={focusId} onlyFocused={onlyFocused} onFocus={setFocusId} onCancel={cancel} />
            <div className="chart-tools">
              <span className="muted tabular">
                {analysis.lines.length} garis {analysis.lines[0]?.source === 'manual' ? 'manual' : 'mesin'}{analysis.referenceLines.length > 0 && analysis.lines[0]?.source !== 'manual' ? ` (+${analysis.referenceLines.length} referensi Anda)` : ''} · {analysis.rows.filter((r) => r.status === 'valid').length} order valid · candle terakhir{' '}
                {fmtDate(new Date(analysis.lastCandleAt).getTime())} ·{' '}
                <span className={mt4 && Date.now() - new Date(mt4.lastSeenAt).getTime() < MT4_STALE_MINUTES * 60_000 ? '' : 'warn'}>
                  MT4 {mt4 ? `terakhir kirim ${ago(mt4.lastSeenAt)}` : 'belum pernah kirim data'}
                  {mt4?.brokerOffsetMinutes !== undefined && ` (server broker UTC${mt4.brokerOffsetMinutes >= 0 ? '+' : ''}${mt4.brokerOffsetMinutes / 60})`}
                </span>
              </span>
              {cancelledHere > 0 && (
                <button type="button" className="restore-all" title={`Kembalikan semua order ${analysis.symbol} yang dibatalkan dengan X`} onClick={restoreAll}>
                  Pulihkan semua ({cancelledHere})
                </button>
              )}
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
            {newsPairs.has(s.name) && (
              <span className="news-mark" title="Ada berita merah untuk mata uang pair ini" aria-label="berita merah">
                !
              </span>
            )}
          </button>
        ))}
      </nav>

      {modal === 'pending' && <PendingModal account={account} accounts={accounts} aggressive={aggressive} onClose={() => setModal(null)} onChanged={refresh} />}
      {modal === 'execute' && (
        <ExecuteModal accounts={accounts} initialAccountId={accountId} aggressive={aggressive} onClose={() => setModal(null)} onChanged={refresh} />
      )}
      {modal === 'settings' && <SettingsModal onClose={() => setModal(null)} onChanged={refresh} />}
      {modal === 'journal' && <JournalModal accounts={accounts} initialAccountId={accountId} onClose={() => setModal(null)} />}
      {modal === 'backtest' && <BacktestModal onClose={() => setModal(null)} />}
      {modal === 'news' && <NewsModal pairs={symbols.map((s) => s.name)} onClose={() => setModal(null)} onChanged={refresh} />}
      {modal === 'calibration' && <CalibrationModal symbols={symbols.map((s) => s.name)} onClose={() => setModal(null)} onChanged={refresh} />}
    </div>
  );
}
