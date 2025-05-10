document.addEventListener('DOMContentLoaded', function() {
    const APP = {
        map: null,
        currentUser: null,
        currentEvents: [],
        currentEventIndex: 0,
        isInitialized: false,
        cityWikidataId: null,
        markers: [],
        timelineStartYear: 1700,
        timelineEndYear: 2000
    };

    // Инициализация приложения
    function init() {
        if (APP.isInitialized) return;

        createBaseStructure();
        setupEventHandlers();
        initTimeline();
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
            const maxYear = new Date().getFullYear();

            const startYear = Math.round(minYear + (maxYear - minYear) * (startPercent / 100));
            const endYear = Math.round(minYear + (maxYear - minYear) * (endPercent / 100));

            startYearElement.textContent = startYear;
            endYearElement.textContent = endYear;

            APP.timelineStartYear = startYear;
            APP.timelineEndYear = endYear;
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

        // Инициализация позиций
        startHandle.style.left = '0px';
        endHandle.style.left = (timeline.offsetWidth - endHandle.offsetWidth) + 'px';
        updateYears();

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
                APP.currentUser = JSON.parse(savedUser);
                document.getElementById('cityInput').value = APP.currentUser.city || 'Санкт-Петербург';
                loadUserEvents();
            } else {
                showAuthModal();
            }
        } catch (e) {
            console.error('Auth error:', e);
            localStorage.removeItem('currentUser');
            showAuthModal();
        }
    }

    // Поиск Wikidata ID для города
    async function findCityWikidataId(cityName) {
        try {
            const query = `
                SELECT ?city ?cityLabel WHERE {
                    ?city wdt:P31/wdt:P279* wd:Q515;
                    rdfs:label "${cityName}"@ru.
                    SERVICE wikibase:label { bd:serviceParam wikibase:language "ru". }
                } LIMIT 1`;
            
            const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}&format=json`;
            
            const response = await fetch(url, {
                headers: { 'Accept': 'application/json' }
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (data.results.bindings.length > 0) {
                const cityUri = data.results.bindings[0].city.value;
                APP.cityWikidataId = cityUri.split('/').pop();
                return true;
            }
            
            return false;
        } catch (error) {
            console.error('Error finding city:', error);
            throw new Error('Не удалось найти город в Wikidata. Проверьте подключение к интернету и попробуйте снова.');
        }
    }

    // Загрузка событий для пользователя
    async function loadUserEvents() {
        if (!APP.cityWikidataId) return;
        
        try {
            showLoading(true);
            
            const events = await fetchHistoricalEvents(APP.timelineStartYear, APP.timelineEndYear);
            
            if (events.length > 0) {
                APP.currentEvents = events;
                APP.currentEventIndex = 0;
                displayEvents();
                updateEventsList();
            } else {
                document.getElementById('eventInfo').innerHTML = `
                    <h2>События не найдены</h2>
                    <p>Попробуйте изменить временной период или город.</p>
                `;
                document.getElementById('eventsListContainer').innerHTML = '';
                document.getElementById('eventsCount').textContent = '0';
            }
        } catch (error) {
            console.error('Error loading events:', error);
            document.getElementById('eventInfo').innerHTML = `
                <h2>Ошибка загрузки</h2>
                <p>${error.message}</p>
            `;
        } finally {
            showLoading(false);
        }
    }

    // Получение исторических событий с Wikidata
    async function fetchHistoricalEvents(startYear, endYear) {
        if (!APP.cityWikidataId) return [];
        
        try {
            const query = `
                SELECT DISTINCT ?event ?eventLabel ?date ?coord ?description WHERE {
                    ?event wdt:P276/wdt:P131* wd:${APP.cityWikidataId};
                           wdt:P585 ?date;
                           wdt:P625 ?coord.
                    
                    OPTIONAL { ?event schema:description ?description. FILTER(LANG(?description) = "ru") }
                    
                    FILTER(YEAR(?date) >= ${startYear} && YEAR(?date) <= ${endYear})
                    FILTER(EXISTS { ?event rdfs:label ?eventLabel. FILTER(LANG(?eventLabel) = "ru") })
                    
                    SERVICE wikibase:label { bd:serviceParam wikibase:language "ru". }
                }
                ORDER BY ?date
                LIMIT 100`;
            
            const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}&format=json`;
            
            const response = await fetch(url, {
                headers: { 'Accept': 'application/json' }
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            return data.results.bindings.map(item => {
                const date = new Date(item.date.value);
                const coord = item.coord?.value;
                
                return {
                    title: item.eventLabel.value,
                    description: item.description?.value || 'Описание отсутствует',
                    date: date.toLocaleDateString('ru-RU'),
                    coordinates: coord ? parseCoordinates(coord) : null,
                    wikidataUrl: item.event.value
                };
            });
        } catch (error) {
            console.error('Error fetching events:', error);
            throw new Error('Не удалось загрузить события. Проверьте подключение к интернету и попробуйте снова.');
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
                <h4>${event.title}</h4>
                <p>${event.date}</p>
                ${event.coordinates ? '' : '<p class="no-coords">(нет координат)</p>'}
            `;
            
            eventElement.addEventListener('click', () => {
                APP.currentEventIndex = index;
                if (event.coordinates) {
                    APP.map.setView(event.coordinates, 12);
                    const marker = APP.markers.find(m => 
                        m.getLatLng().lat === event.coordinates[0] && 
                        m.getLatLng().lng === event.coordinates[1]
                    );
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
        eventInfoElement.innerHTML = `
            <h2>${event.title}</h2>
            <p><strong>Дата:</strong> ${event.date}</p>
            ${event.coordinates ? '' : '<p class="no-coords-info">⚠️ Это событие произошло в указанном городе, но точные координаты неизвестны</p>'}
            <p>${event.description}</p>
            <a href="${event.wikidataUrl}" target="_blank" rel="noopener noreferrer">Подробнее на Wikidata</a>
        `;
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
        APP.currentUser = null;
        APP.currentEvents = [];
        APP.cityWikidataId = null;
        localStorage.removeItem('currentUser');
        
        APP.markers.forEach(marker => marker.remove());
        APP.markers = [];
        
        document.getElementById('profileContainer').style.display = 'none';
        document.getElementById('authContainer').style.display = 'flex';
        
        document.getElementById('eventInfo').innerHTML = `
            <h2>Выберите местоположение и временной период</h2>
            <p>После регистрации и выбора параметров здесь будет отображаться информация о исторических событиях.</p>
        `;
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
                const cityFound = await findCityWikidataId(APP.currentUser.city);
                
                if (cityFound) {
                    localStorage.setItem('currentUser', JSON.stringify(APP.currentUser));
                    hideAuthModal();
                    loadUserEvents();
                } else {
                    alert('Не удалось найти указанный город в Wikidata. Попробуйте другое название.');
                }
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
            
            try {
                showLoading(true);
                const cityFound = await findCityWikidataId(city);
                
                if (cityFound) {
                    if (!APP.currentUser) {
                        APP.currentUser = {
                            city: city
                        };
                    } else {
                        APP.currentUser.city = city;
                    }
                    
                    localStorage.setItem('currentUser', JSON.stringify(APP.currentUser));
                    await loadUserEvents();
                } else {
                    alert('Не удалось найти указанный город в Wikidata. Попробуйте другое название.');
                }
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

    // Инициализация приложения
    init();
});