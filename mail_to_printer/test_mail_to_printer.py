"""Тесты без реальной почты: IMAP подменён заглушкой, печать — командой cp.

Запуск:  python -m unittest -v          (нужен Chromium, см. README; BROWSER_PATH=/путь/к/chrome при необходимости)
"""
import base64
import os
import tempfile
import unittest
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path
from unittest import mock

import mail_to_printer as m

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


def make_mail(subject, body="Привет, мир", html=None, attach=None, cid_image=False):
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = "Я <me@example.com>", "Вася <v@example.com>", subject
    msg["Date"] = "Tue, 29 Sep 2026 10:00:00 +0300"
    msg.set_content(body)
    if html:
        msg.add_alternative(html, subtype="html")
        if cid_image:
            msg.get_payload()[1].add_related(PNG, "image", "png", cid="<pic1>")
    if attach:
        msg.add_attachment(b"x" * 2048, maintype="application", subtype="octet-stream", filename=attach)
    return msg.as_bytes()


class FakeIMAP:
    """Минимум IMAP, который использует скрипт."""

    def __init__(self, mails, folders=None, uidvalidity=7):
        self.mails, self.uidvalidity = mails, uidvalidity  # {uid: bytes}
        self.folders = folders or [b'(\\HasNoChildren \\Sent) "/" "Sent"', b'(\\HasNoChildren) "/" "INBOX"']

    def list(self):
        return "OK", self.folders

    def select(self, folder, readonly=False):
        self.selected = folder
        return "OK", [b"1"]

    def response(self, name):
        return name, [str(self.uidvalidity).encode()]

    def uid(self, cmd, *args):
        if cmd == "SEARCH":
            crit = [a for a in args if a is not None]
            uids = sorted(self.mails)
            if crit[0] == "UID":
                lo = int(crit[1].split(":")[0])
                uids = [u for u in uids if u >= lo] or uids[-1:]  # реальный IMAP для n:* отдаёт хотя бы последнее
            return "OK", [b" ".join(str(u).encode() for u in uids)]
        if cmd == "FETCH":
            return "OK", [(b"1 (BODY[] {n}", self.mails[int(args[0])]), b")"]
        raise AssertionError(cmd)

    def logout(self):
        pass


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.printed = self.tmp / "printed"
        self.printed.mkdir()
        self.cfg = m.Config(
            host="x", user="me@example.com", password="p", printer="FAKE",
            print_cmd=f"cp {{file}} {self.printed}/",  # «принтер» просто копирует файл
            output_dir=str(self.tmp / "out"), state_file=str(self.tmp / "state.json"),
            browser_path=os.environ.get("BROWSER_PATH", ""),
        )
        self.state = m.State(self.cfg.state_file)

    def run_once(self, fake, **kw):
        with mock.patch.object(m, "connect", return_value=fake):
            return m.run_once(self.cfg, self.state, **kw)


class FlowTests(Base):
    def test_first_run_skips_existing_then_prints_only_new(self):
        fake = FakeIMAP({1: make_mail("старое"), 2: make_mail("тоже старое")})
        self.assertEqual(self.run_once(fake), 0)
        self.assertEqual(list(self.printed.iterdir()), [])
        fake.mails[3] = make_mail("Новое письмо")
        self.assertEqual(self.run_once(fake), 1)
        self.assertEqual(self.run_once(fake), 0)  # повторно не печатаем
        files = [p.name for p in self.printed.iterdir()]
        self.assertEqual(len(files), 1)
        self.assertIn("Новое письмо", files[0])
        self.assertTrue((self.printed / files[0]).read_bytes().startswith(b"%PDF"))
        self.assertEqual(len(list((self.tmp / "out").iterdir())), 1)  # копия в output_dir

    def test_all_backfills_everything(self):
        fake = FakeIMAP({1: make_mail("a"), 2: make_mail("b"), 3: make_mail("c")})
        self.assertEqual(self.run_once(fake, backfill_all=True), 3)
        self.assertEqual(len(list(self.printed.iterdir())), 3)
        self.assertEqual(self.run_once(fake), 0)

    def test_state_survives_restart(self):
        fake = FakeIMAP({1: make_mail("a")})
        self.run_once(fake)
        fake.mails[2] = make_mail("b")
        self.assertEqual(self.run_once(fake), 1)
        self.state = m.State(self.cfg.state_file)  # «перезапуск»
        self.assertEqual(self.run_once(fake), 0)

    def test_uidvalidity_change_does_not_reprint(self):
        fake = FakeIMAP({1: make_mail("a"), 2: make_mail("b")})
        self.run_once(fake)
        fake.uidvalidity = 99
        self.assertEqual(self.run_once(fake), 0)

    def test_print_failure_is_retried_then_given_up(self):
        fake = FakeIMAP({1: make_mail("a")})
        self.run_once(fake)
        fake.mails[2] = make_mail("плохое")
        self.cfg.print_cmd = "false {file}"
        for _ in range(m.MAX_ATTEMPTS + 2):
            self.assertEqual(self.run_once(fake), 0)
        (entry,) = self.state.data.values()
        self.assertEqual(entry["pending"], {"2": m.MAX_ATTEMPTS})  # дальше не мучаем
        self.assertEqual(entry["last_uid"], 2)  # но и очередь не блокируется
        self.cfg.print_cmd = f"cp {{file}} {self.printed}/"
        fake.mails[3] = make_mail("хорошее")
        self.assertEqual(self.run_once(fake), 1)

    def test_subject_cannot_inject_shell(self):
        marker = self.tmp / "pwned"
        fake = FakeIMAP({1: make_mail("a")})
        self.run_once(fake)
        fake.mails[2] = make_mail(f"x; touch {marker}")
        self.cfg.print_cmd = "true {title} {file}"
        self.assertEqual(self.run_once(fake), 1)
        self.assertFalse(marker.exists())


class RenderTests(Base):
    def pdf_text(self, path):
        from pypdf import PdfReader
        return "".join(p.extract_text() for p in PdfReader(path).pages)

    def test_html_with_inline_image_attachment_and_cyrillic(self):
        raw = make_mail("Счёт №5", html='<html><body><h1>Оплата</h1><img src="cid:pic1"></body></html>',
                        attach="счёт.xlsx", cid_image=True)
        fake = FakeIMAP({1: b""})
        self.run_once(fake)
        fake.mails[2] = raw
        self.run_once(fake)
        (pdf,) = (self.tmp / "out").iterdir()
        try:
            text = self.pdf_text(pdf)
        except ImportError:
            self.skipTest("pypdf не установлен")
        for needle in ("Оплата", "Вася", "Счёт №5", "счёт.xlsx"):
            self.assertIn(needle, text)

    def test_cid_replaced_by_data_uri(self):
        msg = m.email.message_from_bytes(make_mail("t", html='<img src="cid:pic1">', cid_image=True),
                                         policy=m.email.policy.default)
        self.assertIn("data:image/png;base64,", m.message_to_html(msg))

    def test_plain_text_is_escaped(self):
        msg = m.email.message_from_bytes(make_mail("t", body="<script>alert(1)</script> & co"),
                                         policy=m.email.policy.default)
        out = m.message_to_html(msg)
        self.assertNotIn("<script>", out)
        self.assertIn("&lt;script&gt;", out)


class MiniImapServer:
    """Крошечный настоящий IMAP-сервер на сокете: проверяет разбор ответов реальным imaplib."""

    def __init__(self, mails, uidvalidity=42):
        import socketserver
        import threading
        outer = self
        self.mails, self.uidvalidity = mails, uidvalidity

        class Handler(socketserver.StreamRequestHandler):
            def send(self, data: bytes):
                self.wfile.write(data)

            def handle(self):
                self.send(b"* OK ready\r\n")
                for line in self.rfile:
                    tag, _, rest = line.decode().rstrip("\r\n").partition(" ")
                    cmd = rest.split(" ")[0].upper()
                    if cmd == "CAPABILITY":
                        self.send(b"* CAPABILITY IMAP4rev1\r\n")
                    elif cmd == "LIST":
                        self.send(b'* LIST (\\HasNoChildren) "/" "INBOX"\r\n')
                        self.send(b'* LIST (\\HasNoChildren \\Sent) "/" "&BB4EQgQ,BEAEMAQyBDsENQQ9BD0ESwQ1-"\r\n')
                    elif cmd in ("SELECT", "EXAMINE"):
                        self.send(f"* {len(outer.mails)} EXISTS\r\n* OK [UIDVALIDITY {outer.uidvalidity}] ok\r\n".encode())
                    elif cmd == "UID" and rest.split(" ")[1].upper() == "SEARCH":
                        crit = rest.split(" ")[2:]
                        uids = sorted(outer.mails)
                        if crit[0] == "UID":
                            lo = int(crit[1].split(":")[0])
                            uids = [u for u in uids if u >= lo] or uids[-1:]
                        self.send(b"* SEARCH " + b" ".join(str(u).encode() for u in uids) + b"\r\n")
                    elif cmd == "UID" and rest.split(" ")[1].upper() == "FETCH":
                        uid = int(rest.split(" ")[2])
                        raw = outer.mails[uid]
                        self.send(f"* 1 FETCH (UID {uid} BODY[] {{{len(raw)}}}\r\n".encode() + raw + b")\r\n")
                    elif cmd == "LOGOUT":
                        self.send(b"* BYE\r\n" + tag.encode() + b" OK bye\r\n")
                        return
                    self.send(tag.encode() + b" OK done\r\n")

        self.server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class RealImaplibTests(Base):
    def test_end_to_end_over_real_imaplib(self):
        srv = MiniImapServer({1: make_mail("старое")})
        self.addCleanup(srv.close)
        self.cfg.host, self.cfg.port, self.cfg.ssl = "127.0.0.1", srv.port, False  # sent_folder не задан: ищем по \Sent
        self.assertEqual(m.run_once(self.cfg, self.state), 0)  # первый запуск: baseline
        srv.mails[2] = make_mail("Отправил клиенту")
        self.assertEqual(m.run_once(self.cfg, self.state), 1)
        self.assertEqual(m.run_once(self.cfg, self.state), 0)
        (name,) = [p.name for p in self.printed.iterdir()]
        self.assertIn("Отправил клиенту", name)


# ---------------------------------------------------------------- Outlook (заглушки COM-объектов)

class FakeProp:
    def __init__(self, cid):
        self.cid = cid

    def GetProperty(self, name):
        if not self.cid:
            raise RuntimeError("нет такого свойства")  # так COM ведёт себя у обычных вложений
        return self.cid


class FakeAtt:
    def __init__(self, name, data=b"x" * 2048, cid=""):
        self.FileName, self.Size, self._data, self.PropertyAccessor = name, len(data), data, FakeProp(cid)

    def SaveAsFile(self, path):
        Path(path).write_bytes(self._data)


class FakeAtts:
    def __init__(self, atts):
        self._atts, self.Count = atts, len(atts)

    def Item(self, i):  # в COM нумерация с 1
        return self._atts[i - 1]


class FakeItem:
    Class = 43

    def __init__(self, eid, subject, sent_on, html="", body="Привет", atts=(), to="Вася Иванов; Петя Сидоров"):
        self.EntryID, self.Subject, self.SentOn, self.HTMLBody, self.Body = eid, subject, sent_on, html, body
        self.SenderName, self.To, self.CC, self.Attachments = "Я Сам", to, "", FakeAtts(list(atts))


class FakeItems(list):
    def Sort(self, prop, descending):
        assert prop == "[SentOn]"
        self.sort(key=lambda i: i.SentOn, reverse=descending)


def at(hour, minute=0, day=29):
    return datetime(2026, 9, day, hour, minute)


class OutlookTests(Base):
    def setUp(self):
        super().setUp()
        self.cfg.backend = "outlook"

    def run_outlook(self, items, **kw):
        return m.run_once_outlook(self.cfg, self.state, items, **kw)

    def test_baseline_then_only_new(self):
        items = FakeItems([FakeItem("A", "старое", at(9)), FakeItem("B", "тоже старое", at(10))])
        self.assertEqual(self.run_outlook(items), 0)
        self.assertEqual(list(self.printed.iterdir()), [])
        items.append(FakeItem("C", "Новое из Outlook", at(11)))
        self.assertEqual(self.run_outlook(items), 1)
        self.assertEqual(self.run_outlook(items), 0)
        (name,) = [p.name for p in self.printed.iterdir()]
        self.assertIn("Новое из Outlook", name)
        self.assertIn("2026-09-29_110000", name)

    def test_all_backfills_oldest_first_and_since_filters(self):
        items = FakeItems([FakeItem("A", "a", at(9, day=1)), FakeItem("B", "b", at(9, day=15)), FakeItem("C", "c", at(9, day=28))])
        self.assertEqual(self.run_outlook(items, backfill_all=True), 3)
        self.state = m.State(str(self.tmp / "s2.json"))
        self.assertEqual(self.run_outlook(items, since=datetime(2026, 9, 10)), 2)

    def test_late_arriving_message_inside_lookback_is_not_lost(self):
        items = FakeItems([FakeItem("A", "a", at(10))])
        self.run_outlook(items)
        items.append(FakeItem("B", "b", at(11)))
        self.assertEqual(self.run_outlook(items), 1)
        items.append(FakeItem("L", "поздно доехало", at(10, 30)))  # старше watermark, но в пределах окна
        self.assertEqual(self.run_outlook(items), 1)
        self.assertEqual(self.run_outlook(items), 0)

    def test_unsent_sentinel_date_and_non_mail_items_are_ignored(self):
        weird = FakeItem("W", "черновик", datetime(2026, 1, 1))
        weird.SentOn, weird.CreationTime = datetime(4501, 1, 1), at(8)
        meeting = FakeItem("M", "встреча", at(9))
        meeting.Class = 53
        items = FakeItems([FakeItem("A", "a", at(10)), weird, meeting])
        self.assertEqual(self.run_outlook(items), 0)  # baseline
        items.append(FakeItem("N", "n", at(12)))
        self.assertEqual(self.run_outlook(items), 1)

    def test_failed_print_blocks_queue_then_gives_up_and_continues(self):
        items = FakeItems([FakeItem("A", "a", at(9))])
        self.run_outlook(items)
        items.extend([FakeItem("B", "плохое", at(10)), FakeItem("C", "после плохого", at(11))])
        self.cfg.print_cmd = "false {file}"
        self.assertEqual(self.run_outlook(items), 0)  # попытка 1: стоп, C не трогаем
        self.assertEqual(self.run_outlook(items), 0)  # попытка 2
        self.cfg.print_cmd = f"cp {{file}} {self.printed}/"
        self.assertEqual(self.run_outlook(items), 2)  # принтер ожил: B и потом C, в порядке отправки
        self.assertEqual(sorted(p.name[:17] for p in self.printed.iterdir()), ["2026-09-29_100000", "2026-09-29_110000"])

    def test_gives_up_after_max_attempts(self):
        items = FakeItems([FakeItem("A", "a", at(9))])
        self.run_outlook(items)
        items.extend([FakeItem("B", "плохое", at(10)), FakeItem("C", "после", at(11))])
        self.cfg.print_cmd = "false {file}"
        for _ in range(m.MAX_ATTEMPTS - 1):
            self.assertEqual(self.run_outlook(items), 0)
        # на последней попытке B отбрасывается, а C в этом же проходе тоже падает (принтер всё ещё сломан)
        self.assertEqual(self.run_outlook(items), 0)
        self.cfg.print_cmd = f"cp {{file}} {self.printed}/"
        items.append(FakeItem("D", "свежее", at(12)))
        self.assertEqual(self.run_outlook(items), 2)  # C (ей нужна ещё попытка) и D; B больше не всплывает
        self.assertNotIn("плохое", " ".join(p.name for p in self.printed.iterdir()))

    def test_inline_image_attachment_and_plain_text_conversion(self):
        html_body = '<html><body><p>Счёт</p><img src="cid:logo@x"></body></html>'
        item = FakeItem("A", "Счёт №7", at(9), html=html_body,
                        atts=[FakeAtt("logo.png", PNG, cid="logo@x"), FakeAtt("счёт.xlsx"), FakeAtt("unused.png", PNG, cid="zzz")])
        with tempfile.TemporaryDirectory() as tmp:
            mail = m.mail_from_outlook(item, Path(tmp))
        self.assertIn("data:image/png;base64,", m.render_html(mail))
        self.assertEqual(sorted(mail.attachments), [f"unused.png ({m._fmt_size(len(PNG))})", "счёт.xlsx (2.0 КБ)"])
        self.assertIn(("Кому", "Вася Иванов; Петя Сидоров"), mail.headers)
        plain = m.mail_from_outlook(FakeItem("B", "t", at(9), html="", body="<b>не html</b> & co"), Path(tmp))
        self.assertFalse(plain.is_html)
        self.assertIn("&lt;b&gt;", m.render_html(plain))

    def test_outlook_pdf_contains_text(self):
        items = FakeItems([FakeItem("A", "a", at(9))])
        self.run_outlook(items)
        items.append(FakeItem("B", "Договор №12", at(10), body="Прошу подписать договор"))
        self.run_outlook(items)
        (pdf,) = (self.tmp / "out").iterdir()
        try:
            from pypdf import PdfReader
        except BaseException:
            self.skipTest("pypdf не установлен")
        text = "".join(pg.extract_text() for pg in PdfReader(pdf).pages)
        for needle in ("Договор №12", "Прошу подписать", "Вася Иванов"):
            self.assertIn(needle, text)


class ImapHelpersTests(unittest.TestCase):
    def test_utf7(self):
        self.assertEqual(m.imap_utf7_encode("Отправленные"), "&BB4EQgQ,BEAEMAQyBDsENQQ9BD0ESwQ1-")
        self.assertEqual(m.imap_utf7_encode("A&B"), "A&-B")
        self.assertEqual(m.imap_utf7_encode("Sent Items"), "Sent Items")

    def test_find_sent_by_flag(self):
        f = FakeIMAP({}, folders=[b'(\\HasNoChildren) "/" "INBOX"', b'(\\HasNoChildren \\Sent) "/" "[Gmail]/Sent Mail"'])
        self.assertEqual(m.find_sent_folder(f), '"[Gmail]/Sent Mail"')

    def test_find_sent_by_russian_name(self):
        f = FakeIMAP({}, folders=[b'(\\HasNoChildren) "/" "INBOX"',
                                  b'(\\HasNoChildren) "/" "&BB4EQgQ,BEAEMAQyBDsENQQ9BD0ESwQ1-"'])
        self.assertEqual(m.find_sent_folder(f), '"&BB4EQgQ,BEAEMAQyBDsENQQ9BD0ESwQ1-"')

    def test_find_sent_missing_gives_clear_error(self):
        f = FakeIMAP({}, folders=[b'(\\HasNoChildren) "/" "INBOX"'])
        with self.assertRaisesRegex(RuntimeError, "sent_folder"):
            m.find_sent_folder(f)

    def test_imap_date_is_locale_independent(self):
        from datetime import datetime
        self.assertEqual(m.imap_date(datetime(2026, 1, 5)), "05-Jan-2026")


if __name__ == "__main__":
    unittest.main()
