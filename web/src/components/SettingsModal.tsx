import { useEffect, useState } from 'react';
import { api, type Account, type Settings, type SrParams, type SymbolItem } from '../api.ts';
import { ago, fmtMoney } from '../format.ts';
import { Modal } from './Modal.tsx';

type Props = { onClose: () => void; onChanged: () => void };
type Tab = 'general' | 'sr' | 'pairs' | 'accounts';

const SR_FIELDS: { key: keyof SrParams; label: string; hint: string; step: number }[] = [
  { key: 'lookback', label: 'Jumlah candle D1', hint: 'Sekitar 2 tahun = 520', step: 1 },
  { key: 'fractal', label: 'Fraktal (candle tiap sisi)', hint: '2 = fraktal 5 candle', step: 1 },
  { key: 'atrPeriod', label: 'Periode ATR', hint: '', step: 1 },
  { key: 'clusterAtr', label: 'Penggabungan area (x ATR)', hint: 'Swing berdekatan jadi satu garis', step: 0.05 },
  { key: 'minTouches', label: 'Minimal sentuhan', hint: 'Swing per garis', step: 1 },
  { key: 'strongBodyPct', label: 'Candle kuat: body / range', hint: '0,6 = 60%', step: 0.05 },
  { key: 'strongAtr', label: 'Candle kuat: body / ATR', hint: '', step: 0.05 },
  { key: 'strongMaxDistanceAtr', label: 'Candle kuat: jarak maks dari garis (x ATR)', hint: '', step: 0.1 },
  { key: 'wickRatio', label: 'Pantulan: wick / range', hint: 'Wick penolakan', step: 0.05 },
  { key: 'reboundMaxDistanceAtr', label: 'Pantulan: jarak maks dari garis (x ATR)', hint: '', step: 0.1 },
  { key: 'bufferAtr', label: 'Buffer entry/SL (x ATR)', hint: '0,1 = 10% ATR', step: 0.01 },
  { key: 'autoTpRr', label: 'RR untuk TP auto (ATH/ATL)', hint: '', step: 0.1 },
  { key: 'maxLinesPerSide', label: 'Maks garis berorder per sisi', hint: '0 = semua garis', step: 1 },
];

const parsePairs = (text: string, num: boolean) => {
  const out: Record<string, string | number> = {};
  for (const line of text.split('\n')) {
    const [k, v] = line.split('=').map((s) => s.trim());
    if (!k || v === undefined || v === '') continue;
    out[k.toUpperCase()] = num ? Number(v) : v;
  }
  return out;
};
const pairsText = (rec: Record<string, string | number>) => Object.entries(rec).map(([k, v]) => `${k}=${v}`).join('\n');

function NumberField({ label, hint, value, step, onChange }: { label: string; hint?: string; value: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type="number" step={step} value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(e.target.valueAsNumber)} />
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

export function SettingsModal({ onClose, onChanged }: Props) {
  const [tab, setTab] = useState<Tab>('general');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [symbols, setSymbols] = useState<SymbolItem[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [newPair, setNewPair] = useState('');
  const [shownKey, setShownKey] = useState<{ name: string; key: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadAll = async () => {
    try {
      const [s, sy, ac] = await Promise.all([api.settings(), api.symbols(), api.accounts()]);
      setSettings(s);
      setSymbols(sy.symbols);
      setAccounts(ac.accounts);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void loadAll();
  }, []);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setError(null);
    setMessage(null);
    try {
      await fn();
      setMessage(done);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const saveSettings = () =>
    run(async () => {
      const { version: _v, ...rest } = settings!;
      setSettings(await api.saveSettings(rest));
    }, 'Pengaturan disimpan. Analisa semua pair dihitung ulang.');

  const savePairs = (list: SymbolItem[]) =>
    run(async () => {
      await api.saveSymbols(list.map((s) => ({ name: s.name, active: s.active })));
      setSymbols((await api.symbols()).symbols);
    }, 'Daftar pair disimpan.');

  const move = (i: number, d: -1 | 1) => {
    const list = [...symbols];
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j]!, list[i]!];
    setSymbols(list);
  };

  if (!settings) return <Modal title="Pengaturan" onClose={onClose}>{error ? <p className="error">{error}</p> : <p className="muted">Memuat…</p>}</Modal>;
  const set = (patch: Partial<Settings>) => setSettings({ ...settings, ...patch });
  const setSr = (patch: Partial<SrParams>) => setSettings({ ...settings, sr: { ...settings.sr, ...patch } });

  return (
    <Modal title="Pengaturan" onClose={onClose} wide>
      <div className="seg" role="tablist">
        {(
          [
            ['general', 'Umum'],
            ['sr', 'Analisa S/R'],
            ['pairs', 'Pair'],
            ['accounts', 'Akun MT5'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {message && <p className="ok">{message}</p>}
      {error && <p className="error">{error}</p>}

      {tab === 'general' && (
        <div className="form">
          <div className="grid">
            <NumberField label="Ambang RR rendah" hint="Baris di bawah ini ditandai kuning" step={0.1} value={settings.rrThreshold} onChange={(v) => set({ rrThreshold: v })} />
            <NumberField label="Jendela berita (jam)" step={1} value={settings.newsWindowHours} onChange={(v) => set({ newsWindowHours: v })} />
            <NumberField label="Masa berlaku perintah (jam)" step={1} value={settings.commandTtlHours} onChange={(v) => set({ commandTtlHours: v })} />
            <NumberField label="Balance dianggap lama (menit)" step={1} value={settings.balanceStaleMinutes} onChange={(v) => set({ balanceStaleMinutes: v })} />
            <NumberField label="Umur maks harga bid/ask (menit)" step={1} value={settings.quoteMaxAgeMinutes} onChange={(v) => set({ quoteMaxAgeMinutes: v })} />
          </div>
          <h3>Warna garis</h3>
          <div className="grid">
            {(
              [
                ['sr', 'S/R'],
                ['entry', 'Entry'],
                ['sltp', 'SL / TP'],
              ] as const
            ).map(([k, label]) => (
              <label key={k} className="field color">
                <span>{label}</span>
                <input type="color" value={settings.colors[k]} onChange={(e) => set({ colors: { ...settings.colors, [k]: e.target.value } })} />
              </label>
            ))}
          </div>
          <div className="actions">
            <button type="button" className="primary" onClick={saveSettings}>
              Simpan
            </button>
          </div>
        </div>
      )}

      {tab === 'sr' && (
        <div className="form">
          <p className="muted">Semua aturan dihitung di D1 dengan candle yang sudah close. Simpan akan menghitung ulang semua pair.</p>
          <div className="grid">
            {SR_FIELDS.map((f) => (
              <NumberField key={f.key} label={f.label} hint={f.hint} step={f.step} value={settings.sr[f.key] as number} onChange={(v) => setSr({ [f.key]: v })} />
            ))}
            <label className="field">
              <span>Pilihan candle kuat</span>
              <select value={settings.sr.strongPick} onChange={(e) => setSr({ strongPick: e.target.value as SrParams['strongPick'] })}>
                <option value="recent">Paling baru</option>
                <option value="nearest">Paling dekat garis</option>
              </select>
            </label>
          </div>
          <div className="actions">
            <button type="button" className="primary" onClick={saveSettings}>
              Simpan dan hitung ulang
            </button>
          </div>
        </div>
      )}

      {tab === 'pairs' && (
        <div className="form">
          <p className="muted">Urutan = urutan tab di bawah chart. Pair harus ada di Market Watch MT4 dengan histori D1 terunduh.</p>
          <ul className="pairs">
            {symbols.map((s, i) => (
              <li key={s.name}>
                <label className="check">
                  <input type="checkbox" checked={s.active} onChange={(e) => setSymbols(symbols.map((x) => (x.name === s.name ? { ...x, active: e.target.checked } : x)))} />
                  {s.name}
                </label>
                <span className="muted tabular">{s.lastCandleAt ? `candle terakhir ${ago(s.lastCandleAt)}` : 'belum ada candle'}</span>
                <button type="button" className="icon" aria-label={`Naikkan ${s.name}`} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button type="button" className="icon" aria-label={`Turunkan ${s.name}`} onClick={() => move(i, 1)}>
                  ↓
                </button>
              </li>
            ))}
          </ul>
          <div className="inline">
            <input placeholder="Tambah pair, mis. GBPUSD" value={newPair} onChange={(e) => setNewPair(e.target.value.toUpperCase())} />
            <button
              type="button"
              disabled={!newPair.trim()}
              onClick={() => {
                const name = newPair.trim();
                if (!symbols.some((s) => s.name === name)) setSymbols([...symbols, { name, active: true, order: symbols.length, digits: 5, candidates: 0, lastCandleAt: null }]);
                setNewPair('');
              }}
            >
              Tambah
            </button>
          </div>
          <div className="actions">
            <button type="button" className="primary" onClick={() => savePairs(symbols)}>
              Simpan daftar pair
            </button>
          </div>
        </div>
      )}

      {tab === 'accounts' && (
        <div className="form">
          {shownKey && (
            <div className="key-box">
              <p>
                Key EA untuk <b>{shownKey.name}</b>. Salin ke parameter EA MT5 sekarang: key ini tidak ditampilkan lagi.
              </p>
              <code>{shownKey.key}</code>
            </div>
          )}
          {accounts.map((a) => (
            <AccountEditor
              key={a.id}
              account={a}
              onSave={(patch) => run(async () => setAccounts((await Promise.all([api.updateAccount(a.id, patch), api.accounts()]))[1].accounts), `${a.name} disimpan.`)}
              onRotate={() =>
                run(async () => {
                  const { key } = await api.rotateKey(a.id);
                  setShownKey({ name: a.name, key });
                }, 'Key baru dibuat. Key lama tidak berlaku lagi.')
              }
              onDelete={() => {
                if (!window.confirm(`Hapus akun ${a.name}? Perintah yang menunggu ikut dibatalkan.`)) return;
                void run(async () => {
                  await api.deleteAccount(a.id);
                  setAccounts((await api.accounts()).accounts);
                }, `${a.name} dihapus.`);
              }}
            />
          ))}
          <NewAccount
            onCreate={(input) =>
              run(async () => {
                const { account, key } = await api.createAccount(input);
                setShownKey({ name: account.name, key });
                setAccounts((await api.accounts()).accounts);
              }, 'Akun ditambahkan.')
            }
          />
        </div>
      )}
    </Modal>
  );
}

function AccountEditor({ account, onSave, onRotate, onDelete }: { account: Account; onSave: (p: Partial<Account>) => void; onRotate: () => void; onDelete: () => void }) {
  const [a, setA] = useState(account);
  const [map, setMap] = useState(pairsText(account.symbolMap));
  const [offsets, setOffsets] = useState(pairsText(account.offsets));
  return (
    <details className="account">
      <summary>
        <b>{account.name}</b> <span className="muted tabular">{account.number}</span>
        <span className="tabular">
          {' '}· balance {fmtMoney(account.balance)} {account.currency ?? ''} · sinkron {ago(account.balanceAt)} · {account.specSymbols.length} spesifikasi simbol
        </span>
      </summary>
      <div className="grid">
        <label className="field">
          <span>Nama</span>
          <input value={a.name} onChange={(e) => setA({ ...a, name: e.target.value })} />
        </label>
        <NumberField label="Nomor akun MT5" step={1} value={a.number} onChange={(v) => setA({ ...a, number: v })} />
        <NumberField label="Risk per trade (%)" step={0.05} value={a.riskPct} onChange={(v) => setA({ ...a, riskPct: v })} />
        <NumberField label="Pengali Aggressive" step={0.5} value={a.aggressiveMultiplier} onChange={(v) => setA({ ...a, aggressiveMultiplier: v })} />
        <label className="check">
          <input type="checkbox" checked={a.aggressiveAuto} onChange={(e) => setA({ ...a, aggressiveAuto: e.target.checked })} /> Aggressive otomatis saat berita merah
        </label>
      </div>
      <div className="grid two">
        <label className="field">
          <span>Mapping simbol (satu per baris)</span>
          <textarea rows={4} placeholder="EURUSD=EURUSD.m" value={map} onChange={(e) => setMap(e.target.value)} />
        </label>
        <label className="field">
          <span>Offset harga MT4 ke MT5</span>
          <textarea rows={4} placeholder="EURUSD=0.00002" value={offsets} onChange={(e) => setOffsets(e.target.value)} />
        </label>
      </div>
      <div className="actions">
        <button type="button" className="danger" onClick={onDelete}>
          Hapus
        </button>
        <button type="button" onClick={onRotate}>
          Buat key EA baru
        </button>
        <button
          type="button"
          className="primary"
          onClick={() =>
            onSave({
              name: a.name,
              number: a.number,
              riskPct: a.riskPct,
              aggressiveMultiplier: a.aggressiveMultiplier,
              aggressiveAuto: a.aggressiveAuto,
              symbolMap: parsePairs(map, false) as Record<string, string>,
              offsets: parsePairs(offsets, true) as Record<string, number>,
            })
          }
        >
          Simpan
        </button>
      </div>
    </details>
  );
}

function NewAccount({ onCreate }: { onCreate: (a: Partial<Account>) => void }) {
  const [name, setName] = useState('');
  const [number, setNumber] = useState(NaN);
  return (
    <div className="inline new-account">
      <input placeholder="Nama akun" value={name} onChange={(e) => setName(e.target.value)} />
      <input type="number" placeholder="Nomor akun MT5" value={Number.isFinite(number) ? number : ''} onChange={(e) => setNumber(e.target.valueAsNumber)} />
      <button
        type="button"
        disabled={!name.trim() || !Number.isFinite(number)}
        onClick={() => {
          onCreate({ name: name.trim(), number });
          setName('');
          setNumber(NaN);
        }}
      >
        Tambah akun
      </button>
    </div>
  );
}
