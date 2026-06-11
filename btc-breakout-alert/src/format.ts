const priceFmt = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function fmtPrice(p: number): string {
  return priceFmt.format(p);
}

export function fmtPct(p: number): string {
  return `${p.toFixed(2)}%`;
}

export function fmtRatio(r: number | null): string {
  return r === null ? '—' : `${r.toFixed(2)}×`;
}

/** Signed base-asset amount, e.g. CVD change: "+12.3" / "−4.0". */
export function fmtDelta(d: number | null): string {
  if (d === null || !Number.isFinite(d)) return '—';
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}`;
}

export function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour12: false });
}
