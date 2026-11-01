import { useEffect, useState } from 'react';
import { api, type Account, type Settings, type SrParams, type SymbolItem } from '../api.ts';
import { defaultSpreadPips } from '../engine/backtest.ts';
import { pipSize } from '../engine/sr.ts';
import { ago, fmtMoney } from '../format.ts';
import { setLang, tr, useLang, useT } from '../i18n.ts';
import { Modal } from './Modal.tsx';

type Props = { onClose: () => void; onChanged: () => void };
type Tab = 'general' | 'sr' | 'pairs' | 'costs' | 'accounts';

type Field = { key: keyof SrParams; label: string; hint: string; step: number };

// g = distance from the line to the next line in the order direction
const ladderFields = (): Field[] => [
  { key: 'entryGap', label: tr('Entry: garis + … x g', 'Entry: line + … x g'), hint: tr('Dari order Anda: 0,22', 'From your orders: 0.22'), step: 0.01 },
  { key: 'slGap', label: tr('SL: garis − … x g', 'SL: line − … x g'), hint: tr('Seberang garis yang sama. Dari order Anda: 0,16', 'Opposite side of the same line. From your orders: 0.16'), step: 0.01 },
  { key: 'tpGap', label: tr('TP: garis berikutnya − … x g', 'TP: next line − … x g'), hint: tr('Dari order Anda: 0,07', 'From your orders: 0.07'), step: 0.01 },
  { key: 'minDistanceAtr', label: tr('Lewati order dengan entry lebih dekat dari … x ATR ke harga', 'Skip orders whose entry is closer than … x ATR to price'), hint: '', step: 0.05 },
  { key: 'maxLinesPerSide', label: tr('Garis berorder per sisi', 'Lines with orders per side'), hint: tr('Garis terdekat dari harga; 0 = semua', 'Lines nearest to price; 0 = all'), step: 1 },
  { key: 'autoTpRr', label: tr('RR TP di garis terakhir', 'RR for TP at the last line'), hint: tr('Tidak ada garis berikutnya', 'There is no next line'), step: 0.1 },
];

// SL from the nearest strong D1 candle on the SL side of the line (ladder model option)
const candleSlFields = (): Field[] => [
  { key: 'strongBodyPct', label: tr('Candle SL: body / range', 'SL candle: body / range'), hint: tr('0,6 = 60%', '0.6 = 60%'), step: 0.05 },
  { key: 'slStrongAtr', label: tr('Candle SL: body minimal (x ATR)', 'SL candle: min body (x ATR)'), hint: '', step: 0.05 },
  { key: 'strongMaxDistanceAtr', label: tr('Candle SL: jarak maks high/low ke garis (x ATR)', 'SL candle: max high/low distance to the line (x ATR)'), hint: '', step: 0.1 },
  { key: 'bufferAtr', label: tr('Buffer di luar low/high (x ATR)', 'Buffer beyond low/high (x ATR)'), hint: tr('0,1 = 10% ATR', '0.1 = 10% ATR'), step: 0.01 },
  { key: 'slMaxRiskAtr', label: tr('Risk maks entry–SL (x ATR)', 'Max entry–SL risk (x ATR)'), hint: tr('Lebih lebar: pakai SL tangga', 'Wider: use the ladder SL'), step: 0.1 },
];

const sourceLabel = (src: string): string => {
  const m: Record<string, string> = { mt4: tr('dari chart MT4', 'from MT4 chart'), import: tr('dari template', 'from template'), web: tr('dari web', 'from web') };
  return m[src] ?? '';
};

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
  const t = useT();
  const lang = useLang();
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
    }, t('Pengaturan disimpan. Analisa semua pair dihitung ulang.', 'Settings saved. All pairs are being re-analysed.'));

  const savePairs = (list: SymbolItem[]) =>
    run(async () => {
      await api.saveSymbols(list.map((s) => ({ name: s.name, active: s.active, minSlPips: s.minSlPips })));
      setSymbols((await api.symbols()).symbols);
    }, t('Daftar pair disimpan.', 'Pair list saved.'));

  // only the costs: they are for the backtest and need no new analysis
  const saveCosts = () =>
    run(async () => {
      const c = settings!.costs;
      // a value equal to the default is not stored, so a later default change reaches it
      const digits = new Map(symbols.map((s) => [s.name, s.digits]));
      const spreadPips = Object.fromEntries(
        Object.entries(c.spreadPips).filter(([k, v]) => Number.isFinite(v) && v >= 0 && v !== defaultSpreadPips(k, digits.get(k) ?? 5)),
      );
      setSettings(await api.saveSettings({ costs: { ...c, slippagePips: Number.isFinite(c.slippagePips) ? c.slippagePips : 0, commissionPerLot: Number.isFinite(c.commissionPerLot) ? c.commissionPerLot : 0, maxCostR: Number.isFinite(c.maxCostR) ? c.maxCostR : 0, spreadPips } }));
    }, t('Biaya backtest disimpan. Buka Backtest untuk melihat hasil net.', 'Backtest costs saved. Open Backtest to see the net result.'));

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
    }, t(`Garis diimport dari ${files.length} template.`, `Lines imported from ${files.length} template(s).`));
  };

  const useAuto = (name: string) =>
    run(async () => {
      await api.setLines(name, []);
      setSymbols((await api.symbols()).symbols);
    }, t(`Garis referensi ${name} dihapus.`, `Reference lines for ${name} removed.`));

  const move = (i: number, d: -1 | 1) => {
    const list = [...symbols];
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j]!, list[i]!];
    setSymbols(list);
  };

  if (!settings) return <Modal title={t('Pengaturan', 'Settings')} onClose={onClose}>{error ? <p className="error">{error}</p> : <p className="muted">{t('Memuat…', 'Loading…')}</p>}</Modal>;
  const set = (patch: Partial<Settings>) => setSettings({ ...settings, ...patch });
  const setSr = (patch: Partial<SrParams>) => setSettings({ ...settings, sr: { ...settings.sr, ...patch } });

  return (
    <Modal title={t('Pengaturan', 'Settings')} onClose={onClose} wide>
      <div className="seg" role="tablist">
        {(
          [
            ['general', t('Umum', 'General')],
            ['sr', t('Strategi', 'Strategy')],
            ['pairs', 'Pair'],
            ['costs', t('Biaya backtest', 'Backtest costs')],
            ['accounts', t('Akun MT5', 'MT5 accounts')],
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
          <div className="field">
            <span>{t('Bahasa', 'Language')}</span>
            <div className="seg">
              <button type="button" aria-pressed={lang === 'id'} onClick={() => setLang('id')}>
                Bahasa Indonesia
              </button>
              <button type="button" aria-pressed={lang === 'en'} onClick={() => setLang('en')}>
                English
              </button>
            </div>
          </div>
          <div className="grid">
            <NumberField label={t('Ambang RR rendah', 'Low RR threshold')} hint={t('Baris di bawah ini ditandai kuning', 'Rows below this are marked yellow')} step={0.1} value={settings.rrThreshold} onChange={(v) => set({ rrThreshold: v })} />
            <NumberField label={t('Jendela berita (jam)', 'News window (hours)')} step={1} value={settings.newsWindowHours} onChange={(v) => set({ newsWindowHours: v })} />
            <NumberField label={t('Masa berlaku perintah (jam)', 'Command validity (hours)')} step={1} value={settings.commandTtlHours} onChange={(v) => set({ commandTtlHours: v })} />
            <NumberField label={t('Balance dianggap lama (menit)', 'Balance considered stale (minutes)')} step={1} value={settings.balanceStaleMinutes} onChange={(v) => set({ balanceStaleMinutes: v })} />
            <NumberField label={t('Umur maks harga bid/ask (menit)', 'Max bid/ask price age (minutes)')} step={1} value={settings.quoteMaxAgeMinutes} onChange={(v) => set({ quoteMaxAgeMinutes: v })} />
          </div>
          <h3>{t('Warna garis', 'Line colours')}</h3>
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
              {t('Simpan', 'Save')}
            </button>
          </div>
        </div>
      )}

      {tab === 'sr' && (
        <div className="form">
          <p className="muted">{t('Semua aturan dihitung di D1 dengan candle yang sudah close. Simpan akan menghitung ulang semua pair.', 'All rules are computed on D1 using closed candles. Saving re-analyses all pairs.')}</p>
          <h3>Breakout JohnPaul77</h3>
          <p className="muted">{t('g = jarak garis ke garis berikutnya searah order. Entry dan TP dari 3.648 order Anda di September terhadap garis Anda sendiri.', 'g = distance from the line to the next line in the order direction. Entry and TP come from your 3,648 orders in September against your own lines.')}</p>
          <div className="grid">
            <label className="field">
              <span>{t('Sumber SL', 'SL source')}</span>
              <select value={settings.sr.slSource} onChange={(e) => setSr({ slSource: e.target.value as SrParams['slSource'] })}>
                <option value="ladder">{t('Tangga: garis − slGap·g (sesuai history Anda)', 'Ladder: line − slGap·g (matches your history)')}</option>
                <option value="candle">{t('Candle kuat D1 terdekat di sisi SL garis, dibatasi', 'Nearest strong D1 candle on the SL side of the line, capped')}</option>
              </select>
              <small className="muted">{t('Candle: SL di low/high candle kuat terdekat ± buffer; jika lebih lebar dari batas risk, jatuh ke SL tangga (ditandai).', 'Candle: SL at the low/high of the nearest strong candle ± buffer; if wider than the risk cap, it falls back to the ladder SL (marked).')}</small>
            </label>
          </div>
          <div className="grid">
            {[...ladderFields(), ...(settings.sr.slSource === 'candle' ? candleSlFields() : [])].map((f) => (
              <NumberField key={f.key} label={f.label} hint={f.hint} step={f.step} value={settings.sr[f.key] as number} onChange={(v) => setSr({ [f.key]: v })} />
            ))}
          </div>
          <h3>{t('Garis S/R', 'S/R lines')}</h3>
          <p className="muted">
            {t(
              'Garis S/R dikunci di engine dan tidak bisa diubah dari sini. Garis Anda (Pengaturan > Pair) hanya referensi: tampil samar di chart dan dibandingkan di Kalibrasi > Garis.',
              'S/R lines are fixed in the engine and cannot be changed here. Your lines (Settings > Pair) are reference only: shown faintly on the chart and compared in Calibration > Lines.',
            )}
          </p>
          <div className="actions">
            <button type="button" className="primary" onClick={saveSettings}>
              {t('Simpan dan hitung ulang', 'Save and recalculate')}
            </button>
          </div>
        </div>
      )}

      {tab === 'pairs' && (
        <div className="form">
          <p className="muted">
            {t(
              'Urutan = urutan tab di bawah chart. Garis S/R manual dikirim otomatis oleh EA MT4 dari garis horizontal di chart pair itu, atau diimport dari template chart (.tpl). Garis Anda adalah referensi untuk menyetel mesin; order memakai garis mesin.',
              'Order = order of the tabs under the chart. Manual S/R lines are sent automatically by the MT4 EA from the horizontal lines on that pair\'s chart, or imported from a chart template (.tpl). Your lines are a reference for tuning the engine; orders use the engine lines.',
            )}
          </p>
          <label className="field import-tpl">
            <span>{t('Import garis dari template MT4/MT5 (.tpl, boleh banyak file)', 'Import lines from an MT4/MT5 template (.tpl, multiple files allowed)')}</span>
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
                      {s.manualLines} {t('garis referensi', 'reference lines')} {sourceLabel(s.manualLinesSource ?? '')} · {ago(s.manualLinesAt)}
                    </span>
                  ) : (
                    t('tanpa referensi', 'no reference')
                  )}
                  {' · '}
                  {s.lastCandleAt ? `candle ${ago(s.lastCandleAt)}` : t('belum ada candle', 'no candles yet')}
                </span>
                <label className="min-sl">
                  <span className="muted">{t('SL min', 'Min SL')}</span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={s.minSlPips}
                    aria-label={t(`SL minimal ${s.name} dalam pips`, `Minimum SL ${s.name} in pips`)}
                    onChange={(e) => setSymbols(symbols.map((x) => (x.name === s.name ? { ...x, minSlPips: e.target.valueAsNumber } : x)))}
                  />
                  <span className="muted">pips</span>
                </label>
                {s.manualLines ? (
                  <button type="button" className="link" onClick={() => useAuto(s.name)}>
                    {t('Hapus referensi', 'Remove reference')}
                  </button>
                ) : (
                  <span />
                )}
                <button type="button" className="icon" aria-label={t(`Naikkan ${s.name}`, `Move ${s.name} up`)} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button type="button" className="icon" aria-label={t(`Turunkan ${s.name}`, `Move ${s.name} down`)} onClick={() => move(i, 1)}>
                  ↓
                </button>
              </li>
            ))}
          </ul>
          <div className="inline">
            <input placeholder={t('Tambah pair, mis. GBPUSD', 'Add a pair, e.g. GBPUSD')} value={newPair} onChange={(e) => setNewPair(e.target.value.toUpperCase())} />
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
              {t('Tambah', 'Add')}
            </button>
          </div>
          <div className="actions">
            <button type="button" className="primary" onClick={() => savePairs(symbols)}>
              {t('Simpan daftar pair', 'Save pair list')}
            </button>
          </div>
        </div>
      )}

      {tab === 'costs' && (
        <div className="form">
          <p className="muted">
            {t(
              'Hanya untuk backtest. Candle D1 adalah harga bid, jadi hasil mentah (gross) belum membayar spread. Net = tiap trade dikurangi spread + komisi + slippage dalam pips, dan dalam R sebesar biaya / jarak SL trade itu. Default = spread "mulai dari" akun Maxrich Premium (terendah yang dikutip broker, jadi rata-rata nyata sedikit lebih lebar) dan komisi USD 10 per lot; ganti dengan angka akun Anda bila tahu. Tidak mengubah order live.',
              'For backtest only. D1 candles are bid prices, so the raw (gross) result has not paid the spread. Net = each trade minus spread + commission + slippage in pips, and in R as cost / that trade\'s SL distance. Default = the "from" spread of the Maxrich Premium account (the lowest the broker quotes, so the real average is slightly wider) and a USD 10 commission per lot; replace with your own account\'s numbers if you know them. Does not change live orders.',
            )}
          </p>
          <div className="grid">
            <label className="check">
              <input type="checkbox" checked={settings.costs.enabled} onChange={(e) => set({ costs: { ...settings.costs, enabled: e.target.checked } })} /> {t('Hitung spread, komisi, dan slippage (hasil net)', 'Include spread, commission and slippage (net result)')}
            </label>
            <NumberField
              label={t('Komisi per lot (USD)', 'Commission per lot (USD)')}
              hint={t('Pulang-pergi (buka + tutup), diubah ke pips lewat nilai pip pair; 0 = tanpa komisi', 'Round trip (open + close), converted to pips via the pair\'s pip value; 0 = no commission')}
              step={1}
              value={settings.costs.commissionPerLot}
              onChange={(v) => set({ costs: { ...settings.costs, commissionPerLot: v } })}
            />
            <NumberField
              label={t('Slippage per trade (pips)', 'Slippage per trade (pips)')}
              hint={t('Tambahan untuk semua pair; 0 = tanpa slippage', 'Extra for all pairs; 0 = no slippage')}
              step={0.1}
              value={settings.costs.slippagePips}
              onChange={(v) => set({ costs: { ...settings.costs, slippagePips: v } })}
            />
            <NumberField
              label={t('Batas biaya per trade (R)', 'Cost cap per trade (R)')}
              hint={t('Order yang biayanya lebih dari ini (spread + komisi + slippage, dibagi jarak SL-nya) tidak dibuka di backtest; 0 = tanpa batas. Mengubahnya perlu Jalankan ulang', 'Orders costing more than this (spread + commission + slippage, divided by their SL distance) are not opened in the backtest; 0 = no cap. Changing it needs a re-run')}
              step={0.01}
              value={settings.costs.maxCostR}
              onChange={(v) => set({ costs: { ...settings.costs, maxCostR: v } })}
            />
          </div>
          <table className="orders tabular spreads">
            <thead>
              <tr>
                <th>Pair</th>
                <th className="num">Spread (pips)</th>
                <th className="num">{t('= harga', '= price')}</th>
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
                      {!s.active && <span className="muted"> {t('(nonaktif)', '(inactive)')}</span>}
                    </td>
                    <td className="num">
                      <input
                        type="number"
                        min={0}
                        step={0.1}
                        value={Number.isFinite(v) ? v : ''}
                        aria-label={t(`Spread ${s.name} dalam pips`, `Spread ${s.name} in pips`)}
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
          <p className="muted">{t('1 pip = 0,0001 (0,01 untuk pair JPY); XAUUSD 1 pip = 10 × digit terakhir, default spreadnya $0,30.', '1 pip = 0.0001 (0.01 for JPY pairs); XAUUSD 1 pip = 10 × the last digit, default spread $0.30.')}</p>
          <div className="actions">
            <button type="button" onClick={() => set({ costs: { ...settings.costs, spreadPips: {} } })}>
              {t('Kembalikan default', 'Restore defaults')}
            </button>
            <button type="button" className="primary" onClick={saveCosts}>
              {t('Simpan biaya', 'Save costs')}
            </button>
          </div>
        </div>
      )}

      {tab === 'accounts' && (
        <div className="form">
          {shownKey && (
            <div className="key-box">
              <p>
                {t('Key EA untuk', 'EA key for')} <b>{shownKey.name}</b>. {t('Salin ke parameter EA MT5 sekarang: key ini tidak ditampilkan lagi.', 'Copy it to the MT5 EA parameters now: this key is not shown again.')}
              </p>
              <code>{shownKey.key}</code>
            </div>
          )}
          {accounts.map((a) => (
            <AccountEditor
              key={a.id}
              account={a}
              onSave={(patch) => run(async () => setAccounts((await Promise.all([api.updateAccount(a.id, patch), api.accounts()]))[1].accounts), t(`${a.name} disimpan.`, `${a.name} saved.`))}
              onRotate={() =>
                run(async () => {
                  const { key } = await api.rotateKey(a.id);
                  setShownKey({ name: a.name, key });
                }, t('Key baru dibuat. Key lama tidak berlaku lagi.', 'New key created. The old key no longer works.'))
              }
              onDelete={() => {
                if (!window.confirm(t(`Hapus akun ${a.name}? Perintah yang menunggu ikut dibatalkan.`, `Delete account ${a.name}? Pending commands are cancelled too.`))) return;
                void run(async () => {
                  await api.deleteAccount(a.id);
                  setAccounts((await api.accounts()).accounts);
                }, t(`${a.name} dihapus.`, `${a.name} deleted.`));
              }}
            />
          ))}
          <NewAccount
            onCreate={(input) =>
              run(async () => {
                const { account, key } = await api.createAccount(input);
                setShownKey({ name: account.name, key });
                setAccounts((await api.accounts()).accounts);
              }, t('Akun ditambahkan.', 'Account added.'))
            }
          />
        </div>
      )}
    </Modal>
  );
}

function AccountEditor({ account, onSave, onRotate, onDelete }: { account: Account; onSave: (p: Partial<Account>) => void; onRotate: () => void; onDelete: () => void }) {
  const t = useT();
  const [a, setA] = useState(account);
  const [map, setMap] = useState(pairsText(account.symbolMap));
  const [offsets, setOffsets] = useState(pairsText(account.offsets));
  return (
    <details className="account">
      <summary>
        <b>{account.name}</b> <span className="muted tabular">{account.number}</span>
        <span className="tabular">
          {' '}· balance {fmtMoney(account.balance)} {account.currency ?? ''} · {t('sinkron', 'synced')} {ago(account.balanceAt)} · {account.specSymbols.length} {t('spesifikasi simbol', 'symbol specs')}
        </span>
      </summary>
      <div className="grid">
        <label className="field">
          <span>{t('Nama', 'Name')}</span>
          <input value={a.name} onChange={(e) => setA({ ...a, name: e.target.value })} />
        </label>
        <NumberField label={t('Nomor akun MT5', 'MT5 account number')} step={1} value={a.number} onChange={(v) => setA({ ...a, number: v })} />
        <NumberField label="Risk per trade (%)" step={0.05} value={a.riskPct} onChange={(v) => setA({ ...a, riskPct: v })} />
        <NumberField label={t('Pengali Aggressive', 'Aggressive multiplier')} step={0.5} value={a.aggressiveMultiplier} onChange={(v) => setA({ ...a, aggressiveMultiplier: v })} />
        <label className="check">
          <input type="checkbox" checked={a.aggressiveAuto} onChange={(e) => setA({ ...a, aggressiveAuto: e.target.checked })} /> {t('Aggressive otomatis saat berita merah', 'Aggressive automatically on red news')}
        </label>
      </div>
      <div className="grid two">
        <label className="field">
          <span>{t('Mapping simbol (satu per baris)', 'Symbol mapping (one per line)')}</span>
          <textarea rows={4} placeholder="EURUSD=EURUSD.m" value={map} onChange={(e) => setMap(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('Offset harga MT4 ke MT5', 'MT4 to MT5 price offset')}</span>
          <textarea rows={4} placeholder="EURUSD=0.00002" value={offsets} onChange={(e) => setOffsets(e.target.value)} />
        </label>
      </div>
      <div className="actions">
        <button type="button" className="danger" onClick={onDelete}>
          {t('Hapus', 'Delete')}
        </button>
        <button type="button" onClick={onRotate}>
          {t('Buat key EA baru', 'Create new EA key')}
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
          {t('Simpan', 'Save')}
        </button>
      </div>
    </details>
  );
}

function NewAccount({ onCreate }: { onCreate: (a: Partial<Account>) => void }) {
  const t = useT();
  const [name, setName] = useState('');
  const [number, setNumber] = useState(NaN);
  return (
    <div className="inline new-account">
      <input placeholder={t('Nama akun', 'Account name')} value={name} onChange={(e) => setName(e.target.value)} />
      <input type="number" placeholder={t('Nomor akun MT5', 'MT5 account number')} value={Number.isFinite(number) ? number : ''} onChange={(e) => setNumber(e.target.valueAsNumber)} />
      <button
        type="button"
        disabled={!name.trim() || !Number.isFinite(number)}
        onClick={() => {
          onCreate({ name: name.trim(), number });
          setName('');
          setNumber(NaN);
        }}
      >
        {t('Tambah akun', 'Add account')}
      </button>
    </div>
  );
}
