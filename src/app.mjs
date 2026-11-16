import { analyzeContracts, filterBefore } from './contracts.mjs';
import { fieldLabels } from './fields.mjs';

const byId = id => document.getElementById(id);
const filesInput = byId('files');
const asOfInput = byId('as-of');
const filterToggle = byId('enable-filter');
const beforeInput = byId('before');
const sourceDialog = byId('source-dialog');
const sourceBody = byId('source-body');
const numberFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const kinds = { contract: 'Договор', amendment: 'Допсоглашение', draft: 'Проект допсоглашения', letter: 'Письмо поставщика' };
const valueFormats = {
  amount: value => `${numberFormat.format(value)} ₽`,
  deadline: formattedDate,
  penaltyRate: value => `${value}% в день`,
};

let files = [];
let fileErrors = [];
let uploaded = false;
let loading = false;
let uploadVersion = 0;
let result;

function node(tag, content, classes) {
  const element = document.createElement(tag);
  if (content !== undefined) element.textContent = content;
  if (classes) element.className = classes;
  return element;
}

function formattedDate(value) {
  return value.split('-').reverse().join('.');
}

function openDocument(document, source) {
  byId('source-kind').textContent = kinds[document.kind] ?? 'Исходный документ';
  byId('source-title').textContent = document.filename;
  const location = byId('source-location');
  location.hidden = !source;
  if (source) {
    location.textContent = `Выделен фрагмент ${source.index + 1} из ${document.paragraphs.length}`;
  }
  const paragraphs = document.paragraphs.map((text, index) => {
    const selected = index === source?.index;
    return node(selected ? 'blockquote' : 'p', text, selected ? 'source-paragraph selected' : 'source-paragraph');
  });
  sourceBody.replaceChildren(...paragraphs);
  if (!sourceDialog.open) sourceDialog.showModal();
  sourceBody.scrollTop = 0;
  if (source) paragraphs[source.index].scrollIntoView({ block: 'center' });
}

function documentButton(label, document, source) {
  const button = node('button', label, 'text-button');
  button.type = 'button';
  button.addEventListener('click', () => openDocument(document, source));
  return button;
}

function sourceButton(label, source) {
  const button = documentButton(label, result.documents[source.documentId], source);
  button.title = source.filename;
  return button;
}

function renderField(container, name, field, inProposal = false) {
  const labels = { missing: 'нет данных', review: 'требуется проверка' };
  const value = field.status === 'confirmed' ? valueFormats[name](field.value) : labels[field.status];
  const shown = field.source ? sourceButton(value, field.source) : node('span', value);
  shown.classList.add('value');
  if (field.status === 'review') shown.classList.add('warning');
  if (field.status === 'missing') shown.classList.add('missing');
  container.append(shown);
  if (field.reason) container.append(node('span', field.reason, 'field-note'));
  for (const source of field.sources ?? []) {
    const line = node('span', undefined, 'field-note');
    line.append(sourceButton(`${source.filename} · фрагмент ${source.index + 1}`, source));
    container.append(line);
  }
  if (field.source && field.amended && !inProposal) {
    container.append(node('span', `Допсоглашение с ${formattedDate(field.effectiveDate)}`, 'field-note amended'));
  }
}

function renderRow(row) {
  const tr = node('tr');
  const contract = node('td');
  const details = node('details', undefined, 'related-documents');
  details.append(node('summary', row.number, 'contract-number'));
  const list = node('ul');
  for (const document of row.documents) {
    const li = node('li');
    li.append(documentButton(document.filename, document), node('span', kinds[document.kind], 'field-note'));
    list.append(li);
  }
  details.append(list);
  contract.append(details, node('span', `Файлов: ${row.documents.length}`, 'field-note'));
  tr.append(contract, node('td', row.supplier ?? 'нет данных'));
  for (const name of Object.keys(fieldLabels)) {
    const cell = node('td');
    renderField(cell, name, row[name]);
    tr.append(cell);
  }
  return tr;
}

function renderProposal(proposal) {
  const article = node('article', undefined, 'proposal');
  const heading = node('h3', undefined, 'proposal-head');
  heading.append(node('strong', proposal.number, 'contract-number'), node('span', kinds[proposal.document.kind]));
  article.append(heading);
  if (!proposal.linked) article.append(node('p', 'Основной договор не загружен', 'field-note warning'));
  const values = node('dl', undefined, 'proposal-values');
  for (const [name, label] of Object.entries(fieldLabels)) {
    const field = proposal.fields[name];
    if (!field) continue;
    const group = node('div');
    const dd = node('dd');
    renderField(dd, name, field, true);
    group.append(node('dt', label), dd);
    values.append(group);
  }
  if (values.childElementCount) article.append(values);
  else article.append(node('p', 'Условия требуют ручной проверки', 'field-note warning'));
  const file = node('p', undefined, 'proposal-file');
  file.append(documentButton(proposal.document.filename, proposal.document));
  article.append(file);
  return article;
}

function renderIssue(issue) {
  const li = node('li');
  const filename = issue.document ? documentButton(issue.document.filename, issue.document) : node('strong', issue.filename);
  li.append(filename, ` — ${issue.message}`);
  return li;
}

function render() {
  beforeInput.disabled = !filterToggle.checked;
  const status = byId('upload-status');
  if (loading) {
    status.textContent = 'Читаем TXT…';
    return;
  }
  const validDate = asOfInput.validity.valid;
  byId('empty-state').hidden = uploaded;
  byId('controls').hidden = !uploaded;
  byId('workspace').hidden = !uploaded || !validDate;
  if (!uploaded) return;
  byId('upload-button').textContent = 'Заменить комплект TXT';
  status.textContent = validDate ? `Прочитано файлов: ${files.length}` : 'Укажите дату проверки.';
  if (!validDate) return;

  result = analyzeContracts(files, asOfInput.value);
  const filter = filterToggle.checked;
  const needFilterDate = filter && !beforeInput.value;
  const rows = needFilterDate ? [] : filterBefore(result.rows, filter ? beforeInput.value : null);
  byId('rows').replaceChildren(...rows.map(renderRow));
  byId('row-count').textContent = filter ? `Показано ${rows.length} из ${result.rows.length}` : `Договоров: ${rows.length}`;
  byId('table-wrap').hidden = !rows.length;
  const noRows = byId('no-rows');
  noRows.hidden = !!rows.length;
  noRows.textContent = needFilterDate ? 'Укажите дату для фильтра.'
    : filter ? 'Договоров с подтверждённым сроком раньше этой даты нет.' : 'Договоров на дату проверки нет.';
  byId('proposal-list').replaceChildren(...(result.proposals.length
    ? result.proposals.map(renderProposal) : [node('p', 'Предложения не найдены.', 'proposal section-note')]));
  const issues = [...fileErrors, ...result.issues];
  byId('issues').hidden = !issues.length;
  byId('issue-list').replaceChildren(...issues.map(renderIssue));
}

async function readFile(file) {
  try {
    if (!/\.txt$/i.test(file.name)) throw new Error('Выберите файл в формате TXT.');
    const data = await file.arrayBuffer();
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
      throw new Error('Сохраните TXT в кодировке UTF-8.');
    }
    if (!text.trim()) throw new Error('Файл пуст.');
    return { filename: file.name, text };
  } catch (error) {
    return { filename: file.name, message: error.message };
  }
}

byId('upload-button').addEventListener('click', () => filesInput.click());
filesInput.addEventListener('change', async () => {
  const selected = [...filesInput.files];
  filesInput.value = '';
  if (!selected.length) return;
  const version = ++uploadVersion;
  loading = true;
  render();
  const loaded = await Promise.all(selected.map(readFile));
  if (version !== uploadVersion) return;
  files = loaded.filter(file => 'text' in file);
  fileErrors = loaded.filter(file => 'message' in file);
  uploaded = true;
  loading = false;
  render();
});

for (const input of [asOfInput, filterToggle, beforeInput]) input.addEventListener('change', render);
