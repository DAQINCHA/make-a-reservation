import { icons } from './icons.js';
import {
  titles, singular, columns, orderedColumns, colors, groups, palette,
  dayKey, timeText, dateText, endDay, allDay, range, bookingStatus,
  roomInfo, roomStatus, compareEnd, reorder, avatarSrc, imageInfo,
  avatarError, mergeRecord, addDays, diffDays, weekdayOf, shortDay,
  bookingOnDay, rangeConflicts,
} from './domain.js';

const app = document.querySelector('#app');
const dialogs = document.querySelector('#dialogs');
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

const uuid = () => {
  try {
    if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch (error) {}
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 3) | 8;
    return v.toString(16);
  });
};

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const icon = (name, size = 24) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${
    (icons[name] || []).map(([tag, attrs]) =>
      `<${tag} ${Object.entries(attrs).filter(([k]) => k !== 'key').map(([k, v]) => `${k}="${esc(v)}"`).join(' ')}></${tag}>`
    ).join('')
  }</svg>`;

const button = (action, label, cls = 'secondary-button', ico = '', extra = '') =>
  `<button type="button" class="${cls}" data-action="${esc(action)}" ${extra}>${
    ico ? icon(ico, cls.includes('primary-button') ? 18 : cls.includes('compact') ? 15 : cls === 'room-block-button' ? 14 : cls.includes('icon-button') ? 15 : 16) : ''
  }${label}</button>`;

const ib = (action, name, label, title = label) =>
  button(
    action,
    icon(name, action === 'logout' ? 16 : action === 'password' ? 15 : state.views[state.entity] === 'cards' && state.entity === 'people' ? 16 : state.views[state.entity] === 'cards' ? 15 : 14),
    'icon-button',
    '',
    `aria-label="${esc(label)}" title="${esc(title)}"`,
  );

const viewTitle = (entity, view) =>
  entity === 'bookings'
    ? (view === 'cards' ? '预约统计' : '预约明细')
    : (view === 'cards' ? '卡片视图' : '表格视图');

const state = {
  user: null,
  data: {
    rooms: [],
    people: [],
    bookings: [],
    fields: { rooms: [], people: [], bookings: [] },
    hidden: { rooms: [], people: [], bookings: [] },
    columnOrder: { rooms: [], people: [], bookings: [] },
  },
  revision: 0,
  entity: 'bookings',
  home: true,
  views: { bookings: 'cards', rooms: 'cards', people: 'cards' },
  filter: 'all',
  filterPerson: '',
  search: '',
  tlStart: addDays(dayKey(Date.now()), matchMedia('(max-width: 767px)').matches ? 0 : -2),
  tlDays: matchMedia('(max-width: 767px)').matches ? 7 : 14,
  selected: [],
  sort: null,
  sorting: false,
  loading: false,
  saving: false,
  error: '',
  connectionError: '',
  lastSync: 0,
  mobile: false,
  modal: null,
  undoSnapshot: null,
};

const admin = () => state.user?.role === 'admin';
const ownBooking = (r) => !!r && r.personId === state.user.personId;
const canCreate = (e = state.entity) => admin() || e === 'bookings';
const canEdit = (r, e = state.entity) =>
  admin() || (e === 'bookings' && ownBooking(r)) || (e === 'people' && r.id === state.user.personId);
const canDelete = (r, e = state.entity) => admin() || (e === 'bookings' && ownBooking(r));
const self = (r) => state.entity === 'people' && r.id === state.user.personId;
const person = (id) => state.data.people.find((p) => p.id === id);
const room = (id) => state.data.rooms.find((r) => r.id === id);

let toastTimer;
function toast(message, error = false, allowUndo = false) {
  clearTimeout(toastTimer);
  const host = document.querySelector('#notifications');
  host.innerHTML = `<div class="toast ${error ? 'error' : ''}"><span>${esc(message)}</span>${
    allowUndo && state.undoSnapshot ? '<button type="button" class="toast-undo" data-action="undo">撤销</button>' : ''
  }</div>`;
  toastTimer = setTimeout(() => {
    host.replaceChildren();
    state.undoSnapshot = null;
  }, allowUndo ? 5000 : 3000);
}

async function api(path, method = 'GET', body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), path === '/api/workspace' && method === 'PUT' ? 120000 : 15000);
  const options = { method, cache: 'no-store', signal: controller.signal };
  if (body instanceof FormData) options.body = body;
  else if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  try {
    const response = await fetch(path, options);
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 401 && state.user && path !== '/api/password') {
        state.user = null;
        closeModal(true);
        render();
      }
      const error = Error(result.error || '保存失败，请重试');
      error.status = response.status;
      throw error;
    }
    return result;
  } catch (error) {
    if (!error.status || error.status >= 500) {
      state.connectionError =
        '连接中断，当前显示的可能是旧数据。' +
        (state.lastSync
          ? '上次同步：' + new Date(state.lastSync).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + '（北京时间）。'
          : '请检查网络或联系管理员。');
      if (!error.status) error.message = error.name === 'AbortError' ? '连接超时，请重试。' : '无法连接工作区，请检查网络后重试。';
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function load(quiet = false) {
  if (state.user?.mustChangePassword) {
    state.loading = false;
    return false;
  }
  try {
    const result = await api('/api/workspace');
    if (!state.saving && result.revision >= state.revision) {
      state.data = result.data;
      state.revision = result.revision;
      state.error = '';
      state.connectionError = '';
      state.lastSync = Date.now();
    }
    return true;
  } catch (e) {
    if (!quiet) state.error = e.message;
    return false;
  } finally {
    state.loading = false;
    if (!quiet || !state.modal) render();
    else updateSaveStatus();
  }
}

async function persist(data, avatarChange, options = {}) {
  if (state.saving) throw Error('正在保存，请稍候');
  const prevSnapshot = options.undo ? structuredClone(state.data) : null;
  state.saving = true;
  updateSaveStatus();
  try {
    const result = await api('/api/workspace', 'PUT', {
      data,
      revision: state.revision,
      ...(avatarChange ? { avatarChange } : {}),
    });
    state.data = result.data;
    state.revision = result.revision;
    state.error = '';
    state.connectionError = '';
    state.lastSync = Date.now();
    state.undoSnapshot = prevSnapshot;
    toast(options.message || '已保存到工作区', false, !!prevSnapshot);
  } finally {
    state.saving = false;
    updateSaveStatus();
  }
  render();
}

function updateSaveStatus() {
  const el = document.querySelector('.save-status');
  if (!el) return;
  const offline = !!state.connectionError;
  el.innerHTML =
    icon(offline || state.error ? 'circle-alert' : state.saving || state.loading ? 'refresh-cw' : 'check', 14) +
    ' ' +
    (offline ? '连接中断' : state.error ? '操作未完成' : state.saving ? '正在保存' : state.loading ? '正在连接' : '已保存');
}

/* ==================== 外观与皮肤（日/夜/自动 × 普通/毛玻璃/暗房） ==================== */
function theme() { return document.documentElement.classList.contains('dark'); }
function themeMode() { return localStorage.getItem('jingjian-theme') || 'system'; }
function skinMode() {
  const s = localStorage.getItem('jingjian-skin');
  return s === 'solid' || s === 'darkroom' ? s : 'glass';
}
function applyTheme() {
  const mode = themeMode();
  const skin = skinMode();
  const darkroom = skin === 'darkroom';
  const dark = darkroom || mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.classList.toggle('glass', skin === 'glass');
  document.documentElement.classList.toggle('darkroom', darkroom);
}

let appearanceOpen = false;
const APPEARANCE_THEMES = [['light', '日间', 'sun'], ['dark', '夜间', 'moon'], ['system', '自动', 'monitor']];
const APPEARANCE_SKINS = [['solid', '普通'], ['glass', '毛玻璃'], ['darkroom', '暗房']];

function appearanceChoice(action, label, active, ico = '') {
  return `<button type="button" class="appearance-choice" data-action="${action}" data-active="${active}" role="menuitemradio" aria-checked="${active}">${ico ? icon(ico, 14) : ''}${label}</button>`;
}

function appearanceControl() {
  const mode = themeMode();
  const skin = skinMode();
  const skinLabel = skin === 'darkroom' ? '暗房' : skin === 'glass' ? '毛玻璃' : '普通';
  const summaryLabel = skin === 'darkroom' ? '暗房' : `${theme() ? '夜间' : '日间'} · ${skinLabel}`;
  return `<div class="appearance-control" data-open="${appearanceOpen}">
    <button type="button" class="appearance-trigger" data-action="appearance" aria-haspopup="true" aria-expanded="${appearanceOpen}" aria-label="外观设置" title="外观设置">
      ${icon(theme() ? 'moon' : 'sun', 15)}<span class="appearance-label">${summaryLabel}</span>${icon('chevron-down', 13)}
    </button>
    <div class="appearance-popover" role="menu" aria-label="外观设置">
      ${skin !== 'darkroom' ? `<div class="appearance-group"><span class="appearance-caption">明暗</span><div class="appearance-choices">${APPEARANCE_THEMES.map(([k, l, i]) => appearanceChoice('theme:' + k, l, mode === k, i)).join('')}</div></div>` : ''}
      <div class="appearance-group"><span class="appearance-caption">外观</span><div class="appearance-choices">${APPEARANCE_SKINS.map(([k, l]) => appearanceChoice('skin:' + k, l, skin === k)).join('')}</div></div>
    </div>
  </div>`;
}

function refreshAppearance() {
  document.querySelectorAll('.appearance-control').forEach((el) => {
    const box = document.createElement('div');
    box.innerHTML = appearanceControl();
    el.replaceWith(box.firstElementChild);
  });
}

let userMenuOpen = false;
function mobileUserControl(me) {
  if (!state.user) return '';
  return `<div class="mobile-user-control" data-open="${userMenuOpen}">
    <button type="button" class="mobile-user-trigger" data-action="user-menu" aria-haspopup="true" aria-expanded="${userMenuOpen}" aria-label="账号菜单">
      <span class="avatar small ${esc(me?.color || 'violet')}">${me?.avatar ? `<img src="${avatarSrc(me.id, me.avatar)}" alt="">` : esc(state.user.name.slice(0, 1))}</span>
    </button>
    <div class="mobile-user-popover" role="menu" aria-label="账号菜单">
      <div class="mobile-user-info"><strong>${esc(state.user.name)}</strong><small>${esc(state.user.username)}</small></div>
      <button type="button" class="mobile-user-item" data-action="password" role="menuitem">${icon('key-round', 15)}修改密码</button>
      <button type="button" class="mobile-user-item danger-text" data-action="logout" role="menuitem">${icon('log-out', 15)}退出登录</button>
    </div>
  </div>`;
}
function refreshUserMenu() {
  const me = person(state.user?.personId);
  document.querySelectorAll('.mobile-user-control').forEach((el) => {
    const box = document.createElement('div');
    box.innerHTML = mobileUserControl(me);
    if (box.firstElementChild) el.replaceWith(box.firstElementChild);
  });
}

function avatar(p, large = false) {
  return `<span class="avatar ${large ? 'large' : 'small'} ${esc(p?.color || 'slate')}">${
    p?.avatar ? `<img src="${avatarSrc(p.id, p.avatar)}" alt="">` : esc(p?.name?.slice(0, 1) || '—')
  }</span>`;
}
function personName(p) { return `<span class="person-cell">${avatar(p)}${esc(p?.name || '暂无')}</span>`; }

function initialPasswordScreen() {
  if (app.querySelector('#initial-password-form')) return;
  app.innerHTML = `<main class="login-page"><section class="login-panel"><h1>设置管理员密码</h1><p>首次使用前，请将初始密码改为至少 8 个字符的新密码。</p><form id="initial-password-form">${field('currentPassword', '初始密码', '', 'password', true, '', true)}${field('newPassword', '新密码', '', 'password', true, '至少 8 个字符', true)}${field('confirmPassword', '确认新密码', '', 'password', true, '', true)}<p class="form-error" role="alert" hidden></p><button type="submit" class="primary-button">设置密码并进入工作区</button>${button('logout', '退出登录')}</form></section></main>`;
  const form = app.querySelector('form');
  form.elements.currentPassword.autocomplete = 'current-password';
  form.elements.newPassword.minLength = form.elements.confirmPassword.minLength = 8;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const buttons = [...form.querySelectorAll('button')];
    const error = form.querySelector('.form-error');
    buttons.forEach((b) => (b.disabled = true));
    error.hidden = true;
    try {
      const values = Object.fromEntries(new FormData(form));
      if (values.newPassword !== values.confirmPassword) throw Error('两次输入的新密码不一致');
      state.user = (await api('/api/password', 'POST', values)).user;
      state.revision = 0;
      state.loading = true;
      readHash();
      render();
      await load();
    } catch (e) {
      error.hidden = false;
      error.textContent = e.message;
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  });
}

function status(value) {
  return `<span class="status ${{ 使用中: 'busy', 待开始: 'upcoming', 可预约: 'available', 不可预约: 'blocked' }[value] || ''}">${value}</span>`;
}
function rowStatus(r) {
  return state.entity === 'bookings' ? bookingStatus(r) : state.entity === 'rooms' ? roomStatus(r, state.data) : '';
}
function bookingTime(b) {
  const whole = allDay(b);
  const end = whole ? endDay(b) : dayKey(b.end);
  return `<div class="booking-time">${dateText(b.start)}${dayKey(b.start) !== end ? ' – ' + dateText(whole ? end : b.end) : ''}${!whole ? `<small>${timeText(b.start)} – ${timeText(b.end)}</small>` : ''}</div>`;
}

function matchesSearch(e, r, q) {
  if (!q) return true;
  const hay = [r.name, r.note];
  if (e === 'bookings') {
    const rm = room(r.roomId);
    const pr = person(r.personId);
    hay.push(rm?.name, rm?.code, rm?.equipment, pr?.name, pr?.team);
  } else if (e === 'rooms') {
    hay.push(r.code, r.kind, r.location, r.equipment);
  } else {
    hay.push(r.role, r.team, r.email, r.phone);
  }
  return hay.filter(Boolean).join(' ').toLowerCase().includes(q);
}

function records() {
  const e = state.entity;
  const all = state.data[e].slice();
  if (e === 'people' && !admin()) {
    const at = all.findIndex((r) => r.id === state.user.personId);
    if (at > 0) all.unshift(...all.splice(at, 1));
  }
  const q = state.search.trim().toLowerCase();
  const rows = all.filter((r) => {
    if (e === 'bookings' && state.filterPerson && r.personId !== state.filterPerson) return false;
    const matchFilter =
      state.filter === 'all' ||
      (state.filter === 'mine'
        ? ownBooking(r)
        : e === 'people'
          ? r.team === state.filter
          : rowStatus(r) === state.filter);
    return matchFilter && matchesSearch(e, r, q);
  });
  if (e === 'bookings') {
    if (state.sort) {
      const { key, direction } = state.sort;
      const value = (b) =>
        key === 'time' ? Date.parse(b.end) : key === 'roomId' ? room(b.roomId)?.name || '' : person(b.personId)?.name || '';
      rows.sort((a, b) => {
        const x = value(a);
        const y = value(b);
        return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'zh-Hans-CN')) * (direction === 'asc' ? 1 : -1);
      });
    } else if (state.data.bookingOrder !== 'manual') {
      rows.sort(compareEnd);
    }
  }
  return { all, rows };
}

function navigate(e, mine = false, filter = null, view = null) {
  const home = e === 'home';
  const target = home ? 'bookings' : e;
  state.home = home;
  state.entity = target;
  if (view) state.views[target] = view;
  state.filter =
    target === 'bookings' && state.views[target] === 'cards'
      ? 'all'
      : filter || (mine || (!admin() && target === 'bookings') ? 'mine' : 'all');
  state.filterPerson = '';
  state.search = '';
  state.selected = [];
  state.sorting = false;
  state.error = '';
  state.mobile = false;
  history.replaceState(null, '', home ? '#home' : mine ? '#my-bookings' : '#' + e);
  render();
}

function login() {
  app.innerHTML = `<main class="login-page"><div class="login-theme">${appearanceControl()}</div><section class="login-panel"><img class="brand-image" src="/icons/icon-source.svg?v=violet-glass" alt="" width="39" height="39"><h1 class="login-brand">镜间</h1><p class="login-subtitle">光影之艺影棚管理系统</p><p class="login-hint">账号登录</p><form id="login-form"><label class="form-field"><span>账号</span><input name="username" autocomplete="username" autocapitalize="none" required maxlength="50"></label><label class="form-field"><span>密码</span><input name="password" type="password" autocomplete="current-password" required maxlength="128"></label><p class="form-error" role="alert" hidden></p><button class="primary-button" type="submit">${icon('log-in', 17)}登录</button></form></section></main>`;
  document.querySelector('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const b = form.querySelector('button');
    b.disabled = true;
    b.innerHTML = icon('log-in', 17) + '正在登录…';
    try {
      const values = Object.fromEntries(new FormData(form));
      state.user = (await api('/api/session', 'POST', values)).user;
      state.revision = 0;
      state.loading = true;
      history.replaceState(null, '', '#home');
      readHash();
      render();
      await load();
    } catch (error) {
      form.querySelector('.form-error').hidden = false;
      form.querySelector('.form-error').textContent = error.message;
    } finally {
      b.disabled = false;
      b.innerHTML = icon('log-in', 17) + '登录';
    }
  });
}

function bookingSummary(bookings) {
  const counts = { 待开始: 0, 使用中: 0, 已结束: 0 };
  const now = Date.now();
  for (const booking of bookings) counts[bookingStatus(booking, now)]++;
  return `<div class="section-summary"><span><b>${bookings.length}</b> 条预约</span><i></i><span>${counts['待开始']} 条待开始</span><span class="amber-text">${counts['使用中']} 条使用中</span><span>${counts['已结束']} 条已结束</span></div>`;
}

function bookingPeople(rows, bookings) {
  const visible = new Set(rows.map((booking) => booking.personId));
  const totals = new Map();
  const now = Date.now();
  for (const booking of bookings) {
    const count = totals.get(booking.personId) || { active: 0, total: 0 };
    count.total++;
    if (bookingStatus(booking, now) !== '已结束') count.active++;
    totals.set(booking.personId, count);
  }
  return state.data.people
    .filter((p) => visible.has(p.id))
    .map((p) => ({ person: p, ...totals.get(p.id) }))
    .sort((a, b) => b.total - a.total);
}

function bookingPersonCard({ person: p, active, total }, index) {
  const medal = ['🥇', '🥈', '🥉'][index];
  const rank = index + 1;
  return `<article class="person-card booking-person-card is-clickable ${esc(p.color)}" data-action="drill-person:${esc(p.id)}">${
    medal ? `<span class="booking-rank-medal" role="img" aria-label="第 ${rank} 名">${medal}</span>` : ''
  }<div class="person-accent ${esc(p.color)}"></div><div class="booking-person-head"><span class="booking-person-avatar">${avatar(p, true)}${
    rank === 1 ? '<span class="booking-avatar-crown" aria-hidden="true">👑</span>' : ''
  }</span><div><h2>${esc(p.name)}</h2><p>${esc(p.team || '未分组')}</p></div></div><div class="booking-person-stats"><div><span>正在预约</span><strong>${active}</strong><small>条</small></div><div><span>累计预约</span><strong>${total}</strong><small>条</small></div></div></article>`;
}

/* ==================== 首页：预约入口 + 排期时间轴 ==================== */
function homeView() {
  return `<div class="home-hero">${button('new-booking', `${icon('calendar-plus', 24)}<strong>我要预约</strong>`, 'home-cta', '', !state.revision || state.saving ? 'disabled' : '')}</div>${timelineView(state.data.bookings)}`;
}

/* ==================== 排期灯箱时间轴 ==================== */
function timelineView(rows) {
  const d = state.data;
  const today = dayKey(Date.now());
  const days = Array.from({ length: state.tlDays }, (_, i) => addDays(state.tlStart, i));
  const endIso = days[days.length - 1];
  const todayIdx = days.indexOf(today);

  if (!d.rooms.length) {
    return `<div class="empty-state">${icon('door-open')}<h3>还没有摄影间</h3>${admin() ? button('nav:rooms', '前往影棚状态', 'secondary-button') : ''}</div>`;
  }

  const lanesHtml = d.rooms.map((r) => {
    const info = roomInfo(r, d);
    const live = !r.blocked && !!info.active;
    const laneBookings = rows.filter((b) => b.roomId === r.id && endDay(b) >= state.tlStart && dayKey(b.start) <= endIso);
    const barsHtml = laneBookings.map((b) => {
      const p = person(b.personId);
      const bStart = dayKey(b.start);
      const bEnd = endDay(b);
      const clampedStart = bStart < state.tlStart ? state.tlStart : bStart;
      const clampedEnd = bEnd > endIso ? endIso : bEnd;
      const leftIdx = diffDays(state.tlStart, clampedStart);
      const span = diffDays(clampedStart, clampedEnd) + 1;
      const totalDays = diffDays(bStart, bEnd) + 1;
      const leftPct = ((leftIdx / state.tlDays) * 100).toFixed(4);
      const widthPct = ((span / state.tlDays) * 100).toFixed(4);
      const isLive = bookingStatus(b) === '使用中';
      const editable = canEdit(b, 'bookings') && !r.blocked;
      return `<div class="tl-bar ${esc(r.color)} ${isLive ? 'is-live' : ''} ${editable ? 'is-draggable' : ''}"
        data-tl-booking="${esc(b.id)}"
        data-editable="${editable}"
        data-left="${leftPct}"
        data-width="${widthPct}"
        title="${esc(b.name)} · ${esc(p?.name || '')} · ${shortDay(bStart)}${bStart !== bEnd ? '–' + shortDay(bEnd) : ''}">
        ${avatar(p)}
        <div class="tl-bar-info">
          <div class="tl-bar-title">${esc(b.name)}</div>
          <div class="tl-bar-meta">${esc(p?.name || '—')} · ${totalDays}天</div>
        </div>
        ${editable ? `<div class="tl-resize-handle" data-tl-resize="${esc(b.id)}"></div>` : ''}
      </div>`;
    }).join('');

    const cellsHtml = days.map((iso) => {
      const wd = weekdayOf(iso);
      const weekend = wd === 0 || wd === 6;
      return `<div class="tl-cell ${weekend ? 'is-weekend' : ''} ${iso === today ? 'is-today' : ''}" data-tl-room="${esc(r.id)}" data-tl-day="${iso}"></div>`;
    }).join('');

    const stateCls = r.blocked ? 'tl-state-blocked' : live ? 'tl-state-live' : 'tl-state-free';
    const stateText = r.blocked ? '不可预约' : live ? '使用中' : '可预约';
    return `<div class="tl-row">
      <div class="tl-room-cell ${esc(r.color)}">
        <div class="tl-room-name" title="${esc(r.name)}">${esc(r.name)}</div>
        <div class="tl-room-sub">${r.code ? `<span>${esc(r.code)}</span>` : ''}<span class="${stateCls}">${stateText}</span></div>
      </div>
      <div class="tl-lane ${r.blocked ? 'is-blocked' : ''}" data-lane-room="${esc(r.id)}" data-days="${state.tlDays}">
        ${cellsHtml}
        ${todayIdx >= 0 ? `<div class="tl-today-line" data-left="${(((todayIdx + 0.5) / state.tlDays) * 100).toFixed(4)}"></div>` : ''}
        <div class="tl-bars-layer">${barsHtml}</div>
      </div>
    </div>`;
  }).join('');

  return `<div class="tl-panel">
    <div class="tl-toolbar">
      <div class="tl-nav">
        ${button('tl-shift:-7', '', 'secondary-button compact', 'chevron-left', 'aria-label="上一周" title="上一周"')}
        ${button('tl-today', '今日', 'secondary-button compact')}
        ${button('tl-shift:7', '', 'secondary-button compact', 'chevron-right', 'aria-label="下一周" title="下一周"')}
        <span class="tl-range">${shortDay(state.tlStart)} – ${shortDay(endIso)}</span>
      </div>
      <div class="tl-zoom">
        <button type="button" data-action="tl-zoom:7" data-active="${state.tlDays === 7}">7天</button>
        <button type="button" data-action="tl-zoom:14" data-active="${state.tlDays === 14}">14天</button>
        <button type="button" data-action="tl-zoom:21" data-active="${state.tlDays === 21}">21天</button>
      </div>
    </div>
    <div class="tl-scroll" id="tl-scroll">
      <div class="tl-grid" data-days="${state.tlDays}">
        <div class="tl-row tl-header">
          <div class="tl-corner">摄影间</div>
          <div class="tl-days-head" data-days="${state.tlDays}">
            ${days.map((iso) => {
              const wd = weekdayOf(iso);
              const weekend = wd === 0 || wd === 6;
              return `<div class="tl-day-th ${weekend ? 'is-weekend' : ''} ${iso === today ? 'is-today' : ''}">
                <span>${iso === today ? '今日' : '周' + WEEKDAYS[wd]}</span>
                <strong>${Number(iso.slice(5, 7))}/${Number(iso.slice(8))}</strong>
              </div>`;
            }).join('')}
          </div>
        </div>
        ${lanesHtml}
      </div>
    </div>
  </div>`;
}

// CSP-safe CSSOM positioning (zero inline style attributes)
function applyTimelineStyles() {
  document.querySelectorAll('[data-days]').forEach((el) => {
    el.style.setProperty('--tl-days', el.dataset.days);
  });
  document.querySelectorAll('.tl-today-line[data-left]').forEach((el) => {
    el.style.left = el.dataset.left + '%';
  });
  document.querySelectorAll('.tl-bar[data-left]').forEach((el) => {
    el.style.left = `calc(${el.dataset.left}% + 4px)`;
    el.style.width = `calc(${el.dataset.width}% - 8px)`;
  });
}

function render() {
  if (!state.user) return login();
  if (state.user.mustChangePassword) return initialPasswordScreen();

  const prevTlScroll = document.querySelector('#tl-scroll')?.scrollLeft || 0;
  const activeSearch = document.activeElement?.id === 'list-search' ? document.activeElement.selectionStart : null;

  const errorMessage = state.connectionError || state.error;
  const e = state.entity;
  const d = state.data;
  const { all, rows } = records();
  const view = state.views[e];
  const cards = view === 'cards';
  const title = state.home ? '主页' : titles[e];
  const bookingCards = cards && e === 'bookings' ? bookingPeople(rows, all) : [];

  const busy = d.rooms.filter((r) => roomInfo(r, d).active).length;
  const available = d.rooms.filter((r) => roomStatus(r, d) === '可预约').length;
  const blocked = d.rooms.filter((r) => r.blocked).length;
  const teams = [...new Set(d.people.map((p) => p.team).filter(Boolean))];
  const me = person(state.user.personId);

  const metric = [
    ['全部预约', d.bookings.length, '条', 'calendar-days', 'bookings', 'all', 'table'],
    ['我的预约', d.bookings.filter(ownBooking).length, '条', 'calendar-check', 'bookings', 'mine', 'table'],
    ['空闲摄影间', available, '间', 'door-open', 'rooms', '可预约', 'cards'],
    ['在忙摄影间', busy, '间', 'aperture', 'rooms', '使用中', 'cards'],
  ];

  const tabDefs = [
    ['cards', e === 'bookings' ? 'trophy' : 'layout-grid'],
    ['table', 'table-2'],
  ];
  const filterPersonObj = state.filterPerson ? person(state.filterPerson) : null;

  app.innerHTML = `<div data-slot="sidebar-wrapper">
    <aside data-slot="sidebar" class="${state.mobile ? 'mobile-open' : ''}">
      <button class="sidebar-backdrop" data-action="sidebar" aria-label="关闭侧栏"></button>
      <div data-slot="sidebar-container" class="studio-sidebar">
        <div data-slot="sidebar-inner">
          <div data-slot="sidebar-header">
            <div class="brand">
              <img class="brand-image" src="/icons/icon-source.svg?v=violet-glass" alt="" width="39" height="39">
              <div>镜间<span>光影之艺影棚管理系统</span></div>
            </div>
          </div>
          <div data-slot="sidebar-content">
            <ul data-slot="sidebar-menu">
              ${[['home', 'house'], ['bookings', 'calendar-days'], ['rooms', 'door-open'], ['people', 'users']].map(([k, i]) => {
                const active = k === 'home' ? state.home : !state.home && e === k;
                const count = k === 'home' ? '' : d[k].length;
                return `<li>${button('nav:' + k, `${icon(i, 18)}<span class="nav-label">${k === 'home' ? '主页' : titles[k]}</span>${count === '' ? '' : `<span class="nav-count ${active ? '' : 'is-inactive'}" aria-hidden="${!active}">${count}</span>`}`, 'nav-button', '', `data-active="${active}"`)}</li>`;
              }).join('')}
            </ul>
          </div>
          <div data-slot="sidebar-footer">
            <div class="workspace-user">
              <span class="avatar ${esc(me?.color || 'violet')}">${me?.avatar ? `<img src="${avatarSrc(me.id, me.avatar)}" alt="">` : esc(state.user.name.slice(0, 1))}</span>
              <div class="workspace-name">${esc(state.user.name)}<small>${esc(state.user.username)}</small></div>
              ${ib('password', 'key-round', '修改密码')}
              ${ib('logout', 'log-out', '退出登录')}
            </div>
          </div>
        </div>
      </div>
    </aside>

    <main class="main-shell">
      <header class="topbar">
        <div>
          ${button('sidebar', `${icon('panel-left', 16)}<span class="crumb-trigger-label">工作台</span>`, '', '', 'data-slot="sidebar-trigger" aria-label="切换侧栏"')}
          <img class="mobile-brand" src="/icons/icon-source.svg?v=violet-glass" alt="" width="24" height="24">
          <span class="crumb-home">工作台</span>
          <span class="crumb-sep">${icon('chevron-right', 14)}</span>
          <strong>${title}</strong>
        </div>
        <div class="topbar-controls">
          <button type="button" class="cmd-trigger" data-action="cmd-open" aria-label="快捷搜索" title="快捷搜索 (⌘K)">
            ${icon('search', 14)}<span class="cmd-label">搜索</span><span class="cmd-kbd">⌘K</span>
          </button>
          ${appearanceControl()}
          <span class="save-status"></span>
          ${mobileUserControl(me)}
        </div>
      </header>

      <div class="page-content">
        <div class="page-heading">
          <div><h1>${title}</h1></div>
          ${state.home
            ? ''
            : canCreate()
              ? button('new', '新建' + singular[e], 'primary-button', 'plus', !state.revision || state.saving ? 'disabled' : '')
              : ''}
        </div>

        ${state.home
          ? `<div class="stats-grid">${metric.map(([label, value, unit, i, target, filter, v]) =>
              `<button type="button" class="stat-card" data-action="stat:${target}:${encodeURIComponent(filter)}:${v}">
                <div class="stat-top">${label}${icon(i, 18)}</div>
                <div class="stat-number">${String(value).padStart(2, '0')}<span>${unit}</span></div>
              </button>`
            ).join('')}</div>`
          : e === 'bookings'
            ? bookingSummary(d.bookings)
            : `<div class="section-summary">${
                e === 'rooms'
                  ? `<span><b>${d.rooms.length}</b> 个摄影空间</span><i></i><span class="green-text">${available} 间可预约</span><span class="amber-text">${busy} 间使用中</span>${blocked ? `<span>${blocked} 间不可预约</span>` : ''}`
                  : `<span><b>${d.people.length}</b> 位人员</span><i></i><span>${teams.length} 个团队</span>`
              }</div>`}

        ${errorMessage ? `<div class="error-banner" role="alert">${icon('circle-alert', 18)}<span>${esc(errorMessage)}</span>${button('reload', '重新加载', '')}</div>` : ''}

        ${state.home
          ? homeView()
          : `<section class="records-panel ${cards ? 'cards-panel' : ''} ${e === 'bookings' && cards ? 'booking-stats-panel' : ''}">
              <div class="panel-top">
                <div>
                  <div role="tablist" class="view-tabs">
                    ${tabDefs.map(([v, ico]) =>
                      button('view:' + v, viewTitle(e, v), '', ico, `data-slot="tabs-trigger" data-state="${view === v ? 'active' : 'inactive'}" role="tab" aria-selected="${view === v}"`)
                    ).join('')}
                  </div>
                </div>
                <div class="panel-actions">
                  ${admin() && !(e === 'bookings' && cards)
                    ? button('sorting', state.sorting ? '完成排序' : '调整顺序', 'secondary-button compact', 'arrow-up-down', `aria-pressed="${state.sorting}" ${state.saving || d[e].length < 2 ? 'disabled' : ''}`)
                    : ''}
                  ${admin() && e === 'bookings' && view === 'table' && d.bookingOrder === 'manual'
                    ? button('auto', '恢复自动排序', 'secondary-button compact', '', 'title="恢复按结束时间自动排序"')
                    : ''}
                  <span class="record-count">${e === 'bookings' && cards ? bookingCards.length + ' 位' : all.length + ' 条'}</span>
                  ${admin() ? button('fields', '字段设置', 'secondary-button compact', 'sliders-horizontal', !state.revision || state.saving ? 'disabled' : '') : ''}
                </div>
              </div>

              <div class="table-toolbar">
                <div class="status-filters">
                  ${(e === 'bookings' && cards
                    ? ['all']
                    : ['all', ...(e === 'bookings' && !admin() ? ['mine'] : []), ...(e === 'people' ? teams : e === 'bookings' ? ['待开始', '使用中', '已结束'] : ['可预约', '使用中', '不可预约'])]
                  ).map((f) =>
                    button(
                      'filter:' + encodeURIComponent(f),
                      (f === 'all' ? '全部' : f === 'mine' ? '我的预约' : esc(f)) +
                        (f === 'all' ? `<span>${all.length}</span>` : f === 'mine' ? `<span>${state.data.bookings.filter(ownBooking).length}</span>` : ''),
                      state.filter === f ? 'active' : '',
                      '',
                      state.sorting ? 'disabled' : '',
                    )
                  ).join('')}
                  ${filterPersonObj ? button('clear-person', `${esc(filterPersonObj.name)} ${icon('x', 13)}`, 'person-chip') : ''}
                </div>

                <div class="toolbar-right">
                  ${state.selected.length
                    ? `<div class="selection-actions"><span>已选 ${state.selected.length} 条</span>${button('delete-selected', e === 'bookings' ? '取消预约' : '删除', 'danger-text', e === 'bookings' ? 'ban' : 'trash-2')}${ib('unselect', 'x', '取消选择')}</div>`
                    : state.sorting
                      ? `<span class="sort-hint">拖动或方向键调序</span>`
                      : !(e === 'bookings' && cards)
                        ? `<input type="search" id="list-search" class="toolbar-search" value="${esc(state.search)}" placeholder="搜索…">`
                        : ''}
                </div>
              </div>

              ${state.loading
                ? `<div class="empty-state">${icon('refresh-cw')}<h3>正在连接</h3></div>`
                : !rows.length
                  ? emptyState()
                  : !cards
                    ? table(rows)
                    : e === 'rooms'
                      ? `<div class="room-grid">${rows.map(roomCard).join('')}</div>`
                      : e === 'bookings'
                        ? `<div class="people-grid booking-people-grid">${bookingCards.map(bookingPersonCard).join('')}</div>`
                        : `<div class="people-grid">${rows.map(personCard).join('')}</div>`}

              <div class="table-footer">
                <span>${e === 'bookings' && cards ? `共 ${bookingCards.length} 位` : `共 ${rows.length} 条`}</span>
                <span>${icon('clock-3', 14)}北京时间</span>
              </div>
            </section>`}
      </div>
    </main>

    <nav class="mobile-dock" aria-label="快捷导航">
      ${[['home', 'house', '主页'], ['bookings', 'calendar-days', '预约'], ['rooms', 'door-open', '影棚'], ['people', 'users', '人员']].map(([k, i, l]) => {
        const active = k === 'home' ? state.home : !state.home && e === k;
        return `<button type="button" data-action="nav:${k}" data-active="${active}">${icon(i, 18)}<span>${l}</span></button>`;
      }).join('')}
    </nav>
  </div>`;

  updateSaveStatus();
  applyTimelineStyles();

  const nextTlScroll = document.querySelector('#tl-scroll');
  if (nextTlScroll && prevTlScroll) nextTlScroll.scrollLeft = prevTlScroll;

  const selectAll = document.querySelector('[data-select="all"]');
  if (selectAll) {
    selectAll.indeterminate = rows.some((r) => state.selected.includes(r.id)) && !rows.every((r) => state.selected.includes(r.id));
  }

  const searchInput = document.querySelector('#list-search');
  if (searchInput) {
    searchInput.addEventListener('input', (ev) => {
      state.search = ev.target.value;
      render();
    });
    if (activeSearch !== null) {
      searchInput.focus();
      searchInput.setSelectionRange(activeSearch, activeSearch);
    }
  }
}

function emptyState() {
  const e = state.entity;
  const f = state.filter;
  const filtered = f !== 'all' || !!state.search || !!state.filterPerson;
  return `<div class="empty-state">${icon('file-text')}<h3>${filtered ? '暂无匹配记录' : '还没有' + singular[e]}</h3>${
    filtered
      ? button('clear-filters', '查看全部', 'secondary-button')
      : canCreate()
        ? button('new', '新建' + singular[e], 'secondary-button', 'plus', !state.revision ? 'disabled' : '')
        : ''
  }</div>`;
}

function cell(r, key) {
  const e = state.entity;
  if (key === 'name') {
    const content = (e === 'people' ? avatar(r) : '') + `<strong>${esc(r.name)}</strong>` + (self(r) ? '<i class="self-badge">本人</i>' : '');
    return canEdit(r) && !state.sorting ? button('edit:' + r.id, content, 'record-name') : `<span class="record-name is-static">${content}</span>`;
  }
  if (key.startsWith('custom-')) return `<span class="text-value">${esc(r.extra[key] || '—')}</span>`;
  if (key === 'status') return status(rowStatus(r));
  if (e === 'bookings') {
    if (key === 'roomId') {
      const p = room(r.roomId);
      return `<span class="room-tag ${esc(p?.color || 'slate')}">${esc(p?.name || '—')}</span>`;
    }
    if (key === 'personId') return personName(person(r.personId));
    if (key === 'time') return bookingTime(r);
  }
  if (e === 'rooms' && key === 'recent') {
    const info = roomInfo(r, state.data);
    return info.recent ? personName(person(info.recent.personId)) : '<span class="muted">尚未使用</span>';
  }
  return `<span class="text-value ${key === 'note' ? 'note-value' : ''}">${esc(r[key] || '—')}</span>`;
}

function actions(r) {
  const e = state.entity;
  return `${admin() && e === 'people' ? ib('account:' + r.id, 'key-round', '管理' + r.name + '的账号', '管理账号') : ''}${
    canCreate() && e !== 'bookings' ? ib('copy:' + r.id, 'copy', '以' + r.name + '为模板新建', '以此为模板新建') : ''
  }${canEdit(r) ? ib('edit:' + r.id, 'pencil', '编辑' + r.name, '编辑记录') : ''}${
    canDelete(r) ? ib('delete:' + r.id, e === 'bookings' ? 'ban' : 'trash-2', (e === 'bookings' ? '取消预约' : '删除') + r.name, e === 'bookings' ? '取消预约' : '删除记录') : ''
  }`;
}

function table(rows) {
  const e = state.entity;
  const selection = admin() || (e === 'bookings' && state.filter === 'mine');
  const rowActions = admin() || e === 'people' || e === 'bookings';
  const cols = orderedColumns(e, state.data).filter(([key]) => !state.data.hidden[e].includes(key));
  return `<div data-slot="table-container"><table class="records-table"><thead><tr>${
    selection ? `<th class="selection-cell"><input type="checkbox" aria-label="全选" data-select="all" ${rows.every((r) => state.selected.includes(r.id)) ? 'checked' : ''}></th>` : ''
  }<th class="row-number">#</th>${cols.map(([key, label]) => {
    if (e !== 'bookings' || !['roomId', 'personId', 'time'].includes(key)) return `<th>${esc(label)}</th>`;
    const active = state.sort?.key === key;
    return `<th class="sortable-th" aria-sort="${active ? (state.sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}">${button('sort:' + key, esc(label) + icon(active ? (state.sort.direction === 'asc' ? 'arrow-up' : 'arrow-down') : 'arrow-up-down', 13), 'sort-header' + (active ? ' active' : ''), '', `${state.sorting ? 'disabled' : ''} title="按${esc(label)}排序"`)}</th>`;
  }).join('')}${rowActions ? '<th class="row-actions">操作</th>' : ''}</tr></thead><tbody>${rows.map((r, i) =>
    `<tr data-card-id="${esc(r.id)}" ${state.selected.includes(r.id) ? 'data-state="selected"' : ''}>${
      selection ? `<td class="selection-cell"><input type="checkbox" aria-label="选择${esc(r.name)}" data-select="${esc(r.id)}" ${state.selected.includes(r.id) ? 'checked' : ''}></td>` : ''
    }<td class="row-number">${
      state.sorting && admin()
        ? `<button type="button" class="row-drag" draggable="true" data-drag="${esc(r.id)}" aria-label="拖动排序${esc(r.name)}">${String(i + 1).padStart(2, '0')}</button>`
        : String(i + 1).padStart(2, '0')
    }</td>${cols.map(([key, label]) => {
      const html = cell(r, key);
      const empty = html.replace(/<[^>]*>/g, '').trim() === '—';
      return `<td data-label="${esc(label)}" data-edit="${esc(r.id)}"${empty ? ' data-empty="true"' : ''}>${html}</td>`;
    }).join('')}${rowActions && (admin() || ownBooking(r) || self(r)) ? `<td class="record-actions-cell"><div class="row-buttons">${actions(r)}</div></td>` : ''}</tr>`
  ).join('')}</tbody></table></div>`;
}

function orderControls(r) {
  if (!admin() || !state.sorting) return '';
  const rows = state.data[state.entity];
  const at = rows.findIndex((x) => x.id === r.id);
  return `<div class="card-order" role="group" aria-label="${esc(r.name)}排序"><button type="button" class="drag-handle" draggable="true" data-drag="${esc(r.id)}" aria-label="拖动排序${esc(r.name)}">${icon('grip-vertical', 16)}<span>第 ${at + 1} 位</span></button><div>${button('move-up:' + r.id, '', 'icon-button', 'arrow-up', `aria-label="前移${esc(r.name)}" ${at === 0 || state.saving ? 'disabled' : ''}`)}${button('move-down:' + r.id, '', 'icon-button', 'arrow-down', `aria-label="后移${esc(r.name)}" ${at === rows.length - 1 || state.saving ? 'disabled' : ''}`)}</div></div>`;
}

function customDetails(r, e) {
  return state.data.fields[e].length
    ? `<dl class="custom-details">${state.data.fields[e].map((f) => `<div><dt>${esc(f.name)}</dt><dd>${esc(r.extra[f.id] || '—')}</dd></div>`).join('')}</dl>`
    : '';
}

function roomCard(r) {
  const info = roomInfo(r, state.data);
  const recent = person(info.recent?.personId);
  const active = info.active;
  const whole = active && allDay(active);
  const end = active ? (whole ? endDay(active) : dayKey(active.end)) : '';
  return `<article class="space-card ${esc(r.color)} ${esc(r.color)}-space ${r.blocked ? 'is-blocked' : ''}" data-card-id="${esc(r.id)}"><div class="space-accent ${esc(r.color)}"></div>${orderControls(r)}<div class="space-card-head"><span class="space-code">${esc(r.code || '未编号')}</span><div>${status(roomStatus(r, state.data))}${admin() ? ib('copy:' + r.id, 'copy', '以' + r.name + '为模板新建', '以此为模板新建') + ib('edit:' + r.id, 'pencil', '编辑' + r.name) : ''}</div></div><div class="space-name"><div class="space-icon ${esc(r.color)}">${icon('aperture', 29)}</div><div><h2>${esc(r.name)}</h2><span>${esc(r.kind || '摄影空间')}</span></div></div><div class="space-details"><span>${icon('maximize', 13)}${esc(r.area ? r.area + ' ㎡' : '—')}</span><span>${icon('map-pin', 13)}${esc(r.location || '—')}</span></div>${r.equipment ? `<p class="space-equipment">${esc(r.equipment)}</p>` : ''}${r.note ? `<p class="space-note">${esc(r.note)}</p>` : ''}<div class="space-session"><div class="recent-person"><span>${active ? '正在使用' : '最近使用'}</span>${recent ? personName(recent) : '<strong>尚未使用</strong>'}</div><div class="session-time"><span>${active ? '本场结束' : '最近拍摄'}</span><strong>${active ? (whole ? (end === dayKey(Date.now()) ? '今天结束' : dateText(end) + '结束') : (end !== dayKey(Date.now()) ? dateText(end) + ' ' : '') + timeText(active.end)) : info.recent ? dateText(info.recent.start) : '—'}</strong></div></div><div class="next-booking">${icon('clock-3', 14)}<span>${info.next ? `下一场 · ${dateText(info.next.start)}${allDay(info.next) ? '' : ' ' + timeText(info.next.start)} · ${esc(person(info.next.personId)?.name)}` : '暂无后续预约'}</span></div>${customDetails(r, 'rooms')}<div class="space-footer">${button('book:' + r.id, (r.blocked ? '不可预约' : '预约空间') + icon('arrow-up-right', 15), 'text-button', '', r.blocked || state.saving ? 'disabled' : '')}${admin() ? button('block:' + r.id, `<span>${r.blocked ? '解除屏蔽' : '屏蔽'}</span>`, 'room-block-button', r.blocked ? 'shield-check' : 'ban', `aria-label="${r.blocked ? '解除屏蔽' : '屏蔽'}${esc(r.name)}"`) + ib('delete:' + r.id, 'trash-2', '删除' + r.name) : ''}</div></article>`;
}

function personCard(p) {
  const history = state.data.bookings.filter((b) => b.personId === p.id);
  const latest = history.filter((b) => Date.parse(b.start) <= Date.now()).sort((a, b) => Date.parse(b.start) - Date.parse(a.start))[0];
  return `<article class="person-card ${esc(p.color)} ${self(p) ? 'is-self' : ''}" data-card-id="${esc(p.id)}">${orderControls(p)}<div class="person-accent ${esc(p.color)}"></div><div class="person-card-top">${avatar(p, true)}<div class="card-actions">${admin() ? ib('account:' + p.id, 'key-round', '管理' + p.name + '的账号', '管理账号') + ib('copy:' + p.id, 'copy', '以' + p.name + '为模板新建', '以此为模板新建') : ''}${canEdit(p) ? ib('edit:' + p.id, 'pencil', '编辑' + p.name, '编辑记录') : ''}</div></div><h2>${esc(p.name)}${self(p) ? '<i class="self-badge">本人</i>' : ''}<span>${esc(p.role || '未填写')}</span></h2><p class="person-team">${esc(p.team || '未分组')}</p><div class="person-contacts"><div>${icon('mail', 15)}${p.email ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : '<span>—</span>'}</div><div>${icon('phone', 15)}${p.phone ? `<a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : '<span>—</span>'}</div></div>${p.note ? `<p class="person-note">${esc(p.note)}</p>` : ''}${customDetails(p, 'people')}<div class="person-card-footer"><div><strong>${String(history.length).padStart(2, '0')}</strong><span>累计预约</span></div><div><span>最近使用</span><b>${latest ? dateText(latest.start) : '暂无'}</b></div>${admin() ? ib('delete:' + p.id, 'trash-2', '删除' + p.name) : ''}</div></article>`;
}

/* ==================== 弹窗与单弹窗区间日历 ==================== */
let previousFocus;
function modal(title, description, content, cls = 'editor-dialog', hideDescription = false) {
  previousFocus = document.activeElement;
  dialogs.innerHTML = `<dialog class="${cls}" aria-labelledby="dialog-title" aria-describedby="dialog-description"><div data-slot="dialog-header"><h2 data-slot="dialog-title" id="dialog-title">${esc(title)}</h2><p data-slot="dialog-description" id="dialog-description" ${hideDescription ? 'class="sr-only"' : ''}>${esc(description)}</p></div>${content}${button('close', icon('x', 16), '', '', 'data-slot="dialog-close" aria-label="关闭"')}</dialog>`;
  const el = dialogs.querySelector('dialog');
  el.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeModal();
  });
  el.addEventListener('click', (event) => {
    if (event.target === el) {
      const r = el.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeModal();
    }
  });
  el.showModal();
}

function closeModal(force = false) {
  if (!force && (state.saving || state.modal?.busy)) return;
  closeSheet();
  if (state.modal?.previewURL) URL.revokeObjectURL(state.modal.previewURL);
  dialogs.querySelector('dialog')?.close();
  dialogs.replaceChildren();
  state.modal = null;
  previousFocus?.focus();
}

function showError(error) {
  const target = dialogs.querySelector('.modal-error');
  if (!target) return;
  target.hidden = false;
  target.innerHTML =
    esc(error.message || error) +
    (error.status === 409 || String(error.message).includes('其他页面') ? button('modal-reload', '加载最新数据', '') : '');
}

function formActions(label, extraLeft = '') {
  return `<div class="modal-error form-error" role="alert" hidden></div><div class="form-actions">${extraLeft}${button('close', '取消', 'secondary-button')}<button class="primary-button" type="submit">${label}</button></div>`;
}

function field(key, label, value = '', type = 'text', required = false, placeholder = '', wide = false) {
  return `<label class="form-field ${wide || ['name', 'equipment', 'note'].includes(key) ? 'span-two' : ''}"><span>${esc(label)}${required ? '<em>*</em>' : ''}</span>${
    ['note', 'equipment'].includes(key)
      ? `<textarea name="${esc(key)}" maxlength="2000" rows="3" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
      : `<input name="${esc(key)}" value="${esc(value)}" type="${type}" ${required ? 'required' : ''} maxlength="${key === 'name' ? 100 : type === 'password' ? 128 : key.startsWith('custom-') ? 2000 : 200}" ${type === 'number' && key === 'area' ? 'min="0"' : ''} placeholder="${esc(placeholder)}" ${type === 'password' ? 'autocomplete="new-password"' : ''}>`
  }${type === 'date' ? `<button type="button" class="touch-select touch-date" data-action="date-open:${esc(key)}" data-label="${esc(label)}" aria-haspopup="dialog" aria-expanded="false"><span class="touch-select-value">${value ? dateLabel(value) : '选择日期'}</span>${icon('calendar-days', 16)}</button>` : ''}</label>`;
}

const dateLabel = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${Number(y)}年${Number(m)}月${Number(d)}日`;
};

function renderInlineRangeCalendar() {
  const m = state.modal;
  const host = dialogs.querySelector('#rc-box');
  if (!m || m.entity !== 'bookings' || !host) return;

  const today = dayKey(Date.now());
  const vs = m.start;
  const ve = m.end;
  const conflicts = m.roomId && vs && ve ? rangeConflicts(state.data.bookings, m.roomId, vs, ve, m.row?.id || '') : [];
  const conflictSet = new Set(conflicts.map((c) => c.day));
  const spanDays = vs && ve ? diffDays(vs, ve) + 1 : 0;

  const firstDow = new Date(Date.UTC(m.calYear, m.calMonth, 1)).getUTCDay();
  const daysInMon = new Date(Date.UTC(m.calYear, m.calMonth + 1, 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push('<span></span>');
  for (let d = 1; d <= daysInMon; d++) {
    const iso = `${m.calYear}-${String(m.calMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const hit = m.roomId ? bookingOnDay(state.data.bookings, m.roomId, iso, m.row?.id || '') : null;
    const hitPerson = hit ? person(hit.personId) : null;
    const isEdge = iso === vs || iso === ve;
    const inRange = vs && ve && iso > vs && iso < ve;
    const isCollision = conflictSet.has(iso);
    const cls = [
      'rc-day',
      iso === today ? 'is-today' : '',
      hit ? 'is-taken' : '',
      inRange ? 'in-range' : '',
      isEdge && !hit ? 'is-edge' : '',
      isCollision ? 'is-collision' : '',
    ].filter(Boolean).join(' ');
    cells.push(
      `<button type="button" class="${cls}" data-rc-day="${iso}" ${
        hit ? `data-taken="${esc((hitPerson?.name || '') + ' · ' + hit.name)}"` : ''
      }><span>${d}</span>${hit ? `<span class="taken-tag">${esc(hitPerson?.name?.slice(0, 1) || '•')}</span>` : ''}</button>`
    );
  }

  const startInput = dialogs.querySelector('#record-form input[name="start"]');
  const endInput = dialogs.querySelector('#record-form input[name="end"]');
  if (startInput) startInput.value = vs || '';
  if (endInput) endInput.value = ve || '';

  const submitBtn = dialogs.querySelector('#record-form [type="submit"]');
  if (submitBtn && !m.busy) submitBtn.disabled = conflicts.length > 0;

  const hasErr = conflicts.length > 0 || m.inspectError;
  const inspText = conflicts.length
    ? `${shortDay(conflicts[0].day)} 已被 ${person(conflicts[0].booking.personId)?.name || ''}（${conflicts[0].booking.name}）占用`
    : m.inspectText || '';

  host.innerHTML = `
    <div class="rc-top">
      <div class="rc-summary">
        <span>${vs ? (vs !== ve ? `${shortDay(vs)} – ${shortDay(ve)}` : shortDay(vs)) : '选择日期'}</span>
        ${spanDays ? `<span class="rc-days-badge">${spanDays} 天</span>` : ''}
      </div>
      <div class="rc-shortcuts">
        <button type="button" class="rc-chip" data-rc-quick="today">今天</button>
        <button type="button" class="rc-chip" data-rc-quick="tomorrow">明天</button>
        <button type="button" class="rc-chip" data-rc-quick="3days">3天</button>
        <button type="button" class="rc-chip" data-rc-quick="weekend">本周末</button>
      </div>
    </div>
    <div class="rc-nav">
      <button type="button" class="rc-nav-btn" data-rc-mon="-1" aria-label="上月">${icon('chevron-left', 15)}</button>
      <strong>${m.calYear}年${m.calMonth + 1}月</strong>
      <button type="button" class="rc-nav-btn" data-rc-mon="1" aria-label="下月">${icon('chevron-right', 15)}</button>
    </div>
    <div class="rc-weekdays">${WEEKDAYS.map((w) => `<span>${w}</span>`).join('')}</div>
    <div class="rc-days" id="rc-days">${cells.join('')}</div>
    <div class="rc-inspector ${hasErr ? 'is-error' : ''}" id="rc-inspector" ${inspText ? '' : 'hidden'}>${esc(inspText)}</div>
  `;

  const daysEl = host.querySelector('#rc-days');
  daysEl.addEventListener('mouseover', (ev) => {
    const btn = ev.target.closest('[data-rc-day]');
    if (!btn || !state.modal) return;
    const iso = btn.dataset.rcDay;
    const taken = btn.dataset.taken;
    const insp = host.querySelector('#rc-inspector');
    if (taken) {
      insp.hidden = false;
      insp.className = 'rc-inspector';
      insp.textContent = `${shortDay(iso)} · ${taken}`;
      return;
    }
    if (m.pickingEnd && m.hoverDay !== iso) {
      m.hoverDay = iso;
      const s = iso < m.start ? iso : m.start;
      const en = iso < m.start ? m.start : iso;
      const cList = m.roomId ? rangeConflicts(state.data.bookings, m.roomId, s, en, m.row?.id || '') : [];
      const cSet = new Set(cList.map((c) => c.day));
      daysEl.querySelectorAll('[data-rc-day]').forEach((el) => {
        const dStr = el.dataset.rcDay;
        const isTaken = !!el.dataset.taken;
        el.classList.toggle('in-range', dStr > s && dStr < en);
        el.classList.toggle('is-edge', !isTaken && (dStr === s || dStr === en));
        el.classList.toggle('is-collision', cSet.has(dStr));
      });
      const summary = host.querySelector('.rc-summary');
      if (summary) {
        summary.innerHTML = `<span>${s !== en ? `${shortDay(s)} – ${shortDay(en)}` : shortDay(s)}</span><span class="rc-days-badge">${diffDays(s, en) + 1} 天</span>`;
      }
      if (cList.length) {
        insp.hidden = false;
        insp.className = 'rc-inspector is-error';
        insp.textContent = `${shortDay(cList[0].day)} 已被 ${person(cList[0].booking.personId)?.name || ''}（${cList[0].booking.name}）占用`;
      } else {
        insp.hidden = true;
      }
    }
  });
}

function onRoomChange(roomId) {
  const m = state.modal;
  if (!m || m.entity !== 'bookings') return;
  m.roomId = roomId;
  m.pickingEnd = false;
  m.hoverDay = null;
  m.inspectText = '';
  m.inspectError = false;
  renderInlineRangeCalendar();
}

let sheetState = null;
function sheetDialog() {
  let el = document.getElementById('touch-sheet');
  if (!el) {
    el = document.createElement('dialog');
    el.id = 'touch-sheet';
    el.className = 'touch-sheet';
    document.body.appendChild(el);
    el.addEventListener('close', () => { sheetState = null; });
  }
  return el;
}
function openSheet(html) {
  const el = sheetDialog();
  el.innerHTML = html;
  if (!el.open) el.showModal();
}
function closeSheet() {
  const el = document.getElementById('touch-sheet');
  if (el && el.open) el.close();
  sheetState = null;
}

function openPickerSheet(key) {
  const dlg = document.querySelector('#dialogs dialog[open]');
  const select = dlg ? dlg.querySelector(`select[name="${key}"]`) : null;
  if (!select) return;
  const trigger = dlg.querySelector(`[data-action="picker:${key}"]`);
  const label = (trigger && trigger.dataset.label) || '请选择';
  sheetState = { kind: 'picker', key };
  openSheet(`<div class="touch-sheet-head"><strong>选择${esc(label)}</strong>${button('sheet-close', icon('x', 16), 'icon-button', '', 'aria-label="关闭"')}</div><div class="touch-sheet-list" role="listbox" aria-label="${esc(label)}">${
    [...select.options].filter((o) => o.value).map((o) =>
      `<button type="button" class="touch-option" role="option" aria-selected="${o.selected}" data-active="${o.selected}" data-action="picker-set:${key}:${esc(o.value)}" ${o.disabled ? 'disabled' : ''}><span class="touch-option-name">${esc(o.textContent)}</span>${o.disabled ? '<em>不可预约</em>' : ''}<span class="touch-option-check">${o.selected ? icon('check', 16) : ''}</span></button>`
    ).join('')
  }</div>`);
}

function openDateSheet(key) {
  const dlg = document.querySelector('#dialogs dialog[open]');
  const input = dlg ? dlg.querySelector(`input[name="${key}"]`) : null;
  if (!input) return;
  const value = (input.value || dayKey(Date.now())).slice(0, 10);
  const [y, m] = value.split('-').map(Number);
  sheetState = { kind: 'date', key, value, year: y, month: m - 1 };
  renderDateSheet();
}

function renderDateSheet() {
  const st = sheetState;
  if (!st || st.kind !== 'date') return;
  const dlg = document.querySelector('#dialogs dialog[open]');
  const trigger = dlg ? dlg.querySelector(`[data-action="date-open:${st.key}"]`) : null;
  const label = (trigger && trigger.dataset.label) || '日期';
  const first = new Date(st.year, st.month, 1).getDay();
  const days = new Date(st.year, st.month + 1, 0).getDate();
  const today = dayKey(Date.now());
  const cells = [];
  for (let i = 0; i < first; i += 1) cells.push('<span class="touch-cal-blank" aria-hidden="true"></span>');
  for (let d = 1; d <= days; d += 1) {
    const iso = `${st.year}-${String(st.month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push(`<button type="button" class="touch-cal-day" data-action="cal-pick:${iso}" data-active="${iso === st.value}" data-today="${iso === today}">${d}</button>`);
  }
  openSheet(`<div class="touch-sheet-head"><strong>选择${esc(label)}</strong>${button('sheet-close', icon('x', 16), 'icon-button', '', 'aria-label="关闭"')}</div><div class="touch-cal"><div class="touch-cal-nav">${button('cal-move:-1', icon('chevron-right', 16), 'cal-nav-button', '', 'aria-label="上个月"')}<strong>${st.year}年${st.month + 1}月</strong>${button('cal-move:1', icon('chevron-right', 16), 'cal-nav-button', '', 'aria-label="下个月"')}</div><div class="touch-cal-week">${WEEKDAYS.map((x) => `<span>${x}</span>`).join('')}</div><div class="touch-cal-grid">${cells.join('')}</div></div>`);
}

function picker(key, label, value, options, existingId = '') {
  const chosen = options.find((o) => o.id === value);
  return `<label class="form-field"><span>${label}<em>*</em></span><select name="${key}" class="form-select" aria-label="${label}"><option value="" disabled ${!value ? 'selected' : ''}>请选择${label}</option>${options.map((o) => `<option value="${esc(o.id)}" ${o.id === value ? 'selected' : ''} ${o.blocked && o.id !== existingId ? 'disabled' : ''}>${esc(o.name)}${o.blocked ? '（不可预约）' : ''}</option>`).join('')}</select><button type="button" class="touch-select" data-action="picker:${key}" data-label="${esc(label)}" aria-haspopup="dialog" aria-expanded="false"><span class="touch-select-value${chosen ? '' : ' is-placeholder'}">${chosen ? esc(chosen.name) : '请选择' + label}</span>${icon('chevron-down', 16)}</button></label>`;
}

function toggle(key, label, description, value) {
  return `<label class="switch-field span-two"><input type="checkbox" role="switch" name="${key}" ${value ? 'checked' : ''}><span>${label}<small>${description}</small></span></label>`;
}

function colorPalette(selected) {
  const list = groups.map((g) => [g[0], g[1].slice()]);
  if (!palette.includes(selected)) list.push(['原有', [selected]]);
  return `<div class="form-field span-two"><span>标识颜色</span><input type="hidden" name="color" value="${esc(selected)}"><div class="color-palette">${list.map(([label, entries]) => `<div class="color-group" role="group" aria-label="${label}标识颜色"><span class="color-group-label">${label}</span><div class="color-choices">${entries.map((c) => button('color:' + c, `<span class="color-swatch">${c === selected ? icon('check', 16) : ''}</span>`, 'color-choice ' + c + (c === selected ? ' selected' : ''), '', `aria-label="${colors[c]}" title="${colors[c]}" aria-pressed="${c === selected}"`)).join('')}</div></div>`).join('')}</div><small class="color-caption" aria-live="polite">已选 · ${colors[selected] || '自选颜色'}</small></div>`;
}

function editRecord(e, row = null, template = null, roomId = '', presetStart = '', presetEnd = '') {
  const d = state.data;
  const source = row || template || {};
  const defaultDay = dayKey(Date.now());
  const firstOpenRoom = d.rooms.find((r) => !r.blocked)?.id || '';
  const initStart = row?.start ? dayKey(row.start) : (presetStart || defaultDay);
  const initEnd = row?.end ? endDay(row) : (presetEnd || initStart);
  const initRoom = source.roomId || roomId || (e === 'bookings' ? firstOpenRoom : '');
  const [cy, cm] = initStart.split('-').map(Number);

  const values = {
    ...source,
    start: initStart,
    end: initEnd,
    roomId: initRoom,
    personId: source.personId || state.user.personId || '',
    color: source.color || palette[d[e].length % palette.length],
  };

  const m = (state.modal = {
    kind: 'record',
    entity: e,
    row,
    fieldSchema: JSON.stringify(d.fields[e]),
    template,
    id: row?.id || uuid(),
    avatarVersion: row?.avatar,
    avatarFile: null,
    avatarRemoved: false,
    busy: false,
    roomId: values.roomId,
    start: values.start,
    end: values.end,
    pickingEnd: false,
    hoverDay: null,
    calYear: cy,
    calMonth: cm - 1,
    inspectText: '',
    inspectError: false,
  });

  let content = field(
    'name',
    e === 'bookings' ? '拍摄主题' : e === 'rooms' ? '摄影间名称' : '姓名',
    source.name || '',
    'text',
    true,
    e === 'bookings' ? '拍摄主题' : '请输入名称',
  );

  if (e === 'people') {
    content += `<div class="form-field span-two"><span>头像</span><div class="avatar-editor"><span class="avatar large ${esc(values.color)}" id="avatar-preview">${row?.avatar ? `<img src="${avatarSrc(row.id, row.avatar)}" alt="头像预览">` : esc(source.name?.slice(0, 1) || '—')}</span><div class="avatar-actions"><input id="avatar-file" class="sr-only" type="file" accept="image/png,image/jpeg,image/webp,image/gif">${button('pick-avatar', row?.avatar ? '更换图片' : '上传头像', 'secondary-button compact', 'image-up')}${button('clear-avatar', '移除头像', 'text-button', 'trash-2', row?.avatar ? '' : 'hidden')}<small class="avatar-hint">PNG / JPEG / WebP / GIF，最大 3MB</small></div></div><p id="avatar-error" class="form-error" role="alert" hidden></p></div>`;
  }

  if (e === 'bookings') {
    content += picker('roomId', '摄影间', values.roomId, d.rooms.filter((r) => !r.blocked || r.id === row?.roomId), row?.roomId);
    content += !admin()
      ? `<label class="form-field"><span>预约人<em>*</em></span><div class="locked-value" aria-readonly="true">${esc(person(values.personId)?.name || '本人')}</div><input type="hidden" name="personId" value="${esc(values.personId)}"></label>`
      : picker('personId', '预约人', values.personId, d.people);
    if (!d.rooms.some((r) => !r.blocked) && !row?.roomId) {
      content += `<p class="form-error span-two">${d.rooms.length ? '没有可预约的摄影间' : '请先添加摄影间'}</p>`;
    }
    if (!d.people.length) content += '<p class="form-error span-two">请先添加人员</p>';
    if (room(values.roomId)?.blocked) {
      content += '<p class="form-notice span-two">该摄影间已屏蔽，仅可编辑备注或更换摄影间。</p>';
    }
    content += `<div class="form-field span-two"><span>预约日期<em>*</em></span><input type="hidden" name="start" value="${esc(values.start)}"><input type="hidden" name="end" value="${esc(values.end)}"><div class="rc-box" id="rc-box"></div></div>`;
    content += field('note', '拍摄备注', source.note || '', 'text', false, '备注');
  } else if (e === 'rooms') {
    content +=
      field('code', '空间编号', source.code || '', 'text', false, '如 1 号棚') +
      field('kind', '摄影间类型', source.kind || '', 'text', false, '如自然光棚') +
      field('area', '面积（㎡）', source.area || '', 'number') +
      field('location', '所在位置', source.location || '', 'text', false) +
      field('equipment', '设备配置', source.equipment || '') +
      field('note', '空间说明', source.note || '');
    if (admin()) content += toggle('blocked', '屏蔽摄影间', '停止新增预约，保留已有预约。', source.blocked);
  } else {
    content +=
      field('role', '角色', source.role || '', 'text', false) +
      field('team', '所属团队', source.team || '') +
      field('email', '邮箱', source.email || '', 'email') +
      field('phone', '联系电话', source.phone || '', 'tel') +
      field('note', '人员备注', source.note || '');
  }

  if (e !== 'bookings') content += colorPalette(values.color);
  if (d.fields[e].length) content += '<div class="form-divider span-two">自定义信息</div>';
  content += d.fields[e].map((f) => field(f.id, f.name, source.extra?.[f.id] || '', f.type)).join('');

  const extraLeft = row && e === 'bookings' && canDelete(row, 'bookings')
    ? button('modal-delete-booking:' + row.id, '取消预约', 'danger-button form-action-left')
    : '';

  modal(
    (row ? '编辑' : template ? '以模板新建' : '新建') + singular[e],
    template ? '新记录独立保存。' : '',
    `<form id="record-form"><div class="form-grid">${content}</div>${formActions(row ? '保存' : '创建', extraLeft)}</form>`,
    'editor-dialog',
    !template,
  );

  if (e === 'bookings') renderInlineRangeCalendar();

  dialogs.querySelector('#record-form').addEventListener('submit', saveRecord);
  const roomSelect = dialogs.querySelector('#record-form select[name="roomId"]');
  if (roomSelect) roomSelect.addEventListener('change', () => onRoomChange(roomSelect.value));

  const input = dialogs.querySelector('#avatar-file');
  if (input) {
    input.addEventListener('change', async () => {
      const file = input.files[0];
      input.value = '';
      if (!file) return;
      const error = dialogs.querySelector('#avatar-error');
      error.hidden = true;
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
        error.textContent = '请上传 PNG、JPEG、WebP 或 GIF 图片';
        error.hidden = false;
        return;
      }
      const invalid = avatarError(file.size, file.size <= 3 * 1024 * 1024 ? imageInfo(new Uint8Array(await file.arrayBuffer())) : null);
      if (invalid) {
        error.textContent = invalid;
        error.hidden = false;
        return;
      }
      if (m.previewURL) URL.revokeObjectURL(m.previewURL);
      m.avatarFile = file;
      m.avatarRemoved = false;
      m.previewURL = URL.createObjectURL(file);
      dialogs.querySelector('#avatar-preview').innerHTML = `<img src="${m.previewURL}" alt="头像预览">`;
      dialogs.querySelector('[data-action="pick-avatar"]').innerHTML = icon('image-up', 15) + '更换图片';
      dialogs.querySelector('[data-action="clear-avatar"]').hidden = false;
    });
  }
}

async function busyForm(form, work) {
  const buttons = [...form.querySelectorAll('button')];
  const submit = form.querySelector('[type="submit"]');
  const label = submit?.innerHTML;
  const m = state.modal;
  if (m?.busy) return;
  if (m) m.busy = true;
  buttons.forEach((b) => (b.disabled = true));
  if (submit) submit.textContent = '正在保存…';
  try {
    await work();
  } catch (error) {
    showError(error);
  } finally {
    if (m) m.busy = false;
    buttons.forEach((b) => (b.disabled = false));
    if (submit) submit.innerHTML = label;
  }
}

async function saveRecord(event) {
  event.preventDefault();
  const form = event.currentTarget;
  await busyForm(form, async () => {
    const m = state.modal;
    const e = m.entity;
    const v = Object.fromEntries(new FormData(form));
    if (m.fieldSchema !== JSON.stringify(state.data.fields[e])) {
      throw Error('字段设置已更新，请先复制填写内容，再关闭并重新打开记录。');
    }
    if (e === 'bookings') {
      if (!v.roomId) throw Error('请先选择摄影间');
      if (!v.personId) throw Error('请先选择预约人');
      if (!v.start || !v.end) throw Error('请选择预约日期');
      const conflicts = rangeConflicts(state.data.bookings, v.roomId, v.start.slice(0, 10), v.end.slice(0, 10), m.row?.id || '');
      if (conflicts.length) {
        throw Error(`「${room(v.roomId)?.name || '该摄影间'}」在 ${shortDay(conflicts[0].day)} 已有预约`);
      }
    }
    let avatarChange;
    let result = {
      id: m.id,
      name: v.name.trim(),
      extra: Object.fromEntries(state.data.fields[e].map((f) => [f.id, v[f.id] || ''])),
    };
    if (e === 'bookings') {
      result = { ...result, roomId: v.roomId || '', personId: v.personId || '', ...range(v.start, v.end, m.row), note: v.note || '' };
    } else if (e === 'rooms') {
      for (const k of ['code', 'kind', 'area', 'location', 'equipment', 'note', 'color']) result[k] = v[k] || '';
      result.blocked = !!v.blocked;
    } else {
      for (const k of ['role', 'team', 'email', 'phone', 'note', 'color']) result[k] = v[k] || '';
      if (m.avatarFile) {
        const bytes = new Uint8Array(await m.avatarFile.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        avatarChange = { personId: m.id, base64: btoa(binary), mime: m.avatarFile.type };
      } else if (m.avatarRemoved) {
        avatarChange = { personId: m.id, remove: true };
      }
      result.avatar = m.avatarRemoved ? undefined : m.avatarVersion || undefined;
    }
    const rows = state.data[e];
    if (m.row) {
      const latest = rows.find((r) => r.id === m.id);
      if (avatarChange && latest && latest.avatar !== m.row.avatar) {
        throw Error('头像已被其他人修改，请关闭并重新打开资料后核对。');
      }
      result = mergeRecord(m.row, result, latest);
    }
    const next = { ...state.data, [e]: m.row ? rows.map((r) => (r.id === m.id ? result : r)) : [...rows, result] };
    await persist(next, avatarChange);
    closeModal(true);
  });
}

async function reloadModal() {
  const m = state.modal;
  if (!m || m.busy) return;
  m.busy = true;
  try {
    const loaded = await load();
    if (state.modal === m) {
      showError(loaded ? '已加载最新数据，您的填写内容已保留。' : state.error || '加载失败，请重试。');
    }
  } finally {
    m.busy = false;
  }
}

async function accountEditor(p) {
  state.modal = { kind: 'account', person: p, busy: false };
  modal(
    p.name + '的登录账号',
    '修改后需重新登录。',
    `<form id="account-form"><div class="form-grid">${field('username', '账号', '', 'text', true, '', true)}${field('password', '密码', '', 'password', true, '至少 4 个字符', true)}</div>${formActions('正在加载…')}</form>`,
    'editor-dialog account-dialog',
  );
  const form = dialogs.querySelector('form');
  form.querySelectorAll('input,button').forEach((el) => (el.disabled = true));
  try {
    const { account } = await api('/api/accounts?personId=' + encodeURIComponent(p.id));
    if (state.modal?.person !== p) return;
    form.elements.username.value = account?.username || '';
    form.elements.username.minLength = 2;
    form.elements.username.maxLength = 50;
    form.elements.password.minLength = 4;
    form.elements.password.required = !account;
    form.elements.password.placeholder = account ? '留空则保留原密码' : '至少 4 个字符';
    form.elements.password.closest('label').querySelector('span').textContent = account ? '新密码' : '密码';
  } catch (error) {
    showError(error);
  } finally {
    form.querySelectorAll('input,button').forEach((el) => (el.disabled = false));
    form.querySelector('[type="submit"]').textContent = '保存账号';
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    busyForm(form, async () => {
      await api('/api/accounts', 'POST', { personId: p.id, ...Object.fromEntries(new FormData(form)) });
      toast('账号已更新');
      closeModal(true);
    });
  });
}

function passwordEditor() {
  state.modal = { kind: 'password', busy: false };
  modal(
    '修改密码',
    '修改后其它设备需要重新登录。',
    `<form id="password-form"><div class="form-grid">${field('currentPassword', '当前密码', '', 'password', true, '', true)}${field('newPassword', '新密码', '', 'password', true, '至少 4 个字符', true)}${field('confirmPassword', '确认新密码', '', 'password', true, '', true)}</div>${formActions('保存新密码')}</form>`,
    'editor-dialog account-dialog',
  );
  const form = dialogs.querySelector('form');
  form.elements.currentPassword.autocomplete = 'current-password';
  form.elements.newPassword.minLength = form.elements.confirmPassword.minLength = 4;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    busyForm(form, async () => {
      const v = Object.fromEntries(new FormData(form));
      if (v.newPassword !== v.confirmPassword) throw Error('两次输入的新密码不一致');
      if (v.newPassword === v.currentPassword) throw Error('新密码不能与当前密码相同');
      await api('/api/password', 'POST', v);
      toast('密码已更新');
      closeModal(true);
    });
  });
}

function fieldsEditor() {
  if (!admin()) return;
  const e = state.entity;
  state.modal = {
    kind: 'fields',
    baseRevision: state.revision,
    fields: structuredClone(state.data.fields[e]),
    hidden: [...state.data.hidden[e]],
    order: orderedColumns(e, state.data).map(([id]) => id),
    busy: false,
  };
  modal(
    '管理表格字段',
    '拖动调整列顺序，删除字段会同时删除其内容。',
    `<form id="fields-form"><div class="fields-list"></div>${button('add-field', '添加自定义字段', 'add-field', 'plus')}${formActions('保存字段设置')}</form>`,
    'fields-dialog',
  );
  renderFields();
  const form = dialogs.querySelector('form');
  form.addEventListener('input', (event) => {
    const el = event.target;
    if (el.dataset.fieldId) {
      const f = state.modal.fields.find((f) => f.id === el.dataset.fieldId);
      if (f) f[el.dataset.property] = el.value;
    }
  });
  form.addEventListener('change', (event) => {
    const el = event.target;
    if (el.dataset.visible) {
      const m = state.modal;
      m.hidden = el.checked ? m.hidden.filter((k) => k !== el.dataset.visible) : [...m.hidden, el.dataset.visible];
    }
  });
  form.addEventListener('keydown', (event) => {
    const handle = event.target.closest('[data-field-drag]');
    if (!handle || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const id = handle.dataset.fieldDrag;
    const m = state.modal;
    const at = m.order.indexOf(id);
    const other = m.order[at + (event.key === 'ArrowUp' ? -1 : 1)];
    if (other) {
      m.order = reorder(m.order.map((id) => ({ id })), id, other).map((row) => row.id);
      renderFields();
      dialogs.querySelector(`[data-field-drag="${CSS.escape(id)}"]`)?.focus();
    }
  });
  let dragging = null;
  form.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest('[data-field-drag]');
    if (!handle || event.button !== 0) return;
    dragging = { id: handle.dataset.fieldDrag, target: null };
    handle.setPointerCapture(event.pointerId);
  });
  form.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-field-row]');
    form.querySelectorAll('.field-drop-target').forEach((el) => el.classList.remove('field-drop-target'));
    if (row && row.dataset.fieldRow !== dragging.id) {
      dragging.target = row.dataset.fieldRow;
      row.classList.add('field-drop-target');
    } else dragging.target = null;
  });
  const finish = (event) => {
    if (!dragging) return;
    const { id, target } = dragging;
    dragging = null;
    form.querySelectorAll('.field-drop-target').forEach((el) => el.classList.remove('field-drop-target'));
    if (event.type === 'pointerup' && target) {
      const m = state.modal;
      m.order = reorder(m.order.map((id) => ({ id })), id, target).map((row) => row.id);
      renderFields();
    }
  };
  form.addEventListener('pointerup', finish);
  form.addEventListener('pointercancel', finish);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    busyForm(form, async () => {
      const e = state.entity;
      const m = state.modal;
      if (m.baseRevision !== state.revision) throw Error('工作区已更新，请关闭并重新打开字段设置。');
      const fields = m.fields.map((f) => ({ ...f, name: f.name.trim() }));
      if (fields.some((f) => !f.name)) throw Error('请填写字段名称');
      const ids = new Set(fields.map((f) => f.id));
      await persist({
        ...state.data,
        fields: { ...state.data.fields, [e]: fields },
        hidden: { ...state.data.hidden, [e]: m.hidden.filter((id) => !id.startsWith('custom-') || ids.has(id)) },
        columnOrder: { ...state.data.columnOrder, [e]: m.order },
        [e]: state.data[e].map((r) => ({ ...r, extra: Object.fromEntries(Object.entries(r.extra).filter(([k]) => ids.has(k))) })),
      });
      closeModal(true);
    });
  });
}

function renderFields() {
  const m = state.modal;
  const e = state.entity;
  const base = new Map(columns[e]);
  const custom = new Map(m.fields.map((f) => [f.id, f]));
  dialogs.querySelector('.fields-list').innerHTML = m.order.map((key, index) => {
    const label = base.get(key);
    const f = custom.get(key);
    const handle = `<button type="button" class="field-drag" data-field-drag="${esc(key)}" aria-label="调整${esc(label || f?.name || key)}顺序"><span class="field-position">${index + 1}</span>${icon('grip-vertical', 14)}</button>`;
    const visible = `<input type="checkbox" data-visible="${esc(key)}" aria-label="显示${esc(label || f?.name || key)}" ${m.hidden.includes(key) ? '' : 'checked'}>`;
    if (label) return `<div class="field-row" data-field-row="${esc(key)}">${handle}${visible}<span>${esc(label)}</span>${icon('lock-keyhole', 13)}<small>基础字段</small></div>`;
    if (!f) return '';
    return `<div class="field-row custom-field" data-field-row="${esc(key)}">${handle}${visible}<input aria-label="字段名称" data-field-id="${esc(f.id)}" data-property="name" value="${esc(f.name)}" maxlength="60"><select class="form-select" aria-label="字段类型" data-field-id="${esc(f.id)}" data-property="type">${[['text', '文本'], ['number', '数字'], ['date', '日期']].map(([value, lbl]) => `<option value="${value}" ${value === f.type ? 'selected' : ''}>${lbl}</option>`).join('')}</select>${ib('remove-field:' + f.id, 'trash-2', '删除字段' + f.name)}</div>`;
  }).join('');
  dialogs.querySelector('[data-action="add-field"]').disabled = m.fields.length >= 30;
}

function deleteEditor(ids, entity = state.entity) {
  state.modal = { kind: 'delete', entity, baseRevision: state.revision, ids, busy: false };
  const booking = entity === 'bookings';
  modal(
    booking ? `取消 ${ids.length} 条预约？` : `删除 ${ids.length} 条${singular[entity]}记录？`,
    booking ? '将释放对应时段。' : '删除后无法恢复。',
    `<div class="modal-error form-error" role="alert" hidden></div><div class="form-actions">${button('close', '取消')}${button('confirm-delete', booking ? '确认取消' : '确认删除', 'danger-button')}</div>`,
    'delete-dialog',
  );
}

/* ==================== 全局搜索指令面板 (⌘K) ==================== */
function openCommandPalette() {
  if (!state.user || state.user.mustChangePassword) return;
  closeModal(true);
  state.modal = { kind: 'cmd', busy: false };
  dialogs.innerHTML = `<dialog class="cmd-dialog" aria-label="快捷搜索"><div class="cmd-input-wrap">${icon('search', 16)}<input id="cmd-input" placeholder="搜索主题、摄影间、设备、人员…" autocomplete="off"><span class="cmd-kbd">ESC</span></div><div class="cmd-list" id="cmd-list"></div></dialog>`;
  const dlg = dialogs.querySelector('dialog');
  const inp = dlg.querySelector('#cmd-input');
  const listEl = dlg.querySelector('#cmd-list');

  const draw = (q = '') => {
    const kw = q.trim().toLowerCase();
    const today = dayKey(Date.now());
    const items = [
      { label: '新建预约', sub: '操作', act: 'new-booking' },
      { label: '排期时间轴', sub: '主页', act: 'nav:home' },
      { label: '暗房外观', sub: '皮肤', act: 'skin:darkroom' },
      ...state.data.rooms.map((r) => ({
        label: `${r.code ? r.code + ' ' : ''}${r.name}`,
        sub: [r.location, r.equipment].filter(Boolean).join(' · ') || '摄影间',
        act: r.blocked ? 'nav:rooms' : `book-day:${r.id}:${today}`,
      })),
      ...state.data.bookings.map((b) => ({
        label: b.name,
        sub: `${room(b.roomId)?.name || ''} · ${person(b.personId)?.name || ''} · ${shortDay(dayKey(b.start))}`,
        act: `inspect-booking:${b.id}`,
      })),
      ...state.data.people.map((p) => ({
        label: p.name,
        sub: [p.role, p.team, p.phone].filter(Boolean).join(' · ') || '人员',
        act: `drill-person:${p.id}`,
      })),
    ].filter((it) => !kw || `${it.label} ${it.sub}`.toLowerCase().includes(kw)).slice(0, 10);

    listEl.innerHTML = items.length
      ? items.map((it) => `<button type="button" class="cmd-item" data-cmd-act="${esc(it.act)}"><strong>${esc(it.label)}</strong><small>${esc(it.sub)}</small></button>`).join('')
      : '<div class="cmd-empty">无匹配结果</div>';
  };

  draw('');
  dlg.addEventListener('cancel', (ev) => { ev.preventDefault(); closeModal(true); });
  dlg.addEventListener('click', (ev) => {
    if (ev.target === dlg) closeModal(true);
    const btn = ev.target.closest('[data-cmd-act]');
    if (btn) {
      const act = btn.dataset.cmdAct;
      closeModal(true);
      runAction(act);
    }
  });
  inp.addEventListener('input', (ev) => draw(ev.target.value));
  dlg.showModal();
  inp.focus();
}

async function move(source, target) {
  if (!admin() || state.saving || source === target) return;
  const e = state.entity;
  await persist({ ...state.data, [e]: reorder(state.data[e], source, target), ...(e === 'bookings' ? { bookingOrder: 'manual' } : {}) });
}

/* ==================== 统一 Action 分发 ==================== */
async function runAction(rawAction, triggerEl = null) {
  const [name, ...rest] = rawAction.split(':');
  const id = rest.join(':');
  const e = state.entity;
  const r = state.data[e]?.find((x) => x.id === id);

  try {
    switch (name) {
      case 'appearance':
        appearanceOpen = !appearanceOpen;
        if (appearanceOpen && userMenuOpen) { userMenuOpen = false; refreshUserMenu(); }
        refreshAppearance();
        break;
      case 'user-menu':
        userMenuOpen = !userMenuOpen;
        if (userMenuOpen && appearanceOpen) { appearanceOpen = false; refreshAppearance(); }
        refreshUserMenu();
        break;
      case 'theme':
        localStorage.setItem('jingjian-theme', id);
        applyTheme();
        refreshAppearance();
        break;
      case 'skin':
        localStorage.setItem('jingjian-skin', id);
        applyTheme();
        refreshAppearance();
        break;
      case 'cmd-open':
        openCommandPalette();
        break;
      case 'sidebar': {
        state.mobile = !state.mobile;
        const aside = document.querySelector('[data-slot=sidebar]');
        if (aside) aside.classList.toggle('mobile-open', state.mobile);
        const trig = document.querySelector('[data-slot=sidebar-trigger]');
        if (trig) trig.setAttribute('aria-expanded', String(state.mobile));
        break;
      }
      case 'nav': {
        const dest = id === 'my-bookings' ? 'bookings' : id;
        const onlyMine = id === 'my-bookings';
        if (state.mobile) {
          state.mobile = false;
          const aside = document.querySelector('[data-slot=sidebar]');
          if (aside) {
            aside.classList.remove('mobile-open');
            setTimeout(() => navigate(dest, onlyMine), 260);
            break;
          }
        }
        navigate(dest, onlyMine);
        break;
      }
      case 'go-timeline':
        navigate('bookings', false, 'all', 'timeline');
        break;
      case 'stat': {
        const [entity, filterEnc, viewName] = rest;
        const filter = decodeURIComponent(filterEnc || 'all');
        navigate(entity, filter === 'mine', filter, viewName || (entity === 'bookings' ? 'table' : null));
        break;
      }
      case 'logout':
        userMenuOpen = false;
        await api('/api/session', 'DELETE');
        state.user = null;
        state.revision = 0;
        closeModal(true);
        render();
        break;
      case 'reload':
        await load();
        break;
      case 'modal-reload':
        await reloadModal();
        break;
      case 'view':
        state.views[e] = id;
        if (e === 'bookings' && id === 'cards') state.filter = 'all';
        state.sorting = false;
        if (e === 'bookings') state.selected = [];
        render();
        break;
      case 'filter':
        state.filter = decodeURIComponent(id);
        state.selected = [];
        render();
        break;
      case 'clear-person':
        state.filterPerson = '';
        render();
        break;
      case 'clear-filters':
        state.filter = 'all';
        state.filterPerson = '';
        state.search = '';
        render();
        break;
      case 'drill-person':
        state.home = false;
        state.entity = 'bookings';
        state.views.bookings = 'table';
        state.filter = 'all';
        state.filterPerson = id;
        state.search = '';
        history.replaceState(null, '', '#bookings');
        render();
        break;
      case 'tl-shift':
        state.tlStart = addDays(state.tlStart, Number(id));
        render();
        break;
      case 'tl-today':
        state.tlStart = addDays(dayKey(Date.now()), state.tlDays <= 7 ? 0 : -2);
        render();
        break;
      case 'tl-zoom':
        state.tlDays = Number(id);
        render();
        break;
      case 'sort':
        state.sort =
          state.sort?.key !== id
            ? { key: id, direction: 'asc' }
            : state.sort.direction === 'asc'
              ? { key: id, direction: 'desc' }
              : null;
        render();
        break;
      case 'sorting':
        if (!admin()) return;
        if (!state.sorting && e === 'bookings' && state.data.bookingOrder !== 'manual') {
          await persist({ ...state.data, bookings: [...state.data.bookings].sort(compareEnd), bookingOrder: 'manual' });
        }
        state.sorting = !state.sorting;
        state.sort = null;
        state.filter = 'all';
        render();
        break;
      case 'auto':
        await persist({ ...state.data, bookingOrder: 'auto' });
        break;
      case 'move-up':
      case 'move-down': {
        const rows = state.data[e];
        const at = rows.findIndex((x) => x.id === id);
        const to = rows[at + (name === 'move-up' ? -1 : 1)];
        if (to) await move(id, to.id);
        break;
      }
      case 'new':
        if (canCreate()) editRecord(e);
        break;
      case 'new-booking':
        if (canCreate('bookings')) editRecord('bookings');
        break;
      case 'edit':
        if (r && canEdit(r)) editRecord(e, r);
        break;
      case 'edit-booking': {
        const b = state.data.bookings.find((x) => x.id === id);
        if (b && canEdit(b, 'bookings')) editRecord('bookings', b);
        break;
      }
      case 'inspect-booking': {
        const b = state.data.bookings.find((x) => x.id === id);
        if (!b) break;
        if (canEdit(b, 'bookings')) editRecord('bookings', b);
        else toast(`${b.name} · ${person(b.personId)?.name || ''} · ${shortDay(dayKey(b.start))}–${shortDay(endDay(b))}`);
        break;
      }
      case 'modal-delete-booking': {
        const b = state.data.bookings.find((x) => x.id === id);
        if (b && canDelete(b, 'bookings')) {
          closeModal(true);
          deleteEditor([b.id], 'bookings');
        }
        break;
      }
      case 'copy':
        if (admin() && r && e !== 'bookings') editRecord(e, null, { ...r, id: '', name: r.name.slice(0, 95) + ' · 副本', extra: { ...r.extra } });
        break;
      case 'book':
        if (!room(id)?.blocked) editRecord('bookings', null, null, id);
        break;
      case 'book-day': {
        const [roomId, day] = rest;
        if (!room(roomId)?.blocked && canCreate('bookings')) editRecord('bookings', null, null, roomId, day, day);
        break;
      }
      case 'block':
        if (admin()) {
          const targetRoom = room(id);
          await persist(
            { ...state.data, rooms: state.data.rooms.map((rm) => (rm.id === id ? { ...rm, blocked: !rm.blocked } : rm)) },
            undefined,
            { undo: true, message: targetRoom?.blocked ? '已解除屏蔽' : '已屏蔽摄影间' },
          );
        }
        break;
      case 'delete':
        if (canDelete(r)) deleteEditor([id], e);
        break;
      case 'delete-selected': {
        const ids = state.selected.filter((x) => canDelete(state.data[e].find((row) => row.id === x)));
        if (ids.length) deleteEditor(ids, e);
        break;
      }
      case 'unselect':
        state.selected = [];
        render();
        break;
      case 'confirm-delete': {
        const m = state.modal;
        const targetEntity = m.entity || e;
        if (m.baseRevision !== state.revision) throw Error('工作区已更新，请关闭窗口后重试。');
        if (triggerEl) triggerEl.disabled = true;
        m.busy = true;
        try {
          await persist(
            { ...state.data, [targetEntity]: state.data[targetEntity].filter((row) => !m.ids.includes(row.id)) },
            undefined,
            { undo: true, message: targetEntity === 'bookings' ? '已取消预约' : '已删除记录' },
          );
          state.selected = [];
          closeModal(true);
          render();
        } finally {
          m.busy = false;
          if (triggerEl) triggerEl.disabled = false;
        }
        break;
      }
      case 'undo': {
        const snap = state.undoSnapshot;
        if (!snap || state.saving) break;
        state.undoSnapshot = null;
        await persist(snap, undefined, { message: '已撤销' });
        break;
      }
      case 'account':
        if (admin() && r) await accountEditor(r);
        break;
      case 'password':
        if (userMenuOpen) { userMenuOpen = false; refreshUserMenu(); }
        passwordEditor();
        break;
      case 'fields':
        if (admin()) fieldsEditor();
        break;
      case 'sheet-close':
        closeSheet();
        break;
      case 'picker':
        openPickerSheet(id);
        break;
      case 'picker-set': {
        const sep = id.indexOf(':');
        const key = id.slice(0, sep);
        const val = id.slice(sep + 1);
        const dlg = document.querySelector('#dialogs dialog[open]');
        const form = dlg ? dlg.querySelector('form') : null;
        const select = form ? form.elements[key] : null;
        if (select) select.value = val;
        const text = select && select.selectedOptions[0] ? select.selectedOptions[0].textContent : val;
        const trigger = dlg ? dlg.querySelector(`[data-action="picker:${key}"]`) : null;
        const valueEl = trigger ? trigger.querySelector('.touch-select-value') : null;
        if (valueEl) {
          valueEl.textContent = text;
          valueEl.classList.remove('is-placeholder');
        }
        closeSheet();
        if (key === 'roomId' && state.modal?.entity === 'bookings') onRoomChange(val);
        break;
      }
      case 'date-open':
        openDateSheet(id);
        break;
      case 'cal-move': {
        if (!sheetState || sheetState.kind !== 'date') break;
        let m = sheetState.month + Number(id);
        let y = sheetState.year;
        if (m < 0) { m += 12; y -= 1; }
        if (m > 11) { m -= 12; y += 1; }
        sheetState.month = m;
        sheetState.year = y;
        renderDateSheet();
        break;
      }
      case 'cal-pick': {
        if (!sheetState || sheetState.kind !== 'date') break;
        const dlg = document.querySelector('#dialogs dialog[open]');
        const input = dlg ? dlg.querySelector(`input[name="${sheetState.key}"]`) : null;
        if (input) {
          input.value = id;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const trigger = dlg ? dlg.querySelector(`[data-action="date-open:${sheetState.key}"]`) : null;
        const valueEl = trigger ? trigger.querySelector('.touch-select-value') : null;
        if (valueEl) valueEl.textContent = dateLabel(id);
        closeSheet();
        break;
      }
      case 'close':
        closeModal();
        break;
      case 'color':
        dialogs.querySelector('[name=color]').value = id;
        dialogs.querySelectorAll('.color-choice').forEach((el) => {
          const active = el.dataset.action === 'color:' + id;
          el.classList.toggle('selected', active);
          el.setAttribute('aria-pressed', String(active));
          el.querySelector('.color-swatch').innerHTML = active ? icon('check', 16) : '';
        });
        dialogs.querySelector('.color-caption').textContent = '已选 · ' + colors[id];
        if (dialogs.querySelector('#avatar-preview')) dialogs.querySelector('#avatar-preview').className = 'avatar large ' + id;
        break;
      case 'pick-avatar':
        dialogs.querySelector('#avatar-file').click();
        break;
      case 'clear-avatar': {
        const m = state.modal;
        if (m.previewURL) URL.revokeObjectURL(m.previewURL);
        m.avatarFile = null;
        m.avatarRemoved = true;
        m.previewURL = null;
        dialogs.querySelector('#avatar-preview').textContent = dialogs.querySelector('[name=name]').value.trim().slice(0, 1) || '—';
        if (triggerEl) triggerEl.hidden = true;
        dialogs.querySelector('[data-action="pick-avatar"]').innerHTML = icon('image-up', 15) + '上传头像';
        break;
      }
      case 'add-field': {
        const f = { id: 'custom-' + uuid(), name: '新字段', type: 'text' };
        state.modal.fields.push(f);
        state.modal.order.push(f.id);
        renderFields();
        break;
      }
      case 'remove-field':
        state.modal.fields = state.modal.fields.filter((f) => f.id !== id);
        state.modal.order = state.modal.order.filter((key) => key !== id);
        state.modal.hidden = state.modal.hidden.filter((key) => key !== id);
        renderFields();
        break;
    }
  } catch (error) {
    if (state.modal) showError(error);
    else {
      state.error = error.message;
      render();
    }
  }
}

/* ==================== 全局事件绑定 ==================== */
document.addEventListener('click', (event) => {
  const rcMon = event.target.closest('[data-rc-mon]');
  if (rcMon && state.modal?.entity === 'bookings') {
    let mon = state.modal.calMonth + Number(rcMon.dataset.rcMon);
    let yr = state.modal.calYear;
    if (mon < 0) { mon = 11; yr -= 1; }
    if (mon > 11) { mon = 0; yr += 1; }
    state.modal.calMonth = mon;
    state.modal.calYear = yr;
    renderInlineRangeCalendar();
    return;
  }
  const rcQuick = event.target.closest('[data-rc-quick]');
  if (rcQuick && state.modal?.entity === 'bookings') {
    const today = dayKey(Date.now());
    const q = rcQuick.dataset.rcQuick;
    if (q === 'today') {
      state.modal.start = today;
      state.modal.end = today;
    } else if (q === 'tomorrow') {
      const t = addDays(today, 1);
      state.modal.start = t;
      state.modal.end = t;
    } else if (q === '3days') {
      state.modal.start = today;
      state.modal.end = addDays(today, 2);
    } else if (q === 'weekend') {
      const wd = weekdayOf(today);
      const satOffset = wd === 0 ? 6 : (6 - wd);
      const sat = addDays(today, satOffset);
      state.modal.start = sat;
      state.modal.end = addDays(sat, 1);
    }
    state.modal.pickingEnd = false;
    state.modal.hoverDay = null;
    state.modal.inspectText = '';
    state.modal.inspectError = false;
    const [y, mon] = state.modal.start.split('-').map(Number);
    state.modal.calYear = y;
    state.modal.calMonth = mon - 1;
    renderInlineRangeCalendar();
    return;
  }
  const rcDay = event.target.closest('[data-rc-day]');
  if (rcDay && state.modal?.entity === 'bookings') {
    const iso = rcDay.dataset.rcDay;
    const taken = rcDay.dataset.taken;
    if (taken) {
      state.modal.inspectText = `${shortDay(iso)} · ${taken}`;
      state.modal.inspectError = true;
      renderInlineRangeCalendar();
      return;
    }
    state.modal.inspectText = '';
    state.modal.inspectError = false;
    if (!state.modal.pickingEnd) {
      state.modal.start = iso;
      state.modal.end = iso;
      state.modal.pickingEnd = true;
      state.modal.hoverDay = iso;
    } else {
      const s = iso < state.modal.start ? iso : state.modal.start;
      const en = iso < state.modal.start ? state.modal.start : iso;
      state.modal.start = s;
      state.modal.end = en;
      state.modal.pickingEnd = false;
      state.modal.hoverDay = null;
    }
    renderInlineRangeCalendar();
    return;
  }

  const target = event.target.closest('[data-action]');
  if (target && !target.disabled) {
    runAction(target.dataset.action, target);
    return;
  }

  const card = event.target.closest('.space-card');
  if (card && !state.sorting && !event.target.closest('[data-action],button,a,input,select,textarea,[data-drag]')) {
    const book = card.querySelector('.space-footer [data-action^="book:"]');
    if (book && !book.disabled) book.click();
    return;
  }

  // Touch tap on timeline bar or empty cell (keeps native horizontal swipe scrolling intact)
  if (lastPointerType === 'touch' && !state.saving && onTimeline()) {
    const barEl = event.target.closest('.tl-bar[data-tl-booking]');
    if (barEl) {
      runAction('inspect-booking:' + barEl.dataset.tlBooking);
      return;
    }
    const cell = event.target.closest('.tl-cell[data-tl-room]');
    if (cell && canCreate('bookings')) {
      const r = room(cell.dataset.tlRoom);
      if (r && !r.blocked) editRecord('bookings', null, null, r.id, cell.dataset.tlDay, cell.dataset.tlDay);
      return;
    }
  }

  if (appearanceOpen && !event.target.closest('.appearance-control')) {
    appearanceOpen = false;
    refreshAppearance();
  }
  if (userMenuOpen && !event.target.closest('.mobile-user-control')) {
    userMenuOpen = false;
    refreshUserMenu();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && appearanceOpen) {
    appearanceOpen = false;
    refreshAppearance();
  }
  if (event.key === 'Escape' && userMenuOpen) {
    userMenuOpen = false;
    refreshUserMenu();
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openCommandPalette();
  }
});

app.addEventListener('change', (event) => {
  const el = event.target;
  if (el.dataset.select) {
    const id = el.dataset.select;
    state.selected = id === 'all' ? (el.checked ? records().rows.map((r) => r.id) : []) : el.checked ? [...state.selected, id] : state.selected.filter((x) => x !== id);
    render();
  }
});

app.addEventListener('dblclick', (event) => {
  const id = event.target.closest('[data-edit]')?.dataset.edit;
  if (id && !state.sorting) {
    const r = state.data[state.entity].find((x) => x.id === id);
    if (r && canEdit(r)) editRecord(state.entity, r);
  }
});

/* ==================== 时间轴拖拽直约 / 改期 / 拉伸延展 ==================== */
let tlDrag = null;
let lastPointerType = 'mouse';
const onTimeline = () => state.home;
const dragPill = document.querySelector('#drag-pill');

function showDragPill(x, y, text, isError = false) {
  if (!dragPill) return;
  dragPill.hidden = false;
  dragPill.className = 'drag-pill' + (isError ? ' is-error' : '');
  dragPill.style.left = x + 'px';
  dragPill.style.top = y + 'px';
  dragPill.textContent = text;
}
function hideDragPill() {
  if (dragPill) dragPill.hidden = true;
}

function updateTlCreateHighlight(cx, cy) {
  document.querySelectorAll('.tl-cell.drag-select, .tl-cell.drag-conflict').forEach((el) => el.classList.remove('drag-select', 'drag-conflict'));
  if (!tlDrag || tlDrag.mode !== 'create') return;
  const s = tlDrag.anchorDay <= tlDrag.currentDay ? tlDrag.anchorDay : tlDrag.currentDay;
  const en = tlDrag.anchorDay <= tlDrag.currentDay ? tlDrag.currentDay : tlDrag.anchorDay;
  const conflicts = rangeConflicts(state.data.bookings, tlDrag.roomId, s, en);
  const cls = conflicts.length ? 'drag-conflict' : 'drag-select';
  const lane = document.querySelector(`.tl-lane[data-lane-room="${CSS.escape(tlDrag.roomId)}"]`);
  if (lane) {
    lane.querySelectorAll('.tl-cell').forEach((c) => {
      if (c.dataset.tlDay >= s && c.dataset.tlDay <= en) c.classList.add(cls);
    });
  }
  showDragPill(
    cx,
    cy,
    conflicts.length
      ? `${shortDay(conflicts[0].day)} 已有冲突`
      : `${shortDay(s)}${s !== en ? ' – ' + shortDay(en) : ''} · ${diffDays(s, en) + 1}天`,
    conflicts.length > 0,
  );
}

app.addEventListener('pointerdown', (event) => {
  lastPointerType = event.pointerType || 'mouse';
  if (event.pointerType === 'touch' || event.button !== 0 || !onTimeline() || state.saving) return;

  const resizeEl = event.target.closest('[data-tl-resize]');
  if (resizeEl) {
    const b = state.data.bookings.find((x) => x.id === resizeEl.dataset.tlResize);
    if (!b || !canEdit(b, 'bookings') || room(b.roomId)?.blocked) return;
    event.preventDefault();
    const lane = resizeEl.closest('.tl-lane');
    tlDrag = {
      mode: 'resize',
      booking: b,
      lane,
      origStart: dayKey(b.start),
      origEnd: endDay(b),
      targetEnd: endDay(b),
      startX: event.clientX,
      moved: false,
    };
    return;
  }

  const barEl = event.target.closest('.tl-bar[data-tl-booking]');
  if (barEl) {
    const b = state.data.bookings.find((x) => x.id === barEl.dataset.tlBooking);
    if (!b) return;
    const lane = barEl.closest('.tl-lane');
    tlDrag = {
      mode: 'move',
      booking: b,
      barEl,
      lane,
      editable: barEl.dataset.editable === 'true',
      origStart: dayKey(b.start),
      origEnd: endDay(b),
      startX: event.clientX,
      deltaDays: 0,
      moved: false,
    };
    return;
  }

  const cell = event.target.closest('.tl-cell[data-tl-room]');
  if (cell && canCreate('bookings')) {
    const r = room(cell.dataset.tlRoom);
    if (!r || r.blocked) return;
    event.preventDefault();
    tlDrag = { mode: 'create', roomId: r.id, anchorDay: cell.dataset.tlDay, currentDay: cell.dataset.tlDay };
    updateTlCreateHighlight(event.clientX, event.clientY);
  }
});

document.addEventListener('pointermove', (event) => {
  if (!tlDrag) return;
  if (tlDrag.mode === 'create') {
    const el = document.elementFromPoint(event.clientX, event.clientY)?.closest('.tl-cell[data-tl-room]');
    if (el && el.dataset.tlRoom === tlDrag.roomId) tlDrag.currentDay = el.dataset.tlDay;
    updateTlCreateHighlight(event.clientX, event.clientY);
  } else if (tlDrag.mode === 'move') {
    if (!tlDrag.editable) return;
    const dx = event.clientX - tlDrag.startX;
    if (!tlDrag.moved && Math.abs(dx) < 8) return;
    tlDrag.moved = true;
    const dayW = tlDrag.lane.getBoundingClientRect().width / state.tlDays;
    const shift = Math.round(dx / dayW);
    tlDrag.deltaDays = shift;
    const ns = addDays(tlDrag.origStart, shift);
    const ne = addDays(tlDrag.origEnd, shift);
    const conflicts = rangeConflicts(state.data.bookings, tlDrag.booking.roomId, ns, ne, tlDrag.booking.id);
    tlDrag.barEl.classList.add('is-dragging');
    tlDrag.barEl.style.transform = `translateX(${shift * dayW}px)`;
    showDragPill(
      event.clientX,
      event.clientY,
      conflicts.length ? `${shortDay(conflicts[0].day)} 已有冲突` : `${shortDay(ns)}${ns !== ne ? ' – ' + shortDay(ne) : ''}`,
      conflicts.length > 0,
    );
  } else if (tlDrag.mode === 'resize') {
    const dx = event.clientX - tlDrag.startX;
    if (!tlDrag.moved && Math.abs(dx) < 6) return;
    tlDrag.moved = true;
    const dayW = tlDrag.lane.getBoundingClientRect().width / state.tlDays;
    const delta = Math.round(dx / dayW);
    let nextEnd = addDays(tlDrag.origEnd, delta);
    if (nextEnd < tlDrag.origStart) nextEnd = tlDrag.origStart;
    tlDrag.targetEnd = nextEnd;
    const conflicts = rangeConflicts(state.data.bookings, tlDrag.booking.roomId, tlDrag.origStart, nextEnd, tlDrag.booking.id);
    showDragPill(
      event.clientX,
      event.clientY,
      conflicts.length ? `${shortDay(conflicts[0].day)} 已有冲突` : `${shortDay(tlDrag.origStart)} – ${shortDay(nextEnd)} · ${diffDays(tlDrag.origStart, nextEnd) + 1}天`,
      conflicts.length > 0,
    );
  }
});

document.addEventListener('pointerup', async () => {
  if (!tlDrag) return;
  const op = tlDrag;
  tlDrag = null;
  hideDragPill();
  document.querySelectorAll('.tl-cell.drag-select, .tl-cell.drag-conflict').forEach((el) => el.classList.remove('drag-select', 'drag-conflict'));

  if (op.mode === 'create') {
    const s = op.anchorDay <= op.currentDay ? op.anchorDay : op.currentDay;
    const en = op.anchorDay <= op.currentDay ? op.currentDay : op.anchorDay;
    if (!rangeConflicts(state.data.bookings, op.roomId, s, en).length) {
      editRecord('bookings', null, null, op.roomId, s, en);
    }
  } else if (op.mode === 'move') {
    op.barEl.classList.remove('is-dragging');
    op.barEl.style.transform = '';
    if (!op.moved) {
      if (canEdit(op.booking, 'bookings')) editRecord('bookings', op.booking);
      else toast(`${op.booking.name} · ${person(op.booking.personId)?.name || ''} · ${shortDay(op.origStart)}–${shortDay(op.origEnd)}`);
    } else if (op.deltaDays !== 0) {
      const ns = addDays(op.origStart, op.deltaDays);
      const ne = addDays(op.origEnd, op.deltaDays);
      if (!rangeConflicts(state.data.bookings, op.booking.roomId, ns, ne, op.booking.id).length) {
        const updated = { ...op.booking, ...range(ns, ne, op.booking) };
        try {
          await persist(
            { ...state.data, bookings: state.data.bookings.map((b) => (b.id === op.booking.id ? updated : b)) },
            undefined,
            { undo: true, message: `已改期至 ${shortDay(ns)}${ns !== ne ? ' – ' + shortDay(ne) : ''}` },
          );
        } catch (err) {
          state.error = err.message;
          render();
        }
      }
    }
  } else if (op.mode === 'resize' && op.moved && op.targetEnd !== op.origEnd) {
    if (!rangeConflicts(state.data.bookings, op.booking.roomId, op.origStart, op.targetEnd, op.booking.id).length) {
      const updated = { ...op.booking, ...range(op.origStart, op.targetEnd, op.booking) };
      try {
        await persist(
          { ...state.data, bookings: state.data.bookings.map((b) => (b.id === op.booking.id ? updated : b)) },
          undefined,
          { undo: true, message: `已调整结束日至 ${shortDay(op.targetEnd)}` },
        );
      } catch (err) {
        state.error = err.message;
        render();
      }
    }
  }
});

/* ==================== 表格/卡片原有拖拽排序 ==================== */
let dragId = null;
function clearDrop() {
  app.querySelectorAll('.drop-before,.drop-after,.drop-target').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-target'));
}
app.addEventListener('dragstart', (event) => {
  const el = event.target.closest('[data-drag]');
  if (!el || !state.sorting || state.saving) { event.preventDefault(); return; }
  dragId = el.dataset.drag;
  el.closest('[data-card-id]').classList.add('is-dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', dragId);
});
app.addEventListener('dragover', (event) => {
  const el = event.target.closest('[data-card-id]');
  if (!el || !dragId || !state.sorting || state.saving) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  clearDrop();
  const target = el.dataset.cardId;
  if (target === dragId) return;
  const rows = state.data[state.entity];
  el.classList.add('drop-target', rows.findIndex((r) => r.id === dragId) < rows.findIndex((r) => r.id === target) ? 'drop-after' : 'drop-before');
});
app.addEventListener('dragleave', (event) => {
  const el = event.target.closest('[data-card-id]');
  if (el && !el.contains(event.relatedTarget)) el.classList.remove('drop-before', 'drop-after', 'drop-target');
});
app.addEventListener('drop', async (event) => {
  const el = event.target.closest('[data-card-id]');
  if (!el || !dragId) return;
  event.preventDefault();
  const source = dragId;
  dragId = null;
  clearDrop();
  try {
    await move(source, el.dataset.cardId);
  } catch (error) {
    state.error = error.message;
    render();
  }
});
app.addEventListener('dragend', () => {
  dragId = null;
  clearDrop();
  app.querySelectorAll('.is-dragging').forEach((el) => el.classList.remove('is-dragging'));
});
app.addEventListener('keydown', async (event) => {
  const el = event.target.closest('[data-drag]');
  if (!el) return;
  const step = ['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : 0;
  if (!step) return;
  event.preventDefault();
  const rows = state.data[state.entity];
  const id = el.dataset.drag;
  const at = rows.findIndex((r) => r.id === id);
  const target = rows[at + step];
  if (target) {
    try {
      await move(id, target.id);
      app.querySelector(`[data-drag="${CSS.escape(id)}"]`)?.focus();
    } catch (error) {
      state.error = error.message;
      render();
    }
  }
});

/* ==================== 路由与智能同步 ==================== */
function readHash() {
  const h = location.hash.slice(1);
  state.home = !h || h === 'home';
  if (state.home) {
    state.entity = 'bookings';
  } else if (h === 'my-bookings') {
    state.entity = 'bookings';
  } else {
    state.entity = titles[h] && h !== 'home' ? h : 'bookings';
  }
  state.selected = [];
  state.sorting = false;
  state.filterPerson = '';
  state.filter =
    state.entity === 'bookings' && state.views.bookings === 'cards'
      ? 'all'
      : h === 'my-bookings' || (!admin() && state.entity === 'bookings')
        ? 'mine'
        : 'all';
}

window.addEventListener('hashchange', () => {
  if (state.user) {
    readHash();
    render();
  }
});

const canAutoRefresh = () =>
  !document.hidden && state.user && !state.user.mustChangePassword && !state.modal && !state.sorting && !state.saving && !tlDrag;

setInterval(() => { if (canAutoRefresh()) render(); }, 15000);
setInterval(() => { if (canAutoRefresh()) load(true); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && canAutoRefresh()) load(true); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { applyTheme(); if (state.user) render(); });
applyTheme();

async function start() {
  const rootCls = document.documentElement.classList;
  if (rootCls.add) {
    rootCls.add('app-enter');
    setTimeout(() => rootCls.remove('app-enter'), 900);
  }
  try {
    state.user = (await api('/api/session')).user;
    if (state.user) {
      state.loading = true;
      readHash();
      render();
      await load();
    } else {
      render();
    }
  } catch (error) {
    app.innerHTML = `<main class="login-page"><div class="login-panel"><h1>光影之艺影棚管理</h1><p>${esc(error.message)}</p>${button('reconnect', '重新连接', 'primary-button')}</div></main>`;
    app.querySelector('button').addEventListener('click', start);
  }
}

start();

if (document.modelContext?.registerTool) {
  document.modelContext.registerTool({
    name: 'get_studio_availability',
    title: '查看摄影间实时状态',
    description: '读取摄影间、当前预约、最近使用人和下一场预约，不修改记录。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: (input) => {
      if (!input || typeof input !== 'object' || Object.keys(input).length) throw Error('此工具不接受参数');
      if (!state.user) throw Error('请先登录');
      return state.data.rooms.map((r) => {
        const info = roomInfo(r, state.data);
        return {
          id: r.id,
          name: r.name,
          status: roomStatus(r, state.data),
          recentUser: person(info.recent?.personId)?.name || null,
          nextBooking: info.next ? { name: info.next.name, start: info.next.start, end: info.next.end } : null,
        };
      });
    },
  });
}
