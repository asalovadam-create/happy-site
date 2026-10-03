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
  const say = (m, t) => { if (typeof toast === 'function') toast(m, t); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const timeAgo = iso => {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    return s < 60 ? 'только что' : s < 3600 ? Math.round(s / 60) + ' мин' : s < 86400 ? Math.round(s / 3600) + ' ч' : Math.round(s / 86400) + ' дн';
  };

  const I = {
    heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 00-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 000-7.8z"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 01-9 8.4 8.5 8.5 0 01-3.8-.9L3 20l1.1-5A8.4 8.4 0 1121 11.5z"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
    on: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 010 7M19 5a10 10 0 010 14"/></svg>',
    off: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/></svg>',
  };

  // ═══════════════ ЛЕНТА ДЛЯ ПОКУПАТЕЛЕЙ ═══════════════
  const R = { items: [], cur: null, muted: true, root: null, scroller: null, io: null, counted: new Set(), watched: {}, last: {}, tapT: 0, lastTap: { t: 0, i: -1 }, onKey: null, onVis: null };

  const slideEl = i => R.scroller && R.scroller.querySelector(`.reel[data-i="${i}"]`);
  const vEl = i => { const s = slideEl(i); return s && s.querySelector('video'); };

  function slideHtml(it, i) {
    return `<section class="reel loading" data-i="${i}" data-id="${it.id}">
      <div class="reel-media" style="background-image:url('${esc(it.poster_url)}')">
        <video class="reel-video" playsinline webkit-playsinline muted loop preload="none" disablepictureinpicture poster="${esc(it.poster_url)}"></video>
      </div>
      <div class="reel-spin"></div><div class="reel-tap"></div><div class="reel-grad"></div>
      <div class="reel-pause">${I.play}</div><div class="reel-heart">❤️</div>
      <div class="reel-info">
        ${it.is_new ? '<span class="reel-new">Новое</span>' : ''}
        ${it.title ? `<div class="reel-title">${esc(it.title)}</div>` : ''}
        ${it.caption ? `<div class="reel-cap" data-act="cap">${esc(it.caption)}</div>` : ''}
      </div>
      <div class="reel-actions">
        <button class="ra like ${it.liked ? 'on' : ''}" data-act="like"><span class="ico">${I.heart}</span><b data-k="likes">${short(it.likes)}</b></button>
        <button class="ra" data-act="comments"><span class="ico">${I.chat}</span><b data-k="comments">${short(it.comments)}</b></button>
        <div class="ra static"><span class="ico">${I.eye}</span><b data-k="views">${short(it.views)}</b></div>
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
      R.root.innerHTML = `<div class="reels-empty"><div class="big">😕</div><h3>Не удалось загрузить</h3><p>${esc(e.message || 'Проверьте интернет')}</p><button class="rbtn" data-act="restart">Повторить</button></div>`;
      bind(); return;
    }
    if (!R.items.length) {
      R.root.innerHTML = '<div class="reels-empty"><div class="big">🎬</div><h3>Скоро здесь появятся видео</h3><p>Мы готовим для вас новинки и обзоры игрушек. Загляните позже!</p></div>';
      return;
    }
    const hint = (() => { try { return !localStorage.getItem('ht_reels_hint'); } catch (e) { return false; } })();
    R.root.innerHTML = `<div class="reels-top"><div class="reels-brand">Happy <span>TV</span></div>
        <button class="reels-mute" id="reelsMute" aria-label="Звук">${R.muted ? I.off : I.on}</button></div>
      <div class="reels-scroll" id="reelsScroll">${R.items.map(slideHtml).join('')}
        <section class="reel reel-end" data-i="${R.items.length}"><div class="big">🎉</div><h3>Вы посмотрели всё!</h3>
          <p>Загляните позже — мы регулярно добавляем новые видео.</p><button class="rbtn" data-act="restart">Смотреть сначала</button></section></div>
      ${hint && R.items.length > 1 ? '<div class="reels-hint">Листайте вверх ↑</div>' : ''}
      <div id="rcLayer"></div>`;
    try { localStorage.setItem('ht_reels_hint', '1'); } catch (e) {}
    R.scroller = $('reelsScroll'); R.cur = null; R.counted = new Set(); R.watched = {}; R.last = {};
    bind();
    R.io = new IntersectionObserver(es => es.forEach(en => { if (en.isIntersecting && en.intersectionRatio >= 0.65) activate(+en.target.dataset.i); }),
      { root: R.scroller, threshold: [0.65] });
    R.scroller.querySelectorAll('.reel').forEach(el => R.io.observe(el));
    activate(0);
  };

  function bind() {
    R.root.onclick = onClick;
    R.root.addEventListener('timeupdate', onTime, true);
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

  function loadSrc(i) {
    const v = vEl(i); if (!v || v.getAttribute('src') || !R.items[i]) return;
    v.src = R.items[i].video_url; v.preload = 'auto';
  }
  function unloadSrc(i) {
    const v = vEl(i); if (!v || !v.getAttribute('src')) return;
    try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {}
    const s = slideEl(i); if (s) { s.classList.remove('ready', 'paused'); s.classList.add('loading'); }
  }

  function activate(i) {
    if (R.cur === i || !R.scroller) return;
    const prev = R.cur; R.cur = i;
    if (prev != null) { const pv = vEl(prev); if (pv) pv.pause(); }
    for (let j = 0; j < R.items.length; j++) {
      if (Math.abs(j - i) <= 1) loadSrc(j); else if (Math.abs(j - i) > 2) unloadSrc(j);
    }
    if (i < R.items.length) { const bar = slideEl(i).querySelector('.reel-bar i'); if (bar) bar.style.width = '0'; R.last[i] = 0; playVideo(i); }
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
  function syncMute() { const b = $('reelsMute'); if (b) b.innerHTML = R.muted ? I.off : I.on; }

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
  }

  async function countView(i) {
    R.counted.add(i);
    const it = R.items[i]; if (!it) return;
    try {
      const j = await API.post(`/api/reels/${it.id}/view`, { vid: vidId() });
      if (j && j.views != null) { it.views = j.views; setStat(i, 'views', j.views); }
      if (j && j.counted) track('reel_view', it.title || ('#' + it.id), { id: it.id });
    } catch (e) { /* просмотр не засчитался — не страшно */ }
  }
  function setStat(i, k, val) { const s = slideEl(i); const b = s && s.querySelector(`[data-k="${k}"]`); if (b) b.textContent = short(val); }

  function needLogin(msg) {
    const s = S();
    if (s && s.user && s.user.role === 'admin') { say('Лайки и комментарии доступны покупателям', 'err'); return; }
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
      <div class="rc-head"><span>Комментарии · <span id="rcCount">${it.comments}</span></span><button class="rc-x" data-rc="close">✕</button></div>
      <div class="rc-list" id="rcList"><div class="rc-empty">Загрузка…</div></div>
      ${canWrite ? `<form class="rc-form" id="rcForm"><input id="rcIn" maxlength="300" placeholder="Добавить комментарий…" autocomplete="off"><button type="submit">➤</button></form>`
        : `<div class="rc-login">Войдите, чтобы комментировать<br><button class="rbtn" data-rc="login">Войти</button></div>`}</div>`;
    layer.onclick = e => {
      const b = e.target.closest('[data-rc]'); if (b) { if (b.dataset.rc === 'close') closeComments(); if (b.dataset.rc === 'login') { closeComments(); needLogin('Войдите в аккаунт'); } return; }
      const d = e.target.closest('[data-del]'); if (d) delComment(i, +d.dataset.del);
    };
    const draw = items => {
      $('rcList').innerHTML = items.length ? items.map(c => `<div class="rc-item" id="rc${c.id}"><div class="rc-av">${esc((c.author || '?')[0].toUpperCase())}</div>
        <div><div class="rc-au">${esc(c.author)}<small>${timeAgo(c.created_at)}</small></div><div class="rc-tx">${esc(c.body)}</div></div>
        ${c.mine ? `<button class="rc-del" data-del="${c.id}" aria-label="Удалить">🗑</button>` : '<span></span>'}</div>`).join('') : '<div class="rc-empty">Пока нет комментариев. Будьте первым!</div>';
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
  const A = { items: [], busy: false, file: null, openCm: null, timer: null };
  const fmtDur = s => { s = Math.round(+s || 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const fmtMb = b => (b / 1048576).toFixed(b > 10485760 ? 0 : 1) + ' МБ';

  window.initReelsAdmin = function () {
    const host = $('reelsAdmin'); if (!host) return;
    host.innerHTML = `<div class="rva"><div class="rva-h"><h3>🎬 Видео для раздела Happy TV</h3><button class="rva-acts-btn" id="rvaRefresh" style="border:0;background:none;color:#FF6B35;font-weight:900;cursor:pointer">Обновить</button></div>
      <div class="rva-sub">Лучше всего вертикальное видео 9:16, до 100 МБ и до 3 минут. Мы сами сделаем формат 720×1280, сожмём без заметной потери качества и опубликуем, когда ролик будет готов к просмотру. Горизонтальные получат размытый фон по краям, как в TikTok.</div>
      <div class="rva-drop" id="rvaDrop"><b>＋ Выберите видео</b><span>или перетащите файл сюда · MP4, MOV</span>
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
    $('rvaRefresh').onclick = loadList;
    $('rvaList').onclick = onListClick;
    loadList();
    clearInterval(A.timer);
    A.timer = setInterval(() => { if (!$('rvaList')) return clearInterval(A.timer); if (!document.hidden && !A.busy) loadList(true); }, 30000);
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

  async function pick(file) {
    if (!file) return;
    const info = $('rvaInfo'), go = $('rvaGo');
    A.file = null; go.disabled = true;
    if (!(file.type || '').startsWith('video/') && !/\.(mp4|mov|m4v|webm|mkv)$/i.test(file.name)) { info.className = 'rva-file on'; info.innerHTML = '❌ Это не видеофайл'; return; }
    if (file.size > 100 * 1048576) { info.className = 'rva-file on'; info.innerHTML = `❌ Файл слишком большой (${fmtMb(file.size)}). Максимум — 100 МБ.`; return; }
    const m = await probe(file);
    if (m && m.d > 183) { info.className = 'rva-file on'; info.innerHTML = `❌ Видео длиннее 3 минут (${fmtDur(m.d)}). Сократите ролик.`; return; }
    const ratio = m && m.w && m.h ? m.w / m.h : 0;
    const note = !m ? '' : (Math.abs(ratio - 9 / 16) < 0.03 ? '✅ Формат 9:16 — идеально' : ratio > 1 ? 'ℹ️ Горизонтальное: добавим размытый фон по краям' : 'ℹ️ Формат отличается от 9:16: добавим размытые поля');
    A.file = file;
    info.className = 'rva-file on';
    info.innerHTML = `🎞️ ${esc(file.name)}<small>${fmtMb(file.size)}${m ? ` · ${fmtDur(m.d)} · ${m.w}×${m.h}` : ''}${note ? ' · ' + note : ''}</small>`;
    go.disabled = false;
    if (!$('rvaTitle').value) $('rvaTitle').value = file.name.replace(/\.[^.]+$/, '').slice(0, 80);
  }

  function setProg(pct, text, cls, pulse) {
    const prog = $('rvaProg'); if (!prog) return;
    prog.classList.add('on');
    const bar = $('rvaBar'); bar.className = pulse ? 'pulse' : ''; if (!pulse) bar.style.width = pct + '%';
    const m = $('rvaMsg'); m.textContent = text; m.className = 'rva-msg ' + (cls || '');
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
      fd.append('signature', sig.signature); fd.append('folder', sig.folder); fd.append('eager', sig.eager); fd.append('eager_async', sig.eager_async);
      const up = await new Promise((ok, fail) => {
        const x = new XMLHttpRequest();
        x.open('POST', `https://api.cloudinary.com/v1_1/${sig.cloud_name}/video/upload`);
        x.upload.onprogress = e => { if (e.lengthComputable) setProg(Math.round(e.loaded / e.total * 90), `Загрузка видео… ${Math.round(e.loaded / e.total * 100)}%`); };
        x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch (e) {} x.status < 300 && j.public_id ? ok(j) : fail(new Error((j.error && j.error.message) || 'Не удалось загрузить видео')); };
        x.onerror = () => fail(new Error('Нет соединения при загрузке'));
        x.send(fd);
      });
      setProg(92, 'Оптимизируем видео — это займёт до пары минут…', '', true);
      let ready = false;
      for (let t = 0; t < 100 && !ready; t++) {
        const r = await API.get('/api/admin/reels/ready?public_id=' + encodeURIComponent(up.public_id));
        ready = r.ready; if (!ready) await sleep(3000);
      }
      if (!ready) throw new Error('Оптимизация занимает слишком долго. Подождите и нажмите «Обновить» — видео появится в списке, когда будет готово.');
      setProg(98, 'Публикуем…');
      await API.post('/api/admin/reels', { public_id: up.public_id, title, caption });
      setProg(100, '✅ Видео опубликовано и уже доступно в ленте', 'ok');
      A.file = null; $('rvaInfo').className = 'rva-file'; $('rvaTitle').value = ''; $('rvaCap').value = ''; $('rvaFile').value = '';
      await loadList();
    } catch (e) {
      setProg(0, '❌ ' + (e.message || 'Ошибка'), 'err');
      $('rvaGo').disabled = !A.file;
    }
    A.busy = false; $('rvaDrop').style.opacity = 1;
  }

  async function loadList(silent) {
    const list = $('rvaList'); if (!list) return;
    try { A.items = (await API.get('/api/admin/reels')).items || []; } catch (e) { if (!silent) list.innerHTML = `<div class="rva-empty">${esc(e.message)}</div>`; return; }
    if (!A.items.length) { list.innerHTML = '<div class="rva-empty">Пока нет видео. Загрузите первое — оно сразу появится в ленте у покупателей.</div>'; return; }
    list.innerHTML = A.items.map(r => `<div class="rva-card ${r.is_published ? '' : 'off'}" data-id="${r.id}">
      <div class="rva-poster" id="rvp${r.id}" style="background-image:url('${esc(r.poster_url)}')">
        <span class="st ${r.is_published ? '' : 'off'}">${r.is_published ? 'Опубликовано' : 'Скрыто'}</span><span class="dur">${fmtDur(r.duration)}</span>
        <button class="play" data-a="play" aria-label="Смотреть">▶</button></div>
      <div class="rva-body"><div class="rva-t">${esc(r.title || 'Без названия')}</div>
        <div class="rva-d">${new Date(r.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${fmtMb(r.bytes || 0)}</div>
        <div class="rva-stats"><div class="rva-s"><b>${short(r.views)}</b><span>просмотры</span></div><div class="rva-s"><b>${short(r.likes)}</b><span>лайки</span></div><div class="rva-s"><b>${short(r.comments)}</b><span>комментарии</span></div></div>
        <div class="rva-split">просмотры: аккаунтов ${r.views_accounts} · гостей ${r.views_guests}</div>
        <div class="rva-acts"><button data-a="cm">💬 Комментарии</button><button data-a="pub">${r.is_published ? 'Скрыть' : 'Показать'}</button><button data-a="del" class="del">Удалить</button></div>
        <div id="rvc${r.id}"></div></div></div>`).join('');
    if (A.openCm) openCm(A.openCm);
  }

  async function openCm(id) {
    const box = $('rvc' + id); if (!box) return;
    A.openCm = id;
    try {
      const j = await API.get(`/api/admin/reels/${id}/comments`);
      box.innerHTML = `<div class="rva-cm">${j.items.length ? j.items.map(c => `<div class="rva-c" id="rvcm${c.id}"><div><b>${esc(c.author || 'Покупатель')}</b> <small>${esc(c.email || c.phone || '')} · ${timeAgo(c.created_at)} назад</small>${esc(c.body)}</div><button data-a="delcm" data-cid="${c.id}" aria-label="Удалить">🗑</button></div>`).join('') : '<div class="rva-empty" style="padding:8px">Комментариев нет</div>'}</div>`;
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
      if (a === 'pub') { const r = A.items.find(x => x.id === id); await API.req('PATCH', `/api/admin/reels/${id}`, { is_published: !r.is_published }); say(r.is_published ? 'Видео скрыто' : 'Видео опубликовано'); return loadList(); }
      if (a === 'del') {
        if (!confirm('Удалить видео безвозвратно вместе с лайками и комментариями?')) return;
        await API.req('DELETE', `/api/admin/reels/${id}`); say('Видео удалено'); if (A.openCm === id) A.openCm = null; return loadList();
      }
      if (a === 'delcm') { await API.req('DELETE', `/api/admin/reels/comments/${b.dataset.cid}`); const el = $('rvcm' + b.dataset.cid); if (el) el.remove(); say('Комментарий удалён'); loadList(true); }
    } catch (err) { say(err.message || 'Ошибка', 'err'); }
  }
})();
