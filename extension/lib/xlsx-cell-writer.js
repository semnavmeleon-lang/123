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

  let target_ = rel.getAttribute('Target').replace(/^\.?\//, '');
  return target_.startsWith('xl/') ? target_ : `xl/${target_}`;
}

class XlsxCellWriter {
  constructor(zip) {
    this.zip = zip;
    this.sheetPath = null;
    this.doc = null;
    this.sheetDataEl = null;
  }

  static async open(fileBytes) {
    const zip = await JSZip.loadAsync(fileBytes);
    return new XlsxCellWriter(zip);
  }

  async useSheet(sheetName) {
    this.sheetPath = await resolveSheetPath(this.zip, sheetName);
    const xml = await this.zip.file(this.sheetPath).async('string');
    this.doc = new DOMParser().parseFromString(xml, 'application/xml');
    this.sheetDataEl = this.doc.getElementsByTagNameNS(SS_NS, 'sheetData')[0];
  }

  setCell(ref, text) {
    const { row: rowNum, colNum } = splitRef(ref);

    let rowEl = Array.from(this.sheetDataEl.getElementsByTagNameNS(SS_NS, 'row')).find(
      (r) => r.getAttribute('r') === rowNum
    );
    if (!rowEl) {
      rowEl = this.doc.createElementNS(SS_NS, 'row');
      rowEl.setAttribute('r', rowNum);
      const nextRow = Array.from(this.sheetDataEl.children).find(
        (r) => Number(r.getAttribute('r')) > Number(rowNum)
      );
      if (nextRow) this.sheetDataEl.insertBefore(rowEl, nextRow);
      else this.sheetDataEl.appendChild(rowEl);
    }

    let cellEl = Array.from(rowEl.children).find((c) => c.getAttribute('r') === ref);
    if (!cellEl) {
      cellEl = this.doc.createElementNS(SS_NS, 'c');
      cellEl.setAttribute('r', ref);
      const nextCell = Array.from(rowEl.children).find(
        (c) => colLettersToNum(splitRef(c.getAttribute('r')).col) > colNum
      );
      if (nextCell) rowEl.insertBefore(cellEl, nextCell);
      else rowEl.appendChild(cellEl);
    }

    while (cellEl.firstChild) cellEl.removeChild(cellEl.firstChild);
    cellEl.setAttribute('t', 'inlineStr');
    const isEl = this.doc.createElementNS(SS_NS, 'is');
    const tEl = this.doc.createElementNS(SS_NS, 't');
    tEl.setAttribute('xml:space', 'preserve');
    tEl.textContent = text;
    isEl.appendChild(tEl);
    cellEl.appendChild(isEl);
  }

  async toBytes() {
    const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + new XMLSerializer().serializeToString(this.doc);
    this.zip.file(this.sheetPath, xml);
    return this.zip.generateAsync({ type: 'arraybuffer' });
  }
}

if (typeof module !== 'undefined') module.exports = { XlsxCellWriter, resolveSheetPath, splitRef, colLettersToNum };
