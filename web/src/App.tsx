import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, hasToken, setToken, UNAUTHORIZED, type Account, type Analysis, type Colors, type AggressiveMode, type Mt4Status, type NewsFeed, type OrderRow, type SymbolItem } from './api.ts';
import { BacktestModal } from './components/BacktestModal.tsx';
import { CalibrationModal } from './components/CalibrationModal.tsx';
import { Chart } from './components/Chart.tsx';
import { ExecuteView } from './components/ExecuteView.tsx';
import { JournalModal } from './components/JournalModal.tsx';
import { NewsModal } from './components/NewsModal.tsx';
import { OrdersPanel } from './components/OrdersPanel.tsx';
import { SignalsModal } from './components/SignalsModal.tsx';
import { PendingModal } from './components/PendingModal.tsx';
import { SettingsModal } from './components/SettingsModal.tsx';
import { ago, fmtDate, fmtMoney, fmtNewsTime, fmtPrice } from './format.ts';
import { engineText, getLang, setLang, useLang, useT } from './i18n.ts';

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

function LangToggle({ className }: { className?: string }) {
  const t = useT();
  const other = getLang() === 'id' ? 'en' : 'id';
  return (
    <button type="button" className={className} title={t('Ganti bahasa ke English', 'Switch language to Indonesian')} onClick={() => setLang(other)}>
      {other.toUpperCase()}
    </button>
  );
}

export function App() {
  useLang();
  const [signedIn, setSignedIn] = useState(hasToken());
  useEffect(() => {
    const out = () => setSignedIn(false);
    window.addEventListener(UNAUTHORIZED, out);
    return () => window.removeEventListener(UNAUTHORIZED, out);
  }, []);
  return signedIn ? <Main onLogout={() => { setToken(null); setSignedIn(false); }} /> : <Login onDone={() => setSignedIn(true)} />;
}

function Login({ onDone }: { onDone: () => void }) {
  const t = useT();
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
          <span>{t('Password', 'Password')}</span>
          <input type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="primary" disabled={busy || !password}>
          {busy ? t('Masuk…', 'Signing in…') : t('Masuk', 'Sign in')}
        </button>
        <LangToggle className="link" />
      </form>
    </main>
  );
}

type ModalKind = 'pending' | 'execute' | 'settings' | 'calibration' | 'journal' | 'news' | 'backtest' | 'signals' | null;

const MT4_STALE_MINUTES = 10;

function Main({ onLogout }: { onLogout: () => void }) {
  const t = useT();
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

  // restore from the orders panel; busyId keeps a second click from firing twice
  const [busyId, setBusyId] = useState<string | null>(null);
  const restore = async (row: OrderRow) => {
    setBusyId(row.id);
    try {
      await api.restore(row.id);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const account = accounts.find((a) => a.id === accountId) ?? null;

  const restoreAll = async () => {
    setBusyId('*');
    try {
      await api.restoreAll(symbol ?? undefined);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
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
    aggressive === 'on'
      ? t(`Aggressive ${mult} semua pair`, `Aggressive ${mult} all pairs`)
      : autoActive
        ? `Aggressive ${mult} auto (${affected.join(', ')})`
        : aggressive === 'off'
          ? t('Aggressive mati', 'Aggressive off')
          : 'Aggressive';
  const aggrTitle = aggrActive
    ? t('Klik untuk mematikan Aggressive selama sesi ini', 'Click to turn Aggressive off for this session')
    : t('Klik untuk menyalakan Aggressive di semua pair', 'Click to turn Aggressive on for all pairs');
  const newsNote =
    aggressive === 'off'
      ? t('Aggressive dimatikan untuk sesi ini.', 'Aggressive is off for this session.')
      : aggressive === 'on'
        ? t('Aggressive manual aktif untuk semua pair.', 'Manual Aggressive is on for all pairs.')
        : autoActive
          ? t('Aggressive aktif untuk pair terkait.', 'Aggressive is on for the related pairs.')
          : account && !account.aggressiveAuto
            ? t('Aggressive otomatis nonaktif untuk akun ini.', 'Automatic Aggressive is off for this account.')
            : '';
  const stale = account && (!account.balanceAt || analysis?.account?.stale);
  const mt4Fresh = !!mt4 && Date.now() - new Date(mt4.lastSeenAt).getTime() < MT4_STALE_MINUTES * 60_000;

  // Execute replaces the whole screen; the main screen's state stays as it was
  if (modal === 'execute') {
    return (
      <ExecuteView
        accounts={accounts}
        initialAccountId={accountId}
        aggressive={aggressive}
        aggrActive={aggrActive}
        aggrLabel={aggrLabel}
        onClose={() => setModal(null)}
        onChanged={refresh}
      />
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
            <rect x="1" y="1" width="20" height="20" rx="5" fill="none" stroke="var(--sr)" strokeWidth="1.5" />
            <path d="M5 14h12M5 8h12" stroke="var(--sr)" strokeWidth="1.5" />
            <path d="M9 4v14" stroke="var(--entry)" strokeWidth="1.5" strokeDasharray="2 2" />
          </svg>
          <span>DavePaul77</span>
        </div>
        <nav className="sections" aria-label={t('Bagian', 'Sections')}>
          <button type="button" aria-current="page">
            {t('Grafik', 'Chart')}
          </button>
          <button type="button" onClick={() => setModal('pending')}>
            Pending Orders
          </button>
          <button type="button" onClick={() => setModal('signals')}>
            {t('Sinyal TF', 'TF signals')}
          </button>
          <button type="button" onClick={() => setModal('news')}>
            {t('Berita', 'News')}
          </button>
          <button type="button" onClick={() => setModal('journal')}>
            {t('Jurnal', 'Journal')}
          </button>
          <button type="button" onClick={() => setModal('backtest')}>
            Backtest
          </button>
          <button type="button" onClick={() => setModal('calibration')}>
            {t('Kalibrasi', 'Calibration')}
          </button>
        </nav>
        <div className="top-actions">
          <button
            type="button"
            className={`aggr-pill${aggrActive ? ' aggr-on' : aggressive === 'off' ? ' aggr-off' : ''}`}
            aria-pressed={aggrActive}
            title={aggrTitle}
            onClick={() => setAggressive(aggrActive ? 'off' : 'on')}
          >
            <span className="pill-dot" aria-hidden="true" />
            <span className="pill-text">{aggrLabel}</span>
          </button>
          <LangToggle className="icon-btn lang" />
          <button type="button" className="icon-btn" aria-label={t('Pengaturan', 'Settings')} title={t('Pengaturan', 'Settings')} onClick={() => setModal('settings')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
            </svg>
          </button>
          <button type="button" className="icon-btn" aria-label={t('Keluar', 'Log out')} title={t('Keluar', 'Log out')} onClick={onLogout}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
            </svg>
          </button>
        </div>
      </header>

      <div className="status-strip tabular">
        <label className="stat">
          <span className="stat-label">{t('Akun', 'Account')}</span>
          <select value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value || null)}>
            {!accounts.length && <option value="">{t('Belum ada akun', 'No accounts yet')}</option>}
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        {account && (
          <>
            <div className="stat">
              <span className="stat-label">Balance</span>
              <span className={`stat-value mono${stale ? ' warn' : ''}`}>
                {fmtMoney(account.balance)} <span className="muted">{account.currency ?? ''}</span>
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">{t('Sinkron', 'Synced')}</span>
              <span className={stale ? 'warn' : ''}>{ago(account.balanceAt)}</span>
            </div>
          </>
        )}
        <div className="status-chips">
          <span
            className={`chip-status${mt4Fresh ? '' : ' warn'}`}
            title={mt4?.brokerOffsetMinutes !== undefined ? `${t('server broker', 'broker server')} UTC${mt4.brokerOffsetMinutes >= 0 ? '+' : ''}${mt4.brokerOffsetMinutes / 60}` : undefined}
          >
            <span className={`pill-dot${mt4Fresh ? ' ok' : ''}`} aria-hidden="true" />
            MT4 {mt4 ? t(`terakhir kirim ${ago(mt4.lastSeenAt)}`, `last sent ${ago(mt4.lastSeenAt)}`) : t('belum pernah kirim data', 'has never sent data')}
            {mt4?.brokerOffsetMinutes !== undefined && ` · UTC${mt4.brokerOffsetMinutes >= 0 ? '+' : ''}${mt4.brokerOffsetMinutes / 60}`}
          </span>
          {analysis && analysis.symbol === symbol && (
            <span className="chip-status muted">
              {t('Candle terakhir', 'Last candle')} <span className="chip-value">{fmtDate(new Date(analysis.lastCandleAt).getTime())}</span>
            </span>
          )}
        </div>
      </div>

      {feed && (feed.news.length > 0 || feed.status.error) && (
        <div className="news" role="status">
          {feed.news.map((n) => (
            <span key={n.id} className={new Date(n.at).getTime() < Date.now() ? 'past' : ''}>
              {n.currency} {fmtNewsTime(n.at)}: {n.title}
            </span>
          ))}
          {feed.news.length > 0 && <span className="news-note">{newsNote}</span>}
          <button type="button" className="news-more" onClick={() => setModal('news')}>
            {t('Semua berita', 'All news')}
          </button>
          {feed.status.error && <span className="error">{t(`Kalender gagal diambil (${feed.status.error}); data terakhir dipakai.`, `Calendar fetch failed (${engineText(feed.status.error)}); last data in use.`)}</span>}
        </div>
      )}
      {error && <div className="error-bar">{error}</div>}

      <div className="desk">
      <nav className="pair-list" ref={tabsRef} aria-label="Pair">
        <div className="pair-list-head" aria-hidden="true">
          <span>Pair</span>
          <span>{t('Kandidat', 'Candidates')}</span>
        </div>
        {symbols.map((s) => (
          <button key={s.name} type="button" className={s.name === symbol ? 'active' : ''} aria-current={s.name === symbol} onClick={() => setSymbol(s.name)}>
            <span className="pair-name">{s.name}</span>
            {newsPairs.has(s.name) && (
              <span className="news-mark" title={t('Ada berita merah untuk mata uang pair ini', 'Red news for this pair\'s currencies')} aria-label={t('berita merah', 'red news')}>
                !
              </span>
            )}
            {s.candidates > 0 && (
              <span className="count" aria-label={t(`${s.candidates} kandidat`, `${s.candidates} candidates`)}>
                {s.candidates}
              </span>
            )}
          </button>
        ))}
      </nav>

      <main className="stage">
        {analysis && analysis.symbol === symbol ? (
          <>
            <div className="chart-bar">
              <div className="chart-title">
                <h1>{analysis.symbol}</h1>
                <span className="tf">D1</span>
                <span className="mono">{fmtPrice(analysis.price, analysis.digits)}</span>
              </div>
              <div className="legend tabular">
                <span>
                  <i className="key key-sr" />
                  S/R · {analysis.lines.length} {t('garis', 'lines')} {analysis.lines[0]?.source === 'manual' ? t('manual', 'manual') : t('mesin', 'engine')}
                  {analysis.referenceLines.length > 0 && analysis.lines[0]?.source !== 'manual' ? t(` (+${analysis.referenceLines.length} referensi Anda)`, ` (+${analysis.referenceLines.length} of your references)`) : ''}
                </span>
                <span>
                  <i className="key key-entry" />
                  Entry
                </span>
                <span>
                  <i className="key key-sltp" />
                  SL / TP
                </span>
              </div>
              <div className="seg" role="group" aria-label={t('Tampilkan order', 'Show orders')}>
                <button type="button" aria-pressed={!onlyFocused} onClick={() => setOnlyFocused(false)}>
                  {t('Semua', 'All')}
                </button>
                <button type="button" aria-pressed={onlyFocused} disabled={!focusId} onClick={() => setOnlyFocused(true)}>
                  {t('Hanya dipilih', 'Selected only')}
                </button>
              </div>
            </div>
            <Chart analysis={analysis} colors={colors} focusId={focusId} onlyFocused={onlyFocused} onFocus={setFocusId} onCancel={cancel} />
          </>
        ) : (
          <div className="empty muted">{symbol ? t('Memuat…', 'Loading…') : t('Belum ada pair aktif. Atur di Pengaturan.', 'No active pairs yet. Set them up in Settings.')}</div>
        )}
      </main>

      {analysis && analysis.symbol === symbol && (
        <OrdersPanel
          symbol={analysis.symbol}
          rows={analysis.rows}
          digits={analysis.digits}
          currency={analysis.account?.currency ?? account?.currency ?? null}
          focusId={focusId}
          busyId={busyId}
          onFocus={setFocusId}
          onCancel={cancel}
          onRestore={restore}
          onRestoreAll={restoreAll}
          onExecute={() => setModal('execute')}
        />
      )}
      </div>

      {modal === 'pending' && <PendingModal account={account} accounts={accounts} aggressive={aggressive} onClose={() => setModal(null)} onChanged={refresh} />}
      {modal === 'signals' && <SignalsModal account={account} aggressive={aggressive} newsPairs={newsPairs} news={feed?.news ?? []} onClose={() => setModal(null)} />}
      {modal === 'settings' && <SettingsModal onClose={() => setModal(null)} onChanged={refresh} />}
      {modal === 'journal' && <JournalModal accounts={accounts} initialAccountId={accountId} onClose={() => setModal(null)} />}
      {modal === 'backtest' && <BacktestModal onClose={() => setModal(null)} />}
      {modal === 'news' && <NewsModal pairs={symbols.map((s) => s.name)} onClose={() => setModal(null)} onChanged={refresh} />}
      {modal === 'calibration' && <CalibrationModal symbols={symbols.map((s) => s.name)} onClose={() => setModal(null)} onChanged={refresh} />}
    </div>
  );
}
