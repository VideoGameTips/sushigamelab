(() => {
  'use strict';

  // The page shows every board there is, grouped by game, rather than making you pick a
  // game and then a challenge before anything appears. A game with three challenges shows
  // three cards side by side under one heading; the games nobody has posted to yet fold
  // away at the bottom, so eight empty ones do not bury the two that are alive.

  const sections = document.getElementById('sections');
  const status = document.getElementById('page-status');
  const quietZone = document.getElementById('quiet-zone');
  const quietGrid = document.getElementById('quiet-grid');
  const quietToggle = document.getElementById('quiet-toggle');
  const quietCount = document.getElementById('quiet-count');
  const jumpBtn = document.getElementById('jump-btn');
  const jumpPanel = document.getElementById('jump-panel');
  const jumpList = document.getElementById('jump-list');
  const jumpSearch = document.getElementById('jump-search');
  const jumpLabel = document.getElementById('jump-label');

  const TOP_N = 5;
  let config = [];
  let period = 'week';
  let loadToken = 0;

  const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[c]);

  // Every game is served at /<slug>/ — battle-sim's bare directory is redirected by the
  // reverse proxy, so this holds for all ten. Deriving it beats a slug -> URL table that
  // nobody would remember to update when a game is added.
  const playUrl = game => `/${encodeURIComponent(game.slug)}/`;

  function formatValue(value, unit) {
    if (unit === 'time') {
      const seconds = Math.max(0, Number(value) || 0);
      return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }
    return Number(value || 0).toLocaleString();
  }

  function rowHtml(entry, mode, mine) {
    const rank = Number(entry.rank);
    const badge = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank;
    return `<div class="row${mine ? ' me' : ''}"><span class="pos">${badge}</span>` +
      `<span class="who">${esc(entry.displayName)}</span>` +
      `<span class="val">${formatValue(entry.value, mode.unit)}</span></div>`;
  }

  function cardHtml(mode, board) {
    const entries = board?.entries || [];
    const verified = entries.some(entry => entry.verification === 'verified');
    const meRank = Number(board?.me?.rank || 0);
    const body = entries.length
      ? `<div class="rows">${entries.slice(0, TOP_N).map(e => rowHtml(e, mode, meRank === Number(e.rank))).join('')}` +
        // Below the cut but on the board: show their own line too, so being 40th still
        // means seeing yourself rather than seeing nothing.
        (meRank > TOP_N ? rowHtml(board.me, mode, true) : '') + '</div>'
      : '<div class="card-empty"><b>No scores yet</b>Be the first captain here.</div>';
    return `<article class="board-card${entries.length ? '' : ' is-empty'}">` +
      `<div class="card-head"><h3>${esc(mode.name)}</h3><p>${esc(mode.description || '')}</p>` +
      `<span class="card-badge${verified ? ' verified' : ''}">${verified ? 'VERIFIED ✓' : 'COMMUNITY'}</span></div>` +
      body + '</article>';
  }

  function sectionHtml(game, boards) {
    const live = boards.filter(b => b.board?.entries?.length).length;
    return `<section class="game-section" id="game-${esc(game.slug)}">` +
      `<div class="game-head"><h2>${esc(game.name)}</h2>` +
      `<span class="count">${game.modes.length} BOARD${game.modes.length === 1 ? '' : 'S'}` +
        `${live ? ` · ${live} ACTIVE` : ''}</span><span class="spacer"></span>` +
      `<a class="play-link" href="${playUrl(game)}">▶ PLAY</a></div>` +
      `<div class="board-grid">${boards.map(b => cardHtml(b.mode, b.board)).join('')}</div>` +
      '</section>';
  }

  function quietCardHtml(game) {
    return `<a class="quiet-card" href="${playUrl(game)}"><span><b>${esc(game.name)}</b>` +
      `<span>${game.modes.length} board${game.modes.length === 1 ? '' : 's'} · be the first</span></span>` +
      '<span class="caret">▶</span></a>';
  }

  async function fetchBoard(game, mode) {
    try {
      const data = await window.SushiID.request(
        `/leaderboards/${encodeURIComponent(game.slug)}/${encodeURIComponent(mode.slug)}?period=${period}&limit=${TOP_N + 1}`);
      return { mode, board: data };
    } catch (error) {
      // One board failing must not blank the page; it simply renders as empty.
      return { mode, board: null };
    }
  }

  async function loadAll() {
    const token = ++loadToken;
    status.hidden = false;
    status.textContent = 'Loading rankings…';
    sections.innerHTML = '';
    quietZone.hidden = true;

    // Every board at once. Thirteen small requests in parallel beats thirteen round
    // trips, and seeing them together is the entire point of the page.
    const results = await Promise.all(config.map(async game => ({
      game, boards: await Promise.all(game.modes.map(mode => fetchBoard(game, mode))),
    })));
    if (token !== loadToken) return;      // a newer period was chosen while this was in flight

    const hasScores = r => r.boards.some(b => b.board?.entries?.length);
    const active = results.filter(hasScores);
    const quiet = results.filter(r => !hasScores(r));

    sections.innerHTML = active.map(r => sectionHtml(r.game, r.boards)).join('');

    if (quiet.length) {
      quietCount.textContent = active.length
        ? `${quiet.length} more game${quiet.length === 1 ? '' : 's'} with no scores yet`
        : `All ${quiet.length} games are waiting for a first score`;
      quietGrid.innerHTML = quiet.map(r => quietCardHtml(r.game)).join('');
      quietZone.hidden = false;
      // With nothing live anywhere, the fold IS the page — open it, rather than showing
      // an empty page with the games hidden behind another click.
      setQuiet(active.length === 0);
    }

    status.hidden = Boolean(active.length || quiet.length);
    if (!active.length && !quiet.length) status.textContent = 'No games are configured yet.';
    buildJumpList();
  }

  function setQuiet(open) {
    quietGrid.hidden = !open;
    quietToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    quietToggle.querySelector('.caret').textContent = open ? '▴' : '▾';
  }

  // ---- jump menu -------------------------------------------------------------------
  // Ten games is already past what reads as a row of buttons, and the list only grows.
  // One searchable control keeps the toolbar quiet and still works at thirty.

  function buildJumpList(filter = '') {
    const needle = filter.trim().toLowerCase();
    const matches = config.filter(game => !needle || game.name.toLowerCase().includes(needle));
    jumpList.innerHTML = matches.length
      ? matches.map(game => `<button class="jump-item" data-slug="${esc(game.slug)}" role="option">` +
          `<span>${esc(game.name)}</span><span class="n">${game.modes.length}</span></button>`).join('')
      : '<div class="jump-empty">No game by that name.</div>';
  }

  function openJump(open) {
    jumpPanel.hidden = !open;
    jumpBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { jumpSearch.value = ''; buildJumpList(); jumpSearch.focus(); }
  }

  function jumpTo(slug) {
    openJump(false);
    const game = config.find(item => item.slug === slug);
    const target = document.getElementById(`game-${slug}`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (game) {
      // No scores yet, so it lives in the folded section rather than on the page.
      setQuiet(true);
      quietZone.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (game) jumpLabel.textContent = game.name;
  }

  async function init() {
    try {
      const data = await window.SushiID.request('/leaderboards/config');
      config = data.games || [];
      await loadAll();
    } catch (error) {
      status.hidden = false;
      status.textContent = 'Rankings are offline right now — every game still plays normally as a guest.';
    }
  }

  document.querySelectorAll('[data-period]').forEach(button => button.addEventListener('click', () => {
    period = button.dataset.period;
    document.querySelectorAll('[data-period]').forEach(other => {
      const on = other === button;
      other.classList.toggle('active', on);
      other.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    loadAll();
  }));

  quietToggle.addEventListener('click', () => setQuiet(quietGrid.hidden));
  jumpBtn.addEventListener('click', () => openJump(jumpPanel.hidden));
  jumpSearch.addEventListener('input', () => buildJumpList(jumpSearch.value));
  jumpList.addEventListener('click', event => {
    const item = event.target.closest('.jump-item');
    if (item) jumpTo(item.dataset.slug);
  });
  document.addEventListener('click', event => {
    if (!jumpPanel.hidden && !event.target.closest('.jump')) openJump(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !jumpPanel.hidden) { openJump(false); jumpBtn.focus(); }
  });

  window.addEventListener('sgl:authchange', loadAll);
  window.addEventListener('DOMContentLoaded', init);
})();
