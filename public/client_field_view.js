/* Геометрия игрового вида: масштаб, камера, тряска и границы видимости.

   Чистая математика — ни канваса, ни DOM. Раньше всё это жило внутри draw()
   вперемешку с отрисовкой, и проверить его можно было только глазами на
   живом матче. При этом здесь трижды чинились баги, каждый из которых
   воспроизводится ровно одним сочетанием чисел:

   1) На портретном телефоне масштаб считался только от вьюпорта, а ROI
      сервера фиксирован. По высоте на экран влезало под сотню рядов, всё за
      пределами ROI закрашивалось туманом — до 40% экрана.
   2) Поправка «затолкать вьюпорт внутрь ROI» считалась от края окна, а окно
      сервер снапит по шагу: величина была ступенчатой, и сглаживание не
      убирало ступеньку, а растягивало её в рывок.
   3) Ведение камеры вперёд рывок убирало, но камера доворачивала на
      поворотах — заказчику этого не нужно.

   Тесты ниже держат (1) и (3); (2) закрыт тем, что ведения больше нет вовсе.
*/

export const VIEW_CELLS_X = 40;
export const VIEW_CELLS_Y = 28;

/* Запас ROI, который сервер добавляет по краям. Вычитается при расчёте
   масштаба: у самой кромки данные уже неактуальны, и растягивать экран до
   полного ROI значит показывать туман. */
export const ROI_MARGIN_CELLS = 14;

/** Минимальный размер клетки в пикселях. Меньше — поле нечитаемо. */
export const MIN_CELL = 6;

/**
 * Размер клетки в пикселях.
 *
 * Базовое значение — вписать VIEW_CELLS_X x VIEW_CELLS_Y в окно. Затем
 * масштаб ПОДНИМАЕТСЯ так, чтобы экран не оказался больше фактического ROI:
 * иначе за его краем рисуется туман. Именно поэтому здесь max, а не min —
 * увеличение клетки уменьшает число видимых клеток.
 */
export function cellSizeFor({ cw, viewH, roi, roiGrant }) {
  const w = Math.max(1, Number(cw) || 0);
  const h = Math.max(1, Number(viewH) || 0);

  let cell = Math.max(MIN_CELL, Math.floor(Math.min(w / VIEW_CELLS_X, h / VIEW_CELLS_Y)));

  /* До первого ROI-пакета опираемся на размер, подтверждённый сервером
     (ack на viewport), и только потом — на исторические 80x56. Иначе первые
     кадры после входа рисуются в неверном масштабе и схлопываются на первом
     же пакете. */
  const fallbackW = Number(roiGrant?.w) || VIEW_CELLS_X * 2;
  const fallbackH = Number(roiGrant?.h) || VIEW_CELLS_Y * 2;
  const roiW = Math.max(8, (Number(roi?.rw) || fallbackW) - ROI_MARGIN_CELLS);
  const roiH = Math.max(8, (Number(roi?.rh) || fallbackH) - ROI_MARGIN_CELLS);

  return Math.max(cell, Math.ceil(w / roiW), Math.ceil(h / roiH));
}

/** Плавное ведение камеры за целью. k — доля пути за кадр. */
export function followCamera(cur, target, k = 0.12) {
  const t = Number(target) || 0;
  if (cur == null || !Number.isFinite(Number(cur))) return t;
  const c = Number(cur);
  return c + (t - c) * Math.max(0, Math.min(1, Number(k) || 0));
}

/**
 * Затухание тряски за кадр.
 *
 * Скорость и смещение гаснут независимо и по времени, а не по числу кадров:
 * иначе на 30 fps тряска длится вдвое дольше, чем на 60. Смещение зажато
 * потолком в долях клетки — без него сильный удар уносил камеру за экран.
 */
export function decayShake({ x = 0, y = 0, vx = 0, vy = 0, dtMs = 16, intensity = 1 }) {
  const dt = Math.max(0, Math.min(50, Number(dtMs) || 0));
  const k = Math.max(0, dt / 16);

  const nvx = (Number(vx) || 0) * Math.pow(0.78, k);
  const nvy = (Number(vy) || 0) * Math.pow(0.78, k);

  let nx = ((Number(x) || 0) + nvx) * Math.pow(0.72, k);
  let ny = ((Number(y) || 0) + nvy) * Math.pow(0.72, k);

  // Потолок 0.8 клетки: при меньшем сильная тряска физически незаметна.
  const max = 0.8 * Math.max(0, Number(intensity) || 0);
  nx = Math.max(-max, Math.min(max, nx));
  ny = Math.max(-max, Math.min(max, ny));

  return { x: nx, y: ny, vx: nvx, vy: nvy };
}

/**
 * Смещение полотна и границы клеток, попадающих на экран.
 *
 * Запас в 2 клетки по краям — чтобы частично видимые клетки рисовались
 * целиком и не мигали на границе. Границы зажимаются размерами поля.
 */
export function visibleBounds({ cw, viewH, cell, camX, camY, shakeX = 0, shakeY = 0, W, H }) {
  const c = Math.max(1, Number(cell) || 1);
  const w = Math.max(1, Number(cw) || 0);
  const h = Math.max(1, Number(viewH) || 0);
  const gw = Math.max(1, Number(W) || 0);
  const gh = Math.max(1, Number(H) || 0);

  const offsetX = w / 2 - ((Number(camX) || 0) + (Number(shakeX) || 0)) * c;
  const offsetY = h / 2 - ((Number(camY) || 0) + (Number(shakeY) || 0)) * c;

  return {
    offsetX,
    offsetY,
    minX: Math.max(0, Math.floor(-offsetX / c) - 2),
    minY: Math.max(0, Math.floor(-offsetY / c) - 2),
    maxX: Math.min(gw - 1, Math.floor((w - offsetX) / c) + 2),
    maxY: Math.min(gh - 1, Math.floor((h - offsetY) / c) + 2)
  };
}

/**
 * Пересечение экрана с последним полученным ROI.
 *
 * За его пределами данные сетки заведомо устарели, поэтому горячий цикл
 * отрисовки обязан ограничиваться этим прямоугольником. Он же — рамка обзора
 * на миникарте: рисовать её по границам экрана значит заявлять обзор больше
 * реального.
 */
export function clampToRoi(bounds, roi) {
  if (!roi) return { ...bounds };
  const rx = Number(roi.rx) || 0;
  const ry = Number(roi.ry) || 0;
  const rw = Number(roi.rw) || 0;
  const rh = Number(roi.rh) || 0;
  return {
    ...bounds,
    minX: Math.max(bounds.minX, rx),
    minY: Math.max(bounds.minY, ry),
    maxX: Math.min(bounds.maxX, rx + rw - 1),
    maxY: Math.min(bounds.maxY, ry + rh - 1)
  };
}

/* Направление -> единичный вектор смещения по сетке. Раньше draw() считал
   это дважды похожим, но не идентичным кодом: инлайновые тернарники для
   частиц скорости (независимо dx и dy, любое нераспознанное значение — 0,0)
   и отдельная локальная функция для отрисовки игроков (нераспознанное
   значение молча читалось как 'right'). Оба места кормит один и тот же
   DIR_NAMES ('up'|'down'|'left'|'right'), так что расхождение не проявлялось
   на практике — но переживало бы любой будущий пятый вариант направления
   тихо и по-разному в двух местах. */
export function dirVec(d) {
  if (d === 'up') return [0, -1];
  if (d === 'down') return [0, 1];
  if (d === 'left') return [-1, 0];
  if (d === 'right') return [1, 0];
  return [0, 0];
}

/** Прямоугольник обзора для миникарты: всегда нормализован (min <= max). */
export function viewRectOf(bounds) {
  return {
    minX: Math.min(bounds.minX, bounds.maxX),
    minY: Math.min(bounds.minY, bounds.maxY),
    maxX: Math.max(bounds.minX, bounds.maxX),
    maxY: Math.max(bounds.minY, bounds.maxY)
  };
}
