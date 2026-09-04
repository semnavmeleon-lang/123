window.Tools = window.Tools || {};
Tools.watermark = (function () {
  let selectedEntries = [];

  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return { r: 1, g: 0, b: 0 };
    return {
      r: parseInt(m[1], 16) / 255,
      g: parseInt(m[2], 16) / 255,
      b: parseInt(m[3], 16) / 255,
    };
  }

  function rotatedAnchor(cx, cy, dx, dy, angleDeg) {
    const rad = (angleDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return {
      x: cx + (dx * cos - dy * sin),
      y: cy + (dx * sin + dy * cos),
    };
  }

  async function applyWatermark(bytes, opts) {
    const pdfDoc = await Utils.loadPdfLibDocument(bytes);
    const font = await Utils.embedUnicodeFont(pdfDoc);
    const width = font.widthOfTextAtSize(opts.text, opts.size);
    const height = font.heightAtSize(opts.size);

    for (const page of pdfDoc.getPages()) {
      const { width: pw, height: ph } = page.getSize();
      if (opts.position === "center") {
        const { x, y } = rotatedAnchor(pw / 2, ph / 2, -width / 2, -height / 2, opts.angle);
        page.drawText(opts.text, { x, y, size: opts.size, font, color: opts.color, opacity: opts.opacity, rotate: PDFLib.degrees(opts.angle) });
      } else {
        const spacingX = width * 1.8 + 40;
        const spacingY = height * 4 + 40;
        const cols = Math.ceil(pw / spacingX) + 2;
        const rows = Math.ceil(ph / spacingY) + 2;
        for (let ri = -1; ri < rows; ri++) {
          for (let ci = -1; ci < cols; ci++) {
            const cx = ci * spacingX;
            const cy = ri * spacingY;
            const { x, y } = rotatedAnchor(cx, cy, -width / 2, -height / 2, opts.angle);
            page.drawText(opts.text, { x, y, size: opts.size, font, color: opts.color, opacity: opts.opacity, rotate: PDFLib.degrees(opts.angle) });
          }
        }
      }
    }
    return pdfDoc.save();
  }

  function init() {
    const picker = document.getElementById("wm-picker");
    const els = {
      options: document.getElementById("wm-options"),
      text: document.getElementById("wm-text"),
      size: document.getElementById("wm-size"),
      opacity: document.getElementById("wm-opacity"),
      rotation: document.getElementById("wm-rotation"),
      color: document.getElementById("wm-color"),
      position: document.getElementById("wm-position"),
      run: document.getElementById("wm-run"),
      status: document.getElementById("wm-status"),
    };

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
      const text = els.text.value.trim();
      if (!text) {
        Utils.setStatus(els.status, "Введите текст водяного знака.", "error");
        return;
      }
      if (selectedEntries.length === 0) return;
      els.run.disabled = true;
      const opts = {
        text,
        size: parseFloat(els.size.value) || 48,
        opacity: parseFloat(els.opacity.value),
        angle: parseFloat(els.rotation.value) || 0,
        color: (() => {
          const { r, g, b } = hexToRgb(els.color.value);
          return PDFLib.rgb(r, g, b);
        })(),
        position: els.position.value,
      };
      try {
        const outputs = [];
        for (let i = 0; i < selectedEntries.length; i++) {
          const entry = selectedEntries[i];
          Utils.setStatus(els.status, `Обработка ${i + 1} из ${selectedEntries.length}: ${entry.name}...`, "info");
          const bytes = await Pool.getBytes(entry.id);
          const outBytes = await applyWatermark(bytes, opts);
          outputs.push({ name: Utils.triggerDownloadName(entry.name, "_watermarked", "pdf"), bytes: outBytes });
        }
        if (outputs.length === 1) {
          Utils.downloadBlob(new Blob([outputs[0].bytes], { type: "application/pdf" }), outputs[0].name);
        } else {
          const zip = new JSZip();
          outputs.forEach((o) => zip.file(o.name, o.bytes));
          const blob = await zip.generateAsync({ type: "blob" });
          Utils.downloadBlob(blob, "watermarked.zip");
        }
        Utils.setStatus(els.status, `Готово: обработано файлов — ${outputs.length}.`, "success");
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
