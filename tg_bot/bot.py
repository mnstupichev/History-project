import os
import logging
from typing import Dict
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

# Состояния диалога
MAIN_MENU, SELECT_CITY, SELECT_ERA = range(3)

# Данные пользователей
user_data: Dict[int, Dict] = {}


# Клавиатуры
def main_menu_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🔄 Изменить город", callback_data='change_city')],
        [InlineKeyboardButton("⏳ Выбрать эпоху", callback_data='choose_era')],
        [InlineKeyboardButton("📜 Получить событие сейчас", callback_data='get_event')],
        [InlineKeyboardButton("ℹ️ Помощь", callback_data='help')]
    ])


def eras_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🔰 Средние века (V-XV вв.)", callback_data='era_middle_ages')],
        [InlineKeyboardButton("🎨 Эпоха Возрождения (XIV-XVI вв.)", callback_data='era_renaissance')],
        [InlineKeyboardButton("👑 Императорская Россия (XVIII-XX вв.)", callback_data='era_imperial')],
        [InlineKeyboardButton("☭ Советский период (1917-1991)", callback_data='era_soviet')],
        [InlineKeyboardButton("🏛 Современная Россия (с 1991)", callback_data='era_modern')],
        [InlineKeyboardButton("↩️ Назад", callback_data='back')]
    ])


def cancel_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("❌ Отмена", callback_data='cancel')]
    ])


# Обработчики команд
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    user = update.effective_user
    user_data[user.id] = {
        'city': 'Санкт-Петербург',
        'era': 'imperial',
        'sent_events': set()
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
        "/help - Показать эту справку\n\n"
        "Используйте кнопки меню для:\n"
        "📍 Изменения города\n"
        "⏳ Выбора исторического периода\n"
        "📜 Получения события по требованию",
        reply_markup=main_menu_keyboard()
    )


# Получение исторического события (заглушка - реализуйте по аналогии с вашим API)
async def get_historical_event(user_id: int) -> str:
    city = user_data[user_id]['city']
    era = user_data[user_id]['era']

    # Здесь должна быть реализация запроса к вашему API
    # Временная заглушка:
    events = {
        'middle_ages': f"В {city} в средние века произошло важное событие...",
        'renaissance': f"В эпоху Возрождения в {city}...",
        'imperial': f"Императорский период в {city} был отмечен...",
        'soviet': f"В советское время в {city}...",
        'modern': f"Современная история {city}..."
    }
    return events.get(era, "Интересное историческое событие")


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
            f"📜 Историческое событие:\n\n{event}\n\n"
            "Хотите получить еще одно событие?",
            reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("🔁 Еще событие", callback_data='get_event')],
                [InlineKeyboardButton("↩️ Назад", callback_data='back')]
            ])
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


async def select_city(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    user = update.effective_user
    city = update.message.text

    user_data[user.id]['city'] = city
    user_data[user.id]['sent_events'] = set()

    await update.message.reply_text(
        f"✅ Город изменён на {city}",
        reply_markup=main_menu_keyboard()
    )
    return MAIN_MENU


async def select_era(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    user = update.effective_user
    era = query.data.split('_')[1]

    user_data[user.id]['era'] = era
    user_data[user.id]['sent_events'] = set()

    era_names = {
        'middle_ages': 'Средние века (V-XV вв.)',
        'renaissance': 'Эпоха Возрождения (XIV-XVI вв.)',
        'imperial': 'Императорская Россия (XVIII-XX вв.)',
        'soviet': 'Советский период (1917-1991)',
        'modern': 'Современная Россия (с 1991)'
    }

    await query.edit_message_text(
        f"✅ Выбрана эпоха: {era_names[era]}",
        reply_markup=main_menu_keyboard()
    )
    return MAIN_MENU


async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    await query.edit_message_text(
        "Действие отменено",
        reply_markup=main_menu_keyboard()
    )
    return MAIN_MENU


# Основная функция
def main() -> None:
    application = Application.builder().token("7163161959:AAECiAYMJlfo_40ka-9oapDNrA1fHmJeHjM").build()

    conv_handler = ConversationHandler(
        entry_points=[CommandHandler('start', start)],
        states={
            MAIN_MENU: [
                CallbackQueryHandler(main_menu, pattern='^(change_city|choose_era|get_event|help|cancel|back)$')
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