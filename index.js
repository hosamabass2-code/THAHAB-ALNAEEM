const express = require('express');
const cron = require('node-cron');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const PORT = process.env.PORT || 10000;
const DATA_DIR = process.env.DATA_DIR || './data';
const DATA_FILE = path.join(DATA_DIR, 'bot-data.json');
const AUTH_DIR = path.join(DATA_DIR, 'wwebjs_auth');
const BOT_PHONE_NUMBER = (process.env.BOT_PHONE_NUMBER || '').replace(/\D/g, '');
const REPORT_TO_PHONE = (process.env.REPORT_TO_PHONE || '').replace(/\D/g, '');
const ALLOWED_GROUP_ID = (process.env.ALLOWED_GROUP_ID || '').trim();
const EMPLOYEE_NUMBERS = new Set(
  (process.env.EMPLOYEE_NUMBERS || '')
    .split(',')
    .map(v => v.replace(/\D/g, ''))
    .filter(Boolean)
);

const START_WORD = 'جديد';
const CANCEL_WORD = 'إلغاء';
const CONFIRM_WORDS = new Set(['تأكيد', 'تاكيد', 'نعم']);

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { transactions: [], sessions: {} };
  }
}

let data = loadData();
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function normalizeNumber(value = '') {
  return String(value).replace(/\D/g, '');
}

function getSenderNumber(msg) {
  // WhatsApp Web JS normally exposes author as the sender in groups.
  return normalizeNumber(msg.author || msg.from);
}

function employeeAllowed(number) {
  return EMPLOYEE_NUMBERS.size === 0 || EMPLOYEE_NUMBERS.has(number);
}

function getSessionKey(groupId, employeeNumber) {
  return `${groupId}|${employeeNumber}`;
}

function getSession(groupId, employeeNumber) {
  return data.sessions[getSessionKey(groupId, employeeNumber)] || null;
}

function setSession(groupId, employeeNumber, session) {
  data.sessions[getSessionKey(groupId, employeeNumber)] = session;
  saveData();
}

function clearSession(groupId, employeeNumber) {
  delete data.sessions[getSessionKey(groupId, employeeNumber)];
  saveData();
}

function parseNumber(text) {
  const normalized = String(text).replace(/,/g, '.').replace(/[^0-9.\-]/g, '');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function todayKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

async function sendDailyReport() {
  if (!REPORT_TO_PHONE || !client.info) return;
  const date = todayKey();
  const rows = data.transactions.filter(t => t.dateDubai === date);
  if (!rows.length) {
    console.log(`No transactions for ${date}`);
    return;
  }

  const employeeMap = new Map();
  for (const t of rows) {
    if (!employeeMap.has(t.employeeNumber)) employeeMap.set(t.employeeNumber, { employeeNumber: t.employeeNumber, employeeName: t.employeeName || '', count: 0, weight: 0, price: 0 });
    const e = employeeMap.get(t.employeeNumber);
    e.count += 1;
    e.weight += Number(t.weight) || 0;
    e.price += Number(t.price) || 0;
  }

  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.json_to_sheet(rows.map(t => ({
    'التاريخ': t.dateDubai,
    'الوقت': t.timeDubai,
    'رقم الموظف': t.employeeNumber,
    'اسم الموظف': t.employeeName || '',
    'الباركود': t.barcode,
    'اسم الزبون': t.customerName,
    'الوزن': t.weight,
    'السعر': t.price,
    'المجموعة': t.groupName || t.groupId
  })));
  XLSX.utils.book_append_sheet(wb, ws1, 'العمليات');

  const ws2 = XLSX.utils.json_to_sheet(Array.from(employeeMap.values()).map(e => ({
    'رقم الموظف': e.employeeNumber,
    'اسم الموظف': e.employeeName,
    'عدد العمليات': e.count,
    'إجمالي الوزن': e.weight,
    'إجمالي السعر': e.price
  })));
  XLSX.utils.book_append_sheet(wb, ws2, 'ملخص الموظفين');

  const filePath = path.join(DATA_DIR, `تقرير-اليوم-${date}.xlsx`);
  XLSX.writeFile(wb, filePath);

  try {
    const chatId = `${REPORT_TO_PHONE}@c.us`;
    const media = MessageMedia.fromFilePath(filePath);
    await client.sendMessage(chatId, media, { caption: `تقرير العمليات اليومي - ${date}` });
    console.log(`DAILY_REPORT_SENT: ${filePath}`);
  } catch (err) {
    console.error('DAILY_REPORT_SEND_ERROR:', err);
  }
}

const app = express();
app.get('/', (_req, res) => res.send('THAHAB AL NAEEM BOT is running'));
app.get('/health', (_req, res) => res.json({ ok: true, whatsappReady: Boolean(client && client.info) }));
app.listen(PORT, () => console.log(`HTTP server listening on ${PORT}`));

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: 'thahab-al-naeem-bot',
    dataPath: AUTH_DIR
  }),
  pairWithPhoneNumber: BOT_PHONE_NUMBER || undefined,
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote'
    ]
  }
});

client.on('code', code => {
  console.log('==============================================');
  console.log(`PAIRING CODE: ${code}`);
  console.log('WhatsApp > Linked devices > Link a device > Link with phone number');
  console.log('==============================================');
});

client.on('qr', () => {
  console.log('QR RECEIVED (pairing code mode is enabled; use the phone-number linking option).');
});

client.on('authenticated', () => console.log('WHATSAPP_AUTHENTICATED'));
client.on('ready', async () => {
  console.log('WHATSAPP_READY');
  try {
    const version = await client.getWWebVersion();
    console.log(`WHATSAPP_WEB_VERSION: ${version}`);
  } catch {}
});
client.on('auth_failure', msg => console.error('WHATSAPP_AUTH_FAILURE:', msg));
client.on('disconnected', reason => console.error('WHATSAPP_DISCONNECTED:', reason));

client.on('message', async msg => {
  try {
    if (!msg.from || !msg.from.endsWith('@g.us')) return;
    const groupId = msg.from;
    const body = String(msg.body || '').trim();
    const employeeNumber = getSenderNumber(msg);
    if (!employeeAllowed(employeeNumber)) return;

    if (ALLOWED_GROUP_ID && groupId !== ALLOWED_GROUP_ID) return;

    let groupName = '';
    try {
      const chat = await msg.getChat();
      groupName = chat.name || '';
    } catch {}

    if (!ALLOWED_GROUP_ID) {
      console.log(`GROUP_ID_DETECTED: ${groupId}`);
      console.log(`GROUP_NAME: ${groupName}`);
      return;
    }

    const key = getSessionKey(groupId, employeeNumber);
    let session = data.sessions[key];

    if (body === CANCEL_WORD) {
      if (session) {
        clearSession(groupId, employeeNumber);
        await msg.reply('تم إلغاء العملية.');
      }
      return;
    }

    if (!session) {
      if (body !== START_WORD) return;
      session = {
        step: 'barcode',
        employeeNumber,
        employeeName: '',
        groupId,
        groupName,
        createdAt: new Date().toISOString()
      };
      setSession(groupId, employeeNumber, session);
      await msg.reply('أرسل الباركود.');
      return;
    }

    if (session.step === 'barcode') {
      session.barcode = body;
      session.step = 'customerName';
      setSession(groupId, employeeNumber, session);
      await msg.reply('أرسل اسم الزبون.');
      return;
    }

    if (session.step === 'customerName') {
      session.customerName = body;
      session.step = 'weight';
      setSession(groupId, employeeNumber, session);
      await msg.reply('أرسل الوزن.');
      return;
    }

    if (session.step === 'weight') {
      const weight = parseNumber(body);
      if (weight === null || weight < 0) {
        await msg.reply('الوزن غير صحيح. أرسل رقم الوزن فقط.');
        return;
      }
      session.weight = weight;
      session.step = 'price';
      setSession(groupId, employeeNumber, session);
      await msg.reply('أرسل السعر.');
      return;
    }

    if (session.step === 'price') {
      const price = parseNumber(body);
      if (price === null || price < 0) {
        await msg.reply('السعر غير صحيح. أرسل رقم السعر فقط.');
        return;
      }
      session.price = price;
      session.step = 'confirm';
      setSession(groupId, employeeNumber, session);
      await msg.reply(`تأكيد العملية؟\nالباركود: ${session.barcode}\nالزبون: ${session.customerName}\nالوزن: ${session.weight}\nالسعر: ${session.price}\n\nاكتب: تأكيد`);
      return;
    }

    if (session.step === 'confirm') {
      if (!CONFIRM_WORDS.has(body)) {
        await msg.reply('اكتب «تأكيد» للحفظ أو «إلغاء» لإلغاء العملية.');
        return;
      }

      const now = new Date();
      const dateDubai = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
      const timeDubai = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now);

      data.transactions.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        dateDubai,
        timeDubai,
        employeeNumber,
        employeeName: session.employeeName || '',
        barcode: session.barcode,
        customerName: session.customerName,
        weight: session.weight,
        price: session.price,
        groupId,
        groupName
      });
      clearSession(groupId, employeeNumber);
      await msg.reply('تم حفظ العملية بنجاح.');
      return;
    }
  } catch (err) {
    console.error('MESSAGE_HANDLER_ERROR:', err);
  }
});

cron.schedule('59 23 * * *', sendDailyReport, { timezone: 'Asia/Dubai' });

console.log('Starting WhatsApp Web client...');
console.log(`BOT_PHONE_NUMBER: ${BOT_PHONE_NUMBER ? BOT_PHONE_NUMBER : '(missing)'}`);
console.log(`ALLOWED_GROUP_ID: ${ALLOWED_GROUP_ID || '(discovery mode)'}`);
console.log(`EMPLOYEE_NUMBERS: ${EMPLOYEE_NUMBERS.size ? `${EMPLOYEE_NUMBERS.size} configured` : '(all employees allowed until configured)'}`);

client.initialize().catch(err => {
  console.error('WHATSAPP_INITIALIZE_ERROR:', err);
  process.exitCode = 1;
});
