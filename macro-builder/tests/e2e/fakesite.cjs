// Имитация сайта: поиск -> результаты с меню «три точки» -> карточка полиса в новой вкладке.
const http = require("http");

const DB = [
  { fio: "Тишин Юрий Романович", policy: "25470CFI4440002174", status: "Действует", premium: "16 639,00" },
  { fio: "Шапарь Елена Игоревна", policy: "25470CFI4440009999", status: "Расторгнут", premium: "1 000,00" },
  { fio: "Шапарь Елена Ивановна", policy: "25470CFI4440002995", status: "Действует", premium: "90 507,00" },
  { fio: "Сломанов Пётр Ильич", policy: "BROKEN", status: "", premium: "" }, // карточка без нужных полей
];

const page = (body, script = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Fake</title></head><body>${body}<script>${script}</script></body></html>`;

function searchPage() {
  return page(
    `<input id="q" placeholder="ФИО"><button id="search">Искать</button>
     <div id="results"></div>`,
    `
    const DB = ${JSON.stringify(DB)};
    document.getElementById("search").addEventListener("click", () => {
      const q = document.getElementById("q").value.trim().toLowerCase().replace(/ё/g, "е");
      setTimeout(() => {
        const box = document.getElementById("results");
        const found = q ? DB.filter(p => p.fio.toLowerCase().replace(/ё/g, "е").includes(q.split(" ")[0])) : [];
        if (!found.length) { box.innerHTML = '<div class="empty">Ничего не найдено</div>'; return; }
        box.innerHTML = '<table>' + found.map(p => (
          '<tr class="row"><td class="name">' + p.fio + '</td><td class="num">' + p.policy + '</td>' +
          '<td><button class="dots" aria-label="Действия">⋮</button>' +
          '<div class="menu" style="display:none"><a class="view" target="_blank" href="/policy?n=' + p.policy + '">Посмотреть данные полиса</a>' +
          '<span class="other">Другое</span></div></td></tr>')).join("") + '</table>';
        // меню открывается ТОЛЬКО по pointerdown (как в Radix) - обычный click его не откроет
        box.querySelectorAll(".dots").forEach(b => b.addEventListener("pointerdown", () => {
          const m = b.parentElement.querySelector(".menu");
          m.style.display = m.style.display === "none" ? "block" : "none";
        }));
      }, 300);
    });`
  );
}

function policyPage(n) {
  const p = DB.find((x) => x.policy === n);
  if (!p) return page("<h1>Нет такого полиса</h1>");
  if (p.policy === "BROKEN") return page("<h1>Ошибка отображения</h1>");
  return page(`<h1>Полис ${p.policy}</h1><div id="holder">${p.fio}</div><div id="status">${p.status}</div><div id="premium">${p.premium}</div>`);
}

module.exports = function start() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (u.pathname === "/policy") return res.end(policyPage(u.searchParams.get("n")));
      res.end(searchPage());
    }).listen(0, () => resolve({ server, port: server.address().port }));
  });
};
