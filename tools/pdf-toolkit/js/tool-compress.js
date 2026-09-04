window.Tools = window.Tools || {};
Tools.compress = (function () {
  let currentFile = null;
  let currentBytes = null;

  const SAFE_COLOR_SPACES = ["/DeviceRGB", "/DeviceGray", "/CalRGB", "/CalGray"];

  async function compressImages(pdfDoc, quality, onProgress) {
    const { PDFName, PDFRawStream } = PDFLib;
    const context = pdfDoc.context;
    const indirectObjects = context.enumerateIndirectObjects();
    let processed = 0;
    let skipped = 0;
    let savedBytes = 0;
    let done = 0;
    for (const [, obj] of indirectObjects) {
      done++;
      if (done % 5 === 0) onProgress(done, indirectObjects.length);
      if (!(obj instanceof PDFRawStream)) continue;
      const dict = obj.dict;
      const subtype = dict.lookupMaybe(PDFName.of("Subtype"), PDFName);
      if (!subtype || subtype.toString() !== "/Image") continue;
      const filter = dict.lookupMaybe(PDFName.of("Filter"), PDFName);
      if (!filter || filter.toString() !== "/DCTDecode") {
        skipped++;
        continue;
      }
      if (dict.get(PDFName.of("Decode"))) {
        skipped++;
        continue;
      }
      const colorSpace = dict.lookupMaybe(PDFName.of("ColorSpace"), PDFName);
      if (!colorSpace || !SAFE_COLOR_SPACES.includes(colorSpace.toString())) {
        skipped++;
        continue;
      }
      try {
        const originalBytes = obj.getContents();
        const bitmap = await createImageBitmap(new Blob([originalBytes], { type: "image/jpeg" }));
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d").drawImage(bitmap, 0, 0);
        const newBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
        const newBytes = new Uint8Array(await newBlob.arrayBuffer());
        if (newBytes.length < originalBytes.length) {
          obj.contents = newBytes;
          savedBytes += originalBytes.length - newBytes.length;
          processed++;
        } else {
          skipped++;
        }
      } catch (e) {
        console.warn("Пропуск изображения при сжатии:", e);
        skipped++;
      }
    }
    return { processed, skipped, savedBytes };
  }

  async function loadFile(file, els) {
    currentFile = file;
    Utils.setStatus(els.status, "Загрузка...", "info");
    try {
      currentBytes = await Utils.readFileAsArrayBuffer(file);
      els.options.hidden = false;
      els.run.disabled = false;
      Utils.setStatus(els.status, `Загружено: ${file.name} (${Utils.formatBytes(file.size)})`, "success");
    } catch (err) {
      console.error(err);
      Utils.setStatus(els.status, "Ошибка чтения файла: " + err.message, "error");
      els.run.disabled = true;
    }
  }

  function init() {
    const els = {
      dropzone: document.querySelector("#panel-compress .dropzone"),
      input: document.getElementById("compress-input"),
      options: document.getElementById("compress-options"),
      quality: document.getElementById("compress-quality"),
      qualityLabel: document.getElementById("compress-quality-label"),
      run: document.getElementById("compress-run"),
      status: document.getElementById("compress-status"),
    };

    els.quality.addEventListener("input", () => {
      els.qualityLabel.textContent = Math.round(parseFloat(els.quality.value) * 100) + "%";
    });

    Utils.wireDropzone(els.dropzone, els.input, (files) => {
      if (files[0]) loadFile(files[0], els);
    });

    els.run.addEventListener("click", async () => {
      els.run.disabled = true;
      Utils.setStatus(els.status, "Сжатие...", "info");
      try {
        const quality = parseFloat(els.quality.value);
        const pdfDoc = await Utils.loadPdfLibDocument(currentBytes);
        const { processed, skipped } = await compressImages(pdfDoc, quality, (done, total) => {
          Utils.setStatus(els.status, `Обработка объектов: ${done} из ${total}...`, "info");
        });
        const outBytes = await pdfDoc.save({ useObjectStreams: true });
        const before = currentBytes.byteLength;
        const after = outBytes.length;
        Utils.downloadBlob(
          new Blob([outBytes], { type: "application/pdf" }),
          Utils.triggerDownloadName(currentFile.name, "_compressed", "pdf")
        );
        const pct = before > 0 ? Math.round((1 - after / before) * 100) : 0;
        Utils.setStatus(
          els.status,
          `Готово: ${Utils.formatBytes(before)} → ${Utils.formatBytes(after)} (${pct >= 0 ? "-" : "+"}${Math.abs(pct)}%). ` +
            `Пересжато изображений: ${processed}, пропущено: ${skipped}.`,
          "success"
        );
      } catch (err) {
        console.error(err);
        Utils.setStatus(els.status, "Ошибка: " + err.message, "error");
      } finally {
        els.run.disabled = false;
      }
    });
  }

  return { init };
})();
