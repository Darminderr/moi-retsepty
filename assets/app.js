/* «Мои рецепты» — логика приложения.
   Без браузерных alert/confirm: все диалоги — свои. Оплата — только голосами. */

'use strict';

/* ======================= Константы и состояние ======================= */

var LS_KEY = 'mr_state_v2';
var CHUNK = 2000;
var DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

var state = {
  recipes: [],
  favs: [],
  plan: {},
  shop: [],
  premium: false,
  purchasedAt: null,
  trialStart: null,
  theme: 'auto',
  onboarded: false,
  updatedAt: 0
};

var ui = {
  view: 'home',
  stack: [],
  homeTab: 'all',
  homeCat: 'all',
  servings: {},
  cook: null,
  cover: null,
  sync: 'idle',
  userName: ''
};

var timers = { cook: null };

/* ======================= Утилиты ======================= */

function $(id) { return document.getElementById(id); }
function el(html) {
  var t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function plural(n, one, few, many) {
  var a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
function normQty(v) {
  if (v >= 10) return String(Math.round(v));
  if (v >= 1) return String(Math.round(v * 10) / 10).replace('.', ',');
  return String(Math.round(v * 4) / 4).replace('.', ',');
}
function fmtMinutes(m) {
  if (!m) return '';
  if (m < 60) return m + ' мин';
  var h = Math.floor(m / 60), r = m % 60;
  return h + ' ч' + (r ? ' ' + r + ' мин' : '');
}
function parseStep(s) {
  var i = String(s).lastIndexOf('|');
  if (i > -1) {
    var m = parseInt(String(s).slice(i + 1).trim(), 10);
    if (!isNaN(m) && m > 0) return { text: String(s).slice(0, i).trim(), minutes: m };
  }
  return { text: String(s).trim(), minutes: 0 };
}

/* ======================= Ссылки и мосты ======================= */

function isVK() { return !!window.__VK; }

function vk(method, params) {
  return new Promise(function (resolve, reject) {
    if (!window.vkBridge || typeof window.vkBridge.send !== 'function') {
      reject(new Error('no-bridge'));
      return;
    }
    var done = false;
    var t = setTimeout(function () {
      if (!done) { done = true; reject(new Error('timeout')); }
    }, 10000);
    window.vkBridge.send(method, params || {}).then(function (r) {
      if (done) return;
      done = true; clearTimeout(t); resolve(r);
    }).catch(function (e) {
      if (done) return;
      done = true; clearTimeout(t); reject(e);
    });
  });
}
function vkQuiet(method, params) {
  return vk(method, params).catch(function () { return null; });
}
function haptic(type) {
  if (isVK()) {
    vkQuiet('VKWebAppTapticNotification', { type: type || 'success' });
    vkQuiet('VKWebAppTapticImpact', { style: 'light' });
  }
  else if (navigator.vibrate) { try { navigator.vibrate(8); } catch (e) {} }
}

/* ======================= Хранилище и синхронизация ======================= */

function packState() {
  return {
    recipes: state.recipes,
    favs: state.favs,
    plan: state.plan,
    shop: state.shop,
    premium: state.premium,
    purchasedAt: state.purchasedAt,
    trialStart: state.trialStart,
    onboarded: state.onboarded,
    updatedAt: state.updatedAt
  };
}

function saveLocal() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(packState())); } catch (e) {}
}

function loadLocal() {
  try {
    var raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    var d = JSON.parse(raw);
    Object.keys(packState()).forEach(function (k) {
      if (d[k] !== undefined) state[k] = d[k];
    });
  } catch (e) {}
}

function touch() { state.updatedAt = Date.now(); saveLocal(); scheduleSync(); }

var syncTimer = null;
function scheduleSync() {
  if (!isVK()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(function () { syncPush(); }, 1200);
}

function syncPush() {
  var payload = JSON.stringify(packState());
  var chunks = [];
  for (var i = 0; i < payload.length; i += CHUNK) chunks.push(payload.slice(i, i + CHUNK));
  if (chunks.length > 12) chunks = chunks.slice(0, 12);
  ui.sync = 'wait';
  var chain = Promise.resolve();
  chunks.forEach(function (chunk, idx) {
    chain = chain.then(function () {
      return vk('VKWebAppStorageSet', { key: 'mr' + idx, value: chunk });
    });
  });
  chain = chain.then(function () {
    return vk('VKWebAppStorageSet', { key: 'mrmeta', value: JSON.stringify({ n: chunks.length, t: state.updatedAt }) });
  }).then(function () {
    ui.sync = 'ok';
  }).catch(function () {
    ui.sync = 'error';
  });
}

function syncPull() {
  if (!isVK()) return Promise.resolve(null);
  return vk('VKWebAppStorageGet', { keys: ['mrmeta'] }).then(function (res) {
    var metaRaw = extractValue(res, 'mrmeta');
    if (!metaRaw) return null;
    var meta = JSON.parse(metaRaw);
    var keys = [];
    for (var i = 0; i < (meta.n || 0); i++) keys.push('mr' + i);
    if (!keys.length) return null;
    return vk('VKWebAppStorageGet', { keys: keys }).then(function (r2) {
      var out = '';
      keys.forEach(function (k) {
        var v = extractValue(r2, k);
        if (v) out += v;
      });
      if (!out) return null;
      return JSON.parse(out);
    });
  }).catch(function () { return null; });
}

function extractValue(res, key) {
  try {
    var list = (res && res.keys) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === key) return list[i].value;
    }
  } catch (e) {}
  return null;
}

/* ======================= Доступ и оплата ======================= */

function trialLeft() {
  if (!state.trialStart) return 0;
  var left = TRIAL_DAYS - Math.floor((Date.now() - state.trialStart) / 86400000);
  return left > 0 ? left : 0;
}
function isUnlocked() { return state.premium || trialLeft() > 0; }

var FREE_IDS = null;
function freeIds() {
  if (FREE_IDS) return FREE_IDS;
  FREE_IDS = {};
  var byCat = {};
  RECIPES.forEach(function (r) {
    byCat[r.cat] = byCat[r.cat] || 0;
    if (byCat[r.cat] < FREE_BUILTIN_PER_CATEGORY) {
      FREE_IDS[r.id] = true;
      byCat[r.cat]++;
    }
  });
  return FREE_IDS;
}
function isLocked(r) {
  if (!r || r.custom) return false;
  if (isUnlocked()) return false;
  return !freeIds()[r.id];
}

function allRecipes() {
  return RECIPES.concat(state.recipes || []);
}
function findRecipe(id) {
  for (var i = 0; i < RECIPES.length; i++) if (RECIPES[i].id === id) return RECIPES[i];
  for (var j = 0; j < state.recipes.length; j++) if (state.recipes[j].id === id) return state.recipes[j];
  return null;
}

function isIOS() {
  var ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
}

function buyPremium() {
  if (isIOS()) {
    dialog({
      title: 'Покупка на iOS',
      text: 'На iOS платформа не проводит оплату голосами — так работают правила App Store. Откройте «Мои рецепты» с компьютера или на Android и оформите безлимит там: покупка привяжется к вашему аккаунту и появится на всех устройствах.',
      buttons: [{ label: 'Понятно', cls: 'soft' }]
    });
    return;
  }
  if (!isVK()) {
    dialog({
      title: 'Оплата — внутри приложения',
      text: 'Покупки работают только при запуске «Моих рецептов» внутри социальной сети. Откройте приложение по официальной ссылке и оформите безлимит там.',
      buttons: [
        { label: 'Открыть приложение', cls: 'primary', onClick: function () { location.href = APP_LINK; } },
        { label: 'Понятно', cls: 'soft' }
      ]
    });
    return;
  }
  vk('VKWebAppShowOrderBox', { type: 'item', item: PREMIUM_ITEM }).then(function (res) {
    if (res && (res.success || res.result)) {
      unlockPremium();
    } else {
      throw new Error('cancelled');
    }
  }).catch(function (e) {
    var code = e && (e.error_code || e.code);
    if (code === 4 || code === '4') return; // пользователь закрыл окно
    if (/no-bridge|timeout/.test(String(e && e.message))) {
      dialog({ title: 'Оплата недоступна', text: 'Платёжный сервис не ответил. Попробуйте ещё раз через минуту.', buttons: [{ label: 'Хорошо', cls: 'soft' }] });
      return;
    }
    dialog({
      title: 'Не удалось открыть оплату',
      text: 'Проверьте, что товар «' + PREMIUM_ITEM + '» добавлен в разделе «Монетизация» Панели управления платформы и приложение прошло проверку.',
      buttons: [{ label: 'Понятно', cls: 'soft' }]
    });
  });
}

function unlockPremium() {
  state.premium = true;
  state.purchasedAt = Date.now();
  touch();
  haptic('success');
  toast('Безлимит открыт. Приятного аппетита!');
  closeSheet();
  renderAll();
}

function startTrial() {
  if (state.trialStart) {
    toast('Пробный период уже использован');
    return;
  }
  state.trialStart = Date.now();
  touch();
  haptic('success');
  toast('Пробный период на ' + TRIAL_DAYS + ' дней активирован');
  closeSheet();
  renderAll();
}

function restorePurchase() {
  if (!isVK()) {
    toast('Восстановление доступно при запуске внутри платформы');
    return;
  }
  toast('Проверяем покупку…');
  syncPull().then(function (cloud) {
    if (cloud && cloud.premium) {
      state.premium = true;
      state.purchasedAt = cloud.purchasedAt || Date.now();
      touch();
      toast('Безлимит восстановлен');
      renderAll();
    } else {
      dialog({ title: 'Покупка не найдена', text: 'На этом аккаунте безлимит не оформлялся. Оформить его можно в разделе «Безлимит».', buttons: [{ label: 'Понятно', cls: 'soft' }] });
    }
  });
}

/* ======================= Диалоги, листы, тосты ======================= */

function toast(text, ms) {
  var box = $('toasts');
  var t = el('<div class="toast">' + esc(text) + '</div>');
  box.appendChild(t);
  setTimeout(function () {
    t.style.opacity = '0';
    t.style.transform = 'translateY(6px)';
    t.style.transition = 'opacity .2s, transform .2s';
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 220);
  }, ms || 2100);
}

function dialog(opts) {
  var root = $('modal-root');
  var buttons = (opts.buttons || [{ label: 'Ок', cls: 'soft' }]).map(function (b, i) {
    return '<button class="btn ' + (b.cls || 'soft') + '" data-i="' + i + '">' + esc(b.label) + '</button>';
  }).join('');
  var ov = el(
    '<div class="overlay center">' +
      '<div class="dialog">' +
        (opts.title ? '<h3>' + esc(opts.title) + '</h3>' : '') +
        (opts.text ? '<p>' + esc(opts.text) + '</p>' : '') +
        (opts.html || '') +
        buttons +
      '</div>' +
    '</div>'
  );
  ov.addEventListener('click', function (e) {
    if (e.target === ov) { ov.remove(); return; }
    var btn = e.target.closest('button[data-i]');
    if (!btn) return;
    var b = opts.buttons[+btn.getAttribute('data-i')] || {};
    if (b.onClick) { try { b.onClick(); } catch (err) {} }
    if (b.keepOpen !== true) ov.remove();
  });
  root.appendChild(ov);
  return ov;
}

function confirmDialog(title, text, okLabel, onOk) {
  dialog({
    title: title,
    text: text,
    buttons: [
      { label: okLabel || 'Да', cls: 'primary', onClick: onOk },
      { label: 'Отмена', cls: 'soft' }
    ]
  });
}

function sheet(html) {
  var root = $('modal-root');
  var ov = el('<div class="overlay"><div class="sheet"><div class="grab"></div>' + html + '</div></div>');
  ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
  root.appendChild(ov);
  return ov;
}
function closeSheet() {
  var root = $('modal-root');
  while (root.firstChild) root.removeChild(root.firstChild);
}

/* ======================= Тема ======================= */

function applyTheme() {
  var dark = false;
  if (state.theme === 'dark') dark = true;
  else if (state.theme === 'auto') {
    dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  document.body.classList.toggle('dark', dark);
  var btn = $('theme-btn');
  if (btn) btn.innerHTML = '<svg class="ic"><use href="#' + (dark ? 'i-sun' : 'i-moon') + '"/></svg>';
  var mt = document.querySelector('meta[name="theme-color"]');
  if (mt) mt.setAttribute('content', dark ? '#0E1014' : '#F5F5F7');
}
function cycleTheme() {
  var order = ['auto', 'light', 'dark'];
  var i = order.indexOf(state.theme);
  state.theme = order[(i + 1) % order.length];
  touch();
  applyTheme();
  var names = { auto: 'Тема: как в системе', light: 'Тема: светлая', dark: 'Тема: тёмная' };
  toast(names[state.theme]);
}
function toggleTheme() { cycleTheme(); }

/* ======================= Роутер ======================= */

var MAIN_VIEWS = { home: 1, plan: 1, shop: 1, profile: 1 };

function go(view, opts) {
  opts = opts || {};
  if (view !== ui.view) {
    if (MAIN_VIEWS[ui.view]) ui.stack = [ui.view];
    else ui.stack.push(ui.view);
  }
  ui.view = view;
  document.querySelectorAll('.screen').forEach(function (s) { s.classList.remove('active'); });
  var scr = $('screen-' + view);
  if (scr) scr.classList.add('active');
  var bar = $('tabbar');
  if (bar) bar.style.display = MAIN_VIEWS[view] ? 'flex' : 'none';
  document.body.classList.toggle('no-tabs', !MAIN_VIEWS[view]);
  ['home', 'plan', 'shop', 'profile'].forEach(function (v) {
    var b = $('tab-' + v);
    if (b) b.classList.toggle('on', v === view);
  });
  window.scrollTo(0, 0);
  if (view === 'home') renderHome();
  if (view === 'plan') renderPlan();
  if (view === 'shop') renderShop();
  if (view === 'profile') renderProfile();
}

function back() {
  var prev = ui.stack.pop() || 'home';
  ui.view = prev;
  document.querySelectorAll('.screen').forEach(function (s) { s.classList.remove('active'); });
  var scr = $('screen-' + prev);
  if (scr) scr.classList.add('active');
  $('tabbar').style.display = MAIN_VIEWS[prev] ? 'flex' : 'none';
  document.body.classList.toggle('no-tabs', !MAIN_VIEWS[prev]);
  ['home', 'plan', 'shop', 'profile'].forEach(function (v) {
    var b = $('tab-' + v);
    if (b) b.classList.toggle('on', v === prev);
  });
  window.scrollTo(0, 0);
  if (prev === 'home') renderHome();
  if (prev === 'plan') renderPlan();
  if (prev === 'shop') renderShop();
  if (prev === 'profile') renderProfile();
  if (prev === 'detail' && ui.cover) renderDetail(ui.cover, true);
}

/* ======================= Главный экран ======================= */

function renderAll() {
  renderHome();
  renderPlan();
  renderShop();
  renderProfile();
  if (ui.view === 'detail' && ui.cover) renderDetail(ui.cover, true);
}

function renderHome() {
  var chips = $('home-chips');
  if (chips) {
    chips.innerHTML = CATEGORIES.map(function (c) {
      return '<button class="chip' + (ui.homeCat === c.id ? ' on' : '') + '" data-cat="' + c.id + '">' +
        c.emoji + ' ' + esc(c.name) + '</button>';
    }).join('');
    chips.onclick = function (e) {
      var b = e.target.closest('[data-cat]');
      if (!b) return;
      ui.homeCat = b.getAttribute('data-cat');
      renderHome();
    };
  }
  var seg = $('home-seg');
  if (seg) {
    seg.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === ui.homeTab);
    });
    seg.onclick = function (e) {
      var b = e.target.closest('[data-tab]');
      if (!b) return;
      ui.homeTab = b.getAttribute('data-tab');
      renderHome();
    };
  }
  var q = ($('home-q') && $('home-q').value || '').trim().toLowerCase();
  var list = [];

  if (ui.homeTab === 'my') {
    list = state.recipes.slice().reverse();
  } else if (ui.homeTab === 'fav') {
    list = allRecipes().filter(function (r) { return state.favs.indexOf(r.id) > -1; });
  } else {
    list = RECIPES.slice();
    if (ui.homeCat !== 'all') list = list.filter(function (r) { return r.cat === ui.homeCat; });
  }
  if (q) {
    list = list.filter(function (r) {
      var hay = (r.name + ' ' + (r.about || '') + ' ' + (r.ing || []).map(function (i) { return i[0]; }).join(' ')).toLowerCase();
      return hay.indexOf(q) > -1;
    });
  }

  var box = $('home-list');
  if (!box) return;

  if (!list.length) {
    if (ui.homeTab === 'my') {
      box.innerHTML = emptyHTML('📝', 'Здесь будут ваши рецепты', 'Добавьте первый — с фотографией или без', 'Добавить рецепт', 'openAdd()');
    } else if (ui.homeTab === 'fav') {
      box.innerHTML = emptyHTML('❤️', 'В избранном пусто', 'Нажмите на сердечко у рецепта — он сохранится здесь', null, null);
    } else {
      box.innerHTML = emptyHTML('🔍', 'Ничего не нашлось', 'Попробуйте другое слово или другую категорию', null, null);
    }
    return;
  }
  box.innerHTML = list.map(recipeCard).join('');
  box.onclick = function (e) {
    var fav = e.target.closest('[data-fav]');
    if (fav) { toggleFav(fav.getAttribute('data-fav')); e.stopPropagation(); return; }
    var card = e.target.closest('[data-open]');
    if (!card) return;
    openDetail(card.getAttribute('data-open'));
  };
}

function emptyHTML(emoji, title, text, btnLabel, btnAction) {
  return '<div class="empty"><div class="e-emoji">' + emoji + '</div>' +
    '<p><b style="color:var(--text);font-size:15px">' + esc(title) + '</b><br>' + esc(text) + '</p>' +
    (btnLabel ? '<button class="btn primary" style="max-width:220px;margin:0 auto" onclick="' + btnAction + '">' + esc(btnLabel) + '</button>' : '') +
    '</div>';
}

function thumbHTML(r, cls) {
  if (r.photo) {
    return '<img class="' + cls + '" src="' + esc(r.photo) + '" alt="" loading="lazy" onerror="imgFail(this,\'' + (r.id || '') + '\')">';
  }
  return '<div class="' + cls + ' thumb-fb">' + catEmoji(r.cat) + '</div>';
}
function catEmoji(cat) {
  for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].id === cat) return CATEGORIES[i].emoji;
  return '🍽';
}
function imgFail(img, id) {
  var h = img.clientHeight || 84;
  var div = document.createElement('div');
  div.className = (img.className ? img.className + ' ' : '') + 'thumb-fb';
  div.style.height = h + 'px';
  div.textContent = '🍽';
  if (img.parentNode) img.parentNode.replaceChild(div, img);
}

function recipeCard(r) {
  var locked = isLocked(r);
  var fav = state.favs.indexOf(r.id) > -1;
  return '<div class="rcard" data-open="' + r.id + '">' +
    thumbHTML(r, 'thumb') +
    '<div class="rc-body">' +
      '<h3>' + esc(r.name) + '</h3>' +
      '<div class="meta">' +
        '<span><svg class="ic ic-sm" style="width:13px;height:13px"><use href="#i-clock"/></svg>' + fmtMinutes(r.time) + '</span>' +
        '<span>' + (r.servings || 1) + ' ' + plural(r.servings || 1, 'порция', 'порции', 'порций') + '</span>' +
        (r.custom ? '<span class="tag-hot">мой</span>' : '') +
      '</div>' +
    '</div>' +
    '<button class="fav-btn' + (fav ? ' on' : '') + '" data-fav="' + r.id + '" aria-label="В избранное">' +
      '<svg class="ic ic-sm"><use href="#i-heart"/></svg></button>' +
    (locked ? '<div class="lock-badge"><svg class="ic" style="width:11px;height:11px"><use href="#i-lock"/></svg>Безлимит</div>' : '') +
  '</div>';
}

function toggleFav(id) {
  var i = state.favs.indexOf(id);
  if (i > -1) state.favs.splice(i, 1); else state.favs.push(id);
  haptic(i > -1 ? 'error' : 'success');
  touch();
  renderHome();
  renderProfile();
  if (ui.view === 'detail' && ui.cover === id) renderDetail(id, true);
}

function randomRecipe() {
  var pool = allRecipes().filter(function (r) {
    return (r.custom || !isLocked(r)) && (r.custom || r.id);
  });
  if (!pool.length) { toast('Пока нет доступных рецептов'); return; }
  var r = pool[Math.floor(Math.random() * pool.length)];
  haptic('success');
  openDetail(r.id);
}

/* ======================= Детальный экран ======================= */

function openDetail(id) {
  ui.cover = id;
  go('detail');
  renderDetail(id);
}

function renderDetail(id, keepScroll) {
  var r = findRecipe(id);
  if (!r) { back(); return; }
  var locked = isLocked(r);
  var fav = state.favs.indexOf(id) > -1;
  var servings = ui.servings[id] || r.servings || 1;
  var factor = servings / (r.servings || 1);
  var body = $('detail-body');

  var html = '<div class="detail-hero">' +
    thumbHero(r) +
    '<div class="hero-top">' +
      '<button class="round-btn" onclick="exitDetail()" aria-label="Назад"><svg class="ic"><use href="#i-back"/></svg></button>' +
      '<button class="round-btn' + (fav ? ' liked' : '') + '" onclick="toggleFav(\'' + id + '\')" aria-label="Избранное"><svg class="ic"><use href="#i-heart"/></svg></button>' +
    '</div></div>' +
    '<div class="page"><div class="detail-body">' +
      '<h1 class="detail-title">' + esc(r.name) + '</h1>' +
      '<p class="detail-about">' + esc(r.about || '') + '</p>' +
      '<div class="badges">' +
        '<span><svg class="ic ic-sm"><use href="#i-clock"/></svg>' + fmtMinutes(r.time) + '</span>' +
        '<span>' + (r.servings || 1) + ' ' + plural(r.servings || 1, 'порция', 'порции', 'порций') + '</span>' +
        (r.level ? '<span>' + esc(r.level) + '</span>' : '') +
        '<span>' + catEmoji(r.cat) + ' ' + esc(catName(r.cat)) + '</span>' +
      '</div>';

  if (locked) {
    html += '<div class="locked-block">' +
      '<div style="font-size:34px;margin-bottom:8px">🔒</div>' +
      '<div style="font-weight:800;font-size:17px;margin-bottom:6px">Рецепт входит в Безлимит</div>' +
      '<p class="muted" style="margin-bottom:14px">Откройте все 30 рецептов, добавляйте свои без ограничений и синхронизируйте их между устройствами.</p>' +
      '<button class="btn primary" onclick="openPaywall()">Открыть Безлимит</button>' +
      (state.trialStart ? '' : '<button class="btn soft mt8" onclick="startTrial()">Попробовать ' + TRIAL_DAYS + ' дней бесплатно</button>') +
      '</div>';
  } else {
    html += '<div class="card-block">' +
      '<h3>Ингредиенты <span class="serv">' +
        '<button onclick="changeServings(\'' + id + '\',-1)">−</button>' +
        '<b>' + servings + ' ' + plural(servings, 'порция', 'порции', 'порций') + '</b>' +
        '<button onclick="changeServings(\'' + id + '\',1)">+</button>' +
      '</span></h3>' +
      '<ul class="ing">' + (r.ing || []).map(function (i) {
        return '<li><span class="nm">' + esc(i[0]) + '</span><span class="qt">' + ingQty(i, factor) + '</span></li>';
      }).join('') + '</ul></div>';

    var steps = (r.steps || []).map(parseStep);
    html += '<div class="card-block"><h3>Как готовить</h3><ol class="steps">' +
      steps.map(function (s) {
        return '<li><div><div class="stx">' + esc(s.text) + '</div>' +
          (s.minutes ? '<div class="stm"><svg class="ic" style="width:13px;height:13px"><use href="#i-clock"/></svg>таймер ' + s.minutes + ' мин</div>' : '') +
          '</div></li>';
      }).join('') + '</ol></div>';

    if (r.tips) {
      html += '<div class="tip"><svg class="ic"><use href="#i-sparkle"/></svg><div>' + esc(r.tips) + '</div></div>';
    }
    html += '<div class="detail-actions mt16">' +
      '<button class="btn outline" onclick="shareRecipe(\'' + id + '\')"><svg class="ic ic-sm"><use href="#i-share"/></svg>Поделиться</button>' +
      '<button class="btn outline" onclick="addRecipeToShop(\'' + id + '\')"><svg class="ic ic-sm"><use href="#i-cart"/></svg>В покупки</button>' +
      '</div>';
    if (r.steps && r.steps.length) {
      html += '<div class="sticky-cta"><button class="btn primary" onclick="startCooking(\'' + id + '\')">' +
        '<svg class="ic ic-sm"><use href="#i-flame"/></svg>Начать готовить</button></div>';
    }
  }
  html += '</div></div>';
  body.innerHTML = html;
  if (!keepScroll) window.scrollTo(0, 0);
}

function thumbHero(r) {
  if (r.photo) {
    return '<img src="' + esc(r.photo) + '" alt="" onerror="imgFail(this,\'' + r.id + '\')">';
  }
  return '<div style="height:250px;display:flex;align-items:center;justify-content:center;font-size:72px;background:linear-gradient(135deg,var(--accent-soft),var(--purple-soft))">' + catEmoji(r.cat) + '</div>';
}

function catName(id) {
  for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].id === id) return CATEGORIES[i].name;
  return 'Рецепт';
}

function ingQty(ing, factor) {
  if (ing[1] == null) return ing[2] ? esc(ing[2]) : 'по вкусу';
  var q = normQty(ing[1] * factor);
  return esc(q + ' ' + (ing[2] || ''));
}

function changeServings(id, delta) {
  var r = findRecipe(id);
  if (!r) return;
  var cur = ui.servings[id] || r.servings || 1;
  var next = Math.min(12, Math.max(1, cur + delta));
  ui.servings[id] = next;
  renderDetail(id, true);
}

function exitDetail() {
  if (ui.stack.length) back(); else go('home');
}

/* ======================= Режим готовки ======================= */

function startCooking(id) {
  var r = findRecipe(id);
  if (!r || !r.steps || !r.steps.length) { toast('В этом рецепте нет шагов'); return; }
  var steps = r.steps.map(parseStep);
  ui.cook = { id: id, i: 0, steps: steps, left: (steps[0].minutes || 0) * 60, running: false, preset: steps[0].minutes || 0 };
  go('cook');
  renderCook();
  requestWakeLock();
}

function renderCook() {
  var c = ui.cook;
  if (!c) return;
  var r = findRecipe(c.id);
  var s = c.steps[c.i];
  var total = c.steps.length;
  var pct = Math.round(((c.i) / total) * 100);
  var mm = Math.floor(Math.abs(c.left) / 60), ss = Math.abs(c.left) % 60;
  var timeStr = (c.left < 0 ? '-' : '') + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');

  $('cook-body').innerHTML =
    '<div class="cook">' +
      '<div class="cook-top">' +
        '<button class="icon-btn plain" onclick="stopCooking()" aria-label="Выйти"><svg class="ic"><use href="#i-close"/></svg></button>' +
        '<div class="t">' + esc(r.name) + '</div>' +
        '<button class="icon-btn plain" onclick="stopCooking()" aria-label="Свернуть"><svg class="ic"><use href="#i-back"/></svg></button>' +
      '</div>' +
      '<div class="progress"><i style="width:' + pct + '%"></i></div>' +
      '<div class="cook-step">' +
        '<div class="cnt">Шаг ' + (c.i + 1) + ' из ' + total + '</div>' +
        '<div class="txt">' + esc(s.text) + '</div>' +
      '</div>' +
      '<div class="timer"><div class="val' + (c.running ? ' run' : '') + '" id="cook-timer">' + timeStr + '</div></div>' +
      '<div class="timer-min">' +
        '<input type="number" id="tm-min" min="0" max="99" value="' + Math.floor((c.preset || 0) / 60) + '" aria-label="Минуты">' +
        '<span class="muted" style="align-self:center">мин</span>' +
        '<input type="number" id="tm-sec" min="0" max="59" value="' + ((c.preset || 0) % 60) + '" aria-label="Секунды">' +
        '<span class="muted" style="align-self:center">сек</span>' +
      '</div>' +
      '<div class="cook-nav mb16">' +
        '<button class="btn soft" onclick="cookTimerToggle()" style="flex:1">' +
          '<svg class="ic ic-sm"><use href="#' + (c.running ? 'i-pause' : 'i-play') + '"/></svg>' + (c.running ? 'Пауза' : 'Старт') + '</button>' +
        '<button class="btn outline" onclick="cookTimerReset()" style="flex:1">' +
          '<svg class="ic ic-sm"><use href="#i-reset"/></svg>Сброс</button>' +
      '</div>' +
      '<div class="cook-nav" style="margin-top:auto">' +
        (c.i > 0 ? '<button class="btn soft" onclick="cookPrev()" style="flex:1">Назад</button>' : '') +
        (c.i < total - 1
          ? '<button class="btn primary" onclick="cookNext()" style="flex:2">Дальше</button>'
          : '<button class="btn green" onclick="cookFinish()" style="flex:2">Готово!</button>') +
      '</div>' +
    '</div>';
}

function cookPrev() { if (ui.cook.i > 0) { ui.cook.i--; ui.cook.preset = ui.cook.steps[ui.cook.i].minutes || 0; ui.cook.left = ui.cook.preset * 60; stopCookTimer(); renderCook(); } }
function cookNext() { if (ui.cook.i < ui.cook.steps.length - 1) { ui.cook.i++; ui.cook.preset = ui.cook.steps[ui.cook.i].minutes || 0; ui.cook.left = ui.cook.preset * 60; stopCookTimer(); renderCook(); } }

function cookTimerToggle() {
  var c = ui.cook;
  if (c.running) { stopCookTimer(); renderCook(); return; }
  if (c.left <= 0) {
    var m = parseInt(($('tm-min') || {}).value, 10) || 0;
    var s = parseInt(($('tm-sec') || {}).value, 10) || 0;
    c.left = m * 60 + s;
    if (c.left <= 0) { toast('Укажите время таймера'); return; }
  }
  c.running = true;
  timers.cook = setInterval(function () {
    c.left--;
    var node = $('cook-timer');
    if (node) {
      var mm = Math.floor(Math.abs(c.left) / 60), ss = Math.abs(c.left) % 60;
      node.textContent = (c.left < 0 ? '-' : '') + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
    }
    if (c.left === 0) {
      stopCookTimer();
      beep();
      haptic('success');
      toast('Время вышло');
    }
  }, 1000);
  renderCook();
}

function stopCookTimer() {
  if (timers.cook) { clearInterval(timers.cook); timers.cook = null; }
  if (ui.cook) ui.cook.running = false;
}
function cookTimerReset() { stopCookTimer(); if (ui.cook) ui.cook.left = 0; renderCook(); }

function cookFinish() {
  stopCookTimer();
  haptic('success');
  beep();
  dialog({
    title: 'Готово! 🎉',
    text: 'Блюдо готово. Приятного аппетита!',
    buttons: [
      { label: 'К рецепту', cls: 'primary', onClick: function () { stopCooking(); } }
    ]
  });
}

function stopCooking() {
  stopCookTimer();
  releaseWakeLock();
  var id = ui.cook && ui.cook.id;
  ui.cook = null;
  ui.stack = ['home'];
  if (id) openDetail(id); else go('home');
}

var wakeLock = null;
function requestWakeLock() {
  try {
    if (navigator.wakeLock && !wakeLock) {
      navigator.wakeLock.request('screen').then(function (wl) { wakeLock = wl; }).catch(function () {});
    }
  } catch (e) {}
}
function releaseWakeLock() {
  try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) {}
}

var audioCtx = null;
function beep() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.22].forEach(function (delay) {
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = 880;
      g.gain.value = 0.05;
      o.connect(g); g.connect(audioCtx.destination);
      o.start(audioCtx.currentTime + delay);
      o.stop(audioCtx.currentTime + delay + 0.14);
    });
  } catch (e) {}
}

/* ======================= Добавление рецепта ======================= */

function openAdd() {
  if (!isUnlocked() && state.recipes.length >= FREE_OWN_LIMIT) {
    dialog({
      title: 'Достигнут лимит',
      text: 'Бесплатно можно хранить ' + FREE_OWN_LIMIT + ' своих рецептов. В Безлимите ограничений нет.',
      buttons: [
        { label: 'Открыть Безлимит', cls: 'primary', onClick: openPaywall },
        { label: 'Позже', cls: 'soft' }
      ]
    });
    return;
  }
  go('add');
  renderAdd();
}

function renderAdd() {
  var cats = CATEGORIES.filter(function (c) { return c.id !== 'all'; });
  $('add-body').innerHTML =
    '<div class="topbar"><button class="icon-btn plain" onclick="back()" aria-label="Назад"><svg class="ic"><use href="#i-back"/></svg></button>' +
    '<h1 style="font-size:19px">Новый рецепт</h1></div>' +
    '<div class="page">' +
      '<div class="field"><label>Название</label><input class="input" id="a-name" placeholder="Например: Бабушкин пирог"></div>' +
      '<div class="field"><label>Категория</label><div class="chips" id="a-cats" style="margin:0;padding:0">' +
        cats.map(function (c, i) { return '<button class="chip' + (i === 0 ? ' on' : '') + '" data-cat="' + c.id + '">' + c.emoji + ' ' + esc(c.name) + '</button>'; }).join('') +
      '</div></div>' +
      '<div class="row2">' +
        '<div class="field"><label>Время, мин</label><input class="input" id="a-time" type="number" min="1" max="600" value="30"></div>' +
        '<div class="field"><label>Порций</label><input class="input" id="a-serv" type="number" min="1" max="20" value="2"></div>' +
      '</div>' +
      '<div class="field"><label>Ингредиенты</label><textarea class="input" id="a-ing" placeholder="Картофель — 3 шт&#10;Молоко — 200 мл&#10;Соль — по вкусу"></textarea>' +
        '<div class="hint">Каждый ингредиент с новой строки. Пишите «продукт — количество». Если количество не нужно — оставьте только название.</div></div>' +
      '<div class="field"><label>Шаги</label><textarea class="input" id="a-steps" placeholder="Нарежьте овощи&#10;Обжарьте 5 минут | 5&#10;Добавьте воду и варите 20 минут | 20"></textarea>' +
        '<div class="hint">Каждый шаг с новой строки. Чтобы включить таймер, добавьте в конце «| минуты», например «варите 20 минут | 20».</div></div>' +
      '<button class="btn primary" onclick="saveCustomRecipe()">Сохранить рецепт</button>' +
      '<button class="btn soft mt8" onclick="back()">Отмена</button>' +
    '</div>';

  var box = $('a-cats');
  if (box) box.onclick = function (e) {
    var b = e.target.closest('[data-cat]');
    if (!b) return;
    box.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('on'); });
    b.classList.add('on');
  };
}

function parseIngredientLine(line) {
  var s = String(line).trim();
  if (!s) return null;
  var withQty = s.match(/^(.*?)[\s—–\-]+([\d]+(?:[.,]\d+)?)\s*([а-яёa-z%.]*)$/i);
  if (withQty && withQty[1]) {
    var q = parseFloat(String(withQty[2]).replace(',', '.'));
    if (!isNaN(q)) return [withQty[1].trim(), q, (withQty[3] || '').trim() || 'шт'];
  }
  var noQty = s.match(/^(.*?)\s*[—–\-]\s*(.+)$/);
  if (noQty && noQty[1] && noQty[2]) return [noQty[1].trim(), null, noQty[2].trim()];
  return [s, null, ''];
}

function saveCustomRecipe() {
  var name = ($('a-name').value || '').trim();
  var time = parseInt($('a-time').value, 10) || 30;
  var servings = parseInt($('a-serv').value, 10) || 2;
  var ingRaw = ($('a-ing').value || '').split('\n');
  var stepsRaw = ($('a-steps').value || '').split('\n');
  var catBtn = document.querySelector('#a-cats .chip.on');
  var cat = catBtn ? catBtn.getAttribute('data-cat') : 'main';

  if (!name) { toast('Введите название'); return; }
  var ing = ingRaw.map(parseIngredientLine).filter(Boolean);
  var steps = stepsRaw.map(function (s) { return String(s).trim(); }).filter(Boolean);
  if (!ing.length) { toast('Добавьте хотя бы один ингредиент'); return; }
  if (!steps.length) { toast('Добавьте хотя бы один шаг'); return; }

  state.recipes.push({
    id: 'u' + Date.now(),
    cat: cat,
    name: name,
    time: time,
    servings: servings,
    level: 'мой рецепт',
    about: 'Личный рецепт',
    ing: ing,
    steps: steps,
    tips: '',
    custom: true,
    photo: ''
  });
  touch();
  haptic('success');
  toast('Рецепт сохранён');
  ui.homeTab = 'my';
  go('home');
}

/* ======================= План ======================= */

function renderPlan() {
  var list = $('plan-list');
  if (!list) return;
  var filled = 0;
  list.innerHTML = DAYS.map(function (d, idx) {
    var id = state.plan[idx];
    var r = id ? findRecipe(id) : null;
    if (r) filled++;
    return '<div class="plan-row" data-day="' + idx + '">' +
      '<div class="day">' + d + '</div>' +
      (r ? thumbHTML(r, 'thumb-s') : '') +
      '<div class="pr' + (r ? '' : ' empty') + '">' + (r ? esc(r.name) : 'Добавить блюдо') + '</div>' +
      (r ? '<button class="del" data-del="' + idx + '" aria-label="Убрать"><svg class="ic ic-sm"><use href="#i-close"/></svg></button>' : '<svg class="ic ic-sm" style="color:var(--text-3)"><use href="#i-chevron"/></svg>') +
    '</div>';
  }).join('');

  list.onclick = function (e) {
    var del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); delete state.plan[del.getAttribute('data-del')]; touch(); renderPlan(); return; }
    var row = e.target.closest('[data-day]');
    if (!row) return;
    openPlanPicker(+row.getAttribute('data-day'));
  };

  $('plan-sub').textContent = filled + ' из 7 дней заполнено';
  $('plan-actions').innerHTML = filled
    ? '<button class="btn primary" onclick="planToShop()"><svg class="ic ic-sm"><use href="#i-cart"/></svg>Собрать список покупок</button>' +
      '<button class="btn soft mt8" onclick="clearPlan()">Очистить план</button>'
    : '<button class="btn soft" onclick="autoPlan()"><svg class="ic ic-sm"><use href="#i-sparkle"/></svg>Заполнить план автоматически</button>';
}

function openPlanPicker(day) {
  var pool = allRecipes().filter(function (r) { return !isLocked(r); });
  var ov = sheet(
    '<h2>Блюдо на ' + DAYS[day] + '</h2>' +
    '<p class="sub">Выберите рецепт из доступных</p>' +
    '<div class="search" style="margin-bottom:10px"><svg class="ic ic-sm"><use href="#i-search"/></svg><input id="pp-q" placeholder="Поиск" autocomplete="off"></div>' +
    '<div id="pp-list" style="max-height:52vh;overflow:auto;padding-bottom:8px"></div>'
  );
  var render = function () {
    var q = (ov.querySelector('#pp-q').value || '').toLowerCase();
    var items = pool.filter(function (r) { return r.name.toLowerCase().indexOf(q) > -1; });
    ov.querySelector('#pp-list').innerHTML = items.map(function (r) {
      return '<div class="plan-row" data-pick="' + r.id + '" style="margin-bottom:6px">' +
        thumbHTML(r, 'thumb-s') +
        '<div class="pr">' + esc(r.name) + '</div>' +
        '<span class="muted">' + fmtMinutes(r.time) + '</span></div>';
    }).join('') || '<div class="empty"><p>Ничего не найдено</p></div>';
  };
  render();
  ov.querySelector('#pp-q').oninput = render;
  ov.querySelector('#pp-list').onclick = function (e) {
    var row = e.target.closest('[data-pick]');
    if (!row) return;
    state.plan[day] = row.getAttribute('data-pick');
    touch();
    closeSheet();
    renderPlan();
    toast('Добавлено в план');
  };
}

function deletePlanDay() {}

function autoPlan() {
  var pool = allRecipes().filter(function (r) { return !isLocked(r); });
  if (!pool.length) { toast('Нет доступных рецептов'); return; }
  var empty = [];
  for (var i = 0; i < 7; i++) if (!state.plan[i]) empty.push(i);
  if (!empty.length) { toast('План уже заполнен'); return; }
  empty.forEach(function (d) {
    state.plan[d] = pool[Math.floor(Math.random() * pool.length)].id;
  });
  touch();
  haptic('success');
  renderPlan();
  toast('План заполнен');
}

function clearPlan() {
  confirmDialog('Очистить план?', 'Все блюда из плана на неделю будут удалены.', 'Очистить', function () {
    state.plan = {};
    touch();
    renderPlan();
    toast('План очищен');
  });
}

function planToShop() {
  var added = 0;
  Object.keys(state.plan).forEach(function (d) {
    var r = findRecipe(state.plan[d]);
    if (!r) return;
    (r.ing || []).forEach(function (i) {
      var text = i[0] + (i[1] != null ? ' — ' + normQty(i[1]) + ' ' + (i[2] || '') : '');
      if (addShopText(text)) added++;
    });
  });
  if (added) { haptic('success'); toast('Добавлено позиций: ' + added); go('shop'); }
  else toast('В плане пока нет блюд');
}

/* ======================= Список покупок ======================= */

function addShopText(text) {
  var t = String(text).trim();
  if (!t) return false;
  for (var i = 0; i < state.shop.length; i++) {
    if (state.shop[i].text.toLowerCase() === t.toLowerCase()) return false;
  }
  state.shop.push({ text: t, checked: false });
  return true;
}

function addRecipeToShop(id) {
  var r = findRecipe(id);
  if (!r) return;
  var servings = ui.servings[id] || r.servings || 1;
  var factor = servings / (r.servings || 1);
  var added = 0;
  (r.ing || []).forEach(function (i) {
    var text = i[0] + (i[1] != null ? ' — ' + normQty(i[1] * factor) + ' ' + (i[2] || '') : '');
    if (addShopText(text)) added++;
  });
  touch();
  haptic('success');
  toast(added ? 'В списке покупок: +' + added : 'Продукты уже в списке');
  renderShop();
}

function renderShop() {
  var box = $('shop-list');
  if (!box) return;
  if (!state.shop.length) {
    box.innerHTML = emptyHTML('🧾', 'Список пока пуст', 'Добавьте продукты из рецепта или вручную', 'Добавить продукт', 'addShopManually()');
  } else {
    box.innerHTML = state.shop.map(function (it, i) {
      return '<div class="shop-item' + (it.checked ? ' done' : '') + '">' +
        '<button class="check' + (it.checked ? ' on' : '') + '" data-chk="' + i + '" aria-label="Куплено">' +
          '<svg class="ic ic-sm"><use href="#i-check"/></svg></button>' +
        '<div class="txt">' + esc(it.text) + '</div>' +
        '<button class="del" data-del="' + i + '" aria-label="Удалить"><svg class="ic ic-sm"><use href="#i-trash"/></svg></button>' +
      '</div>';
    }).join('');
  }
  var total = state.shop.length;
  var done = state.shop.filter(function (x) { return x.checked; }).length;
  $('shop-sub').textContent = total ? total + ' ' + plural(total, 'позиция', 'позиции', 'позиций') : 'Пусто';
  $('shop-summary').classList.toggle('hidden', !total);
  $('shop-left').textContent = 'Осталось купить: ' + (total - done);
  $('shop-done').textContent = done ? 'Куплено: ' + done : '';

  $('shop-actions').innerHTML = total
    ? '<button class="btn primary" onclick="copyShop()"><svg class="ic ic-sm"><use href="#i-copy"/></svg>Скопировать список</button>' +
      '<div class="btn-row mt8"><button class="btn soft" onclick="clearChecked()">Убрать купленное</button>' +
      '<button class="btn soft" onclick="clearShop()">Очистить всё</button></div>'
    : '';

  box.onclick = function (e) {
    var chk = e.target.closest('[data-chk]');
    if (chk) { var i = +chk.getAttribute('data-chk'); state.shop[i].checked = !state.shop[i].checked; touch(); renderShop(); return; }
    var del = e.target.closest('[data-del]');
    if (del) { state.shop.splice(+del.getAttribute('data-del'), 1); touch(); renderShop(); }
  };
}

function addShopManually() {
  var ov = dialog({
    title: 'Новый продукт',
    html: '<input class="input" id="dm-text" placeholder="Например: хлеб — 1 шт" autocomplete="off">',
    buttons: [
      { label: 'Добавить', cls: 'primary', onClick: function () {
          var inp = $('dm-text');
          if (inp && inp.value.trim()) {
            addShopText(inp.value);
            touch();
            renderShop();
            toast('Добавлено');
          }
        } },
      { label: 'Отмена', cls: 'soft' }
    ]
  });
  setTimeout(function () {
    var inp = $('dm-text');
    if (inp) inp.focus();
  }, 80);
  ov.addEventListener('keydown', function (e) { if (e.key === 'Enter') { var b = ov.querySelector('button[data-i="0"]'); if (b) b.click(); } });
}

function copyShop() {
  var text = state.shop.filter(function (x) { return !x.checked; }).map(function (x) { return '• ' + x.text; }).join('\n');
  if (!text) { toast('Нет некупленных позиций'); return; }
  copyText(text, 'Список покупок скопирован');
}

function copyText(text, okMsg) {
  var done = function () { toast(okMsg || 'Скопировано'); haptic('success'); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text, done); });
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, done) {
  try {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    done();
  } catch (e) { toast('Не удалось скопировать'); }
}

function clearChecked() {
  var n = state.shop.filter(function (x) { return x.checked; }).length;
  if (!n) { toast('Нет купленных позиций'); return; }
  state.shop = state.shop.filter(function (x) { return !x.checked; });
  touch();
  renderShop();
  toast('Убрано: ' + n);
}
function clearShop() {
  confirmDialog('Очистить список?', 'Все продукты будут удалены из списка покупок.', 'Очистить', function () {
    state.shop = [];
    touch();
    renderShop();
    toast('Список очищен');
  });
}

/* ======================= Конвертер ======================= */

function openConverter() {
  go('converter');
  renderConverter();
}
function renderConverter() {
  var products = Object.keys(DENSITY);
  $('converter-body').innerHTML =
    '<div class="topbar"><button class="icon-btn plain" onclick="back()" aria-label="Назад"><svg class="ic"><use href="#i-back"/></svg></button>' +
    '<h1 style="font-size:19px">Конвертер мер</h1></div>' +
    '<div class="page">' +
      '<div class="row2">' +
        '<div class="field"><label>Количество</label><input class="input" id="cv-a" type="number" value="1" min="0.1" step="0.1" oninput="calcConvert()"></div>' +
        '<div class="field"><label>Мера</label><select class="input" id="cv-f" onchange="calcConvert()">' +
          '<option value="glass">Стакан (250 мл)</option><option value="tbsp">Столовая ложка</option>' +
          '<option value="tsp">Чайная ложка</option><option value="gram">Граммы</option>' +
        '</select></div>' +
      '</div>' +
      '<div class="field"><label>Продукт</label><select class="input" id="cv-p" onchange="calcConvert()">' +
        products.map(function (p) { return '<option value="' + p + '">' + esc(DENSITY[p].name) + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="conv-result" id="cv-out">—</div>' +
      '<p class="muted mt12">Стакан — 250 мл, столовая ложка — с небольшой горкой. Значения приблизительные: зависит от помола и влажности продукта.</p>' +
    '</div>';
  calcConvert();
}
function calcConvert() {
  var a = parseFloat($('cv-a').value) || 0;
  var f = $('cv-f').value;
  var p = $('cv-p').value;
  var d = DENSITY[p];
  var out = '—';
  if (a > 0 && d) {
    if (f === 'gram') {
      out = normQty(a) + ' г ≈ ' + normQty(a / d.glass) + ' ст. и ' + Math.round((a / d.tbsp) * 10) / 10 + ' ст. л.';
    } else if (f === 'glass') {
      out = normQty(a) + ' ст. ≈ ' + Math.round(a * d.glass) + ' г';
    } else if (f === 'tbsp') {
      out = normQty(a) + ' ст. л. ≈ ' + Math.round(a * d.tbsp) + ' г';
    } else if (f === 'tsp') {
      out = normQty(a) + ' ч. л. ≈ ' + Math.round(a * d.tbsp / 3) + ' г';
    }
  }
  var node = $('cv-out');
  if (node) node.textContent = out;
}

/* ======================= Что в холодильнике ======================= */

function openFridge() {
  go('fridge');
  renderFridge();
}
function renderFridge() {
  $('fridge-body').innerHTML =
    '<div class="topbar"><button class="icon-btn plain" onclick="back()" aria-label="Назад"><svg class="ic"><use href="#i-back"/></svg></button>' +
    '<h1 style="font-size:19px">Что в холодильнике?</h1></div>' +
    '<div class="page">' +
      '<div class="search"><svg class="ic ic-sm"><use href="#i-search"/></svg>' +
        '<input id="fr-q" placeholder="Картофель, курица, лук" autocomplete="off" oninput="searchFridge()"></div>' +
      '<div id="fr-list" class="cards"></div>' +
    '</div>';
  $('fr-q').focus();
  searchFridge();
}
function searchFridge() {
  var q = ($('fr-q').value || '').toLowerCase().trim();
  var box = $('fr-list');
  if (!q) {
    box.innerHTML = emptyHTML('🧊', 'Введите продукты', 'Перечислите через запятую то, что есть под рукой — покажем подходящие рецепты', null, null);
    return;
  }
  var parts = q.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  var res = allRecipes().filter(function (r) { return !isLocked(r); }).map(function (r) {
    var hay = (r.ing || []).map(function (i) { return i[0]; }).join(' ').toLowerCase() + ' ' + r.name.toLowerCase();
    var found = parts.filter(function (p) { return hay.indexOf(p) > -1; }).length;
    return { r: r, found: found };
  }).filter(function (x) { return x.found > 0; })
    .sort(function (a, b) { return b.found - a.found; });

  if (!res.length) {
    box.innerHTML = emptyHTML('😕', 'Ничего не подошло', 'Попробуйте другие продукты или загляните в категории', null, null);
    return;
  }
  box.innerHTML = res.map(function (x) {
    return '<div class="rcard" data-open="' + x.r.id + '">' + thumbHTML(x.r, 'thumb') +
      '<div class="rc-body"><h3>' + esc(x.r.name) + '</h3>' +
      '<div class="fridge-match">совпало: ' + x.found + ' из ' + parts.length + '</div>' +
      '<div class="meta"><span>' + fmtMinutes(x.r.time) + '</span></div></div></div>';
  }).join('');
  box.onclick = function (e) {
    var c = e.target.closest('[data-open]');
    if (c) openDetail(c.getAttribute('data-open'));
  };
}

/* ======================= Замены ингредиентов ======================= */

function openSubs() {
  go('subs');
  renderSubs();
}
function renderSubs() {
  $('subs-body').innerHTML =
    '<div class="topbar"><button class="icon-btn plain" onclick="back()" aria-label="Назад"><svg class="ic"><use href="#i-back"/></svg></button>' +
    '<h1 style="font-size:19px">Замена ингредиентов</h1></div>' +
    '<div class="page">' +
      '<div class="search"><svg class="ic ic-sm"><use href="#i-search"/></svg>' +
        '<input id="sb-q" placeholder="Что заменить? Например: сметана" autocomplete="off" oninput="filterSubs()"></div>' +
      '<div id="sb-list"></div>' +
    '</div>';
  filterSubs();
}
function filterSubs() {
  var q = (($('sb-q') || {}).value || '').toLowerCase();
  var items = SUBSTITUTES.filter(function (s) {
    return (s.from + ' ' + s.to + ' ' + s.note).toLowerCase().indexOf(q) > -1;
  });
  $('sb-list').innerHTML = items.length
    ? items.map(function (s) {
        return '<div class="sub-item"><b>' + esc(s.from) + ' → ' + esc(s.to) + '</b><p>' + esc(s.note) + '</p></div>';
      }).join('')
    : emptyHTML('🤔', 'Не нашли замену', 'Попробуйте другое слово', null, null);
}

/* ======================= Профиль ======================= */

function renderProfile() {
  var body = $('profile-body');
  if (!body) return;
  var unlocked = isUnlocked();
  var tl = trialLeft();
  var stats = {
    own: state.recipes.length,
    favs: state.favs.length,
    plan: Object.keys(state.plan).length
  };
  var html = '';

  html += '<div class="profile-head">' +
    '<div class="avatar">' + (ui.userName ? esc(ui.userName.slice(0, 1).toUpperCase()) : '🍳') + '</div>' +
    '<div><div class="nm">' + (ui.userName ? esc(ui.userName) : 'Мои рецепты') + '</div>' +
    '<div class="st">' + (state.premium ? 'Безлимит активен' : (unlocked ? 'Пробный период: ' + tl + ' ' + plural(tl, 'день', 'дня', 'дней') : 'Бесплатная версия')) + '</div></div>' +
    '</div>';

  if (!state.premium) {
    html += '<div class="plan-card">' +
      '<div class="pc-top"><svg class="ic ic-sm"><use href="#i-crown"/></svg>' +
        (unlocked ? 'Пробный доступ' : 'Безлимит') + '</div>' +
      '<h3>' + (unlocked ? tl + ' ' + plural(tl, 'день', 'дня', 'дней') + ' полного доступа' : 'Все рецепты и свои без лимита') + '</h3>' +
      '<p>' + (unlocked
        ? 'Потом можно оформить безлимит навсегда — он останется с вами.'
        : '30 рецептов вместо 12, неограниченные свои рецепты, синхронизация и список покупок без ограничений.') + '</p>' +
      '<button class="btn" onclick="openPaywall()">' + (unlocked ? 'Открыть навсегда' : 'Открыть за ' + PREMIUM_VOTES + ' голосов') + '</button>' +
      '</div>';
  } else {
    html += '<div class="plan-card">' +
      '<div class="pc-top"><svg class="ic ic-sm"><use href="#i-crown"/></svg>Безлимит активен</div>' +
      '<h3>Спасибо, что с нами!</h3>' +
      '<p>Доступны все 30 рецептов, свои рецепты без ограничений и синхронизация между устройствами.</p>' +
      '</div>';
  }

  html += '<div class="quick" style="margin-bottom:16px">' +
    '<button class="qbtn" onclick="go(\'plan\')"><div class="qi" style="background:var(--amber-soft)">📅</div><b>План на неделю</b><small>' + stats.plan + ' из 7 дней</small></button>' +
    '<button class="qbtn" onclick="go(\'shop\')"><div class="qi" style="background:var(--blue-soft)">🧾</div><b>Покупки</b><small>' + state.shop.length + ' ' + plural(state.shop.length, 'позиция', 'позиции', 'позиций') + '</small></button>' +
    '<button class="qbtn" onclick="openConverter()"><div class="qi" style="background:var(--purple-soft)">⚖️</div><b>Конвертер</b><small>стаканы и граммы</small></button>' +
    '<button class="qbtn" onclick="openSubs()"><div class="qi" style="background:var(--green-soft)">🔄</div><b>Замены</b><small>чем заменить продукт</small></button>' +
    '</div>';

  html += '<div class="list-menu mb16">';
  if (!state.premium) {
    html += menuRow('i-crown', unlocked ? 'Открыть безлимит' : 'Открыть безлимит', PREMIUM_VOTES + ' голосов', 'openPaywall()');
    if (!state.trialStart) html += menuRow('i-sparkle', 'Пробный период', TRIAL_DAYS + ' дней бесплатно', 'startTrial()');
    else if (unlocked) html += menuRow('i-clock', 'Пробный период', 'осталось ' + tl + ' ' + plural(tl, 'день', 'дня', 'дней'), '');
  }
  html += menuRow('i-cloud', 'Синхронизация', syncLabel(), 'syncInfo()');
  html += menuRow('i-moon', 'Тема оформления', themeLabel(), 'cycleTheme()');
  html += '</div>';

  html += '<div class="list-menu mb16">';
  if (state.premium) html += menuRow('i-check', 'Восстановить покупку', 'проверить', 'restorePurchase()');
  else if (isVK()) html += menuRow('i-check', 'Восстановить покупку', 'проверить', 'restorePurchase()');
  html += menuRow('i-book', 'Пользовательское соглашение', '', 'openDoc(\'terms.html\')');
  html += menuRow('i-lock', 'Политика конфиденциальности', '', 'openDoc(\'privacy.html\')');
  html += menuRow('i-info', 'Лицензии фотографий', '', 'openDoc(\'credits.html\')');
  html += menuRow('i-user', 'Поддержка', '', 'openSupport()');
  html += menuRow('i-info', 'О приложении', '1.0.0', 'aboutApp()');
  html += menuRow('i-trash', 'Сбросить данные', '', 'resetData()', true);
  html += '</div>';

  html += '<p class="note">«Мои рецепты» · сделано с любовью к еде<br>Рецепты проверены, фотографии — со свободными лицензиями (подробности в разделе «Лицензии фотографий»).</p>';
  body.innerHTML = html;
}

function menuRow(icon, title, right, action, danger) {
  return '<button class="mrow' + (danger ? ' danger' : '') + '" onclick="' + action + '">' +
    '<svg class="ic"><use href="#' + icon + '"/></svg>' +
    '<span>' + esc(title) + '</span>' +
    '<span class="right">' + esc(right || '') + (action && !right ? '<svg class="ic ic-sm"><use href="#i-chevron"/></svg>' : (right && action ? '<svg class="ic ic-sm"><use href="#i-chevron"/></svg>' : '')) + '</span>' +
  '</button>';
}

function syncLabel() {
  if (!isVK()) return 'только на этом устройстве';
  if (ui.sync === 'ok') return 'включена';
  if (ui.sync === 'wait') return 'сохраняем…';
  if (ui.sync === 'error') return 'ошибка сети';
  return 'готова';
}
function themeLabel() {
  return state.theme === 'auto' ? 'как в системе' : (state.theme === 'dark' ? 'тёмная' : 'светлая');
}

function syncInfo() {
  dialog({
    title: 'Синхронизация',
    text: isVK()
      ? 'Рецепты, избранное, план и список покупок сохраняются в защищённом облачном хранилище платформы и подтягиваются при входе с другого устройства.'
      : 'Вы открыли приложение вне социальной сети, поэтому данные хранятся только в этом браузере. При запуске внутри платформы включается синхронизация.',
    buttons: [{ label: 'Понятно', cls: 'soft' }]
  });
}
function openDoc(name) {
  window.location.href = name;
}
function openSupport() {
  var url = SUPPORT_URL || APP_LINK;
  try {
    if (isVK()) { vkQuiet('VKWebAppOpenApp', { app_id: APP_ID }); }
    window.open(url, '_blank');
  } catch (e) {
    toast(url);
  }
}
function aboutApp() {
  dialog({
    title: 'Мои рецепты · 1.0.0',
    text: '30 проверенных рецептов с точными граммовками, план на неделю, список покупок и режим готовки с таймером. Фотографии — со свободными лицензиями Wikimedia Commons, авторы перечислены в разделе «Лицензии фотографий».',
    buttons: [{ label: 'Безлимит', cls: 'primary', onClick: openPaywall }, { label: 'Закрыть', cls: 'soft' }]
  });
}
function resetData() {
  confirmDialog('Сбросить данные?', 'Удалятся свои рецепты, избранное, план и список покупок. Безлимит и пробный период тоже сбросятся на этом устройстве.', 'Сбросить', function () {
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
    state.recipes = []; state.favs = []; state.plan = {}; state.shop = [];
    state.premium = false; state.trialStart = null; state.purchasedAt = null;
    FREE_IDS = null;
    touch();
    renderAll();
    toast('Данные сброшены');
  });
}

/* ======================= Оплата: лист ======================= */

function openPaywall() {
  if (state.premium) {
    toast('Безлимит уже активен');
    return;
  }
  var tl = trialLeft();
  var trialBtn = '';
  if (!state.trialStart) {
    trialBtn = '<button class="btn soft" onclick="startTrial()">Попробовать ' + TRIAL_DAYS + ' дней бесплатно</button>';
  } else if (tl > 0) {
    trialBtn = '<button class="btn soft" disabled>Пробный период активен: ' + tl + ' ' + plural(tl, 'день', 'дня', 'дней') + '</button>';
  }
  sheet(
    '<h2>Безлимит навсегда</h2>' +
    '<p class="sub">Один раз — и все рецепты ваши</p>' +
    '<ul class="prem-list">' +
      '<li><svg class="ic ic-sm"><use href="#i-check"/></svg><span>Все 30 рецептов с граммовками и таймерами</span></li>' +
      '<li><svg class="ic ic-sm"><use href="#i-check"/></svg><span>Свои рецепты без ограничений</span></li>' +
      '<li><svg class="ic ic-sm"><use href="#i-check"/></svg><span>Синхронизация между устройствами</span></li>' +
      '<li><svg class="ic ic-sm"><use href="#i-check"/></svg><span>План на неделю и список покупок — без лимитов</span></li>' +
      '<li><svg class="ic ic-sm"><use href="#i-check"/></svg><span>Все будущие обновления бесплатно</span></li>' +
    '</ul>' +
    '<div class="price-row"><div class="p">' + PREMIUM_VOTES + ' <small>голосов</small></div><div class="old">≈ ' + (PREMIUM_VOTES * 7) + ' ₽</div></div>' +
    (isIOS()
      ? '<button class="btn soft" onclick="buyPremium()">Покупка недоступна на iOS — почему?</button>'
      : '<button class="btn primary" onclick="buyPremium()">Оплатить голосами</button>') +
    trialBtn +
    '<p class="note">Платёж один раз, в защищённом окне платформы. Без подписок и автосписаний. Стоимость в рублях зависит от способа покупки голосов.</p>'
  );
}

/* ======================= Поделиться и ссылки ======================= */

function shareRecipe(id) {
  var r = findRecipe(id);
  if (!r) return;
  var link = APP_LINK + '#recipe_' + id;
  if (isVK()) {
    vk('VKWebAppShare', { link: link }).catch(function () {
      copyText(r.name + ' — ' + link, 'Ссылка скопирована');
    });
    return;
  }
  var text = r.name + ' — рецепт в приложении «Мои рецепты»: ' + link;
  if (navigator.share) {
    navigator.share({ title: r.name, text: r.name, url: link }).catch(function () {});
  } else {
    copyText(text, 'Ссылка скопирована');
  }
}

function handleHash() {
  var h = location.hash || '';
  var m = h.match(/#recipe_([a-z0-9_-]+)/i);
  if (m) {
    var r = findRecipe(m[1]);
    if (r) { openDetail(m[1]); return true; }
  }
  return false;
}

/* ======================= Онбординг ======================= */

var onbSlide = 0;
var ONB = [
  { emoji: '🍳', title: 'Рецепты, которые получаются', text: '30 проверенных рецептов с точными граммовками, шагами и таймерами для каждого этапа.' },
  { emoji: '📅', title: 'План и покупки без хлопот', text: 'Соберите меню на неделю — приложение само сложит продукты в список покупок.' },
  { emoji: '👨‍🍳', title: 'Готовьте по шагам', text: 'Большие подсказки, таймер под каждым шагом и экран не гаснет. Безлимит открывает все рецепты.' }
];
function showOnboarding() {
  onbSlide = 0;
  var wrap = el('<div class="onb" id="onb"></div>');
  document.body.appendChild(wrap);
  renderOnb();
}
function renderOnb() {
  var s = ONB[onbSlide];
  var last = onbSlide === ONB.length - 1;
  $('onb').innerHTML =
    '<div class="art"><div class="bubble">' + s.emoji + '</div></div>' +
    '<h2>' + esc(s.title) + '</h2>' +
    '<p>' + esc(s.text) + '</p>' +
    '<div class="dots">' + ONB.map(function (_, i) { return '<i class="' + (i === onbSlide ? 'on' : '') + '"></i>'; }).join('') + '</div>' +
    '<button class="btn primary" onclick="onbNext()">' + (last ? 'Начать' : 'Далее') + '</button>';
}
function onbNext() {
  if (onbSlide < ONB.length - 1) { onbSlide++; renderOnb(); return; }
  var node = $('onb');
  if (node) node.remove();
  state.onboarded = true;
  touch();
}

/* ======================= Инициализация ======================= */

function renderQuick() {
  var box = $('quick-actions');
  if (!box) return;
  box.innerHTML =
    '<button class="qbtn" onclick="go(\'plan\')"><div class="qi" style="background:var(--amber-soft)">📅</div><b>План недели</b><small>7 дней меню</small></button>' +
    '<button class="qbtn" onclick="go(\'shop\')"><div class="qi" style="background:var(--blue-soft)">🧾</div><b>Покупки</b><small>список продуктов</small></button>' +
    '<button class="qbtn" onclick="openConverter()"><div class="qi" style="background:var(--purple-soft)">⚖️</div><b>Конвертер</b><small>ложки и граммы</small></button>' +
    '<button class="qbtn" onclick="openSubs()"><div class="qi" style="background:var(--green-soft)">🔄</div><b>Замены</b><small>чем заменить</small></button>';
}

function bindHomeControls() {
  var seg = $('home-seg');
  if (seg) seg.onclick = function (e) {
    var b = e.target.closest('[data-tab]');
    if (!b) return;
    ui.homeTab = b.getAttribute('data-tab');
    renderHome();
  };
  var chips = $('home-chips');
  if (chips) chips.onclick = function (e) {
    var b = e.target.closest('[data-cat]');
    if (!b) return;
    ui.homeCat = b.getAttribute('data-cat');
    renderHome();
  };
}

function init() {
  loadLocal();
  applyTheme();
  renderQuick();
  bindHomeControls();
  go('home');
  if (!state.onboarded) showOnboarding();
  handleHash();
  window.addEventListener('hashchange', handleHash);
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onMq = function () { if (state.theme === 'auto') applyTheme(); };
    if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq);
  }
  if (isVK()) {
    vkQuiet('VKWebAppGetUserInfo', {}).then(function (res) {
      if (res && res.first_name) { ui.userName = res.first_name; renderProfile(); }
    });
    syncPull().then(function (cloud) {
      if (cloud && (cloud.updatedAt || 0) > (state.updatedAt || 0)) {
        state.recipes = cloud.recipes || [];
        state.favs = cloud.favs || [];
        state.plan = cloud.plan || {};
        state.shop = cloud.shop || [];
        state.premium = !!cloud.premium;
        state.purchasedAt = cloud.purchasedAt || null;
        state.trialStart = cloud.trialStart || null;
        state.onboarded = state.onboarded || !!cloud.onboarded;
        state.updatedAt = cloud.updatedAt || Date.now();
        saveLocal();
        ui.sync = 'ok';
        renderAll();
      } else if (!cloud) {
        syncPush();
      }
    });
    try {
      window.vkBridge.subscribe(function (e) {
        var t = e && e.detail && e.detail.type;
        if (t === 'VKWebAppShowOrderBoxResult') {
          if (e.detail.data && (e.detail.data.success || e.detail.data.result) && !state.premium) unlockPremium();
        }
        if (t === 'VKWebAppViewHide') { stopCookTimer(); releaseWakeLock(); }
        if (t === 'VKWebAppViewRestore') { if (ui.view === 'cook') renderCook(); }
      });
    } catch (err) {}
  }
  window.addEventListener('beforeunload', function () { stopCookTimer(); });
}

document.addEventListener('DOMContentLoaded', init);
