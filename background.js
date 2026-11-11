// Auto Visit — 백그라운드 서비스 워커
// 정해둔 간격마다 목록의 링크를 "전부 한 번씩" 엽니다. 링크마다 전용 탭을 하나씩 두고 재사용합니다.
// 상태는 모두 chrome.storage.local 에 둡니다 (서비스 워커는 수시로 내려갔다 올라오기 때문).
//   settings: { urls: string[], intervalSec: number, background: boolean }
//   run:      { running, tabIds: (number|null)[], startedAt, lastAt, rounds }
//   log:      [{ id, tabId, url, at, status: pending|ok|error|timeout, code?, ms?, error?, requestId? }]

const ALARM = 'auto-visit';
const MIN_INTERVAL_SEC = 30; // Chrome 120+ 에서 chrome.alarms 의 최소 주기
const LOG_LIMIT = 200;

const DEFAULT_SETTINGS = { urls: [], intervalSec: 60, background: true };
const IDLE_RUN = { running: false, tabIds: [], startedAt: null, lastAt: null, rounds: 0 };

async function load() {
  const { settings, run } = await chrome.storage.local.get(['settings', 'run']);
  return {
    settings: { ...DEFAULT_SETTINGS, ...settings },
    run: { ...IDLE_RUN, ...run },
  };
}

// 로그는 webRequest 이벤트가 연달아 들어오며 동시에 고칠 수 있어, 한 줄로 세워 처리합니다.
let logChain = Promise.resolve();
function mutateLog(fn) {
  logChain = logChain.then(async () => {
    const { log = [] } = await chrome.storage.local.get('log');
    const next = fn(log);
    if (next === false) return; // 바뀐 게 없으면 저장하지 않음
    await chrome.storage.local.set({ log: (next ?? log).slice(-LOG_LIMIT) });
  }).catch((e) => console.error('[auto-visit] log', e));
  return logChain;
}

async function setBadge(on) {
  await chrome.action.setBadgeText({ text: on ? 'ON' : '' });
  if (on) await chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
}

// 링크 전용 탭을 확보합니다. 사용자가 닫았으면 새로 만듭니다.
async function ensureTab(tabId, background) {
  if (tabId != null) {
    try {
      await chrome.tabs.get(tabId);
      return tabId;
    } catch {
      // 닫힌 탭 — 아래에서 새로 만든다
    }
  }
  const tab = await chrome.tabs.create({ url: 'about:blank', active: !background });
  return tab.id;
}

// 한 바퀴: 목록의 링크를 모두 한 번씩 연다.
async function tick() {
  const { settings, run } = await load();
  if (!run.running || settings.urls.length === 0) return;

  const tabIds = [];
  for (let i = 0; i < settings.urls.length; i++) {
    tabIds.push(await ensureTab(run.tabIds[i], settings.background));
  }
  const at = Date.now();

  // tabIds 를 먼저 저장해야 webRequest 리스너가 이 탭들의 요청을 알아봅니다.
  await chrome.storage.local.set({
    run: { ...run, tabIds, lastAt: at, rounds: run.rounds + 1 },
  });

  await mutateLog((log) => {
    // 지난 바퀴에서 아직 끝나지 않은 방문은 시간 초과로 처리
    for (const e of log) if (e.status === 'pending') e.status = 'timeout';
    settings.urls.forEach((url, i) => {
      log.push({ id: crypto.randomUUID(), tabId: tabIds[i], url, at, status: 'pending' });
    });
    return log;
  });

  await Promise.allSettled(
    settings.urls.map((url, i) => chrome.tabs.update(tabIds[i], { url })),
  );
}

async function start(input) {
  const urls = Array.isArray(input?.urls) ? input.urls : [];
  if (urls.length === 0) throw new Error('링크를 하나 이상 입력하세요.');
  const intervalSec = Math.max(MIN_INTERVAL_SEC, Math.round(Number(input.intervalSec) || 0));
  const settings = { urls, intervalSec, background: !!input.background };

  const { run } = await load();
  await chrome.storage.local.set({
    settings,
    // 이전에 쓰던 탭이 남아 있으면 같은 순서로 재사용
    run: { ...IDLE_RUN, running: true, startedAt: Date.now(), tabIds: run.tabIds },
  });

  await chrome.alarms.create(ALARM, {
    delayInMinutes: intervalSec / 60,
    periodInMinutes: intervalSec / 60,
  });
  await setBadge(true);
  await tick(); // 시작하자마자 첫 바퀴 (실패해도 알람이 걸려 있어 다음 주기에 재시도)
}

async function stop() {
  await chrome.alarms.clear(ALARM);
  const { run } = await load();
  await chrome.storage.local.set({ run: { ...run, running: false } });
  await mutateLog((log) => {
    for (const e of log) if (e.status === 'pending') e.status = 'timeout';
    return log;
  });
  await setBadge(false);
}

// 브라우저 재시작 후에도 실행 중이었다면 이어서 돈다.
async function resume() {
  const { settings, run } = await load();
  await setBadge(run.running);
  if (!run.running) return;
  const alarm = await chrome.alarms.get(ALARM);
  if (!alarm) {
    await chrome.alarms.create(ALARM, {
      delayInMinutes: settings.intervalSec / 60,
      periodInMinutes: settings.intervalSec / 60,
    });
  }
}

chrome.runtime.onStartup.addListener(resume);
chrome.runtime.onInstalled.addListener(resume);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) tick().catch((e) => console.error('[auto-visit] tick', e));
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'start': await start(msg.settings); break;
      case 'stop': await stop(); break;
      case 'visitNow': await tick(); break;
      case 'clearLog': await mutateLog(() => []); break;
      default: throw new Error(`알 수 없는 요청: ${msg?.type}`);
    }
  })().then(
    () => sendResponse({ ok: true }),
    (e) => sendResponse({ ok: false, error: e.message }),
  );
  return true; // 비동기 응답
});

// ── 방문 결과 기록 (HTTP 상태 코드·응답 시간) ──────────────────────────
const FILTER = { urls: ['<all_urls>'], types: ['main_frame'] };

// 방문 직후 그 탭에서 들어오는 첫 main_frame 요청을 해당 탭의 대기 중 로그에 연결합니다.
// requestId 로 묶어 두어야, 다음 바퀴로 넘어가며 취소된 이전 요청(ERR_ABORTED)이
// 새 방문 기록을 덮어쓰지 않습니다.
chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId < 0) return;
  mutateLog((log) => {
    const entry = log.findLast((e) => e.tabId === d.tabId && e.status === 'pending');
    if (!entry || entry.requestId) return false;
    entry.requestId = d.requestId;
    return log;
  });
}, FILTER);

function settle(requestId, patch) {
  mutateLog((log) => {
    const entry = log.find((e) => e.requestId === requestId && e.status === 'pending');
    if (!entry) return false;
    Object.assign(entry, patch, { ms: Date.now() - entry.at });
    return log;
  });
}

chrome.webRequest.onCompleted.addListener((d) => {
  settle(d.requestId, { status: d.statusCode >= 400 ? 'error' : 'ok', code: d.statusCode });
}, FILTER);

chrome.webRequest.onErrorOccurred.addListener((d) => {
  settle(d.requestId, { status: 'error', error: d.error });
}, FILTER);
