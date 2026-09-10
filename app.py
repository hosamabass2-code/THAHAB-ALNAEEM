import os
import re
import io
import sqlite3
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

import requests
from flask import Flask, request, jsonify, send_file
from openpyxl import Workbook

app = Flask(__name__)

DATABASE_URL = os.getenv("DATABASE_URL", "")
VERIFY_TOKEN = os.getenv("VERIFY_TOKEN", "CHANGE_ME")
WHATSAPP_TOKEN = os.getenv("WHATSAPP_TOKEN", "")
PHONE_NUMBER_ID = os.getenv("PHONE_NUMBER_ID", "")
GRAPH_API_VERSION = os.getenv("GRAPH_API_VERSION", "v23.0")
REPORT_TO_PHONE = os.getenv("REPORT_TO_PHONE", "")

# For the first test, SQLite is fine. For production on Render, use PostgreSQL
# by setting DATABASE_URL and installing psycopg[binary].
DB_PATH = os.getenv("SQLITE_PATH", "bot.db")

sessions = {}  # phone -> current transaction state (simple first version)


def db():
    if DATABASE_URL.startswith("postgres"):
        import psycopg
        conn = psycopg.connect(DATABASE_URL)
        return conn, "postgres"
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn, "sqlite"


def init_db():
    conn, kind = db()
    cur = conn.cursor()
    if kind == "postgres":
        cur.execute("""
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                created_at TIMESTAMPTZ NOT NULL,
                employee_phone TEXT NOT NULL,
                employee_name TEXT,
                barcode TEXT NOT NULL,
                customer_name TEXT NOT NULL,
                weight NUMERIC NOT NULL,
                price NUMERIC NOT NULL
            )
        """)
    else:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                employee_phone TEXT NOT NULL,
                employee_name TEXT,
                barcode TEXT NOT NULL,
                customer_name TEXT NOT NULL,
                weight REAL NOT NULL,
                price REAL NOT NULL
            )
        """)
    conn.commit()
    conn.close()


def send_text(to, text):
    if not WHATSAPP_TOKEN or not PHONE_NUMBER_ID:
        app.logger.warning("WhatsApp credentials are not configured.")
        return False

    url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/{PHONE_NUMBER_ID}/messages"
    headers = {
        "Authorization": f"Bearer {WHATSAPP_TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {
        "messaging_product": "whatsapp",
        "to": to,
        "type": "text",
        "text": {"body": text},
    }
    r = requests.post(url, headers=headers, json=payload, timeout=30)
    if not r.ok:
        app.logger.error("WhatsApp send failed: %s %s", r.status_code, r.text)
        return False
    return True


def normalize_text(value):
    return (value or "").strip()


def parse_number(value):
    value = normalize_text(value).replace(",", ".")
    try:
        x = Decimal(value)
        if x <= 0:
            raise InvalidOperation
        return x
    except InvalidOperation:
        return None


def save_transaction(data):
    conn, kind = db()
    cur = conn.cursor()
    created = datetime.now(timezone.utc)
    if kind == "postgres":
        cur.execute("""
            INSERT INTO transactions
            (created_at, employee_phone, employee_name, barcode, customer_name, weight, price)
            VALUES (%s,%s,%s,%s,%s,%s,%s)
        """, (
            created, data["employee_phone"], data.get("employee_name"),
            data["barcode"], data["customer_name"], data["weight"], data["price"]
        ))
    else:
        cur.execute("""
            INSERT INTO transactions
            (created_at, employee_phone, employee_name, barcode, customer_name, weight, price)
            VALUES (?,?,?,?,?,?,?)
        """, (
            created.isoformat(), data["employee_phone"], data.get("employee_name"),
            data["barcode"], data["customer_name"], float(data["weight"]), float(data["price"])
        ))
    conn.commit()
    conn.close()


def handle_message(phone, text, employee_name=None):
    text = normalize_text(text)
    low = text.lower()

    if low in ("إلغاء", "الغاء", "cancel"):
        sessions.pop(phone, None)
        send_text(phone, "تم إلغاء العملية.")
        return

    if low in ("جديد", "new"):
        sessions[phone] = {
            "step": "barcode",
            "employee_phone": phone,
            "employee_name": employee_name or "",
        }
        send_text(phone, "تمام. أرسل الباركود.")
        return

    state = sessions.get(phone)
    if not state:
        send_text(phone, 'للبدء أرسل «جديد». ولإلغاء العملية أرسل «إلغاء».')
        return

    step = state["step"]

    if step == "barcode":
        state["barcode"] = text
        state["step"] = "customer_name"
        send_text(phone, "أرسل اسم العميل.")
        return

    if step == "customer_name":
        state["customer_name"] = text
        state["step"] = "weight"
        send_text(phone, "أرسل الوزن.")
        return

    if step == "weight":
        n = parse_number(text)
        if n is None:
            send_text(phone, "الوزن غير صحيح. أرسل رقم الوزن، مثال: 12.50")
            return
        state["weight"] = n
        state["step"] = "price"
        send_text(phone, "أرسل السعر.")
        return

    if step == "price":
        n = parse_number(text)
        if n is None:
            send_text(phone, "السعر غير صحيح. أرسل رقم السعر، مثال: 2500")
            return
        state["price"] = n
        state["step"] = "confirm"
        send_text(
            phone,
            "راجع العملية:\n"
            f"الباركود: {state['barcode']}\n"
            f"العميل: {state['customer_name']}\n"
            f"الوزن: {state['weight']}\n"
            f"السعر: {state['price']}\n\n"
            "أرسل «تأكيد» للحفظ أو «إلغاء» للإلغاء."
        )
        return

    if step == "confirm":
        if low in ("تأكيد", "تاكيد", "نعم", "yes"):
            save_transaction(state)
            sessions.pop(phone, None)
            send_text(phone, "تم حفظ العملية بنجاح. لإدخال عملية جديدة أرسل «جديد».")
        else:
            send_text(phone, "أرسل «تأكيد» للحفظ أو «إلغاء» للإلغاء.")
        return


@app.get("/health")
def health():
    return jsonify({"ok": True})


@app.get("/webhook")
def verify_webhook():
    mode = request.args.get("hub.mode")
    token = request.args.get("hub.verify_token")
    challenge = request.args.get("hub.challenge")

    if mode == "subscribe" and token == VERIFY_TOKEN:
        return challenge, 200
    return "Forbidden", 403


@app.post("/webhook")
def webhook():
    data = request.get_json(silent=True) or {}
    try:
        for entry in data.get("entry", []):
            for change in entry.get("changes", []):
                value = change.get("value", {})
                contacts = value.get("contacts", [])
                employee_name = None
                if contacts:
                    employee_name = contacts[0].get("profile", {}).get("name")

                for message in value.get("messages", []):
                    if message.get("type") != "text":
                        continue
                    phone = message.get("from")
                    text = message.get("text", {}).get("body", "")
                    if phone:
                        handle_message(phone, text, employee_name)
    except Exception:
        app.logger.exception("Webhook processing error")

    return "EVENT_RECEIVED", 200


def make_report_xlsx():
    conn, kind = db()
    cur = conn.cursor()
    cur.execute("""
        SELECT created_at, employee_phone, employee_name, barcode,
               customer_name, weight, price
        FROM transactions
        ORDER BY created_at ASC
    """)
    rows = cur.fetchall()
    conn.close()

    wb = Workbook()
    ws = wb.active
    ws.title = "العمليات"
    headers = ["التاريخ والوقت", "رقم الموظف", "اسم الموظف", "الباركود",
               "اسم العميل", "الوزن", "السعر"]
    ws.append(headers)

    total_weight = Decimal("0")
    total_price = Decimal("0")

    for row in rows:
        vals = list(row)
        ws.append(vals)
        total_weight += Decimal(str(row[5]))
        total_price += Decimal(str(row[6]))

    ws.append([])
    ws.append(["الإجمالي", "", "", "", "", float(total_weight), float(total_price)])

    # A second sheet with employee totals.
    emp = wb.create_sheet("ملخص الموظفين")
    emp.append(["رقم الموظف", "اسم الموظف", "عدد العمليات", "إجمالي الوزن", "إجمالي السعر"])

    grouped = {}
    for row in rows:
        key = (row[1], row[2] or "")
        if key not in grouped:
            grouped[key] = [0, Decimal("0"), Decimal("0")]
        grouped[key][0] += 1
        grouped[key][1] += Decimal(str(row[5]))
        grouped[key][2] += Decimal(str(row[6]))

    for (phone, name), (count, weight, price) in grouped.items():
        emp.append([phone, name, count, float(weight), float(price)])

    out = io.BytesIO()
    wb.save(out)
    out.seek(0)
    return out


@app.get("/report.xlsx")
def report():
    data = make_report_xlsx()
    filename = f"thahab_report_{datetime.now().strftime('%Y-%m-%d')}.xlsx"
    return send_file(
        data,
        as_attachment=True,
        download_name=filename,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


if __name__ == "__main__":
    init_db()
    port = int(os.getenv("PORT", "10000"))
    app.run(host="0.0.0.0", port=port)
