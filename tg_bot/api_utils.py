import logging

import aiohttp
import requests
import asyncio
from typing import Dict, List, Optional, Set, Tuple
from datetime import datetime
import re
from urllib.parse import quote

# Настройка логирования
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.DEBUG  # Изменяем уровень на DEBUG
)
logger = logging.getLogger(__name__)

# Константы для API
WIKIDATA_API_URL = "https://www.wikidata.org/w/api.php"
WIKIDATA_SPARQL_URL = "https://query.wikidata.org/sparql"
WIKIPEDIA_API_URL = "https://ru.wikipedia.org/w/api.php"

# Кэш для хранения результатов
cache = {
    'city_ids': {},
    'page_info': {},
    'related_articles': {},
    'search_results': {}
}

# Временные границы для эпох
ERA_RANGES = {
    'ancient_rus': {'start': '0800', 'end': '1547', 'name': 'Древняя Русь (IX-XVI вв.)'},
    'tsar_rus': {'start': '1547', 'end': '1721', 'name': 'Царская Россия (XVI-XVIII вв.)'},
    'imperial': {'start': '1721', 'end': '1917', 'name': 'Императорская Россия (XVIII-XX вв.)'},
    'soviet': {'start': '1917', 'end': '1991', 'name': 'Советский период (1917-1991)'},
    'modern': {'start': '1991', 'end': str(datetime.now().year), 'name': 'Наше время (с 1991)'}
}

async def get_city_wikidata_id(city_name: str) -> Optional[str]:
    """Получает ID города в Wikidata с использованием кэша."""
    if city_name in cache['city_ids']:
        return cache['city_ids'][city_name]

    try:
        params = {
            'action': 'wbsearchentities',
            'format': 'json',
            'language': 'ru',
            'type': 'item',
            'search': city_name
        }
        async with aiohttp.ClientSession() as session:
            async with session.get(WIKIDATA_API_URL, params=params) as response:
                if response.status == 200:
                    data = await response.json()
                    if data.get('search'):
                        city_id = data['search'][0]['id']
                        cache['city_ids'][city_name] = city_id
                        return city_id
        return None
    except Exception as e:
        logger.error(f"Error getting Wikidata ID for city {city_name}: {e}")
        return None

async def fetch_wikidata_events(city_id: str, era: str, exclude_events: Set[str] = None) -> List[Dict]:
    """Получает исторические события из Wikidata с улучшенным поиском."""
    try:
        era_range = ERA_RANGES.get(era)
        if not era_range:
            logger.error(f"Invalid era: {era}")
            return []

        logger.info(f"Fetching Wikidata events for city_id: {city_id}, era: {era}")
        logger.info(f"Era range: {era_range['start']} - {era_range['end']}")

        # Получаем координаты города
        city_coords = await get_city_coordinates(city_id)
        if city_coords:
            logger.info(f"Using city coordinates as fallback: {city_coords}")

        # Измененный SPARQL запрос с более широким поиском и координатами
        query = f"""
        SELECT DISTINCT ?event ?eventLabel ?date ?description ?coord WHERE {{
          ?event wdt:P31 wd:Q1190554;  # instance of historical event
                wdt:P585 ?date.        # point in time
          
          # Расширенный поиск по локации
          {{
            ?event wdt:P276 ?city.     # direct location
            ?city wdt:P31 wd:Q515;     # instance of city
            wd:{city_id} ?city.        # city ID
          }} UNION {{
            ?event wdt:P276 ?location. # location
            ?location wdt:P131* wd:{city_id}. # administrative unit of city
          }}
          
          OPTIONAL {{ ?event schema:description ?description FILTER(LANG(?description) = "ru") }}
          OPTIONAL {{ ?event wdt:P625 ?coord }}  # coordinates
          FILTER(?date >= "{era_range['start']}-01-01T00:00:00Z"^^xsd:dateTime &&
                 ?date <= "{era_range['end']}-12-31T23:59:59Z"^^xsd:dateTime)
          SERVICE wikibase:label {{ bd:serviceParam wikibase:language "[AUTO_LANGUAGE],ru". }}
        }}
        ORDER BY ?date
        LIMIT 100
        """

        logger.debug(f"Wikidata SPARQL query: {query}")

        headers = {
            'Accept': 'application/sparql-results+json',
            'User-Agent': 'HistoricalEventsBot/1.0'
        }

        async with aiohttp.ClientSession() as session:
            async with session.get(WIKIDATA_SPARQL_URL, params={'query': query}, headers=headers) as response:
                if response.status == 200:
                    data = await response.json()
                    logger.debug(f"Wikidata raw response: {data}")
                    
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
                                    logger.debug(f"Added event coordinates for {event['label']}: {lat}, {lon}")
                            except Exception as e:
                                logger.error(f"Error parsing coordinates for event {event['label']}: {e}")
                                if city_coords:
                                    event['coordinates'] = city_coords
                                    logger.info(f"Using city coordinates for event {event['label']} after parsing error")
                        elif city_coords:
                            # Если координаты события не найдены, используем координаты города
                            event['coordinates'] = city_coords
                            logger.info(f"Using city coordinates for event {event['label']} (no event coordinates)")
                        
                        if exclude_events is None or event['label'] not in exclude_events:
                            events.append(event)
                            logger.debug(f"Added Wikidata event: {event['label']} ({event['date']})")
                    
                    logger.info(f"Successfully fetched {len(events)} events from Wikidata")
                    if not events:
                        logger.warning("No events found in Wikidata response")
                    return events
                else:
                    response_text = await response.text()
                    logger.error(f"Wikidata SPARQL request failed with status {response.status}")
                    logger.error(f"Response: {response_text}")
                    return []
    except Exception as e:
        logger.error(f"Error fetching Wikidata events: {e}", exc_info=True)
        return []

async def fetch_wikipedia_events(city: str, era: str, exclude_events: Set[str] = None) -> List[Dict]:
    """Получает исторические события из Wikipedia."""
    try:
        era_range = ERA_RANGES.get(era)
        if not era_range:
            logger.error(f"Invalid era: {era}")
            return []

        logger.info(f"Fetching Wikipedia events for city: {city}, era: {era}")

        # Поисковые запросы
        search_queries = [
            f"{city} история {era_range['start']}-{era_range['end']}",
            f"{city} события {era_range['start']}-{era_range['end']}",
            f"{city} исторические события",
            f"{city} {era_range['name']}"
        ]

        logger.info(f"Search queries: {search_queries}")

        found_pages = set()
        events = []

        for query in search_queries:
            if query in cache['search_results']:
                logger.info(f"Using cached results for query: {query}")
                found_pages.update(cache['search_results'][query])
                continue

            try:
                params = {
                    'action': 'query',
                    'format': 'json',
                    'list': 'search',
                    'srsearch': query,
                    'srlimit': 50,
                    'srprop': 'snippet|title',
                    'srnamespace': 0
                }

                logger.debug(f"Wikipedia search params: {params}")

                async with aiohttp.ClientSession() as session:
                    async with session.get(WIKIPEDIA_API_URL, params=params) as response:
                        if response.status == 200:
                            data = await response.json()
                            if 'query' in data and 'search' in data['query']:
                                page_ids = [str(page['pageid']) for page in data['query']['search']]
                                found_pages.update(page_ids)
                                cache['search_results'][query] = page_ids
                                logger.info(f"Found {len(page_ids)} pages for query: {query}")
                            else:
                                logger.warning(f"No search results for query: {query}")
                                logger.debug(f"Wikipedia response: {data}")
                            await asyncio.sleep(1)  # Задержка между запросами
            except Exception as e:
                logger.error(f"Error in Wikipedia search for query '{query}': {e}", exc_info=True)
                continue

        # Получаем информацию о страницах
        if found_pages:
            logger.info(f"Processing {len(found_pages)} found pages")
            events.extend(await fetch_pages_info(list(found_pages), city, era_range, exclude_events))
            logger.info(f"Extracted {len(events)} events from Wikipedia pages")
        else:
            logger.warning("No pages found in Wikipedia search")

        return events
    except Exception as e:
        logger.error(f"Error in fetch_wikipedia_events: {e}", exc_info=True)
        return []

async def fetch_pages_info(page_ids: List[str], city: str, era_range: Dict, exclude_events: Set[str] = None) -> List[Dict]:
    """Получает информацию о страницах Wikipedia."""
    events = []
    processed_page_ids = set()
    processed_titles = set()

    logger.info(f"Fetching info for {len(page_ids)} Wikipedia pages")

    # Разбиваем page_ids на группы по 35 для избежания слишком длинных URL
    for i in range(0, len(page_ids), 35):
        group = page_ids[i:i + 35]
        group_key = ','.join(group)
        
        logger.info(f"Processing group {i//35 + 1} of {(len(page_ids) + 34)//35} ({len(group)} pages)")
        
        if group_key in cache['page_info']:
            logger.info(f"Using cached info for group {i//35 + 1}")
            events.extend(await process_cached_pages(cache['page_info'][group_key], city, era_range, exclude_events, processed_page_ids, processed_titles))
            continue

        try:
            params = {
                'action': 'query',
                'format': 'json',
                'pageids': '|'.join(group),
                'prop': 'extracts|pageimages|info|categories',
                'exintro': 1,
                'explaintext': 1,
                'inprop': 'url',
                'cllimit': 50
            }

            logger.debug(f"Wikipedia API params for group {i//35 + 1}: {params}")

            async with aiohttp.ClientSession() as session:
                async with session.get(WIKIPEDIA_API_URL, params=params) as response:
                    if response.status == 200:
                        data = await response.json()
                        if 'query' in data and 'pages' in data['query']:
                            pages = data['query']['pages']
                            logger.info(f"Successfully retrieved info for {len(pages)} pages in group {i//35 + 1}")
                            
                            # Проверяем наличие ошибок в ответе
                            for page_id, page in pages.items():
                                if 'missing' in page:
                                    logger.warning(f"Page {page_id} is missing: {page.get('title', 'Unknown')}")
                                if 'invalid' in page:
                                    logger.warning(f"Page {page_id} is invalid: {page.get('title', 'Unknown')}")
                            
                            cache['page_info'][group_key] = pages
                            events.extend(await process_pages(pages, city, era_range, exclude_events, processed_page_ids, processed_titles))
                        else:
                            logger.error(f"Invalid response format for group {i//35 + 1}")
                            logger.debug(f"Response data: {data}")
                    else:
                        response_text = await response.text()
                        logger.error(f"Wikipedia API request failed for group {i//35 + 1} with status {response.status}")
                        logger.error(f"Response: {response_text}")
                    await asyncio.sleep(1)  # Задержка между запросами
        except Exception as e:
            logger.error(f"Error fetching page info for group {i//35 + 1}: {e}", exc_info=True)
            continue

    logger.info(f"Total events found after processing all pages: {len(events)}")
    return events

async def process_pages(pages: Dict, city: str, era_range: Dict, exclude_events: Set[str], 
                       processed_page_ids: Set[str], processed_titles: Set[str]) -> List[Dict]:
    """Обрабатывает страницы Wikipedia и извлекает события."""
    events = []
    
    logger.info(f"Processing {len(pages)} Wikipedia pages for city: {city}")
    
    # Получаем координаты города
    city_id = await get_city_wikidata_id(city)
    city_coords = None
    if city_id:
        city_coords = await get_city_coordinates(city_id)
        if city_coords:
            logger.info(f"Using city coordinates for events: {city_coords}")
    
    # Список ключевых слов, которые указывают на то, что страница НЕ является событием
    non_event_keywords = [
        'список', 'категория', 'шаблон', 'проект', 'портал', 'википедия',
        'российская империя', 'история россии', 'хронология', 'эпоха',
        'период', 'век', 'годы', 'года', 'году', 'годах'
    ]
    
    # Список ключевых слов для категорий, которые указывают на события
    event_category_keywords = [
        'исторические события', 'события по годам', 'события по месяцам',
        'события по дням', 'исторические даты', 'важные события',
        'знаменательные события', 'исторические факты'
    ]
    
    # Список ключевых слов в заголовке, которые указывают на событие
    event_title_keywords = [
        'событие', 'сражение', 'битва', 'война', 'революция', 'восстание',
        'пожар', 'наводнение', 'открытие', 'основание', 'создание',
        'построен', 'построена', 'построено', 'заложен', 'заложена',
        'заложено', 'учрежден', 'учреждена', 'учреждено'
    ]
    
    for page_id, page in pages.items():
        if page_id in processed_page_ids or page.get('title') in processed_titles:
            logger.debug(f"Skipping already processed page: {page.get('title')}")
            continue

        processed_page_ids.add(page_id)
        processed_titles.add(page.get('title', ''))
        
        title = page.get('title', '').lower()
        text = page.get('extract', '').lower()
        
        # Проверяем, не является ли страница не-событием
        if any(keyword in title.lower() for keyword in non_event_keywords):
            logger.debug(f"Page {title} skipped - matches non-event keywords")
            continue
            
        # Проверяем категории
        categories = [cat.get('title', '').lower() for cat in page.get('categories', [])]
        logger.debug(f"Page {title} categories: {categories}")
        
        # Проверяем наличие категорий событий
        has_event_category = any(
            any(keyword in cat for keyword in event_category_keywords)
            for cat in categories
        )
        
        # Проверяем заголовок на наличие ключевых слов событий
        has_event_title = any(keyword in title for keyword in event_title_keywords)
        
        # Проверяем наличие дат в тексте
        has_dates = bool(find_dates_in_text(text))
        
        # Страница должна соответствовать хотя бы двум критериям из трех
        if sum([has_event_category, has_event_title, has_dates]) < 2:
            logger.debug(f"Page {title} skipped - insufficient event indicators")
            continue

        # Проверяем релевантность городу
        city_mentions = text.count(city.lower())
        logger.debug(f"Page {title} city mentions: {city_mentions}")
        
        if city_mentions < 1:
            logger.debug(f"Page {title} skipped - insufficient city mentions")
            continue

        # Ищем даты в тексте
        dates = find_dates_in_text(text)
        logger.debug(f"Page {title} found dates: {[d.strftime('%Y-%m-%d') for d in dates]}")
        
        # Если даты не найдены, но текст содержит упоминания годов и есть признаки события
        if not dates and has_event_title and any(str(year) in text for year in range(int(era_range['start']), int(era_range['end']) + 1)):
            # Добавляем событие с примерной датой
            event = {
                'label': page.get('title', 'Неизвестное событие'),
                'date': f"{era_range['start']}-01-01",  # Используем начало эпохи как примерную дату
                'description': text[:500] + '...' if len(text) > 500 else text,
                'url': page.get('fullurl', '')
            }
            if city_coords:
                event['coordinates'] = city_coords
            if exclude_events is None or event['label'] not in exclude_events:
                events.append(event)
                logger.info(f"Added event with approximate date from page {title}")
            continue
        
        for date in dates:
            if is_date_in_range(date, era_range):
                event = {
                    'label': page.get('title', 'Неизвестное событие'),
                    'date': date.strftime('%Y-%m-%d'),
                    'description': text[:500] + '...' if len(text) > 500 else text,
                    'url': page.get('fullurl', '')
                }
                if city_coords:
                    event['coordinates'] = city_coords
                
                if exclude_events is None or event['label'] not in exclude_events:
                    events.append(event)
                    logger.info(f"Added event from page {title} with date {date.strftime('%Y-%m-%d')}")
            else:
                logger.debug(f"Date {date.strftime('%Y-%m-%d')} from page {title} outside era range")

    logger.info(f"Processed pages resulted in {len(events)} events")
    return events

def find_dates_in_text(text: str) -> List[datetime]:
    """Ищет даты в тексте."""
    dates = []
    
    # Паттерны для поиска дат
    patterns = [
        r'\b(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(\d{4})\b',
        r'\b(\d{4})[-–](\d{1,2})[-–](\d{1,2})\b',
        r'\b(\d{1,2})[-–](\d{1,2})[-–](\d{4})\b'
    ]
    
    month_map = {
        'января': 1, 'февраля': 2, 'марта': 3, 'апреля': 4,
        'мая': 5, 'июня': 6, 'июля': 7, 'августа': 8,
        'сентября': 9, 'октября': 10, 'ноября': 11, 'декабря': 12
    }
    
    logger.debug(f"Searching for dates in text of length: {len(text)}")
    
    for pattern in patterns:
        matches = re.finditer(pattern, text, re.IGNORECASE)
        for match in matches:
            try:
                if 'января' in pattern:  # Русский формат
                    day, month, year = match.groups()
                    month = month_map[month.lower()]
                    logger.debug(f"Found Russian date: {day}.{month}.{year}")
                else:  # ISO формат
                    if pattern == r'\b(\d{4})[-–](\d{1,2})[-–](\d{1,2})\b':
                        year, month, day = map(int, match.groups())
                        logger.debug(f"Found ISO date (YMD): {year}-{month}-{day}")
                    else:
                        day, month, year = map(int, match.groups())
                        logger.debug(f"Found ISO date (DMY): {day}-{month}-{year}")
                
                date = datetime(int(year), int(month), int(day))
                if 800 <= date.year <= 2100:  # Фильтруем нереалистичные даты
                    dates.append(date)
                    logger.debug(f"Added valid date: {date.strftime('%Y-%m-%d')}")
                else:
                    logger.debug(f"Skipped date outside valid range: {date.strftime('%Y-%m-%d')}")
            except (ValueError, KeyError) as e:
                logger.debug(f"Error parsing date: {match.group()} - {str(e)}")
                continue
    
    logger.info(f"Found {len(dates)} valid dates in text")
    return dates

def is_date_in_range(date: datetime, era_range: Dict) -> bool:
    """Проверяет, находится ли дата в указанном диапазоне."""
    start_year = int(era_range['start'])
    end_year = int(era_range['end'])
    return start_year <= date.year <= end_year

async def get_combined_events(city: str, era: str, exclude_events: Set[str] = None) -> List[Dict]:
    """Получает события из обоих источников и объединяет результаты."""
    logger.info(f"Starting combined search for city: {city}, era: {era}")
    
    city_id = await get_city_wikidata_id(city)
    if not city_id:
        logger.error(f"Could not find Wikidata ID for city: {city}")
        return []
    
    logger.info(f"Found Wikidata ID for {city}: {city_id}")

    # Получаем события из обоих источников параллельно
    try:
        wikidata_events, wikipedia_events = await asyncio.gather(
            fetch_wikidata_events(city_id, era, exclude_events),
            fetch_wikipedia_events(city, era, exclude_events)
        )
        
        logger.info(f"Found {len(wikidata_events)} events from Wikidata and {len(wikipedia_events)} events from Wikipedia")
        
        # Объединяем результаты, удаляя дубликаты
        all_events = []
        seen_titles = set()

        for event in wikidata_events + wikipedia_events:
            if event['label'] not in seen_titles:
                seen_titles.add(event['label'])
                all_events.append(event)

        logger.info(f"Combined unique events: {len(all_events)}")
        return all_events
    except Exception as e:
        logger.error(f"Error in get_combined_events: {e}", exc_info=True)
        return []

def format_event_message(event: Dict, city: str) -> Tuple[str, str]:
    """Форматирует сообщение о событии для Telegram."""
    try:
        date = datetime.fromisoformat(event['date'].replace('Z', '+00:00'))
        formatted_date = date.strftime('%d.%m.%Y')
    except:
        formatted_date = event['date']

    # Формируем сообщение
    message = f"<b>📅 {formatted_date}</b>\n\n"
    message += f"<b>📜 {event['label']}</b>\n"

    if event.get('description'):
        message += f"\n📝 {event['description']}\n"

    message += f"\n🏙 {city}\n"

    # Формируем URL для карты
    event_label = quote(event['label'])
    formatted_date_url = quote(formatted_date)
    city_url = quote(city)
    
    # Добавляем подробное логирование для отладки координат
    logger.info(f"Processing event in format_event_message: {event['label']}")
    logger.info(f"Event data: {event}")
    
    # Добавляем координаты в URL, если они есть
    coords_param = ""
    if 'coordinates' in event:
        try:
            lat, lon = event['coordinates']
            coords_param = f"&lat={lat}&lon={lon}"
            logger.info(f"Adding coordinates to URL for event {event['label']}: lat={lat}, lon={lon}")
        except Exception as e:
            logger.error(f"Error processing coordinates for event {event['label']}: {e}")
            logger.error(f"Coordinates value: {event.get('coordinates')}")
    else:
        logger.info(f"No coordinates found for event {event['label']}")
    
    url = f"https://mnstupichev.github.io/History-project/?event={event_label}&date={formatted_date_url}&city={city_url}{coords_param}"
    logger.info(f"Generated URL for event {event['label']}: {url}")

    return message, url

async def process_cached_pages(pages: Dict, city: str, era_range: Dict, exclude_events: Set[str],
                            processed_page_ids: Set[str], processed_titles: Set[str]) -> List[Dict]:
    """Обрабатывает страницы из кэша."""
    return await process_pages(pages, city, era_range, exclude_events, processed_page_ids, processed_titles)

async def get_city_coordinates(city_id: str) -> Optional[Tuple[float, float]]:
    """Получает координаты города из Wikidata."""
    try:
        query = f"""
        SELECT ?lat ?lon WHERE {{
          wd:{city_id} wdt:P625 ?coord.
          BIND(xsd:decimal(strbefore(strafter(str(?coord), "Point("), " ")) AS ?lon)
          BIND(xsd:decimal(strbefore(strafter(str(?coord), " "), ")")) AS ?lat)
        }}
        LIMIT 1
        """

        logger.debug(f"Fetching coordinates for city {city_id}")
        
        headers = {
            'Accept': 'application/sparql-results+json',
            'User-Agent': 'HistoricalEventsBot/1.0'
        }

        async with aiohttp.ClientSession() as session:
            async with session.get(WIKIDATA_SPARQL_URL, params={'query': query}, headers=headers) as response:
                if response.status == 200:
                    data = await response.json()
                    results = data.get('results', {}).get('bindings', [])
                    if results:
                        lat = float(results[0]['lat']['value'])
                        lon = float(results[0]['lon']['value'])
                        logger.info(f"Found coordinates for city {city_id}: {lat}, {lon}")
                        return lat, lon
                    else:
                        logger.warning(f"No coordinates found for city {city_id}")
                        return None
                else:
                    response_text = await response.text()
                    logger.error(f"Failed to get coordinates for city {city_id}: {response.status}")
                    logger.error(f"Response: {response_text}")
                    return None
    except Exception as e:
        logger.error(f"Error getting coordinates for city {city_id}: {e}", exc_info=True)
        return None 