window.Tools = window.Tools || {};
Tools.merge = (function () {
  let order = []; // array of pool entries, in merge order

  function syncOrder(selectedEntries) {
    const selectedIds = new Set(selectedEntries.map((e) => e.id));
    order = order.filter((e) => selectedIds.has(e.id));
    const known = new Set(order.map((e) => e.id));
    selectedEntries.forEach((e) => {
      if (!known.has(e.id)) order.push(e);
    });
  }

  function renderList(listEl, runBtn) {
    listEl.innerHTML = "";
    order.forEach((entry, idx) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = `${idx + 1}. ${entry.name} (${Utils.formatBytes(entry.size)})`;
      const btns = document.createElement("span");
      btns.className = "btns";

      const upBtn = document.createElement("button");
      upBtn.textContent = "↑";
      upBtn.disabled = idx === 0;
      upBtn.addEventListener("click", () => {
        [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
        renderList(listEl, runBtn);
      });

      const downBtn = document.createElement("button");
      downBtn.textContent = "↓";
      downBtn.disabled = idx === order.length - 1;
      downBtn.addEventListener("click", () => {
        [order[idx + 1], order[idx]] = [order[idx], order[idx + 1]];
        renderList(listEl, runBtn);
      });

      btns.append(upBtn, downBtn);
      li.append(name, btns);
      listEl.appendChild(li);
    });
    runBtn.disabled = order.length < 1;
  }

  function init() {
    const picker = document.getElementById("merge-picker");
    const listEl = document.getElementById("merge-list");
    const runBtn = document.getElementById("merge-run");
    const statusEl = document.getElementById("merge-status");

    FilePicker.mount(picker, {
      accept: "pdf",
      multi: true,
      onChange: (selected) => {
        syncOrder(selected);
        renderList(listEl, runBtn);
      },
    });

    runBtn.addEventListener("click", async () => {
      runBtn.disabled = true;
      Utils.setStatus(statusEl, "Объединение...", "info");
      try {
        const merged = await PDFLib.PDFDocument.create();
        for (const entry of order) {
          const bytes = await Pool.getBytes(entry.id);
          const donor = await Utils.loadPdfLibDocument(bytes);
          const pages = await merged.copyPages(donor, donor.getPageIndices());
          pages.forEach((p) => merged.addPage(p));
        }
        const outBytes = await merged.save();
        Utils.downloadBlob(new Blob([outBytes], { type: "application/pdf" }), "merged.pdf");
        Utils.setStatus(statusEl, `Готово: объединено файлов — ${order.length}.`, "success");
      } catch (err) {
        console.error(err);
        Utils.setStatus(statusEl, "Ошибка: " + err.message, "error");
      } finally {
        runBtn.disabled = order.length < 1;
      }
    });
  }

  return { init };
})();
