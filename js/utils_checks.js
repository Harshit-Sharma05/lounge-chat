// =====================================================================
// utils_checks.js (SAMEER'S PART) – extracted from js/utils.js
//   4. Bad-word filter      5. Form validation
// In the full project these two sections live inside js/utils.js.
// =====================================================================

import { BAD_WORDS } from './config.js';

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

