// ai-agent.js — Claude Opus API + Telegram Bot API (Ф5).
// -----------------------------------------------------------------------------
// Что делает:
//  1) По клику «Сформировать отчёт» собирает перерасходы из calcProject().
//  2) Строит промпт и зовёт Claude Opus (claude-opus-4-8) прямо из браузера.
//  3) Показывает отчёт в модалке (спиннер на время генерации).
//  4) Шлёт Максиму ДВА сообщения в Telegram (алерт + полный отчёт).
//  5) При любой ошибке AI — резервный отчёт по цифрам (buildFallbackReport).
//  6) Все ошибки — понятным русским текстом; техдетали только в console (logDev).
//
// Стиль: без сборки, работает через file://. Зависит от app.js (calcProject,
// esc, fmtT, fmtRub, fmtPct, num) и config.js (CONFIG).
'use strict';

// ==== Константы API ==========================================================
var LLM_URL = 'https://api.anthropic.com/v1/messages';
var LLM_MODEL = 'claude-opus-4-8';
var LLM_MAX_TOKENS = 2048;      // SPEC пишет 1024, но деловой отчёт не должен обрезаться
var LLM_TIMEOUT_MS = 60000;     // таймаут генерации, 60 c (Plan.md р.4)

// Ключ localStorage для последнего отчёта (P1: восстановление в модалку).
var LAST_REPORT_KEY = 'zamery_last_report';

// Плейсхолдеры из config.js — если ключ равен одному из них, значит не настроен.
var PLACEHOLDERS = {
  key: 'sk-ant-ВСТАВЬТЕ_КЛЮЧ',
  token: 'ВСТАВЬТЕ_ТОКЕН',
  chat: 'ВСТАВЬТЕ_CHAT_ID'
};

// ==== Модуль-состояние (последний сформированный отчёт и его данные) =========
// Держим тут, чтобы «Повторить отправку» в TG НЕ пересоздавал отчёт.
var lastReportText = '';   // текст отчёта (AI или резервный), показанный в модалке
var lastAlertText = '';    // текст короткого алерта (сообщение 1 для TG)
var lastTgStatus = { alert: false, full: false }; // что уже ушло в Telegram

// ==== Проверка настройки ключей =============================================
// hasConfig() — есть ли объект CONFIG вообще.
function hasConfig() {
  return (typeof CONFIG !== 'undefined') && CONFIG && typeof CONFIG === 'object';
}
// llmKeyReady() — ключ Anthropic задан и это не плейсхолдер.
function llmKeyReady() {
  if (!hasConfig()) return false;
  var k = CONFIG.ANTHROPIC_API_KEY;
  return typeof k === 'string' && k.length > 0 && k !== PLACEHOLDERS.key;
}
// tgReady() — токен бота и chat_id заданы и это не плейсхолдеры.
function tgReady() {
  if (!hasConfig()) return false;
  var t = CONFIG.TG_BOT_TOKEN, c = CONFIG.MAKSIM_CHAT_ID;
  return typeof t === 'string' && t.length > 0 && t !== PLACEHOLDERS.token
      && (typeof c === 'string' || typeof c === 'number') && String(c).length > 0 && String(c) !== PLACEHOLDERS.chat;
}

// ==== Логирование для разработчика ==========================================
// logDev(tag, err) — обёртка над console.error. Техника (коды/тела/стеки)
// идёт ТОЛЬКО в консоль (F12). Пользователю НИКОГДА не показываем.
function logDev(tag, err) {
  try { console.error('[ai-agent] ' + tag, err); } catch (e) {}
}

// ==== Сбор данных о перерасходе =============================================
// collectOverruns() — из calcProject() выбирает перерасходы (delta_t < 0)
// по помещениям и материалам, с ответственным, планом/фактом/Δт/Δ₽/%.
// Возвращает:
//   { projectName, date, overruns: [ {room, floor, material, responsible,
//        plan_t, fact_t, delta_t, delta_rub, percent} ], totals, hasData }
// overruns отсортированы по величине Δ₽ (самый дорогой перерасход — первым).
function collectOverruns() {
  var data = (typeof calcProject === 'function') ? calcProject() : { materials: [], rooms: [], totals: {}, projectName: '' };
  var overruns = [];

  (data.rooms || []).forEach(function (room) {
    (room.byMaterial || []).forEach(function (m) {
      if (m.overrun && m.delta_t < 0) {
        overruns.push({
          floor: room.floorName || '',
          room: room.roomName || 'Помещение',
          responsible: room.responsible || 'не указан',
          material: m.materialName || '',
          plan_t: m.plan_t,
          fact_t: m.fact_t,
          delta_t: m.delta_t,          // < 0
          delta_rub: m.delta_rub,      // < 0
          percent: m.percent           // < 0
        });
      }
    });
  });

  // Самый дорогой перерасход первым (по модулю Δ₽).
  overruns.sort(function (a, b) { return a.delta_rub - b.delta_rub; });

  return {
    projectName: data.projectName || 'Объект',
    date: formatDateRu(new Date()),
    overruns: overruns,
    materials: data.materials || [],
    totals: data.totals || { plan_t: 0, fact_t: 0, delta_t: 0, delta_rub: 0 },
    hasData: (data.materials || []).length > 0
  };
}

// formatDateRu(d) — «02.07.2026».
function formatDateRu(d) {
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  return p2(d.getDate()) + '.' + p2(d.getMonth() + 1) + '.' + d.getFullYear();
}

// t3(v) — тонны с 3 знаками (использует fmtT из app.js, если есть).
function t3(v) { return (typeof fmtT === 'function') ? fmtT(v) : String(Math.round(num(v) * 1000) / 1000); }
// rub(v) — рубли (fmtRub из app.js).
function rub(v) { return (typeof fmtRub === 'function') ? fmtRub(v) : String(Math.round(num(v))); }
// pct(v) — проценты (fmtPct из app.js).
function pct(v) { return (typeof fmtPct === 'function') ? fmtPct(v) : (Math.round(num(v) * 10) / 10) + '%'; }
// n(v) — безопасное число (num из app.js, с локальным фолбэком).
function n(v) {
  if (typeof num === 'function') return num(v);
  var x = Number(v); return isFinite(x) ? x : 0;
}

// ==== Промпты ================================================================
// SYSTEM_PROMPT — style guide из SPEC (деловой тон, от первого лица, без AI-воды).
var SYSTEM_PROMPT = [
  'Ты помощник руководителя строительного проекта.',
  'Пишешь деловые отчёты о расходе материалов.',
  '',
  'Стиль:',
  '- Краткий, прямой, деловой — как пишет опытный руководитель-строитель, не AI',
  '- Без вводных «данные показывают», «анализ выявил», «рекомендуется»',
  '- Называй вещи своими именами: «перерасход», «не выполнено», «требует проверки»',
  '- Пиши от первого лица, как будто это пишет Александр',
  '- Без воды и пустых фраз',
  '',
  'Формат: сводка по перерасходу → оценка → рекомендации.'
].join('\n');

// buildPrompt(info) — пользовательское сообщение с цифрами для Claude.
function buildPrompt(info) {
  var lines = [];
  lines.push('Сформируй деловой отчёт о перерасходе материалов для клиента Максима.');
  lines.push('');
  lines.push('ОБЪЕКТ: ' + info.projectName + ' | ДАТА: ' + info.date);
  lines.push('');
  if (!info.overruns.length) {
    lines.push('Перерасхода нет: факт по всем материалам в пределах плана.');
  } else {
    lines.push('ПЕРЕРАСХОД (факт больше плана):');
    info.overruns.forEach(function (o) {
      var where = o.room + (o.floor ? ' (' + o.floor + ')' : '');
      lines.push('- ' + where + ' / ' + o.material + ': план ' + t3(o.plan_t)
        + ' т, факт ' + t3(o.fact_t) + ' т, перерасход ' + t3(Math.abs(o.delta_t)) + ' т ('
        + pct(o.percent) + '), лишние затраты ' + rub(Math.abs(o.delta_rub)) + ' ₽. Ответственный: ' + o.responsible + '.');
    });
    lines.push('');
    lines.push('ИТОГО по объекту: план ' + t3(info.totals.plan_t) + ' т, факт '
      + t3(info.totals.fact_t) + ' т, перерасход ' + t3(Math.abs(info.totals.delta_t))
      + ' т на ' + rub(Math.abs(info.totals.delta_rub)) + ' ₽.');
  }
  lines.push('');
  lines.push('Структура отчёта:');
  lines.push('ПЕРЕРАСХОД: по строке на помещение/материал (план → факт, −Δт (−%), ответственный).');
  lines.push('ОЦЕНКА: 2-3 предложения — что происходит, насколько серьёзно.');
  lines.push('РЕКОМЕНДАЦИИ: 1-3 конкретных действия.');
  return lines.join('\n');
}

// ==== Резервный отчёт (без AI) ==============================================
// buildFallbackReport(info) — собирает отчёт ТОЛЬКО из посчитанных цифр
// (calcProject), без обращения к Claude. Используется при любой ошибке LLM.
function buildFallbackReport(info) {
  var lines = [];
  lines.push('ОБЪЕКТ: ' + info.projectName + ' | ДАТА: ' + info.date);
  lines.push('');
  lines.push('ПЕРЕРАСХОД:');
  if (!info.overruns.length) {
    lines.push('• Перерасхода не выявлено — факт в пределах плана.');
  } else {
    info.overruns.forEach(function (o) {
      var where = o.room + (o.floor ? ' (' + o.floor + ')' : '');
      lines.push('• ' + where + ' / ' + o.material + ': план ' + t3(o.plan_t)
        + ' т → факт ' + t3(o.fact_t) + ' т, −' + t3(Math.abs(o.delta_t)) + ' т ('
        + pct(o.percent) + ') | Ответственный: ' + o.responsible);
    });
    lines.push('');
    lines.push('ИТОГО: перерасход ' + t3(Math.abs(info.totals.delta_t)) + ' т на '
      + rub(Math.abs(info.totals.delta_rub)) + ' ₽ по объекту.');
  }
  return lines.join('\n');
}

// buildAlert(info) — короткое сообщение 1 (алерт) по топ-1 проблеме (SPEC).
function buildAlert(info) {
  if (!info.overruns.length) {
    return '✅ Объект ' + info.projectName + ': перерасхода нет.\nПолный отчёт ниже ↓';
  }
  var top = info.overruns[0];
  var where = top.room + (top.floor ? ', ' + top.floor : '');
  return '⚠️ Перерасход на объекте ' + info.projectName + '\n'
    + 'Материал: ' + top.material + '\n'
    + 'Помещение: ' + where + ', −' + t3(Math.abs(top.delta_t)) + ' т (' + pct(top.percent)
    + '), ответственный: ' + top.responsible + '\n'
    + 'Полный отчёт ниже ↓';
}

// ============================================================================
// МОДАЛКА (overlay + окно). Создаётся из JS один раз, дальше переиспользуется.
// ============================================================================
var modalEls = null; // { overlay, box, body, footer, closeBtn }

// escHtml(s) — экранирование (используем esc из app.js, локальный фолбэк).
function escHtml(s) {
  if (typeof esc === 'function') return esc(s);
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ensureModal() — создаёт DOM модалки при первом вызове.
function ensureModal() {
  if (modalEls) return modalEls;

  var overlay = document.createElement('div');
  overlay.className = 'ai-modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.hidden = true;

  var box = document.createElement('div');
  box.className = 'ai-modal';

  var head = document.createElement('div');
  head.className = 'ai-modal-head';
  head.innerHTML = '<span class="ai-modal-title">Отчёт по перерасходу</span>';

  var closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'ai-modal-close';
  closeBtn.setAttribute('aria-label', 'Закрыть');
  closeBtn.textContent = '✕';
  head.appendChild(closeBtn);

  var body = document.createElement('div');
  body.className = 'ai-modal-body';

  var footer = document.createElement('div');
  footer.className = 'ai-modal-footer';

  box.appendChild(head);
  box.appendChild(body);
  box.appendChild(footer);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  // Закрытие: крестик, клик по фону, Esc.
  closeBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', function (ev) {
    if (ev.target === overlay) closeModal();
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !overlay.hidden) closeModal();
  });

  modalEls = { overlay: overlay, box: box, body: body, footer: footer, closeBtn: closeBtn };
  return modalEls;
}

// openModal() / closeModal() — показать/скрыть overlay.
function openModal() {
  var m = ensureModal();
  m.overlay.hidden = false;
  document.body.classList.add('ai-modal-open');
}
function closeModal() {
  if (!modalEls) return;
  modalEls.overlay.hidden = true;
  document.body.classList.remove('ai-modal-open');
}

// setModalFooter(buttons) — buttons: [{label, kind, disabled, onClick}].
// kind ∈ 'primary'|'ghost'|'danger' → классы кнопок. Очищает и перерисовывает.
function setModalFooter(buttons) {
  var m = ensureModal();
  m.footer.innerHTML = '';
  (buttons || []).forEach(function (b) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm ' + (b.kind === 'primary' ? 'btn-primary'
      : b.kind === 'danger' ? 'btn-danger-solid' : 'btn-ghost');
    btn.textContent = b.label;
    if (b.disabled) { btn.disabled = true; }
    else if (typeof b.onClick === 'function') { btn.addEventListener('click', b.onClick); }
    m.footer.appendChild(btn);
  });
}

// showSpinner(msg) — состояние «генерируется».
function showSpinner(msg) {
  var m = ensureModal();
  m.body.innerHTML = '<div class="ai-spinner-wrap">'
    + '<div class="ai-spinner" aria-hidden="true"></div>'
    + '<p class="ai-spinner-msg">' + escHtml(msg || 'Формирую отчёт…') + '</p>'
    + '</div>';
  setModalFooter([]);
  openModal();
}

// showUserError(msgRu) — рендер ПОНЯТНОГО РУССКОГО сообщения в модалку.
// Технику сюда НЕ пишем (она в консоли через logDev).
function showUserError(msgRu) {
  var m = ensureModal();
  m.body.innerHTML = '<div class="ai-error"><p class="ai-error-msg">'
    + escHtml(msgRu) + '</p></div>';
  openModal();
}

// showReport(text, opts) — показать текст отчёта в модалке.
//   opts.fallback — true → плашка «резервный отчёт».
//   opts.notice   — доп. русское уведомление сверху (ошибка LLM/TG).
//   opts.retry    — { label, disabled, onClick } кнопка «Повторить» (для LLM).
// Внизу всегда: «Скопировать отчёт» + управление отправкой в TG.
function showReport(text, opts) {
  opts = opts || {};
  var m = ensureModal();

  var html = '';
  if (opts.notice) {
    html += '<div class="ai-notice">' + escHtml(opts.notice) + '</div>';
  }
  if (opts.fallback) {
    html += '<div class="ai-notice ai-notice-warn">⚠️ Показан резервный отчёт по цифрам '
      + '(без анализа AI). Нажмите «Повторить», чтобы сформировать полный отчёт.</div>';
  }
  html += '<pre class="ai-report-text" data-role="report-text">' + escHtml(text) + '</pre>';
  m.body.innerHTML = html;

  buildReportFooter(opts);
  openModal();
}

// buildReportFooter(opts) — низ модалки с отчётом: копировать + TG + повтор.
function buildReportFooter(opts) {
  opts = opts || {};
  var buttons = [];

  // «Скопировать отчёт» (P1) — всегда доступна.
  buttons.push({ label: 'Скопировать отчёт', kind: 'ghost', onClick: copyReport });

  // «Повторить» — для сценариев ошибки LLM (резервный отчёт).
  if (opts.retry) {
    buttons.push({
      label: opts.retry.label || 'Повторить',
      kind: 'primary',
      disabled: !!opts.retry.disabled,
      onClick: opts.retry.onClick
    });
  }

  setModalFooter(buttons);

  // Управление отправкой в Telegram — отдельным блоком под кнопками.
  renderTgControls();
}

// copyReport() — копирование текста отчёта в буфер (navigator.clipboard + фолбэк).
function copyReport() {
  var pre = modalEls && modalEls.body.querySelector('[data-role="report-text"]');
  var text = pre ? pre.textContent : lastReportText;
  if (!text) return;
  function done() { flashCopyOk(); }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function (err) {
      logDev('clipboard', err); legacyCopy(text); done();
    });
  } else {
    legacyCopy(text); done();
  }
}
function legacyCopy(text) {
  try {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  } catch (e) { logDev('legacyCopy', e); }
}
function flashCopyOk() {
  var btns = modalEls && modalEls.footer.querySelectorAll('button');
  if (!btns) return;
  for (var i = 0; i < btns.length; i++) {
    if (btns[i].textContent.indexOf('Скопир') === 0) {
      var b = btns[i], old = b.textContent;
      b.textContent = 'Скопировано ✓';
      setTimeout(function () { b.textContent = old; }, 1500);
      break;
    }
  }
}

// ============================================================================
// ВЫЗОВ CLAUDE (Anthropic API) — из браузера, с таймаутом и разбором ошибок.
// ============================================================================
// LlmError — свой тип ошибки с «видом», чтобы наверху выбрать русский текст.
//   kind ∈ 'network' | 'auth' | 'overload' | 'server' | 'timeout' | 'bad'
function LlmError(kind, detail) {
  this.name = 'LlmError';
  this.kind = kind;
  this.detail = detail;
}

// callClaude(prompt) — POST на /v1/messages. Возвращает текст отчёта (string)
// или бросает LlmError с нужным kind (см. таблицу 4.1 Plan.md).
function callClaude(prompt) {
  var controller = new AbortController();
  var timedOut = false;
  var timer = setTimeout(function () { timedOut = true; controller.abort(); }, LLM_TIMEOUT_MS);

  return fetch(LLM_URL, {
    method: 'POST',
    headers: {
      'x-api-key': CONFIG.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_tokens: LLM_MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }]
    }),
    signal: controller.signal
  }).then(function (resp) {
    clearTimeout(timer);
    if (!resp.ok) {
      // Разбор HTTP-статусов по таблице 4.1.
      var status = resp.status;
      return resp.text().then(function (body) {
        if (status === 401 || status === 403) {
          logDev('LLM 401', body);
          throw new LlmError('auth', body);
        }
        if (status === 429 || status === 529) {
          logDev('LLM 429/529', body);
          throw new LlmError('overload', body);
        }
        if (status >= 500) {
          logDev('LLM 5xx', body);
          throw new LlmError('server', body);
        }
        logDev('LLM http ' + status, body);
        throw new LlmError('server', body);
      });
    }
    return resp.json().then(function (data) {
      // Извлекаем текст из content[].text.
      var text = '';
      if (data && Array.isArray(data.content)) {
        data.content.forEach(function (part) {
          if (part && part.type === 'text' && typeof part.text === 'string') text += part.text;
        });
      }
      text = text.trim();
      if (!text) {
        logDev('LLM bad response', JSON.stringify(data));
        throw new LlmError('bad', data);
      }
      return text;
    });
  }).catch(function (err) {
    clearTimeout(timer);
    if (err instanceof LlmError) throw err;
    if (timedOut || (err && err.name === 'AbortError')) {
      logDev('LLM timeout', err);
      throw new LlmError('timeout', err);
    }
    // Сетевой сбой (fetch failed / нет интернета / CORS).
    logDev('LLM network', err);
    throw new LlmError('network', err);
  });
}

// llmErrorMessage(kind) — русский текст для пользователя по таблице 4.1.
function llmErrorMessage(kind) {
  switch (kind) {
    case 'network':  return 'Нет связи с интернетом. Проверьте подключение и нажмите «Повторить».';
    case 'auth':     return 'Проблема с доступом к сервису отчётов. Сообщите Александру.';
    case 'overload': return 'Сервис перегружен. Попробуйте через минуту.';
    case 'server':   return 'Сервис отчётов временно недоступен. Попробуйте позже.';
    case 'timeout':  return 'Отчёт формируется слишком долго. Попробуйте ещё раз.';
    case 'bad':      return 'Не удалось получить текст отчёта.';
    default:         return 'Не удалось сформировать отчёт.';
  }
}

// ============================================================================
// TELEGRAM — отправка двух сообщений, отслеживание статуса, обработка ошибок.
// ============================================================================
// TgError — свой тип: kind ∈ 'config' (неверный chat_id/токен) | 'network' (сбой).
function TgError(kind, detail) { this.name = 'TgError'; this.kind = kind; this.detail = detail; }

// sendTgMessage(text) — один sendMessage. Резолвится при ok:true,
// иначе бросает TgError. Отдельно ловим неверный chat_id/токен → kind='config'.
function sendTgMessage(text) {
  var url = 'https://api.telegram.org/bot' + CONFIG.TG_BOT_TOKEN + '/sendMessage';
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CONFIG.MAKSIM_CHAT_ID, text: text })
  }).then(function (resp) {
    return resp.json().then(function (data) {
      if (resp.ok && data && data.ok) return true;
      // Telegram отдаёт описание в data.description. 400/401/404 при неверных
      // токене/chat_id — это ошибка настроек (повтор не поможет).
      var code = resp.status;
      logDev('TG send', JSON.stringify({ code: code, body: data }));
      if (code === 400 || code === 401 || code === 404) {
        throw new TgError('config', data);
      }
      throw new TgError('network', data);
    });
  }).catch(function (err) {
    if (err instanceof TgError) throw err;
    logDev('TG network', err);
    throw new TgError('network', err);
  });
}

// deliverToTelegram() — шлёт алерт, затем полный отчёт. Отслеживает, что ушло.
// Повтор шлёт только то, что ещё НЕ доставлено (lastTgStatus). НЕ пересоздаёт отчёт.
function deliverToTelegram() {
  if (!tgReady()) {
    renderTgControls('Не удаётся отправить Максиму. Проверьте настройки (Александр).', true);
    return;
  }

  renderTgControls('Отправляю в Telegram…', null, true /* busy */);

  var chain = Promise.resolve();

  // Сообщение 1 — алерт (если ещё не ушло).
  if (!lastTgStatus.alert) {
    chain = chain.then(function () {
      return sendTgMessage(lastAlertText).then(function () { lastTgStatus.alert = true; });
    });
  }
  // Сообщение 2 — полный отчёт (если ещё не ушло).
  chain = chain.then(function () {
    if (lastTgStatus.full) return;
    return sendTgMessage(lastReportText).then(function () { lastTgStatus.full = true; });
  });

  chain.then(function () {
    renderTgControls(null); // всё доставлено
  }).catch(function (err) {
    if (err instanceof TgError && err.kind === 'config') {
      // Неверный chat_id/токен — повтор неактивен (таблица 4.2).
      renderTgControls('Не удаётся отправить Максиму. Проверьте настройки (Александр).', true);
      return;
    }
    // Сеть/HTTP: различаем «ничего не ушло» и «ушло частично».
    if (lastTgStatus.alert && !lastTgStatus.full) {
      renderTgControls('Отправлено частично. Повторить отправку полного отчёта?', false);
    } else {
      renderTgControls('Отчёт готов, но не отправился в Telegram. Нажмите «Повторить отправку».', false);
    }
  });
}

// renderTgControls(msg, disableRetry, busy) — блок состояния TG под кнопками.
//   msg=null и всё доставлено → «Отправлено Максиму ✓».
//   msg=null и ничего не отправляли → предложить «Отправить в Telegram».
//   msg=строка → показать её; disableRetry=true → кнопка повтора неактивна.
//   busy=true → показать «идёт отправка», без кнопки.
function renderTgControls(msg, disableRetry, busy) {
  var m = ensureModal();
  var wrap = m.footer.querySelector('.ai-tg');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'ai-tg';
    m.footer.appendChild(wrap);
  }
  wrap.innerHTML = '';

  var bothSent = lastTgStatus.alert && lastTgStatus.full;

  if (busy) {
    wrap.innerHTML = '<span class="ai-tg-status">' + escHtml(msg || 'Отправляю…') + '</span>';
    return;
  }

  if (!msg && bothSent) {
    wrap.innerHTML = '<span class="ai-tg-status ai-tg-ok">✓ Отправлено Максиму в Telegram</span>';
    return;
  }

  if (!msg && !bothSent) {
    // Ещё не отправляли — предложить отправку.
    var sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'btn btn-sm btn-primary';
    sendBtn.textContent = 'Отправить в Telegram';
    sendBtn.addEventListener('click', deliverToTelegram);
    wrap.appendChild(sendBtn);
    return;
  }

  // Есть сообщение (ошибка/частично).
  var status = document.createElement('span');
  status.className = 'ai-tg-status ai-tg-warn';
  status.textContent = msg;
  wrap.appendChild(status);

  if (!disableRetry) {
    var retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn-sm btn-primary';
    retry.textContent = 'Повторить отправку';
    retry.addEventListener('click', deliverToTelegram);
    wrap.appendChild(retry);
  }
}

// ============================================================================
// СОХРАНЕНИЕ / ВОССТАНОВЛЕНИЕ последнего отчёта (P1).
// ============================================================================
function saveLastReport(text, alertText) {
  try {
    localStorage.setItem(LAST_REPORT_KEY, JSON.stringify({
      text: text, alert: alertText, at: new Date().toISOString()
    }));
  } catch (e) { logDev('saveLastReport', e); }
}
function loadLastReport() {
  try {
    var raw = localStorage.getItem(LAST_REPORT_KEY);
    if (!raw) return null;
    var obj = JSON.parse(raw);
    return (obj && typeof obj.text === 'string') ? obj : null;
  } catch (e) { logDev('loadLastReport', e); return null; }
}

// ============================================================================
// ГЛАВНЫЙ ПОТОК: генерация отчёта по клику.
// ============================================================================
// generateReport() — собирает данные, зовёт Claude, показывает результат.
// При любой ошибке AI — резервный отчёт + русское уведомление + «Повторить».
function generateReport() {
  var info = collectOverruns();

  if (!info.hasData) {
    showUserError('Пока нет данных для отчёта. Добавьте помещения и замеры на экранах «Помещения» и «Замер».');
    return;
  }

  // Алерт готовим заранее (нужен и для TG, и для резервного пути).
  lastAlertText = buildAlert(info);
  // Новый отчёт → сбрасываем статус доставки в TG.
  lastTgStatus = { alert: false, full: false };

  // Ключи не настроены — не делаем «мёртвый» вызов: сразу резервный отчёт.
  if (!llmKeyReady()) {
    logDev('config', 'ANTHROPIC_API_KEY не настроен (плейсхолдер).');
    var fb = buildFallbackReport(info);
    finishReport(fb, {
      fallback: true,
      notice: 'Не настроены ключи. Сообщите Александру.',
      retry: { label: 'Повторить', onClick: generateReport }
    });
    return;
  }

  showSpinner('Формирую отчёт…');

  callClaude(buildPrompt(info)).then(function (text) {
    finishReport(text, { retry: null });
  }).catch(function (err) {
    var kind = (err && err.kind) ? err.kind : 'unknown';
    var msg = llmErrorMessage(kind);
    var fb = buildFallbackReport(info);
    // 401 → «Повторить» неактивна (таблица 4.1).
    var retryDisabled = (kind === 'auth');
    finishReport(fb, {
      fallback: true,
      notice: msg,
      retry: { label: 'Повторить', disabled: retryDisabled, onClick: generateReport }
    });
  });
}

// finishReport(text, opts) — общий финал: запомнить, показать, сохранить, отправить.
function finishReport(text, opts) {
  lastReportText = text;
  saveLastReport(text, lastAlertText);
  showReport(text, opts);
  // Автоотправка в Telegram, если ключи настроены. Иначе — блок предложит отправку.
  if (tgReady()) {
    deliverToTelegram();
  } else {
    renderTgControls('Telegram не настроен. Отчёт можно скопировать вручную.', true);
  }
}

// openLastReport() — восстановить последний отчёт в модалку (P1).
// Используется, если пользователь открывает модалку повторно без генерации.
function openLastReport() {
  var saved = loadLastReport();
  if (!saved) return false;
  lastReportText = saved.text;
  lastAlertText = saved.alert || '';
  lastTgStatus = { alert: false, full: false };
  showReport(saved.text, {
    notice: 'Показан последний сформированный отчёт. Нажмите «Повторить», чтобы сформировать заново.',
    retry: { label: 'Сформировать заново', onClick: generateReport }
  });
  return true;
}

// ============================================================================
// ПРИВЯЗКА КНОПКИ «Сформировать отчёт» (#btn-report).
// Кнопка перерисовывается внутри #compare-root, поэтому вешаем делегированно
// на постоянный контейнер (или document как фолбэк).
// ============================================================================
function bindReportButton() {
  var root = document.getElementById('compare-root') || document;
  if (root._aiReportBound) return;
  root._aiReportBound = true;
  root.addEventListener('click', function (ev) {
    var btn = ev.target.closest && ev.target.closest('#btn-report, [data-role="report"]');
    if (!btn) return;
    ev.preventDefault();
    generateReport();
  });
}

if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('DOMContentLoaded', bindReportButton);
}
