window.Tools = window.Tools || {};
Tools.compress = (function () {
  let selectedEntries = [];

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

  function init() {
    const picker = document.getElementById("compress-picker");
    const els = {
      options: document.getElementById("compress-options"),
      quality: document.getElementById("compress-quality"),
      qualityLabel: document.getElementById("compress-quality-label"),
      run: document.getElementById("compress-run"),
      status: document.getElementById("compress-status"),
    };

    els.quality.addEventListener("input", () => {
      els.qualityLabel.textContent = Math.round(parseFloat(els.quality.value) * 100) + "%";
    });

    FilePicker.mount(picker, {
      accept: "pdf",
      multi: true,
      onChange: (selected) => {
        selectedEntries = selected;
        els.options.hidden = selected.length === 0;
        els.run.disabled = selected.length === 0;
      },
    });

    els.run.addEventListener("click", async () => {
      if (selectedEntries.length === 0) return;
      els.run.disabled = true;
      const quality = parseFloat(els.quality.value);
      try {
        const outputs = [];
        let totalBefore = 0;
        let totalAfter = 0;
        let totalProcessed = 0;
        let totalSkipped = 0;
        for (let i = 0; i < selectedEntries.length; i++) {
          const entry = selectedEntries[i];
          Utils.setStatus(els.status, `Сжатие ${i + 1} из ${selectedEntries.length}: ${entry.name}...`, "info");
          const bytes = await Pool.getBytes(entry.id);
          const pdfDoc = await Utils.loadPdfLibDocument(bytes);
          const { processed, skipped } = await compressImages(pdfDoc, quality, (done, total) => {
            Utils.setStatus(els.status, `${entry.name}: объекты ${done} из ${total}...`, "info");
          });
          const outBytes = await pdfDoc.save({ useObjectStreams: true });
          totalBefore += bytes.byteLength;
          totalAfter += outBytes.length;
          totalProcessed += processed;
          totalSkipped += skipped;
          outputs.push({ name: Utils.triggerDownloadName(entry.name, "_compressed", "pdf"), bytes: outBytes });
        }
        if (outputs.length === 1) {
          Utils.downloadBlob(new Blob([outputs[0].bytes], { type: "application/pdf" }), outputs[0].name);
        } else {
          const zip = new JSZip();
          outputs.forEach((o) => zip.file(o.name, o.bytes));
          const blob = await zip.generateAsync({ type: "blob" });
          Utils.downloadBlob(blob, "compressed.zip");
        }
        const pct = totalBefore > 0 ? Math.round((1 - totalAfter / totalBefore) * 100) : 0;
        Utils.setStatus(
          els.status,
          `Готово: ${Utils.formatBytes(totalBefore)} → ${Utils.formatBytes(totalAfter)} (${pct >= 0 ? "-" : "+"}${Math.abs(pct)}%). ` +
            `Пересжато изображений: ${totalProcessed}, пропущено: ${totalSkipped}.`,
          "success"
        );
      } catch (err) {
        console.error(err);
        Utils.setStatus(els.status, "Ошибка: " + err.message, "error");
      } finally {
        els.run.disabled = selectedEntries.length === 0;
      }
    });
  }

  return { init };
})();
