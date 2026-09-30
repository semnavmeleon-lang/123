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

// Формы со «сложными» полями: обёртки, label, contenteditable, shadow DOM, динамический id, неоднозначные блоки
function formsPage() {
  return page(
    `<div id="wrap1" class="field"><span class="ph">Введите ФИО</span><input id="real1"></div>
     <div id="wrap2" class="field"><label for="real2" id="lbl2">Телефон</label><input id="real2"></div>
     <div id="ambig"><input id="a1"><input id="a2"></div>
     <div id="plain">просто текст</div>
     <div id="ce" contenteditable="true">старый текст</div>
     <div id="host"></div>
     <input type="checkbox" id="cb">
     <div id="wrap3" class="mat"><div class="frame"><input id="mat-input-123456" placeholder="Фамилия"></div></div>
     <formly-field class="ng-star-inserted"><p-calendar id="formly_46_date-range_contractIssueDate_1" class="ng-untouched ng-pristine"><span class="ng-tns-c196-13 p-calendar ng-star-inserted"><input type="text" class="p-inputtext p-component ng-tns-c196-13" onblur="this.dataset.blurred='yes'"><button type="button" class="p-datepicker-trigger">cal</button></span></p-calendar></formly-field>
     <formly-field class="ng-star-inserted"><p-calendar id="formly_46_date-range_contractIssueDate_2" class="ng-untouched ng-pristine"><span class="ng-tns-c196-13 p-calendar ng-star-inserted"><input type="text" class="p-inputtext p-component ng-tns-c196-13" onblur="this.dataset.blurred='yes'"><button type="button" class="p-datepicker-trigger">cal</button></span></p-calendar></formly-field>`,
    `const root = document.getElementById("host").attachShadow({ mode: "open" });
     root.innerHTML = '<input id="sh" placeholder="в shadow DOM">';`
  );
}

module.exports = function start() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (u.pathname === "/policy") return res.end(policyPage(u.searchParams.get("n")));
      if (u.pathname === "/forms") return res.end(formsPage());
      // ячейка списка результатов собрана из отдельных элементов (слова без пробелов между ними), карточка - обычным текстом
      if (u.pathname === "/names") {
        return res.end(page(`<div id="cell"><span>Еременко</span><span>Сергей</span><span>Иванович</span></div>
          <div id="cell2"><div>Дорохин</div><div>Виктор</div><div>Анатольевич</div></div>
          <div id="cell3"><b>Пет</b>ров<br>Пётр</div>
          <div id="card"><span>Еременко Сергей Иванович, дата рождения: 05.10.1968</span></div>
          <div id="card2"><span>Иванов Иван Иванович, дата рождения: 01.01.1980</span></div>
          <div id="pre">  много    пробелов
            и строк  </div>
          <div id="hid">видно<script>window.x=1</script><style>.q{}</style></div>`));
      }
      res.end(searchPage());
    }).listen(0, () => resolve({ server, port: server.address().port }));
  });
};
