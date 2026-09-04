const Thumbnails = (function () {
  /**
   * Renders every page of a pdf.js document as a thumbnail card:
   *   <div class="thumb-card" data-index="N">
   *     <canvas>...</canvas>
   *     <div class="thumb-label">Стр. N+1</div>
   *   </div>
   * Returns an array of card descriptors: { index, wrapper, canvas, label, page, rotation }.
   * opts.onCardBuilt(card) is called after each card is appended, so callers
   * can attach checkboxes / buttons / drag handles specific to their tool.
   */
  async function render(containerEl, pdfjsDoc, opts) {
    opts = opts || {};
    const targetWidth = opts.targetWidth || 130;
    containerEl.innerHTML = "";
    const cards = [];
    const numPages = pdfjsDoc.numPages;
    for (let i = 1; i <= numPages; i++) {
      const page = await pdfjsDoc.getPage(i);
      const wrapper = document.createElement("div");
      wrapper.className = "thumb-card";
      wrapper.dataset.index = String(i - 1);

      const canvas = document.createElement("canvas");
      wrapper.appendChild(canvas);

      const label = document.createElement("div");
      label.className = "thumb-label";
      label.textContent = "Стр. " + i;
      wrapper.appendChild(label);

      containerEl.appendChild(wrapper);

      const card = { index: i - 1, wrapper, canvas, label, page, rotation: 0 };
      await renderCanvas(card, targetWidth);
      cards.push(card);
      if (opts.onCardBuilt) opts.onCardBuilt(card);
    }
    return cards;
  }

  /** Re-draws a card's canvas at its current `rotation` (added on top of the
   * page's own /Rotate entry). rotation must be a multiple of 90. */
  async function renderCanvas(card, targetWidth) {
    targetWidth = targetWidth || card.canvas.width || 130;
    const baseRotation = card.page.rotate || 0;
    const totalRotation = ((baseRotation + card.rotation) % 360 + 360) % 360;
    const probeViewport = card.page.getViewport({ scale: 1, rotation: totalRotation });
    const scale = targetWidth / probeViewport.width;
    const viewport = card.page.getViewport({ scale, rotation: totalRotation });
    card.canvas.width = Math.ceil(viewport.width);
    card.canvas.height = Math.ceil(viewport.height);
    const ctx = card.canvas.getContext("2d");
    await card.page.render({ canvasContext: ctx, viewport }).promise;
  }

  function clear(containerEl) {
    containerEl.innerHTML = "";
  }

  return { render, renderCanvas, clear };
})();
