window.Tools = window.Tools || {};
Tools.watermark = (function () {
  let currentFile = null;
  let currentBytes = null;

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

  async function loadFile(file, els) {
    currentFile = file;
    Utils.setStatus(els.status, "Загрузка...", "info");
    try {
      currentBytes = await Utils.readFileAsArrayBuffer(file);
      els.options.hidden = false;
      els.run.disabled = false;
      Utils.setStatus(els.status, `Загружено: ${file.name}`, "success");
    } catch (err) {
      console.error(err);
      Utils.setStatus(els.status, "Ошибка чтения файла: " + err.message, "error");
      els.run.disabled = true;
    }
  }

  function init() {
    const els = {
      dropzone: document.querySelector("#panel-watermark .dropzone"),
      input: document.getElementById("wm-input"),
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

    Utils.wireDropzone(els.dropzone, els.input, (files) => {
      if (files[0]) loadFile(files[0], els);
    });

    els.run.addEventListener("click", async () => {
      const text = els.text.value.trim();
      if (!text) {
        Utils.setStatus(els.status, "Введите текст водяного знака.", "error");
        return;
      }
      els.run.disabled = true;
      Utils.setStatus(els.status, "Наложение водяного знака...", "info");
      try {
        const pdfDoc = await Utils.loadPdfLibDocument(currentBytes);
        const font = await Utils.embedUnicodeFont(pdfDoc);
        const size = parseFloat(els.size.value) || 48;
        const opacity = parseFloat(els.opacity.value);
        const angle = parseFloat(els.rotation.value) || 0;
        const { r, g, b } = hexToRgb(els.color.value);
        const color = PDFLib.rgb(r, g, b);
        const width = font.widthOfTextAtSize(text, size);
        const height = font.heightAtSize(size);
        const position = els.position.value;

        for (const page of pdfDoc.getPages()) {
          const { width: pw, height: ph } = page.getSize();
          if (position === "center") {
            const { x, y } = rotatedAnchor(pw / 2, ph / 2, -width / 2, -height / 2, angle);
            page.drawText(text, { x, y, size, font, color, opacity, rotate: PDFLib.degrees(angle) });
          } else {
            const spacingX = width * 1.8 + 40;
            const spacingY = height * 4 + 40;
            const cols = Math.ceil(pw / spacingX) + 2;
            const rows = Math.ceil(ph / spacingY) + 2;
            for (let ri = -1; ri < rows; ri++) {
              for (let ci = -1; ci < cols; ci++) {
                const cx = ci * spacingX;
                const cy = ri * spacingY;
                const { x, y } = rotatedAnchor(cx, cy, -width / 2, -height / 2, angle);
                page.drawText(text, { x, y, size, font, color, opacity, rotate: PDFLib.degrees(angle) });
              }
            }
          }
        }

        const bytes = await pdfDoc.save();
        Utils.downloadBlob(
          new Blob([bytes], { type: "application/pdf" }),
          Utils.triggerDownloadName(currentFile.name, "_watermarked", "pdf")
        );
        Utils.setStatus(els.status, "Готово.", "success");
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
