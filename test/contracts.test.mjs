import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { analyzeContracts, filterBefore } from '../src/contracts.mjs';

const folder = new URL('../documents/', import.meta.url);
const originals = readdirSync(folder).sort().map(filename => ({ filename, text: readFileSync(new URL(filename, folder), 'utf8') }));
const [first, signed, second, third, email, draft] = originals;
const asOf = '2026-03-10';

test('originals answer all four questions and keep the proposals visible after filtering', () => {
  const { rows, proposals, issues } = analyzeContracts(originals, asOf);
  assert.deepEqual(rows.map(row => [row.number, row.supplier, row.amount.status, row.amount.value, row.deadline.value]), [
    ['STN-101', 'ООО «Вектор Прибор»', 'confirmed', 1380000, '2026-04-30'],
    ['STN-102', 'ООО «Контур Электро»', 'confirmed', 840000, '2026-03-20'],
    ['STN-103', 'ООО «ПромСнаб Сервис»', 'missing', undefined, '2026-04-30'],
  ]);
  assert.deepEqual(issues, []);
  assert.equal(rows[0].amount.amended, true);
  assert.equal(rows[0].deadline.source.filename, signed.filename);
  assert.equal(rows[0].amount.source.filename, signed.filename);
  assert.doesNotMatch(rows[1].amount.source.quote, /252 000/);
  assert.doesNotMatch(rows[1].deadline.source.quote, /10\.04\.2026/);
  assert.match(rows[2].amount.source.quote, /Приложение № 1 в предоставленный комплект документов не входит/);
  assert.deepEqual(filterBefore(rows, '2026-04-01').map(row => row.number), ['STN-102']);
  assert.deepEqual(filterBefore(rows, '2026-03-20'), []);
  assert.deepEqual(proposals.map(item => [item.number, item.document.filename, item.fields.amount?.value, item.fields.deadline.value]), [
    ['STN-101', draft.filename, 1450000, '2026-05-10'],
    ['STN-102', email.filename, undefined, '2026-03-27'],
  ]);
});

test('the exact citation points to its original clause and preserves indentation and CRLF', () => {
  const file = { ...second, text: second.text.replace('2.1. Общая', '  2.1. Общая').replaceAll('\n', '\r\n') };
  const { rows, documents } = analyzeContracts([file], asOf);
  const { source } = rows[0].amount;
  assert.equal(documents[source.documentId].paragraphs[source.index], source.quote);
  assert.equal(source.quote, '  2.1. Общая стоимость поставки составляет 840 000 (восемьсот сорок тысяч) рублей, включая НДС. Указанная сумма — итоговая стоимость договора.');
  assert.ok(file.text.includes(source.quote));
});

test('content and effective date determine priority regardless of file name, duplication or order', () => {
  const renamed = [...originals].reverse().map((file, index) => ({ ...file, filename: `1999-01-0${index + 1}.txt` }));
  renamed.push({ ...signed, filename: '2035-01-01.txt' });
  const before = analyzeContracts(renamed, '2026-02-28').rows[0];
  const at = analyzeContracts(renamed, '2026-03-01').rows[0];
  assert.equal(before.amount.value, 1200000);
  assert.equal(before.deadline.value, '2026-04-15');
  assert.equal(at.amount.value, 1380000);
  assert.equal(at.deadline.value, '2026-04-30');
  assert.equal(at.deadline.source.filename, renamed[4].filename);
});

test('each field picks its latest applicable amendment and blocks a same-date conflict', () => {
  const text = signed.text.replace(/^1\. .+\n\n/m, '').replace('30.04.2026', '25.04.2026');
  const conflict = { filename: 'other.txt', text };
  const { rows } = analyzeContracts([first, signed, conflict], asOf);
  assert.equal(rows[0].amount.value, 1380000);
  assert.equal(rows[0].deadline.status, 'review');
  assert.equal(rows[0].deadline.sources.length, 2);
  assert.deepEqual(filterBefore(rows, '2026-05-01'), []);
  const later = { ...conflict, text: text.replaceAll('01.03.2026', '07.03.2026') };
  const result = analyzeContracts([first, later, signed], asOf).rows[0];
  assert.equal(result.deadline.value, '2026-04-25');
  assert.equal(result.amount.value, 1380000);
});

test('unsigned amendments stay proposals and unknown status or effective date requires review', () => {
  const unsigned = { ...signed, text: signed.text.replace('подписано обеими сторонами 01.03.2026', 'не подписано обеими сторонами') };
  const pending = analyzeContracts([first, unsigned], asOf);
  assert.equal(pending.rows[0].deadline.value, '2026-04-15');
  assert.equal(pending.proposals[0].fields.deadline.value, '2026-04-30');
  for (const text of [
    signed.text.replace('подписано обеими сторонами 01.03.2026', 'подписание уточняется'),
    signed.text.replace('Покупатель:', 'Статус: не подписано.\nПокупатель:'),
    signed.text.replace('вступает в силу 01.03.2026', 'вступает в силу после выполнения условий'),
    signed.text.replace('вступает в силу 01.03.2026.', 'вступает в силу 01.03.2026 при наличии согласования.'),
  ]) {
    const result = analyzeContracts([first, { ...signed, text }], asOf);
    assert.equal(result.rows[0].deadline.status, 'review');
    assert.ok(result.rows[0].deadline.sources.length >= 2);
    assert.equal(result.issues.length, 1);
  }
});

test('a changed amount and an unseen contract are read, and absent fields stay empty', () => {
  const edited = { ...second, text: second.text.replace(/840 000 \([^)]+\)/, '999\u202f123,45') };
  const added = { filename: 'additional.txt', text: third.text.replace('STN-103', 'NEW-504').replace(/^3\.1\. .+\n\n/m, '') };
  const result = analyzeContracts([...originals.filter(file => file !== second), edited, added], asOf);
  assert.equal(result.rows.find(row => row.number === 'STN-102').amount.value, 999123.45);
  const row = result.rows.find(row => row.number === 'NEW-504');
  assert.equal(row.supplier, 'ООО «ПромСнаб Сервис»');
  assert.equal(row.amount.status, 'missing');
  assert.deepEqual(row.deadline, { status: 'missing' });
});

test('an invalid delivery date and a separate advance never become confirmed terms', () => {
  const text = second.text.replace('20.03.2026', '31.02.2026')
    .replace(/Общая стоимость поставки составляет .+итоговая стоимость договора\./, 'Общая стоимость уточняется. Аванс составляет 19 000 рублей.');
  const [row] = analyzeContracts([{ ...second, text }], asOf).rows;
  assert.equal(row.amount.status, 'review');
  assert.equal(row.deadline.status, 'review');
});

test('an unlinked proposal and an unknown file appear in the review list', () => {
  const result = analyzeContracts([email, { filename: 'unknown.txt', text: 'Свободный формат.' }], asOf);
  assert.equal(result.rows.length, 0);
  assert.equal(result.proposals[0].linked, false);
  assert.equal(result.issues.length, 2);
});

test('originals cite the daily penalty rate or its explicit absence', () => {
  const { rows, documents } = analyzeContracts(originals, asOf);
  assert.deepEqual(rows.map(row => [row.number, row.penaltyRate?.status, row.penaltyRate?.value, row.penaltyRate?.source?.filename]), [
    ['STN-101', 'confirmed', '0,1', first.filename],
    ['STN-102', 'confirmed', '0,05', second.filename],
    ['STN-103', 'missing', undefined, third.filename],
  ]);
  for (const { penaltyRate: { source } } of rows) {
    assert.equal(source.quote, documents[source.documentId].paragraphs[source.index]);
    assert.ok(documents[source.documentId].text.includes(source.quote));
  }
  assert.match(rows[0].penaltyRate.source.quote, /0,1%.*за каждый день, но не более 10%/);
  assert.match(rows[2].penaltyRate.source.quote, /Ставка неустойки в тексте договора не установлена/);
});

test('an explicit daily penalty change uses the usual rules for date and signature', () => {
  const changed = signed.text.replace('Остальные условия договора, в том числе размер неустойки, остаются без изменений.',
    'Пункт 4.1 изложить в следующей редакции: «Неустойка за просрочку поставки составляет 0.2% стоимости поставки за каждый день, но не более 10% стоимости поставки».');
  const amendment = { ...signed, text: changed };
  assert.equal(analyzeContracts([first, amendment], '2026-02-28').rows[0].penaltyRate?.value, '0,1');
  const { penaltyRate } = analyzeContracts([first, amendment], asOf).rows[0];
  assert.equal(penaltyRate?.value, '0,2');
  assert.equal(penaltyRate.source.filename, signed.filename);
  const unsigned = { ...amendment, text: changed.replace('подписано обеими сторонами 01.03.2026', 'не подписано') };
  const result = analyzeContracts([first, unsigned], asOf);
  assert.equal(result.rows[0].penaltyRate.value, '0,1');
  assert.equal(result.proposals[0].fields.penaltyRate.value, '0,2');
});

test('a cap or multiple tiers require review and a missing clause stays empty', () => {
  for (const clause of [
    'Неустойка за просрочку поставки составляет не более 10% стоимости поставки.',
    'Неустойка за просрочку поставки составляет 0,1% за каждый день, с 11-го дня — 0,2% за каждый день.',
  ]) {
    const modified = { ...first, text: first.text.replace(/4\.1\. .+/, `4.1. ${clause}`) };
    assert.equal(analyzeContracts([modified], asOf).rows[0].penaltyRate?.status, 'review');
  }
  const absent = { ...first, text: first.text.replace(/4\.1\. .+/, '4.1. Ответственность определяется законодательством.') };
  assert.deepEqual(analyzeContracts([absent], asOf).rows[0].penaltyRate, { status: 'missing' });
});
