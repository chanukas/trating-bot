import { fmtClock, fmtDelta, fmtPrice, fmtRatio } from '../format';
import type { AlertRecord } from '../types';

interface Props {
  alerts: AlertRecord[];
}

export default function AlertTable({ alerts }: Props) {
  if (alerts.length === 0) {
    return (
      <div className="alert-empty">
        No breakouts yet this session — alerts will appear here when one fires.
      </div>
    );
  }

  return (
    <div className="alert-scroll">
      <table className="alert-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>TF</th>
            <th>Direction</th>
            <th>Price</th>
            <th>Level broken</th>
            <th>Volume</th>
            <th>CVD Δ</th>
            <th>Trigger</th>
          </tr>
        </thead>
        <tbody>
          {alerts.map((a) => (
            <tr key={a.id}>
              <td className="num">{fmtClock(a.firedAt)}</td>
              <td>{a.timeframe}</td>
              <td>
                <span className={`dir-badge dir-${a.direction}`}>
                  {a.direction === 'up' ? '▲ Upside' : '▼ Downside'}
                </span>
              </td>
              <td className="num">{fmtPrice(a.price)}</td>
              <td className="num">
                {a.direction === 'up' ? 'R ' : 'S '}
                {fmtPrice(a.level)}
              </td>
              <td className="num">{fmtRatio(a.volumeRatio)}</td>
              <td className="num">{fmtDelta(a.cvdDelta)}</td>
              <td>{a.mode === 'close' ? 'close' : 'intra'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
