document.addEventListener('DOMContentLoaded', function() {
    const APP = {
        map: null,
        currentUser: null,
        currentEvents: [],
        currentEventIndex: 0,
        isInitialized: false,
        cityWikidataId: null,
        markers: [],
        timelineStartYear: 1400,
        timelineEndYear: 1700,
        hasProcessedUrlParams: false,
        defaultEvent: {
            title: "Основание Санкт-Петербурга",
            description: "27 мая 1703 года был основан город Санкт-Петербург. В этот день на Заячьем острове была заложена Петропавловская крепость, что считается официальной датой основания города.",
            date: "27.05.1703",
            coordinates: [59.9343, 30.3351],
            link: "https://mnstupichev.github.io/History-project/"
        },
        wikipediaCache: new Map(), // Кэш для хранения данных из Wikipedia
    };

    // Функция для получения параметров из URL
    function getUrlParams() {
        const params = new URLSearchParams(window.location.search);
        return {
            event: params.get('event'),
            date: params.get('date'),
            city: params.get('city')
        };
    }

    // Функция для отображения события из URL
    function displayEventFromUrl() {
        const params = getUrlParams();
        if (!params.event || !params.date || !params.city || APP.hasProcessedUrlParams) {
            return false;
        }

        const cityFromUrl = decodeURIComponent(params.city);

        // Если город из URL отличается от текущего города пользователя,
        // обновляем город пользователя
        if (APP.currentUser && APP.currentUser.city !== cityFromUrl) {
            APP.currentUser.city = cityFromUrl;
            document.getElementById('cityInput').value = cityFromUrl;
            APP.cityWikidataId = null; // Сбрасываем ID города
            localStorage.setItem('currentUser', JSON.stringify(APP.currentUser));
        }

        // Создаем событие из параметров URL
        const event = {
            title: decodeURIComponent(params.event),
            description: `Историческое событие в городе ${cityFromUrl}`,
            date: decodeURIComponent(params.date),
            coordinates: [59.9343, 30.3351] // Координаты Санкт-Петербурга по умолчанию
        };

        // Отображаем событие
        APP.currentEvents = [event];
        APP.currentEventIndex = 0;

        // Очистка предыдущих маркеров
        APP.markers.forEach(marker => marker.remove());
        APP.markers = [];

        // Добавление маркера
        const marker = L.marker(event.coordinates).addTo(APP.map)
            .bindPopup(`<b>${event.title}</b><br>${event.date}`);

        APP.markers.push(marker);
        marker.openPopup();

        // Установка вида карты
        APP.map.setView(event.coordinates, 12);

        // Обновление информации о событии
        displayEventInfo(event);
        updateEventsList();

        APP.hasProcessedUrlParams = true; // Помечаем, что параметры обработаны
        return true;
    }

    // Инициализация приложения
    function init() {
        if (APP.isInitialized) return;

        createBaseStructure();
        setupEventHandlers();
        initTimeline();

        // Проверяем авторизацию
        checkAuth();

        APP.isInitialized = true;
    }

    // Создание базовой структуры страницы
    function createBaseStructure() {
        createAuthModal();
        createProfileModal();
        initMap();
    }

    // Инициализация карты
    function initMap() {
        try {
            APP.map = L.map('map').setView([59.9343, 30.3351], 12); // Центр на Санкт-Петербурге

            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            }).addTo(APP.map);

            if (APP.currentUser) {
                loadUserEvents();
            }
        } catch (error) {
            console.error('Error initializing map:', error);
            document.getElementById('eventInfo').innerHTML = `
                <h2>Ошибка инициализации карты</h2>
                <p>Пожалуйста, обновите страницу или попробуйте позже.</p>
            `;
        }
    }

    // Инициализация таймлайна
    function initTimeline() {
        const timeline = document.querySelector('.timeline');
        const startHandle = document.querySelector('.start-handle');
        const endHandle = document.querySelector('.end-handle');
        const startYearElement = document.getElementById('startYear');
        const endYearElement = document.getElementById('endYear');

        let isDragging = false;
        let activeHandle = null;

        function updateYears() {
            const timelineWidth = timeline.offsetWidth;
            const startPercent = (parseInt(startHandle.style.left) || 0) / timelineWidth * 100;
            const endPercent = (parseInt(endHandle.style.left) || timelineWidth) / timelineWidth * 100;

            const minYear = 1000;
            const maxYear = 2100;  // Изменено с 2000 на 2100 для компенсации размера слайдера

            const startYear = Math.round(minYear + (maxYear - minYear) * (startPercent / 100));
            const endYear = Math.round(minYear + (maxYear - minYear) * (endPercent / 100));

            // Ограничиваем отображаемый год до 2000
            startYearElement.textContent = Math.min(startYear, 2000);
            endYearElement.textContent = Math.min(endYear, 2000);

            // Сохраняем реальные значения для вычислений
            APP.timelineStartYear = Math.min(startYear, 2000);
            APP.timelineEndYear = Math.min(endYear, 2000);
        }

        function moveHandle(handle, position) {
            const timelineWidth = timeline.offsetWidth;
            const handleWidth = handle.offsetWidth;
            const minPosition = 0;
            const maxPosition = timelineWidth - handleWidth;

            let newPosition = position - timeline.getBoundingClientRect().left - (handleWidth / 2);
            newPosition = Math.max(minPosition, Math.min(newPosition, maxPosition));

            if (handle === startHandle) {
                const endPosition = parseInt(endHandle.style.left) || maxPosition;
                newPosition = Math.min(newPosition, endPosition - handleWidth);
            } else {
                const startPosition = parseInt(startHandle.style.left) || 0;
                newPosition = Math.max(newPosition, startPosition + handleWidth);
            }

            handle.style.left = `${newPosition}px`;
            updateYears();
        }

        // Инициализация позиций слайдеров для периода 1400-1700
        function initializeSliderPositions() {
            const timelineWidth = timeline.offsetWidth;
            const handleWidth = startHandle.offsetWidth;
            const minYear = 1000;
            const maxYear = 2100;  // Изменено с 2000 на 2100
            
            // Вычисляем позиции для 1400 и 1700 годов
            const startPosition = ((APP.timelineStartYear - minYear) / (maxYear - minYear)) * (timelineWidth - handleWidth);
            const endPosition = ((APP.timelineEndYear - minYear) / (maxYear - minYear)) * (timelineWidth - handleWidth);
            
            startHandle.style.left = `${startPosition}px`;
            endHandle.style.left = `${endPosition}px`;
            
            // Обновляем отображение годов
            startYearElement.textContent = APP.timelineStartYear;
            endYearElement.textContent = APP.timelineEndYear;
        }

        // Инициализация позиций
        initializeSliderPositions();

        // Обработчики событий для ручек
        [startHandle, endHandle].forEach(handle => {
            // Mouse events
            handle.addEventListener('mousedown', function(e) {
                isDragging = true;
                activeHandle = this;
                e.preventDefault();
            });

            // Touch events
            handle.addEventListener('touchstart', function(e) {
                isDragging = true;
                activeHandle = this;
                e.preventDefault();
            });
        });

        // Mouse move
        document.addEventListener('mousemove', function(e) {
            if (!isDragging || !activeHandle) return;
            moveHandle(activeHandle, e.clientX);
        });

        // Touch move
        document.addEventListener('touchmove', function(e) {
            if (!isDragging || !activeHandle) return;
            moveHandle(activeHandle, e.touches[0].clientX);
        });

        // Mouse up
        document.addEventListener('mouseup', function() {
            isDragging = false;
            activeHandle = null;
        });

        // Touch end
        document.addEventListener('touchend', function() {
            isDragging = false;
            activeHandle = null;
        });

        // Click/tap on timeline
        timeline.addEventListener('click', function(e) {
            const rect = this.getBoundingClientRect();
            const position = e.clientX - rect.left;
            const middle = (parseInt(startHandle.style.left) + parseInt(endHandle.style.left)) / 2;

            if (position < middle) {
                moveHandle(startHandle, e.clientX);
            } else {
                moveHandle(endHandle, e.clientX);
            }
        });

        // Touch on timeline
        timeline.addEventListener('touchstart', function(e) {
            const rect = this.getBoundingClientRect();
            const position = e.touches[0].clientX - rect.left;
            const middle = (parseInt(startHandle.style.left) + parseInt(endHandle.style.left)) / 2;

            if (position < middle) {
                moveHandle(startHandle, e.touches[0].clientX);
            } else {
                moveHandle(endHandle, e.touches[0].clientX);
            }
        });
    }

    // Проверка авторизации
    function checkAuth() {
        try {
            const savedUser = localStorage.getItem('currentUser');
            if (savedUser) {
                const parsedUser = JSON.parse(savedUser);
                // Проверяем структуру данных пользователя
                if (!parsedUser || typeof parsedUser !== 'object') {
                    throw new Error('Invalid user data structure');
                }

                // Проверяем обязательные поля
                if (!parsedUser.city) {
                    parsedUser.city = 'Санкт-Петербург';
                }

                APP.currentUser = parsedUser;

                // Проверяем, есть ли событие в URL
                const params = getUrlParams();
                if (params.event && params.date && params.city) {
                    // Если есть параметры из Telegram, показываем событие
                    displayEventFromUrl();
                } else {
                    // Иначе устанавливаем город по умолчанию и загружаем события
                    document.getElementById('cityInput').value = APP.currentUser.city;
                    APP.cityWikidataId = null; // Сбрасываем ID города
                    loadUserEvents();
                }
            } else {
                showAuthModal();
            }
        } catch (e) {
            console.error('Auth error:', e);
            localStorage.removeItem('currentUser');
            showAuthModal();
        }
    }

    // Отображение события по умолчанию
    function displayDefaultEvent() {
        if (!APP.map) return;

        // Очищаем предыдущие маркеры
        APP.markers.forEach(marker => marker.remove());
        APP.markers = [];

        // Очищаем список событий
        document.getElementById('eventsListContainer').innerHTML = '';
        document.getElementById('eventsCount').textContent = '0';

        // Устанавливаем событие по умолчанию
        APP.currentEvents = [APP.defaultEvent];
        APP.currentEventIndex = 0;

        // Добавляем маркер
        const marker = L.marker(APP.defaultEvent.coordinates).addTo(APP.map)
            .bindPopup(`<b>${APP.defaultEvent.title}</b><br>${APP.defaultEvent.date}`);

        APP.markers.push(marker);
        marker.openPopup();

        // Устанавливаем вид карты
        APP.map.setView(APP.defaultEvent.coordinates, 12);

        // Обновляем информацию о событии
        displayEventInfo(APP.defaultEvent);
    }

    // Поиск Wikidata ID для города
    async function findCityWikidataId(cityName) {
        if (!cityName || typeof cityName !== 'string' || cityName.trim() === '') {
            throw new Error('Некорректное название города');
        }

        try {
            const query = `
                SELECT ?city ?cityLabel WHERE {
                    ?city wdt:P31/wdt:P279* wd:Q515;
                    rdfs:label "${cityName.trim()}"@ru.
                    SERVICE wikibase:label { bd:serviceParam wikibase:language "ru". }
                } LIMIT 1`;

            const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}&format=json`;

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 секунд таймаут

            const response = await fetch(url, {
                headers: { 'Accept': 'application/json' },
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();

            if (!data || !data.results || !data.results.bindings) {
                throw new Error('Некорректный формат ответа от Wikidata');
            }

            if (data.results.bindings.length > 0) {
                const cityUri = data.results.bindings[0].city.value;
                return cityUri.split('/').pop();
            }

            return null;
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error('Превышено время ожидания ответа от Wikidata');
            }
            console.error('Error finding city:', error);
            throw new Error('Не удалось найти город в Wikidata. Проверьте подключение к интернету и попробуйте снова.');
        }
    }

    // Загрузка событий для пользователя
    async function loadUserEvents() {
        try {
            showLoading(true);

            // Очищаем предыдущие маркеры
            APP.markers.forEach(marker => marker.remove());
            APP.markers = [];

            // Получаем Wikidata ID для города
            if (!APP.cityWikidataId) {
                const cityId = await findCityWikidataId(APP.currentUser.city);
                if (!cityId) {
                    throw new Error('Не удалось найти город в базе данных');
                }
                APP.cityWikidataId = cityId;
            }

            // Получаем события
            const events = await fetchHistoricalEvents(APP.timelineStartYear, APP.timelineEndYear);

            if (events.length > 0) {
                APP.currentEvents = events;
                APP.currentEventIndex = 0;
                displayEvents();
                updateEventsList();
            } else {
                // Очищаем данные о событиях
                APP.currentEvents = [];
                APP.currentEventIndex = 0;

                // Очищаем информацию о событии
                document.getElementById('eventInfo').innerHTML = `
                    <h2>События не найдены</h2>
                    <p>Попробуйте изменить временной период или город.</p>
                `;
                document.getElementById('eventsListContainer').innerHTML = '';
                document.getElementById('eventsCount').textContent = '0';

                // Устанавливаем вид карты по умолчанию
                if (APP.map) {
                    APP.map.setView([59.9343, 30.3351], 12); // Центр на Санкт-Петербурге
                }
            }
        } catch (error) {
            console.error('Error loading events:', error);

            // Очищаем данные о событиях и маркеры
            APP.currentEvents = [];
            APP.currentEventIndex = 0;
            APP.markers.forEach(marker => marker.remove());
            APP.markers = [];

            document.getElementById('eventInfo').innerHTML = `
                <h2>Ошибка загрузки</h2>
                <p>${error.message}</p>
            `;
            document.getElementById('eventsListContainer').innerHTML = '';
            document.getElementById('eventsCount').textContent = '0';

            // Устанавливаем вид карты по умолчанию
            if (APP.map) {
                APP.map.setView([59.9343, 30.3351], 12); // Центр на Санкт-Петербурге
            }
        } finally {
            showLoading(false);
        }
    }

    // Получение исторических событий с Wikidata и Wikipedia
    async function fetchHistoricalEvents(startYear, endYear) {
        if (!APP.cityWikidataId) return [];

        try {
            // Получаем события из Wikidata
            const wikidataEvents = await fetchWikidataEvents(startYear, endYear);
            
            // Получаем события из Wikipedia
            const wikipediaEvents = await fetchWikipediaEvents(APP.currentUser.city, startYear, endYear);
            
            // Объединяем события, избегая дубликатов
            const allEvents = [...wikidataEvents];
            
            // Добавляем уникальные события из Wikipedia
            wikipediaEvents.forEach(wikiEvent => {
                const isDuplicate = allEvents.some(event => 
                    event.title === wikiEvent.title || 
                    (event.date === wikiEvent.date && 
                     Math.abs(new Date(event.date) - new Date(wikiEvent.date)) < 86400000) // 1 день в миллисекундах
                );
                
                if (!isDuplicate) {
                    allEvents.push(wikiEvent);
                }
            });

            // Сортируем все события по дате
            return allEvents.sort((a, b) => new Date(a.date) - new Date(b.date));
        } catch (error) {
            console.error('Error fetching events:', error);
            throw new Error('Не удалось загрузить события. Проверьте подключение к интернету и попробуйте снова.');
        }
    }

    // Получение событий из Wikidata
    async function fetchWikidataEvents(startYear, endYear) {
        const query = `
            SELECT DISTINCT ?event ?eventLabel ?date ?coord ?description WHERE {
                {
                    # События, произошедшие в городе
                    ?event wdt:P276/wdt:P131* wd:${APP.cityWikidataId};
                           wdt:P585 ?date.
                } UNION {
                    # События, связанные с городом через другие свойства
                    ?event wdt:P276/wdt:P131* wd:${APP.cityWikidataId};
                           wdt:P585 ?date.
                    ?event wdt:P276 ?location.
                    ?location wdt:P131* wd:${APP.cityWikidataId}.
                } UNION {
                    # События, упоминающие город в описании
                    ?event wdt:P585 ?date;
                           schema:description ?description.
                    FILTER(CONTAINS(LCASE(?description), LCASE("${APP.currentUser.city}")))
                }
                
                OPTIONAL { ?event wdt:P625 ?coord. }
                OPTIONAL { ?event schema:description ?description. FILTER(LANG(?description) = "ru") }
                
                # Более гибкая фильтрация по дате
                BIND(YEAR(?date) AS ?year)
                FILTER(?year >= ${startYear} && ?year <= ${endYear})
                
                # Проверяем наличие русского названия
                FILTER(EXISTS { ?event rdfs:label ?eventLabel. FILTER(LANG(?eventLabel) = "ru") })
                
                SERVICE wikibase:label { bd:serviceParam wikibase:language "ru". }
            }
            ORDER BY ?date
            LIMIT 200`;

        const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}&format=json`;
        const response = await fetch(url, { headers: { 'Accept': 'application/json' } });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        return await Promise.all(data.results.bindings.map(async item => {
            const date = new Date(item.date.value);
            const coord = item.coord?.value;
            const title = item.eventLabel.value;
            const wikiInfo = await fetchWikipediaInfo(title);

            return {
                title: title,
                description: item.description?.value || 'Описание отсутствует',
                date: date.toLocaleDateString('ru-RU'),
                coordinates: coord ? parseCoordinates(coord) : null,
                wikidataUrl: item.event.value,
                wikipediaInfo: wikiInfo,
                source: 'wikidata'
            };
        }));
    }

    // Получение событий из Wikipedia
    async function fetchWikipediaEvents(city, startYear, endYear) {
        try {
            const events = [];
            const processedTitles = new Set();

            // Функция для поиска связанных статей
            async function findRelatedArticles(pageId) {
                const relatedUrl = `https://ru.wikipedia.org/w/api.php?action=query&pageids=${pageId}&prop=links&pllimit=500&format=json&origin=*`;
                const response = await fetch(relatedUrl);
                const data = await response.json();
                return data.query?.pages[pageId]?.links || [];
            }

            // Функция для обработки одной страницы
            async function processPage(page) {
                if (processedTitles.has(page.title)) return;
                processedTitles.add(page.title);

                // Получаем категории страницы
                const categories = page.categories?.map(cat => cat.title.toLowerCase()) || [];
                
                // Расширенный список исторических категорий
                const historicalCategories = [
                    'история', 'события', 'даты', 'хронология', 'исторические события',
                    'исторические даты', 'исторические места', 'памятные даты',
                    'исторические личности', 'исторические здания', 'исторические памятники'
                ];

                // Проверяем, что страница относится к истории
                const isHistorical = categories.some(cat => 
                    historicalCategories.some(histCat => cat.includes(histCat))
                );

                // Проверяем связь с городом
                const isCityRelated = 
                    categories.some(cat => cat.toLowerCase().includes(city.toLowerCase())) ||
                    page.extract.toLowerCase().includes(city.toLowerCase());

                if (!isHistorical || !isCityRelated) return;

                // Ищем даты в тексте (поддерживаем разные форматы)
                const datePatterns = [
                    /(\d{1,2}\.\d{1,2}\.\d{4})/g,  // 01.01.2024
                    /(\d{1,2}\s+[а-яА-Я]+\s+\d{4})/g,  // 1 января 2024
                    /(\d{4}\s+год)/g,  // 2024 год
                    /(в\s+\d{4}\s+году)/g  // в 2024 году
                ];

                let dates = [];
                for (const pattern of datePatterns) {
                    const matches = page.extract.matchAll(pattern);
                    for (const match of matches) {
                        let date = match[0];
                        
                        // Преобразуем дату в стандартный формат
                        if (date.includes(' ')) {
                            const months = {
                                'января': '01', 'февраля': '02', 'марта': '03', 'апреля': '04',
                                'мая': '05', 'июня': '06', 'июля': '07', 'августа': '08',
                                'сентября': '09', 'октября': '10', 'ноября': '11', 'декабря': '12'
                            };
                            
                            if (date.includes('год')) {
                                // Для формата "2024 год" или "в 2024 году"
                                const year = date.match(/\d{4}/)[0];
                                date = `01.01.${year}`;
                            } else {
                                // Для формата "1 января 2024"
                                const [day, month, year] = date.split(' ');
                                date = `${day.padStart(2, '0')}.${months[month.toLowerCase()]}.${year}`;
                            }
                        }

                        // Проверяем, что дата входит в заданный период
                        const eventDate = new Date(date.split('.').reverse().join('-'));
                        if (eventDate.getFullYear() >= startYear && eventDate.getFullYear() <= endYear) {
                            dates.push(date);
                        }
                    }
                }

                if (dates.length > 0) {
                    // Получаем изображение для события
                    const wikiInfo = await fetchWikipediaInfo(page.title);

                    // Создаем событие для каждой найденной даты
                    for (const date of dates) {
                        events.push({
                            title: page.title,
                            description: page.extract.split('\n')[0], // Берем первый абзац
                            date: date,
                            coordinates: null,
                            wikipediaInfo: wikiInfo,
                            source: 'wikipedia',
                            url: page.fullurl
                        });
                    }

                    // Ищем связанные статьи
                    const relatedLinks = await findRelatedArticles(page.pageid);
                    for (const link of relatedLinks) {
                        if (!processedTitles.has(link.title)) {
                            const relatedPageUrl = `https://ru.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(link.title)}&prop=extracts|pageimages|info|categories&exintro=1&explaintext=1&inprop=url&format=json&origin=*&cllimit=50`;
                            const relatedResponse = await fetch(relatedPageUrl);
                            const relatedData = await relatedResponse.json();
                            const relatedPage = Object.values(relatedData.query.pages)[0];
                            
                            if (relatedPage && !relatedPage.missing) {
                                await processPage(relatedPage);
                            }
                        }
                    }
                }
            }

            // Начальный поиск
            const searchQueries = [
                `${city} ${startYear}..${endYear} история`,
                `${city} исторические события`,
                `${city} памятные даты`,
                `${city} хронология`
            ];

            for (const query of searchQueries) {
                const searchUrl = `https://ru.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*&srlimit=100`;
                const searchResponse = await fetch(searchUrl);
                const searchData = await searchResponse.json();

                if (searchData.query?.search?.length) {
                    const pageIds = searchData.query.search.map(result => result.pageid).join('|');
                    const pagesUrl = `https://ru.wikipedia.org/w/api.php?action=query&pageids=${pageIds}&prop=extracts|pageimages|info|categories&exintro=1&explaintext=1&inprop=url&format=json&origin=*&cllimit=50`;
                    
                    const pagesResponse = await fetch(pagesUrl);
                    const pagesData = await pagesResponse.json();

                    // Обрабатываем каждую найденную страницу
                    for (const page of Object.values(pagesData.query.pages)) {
                        if (!page.missing) {
                            await processPage(page);
                        }
                    }
                }
            }

            return events;
        } catch (error) {
            console.error('Error fetching Wikipedia events:', error);
            return [];
        }
    }

    // Парсинг координат
    function parseCoordinates(coordString) {
        if (!coordString) return null;

        try {
            const matches = coordString.match(/Point\(([-\d.]+) ([-\d.]+)\)/);
            if (matches && matches.length === 3) {
                const longitude = parseFloat(matches[1]);
                const latitude = parseFloat(matches[2]);
                return [latitude, longitude];
            }
        } catch (e) {
            console.error("Ошибка парсинга координат:", e);
        }
        return null;
    }

    // Отображение событий на карте
    function displayEvents() {
        if (!APP.map || APP.currentEvents.length === 0) return;

        APP.markers.forEach(marker => marker.remove());
        APP.markers = [];

        const eventsWithCoords = APP.currentEvents.filter(event => event.coordinates !== null);

        eventsWithCoords.forEach((event, index) => {
            const marker = L.marker(event.coordinates).addTo(APP.map)
                .bindPopup(`<b>${event.title}</b><br>${event.date}`);

            APP.markers.push(marker);

            if (index === APP.currentEventIndex) {
                marker.openPopup();
            }
        });

        if (eventsWithCoords.length > 0) {
            const currentEvent = eventsWithCoords[APP.currentEventIndex % eventsWithCoords.length];
            APP.map.setView(currentEvent.coordinates, 12);
            displayEventInfo(currentEvent);
        } else if (APP.currentEvents.length > 0) {
            displayEventInfo(APP.currentEvents[0]);
        }
    }

    // Обновление списка событий
    function updateEventsList() {
        const container = document.getElementById('eventsListContainer');
        const countElement = document.getElementById('eventsCount');

        if (!container || !countElement) return;

        container.innerHTML = '';
        countElement.textContent = APP.currentEvents.length;

        APP.currentEvents.forEach((event, index) => {
            const eventElement = document.createElement('div');
            eventElement.className = 'event-item';
            
            eventElement.innerHTML = `
                <div class="event-header">
                    <h4>${event.title}</h4>
                    <div class="event-date">${event.date}</div>
                </div>
                <div class="event-description">${event.description}</div>
                <div class="event-details">
                    ${event.wikipediaInfo ? `
                        <div class="event-wikipedia-preview">
                            <p>${event.wikipediaInfo.extract.substring(0, 150)}...</p>
                            <a href="${event.wikipediaInfo.url}" target="_blank" rel="noopener noreferrer" class="wikipedia-link">
                                Читать на Wikipedia
                            </a>
                        </div>
                    ` : ''}
                    ${event.wikidataUrl ? `
                        <p class="event-source">
                            <a href="${event.wikidataUrl}" target="_blank" rel="noopener noreferrer">
                                Подробнее на Wikidata
                            </a>
                        </p>
                    ` : ''}
                    ${event.coordinates ? `
                        <p class="event-location">
                            <span class="location-icon">📍</span>
                            Местоположение: ${formatCoordinates(event.coordinates)}
                        </p>
                    ` : `
                        <p class="no-coords">Местоположение не указано</p>
                    `}
                    ${event.tags ? `
                        <div class="event-tags">
                            ${event.tags.map(tag => `<span class="event-tag">${tag}</span>`).join('')}
                        </div>
                    ` : ''}
                </div>
            `;

            // Добавляем обработчик клика для раскрытия/скрытия деталей
            eventElement.addEventListener('click', () => {
                // Закрываем все остальные события
                document.querySelectorAll('.event-item.expanded').forEach(item => {
                    if (item !== eventElement) {
                        item.classList.remove('expanded');
                    }
                });
                
                // Переключаем текущее событие
                eventElement.classList.toggle('expanded');
                
                // Обновляем карту и информацию
                APP.currentEventIndex = index;
                if (event.coordinates) {
                    APP.map.setView(event.coordinates, 12);
                    const marker = APP.markers[index];
                    if (marker) marker.openPopup();
                }
                displayEventInfo(event);
            });

            container.appendChild(eventElement);
        });
    }

    // Отображение информации о событии
    function displayEventInfo(event) {
        const eventInfoElement = document.getElementById('eventInfo');
        if (!eventInfoElement) return;

        eventInfoElement.innerHTML = `
            <div class="event-info-content">
                <h2>${event.title}</h2>
                <div class="event-info-date">${event.date}</div>
                <div class="event-info-description">${event.description}</div>
                
                ${event.wikipediaInfo ? `
                    <div class="event-wikipedia-info">
                        <div class="event-wikipedia-content">
                            <h3>Подробная информация</h3>
                            <div class="event-wikipedia-extract">${event.wikipediaInfo.extract}</div>
                            <div class="event-wikipedia-source">
                                <a href="${event.wikipediaInfo.url}" target="_blank" rel="noopener noreferrer">
                                    Читать полную статью на Wikipedia
                                </a>
                            </div>
                        </div>
                        ${event.wikipediaInfo.imageUrl ? `
                            <div class="event-image">
                                <img src="${event.wikipediaInfo.imageUrl}" alt="${event.title}" loading="lazy">
                            </div>
                        ` : ''}
                    </div>
                ` : ''}
                
                ${event.wikidataUrl ? `
                    <div class="event-info-source">
                        <a href="${event.wikidataUrl}" target="_blank" rel="noopener noreferrer">
                            Подробнее на Wikidata
                        </a>
                    </div>
                ` : ''}
                
                ${event.coordinates ? `
                    <div class="event-info-location">
                        <span class="location-icon">📍</span>
                        Местоположение: ${formatCoordinates(event.coordinates)}
                    </div>
                ` : `
                    <div class="no-coords-info">Местоположение не указано</div>
                `}
                
                ${event.tags ? `
                    <div class="event-info-tags">
                        ${event.tags.map(tag => `<span class="event-tag">${tag}</span>`).join('')}
                    </div>
                ` : ''}
            </div>
        `;
    }

    // Вспомогательная функция для форматирования координат
    function formatCoordinates(coords) {
        if (!coords) return '';
        const [lat, lng] = coords;
        return `${lat.toFixed(4)}°, ${lng.toFixed(4)}°`;
    }

    // Создание модального окна авторизации
    function createAuthModal() {
        const authContainer = document.createElement('div');
        authContainer.className = 'auth-container';
        authContainer.id = 'authContainer';

        const authForm = document.createElement('div');
        authForm.className = 'auth-form';

        const authTitle = document.createElement('h2');
        authTitle.textContent = 'Регистрация';

        const form = document.createElement('form');
        form.id = 'registrationForm';

        const fields = [
            { id: 'firstName', label: 'Имя:', type: 'text' },
            { id: 'lastName', label: 'Фамилия:', type: 'text' },
            { id: 'email', label: 'Email:', type: 'email' },
            { id: 'password', label: 'Пароль:', type: 'password' }
        ];

        fields.forEach(field => {
            const formGroup = document.createElement('div');
            formGroup.className = 'form-group';

            const label = document.createElement('label');
            label.setAttribute('for', field.id);
            label.textContent = field.label;

            const input = document.createElement('input');
            input.type = field.type;
            input.id = field.id;
            input.required = true;

            formGroup.appendChild(label);
            formGroup.appendChild(input);
            form.appendChild(formGroup);
        });

        const submitBtn = document.createElement('button');
        submitBtn.type = 'submit';
        submitBtn.textContent = 'Зарегистрироваться';
        form.appendChild(submitBtn);

        authForm.appendChild(authTitle);
        authForm.appendChild(form);
        authContainer.appendChild(authForm);

        document.body.appendChild(authContainer);
    }

    // Создание модального окна профиля
    function createProfileModal() {
        const profileContainer = document.createElement('div');
        profileContainer.className = 'profile-container';
        profileContainer.id = 'profileContainer';

        const profileForm = document.createElement('div');
        profileForm.className = 'profile-form';

        const profileTitle = document.createElement('h2');
        profileTitle.textContent = 'Профиль';

        const form = document.createElement('form');
        form.id = 'profileForm';

        const fields = [
            { id: 'profileFirstName', label: 'Имя:', type: 'text' },
            { id: 'profileLastName', label: 'Фамилия:', type: 'text' },
            { id: 'profileEmail', label: 'Email:', type: 'email' }
        ];

        fields.forEach(field => {
            const formGroup = document.createElement('div');
            formGroup.className = 'form-group';

            const label = document.createElement('label');
            label.setAttribute('for', field.id);
            label.textContent = field.label;

            const input = document.createElement('input');
            input.type = field.type;
            input.id = field.id;
            input.required = true;

            formGroup.appendChild(label);
            formGroup.appendChild(input);
            form.appendChild(formGroup);
        });

        const submitBtn = document.createElement('button');
        submitBtn.type = 'submit';
        submitBtn.textContent = 'Сохранить изменения';
        form.appendChild(submitBtn);

        const logoutBtn = document.createElement('button');
        logoutBtn.id = 'logoutBtn';
        logoutBtn.textContent = 'Выйти';

        const closeBtn = document.createElement('button');
        closeBtn.id = 'closeProfileBtn';
        closeBtn.textContent = 'Закрыть';

        profileForm.appendChild(profileTitle);
        profileForm.appendChild(form);
        profileForm.appendChild(logoutBtn);
        profileForm.appendChild(closeBtn);
        profileContainer.appendChild(profileForm);

        document.body.appendChild(profileContainer);
    }

    // Показать модальное окно авторизации
    function showAuthModal() {
        document.getElementById('authContainer').style.display = 'flex';
    }

    // Скрыть модальное окно авторизации
    function hideAuthModal() {
        document.getElementById('authContainer').style.display = 'none';
    }

    // Показать профиль
    function showProfile() {
        if (!APP.currentUser) return;

        document.getElementById('profileFirstName').value = APP.currentUser.firstName || '';
        document.getElementById('profileLastName').value = APP.currentUser.lastName || '';
        document.getElementById('profileEmail').value = APP.currentUser.email || '';

        document.getElementById('profileContainer').style.display = 'flex';
    }

    // Выход из системы
    function logout() {
        // Очищаем данные пользователя
        APP.currentUser = null;
        APP.currentEvents = [];
        APP.cityWikidataId = null;
        localStorage.removeItem('currentUser');

        // Очищаем маркеры на карте
        APP.markers.forEach(marker => marker.remove());
        APP.markers = [];

        // Сбрасываем временной промежуток на значения по умолчанию
        APP.timelineStartYear = 1400;
        APP.timelineEndYear = 1700;

        // Скрываем профиль и показываем форму авторизации
        document.getElementById('profileContainer').style.display = 'none';
        document.getElementById('authContainer').style.display = 'flex';

        // Очищаем поле ввода города
        document.getElementById('cityInput').value = '';

        // Сбрасываем позиции таймлайна
        const startHandle = document.querySelector('.start-handle');
        const endHandle = document.querySelector('.end-handle');
        const timeline = document.querySelector('.timeline');

        if (startHandle && endHandle && timeline) {
            const timelineWidth = timeline.offsetWidth;
            const handleWidth = startHandle.offsetWidth;
            const minYear = 1000;
            const maxYear = 2100;  // Изменено с 2000 на 2100
            
            // Вычисляем позиции для 1400 и 1700 годов
            const startPosition = ((APP.timelineStartYear - minYear) / (maxYear - minYear)) * (timelineWidth - handleWidth);
            const endPosition = ((APP.timelineEndYear - minYear) / (maxYear - minYear)) * (timelineWidth - handleWidth);
            
            startHandle.style.left = `${startPosition}px`;
            endHandle.style.left = `${endPosition}px`;
            
            // Обновляем отображение годов
            document.getElementById('startYear').textContent = APP.timelineStartYear;
            document.getElementById('endYear').textContent = APP.timelineEndYear;
        }

        // Показываем событие по умолчанию
        displayDefaultEvent();
    }

    // Настройка обработчиков событий
    function setupEventHandlers() {
        // Обработчик регистрации
        document.getElementById('registrationForm')?.addEventListener('submit', async function(e) {
            e.preventDefault();

            APP.currentUser = {
                firstName: document.getElementById('firstName').value,
                lastName: document.getElementById('lastName').value,
                email: document.getElementById('email').value,
                password: document.getElementById('password').value,
                city: document.getElementById('cityInput').value || 'Санкт-Петербург'
            };

            try {
                showLoading(true);
                localStorage.setItem('currentUser', JSON.stringify(APP.currentUser));
                hideAuthModal();

                // Всегда загружаем события для выбранного города, игнорируя параметры URL
                await loadUserEvents();
            } catch (error) {
                console.error('Registration error:', error);
                alert('Ошибка регистрации: ' + error.message);
            } finally {
                showLoading(false);
            }
        });

        // Обработчик кнопки применения настроек
        document.getElementById('applySettingsBtn').addEventListener('click', async function() {
            const city = document.getElementById('cityInput').value;

            if (!city) {
                alert('Пожалуйста, введите город');
                return;
            }

            if (!APP.currentUser) {
                APP.currentUser = {
                    city: city
                };
            }

            try {
                showLoading(true);

                // Обновляем данные пользователя
                APP.currentUser.city = city;

                // Сохраняем обновленные данные
                localStorage.setItem('currentUser', JSON.stringify(APP.currentUser));

                // Сбрасываем cityWikidataId, чтобы он был получен заново
                APP.cityWikidataId = null;

                // Загружаем события для выбранного города
                await loadUserEvents();
            } catch (error) {
                console.error('Error applying settings:', error);
                alert('Ошибка: ' + error.message);
            } finally {
                showLoading(false);
            }
        });

        // Обработчик профиля
        document.getElementById('profileLink')?.addEventListener('click', function(e) {
            e.preventDefault();
            showProfile();
        });

        // Обработчик обновления профиля
        document.getElementById('profileForm')?.addEventListener('submit', function(e) {
            e.preventDefault();

            APP.currentUser.firstName = document.getElementById('profileFirstName').value;
            APP.currentUser.lastName = document.getElementById('profileLastName').value;
            APP.currentUser.email = document.getElementById('profileEmail').value;

            localStorage.setItem('currentUser', JSON.stringify(APP.currentUser));
            document.getElementById('profileContainer').style.display = 'none';
        });

        // Обработчики кнопок
        document.getElementById('logoutBtn')?.addEventListener('click', logout);
        document.getElementById('closeProfileBtn')?.addEventListener('click', function() {
            document.getElementById('profileContainer').style.display = 'none';
        });
    }

    // Показать/скрыть индикатор загрузки
    function showLoading(show) {
        const buttons = document.querySelectorAll('button');
        buttons.forEach(btn => {
            btn.disabled = show;
            if (btn.id === 'applySettingsBtn' && show) {
                btn.innerHTML = '<span class="loading"></span>';
            } else if (btn.id === 'applySettingsBtn') {
                btn.textContent = 'Применить';
            }
        });
    }

    // Функция для получения информации из Wikipedia
    async function fetchWikipediaInfo(title) {
        // Проверяем кэш
        if (APP.wikipediaCache.has(title)) {
            return APP.wikipediaCache.get(title);
        }

        try {
            // Сначала ищем страницу по названию
            const searchUrl = `https://ru.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(title)}&format=json&origin=*`;
            const searchResponse = await fetch(searchUrl);
            const searchData = await searchResponse.json();

            if (!searchData.query?.search?.length) {
                return null;
            }

            // Берем первый результат поиска
            const pageId = searchData.query.search[0].pageid;
            
            // Получаем полную информацию о странице, включая изображения
            const pageUrl = `https://ru.wikipedia.org/w/api.php?action=query&pageids=${pageId}&prop=extracts|pageimages|images|info&exintro=1&explaintext=1&inprop=url&format=json&origin=*&pithumbsize=1000`;
            const pageResponse = await fetch(pageUrl);
            const pageData = await pageResponse.json();

            const page = pageData.query.pages[pageId];
            if (!page) {
                return null;
            }

            // Получаем лучшее изображение для страницы
            let bestImageUrl = null;
            if (page.thumbnail) {
                // Используем изображение из thumbnail, но в большем размере
                bestImageUrl = page.thumbnail.source.replace(/\/\d+px-/, '/1000px-');
            } else if (page.images) {
                // Если нет thumbnail, ищем подходящее изображение в списке
                const imagePromises = page.images
                    .filter(img => !img.title.includes('icon') && !img.title.includes('logo'))
                    .slice(0, 5) // Берем первые 5 изображений
                    .map(async img => {
                        const imageTitle = img.title.replace(/^File:/, '');
                        const imageInfoUrl = `https://ru.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(imageTitle)}&prop=imageinfo&iiprop=url|size|mime&format=json&origin=*`;
                        const imageInfoResponse = await fetch(imageInfoUrl);
                        const imageInfoData = await imageInfoResponse.json();
                        const imageInfo = Object.values(imageInfoData.query.pages)[0]?.imageinfo?.[0];
                        
                        if (imageInfo) {
                            return {
                                url: imageInfo.url,
                                width: imageInfo.width,
                                height: imageInfo.height,
                                size: imageInfo.size
                            };
                        }
                        return null;
                    });

                const imageResults = await Promise.all(imagePromises);
                const validImages = imageResults.filter(img => img !== null);
                
                if (validImages.length > 0) {
                    // Выбираем изображение с наилучшим соотношением сторон и размером
                    bestImageUrl = validImages
                        .sort((a, b) => {
                            const ratioA = a.width / a.height;
                            const ratioB = b.width / b.height;
                            // Предпочитаем изображения с соотношением сторон ближе к 16:9
                            const targetRatio = 16/9;
                            const ratioDiffA = Math.abs(ratioA - targetRatio);
                            const ratioDiffB = Math.abs(ratioB - targetRatio);
                            
                            if (Math.abs(ratioDiffA - ratioDiffB) < 0.1) {
                                // Если соотношения сторон близки, выбираем большее изображение
                                return b.size - a.size;
                            }
                            return ratioDiffA - ratioDiffB;
                        })[0].url;
                }
            }

            // Формируем объект с информацией
            const wikiInfo = {
                title: page.title,
                extract: page.extract,
                url: page.fullurl,
                imageUrl: bestImageUrl,
                lastModified: page.touched
            };

            // Сохраняем в кэш
            APP.wikipediaCache.set(title, wikiInfo);
            return wikiInfo;
        } catch (error) {
            console.error('Error fetching Wikipedia info:', error);
            return null;
        }
    }

    // Инициализация приложения
    init();
});