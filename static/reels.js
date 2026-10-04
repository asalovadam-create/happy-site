/* Happy TV — лента коротких видео (для покупателей) и раздел «Видео» (для админки) */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const S = () => (typeof State !== 'undefined' ? State : null);
  const short = n => { n = +n || 0; return n >= 1e6 ? (n / 1e6).toFixed(1).replace('.0', '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1).replace('.0', '') + 'K' : String(n); };
  const track = (t, n, m) => { try { window.htTrack && window.htTrack(t, n, m); } catch (e) {} };
  const vidId = () => { try { return localStorage.getItem('ht_vid') || ''; } catch (e) { return ''; } };
  const isCustomer = () => { const s = S(); return !!(s && s.user && s.user.role === 'customer'); };
  const isAdmin = () => { const s = S(); return !!(s && s.user && s.user.role === 'admin'); };
  const say = (m, t) => { if (typeof toast === 'function') toast(m, t); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const timeAgo = iso => {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    return s < 60 ? 'только что' : s < 3600 ? Math.round(s / 60) + ' мин' : s < 86400 ? Math.round(s / 3600) + ' ч' : Math.round(s / 86400) + ' дн';
  };

  // ── SVG-иконки (никаких эмодзи) ──
  const sv = (body, cls) => `<svg class="${cls || ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const HEART = '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>';
  const I = {
    heart: sv(HEART),
    heartFill: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${HEART}</svg>`,
    chat: sv('<path d="M20.66 17a9.99 9.99 0 1 0-3.6 3.62L22 22z"/>'),
    eye: sv('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
    play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
    volOn: sv('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>'),
    volOff: sv('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>'),
    trash: sv('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>'),
    send: sv('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'),
    close: sv('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
    film: sv('<rect x="2" y="2" width="20" height="20" rx="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/>'),
    plus: sv('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
    clock: sv('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
    check: sv('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>'),
    alert: sv('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'),
    info: sv('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'),
    up: sv('<polyline points="18 15 12 9 6 15"/>'),
    video: sv('<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>'),
  };
  const ic = (name, tone) => `<span class="ic ${tone || ''}">${I[name]}</span>`;

  // ═══════════════ ЛЕНТА ДЛЯ ПОКУПАТЕЛЕЙ ═══════════════
  const AHEAD = 15;     // секунд видео, которые прогружаем вперёд, прежде чем начинать качать следующее
  const R = { items: [], cur: null, muted: true, root: null, scroller: null, io: null, counted: new Set(), watched: {}, last: {}, armed: {}, tapT: 0, lastTap: { t: 0, i: -1 }, onKey: null, onVis: null };

  const slideEl = i => R.scroller && R.scroller.querySelector(`.reel[data-i="${i}"]`);
  const vEl = i => { const s = slideEl(i); return s && s.querySelector('video'); };

  function slideHtml(it, i) {
    return `<section class="reel loading" data-i="${i}" data-id="${it.id}">
      <div class="reel-media" style="background-image:url('${esc(it.poster_url)}')">
        <video class="reel-video" playsinline webkit-playsinline muted loop preload="none" disablepictureinpicture poster="${esc(it.poster_url)}"></video>
      </div>
      <div class="reel-spin"></div><div class="reel-tap"></div><div class="reel-grad"></div>
      <div class="reel-pause">${I.play}</div><div class="reel-heart">${I.heartFill}</div>
      <div class="reel-info">
        ${it.is_new ? '<span class="reel-new">Новое</span>' : ''}
        ${it.title ? `<div class="reel-title">${esc(it.title)}</div>` : ''}
        ${it.caption ? `<div class="reel-cap" data-act="cap">${esc(it.caption)}</div>` : ''}
      </div>
      <div class="reel-actions">
        <button class="ra like ${it.liked ? 'on' : ''}" data-act="like" aria-label="Нравится"><span class="ico">${I.heart}</span><b data-k="likes">${short(it.likes)}</b></button>
        <button class="ra" data-act="comments" aria-label="Комментарии"><span class="ico">${I.chat}</span><b data-k="comments">${short(it.comments)}</b></button>
        ${isAdmin() ? `<div class="ra static" title="Просмотры (видит только админ)"><span class="ico">${I.eye}</span><b data-k="views">${short(it.views)}</b></div>` : ''}
      </div>
      <div class="reel-bar"><i></i></div></section>`;
  }

  window.renderReels = async function () {
    const mc = $('mainContent');
    if (!mc) return;
    window.stopReels && window.stopReels();
    mc.innerHTML = '<div class="reels" id="reels"><div class="reels-load"><div class="spin"></div></div></div>';
    R.root = $('reels');
    try {
      const j = await API.get('/api/reels/feed?vid=' + encodeURIComponent(vidId()));
      R.items = j.items || [];
    } catch (e) {
      R.root.innerHTML = `<div class="reels-empty"><div class="big-ico">${I.alert}</div><h3>Не удалось загрузить</h3><p>${esc(e.message || 'Проверьте интернет')}</p><button class="rbtn" data-act="restart">Повторить</button></div>`;
      bind(); return;
    }
    if (!R.items.length) {
      R.root.innerHTML = `<div class="reels-empty"><div class="big-ico">${I.film}</div><h3>Скоро здесь появятся видео</h3><p>Мы готовим для вас новинки и обзоры игрушек. Загляните позже!</p></div>`;
      return;
    }
    const hint = (() => { try { return !localStorage.getItem('ht_reels_hint'); } catch (e) { return false; } })();
    R.root.innerHTML = `<div class="reels-top"><div class="reels-brand">Happy <span>TV</span></div>
        <button class="reels-mute" id="reelsMute" aria-label="Звук">${R.muted ? I.volOff : I.volOn}</button></div>
      <div class="reels-scroll" id="reelsScroll">${R.items.map(slideHtml).join('')}
        <section class="reel reel-end" data-i="${R.items.length}"><div class="big-ico">${I.check}</div><h3>Вы посмотрели всё!</h3>
          <p>Загляните позже — мы регулярно добавляем новые видео.</p><button class="rbtn" data-act="restart">Смотреть сначала</button></section></div>
      ${hint && R.items.length > 1 ? `<div class="reels-hint">${I.up}<span>Листайте вверх</span></div>` : ''}
      <div id="rcLayer"></div>`;
    try { localStorage.setItem('ht_reels_hint', '1'); } catch (e) {}
    R.scroller = $('reelsScroll'); R.cur = null; R.counted = new Set(); R.watched = {}; R.last = {}; R.armed = {};
    bind();
    R.io = new IntersectionObserver(es => es.forEach(en => { if (en.isIntersecting && en.intersectionRatio >= 0.65) activate(+en.target.dataset.i); }),
      { root: R.scroller, threshold: [0.65] });
    R.scroller.querySelectorAll('.reel').forEach(el => R.io.observe(el));
    activate(0);
  };

  function bind() {
    R.root.onclick = onClick;
    R.root.addEventListener('timeupdate', onTime, true);
    R.root.addEventListener('progress', e => { const v = e.target; if (v && v.tagName === 'VIDEO') checkArm(v); }, true);
    R.root.addEventListener('loadedmetadata', e => {
      const v = e.target, s = v.closest && v.closest('.reel');
      if (s && v.videoWidth && v.videoWidth / v.videoHeight > 0.75) s.classList.add('fit-contain');   // широкое видео: без обрезки, на размытом фоне
    }, true);
    R.root.addEventListener('loadeddata', e => { const s = e.target.closest && e.target.closest('.reel'); if (s) { s.classList.add('ready'); s.classList.remove('loading'); } }, true);
    R.root.addEventListener('playing', e => { const s = e.target.closest && e.target.closest('.reel'); if (s) { s.classList.add('ready'); s.classList.remove('loading', 'paused'); } }, true);
    R.root.addEventListener('waiting', e => { const s = e.target.closest && e.target.closest('.reel'); if (s && s.dataset.i == R.cur) s.classList.add('loading'); }, true);
    if (!R.onKey) {
      R.onKey = e => {
        if (!R.scroller || !document.body.classList.contains('reels-on')) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); R.scroller.scrollBy({ top: (e.key === 'ArrowDown' ? 1 : -1) * R.scroller.clientHeight, behavior: 'smooth' }); }
        if (e.key === ' ' && R.cur != null) { e.preventDefault(); togglePause(R.cur); }
      };
      document.addEventListener('keydown', R.onKey);
      R.onVis = () => {
        if (!R.scroller || R.cur == null) return;
        const v = vEl(R.cur); if (!v) return;
        if (document.hidden) v.pause(); else if (document.body.classList.contains('reels-on')) playVideo(R.cur);
      };
      document.addEventListener('visibilitychange', R.onVis);
    }
  }

  window.stopReels = function () {
    if (R.io) { R.io.disconnect(); R.io = null; }
    if (R.scroller) R.scroller.querySelectorAll('video').forEach(v => { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {} });
    if (R.onKey) { document.removeEventListener('keydown', R.onKey); R.onKey = null; }
    if (R.onVis) { document.removeEventListener('visibilitychange', R.onVis); R.onVis = null; }
    R.root = null; R.scroller = null; R.cur = null;
  };

  // ── поэтапная загрузка: сначала только текущее видео, затем (когда прогружено ~15 с вперёд) — следующее ──
  function loadSrc(i) {
    const v = vEl(i); if (!v || v.getAttribute('src') || !R.items[i]) return;
    v.preload = 'auto'; v.src = R.items[i].video_url;
  }
  function unloadSrc(i) {
    const v = vEl(i); if (!v || !v.getAttribute('src')) return;
    try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {}     // обрываем скачивание — не тратим трафик и канал
    const s = slideEl(i); if (s) { s.classList.remove('ready', 'paused'); s.classList.add('loading'); }
    delete R.armed[i];
  }
  const aheadOf = v => {
    const t = v.currentTime, b = v.buffered;
    for (let k = 0; k < b.length; k++) if (b.start(k) <= t + 0.5 && b.end(k) >= t) return b.end(k) - t;
    return 0;
  };
  function checkArm(v) {
    const s = v.closest('.reel'); if (!s) return;
    const i = +s.dataset.i; if (i !== R.cur || R.armed[i]) return;
    const dur = v.duration;
    if (!dur || !isFinite(dur)) return;
    const need = Math.min(AHEAD, Math.max(0, dur - v.currentTime - 0.3));
    if (aheadOf(v) >= need) { R.armed[i] = true; if (i + 1 < R.items.length) loadSrc(i + 1); }
  }

  function activate(i) {
    if (R.cur === i || !R.scroller) return;
    const prev = R.cur; R.cur = i;
    if (prev != null) { const pv = vEl(prev); if (pv) pv.pause(); }
    for (let j = 0; j < R.items.length; j++) {
      if (j === i) continue;
      const v = vEl(j);
      if (j === i + 1 && v && v.getAttribute('src')) continue;      // уже подгружено заранее — оставляем
      unloadSrc(j);                                                 // остальное выгружаем, чтобы не качать лишнее
    }
    if (i < R.items.length) {
      const bar = slideEl(i).querySelector('.reel-bar i'); if (bar) bar.style.width = '0'; R.last[i] = 0;
      playVideo(i);
      const v = vEl(i); if (v) checkArm(v);
    }
  }

  function playVideo(i) {
    const v = vEl(i); if (!v) return;
    loadSrc(i);
    v.muted = R.muted;
    const p = v.play();
    if (p && p.catch) p.catch(() => {
      if (!v.muted) { R.muted = true; v.muted = true; syncMute(); const q = v.play(); if (q && q.catch) q.catch(() => {}); }
    });
  }
  function syncMute() { const b = $('reelsMute'); if (b) b.innerHTML = R.muted ? I.volOff : I.volOn; }

  function togglePause(i) {
    const v = vEl(i), s = slideEl(i); if (!v) return;
    if (v.paused) { playVideo(i); s.classList.remove('paused'); } else { v.pause(); s.classList.add('paused'); }
  }

  function onTime(e) {
    const v = e.target; if (!v || v.tagName !== 'VIDEO') return;
    const s = v.closest('.reel'); if (!s) return;
    const i = +s.dataset.i; if (i !== R.cur) return;
    const bar = s.querySelector('.reel-bar i');
    if (bar && v.duration) bar.style.width = (v.currentTime / v.duration * 100) + '%';
    const prev = R.last[i] || 0, d = v.currentTime - prev;
    R.last[i] = v.currentTime;
    if (d > 0 && d < 1.5) R.watched[i] = (R.watched[i] || 0) + d;
    const need = Math.min(2, (v.duration || 2) * 0.8);
    if ((R.watched[i] || 0) >= need && !R.counted.has(i)) countView(i);
    checkArm(v);
  }

  async function countView(i) {
    R.counted.add(i);
    const it = R.items[i]; if (!it) return;
    try {
      const j = await API.post(`/api/reels/${it.id}/view`, { vid: vidId() });
      if (j && j.views != null) { it.views = j.views; setStat(i, 'views', j.views); }       // число приходит только админу
      if (j && j.counted) track('reel_view', it.title || ('#' + it.id), { id: it.id });
    } catch (e) { /* просмотр не засчитался — не страшно */ }
  }
  function setStat(i, k, val) { const s = slideEl(i); const b = s && s.querySelector(`[data-k="${k}"]`); if (b) b.textContent = short(val); }

  function needLogin(msg) {
    if (isAdmin()) { say('Лайки и комментарии доступны покупателям', 'err'); return; }
    say(msg, 'err'); if (typeof openAuth === 'function') openAuth();
  }

  async function toggleLike(i) {
    const it = R.items[i]; if (!it) return;
    if (!isCustomer()) return needLogin('Войдите в аккаунт, чтобы ставить лайки');
    const btn = slideEl(i).querySelector('.ra.like');
    it.liked = !it.liked; it.likes += it.liked ? 1 : -1; btn.classList.toggle('on', it.liked); setStat(i, 'likes', it.likes);
    try {
      const j = await API.post(`/api/reels/${it.id}/like`, {});
      it.liked = j.liked; it.likes = j.likes; btn.classList.toggle('on', j.liked); setStat(i, 'likes', j.likes);
      if (j.liked) track('reel_like', it.title || ('#' + it.id), { id: it.id });
    } catch (e) {
      it.liked = !it.liked; it.likes += it.liked ? 1 : -1; btn.classList.toggle('on', it.liked); setStat(i, 'likes', it.likes);
      say(e.message || 'Не получилось', 'err');
    }
  }
  function doubleLike(i) {
    const h = slideEl(i).querySelector('.reel-heart');
    h.classList.remove('go'); void h.offsetWidth; h.classList.add('go');
    if (R.items[i] && !R.items[i].liked) toggleLike(i);
  }

  function onClick(e) {
    const act = e.target.closest('[data-act]');
    if (act) {
      const a = act.dataset.act, sl = act.closest('.reel'), i = sl ? +sl.dataset.i : R.cur;
      if (a === 'like') return toggleLike(i);
      if (a === 'comments') return openComments(i);
      if (a === 'cap') return act.classList.toggle('open');
      if (a === 'restart') return window.renderReels();
      return;
    }
    if (e.target.closest('#reelsMute')) {
      R.muted = !R.muted;
      const v = R.cur != null && vEl(R.cur);
      if (v) { v.muted = R.muted; if (!R.muted) { const p = v.play(); if (p && p.catch) p.catch(() => { R.muted = true; v.muted = true; }); } }
      syncMute(); return;
    }
    const tap = e.target.closest('.reel-tap');
    if (tap) {
      const i = +tap.closest('.reel').dataset.i, now = Date.now();
      if (now - R.lastTap.t < 280 && R.lastTap.i === i) { clearTimeout(R.tapT); R.lastTap.t = 0; doubleLike(i); }
      else { R.lastTap = { t: now, i }; R.tapT = setTimeout(() => togglePause(i), 280); }
    }
  }

  // ── комментарии ──
  function closeComments() { const l = $('rcLayer'); if (l) l.innerHTML = ''; }
  async function openComments(i) {
    const it = R.items[i]; if (!it) return;
    const layer = $('rcLayer'); if (!layer) return;
    const canWrite = isCustomer();
    layer.innerHTML = `<div class="rc-back" data-rc="close"></div><div class="rc-sheet">
      <div class="rc-head"><span>Комментарии · <span id="rcCount">${it.comments}</span></span><button class="rc-x" data-rc="close" aria-label="Закрыть">${I.close}</button></div>
      <div class="rc-list" id="rcList"><div class="rc-empty">Загрузка…</div></div>
      ${canWrite ? `<form class="rc-form" id="rcForm"><input id="rcIn" maxlength="300" placeholder="Добавить комментарий…" autocomplete="off"><button type="submit" aria-label="Отправить">${I.send}</button></form>`
        : `<div class="rc-login">Войдите, чтобы комментировать<br><button class="rbtn" data-rc="login">Войти</button></div>`}</div>`;
    layer.onclick = e => {
      const b = e.target.closest('[data-rc]'); if (b) { if (b.dataset.rc === 'close') closeComments(); if (b.dataset.rc === 'login') { closeComments(); needLogin('Войдите в аккаунт'); } return; }
      const d = e.target.closest('[data-del]'); if (d) delComment(i, +d.dataset.del);
    };
    const draw = items => {
      $('rcList').innerHTML = items.length ? items.map(c => `<div class="rc-item" id="rc${c.id}"><div class="rc-av">${esc((c.author || '?')[0].toUpperCase())}</div>
        <div><div class="rc-au">${esc(c.author)}<small>${timeAgo(c.created_at)}</small></div><div class="rc-tx">${esc(c.body)}</div></div>
        ${c.mine ? `<button class="rc-del" data-del="${c.id}" aria-label="Удалить">${I.trash}</button>` : '<span></span>'}</div>`).join('') : '<div class="rc-empty">Пока нет комментариев. Будьте первым!</div>';
    };
    try { draw((await API.get(`/api/reels/${it.id}/comments`)).items || []); } catch (e) { $('rcList').innerHTML = `<div class="rc-empty">${esc(e.message)}</div>`; }
    const f = $('rcForm');
    if (f) f.onsubmit = async ev => {
      ev.preventDefault();
      const inp = $('rcIn'), text = inp.value.trim(); if (!text) return;
      inp.disabled = true;
      try {
        const j = await API.post(`/api/reels/${it.id}/comments`, { body: text });
        inp.value = ''; it.comments = j.comments; setStat(i, 'comments', j.comments); $('rcCount').textContent = j.comments;
        const list = await API.get(`/api/reels/${it.id}/comments`); draw(list.items || []);
        track('reel_comment', it.title || ('#' + it.id), { id: it.id, text: text.slice(0, 80) });
      } catch (e) { say(e.message || 'Не отправилось', 'err'); }
      inp.disabled = false; inp.focus();
    };
  }
  async function delComment(i, cid) {
    try {
      await API.req('DELETE', `/api/reels/comments/${cid}`);
      const el = $('rc' + cid); if (el) el.remove();
      const it = R.items[i]; it.comments = Math.max(0, it.comments - 1); setStat(i, 'comments', it.comments); const c = $('rcCount'); if (c) c.textContent = it.comments;
      if (!$('rcList').children.length) $('rcList').innerHTML = '<div class="rc-empty">Пока нет комментариев. Будьте первым!</div>';
    } catch (e) { say(e.message || 'Не удалось удалить', 'err'); }
  }

  // ═══════════════ АДМИНКА: РАЗДЕЛ «ВИДЕО» ═══════════════
  const A = { items: [], busy: false, file: null, openCm: null, timer: null, fast: false, sig: '', tick: 0 };
  const fmtDur = s => { s = Math.round(+s || 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const fmtMb = b => (b / 1048576).toFixed(b > 10485760 ? 0 : 1) + ' МБ';

  window.initReelsAdmin = function () {
    const host = $('reelsAdmin'); if (!host) return;
    host.innerHTML = `<div class="rva"><div class="rva-h"><h3>${ic('film')}Видео для раздела Happy TV</h3><button class="rva-link" id="rvaRefresh">Обновить</button></div>
      <div class="rva-sub">Лучше всего вертикальное видео 9:16, до 100 МБ и до 3 минут. Мы сами сделаем формат 720×1280, сожмём без заметной потери качества и опубликуем, когда ролик будет готов к просмотру. Горизонтальные получат размытый фон по краям, как в TikTok.</div>
      <div class="rva-drop" id="rvaDrop"><b>${ic('plus')}Выберите видео</b><span>или перетащите файл сюда · MP4, MOV</span>
        <input type="file" id="rvaFile" accept="video/*" style="display:none"></div>
      <div class="rva-file" id="rvaInfo"></div>
      <input class="rva-in" id="rvaTitle" maxlength="80" placeholder="Название (необязательно)">
      <input class="rva-in" id="rvaCap" maxlength="300" placeholder="Описание (необязательно)">
      <button class="rva-btn" id="rvaGo" disabled>Загрузить и опубликовать</button>
      <div class="rva-prog" id="rvaProg"><div class="rva-bar"><i id="rvaBar"></i></div><div class="rva-msg" id="rvaMsg"></div></div>
      <div class="rva-list" id="rvaList"><div class="rva-empty">Загрузка…</div></div></div>`;
    const drop = $('rvaDrop'), inp = $('rvaFile');
    drop.onclick = () => !A.busy && inp.click();
    inp.onchange = () => pick(inp.files[0]);
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); pick(e.dataTransfer.files[0]); };
    $('rvaGo').onclick = upload;
    $('rvaRefresh').onclick = () => loadList();
    $('rvaList').onclick = onListClick;
    A.sig = '';
    loadList();
    clearInterval(A.timer);
    A.tick = 0;
    A.timer = setInterval(() => {
      if (!$('rvaList')) return clearInterval(A.timer);
      A.tick++;
      if (!document.hidden && !A.busy && (A.fast || A.tick % 6 === 0)) loadList(true);   // раз в 5 с, пока видео оптимизируется; иначе раз в 30 с
    }, 5000);
  };

  function probe(file) {
    return new Promise(res => {
      const v = document.createElement('video'); const url = URL.createObjectURL(file);
      v.preload = 'metadata'; v.muted = true;
      v.onloadedmetadata = () => { res({ d: v.duration, w: v.videoWidth, h: v.videoHeight }); URL.revokeObjectURL(url); };
      v.onerror = () => { res(null); URL.revokeObjectURL(url); };
      v.src = url;
    });
  }

  const note = (tone, icon, text) => `<span class="ic-line ${tone}">${ic(icon)}<span>${text}</span></span>`;

  async function pick(file) {
    if (!file) return;
    const info = $('rvaInfo'), go = $('rvaGo');
    A.file = null; go.disabled = true;
    if (!(file.type || '').startsWith('video/') && !/\.(mp4|mov|m4v|webm|mkv)$/i.test(file.name)) { info.className = 'rva-file on'; info.innerHTML = note('err', 'alert', 'Это не видеофайл'); return; }
    if (file.size > 100 * 1048576) { info.className = 'rva-file on'; info.innerHTML = note('err', 'alert', `Файл слишком большой (${fmtMb(file.size)}). Максимум — 100 МБ.`); return; }
    const m = await probe(file);
    if (m && m.d > 183) { info.className = 'rva-file on'; info.innerHTML = note('err', 'alert', `Видео длиннее 3 минут (${fmtDur(m.d)}). Сократите ролик.`); return; }
    const ratio = m && m.w && m.h ? m.w / m.h : 0;
    const fmtNote = !m ? '' : (Math.abs(ratio - 9 / 16) < 0.03 ? note('ok', 'check', 'Формат 9:16 — идеально') : ratio > 1 ? note('info', 'info', 'Горизонтальное: добавим размытый фон по краям') : note('info', 'info', 'Формат отличается от 9:16: добавим размытые поля'));
    const big = file.size > 50 * 1048576 ? note('warn', 'alert', 'Большой файл — загрузка займёт время. Для скорости снимайте в Full HD (1080p), а не в 4K') : '';
    A.file = file;
    info.className = 'rva-file on';
    info.innerHTML = `<span class="ic-line">${ic('video')}<span>${esc(file.name)}</span></span><small>${fmtMb(file.size)}${m ? ` · ${fmtDur(m.d)} · ${m.w}×${m.h}` : ''}</small>${fmtNote}${big}`;
    go.disabled = false;
    if (!$('rvaTitle').value) $('rvaTitle').value = file.name.replace(/\.[^.]+$/, '').slice(0, 80);
  }

  function setProg(pct, html, cls, pulse) {
    const prog = $('rvaProg'); if (!prog) return;
    prog.classList.add('on');
    const bar = $('rvaBar'); bar.className = pulse ? 'pulse' : ''; if (!pulse) bar.style.width = pct + '%';
    const m = $('rvaMsg'); m.innerHTML = html; m.className = 'rva-msg ' + (cls || '');
  }

  async function upload() {
    if (A.busy || !A.file) return;
    A.busy = true; $('rvaGo').disabled = true; $('rvaDrop').style.opacity = .5;
    const title = $('rvaTitle').value.trim(), caption = $('rvaCap').value.trim();
    try {
      setProg(2, 'Подготовка…');
      const sig = await API.post('/api/admin/reels/sign', {});
      const fd = new FormData();
      fd.append('file', A.file); fd.append('api_key', sig.api_key); fd.append('timestamp', sig.timestamp);
      fd.append('signature', sig.signature); fd.append('folder', sig.folder);
      const t0 = Date.now();
      const up = await new Promise((ok, fail) => {
        const x = new XMLHttpRequest();
        x.open('POST', `https://api.cloudinary.com/v1_1/${sig.cloud_name}/video/upload`);
        x.upload.onprogress = e => {
          if (!e.lengthComputable) return;
          const sec = Math.max(0.5, (Date.now() - t0) / 1000), speed = e.loaded / sec;           // байт/с
          const left = Math.max(0, Math.round((e.total - e.loaded) / Math.max(speed, 1)));
          setProg(Math.round(e.loaded / e.total * 95), `Загрузка видео… ${Math.round(e.loaded / e.total * 100)}% · ${(speed * 8 / 1e6).toFixed(1)} Мбит/с · осталось ~${left} с`);
        };
        x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch (e) {} x.status < 300 && j.public_id ? ok(j) : fail(new Error((j.error && j.error.message) || 'Не удалось загрузить видео')); };
        x.onerror = () => fail(new Error('Нет соединения при загрузке'));
        x.send(fd);
      });
      const upSec = Math.round((Date.now() - t0) / 1000);
      setProg(97, 'Сохраняем и запускаем оптимизацию…');
      await API.post('/api/admin/reels', { public_id: up.public_id, title, caption });
      setProg(100, note('ok', 'check', `Загружено за ${upSec} с. Видео оптимизируется в фоне и появится в ленте само (обычно 1–3 минуты). Можно загружать следующее.`), 'ok');
      A.file = null; $('rvaInfo').className = 'rva-file'; $('rvaTitle').value = ''; $('rvaCap').value = ''; $('rvaFile').value = '';
      A.busy = false; $('rvaDrop').style.opacity = 1;      // форма свободна сразу — можно выбирать следующее видео
      A.sig = ''; loadList();
    } catch (e) {
      setProg(0, note('err', 'alert', esc(e.message || 'Ошибка')), 'err');
      $('rvaGo').disabled = !A.file;
    }
    A.busy = false; $('rvaDrop').style.opacity = 1;
  }

  async function loadList(silent) {
    const list = $('rvaList'); if (!list) return;
    let items;
    try { items = (await API.get('/api/admin/reels')).items || []; } catch (e) { if (!silent) list.innerHTML = `<div class="rva-empty">${esc(e.message)}</div>`; return; }
    A.fast = items.some(r => r.status === 'processing');
    const sg = JSON.stringify(items.map(r => [r.id, r.status, r.views, r.likes, r.comments, r.is_published, r.title]));
    if (silent && sg === A.sig) return;            // ничего не изменилось — не трогаем (чтобы не сбрасывать просмотр ролика)
    A.sig = sg; A.items = items;
    if (!A.items.length) { list.innerHTML = '<div class="rva-empty">Пока нет видео. Загрузите первое — оно появится в ленте у покупателей, как только будет готово.</div>'; return; }
    list.innerHTML = A.items.map(r => `<div class="rva-card ${r.is_published ? '' : 'off'}" data-id="${r.id}">
      <div class="rva-poster" id="rvp${r.id}" style="background-image:url('${esc(r.poster_url)}')">
        ${r.status === 'processing' ? `<span class="st proc">${ic('clock')}Оптимизируется</span>` : r.status === 'failed' ? '<span class="st off">Ошибка обработки</span>' : `<span class="st ${r.is_published ? '' : 'off'}">${r.is_published ? 'Опубликовано' : 'Скрыто'}</span>`}<span class="dur">${fmtDur(r.duration)}</span>
        ${r.status === 'ready' ? `<button class="play" data-a="play" aria-label="Смотреть">${I.play}</button>` : ''}</div>
      <div class="rva-body"><div class="rva-t">${esc(r.title || 'Без названия')}</div>
        <div class="rva-d">${new Date(r.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${fmtMb(r.bytes || 0)}</div>
        <div class="rva-stats"><div class="rva-s"><b>${short(r.views)}</b><span>просмотры</span></div><div class="rva-s"><b>${short(r.likes)}</b><span>лайки</span></div><div class="rva-s"><b>${short(r.comments)}</b><span>комментарии</span></div></div>
        <div class="rva-split">просмотры: аккаунтов ${r.views_accounts} · гостей ${r.views_guests}</div>
        <div class="rva-acts"><button data-a="cm">${ic('chat')}Комментарии</button>${r.status === 'ready' ? `<button data-a="pub">${r.is_published ? 'Скрыть' : 'Показать'}</button>` : ''}<button data-a="del" class="del">${ic('trash')}Удалить</button></div>
        <div id="rvc${r.id}"></div></div></div>`).join('');
    if (A.openCm) openCm(A.openCm);
  }

  async function openCm(id) {
    const box = $('rvc' + id); if (!box) return;
    A.openCm = id;
    try {
      const j = await API.get(`/api/admin/reels/${id}/comments`);
      box.innerHTML = `<div class="rva-cm">${j.items.length ? j.items.map(c => `<div class="rva-c" id="rvcm${c.id}"><div><b>${esc(c.author || 'Покупатель')}</b> <small>${esc(c.email || c.phone || '')} · ${timeAgo(c.created_at)} назад</small>${esc(c.body)}</div><button data-a="delcm" data-cid="${c.id}" aria-label="Удалить">${I.trash}</button></div>`).join('') : '<div class="rva-empty" style="padding:8px">Комментариев нет</div>'}</div>`;
    } catch (e) { box.innerHTML = `<div class="rva-empty" style="padding:8px">${esc(e.message)}</div>`; }
  }

  async function onListClick(e) {
    const b = e.target.closest('[data-a]'); if (!b) return;
    const card = b.closest('.rva-card'), id = +card.dataset.id, a = b.dataset.a;
    try {
      if (a === 'play') {
        const r = A.items.find(x => x.id === id), p = $('rvp' + id);
        p.innerHTML = `<video src="${esc(r.video_url)}" controls autoplay playsinline></video>`; return;
      }
      if (a === 'cm') { if (A.openCm === id) { A.openCm = null; $('rvc' + id).innerHTML = ''; } else { if (A.openCm) { const o = $('rvc' + A.openCm); if (o) o.innerHTML = ''; } openCm(id); } return; }
      if (a === 'pub') { const r = A.items.find(x => x.id === id); await API.req('PATCH', `/api/admin/reels/${id}`, { is_published: !r.is_published }); say(r.is_published ? 'Видео скрыто' : 'Видео опубликовано'); A.sig = ''; return loadList(); }
      if (a === 'del') {
        if (!confirm('Удалить видео безвозвратно вместе с лайками и комментариями?')) return;
        await API.req('DELETE', `/api/admin/reels/${id}`); say('Видео удалено'); if (A.openCm === id) A.openCm = null; A.sig = ''; return loadList();
      }
      if (a === 'delcm') { await API.req('DELETE', `/api/admin/reels/comments/${b.dataset.cid}`); const el = $('rvcm' + b.dataset.cid); if (el) el.remove(); say('Комментарий удалён'); loadList(true); }
    } catch (err) { say(err.message || 'Ошибка', 'err'); }
  }
})();
