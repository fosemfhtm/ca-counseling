/**
 * CA 학업·진로 상담 예약 — Google Apps Script 백엔드
 *
 * Google 스프레드시트에 연결된 Apps Script 프로젝트에 이 파일 전체를 붙여넣으세요.
 * 설치 방법은 README.md를 참고하세요.
 */

const CONFIG = {
  COUNSELOR_NAME: '',            // 상담일지 "상담자" 칸에 자동으로 들어갈 이름
  METHOD: '대면상담',             // 상담방법 (모든 예약에 동일하게 기록)
  ADMIN_EMAIL: '',               // 새 예약 알림 받을 주소 (비우면 스크립트 소유자)
  MIN_HOURS_BEFORE: 3,           // 상담 시작 N시간 전까지만 예약 가능
  ONE_ACTIVE_PER_STUDENT: true,  // 한 학번당 예정된 예약은 1건만 허용
  SEND_STUDENT_EMAIL: true,      // 학생에게 예약 확인 메일 발송
  SITE_TITLE: 'CA 학업·진로 상담',
};

const SLOT_SHEET = '슬롯';
const BOOKING_SHEET = '예약';

const SLOT_HEADERS = ['슬롯ID', '날짜', '시작', '종료', '장소', '상태', '예약ID'];
const SLOT_TEXT_COLS = ['슬롯ID', '날짜', '시작', '종료'];

// 상담일지 양식 순서
const BOOKING_HEADERS = [
  '예약ID', '접수시각', '예약상태', '슬롯ID', '상담일', '상담시간', '상담장소',
  '학번', '이름', '성별', '학과', '과정', '국적', '연락처', '이메일',
  '상담자', '상담방법', '상담구분',
  '호소문제유형', '주요 호소내용', '학생 작성 상세내용',
  '카페이용내역', '이용금액', '상담및조치', '관찰사항', '특이사항', '상담결과',
];
const BOOKING_TEXT_COLS = ['상담일', '상담시간', '학번', '연락처'];
const PREFILLED_FROM = '학번', PREFILLED_TO = '학생 작성 상세내용';
const POST_FROM = '카페이용내역', POST_TO = '상담결과';

const SLOT = { OPEN: '열림', BOOKED: '예약됨', CLOSED: '닫힘' };
const BOOKING = { ACTIVE: '확정', DONE: '완료', CANCELLED: '취소' };

const OPTIONS = {
  gender: ['남자', '여자'],
  course: ['1학년', '2학년', '3학년', '4학년', '석사과정', '박사과정', '석박사통합과정', '기타'],
  nationality: ['내국인', '외국인(International)'],
  method: ['대면상담', '전화상담', '이메일상담', 'SNS상담'],
  route: ['일반상담', '의뢰상담'],
  result: ['상담완료', '지속상담'],
  cafe: ['스무디킹', '오가다', '그라찌에', '카페잇', '카페드림', '파스쿠찌', '쥬스킹', '탐앤탐스', '캘리포니아 베이커리', '드롭탑', '엔제리너스', '던킨도너츠'],
};

/* =========================================================
 * 웹 앱 엔드포인트
 * ======================================================= */

function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || 'slots';
    if (action === 'slots') return json_({ ok: true, slots: listOpenSlots_() });
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: '서버 오류가 발생했습니다.' });
  }
}

function doPost(e) {
  try {
    let d;
    try { d = JSON.parse(e.postData.contents); } catch (err) {
      return json_({ ok: false, error: '요청 형식이 올바르지 않습니다.' });
    }
    if (d.action === 'adminList' || d.action === 'adminApply') return json_(admin_(d));
    if (str_(d.website)) return json_({ ok: true, bookingId: '-' }); // 스팸 봇

    const invalid = validate_(d);
    if (invalid) return json_({ ok: false, error: invalid });

    const lock = LockService.getScriptLock();
    if (!lock.tryLock(15000)) {
      return json_({ ok: false, error: '신청이 몰리고 있습니다. 잠시 후 다시 시도해 주세요.' });
    }
    let booking, slot;
    try {
      const slotSh = sheet_(SLOT_SHEET);
      const bookSh = sheet_(BOOKING_SHEET);
      slot = readRows_(slotSh).map(slotFromRow_).find((s) => s && s.id === d.slotId);
      if (!slot || !isBookable_(slot)) {
        return json_({ ok: false, code: 'SLOT_TAKEN', error: '방금 다른 분이 예약했거나 마감된 시간입니다. 다른 시간을 선택해 주세요.' });
      }
      if (CONFIG.ONE_ACTIVE_PER_STUDENT && hasUpcomingBooking_(bookSh, str_(d.studentId))) {
        return json_({ ok: false, code: 'DUPLICATE', error: '이미 예정된 상담 예약이 있습니다. 변경이 필요하면 받으신 확인 메일에 회신해 주세요.' });
      }
      booking = buildBooking_(d, slot);
      appendObjects_(bookSh, [booking], BOOKING_TEXT_COLS);
      setCells_(slotSh, slot.row, { '슬롯ID': slot.id, '상태': SLOT.BOOKED, '예약ID': booking['예약ID'] });
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }

    notify_(booking, slot, d);
    return json_({ ok: true, bookingId: booking['예약ID'], slot: publicSlot_(slot), location: booking['상담장소'] });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }
}

/* =========================================================
 * 예약 로직
 * ======================================================= */

function listOpenSlots_() {
  return readRows_(sheet_(SLOT_SHEET))
    .map(slotFromRow_)
    .filter((s) => s && isBookable_(s))
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))
    .map(publicSlot_);
}

function slotFromRow_(r) {
  const date = ymd_(r['날짜']);
  const start = hm_(r['시작']);
  if (!date || !start) return null;
  return {
    id: str_(r['슬롯ID']) || slotId_(date, start),
    date,
    start,
    end: hm_(r['종료']),
    location: str_(r['장소']),
    status: str_(r['상태']) || SLOT.OPEN, // 상태를 비워두면 열림으로 간주
    bookingId: str_(r['예약ID']),
    row: r._row,
  };
}

function publicSlot_(s) {
  return { id: s.id, date: s.date, start: s.start, end: s.end, location: s.location };
}

function isBookable_(s) {
  if (s.status !== SLOT.OPEN || s.bookingId) return false;
  const startsAt = toDate_(s.date, s.start).getTime();
  return startsAt - Date.now() >= CONFIG.MIN_HOURS_BEFORE * 3600 * 1000;
}

function hasUpcomingBooking_(bookSh, studentId) {
  const now = Date.now();
  return readRows_(bookSh).some((r) =>
    str_(r['학번']) === studentId &&
    str_(r['예약상태']) === BOOKING.ACTIVE &&
    ymd_(r['상담일']) && hm_(r['상담시간']) &&
    toDate_(ymd_(r['상담일']), hm_(r['상담시간'])).getTime() > now
  );
}

function validate_(d) {
  if (!str_(d.slotId)) return '상담 시간을 선택해 주세요.';
  const required = {
    studentId: '학번', name: '이름', gender: '성별', major: '학과', course: '과정',
    nationality: '국적', phone: '연락처', email: '이메일', mainConcerns: '주요 고민',
  };
  for (const k in required) {
    if (!str_(d[k])) return `${required[k]}을(를) 입력해 주세요.`;
  }
  if (d.consent !== true) return '개인정보 수집·이용에 동의해 주세요.';
  if (!/^[0-9A-Za-z]{4,12}$/.test(str_(d.studentId))) return '학번 형식을 확인해 주세요.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str_(d.email)) || str_(d.email).length > 80) return '이메일 형식을 확인해 주세요.';
  if (!/^[0-9+\-()\s]{7,20}$/.test(str_(d.phone))) return '연락처 형식을 확인해 주세요.';
  if (!OPTIONS.gender.includes(d.gender)) return '성별을 선택해 주세요.';
  if (!OPTIONS.course.includes(d.course)) return '과정을 선택해 주세요.';
  if (!OPTIONS.nationality.includes(d.nationality)) return '국적을 선택해 주세요.';
  if (str_(d.cafe) && !OPTIONS.cafe.includes(d.cafe)) return '장소를 다시 선택해 주세요.';
  if (!Array.isArray(d.topics) || !d.topics.length || d.topics.length > 40) return '고민 분야를 하나 이상 선택해 주세요.';
  if (d.topics.some((t) => typeof t !== 'string' || t.length > 60)) return '고민 분야 값이 올바르지 않습니다.';
  if (str_(d.name).length > 30 || str_(d.major).length > 40) return '입력값이 너무 깁니다.';
  if (str_(d.mainConcerns).length > 600 || str_(d.details).length > 2000) return '내용이 너무 깁니다.';
  return '';
}

function buildBooking_(d, slot) {
  // 학생이 다른 교내 카페를 고르면 그곳이 상담장소, 아니면 슬롯 장소
  const cafe = str_(d.cafe);
  const place = cafe ? `교내 ${cafe}` : slot.location;
  return {
    '예약ID': 'CA-' + slot.date.slice(2).replace(/-/g, '') + '-' + Utilities.getUuid().slice(0, 4).toUpperCase(),
    '접수시각': new Date(),
    '예약상태': BOOKING.ACTIVE,
    '슬롯ID': slot.id,
    '상담일': slot.date,
    '상담시간': `${slot.start}-${slot.end}`,
    '상담장소': place,
    '학번': safe_(d.studentId),
    '이름': safe_(d.name),
    '성별': d.gender,
    '학과': safe_(d.major),
    '과정': d.course,
    '국적': d.nationality,
    '연락처': safe_(d.phone),
    '이메일': safe_(d.email),
    '상담자': CONFIG.COUNSELOR_NAME,
    '상담방법': CONFIG.METHOD,
    '상담구분': d.route === '의뢰상담' ? '의뢰상담' : '일반상담',
    '호소문제유형': formatTopics_(d.topics),
    '주요 호소내용': safe_(d.mainConcerns),
    '학생 작성 상세내용': safe_(d.details),
    '카페이용내역': cafe || OPTIONS.cafe.find((c) => place.includes(c)) || '',
  };
}

// ["학업|수강신청/변경", "학업|휴학", "진로|유학"] → "학업: 수강신청/변경, 휴학\n진로: 유학"
function formatTopics_(topics) {
  const groups = {};
  const order = [];
  topics.forEach((t) => {
    const [g, item] = String(t).split('|');
    if (!item) return;
    if (!groups[g]) { groups[g] = []; order.push(g); }
    groups[g].push(item);
  });
  return safe_(order.map((g) => `${g}: ${groups[g].join(', ')}`).join('\n'));
}

function notify_(b, slot, d) {
  const when = `${fmtKDate_(slot.date)} ${slot.start}–${slot.end}`;
  const admin = CONFIG.ADMIN_EMAIL || Session.getEffectiveUser().getEmail();
  try {
    MailApp.sendEmail({
      to: admin,
      subject: `[CA 상담] 새 예약 — ${d.name} (${d.studentId}) ${slot.date.slice(5).replace('-', '/')} ${slot.start}`,
      body: [
        `예약번호: ${b['예약ID']}`,
        `일시: ${when}`,
        `장소: ${b['상담장소'] || '-'}${str_(d.cafe) ? ' (학생 희망)' : ''}`,
        `상담구분: ${b['상담구분']}`,
        '',
        `${d.name} · ${d.studentId} · ${d.major} ${d.course} · ${d.gender} · ${d.nationality}`,
        `연락처: ${d.phone} / ${d.email}`,
        '',
        '[호소문제유형]',
        b['호소문제유형'],
        '',
        '[주요 고민]',
        d.mainConcerns,
        '',
        '[상세 내용]',
        d.details || '-',
        '',
        `시트: ${SpreadsheetApp.getActive().getUrl()}`,
      ].join('\n'),
    });
  } catch (err) { console.error('관리자 메일 실패', err); }

  if (!CONFIG.SEND_STUDENT_EMAIL) return;
  try {
    MailApp.sendEmail({
      to: d.email,
      replyTo: admin,
      name: CONFIG.SITE_TITLE,
      subject: `[${CONFIG.SITE_TITLE}] 상담 예약이 확정되었습니다 (${when})`,
      body: [
        `${d.name}님, 상담 예약이 확정되었습니다.`,
        '',
        `■ 예약번호: ${b['예약ID']}`,
        `■ 일시: ${when}`,
        `■ 장소: ${b['상담장소'] || '추후 안내'}`,
        '',
        '미리 적어주신 내용을 바탕으로 상담을 준비해 두겠습니다.',
        '일정 변경이나 취소가 필요하면 이 메일에 회신해 주세요.',
      ].join('\n'),
    });
  } catch (err) { console.error('학생 메일 실패', err); }
}

/* =========================================================
 * 관리자 페이지 (admin.html) API
 * ======================================================= */

function admin_(d) {
  const key = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  if (!key) return { ok: false, error: '관리자 키가 아직 없습니다. 시트 메뉴 [CA 상담 → 관리자 키 만들기]를 먼저 실행하세요.' };
  if (str_(d.key) !== key) {
    Utilities.sleep(1500); // 무차별 대입 지연
    return { ok: false, code: 'BAD_KEY', error: '관리자 키가 올바르지 않습니다.' };
  }
  return d.action === 'adminList' ? adminList_(d) : adminApply_(d);
}

// 기간 내 모든 슬롯 (지난 것·예약된 것 포함)
function adminList_(d) {
  const from = ymd_(d.from), to = ymd_(d.to);
  if (!from || !to) return { ok: false, error: '기간이 올바르지 않습니다.' };
  const names = {};
  readRows_(sheet_(BOOKING_SHEET)).forEach((r) => {
    if (str_(r['예약상태']) !== BOOKING.CANCELLED) names[str_(r['예약ID'])] = str_(r['이름']);
  });
  const slots = readRows_(sheet_(SLOT_SHEET))
    .map(slotFromRow_)
    .filter((s) => s && s.date >= from && s.date <= to)
    .map((s) => ({
      id: s.id, date: s.date, start: s.start, end: s.end, location: s.location,
      status: s.bookingId ? SLOT.BOOKED : s.status,
      name: s.bookingId ? (names[s.bookingId] || '') : '',
    }));
  return { ok: true, slots };
}

// add: [{date, start, end}] 새로 열기 / remove: [슬롯ID] 예약 안 된 슬롯 삭제
// relocate: [슬롯ID] 장소를 location으로 변경 (예약된 슬롯은 예약 시트의 상담장소도 함께 변경)
function adminApply_(d) {
  const add = Array.isArray(d.add) ? d.add : [];
  const remove = Array.isArray(d.remove) ? d.remove.map(str_) : [];
  const relocate = Array.isArray(d.relocate) ? d.relocate.map(str_) : [];
  if (add.length + remove.length + relocate.length > 1000) return { ok: false, error: '한 번에 너무 많이 바꿨습니다. 나눠서 저장해 주세요.' };
  const location = safe_(d.location).slice(0, 60);
  if (relocate.length && !location) return { ok: false, error: '바꿀 장소를 입력해 주세요.' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, error: '잠시 후 다시 시도해 주세요.' };
  try {
    const sh = sheet_(SLOT_SHEET);
    const slots = readRows_(sh).map(slotFromRow_).filter(Boolean);
    const byId = {};
    slots.forEach((s) => { byId[s.id] = s; });

    let added = 0, reopened = 0, removed = 0, skipped = 0, relocated = 0;

    // 장소 변경은 행 삭제 전에 처리 (행 번호가 바뀌기 때문)
    if (relocate.length) {
      const bookSh = sheet_(BOOKING_SHEET);
      const bookingRows = {};
      readRows_(bookSh).forEach((r) => { bookingRows[str_(r['예약ID'])] = r._row; });
      relocate.forEach((id) => {
        const s = byId[id];
        if (!s || !s.row) { skipped++; return; }
        setCells_(sh, s.row, { '장소': location });
        if (s.bookingId && bookingRows[s.bookingId]) setCells_(bookSh, bookingRows[s.bookingId], { '상담장소': location });
        relocated++;
      });
    }

    const newRows = [];
    add.forEach((a) => {
      const date = ymd_(a.date), start = hm_(a.start), end = hm_(a.end);
      if (!date || !start || !end) { skipped++; return; }
      const id = slotId_(date, start);
      const ex = byId[id];
      if (ex) {
        if (ex.status === SLOT.CLOSED && !ex.bookingId) { setCells_(sh, ex.row, { '상태': SLOT.OPEN }); reopened++; } else skipped++;
        return;
      }
      byId[id] = { id };
      newRows.push({ '슬롯ID': id, '날짜': date, '시작': start, '종료': end, '장소': location, '상태': SLOT.OPEN });
    });

    const delRows = [];
    remove.forEach((id) => {
      const s = byId[id];
      if (!s || !s.row) { skipped++; return; }
      if (s.bookingId || s.status === SLOT.BOOKED) { skipped++; return; } // 예약된 시간은 지우지 않음
      delRows.push(s.row);
    });
    delRows.sort((a, b) => b - a).forEach((r) => { sh.deleteRow(r); removed++; });

    appendObjects_(sh, newRows, SLOT_TEXT_COLS);
    added = newRows.length;
    SpreadsheetApp.flush();
    return { ok: true, added, reopened, removed, relocated, skipped };
  } finally {
    lock.releaseLock();
  }
}

function createAdminKey() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('ADMIN_KEY')) {
    const a = ui.alert('관리자 키', '이미 키가 있습니다. 새 키로 바꿀까요? (아니오를 누르면 기존 키를 보여줍니다)', ui.ButtonSet.YES_NO_CANCEL);
    if (a === ui.Button.CANCEL || a === ui.Button.CLOSE) return;
    if (a === ui.Button.NO) { ui.alert('현재 관리자 키', props.getProperty('ADMIN_KEY'), ui.ButtonSet.OK); return; }
  }
  const key = Utilities.getUuid().replace(/-/g, '').slice(0, 24);
  props.setProperty('ADMIN_KEY', key);
  ui.alert('새 관리자 키', `${key}\n\n관리자 페이지(admin.html)에서 이 키를 한 번 입력하면 그 브라우저에 저장됩니다.\n다른 사람에게 공유하지 마세요.`, ui.ButtonSet.OK);
}

/* =========================================================
 * 스프레드시트 메뉴
 * ======================================================= */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('CA 상담')
    .addItem('슬롯 일괄 생성…', 'showSlotGenerator')
    .addItem('선택한 예약 → 상담일지 초안', 'showReportDraft')
    .addItem('선택한 예약 취소 (시간 다시 열기)', 'cancelSelectedBooking')
    .addSeparator()
    .addItem('관리자 키 만들기 / 보기', 'createAdminKey')
    .addItem('처음 설정 (시트 만들기)', 'setup')
    .addToUi();
}

function setup() {
  const ss = SpreadsheetApp.getActive();
  const slotSh = ensureSheet_(ss, SLOT_SHEET, SLOT_HEADERS, SLOT_TEXT_COLS);
  const bookSh = ensureSheet_(ss, BOOKING_SHEET, BOOKING_HEADERS, BOOKING_TEXT_COLS);

  dropdown_(slotSh, '상태', Object.values(SLOT));
  dropdown_(bookSh, '예약상태', Object.values(BOOKING));
  dropdown_(bookSh, '성별', OPTIONS.gender);
  dropdown_(bookSh, '과정', OPTIONS.course);
  dropdown_(bookSh, '국적', OPTIONS.nationality);
  dropdown_(bookSh, '상담방법', OPTIONS.method);
  dropdown_(bookSh, '상담구분', OPTIONS.route);
  dropdown_(bookSh, '카페이용내역', OPTIONS.cafe);
  dropdown_(bookSh, '상담결과', OPTIONS.result);

  // 머리글 색: 파랑 = 학생이 미리 입력, 노랑 = 상담 후 작성
  const map = headerMap_(bookSh);
  bookSh.getRange(1, map[PREFILLED_FROM] + 1, 1, map[PREFILLED_TO] - map[PREFILLED_FROM] + 1).setBackground('#dbe7ff');
  bookSh.getRange(1, map[POST_FROM] + 1, 1, map[POST_TO] - map[POST_FROM] + 1).setBackground('#fff1c7');
  ['호소문제유형', '주요 호소내용', '학생 작성 상세내용', '상담및조치', '관찰사항', '특이사항'].forEach((h) => {
    bookSh.setColumnWidth(map[h] + 1, 280);
    bookSh.getRange(2, map[h] + 1, bookSh.getMaxRows() - 1, 1).setWrap(true).setVerticalAlignment('top');
  });

  const blank = ss.getSheets().find((s) => /^(Sheet1|시트1)$/.test(s.getName()) && s.getLastRow() === 0);
  if (blank && ss.getSheets().length > 1) ss.deleteSheet(blank);

  try {
    SpreadsheetApp.getUi().alert('설정 완료! 메뉴 [CA 상담 → 슬롯 일괄 생성]으로 상담 시간을 만들어 보세요.');
  } catch (err) { /* 편집기에서 실행한 경우 */ }
}

function showSlotGenerator() {
  const today = Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd');
  const html = HtmlService.createHtmlOutput(`
<style>
  body { font-family: Arial, sans-serif; font-size: 13px; margin: 0; }
  label { display: block; margin: 10px 0 3px; font-weight: bold; }
  input { width: 100%; padding: 6px; box-sizing: border-box; }
  .row { display: flex; gap: 10px; } .row > div { flex: 1; }
  .days label { display: inline-block; font-weight: normal; margin: 0 10px 0 0; }
  .days input { width: auto; }
  button { margin-top: 16px; padding: 8px 18px; background: #2f5bea; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
  #msg { margin-top: 10px; }
</style>
<form id="f">
  <div class="row">
    <div><label>시작일</label><input type="date" name="from" value="${today}" required></div>
    <div><label>종료일</label><input type="date" name="to" value="${today}" required></div>
  </div>
  <label>요일</label>
  <div class="days">
    ${['일', '월', '화', '수', '목', '금', '토'].map((n, i) =>
      `<label><input type="checkbox" name="days" value="${i}" ${i >= 1 && i <= 5 ? 'checked' : ''}> ${n}</label>`).join('')}
  </div>
  <div class="row">
    <div><label>첫 상담 시작</label><input type="time" name="startTime" value="14:00" required></div>
    <div><label>마지막 상담 종료</label><input type="time" name="endTime" value="17:00" required></div>
  </div>
  <div class="row">
    <div><label>상담 길이(분)</label><input type="number" name="duration" value="50" min="10" required></div>
    <div><label>쉬는 시간(분)</label><input type="number" name="gap" value="10" min="0"></div>
  </div>
  <label>장소</label><input name="location" placeholder="예: 학생회관 2층 상담실">
  <button>슬롯 만들기</button>
  <div id="msg"></div>
</form>
<script>
  document.getElementById('f').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target, msg = document.getElementById('msg');
    var days = Array.prototype.map.call(f.querySelectorAll('[name=days]:checked'), function (x) { return +x.value; });
    msg.textContent = '만드는 중…';
    google.script.run
      .withSuccessHandler(function (n) { msg.textContent = n + '개 슬롯을 만들었습니다. (이미 있는 시간은 건너뜀)'; })
      .withFailureHandler(function (err) { msg.textContent = '오류: ' + err.message; })
      .generateSlots({ from: f.from.value, to: f.to.value, days: days, startTime: f.startTime.value,
        endTime: f.endTime.value, duration: +f.duration.value, gap: +f.gap.value || 0, location: f.location.value });
  });
</script>`).setWidth(420).setHeight(430);
  SpreadsheetApp.getUi().showModalDialog(html, '상담 슬롯 일괄 생성');
}

function generateSlots(o) {
  const pad = (n) => String(n).padStart(2, '0');
  const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  const fromMin = (n) => `${pad(Math.floor(n / 60))}:${pad(n % 60)}`;
  const [fy, fm, fd] = o.from.split('-').map(Number);
  const [ty, tm, td] = o.to.split('-').map(Number);
  const DAY = 24 * 3600 * 1000;
  let cur = Date.UTC(fy, fm - 1, fd);
  const last = Date.UTC(ty, tm - 1, td);
  const startMin = toMin(o.startTime), endMin = toMin(o.endTime);
  const dur = Number(o.duration), gap = Number(o.gap) || 0;

  if (last < cur) throw new Error('종료일이 시작일보다 빠릅니다.');
  if (last - cur > 180 * DAY) throw new Error('한 번에 180일까지만 만들 수 있습니다.');
  if (!(dur > 0) || startMin + dur > endMin) throw new Error('시간 범위와 상담 길이를 확인하세요.');
  if (!o.days.length) throw new Error('요일을 하나 이상 선택하세요.');

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheet_(SLOT_SHEET);
    const existing = new Set(readRows_(sh).map(slotFromRow_).filter(Boolean).map((s) => s.id));
    const rows = [];
    for (; cur <= last; cur += DAY) {
      const d = new Date(cur);
      if (!o.days.includes(d.getUTCDay())) continue;
      const ymd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
      for (let t = startMin; t + dur <= endMin; t += dur + gap) {
        const id = slotId_(ymd, fromMin(t));
        if (existing.has(id)) continue;
        rows.push({ '슬롯ID': id, '날짜': ymd, '시작': fromMin(t), '종료': fromMin(t + dur), '장소': o.location || '', '상태': SLOT.OPEN });
      }
    }
    appendObjects_(sh, rows, SLOT_TEXT_COLS);
    return rows.length;
  } finally {
    lock.releaseLock();
  }
}

function showReportDraft() {
  const r = selectedBooking_();
  if (!r) return;
  const v = (k) => str_(r[k]);
  const date = ymd_(r['상담일']);
  const text = [
    '■ 내담자 기본정보',
    `학번: ${v('학번')}`,
    `이름: ${v('이름')}`,
    `성별: ${v('성별')}`,
    `학과: ${v('학과')}`,
    `과정: ${v('과정')}`,
    `국적: ${v('국적')}`,
    `연락처: ${v('연락처')}`,
    '',
    '■ 상담결과 기본정보',
    `상담자: ${v('상담자')}`,
    `상담방법: ${v('상담방법')}`,
    `상담구분: ${v('상담구분')}`,
    `상담일시: ${date ? fmtKDate_(date) : ''} ${v('상담시간')}`,
    `상담장소: ${v('상담장소')}`,
    '',
    '■ 호소문제유형',
    v('호소문제유형'),
    '',
    '■ 카페이용 정보',
    `카페이용내역: ${v('카페이용내역')}`,
    `이용금액: ${v('이용금액')}원`,
    '',
    '■ 주요 호소내용 및 상담/조치사항',
    '[주요 호소내용]',
    v('주요 호소내용'),
    '',
    '[상담및조치]',
    v('상담및조치') || '(상담 후 작성)',
    '',
    '[관찰사항]',
    v('관찰사항'),
    '',
    '[특이사항]',
    v('특이사항'),
    '',
    `[상담결과] ${v('상담결과')}`,
    '',
    '────────────',
    '(참고) 학생이 미리 작성한 상세 내용',
    v('학생 작성 상세내용') || '-',
  ].join('\n');

  const safeJson = JSON.stringify(text).replace(/</g, '\\u003c');
  const html = HtmlService.createHtmlOutput(`
<style>
  body { font-family: Arial, sans-serif; margin: 0; }
  textarea { width: 100%; height: 470px; box-sizing: border-box; font-size: 13px; line-height: 1.5; padding: 8px; }
  button { margin-top: 8px; padding: 8px 18px; background: #2f5bea; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
  span { margin-left: 8px; font-size: 12px; color: #555; }
</style>
<textarea id="t" readonly></textarea>
<button id="c">전체 복사</button><span id="m"></span>
<script>
  var t = document.getElementById('t');
  t.value = ${safeJson};
  document.getElementById('c').onclick = function () {
    t.select(); document.execCommand('copy');
    document.getElementById('m').textContent = '복사했습니다.';
  };
</script>`).setWidth(560).setHeight(560);
  SpreadsheetApp.getUi().showModalDialog(html, `상담일지 초안 — ${v('이름')}`);
}

function cancelSelectedBooking() {
  const ui = SpreadsheetApp.getUi();
  const r = selectedBooking_();
  if (!r) return;
  if (str_(r['예약상태']) === BOOKING.CANCELLED) { ui.alert('이미 취소된 예약입니다.'); return; }
  const answer = ui.alert('예약 취소',
    `${str_(r['이름'])} (${ymd_(r['상담일'])} ${str_(r['상담시간'])}) 예약을 취소하고 해당 시간을 다시 열까요?`,
    ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    setCells_(sheet_(BOOKING_SHEET), r._row, { '예약상태': BOOKING.CANCELLED });
    const slotSh = sheet_(SLOT_SHEET);
    const slot = readRows_(slotSh).map(slotFromRow_).find((s) => s && s.bookingId === str_(r['예약ID']));
    if (slot) setCells_(slotSh, slot.row, { '상태': SLOT.OPEN, '예약ID': '' });
  } finally {
    lock.releaseLock();
  }
  ui.alert('취소했습니다. 학생에게는 따로 연락해 주세요.');
}

function selectedBooking_() {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActiveSheet();
  if (sh.getName() !== BOOKING_SHEET) { ui.alert(`'${BOOKING_SHEET}' 시트에서 예약 행을 선택한 뒤 실행하세요.`); return null; }
  const row = sh.getActiveRange().getRow();
  if (row < 2 || row > sh.getLastRow()) { ui.alert('예약 행을 선택한 뒤 실행하세요.'); return null; }
  const map = headerMap_(sh);
  const values = sh.getRange(row, 1, 1, sh.getLastColumn()).getValues()[0];
  const o = { _row: row };
  Object.keys(map).forEach((k) => { o[k] = values[map[k]]; });
  return o;
}

/* =========================================================
 * 시트 유틸
 * ======================================================= */

function sheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error(`'${name}' 시트가 없습니다. 메뉴에서 '처음 설정'을 먼저 실행하세요.`);
  return sh;
}

function ensureSheet_(ss, name, headers, textCols) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#eef1f7');
    sh.setFrozenRows(1);
  }
  const map = headerMap_(sh);
  textCols.forEach((k) => {
    if (k in map) sh.getRange(2, map[k] + 1, sh.getMaxRows() - 1, 1).setNumberFormat('@');
  });
  return sh;
}

function dropdown_(sh, header, list) {
  const map = headerMap_(sh);
  if (!(header in map)) return;
  const rule = SpreadsheetApp.newDataValidation().requireValueInList(list, true).setAllowInvalid(true).build();
  sh.getRange(2, map[header] + 1, sh.getMaxRows() - 1, 1).setDataValidation(rule);
}

function headerMap_(sh) {
  const width = sh.getLastColumn();
  const map = {};
  if (!width) return map;
  sh.getRange(1, 1, 1, width).getValues()[0].forEach((h, i) => {
    const key = str_(h);
    if (key) map[key] = i;
  });
  return map;
}

// 머리글 이름을 키로 하는 객체 배열 (행 번호는 _row)
function readRows_(sh) {
  const map = headerMap_(sh);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues().map((v, i) => {
    const o = { _row: i + 2 };
    Object.keys(map).forEach((k) => { o[k] = v[map[k]]; });
    return o;
  });
}

function appendObjects_(sh, objs, textCols) {
  if (!objs.length) return;
  const map = headerMap_(sh);
  const width = sh.getLastColumn();
  const values = objs.map((o) => {
    const row = new Array(width).fill('');
    Object.keys(o).forEach((k) => { if (k in map) row[map[k]] = o[k]; });
    return row;
  });
  const start = sh.getLastRow() + 1;
  const need = start + values.length - 1;
  if (need > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows() + 50);
  textCols.forEach((k) => {
    if (k in map) sh.getRange(start, map[k] + 1, values.length, 1).setNumberFormat('@');
  });
  sh.getRange(start, 1, values.length, width).setValues(values);
}

function setCells_(sh, rowNum, obj) {
  const map = headerMap_(sh);
  Object.keys(obj).forEach((k) => {
    if (k in map) sh.getRange(rowNum, map[k] + 1).setValue(obj[k]);
  });
}

/* =========================================================
 * 값 유틸
 * ======================================================= */

let tzCache_;
function tz_() { return tzCache_ || (tzCache_ = SpreadsheetApp.getActive().getSpreadsheetTimeZone()); }

function str_(v) { return (v === null || v === undefined ? '' : String(v)).trim(); }

// 학생 입력이 수식(=, +, -, @로 시작)으로 해석되지 않도록 막기
function safe_(v) {
  const s = str_(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function ymd_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
  const m = str_(v).replace(/[./]/g, '-').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
}

function hm_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'HH:mm');
  const m = str_(v).match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
}

function toDate_(ymd, hm) { return Utilities.parseDate(`${ymd} ${hm}`, tz_(), 'yyyy-MM-dd HH:mm'); }

function slotId_(ymd, hm) { return 'S' + ymd.replace(/-/g, '') + hm.replace(':', ''); }

function fmtKDate_(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const wd = ['일', '월', '화', '수', '목', '금', '토'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${y}년 ${m}월 ${d}일 (${wd})`;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
