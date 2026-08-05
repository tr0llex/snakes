/* «Желаемая» экипировка: что игрок выбрал, пока сервер был недоступен.

   Зачем это вообще. Магазин работает и без соединения — предметы берутся из
   локального кэша. Игрок может надеть скин, пока идёт переподключение, и
   выбор обязан пережить это: иначе экипировка молча откатывается на то, что
   помнит сервер, и выглядит как «игра не сохранила покупку».

   Здесь только модель: чтение, запись и ПЛАН применения. Отправкой на сервер
   и показом ошибок занимается client.js — так план можно проверить тестом,
   не поднимая ни WebSocket, ни DOM. */

/* Ключ обязан совпадать с прежним: под ним уже лежит выбор у живых игроков,
   и переименование молча стёрло бы его — «игра не сохранила экипировку». */
export const COSMETICS_DESIRED_KEY = 'snakes_cosmetics_desired_v1';

/* Единственный источник правды «категория -> поле в хранилище».
   Раньше это соответствие было выписано дважды — в записи выбора и в его
   применении — двумя разными цепочками if. Достаточно было добавить
   категорию в одном месте и забыть в другом, чтобы выбор сохранялся, но
   никогда не применялся. */
export const DESIRED_FIELD_BY_CAT = {
  capturefx: 'eqCaptureFx',
  head: 'eqHead',
  seg: 'eqSeg',
  nameplate: 'eqNameplate',
  frame: 'eqFrame',
  terr: 'eqTerr',
  death: 'eqDeath'
};

const MAX_ID = 7;
const clampId = (v) => Math.max(0, Math.min(MAX_ID, Number(v) || 0));

/** Прочитать сохранённый выбор. Любая порча хранилища — как будто выбора нет. */
export function loadDesired(storage) {
  try {
    const raw = storage?.getItem?.(COSMETICS_DESIRED_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    return s;
  } catch {
    return null;
  }
}

/** Записать выбор. Пустой объект и null стирают запись, а не хранят мусор. */
export function saveDesired(storage, s) {
  try {
    if (!s || Object.keys(s).length === 0) {
      storage?.removeItem?.(COSMETICS_DESIRED_KEY);
      return;
    }
    storage?.setItem?.(COSMETICS_DESIRED_KEY, JSON.stringify(s));
  } catch {
    // Приватный режим или переполненное хранилище: выбор не важнее игры.
  }
}

/** Запомнить, что игрок хочет надеть предмет id в категории cat. */
export function setDesired(storage, cat, id) {
  const field = DESIRED_FIELD_BY_CAT[String(cat || '').trim().toLowerCase()];
  if (!field) return false;
  const next = loadDesired(storage) || {};
  next[field] = clampId(id);
  saveDesired(storage, next);
  return true;
}

/**
 * План применения выбора к серверу — чистая функция, ничего не отправляет.
 *
 * @param desired   что сохранено локально
 * @param inventory (cat) => битовая маска купленного
 * @param equipped  (cat) => что надето сейчас
 * @returns { toSend, missing }
 *   toSend  — что нужно отправить: уже надетое сюда не попадает;
 *   missing — чего в инвентаре нет. Это не придирка: кэш пережил смену
 *             личности (сменился PROFILE_SECRET, чужое устройство), обещает
 *             предмет, которого у аккаунта нет, и промолчать здесь значит
 *             оставить игрока с бесконечно «не применяющимся» скином.
 */
export function planDesiredApply({ desired, inventory, equipped }) {
  const toSend = [];
  const missing = [];
  if (!desired) return { toSend, missing };

  for (const [cat, field] of Object.entries(DESIRED_FIELD_BY_CAT)) {
    const raw = desired[field];
    if (raw === undefined || raw === null) continue;

    const want = clampId(raw);
    if (want === clampId(equipped?.(cat))) continue; // уже надето

    if ((Number(inventory?.(cat)) & (1 << want)) === 0) {
      missing.push({ cat, id: want, field });
      continue;
    }
    toSend.push({ cat, id: want, field });
  }
  return { toSend, missing };
}

/**
 * Что оставить в хранилище после попытки применения.
 * Остаётся ТОЛЬКО не отправленное: применённое уже подтвердит сервер, а
 * недоступное не станет доступным от повторов и иначе копилось бы вечно.
 */
export function keepUnsent(sentOk) {
  const kept = {};
  for (const { field, id, ok } of sentOk) {
    if (!ok) kept[field] = id;
  }
  return kept;
}
