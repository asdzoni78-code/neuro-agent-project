import os
import json
import hashlib
import sqlite3
import asyncio
from datetime import datetime
from dotenv import load_dotenv
from tavily import TavilyClient
import anthropic
import telegram

load_dotenv()

DB_PATH = os.path.join(os.path.dirname(__file__), "db.sqlite3")
CONTEXT_PATH = os.path.join(os.path.dirname(__file__), "context.json")
BLOCK_SEPARATOR = "---BLOCK---"

SEARCH_QUERIES = [
    "TRIZ Systematic Innovation",
    "Inventive Problem Solving",
    "Systems Thinking",
    "Complex Systems",
    "Complexity Science",
    "Agentic AI",
    "Multi-Agent Systems",
    "Autonomous Enterprise",
    "MCP Model Context Protocol",
    "Digital Twin",
    "Enterprise Digital Twin",
    "Agentic Digital Twin",
    "Future of Organizations",
    "AI Native Company",
    "Future of Work",
    "Construction AI",
    "AI Construction Management",
    "AI Project Control",
    "AI Tender Management",
]


# --- SQLite deduplication ---

def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS seen_articles (
            url_hash TEXT PRIMARY KEY,
            url TEXT,
            seen_date TEXT DEFAULT (date('now'))
        )
    """)
    conn.commit()
    conn.close()


def _url_hash(url: str) -> str:
    return hashlib.sha256(url.encode()).hexdigest()


def is_seen(url: str) -> bool:
    conn = sqlite3.connect(DB_PATH)
    result = conn.execute(
        "SELECT 1 FROM seen_articles WHERE url_hash = ?", (_url_hash(url),)
    ).fetchone()
    conn.close()
    return result is not None


def mark_seen(url: str):
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "INSERT OR IGNORE INTO seen_articles (url_hash, url) VALUES (?, ?)",
        (_url_hash(url), url),
    )
    conn.commit()
    conn.close()


def cleanup_old(days: int = 30):
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "DELETE FROM seen_articles WHERE seen_date < date('now', ?)",
        (f"-{days} days",),
    )
    conn.commit()
    conn.close()


# --- User context ---

def load_context() -> dict:
    try:
        with open(CONTEXT_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"role": "Предприниматель", "current_projects": [], "focus_now": "", "interests": [], "avoid": []}


# --- News collection ---

def collect_news() -> str:
    tavily = TavilyClient(api_key=os.getenv("TAVILY_API_KEY"))
    sections = []
    new_count = 0
    skip_count = 0

    for query in SEARCH_QUERIES:
        try:
            response = tavily.search(query=query, search_depth="basic", max_results=3, days=1)
            items = []
            for r in response.get("results", []):
                url = r.get("url", "")
                if is_seen(url):
                    skip_count += 1
                    continue
                mark_seen(url)
                new_count += 1
                items.append(f"- {r['title']}: {r['content'][:300]} ({url})")
            if items:
                sections.append(f"### {query}\n" + "\n".join(items))
        except Exception as e:
            print(f"Ошибка поиска [{query}]: {e}")

    print(f"Новых статей: {new_count}, пропущено (дубли): {skip_count}")
    return "\n\n".join(sections)


# --- Digest generation ---

def generate_digest(raw_data: str) -> str:
    ctx = load_context()
    client = anthropic.Anthropic(api_key=os.getenv("CLAUDE_API_KEY"))
    today = datetime.now().strftime("%d.%m.%Y")

    projects_list = "\n".join(f"  - {p}" for p in ctx.get("current_projects", []))
    interests_list = ", ".join(ctx.get("interests", []))
    avoid_list = ", ".join(ctx.get("avoid", []))

    prompt = f"""Ты — личный стратегический аналитик и редактор дайджеста.

Пользователь: {ctx.get('role', '')}
Текущие проекты:
{projects_list}
Фокус сейчас: {ctx.get('focus_now', '')}
Горизонт: {ctx.get('horizon', '3-5 лет')}
Темы интереса: {interests_list}
Не включать: {avoid_list}

Вот свежие материалы из интернета за последние 24 часа (дубликаты уже удалены):

{raw_data}

Создай дайджест. СТРОГО разделяй блоки строкой ---BLOCK---

Формат каждой находки внутри блока:
ФАКТ: [что произошло — конкретно]
ПОЧЕМУ ВАЖНО: [конкретное значение, не общие слова]
ДЛЯ МЕНЯ: [как связано с моими проектами и что можно применить]
Источник: [URL]

Если источник не подтверждён — пиши «Требует проверки».

Блоки дайджеста (разделяй каждый строкой ---BLOCK---):

📡 РАЗВЕДКА: {today}
[1-2 предложения — что главное за сутки, без воды]

---BLOCK---

💼 БЛОК 1 — Управление и труд
[2-3 находки о том, как меняется управление, организация работы, роли в компаниях]

---BLOCK---

🤖 БЛОК 2 — Агентные системы
[2-3 находки по Agentic AI, Multi-Agent Systems, Digital Twins, Autonomous Organizations]

---BLOCK---

🧩 БЛОК 3 — Методы мышления
[1-2 находки по ТРИЗ, системному мышлению, изобретательству, сложным системам]

---BLOCK---

🏗 БЛОК 4 — Применимо в строительстве
[1-2 идеи для строительных компаний, подрядчиков, AI-инструментов для стройки]

---BLOCK---

🌀 БЛОК 5 — Странная идея дня
[1 идея, которая сейчас выглядит странно, но через 3-5 лет может стать нормой. Объясни почему.]

---BLOCK---

🧠 ГЛАВНАЯ ИДЕЯ ДНЯ
Тезис: [одно провокационное предложение]
Факт: [что произошло]
Почему важно: [что реально изменилось]
Для меня: [конкретное применение к моим проектам]
Действие: [одно конкретное действие на сегодня]
Источник: [URL]

Пиши кратко. Без воды. Без «ИИ продолжает развиваться». Каждая находка — 2-3 предложения максимум."""

    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=3000,
        messages=[{"role": "user", "content": prompt}],
    )

    return message.content[0].text


# --- Telegram delivery ---

async def send_to_telegram(digest: str):
    bot = telegram.Bot(token=os.getenv("TELEGRAM_BOT_TOKEN"))
    chat_id = os.getenv("TELEGRAM_CHAT_ID")

    blocks = [b.strip() for b in digest.split("---BLOCK---") if b.strip()]

    for block in blocks:
        if len(block) <= 4096:
            await bot.send_message(chat_id=chat_id, text=block)
        else:
            for i in range(0, len(block), 4096):
                await bot.send_message(chat_id=chat_id, text=block[i : i + 4096])
                await asyncio.sleep(0.5)
        await asyncio.sleep(0.8)


# --- Entry point ---

async def main():
    init_db()
    cleanup_old(days=30)

    print("Собираю данные из интернета...")
    raw_data = collect_news()

    if not raw_data:
        print("Нет новых материалов за последние 24 часа.")
        return

    print("Генерирую дайджест...")
    digest = generate_digest(raw_data)

    print("Отправляю в Telegram...")
    await send_to_telegram(digest)

    print("Готово!")


if __name__ == "__main__":
    asyncio.run(main())