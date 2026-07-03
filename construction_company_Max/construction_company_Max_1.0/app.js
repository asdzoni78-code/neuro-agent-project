// app.js — state, localStorage, расчёты, рендер.
// Ф1 (ядро данных): state, load(), save(), uuid(), renderAll(), справочник материалов.
// Расчёты (calcFloor и т.д.) — Ф2. Формы и CRUD экранов — Ф3+. AI/Telegram — Ф5.

'use strict';

// Ключ хранилища (см. SPEC.md «Данные»).
const STORAGE_KEY = 'zamery_v1';

// Справочник материалов по SPEC.md (нормы приблизительные, редактируемые).
// Вынесен в функцию, чтобы каждый дефолтный state получал свежую копию
// (объекты не разделяются между разными state по ссылке).
function defaultMaterials() {
  return [
    { id: 'plaster_g', name: 'Штукатурка гипс.', norm: 8.5,  price: 15000, budget: 0 },
    { id: 'plaster_c', name: 'Штукатурка ЦПС',   norm: 18.0, price: 8000,  budget: 0 },
    { id: 'screed_c',  name: 'Стяжка ЦПС',        norm: 20.0, price: 6000,  budget: 0 },
    { id: 'spackle',   name: 'Шпаклёвка',          norm: 10.0, price: 20000, budget: 0 }
  ];
}

// Настройки объекта. overrunThresholdPct — порог значимости отклонения в %:
// перерасход ≥ порога → тревога (красный, TG-алерт); недорасход ≥ порога →
// «проверить» (жёлтый). Меньше порога в любую сторону → норма. По умолчанию 5%.
function defaultSettings() {
  return { overrunThresholdPct: 5 };
}

// Дефолтный state — используется при первом запуске или битом localStorage.
function defaultState() {
  return {
    project: { name: 'Объект', floors: [] },
    materials: defaultMaterials(),
    settings: defaultSettings()
  };
}

// Глобальное состояние приложения. Наполняется в load().
let state = defaultState();

// uuid() — уникальный id для этажей/комнат/откосов/колонн.
// crypto.randomUUID недоступен в старых браузерах и при file:// в ряде движков —
// поэтому есть ручной фолбэк (RFC4122 v4-подобный).
function uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// load() — читает localStorage, парсит JSON.
// Если пусто или битый JSON — создаёт дефолтный state. Присваивает в глобальный state.
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      state = defaultState();
      save(); // зафиксировать дефолт при первом запуске
      return state;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Некорректная структура state');
    }
    // Мягкая нормализация: гарантируем наличие обязательных секций,
    // чтобы renderAll() и будущие фазы не падали на неполных данных.
    state = {
      project: (parsed.project && typeof parsed.project === 'object')
        ? {
            name: typeof parsed.project.name === 'string' ? parsed.project.name : 'Объект',
            floors: Array.isArray(parsed.project.floors) ? parsed.project.floors : []
          }
        : defaultState().project,
      materials: Array.isArray(parsed.materials) && parsed.materials.length
        ? parsed.materials
        : defaultMaterials(),
      // Мягкая миграция: у старых данных секции settings нет → подставляем дефолт.
      settings: (parsed.settings && typeof parsed.settings === 'object'
                 && Number.isFinite(Number(parsed.settings.overrunThresholdPct)))
        ? { overrunThresholdPct: Math.max(0, Number(parsed.settings.overrunThresholdPct)) }
        : defaultSettings()
    };
    return state;
  } catch (err) {
    console.error('[load] Не удалось прочитать localStorage, использую дефолт:', err);
    state = defaultState();
    return state;
  }
}

// save() — сериализует state в JSON и пишет в localStorage.
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.error('[save] Не удалось записать localStorage:', err);
  }
}

// renderAll() — единая точка перерисовки.
// В Ф1 минимальна: вызывает render-функции экранов, если они уже определены
// (появятся в Ф3+). Обёрнуто в проверки, чтобы вызов не падал при пустом state.
function renderAll() {
  if (typeof renderRooms === 'function')      renderRooms();      // Экран 1 — Ф3
  if (typeof renderMeasure === 'function')    renderMeasure();    // Экран 2 — Ф3
  if (typeof renderComparison === 'function') renderComparison(); // Экран 3 — Ф4
}

// ============================================================================
// Ф2. ДВИЖОК РАСЧЁТОВ
// ----------------------------------------------------------------------------
// Шесть чистых функций по формулам SPEC.md «Ключевые формулы».
// Правила:
//  • Все линейные размеры на входе — в миллиметрах.
//  • Функции чистые: принимают данные, возвращают числа/объекты.
//    Никаких побочных эффектов, никакого чтения DOM.
//  • Округление — забота слоя отображения (Ф4). Здесь возвращаем полные числа.
//  • Защита от NaN: отсутствующие/пустые поля трактуем как 0, а не как undefined.
//
// Структура комнаты (см. SPEC.md «Структура замера»): комната хранит две стадии
//   room = { id, name, stage1: <замер>, stage2: <замер> }
// где каждый замер = { height, length, width, workOrder, responsible,
//                      floor, ceiling, walls:{A,B,V,G}, slopes:[], columns:[] }.
// ============================================================================

// num(v) — безопасное приведение к конечному числу (иначе 0).
// Гасит undefined/null/''/NaN/Infinity, чтобы дальше не тянулся NaN.
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// round(v, digits) — хелпер округления ТОЛЬКО для отображения.
// В промежуточных вычислениях НЕ используется (не теряем точность).
function round(v, digits) {
  const d = num(digits);
  const f = Math.pow(10, d);
  return Math.round(num(v) * f) / f;
}

// thresholdPct() — текущий порог значимости отклонения, %. Читается из настроек,
// с откатом на 5% при отсутствии/битом значении. 0 — валиден (любое отклонение значимо).
function thresholdPct() {
  const s = (state && state.settings) ? state.settings : null;
  const v = s ? Number(s.overrunThresholdPct) : NaN;
  return (Number.isFinite(v) && v >= 0) ? v : 5;
}

// deviationFlags(plan_t, fact_t, delta_t) — зоны отклонения по порогу (двусторонние):
//   overrun    — есть перерасход (факт>план), любой величины;
//   alert      — значимый перерасход (|%| ≥ порог) → красный + TG-алерт;
//   undershoot — значимый недорасход (факт≪план, |%| ≥ порог) → жёлтый «проверить».
// Край: план=0, факт>0 → |%|=∞ ≥ порог → alert. Экономия/перерасход < порога → норма.
function deviationFlags(plan_t, fact_t, delta_t) {
  const thr = thresholdPct();
  const absPct = (plan_t !== 0) ? Math.abs(delta_t / plan_t) * 100 : (fact_t > 0 ? Infinity : 0);
  const isOver = delta_t < 0;
  const isUnder = delta_t > 0;
  return {
    overrun: isOver,
    alert: isOver && absPct >= thr,
    undershoot: isUnder && absPct >= thr
  };
}

// materialById(id) — норма/цена/смета из справочника state.materials.
// Если материал не найден — безопасная «пустышка» с нулями.
function materialById(id) {
  const list = (state && Array.isArray(state.materials)) ? state.materials : [];
  const m = list.find(function (x) { return x && x.id === id; });
  return m || { id: id || null, name: '', norm: 0, price: 0, budget: 0 };
}

// consumption(area_m2, thickness_mm, norm) — общая формула расхода из SPEC:
//   расход_т = площадь_м² × (толщина_мм / 10) × норма / 1000
// (толщина_мм/10 = толщина в см).
function consumption(area_m2, thickness_mm, norm) {
  return num(area_m2) * (num(thickness_mm) / 10) * num(norm) / 1000;
}

// stageOf(room, stage) — достаёт нужную стадию замера из комнаты.
// stage: 1 → room.stage1, 2 → room.stage2. Если стадии нет — {} (всё занулится).
function stageOf(room, stage) {
  if (!room || typeof room !== 'object') return {};
  const s = stage === 2 ? room.stage2 : room.stage1;
  return (s && typeof s === 'object') ? s : {};
}

// ----------------------------------------------------------------------------
// 1) calcFloor(room) — ПОЛ
//   area_m2         = (length × width) / 1e6      (площадь берём по стадии 1)
//   thickness_s1_cm = thicknessPlan_mm / 10       (план)
//   thickness_s2_cm = (height_s1 − height_s2) / 10 (факт = дельта высот в см)
//   consumption_t   = area × толщина_см × норма / 1000
// Возвращает план и факт: площадь, толщину (мм и см), расход, материал.
// ----------------------------------------------------------------------------
function calcFloor(room) {
  const s1 = stageOf(room, 1);
  const s2 = stageOf(room, 2);
  const floor = (s1.floor && typeof s1.floor === 'object') ? s1.floor : {};
  const mat = materialById(floor.materialId);

  // Площадь пола не меняется между стадиями → считаем по ст.1.
  const area_m2 = (num(s1.length) * num(s1.width)) / 1000000;

  // План: толщина задана прорабом (в мм).
  const thicknessPlan_mm = num(floor.thicknessPlan);
  // Факт: разница высот потолка ДО/ПОСЛЕ заливки, в мм.
  //  height_s1 − height_s2 > 0 → пол «поднялся» на эту величину.
  const thicknessFact_mm = num(s1.height) - num(s2.height);

  return {
    surface: 'floor',
    materialId: floor.materialId || null,
    materialName: mat.name,
    area_m2: area_m2,
    plan: {
      thickness_mm: thicknessPlan_mm,
      thickness_cm: thicknessPlan_mm / 10,
      consumption_t: consumption(area_m2, thicknessPlan_mm, mat.norm)
    },
    fact: {
      thickness_mm: thicknessFact_mm,
      thickness_cm: thicknessFact_mm / 10,
      consumption_t: consumption(area_m2, thicknessFact_mm, mat.norm)
    }
  };
}

// ----------------------------------------------------------------------------
// 2) calcWall(room, wallKey) — СТЕНА (wallKey ∈ {A,B,V,G})
//   Высота стены для площади:
//     ст.1 (план): height_s1 всегда.
//     ст.2 (факт): screed_first → height_s2; plaster_first/unknown → height_s1.
//   Ширина стены: A,V → length; B,G → width (по текущей стадии).
//   gross    = (wall_height × wall_width) / 1e6
//   openings = Σ(w×h) / 1e6
//   net_area = gross − openings
//   Толщина ст.2: AV = (length_s1 − length_s2)/2; BG = (width_s1 − width_s2)/2.
//   consumption_t = net_area × (толщина_мм/10) × норма / 1000
// ----------------------------------------------------------------------------
function calcWall(room, wallKey) {
  const s1 = stageOf(room, 1);
  const s2 = stageOf(room, 2);
  const isAV = wallKey === 'A' || wallKey === 'V';

  // Описание стены (материал, план.толщина, проёмы) берём из стадии 1.
  const walls1 = (s1.walls && typeof s1.walls === 'object') ? s1.walls : {};
  const wall = (walls1[wallKey] && typeof walls1[wallKey] === 'object') ? walls1[wallKey] : {};
  const mat = materialById(wall.materialId);

  // Проёмы: сумма площадей в м². Защищаемся от отсутствия массива.
  function openingsArea(stageWalls) {
    const w = (stageWalls && stageWalls[wallKey] && Array.isArray(stageWalls[wallKey].openings))
      ? stageWalls[wallKey].openings : [];
    let sum = 0;
    for (let i = 0; i < w.length; i++) {
      sum += num(w[i].w) * num(w[i].h);
    }
    return sum / 1000000;
  }

  // -------- ПЛАН (стадия 1) --------
  const planHeight = num(s1.height);                       // высота всегда ст.1
  const planWidth = isAV ? num(s1.length) : num(s1.width); // ширина стены по ст.1
  const planGross = (planHeight * planWidth) / 1000000;
  const planOpen = openingsArea(walls1);
  const planNet = planGross - planOpen;
  const planThickness_mm = num(wall.thicknessPlan);

  // -------- ФАКТ (стадия 2) --------
  // Высота зависит от порядка работ.
  const workOrder = s2.workOrder || s1.workOrder || 'unknown';
  const factHeight = (workOrder === 'screed_first') ? num(s2.height) : num(s1.height);
  const factWidth = isAV ? num(s2.length) : num(s2.width);
  const factGross = (factHeight * factWidth) / 1000000;
  const walls2 = (s2.walls && typeof s2.walls === 'object') ? s2.walls : walls1;
  const factOpen = openingsArea(walls2);
  const factNet = factGross - factOpen;
  // Толщина факта = половина разницы противоположных стен (наносится с двух сторон).
  const factThickness_mm = isAV
    ? (num(s1.length) - num(s2.length)) / 2
    : (num(s1.width) - num(s2.width)) / 2;

  return {
    surface: 'wall',
    wallKey: wallKey,
    materialId: wall.materialId || null,
    materialName: mat.name,
    plan: {
      wall_height_mm: planHeight,
      wall_width_mm: planWidth,
      gross_m2: planGross,
      openings_m2: planOpen,
      net_area_m2: planNet,
      thickness_mm: planThickness_mm,
      consumption_t: consumption(planNet, planThickness_mm, mat.norm)
    },
    fact: {
      wall_height_mm: factHeight,
      wall_width_mm: factWidth,
      gross_m2: factGross,
      openings_m2: factOpen,
      net_area_m2: factNet,
      thickness_mm: factThickness_mm,
      consumption_t: consumption(factNet, factThickness_mm, mat.norm)
    }
  };
}

// ----------------------------------------------------------------------------
// 3) calcSlope(slope) — ОТКОС (двухстадийный)
//   area_m2 = (perimeter × width) / 1e6         (width — глубина плоскости откоса)
//   План.толщина  — thicknessPlan (задаётся на ст.1; откат на старое thickness).
//   Факт.толщина  — из того, насколько уменьшился ПРОЁМ окна/двери после
//     штукатурки откосов (замер проёма на ст.1 и ст.2):
//       боковые откосы «съедают» ширину с двух сторон → t = (openW1 − openW2)/2
//       верхний откос  «съедает» высоту сверху        → t = (openH1 − openH2)
//     Берём среднее доступных оценок; если проём не замерян — факт = план.
//   consumption_t = area × (толщина_мм/10) × норма / 1000
// ----------------------------------------------------------------------------
function calcSlope(slope) {
  const s = (slope && typeof slope === 'object') ? slope : {};
  const mat = materialById(s.materialId);
  const area_m2 = (num(s.perimeter) * num(s.width)) / 1000000;

  // План: новое поле thicknessPlan, с откатом на старое единое thickness.
  const planThickness = num(
    (s.thicknessPlan !== undefined && s.thicknessPlan !== '') ? s.thicknessPlan : s.thickness
  );

  // Факт: оценки толщины из разницы размеров проёма между стадиями.
  const ests = [];
  if (num(s.openW1) > 0 && num(s.openW2) > 0) ests.push((num(s.openW1) - num(s.openW2)) / 2);
  if (num(s.openH1) > 0 && num(s.openH2) > 0) ests.push(num(s.openH1) - num(s.openH2));
  const factThickness = ests.length
    ? ests.reduce(function (a, b) { return a + b; }, 0) / ests.length
    : planThickness; // нет замеров проёма — считаем факт равным плану

  return {
    surface: 'slope',
    id: s.id || null,
    materialId: s.materialId || null,
    materialName: mat.name,
    area_m2: area_m2,
    thickness_mm: planThickness, // обратная совместимость (использовалось где-то)
    plan: { thickness_mm: planThickness, consumption_t: consumption(area_m2, planThickness, mat.norm) },
    fact: { thickness_mm: factThickness, consumption_t: consumption(area_m2, factThickness, mat.norm) }
  };
}

// ----------------------------------------------------------------------------
// 4) calcColumn(column) — КОЛОННА
//   area_m2 = (perimeter × height) / 1e6
//   consumption_t = area × (толщина_мм/10) × норма / 1000
// Как и откос — одна толщина на план и факт.
// ----------------------------------------------------------------------------
function calcColumn(column) {
  const c = (column && typeof column === 'object') ? column : {};
  const mat = materialById(c.materialId);
  const area_m2 = (num(c.perimeter) * num(c.height)) / 1000000;
  const cons = consumption(area_m2, num(c.thickness), mat.norm);
  return {
    surface: 'column',
    id: c.id || null,
    materialId: c.materialId || null,
    materialName: mat.name,
    area_m2: area_m2,
    thickness_mm: num(c.thickness),
    plan: { consumption_t: cons },
    fact: { consumption_t: cons }
  };
}

// ----------------------------------------------------------------------------
// 5) calcRoom(room) — АГРЕГАЦИЯ ПО КОМНАТЕ
// Считает все поверхности (пол, 4 стены, откосы, колонны) и группирует расход
// ПО materialId. Суммы РАЗНЫХ материалов не смешиваются.
// Возвращает:
//   {
//     id, name, responsible,
//     surfaces: [ ...результаты calcFloor/calcWall/calcSlope/calcColumn ],
//     byMaterial: { <materialId>: { materialId, materialName, norm, price,
//                                   plan_t, fact_t } }
//   }
// ----------------------------------------------------------------------------
function calcRoom(room) {
  const r = (room && typeof room === 'object') ? room : {};
  const s1 = stageOf(r, 1);
  const surfaces = [];

  // Пол — только если задан материал (иначе поверхности нет).
  const floor = (s1.floor && typeof s1.floor === 'object') ? s1.floor : null;
  if (floor && floor.materialId) {
    surfaces.push(calcFloor(r));
  }

  // Четыре стены — считаем те, у которых задан материал.
  const walls1 = (s1.walls && typeof s1.walls === 'object') ? s1.walls : {};
  ['A', 'B', 'V', 'G'].forEach(function (key) {
    if (walls1[key] && walls1[key].materialId) {
      surfaces.push(calcWall(r, key));
    }
  });

  // Откосы и колонны.
  (Array.isArray(s1.slopes) ? s1.slopes : []).forEach(function (sl) {
    if (sl && sl.materialId) surfaces.push(calcSlope(sl));
  });
  (Array.isArray(s1.columns) ? s1.columns : []).forEach(function (col) {
    if (col && col.materialId) surfaces.push(calcColumn(col));
  });

  // Группировка по материалу: план и факт суммируются раздельно по каждому id.
  const byMaterial = {};
  surfaces.forEach(function (surf) {
    const id = surf.materialId;
    if (!id) return;
    if (!byMaterial[id]) {
      const mat = materialById(id);
      byMaterial[id] = {
        materialId: id,
        materialName: mat.name,
        norm: num(mat.norm),
        price: num(mat.price),
        plan_t: 0,
        fact_t: 0
      };
    }
    byMaterial[id].plan_t += num(surf.plan && surf.plan.consumption_t);
    byMaterial[id].fact_t += num(surf.fact && surf.fact.consumption_t);
  });

  return {
    id: r.id || null,
    name: r.name || '',
    responsible: s1.responsible || (stageOf(r, 2).responsible) || '',
    surfaces: surfaces,
    byMaterial: byMaterial
  };
}

// ----------------------------------------------------------------------------
// 6) calcProject() — АГРЕГАЦИЯ ПО ОБЪЕКТУ
// Обходит все этажи → комнаты, суммирует расход по каждому материалу.
//   budget (смета) — из справочника материалов (state.materials[].budget).
//   plan_t / fact_t — суммы по всем комнатам объекта.
//   Δт = plan_t − fact_t   → Δ < 0 означает ПЕРЕРАСХОД (факт > плана).
//   Δ₽ = Δт × price.
//   %  = (Δт / plan_t) × 100 (при plan_t=0 → 0, защита от деления на ноль).
// Возвращает структуру для таблицы экрана 3 и AI-отчёта:
//   {
//     projectName,
//     materials: [ { materialId, materialName, budget_t, plan_t, fact_t,
//                    delta_t, delta_rub, percent, price } ],
//     rooms:     [ { floorName, roomId, roomName, responsible,
//                    byMaterial: [ {..., delta_t, delta_rub, percent, overrun} ] } ],
//     totals: { plan_t, fact_t, delta_t, delta_rub }
//   }
// ----------------------------------------------------------------------------
function calcProject() {
  const project = (state && state.project) ? state.project : { name: '', floors: [] };
  const floors = Array.isArray(project.floors) ? project.floors : [];

  // Аккумулятор по материалам на уровне всего объекта.
  const matAgg = {}; // id -> { plan_t, fact_t }
  const rooms = [];

  floors.forEach(function (floor) {
    const floorName = (floor && floor.name) || '';
    const roomList = (floor && Array.isArray(floor.rooms)) ? floor.rooms : [];
    roomList.forEach(function (room) {
      const rc = calcRoom(room);

      // Разложить byMaterial комнаты в строки с дельтами (для разбивки в таблице).
      const roomMaterials = [];
      Object.keys(rc.byMaterial).forEach(function (id) {
        const bm = rc.byMaterial[id];
        const delta_t = bm.plan_t - bm.fact_t; // Δ<0 → перерасход
        const rf = deviationFlags(bm.plan_t, bm.fact_t, delta_t);
        roomMaterials.push({
          materialId: bm.materialId,
          materialName: bm.materialName,
          plan_t: bm.plan_t,
          fact_t: bm.fact_t,
          delta_t: delta_t,
          delta_rub: delta_t * bm.price,
          percent: bm.plan_t !== 0 ? (delta_t / bm.plan_t) * 100 : 0,
          overrun: rf.overrun,
          alert: rf.alert,
          undershoot: rf.undershoot
        });

        // Копим в объектный агрегат.
        if (!matAgg[id]) matAgg[id] = { plan_t: 0, fact_t: 0, responsibles: {} };
        matAgg[id].plan_t += bm.plan_t;
        matAgg[id].fact_t += bm.fact_t;
        // Собираем множество ответственных, которые работали с этим материалом,
        // чтобы показать их в таблице сравнения на уровне объекта.
        if (rc.responsible) matAgg[id].responsibles[rc.responsible] = true;
      });

      rooms.push({
        floorName: floorName,
        roomId: rc.id,
        roomName: rc.name,
        responsible: rc.responsible,
        byMaterial: roomMaterials
      });
    });
  });

  // Итог по объекту в разрезе материалов + смета/цена из справочника.
  const materials = [];
  const totals = { plan_t: 0, fact_t: 0, delta_t: 0, delta_rub: 0 };

  Object.keys(matAgg).forEach(function (id) {
    const agg = matAgg[id];
    const mat = materialById(id);
    const plan_t = agg.plan_t;
    const fact_t = agg.fact_t;
    const delta_t = plan_t - fact_t;              // Δ<0 → перерасход
    const delta_rub = delta_t * num(mat.price);
    const mf = deviationFlags(plan_t, fact_t, delta_t);
    materials.push({
      materialId: id,
      materialName: mat.name,
      budget_t: num(mat.budget),                  // смета из справочника
      plan_t: plan_t,
      fact_t: fact_t,
      delta_t: delta_t,
      delta_rub: delta_rub,
      percent: plan_t !== 0 ? (delta_t / plan_t) * 100 : 0,
      price: num(mat.price),
      overrun: mf.overrun,
      alert: mf.alert,
      undershoot: mf.undershoot,
      responsible: Object.keys(agg.responsibles || {}).join(', ') // кто работал с материалом
    });
    totals.plan_t += plan_t;
    totals.fact_t += fact_t;
    totals.delta_t += delta_t;
    totals.delta_rub += delta_rub;
  });

  // Зоны отклонения для итоговой строки.
  const tf = deviationFlags(totals.plan_t, totals.fact_t, totals.delta_t);
  totals.overrun = tf.overrun;
  totals.alert = tf.alert;
  totals.undershoot = tf.undershoot;

  return {
    projectName: project.name || '',
    materials: materials,
    rooms: rooms,
    totals: totals
  };
}

// ============================================================================
// Ф3. ЭКРАНЫ 1–2 (Помещения + Ввод замера)
// ----------------------------------------------------------------------------
// UI-состояние (НЕ хранится в localStorage — это выбор экрана, а не данные):
//   currentRoomId — какое помещение открыто на экране «Замер».
//   currentStage  — какая стадия сейчас редактируется (1 или 2).
// Данные пишутся напрямую в state.project.*, после чего save() + renderAll().
// Реактивность: любой input/change → onFieldInput() → пишет в state →
//   calcProject() (пересчёт) → save() → renderAll() (обновляет индикаторы и
//   read-only авторасчёты). Кнопки «Сохранить» нет.
// ============================================================================

let currentRoomId = null;   // id выбранного помещения (экран 2)
let currentStage = 1;       // редактируемая стадия: 1 | 2
// Какие «гармошки» стен раскрыты (ключ A/B/V/G → true). Запоминаем, чтобы
// перерисовка формы (после выбора материала/добавления проёма) не схлопывала
// открытую стену — иначе прораб терял место, где работал (пункт 4).
let openWalls = {};

// esc(s) — экранирование для безопасной вставки в innerHTML.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// showScreen(id) — переключение экрана из кода (та же логика, что в Ф0-скрипте,
// но доступно из app.js, чтобы клик по помещению открывал экран «Замер»).
function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(function (s) {
    s.classList.toggle('is-active', s.id === screenId);
  });
  document.querySelectorAll('[data-screen]').forEach(function (btn) {
    btn.classList.toggle('is-active', btn.dataset.screen === screenId);
  });
}

// findRoom(roomId) — вернуть { floor, room, fIndex, rIndex } или null.
function findRoom(roomId) {
  const floors = (state.project && Array.isArray(state.project.floors)) ? state.project.floors : [];
  for (let i = 0; i < floors.length; i++) {
    const rooms = Array.isArray(floors[i].rooms) ? floors[i].rooms : [];
    for (let j = 0; j < rooms.length; j++) {
      if (rooms[j] && rooms[j].id === roomId) {
        return { floor: floors[i], room: rooms[j], fIndex: i, rIndex: j };
      }
    }
  }
  return null;
}

// emptyStage() — пустой замер со всеми полями, которые ожидают calc-функции.
function emptyStage() {
  return {
    height: '', length: '', width: '',
    workOrder: 'unknown',
    responsible: '',
    floor: { materialId: '', thicknessPlan: '' },
    ceiling: null,
    walls: {
      A: { materialId: '', thicknessPlan: '', openings: [] },
      B: { materialId: '', thicknessPlan: '', openings: [] },
      V: { materialId: '', thicknessPlan: '', openings: [] },
      G: { materialId: '', thicknessPlan: '', openings: [] }
    },
    slopes: [],
    columns: []
  };
}

// newRoom() — новое помещение с двумя пустыми стадиями.
// locked=false: стадия 1 редактируется свободно, пока прораб не перейдёт на ст.2
// и не подтвердит, что все размеры внесены (пункт 5).
function newRoom(name) {
  return { id: uuid(), name: name || 'Помещение', locked: false, stage1: emptyStage(), stage2: emptyStage() };
}

// ensureStage(room, n) — гарантировать, что у комнаты есть корректная стадия n
// с полной структурой (на случай данных из старых версий).
function ensureStage(room, n) {
  const key = (n === 2) ? 'stage2' : 'stage1';
  if (!room[key] || typeof room[key] !== 'object') room[key] = emptyStage();
  const s = room[key];
  if (!s.floor || typeof s.floor !== 'object') s.floor = { materialId: '', thicknessPlan: '' };
  if (!s.walls || typeof s.walls !== 'object') s.walls = {};
  ['A', 'B', 'V', 'G'].forEach(function (k) {
    if (!s.walls[k] || typeof s.walls[k] !== 'object') {
      s.walls[k] = { materialId: '', thicknessPlan: '', openings: [] };
    }
    if (!Array.isArray(s.walls[k].openings)) s.walls[k].openings = [];
  });
  if (!Array.isArray(s.slopes)) s.slopes = [];
  if (!Array.isArray(s.columns)) s.columns = [];
  return s;
}

// stageFilled(stage) — «заполнена» ли стадия: есть основные габариты > 0.
function stageFilled(stage) {
  if (!stage || typeof stage !== 'object') return false;
  return num(stage.height) > 0 && num(stage.length) > 0 && num(stage.width) > 0;
}

// Инициализация: при загрузке страницы — load() затем renderAll().
// В браузере всегда есть document; под Node (тесты) — этого блока нет.
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('DOMContentLoaded', function () {
    load();
    renderAll();
  });
}

// ----------------------------------------------------------------------------
// persist() — единый цикл реактивности: пересчёт → сохранение → перерисовка.
// calcProject() вызывается ради проверки целостности данных (и на будущее для
// экрана 3); его результат тут не нужен — важен побочный пересчёт зависимостей.
// ----------------------------------------------------------------------------
function persist() {
  try { calcProject(); } catch (e) { console.error('[persist] calcProject:', e); }
  save();
  renderAll();
}

// ============================================================================
// ЭКРАН 1 — «Помещения» (#rooms-root)
// ============================================================================
function renderRooms() {
  const root = document.getElementById('rooms-root');
  if (!root) return;

  const project = state.project || (state.project = { name: 'Объект', floors: [] });
  if (!Array.isArray(project.floors)) project.floors = [];

  let html = '';

  // Название объекта.
  html += '<div class="field project-name">'
    + '<label class="field-label" for="project-name-input">Объект</label>'
    + '<input id="project-name-input" class="txt" type="text" data-role="project-name" '
    + 'value="' + esc(project.name) + '" placeholder="Название объекта">'
    + '</div>';

  // Аккордеон этажей.
  if (!project.floors.length) {
    html += '<p class="hint">Пока нет этажей. Нажмите «+ Этаж», чтобы начать.</p>';
  }

  project.floors.forEach(function (floor) {
    const rooms = Array.isArray(floor.rooms) ? floor.rooms : [];
    html += '<div class="floor-card" data-floor-id="' + esc(floor.id) + '">';
    html += '<div class="floor-head">'
      + '<input class="txt floor-name" type="text" data-role="floor-name" '
      + 'data-floor-id="' + esc(floor.id) + '" value="' + esc(floor.name) + '" placeholder="Этаж">'
      + '<button class="btn-icon btn-danger" type="button" data-role="del-floor" '
      + 'data-floor-id="' + esc(floor.id) + '" title="Удалить этаж">✕</button>'
      + '</div>';

    html += '<ul class="room-list">';
    if (!rooms.length) {
      html += '<li class="hint hint-sm">Нет помещений на этаже.</li>';
    }
    rooms.forEach(function (room) {
      const s1 = stageFilled(room.stage1) ? '●' : '○';
      const s2 = stageFilled(room.stage2) ? '●' : '○';
      const isSel = room.id === currentRoomId;
      html += '<li class="room-row' + (isSel ? ' is-selected' : '') + '">'
        + '<button class="room-open" type="button" data-role="open-room" data-room-id="' + esc(room.id) + '">'
        + '<span class="room-open-name">' + esc(room.name) + '</span>'
        + '<span class="room-badges">'
        + '<span class="badge">' + s1 + ' ст.1</span>'
        + '<span class="badge">' + s2 + ' ст.2</span>'
        + '</span>'
        + '</button>'
        + '<button class="btn-icon btn-danger" type="button" data-role="del-room" '
        + 'data-room-id="' + esc(room.id) + '" title="Удалить помещение">✕</button>'
        + '</li>';
    });
    html += '</ul>';

    html += '<button class="btn btn-sm" type="button" data-role="add-room" '
      + 'data-floor-id="' + esc(floor.id) + '">+ Помещение</button>';
    html += '</div>'; // floor-card
  });

  html += '<button class="btn btn-primary btn-add-floor" type="button" data-role="add-floor">+ Этаж</button>';

  root.innerHTML = html;
  bindRoomsEvents(root);
}

// bindRoomsEvents — навешивает обработчики на экран 1 (делегирование через root).
function bindRoomsEvents(root) {
  // Название объекта — реактивно на input.
  const pn = root.querySelector('[data-role="project-name"]');
  if (pn) {
    pn.addEventListener('input', function () {
      state.project.name = pn.value;
      save(); // без полной перерисовки, чтобы не терять фокус/каретку
    });
  }

  // Названия этажей.
  root.querySelectorAll('[data-role="floor-name"]').forEach(function (el) {
    el.addEventListener('input', function () {
      const f = state.project.floors.find(function (x) { return x.id === el.dataset.floorId; });
      if (f) { f.name = el.value; save(); }
    });
  });

  // Клики (делегирование). Навешиваем ОДИН раз на постоянный #rooms-root,
  // иначе каждый renderRooms() добавлял бы новый слушатель (утечка/двойной вызов).
  if (root._roomsClickBound) return;
  root._roomsClickBound = true;
  root.addEventListener('click', function (ev) {
    const btn = ev.target.closest('[data-role]');
    if (!btn || !root.contains(btn)) return;
    const role = btn.dataset.role;

    if (role === 'add-floor') {
      const n = state.project.floors.length + 1;
      state.project.floors.push({ id: uuid(), name: 'Этаж ' + n, rooms: [] });
      persist();
    } else if (role === 'del-floor') {
      const f = state.project.floors.find(function (x) { return x.id === btn.dataset.floorId; });
      const nm = f ? f.name : 'этаж';
      if (confirm('Удалить «' + nm + '» со всеми помещениями?')) {
        state.project.floors = state.project.floors.filter(function (x) { return x.id !== btn.dataset.floorId; });
        // Если удалили этаж с открытым помещением — сбросить выбор.
        if (currentRoomId && !findRoom(currentRoomId)) currentRoomId = null;
        persist();
      }
    } else if (role === 'add-room') {
      const f = state.project.floors.find(function (x) { return x.id === btn.dataset.floorId; });
      if (f) {
        if (!Array.isArray(f.rooms)) f.rooms = [];
        f.rooms.push(newRoom('Помещение ' + (f.rooms.length + 1)));
        persist();
      }
    } else if (role === 'del-room') {
      const found = findRoom(btn.dataset.roomId);
      const nm = found ? found.room.name : 'помещение';
      if (confirm('Удалить помещение «' + nm + '»?')) {
        if (found) {
          found.floor.rooms = found.floor.rooms.filter(function (x) { return x.id !== btn.dataset.roomId; });
          if (currentRoomId === btn.dataset.roomId) currentRoomId = null;
          persist();
        }
      }
    } else if (role === 'open-room') {
      currentRoomId = btn.dataset.roomId;
      currentStage = 1;
      openWalls = {}; // новое помещение — все стены свёрнуты
      renderMeasure();
      showScreen('screen-measure');
    }
  });
}

// ============================================================================
// ЭКРАН 2 — «Ввод замера» (#measure-root)
// ----------------------------------------------------------------------------
// Правило редактируемости (соблюдает то, что читают calc-функции):
//  • Описание поверхности (материал пола/стен, план.толщина, проёмы) — берётся
//    из stage1 → редактируется ТОЛЬКО на ст.1, на ст.2 показывается read-only.
//  • Габариты (height/length/width), порядок работ, ответственный — свои у
//    каждой стадии.
//  • Толщина пола/стен на ст.2 — авторасчёт (read-only): пол = Δвысот,
//    пара AV = (len1−len2)/2, BG = (wid1−wid2)/2.
//  • Проёмы ст.2 (для точной площади факта) — редактируются; при их отсутствии
//    calcWall берёт проёмы ст.1.
// ============================================================================

// materialOptions(selected, includeEmpty) — <option>-ы справочника материалов.
function materialOptions(selected) {
  let out = '<option value="">— материал —</option>';
  (state.materials || []).forEach(function (m) {
    out += '<option value="' + esc(m.id) + '"' + (m.id === selected ? ' selected' : '') + '>'
      + esc(m.name) + '</option>';
  });
  return out;
}

// mm(v) — форматирование мм для read-only (1 знак после запятой, без хвостов).
function mm(v) {
  const n = round(v, 1);
  return (Math.round(n * 10) / 10).toString();
}

function renderMeasure() {
  const root = document.getElementById('measure-root');
  if (!root) return;

  // Помещение не выбрано (или было удалено) — показываем подсказку.
  const found = currentRoomId ? findRoom(currentRoomId) : null;
  if (!found) {
    currentRoomId = null;
    root.innerHTML = '<p class="hint">Выберите помещение на экране «Помещения».</p>';
    return;
  }

  const room = found.room;
  ensureStage(room, 1);
  ensureStage(room, 2);
  const s1 = room.stage1;
  const s = (currentStage === 2) ? room.stage2 : room.stage1;
  const isS2 = currentStage === 2;
  const locked = !!room.locked;              // ст.1 заблокирована (пункт 5)
  // Стадия 1 после блокировки — только чтение; на ст.2 select-ы описания тоже
  // read-only (материалы/план.толщина задаются на ст.1).
  const lockS1 = locked && !isS2;
  const dis = (isS2 || lockS1) ? ' disabled' : '';

  let html = '';

  // 1. Заголовок + переключатель стадий.
  html += '<div class="measure-top">';
  html += '<input class="txt room-title" type="text" data-role="room-name" '
    + 'value="' + esc(room.name) + '" placeholder="Название помещения">';
  html += '<div class="stage-switch" role="tablist">'
    + '<button type="button" class="stage-btn' + (!isS2 ? ' is-active' : '') + '" data-role="stage" data-stage="1">Стадия 1</button>'
    + '<button type="button" class="stage-btn' + (isS2 ? ' is-active' : '') + '" data-role="stage" data-stage="2">Стадия 2</button>'
    + '</div>';
  html += '<button type="button" class="btn btn-sm btn-ghost" data-role="back">← К помещениям</button>';
  // Кнопка разблокировки — ВНЕ отключаемого блока, иначе была бы тоже неактивна.
  if (locked) {
    html += '<button type="button" class="btn btn-sm btn-ghost" data-role="unlock" '
      + 'title="Разблокировать редактирование стадии 1">🔓 Разблокировать ст.1</button>';
  }
  html += '</div>';

  if (lockS1) {
    html += '<p class="hint hint-sm">🔒 Стадия 1 заблокирована — размеры зафиксированы. '
      + 'Нажмите «Разблокировать ст.1», чтобы внести правки.</p>';
  } else if (isS2) {
    html += '<p class="hint hint-sm">Стадия 2 (факт): вводите габариты после работ. '
      + 'Материалы и план.толщина заданы на ст.1; толщина здесь считается автоматически.</p>';
  }

  // Оболочка для всех полей замера. Нативный disabled на <fieldset> отключает
  // ВСЕ вложенные поля/кнопки разом — так реализуется блокировка ст.1 (пункт 5).
  html += '<fieldset class="measure-fields"' + (lockS1 ? ' disabled' : '') + '>';

  // 2. Общие размеры.
  html += '<fieldset class="block"><legend>Общие размеры, мм</legend><div class="grid-3">';
  if (isS2) {
    // На ст.2 рядом с размером — значение из ст.1 и цветовой маркер норма/перерасход (пункт 6).
    html += dimFieldS2('Высота', 'height', s.height, room);
    html += dimFieldS2('Длина А→В', 'length', s.length, room);
    html += dimFieldS2('Ширина Б→Г', 'width', s.width, room);
  } else {
    html += dimField('Высота', 'height', s.height);
    html += dimField('Длина А→В', 'length', s.length);
    html += dimField('Ширина Б→Г', 'width', s.width);
  }
  html += '</div></fieldset>';

  // 3. Порядок работ (radio) — влияет на высоту стены в расчёте.
  const wo = s.workOrder || 'unknown';
  html += '<fieldset class="block"><legend>Порядок работ</legend><div class="radio-row">'
    + woRadio('Стяжка раньше', 'screed_first', wo)
    + woRadio('Штукатурка раньше', 'plaster_first', wo)
    + woRadio('Не указано', 'unknown', wo)
    + '</div></fieldset>';

  // 4. Пол.
  const floorDesc = s1.floor || { materialId: '', thicknessPlan: '' };
  html += '<fieldset class="block"><legend>Пол</legend><div class="grid-2">';
  html += '<div class="field"><label class="field-label">Материал</label>'
    + '<select class="sel" data-role="floor-material"' + dis + '>' + materialOptions(floorDesc.materialId) + '</select></div>';
  if (isS2) {
    const fThick = num(s1.height) - num(room.stage2.height); // Δвысот в мм
    html += '<div class="field"><label class="field-label">Толщина (факт), мм</label>'
      + '<input class="txt auto" type="text" data-role="floor-thick-auto" value="' + esc(mm(fThick)) + '" readonly>'
      + '<span class="unit-note">' + esc(mm(fThick / 10)) + ' см · авторасчёт (Δвысот)</span></div>';
  } else {
    html += '<div class="field"><label class="field-label">План.толщина, мм</label>'
      + '<input class="txt" type="text" inputmode="numeric" data-role="floor-thick-plan" value="' + esc(floorDesc.thicknessPlan) + '" placeholder="напр. 60"></div>';
  }
  html += '</div></fieldset>';

  // 5. Потолок — заглушка.
  html += '<fieldset class="block block-muted"><legend>Потолок</legend>'
    + '<p class="hint hint-sm">Не активен в пилоте.</p></fieldset>';

  // 6. Стены А, Б, В, Г.
  html += '<fieldset class="block"><legend>Стены</legend>';
  ['A', 'B', 'V', 'G'].forEach(function (key) {
    html += renderWallBlock(room, key, isS2);
  });
  html += '</fieldset>';

  // 7. Откосы (хранятся в stage1 — их читает calcRoom из ст.1).
  html += renderSlopes(s1, isS2);

  // 8. Колонны (тоже из stage1).
  html += renderColumns(s1, isS2);

  // 9. Ответственный.
  html += '<fieldset class="block"><legend>Ответственный</legend>'
    + '<input class="txt" type="text" data-role="responsible" value="' + esc(s.responsible) + '" placeholder="Фамилия / имя"></fieldset>';

  // 10. Фото — заглушка.
  html += '<fieldset class="block block-muted"><legend>Фото</legend>'
    + '<button class="btn btn-sm" type="button" disabled>📷 Добавить фото</button>'
    + '<span class="unit-note">скоро</span></fieldset>';

  html += '</fieldset>'; // /measure-fields

  root.innerHTML = html;
  bindMeasureEvents(root);
}

// dimField — числовое поле габарита.
function dimField(label, role, value) {
  return '<div class="field"><label class="field-label">' + esc(label) + '</label>'
    + '<input class="txt" type="text" inputmode="numeric" data-role="dim" data-dim="' + role + '" '
    + 'value="' + esc(value) + '" placeholder="мм"></div>';
}

// markerDotClass(state) — класс цветного кружка по состоянию.
//   over → красный, under → жёлтый, norm → зелёный, neutral → серый.
function markerDotClass(state) {
  if (state === 'over') return 'mk-over';
  if (state === 'under') return 'mk-under';
  if (state === 'norm') return 'mk-norm';
  return 'mk-neutral';
}

// thickState(fact, plan) — сравнение фактической толщины с плановой по порогу (±%):
//   plan<=0 → 'neutral'; факт выше плана более чем на порог → 'over' (перерасход);
//   факт ниже плана более чем на порог → 'under' (недовыполнение); иначе 'norm'.
function thickState(fact, plan) {
  const f = mm(fact), p = mm(plan);
  if (num(plan) <= 0) {
    return { state: 'neutral', title: 'План.толщина не задана', note: 'факт ' + f + ' мм' };
  }
  const thr = thresholdPct();
  const hi = num(plan) * (1 + thr / 100);
  const lo = num(plan) * (1 - thr / 100);
  if (num(fact) > hi) {
    return { state: 'over', title: 'Перерасход: факт ' + f + ' > план ' + p + ' мм (порог ' + thr + '%)',
      note: 'перерасход (факт ' + f + ' > план ' + p + ')' };
  }
  if (num(fact) < lo) {
    return { state: 'under', title: 'Недовыполнение: факт ' + f + ' < план ' + p + ' мм (порог ' + thr + '%)',
      note: 'мало нанесли (факт ' + f + ' < план ' + p + ')' };
  }
  return { state: 'norm', title: 'Норма: факт ' + f + ' ≈ план ' + p + ' мм (±' + thr + '%)',
    note: 'норма (факт ' + f + ' ≈ план ' + p + ')' };
}

// dimMarker(dimRole, room) — состояние маркера для габарита на ст.2:
//   height → сравниваем факт.толщину пола (Δвысот) с план.толщиной пола;
//   length → стены А/В: факт = (len1−len2)/2 против мин. план.толщины этих стен;
//   width  → стены Б/Г: факт = (wid1−wid2)/2 против мин. план.толщины этих стен.
// Если материал/план не заданы — 'neutral'.
function dimMarker(dimRole, room) {
  const s1 = room.stage1, s2 = room.stage2;
  if (dimRole === 'height') {
    const floor = (s1.floor && typeof s1.floor === 'object') ? s1.floor : {};
    if (!floor.materialId) return { state: 'neutral', title: 'Пол не задан', note: '' };
    const fact = num(s1.height) - num(s2.height);
    return thickState(fact, num(floor.thicknessPlan));
  }
  const keys = dimRole === 'length' ? ['A', 'V'] : ['B', 'G'];
  const walls = (s1.walls && typeof s1.walls === 'object') ? s1.walls : {};
  const present = keys.filter(function (k) { return walls[k] && walls[k].materialId; });
  if (!present.length) return { state: 'neutral', title: 'Стены не заданы', note: '' };
  const fact = dimRole === 'length'
    ? (num(s1.length) - num(s2.length)) / 2
    : (num(s1.width) - num(s2.width)) / 2;
  let plan = Infinity;
  present.forEach(function (k) { plan = Math.min(plan, num(walls[k].thicknessPlan)); });
  if (!isFinite(plan)) plan = 0;
  return thickState(fact, plan);
}

// dimFieldS2 — поле габарита на ст.2: подпись из ст.1 + цветной маркер (пункт 6).
function dimFieldS2(label, dimRole, value, room) {
  const ref = num(room.stage1[dimRole]);
  const mk = dimMarker(dimRole, room);
  const refText = 'ст.1: ' + (ref ? mm(ref) + ' мм' : '—') + (mk.note ? ' · ' + mk.note : '');
  return '<div class="field"><label class="field-label">' + esc(label)
    + ' <span class="thick-marker ' + markerDotClass(mk.state) + '" data-dim-marker="' + dimRole + '" '
    + 'title="' + esc(mk.title) + '"></span></label>'
    + '<input class="txt" type="text" inputmode="numeric" data-role="dim" data-dim="' + dimRole + '" '
    + 'value="' + esc(value) + '" placeholder="мм">'
    + '<span class="unit-note" data-dim-ref="' + dimRole + '">' + esc(refText) + '</span></div>';
}

// woRadio — один переключатель порядка работ.
function woRadio(label, value, current) {
  return '<label class="radio"><input type="radio" name="workOrder" value="' + value + '"'
    + (value === current ? ' checked' : '') + ' data-role="work-order"> ' + esc(label) + '</label>';
}

// Русские подписи стен для UI (в данных ключи A/B/V/G).
const WALL_LABELS = { A: 'Стена А', B: 'Стена Б', V: 'Стена В', G: 'Стена Г' };

// renderWallBlock — раскрывающийся блок одной стены.
function renderWallBlock(room, key, isS2) {
  const s1 = room.stage1;
  const wallDesc = s1.walls[key] || { materialId: '', thicknessPlan: '', openings: [] };
  // Проёмы: на ст.1 — из ст.1; на ст.2 — свои (если пусто, отображаем ст.1 как основу).
  const stageWall = (isS2 ? room.stage2.walls[key] : wallDesc) || { openings: [] };
  const openings = Array.isArray(stageWall.openings) ? stageWall.openings : [];
  const dis = isS2 ? ' disabled' : '';

  let h = '<details class="wall" data-wall="' + key + '"' + (openWalls[key] ? ' open' : '')
    + '><summary>' + esc(WALL_LABELS[key]) + '</summary>';
  h += '<div class="wall-body">';

  // Материал (описание — ст.1).
  h += '<div class="grid-2"><div class="field"><label class="field-label">Материал</label>'
    + '<select class="sel" data-role="wall-material" data-wall="' + key + '"' + dis + '>'
    + materialOptions(wallDesc.materialId) + '</select></div>';

  // Толщина.
  if (isS2) {
    const isAV = (key === 'A' || key === 'V');
    const t = isAV
      ? (num(s1.length) - num(room.stage2.length)) / 2
      : (num(s1.width) - num(room.stage2.width)) / 2;
    const src = isAV ? '(Δдлины÷2)' : '(Δширины÷2)';
    h += '<div class="field"><label class="field-label">Толщина (факт), мм</label>'
      + '<input class="txt auto" type="text" value="' + esc(mm(t)) + '" readonly>'
      + '<span class="unit-note">авторасчёт ' + src + '</span></div>';
  } else {
    h += '<div class="field"><label class="field-label">План.толщина, мм</label>'
      + '<input class="txt" type="text" inputmode="numeric" data-role="wall-thick-plan" data-wall="' + key + '" '
      + 'value="' + esc(wallDesc.thicknessPlan) + '" placeholder="напр. 20"></div>';
  }
  h += '</div>';

  // Проёмы.
  h += '<div class="openings"><div class="openings-head">Проёмы</div>';
  if (!openings.length) h += '<p class="hint hint-sm">Нет проёмов.</p>';
  openings.forEach(function (op, idx) {
    h += '<div class="opening-row" data-wall="' + key + '" data-idx="' + idx + '">'
      + '<select class="sel sel-sm" data-role="op-type" data-wall="' + key + '" data-idx="' + idx + '">'
      + '<option value="window"' + (op.type === 'window' ? ' selected' : '') + '>Окно</option>'
      + '<option value="door"' + (op.type === 'door' ? ' selected' : '') + '>Дверь</option>'
      + '<option value="other"' + (op.type === 'other' ? ' selected' : '') + '>Другое</option>'
      + '</select>'
      + '<input class="txt txt-sm" type="text" inputmode="numeric" data-role="op-w" data-wall="' + key + '" data-idx="' + idx + '" value="' + esc(op.w) + '" placeholder="ширина">'
      + '<input class="txt txt-sm" type="text" inputmode="numeric" data-role="op-h" data-wall="' + key + '" data-idx="' + idx + '" value="' + esc(op.h) + '" placeholder="высота">'
      + '<button class="btn-icon btn-danger" type="button" data-role="del-opening" data-wall="' + key + '" data-idx="' + idx + '" title="Удалить проём">✕</button>'
      + '</div>';
  });
  h += '<button class="btn btn-sm" type="button" data-role="add-opening" data-wall="' + key + '">+ Проём</button>';
  h += '</div>'; // openings

  h += '</div></details>';
  return h;
}

// slField — компактное числовое поле откоса (readonly → серое, не редактируется).
function slField(label, role, id, value, readOnly) {
  return '<div class="field"><label class="field-label">' + esc(label) + '</label>'
    + '<input class="txt txt-sm" type="text" inputmode="numeric" data-role="' + role + '" data-id="' + esc(id) + '" '
    + 'value="' + esc(value) + '" placeholder="мм"' + (readOnly ? ' readonly' : '') + '></div>';
}

// renderSlopeItem(sl, isS2) — карточка одного откоса.
//   ст.1: периметр, глубина, материал, план.толщина, проём (ширина/высота) ДО работ.
//   ст.2: описание read-only + проём ПОСЛЕ работ (редактируется) + авторасчёт
//         фактической толщины из разницы проёма и цветной маркер (пункты 3, 6).
function renderSlopeItem(sl, isS2) {
  const id = sl.id;
  const mat = materialById(sl.materialId);
  // План.толщина: новое поле thicknessPlan с откатом на старое thickness.
  const planThick = (sl.thicknessPlan !== undefined && sl.thicknessPlan !== '') ? sl.thicknessPlan : sl.thickness;

  let h = '<div class="slope-card" data-slope-id="' + esc(id) + '">';
  h += '<div class="slope-head"><span class="slope-title">Откос</span>';
  if (!isS2) {
    h += '<button class="btn-icon btn-danger" type="button" data-role="del-slope" data-id="' + esc(id) + '" title="Удалить откос">✕</button>';
  }
  h += '</div><div class="slope-grid">';

  if (!isS2) {
    h += slField('Периметр, мм', 'slope-perimeter', id, sl.perimeter, false);
    h += slField('Глубина откоса, мм', 'slope-width', id, sl.width, false);
    h += '<div class="field"><label class="field-label">Материал</label>'
      + '<select class="sel sel-sm" data-role="slope-material" data-id="' + esc(id) + '">' + materialOptions(sl.materialId) + '</select></div>';
    h += slField('План.толщина, мм', 'slope-thick', id, planThick, false);
    h += slField('Проём: ширина ст.1, мм', 'slope-ow1', id, sl.openW1, false);
    h += slField('Проём: высота ст.1, мм', 'slope-oh1', id, sl.openH1, false);
  } else {
    const calc = calcSlope(sl);
    const mk = thickState(calc.fact.thickness_mm, calc.plan.thickness_mm);
    h += '<div class="field"><label class="field-label">Материал</label>'
      + '<input class="txt txt-sm" type="text" value="' + esc(mat.name || '—') + '" readonly></div>';
    h += slField('План.толщина, мм', 'slope-thick', id, mm(calc.plan.thickness_mm), true);
    h += slField('Проём: ширина ст.1, мм', 'slope-ow1', id, sl.openW1, true);
    h += slField('Проём: высота ст.1, мм', 'slope-oh1', id, sl.openH1, true);
    h += slField('Проём: ширина ст.2, мм', 'slope-ow2', id, sl.openW2, false);
    h += slField('Проём: высота ст.2, мм', 'slope-oh2', id, sl.openH2, false);
    h += '<div class="field"><label class="field-label">Толщина (факт), мм '
      + '<span class="thick-marker ' + markerDotClass(mk.state) + '" data-slope-marker="' + esc(id) + '" title="' + esc(mk.title) + '"></span></label>'
      + '<input class="txt auto" type="text" data-slope-auto="' + esc(id) + '" value="' + esc(mm(calc.fact.thickness_mm)) + '" readonly>'
      + '<span class="unit-note" data-slope-note="' + esc(id) + '">' + esc(mk.note) + '</span></div>';
  }

  h += '</div></div>';
  return h;
}

// renderSlopes — список откосов (данные в stage1). Проём ст.2 замеряется на ст.2,
// но хранится в том же объекте откоса (единый список), поэтому редактируется и там.
function renderSlopes(s1, isS2) {
  const slopes = Array.isArray(s1.slopes) ? s1.slopes : [];
  let h = '<fieldset class="block"><legend>Откосы</legend>';
  h += '<p class="hint hint-sm">Толщина факта считается из того, насколько уменьшился '
    + 'проём окна/двери после штукатурки (замер проёма на ст.1 и ст.2).</p>';
  if (!slopes.length) h += '<p class="hint hint-sm">Нет откосов.</p>';
  slopes.forEach(function (sl) { h += renderSlopeItem(sl, isS2); });
  if (!isS2) h += '<button class="btn btn-sm" type="button" data-role="add-slope">+ Откос</button>';
  h += '</fieldset>';
  return h;
}

// renderColumns — список колонн (данные в stage1).
function renderColumns(s1, isS2) {
  const cols = Array.isArray(s1.columns) ? s1.columns : [];
  const dis = isS2 ? ' disabled' : '';
  let h = '<fieldset class="block"><legend>Колонны</legend>';
  if (isS2) h += '<p class="hint hint-sm">Колонны задаются на ст.1 (общий элемент).</p>';
  if (!cols.length) h += '<p class="hint hint-sm">Нет колонн.</p>';
  cols.forEach(function (c) {
    h += '<div class="line-item" data-col-id="' + esc(c.id) + '">'
      + '<input class="txt txt-sm" type="text" inputmode="numeric" data-role="col-perimeter" data-id="' + esc(c.id) + '" value="' + esc(c.perimeter) + '" placeholder="периметр, мм"' + dis + '>'
      + '<input class="txt txt-sm" type="text" inputmode="numeric" data-role="col-height" data-id="' + esc(c.id) + '" value="' + esc(c.height) + '" placeholder="высота, мм"' + dis + '>'
      + '<select class="sel sel-sm" data-role="col-material" data-id="' + esc(c.id) + '"' + dis + '>' + materialOptions(c.materialId) + '</select>'
      + '<input class="txt txt-sm" type="text" inputmode="numeric" data-role="col-thick" data-id="' + esc(c.id) + '" value="' + esc(c.thickness) + '" placeholder="толщ., мм"' + dis + '>'
      + '<button class="btn-icon btn-danger" type="button" data-role="del-col" data-id="' + esc(c.id) + '" title="Удалить колонну"' + dis + '>✕</button>'
      + '</div>';
  });
  if (!isS2) h += '<button class="btn btn-sm" type="button" data-role="add-col">+ Колонна</button>';
  h += '</fieldset>';
  return h;
}

// updateAutoFields — пересчитать и обновить read-only поля толщины ст.2 «на лету»,
// не перерисовывая всю форму (сохраняет фокус/каретку в текущем поле).
function updateAutoFields(root, room) {
  if (currentStage !== 2) return;
  const s1 = room.stage1;
  const s2 = room.stage2;

  const floorAuto = root.querySelector('[data-role="floor-thick-auto"]');
  if (floorAuto) {
    const fThick = num(s1.height) - num(s2.height);
    floorAuto.value = mm(fThick);
    const note = floorAuto.parentNode.querySelector('.unit-note');
    if (note) note.textContent = mm(fThick / 10) + ' см · авторасчёт (Δвысот)';
  }
  root.querySelectorAll('.wall[data-wall]').forEach(function (w) {
    const key = w.dataset.wall;
    const isAV = (key === 'A' || key === 'V');
    const auto = w.querySelector('.txt.auto');
    if (auto) {
      const t = isAV
        ? (num(s1.length) - num(s2.length)) / 2
        : (num(s1.width) - num(s2.width)) / 2;
      auto.value = mm(t);
    }
  });

  // Откосы: пересчёт фактической толщины из разницы проёма + маркер (пункты 3, 6).
  const slopes = Array.isArray(s1.slopes) ? s1.slopes : [];
  root.querySelectorAll('[data-slope-auto]').forEach(function (el) {
    const id = el.dataset.slopeAuto;
    const sl = slopes.find(function (x) { return x.id === id; });
    if (!sl) return;
    const calc = calcSlope(sl);
    el.value = mm(calc.fact.thickness_mm);
    const mk = thickState(calc.fact.thickness_mm, calc.plan.thickness_mm);
    setMarker(root.querySelector('[data-slope-marker="' + cssEsc(id) + '"]'), mk);
    const note = root.querySelector('[data-slope-note="' + cssEsc(id) + '"]');
    if (note) note.textContent = mk.note;
  });

  // Маркеры габаритов (высота/длина/ширина) — норма/перерасход по толщине.
  root.querySelectorAll('[data-dim-marker]').forEach(function (el) {
    const dimRole = el.dataset.dimMarker;
    const mk = dimMarker(dimRole, room);
    setMarker(el, mk);
    const ref = num(room.stage1[dimRole]);
    const note = root.querySelector('[data-dim-ref="' + cssEsc(dimRole) + '"]');
    if (note) note.textContent = 'ст.1: ' + (ref ? mm(ref) + ' мм' : '—') + (mk.note ? ' · ' + mk.note : '');
  });
}

// setMarker(el, mk) — перекрасить кружок-маркер и обновить подсказку.
function setMarker(el, mk) {
  if (!el) return;
  el.classList.remove('mk-over', 'mk-under', 'mk-norm', 'mk-neutral');
  el.classList.add(markerDotClass(mk.state));
  el.title = mk.title;
}

// cssEsc(s) — экранирование значения для селектора [attr="..."] (id-шники uuid
// безопасны, но кавычки на всякий случай экранируем).
function cssEsc(s) {
  return String(s == null ? '' : s).replace(/"/g, '\\"');
}

// bindMeasureEvents — обработчики экрана 2. Навешиваются ОДИН раз на постоянный
// #measure-root (делегирование). Текущие room/стадия резолвятся ЖИВО внутри
// каждого обработчика (ctx()), а не через замыкание, — поэтому повторные
// renderMeasure() не плодят слушателей и всегда работают с актуальными данными.
function bindMeasureEvents(root) {
  if (root._measureBound) return;
  root._measureBound = true;

  // Запоминаем, какие стены раскрыты. Событие 'toggle' не всплывает, поэтому
  // слушаем на фазе перехвата (третий аргумент true) — так один слушатель на
  // #measure-root ловит открытие/закрытие любой вложенной <details class="wall">.
  root.addEventListener('toggle', function (ev) {
    const d = ev.target;
    if (d && d.classList && d.classList.contains('wall')) {
      openWalls[d.dataset.wall] = d.open;
    }
  }, true);

  // ctx() — актуальный контекст: комната, редактируемая стадия, ст.1.
  function ctx() {
    const found = currentRoomId ? findRoom(currentRoomId) : null;
    if (!found) return null;
    const room = found.room;
    ensureStage(room, 1);
    ensureStage(room, 2);
    return { room: room, s: (currentStage === 2) ? room.stage2 : room.stage1, s1: room.stage1 };
  }

  // ---- INPUT: текстовые/числовые поля — пишем в state, save(), обновляем
  //      авторасчёты на лету БЕЗ полной перерисовки (не теряем каретку). ----
  root.addEventListener('input', function (ev) {
    const el = ev.target.closest('[data-role]');
    if (!el) return;
    const c = ctx();
    if (!c) return;
    const room = c.room, s = c.s, s1 = c.s1;
    const role = el.dataset.role;
    let handled = true;

    if (role === 'room-name') {
      room.name = el.value;
    } else if (role === 'dim') {
      s[el.dataset.dim] = el.value;           // height/length/width текущей стадии
    } else if (role === 'responsible') {
      s.responsible = el.value;
    } else if (role === 'floor-thick-plan') {
      s1.floor.thicknessPlan = el.value;      // описание — всегда в ст.1
    } else if (role === 'wall-thick-plan') {
      s1.walls[el.dataset.wall].thicknessPlan = el.value;
    } else if (role === 'op-w' || role === 'op-h') {
      const stageWalls = (currentStage === 2 ? room.stage2 : s1).walls;
      const arr = stageWalls[el.dataset.wall].openings;
      const op = arr[Number(el.dataset.idx)];
      if (op) op[role === 'op-w' ? 'w' : 'h'] = el.value;
    } else if (role === 'slope-perimeter' || role === 'slope-width' || role === 'slope-thick'
            || role === 'slope-ow1' || role === 'slope-oh1' || role === 'slope-ow2' || role === 'slope-oh2') {
      const sl = s1.slopes.find(function (x) { return x.id === el.dataset.id; });
      if (sl) {
        const map = {
          'slope-perimeter': 'perimeter', 'slope-width': 'width', 'slope-thick': 'thicknessPlan',
          'slope-ow1': 'openW1', 'slope-oh1': 'openH1', 'slope-ow2': 'openW2', 'slope-oh2': 'openH2'
        };
        sl[map[role]] = el.value;
      }
    } else if (role === 'col-perimeter' || role === 'col-height' || role === 'col-thick') {
      const c = s1.columns.find(function (x) { return x.id === el.dataset.id; });
      if (c) {
        const map = { 'col-perimeter': 'perimeter', 'col-height': 'height', 'col-thick': 'thickness' };
        c[map[role]] = el.value;
      }
    } else {
      handled = false;
    }

    if (handled) {
      try { calcProject(); } catch (e) { console.error('[measure] calc:', e); }
      save();
      updateAutoFields(root, room);           // толщина ст.2 пересчитывается мгновенно
    }
  });

  // ---- CHANGE: select-ы материалов и проёмов — влияют на расчёт/структуру,
  //      делаем полный persist() (перерисовка обновит индикаторы/авторасчёты). ----
  root.addEventListener('change', function (ev) {
    const el = ev.target.closest('[data-role]');
    if (!el) return;
    const c = ctx();
    if (!c) return;
    const room = c.room, s = c.s, s1 = c.s1;
    const role = el.dataset.role;

    if (role === 'work-order') {
      s.workOrder = el.value;
    } else if (role === 'floor-material') {
      s1.floor.materialId = el.value;
    } else if (role === 'wall-material') {
      s1.walls[el.dataset.wall].materialId = el.value;
    } else if (role === 'op-type') {
      const stageWalls = (currentStage === 2 ? room.stage2 : s1).walls;
      const op = stageWalls[el.dataset.wall].openings[Number(el.dataset.idx)];
      if (op) op.type = el.value;
    } else if (role === 'slope-material') {
      const sl = s1.slopes.find(function (x) { return x.id === el.dataset.id; });
      if (sl) sl.materialId = el.value;
    } else if (role === 'col-material') {
      const c = s1.columns.find(function (x) { return x.id === el.dataset.id; });
      if (c) c.materialId = el.value;
    } else {
      return;
    }
    persist();
  });

  // ---- CLICK: переключение стадий, назад, добавление/удаление. ----
  root.addEventListener('click', function (ev) {
    const btn = ev.target.closest('[data-role]');
    if (!btn) return;
    const role = btn.dataset.role;

    // stage/back не требуют контекста комнаты.
    if (role === 'stage') {
      const target = (btn.dataset.stage === '2') ? 2 : 1;
      // Первый переход на ст.2 — подтверждение и блокировка ст.1 (пункт 5).
      if (target === 2) {
        const c0 = ctx();
        if (c0 && !c0.room.locked) {
          const ok = confirm('Все размеры Стадии 1 внесены?\n\n'
            + 'После перехода к Стадии 2 изменить их будет нельзя '
            + '(при необходимости можно разблокировать вручную).');
          if (!ok) return;
          c0.room.locked = true;
          save();
        }
      }
      currentStage = target;
      renderMeasure();
      return;
    } else if (role === 'back') {
      renderRooms();
      showScreen('screen-rooms');
      return;
    }

    const c = ctx();
    if (!c) return;
    const room = c.room, s1 = c.s1;

    if (role === 'unlock') {
      room.locked = false;
      save();
      renderMeasure();
    } else if (role === 'add-opening') {
      const stageWalls = (currentStage === 2 ? room.stage2 : s1).walls;
      stageWalls[btn.dataset.wall].openings.push({ type: 'window', w: '', h: '' });
      persist();
    } else if (role === 'del-opening') {
      const stageWalls = (currentStage === 2 ? room.stage2 : s1).walls;
      stageWalls[btn.dataset.wall].openings.splice(Number(btn.dataset.idx), 1);
      persist();
    } else if (role === 'add-slope') {
      s1.slopes.push({
        id: uuid(), perimeter: '', width: '', materialId: '', thicknessPlan: '',
        openW1: '', openH1: '', openW2: '', openH2: ''
      });
      persist();
    } else if (role === 'del-slope') {
      s1.slopes = s1.slopes.filter(function (x) { return x.id !== btn.dataset.id; });
      persist();
    } else if (role === 'add-col') {
      s1.columns.push({ id: uuid(), perimeter: '', height: '', materialId: '', thickness: '' });
      persist();
    } else if (role === 'del-col') {
      s1.columns = s1.columns.filter(function (x) { return x.id !== btn.dataset.id; });
      persist();
    }
  });
}

// ============================================================================
// Ф4. ЭКРАН 3 — «Сравнение» (#compare-root)
// ----------------------------------------------------------------------------
// Читает готовую структуру calcProject() и рисует:
//  • десктоп (>768px) — одну широкую таблицу материалов + аккордеон-разбивку
//    (Объект → Этаж → Помещение → Поверхность) + итоговую строку;
//  • мобайл (≤768px) — те же материалы, но в 3 вкладки (План/Факт/Расхождение).
// Перерасход (delta_t<0, overrun=true) подсвечивается var(--danger).
// Оффлайн-баннер отражает navigator.onLine. Кнопка «Сформировать отчёт» —
// заглушка (обработчик появится в Ф5).
//
// Всё форматирование чисел — здесь (calc возвращает полные значения):
//  • тонны — до 3 знаков; ₽ — целые с разделением разрядов; % — 1 знак.
//  • отрицательные Δ показываются со знаком «−».
// ============================================================================

// UI-состояние экрана 3 (НЕ в localStorage — это выбор вкладки, а не данные).
let compareTab = 'plan'; // 'plan' | 'fact' | 'delta'

// fmtT(v) — тонны, до 3 знаков, «чистое» число без хвостовых нулей.
function fmtT(v) {
  const n = round(v, 3);
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 3 });
}

// fmtRub(v) — рубли, целые, с разделением разрядов.
function fmtRub(v) {
  return Math.round(num(v)).toLocaleString('ru-RU');
}

// fmtPct(v) — проценты, 1 знак.
function fmtPct(v) {
  return round(v, 1).toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
}

// fmtSigned(v, fmt) — добавляет явный знак к отформатированному значению.
// Отрицательные уже содержат «−» из toLocaleString; для >0 добавляем «+».
function fmtSigned(v, fmt) {
  const s = fmt(v);
  return (num(v) > 0 ? '+' : '') + s;
}

// renderComparison() — точка входа экрана 3. Вызывается из renderAll().
function renderComparison() {
  const root = document.getElementById('compare-root');
  if (!root) return;

  const data = calcProject();
  const hasData = data.materials.length > 0;

  let html = '';

  // 1. Оффлайн-индикатор (sticky).
  html += onlineBannerHTML();

  // 1b. Панель действий: справочник «Коэффициенты расхода» (пункт 2).
  html += '<div class="cmp-toolbar">'
    + '<button class="btn btn-sm" type="button" data-role="open-materials" '
    + 'title="Нормы расхода, цены и сметы материалов">⚙ Коэффициенты расхода</button>'
    + '</div>';

  // 2. Пустой проект — дружелюбная подсказка вместо таблицы с NaN.
  if (!hasData) {
    html += '<p class="hint">Добавьте помещения и замеры — здесь появится сравнение '
      + 'плана и факта с расхождениями по материалам.</p>';
    html += reportButtonHTML();
    root.innerHTML = html;
    bindComparisonEvents(root);
    return;
  }

  // 3. Заголовок объекта.
  html += '<div class="cmp-project-name">' + esc(data.projectName || 'Объект') + '</div>';

  // 4. Мобайл — вкладки; десктоп — полная таблица (переключение по CSS).
  html += renderMobileTabs(data);
  html += renderDesktopTable(data);

  // 5. Аккордеон-разбивка по этажам/помещениям/поверхностям.
  html += renderBreakdown(data);

  // 6. Кнопка «Сформировать отчёт» (всегда видна, обработчик — Ф5).
  html += reportButtonHTML();

  root.innerHTML = html;
  bindComparisonEvents(root);
}

// onlineBannerHTML() — sticky-баннер онлайн/офлайн.
// Онлайн → зелёный «Сохранено»; офлайн → оранжевый «Офлайн».
function onlineBannerHTML() {
  const online = (typeof navigator === 'undefined') ? true : navigator.onLine !== false;
  const cls = online ? 'is-online' : 'is-offline';
  const label = online ? '● Сохранено' : '● Офлайн';
  return '<div class="cmp-banner ' + cls + '" data-role="online-banner">' + esc(label) + '</div>';
}

// reportButtonHTML() — кнопка «Сформировать отчёт» (обработчик в Ф5).
function reportButtonHTML() {
  return '<div class="cmp-report">'
    + '<button class="btn btn-primary btn-report" type="button" id="btn-report" '
    + 'data-role="report" title="Сформировать AI-отчёт и отправить Максиму">Сформировать отчёт</button>'
    + '<span class="unit-note">AI-отчёт + отправка в Telegram</span>'
    + '</div>';
}

// deltaCellClass(overrun) — класс подсветки перерасхода (используется в таблице
// поверхностей, где порог не применяется — там любой перерасход красный).
function deltaCellClass(overrun) {
  return overrun ? ' cmp-overrun' : '';
}

// flagRowClass(x) — класс строки по зоне отклонения: значимый перерасход → красная,
// значимый недорасход → жёлтая, иначе — обычная (x = материал/итог с alert/undershoot).
function flagRowClass(x) {
  return (x && x.alert) ? ' row-alert' : ((x && x.undershoot) ? ' row-under' : '');
}
// flagCellClass(x) — класс числовой ячейки (цвет цифр) по той же зоне.
function flagCellClass(x) {
  return (x && x.alert) ? ' cmp-alert' : ((x && x.undershoot) ? ' cmp-under' : '');
}

// renderDesktopTable(data) — полная таблица материалов (видна на десктопе).
// Столбцы: Материал | Смета,т | План,т | Факт,т | Δт | Δ₽ | % | Ответственный.
// Ответственный на уровне объекта не агрегируется — ставим прочерк.
function renderDesktopTable(data) {
  let h = '<div class="cmp-desktop"><table class="cmp-table"><thead><tr>'
    + '<th>Материал</th><th class="num">Смета, т</th><th class="num">План, т</th>'
    + '<th class="num">Факт, т</th><th class="num">Δт</th><th class="num">Δ₽</th>'
    + '<th class="num">%</th><th>Ответственный</th>'
    + '</tr></thead><tbody>';

  data.materials.forEach(function (m) {
    h += '<tr class="' + flagRowClass(m).trim() + '">'
      + '<td>' + esc(m.materialName) + '</td>'
      + '<td class="num">' + fmtT(m.budget_t) + '</td>'
      + '<td class="num">' + fmtT(m.plan_t) + '</td>'
      + '<td class="num">' + fmtT(m.fact_t) + '</td>'
      + '<td class="num' + flagCellClass(m) + '">' + fmtSigned(m.delta_t, fmtT) + '</td>'
      + '<td class="num' + flagCellClass(m) + '">' + fmtSigned(m.delta_rub, fmtRub) + '</td>'
      + '<td class="num' + flagCellClass(m) + '">' + fmtSigned(m.percent, fmtPct) + '</td>'
      + '<td>' + (m.responsible ? esc(m.responsible) : '—') + '</td>'
      + '</tr>';
  });

  // Итоговая строка по объекту.
  const t = data.totals;
  h += '<tr class="cmp-total' + flagRowClass(t) + '">'
    + '<td>Итого по объекту</td>'
    + '<td class="num">—</td>'
    + '<td class="num">' + fmtT(t.plan_t) + '</td>'
    + '<td class="num">' + fmtT(t.fact_t) + '</td>'
    + '<td class="num' + flagCellClass(t) + '">' + fmtSigned(t.delta_t, fmtT) + '</td>'
    + '<td class="num' + flagCellClass(t) + '">' + fmtSigned(t.delta_rub, fmtRub) + '</td>'
    + '<td class="num">—</td>'
    + '<td>—</td>'
    + '</tr>';

  h += '</tbody></table></div>';
  return h;
}

// renderMobileTabs(data) — три вкладки для узкого экрана.
//  План:        Материал · Смета,т · План,т · Ответственный
//  Факт:        Материал · Факт,т · Ответственный
//  Расхождение: Материал · Δт · Δ₽ · % · Ответственный
// Активная вкладка — из compareTab (локальное UI-состояние).
function renderMobileTabs(data) {
  const tabs = [
    { id: 'plan',  label: 'План' },
    { id: 'fact',  label: 'Факт' },
    { id: 'delta', label: 'Расхождение' }
  ];

  let h = '<div class="cmp-mobile">';

  // Панель переключения.
  h += '<div class="cmp-tabs" role="tablist">';
  tabs.forEach(function (tb) {
    h += '<button type="button" class="cmp-tab' + (compareTab === tb.id ? ' is-active' : '') + '" '
      + 'data-role="cmp-tab" data-tab="' + tb.id + '">' + esc(tb.label) + '</button>';
  });
  h += '</div>';

  // Тело активной вкладки.
  h += '<table class="cmp-table cmp-table-mobile"><thead><tr>';
  if (compareTab === 'plan') {
    h += '<th>Материал</th><th class="num">Смета, т</th><th class="num">План, т</th><th>Ответств.</th>';
  } else if (compareTab === 'fact') {
    h += '<th>Материал</th><th class="num">Факт, т</th><th>Ответств.</th>';
  } else {
    h += '<th>Материал</th><th class="num">Δт</th><th class="num">Δ₽</th><th class="num">%</th>';
  }
  h += '</tr></thead><tbody>';

  data.materials.forEach(function (m) {
    const oc = flagRowClass(m);
    h += '<tr class="' + oc.trim() + '">';
    if (compareTab === 'plan') {
      h += '<td>' + esc(m.materialName) + '</td>'
        + '<td class="num">' + fmtT(m.budget_t) + '</td>'
        + '<td class="num">' + fmtT(m.plan_t) + '</td>'
        + '<td>' + (m.responsible ? esc(m.responsible) : '—') + '</td>';
    } else if (compareTab === 'fact') {
      h += '<td>' + esc(m.materialName) + '</td>'
        + '<td class="num">' + fmtT(m.fact_t) + '</td>'
        + '<td>' + (m.responsible ? esc(m.responsible) : '—') + '</td>';
    } else {
      h += '<td>' + esc(m.materialName) + '</td>'
        + '<td class="num' + flagCellClass(m) + '">' + fmtSigned(m.delta_t, fmtT) + '</td>'
        + '<td class="num' + flagCellClass(m) + '">' + fmtSigned(m.delta_rub, fmtRub) + '</td>'
        + '<td class="num' + flagCellClass(m) + '">' + fmtSigned(m.percent, fmtPct) + '</td>';
    }
    h += '</tr>';
  });

  // Итог по объекту (адаптирован под вкладку).
  const t = data.totals;
  h += '<tr class="cmp-total' + flagRowClass(t) + '">';
  if (compareTab === 'plan') {
    h += '<td>Итого</td><td class="num">—</td><td class="num">' + fmtT(t.plan_t) + '</td><td>—</td>';
  } else if (compareTab === 'fact') {
    h += '<td>Итого</td><td class="num">' + fmtT(t.fact_t) + '</td><td>—</td>';
  } else {
    h += '<td>Итого</td>'
      + '<td class="num' + flagCellClass(t) + '">' + fmtSigned(t.delta_t, fmtT) + '</td>'
      + '<td class="num' + flagCellClass(t) + '">' + fmtSigned(t.delta_rub, fmtRub) + '</td>'
      + '<td class="num">—</td>';
  }
  h += '</tr>';

  h += '</tbody></table></div>';
  return h;
}

// SURFACE_LABELS — человекочитаемые названия поверхностей для разбивки.
const SURFACE_LABELS = {
  floor: 'Пол', wall: 'Стена', slope: 'Откос', column: 'Колонна'
};

// surfaceLabel(surf) — «Стена А», «Пол», «Откос» и т.п.
function surfaceLabel(surf) {
  const base = SURFACE_LABELS[surf.surface] || surf.surface || 'Поверхность';
  if (surf.surface === 'wall' && surf.wallKey) {
    const w = { A: 'А', B: 'Б', V: 'В', G: 'Г' };
    return base + ' ' + (w[surf.wallKey] || surf.wallKey);
  }
  return base;
}

// renderBreakdown(data) — аккордеон Объект → Этаж → Помещение → Поверхность.
// Использует нативный <details>/<summary>: клик разворачивает/сворачивает.
// Уровни этаж/помещение/материал берём из data.rooms; уровень «поверхность»
// достаём через calcRoom(живой room из state) — там surfaces с план/факт.
function renderBreakdown(data) {
  // Сгруппировать data.rooms по этажу, сохраняя порядок.
  const floorsOrder = [];
  const byFloor = {};
  data.rooms.forEach(function (r) {
    const key = r.floorName || '(без этажа)';
    if (!byFloor[key]) { byFloor[key] = []; floorsOrder.push(key); }
    byFloor[key].push(r);
  });

  let h = '<div class="cmp-breakdown">';
  h += '<details class="acc acc-project" open><summary>Разбивка по объекту</summary>';

  floorsOrder.forEach(function (floorName) {
    h += '<details class="acc acc-floor"><summary>' + esc(floorName) + '</summary>';
    byFloor[floorName].forEach(function (room) {
      h += renderRoomBreakdown(room);
    });
    h += '</details>';
  });

  h += '</details></div>';
  return h;
}

// renderRoomBreakdown(room) — уровень помещения: строки по материалам +
// вложенный уровень поверхностей (из calcRoom живой комнаты).
function renderRoomBreakdown(room) {
  const respPart = room.responsible
    ? ' <span class="acc-resp">· ' + esc(room.responsible) + '</span>' : '';
  let h = '<details class="acc acc-room"><summary>' + esc(room.roomName || 'Помещение') + respPart + '</summary>';

  if (!room.byMaterial.length) {
    h += '<p class="hint hint-sm">Нет данных по материалам.</p>';
  } else {
    // Материалы помещения — компактная таблица (Δт/Δ₽/% с подсветкой).
    h += '<table class="cmp-table cmp-table-sub"><thead><tr>'
      + '<th>Материал</th><th class="num">План, т</th><th class="num">Факт, т</th>'
      + '<th class="num">Δт</th><th class="num">Δ₽</th><th class="num">%</th>'
      + '</tr></thead><tbody>';
    room.byMaterial.forEach(function (m) {
      h += '<tr class="' + flagRowClass(m).trim() + '">'
        + '<td>' + esc(m.materialName) + '</td>'
        + '<td class="num">' + fmtT(m.plan_t) + '</td>'
        + '<td class="num">' + fmtT(m.fact_t) + '</td>'
        + '<td class="num' + flagCellClass(m) + '">' + fmtSigned(m.delta_t, fmtT) + '</td>'
        + '<td class="num' + flagCellClass(m) + '">' + fmtSigned(m.delta_rub, fmtRub) + '</td>'
        + '<td class="num' + flagCellClass(m) + '">' + fmtSigned(m.percent, fmtPct) + '</td>'
        + '</tr>';
    });
    h += '</tbody></table>';
  }

  // Уровень поверхностей: считаем по живой комнате из state.
  const found = room.roomId ? findRoom(room.roomId) : null;
  if (found) {
    const rc = calcRoom(found.room);
    if (rc.surfaces.length) {
      h += '<details class="acc acc-surface-wrap"><summary>Поверхности</summary>';
      h += '<table class="cmp-table cmp-table-sub"><thead><tr>'
        + '<th>Поверхность</th><th>Материал</th><th class="num">План, т</th><th class="num">Факт, т</th>'
        + '</tr></thead><tbody>';
      rc.surfaces.forEach(function (surf) {
        const planT = num(surf.plan && surf.plan.consumption_t);
        const factT = num(surf.fact && surf.fact.consumption_t);
        const over = (planT - factT) < 0;
        h += '<tr class="' + (over ? 'row-overrun' : '') + '">'
          + '<td>' + esc(surfaceLabel(surf)) + '</td>'
          + '<td>' + esc(surf.materialName) + '</td>'
          + '<td class="num">' + fmtT(planT) + '</td>'
          + '<td class="num' + deltaCellClass(over) + '">' + fmtT(factT) + '</td>'
          + '</tr>';
      });
      h += '</tbody></table></details>';
    }
  }

  h += '</details>';
  return h;
}

// bindComparisonEvents(root) — обработчики экрана 3. Навешиваются ОДИН раз на
// постоянный #compare-root (делегирование). Вкладки меняют compareTab и
// перерисовывают экран; кнопка отчёта пока без действия (Ф5).
function bindComparisonEvents(root) {
  if (root._compareBound) return;
  root._compareBound = true;

  root.addEventListener('click', function (ev) {
    const el = ev.target.closest('[data-role]');
    if (!el) return;
    const role = el.dataset.role;
    if (role === 'cmp-tab') {
      compareTab = el.dataset.tab || 'plan';
      renderComparison();
    } else if (role === 'open-materials') {
      openMaterialsModal();
    }
    // role === 'report' — обработчик добавит Ф5 (AI/Telegram).
  });

  // Онлайн/офлайн: перерисовываем баннер при смене статуса сети.
  if (typeof window !== 'undefined' && !window._compareNetBound) {
    window._compareNetBound = true;
    const rerender = function () {
      if (typeof renderComparison === 'function') renderComparison();
    };
    window.addEventListener('online', rerender);
    window.addEventListener('offline', rerender);
  }
}

// ============================================================================
// СПРАВОЧНИК МАТЕРИАЛОВ — окно «Коэффициенты расхода» (пункт 2).
// Редактирование норм (коэффициент расхода), цен и сметы. Правки сразу пишутся
// в state.materials и пересчитывают экран «Сравнение» за окном.
// ============================================================================
let materialsModalEls = null; // { overlay, body }

function ensureMaterialsModal() {
  if (materialsModalEls) return materialsModalEls;

  const overlay = document.createElement('div');
  overlay.className = 'ai-modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.hidden = true;

  const box = document.createElement('div');
  box.className = 'ai-modal';

  const head = document.createElement('div');
  head.className = 'ai-modal-head';
  head.innerHTML = '<span class="ai-modal-title">Коэффициенты расхода</span>';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'ai-modal-close';
  closeBtn.setAttribute('aria-label', 'Закрыть');
  closeBtn.textContent = '✕';
  head.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'ai-modal-body';

  box.appendChild(head);
  box.appendChild(body);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  closeBtn.addEventListener('click', closeMaterialsModal);
  overlay.addEventListener('click', function (ev) { if (ev.target === overlay) closeMaterialsModal(); });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !overlay.hidden) closeMaterialsModal();
  });

  materialsModalEls = { overlay: overlay, body: body };
  bindMaterialsModalEvents(body);
  return materialsModalEls;
}

// renderMaterialsModalBody() — таблица материалов с полями ввода.
function renderMaterialsModalBody() {
  const m = ensureMaterialsModal();
  let h = '<p class="hint hint-sm">Норма (коэффициент расхода) — сколько кг материала уходит '
    + 'на 1 м² при толщине 1 см. Цена — за тонну. Смета — плановый объём по договору.</p>';

  // Порог значимого отклонения (общий на объект).
  h += '<div class="field mat-threshold"><label class="field-label">Порог значимого отклонения, %</label>'
    + '<input class="txt txt-sm mat-num" type="text" inputmode="decimal" data-role="mat-threshold" '
    + 'value="' + esc(thresholdPct()) + '">'
    + '<span class="unit-note">Отклонение меньше порога — норма (🟢). Перерасход выше — тревога (🔴), '
    + 'крупный недорасход — «проверить» (🟡). 0 — реагировать на любое отклонение.</span></div>';
  h += '<table class="cmp-table cmp-table-sub mat-table"><thead><tr>'
    + '<th>Материал</th><th class="num">Норма</th><th class="num">Цена, ₽/т</th>'
    + '<th class="num">Смета, т</th><th></th></tr></thead><tbody>';
  (state.materials || []).forEach(function (mat) {
    h += '<tr>'
      + '<td><input class="txt txt-sm" type="text" data-role="mat-name" data-id="' + esc(mat.id) + '" value="' + esc(mat.name) + '"></td>'
      + '<td><input class="txt txt-sm mat-num" type="text" inputmode="decimal" data-role="mat-norm" data-id="' + esc(mat.id) + '" value="' + esc(mat.norm) + '"></td>'
      + '<td><input class="txt txt-sm mat-num" type="text" inputmode="numeric" data-role="mat-price" data-id="' + esc(mat.id) + '" value="' + esc(mat.price) + '"></td>'
      + '<td><input class="txt txt-sm mat-num" type="text" inputmode="decimal" data-role="mat-budget" data-id="' + esc(mat.id) + '" value="' + esc(mat.budget) + '"></td>'
      + '<td><button class="btn-icon btn-danger" type="button" data-role="mat-del" data-id="' + esc(mat.id) + '" title="Удалить материал">✕</button></td>'
      + '</tr>';
  });
  h += '</tbody></table>';
  h += '<button class="btn btn-sm" type="button" data-role="mat-add">+ Материал</button>';
  m.body.innerHTML = h;
}

// bindMaterialsModalEvents(body) — обработчики окна (навешиваются один раз).
function bindMaterialsModalEvents(body) {
  function findMat(id) { return (state.materials || []).find(function (x) { return x.id === id; }); }

  body.addEventListener('input', function (ev) {
    const el = ev.target.closest('[data-role]');
    if (!el) return;
    // Порог — общий (без data-id), обрабатываем до поиска материала.
    if (el.dataset.role === 'mat-threshold') {
      if (!state.settings) state.settings = defaultSettings();
      state.settings.overrunThresholdPct = Math.max(0, num(el.value));
      save();
      if (typeof renderComparison === 'function') renderComparison();
      return;
    }
    const mat = findMat(el.dataset.id);
    if (!mat) return;
    const role = el.dataset.role;
    if (role === 'mat-name') mat.name = el.value;
    else if (role === 'mat-norm') mat.norm = num(el.value);
    else if (role === 'mat-price') mat.price = num(el.value);
    else if (role === 'mat-budget') mat.budget = num(el.value);
    else return;
    save();
    // Пересчитываем «Сравнение» за окном, но НЕ перерисовываем тело окна —
    // иначе поле ввода потеряет фокус/каретку прямо во время набора.
    if (typeof renderComparison === 'function') renderComparison();
  });

  body.addEventListener('click', function (ev) {
    const el = ev.target.closest('[data-role]');
    if (!el) return;
    const role = el.dataset.role;
    if (role === 'mat-del') {
      const mat = findMat(el.dataset.id);
      if (mat && confirm('Удалить материал «' + mat.name + '» из справочника?')) {
        state.materials = state.materials.filter(function (x) { return x.id !== el.dataset.id; });
        save();
        renderMaterialsModalBody();
        if (typeof renderComparison === 'function') renderComparison();
      }
    } else if (role === 'mat-add') {
      state.materials.push({ id: uuid(), name: 'Новый материал', norm: 0, price: 0, budget: 0 });
      save();
      renderMaterialsModalBody();
    }
  });
}

function openMaterialsModal() {
  ensureMaterialsModal();
  renderMaterialsModalBody();
  materialsModalEls.overlay.hidden = false;
  document.body.classList.add('ai-modal-open');
}
function closeMaterialsModal() {
  if (!materialsModalEls) return;
  materialsModalEls.overlay.hidden = true;
  document.body.classList.remove('ai-modal-open');
}

if (typeof module !== 'undefined') {
  module.exports = { calcFloor, calcWall, calcSlope, calcColumn, calcRoom, calcProject };
}

if (typeof module !== 'undefined' && require.main === module) {
  let passed = 0, failed = 0;
  function assertClose(label, actual, expected, eps) {
    const e = (typeof eps === 'number') ? eps : 1e-9;
    const ok = Math.abs(num(actual) - num(expected)) <= e;
    if (ok) { passed++; console.log('  OK   ' + label + '  = ' + actual); }
    else    { failed++; console.log('  FAIL ' + label + '  ожидалось ' + expected + ', получено ' + actual); }
  }

  // Подменяем глобальный state справочником материалов для тестов.
  // plaster_g norm=8.5, screed_c norm=20, price screed_c=6000.
  state = defaultState();

  console.log('--- Тест 1: ПОЛ (высота 3140 -> 3080 мм => толщина 6 см) ---');
  const roomFloor = {
    id: 'r1', name: 'Комната 1',
    stage1: {
      height: 3140, length: 5000, width: 4000,
      floor: { materialId: 'screed_c', thicknessPlan: 60 },
      walls: {}, slopes: [], columns: []
    },
    stage2: { height: 3080, length: 5000, width: 4000, floor: {}, walls: {} }
  };
  const f = calcFloor(roomFloor);
  assertClose('пол факт толщина_см', f.fact.thickness_cm, 6);           // (3140-3080)/10
  assertClose('пол площадь м2', f.area_m2, 20);                         // 5000*4000/1e6
  assertClose('пол план толщина_см', f.plan.thickness_cm, 6);           // 60/10
  // расход план = 20 * 6 * 20 / 1000 = 2.4 т
  assertClose('пол план расход_т', f.plan.consumption_t, 2.4);
  assertClose('пол факт расход_т', f.fact.consumption_t, 2.4);

  console.log('--- Тест 2: СТЕНА с окном 1200x1400 => net = gross - 1.68 м2 ---');
  const roomWall = {
    id: 'r2', name: 'Комната 2',
    stage1: {
      height: 3000, length: 5000, width: 4000, workOrder: 'plaster_first',
      floor: {},
      walls: {
        A: { materialId: 'plaster_g', thicknessPlan: 20,
             openings: [{ type: 'window', w: 1200, h: 1400 }] }
      },
      slopes: [], columns: []
    },
    stage2: { height: 3000, length: 4960, width: 4000, workOrder: 'plaster_first',
      walls: { A: { openings: [{ type: 'window', w: 1200, h: 1400 }] } } }
  };
  const w = calcWall(roomWall, 'A');
  assertClose('стена A gross план м2', w.plan.gross_m2, 15);            // 3000*5000/1e6
  assertClose('стена A openings м2', w.plan.openings_m2, 1.68);         // 1200*1400/1e6
  assertClose('стена A net план м2', w.plan.net_area_m2, 15 - 1.68);   // = 13.32
  // Толщина факта AV = (length_s1 - length_s2)/2 = (5000-4960)/2 = 20 мм
  assertClose('стена A факт толщина_мм', w.fact.thickness_mm, 20);

  console.log('--- Тест 2b: порядок работ влияет на высоту стены (screed_first) ---');
  const roomWO = {
    stage1: { height: 3000, length: 5000, width: 4000, workOrder: 'screed_first',
      walls: { A: { materialId: 'plaster_g', thicknessPlan: 20, openings: [] } } },
    stage2: { height: 2940, length: 5000, width: 4000, workOrder: 'screed_first',
      walls: { A: { openings: [] } } }
  };
  const wWO = calcWall(roomWO, 'A');
  assertClose('стена факт высота = height_s2 (screed_first)', wWO.fact.wall_height_mm, 2940);
  const roomWO2 = JSON.parse(JSON.stringify(roomWO));
  roomWO2.stage1.workOrder = 'plaster_first';
  roomWO2.stage2.workOrder = 'plaster_first';
  const wWO2 = calcWall(roomWO2, 'A');
  assertClose('стена факт высота = height_s1 (plaster_first)', wWO2.fact.wall_height_mm, 3000);

  console.log('--- Тест 3: ОТКОС 3400x250 => 0.85 м2 ---');
  const sl = calcSlope({ id: 's1', perimeter: 3400, width: 250, materialId: 'plaster_g', thickness: 15 });
  assertClose('откос площадь м2', sl.area_m2, 0.85);                    // 3400*250/1e6

  console.log('--- Тест 4: КОЛОННА 2400x3000 => 7.2 м2 ---');
  const col = calcColumn({ id: 'c1', perimeter: 2400, height: 3000, materialId: 'plaster_g', thickness: 20 });
  assertClose('колонна площадь м2', col.area_m2, 7.2);                  // 2400*3000/1e6

  console.log('--- Тест 5: calcRoom — материалы не смешиваются ---');
  const mixRoom = {
    id: 'r3', name: 'Смешанная',
    stage1: {
      height: 3140, length: 5000, width: 4000, workOrder: 'plaster_first', responsible: 'Иванов',
      floor: { materialId: 'screed_c', thicknessPlan: 60 },       // стяжка
      walls: { A: { materialId: 'plaster_g', thicknessPlan: 20, openings: [] } }, // штукатурка
      slopes: [], columns: []
    },
    stage2: { height: 3080, length: 4960, width: 4000, workOrder: 'plaster_first',
      floor: {}, walls: { A: { openings: [] } } }
  };
  const rc = calcRoom(mixRoom);
  const keys = Object.keys(rc.byMaterial).sort();
  assertClose('calcRoom число материалов', keys.length, 2);
  // Стяжка и штукатурка присутствуют отдельными ключами.
  console.log('  materials: ' + keys.join(', '));
  assertClose('screed_c план_т (пол)', rc.byMaterial['screed_c'].plan_t, 2.4);   // как в тесте 1
  // Штукатурка стены A: net = 3000*5000/1e6 = 15 м2, толщ 20 мм, norm 8.5
  // план = 15 * 2 * 8.5 / 1000 = 0.255 т
  assertClose('plaster_g план_т (стена A)', rc.byMaterial['plaster_g'].plan_t, 0.255);
  assertClose('calcRoom ответственный', rc.responsible === 'Иванов' ? 1 : 0, 1);

  console.log('--- Тест 6: calcProject — Δ<0 при перерасходе (факт>план) ---');
  // Собираем объект с одной комнатой, где факт пола больше плана.
  state = defaultState();
  state.materials.find(function (m){ return m.id === 'screed_c'; }).budget = 3;
  state.project = {
    name: 'Тестовый объект',
    floors: [{
      id: 'fl1', name: 'Этаж 1',
      rooms: [{
        id: 'rp', name: 'Комната',
        stage1: {
          height: 3140, length: 5000, width: 4000,
          floor: { materialId: 'screed_c', thicknessPlan: 60 }, // план толщ 6 см
          walls: {}, slopes: [], columns: []
        },
        // факт: высота упала на 80 мм => факт толщина 8 см > план 6 см => перерасход
        stage2: { height: 3060, length: 5000, width: 4000, floor: {}, walls: {} }
      }]
    }]
  };
  const proj = calcProject();
  const screed = proj.materials.find(function (m){ return m.materialId === 'screed_c'; });
  // план = 20 м2 * 6 см * 20 / 1000 = 2.4 т ; факт = 20 * 8 * 20 / 1000 = 3.2 т
  assertClose('проект план_т', screed.plan_t, 2.4);
  assertClose('проект факт_т', screed.fact_t, 3.2);
  assertClose('проект Δт = план-факт', screed.delta_t, -0.8);          // перерасход => <0
  assertClose('проект Δ₽ = Δт*price(6000)', screed.delta_rub, -0.8 * 6000);
  assertClose('проект перерасход overrun', screed.overrun ? 1 : 0, 1);
  assertClose('проект смета budget_t', screed.budget_t, 3);
  assertClose('проект итог Δт', proj.totals.delta_t, -0.8);

  console.log('--- Тест 7: порог значимости отклонения (двусторонний) ---');
  // Объект из теста 6: перерасход 0.8 т при плане 2.4 = 33%.
  state.settings = { overrunThresholdPct: 5 };
  const proj7 = calcProject();
  const scr7 = proj7.materials.find(function (m) { return m.materialId === 'screed_c'; });
  assertClose('порог 5%: alert при 33% перерасходе', scr7.alert ? 1 : 0, 1);
  assertClose('порог 5%: undershoot=false', scr7.undershoot ? 1 : 0, 0);
  // Порог выше отклонения → перерасход есть, но незначимый (alert=false).
  state.settings = { overrunThresholdPct: 50 };
  const proj7b = calcProject();
  const scr7b = proj7b.materials.find(function (m) { return m.materialId === 'screed_c'; });
  assertClose('порог 50%: alert=false (33% < 50%)', scr7b.alert ? 1 : 0, 0);
  assertClose('порог 50%: overrun всё ещё true', scr7b.overrun ? 1 : 0, 1);
  // Флаги напрямую: недорасход и «план=0, факт>0».
  state.settings = { overrunThresholdPct: 10 };
  const uf = deviationFlags(2.0, 1.0, 1.0);      // план 2, факт 1 → недорасход 50%
  assertClose('недорасход 50% > порог → undershoot', uf.undershoot ? 1 : 0, 1);
  assertClose('недорасход → overrun=false', uf.overrun ? 1 : 0, 0);
  const zf = deviationFlags(0, 0.5, -0.5);        // план 0, факт 0.5 → ∞% → alert
  assertClose('план 0 при факте>0 → alert', zf.alert ? 1 : 0, 1);

  console.log('\n=== ИТОГО: passed=' + passed + ', failed=' + failed + ' ===');
  process.exit(failed === 0 ? 0 : 1);
}
