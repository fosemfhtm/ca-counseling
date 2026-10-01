(() => {
  'use strict';

  const cfg = window.CA_CONFIG || {};
  const DEMO = !cfg.APPS_SCRIPT_URL || new URLSearchParams(location.search).has('demo');
  const API = (cfg.APPS_SCRIPT_URL || '').trim();
  const KEY_STORE = 'ca_admin_key';
  const PREF_STORE = 'ca_admin_prefs';
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

  const $ = (s) => document.querySelector(s);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  const DEFAULT_LOCATION = '교내 던킨도너츠';
  const prefs = Object.assign({ unit: 30, hourFrom: 9, hourTo: 20, weekend: false, location: '' },
    safeParse(store.get(PREF_STORE)));
  if (!prefs.location) prefs.location = DEFAULT_LOCATION;

  const MODE_TEXT = {
    toggle: { label: '새로 여는 시간의 장소', hint: '빈 칸에서 드래그하면 열리고, 열린 칸에서 드래그를 시작하면 닫힙니다.' },
    location: { label: '바꿀 장소', hint: '장소를 바꿀 칸(열림·예약됨)을 드래그로 고르세요. 저장하면 위 장소로 바뀝니다. 예약된 학생에게는 따로 알려주세요.' },
  };

  const state = {
    key: DEMO ? 'demo' : store.get(KEY_STORE),
    weekStart: mondayOf(new Date()),
    slots: [],              // 서버 슬롯
    cellSlot: new Map(),    // cellKey -> slot
    pendingAdd: new Set(),  // cellKey
    pendingRemove: new Set(), // slot id
    pendingLoc: new Set(),  // slot id (장소 변경)
    mode: 'toggle',         // 'toggle' | 'location'
    drag: null,
    saving: false,
  };

  /* ---------- 날짜 유틸 ---------- */
  function safeParse(s) { try { return JSON.parse(s) || {}; } catch (e) { return {}; } }
  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function mondayOf(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
  function toMin(hm) { const [h, m] = hm.split(':').map(Number); return h * 60 + m; }
  function fromMin(n) { return `${pad(Math.floor(n / 60))}:${pad(n % 60)}`; }
  function cellKey(date, min) { return `${date}|${fromMin(min)}`; }
  function cellDate(date, min) { const [y, m, d] = date.split('-').map(Number); return new Date(y, m - 1, d, Math.floor(min / 60), min % 60); }

  function days() {
    const n = prefs.weekend ? 7 : 5;
    return Array.from({ length: n }, (_, i) => addDays(state.weekStart, i));
  }

  /* ---------- 초기화 ---------- */
  function init() {
    $('#demo-banner').hidden = !DEMO;

    const hf = $('#hour-from'), ht = $('#hour-to');
    for (let h = 6; h <= 23; h++) {
      hf.add(new Option(`${pad(h)}시`, h));
      ht.add(new Option(`${pad(h + 1)}시`, h + 1));
    }
    hf.value = prefs.hourFrom; ht.value = prefs.hourTo;
    $('#unit').value = prefs.unit;
    $('#weekend').checked = prefs.weekend;
    $('#location').value = prefs.location;

    $('#login-form').addEventListener('submit', onLogin);
    $('#logout').addEventListener('click', () => { store.del(KEY_STORE); state.key = null; showLogin(); });
    $('#prev-week').addEventListener('click', () => moveWeek(-7));
    $('#next-week').addEventListener('click', () => moveWeek(7));
    $('#this-week').addEventListener('click', () => moveWeek(0));
    $('#unit').addEventListener('change', (e) => changeView(() => { prefs.unit = Number(e.target.value); }, e.target, prefs.unit));
    hf.addEventListener('change', () => { prefs.hourFrom = Math.min(Number(hf.value), prefs.hourTo - 1); hf.value = prefs.hourFrom; savePrefs(); render(); });
    ht.addEventListener('change', () => { prefs.hourTo = Math.max(Number(ht.value), prefs.hourFrom + 1); ht.value = prefs.hourTo; savePrefs(); render(); });
    $('#weekend').addEventListener('change', (e) => { prefs.weekend = e.target.checked; savePrefs(); load(); });
    $('#location').addEventListener('change', (e) => { const v = e.target.value.trim(); if (v) { prefs.location = v; savePrefs(); } });
    $('#location').addEventListener('input', () => { if (state.pendingLoc.size) document.querySelectorAll('#grid .tg-cell').forEach(paintCell); });
    document.querySelectorAll('[name="mode"]').forEach((r) => r.addEventListener('change', (e) => {
      state.mode = e.target.value;
      applyModeText();
      render();
    }));
    applyModeText();
    $('#save').addEventListener('click', save);
    $('#discard').addEventListener('click', () => { clearPending(); render(); });

    const grid = $('#grid');
    grid.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);
    window.addEventListener('beforeunload', (e) => { if (pendingCount()) { e.preventDefault(); e.returnValue = ''; } });

    if (state.key) showBoard(); else showLogin();
  }

  function savePrefs() { store.set(PREF_STORE, JSON.stringify(prefs)); }

  function applyModeText() {
    $('#loc-label').textContent = MODE_TEXT[state.mode].label;
    $('#mode-hint').textContent = MODE_TEXT[state.mode].hint;
    $('#grid').classList.toggle('mode-location', state.mode === 'location');
  }

  function showLogin() { $('#login').hidden = false; $('#board').hidden = true; }
  function showBoard() { $('#login').hidden = true; $('#board').hidden = false; load(); }

  async function onLogin(e) {
    e.preventDefault();
    const key = e.target.key.value.trim();
    const err = $('#login-error');
    err.hidden = true;
    state.key = key;
    const res = await listSlots().catch(() => ({ ok: false, error: '서버에 연결하지 못했습니다.' }));
    if (!res.ok) { err.textContent = res.error; err.hidden = false; state.key = null; return; }
    store.set(KEY_STORE, key);
    e.target.reset();
    showBoard();
  }

  function confirmDiscard() {
    return !pendingCount() || confirm('저장하지 않은 변경 사항이 있습니다. 버리고 이동할까요?');
  }

  function moveWeek(delta) {
    if (!confirmDiscard()) return;
    state.weekStart = delta === 0 ? mondayOf(new Date()) : addDays(state.weekStart, delta);
    clearPending();
    load();
  }

  function changeView(apply, select, prev) {
    if (!confirmDiscard()) { select.value = prev; return; }
    apply(); savePrefs(); clearPending(); indexSlots(); render();
  }

  /* ---------- 데이터 ---------- */
  async function load() {
    setStatus('불러오는 중…');
    try {
      const res = await listSlots();
      if (!res.ok) {
        if (res.code === 'BAD_KEY') { store.del(KEY_STORE); state.key = null; showLogin(); $('#login-error').textContent = res.error; $('#login-error').hidden = false; return; }
        throw new Error(res.error);
      }
      state.slots = res.slots;
      indexSlots();
      setStatus('');
      render();
    } catch (err) {
      console.error(err);
      setStatus('불러오지 못했습니다: ' + (err.message || '네트워크 오류'), true);
    }
  }

  function indexSlots() {
    state.cellSlot.clear();
    const u = prefs.unit;
    state.slots.forEach((s) => {
      const m = toMin(s.start);
      const k = cellKey(s.date, m - (m % u));
      const cur = state.cellSlot.get(k);
      // 한 칸에 여러 슬롯이 겹치면 예약된 것을 우선 표시
      if (!cur || (s.status === '예약됨' && cur.status !== '예약됨')) state.cellSlot.set(k, s);
    });
  }

  function listSlots() {
    return call({ action: 'adminList', from: ymd(state.weekStart), to: ymd(addDays(state.weekStart, 6)) });
  }

  async function call(body) {
    body.key = state.key;
    if (DEMO) return demoCall(body);
    const res = await fetch(API, { method: 'POST', body: JSON.stringify(body) });
    return res.json();
  }

  /* ---------- 렌더 ---------- */
  function setStatus(msg, isError) {
    const el = $('#board-status');
    el.textContent = msg;
    el.classList.toggle('is-error', !!isError);
  }

  function cellState(date, min) {
    const k = cellKey(date, min);
    const slot = state.cellSlot.get(k);
    const past = cellDate(date, min) < new Date();
    const reloc = !!(slot && state.pendingLoc.has(slot.id));
    if (slot && slot.status === '예약됨') return { k, slot, cls: 'booked', past, reloc };
    const isOpen = slot && slot.status !== '닫힘';
    if (isOpen && state.pendingRemove.has(slot.id)) return { k, slot, cls: 'removing', past, reloc: false };
    if (isOpen) return { k, slot, cls: 'open', past, reloc };
    if (state.pendingAdd.has(k)) return { k, slot, cls: 'adding', past, reloc: false };
    return { k, slot, cls: '', past, reloc: false };
  }

  function render() {
    const ds = days();
    const u = prefs.unit;
    const grid = $('#grid');
    grid.style.setProperty('--cols', ds.length);
    const frag = document.createDocumentFragment();

    const corner = document.createElement('div');
    corner.className = 'tg-corner';
    frag.append(corner);
    const today = ymd(new Date());
    ds.forEach((d) => {
      const h = document.createElement('div');
      h.className = 'tg-day' + (ymd(d) === today ? ' is-today' : '');
      h.innerHTML = `<span>${WEEKDAYS[d.getDay()]}</span><strong>${d.getMonth() + 1}/${d.getDate()}</strong>`;
      frag.append(h);
    });

    const now = new Date();
    for (let m = prefs.hourFrom * 60; m < prefs.hourTo * 60; m += u) {
      const t = document.createElement('div');
      t.className = 'tg-time' + (m % 60 === 0 ? ' is-hour' : '');
      t.textContent = m % 60 === 0 ? fromMin(m) : '';
      frag.append(t);
      ds.forEach((d, col) => {
        const date = ymd(d);
        const c = document.createElement('div');
        c.className = 'tg-cell' + (cellDate(date, m) < now ? ' is-past' : '') + (m % 60 === 0 ? ' is-hour' : '');
        c.dataset.col = col;
        c.dataset.date = date;
        c.dataset.min = m;
        c.setAttribute('role', 'gridcell');
        paintCell(c);
        frag.append(c);
      });
    }
    grid.replaceChildren(frag);

    const end = addDays(state.weekStart, ds.length - 1);
    $('#week-label').textContent = `${state.weekStart.getMonth() + 1}월 ${state.weekStart.getDate()}일 – ${end.getMonth() + 1}월 ${end.getDate()}일`;
    updateSavebar();
  }

  // 칸의 상태 클래스·글자·툴팁 갱신
  function paintCell(c) {
    const date = c.dataset.date, m = Number(c.dataset.min);
    const st = cellState(date, m);
    c.classList.remove('open', 'adding', 'removing', 'booked', 'reloc');
    if (st.cls) c.classList.add(st.cls);
    if (st.reloc) c.classList.add('reloc');
    const s = st.slot;
    const shown = s && (st.cls === 'open' || st.cls === 'booked' || st.cls === 'removing');
    const loc = st.reloc ? locationInput() : (s && s.location) || '';
    if (st.cls === 'booked') c.textContent = s.name || '예약';
    else if (shown && state.mode === 'location') c.textContent = loc;
    else c.textContent = '';
    const [, mo, dd] = date.split('-').map(Number);
    c.title = `${mo}/${dd} ${fromMin(m)}` + (shown ? ` (${s.start}–${s.end})` : '') +
      (st.cls === 'booked' ? ` 예약됨${s.name ? ' — ' + s.name : ''}` : '') + (shown && loc ? ` · ${loc}` : '');
  }

  function locationInput() { return $('#location').value.trim(); }

  function pendingCount() { return state.pendingAdd.size + state.pendingRemove.size + state.pendingLoc.size; }
  function clearPending() { state.pendingAdd.clear(); state.pendingRemove.clear(); state.pendingLoc.clear(); }

  function updateSavebar() {
    const a = state.pendingAdd.size, r = state.pendingRemove.size, l = state.pendingLoc.size;
    const parts = [a && `${a}칸 열기`, r && `${r}칸 닫기`, l && `${l}칸 장소 변경`].filter(Boolean);
    $('#pending-text').textContent = parts.length ? parts.join(' · ') : '변경 사항 없음';
    $('#save').disabled = !parts.length || state.saving;
    $('#discard').disabled = !parts.length || state.saving;
  }

  /* ---------- 드래그 ---------- */
  function cellFrom(target) {
    const c = target && target.closest && target.closest('.tg-cell');
    if (!c || c.classList.contains('is-past')) return null;
    if (c.classList.contains('booked') && state.mode !== 'location') return null;
    return c;
  }

  // When2meet처럼 시작 칸~현재 칸을 꼭짓점으로 하는 사각형 전체에 적용
  function onPointerDown(e) {
    if (e.button !== 0 || state.saving) return;
    const c = cellFrom(e.target);
    if (!c) return;
    e.preventDefault();
    const st = cellState(c.dataset.date, Number(c.dataset.min));
    let mode;
    if (state.mode === 'location') mode = st.reloc ? 'unloc' : 'loc';
    else mode = st.cls === 'open' || st.cls === 'adding' ? 'erase' : 'paint';
    state.drag = {
      mode,
      anchor: { col: Number(c.dataset.col), min: Number(c.dataset.min) },
      snapAdd: new Set(state.pendingAdd),
      snapRemove: new Set(state.pendingRemove),
      snapLoc: new Set(state.pendingLoc),
      last: null,
    };
    applyRect(c);
  }

  function onPointerMove(e) {
    if (!state.drag) return;
    const c = cellFrom(document.elementFromPoint(e.clientX, e.clientY));
    if (c && c !== state.drag.last) applyRect(c);
  }

  function endDrag() { state.drag = null; }

  function applyRect(c) {
    const d = state.drag;
    d.last = c;
    state.pendingAdd = new Set(d.snapAdd);
    state.pendingRemove = new Set(d.snapRemove);
    state.pendingLoc = new Set(d.snapLoc);
    const ds = days();
    const col = Number(c.dataset.col), min = Number(c.dataset.min);
    const [c0, c1] = [Math.min(col, d.anchor.col), Math.max(col, d.anchor.col)];
    const [m0, m1] = [Math.min(min, d.anchor.min), Math.max(min, d.anchor.min)];
    const now = new Date();
    for (let ci = c0; ci <= c1; ci++) {
      const date = ymd(ds[ci]);
      for (let m = m0; m <= m1; m += prefs.unit) {
        if (cellDate(date, m) < now) continue;
        const st = cellState(date, m);
        if (d.mode === 'loc' || d.mode === 'unloc') {
          if (st.cls !== 'open' && st.cls !== 'booked') continue;
          if (d.mode === 'loc') state.pendingLoc.add(st.slot.id);
          else state.pendingLoc.delete(st.slot.id);
          continue;
        }
        if (st.cls === 'booked') continue;
        const isOpenSlot = st.slot && st.slot.status !== '닫힘';
        if (d.mode === 'paint') {
          if (isOpenSlot) state.pendingRemove.delete(st.slot.id);
          else state.pendingAdd.add(st.k);
        } else {
          if (isOpenSlot) { state.pendingRemove.add(st.slot.id); state.pendingLoc.delete(st.slot.id); }
          else state.pendingAdd.delete(st.k);
        }
      }
    }
    document.querySelectorAll('#grid .tg-cell').forEach(paintCell);
    updateSavebar();
  }

  /* ---------- 저장 ---------- */
  async function save() {
    if (!pendingCount()) return;
    const location = locationInput();
    if (state.pendingLoc.size && !location) { setStatus('바꿀 장소를 입력해 주세요.', true); $('#location').focus(); return; }
    if (location) { prefs.location = location; savePrefs(); }
    const u = prefs.unit;
    const add = [...state.pendingAdd].map((k) => {
      const [date, start] = k.split('|');
      return { date, start, end: fromMin(toMin(start) + u) };
    });
    const remove = [...state.pendingRemove];
    const relocate = [...state.pendingLoc].filter((id) => !state.pendingRemove.has(id));
    state.saving = true;
    updateSavebar();
    $('#save').textContent = '저장 중…';
    try {
      const res = await call({ action: 'adminApply', add, remove, relocate, location });
      if (!res.ok) throw new Error(res.error);
      clearPending();
      const parts = [res.added && `${res.added}칸 열림`, res.reopened && `${res.reopened}칸 다시 열림`, res.removed && `${res.removed}칸 닫힘`, res.relocated && `${res.relocated}칸 장소 변경`, res.skipped && `${res.skipped}칸 건너뜀(예약됨 등)`].filter(Boolean);
      await load();
      setStatus('저장했습니다. ' + parts.join(' · '));
    } catch (err) {
      console.error(err);
      setStatus('저장하지 못했습니다: ' + (err.message || '네트워크 오류'), true);
    } finally {
      state.saving = false;
      $('#save').textContent = '저장';
      updateSavebar();
    }
  }

  /* ---------- 데모 ---------- */
  const demoDb = [];
  (function seedDemo() {
    const mon = mondayOf(new Date());
    [1, 3].forEach((i) => ['14:00', '14:30', '15:00'].forEach((t, j) => {
      const date = ymd(addDays(mon, i + 7));
      demoDb.push({ id: `S${date.replace(/-/g, '')}${t.replace(':', '')}`, date, start: t, end: fromMin(toMin(t) + 30), location: DEFAULT_LOCATION, status: j === 1 && i === 1 ? '예약됨' : '열림', name: j === 1 && i === 1 ? '홍길동' : '' });
    }));
  })();

  function demoCall(b) {
    return new Promise((resolve) => setTimeout(() => {
      if (b.action === 'adminList') resolve({ ok: true, slots: demoDb.filter((s) => s.date >= b.from && s.date <= b.to).map((s) => ({ ...s })) });
      else {
        let added = 0, removed = 0, relocated = 0;
        (b.relocate || []).forEach((id) => { const s = demoDb.find((x) => x.id === id); if (s) { s.location = b.location; relocated++; } });
        b.add.forEach((a) => { demoDb.push({ id: `S${a.date.replace(/-/g, '')}${a.start.replace(':', '')}`, ...a, location: b.location, status: '열림', name: '' }); added++; });
        b.remove.forEach((id) => { const i = demoDb.findIndex((s) => s.id === id && s.status !== '예약됨'); if (i >= 0) { demoDb.splice(i, 1); removed++; } });
        resolve({ ok: true, added, removed, relocated, reopened: 0, skipped: 0 });
      }
    }, 300));
  }

  init();
})();
