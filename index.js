import makeWASocket, {
  DisconnectReason,
  fetchLatestWaWebVersion,
  useMultiFileAuthState,
  Browsers
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import express from "express";
import cron from "node-cron";
import XLSX from "xlsx";
import fs from "fs";
import path from "path";

const PORT = Number(process.env.PORT || 10000);
const DATA_DIR = process.env.DATA_DIR || "./data";
const AUTH_DIR = path.join(DATA_DIR, "auth");
const DATA_FILE = path.join(DATA_DIR, "bot-data.json");

const START_WORD = "جديد";
const CANCEL_WORD = "إلغاء";
const CONFIRM_WORDS = new Set(["تأكيد", "تاكيد", "نعم"]);

const EMPLOYEE_NUMBERS = (process.env.EMPLOYEE_NUMBERS || "")
  .split(",")
  .map(normalizeNumber)
  .filter(Boolean);

const ALLOWED_GROUP_ID = (process.env.ALLOWED_GROUP_ID || "").trim();
const REPORT_TO_PHONE = normalizeNumber(process.env.REPORT_TO_PHONE || "");
const BOT_PHONE_NUMBER = normalizeNumber(process.env.BOT_PHONE_NUMBER || "");

function normalizeNumber(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function jidToNumber(jid) {
  if (!jid) return "";
  const part = String(jid).split("@")[0];
  return normalizeNumber(part);
}

function readData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return { transactions: [], sessions: {} };
    }
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (err) {
    console.error("DATA READ ERROR", err);
    return { transactions: [], sessions: {} };
  }
}

let data = readData();

function saveData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, DATA_FILE);
}

function sessionKey(groupId, employeeNumber) {
  return `${groupId}::${employeeNumber}`;
}

function cleanText(text) {
  return String(text || "").trim();
}

function getMessageText(message) {
  if (!message?.message) return "";
  const m = message.message;
  return cleanText(
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ""
  );
}

function formatMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function makeExcel(dateKey) {
  const rows = data.transactions
    .filter(x => x.dateKey === dateKey)
    .map(x => ({
      "التاريخ": x.date,
      "الوقت": x.time,
      "اسم الموظف": x.employeeName || "",
      "رقم الموظف": x.employeeNumber,
      "الباركود": x.barcode,
      "اسم الزبون": x.customerName,
      "الوزن": x.weight,
      "السعر": x.price
    }));

  const employeeMap = {};
  for (const x of rows) {
    const key = `${x["اسم الموظف"]} | ${x["رقم الموظف"]}`;
    if (!employeeMap[key]) {
      employeeMap[key] = { "الموظف": key, "عدد العمليات": 0, "مجموع الوزن": 0, "مجموع السعر": 0 };
    }
    employeeMap[key]["عدد العمليات"] += 1;
    employeeMap[key]["مجموع الوزن"] += Number(x["الوزن"]) || 0;
    employeeMap[key]["مجموع السعر"] += Number(x["السعر"]) || 0;
  }

  const summary = Object.values(employeeMap);

  const workbook = XLSX.utils.book_new();
  const ws1 = XLSX.utils.json_to_sheet(rows);
  const ws2 = XLSX.utils.json_to_sheet(summary);
  XLSX.utils.book_append_sheet(workbook, ws1, "العمليات");
  XLSX.utils.book_append_sheet(workbook, ws2, "ملخص الموظفين");

  const file = path.join(DATA_DIR, `report-${dateKey}.xlsx`);
  XLSX.writeFile(workbook, file);
  return file;
}

async function sendReport(sock, dateKey) {
  if (!REPORT_TO_PHONE) {
    console.log("REPORT_TO_PHONE is not configured. Report will not be sent.");
    return;
  }

  const file = makeExcel(dateKey);
  const jid = `${REPORT_TO_PHONE}@s.whatsapp.net`;
  const count = data.transactions.filter(x => x.dateKey === dateKey).length;

  await sock.sendMessage(jid, {
    document: { url: file },
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    fileName: `تقرير-${dateKey}.xlsx`,
    caption: `تقرير العمليات ليوم ${dateKey}\nعدد العمليات: ${count}`
  });

  console.log(`Daily report sent to ${REPORT_TO_PHONE}`);
}

function todayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dubai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function nowDubai() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dubai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date());

  const get = type => parts.find(x => x.type === type)?.value || "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}:${get("second")}`
  };
}

async function handleMessage(sock, msg) {
  const remoteJid = msg.key.remoteJid;
  if (!remoteJid || !remoteJid.endsWith("@g.us")) return;

  const groupId = remoteJid;
  const senderJid = msg.key.participantAlt || msg.key.participant;
  const employeeNumber = jidToNumber(senderJid);
  const text = getMessageText(msg);

  if (!text) return;

  // If the group ID is not configured yet, only log it for setup.
  if (!ALLOWED_GROUP_ID) {
    console.log(`GROUP_ID_DETECTED: ${groupId}`);
    try {
      const meta = await sock.groupMetadata(groupId);
      console.log(`GROUP_NAME: ${meta.subject}`);
    } catch {}
    return;
  }

  if (groupId !== ALLOWED_GROUP_ID) return;
  if (!EMPLOYEE_NUMBERS.includes(employeeNumber)) return;

  const key = sessionKey(groupId, employeeNumber);
  const session = data.sessions[key];

  // Only this exact word starts a new transaction.
  if (text === START_WORD) {
    data.sessions[key] = {
      step: "barcode",
      employeeNumber,
      employeeName: ""
    };
    saveData();
    await sock.sendMessage(remoteJid, { text: "أدخل الباركود:" });
    return;
  }

  // Normal messages do nothing when there is no active transaction.
  if (!session) return;

  if (text === CANCEL_WORD) {
    delete data.sessions[key];
    saveData();
    await sock.sendMessage(remoteJid, { text: "تم إلغاء العملية." });
    return;
  }

  if (session.step === "barcode") {
    session.barcode = text;
    session.step = "customerName";
    saveData();
    await sock.sendMessage(remoteJid, { text: "أدخل اسم الزبون:" });
    return;
  }

  if (session.step === "customerName") {
    session.customerName = text;
    session.step = "weight";
    saveData();
    await sock.sendMessage(remoteJid, { text: "أدخل الوزن:" });
    return;
  }

  if (session.step === "weight") {
    const weight = Number(text.replace(",", "."));
    if (!Number.isFinite(weight) || weight <= 0) {
      await sock.sendMessage(remoteJid, { text: "الوزن غير صحيح. أرسل الوزن كرقم، مثلاً: 12.5" });
      return;
    }
    session.weight = weight;
    session.step = "price";
    saveData();
    await sock.sendMessage(remoteJid, { text: "أدخل السعر:" });
    return;
  }

  if (session.step === "price") {
    const price = Number(text.replace(",", "."));
    if (!Number.isFinite(price) || price < 0) {
      await sock.sendMessage(remoteJid, { text: "السعر غير صحيح. أرسل السعر كرقم." });
      return;
    }
    session.price = price;
    session.step = "confirm";
    saveData();

    await sock.sendMessage(remoteJid, {
      text:
`راجع العملية:
الباركود: ${session.barcode}
الزبون: ${session.customerName}
الوزن: ${session.weight}
السعر: ${formatMoney(session.price)}

اكتب "تأكيد" للحفظ أو "إلغاء" للإلغاء.`
    });
    return;
  }

  if (session.step === "confirm") {
    if (!CONFIRM_WORDS.has(text)) {
      await sock.sendMessage(remoteJid, { text: 'اكتب "تأكيد" للحفظ أو "إلغاء" للإلغاء.' });
      return;
    }

    const time = nowDubai();
    data.transactions.push({
      dateKey: time.date,
      date: time.date,
      time: time.time,
      employeeNumber,
      employeeName: session.employeeName || employeeNumber,
      barcode: session.barcode,
      customerName: session.customerName,
      weight: session.weight,
      price: session.price
    });

    delete data.sessions[key];
    saveData();

    await sock.sendMessage(remoteJid, {
      text: "تم حفظ العملية بنجاح. إذا بدك عملية جديدة اكتب: جديد"
    });
  }
}

async function startWhatsApp() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let version;
  try {
    const latest = await fetchLatestWaWebVersion();
    version = latest.version;
    console.log(`WhatsApp Web version: ${version.join(".")}`);
  } catch (err) {
    console.log("Could not fetch latest WhatsApp Web version; continuing with library defaults.");
  }

  const sock = makeWASocket({
    auth: state,
    ...(version ? { version } : {}),
    browser: Browsers.ubuntu("Thahab Al Naeem Bot"),
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    // Pairing-code mode: do not print a QR. The pairing code must be requested
    // before the socket reaches the "open" state, because pairing is what
    // completes the login.
    if (!state.creds.registered && BOT_PHONE_NUMBER && connection === "connecting") {
      setTimeout(async () => {
        try {
          const phone = normalizeNumber(BOT_PHONE_NUMBER);
          const code = await sock.requestPairingCode(phone);
          console.log("\n========================================");
          console.log(`PAIRING CODE: ${code}`);
          console.log("Open WhatsApp > Linked devices > Link a device > Link with phone number");
          console.log("========================================\n");
        } catch (err) {
          console.error("PAIRING CODE ERROR", err);
        }
      }, 3000);
    }

    if (connection === "open") {
      console.log("WhatsApp connected successfully.");
      console.log("Allowed employees:", EMPLOYEE_NUMBERS);
      console.log("Allowed group:", ALLOWED_GROUP_ID || "(not configured - discovery mode)");
    }

    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log("WhatsApp connection closed. Reconnect:", shouldReconnect);

      if (shouldReconnect) {
        setTimeout(() => startWhatsApp().catch(console.error), 5000);
      } else {
        console.error("WhatsApp logged out. Delete the auth folder and pair the number again.");
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ type, messages }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      try {
        await handleMessage(sock, msg);
      } catch (err) {
        console.error("MESSAGE HANDLER ERROR", err);
      }
    }
  });

  // Daily Excel report at 23:59 Dubai time.
  cron.schedule("59 23 * * *", async () => {
    try {
      await sendReport(sock, todayKey());
    } catch (err) {
      console.error("DAILY REPORT ERROR", err);
    }
  }, { timezone: "Asia/Dubai" });

  return sock;
}

const app = express();
app.get("/", (_req, res) => res.send("THAHAB AL NAEEM WhatsApp Group Bot is running."));
app.get("/health", (_req, res) => res.json({ ok: true, whatsapp: "running" }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP server listening on ${PORT}`);
});

startWhatsApp().catch(err => {
  console.error("STARTUP ERROR", err);
  process.exit(1);
});
