import { extractFields, fieldLabels, parseDate } from './fields.mjs';

const contractNumber = /договор(?:у|а|ом|е)?\s+(?:поставки\s+)?(?:№\s*)?([\p{L}\d][\p{L}\d/–‑-]*\d[\p{L}\d/–‑-]*|\d)(?![\p{L}\d/–‑-])/giu;
const positiveSignature = /^Статус:[ \t]*подписан(?:о)?[ \t]+обеими[ \t]+сторонами(?:[ \t]+(\d{2}\.\d{2}\.\d{4}))?[ \t]*\.?[ \t]*$/imu;
const negativeSignature = /^Статус:[^\r\n]*(?:не\s+подписан|подписан(?:о)?\s+(?:только|одной\s+стороной)|на\s+согласовании)/imu;

function sourceAt(document, index) {
  return { documentId: document.id, filename: document.filename, index, quote: document.paragraphs[index] };
}

function parseDocument({ filename, text }, id) {
  // Keep every paragraph verbatim, including original line breaks and spacing.
  const paragraphs = text.split(/\r?\n(?:[ \t]*\r?\n)+|\r?\n(?=[ \t]*\d+(?:\.\d+)*\.[ \t]+)/).filter(paragraph => paragraph.trim());
  const header = paragraphs[0] ?? '';
  const heading = header.trimStart().split(/\r?\n/, 1)[0];
  let kind = 'unknown';
  if (/^проект\s+дополнительного\s+соглашения/iu.test(heading)) kind = 'draft';
  else if (/^дополнительное\s+соглашение/iu.test(heading)) kind = 'amendment';
  else if (/^договор\s+поставки/iu.test(heading)) kind = 'contract';
  else if (/^письмо\s+поставщика/iu.test(heading)) kind = 'letter';

  const referenceText = kind === 'letter' ? text : heading;
  const numbers = new Set([...referenceText.matchAll(contractNumber)].map(match => match[1].toUpperCase().replace(/[–‑]/g, '-')));
  const statusCount = [...header.matchAll(/^Статус:/gimu)].length;
  const signature = statusCount === 1 ? positiveSignature.exec(header) : null;
  const unsigned = statusCount === 1 && negativeSignature.test(header);
  const signedOn = signature?.[1] ? parseDate(signature[1]) : null;
  const contractDate = parseDate(/^Дата:[ \t]*(\d{2}\.\d{2}\.\d{4})[ \t]*\.?[ \t]*$/imu.exec(header)?.[1]);
  const document = {
    id, filename, text, paragraphs, kind,
    number: numbers.size === 1 ? [...numbers][0] : null,
    signature: signature && !unsigned ? 'signed' : unsigned && !signature ? 'unsigned' : 'review',
    signedOn: signedOn ?? (!signature?.[1] && kind === 'contract' ? contractDate : null),
  };
  if (kind === 'amendment' && document.signature === 'unsigned') document.kind = 'draft';
  document.fields = extractFields(document);
  if (document.kind === 'amendment') {
    const effectiveClauses = paragraphs.flatMap((paragraph, index) => /(?:соглашение\s+)?вступает\s+в\s+силу/iu.test(paragraph) ? [index] : []);
    const index = effectiveClauses[0];
    const effectiveDate = effectiveClauses.length === 1
      ? parseDate(/вступает\s+в\s+силу\s+(?:с\s+)?(\d{2}\.\d{2}\.\d{4})\.?$/iu.exec(paragraphs[index].trimEnd())?.[1])
      : null;
    document.effectiveDate = effectiveDate && (!signedOn || signedOn <= effectiveDate) && (!signature?.[1] || signedOn) ? effectiveDate : null;
    document.statusSources = [0, ...effectiveClauses.filter(index => index !== 0)].map(index => sourceAt(document, index));
  }
  return document;
}

function evidence(field) {
  return field?.sources ?? (field?.source ? [field.source] : []);
}

function review(reason, sources) {
  return { status: 'review', reason, sources };
}

function resolveField(name, contract, amendments, asOf) {
  const base = contract.fields[name];
  const changes = amendments.filter(document => document.fields[name]);
  const uncertain = changes.filter(document => document.signature !== 'signed' || !document.effectiveDate);
  if (uncertain.length) {
    return review('Подписание или дата вступления изменения в силу требуют проверки.',
      uncertain.flatMap(document => [...evidence(document.fields[name]), ...document.statusSources]));
  }
  const applicable = changes.filter(document => document.effectiveDate <= asOf);
  const latest = applicable.reduce((date, document) => date > document.effectiveDate ? date : document.effectiveDate, '');
  const winners = applicable.filter(document => document.effectiveDate === latest);
  if (winners.length > 1) {
    return review('Несколько допсоглашений меняют это условие с одной даты.', winners.flatMap(document => evidence(document.fields[name])));
  }
  if (winners.length === 1) {
    return { ...winners[0].fields[name], amended: true, effectiveDate: latest };
  }
  return base ?? { status: 'missing' };
}

function getSupplier(document) {
  const matches = document.text.matchAll(/(?:^|[.\r\n])[ \t]*Поставщик:[ \t]*([^\r\n]+?)(?:\.[ \t]*(?:$|(?=\d+\.\d+\.|Покупатель:))|[ \t]*$)/gimu);
  return [...matches][0]?.[1].trim() ?? null;
}

export function analyzeContracts(files, asOf) {
  const seen = new Set();
  const documents = [];
  for (const file of files) {
    if (seen.has(file.text)) continue;
    seen.add(file.text);
    documents.push(parseDocument(file, documents.length));
  }

  const groups = Map.groupBy(documents.filter(document => document.number && document.kind !== 'unknown'), document => document.number);
  const rows = [];
  const proposals = [];
  const issues = [];
  for (const document of documents) {
    if (document.kind === 'unknown' || !document.number) {
      issues.push({ document, message: document.kind === 'unknown' ? 'Не удалось определить вид документа.' : 'Не удалось определить один номер договора.' });
    }
  }

  for (const [number, group] of groups) {
    const contracts = group.filter(document => document.kind === 'contract');
    const amendments = group.filter(document => document.kind === 'amendment');
    for (const document of group.filter(document => document.kind === 'letter' || document.kind === 'draft')) {
      proposals.push({ number, document, fields: document.fields, linked: contracts.length > 0 });
    }
    if (contracts.length === 0) {
      for (const document of group) issues.push({ document, message: `Загрузите основной договор ${number}.` });
      continue;
    }
    const [contract] = contracts;
    const row = { number, supplier: contracts.length === 1 ? getSupplier(contract) : null, documents: group };
    const problem = contracts.length > 1 ? 'Загружено несколько версий основного договора.'
      : contract.signature !== 'signed' || !contract.signedOn ? 'Подписание основного договора требует проверки.' : null;
    if (!problem && contract.signedOn > asOf) continue;
    for (const name of Object.keys(fieldLabels)) {
      row[name] = problem
        ? review(problem, contracts.map(document => sourceAt(document, 0)))
        : resolveField(name, contract, amendments, asOf);
    }
    rows.push(row);
    for (const document of amendments) {
      if (document.signature !== 'signed' || !document.effectiveDate || !Object.values(document.fields).some(Boolean)) {
        issues.push({ document, message: 'Требуется проверка статуса, даты вступления в силу или содержания изменения.' });
      }
    }
  }
  rows.sort((left, right) => left.number.localeCompare(right.number, 'ru', { numeric: true }));
  proposals.sort((left, right) => left.number.localeCompare(right.number, 'ru', { numeric: true }));
  return { rows, proposals, documents, issues };
}

export function filterBefore(rows, deadline) {
  return deadline ? rows.filter(row => row.deadline.status === 'confirmed' && row.deadline.value < deadline) : rows;
}
