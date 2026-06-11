import { useEffect, useMemo, useState } from 'react';
import AlertTable from './components/AlertTable';
import ChartPanel, { type ChartMarker } from './components/ChartPanel';
import SettingsPanel from './components/SettingsPanel';
import StatusBar from './components/StatusBar';
import { useBreakoutEngine } from './hooks/useBreakoutEngine';
import { requestNotificationPermission, unlockAudio } from './services/notify';
import { DEFAULT_CONFIG } from './strategy/breakout';
import type { AppSettings } from './types';

const SETTINGS_KEY = 'btc-breakout-alert-settings-v1';

const DEFAULT_SETTINGS: AppSettings = {
  ...DEFAULT_CONFIG,
  timeframe: '15m',
  soundOn: true,
  telegramToken: '',
  telegramChatId: '',
};

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    /* corrupted storage — fall back to defaults */
  }
  return DEFAULT_SETTINGS;
}

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const engine = useBreakoutEngine(settings);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* storage full/blocked — settings just won't persist */
    }
  }, [settings]);

  // Ask for notification permission up front; unlock audio on the first
  // user gesture (browsers refuse to play sound before one).
  useEffect(() => {
    void requestNotificationPermission();
    const unlock = () => unlockAudio();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  // Chart arrows: dimmed for breakouts found in loaded history, vivid for
  // alerts fired live this session (live wins when both hit the same candle).
  const markers = useMemo<ChartMarker[]>(() => {
    const byKey = new Map<string, ChartMarker>();
    for (const s of engine.historicalSignals) {
      byKey.set(`${s.candleTime}:${s.direction}`, {
        time: s.candleTime,
        direction: s.direction,
        historical: true,
      });
    }
    for (const a of engine.alerts) {
      byKey.set(`${a.candleTime}:${a.direction}`, {
        time: a.candleTime,
        direction: a.direction,
        historical: false,
      });
    }
    return [...byKey.values()].sort((a, b) => a.time - b.time);
  }, [engine.historicalSignals, engine.alerts]);

  return (
    <div className="app">
      <header className="topbar">
        <h1>
          BTC Breakout Alert
          <span className="subtitle">Donchian range breakout monitor · Binance</span>
        </h1>
      </header>

      <StatusBar
        price={engine.price}
        levels={engine.levels}
        status={engine.status}
        timeframe={settings.timeframe}
      />

      {engine.notice && (
        <div className="notice">
          <span>⚠ {engine.notice}</span>
          <button type="button" onClick={engine.dismissNotice}>
            ✕
          </button>
        </div>
      )}

      <main className="content">
        <section className="chart-wrap">
          {engine.fatalError ? (
            <div className="error-panel">
              <h2>Couldn&apos;t load market data</h2>
              <p>{engine.fatalError}</p>
              <p className="hint">
                Check your connection (or whether Binance is reachable from your network), then
                retry.
              </p>
              <button type="button" onClick={engine.retry}>
                Retry
              </button>
            </div>
          ) : (
            <>
              <ChartPanel
                seed={engine.seed}
                lastBar={engine.lastBar}
                levels={engine.levels}
                markers={markers}
              />
              {engine.seed.candles.length === 0 && (
                <div className="chart-loading">Loading history…</div>
              )}
            </>
          )}
        </section>

        <aside className="sidebar">
          <SettingsPanel settings={settings} onChange={(patch) => setSettings((s) => ({ ...s, ...patch }))} />
        </aside>
      </main>

      <section className="alerts-section">
        <h2>Alert history</h2>
        <AlertTable alerts={engine.alerts} />
      </section>
    </div>
  );
}
