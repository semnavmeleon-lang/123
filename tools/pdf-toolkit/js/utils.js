const Utils = (function () {
  function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function formatBytes(bytes) {
    if (bytes === 0) return "0 Б";
    const units = ["Б", "КБ", "МБ", "ГБ"];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function stripExtension(name) {
    const idx = name.lastIndexOf(".");
    return idx > 0 ? name.slice(0, idx) : name;
  }

  /** Parse "1-3,5,8-10" (1-based, inclusive) into a sorted unique array of
   * 0-based page indices. Throws Error on invalid/out-of-range input. */
  function parsePageRanges(spec, pageCount) {
    const indices = new Set();
    const chunks = spec.split(",").map((s) => s.trim()).filter(Boolean);
    if (chunks.length === 0) throw new Error("Укажите хотя бы одну страницу или диапазон");
    for (const chunk of chunks) {
      const m = chunk.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) throw new Error(`Некорректный диапазон: "${chunk}"`);
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : start;
      if (start < 1 || end < 1 || start > end) {
        throw new Error(`Некорректный диапазон: "${chunk}"`);
      }
      if (end > pageCount) {
        throw new Error(`Диапазон "${chunk}" выходит за пределы документа (${pageCount} стр.)`);
      }
      for (let p = start; p <= end; p++) indices.add(p - 1);
    }
    return Array.from(indices).sort((a, b) => a - b);
  }

  function setStatus(el, message, type) {
    el.textContent = message || "";
    el.className = "status" + (type ? " " + type : "");
  }

  /** Wires a dropzone element (click-to-browse + drag & drop) to a hidden
   * <input type=file>. onFiles receives a FileList-like array of File objects. */
  function wireDropzone(dropzoneEl, inputEl, onFiles) {
    dropzoneEl.addEventListener("click", () => inputEl.click());
    inputEl.addEventListener("change", () => {
      if (inputEl.files && inputEl.files.length) onFiles(Array.from(inputEl.files));
    });
    ["dragenter", "dragover"].forEach((evt) =>
      dropzoneEl.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzoneEl.classList.add("dragover");
      })
    );
    ["dragleave", "dragend", "drop"].forEach((evt) =>
      dropzoneEl.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzoneEl.classList.remove("dragover");
      })
    );
    dropzoneEl.addEventListener("drop", (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) onFiles(Array.from(files));
    });
  }

  async function loadPdfJsDocument(arrayBuffer) {
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer.slice(0) });
    return loadingTask.promise;
  }

  /** Loads bytes with pdf-lib, converting its encrypted-PDF error into a
   * friendly Russian message (pdf-lib cannot actually decrypt content, so
   * encrypted files must be rejected rather than silently corrupted). */
  async function loadPdfLibDocument(bytes, opts) {
    try {
      return await PDFLib.PDFDocument.load(bytes, opts);
    } catch (err) {
      if (err instanceof PDFLib.EncryptedPDFError || /encrypted/i.test(err.message || "")) {
        throw new Error("Файл защищён паролем. Эта операция не поддерживает файлы с паролем на открытие.");
      }
      throw err;
    }
  }

  function triggerDownloadName(baseName, suffix, ext) {
    return `${stripExtension(baseName)}${suffix}.${ext}`;
  }

  let cyrillicFontBytesPromise = null;
  function getCyrillicFontBytes() {
    if (!cyrillicFontBytesPromise) {
      cyrillicFontBytesPromise = fetch("vendor/fonts/DejaVuSans.ttf").then((r) => {
        if (!r.ok) throw new Error("Не удалось загрузить встроенный шрифт (DejaVu Sans)");
        return r.arrayBuffer();
      });
    }
    return cyrillicFontBytesPromise;
  }

  /** Embeds a Unicode font (DejaVu Sans: Latin + Cyrillic + common
   * punctuation) into a pdf-lib document, so drawText works with Russian
   * text — pdf-lib's built-in StandardFonts only support WinAnsi (Latin). */
  async function embedUnicodeFont(pdfDoc) {
    pdfDoc.registerFontkit(fontkit);
    const bytes = await getCyrillicFontBytes();
    return pdfDoc.embedFont(bytes, { subset: true });
  }

  return {
    readFileAsArrayBuffer,
    downloadBlob,
    formatBytes,
    stripExtension,
    parsePageRanges,
    setStatus,
    wireDropzone,
    loadPdfJsDocument,
    loadPdfLibDocument,
    triggerDownloadName,
    embedUnicodeFont,
  };
})();
