import os
import asyncio
from datetime import datetime
from dotenv import load_dotenv
from tavily import TavilyClient
import anthropic
import telegram

load_dotenv()

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


def collect_news() -> str:
    tavily = TavilyClient(api_key=os.getenv("TAVILY_API_KEY"))
    sections = []

    for query in SEARCH_QUERIES:
        try:
            response = tavily.search(query=query, search_depth="basic", max_results=3, days=1)
            items = []
            for r in response.get("results", []):
                items.append(f"- {r['title']}: {r['content'][:300]} ({r['url']})")
            if items:
                sections.append(f"### {query}\n" + "\n".join(items))
        except Exception as e:
            print(f"Ошибка поиска [{query}]: {e}")

    return "\n\n".join(sections)


def generate_digest(raw_data: str) -> str:
    client = anthropic.Anthropic(api_key=os.getenv("CLAUDE_API_KEY"))
    today = datetime.now().strftime("%d.%m.%Y")

    prompt = f"""Ты — персональный разведчик будущего для стратега, который строит AI-продукты для строительной отрасли.

Контекст: пользователь ищет идеи и тренды, которые будут востребованы через 3–5 лет.
Его интересы: агентные AI-системы, цифровые двойники, новые организационные модели, строительство, AI-консалтинг.

Вот свежие данные из интернета за последние 24 часа:

{raw_data}

Создай структурированный дайджест строго в этом формате (на русском):

📡 РАЗВЕДКА: {today}

Блок 1 — Управление и труд
[2–3 находки о том, как меняется управление бизнесом, создание продуктов, организация труда]

Блок 2 — Агентные системы
[2–3 находки по Agentic AI, Multi-Agent Systems, Digital Twins, Autonomous Organizations]

Блок 3 — Методы мышления
[1–2 находки по ТРИЗ, системному мышлению, инновациям, сложным системам]

Блок 4 — Применимо в строительстве
[1–2 идеи для строительных компаний, подрядчиков, AI-консалтинга]

Блок 5 — Странная идея дня
[1 идея, которая сейчас выглядит странно, но через 3–5 лет может стать нормой]

⭐ ГЛАВНАЯ ИДЕЯ ДНЯ
Название: [одна строка]
Что это: [1–2 предложения]
Что это значит для меня: [1–2 предложения с привязкой к AI-продуктам и строительству]
Источник: [ссылка]

Пиши кратко, без воды. Каждый пункт — 1–2 предложения и ссылка."""

    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}],
    )

    return message.content[0].text


async def send_to_telegram(text: str):
    bot = telegram.Bot(token=os.getenv("TELEGRAM_BOT_TOKEN"))
    chat_id = os.getenv("TELEGRAM_CHAT_ID")

    if len(text) <= 4096:
        await bot.send_message(chat_id=chat_id, text=text)
    else:
        for i in range(0, len(text), 4096):
            await bot.send_message(chat_id=chat_id, text=text[i : i + 4096])
            await asyncio.sleep(1)


async def main():
    print("Собираю данные из интернета...")
    raw_data = collect_news()

    if not raw_data:
        print("Нет данных для обработки.")
        return

    print("Генерирую дайджест...")
    digest = generate_digest(raw_data)

    print("Отправляю в Telegram...")
    await send_to_telegram(digest)

    print("Готово!")


if __name__ == "__main__":
    asyncio.run(main())
