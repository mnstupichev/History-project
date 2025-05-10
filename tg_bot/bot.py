import os
import logging
import requests
import random
from typing import Dict, Optional, List, Set
from datetime import datetime, time
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application,
    CommandHandler,
    CallbackQueryHandler,
    ConversationHandler,
    ContextTypes,
    MessageHandler,
    filters
)

# Настройка логирования
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# Константы для Wikidata
WIKIDATA_API_URL = "https://www.wikidata.org/w/api.php"
WIKIDATA_SPARQL_URL = "https://query.wikidata.org/sparql"

# Временные границы для эпох
ERA_RANGES = {
    'ancient_rus': {'start': '0800', 'end': '1547', 'name': 'Древняя Русь (IX-XVI вв.)'},
    'tsar_rus': {'start': '1547', 'end': '1721', 'name': 'Царская Россия (XVI-XVIII вв.)'},
    'imperial': {'start': '1721', 'end': '1917', 'name': 'Императорская Россия (XVIII-XX вв.)'},
    'soviet': {'start': '1917', 'end': '1991', 'name': 'Советский период (1917-1991)'},
    'modern': {'start': '1991', 'end': str(datetime.now().year), 'name': 'Наше время (с 1991)'}
}

# Состояния диалога
MAIN_MENU, SELECT_CITY, SELECT_ERA = range(3)

# Данные пользователей
user_data: Dict[int, Dict] = {}

# Добавляем словарь для хранения подписчиков
subscribers: Dict[int, Dict] = {}


async def get_city_wikidata_id(city_name: str) -> Optional[str]:
    """Получает ID города в Wikidata."""
    try:
        params = {
            'action': 'wbsearchentities',
            'format': 'json',
            'language': 'ru',
            'type': 'item',
            'search': city_name
        }
        response = requests.get(WIKIDATA_API_URL, params=params)
        response.raise_for_status()
        data = response.json()

        if data.get('search'):
            return data['search'][0]['id']
        return None
    except Exception as e:
        logger.error(f"Error getting Wikidata ID for city {city_name}: {e}")
        return None


async def get_events_from_wikidata(city_id: str, era: str, exclude_events: Set[str] = None) -> List[Dict]:
    """Получает исторические события из Wikidata."""
    try:
        range_data = ERA_RANGES[era]
        
        # SPARQL запрос для получения исторических событий
        query = f"""
                SELECT ?event ?eventLabel ?date ?description WHERE {{
                  ?event wdt:P31 wd:Q1190554;  # instance of historical event
                        wdt:P585 ?date;        # point in time
                        wdt:P276/wdt:P131* wd:{city_id}. # location (city and its administrative units)
                  OPTIONAL {{ ?event schema:description ?description FILTER(LANG(?description) = "ru") }}
                  FILTER(?date >= "{range_data['start']}-01-01"^^xsd:dateTime)
                  FILTER(?date <= "{range_data['end']}-12-31"^^xsd:dateTime)
                  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "[AUTO_LANGUAGE],ru". }}
                }}
                ORDER BY ?date
                LIMIT 50
                """
        
        headers = {'Accept': 'application/sparql-results+json'}
        response = requests.get(WIKIDATA_SPARQL_URL, params={'query': query}, headers=headers)
        response.raise_for_status()
        data = response.json()
        
        events = []
        for result in data.get('results', {}).get('bindings', []):
            event = {
                'label': result.get('eventLabel', {}).get('value', 'Неизвестное событие'),
                'date': result.get('date', {}).get('value', 'Неизвестная дата'),
                'description': result.get('description', {}).get('value', '')
            }
            # Проверяем, не было ли это событие уже показано
            if exclude_events is None or event['label'] not in exclude_events:
                events.append(event)
        
        return events
    except Exception as e:
        logger.error(f"Error getting events from Wikidata: {e}")
        return []


def eras_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🏰 Древняя Русь (IX-XVI вв.)", callback_data='era_ancient_rus')],
        [InlineKeyboardButton("👑 Царская Россия (XVI-XVIII вв.)", callback_data='era_tsar_rus')],
        [InlineKeyboardButton("⚜️ Императорская Россия (XVIII-XX вв.)", callback_data='era_imperial')],
        [InlineKeyboardButton("☭ Советский период (1917-1991)", callback_data='era_soviet')],
        [InlineKeyboardButton("🏛 Наше время (с 1991)", callback_data='era_modern')],
        [InlineKeyboardButton("↩️ Назад", callback_data='back')]
    ])


async def get_historical_event(user_id: int) -> str:
    """Получает историческое событие из Wikidata."""
    try:
        city = user_data[user_id]['city']
        era = user_data[user_id]['era']
        city_id = user_data[user_id].get('city_id')
        
        if not city_id:
            city_id = await get_city_wikidata_id(city)
            if city_id:
                user_data[user_id]['city_id'] = city_id
        
        if not city_id:
            return f"К сожалению, не удалось найти информацию о городе {city} в базе данных."
        
        # Получаем уже показанные события
        shown_events = user_data[user_id].get('shown_events', set())
        
        # Получаем новые события, исключая уже показанные
        events = await get_events_from_wikidata(city_id, era, shown_events)
        
        if not events:
            if shown_events:
                return f"К сожалению, все исторические события для {city} в выбранный период уже были показаны."
            return f"К сожалению, не удалось найти исторические события для {city} в выбранный период."
        
        # Выбираем случайное событие
        event = random.choice(events)
        
        # Добавляем событие в список показанных
        if 'shown_events' not in user_data[user_id]:
            user_data[user_id]['shown_events'] = set()
        user_data[user_id]['shown_events'].add(event['label'])
        
        # Форматируем дату
        try:
            date = datetime.fromisoformat(event['date'].replace('Z', '+00:00'))
            formatted_date = date.strftime('%d.%m.%Y')
        except:
            formatted_date = event['date']
        
        # Формируем сообщение
        message = f"📅 {formatted_date}\n\n"
        message += f"📜 {event['label']}\n"
        
        if event.get('description'):
            message += f"\n📝 {event['description']}\n"
        
        message += f"\n🏙 {city}"
        
        return message
        
    except Exception as e:
        logger.error(f"Error in get_historical_event: {e}")
        return "Произошла ошибка при получении исторического события. Пожалуйста, попробуйте позже."


async def select_era(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    user = update.effective_user
    era = query.data.split('_')[1]

    user_data[user.id]['era'] = era
    user_data[user.id]['shown_events'] = set()  # Сбрасываем список показанных событий

    era_names = {
        'ancient_rus': 'Древняя Русь (IX-XVI вв.)',
        'tsar_rus': 'Царская Россия (XVI-XVIII вв.)',
        'imperial': 'Императорская Россия (XVIII-XX вв.)',
        'soviet': 'Советский период (1917-1991)',
        'modern': 'Наше время (с 1991)'
    }

    await query.edit_message_text(
        f"✅ Выбрана эпоха: {era_names[era]}",
        reply_markup=main_menu_keyboard()
    )
    return MAIN_MENU


async def select_city(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    user = update.effective_user
    city = update.message.text

    # Проверяем существование города в Wikidata
    city_id = await get_city_wikidata_id(city)
    if not city_id:
        await update.message.reply_text(
            f"❌ Город '{city}' не найден в базе данных. Пожалуйста, проверьте название и попробуйте снова.",
            reply_markup=cancel_keyboard()
        )
        return SELECT_CITY

    user_data[user.id]['city'] = city
    user_data[user.id]['city_id'] = city_id
    user_data[user.id]['shown_events'] = set()  # Сбрасываем список показанных событий

    await update.message.reply_text(
        f"✅ Город изменён на {city}",
        reply_markup=main_menu_keyboard()
    )
    return MAIN_MENU


# Клавиатуры
def main_menu_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🔄 Изменить город", callback_data='change_city')],
        [InlineKeyboardButton("⏳ Выбрать эпоху", callback_data='choose_era')],
        [InlineKeyboardButton("📜 Получить событие сейчас", callback_data='get_event')],
        [InlineKeyboardButton("📅 Получать события ежедневно", callback_data='subscribe')],
        [InlineKeyboardButton("ℹ️ Помощь", callback_data='help')]
    ])


def cancel_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("❌ Отмена", callback_data='cancel')]
    ])


# Обработчики команд
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    user = update.effective_user

    # Получаем Wikidata ID для Санкт-Петербурга
    city_id = await get_city_wikidata_id('Санкт-Петербург')

    user_data[user.id] = {
        'city': 'Санкт-Петербург',
        'city_id': city_id,
        'era': 'imperial',
        'shown_events': set()
    }

    await update.message.reply_text(
        f"👋 Привет, {user.first_name}!\n\n"
        "Я - бот «Дневной Петербург». Я буду присылать тебе интересные "
        "исторические события.\n\n"
        "Сейчас настроено:\n"
        f"📍 Город: {user_data[user.id]['city']}\n"
        f"⏳ Эпоха: Императорская Россия (XVIII-XX вв.)",
        reply_markup=main_menu_keyboard()
    )
    return MAIN_MENU


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "ℹ️ Помощь по боту:\n\n"
        "/start - Начать работу с ботом\n"
        "/help - Показать эту справку\n"
        "/subscribe - Получать ежедневные события\n"
        "/unsubscribe - Не получать ежедневные события\n\n"
        "Используйте кнопки меню для:\n"
        "📍 Изменения города\n"
        "⏳ Выбора исторического периода\n"
        "📜 Получения события\n"
        "📅 Подписки на ежедневные события",
        reply_markup=main_menu_keyboard()
    )


# Обработчики меню
async def main_menu(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    if query.data == 'change_city':
        await query.edit_message_text(
            "Введите название города:",
            reply_markup=cancel_keyboard()
        )
        return SELECT_CITY

    elif query.data == 'choose_era':
        await query.edit_message_text(
            "Выберите интересующую эпоху:",
            reply_markup=eras_keyboard()
        )
        return SELECT_ERA

    elif query.data == 'get_event':
        event = await get_historical_event(query.from_user.id)
        await query.edit_message_text(
            f"📜 Историческое событие:\n\n{event}\n\n",
            reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("🔁 Еще событие", callback_data='get_event')],
                [InlineKeyboardButton("↩️ В главное меню", callback_data='back')]
            ])
        )
        return MAIN_MENU

    elif query.data == 'subscribe':
        user = query.from_user
        if user.id not in subscribers:
            subscribers[user.id] = user_data[user.id]
            await query.edit_message_text(
                "✅ Вы подписались на ежедневные исторические события!\n"
                "Каждый день в 10:00 вы будете получать новое событие.",
                reply_markup=main_menu_keyboard()
            )
        else:
            await query.edit_message_text(
                "Вы уже подписаны на ежедневные события!",
                reply_markup=main_menu_keyboard()
            )
        return MAIN_MENU

    elif query.data == 'help':
        return await help_command(update, context)

    elif query.data == 'cancel':
        return await cancel(update, context)

    elif query.data == 'back':
        await query.edit_message_text(
            "Главное меню:",
            reply_markup=main_menu_keyboard()
        )
        return MAIN_MENU

    return MAIN_MENU


async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    await query.edit_message_text(
        "Действие отменено",
        reply_markup=main_menu_keyboard()
    )
    return MAIN_MENU


async def send_daily_event(context: ContextTypes.DEFAULT_TYPE) -> None:
    """Отправляет ежедневное событие всем подписчикам."""
    for user_id, user_info in subscribers.items():
        try:
            event = await get_historical_event(user_id)
            await context.bot.send_message(
                chat_id=user_id,
                text=f"📜 Ежедневное историческое событие:\n\n{event}\n\n",
                reply_markup=InlineKeyboardMarkup([
                    [InlineKeyboardButton("🔁 Еще событие", callback_data='get_event')],
                    [InlineKeyboardButton("↩️ В главное меню", callback_data='back')]
                ])
            )
        except Exception as e:
            logger.error(f"Error sending daily event to user {user_id}: {e}")


async def subscribe(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Подписывает пользователя на ежедневные события."""
    user = update.effective_user
    if user.id not in subscribers:
        subscribers[user.id] = user_data[user.id]
        await update.message.reply_text(
            "✅ Вы подписались на ежедневные исторические события!\n"
            "Каждый день в 10:00 вы будете получать новое событие.",
            reply_markup=main_menu_keyboard()
        )
    else:
        await update.message.reply_text(
            "Вы уже подписаны на ежедневные события!",
            reply_markup=main_menu_keyboard()
        )


async def unsubscribe(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Отписывает пользователя от ежедневных событий."""
    user = update.effective_user
    if user.id in subscribers:
        del subscribers[user.id]
        await update.message.reply_text(
            "❌ Вы отписались от ежедневных исторических событий.",
            reply_markup=main_menu_keyboard()
        )
    else:
        await update.message.reply_text(
            "Вы не были подписаны на ежедневные события.",
            reply_markup=main_menu_keyboard()
        )


# Основная функция
def main() -> None:
    application = Application.builder().token("7163161959:AAECiAYMJlfo_40ka-9oapDNrA1fHmJeHjM").build()

    # Добавляем обработчики команд
    application.add_handler(CommandHandler('subscribe', subscribe))
    application.add_handler(CommandHandler('unsubscribe', unsubscribe))

    # Настраиваем ежедневную отправку событий в 10:00
    job_queue = application.job_queue
    job_queue.run_daily(
        send_daily_event,
        time=time(hour=10, minute=0),
        name='daily_event'
    )

    conv_handler = ConversationHandler(
        entry_points=[CommandHandler('start', start)],
        states={
            MAIN_MENU: [
                CallbackQueryHandler(main_menu, pattern='^(change_city|choose_era|get_event|subscribe|help|cancel|back)$')
            ],
            SELECT_CITY: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, select_city),
                CallbackQueryHandler(cancel, pattern='^cancel$')
            ],
            SELECT_ERA: [
                CallbackQueryHandler(select_era, pattern='^era_'),
                CallbackQueryHandler(main_menu, pattern='^back$'),
                CallbackQueryHandler(cancel, pattern='^cancel$')
            ]
        },
        fallbacks=[
            CommandHandler('help', help_command),
            CommandHandler('start', start)
        ],
        per_message=False
    )

    application.add_handler(conv_handler)
    application.add_handler(CommandHandler('help', help_command))

    application.run_polling()


if __name__ == '__main__':
    main()