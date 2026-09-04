window.Tools = window.Tools || {};
Tools.forms = (function () {
  let currentFile = null;
  let pdfDocRef = null;
  let applyFns = [];

  function buildFieldControl(field) {
    const name = field.getName();
    const wrapper = document.createElement("div");

    if (field instanceof PDFLib.PDFTextField) {
      const label = document.createElement("label");
      label.textContent = name;
      const input = field.isMultiline() ? document.createElement("textarea") : document.createElement("input");
      if (input.tagName === "INPUT") input.type = "text";
      try {
        input.value = field.getText() || "";
      } catch (e) {
        input.value = "";
      }
      label.appendChild(input);
      wrapper.appendChild(label);
      return { el: wrapper, apply: () => field.setText(input.value) };
    }

    if (field instanceof PDFLib.PDFCheckBox) {
      const label = document.createElement("label");
      label.className = "checkbox-row";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = field.isChecked();
      label.append(input, document.createTextNode(" " + name));
      wrapper.appendChild(label);
      return { el: wrapper, apply: () => (input.checked ? field.check() : field.uncheck()) };
    }

    if (field instanceof PDFLib.PDFRadioGroup) {
      const title = document.createElement("div");
      title.textContent = name;
      wrapper.appendChild(title);
      const options = field.getOptions();
      const selected = field.getSelected();
      const radioInputs = [];
      options.forEach((opt) => {
        const optLabel = document.createElement("label");
        optLabel.className = "field-row";
        const input = document.createElement("input");
        input.type = "radio";
        input.checked = opt === selected;
        optLabel.append(input, document.createTextNode(" " + opt));
        wrapper.appendChild(optLabel);
        radioInputs.push({ input, opt });
      });
      return {
        el: wrapper,
        apply: () => {
          const chosen = radioInputs.find((r) => r.input.checked);
          if (chosen) field.select(chosen.opt);
        },
      };
    }

    if (field instanceof PDFLib.PDFDropdown) {
      const label = document.createElement("label");
      label.textContent = name;
      const select = document.createElement("select");
      field.getOptions().forEach((opt) => {
        const o = document.createElement("option");
        o.value = opt;
        o.textContent = opt;
        select.appendChild(o);
      });
      const selected = field.getSelected();
      if (selected && selected[0] !== undefined) select.value = selected[0];
      label.appendChild(select);
      wrapper.appendChild(label);
      return { el: wrapper, apply: () => field.select(select.value) };
    }

    if (field instanceof PDFLib.PDFOptionList) {
      const label = document.createElement("label");
      label.textContent = name + " (можно выбрать несколько — Ctrl/Cmd+клик)";
      const select = document.createElement("select");
      select.multiple = true;
      field.getOptions().forEach((opt) => {
        const o = document.createElement("option");
        o.value = opt;
        o.textContent = opt;
        select.appendChild(o);
      });
      const selected = field.getSelected() || [];
      Array.from(select.options).forEach((o) => {
        o.selected = selected.includes(o.value);
      });
      label.appendChild(select);
      wrapper.appendChild(label);
      return {
        el: wrapper,
        apply: () => field.select(Array.from(select.selectedOptions).map((o) => o.value)),
      };
    }

    return null; // push buttons, signature fields: nothing to fill
  }

  async function loadFile(file, els) {
    currentFile = file;
    els.fieldsContainer.innerHTML = "";
    applyFns = [];
    Utils.setStatus(els.status, "Загрузка...", "info");
    try {
      const bytes = await Utils.readFileAsArrayBuffer(file);
      pdfDocRef = await Utils.loadPdfLibDocument(bytes);
      const form = pdfDocRef.getForm();
      const fields = form.getFields();
      if (fields.length === 0) {
        Utils.setStatus(els.status, "В этом PDF нет полей формы (AcroForm).", "info");
        els.run.disabled = true;
        els.flattenRow.hidden = true;
        return;
      }
      fields.forEach((field) => {
        const built = buildFieldControl(field);
        if (built) {
          els.fieldsContainer.appendChild(built.el);
          applyFns.push(built.apply);
        }
      });
      els.flattenRow.hidden = false;
      els.run.disabled = false;
      Utils.setStatus(els.status, `Загружено: ${file.name} (${fields.length} полей)`, "success");
    } catch (err) {
      console.error(err);
      Utils.setStatus(els.status, "Ошибка чтения PDF: " + err.message, "error");
      els.run.disabled = true;
    }
  }

  function init() {
    const els = {
      dropzone: document.querySelector("#panel-forms .dropzone"),
      input: document.getElementById("forms-input"),
      fieldsContainer: document.getElementById("forms-fields"),
      flattenRow: document.getElementById("forms-flatten-row"),
      flatten: document.getElementById("forms-flatten"),
      run: document.getElementById("forms-run"),
      status: document.getElementById("forms-status"),
    };

    Utils.wireDropzone(els.dropzone, els.input, (files) => {
      if (files[0]) loadFile(files[0], els);
    });

    els.run.addEventListener("click", async () => {
      els.run.disabled = true;
      Utils.setStatus(els.status, "Сохранение...", "info");
      try {
        applyFns.forEach((apply) => apply());
        const form = pdfDocRef.getForm();
        const font = await Utils.embedUnicodeFont(pdfDocRef);
        form.updateFieldAppearances(font);
        if (els.flatten.checked) {
          form.flatten();
        }
        const bytes = await pdfDocRef.save({ updateFieldAppearances: false });
        Utils.downloadBlob(
          new Blob([bytes], { type: "application/pdf" }),
          Utils.triggerDownloadName(currentFile.name, "_filled", "pdf")
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
