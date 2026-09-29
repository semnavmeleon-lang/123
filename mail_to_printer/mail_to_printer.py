#!/usr/bin/env python3
"""Отправленные письма -> PDF -> (виртуальный) принтер.

Скрипт берёт письма из папки «Отправленные», которых он ещё не обрабатывал,
превращает каждое в PDF (через headless Chromium) и отправляет этот PDF
на указанный принтер и/или складывает в папку.

Откуда берутся письма ([mail] backend в config.ini):
  imap     — по IMAP (Gmail, Яндекс, Mail.ru, Exchange с включённым IMAP и паролем);
  outlook  — напрямую из установленного на Windows Outlook (COM), без паролей и OAuth:
             подходит для корпоративного Outlook/Microsoft 365, где IMAP по паролю отключён.

Запуск:
    python mail_to_printer.py --config config.ini            # один проход (для cron / Планировщика)
    python mail_to_printer.py --config config.ini --watch    # работать постоянно, опрос раз в N секунд
"""
from __future__ import annotations

import argparse
import base64
import configparser
import email
import email.policy
import email.utils
import html
import hashlib
import imaplib
import json
import logging
import mimetypes
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from email.message import EmailMessage
from pathlib import Path

log = logging.getLogger("mail_to_printer")

MAX_ATTEMPTS = 3  # сколько раз пробуем письмо, которое упало с ошибкой
SENT_FALLBACK_NAMES = (
    "Sent", "Sent Items", "Sent Messages", "INBOX.Sent", "[Gmail]/Sent Mail",
    "Отправленные", "Отправленные письма", "INBOX.Отправленные",
)
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


# --------------------------------------------------------------------------- конфиг

@dataclass
class Config:
    backend: str = "imap"          # imap | outlook
    host: str = ""
    port: int = 993
    ssl: bool = True
    user: str = ""
    password: str = ""
    sent_folder: str = ""          # пусто = определить автоматически
    printer: str = ""              # имя принтера в системе; пусто = не печатать
    print_cmd: str = ""            # шаблон команды печати; пусто = по умолчанию для ОС
    output_dir: str = ""           # куда складывать копии PDF; пусто = не сохранять
    state_file: str = "state.json"
    poll_seconds: int = 60
    load_remote_images: bool = False
    browser_path: str = ""         # msedge | chrome | путь к браузеру; пусто = браузер Playwright


def load_config(path: str) -> Config:
    cp = configparser.ConfigParser(interpolation=None)
    if not cp.read(path, encoding="utf-8"):
        sys.exit(f"Не найден файл настроек: {path} (скопируйте config.example.ini)")
    m, o = cp["mail"], cp["output"] if cp.has_section("output") else {}
    cfg = Config(
        backend=m.get("backend", "imap").strip().lower(),
        host=m.get("host", "").strip(),
        port=m.getint("port", 993),
        ssl=m.getboolean("ssl", True),
        user=m.get("user", "").strip(),
        password=os.environ.get("MAIL_PASSWORD") or m.get("password", ""),
        sent_folder=m.get("sent_folder", "").strip(),
        printer=(o.get("printer", "") if o else "").strip(),
        print_cmd=(o.get("print_cmd", "") if o else "").strip(),
        output_dir=(o.get("output_dir", "") if o else "").strip(),
        state_file=(o.get("state_file", "state.json") if o else "state.json").strip(),
        poll_seconds=int(o.get("poll_seconds", 60)) if o else 60,
        load_remote_images=str(o.get("load_remote_images", "no")).lower() in ("1", "yes", "true", "on") if o else False,
        browser_path=(o.get("browser_path", "") if o else "").strip(),
    )
    if cfg.backend not in ("imap", "outlook"):
        sys.exit(f"[mail] backend = {cfg.backend!r}: допустимо imap или outlook")
    if cfg.backend == "imap":
        if not cfg.host or not cfg.user:
            sys.exit("Для backend = imap нужны [mail] host и user.")
        if not cfg.password:
            sys.exit("Пароль не задан: укажите его в переменной окружения MAIL_PASSWORD "
                     "или в [mail] password (для Gmail/Яндекс/Mail.ru нужен пароль приложения).")
    if not cfg.printer and not cfg.output_dir:
        sys.exit("В [output] нужно указать printer и/или output_dir, иначе PDF некуда девать.")
    return cfg


# --------------------------------------------------------------------------- IMAP

def imap_utf7_encode(s: str) -> str:
    """Имя папки -> modified UTF-7 (RFC 3501), нужно для «Отправленные» и т.п."""
    out, buf = [], []

    def flush():
        if buf:
            b64 = base64.b64encode("".join(buf).encode("utf-16-be")).decode().rstrip("=")
            out.append("&" + b64.replace("/", ",") + "-")
            buf.clear()

    for ch in s:
        if 0x20 <= ord(ch) <= 0x7E:
            flush()
            out.append("&-" if ch == "&" else ch)
        else:
            buf.append(ch)
    flush()
    return "".join(out)


def imap_quote(name: str) -> str:
    return '"' + name.replace("\\", "\\\\").replace('"', '\\"') + '"'


_LIST_RE = re.compile(rb'\((?P<flags>[^)]*)\)\s+(?P<delim>"[^"]*"|NIL)\s+(?P<name>.+)$')


def find_sent_folder(imap: imaplib.IMAP4, wanted: str = "") -> str:
    """Вернуть имя папки в том виде, в каком его надо отдавать в SELECT (уже в кавычках)."""
    if wanted:
        return imap_quote(imap_utf7_encode(wanted))
    typ, data = imap.list()
    if typ != "OK":
        raise RuntimeError("IMAP LIST не удался")
    names: list[tuple[str, bool]] = []  # (raw name, has \Sent flag)
    for line in data:
        if not isinstance(line, bytes):
            continue
        m = _LIST_RE.match(line)
        if not m:
            continue
        raw = m["name"].decode("ascii", "replace").strip()
        if raw.startswith('"') and raw.endswith('"'):
            raw = raw[1:-1].replace('\\"', '"').replace("\\\\", "\\")
        names.append((raw, rb"\sent" in m["flags"].lower()))
    for raw, is_sent in names:
        if is_sent:
            return imap_quote(raw)
    lowered = {raw.lower(): raw for raw, _ in names}
    for cand in SENT_FALLBACK_NAMES:
        hit = lowered.get(imap_utf7_encode(cand).lower())
        if hit:
            return imap_quote(hit)
    raise RuntimeError("Не нашёл папку «Отправленные». Укажите её в конфиге: [mail] sent_folder = ...")


def imap_date(d: datetime) -> str:
    return f"{d.day:02d}-{MONTHS[d.month - 1]}-{d.year}"  # без локали, IMAP требует англ. месяцы


def connect(cfg: Config) -> imaplib.IMAP4:
    imap = imaplib.IMAP4_SSL(cfg.host, cfg.port) if cfg.ssl else imaplib.IMAP4(cfg.host, cfg.port)
    imap.login(cfg.user, cfg.password)
    return imap


# --------------------------------------------------------------------------- состояние

class State:
    """last_uid по каждой паре (ящик, папка) + pending: письма в очереди (uid -> число неудачных попыток)."""

    def __init__(self, path: str):
        self.path = Path(path)
        try:
            self.data = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            self.data = {}

    def get(self, key: str) -> dict | None:
        return self.data.get(key)

    def set(self, key: str, entry: dict) -> None:
        self.data[key] = entry
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, self.path)  # атомарно: не потеряем состояние при падении


# --------------------------------------------------------------------------- письмо -> HTML

def _safe_name(text: str, limit: int = 80) -> str:
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", text).strip(" .")
    return text[:limit] or "no_subject"


def _fmt_size(n: int) -> str:
    for unit in ("Б", "КБ", "МБ", "ГБ"):
        if n < 1024 or unit == "ГБ":
            return f"{n:.0f} {unit}" if unit == "Б" else f"{n:.1f} {unit}"
        n /= 1024
    return ""


@dataclass
class Mail:
    """Письмо в нейтральном виде: не важно, откуда оно пришло (IMAP или Outlook)."""
    subject: str
    sent_at: datetime | None
    headers: list[tuple[str, str]]          # (подпись, значение) для шапки в PDF
    body: str
    is_html: bool
    cids: dict[str, str] = field(default_factory=dict)   # Content-ID -> data:URI встроенной картинки
    attachments: list[str] = field(default_factory=list)  # «имя (размер)»


def mail_from_email(msg: EmailMessage) -> Mail:
    body = msg.get_body(preferencelist=("html", "plain"))
    if body is None:
        content, is_html = "", False
    else:
        try:
            content = body.get_content()
        except (LookupError, UnicodeDecodeError):  # битая/неизвестная кодировка
            content = body.get_payload(decode=True).decode("utf-8", "replace")
        is_html = body.get_content_subtype() == "html"

    cids = {}
    if is_html:
        for part in msg.walk():
            cid = part.get("Content-ID")
            if cid and part.get_content_maintype() == "image":
                data = part.get_payload(decode=True) or b""
                cids[cid.strip("<>")] = f"data:{part.get_content_type()};base64,{base64.b64encode(data).decode()}"

    try:
        sent_at = email.utils.parsedate_to_datetime(msg["Date"]) if msg["Date"] else None
    except (TypeError, ValueError):
        sent_at = None
    headers = [(label, str(msg[h])) for label, h in
               (("От", "From"), ("Кому", "To"), ("Копия", "Cc"), ("Дата", "Date"), ("Тема", "Subject")) if msg.get(h)]
    attachments = [
        f"{p.get_filename() or '(без имени)'} ({_fmt_size(len(p.get_payload(decode=True) or b''))})"
        for p in msg.iter_attachments() if p.get_content_disposition() == "attachment"
    ]
    return Mail(str(msg.get("Subject") or "(без темы)"), sent_at, headers, content, is_html, cids, attachments)


def render_html(mail: Mail) -> str:
    """Собрать самодостаточный HTML: шапка письма + тело + список вложений."""
    if mail.is_html:
        # inline-картинки: cid:xxx -> data:URI, чтобы они попали в PDF
        content = re.sub(r'cid:([^"\'\s)>]+)', lambda m: mail.cids.get(m[1], m[0]), mail.body, flags=re.I)
    else:
        content = f'<pre style="white-space:pre-wrap;font-family:inherit;margin:0">{html.escape(mail.body)}</pre>'

    rows = "".join(f"<tr><th>{label}:</th><td>{html.escape(value)}</td></tr>" for label, value in mail.headers)
    att_html = ("<div class='att'><b>Вложения:</b> " + "; ".join(html.escape(a) for a in mail.attachments) + "</div>"
                ) if mail.attachments else ""

    header_html = f"<div class='mailhdr'><table>{rows}</table></div>{att_html}"
    style = (
        "<meta charset='utf-8'><style>"
        "body{font-family:'Segoe UI',Arial,'DejaVu Sans',sans-serif}"
        ".mailhdr{border-bottom:2px solid #888;margin-bottom:14px;padding-bottom:8px;font-size:12px}"
        ".mailhdr th{text-align:right;vertical-align:top;padding-right:8px;color:#555;white-space:nowrap}"
        ".att{margin:0 0 12px;font-size:12px;color:#333}"
        "</style>"
    )
    if re.search(r"<body[^>]*>", content, re.I):
        return style + re.sub(r"(<body[^>]*>)", lambda m: m[1] + header_html, content, count=1, flags=re.I)
    return f"<!doctype html><html><head>{style}</head><body>{header_html}{content}</body></html>"


def message_to_html(msg: EmailMessage) -> str:
    return render_html(mail_from_email(msg))


# --------------------------------------------------------------------------- HTML -> PDF

class PdfRenderer:
    """Один браузер на всю пачку писем."""

    def __init__(self, browser_path: str = "", load_remote: bool = False):
        self.browser_path, self.load_remote = browser_path, load_remote

    def __enter__(self):
        from playwright.sync_api import sync_playwright  # импорт тут, чтобы --help работал без Playwright
        self._pw = sync_playwright().start()
        if self.browser_path.lower() in ("msedge", "chrome"):  # уже установленный в системе браузер, скачивать ничего не надо
            kwargs = {"channel": self.browser_path.lower()}
        else:
            kwargs = {"executable_path": self.browser_path} if self.browser_path else {}
        as_root = hasattr(os, "geteuid") and os.geteuid() == 0  # в контейнерах Chromium от root без этого не стартует
        self._browser = self._pw.chromium.launch(args=["--no-sandbox"] if as_root else [], **kwargs)
        return self

    def __exit__(self, *exc):
        self._browser.close()
        self._pw.stop()

    def render(self, html_text: str, out_path: Path) -> None:
        ctx = self._browser.new_context(java_script_enabled=False)  # письмо не должно исполнять скрипты
        try:
            page = ctx.new_page()
            if not self.load_remote:  # по умолчанию не ходим в сеть: быстрее и без трекинг-пикселей
                page.route("**/*", lambda r: r.continue_() if r.request.url.startswith(("data:", "about:")) else r.abort())
            page.set_content(html_text, wait_until="load")
            page.pdf(path=str(out_path), format="A4", print_background=True,
                     margin={"top": "15mm", "bottom": "15mm", "left": "12mm", "right": "12mm"})
        finally:
            ctx.close()


# --------------------------------------------------------------------------- печать

def default_print_cmd() -> str:
    if os.name != "nt":
        return "lp -d {printer} -t {title} {file}"  # CUPS: Linux и macOS
    for cand in (r"C:\Program Files\SumatraPDF\SumatraPDF.exe",
                 r"C:\Program Files (x86)\SumatraPDF\SumatraPDF.exe",
                 shutil.which("SumatraPDF") or ""):
        if cand and Path(cand).exists():
            return f'"{cand}" -print-to {{printer}} -silent {{file}}'
    raise RuntimeError("На Windows для тихой печати нужен SumatraPDF или свой print_cmd в конфиге.")


def send_to_printer(cfg: Config, pdf: Path, title: str) -> None:
    template = cfg.print_cmd or default_print_cmd()
    tokens = shlex.split(template, posix=(os.name != "nt"))
    if os.name == "nt":
        tokens = [t[1:-1] if len(t) > 1 and t[0] == t[-1] == '"' else t for t in tokens]
    # подстановка после разбора на аргументы: тема письма не может «выйти» из аргумента (нет shell-инъекции)
    argv = [t.format(printer=cfg.printer, file=str(pdf), title=title) for t in tokens]
    subprocess.run(argv, check=True, timeout=180, capture_output=True)


# --------------------------------------------------------------------------- основной цикл

def process_message(cfg: Config, renderer: PdfRenderer, mail: Mail, tag: str) -> str:
    """Письмо -> PDF -> принтер и/или output_dir. tag делает имя файла уникальным."""
    stamp = (mail.sent_at or datetime.now()).strftime("%Y-%m-%d_%H%M%S")
    filename = f"{stamp}_{tag}_{_safe_name(mail.subject)}.pdf"

    keep_dir = Path(cfg.output_dir) if cfg.output_dir else None
    if keep_dir:
        keep_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        pdf = (keep_dir or Path(tmp)) / filename
        renderer.render(render_html(mail), pdf)
        if cfg.printer:
            send_to_printer(cfg, pdf, mail.subject)
    return filename


def search_uids(imap: imaplib.IMAP4, *criteria: str) -> list[int]:
    typ, data = imap.uid("SEARCH", None, *criteria)
    if typ != "OK":
        raise RuntimeError(f"IMAP SEARCH {criteria} не удался")
    return sorted(int(x) for x in data[0].split())


def run_once(cfg: Config, state: State, *, backfill_all: bool = False, since: datetime | None = None) -> int:
    imap = connect(cfg)
    try:
        folder = find_sent_folder(imap, cfg.sent_folder)
        typ, _ = imap.select(folder, readonly=True)  # readonly: письма не трогаем
        if typ != "OK":
            raise RuntimeError(f"Не удалось открыть папку {folder}")
        uidvalidity = int(imap.response("UIDVALIDITY")[1][0])
        key = f"{cfg.user}|{folder}"
        entry = state.get(key)

        if entry is None or entry["uidvalidity"] != uidvalidity:
            if entry is not None:
                log.warning("UIDVALIDITY папки изменился — счётчик сброшен, старые письма пропускаю")
            existing = search_uids(imap, "ALL")
            # last_uid = самое свежее из уже лежащих писем: всё, что старше, считается обработанным
            entry = {"uidvalidity": uidvalidity, "last_uid": max(existing, default=0), "pending": {}}
            if backfill_all or since:
                backlog = search_uids(imap, "SINCE", imap_date(since)) if since else existing
                entry["pending"] = {str(u): 0 for u in backlog}  # попадут в очередь ниже, прогресс сохраняется
                log.info("Первый запуск: в очереди %d старых писем", len(backlog))
            else:
                log.info("Первый запуск: %d существующих писем пропущено, дальше обрабатываю только новые. "
                         "Чтобы обработать и старые — удалите state-файл и запустите с --all или "
                         "--since ГГГГ-ММ-ДД.", len(existing))
            state.set(key, entry)

        new_uids = [u for u in search_uids(imap, "UID", f"{entry['last_uid'] + 1}:*") if u > entry["last_uid"]]
        retry = [int(u) for u, n in entry["pending"].items() if n < MAX_ATTEMPTS]
        todo = sorted(set(new_uids) | set(retry))
        if not todo:
            log.debug("Новых писем нет")
            return 0

        done = 0
        with PdfRenderer(cfg.browser_path, cfg.load_remote_images) as renderer:
            for uid in todo:
                try:
                    typ, msg_data = imap.uid("FETCH", str(uid), "(BODY.PEEK[])")
                    raw = next(p[1] for p in msg_data if isinstance(p, tuple))
                    mail = mail_from_email(email.message_from_bytes(raw, policy=email.policy.default))
                    name = process_message(cfg, renderer, mail, str(uid))
                    entry["pending"].pop(str(uid), None)
                    log.info("OK  uid=%d -> %s", uid, name)
                    done += 1
                except Exception as exc:  # одно битое письмо не должно ронять остальные
                    entry["pending"][str(uid)] = entry["pending"].get(str(uid), 0) + 1
                    log.error("ОШИБКА uid=%d (попытка %d/%d): %s", uid, entry["pending"][str(uid)], MAX_ATTEMPTS, exc)
                if uid > entry["last_uid"]:
                    entry["last_uid"] = uid
                state.set(key, entry)  # сохраняем после каждого письма
        return done
    finally:
        try:
            imap.logout()
        except Exception:
            pass


# --------------------------------------------------------------------------- Outlook (COM, только Windows)
#
# Работает с классическим Outlook, установленным на этом же компьютере (не «новый Outlook» и не веб-версия):
# ни IMAP, ни пароля, ни регистрации приложения в Azure не нужно — используется уже настроенная учётка.

OL_FOLDER_SENT_MAIL = 5   # olFolderSentMail
OL_MAIL_ITEM = 43         # olMail
PR_ATTACH_CONTENT_ID = "http://schemas.microsoft.com/mapi/proptag/0x3712001F"
OUTLOOK_LOOKBACK = timedelta(hours=3)   # перестраховка: письмо могло «доехать» в Отправленные с опозданием / перевод часов
OUTLOOK_MAX_DONE = 1000                 # сколько EntryID помним в state.json
EPOCH = datetime(1970, 1, 1)


def open_outlook_sent_items():
    try:
        import win32com.client
    except ImportError:
        sys.exit("Для backend = outlook нужен pywin32 (только Windows):  pip install pywin32")
    try:
        ns = win32com.client.Dispatch("Outlook.Application").GetNamespace("MAPI")
        return ns.GetDefaultFolder(OL_FOLDER_SENT_MAIL).Items
    except Exception as exc:
        raise RuntimeError("Не удалось подключиться к Outlook. Нужен установленный классический Outlook "
                           "(не «новый Outlook»), запущенный под тем же пользователем, что и скрипт.") from exc


def _outlook_time(item) -> datetime | None:
    """Время отправки как «наивная» дата: ровно то, что показывает Outlook (в разных версиях pywin32 tz-метка врёт)."""
    for attr in ("SentOn", "CreationTime"):
        try:
            dt = getattr(item, attr)
        except Exception:
            continue
        if dt and dt.year < 3000:   # у неотправленных писем в SentOn стоит 4501 год
            return datetime(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second)
    return None


def _outlook_cid(att) -> str:
    try:
        return att.PropertyAccessor.GetProperty(PR_ATTACH_CONTENT_ID) or ""
    except Exception:
        return ""


def mail_from_outlook(item, tmpdir: Path) -> Mail:
    sent_at = _outlook_time(item)
    subject = str(item.Subject or "(без темы)")
    headers = [(label, str(getattr(item, attr, "") or "")) for label, attr in
               (("От", "SenderName"), ("Кому", "To"), ("Копия", "CC"))]
    headers = [(label, v) for label, v in headers if v]
    if sent_at:
        headers.append(("Дата", sent_at.strftime("%d.%m.%Y %H:%M")))
    headers.append(("Тема", subject))

    html_body = str(item.HTMLBody or "")
    is_html = bool(html_body.strip())
    body = html_body if is_html else str(item.Body or "")

    cids, attachments = {}, []
    for i in range(1, item.Attachments.Count + 1):
        att = item.Attachments.Item(i)
        name = str(att.FileName or "(без имени)")
        cid = _outlook_cid(att)
        if is_html and cid and f"cid:{cid}".lower() in html_body.lower():
            path = tmpdir / f"att{i}"
            att.SaveAsFile(str(path))
            mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
            cids[cid] = f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}"
        else:
            try:
                attachments.append(f"{name} ({_fmt_size(int(att.Size))})")
            except Exception:
                attachments.append(name)
    return Mail(subject, sent_at, headers, body, is_html, cids, attachments)


def run_once_outlook(cfg: Config, state: State, items, *, backfill_all: bool = False,
                     since: datetime | None = None) -> int:
    """Один проход по «Отправленным» Outlook. items — коллекция Items папки (или её заглушка в тестах).

    Состояние: watermark (время самого свежего обработанного письма) + список EntryID обработанных.
    Письма сканируются от новых к старым до watermark - OUTLOOK_LOOKBACK, уже обработанные отсеиваются по EntryID.
    """
    key = "outlook|sent"
    items.Sort("[SentOn]", True)  # от новых к старым; сортируем на стороне Outlook, не через Restrict (он зависит от локали)

    def mails_since(cutoff: datetime | None):
        for item in items:
            if getattr(item, "Class", None) != OL_MAIL_ITEM:
                continue
            t = _outlook_time(item)
            if t is None:
                continue
            if cutoff is not None and t < cutoff:
                return
            yield t, item

    entry = state.get(key)
    if entry is None:
        if backfill_all or since:
            floor = since or EPOCH
            entry = {"watermark": floor.isoformat(), "floor": floor.isoformat(), "done": [], "attempts": {}}
            log.info("Первый запуск: обработаю старые письма начиная с %s", floor.date() if since else "самого начала")
        else:
            latest = next(mails_since(None), None)
            newest = latest[0] if latest else datetime.now().replace(microsecond=0)
            skipped = [it.EntryID for _, it in mails_since(newest - OUTLOOK_LOOKBACK)]
            entry = {"watermark": newest.isoformat(), "floor": EPOCH.isoformat(), "done": skipped[-OUTLOOK_MAX_DONE:], "attempts": {}}
            state.set(key, entry)
            log.info("Первый запуск: существующие письма пропущены, дальше обрабатываю только новые. "
                     "Чтобы обработать и старые — удалите state-файл и запустите с --all или --since ГГГГ-ММ-ДД.")
            return 0

    watermark = datetime.fromisoformat(entry["watermark"])
    cutoff = max(watermark - OUTLOOK_LOOKBACK, datetime.fromisoformat(entry["floor"]))
    done = set(entry["done"])
    todo = sorted(((t, it) for t, it in mails_since(cutoff) if it.EntryID not in done), key=lambda x: x[0])
    if not todo:
        log.debug("Новых писем нет")
        return 0

    processed = 0
    with PdfRenderer(cfg.browser_path, cfg.load_remote_images) as renderer:
        for t, item in todo:
            eid = item.EntryID
            try:
                with tempfile.TemporaryDirectory() as tmp:
                    name = process_message(cfg, renderer, mail_from_outlook(item, Path(tmp)),
                                           hashlib.sha1(eid.encode()).hexdigest()[:8])
                log.info("OK  %s -> %s", t, name)
                processed += 1
            except Exception as exc:  # принтер недоступен, битое письмо и т.п.
                n = entry["attempts"][eid] = entry["attempts"].get(eid, 0) + 1
                log.error("ОШИБКА (%s, попытка %d/%d): %s", t, n, MAX_ATTEMPTS, exc)
                if n < MAX_ATTEMPTS:
                    state.set(key, entry)
                    break  # порядок важен: повторим это письмо на следующем проходе, следующие не трогаем
                log.error("Письмо пропущено после %d неудачных попыток", MAX_ATTEMPTS)
            entry["attempts"].pop(eid, None)
            entry["done"] = (entry["done"] + [eid])[-OUTLOOK_MAX_DONE:]
            watermark = max(watermark, t)
            entry["watermark"] = watermark.isoformat()
            state.set(key, entry)  # сохраняем после каждого письма
    return processed


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default="config.ini")
    ap.add_argument("--watch", action="store_true", help="не выходить, проверять ящик каждые poll_seconds секунд")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--all", action="store_true", help="при первом запуске обработать ВСЕ письма из «Отправленных»")
    g.add_argument("--since", metavar="ГГГГ-ММ-ДД", help="при первом запуске обработать письма начиная с даты")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    cfg = load_config(args.config)
    state = State(cfg.state_file)
    since = datetime.strptime(args.since, "%Y-%m-%d") if args.since else None

    def one_pass():
        if cfg.backend == "outlook":
            return run_once_outlook(cfg, state, open_outlook_sent_items(), backfill_all=args.all, since=since)
        return run_once(cfg, state, backfill_all=args.all, since=since)

    while True:
        try:
            one_pass()
        except KeyboardInterrupt:
            raise
        except Exception as exc:
            if not args.watch:
                raise
            log.error("Проход не удался, повторю позже: %s", exc)  # сеть моргнула — не падаем в режиме службы
        if not args.watch:
            break
        time.sleep(cfg.poll_seconds)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
