import { useCallback, useEffect, useState } from 'react';
import { api, type Account, type AuditGroup, type CloseReason, type Journal, type JournalTrade } from '../api.ts';
import { digitsOf, fmtLot, fmtMoney, fmtPrice, fmtRr, fmtWibDateTime } from '../format.ts';
import { Modal } from './Modal.tsx';

type Props = { accounts: Account[]; initialAccountId: string | null; onClose: () => void };

const REASON: Record<CloseReason, string> = { sl: 'SL', tp: 'TP', so: 'Stop out', expert: 'EA', manual: 'Manual' };

// Current month in WIB as "YYYY-MM".
function thisMonth(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit' }).format(new Date());
}

// Month bounds in WIB (UTC+7, no daylight saving) as ISO strings.
function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const at = (yy: number, mm: number) => new Date(Date.UTC(yy, mm - 1, 1) - 7 * 3_600_000).toISOString();
  return { from: at(y, m), to: m === 12 ? at(y + 1, 1) : at(y, m + 1) };
}

const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)}%`);
const fmtR = (v: number | null) => (v === null ? '–' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`);
const signCls = (v: number | null) => (v === null || v === 0 ? '' : v > 0 ? 'ok' : 'error');

function GroupTable({ title, groups }: { title: string; groups: AuditGroup[] }) {
  if (!groups.length) return null;
  return (
    <div className="audit-group">
      <h3>{title}</h3>
      <table className="orders tabular">
        <thead>
          <tr>
            <th />
            <th className="num">Trade</th>
            <th className="num">Win</th>
            <th className="num">Net</th>
            <th className="num">Rata R</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.key}>
              <td>{g.key}</td>
              <td className="num">{g.trades}</td>
              <td className="num">{pct(g.winRate)}</td>
              <td className={`num ${signCls(g.net)}`}>{fmtMoney(g.net)}</td>
              <td className={`num ${signCls(g.avgR)}`}>{fmtR(g.avgR)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const CSV_HEAD = ['ticket', 'symbol', 'side', 'opened_wib', 'closed_wib', 'volume', 'plan_entry', 'fill', 'close', 'plan_sl', 'plan_tp', 'reason', 'net', 'r', 'plan_rr', 'plan_risk', 'sl_from', 'line_source', 'multiplier', 'news', 'ref'];

function csv(trades: JournalTrade[]): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = trades.map((t) => [
    t.ticket, t.symbol, t.side, fmtWibDateTime(t.openedAt), fmtWibDateTime(t.closedAt), t.volume, t.plan?.entry, t.openPrice, t.closePrice,
    t.plan?.sl, t.plan?.tp, t.closeReason, t.net, t.r, t.plan?.rr, t.plan?.risk, t.plan?.slFrom, t.plan?.lineSource, t.plan?.multiplier,
    t.plan?.newsAffected, t.ref,
  ]);
  return [CSV_HEAD, ...rows].map((r) => r.map(cell).join(',')).join('\n');
}

export function JournalModal({ accounts, initialAccountId, onClose }: Props) {
  const [accountId, setAccountId] = useState(initialAccountId ?? accounts[0]?.id ?? '');
  const [month, setMonth] = useState(thisMonth());
  const [data, setData] = useState<Journal | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accountId || !month) return;
    try {
      const { from, to } = monthRange(month);
      setData(await api.journal(accountId, from, to));
      setError(null);
    } catch (e) {
      setData(null);
      setError((e as Error).message);
    }
  }, [accountId, month]);

  useEffect(() => {
    void load();
  }, [load]);

  const account = accounts.find((a) => a.id === accountId);
  const download = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([csv(data.trades)], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `jurnal-${account?.number ?? 'akun'}-${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const a = data?.audit;
  const s = a?.stats;
  const cur = data?.currency ?? '';

  return (
    <Modal title="Jurnal & Audit" onClose={onClose} wide>
      <div className="modal-tools">
        <label>
          <span className="sr-only">Akun</span>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="Akun">
            {!accounts.length && <option value="">Belum ada akun</option>}
            {accounts.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} ({x.number})
              </option>
            ))}
          </select>
        </label>
        <label className="inline">
          Bulan <input type="month" value={month} max={thisMonth()} onChange={(e) => setMonth(e.target.value)} />
        </label>
        <button type="button" disabled={!data?.trades.length} onClick={download}>
          Unduh CSV
        </button>
        <span className="muted">Trade dihitung pada bulan close-nya (WIB).</span>
      </div>
      {error && <p className="error">{error}</p>}
      {!accounts.length && <p className="muted pad">Tambahkan akun MT5 di Pengaturan dulu.</p>}

      {a && s && (
        <>
          <div className="tiles tabular">
            <div>
              <span>Trade</span>
              <b>{s.trades}</b>
              <small className="muted">
                {s.wins} untung · {s.losses} rugi
              </small>
            </div>
            <div>
              <span>Win rate</span>
              <b>{pct(s.winRate)}</b>
            </div>
            <div>
              <span>Net {cur}</span>
              <b className={signCls(s.net)}>{fmtMoney(s.net)}</b>
              <small className="muted">
                +{fmtMoney(s.grossProfit)} / {fmtMoney(s.grossLoss)}
              </small>
            </div>
            <div>
              <span>Profit factor</span>
              <b>{s.profitFactor ?? '–'}</b>
            </div>
            <div>
              <span>Rata-rata R</span>
              <b className={signCls(s.avgR)}>{fmtR(s.avgR)}</b>
              <small className="muted">total {fmtR(s.totalR)}</small>
            </div>
            <div>
              <span>Max drawdown</span>
              <b>{fmtMoney(a.maxDrawdown)}</b>
            </div>
            <div>
              <span>Fill rate</span>
              <b>{pct(a.fills.rate)}</b>
              <small className="muted">
                {a.fills.filled}/{a.fills.placed} order
              </small>
            </div>
            <div>
              <span>Slippage</span>
              <b>{fmtR(a.avgSlipR)}</b>
              <small className="muted">{a.avgHoldHours === null ? '' : `tahan rata ${a.avgHoldHours} jam`}</small>
            </div>
          </div>

          <h3>Temuan</h3>
          <ul className="findings">
            {a.findings.map((f, i) => (
              <li key={i} className={`finding-${f.level}`}>
                {f.text}
              </li>
            ))}
          </ul>

          {s.trades > 0 && (
            <div className="audit-groups">
              <GroupTable title="Per pair" groups={a.bySymbol} />
              <GroupTable title="Alasan close" groups={a.byReason} />
              <GroupTable title="Normal / Aggressive" groups={a.byMode} />
              <GroupTable title="Sumber SL" groups={a.bySlFrom} />
              <GroupTable title="RR rencana" groups={a.byRr} />
              <GroupTable title="Garis" groups={a.byLineSource} />
              <GroupTable title="Arah" groups={a.bySide} />
            </div>
          )}

          <h3>Trade close ({data.trades.length})</h3>
          {data.trades.length ? (
            <TradesTable trades={data.trades} />
          ) : (
            <p className="muted">Belum ada. EA eksekutor v1.10 melapor deal tiap status (60 detik) setelah posisi close.</p>
          )}
          {data.open.length > 0 && (
            <>
              <h3>Posisi masih terbuka ({data.open.length})</h3>
              <TradesTable trades={data.open} />
            </>
          )}
        </>
      )}
    </Modal>
  );
}

function TradesTable({ trades }: { trades: JournalTrade[] }) {
  return (
    <div className="table-scroll">
      <table className="orders tabular">
        <thead>
          <tr>
            <th>Buka</th>
            <th>Close</th>
            <th>Pair</th>
            <th>Tipe</th>
            <th className="num">Lot</th>
            <th className="num">Entry rencana</th>
            <th className="num">Fill</th>
            <th className="num">Close</th>
            <th>Alasan</th>
            <th className="num">Net</th>
            <th className="num">R</th>
            <th className="num">RR rencana</th>
            <th>Catatan</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => {
            const d = digitsOf(t.symbol);
            return (
              <tr key={t.id}>
                <td>{fmtWibDateTime(t.openedAt)}</td>
                <td>{fmtWibDateTime(t.closedAt)}</td>
                <td>{t.symbol}</td>
                <td>{t.side}</td>
                <td className="num">{fmtLot(t.volume)}</td>
                <td className="num">{fmtPrice(t.plan?.entry, d)}</td>
                <td className="num">{fmtPrice(t.openPrice, d)}</td>
                <td className="num">{fmtPrice(t.closePrice, d)}</td>
                <td>{t.closeReason ? REASON[t.closeReason] : '–'}</td>
                <td className={`num ${signCls(t.status === 'closed' ? t.net : null)}`}>{t.status === 'closed' ? fmtMoney(t.net) : '–'}</td>
                <td className={`num ${signCls(t.r)}`}>{fmtR(t.r)}</td>
                <td className="num">{fmtRr(t.plan?.rr)}</td>
                <td>
                  {!t.plan && <span className="tag">tanpa rencana</span>}
                  {t.plan?.slFrom === 'ladder' && <span className="tag">SL tangga</span>}
                  {t.plan?.tpAuto && <span className="tag">TP auto</span>}
                  {t.plan && t.plan.multiplier > 1 && <span className="aggr"> {t.plan.multiplier}x</span>}
                  {t.plan?.newsAffected && <span className="tag">berita</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
