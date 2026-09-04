window.Tools = window.Tools || {};
Tools.rotate = (function () {
  let currentFile = null;
  let currentBytes = null;
  let cards = [];

  function addControls(card) {
    const controls = document.createElement("div");
    controls.className = "thumb-controls";
    const leftBtn = document.createElement("button");
    leftBtn.textContent = "⟲";
    leftBtn.title = "Повернуть влево на 90°";
    leftBtn.addEventListener("click", () => rotateCard(card, -90));
    const rightBtn = document.createElement("button");
    rightBtn.textContent = "⟳";
    rightBtn.title = "Повернуть вправо на 90°";
    rightBtn.addEventListener("click", () => rotateCard(card, 90));
    controls.append(leftBtn, rightBtn);
    card.wrapper.appendChild(controls);
  }

  async function rotateCard(card, delta) {
    card.rotation = (((card.rotation + delta) % 360) + 360) % 360;
    await Thumbnails.renderCanvas(card, 120);
  }

  async function loadFile(file, els) {
    currentFile = file;
    Utils.setStatus(els.status, "Загрузка...", "info");
    try {
      currentBytes = await Utils.readFileAsArrayBuffer(file);
      const pdfjsDoc = await Utils.loadPdfJsDocument(currentBytes);
      cards = await Thumbnails.render(els.thumbs, pdfjsDoc, {
        targetWidth: 120,
        onCardBuilt: addControls,
      });
      els.options.hidden = false;
      els.run.disabled = false;
      Utils.setStatus(els.status, `Загружено: ${file.name} (${cards.length} стр.)`, "success");
    } catch (err) {
      console.error(err);
      Utils.setStatus(els.status, "Ошибка чтения PDF: " + err.message, "error");
      els.run.disabled = true;
    }
  }

  function init() {
    const els = {
      dropzone: document.querySelector("#panel-rotate .dropzone"),
      input: document.getElementById("rotate-input"),
      thumbs: document.getElementById("rotate-thumbs"),
      options: document.getElementById("rotate-options"),
      run: document.getElementById("rotate-run"),
      status: document.getElementById("rotate-status"),
      allLeft: document.getElementById("rotate-all-left"),
      allRight: document.getElementById("rotate-all-right"),
    };

    Utils.wireDropzone(els.dropzone, els.input, (files) => {
      if (files[0]) loadFile(files[0], els);
    });

    els.allLeft.addEventListener("click", () => cards.forEach((c) => rotateCard(c, -90)));
    els.allRight.addEventListener("click", () => cards.forEach((c) => rotateCard(c, 90)));

    els.run.addEventListener("click", async () => {
      els.run.disabled = true;
      Utils.setStatus(els.status, "Сохранение...", "info");
      try {
        const donor = await Utils.loadPdfLibDocument(currentBytes);
        const out = await PDFLib.PDFDocument.create();
        const indices = cards.map((c) => c.index);
        const pages = await out.copyPages(donor, indices);
        pages.forEach((p, i) => {
          const card = cards[i];
          if (card.rotation !== 0) {
            const finalAngle = ((p.getRotation().angle + card.rotation) % 360 + 360) % 360;
            p.setRotation(PDFLib.degrees(finalAngle));
          }
          out.addPage(p);
        });
        const bytes = await out.save();
        Utils.downloadBlob(
          new Blob([bytes], { type: "application/pdf" }),
          Utils.triggerDownloadName(currentFile.name, "_rotated", "pdf")
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
