export const fieldLabels = { amount: 'Сумма', deadline: 'Срок поставки', penaltyRate: 'Ставка неустойки' };

export function parseDate(value) {
  const parts = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  if (!parts) return null;
  const [, day, month, year] = parts;
  const iso = `${year}-${month}-${day}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}

const amountContext = /(?:(?:общ(?:ая|ую)|итоговую|итоговая)\s+стоимость(?:\s+(?:поставки|договора))?|сумм[ау]\s+договора)/iu;
const amountDeclaration = new RegExp(`(?:^\\s*(?:[\\d.]+\\s+)?|[«“\"]\\s*|(?:изменить|установить)\\s+)${amountContext.source}`, 'iu');
const amountValues = /^\s*(?:составляет|составит|равна|на|[:—–-])?\s*(\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)([,.]\d{1,2})?(?:\s*\([^)]*\))?\s*(?:руб(?:лей|ля|ль|\.)?|₽)(?![а-яё])/iu;
const deadlineContext = /поставщик\s+обязуется\s+поставить|срок\s+поставки\s*(?:[:—–-]|составляет|установлен|определяется|не\s+указан|на\s+|до\s+)|(?:перенести|изменить)\s+срок\s+поставки/iu;
const deadlineValues = /(?:не\s+позднее\s+(?:чем\s+)?|на\s+|до\s+|[:—–-]\s*|составляет\s+|установлен\s+)(\d{2}\.\d{2}\.\d{4})(?!\d)/giu;
const penaltyContext = /(?:(?:ставк[ау]\s+)?неустойк[ауи]\s+за\s+просрочку\s+поставки|ставк[ау]\s+неустойки(?!\s+за\s+просрочку))(?=[\s:—–-]|$)(?!\s+(?:оста[её]тся\s+без\s+изменений|не\s+изменяется))/iu;
const penaltyValues = /^\s*(?:(?:составляет|составит|равна|на|(?:установлена\s+)?в\s+размере|[:—–-])\s*)?(\d+(?:[,.]\d+)?)\s*%[^.!?;%,]*?(?:за\s+(?:каждый\s+)?(?:календарный\s+)?день|в\s+день|ежедневно)(?![а-яё])/iu;

function rubles(match) {
  const integer = Number(match[1].replace(/\s/g, ''));
  const fractional = Number((match[2]?.slice(1) ?? '').padEnd(2, '0'));
  const kopecks = integer * 100 + fractional;
  return Number.isSafeInteger(kopecks) ? kopecks / 100 : null;
}

function matchDailyPenalty(pattern, paragraph, context) {
  const clause = paragraph.slice(context.index + context[0].length);
  const rate = pattern.exec(clause);
  if (!rate) return [];
  // A single cap can accompany the rate. Another percentage requires review.
  const remainder = clause.slice(rate[0].length).replace(/(?:^|[\s,])но\s+не\s+более\s+\d+(?:[,.]\d+)?\s*%/iu, '');
  return remainder.includes('%') ? [] : [rate];
}

const fields = {
  amount: {
    context: amountDeclaration,
    values: amountValues,
    parse: rubles,
    missing: /определяется\s+спецификацией|числовое\s+значение\s+стоимости.+не\s+указано|(?:стоимость|сумма)\s+не\s+(?:указана|установлена)/isu,
    matches: (pattern, paragraph, context) => [pattern.exec(paragraph.slice(context.index + context[0].length))].filter(Boolean),
  },
  deadline: {
    context: deadlineContext,
    values: deadlineValues,
    parse: match => parseDate(match[1]),
    missing: /срок\s+поставки\s+не\s+(?:указан|установлен|определён|определен)/iu,
    matches: (pattern, paragraph, context) => [...paragraph.slice(context.index).split(/[.!?](?=\s|$)/u, 1)[0].matchAll(pattern)],
  },
  penaltyRate: {
    context: penaltyContext,
    values: penaltyValues,
    parse: match => match[1].replace('.', ','),
    missing: /(?:ставка\s+неустойки|неустойка\s+за\s+просрочку\s+поставки)[^.!?;]*?\s+не\s+(?:указана|установлена|предусмотрена|определена)/iu,
    matches: matchDailyPenalty,
  },
};

export function extractFields(document) {
  return Object.fromEntries(Object.entries(fields).map(([name, field]) => {
    const candidates = [];
    for (const [index, paragraph] of document.paragraphs.entries()) {
      const context = field.context.exec(paragraph);
      if (!context) continue;
      const source = { documentId: document.id, filename: document.filename, index, quote: paragraph };
      if (field.missing.test(paragraph)) {
        candidates.push({ status: 'missing', source });
        continue;
      }
      const values = field.matches(field.values, paragraph, context).map(field.parse);
      if (values.length === 1 && values[0] !== null) {
        candidates.push({ status: 'confirmed', value: values[0], source });
      } else {
        candidates.push({ status: 'review', source });
      }
    }
    if (candidates.length === 0) return [name, null];
    if (candidates.length === 1) return [name, candidates[0]];
    return [name, { status: 'review', sources: candidates.map(candidate => candidate.source), reason: 'Найдено несколько формулировок одного условия.' }];
  }));
}
