import { useEffect, useState } from 'react';
import { api, type Account, type Settings, type SrParams, type SymbolItem } from '../api.ts';
import { defaultSpreadPips } from '../engine/backtest.ts';
import { pipSize } from '../engine/sr.ts';
import { ago, fmtMoney } from '../format.ts';
import { Modal } from './Modal.tsx';

type Props = { onClose: () => void; onChanged: () => void };
type Tab = 'general' | 'sr' | 'pairs' | 'costs' | 'accounts';

type Field = { key: keyof SrParams; label: string; hint: string; step: number };

// The engine's lines (the default source for orders).
const LINE_FIELDS: Field[] = [
  { key: 'lookback', label: 'Jumlah candle D1', hint: 'Sekitar 2 tahun = 520', step: 1 },
  { key: 'fractal', label: 'Fraktal (candle tiap sisi)', hint: '2 = fraktal 5 candle', step: 1 },
  { key: 'atrPeriod', label: 'Periode ATR', hint: '', step: 1 },
  { key: 'rangeMinBars', label: 'Area ranging: minimal candle', hint: 'Sideways sekurangnya … candle', step: 1 },
  { key: 'rangeMaxAtr', label: 'Area ranging: tinggi maks (x ATR)', hint: 'High–low area ranging', step: 0.1 },
  { key: 'rangeWeight', label: 'Bobot tepi ranging', hint: 'Satu tepi ranging = … swing; 0 = swing saja', step: 1 },
  { key: 'clusterAtr', label: 'Penggabungan area (x ATR)', hint: 'Swing dan tepi ranging berdekatan jadi satu garis', step: 0.05 },
  { key: 'minTouches', label: 'Minimal bobot garis', hint: 'Swing = 1, tepi ranging = bobotnya', step: 1 },
  { key: 'minSpacingAtr', label: 'Jarak min antar garis (x ATR)', hint: 'Lebih dekat: digabung jadi rata-ratanya; 0 = mati', step: 0.05 },
  { key: 'zoneMergeAtr', label: 'Gabung zona sampai (x ATR)', hint: 'Jarak tepi dua garis tanpa body candle di antaranya: jadi satu; 0 = mati', step: 0.05 },
];

// g = jarak garis ke garis berikutnya searah order
const LADDER_FIELDS: Field[] = [
  { key: 'entryGap', label: 'Entry: garis + … x g', hint: 'Dari order Anda: 0,22', step: 0.01 },
  { key: 'slGap', label: 'SL: garis − … x g', hint: 'Seberang garis yang sama. Dari order Anda: 0,16', step: 0.01 },
  { key: 'tpGap', label: 'TP: garis berikutnya − … x g', hint: 'Dari order Anda: 0,07', step: 0.01 },
  { key: 'minDistanceAtr', label: 'Lewati garis lebih dekat dari … x ATR ke harga', hint: '', step: 0.05 },
  { key: 'maxLinesPerSide', label: 'Garis berorder per sisi', hint: 'Garis terdekat dari harga; 0 = semua', step: 1 },
  { key: 'autoTpRr', label: 'RR TP di garis terakhir', hint: 'Tidak ada garis berikutnya', step: 0.1 },
];

// SL from the nearest strong D1 candle on the SL side of the line (ladder model option)
const CANDLE_SL_FIELDS: Field[] = [
  { key: 'strongBodyPct', label: 'Candle SL: body / range', hint: '0,6 = 60%', step: 0.05 },
  { key: 'slStrongAtr', label: 'Candle SL: body minimal (x ATR)', hint: '', step: 0.05 },
  { key: 'strongMaxDistanceAtr', label: 'Candle SL: jarak maks high/low ke garis (x ATR)', hint: '', step: 0.1 },
  { key: 'bufferAtr', label: 'Buffer di luar low/high (x ATR)', hint: '0,1 = 10% ATR', step: 0.01 },
  { key: 'slMaxRiskAtr', label: 'Risk maks entry–SL (x ATR)', hint: 'Lebih lebar: pakai SL tangga', step: 0.1 },
];

const STRONG_FIELDS: Field[] = [
  { key: 'strongBodyPct', label: 'Candle kuat: body / range', hint: '0,6 = 60%', step: 0.05 },
  { key: 'strongAtr', label: 'Candle kuat: body / ATR', hint: '', step: 0.05 },
  { key: 'strongMaxDistanceAtr', label: 'Candle kuat: jarak maks dari garis (x ATR)', hint: '', step: 0.1 },
  { key: 'wickRatio', label: 'Pantulan: wick / range', hint: 'Wick penolakan', step: 0.05 },
  { key: 'reboundMaxDistanceAtr', label: 'Pantulan: jarak maks dari garis (x ATR)', hint: '', step: 0.1 },
  { key: 'bufferAtr', label: 'Buffer entry/SL (x ATR)', hint: '0,1 = 10% ATR', step: 0.01 },
  { key: 'autoTpRr', label: 'RR untuk TP auto (ATH/ATL)', hint: '', step: 0.1 },
  { key: 'maxLinesPerSide', label: 'Maks garis berorder per sisi', hint: '0 = semua garis', step: 1 },
];

const SOURCE: Record<string, string> = { mt4: 'dari chart MT4', import: 'dari template', web: 'dari web' };

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
      await api.saveSymbols(list.map((s) => ({ name: s.name, active: s.active, minSlPips: s.minSlPips })));
      setSymbols((await api.symbols()).symbols);
    }, 'Daftar pair disimpan.');

  // only the costs: they are for the backtest and need no new analysis
  const saveCosts = () =>
    run(async () => {
      const c = settings!.costs;
      // a value equal to the default is not stored, so a later default change reaches it
      const digits = new Map(symbols.map((s) => [s.name, s.digits]));
      const spreadPips = Object.fromEntries(
        Object.entries(c.spreadPips).filter(([k, v]) => Number.isFinite(v) && v >= 0 && v !== defaultSpreadPips(k, digits.get(k) ?? 5)),
      );
      setSettings(await api.saveSettings({ costs: { ...c, slippagePips: Number.isFinite(c.slippagePips) ? c.slippagePips : 0, commissionPerLot: Number.isFinite(c.commissionPerLot) ? c.commissionPerLot : 0, spreadPips } }));
    }, 'Biaya backtest disimpan. Buka Backtest untuk melihat hasil net.');

  const importTemplates = (files: FileList | null) => {
    if (!files?.length) return;
    void run(async () => {
      const payload = await Promise.all([...files].map(async (f) => ({ name: f.name, content: await f.text() })));
      const { results } = await api.importTpl(payload);
      setSymbols((await api.symbols()).symbols);
      const ok = results.filter((r) => !r.error);
      const bad = results.filter((r) => r.error);
      if (bad.length) setError(bad.map((r) => `${r.file}: ${r.error}`).join(' · '));
      return ok;
    }, `Garis diimport dari ${files.length} template.`);
  };

  const useAuto = (name: string) =>
    run(async () => {
      await api.setLines(name, []);
      setSymbols((await api.symbols()).symbols);
    }, `Garis referensi ${name} dihapus.`);

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
            ['costs', 'Biaya backtest'],
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
            <label className="field">
              <span>Model order</span>
              <select value={settings.sr.orderModel} onChange={(e) => setSr({ orderModel: e.target.value as SrParams['orderModel'] })}>
                <option value="ladder">Tangga (dari history order Anda)</option>
                <option value="strong">Candle kuat + pantulan (konsep awal)</option>
              </select>
            </label>
          </div>
          <h3>{settings.sr.orderModel === 'ladder' ? 'Model tangga' : 'Model candle kuat'}</h3>
          {settings.sr.orderModel === 'ladder' && (
            <>
              <p className="muted">g = jarak garis ke garis berikutnya searah order. Entry dan TP dari 3.648 order Anda di September terhadap garis Anda sendiri.</p>
              <div className="grid">
                <label className="field">
                  <span>Sumber SL</span>
                  <select value={settings.sr.slSource} onChange={(e) => setSr({ slSource: e.target.value as SrParams['slSource'] })}>
                    <option value="ladder">Tangga: garis − slGap·g (sesuai history Anda)</option>
                    <option value="candle">Candle kuat D1 terdekat di sisi SL garis, dibatasi</option>
                  </select>
                  <small className="muted">Candle: SL di low/high candle kuat terdekat ± buffer; jika lebih lebar dari batas risk, jatuh ke SL tangga (ditandai).</small>
                </label>
              </div>
            </>
          )}
          <div className="grid">
            {(settings.sr.orderModel === 'ladder' ? [...LADDER_FIELDS, ...(settings.sr.slSource === 'candle' ? CANDLE_SL_FIELDS : [])] : STRONG_FIELDS).map((f) => (
              <NumberField key={f.key} label={f.label} hint={f.hint} step={f.step} value={settings.sr[f.key] as number} onChange={(v) => setSr({ [f.key]: v })} />
            ))}
            {settings.sr.orderModel === 'strong' && (
              <label className="field">
                <span>Pilihan candle kuat</span>
                <select value={settings.sr.strongPick} onChange={(e) => setSr({ strongPick: e.target.value as SrParams['strongPick'] })}>
                  <option value="recent">Paling baru</option>
                  <option value="nearest">Paling dekat garis</option>
                </select>
              </label>
            )}
          </div>
          <h3>Garis S/R</h3>
          <p className="muted">
            Garis Anda (Pengaturan &gt; Pair) hanya referensi: tampil samar di chart dan dipakai di Kalibrasi &gt; Garis untuk menyetel
            mesin.
          </p>
          <div className="grid">
            <label className="field">
              <span>Garis untuk order</span>
              <select value={settings.sr.lineSource} onChange={(e) => setSr({ lineSource: e.target.value as SrParams['lineSource'] })}>
                <option value="auto">Mesin (garis Anda hanya referensi)</option>
                <option value="manual">Garis Anda, mesin untuk pair tanpa garis</option>
              </select>
            </label>
            {LINE_FIELDS.map((f) => (
              <NumberField key={f.key} label={f.label} hint={f.hint} step={f.step} value={settings.sr[f.key] as number} onChange={(v) => setSr({ [f.key]: v })} />
            ))}
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
          <p className="muted">
            Urutan = urutan tab di bawah chart. Garis S/R manual dikirim otomatis oleh EA MT4 dari garis horizontal di chart pair itu, atau
            diimport dari template chart (.tpl). Garis Anda adalah referensi untuk menyetel mesin; order memakai garis mesin.
          </p>
          <label className="field import-tpl">
            <span>Import garis dari template MT4/MT5 (.tpl, boleh banyak file)</span>
            <input type="file" accept=".tpl" multiple onChange={(e) => importTemplates(e.target.files)} />
          </label>
          <ul className="pairs">
            {symbols.map((s, i) => (
              <li key={s.name}>
                <label className="check">
                  <input type="checkbox" checked={s.active} onChange={(e) => setSymbols(symbols.map((x) => (x.name === s.name ? { ...x, active: e.target.checked } : x)))} />
                  {s.name}
                </label>
                <span className="muted tabular">
                  {s.manualLines ? (
                    <span className="lines-manual">
                      {s.manualLines} garis referensi {SOURCE[s.manualLinesSource ?? ''] ?? ''} · {ago(s.manualLinesAt)}
                    </span>
                  ) : (
                    'tanpa referensi'
                  )}
                  {' · '}
                  {s.lastCandleAt ? `candle ${ago(s.lastCandleAt)}` : 'belum ada candle'}
                </span>
                <label className="min-sl">
                  <span className="muted">SL min</span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={s.minSlPips}
                    aria-label={`SL minimal ${s.name} dalam pips`}
                    onChange={(e) => setSymbols(symbols.map((x) => (x.name === s.name ? { ...x, minSlPips: e.target.valueAsNumber } : x)))}
                  />
                  <span className="muted">pips</span>
                </label>
                {s.manualLines ? (
                  <button type="button" className="link" onClick={() => useAuto(s.name)}>
                    Hapus referensi
                  </button>
                ) : (
                  <span />
                )}
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
                if (!symbols.some((s) => s.name === name)) setSymbols([
                    ...symbols,
                    { name, active: true, order: symbols.length, digits: 5, candidates: 0, lastCandleAt: null, manualLines: 0, manualLinesAt: null, manualLinesSource: null, minSlPips: 15 },
                  ]);
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

      {tab === 'costs' && (
        <div className="form">
          <p className="muted">
            Hanya untuk backtest. Candle D1 adalah harga bid, jadi hasil mentah (gross) belum membayar spread. Net = tiap trade dikurangi spread + komisi + slippage dalam pips, dan
            dalam R sebesar biaya / jarak SL trade itu. Default = spread "mulai dari" akun Maxrich Premium (terendah yang dikutip broker, jadi rata-rata nyata
            sedikit lebih lebar) dan komisi USD 10 per lot; ganti dengan angka akun Anda bila tahu. Tidak mengubah order live.
          </p>
          <div className="grid">
            <label className="check">
              <input type="checkbox" checked={settings.costs.enabled} onChange={(e) => set({ costs: { ...settings.costs, enabled: e.target.checked } })} /> Hitung spread, komisi, dan slippage
              (hasil net)
            </label>
            <NumberField
              label="Komisi per lot (USD)"
              hint="Pulang-pergi (buka + tutup), diubah ke pips lewat nilai pip pair; 0 = tanpa komisi"
              step={1}
              value={settings.costs.commissionPerLot}
              onChange={(v) => set({ costs: { ...settings.costs, commissionPerLot: v } })}
            />
            <NumberField
              label="Slippage per trade (pips)"
              hint="Tambahan untuk semua pair; 0 = tanpa slippage"
              step={0.1}
              value={settings.costs.slippagePips}
              onChange={(v) => set({ costs: { ...settings.costs, slippagePips: v } })}
            />
          </div>
          <table className="orders tabular spreads">
            <thead>
              <tr>
                <th>Pair</th>
                <th className="num">Spread (pips)</th>
                <th className="num">= harga</th>
                <th className="num">Default</th>
              </tr>
            </thead>
            <tbody>
              {symbols.map((s) => {
                const def = defaultSpreadPips(s.name, s.digits);
                const v = settings.costs.spreadPips[s.name] ?? def;
                return (
                  <tr key={s.name} className={s.active ? '' : 'off'}>
                    <td>
                      <b>{s.name}</b>
                      {!s.active && <span className="muted"> (nonaktif)</span>}
                    </td>
                    <td className="num">
                      <input
                        type="number"
                        min={0}
                        step={0.1}
                        value={Number.isFinite(v) ? v : ''}
                        aria-label={`Spread ${s.name} dalam pips`}
                        onChange={(e) => set({ costs: { ...settings.costs, spreadPips: { ...settings.costs.spreadPips, [s.name]: e.target.valueAsNumber } } })}
                      />
                    </td>
                    <td className="num muted">{Number.isFinite(v) ? (v * pipSize(s.digits)).toFixed(Math.max(s.digits, 2)) : '–'}</td>
                    <td className="num muted">{def}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted">1 pip = 0,0001 (0,01 untuk pair JPY); XAUUSD 1 pip = 10 × digit terakhir, default spreadnya $0,30.</p>
          <div className="actions">
            <button type="button" onClick={() => set({ costs: { ...settings.costs, spreadPips: {} } })}>
              Kembalikan default
            </button>
            <button type="button" className="primary" onClick={saveCosts}>
              Simpan biaya
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
