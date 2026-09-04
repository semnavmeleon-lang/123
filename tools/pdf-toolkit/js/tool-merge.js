window.Tools = window.Tools || {};
Tools.merge = (function () {
  let files = [];

  function renderList(listEl, runBtn) {
    listEl.innerHTML = "";
    files.forEach((file, idx) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = `${idx + 1}. ${file.name} (${Utils.formatBytes(file.size)})`;
      const btns = document.createElement("span");
      btns.className = "btns";

      const upBtn = document.createElement("button");
      upBtn.textContent = "↑";
      upBtn.disabled = idx === 0;
      upBtn.addEventListener("click", () => {
        [files[idx - 1], files[idx]] = [files[idx], files[idx - 1]];
        renderList(listEl, runBtn);
      });

      const downBtn = document.createElement("button");
      downBtn.textContent = "↓";
      downBtn.disabled = idx === files.length - 1;
      downBtn.addEventListener("click", () => {
        [files[idx + 1], files[idx]] = [files[idx], files[idx + 1]];
        renderList(listEl, runBtn);
      });

      const removeBtn = document.createElement("button");
      removeBtn.textContent = "✕";
      removeBtn.addEventListener("click", () => {
        files.splice(idx, 1);
        renderList(listEl, runBtn);
      });

      btns.append(upBtn, downBtn, removeBtn);
      li.append(name, btns);
      listEl.appendChild(li);
    });
    runBtn.disabled = files.length < 1;
  }

  function init() {
    const panel = document.getElementById("panel-merge");
    const dropzone = panel.querySelector(".dropzone");
    const input = document.getElementById("merge-input");
    const listEl = document.getElementById("merge-list");
    const runBtn = document.getElementById("merge-run");
    const statusEl = document.getElementById("merge-status");

    Utils.wireDropzone(dropzone, input, (newFiles) => {
      const pdfFiles = newFiles.filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
      if (pdfFiles.length === 0) {
        Utils.setStatus(statusEl, "Выберите PDF-файлы.", "error");
        return;
      }
      files.push(...pdfFiles);
      Utils.setStatus(statusEl, "", "");
      renderList(listEl, runBtn);
    });

    runBtn.addEventListener("click", async () => {
      runBtn.disabled = true;
      Utils.setStatus(statusEl, "Объединение...", "info");
      try {
        const merged = await PDFLib.PDFDocument.create();
        for (const file of files) {
          const bytes = await Utils.readFileAsArrayBuffer(file);
          const donor = await Utils.loadPdfLibDocument(bytes);
          const pages = await merged.copyPages(donor, donor.getPageIndices());
          pages.forEach((p) => merged.addPage(p));
        }
        const outBytes = await merged.save();
        Utils.downloadBlob(new Blob([outBytes], { type: "application/pdf" }), "merged.pdf");
        Utils.setStatus(statusEl, `Готово: объединено файлов — ${files.length}.`, "success");
      } catch (err) {
        console.error(err);
        Utils.setStatus(statusEl, "Ошибка: " + err.message, "error");
      } finally {
        runBtn.disabled = files.length < 1;
      }
    });
  }

  return { init };
})();
