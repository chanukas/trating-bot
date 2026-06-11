import { useEffect, useState } from 'react';
import {
  notificationState,
  playBreakoutSound,
  requestNotificationPermission,
  sendTelegram,
  unlockAudio,
} from '../services/notify';
import { TIMEFRAMES, type AppSettings, type Timeframe } from '../types';

interface Props {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
}

interface NumberFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  int?: boolean;
  disabled?: boolean;
  onCommit: (value: number) => void;
}

/** Numeric input that keeps a local draft while typing and commits on blur/Enter. */
function NumberField({ label, value, min, max, step, int, disabled, onCommit }: NumberFieldProps) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const n = int ? parseInt(draft, 10) : parseFloat(draft);
    if (Number.isFinite(n)) {
      onCommit(Math.min(max, Math.max(min, n)));
    } else {
      setDraft(String(value));
    }
  };

  return (
    <label className={`field${disabled ? ' field-disabled' : ''}`}>
      <span>{label}</span>
      <input
        type="number"
        value={draft}
        min={min}
        max={max}
        step={step ?? 1}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="field field-toggle">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export default function SettingsPanel({ settings, onChange }: Props) {
  const [permission, setPermission] = useState(notificationState());
  const [tgStatus, setTgStatus] = useState<string | null>(null);

  const requestPermission = async () => {
    setPermission(await requestNotificationPermission());
  };

  const testTelegram = async () => {
    setTgStatus('Sending…');
    try {
      await sendTelegram(
        settings.telegramToken,
        settings.telegramChatId,
        '✅ Test message from BTC Breakout Alert',
      );
      setTgStatus('Sent ✓');
    } catch (err) {
      setTgStatus(err instanceof Error ? err.message : 'Send failed');
    }
  };

  return (
    <div className="settings">
      <h2>Settings</h2>

      <h3>Market</h3>
      <label className="field">
        <span>Timeframe</span>
        <select
          value={settings.timeframe}
          onChange={(e) => onChange({ timeframe: e.target.value as Timeframe })}
        >
          {TIMEFRAMES.map((tf) => (
            <option key={tf} value={tf}>
              {tf}
            </option>
          ))}
        </select>
      </label>

      <h3>Strategy</h3>
      <NumberField
        label="Lookback (candles)"
        value={settings.lookback}
        min={2}
        max={400}
        int
        onCommit={(lookback) => onChange({ lookback })}
      />
      <div className="field field-radio">
        <span>Trigger on</span>
        <div className="radio-group">
          <label>
            <input
              type="radio"
              name="mode"
              checked={settings.mode === 'close'}
              onChange={() => onChange({ mode: 'close' })}
            />
            Candle close
          </label>
          <label>
            <input
              type="radio"
              name="mode"
              checked={settings.mode === 'intracandle'}
              onChange={() => onChange({ mode: 'intracandle' })}
            />
            Intra-candle cross
          </label>
        </div>
      </div>
      <p className="hint">
        Candle close confirms the breakout and filters wick noise; intra-candle fires the moment
        price crosses the level.
      </p>
      <NumberField
        label="Cooldown (candles)"
        value={settings.cooldown}
        min={0}
        max={500}
        int
        onCommit={(cooldown) => onChange({ cooldown })}
      />

      <h3>Filters</h3>
      <Toggle
        label="Volume filter"
        checked={settings.volumeFilter}
        onChange={(volumeFilter) => onChange({ volumeFilter })}
      />
      <NumberField
        label="Volume multiplier (×)"
        value={settings.volumeMultiplier}
        min={0.1}
        max={10}
        step={0.1}
        disabled={!settings.volumeFilter}
        onCommit={(volumeMultiplier) => onChange({ volumeMultiplier })}
      />
      <NumberField
        label="Volume average period"
        value={settings.volumePeriod}
        min={2}
        max={400}
        int
        disabled={!settings.volumeFilter}
        onCommit={(volumePeriod) => onChange({ volumePeriod })}
      />
      <Toggle
        label="Buffer filter"
        checked={settings.bufferFilter}
        onChange={(bufferFilter) => onChange({ bufferFilter })}
      />
      <NumberField
        label="Buffer (%)"
        value={settings.bufferPct}
        min={0}
        max={5}
        step={0.05}
        disabled={!settings.bufferFilter}
        onCommit={(bufferPct) => onChange({ bufferPct })}
      />
      <Toggle
        label="CVD filter"
        checked={settings.cvdFilter}
        onChange={(cvdFilter) => onChange({ cvdFilter })}
      />
      <NumberField
        label="CVD window (candles)"
        value={settings.cvdLookback}
        min={1}
        max={100}
        int
        disabled={!settings.cvdFilter}
        onCommit={(cvdLookback) => onChange({ cvdLookback })}
      />
      <p className="hint">
        CVD = cumulative volume delta (taker buys − taker sells). The filter requires net
        aggressive flow over the window (breakout candle included) to point in the breakout
        direction. The purple line on the volume pane plots it.
      </p>

      <h3>Alerts</h3>
      <Toggle
        label="Sound"
        checked={settings.soundOn}
        onChange={(soundOn) => onChange({ soundOn })}
      />
      <div className="button-row">
        <button
          type="button"
          onClick={() => {
            unlockAudio();
            playBreakoutSound('up');
            setTimeout(() => playBreakoutSound('down'), 700);
          }}
        >
          Test sound
        </button>
      </div>
      <div className="field">
        <span>Browser notifications</span>
        {permission === 'granted' ? (
          <span className="perm-ok">enabled ✓</span>
        ) : permission === 'unsupported' ? (
          <span className="perm-bad">unsupported</span>
        ) : (
          <button type="button" onClick={requestPermission}>
            {permission === 'denied' ? 'blocked — check browser' : 'Enable'}
          </button>
        )}
      </div>

      <h3>Telegram (optional)</h3>
      <label className="field field-text">
        <span>Bot token</span>
        <input
          type="password"
          placeholder="123456:ABC-…"
          value={settings.telegramToken}
          onChange={(e) => onChange({ telegramToken: e.target.value })}
        />
      </label>
      <label className="field field-text">
        <span>Chat ID</span>
        <input
          type="text"
          placeholder="e.g. 123456789"
          value={settings.telegramChatId}
          onChange={(e) => onChange({ telegramChatId: e.target.value })}
        />
      </label>
      <div className="button-row">
        <button
          type="button"
          disabled={!settings.telegramToken.trim() || !settings.telegramChatId.trim()}
          onClick={testTelegram}
        >
          Send test message
        </button>
        {tgStatus && <span className="tg-status">{tgStatus}</span>}
      </div>
      <p className="hint">
        Leave blank to skip. The token is stored only in this browser&apos;s localStorage and sent
        only to api.telegram.org.
      </p>
    </div>
  );
}
