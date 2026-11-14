// =====================================================================
// utils.js – small reusable helpers used by auth-page.js and chat.js.
// Pure helpers only: no Supabase calls, no page-specific logic.
// =====================================================================

import { BAD_WORDS } from './config.js';

/* ---------------------------------------------------------------
   1. DOM shortcuts
   --------------------------------------------------------------- */
export const $  = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/* ---------------------------------------------------------------
   2. Security: escape text before putting it into innerHTML.
      Without this, a message like <img src=x onerror=alert(1)>
      would run as code in everyone's browser (an XSS attack).
   --------------------------------------------------------------- */
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

/* ---------------------------------------------------------------
   3. Date and time formatting (follows the user's device locale)
   --------------------------------------------------------------- */
const timeFormat = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat([], {
  weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
});

// "10:32 am" – shown next to each message
export const fmtTime = (iso) => timeFormat.format(new Date(iso));

// "Mon, 9 Nov 2026, 10:32 am" – shown as a hover tooltip on the time
export const fmtFull = (iso) => `${dateFormat.format(new Date(iso))}, ${fmtTime(iso)}`;

export function isSameDay(a, b) {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

// "Today", "Yesterday", or "Mon, 9 Nov 2026" – used for the day dividers in the feed
export function dayLabel(iso) {
  const date = new Date(iso);
  const now = new Date();
  if (isSameDay(date, now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(date, yesterday)) return 'Yesterday';
  return dateFormat.format(date);
}

/* ---------------------------------------------------------------
   4. Bad-word filter (words come from config.js)
   --------------------------------------------------------------- */
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const badPattern = [...new Set(BAD_WORDS.map(w => w.trim().toLowerCase()).filter(Boolean))]
  .sort((a, b) => b.length - a.length)          // match longer phrases first
  .map(escapeRegex)
  .join('|');

const maskRegex = badPattern ? new RegExp(`\\b(${badPattern})\\b`, 'gi') : null;
const testRegex = badPattern ? new RegExp(`\\b(${badPattern})\\b`, 'i')  : null;

// "you idiot" -> "you *****"
export const maskBadWords = (text) =>
  maskRegex ? text.replace(maskRegex, (match) => '*'.repeat(match.length)) : text;

export const hasBadWords = (text) => (testRegex ? testRegex.test(text) : false);

/* ---------------------------------------------------------------
   5. Form validation. Each function returns '' when the value is
      fine, or a short error message to show under the input.
   --------------------------------------------------------------- */
export const validate = {
  username(value) {
    const v = value.trim();
    if (!v) return 'Choose a username.';
    return /^[a-zA-Z0-9_]{3,15}$/.test(v)
      ? ''
      : 'Use 3–15 letters, numbers or underscores.';
  },
  email(value) {
    const v = value.trim();
    if (!v) return 'Enter your email address.';
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? '' : 'Enter a valid email address.';
  },
  password(value) {
    if (!value) return 'Enter a password.';
    if (value.length < 8) return 'Use at least 8 characters.';
    if (!/\d/.test(value)) return 'Include at least one number.';
    return '';
  }
};

/* ---------------------------------------------------------------
   6. Avatars: initials and a colour that is always the same
      for the same username.
   --------------------------------------------------------------- */
export const initials = (name) => String(name || '?').trim().slice(0, 2).toUpperCase();

export function avatarColor(name) {
  let hue = 0;
  for (const ch of String(name || '?')) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${hue} 45% 38%)`;
}

/* ---------------------------------------------------------------
   7. Toast notifications (small pop-up messages).
      type: 'info' | 'success' | 'error'
      Styled by the .toast classes in style.css (Part 3).
   --------------------------------------------------------------- */
export function showToast(message, type = 'info', duration = 3500) {
  let box = $('#toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    box.setAttribute('aria-live', 'polite');
    document.body.append(box);
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  box.append(toast);
  setTimeout(() => toast.remove(), duration);
}