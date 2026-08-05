/*
 * «Желаемая» экипировка: выбор, сделанный без соединения.
 *
 * Магазин работает и офлайн — предметы берутся из локального кэша. Игрок
 * может надеть скин, пока идёт переподключение, и выбор обязан пережить это:
 * иначе экипировка молча откатывается на то, что помнит сервер, и выглядит
 * как «игра не сохранила покупку».
 *
 * Две вещи здесь легко сломать незаметно:
 *   1) соответствие «категория -> поле хранилища». Раньше оно было выписано
 *      двумя разными цепочками if — в записи выбора и в его применении.
 *      Добавить категорию в одном месте и забыть в другом означало «выбор
 *      сохраняется, но не применяется никогда»;
 *   2) что оставить в хранилище после отправки. Оставить лишнее — копить
 *      вечно неприменимый выбор; стереть лишнее — потерять его при обрыве.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COSMETICS_DESIRED_KEY,
  DESIRED_FIELD_BY_CAT,
  keepUnsent,
  loadDesired,
  planDesiredApply,
  saveDesired,
  setDesired
} from '../public/client_cos_desired.js';

import { COSMETICS_CATS } from '../public/client_cos_model.js';

function memStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _raw: () => (map.has(COSMETICS_DESIRED_KEY) ? JSON.parse(map.get(COSMETICS_DESIRED_KEY)) : null),
    _has: () => map.has(COSMETICS_DESIRED_KEY)
  };
}

const hostile = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceededError'); },
  removeItem() { throw new Error('SecurityError'); }
};

/** Инвентарь из списка id: маска с выставленными битами. */
const inv = (...ids) => ids.reduce((m, i) => m | (1 << i), 0);

// --- ключ и соответствие категорий -------------------------------------------

test('ключ хранилища не менялся: под ним лежит выбор живых игроков', () => {
  assert.equal(COSMETICS_DESIRED_KEY, 'snakes_cosmetics_desired_v1');
});

test('у каждой покупаемой категории есть поле в хранилище', () => {
  for (const cat of COSMETICS_CATS) {
    assert.ok(DESIRED_FIELD_BY_CAT[cat], `нет поля для категории ${cat} — её выбор не применится`);
  }
});

test('и наоборот: лишних полей нет', () => {
  for (const cat of Object.keys(DESIRED_FIELD_BY_CAT)) {
    assert.ok(COSMETICS_CATS.includes(cat), `поле для несуществующей категории ${cat}`);
  }
});

test('поля не повторяются: два разных предмета не пишутся в одно место', () => {
  const fields = Object.values(DESIRED_FIELD_BY_CAT);
  assert.equal(fields.length, new Set(fields).size);
});

// --- загрузка и запись -------------------------------------------------------

test('пустое хранилище — выбора нет', () => {
  assert.equal(loadDesired(memStorage()), null);
});

test('порча хранилища читается как «выбора нет», а не роняет магазин', () => {
  for (const bad of ['не json', '[]', 'null', '123', '"строка"']) {
    assert.equal(loadDesired(memStorage({ [COSMETICS_DESIRED_KEY]: bad })), null, `на входе ${bad}`);
  }
});

test('недоступное хранилище не роняет ни чтение, ни запись', () => {
  assert.equal(loadDesired(hostile), null);
  assert.doesNotThrow(() => saveDesired(hostile, { eqHead: 2 }));
  assert.doesNotThrow(() => setDesired(hostile, 'head', 2));
});

test('пустой объект не хранится: стираем запись, а не пишем «{}»', () => {
  const st = memStorage({ [COSMETICS_DESIRED_KEY]: '{"eqHead":1}' });
  saveDesired(st, {});
  assert.equal(st._has(), false);
  saveDesired(st, null);
  assert.equal(st._has(), false);
});

// --- setDesired --------------------------------------------------------------

test('выбор пишется в поле своей категории', () => {
  const st = memStorage();
  setDesired(st, 'head', 3);
  assert.deepEqual(st._raw(), { eqHead: 3 });
});

test('выбор в разных категориях накапливается, а не затирает предыдущий', () => {
  const st = memStorage();
  setDesired(st, 'head', 3);
  setDesired(st, 'terr', 5);
  assert.deepEqual(st._raw(), { eqHead: 3, eqTerr: 5 });
});

test('повторный выбор в той же категории заменяет прежний', () => {
  const st = memStorage();
  setDesired(st, 'seg', 1);
  setDesired(st, 'seg', 6);
  assert.deepEqual(st._raw(), { eqSeg: 6 });
});

test('категория нечувствительна к регистру и пробелам', () => {
  const st = memStorage();
  assert.equal(setDesired(st, '  HeAd ', 2), true);
  assert.deepEqual(st._raw(), { eqHead: 2 });
});

test('неизвестная категория ничего не пишет', () => {
  const st = memStorage();
  assert.equal(setDesired(st, 'нетакой', 2), false);
  assert.equal(st._has(), false);
});

test('id зажимается в границы инвентаря', () => {
  const st = memStorage();
  setDesired(st, 'head', 99);
  assert.deepEqual(st._raw(), { eqHead: 7 });
  setDesired(st, 'head', -5);
  assert.deepEqual(st._raw(), { eqHead: 0 });
});

// --- planDesiredApply --------------------------------------------------------

test('без сохранённого выбора отправлять нечего', () => {
  const p = planDesiredApply({ desired: null, inventory: () => 0xff, equipped: () => 0 });
  assert.deepEqual(p.toSend, []);
  assert.deepEqual(p.missing, []);
});

test('купленный и не надетый предмет попадает в отправку', () => {
  const p = planDesiredApply({
    desired: { eqHead: 3 },
    inventory: (c) => (c === 'head' ? inv(0, 3) : 0),
    equipped: () => 0
  });
  assert.deepEqual(p.toSend, [{ cat: 'head', id: 3, field: 'eqHead' }]);
  assert.deepEqual(p.missing, []);
});

test('уже надетый предмет не отправляется повторно', () => {
  const p = planDesiredApply({
    desired: { eqHead: 3 },
    inventory: () => inv(0, 3),
    equipped: (c) => (c === 'head' ? 3 : 0)
  });
  assert.deepEqual(p.toSend, []);
});

test('некупленный предмет уходит в missing, а не молча теряется', () => {
  // Кэш пережил смену личности и обещает предмет, которого у аккаунта нет.
  const p = planDesiredApply({
    desired: { eqHead: 5 },
    inventory: () => inv(0, 1),
    equipped: () => 0
  });
  assert.deepEqual(p.toSend, []);
  assert.deepEqual(p.missing, [{ cat: 'head', id: 5, field: 'eqHead' }]);
});

test('нулевой (базовый) предмет — законный выбор: снять скин', () => {
  const p = planDesiredApply({
    desired: { eqHead: 0 },
    inventory: () => inv(0, 4),
    equipped: () => 4
  });
  assert.deepEqual(p.toSend, [{ cat: 'head', id: 0, field: 'eqHead' }]);
});

test('поля без значения пропускаются, а не считаются нулём', () => {
  const p = planDesiredApply({
    desired: { eqHead: undefined, eqSeg: null, eqTerr: 2 },
    inventory: () => 0xff,
    equipped: () => 0
  });
  assert.deepEqual(p.toSend.map((x) => x.cat), ['terr']);
});

test('несколько категорий обрабатываются за один проход', () => {
  const p = planDesiredApply({
    desired: { eqHead: 1, eqSeg: 2, eqFrame: 6 },
    inventory: (c) => (c === 'frame' ? inv(0) : 0xff),
    equipped: () => 0
  });
  assert.deepEqual(p.toSend.map((x) => x.cat).sort(), ['head', 'seg']);
  assert.deepEqual(p.missing.map((x) => x.cat), ['frame']);
});

test('битый инвентарь не превращает всё в «куплено»', () => {
  const p = planDesiredApply({
    desired: { eqHead: 3 },
    inventory: () => undefined,
    equipped: () => 0
  });
  assert.deepEqual(p.toSend, []);
  assert.equal(p.missing.length, 1);
});

// --- keepUnsent --------------------------------------------------------------

test('отправленное из хранилища вычищается', () => {
  const kept = keepUnsent([{ field: 'eqHead', id: 3, ok: true }]);
  assert.deepEqual(kept, {});
});

test('неотправленное сохраняется до следующей попытки', () => {
  const kept = keepUnsent([{ field: 'eqHead', id: 3, ok: false }]);
  assert.deepEqual(kept, { eqHead: 3 });
});

test('смешанный результат: остаётся ровно то, что не ушло', () => {
  const kept = keepUnsent([
    { field: 'eqHead', id: 3, ok: true },
    { field: 'eqSeg', id: 2, ok: false },
    { field: 'eqTerr', id: 5, ok: true }
  ]);
  assert.deepEqual(kept, { eqSeg: 2 });
});

test('связка: обрыв на отправке сохраняет выбор, повтор его применяет', () => {
  const st = memStorage();
  setDesired(st, 'seg', 4);

  const inventory = () => inv(0, 4);
  const equipped = () => 0;

  // Первая попытка: сеть недоступна, отправить не удалось.
  const p1 = planDesiredApply({ desired: loadDesired(st), inventory: inventory, equipped });
  saveDesired(st, keepUnsent(p1.toSend.map((x) => ({ ...x, ok: false }))));
  assert.deepEqual(st._raw(), { eqSeg: 4 }, 'выбор обязан пережить обрыв');

  // Вторая попытка: сеть вернулась.
  const p2 = planDesiredApply({ desired: loadDesired(st), inventory: inventory, equipped });
  saveDesired(st, keepUnsent(p2.toSend.map((x) => ({ ...x, ok: true }))));
  assert.equal(st._has(), false, 'применённый выбор больше не хранится');
});

test('связка: недоступный предмет не копится в хранилище вечно', () => {
  const st = memStorage();
  setDesired(st, 'frame', 7);
  const p = planDesiredApply({ desired: loadDesired(st), inventory: () => inv(0), equipped: () => 0 });
  saveDesired(st, keepUnsent(p.toSend.map((x) => ({ ...x, ok: true }))));
  assert.equal(p.missing.length, 1);
  assert.equal(st._has(), false, 'от повторов он доступным не станет');
});
