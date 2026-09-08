/* global Office */

Office.onReady(() => {
  const btn = document.getElementById("saveBtn");
  if (btn) btn.addEventListener("click", onSaveClick);

  if (!isAttachmentContentSupported()) {
    const checkbox = document.getElementById("includeAttachments");
    const hint = document.getElementById("attachmentsHint");
    if (checkbox) {
      checkbox.checked = false;
      checkbox.disabled = true;
    }
    if (hint) {
      hint.textContent =
        "Вложения недоступны: ваш почтовый сервер (Exchange) не поддерживает нужную версию API Outlook. Письмо сохранится без вложений.";
      hint.hidden = false;
    }
  }
});

function isAttachmentContentSupported() {
  return (
    Office.context.requirements &&
    Office.context.requirements.isSetSupported("Mailbox", "1.8")
  );
}

function setStatus(msg, kind) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.className = kind || "";
}

function onSaveClick() {
  const btn = document.getElementById("saveBtn");
  btn.disabled = true;
  setStatus("Читаю письмо…");

  saveCurrentEmail()
    .then((fileName) => {
      setStatus(
        "Открылось отдельное окно — нажмите в нём «Скачать .eml», чтобы сохранить: " + fileName,
        "ok"
      );
    })
    .catch((err) => {
      console.error(err);
      setStatus("Ошибка: " + (err && err.message ? err.message : err), "error");
    })
    .finally(() => {
      btn.disabled = false;
    });
}

async function saveCurrentEmail() {
  const item = Office.context.mailbox.item;
  if (!item) {
    throw new Error("Не удалось получить открытое письмо.");
  }

  const includeAttachments = document.getElementById("includeAttachments").checked;

  const [htmlBody, attachments] = await Promise.all([
    getBodyHtml(item),
    includeAttachments ? getAttachments(item) : Promise.resolve([]),
  ]);

  const eml = buildEml(item, htmlBody, attachments);
  const fileName = sanitizeFileName(item.subject || "Без темы") + ".eml";
  await openDownloadDialog(eml, fileName);
  return fileName;
}

function openDownloadDialog(eml, fileName) {
  // Outlook's task pane runs in a restricted webview that silently blocks
  // programmatic file downloads. Office Dialog API opens a real top-level
  // window instead, where a user click reliably triggers a save.
  localStorage.setItem("svEmailContent", eml);
  localStorage.setItem("svEmailFileName", fileName);

  return new Promise((resolve, reject) => {
    Office.context.ui.displayDialogAsync(
      "https://localhost:3000/download.html",
      { height: 25, width: 30, promptBeforeOpen: false },
      (result) => {
        if (result.status === Office.AsyncResultStatus.Succeeded) {
          resolve();
        } else {
          reject(result.error);
        }
      }
    );
  });
}

function getBodyHtml(item) {
  return new Promise((resolve, reject) => {
    item.body.getAsync(Office.CoercionType.Html, (result) => {
      if (result.status === Office.AsyncResultStatus.Succeeded) {
        resolve(result.value);
      } else {
        reject(result.error);
      }
    });
  });
}

function getAttachments(item) {
  if (!isAttachmentContentSupported()) {
    return Promise.resolve([]);
  }
  const cloudType = Office.MailboxEnums && Office.MailboxEnums.AttachmentType
    ? Office.MailboxEnums.AttachmentType.Cloud
    : "cloud";
  const list = (item.attachments || []).filter(
    (a) => !a.isInline && a.attachmentType !== cloudType
  );
  return Promise.all(list.map((a) => getAttachmentContent(item, a)));
}

function getAttachmentContent(item, attachment) {
  return new Promise((resolve, reject) => {
    item.getAttachmentContentAsync(attachment.id, (result) => {
      if (result.status === Office.AsyncResultStatus.Succeeded) {
        const content = result.value;
        resolve({
          name: attachment.name || "attachment",
          contentType: attachment.contentType || "application/octet-stream",
          format: content.format,
          content: content.content,
        });
      } else {
        reject(result.error);
      }
    });
  });
}

function buildEml(item, htmlBody, attachments) {
  const boundary =
    "----=_SaveEmailAddIn_" + Date.now().toString(16) + Math.random().toString(16).slice(2);

  const headers = [];
  headers.push("MIME-Version: 1.0");
  headers.push("Subject: " + encodeHeaderText(item.subject || "(без темы)"));
  headers.push("From: " + formatAddress(item.from));

  const to = formatAddressList(item.to);
  if (to) headers.push("To: " + to);

  const cc = formatAddressList(item.cc);
  if (cc) headers.push("Cc: " + cc);

  headers.push("Date: " + formatDate(item.dateTimeCreated));
  if (item.internetMessageId) headers.push("Message-ID: " + item.internetMessageId);
  headers.push('Content-Type: multipart/mixed; boundary="' + boundary + '"');
  headers.push("X-Saved-By: Outlook Save Email Add-in");

  const bodyPart = [
    "--" + boundary,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(base64EncodeUnicode(htmlBody || "")),
    "",
  ].join("\r\n");

  const attachmentContentFormatBase64 =
    Office.MailboxEnums && Office.MailboxEnums.AttachmentContentFormat
      ? Office.MailboxEnums.AttachmentContentFormat.Base64
      : "base64";

  const attachmentParts = attachments
    .map((att) => {
      const ct = att.contentType || "application/octet-stream";
      const encodedName = encodeHeaderText(att.name);
      const content =
        att.format === attachmentContentFormatBase64
          ? att.content
          : base64EncodeUnicode(att.content);
      return [
        "--" + boundary,
        "Content-Type: " + ct + '; name="' + encodedName + '"',
        "Content-Transfer-Encoding: base64",
        'Content-Disposition: attachment; filename="' + encodedName + '"',
        "",
        wrapBase64(content),
        "",
      ].join("\r\n");
    })
    .join("");

  return (
    headers.join("\r\n") +
    "\r\n\r\n" +
    bodyPart +
    attachmentParts +
    "--" +
    boundary +
    "--\r\n"
  );
}

function formatAddress(addr) {
  if (!addr || !addr.emailAddress) return "";
  const name = addr.displayName && addr.displayName.trim();
  if (!name) return "<" + addr.emailAddress + ">";
  return encodeHeaderText(name) + " <" + addr.emailAddress + ">";
}

function formatAddressList(list) {
  return (list || []).map(formatAddress).filter(Boolean).join(", ");
}

function formatDate(date) {
  const d = date ? new Date(date) : new Date();
  return d.toUTCString().replace("GMT", "+0000");
}

function encodeHeaderText(text) {
  if (/^[\x20-\x7E]*$/.test(text)) {
    if (/[",;<>]/.test(text)) {
      return '"' + text.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    }
    return text;
  }
  const chunks = [];
  for (let i = 0; i < text.length; i += 20) {
    chunks.push(text.slice(i, i + 20));
  }
  return chunks.map((c) => "=?UTF-8?B?" + base64EncodeUnicode(c) + "?=").join("\r\n ");
}

function base64EncodeUnicode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function wrapBase64(b64) {
  return b64.replace(/(.{76})/g, "$1\r\n");
}

function sanitizeFileName(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 150) || "email";
}
