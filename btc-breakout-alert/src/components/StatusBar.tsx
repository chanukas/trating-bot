import { fmtPct, fmtPrice } from '../format';
import type { ConnStatus, Levels, Timeframe } from '../types';

interface Props {
  price: number | null;
  levels: Levels | null;
  status: ConnStatus;
  timeframe: Timeframe;
}

const STATUS_LABEL: Record<ConnStatus, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  error: 'Error',
};

export default function StatusBar({ price, levels, status, timeframe }: Props) {
  const toResistance = price !== null && levels ? ((levels.resistance - price) / price) * 100 : null;
  const toSupport = price !== null && levels ? ((price - levels.support) / price) * 100 : null;

  return (
    <div className="statusbar">
      <span className="symbol-badge">
        BTC/USDT <em>{timeframe}</em>
      </span>
      <span className="price num">{price !== null ? fmtPrice(price) : '—'}</span>

      <span className="level-chip up num" title="Distance from current price up to resistance">
        R {levels ? fmtPrice(levels.resistance) : '—'}
        {toResistance !== null && <em>{fmtPct(toResistance)} away</em>}
      </span>
      <span className="level-chip down num" title="Distance from current price down to support">
        S {levels ? fmtPrice(levels.support) : '—'}
        {toSupport !== null && <em>{fmtPct(toSupport)} away</em>}
      </span>

      <span className={`conn-pill conn-${status}`}>{STATUS_LABEL[status]}</span>
    </div>
  );
}
