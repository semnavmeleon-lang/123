const SS_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function colLettersToNum(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function splitRef(ref) {
  const m = ref.match(/^([A-Z]+)(\d+)$/);
  return { col: m[1], row: m[2], colNum: colLettersToNum(m[1]) };
}

// Только чтение — workbook.xml/rels никогда не переписываются, так что
// разбор через DOMParser здесь безопасен (не рискует ничего испортить).
async function resolveSheetPath(zip, sheetName) {
  const wbXml = await zip.file('xl/workbook.xml').async('string');
  const wbDoc = new DOMParser().parseFromString(wbXml, 'application/xml');
  const sheetEls = Array.from(wbDoc.getElementsByTagNameNS(SS_NS, 'sheet'));
  const target = sheetEls.find((el) => el.getAttribute('name') === sheetName);
  if (!target) throw new Error(`Лист "${sheetName}" не найден в workbook.xml`);
  const rId = target.getAttributeNS(REL_NS, 'id') || target.getAttribute('r:id');

  const relsXml = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const relsDoc = new DOMParser().parseFromString(relsXml, 'application/xml');
  const relEls = Array.from(relsDoc.getElementsByTagName('Relationship'));
  const rel = relEls.find((el) => el.getAttribute('Id') === rId);
  if (!rel) throw new Error('Связь листа не найдена в workbook.xml.rels');

  const target_ = rel.getAttribute('Target').replace(/^\.?\//, '');
  return target_.startsWith('xl/') ? target_ : `xl/${target_}`;
}

function escapeXmlText(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r\n/g, '&#10;')
    .replace(/\r/g, '&#10;')
    .replace(/\n/g, '&#10;')
    .replace(/\t/g, '&#9;');
}

function buildCellXml(ref, text, styleAttr) {
  return `<c r="${ref}"${styleAttr}t="inlineStr"><is><t xml:space="preserve">${escapeXmlText(text)}</t></is></c>`;
}

function extractAttr(tag, name) {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}

// Находит один тег (и его тело, если он не самозакрывающийся) по regex
// открывающего тега — без разбора всего документа, только точный поиск
// в исходной строке. Строки за пределами найденного диапазона не трогаются.
function findTagSpan(haystack, openTagRegex, closeTagLiteral) {
  const m = openTagRegex.exec(haystack);
  if (!m) return null;
  const openTag = m[0];
  const start = m.index;
  const openEnd = start + openTag.length;
  const selfClosing = /\/>$/.test(openTag);
  if (selfClosing) {
    return { start, end: openEnd, openTag, bodyStart: openEnd, bodyEnd: openEnd, selfClosing: true };
  }
  const closeIdx = haystack.indexOf(closeTagLiteral, openEnd);
  if (closeIdx === -1) throw new Error(`Не найден закрывающий тег ${closeTagLiteral}`);
  const end = closeIdx + closeTagLiteral.length;
  return { start, end, openTag, bodyStart: openEnd, bodyEnd: closeIdx, selfClosing: false };
}

function findRowSpan(xml, rowNum) {
  const re = new RegExp(`<row\\b[^>]*\\sr="${rowNum}"[^>]*?/?>`);
  return findTagSpan(xml, re, '</row>');
}

function findCellSpanInBody(rowBody, ref) {
  const re = new RegExp(`<c\\b[^>]*\\sr="${ref}"[^>]*?/?>`);
  return findTagSpan(rowBody, re, '</c>');
}

function insertCellXmlIntoRowBody(rowBody, colNum, newCellXml) {
  const re = /<c\b[^>]*\sr="([A-Z]+)\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g;
  let m;
  let insertAt = rowBody.length;
  while ((m = re.exec(rowBody))) {
    if (colLettersToNum(m[1]) > colNum) {
      insertAt = m.index;
      break;
    }
  }
  return rowBody.slice(0, insertAt) + newCellXml + rowBody.slice(insertAt);
}

function insertRowXml(xml, rowNum, newRowXml) {
  const openMatch = /<sheetData\b[^>]*>/.exec(xml);
  if (!openMatch) throw new Error('Не найден <sheetData> в листе');
  const bodyStart = openMatch.index + openMatch[0].length;
  const closeIdx = xml.indexOf('</sheetData>', bodyStart);
  if (closeIdx === -1) throw new Error('Не найден закрывающий </sheetData>');

  const body = xml.slice(bodyStart, closeIdx);
  const re = /<row\b[^>]*\sr="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g;
  let m;
  let insertAt = body.length;
  while ((m = re.exec(body))) {
    if (Number(m[1]) > rowNum) {
      insertAt = m.index;
      break;
    }
  }
  const newBody = body.slice(0, insertAt) + newRowXml + body.slice(insertAt);
  return xml.slice(0, bodyStart) + newBody + xml.slice(closeIdx);
}

// Точечная правка одной ячейки прямо в тексте XML — без DOMParser/XMLSerializer
// на этом пути вообще. Меняются только байты найденного тега <row>/<c>; всё
// остальное содержимое строки остаётся буквально тем же самым объектом String
// (копируется через slice), никакой пересборки/нормализации документа не происходит.
function spliceCellIntoXml(xml, ref, text) {
  const { row: rowNum, colNum } = splitRef(ref);
  const rowSpan = findRowSpan(xml, rowNum);

  if (!rowSpan) {
    const newRowXml = `<row r="${rowNum}">${buildCellXml(ref, text, ' ')}</row>`;
    return insertRowXml(xml, Number(rowNum), newRowXml);
  }

  const rowBody = rowSpan.selfClosing ? '' : xml.slice(rowSpan.bodyStart, rowSpan.bodyEnd);
  const cellSpan = rowSpan.selfClosing ? null : findCellSpanInBody(rowBody, ref);

  let newRowBody;
  if (cellSpan) {
    const styleVal = extractAttr(cellSpan.openTag, 's');
    const styleAttr = styleVal !== null ? ` s="${styleVal}" ` : ' ';
    const newCellXml = buildCellXml(ref, text, styleAttr);
    newRowBody = rowBody.slice(0, cellSpan.start) + newCellXml + rowBody.slice(cellSpan.end);
  } else {
    newRowBody = insertCellXmlIntoRowBody(rowBody, colNum, buildCellXml(ref, text, ' '));
  }

  if (rowSpan.selfClosing) {
    const openTagAsOpen = rowSpan.openTag.replace(/\/>$/, '>');
    const newRowFull = openTagAsOpen + newRowBody + '</row>';
    return xml.slice(0, rowSpan.start) + newRowFull + xml.slice(rowSpan.end);
  }
  return xml.slice(0, rowSpan.bodyStart) + newRowBody + xml.slice(rowSpan.bodyEnd);
}

class XlsxCellWriter {
  constructor(zip) {
    this.zip = zip;
    this.sheetPath = null;
    this.xml = null;
  }

  static async open(fileBytes) {
    const zip = await JSZip.loadAsync(fileBytes);
    return new XlsxCellWriter(zip);
  }

  async useSheet(sheetName) {
    this.sheetPath = await resolveSheetPath(this.zip, sheetName);
    this.xml = await this.zip.file(this.sheetPath).async('string');
  }

  setCell(ref, text) {
    this.xml = spliceCellIntoXml(this.xml, ref, text);
  }

  async toBytes() {
    this.zip.file(this.sheetPath, this.xml);
    return this.zip.generateAsync({ type: 'arraybuffer' });
  }
}

if (typeof module !== 'undefined') {
  module.exports = { XlsxCellWriter, resolveSheetPath, splitRef, colLettersToNum, spliceCellIntoXml };
}
