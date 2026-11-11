const ALARM = 'auto-visit';
const MIN_INTERVAL_SEC = 30;

const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'), urls: $('urls'), interval: $('interval'), unit: $('unit'),
  background: $('background'), error: $('error'), toggle: $('toggle'), visitNow: $('visitNow'),
  runInfo: $('runInfo'), current: $('current'), nextAt: $('nextAt'),
  log: $('log'), logEmpty: $('logEmpty'), clearLog: $('clearLog'),
};

let state = { run: {}, settings: {}, log: [] };
let nextAlarmAt = null;

// ── 입력 파싱 ───────────────────────────────────────────────────────
function parseUrls(text) {
  const urls = [];
  const invalid = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(line) ? line : `https://${line}`;
    try {
      const u = new URL(withScheme);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
      urls.push(u.href);
    } catch {
      invalid.push(line);
    }
  }
  return { urls, invalid };
}

function intervalSec() {
  return Number(els.interval.value) * Number(els.unit.value);
}

// 팝업을 닫아도 입력 중인 내용이 남도록 저장
function saveForm() {
  chrome.storage.local.set({
    form: {
      text: els.urls.value,
      interval: els.interval.value,
      unit: els.unit.value,
      background: els.background.checked,
    },
  });
}

function showError(msg) {
  els.error.textContent = msg ?? '';
  els.error.hidden = !msg;
}

// ── 렌더링 ─────────────────────────────────────────────────────────
const fmtTime = (t) =>
  new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

function fmtResult(e) {
  switch (e.status) {
    case 'ok': return `${e.code} · ${(e.ms / 1000).toFixed(1)}s`;
    case 'error': return e.code ? `${e.code} · ${(e.ms / 1000).toFixed(1)}s` : (e.error || '오류').replace(/^net::/, '');
    case 'timeout': return '미완료';
    default: return '로딩 중…';
  }
}

function render() {
  const { run, settings, log } = state;
  const running = !!run.running;

  els.status.textContent = running ? '실행 중' : '정지';
  els.status.classList.toggle('on', running);
  els.toggle.textContent = running ? '정지' : '시작';
  els.toggle.classList.toggle('stop', running);
  els.visitNow.hidden = !running;
  els.runInfo.hidden = !running;
  for (const el of [els.urls, els.interval, els.unit, els.background]) el.disabled = running;

  if (running) {
    const total = settings.urls?.length ?? 0;
    els.current.textContent = run.lastAt
      ? `${fmtTime(run.lastAt)} · 링크 ${total}개 · ${run.rounds}회째`
      : '-';
  }
  renderCountdown();

  els.log.replaceChildren(
    ...[...log].reverse().slice(0, 50).map((e) => {
      const li = document.createElement('li');
      const time = Object.assign(document.createElement('span'), { className: 'time', textContent: fmtTime(e.at) });
      const url = Object.assign(document.createElement('span'), { className: 'url', textContent: e.url, title: e.url });
      const res = Object.assign(document.createElement('span'), { className: `res ${e.status}`, textContent: fmtResult(e) });
      li.append(time, url, res);
      return li;
    }),
  );
  els.logEmpty.hidden = log.length > 0;
}

function renderCountdown() {
  if (!state.run.running || !nextAlarmAt) {
    els.nextAt.textContent = '-';
    return;
  }
  const left = Math.max(0, Math.round((nextAlarmAt - Date.now()) / 1000));
  const m = Math.floor(left / 60);
  const s = left % 60;
  els.nextAt.textContent = `${fmtTime(nextAlarmAt)} (${m ? `${m}분 ` : ''}${s}초 후)`;
}

async function refresh() {
  const data = await chrome.storage.local.get(['run', 'settings', 'log']);
  state = { run: data.run ?? {}, settings: data.settings ?? {}, log: data.log ?? [] };
  const alarm = await chrome.alarms.get(ALARM);
  nextAlarmAt = alarm?.scheduledTime ?? null;
  render();
}

// ── 동작 ───────────────────────────────────────────────────────────
async function send(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (!res?.ok) throw new Error(res?.error || '요청에 실패했습니다.');
}

els.toggle.addEventListener('click', async () => {
  showError(null);
  els.toggle.disabled = true;
  try {
    if (state.run.running) {
      await send({ type: 'stop' });
      return;
    }
    const { urls, invalid } = parseUrls(els.urls.value);
    if (invalid.length) return showError(`올바르지 않은 링크:\n${invalid.join('\n')}`);
    if (!urls.length) return showError('링크를 하나 이상 입력하세요.');
    const sec = intervalSec();
    if (!(sec >= MIN_INTERVAL_SEC)) return showError(`방문 간격은 최소 ${MIN_INTERVAL_SEC}초입니다.`);
    await send({ type: 'start', settings: { urls, intervalSec: sec, background: els.background.checked } });
  } catch (e) {
    showError(e.message);
  } finally {
    els.toggle.disabled = false;
    refresh();
  }
});

els.visitNow.addEventListener('click', () => send({ type: 'visitNow' }).catch((e) => showError(e.message)));
els.clearLog.addEventListener('click', () => send({ type: 'clearLog' }).catch((e) => showError(e.message)));

for (const el of [els.urls, els.interval, els.unit, els.background]) {
  el.addEventListener('input', saveForm);
  el.addEventListener('change', saveForm);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.run || changes.log || changes.settings)) refresh();
});

// ── 초기화 ─────────────────────────────────────────────────────────
(async () => {
  const { form } = await chrome.storage.local.get('form');
  if (form) {
    els.urls.value = form.text ?? '';
    els.interval.value = form.interval ?? '1';
    els.unit.value = form.unit ?? '60';
    els.background.checked = form.background ?? true;
  }
  await refresh();
  setInterval(renderCountdown, 1000);
})();
