/**
 * Alert delivery: browser notifications, WebAudio tones, optional Telegram.
 */
import type { Direction } from '../types';

// ---------------------------------------------------------------- browser

export function notificationState(): NotificationPermission | 'unsupported' {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function showBrowserNotification(title: string, body: string): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body });
  } catch {
    /* some browsers throw outside a service worker — non-fatal */
  }
}

// ------------------------------------------------------------------ sound

let audioCtx: AudioContext | null = null;

/**
 * Browsers only allow audio after a user gesture; App calls this on the
 * first pointer/key event so later alerts can actually be heard.
 */
export function unlockAudio(): void {
  if (!audioCtx) {
    try {
      audioCtx = new AudioContext();
    } catch {
      return;
    }
  }
  if (audioCtx.state === 'suspended') void audioCtx.resume();
}

function tone(ctx: AudioContext, freq: number, start: number, duration: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.35, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.05);
}

/** Rising three-note chirp for upside, falling for downside. */
export function playBreakoutSound(direction: Direction): void {
  unlockAudio();
  if (!audioCtx || audioCtx.state !== 'running') return;
  const freqs = direction === 'up' ? [660, 880, 1175] : [587, 440, 294];
  const t0 = audioCtx.currentTime + 0.01;
  freqs.forEach((f, i) => tone(audioCtx!, f, t0 + i * 0.16, 0.18));
}

// --------------------------------------------------------------- telegram

/**
 * Sends via the Bot API directly from the browser (api.telegram.org allows
 * CORS). Throws on failure so the caller can surface a warning.
 */
export async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token.trim()}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId.trim(), text }),
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as { description?: string };
      if (body.description) detail = `${res.status} ${body.description}`;
    } catch {
      /* keep status only */
    }
    throw new Error(`Telegram: ${detail}`);
  }
}
