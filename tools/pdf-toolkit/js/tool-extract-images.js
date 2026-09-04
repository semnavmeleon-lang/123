window.Tools = window.Tools || {};
Tools["extract-images"] = (function () {
  let current = null;
  let pdfjsDoc = null;

  async function loadCurrent(entry, els) {
    current = entry;
    els.results.innerHTML = "";
    if (!entry) {
      els.run.disabled = true;
      return;
    }
    Utils.setStatus(els.status, "Загрузка...", "info");
    try {
      pdfjsDoc = await Pool.getPdfDoc(entry.id);
      els.run.disabled = false;
      Utils.setStatus(els.status, `Загружено: ${entry.name} (${pdfjsDoc.numPages} стр.)`, "success");
    } catch (err) {
      console.error(err);
      Utils.setStatus(els.status, "Ошибка чтения PDF: " + err.message, "error");
      els.run.disabled = true;
    }
  }

  function getObj(objs, name) {
    return new Promise((resolve) => {
      try {
        objs.get(name, resolve);
      } catch (e) {
        resolve(null);
      }
    });
  }

  function imageObjToImageData(imgObj) {
    const { data, width, height, kind } = imgObj;
    if (!data || !width || !height) return null;
    const out = new Uint8ClampedArray(width * height * 4);
    const ImageKind = pdfjsLib.ImageKind;
    if (kind === ImageKind.RGBA_32BPP) {
      out.set(data.subarray ? data.subarray(0, out.length) : data);
    } else if (kind === ImageKind.RGB_24BPP) {
      for (let i = 0, j = 0; j < out.length; i += 3, j += 4) {
        out[j] = data[i];
        out[j + 1] = data[i + 1];
        out[j + 2] = data[i + 2];
        out[j + 3] = 255;
      }
    } else if (kind === ImageKind.GRAYSCALE_1BPP) {
      const rowBytes = Math.ceil(width / 8);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const byte = data[y * rowBytes + (x >> 3)] || 0;
          const bit = (byte >> (7 - (x & 7))) & 1;
          const val = bit ? 255 : 0;
          const j = (y * width + x) * 4;
          out[j] = out[j + 1] = out[j + 2] = val;
          out[j + 3] = 255;
        }
      }
    } else if (data.length === width * height * 4) {
      out.set(data);
    } else if (data.length === width * height) {
      for (let i = 0; i < data.length; i++) {
        const j = i * 4;
        out[j] = out[j + 1] = out[j + 2] = data[i];
        out[j + 3] = 255;
      }
    } else {
      return null;
    }
    return new ImageData(out, width, height);
  }

  async function objToCanvas(imgObj) {
    if (!imgObj) return null;
    const canvas = document.createElement("canvas");
    if (typeof ImageBitmap !== "undefined" && imgObj instanceof ImageBitmap) {
      canvas.width = imgObj.width;
      canvas.height = imgObj.height;
      canvas.getContext("2d").drawImage(imgObj, 0, 0);
      return canvas;
    }
    if (imgObj.bitmap) {
      canvas.width = imgObj.bitmap.width;
      canvas.height = imgObj.bitmap.height;
      canvas.getContext("2d").drawImage(imgObj.bitmap, 0, 0);
      return canvas;
    }
    const imageData = imageObjToImageData(imgObj);
    if (!imageData) return null;
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    canvas.getContext("2d").putImageData(imageData, 0, 0);
    return canvas;
  }

  async function extractFromPage(page, pageIndex, seenCommon, out) {
    const opList = await page.getOperatorList();
    const OPS = pdfjsLib.OPS;
    for (let j = 0; j < opList.fnArray.length; j++) {
      const fn = opList.fnArray[j];
      if (fn !== OPS.paintImageXObject && fn !== OPS.paintImageXObjectRepeat) continue;
      const name = opList.argsArray[j][0];
      let key, imgObj;
      if (page.objs.has(name)) {
        key = `p${pageIndex}_${name}`;
        if (out.seenLocal.has(key)) continue;
        out.seenLocal.add(key);
        imgObj = await getObj(page.objs, name);
      } else if (page.commonObjs.has(name)) {
        key = `common_${name}`;
        if (seenCommon.has(key)) continue;
        seenCommon.add(key);
        imgObj = await getObj(page.commonObjs, name);
      } else {
        continue;
      }
      try {
        const canvas = await objToCanvas(imgObj);
        if (!canvas || canvas.width === 0 || canvas.height === 0) continue;
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        if (blob) out.images.push({ blob, canvas, page: pageIndex + 1, index: out.images.length + 1 });
      } catch (e) {
        console.warn("Не удалось извлечь изображение", name, e);
      }
    }
  }

  function renderResults(container, images) {
    container.innerHTML = "";
    images.forEach((img) => {
      const card = document.createElement("div");
      card.className = "thumb-card";
      const previewCanvas = document.createElement("canvas");
      const scale = Math.min(1, 150 / img.canvas.width);
      previewCanvas.width = img.canvas.width * scale;
      previewCanvas.height = img.canvas.height * scale;
      previewCanvas.getContext("2d").drawImage(img.canvas, 0, 0, previewCanvas.width, previewCanvas.height);
      card.appendChild(previewCanvas);
      const label = document.createElement("div");
      label.className = "thumb-label";
      label.textContent = `Стр. ${img.page} · ${img.canvas.width}×${img.canvas.height}`;
      card.appendChild(label);
      const controls = document.createElement("div");
      controls.className = "thumb-controls";
      const dlBtn = document.createElement("button");
      dlBtn.textContent = "Скачать";
      dlBtn.addEventListener("click", () => Utils.downloadBlob(img.blob, `image_p${img.page}_${img.index}.png`));
      controls.appendChild(dlBtn);
      card.appendChild(controls);
      container.appendChild(card);
    });
  }

  function init() {
    const picker = document.getElementById("extimg-picker");
    const els = {
      run: document.getElementById("extimg-run"),
      downloadAll: document.getElementById("extimg-download-all"),
      results: document.getElementById("extimg-results"),
      status: document.getElementById("extimg-status"),
    };
    let lastImages = [];

    FilePicker.mount(picker, {
      accept: "pdf",
      multi: false,
      onChange: (selected) => loadCurrent(selected[0] || null, els),
    });

    els.run.addEventListener("click", async () => {
      els.run.disabled = true;
      els.downloadAll.disabled = true;
      els.results.innerHTML = "";
      const out = { images: [], seenLocal: new Set() };
      const seenCommon = new Set();
      try {
        const numPages = pdfjsDoc.numPages;
        for (let i = 0; i < numPages; i++) {
          Utils.setStatus(els.status, `Поиск изображений: страница ${i + 1} из ${numPages}...`, "info");
          const page = await pdfjsDoc.getPage(i + 1);
          await extractFromPage(page, i, seenCommon, out);
        }
        lastImages = out.images;
        renderResults(els.results, out.images);
        if (out.images.length === 0) {
          Utils.setStatus(els.status, "Встроенных растровых изображений не найдено.", "info");
        } else {
          Utils.setStatus(els.status, `Готово: найдено изображений — ${out.images.length}.`, "success");
          els.downloadAll.disabled = false;
        }
      } catch (err) {
        console.error(err);
        Utils.setStatus(els.status, "Ошибка: " + err.message, "error");
      } finally {
        els.run.disabled = false;
      }
    });

    els.downloadAll.addEventListener("click", async () => {
      const zip = new JSZip();
      lastImages.forEach((img) => zip.file(`image_p${img.page}_${img.index}.png`, img.blob));
      const blob = await zip.generateAsync({ type: "blob" });
      Utils.downloadBlob(blob, Utils.triggerDownloadName(current.name, "_images", "zip"));
    });
  }

  return { init };
})();
