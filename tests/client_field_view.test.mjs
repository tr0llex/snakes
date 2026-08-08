/*
 * Геометрия игрового вида: масштаб, камера, тряска, границы видимости.
 *
 * Эта математика жила внутри draw() вперемешку с отрисовкой и не была покрыта
 * ничем — при том, что в комментариях к ней описаны три починенных вручную
 * бага. Тесты ниже держат каждый из них, чтобы правка масштаба или камеры не
 * вернула туман на пол-экрана.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_CELL,
  ROI_MARGIN_CELLS,
  VIEW_CELLS_X,
  VIEW_CELLS_Y,
  cellSizeFor,
  clampToRoi,
  decayShake,
  dirVec,
  followCamera,
  viewRectOf,
  visibleBounds
} from '../public/client_field_view.js';

/** Сколько клеток попадает на экран при данном масштабе. */
const cellsOnScreen = (px, cell) => px / cell;

// --- масштаб: главный баг «туман на пол-экрана» ------------------------------

test('портретный телефон: экран не показывает больше клеток, чем прислал сервер', () => {
  // Ровно тот случай, что ломался: узкий и высокий экран, ROI 80x56.
  const roi = { rw: 80, rh: 56 };
  const cw = 390;
  const viewH = 780;

  const cell = cellSizeFor({ cw, viewH, roi });

  const roiW = roi.rw - ROI_MARGIN_CELLS;
  const roiH = roi.rh - ROI_MARGIN_CELLS;
  assert.ok(
    cellsOnScreen(cw, cell) <= roiW + 0.001,
    `по ширине видно ${cellsOnScreen(cw, cell).toFixed(1)} клеток при ROI ${roiW}`
  );
  assert.ok(
    cellsOnScreen(viewH, cell) <= roiH + 0.001,
    `по высоте видно ${cellsOnScreen(viewH, cell).toFixed(1)} клеток при ROI ${roiH} — это и есть туман`
  );
});

test('десктоп: поправка на ROI ничего не меняет, масштаб базовый', () => {
  const cw = 1920;
  const viewH = 1080;
  const base = Math.max(MIN_CELL, Math.floor(Math.min(cw / VIEW_CELLS_X, viewH / VIEW_CELLS_Y)));
  assert.equal(cellSizeFor({ cw, viewH, roi: { rw: 80, rh: 56 } }), base);
});

test('масштаб ограничен снизу: поле не превращается в кашу', () => {
  assert.ok(cellSizeFor({ cw: 120, viewH: 90, roi: { rw: 200, rh: 200 } }) >= MIN_CELL);
});

test('до первого ROI берётся размер, подтверждённый сервером', () => {
  const cw = 390;
  const viewH = 780;
  const withGrant = cellSizeFor({ cw, viewH, roi: null, roiGrant: { w: 60, h: 40 } });
  const withoutGrant = cellSizeFor({ cw, viewH, roi: null });
  assert.ok(withGrant > withoutGrant, 'меньший разрешённый ROI обязан дать более крупную клетку');
});

test('битый ROI не роняет расчёт и не даёт нулевую клетку', () => {
  for (const roi of [{ rw: 0, rh: 0 }, { rw: -5, rh: 'абв' }, {}]) {
    const cell = cellSizeFor({ cw: 800, viewH: 600, roi });
    assert.ok(Number.isFinite(cell) && cell >= MIN_CELL, `ROI ${JSON.stringify(roi)}`);
  }
});

test('нулевое окно не даёт NaN', () => {
  assert.ok(Number.isFinite(cellSizeFor({ cw: 0, viewH: 0, roi: null })));
});

// --- камера ------------------------------------------------------------------

test('первый кадр: камера прыгает на цель, а не выезжает из нуля', () => {
  assert.equal(followCamera(null, 42), 42);
  assert.equal(followCamera(undefined, 42), 42);
});

test('камера идёт к цели, но не перелетает', () => {
  const c = followCamera(0, 10, 0.12);
  assert.ok(c > 0 && c < 10);
  assert.equal(c, 1.2);
});

test('камера сходится к цели за конечное число кадров', () => {
  let c = 0;
  for (let i = 0; i < 200; i++) c = followCamera(c, 100, 0.12);
  assert.ok(Math.abs(c - 100) < 0.01);
});

test('ведения вперёд нет: камера смотрит ровно на цель', () => {
  // Третий исторический баг: камера доворачивала на поворотах.
  // Сместить её может только тряска, и та симметрична.
  const cell = 20;
  const a = visibleBounds({ cw: 800, viewH: 600, cell, camX: 50, camY: 50, W: 200, H: 200 });
  assert.equal(a.offsetX, 800 / 2 - 50 * cell);
  assert.equal(a.offsetY, 600 / 2 - 50 * cell);
});

// --- тряска ------------------------------------------------------------------

test('тряска затухает до нуля', () => {
  let s = { x: 0.8, y: -0.8, vx: 0.4, vy: 0.4 };
  for (let i = 0; i < 200; i++) s = decayShake({ ...s, dtMs: 16, intensity: 1 });
  assert.ok(Math.abs(s.x) < 0.001 && Math.abs(s.y) < 0.001);
});

test('затухание идёт по времени, а не по числу кадров', () => {
  // 30 fps: один кадр по 33мс должен погасить примерно так же, как два по 16.
  const one = decayShake({ x: 1, y: 1, vx: 0, vy: 0, dtMs: 32, intensity: 1 });
  let two = { x: 1, y: 1, vx: 0, vy: 0 };
  two = decayShake({ ...two, dtMs: 16, intensity: 1 });
  two = decayShake({ ...two, dtMs: 16, intensity: 1 });
  assert.ok(Math.abs(one.x - two.x) < 1e-9, `${one.x} против ${two.x}`);
});

test('смещение зажато потолком: сильный удар не уносит камеру за экран', () => {
  const s = decayShake({ x: 0, y: 0, vx: 99, vy: -99, dtMs: 16, intensity: 1 });
  assert.ok(Math.abs(s.x) <= 0.8 + 1e-9);
  assert.ok(Math.abs(s.y) <= 0.8 + 1e-9);
});

test('нулевая интенсивность выключает тряску полностью', () => {
  const s = decayShake({ x: 5, y: 5, vx: 5, vy: 5, dtMs: 16, intensity: 0 });
  assert.equal(s.x, 0);
  assert.equal(s.y, 0);
});

test('огромный провал кадра не выбрасывает камеру', () => {
  // dt зажат сверху: после сворачивания вкладки dt может быть в секундах.
  const s = decayShake({ x: 0.5, y: 0.5, vx: 0.2, vy: 0.2, dtMs: 100000, intensity: 1 });
  assert.ok(Number.isFinite(s.x) && Math.abs(s.x) <= 0.8);
});

// --- границы видимости -------------------------------------------------------

test('границы не выходят за поле', () => {
  const b = visibleBounds({ cw: 4000, viewH: 4000, cell: 10, camX: 0, camY: 0, W: 50, H: 40 });
  assert.equal(b.minX, 0);
  assert.equal(b.minY, 0);
  assert.equal(b.maxX, 49);
  assert.equal(b.maxY, 39);
});

test('есть запас в две клетки — частично видимые не мигают на краю', () => {
  const cell = 20;
  const b = visibleBounds({ cw: 800, viewH: 600, cell, camX: 100, camY: 100, W: 500, H: 500 });
  const exactMinX = Math.floor(-b.offsetX / cell);
  assert.equal(b.minX, exactMinX - 2);
});

test('границы покрывают весь экран', () => {
  const cell = 24;
  const cw = 900;
  const viewH = 700;
  const b = visibleBounds({ cw, viewH, cell, camX: 60, camY: 40, W: 500, H: 500 });
  // левый верхний угол экрана
  assert.ok(b.minX * cell + b.offsetX <= 0);
  assert.ok(b.minY * cell + b.offsetY <= 0);
  // правый нижний
  assert.ok((b.maxX + 1) * cell + b.offsetX >= cw);
  assert.ok((b.maxY + 1) * cell + b.offsetY >= viewH);
});

// --- пересечение с ROI -------------------------------------------------------

test('без ROI границы остаются экранными', () => {
  const b = visibleBounds({ cw: 800, viewH: 600, cell: 20, camX: 50, camY: 50, W: 200, H: 200 });
  assert.deepEqual(clampToRoi(b, null), { ...b });
});

test('ROI режет границы экрана', () => {
  const b = { offsetX: 0, offsetY: 0, minX: 0, minY: 0, maxX: 199, maxY: 199 };
  const c = clampToRoi(b, { rx: 40, ry: 30, rw: 80, rh: 56 });
  assert.equal(c.minX, 40);
  assert.equal(c.minY, 30);
  assert.equal(c.maxX, 119);
  assert.equal(c.maxY, 85);
});

test('ROI, не пересекающийся с экраном, даёт пустой прямоугольник, а не отрицательный размер', () => {
  const b = { offsetX: 0, offsetY: 0, minX: 0, minY: 0, maxX: 10, maxY: 10 };
  const c = clampToRoi(b, { rx: 100, ry: 100, rw: 20, rh: 20 });
  const r = viewRectOf(c);
  assert.ok(r.maxX >= r.minX, 'прямоугольник обзора обязан быть нормализован');
  assert.ok(r.maxY >= r.minY);
});

test('рамка обзора нормализуется в любом порядке границ', () => {
  const r = viewRectOf({ minX: 90, maxX: 10, minY: 80, maxY: 20 });
  assert.deepEqual(r, { minX: 10, maxX: 90, minY: 20, maxY: 80 });
});

// --- направление -> вектор смещения ------------------------------------------
//
// draw() раньше считал это дважды похожим, но не идентичным кодом (частицы
// скорости — независимые тернарники dx/dy; отрисовка игроков — отдельная
// локальная функция с иным поведением на нераспознанном значении). Сверяем
// dirVec с обеими старыми реализациями на всех четырёх направлениях.

const oldDirVecParticles = (dir) => [
  dir === 'left' ? -1 : dir === 'right' ? 1 : 0,
  dir === 'up' ? -1 : dir === 'down' ? 1 : 0
];

const oldDirVecPlayers = (d) => {
  if (d === 'up') return [0, -1];
  if (d === 'down') return [0, 1];
  if (d === 'left') return [-1, 0];
  return [1, 0];
};

test('dirVec совпадает с обеими старыми реализациями на всех известных направлениях', () => {
  for (const d of ['up', 'down', 'left', 'right']) {
    assert.deepEqual(dirVec(d), oldDirVecParticles(d), `частицы скорости: ${d}`);
    assert.deepEqual(dirVec(d), oldDirVecPlayers(d), `отрисовка игроков: ${d}`);
  }
});

test('dirVec: нераспознанное значение — нулевой вектор, а не тихий откат на "право"', () => {
  // DIR_NAMES[d] || 'right' в разборе протокола уже гарантирует один из 4
  // вариантов на входе — это защита на случай будущего разъезда контракта.
  assert.deepEqual(dirVec('unknown'), [0, 0]);
  assert.deepEqual(dirVec(undefined), [0, 0]);
});
