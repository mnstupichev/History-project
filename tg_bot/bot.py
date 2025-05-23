import html
import logging
import requests
import random
import asyncio
import re
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
from api_utils import (
    get_combined_events,
    format_event_message,
    ERA_RANGES
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
MAIN_MENU, SELECT_CITY, SELECT_ERA, SELECT_TIME = range(4)

# Данные пользователей
user_data: Dict[int, Dict] = {}

# Добавляем словарь для хранения подписчиков с их временем
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

        # SPARQL запрос для получения исторических событий с координатами
        query = f"""
                SELECT ?event ?eventLabel ?date ?description ?coord WHERE {{
                  ?event wdt:P31 wd:Q1190554;  # instance of historical event
                        wdt:P585 ?date;        # point in time
                        wdt:P276/wdt:P131* wd:{city_id}. # location (city and its administrative units)
                  OPTIONAL {{ ?event schema:description ?description FILTER(LANG(?description) = "ru") }}
                  OPTIONAL {{ ?event wdt:P625 ?coord }}  # coordinates
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
            
            # Обрабатываем координаты, если они есть
            if 'coord' in result:
                coord_value = result['coord']['value']
                try:
                    # Парсим координаты из формата Point(lon lat)
                    match = re.match(r'Point\(([-\d.]+) ([-\d.]+)\)', coord_value)
                    if match:
                        lon, lat = map(float, match.groups())
                        event['coordinates'] = [lat, lon]
                        logger.info(f"Added coordinates for event {event['label']}: {lat}, {lon}")
                except Exception as e:
                    logger.error(f"Error parsing coordinates for event {event['label']}: {e}")
            
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


def time_slider_keyboard(current_hour: int = 10) -> InlineKeyboardMarkup:
    """Создает клавиатуру-слайдер для выбора времени."""
    keyboard = [
        [
            InlineKeyboardButton("◀️", callback_data='time_prev'),
            InlineKeyboardButton(f"{current_hour:02d}:00", callback_data='time_confirm'),
            InlineKeyboardButton("▶️", callback_data='time_next')
        ],
        [InlineKeyboardButton("↩️ Назад", callback_data='back')]
    ]
    return InlineKeyboardMarkup(keyboard)


async def get_historical_event(user_id: int) -> str:
    """Получает историческое событие из Wikidata и Wikipedia."""
    try:
        city = user_data[user_id]['city']
        era = user_data[user_id]['era']

        # Получаем уже показанные события
        shown_events = user_data[user_id].get('shown_events', set())

        # Получаем новые события, исключая уже показанные
        events = await get_combined_events(city, era, shown_events)

        if not events:
            if shown_events:
                return f"К сожалению, все исторические события для {city} в выбранный период уже были показаны."
            return f"К сожалению, не удалось найти исторические события для {city} в выбранный период."

        # Выбираем случайное событие
        event = random.choice(events)
        logger.info(f"Selected event for formatting: {event}")

        # Добавляем событие в список показанных
        if 'shown_events' not in user_data[user_id]:
            user_data[user_id]['shown_events'] = set()
        user_data[user_id]['shown_events'].add(event['label'])

        # Форматируем сообщение
        message, url = format_event_message(event, city)
        logger.info(f"Generated URL: {url}")
        message += f"\n🗺 <a href='{url}'>Событие на карте</a>"

        return message

    except Exception as e:
        logger.error(f"Error in get_historical_event: {e}", exc_info=True)
        return "Произошла ошибка при получении исторического события. Пожалуйста, попробуйте позже."


async def select_era(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    user = update.effective_user
    # Исправляем получение эпохи из callback_data
    era = query.data.replace('era_', '')  # Убираем префикс 'era_'

    user_data[user.id]['era'] = era
    user_data[user.id]['shown_events'] = set()  # Сбрасываем список показанных событий

    era_names = {
        'ancient_rus': 'Древняя Русь (IX-XVI вв.)',
        'tsar_rus': 'Царская Россия (XVI-XVIII вв.)',
        'imperial': 'Императорская Россия (XVIII-XX вв.)',
        'soviet': 'Советский период (1917-1991)',
        'modern': 'Наше время (с 1991)'
    }

    if era not in era_names:
        logger.error(f"Invalid era selected: {era}")
        await query.edit_message_text(
            "❌ Произошла ошибка при выборе эпохи. Пожалуйста, попробуйте снова.",
            reply_markup=eras_keyboard()
        )
        return SELECT_ERA

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
        # Показываем индикатор загрузки
        loading_message = await query.edit_message_text(
            "⏳ Ищу исторические события...\n\n"
            "🔍 Проверяю Wikidata...\n"
            "📚 Ищу в Wikipedia...\n"
            "📅 Анализирую даты...",
            reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("🔄 Обновить статус", callback_data='loading_status')]
            ])
        )

        # Создаем задачу для обновления статуса загрузки
        status_messages = [
            "🔍 Проверяю Wikidata...",
            "📚 Ищу в Wikipedia...",
            "📅 Анализирую даты...",
            "📝 Форматирую результаты...",
            "⏳ Почти готово..."
        ]
        status_index = 0

        async def update_loading_status():
            nonlocal status_index
            while True:
                await asyncio.sleep(2)  # Обновляем каждые 2 секунды
                if status_index >= len(status_messages):
                    status_index = 0
                status_text = "\n".join([
                    "⏳ Ищу исторические события...\n",
                    status_messages[status_index]
                ])
                try:
                    await loading_message.edit_text(
                        status_text,
                        reply_markup=InlineKeyboardMarkup([
                            [InlineKeyboardButton("🔄 Обновить статус", callback_data='loading_status')]
                        ])
                    )
                except Exception as e:
                    logger.error(f"Error updating loading status: {e}")
                    break
                status_index += 1

        # Запускаем обновление статуса в фоне
        status_task = asyncio.create_task(update_loading_status())

        try:
            # Получаем событие
            event = await get_historical_event(query.from_user.id)
            
            # Отменяем задачу обновления статуса
            status_task.cancel()
            
            # Показываем результат
            await loading_message.edit_text(
                f"📜 Историческое событие:\n\n{event}\n\n",
                parse_mode="HTML",
                disable_web_page_preview=True,
                reply_markup=InlineKeyboardMarkup([
                    [InlineKeyboardButton("🔁 Еще событие", callback_data='get_event')],
                    [InlineKeyboardButton("↩️ В главное меню", callback_data='back')]
                ])
            )
        except Exception as e:
            # Отменяем задачу обновления статуса
            status_task.cancel()
            
            # Показываем ошибку
            await loading_message.edit_text(
                "❌ Произошла ошибка при получении события. Пожалуйста, попробуйте позже.",
                reply_markup=InlineKeyboardMarkup([
                    [InlineKeyboardButton("🔄 Попробовать снова", callback_data='get_event')],
                    [InlineKeyboardButton("↩️ В главное меню", callback_data='back')]
                ])
            )
            logger.error(f"Error getting event: {e}")

        return MAIN_MENU

    elif query.data == 'loading_status':
        # Обновляем статус загрузки при нажатии кнопки
        await query.answer("⏳ Продолжаю поиск...")
        return MAIN_MENU

    elif query.data == 'subscribe':
        return await subscribe(update, context)

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


async def subscribe(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Начинает процесс подписки на ежедневные события."""
    # Определяем, откуда пришел запрос
    if update.callback_query:
        user = update.callback_query.from_user
        message = update.callback_query.message
    else:
        user = update.effective_user
        message = update.message

    if user.id in subscribers:
        current_time = subscribers[user.id].get('time', time(10, 0))
        if update.callback_query:
            await update.callback_query.edit_message_text(
                "Вы уже подписаны на ежедневные события!\n"
                f"Время получения: {current_time.hour:02d}:00\n"
                "Используйте /unsubscribe для отмены подписки.",
                reply_markup=main_menu_keyboard()
            )
        else:
            await message.reply_text(
                "Вы уже подписаны на ежедневные события!\n"
                f"Время получения: {current_time.hour:02d}:00\n"
                "Используйте /unsubscribe для отмены подписки.",
                reply_markup=main_menu_keyboard()
            )
        return MAIN_MENU

    # Сохраняем начальное время в контексте пользователя
    context.user_data['temp_hour'] = 10

    if update.callback_query:
        await update.callback_query.edit_message_text(
            "Выберите время, в которое хотите получать ежедневные события:",
            reply_markup=time_slider_keyboard(10)
        )
    else:
        await message.reply_text(
            "Выберите время, в которое хотите получать ежедневные события:",
            reply_markup=time_slider_keyboard(10)
        )
    return SELECT_TIME


async def select_time(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Обрабатывает выбор времени через слайдер."""
    query = update.callback_query
    await query.answer()

    if query.data == 'back':
        await query.edit_message_text(
            "Главное меню:",
            reply_markup=main_menu_keyboard()
        )
        return MAIN_MENU

    # Получаем текущий час из контекста пользователя
    current_hour = context.user_data.get('temp_hour', 10)

    if query.data == 'time_prev':
        current_hour = (current_hour - 1) % 24
    elif query.data == 'time_next':
        current_hour = (current_hour + 1) % 24
    elif query.data == 'time_confirm':
        user = query.from_user

        # Сохраняем настройки подписки
        subscribers[user.id] = {
            'city': user_data[user.id]['city'],
            'city_id': user_data[user.id].get('city_id'),
            'era': user_data[user.id]['era'],
            'time': time(hour=current_hour, minute=0)
        }

        # Обновляем задачу в планировщике
        job_name = f'daily_event_{user.id}'
        # Удаляем старую задачу, если она существует
        if job_name in context.job_queue.jobs():
            context.job_queue.jobs()[job_name].schedule_removal()

        # Создаем новую задачу
        context.job_queue.run_daily(
            send_daily_event,
            time=time(hour=current_hour, minute=0),
            name=job_name,
            data={'user_id': user.id}
        )

        await query.edit_message_text(
            f"✅ Вы подписались на ежедневные исторические события!\n"
            f"Время получения: {current_hour:02d}:00",
            reply_markup=main_menu_keyboard()
        )
        return MAIN_MENU

    # Сохраняем новый час в контексте пользователя
    context.user_data['temp_hour'] = current_hour

    # Обновляем клавиатуру с новым временем
    await query.edit_message_text(
        "Выберите время, в которое хотите получать ежедневные события:",
        reply_markup=time_slider_keyboard(current_hour)
    )
    return SELECT_TIME


async def send_daily_event(context: ContextTypes.DEFAULT_TYPE) -> None:
    """Отправляет ежедневное событие подписчику."""
    user_id = context.job.data['user_id']
    if user_id not in subscribers:
        return

    try:
        event_text = await get_historical_event(user_id)
        if event_text.startswith("К сожалению") or event_text.startswith("Произошла ошибка"):
            await context.bot.send_message(
                chat_id=user_id,
                text=f"❌ {event_text}",
                reply_markup=main_menu_keyboard()
            )
            return

        await context.bot.send_message(
            chat_id=user_id,
            text=f"📜 Ежедневное историческое событие:\n\n{event_text}",
            parse_mode='HTML',
            disable_web_page_preview=True,
            reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("🔁 Еще событие", callback_data='get_event')],
                [InlineKeyboardButton("↩️ В главное меню", callback_data='back')]
            ])
        )
    except Exception as e:
        logger.error(f"Error sending daily event to user {user_id}: {e}")
        await context.bot.send_message(
            chat_id=user_id,
            text="❌ Произошла ошибка при отправке события. Пожалуйста, попробуйте позже.",
            reply_markup=main_menu_keyboard()
        )


async def unsubscribe(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Отписывает пользователя от ежедневных событий."""
    user = update.effective_user
    if user.id in subscribers:
        # Удаляем задачу из планировщика
        job_name = f'daily_event_{user.id}'
        if job_name in context.job_queue.jobs():
            context.job_queue.jobs()[job_name].schedule_removal()

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

    conv_handler = ConversationHandler(
        entry_points=[CommandHandler('start', start)],
        states={
            MAIN_MENU: [
                CallbackQueryHandler(main_menu,
                                     pattern='^(change_city|choose_era|get_event|subscribe|help|cancel|back)$')
            ],
            SELECT_CITY: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, select_city),
                CallbackQueryHandler(cancel, pattern='^cancel$')
            ],
            SELECT_ERA: [
                CallbackQueryHandler(select_era, pattern='^era_'),
                CallbackQueryHandler(main_menu, pattern='^back$'),
                CallbackQueryHandler(cancel, pattern='^cancel$')
            ],
            SELECT_TIME: [
                CallbackQueryHandler(select_time, pattern='^(time_prev|time_next|time_confirm|back)$')
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