(() => {
  'use strict';

  const cfg = window.CA_CONFIG || {};
  const API = (cfg.APPS_SCRIPT_URL || '').trim();
  const DEMO = !API;

  // 상담일지의 "호소문제유형"과 동일한 분류
  const TOPICS = [
    { group: '대학원진학', note: '입시·연구실 정보', items: ['대학원입시', '연구실선택'] },
    { group: '학업', items: ['수강신청/변경', '성적 고민', '튜터링 신청', '개별연구/URP', '연구실 인턴십', '대학원생 연구/논문 작성', '지도교수와의 마찰', '졸업 문제', '전과/연구실 변경', '복수전공', '휴학', '기초/전공과목 지도', '전공선택'] },
    { group: '진로', note: '진학·유학·취업 등 방향', items: ['대학원 진학', '유학', '취업/기업 인턴십', '병역문제 해결', '창업', '기타'] },
    { group: '학교생활', items: ['대인관계 (이성교제 포함)', '가족관계', '랩원 간의 마찰', '동아리/단체 활동'] },
    { group: '병역', items: ['병역'] },
    { group: '취업', items: ['취업정보', '취업준비(면접,자소서작성 등)'] },
    { group: '기타', items: ['취미활동', '건강문제', '종교', '기타'] },
  ];

  // 상담일지 "카페이용내역"과 동일한 목록
  const CAFES = ['던킨도너츠', '스무디킹', '오가다', '그라찌에', '카페잇', '카페드림', '파스쿠찌', '쥬스킹', '탐앤탐스', '캘리포니아 베이커리', '드롭탑', '엔제리너스'];

  const $ = (sel) => document.querySelector(sel);
  const el = {
    slotStatus: $('#slot-status'),
    slotList: $('#slot-list'),
    stepSlots: $('#step-slots'),
    stepForm: $('#step-form'),
    stepDone: $('#step-done'),
    pickedText: $('#picked-text'),
    pickedLoc: $('#picked-loc'),
    form: $('#booking-form'),
    topics: $('#topics'),
    topicsError: $('#topics-error'),
    formError: $('#form-error'),
    submit: $('#submit-btn'),
    details: $('#booking-form [name="details"]'),
    detailsCount: $('#details-count'),
    summary: $('#done-summary'),
  };

  const state = { slots: [], slot: null };

  /* ---------- 초기화 ---------- */
  function init() {
    if (cfg.TITLE) { $('#title').textContent = cfg.TITLE; document.title = cfg.TITLE; }
    $('#subtitle').textContent = cfg.SUBTITLE || '';
    $('#counselor').textContent = cfg.COUNSELOR || '';
    $('#privacy-purpose').textContent = cfg.PRIVACY?.PURPOSE || '상담 일정 확인 및 상담 사전 준비';
    $('#privacy-retention').textContent = cfg.PRIVACY?.RETENTION || '상담 종료 후 파기';
    if (cfg.CONTACT_EMAIL) {
      const a = document.createElement('a');
      a.href = 'mailto:' + cfg.CONTACT_EMAIL;
      a.textContent = cfg.CONTACT_EMAIL;
      $('#contact').append('문의: ', a);
    }
    $('#demo-banner').hidden = !DEMO;

    renderTopics();
    CAFES.forEach((c) => $('#cafe-select').add(new Option(`교내 ${c}`, c)));

    $('#reload-slots').addEventListener('click', loadSlots);
    $('#change-slot').addEventListener('click', () => goTo(1));
    $('#restart').addEventListener('click', () => { el.form.reset(); el.detailsCount.textContent = '0'; el.form.classList.remove('was-validated'); state.slot = null; goTo(1); loadSlots(); });
    el.details.addEventListener('input', () => { el.detailsCount.textContent = el.details.value.length; });
    el.topics.addEventListener('change', () => { if (el.form.classList.contains('was-validated')) checkGroups(); });
    el.form.addEventListener('change', (e) => {
      if (e.target.type === 'radio' && el.form.classList.contains('was-validated')) checkGroups();
    });
    el.form.addEventListener('submit', onSubmit);

    loadSlots();
  }

  function renderTopics() {
    const frag = document.createDocumentFragment();
    TOPICS.forEach(({ group, note, items }) => {
      const row = document.createElement('div');
      row.className = 'topic-group';
      const h = document.createElement('h4');
      h.textContent = group;
      if (note) { const s = document.createElement('small'); s.textContent = note; h.append(s); }
      const chips = document.createElement('div');
      chips.className = 'chips';
      items.forEach((item) => {
        const label = document.createElement('label');
        label.className = 'chip';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.name = 'topics';
        input.value = `${group}|${item}`;
        const span = document.createElement('span');
        span.textContent = item;
        label.append(input, span);
        chips.append(label);
      });
      row.append(h, chips);
      frag.append(row);
    });
    el.topics.append(frag);
  }

  /* ---------- 단계 전환 ---------- */
  function goTo(step) {
    el.stepSlots.hidden = step !== 1;
    el.stepForm.hidden = step !== 2;
    el.stepDone.hidden = step !== 3;
    document.querySelectorAll('.steps li').forEach((li) => {
      const n = Number(li.dataset.step);
      li.classList.toggle('is-current', n === step);
      li.classList.toggle('is-done', n < step);
    });
    const target = step === 1 ? el.stepSlots : step === 2 ? el.stepForm : el.stepDone;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- 날짜 표시 ---------- */
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
  function parseYmd(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function fmtDay(ymd) {
    const d = parseYmd(ymd);
    return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`;
  }
  function fmtSlot(s) { return `${fmtDay(s.date)} ${s.start}–${s.end}`; }

  /* ---------- 슬롯 ---------- */
  // 지난번에 받은 목록을 먼저 보여주고(서버가 깨어나는 데 몇 초 걸림), 최신 목록이 오면 바꾼다
  const SLOT_CACHE = 'ca_slots_cache';
  function readSlotCache() {
    try {
      const c = JSON.parse(localStorage.getItem(SLOT_CACHE));
      if (!c || Date.now() - c.at > 24 * 3600 * 1000) return null;
      // 서버가 준 마감 시각(전날 밤 12시)이 지난 시간은 빼고 보여준다
      return c.slots.filter((s) => s.deadline && s.deadline > Date.now());
    } catch (e) { return null; }
  }
  function writeSlotCache(slots) {
    try { localStorage.setItem(SLOT_CACHE, JSON.stringify({ at: Date.now(), slots })); } catch (e) { /* ignore */ }
  }

  async function loadSlots() {
    const cached = DEMO ? null : readSlotCache();
    if (cached && cached.length) {
      state.slots = cached;
      renderSlots();
      setStatus('최신 예약 현황을 확인하는 중…');
    } else {
      setStatus('예약 가능한 시간을 불러오는 중… 처음에는 몇 초 걸릴 수 있어요.');
      el.slotList.replaceChildren(skeleton());
    }
    try {
      state.slots = DEMO ? demoSlots() : await apiGetSlots();
      if (!DEMO) writeSlotCache(state.slots);
      renderSlots();
    } catch (err) {
      console.error(err);
      setStatus('시간을 불러오지 못했습니다. 잠시 후 새로고침해 주세요.', true);
      if (!cached) el.slotList.replaceChildren();
    }
  }

  function skeleton() {
    const wrap = document.createElement('div');
    wrap.className = 'skeleton';
    wrap.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 2; i++) {
      const day = document.createElement('div');
      day.className = 'slot-day';
      day.innerHTML = '<div class="sk-line"></div><div class="slot-grid">' + '<div class="sk-slot"></div>'.repeat(4) + '</div>';
      wrap.append(day);
    }
    return wrap;
  }

  function setStatus(msg, isError = false) {
    el.slotStatus.textContent = msg;
    el.slotStatus.classList.toggle('is-error', isError);
  }

  function renderSlots() {
    if (!state.slots.length) {
      setStatus('지금은 예약 가능한 시간이 없습니다. 새 시간이 열리면 다시 확인해 주세요.');
      return;
    }
    setStatus('');
    const byDate = new Map();
    state.slots.forEach((s) => {
      if (!byDate.has(s.date)) byDate.set(s.date, []);
      byDate.get(s.date).push(s);
    });
    const frag = document.createDocumentFragment();
    byDate.forEach((slots, date) => {
      const day = document.createElement('div');
      day.className = 'slot-day';
      const h = document.createElement('h3');
      h.textContent = fmtDay(date);
      const grid = document.createElement('div');
      grid.className = 'slot-grid';
      slots.forEach((s) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'slot';
        b.setAttribute('aria-pressed', String(state.slot?.id === s.id));
        b.textContent = `${s.start}–${s.end}`;
        if (s.location) { const sm = document.createElement('small'); sm.textContent = s.location; b.append(sm); }
        b.addEventListener('click', () => pickSlot(s));
        grid.append(b);
      });
      day.append(h, grid);
      frag.append(day);
    });
    el.slotList.replaceChildren(frag);
  }

  function pickSlot(s) {
    state.slot = s;
    el.pickedText.textContent = fmtSlot(s);
    el.pickedLoc.textContent = s.location || '';
    $('#cafe-default').textContent = s.location ? `지정 장소 그대로 (${s.location})` : '지정 장소 그대로';
    el.formError.hidden = true;
    renderSlots();
    goTo(2);
  }

  /* ---------- 제출 ---------- */
  function checkGroups() {
    let ok = true;
    document.querySelectorAll('[data-required]').forEach((g) => {
      const filled = !!el.form.querySelector(`[name="${g.dataset.required}"]:checked`);
      g.classList.toggle('is-invalid', !filled);
      if (!filled) ok = false;
    });
    const topicsOk = !!el.form.querySelector('[name="topics"]:checked');
    el.topicsError.hidden = topicsOk;
    return ok && topicsOk;
  }

  function collect() {
    const fd = new FormData(el.form);
    const get = (k) => (fd.get(k) || '').toString().trim();
    return {
      slotId: state.slot.id,
      studentId: get('studentId'),
      name: get('name'),
      gender: get('gender'),
      nationality: get('nationality'),
      major: get('major'),
      course: get('course'),
      phone: get('phone'),
      email: get('email'),
      cafe: get('cafe'),
      route: get('route') || '일반상담',
      topics: fd.getAll('topics').map(String),
      mainConcerns: get('mainConcerns'),
      details: get('details'),
      consent: fd.get('consent') === 'on',
      website: get('website'),
    };
  }

  async function onSubmit(e) {
    e.preventDefault();
    el.form.classList.add('was-validated');
    el.formError.hidden = true;
    const groupsOk = checkGroups();
    if (!el.form.checkValidity() || !groupsOk) {
      const firstBad = el.form.querySelector(':invalid, .chips.is-invalid, #topics-error:not([hidden])');
      firstBad?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (firstBad?.focus && firstBad.matches('input, select, textarea')) firstBad.focus({ preventScroll: true });
      showError('표시된 필수 항목을 확인해 주세요.');
      return;
    }
    if (!state.slot) { goTo(1); return; }

    const payload = collect();
    el.submit.disabled = true;
    el.submit.textContent = '신청하는 중…';
    try {
      const res = DEMO ? await demoSubmit(payload) : await apiPost(payload);
      if (!res.ok) {
        if (res.code === 'SLOT_TAKEN') {
          showError(res.error);
          state.slot = null;
          try { localStorage.removeItem(SLOT_CACHE); } catch (e) { /* ignore */ }
          await loadSlots();
          setTimeout(() => goTo(1), 1200);
        } else {
          showError(res.error || '예약에 실패했습니다. 다시 시도해 주세요.');
        }
        return;
      }
      showDone(res, payload);
    } catch (err) {
      console.error(err);
      showError('네트워크 오류로 예약하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      el.submit.disabled = false;
      el.submit.textContent = '예약 신청하기';
    }
  }

  function showError(msg) {
    el.formError.textContent = msg;
    el.formError.hidden = false;
  }

  function showDone(res, p) {
    writeSlotCache(state.slots.filter((x) => x.id !== (res.slot || state.slot).id));
    const s = res.slot || state.slot;
    const rows = [
      ['예약번호', res.bookingId],
      ['일시', fmtSlot(s)],
      ['장소', res.location || s.location || '추후 안내'],
      ['이름', p.name],
    ];
    el.summary.replaceChildren(...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      return [dt, dd];
    }));
    goTo(3);
  }

  /* ---------- API ---------- */
  async function apiGetSlots() {
    const res = await fetch(`${API}?action=slots&t=${Date.now()}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'failed');
    return data.slots;
  }

  async function apiPost(payload) {
    // Content-Type을 지정하지 않아야(text/plain) Apps Script에서 CORS 사전 요청이 생기지 않습니다.
    const res = await fetch(API, { method: 'POST', body: JSON.stringify(payload) });
    return res.json();
  }

  /* ---------- 데모 ---------- */
  function demoSlots() {
    const out = [];
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    while (out.length < 12) {
      d.setDate(d.getDate() + 1);
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      ['14:00', '15:00', '16:00'].forEach((start) => {
        const end = `${start.slice(0, 2)}:50`;
        out.push({ id: `S${ymd.replace(/-/g, '')}${start.replace(':', '')}`, date: ymd, start, end, location: '상담실 (예시)' });
      });
    }
    return out;
  }

  function demoSubmit(p) {
    const location = p.cafe ? `교내 ${p.cafe}` : state.slot.location;
    return new Promise((r) => setTimeout(() => r({ ok: true, bookingId: 'DEMO-' + Math.random().toString(36).slice(2, 7).toUpperCase(), slot: state.slot, location }), 600));
  }

  init();
})();
