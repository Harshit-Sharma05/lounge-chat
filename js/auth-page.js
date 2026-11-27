// =====================================================================
// auth-page.js – logic for index.html (log in / register)
//   1. If already logged in, go straight to the chat
//   2. Switch between "Log in" and "Register" modes
//   3. Validate as the user types
//   4. Call Supabase Auth, then redirect to chat.html
// =====================================================================

import { supabase } from './supabaseClient.js';
import { $, $$, validate } from './utils.js';

const CHAT_PAGE = 'chat.html';

const form       = $('#auth-form');
const submitBtn  = $('#submit-btn');
const messageEl  = $('#form-message');
const usernameWrap = $('#username-field');

const fields = {
  username: { input: $('#username'), error: $('#username-error') },
  email:    { input: $('#email'),    error: $('#email-error') },
  password: { input: $('#password'), error: $('#password-error') }
};

// Which rules apply in each mode. Login only checks the password is
// not empty (the real strength rules apply when registering).
const rules = {
  login: {
    email: validate.email,
    password: (v) => (v ? '' : 'Enter your password.')
  },
  register: {
    username: validate.username,
    email: validate.email,
    password: validate.password
  }
};

let mode = 'login';
let busy = false;

/* ---------- 1. Already logged in? Skip this page ---------- */
(async () => {
  const { data } = await supabase.auth.getSession();
  if (data.session) location.replace(CHAT_PAGE);
})();

/* ---------- 2. Switch between Log in / Register ---------- */
function setMode(next) {
  mode = next;
  const isLogin = mode === 'login';

  $$('.tab').forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.mode === mode)));
  usernameWrap.hidden = isLogin;
  submitBtn.textContent = isLogin ? 'Log in' : 'Create account';
  fields.password.input.autocomplete = isLogin ? 'current-password' : 'new-password';

  Object.keys(fields).forEach(clearError);
  showMessage('');
}

$$('.tab').forEach(tab => tab.addEventListener('click', () => setMode(tab.dataset.mode)));

/* ---------- 3. Validation ---------- */
function clearError(name) {
  fields[name].error.textContent = '';
  fields[name].input.removeAttribute('aria-invalid');
}

// Returns true when the field is valid; shows the error text if not.
function check(name) {
  const rule = rules[mode][name];
  if (!rule) return true;
  const message = rule(fields[name].input.value);
  fields[name].error.textContent = message;
  if (message) fields[name].input.setAttribute('aria-invalid', 'true');
  else fields[name].input.removeAttribute('aria-invalid');
  return !message;
}

Object.keys(fields).forEach(name => {
  const { input } = fields[name];
  // Re-check while typing only after the field has shown an error,
  // so we don't scold people before they finish typing.
  input.addEventListener('input', () => {
    if (input.hasAttribute('aria-invalid')) check(name);
  });
  // Check when leaving the field (but not if it is still empty and untouched).
  input.addEventListener('blur', () => {
    if (input.value !== '' || input.hasAttribute('aria-invalid')) check(name);
  });
});

function showMessage(text, type = 'error') {
  messageEl.textContent = text;
  messageEl.classList.toggle('success', type === 'success');
}

function setBusy(state) {
  busy = state;
  submitBtn.disabled = state;
  submitBtn.textContent = state
    ? (mode === 'login' ? 'Logging in…' : 'Creating account…')
    : (mode === 'login' ? 'Log in' : 'Create account');
}

/* ---------- 4. Turn Supabase errors into plain language ---------- */
function friendlyError(error) {
  const text = (error.message || '').toLowerCase();
  const code = error.code || '';

  if (text.includes('invalid login credentials')) return 'Wrong email or password.';
  if (code === 'email_not_confirmed' || text.includes('email not confirmed'))
    return 'Please confirm your email first. Check your inbox for the link.';
  if (code === 'user_already_exists' || text.includes('already registered'))
    return 'An account with this email already exists. Try logging in.';
  if (text.includes('database error saving new user'))
    return 'That username is already taken. Choose another one.';
  if (code === 'weak_password' || text.includes('password should'))
    return 'That password is too weak. Use at least 8 characters with a number.';
  if (code === 'over_email_send_rate_limit' || error.status === 429 || text.includes('rate limit'))
    return 'Too many attempts. Wait a minute and try again.';
  if (text.includes('failed to fetch') || text.includes('network'))
    return 'Cannot reach the server. Check your internet connection.';
  return error.message || 'Something went wrong. Please try again.';
}

/* ---------- 5. Submit ---------- */
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  showMessage('');

  const names = mode === 'login' ? ['email', 'password'] : ['username', 'email', 'password'];
  const allValid = names.map(check).every(Boolean);   // runs every check so all errors show
  if (!allValid) {
    fields[names.find(n => fields[n].input.hasAttribute('aria-invalid'))].input.focus();
    return;
  }

  const email    = fields.email.input.value.trim();
  const password = fields.password.input.value;
  const username = fields.username.input.value.trim();

  setBusy(true);
  try {
    if (mode === 'login') {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      location.replace(CHAT_PAGE);
      return;
    }

    // Register: the username travels as metadata; a database trigger
    // (see schema.sql) uses it to create the row in `profiles`.
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { username },
        emailRedirectTo: new URL(CHAT_PAGE, location.href).href
      }
    });
    if (error) throw error;

    // With "Confirm email" ON, Supabase hides duplicates by returning
    // a user with no identities instead of an error.
    if (data.user && data.user.identities && data.user.identities.length === 0) {
      showMessage('An account with this email already exists. Try logging in.');
    } else if (data.session) {
      location.replace(CHAT_PAGE);        // logged in immediately
      return;
    } else {
      showMessage('Account created. Check your email to confirm it, then log in.', 'success');
    }
  } catch (error) {
    showMessage(friendlyError(error));
  }
  setBusy(false);
});