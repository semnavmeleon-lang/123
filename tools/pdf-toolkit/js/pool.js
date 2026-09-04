const Pool = (function () {
  let entries = [];
  let nextId = 1;
  const listeners = [];

  function notify() {
    const snapshot = entries.slice();
    listeners.forEach((fn) => fn(snapshot));
  }

  function detectKind(file) {
    if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return "pdf";
    if (file.type.startsWith("image/")) return "image";
    return "other";
  }

  function addFiles(fileList) {
    const added = [];
    for (const file of fileList) {
      const entry = {
        id: "f" + nextId++,
        file,
        name: file.name,
        size: file.size,
        kind: detectKind(file),
        addedAt: Date.now(),
        arrayBuffer: null,
        pdfDocPromise: null,
        pageCount: null,
      };
      entries.push(entry);
      added.push(entry);
    }
    if (added.length) notify();
    return added;
  }

  function remove(id) {
    const before = entries.length;
    entries = entries.filter((e) => e.id !== id);
    if (entries.length !== before) notify();
  }

  function list(kind) {
    const items = kind ? entries.filter((e) => e.kind === kind) : entries.slice();
    return items;
  }

  function get(id) {
    return entries.find((e) => e.id === id);
  }

  async function getBytes(id) {
    const entry = get(id);
    if (!entry) throw new Error("Файл не найден в пуле");
    if (!entry.arrayBuffer) {
      entry.arrayBuffer = await Utils.readFileAsArrayBuffer(entry.file);
    }
    // Return a fresh copy each time: multiple tools may read the same pool
    // entry concurrently, and some parsers work in-place on the buffer.
    return entry.arrayBuffer.slice(0);
  }

  async function getPdfDoc(id) {
    const entry = get(id);
    if (!entry) throw new Error("Файл не найден в пуле");
    if (!entry.pdfDocPromise) {
      entry.pdfDocPromise = getBytes(id).then((bytes) => Utils.loadPdfJsDocument(bytes));
    }
    const doc = await entry.pdfDocPromise;
    if (entry.pageCount == null) {
      entry.pageCount = doc.numPages;
      notify();
    }
    return doc;
  }

  function subscribe(fn) {
    listeners.push(fn);
    fn(entries.slice());
    return () => {
      const idx = listeners.indexOf(fn);
      if (idx !== -1) listeners.splice(idx, 1);
    };
  }

  return { addFiles, remove, list, get, getBytes, getPdfDoc, subscribe };
})();
