(() => {
  'use strict';

  // Kept separate from /api/chat, which belongs to PVP Arena.
  const API = '/sushi-api';
  const state = { user: null, csrfToken: '', apiOnline: true };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[char]);
  }

  async function request(path, options = {}) {
    const headers = { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) };
    if (state.csrfToken && !['GET', 'HEAD'].includes(options.method || 'GET')) headers['x-csrf-token'] = state.csrfToken;
    const response = await fetch(API + path, { credentials: 'same-origin', ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Request failed.');
    return data;
  }

  function modalMarkup() {
    return `
      <div class="sgl-modal-shell" id="sgl-account-modal" hidden>
        <div class="sgl-modal-backdrop" data-sgl-close></div>
        <section class="sgl-modal" role="dialog" aria-modal="true" aria-labelledby="sgl-modal-title">
          <button class="sgl-modal-close" type="button" data-sgl-close aria-label="Close">&times;</button>
          <div class="sgl-modal-brand">
            <img src="/logo.svg" alt="">
            <div><h2 id="sgl-modal-title">Sushi ID</h2><p>One optional account for every game.</p></div>
          </div>
          <div id="sgl-auth-area">
            <div class="sgl-tabs" role="tablist">
              <button class="sgl-tab" type="button" data-auth-tab="login" aria-selected="true">Sign in</button>
              <button class="sgl-tab" type="button" data-auth-tab="register" aria-selected="false">Create account</button>
            </div>
            <form class="sgl-auth-form" id="sgl-login-form">
              <label class="sgl-field"><span>Private username</span><input name="username" autocomplete="username" minlength="3" maxlength="24" required></label>
              <label class="sgl-field"><span>Password</span><div class="sgl-password-row"><input name="password" type="password" autocomplete="current-password" minlength="10" maxlength="128" required><button class="sgl-show-pass" type="button">SHOW</button></div></label>
              <button class="sgl-primary" type="submit">Sign in</button>
              <button class="sgl-secondary" type="button" data-auth-tab="recover">Use a recovery code</button>
              <p class="sgl-form-note">Your username is never shown on rankings. Only your generated player nickname is public.</p>
            </form>
            <form class="sgl-auth-form" id="sgl-register-form" hidden>
              <label class="sgl-field"><span>Choose a private username</span><input name="username" autocomplete="username" minlength="3" maxlength="24" pattern="[A-Za-z0-9_-]+" required></label>
              <label class="sgl-field"><span>Create a password (10+ characters)</span><div class="sgl-password-row"><input name="password" type="password" autocomplete="new-password" minlength="10" maxlength="128" required><button class="sgl-show-pass" type="button">SHOW</button></div></label>
              <button class="sgl-primary" type="submit">Create my Sushi ID</button>
              <p class="sgl-form-note">No email, real name, birthday, location, profile photo or chat profile is collected. Use a unique password that you do not use on another website. Playing as a guest always remains available.</p>
            </form>
            <form class="sgl-auth-form" id="sgl-recover-form" hidden>
              <label class="sgl-field"><span>Private username</span><input name="username" autocomplete="username" minlength="3" maxlength="24" required></label>
              <label class="sgl-field"><span>Recovery code</span><input name="recoveryCode" autocomplete="off" placeholder="xxxx-xxxx-…" required></label>
              <label class="sgl-field"><span>New password (10+ characters)</span><div class="sgl-password-row"><input name="newPassword" type="password" autocomplete="new-password" minlength="10" maxlength="128" required><button class="sgl-show-pass" type="button">SHOW</button></div></label>
              <button class="sgl-primary" type="submit">Reset password</button>
              <button class="sgl-secondary" type="button" data-auth-tab="login">Back to sign in</button>
              <p class="sgl-form-note">A successful reset replaces the old recovery code and signs out every other device.</p>
            </form>
            <p class="sgl-auth-status" id="sgl-auth-status" role="status"></p>
            <p class="sgl-offline-note" id="sgl-api-offline" hidden>The account server is not running in this preview. Guest play still works normally.</p>
          </div>
          <div class="sgl-profile" id="sgl-profile" hidden></div>
        </section>
      </div>`;
  }

  function setStatus(message = '', kind = '') {
    const el = document.getElementById('sgl-auth-status');
    if (!el) return;
    el.textContent = message;
    el.className = `sgl-auth-status ${kind}`.trim();
  }

  function setTab(name) {
    document.querySelectorAll('[data-auth-tab]').forEach(button => {
      button.setAttribute('aria-selected', String(button.dataset.authTab === name));
    });
    document.getElementById('sgl-login-form').hidden = name !== 'login';
    document.getElementById('sgl-register-form').hidden = name !== 'register';
    document.getElementById('sgl-recover-form').hidden = name !== 'recover';
    setStatus();
  }

  function updateButtons() {
    document.querySelectorAll('[data-sgl-account]').forEach(button => {
      button.dataset.signedIn = String(Boolean(state.user));
      button.textContent = state.user ? `🍣 ${state.user.displayName}` : '🍣 Guest · Sign in';
    });
  }

  function renderProfile(recoveryCode = '') {
    const authArea = document.getElementById('sgl-auth-area');
    const profile = document.getElementById('sgl-profile');
    if (!authArea || !profile) return;
    authArea.hidden = Boolean(state.user);
    profile.hidden = !state.user;
    if (!state.user) return;
    profile.innerHTML = `
      <div class="sgl-player-card"><small>PUBLIC PLAYER NAME</small><strong>${escapeHtml(state.user.displayName)}</strong></div>
      ${recoveryCode ? `<div class="sgl-recovery"><b>Save your recovery code now.</b> It is shown once and replaces email recovery.<code>${escapeHtml(recoveryCode)}</code><button type="button" class="sgl-secondary" id="sgl-download-recovery">Download code</button></div>` : ''}
      <p class="sgl-form-note">Signed in privately as <b>${escapeHtml(state.user.username)}</b>. Your games remain playable offline; only rankings need the account server.</p>
      <p class="sgl-auth-status" id="sgl-profile-status" role="status"></p>
      <div class="sgl-profile-actions"><a class="sgl-primary" href="/leaderboard.html">View rankings</a><button class="sgl-secondary" type="button" id="sgl-logout">Sign out</button></div>
      <details class="sgl-delete-box"><summary>Delete this account</summary><form id="sgl-delete-form" class="sgl-auth-form"><label class="sgl-field"><span>Confirm your password</span><input name="password" type="password" autocomplete="current-password" minlength="10" maxlength="128" required></label><button class="sgl-danger" type="submit">Permanently delete account and scores</button><p class="sgl-form-note">This cannot be undone.</p></form></details>`;
    document.getElementById('sgl-logout')?.addEventListener('click', logout);
    document.getElementById('sgl-delete-form')?.addEventListener('submit', deleteAccount);
    document.getElementById('sgl-download-recovery')?.addEventListener('click', () => {
      const text = `Sushi Game Lab recovery code\nUsername: ${state.user.username}\nCode: ${recoveryCode}\n\nKeep this private. Anyone with this code can reset the account password.\n`;
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      const link = Object.assign(document.createElement('a'), { href: url, download: 'sushi-id-recovery.txt' });
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  function openModal(tab = 'login') {
    const shell = document.getElementById('sgl-account-modal');
    shell.hidden = false;
    document.documentElement.style.overflow = 'hidden';
    if (state.user) renderProfile(); else setTab(tab);
    setTimeout(() => shell.querySelector('input:not([hidden]),button')?.focus(), 0);
  }

  function closeModal() {
    document.getElementById('sgl-account-modal').hidden = true;
    document.documentElement.style.overflow = '';
  }

  async function submitAuth(event, mode) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type="submit"]');
    const payload = Object.fromEntries(new FormData(form));
    submit.disabled = true;
    setStatus(mode === 'register' ? 'Creating your account…' : 'Signing in…');
    try {
      const data = await request(`/auth/${mode}`, { method: 'POST', body: JSON.stringify(payload) });
      state.user = data.user;
      state.csrfToken = data.csrfToken || '';
      updateButtons();
      renderProfile(data.recoveryCode || '');
      window.dispatchEvent(new CustomEvent('sgl:authchange', { detail: state.user }));
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      submit.disabled = false;
    }
  }

  async function logout() {
    const status = document.getElementById('sgl-profile-status');
    try {
      await request('/auth/logout', { method: 'POST' });
      state.user = null;
      state.csrfToken = '';
      updateButtons();
      renderProfile();
      closeModal();
      window.dispatchEvent(new CustomEvent('sgl:authchange', { detail: null }));
    } catch (error) {
      if (status) { status.textContent = `Could not sign out: ${error.message}`; status.className = 'sgl-auth-status error'; }
    }
  }

  async function deleteAccount(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type="submit"]');
    const status = document.getElementById('sgl-profile-status');
    submit.disabled = true;
    try {
      await request('/auth/account', { method: 'DELETE', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      state.user = null;
      state.csrfToken = '';
      updateButtons();
      renderProfile();
      closeModal();
      window.dispatchEvent(new CustomEvent('sgl:authchange', { detail: null }));
    } catch (error) {
      if (status) { status.textContent = `Could not delete account: ${error.message}`; status.className = 'sgl-auth-status error'; }
      submit.disabled = false;
    }
  }

  async function loadSession() {
    try {
      const data = await request('/auth/me');
      state.apiOnline = true;
      state.user = data.user || null;
      state.csrfToken = data.csrfToken || '';
    } catch (_) {
      state.apiOnline = false;
      document.getElementById('sgl-api-offline').hidden = false;
    }
    updateButtons();
    renderProfile();
    window.dispatchEvent(new CustomEvent('sgl:authchange', { detail: state.user }));
  }

  function init() {
    document.body.insertAdjacentHTML('beforeend', modalMarkup());
    document.querySelectorAll('[data-sgl-account]').forEach(button => button.addEventListener('click', () => openModal('login')));
    document.querySelectorAll('[data-sgl-close]').forEach(button => button.addEventListener('click', closeModal));
    document.querySelectorAll('[data-auth-tab]').forEach(button => button.addEventListener('click', () => setTab(button.dataset.authTab)));
    document.querySelectorAll('.sgl-show-pass').forEach(button => button.addEventListener('click', () => {
      const input = button.parentElement.querySelector('input');
      input.type = input.type === 'password' ? 'text' : 'password';
      button.textContent = input.type === 'password' ? 'SHOW' : 'HIDE';
    }));
    document.getElementById('sgl-login-form').addEventListener('submit', event => submitAuth(event, 'login'));
    document.getElementById('sgl-register-form').addEventListener('submit', event => submitAuth(event, 'register'));
    document.getElementById('sgl-recover-form').addEventListener('submit', event => submitAuth(event, 'recover'));
    document.addEventListener('keydown', event => { if (event.key === 'Escape') closeModal(); });
    loadSession();
  }

  window.SushiID = { open: openModal, get user() { return state.user; }, request };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
