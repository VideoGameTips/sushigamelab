(() => {
  'use strict';

  const gameSelect = document.getElementById('game-select');
  const modeSelect = document.getElementById('mode-select');
  const body = document.getElementById('rank-body');
  const empty = document.getElementById('rank-empty');
  const title = document.getElementById('board-title');
  const subtitle = document.getElementById('board-subtitle');
  const badge = document.getElementById('verification-badge');
  const youCard = document.getElementById('you-card');
  let config = [];
  let period = 'week';

  const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[c]);

  function selectedGame() { return config.find(game => game.slug === gameSelect.value); }
  function selectedMode() { return selectedGame()?.modes.find(mode => mode.slug === modeSelect.value); }

  function formatValue(value, unit) {
    if (unit === 'time') {
      const seconds = Math.max(0, Number(value) || 0);
      return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }
    return Number(value || 0).toLocaleString();
  }

  function populateGames() {
    gameSelect.innerHTML = config.map(game => `<option value="${esc(game.slug)}">${esc(game.name)}</option>`).join('');
    gameSelect.value = config.some(game => game.slug === 'irontide') ? 'irontide' : config[0]?.slug || '';
    populateModes();
  }

  function populateModes() {
    const game = selectedGame();
    modeSelect.innerHTML = (game?.modes || []).map(mode => `<option value="${esc(mode.slug)}">${esc(mode.name)}</option>`).join('');
    loadBoard();
  }

  async function loadBoard() {
    const game = selectedGame();
    const mode = selectedMode();
    if (!game || !mode) return;
    title.textContent = `${game.name} · ${mode.name}`;
    subtitle.textContent = mode.description || 'Best score per player.';
    body.innerHTML = '<tr><td colspan="4" class="empty">Loading…</td></tr>';
    empty.hidden = true;
    youCard.classList.remove('visible');
    try {
      const data = await window.SushiID.request(`/leaderboards/${encodeURIComponent(game.slug)}/${encodeURIComponent(mode.slug)}?period=${period}&limit=100`);
      renderRows(data.entries || [], mode);
      badge.textContent = data.verification === 'verified' ? 'VERIFIED ✓' : 'COMMUNITY BETA';
      if (data.me) {
        youCard.innerHTML = `<span>Your position: <b>#${Number(data.me.rank)}</b> · ${esc(data.me.displayName)}</span><b>${formatValue(data.me.value, mode.unit)}</b>`;
        youCard.classList.add('visible');
      }
    } catch (error) {
      body.innerHTML = '';
      empty.hidden = false;
      empty.innerHTML = `<strong>Rankings are not online in this preview.</strong>${esc(error.message)}`;
    }
  }

  function renderRows(entries, mode) {
    body.innerHTML = '';
    empty.hidden = entries.length > 0;
    entries.forEach(entry => {
      const rank = Number(entry.rank);
      const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank;
      const date = entry.achievedAt ? new Date(entry.achievedAt).toLocaleDateString(undefined, { month:'short', day:'numeric' }) : '—';
      body.insertAdjacentHTML('beforeend', `<tr><td class="rank ${rank <= 3 ? 'top' : ''}">${medal}</td><td><span class="captain"><span class="avatar">${rank <= 3 ? '🍣' : '⚓'}</span>${esc(entry.displayName)}</span></td><td class="score">${formatValue(entry.value, mode.unit)}</td><td class="date">${esc(date)}</td></tr>`);
    });
  }

  async function init() {
    try {
      const data = await window.SushiID.request('/leaderboards/config');
      config = data.games || [];
      populateGames();
    } catch (error) {
      title.textContent = 'Leaderboard server unavailable';
      subtitle.textContent = 'The games still work normally as a guest.';
      body.innerHTML = '';
      empty.hidden = false;
    }
  }

  gameSelect.addEventListener('change', populateModes);
  modeSelect.addEventListener('change', loadBoard);
  document.querySelectorAll('[data-period]').forEach(button => button.addEventListener('click', () => {
    period = button.dataset.period;
    document.querySelectorAll('[data-period]').forEach(other => other.classList.toggle('active', other === button));
    loadBoard();
  }));
  window.addEventListener('sgl:authchange', loadBoard);
  window.addEventListener('DOMContentLoaded', init);
})();
