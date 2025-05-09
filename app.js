document.addEventListener('DOMContentLoaded', function() {
    // Глобальные переменные
    const APP = {
        map: null,
        currentUser: null,
        currentEvents: [],
        currentEventIndex: 0,
        isInitialized: false,
        cityWikidataId: null,
        markers: [] // Добавляем массив для хранения маркеров
    };

    // Инициализация приложения
    function init() {
        if (APP.isInitialized) return;
        
        createBaseStructure();
        setupEventHandlers();
        checkAuth();
        APP.isInitialized = true;
    }

    // Создание базовой структуры страницы
    function createBaseStructure() {
        // Создаем окно авторизации
        createAuthModal();
        
        // Создаем окно профиля
        createProfileModal();
        
        // Инициализируем карту
        initMap();
    }

    // Инициализация карты
    function initMap() {
        try {
            APP.map = L.map('map').setView([55.7558, 37.6176], 5);
            
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            }).addTo(APP.map);
            
            // Если пользователь уже авторизован, загружаем события
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

    // Проверка авторизации
    function checkAuth() {
        try {
            const savedUser = localStorage.getItem('currentUser');
            if (savedUser) {
                APP.currentUser = JSON.parse(savedUser);
                if (!APP.currentUser || typeof APP.currentUser !== 'object') {
                    throw new Error('Invalid user data');
                }
                
                // Пытаемся найти Wikidata ID для города
                findCityWikidataId(APP.currentUser.city)
                    .then(() => loadUserEvents())
                    .catch(() => showAuthModal());
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
    function getYearsForPeriod(period) {
    const periods = {
        middle_ages: { start: 500, end: 1500 },      // Средние века
        renaissance: { start: 1300, end: 1600 },     // Эпоха Возрождения
        industrial_revolution: { start: 1760, end: 1840 }, // Промышленная революция
        '20th_century': { start: 1901, end: 2000 }  // XX век
    };
    return periods[period] || { start: 1900, end: 2000 }; // По умолчанию XX век
    }

    // Загрузка событий для пользователя
    async function loadUserEvents() {
        if (!APP.currentUser || !APP.cityWikidataId) return;
        
        try {
            showLoading(true);
            
            // Получаем временной период в годах
            const years = getYearsForPeriod(APP.currentUser.timePeriod);
            
            // Загружаем события
            const events = await fetchHistoricalEvents(years.start, years.end);
            
            if (events.length > 0) {
                APP.currentEvents = events;
                APP.currentEventIndex = 0;
                displayEvents();
            } else {
                document.getElementById('eventInfo').innerHTML = `
                    <h2>События не найдены</h2>
                    <p>Попробуйте изменить временной период в настройках профиля.</p>
                `;
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
                LIMIT 20`;
            
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
                const coord = item.coord.value.replace('Point(', '').replace(')', '').split(' ');
                
                return {
                    title: item.eventLabel.value,
                    description: item.description?.value || 'Описание отсутствует',
                    date: date.toLocaleDateString('ru-RU'),
                    coordinates: [parseFloat(coord[1]), parseFloat(coord[0])],
                    wikidataUrl: item.event.value
                };
            });
        } catch (error) {
            console.error('Error fetching events:', error);
            throw new Error('Не удалось загрузить события. Проверьте подключение к интернету и попробуйте снова.');
        }
    }

    // Отображение событий на карте
    function displayEvents() {
        if (!APP.map || APP.currentEvents.length === 0) return;
        
        // Очищаем предыдущие маркеры
        APP.markers.forEach(marker => marker.remove());
        APP.markers = [];
        
        // Добавляем новые маркеры
        APP.currentEvents.forEach((event, index) => {
            const marker = L.marker(event.coordinates).addTo(APP.map)
                .bindPopup(`<b>${event.title}</b><br>${event.date}`);
            
            APP.markers.push(marker);
            
            if (index === APP.currentEventIndex) {
                marker.openPopup();
                displayEventInfo(event);
            }
        });
        
        // Центрируем карту на текущем событии
        APP.map.setView(
            APP.currentEvents[APP.currentEventIndex].coordinates, 
            12
        );
    }

    // Отображение информации о событии
    function displayEventInfo(event) {
        const eventInfoElement = document.getElementById('eventInfo');
        eventInfoElement.innerHTML = `
            <h2>${event.title}</h2>
            <p><strong>Дата:</strong> ${event.date}</p>
            <p>${event.description}</p>
            <a href="${event.wikidataUrl}" target="_blank" rel="noopener noreferrer">Подробнее на Wikidata</a>
        `;
    }

    // Обновление события
    function updateEvent() {
        if (APP.currentEvents.length === 0) return;
        
        APP.currentEventIndex = (APP.currentEventIndex + 1) % APP.currentEvents.length;
        displayEvents();
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
        
        // Поля формы
        const fields = [
            { id: 'firstName', label: 'Имя:', type: 'text' },
            { id: 'lastName', label: 'Фамилия:', type: 'text' },
            { id: 'email', label: 'Email:', type: 'email' },
            { id: 'password', label: 'Пароль:', type: 'password' },
            { id: 'city', label: 'Город:', type: 'text' }
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
        
        // Поле временного периода
        const timePeriodGroup = document.createElement('div');
        timePeriodGroup.className = 'form-group';
        
        const timePeriodLabel = document.createElement('label');
        timePeriodLabel.setAttribute('for', 'timePeriod');
        timePeriodLabel.textContent = 'Интересующий временной период:';
        
        const timePeriodSelect = document.createElement('select');
        timePeriodSelect.id = 'timePeriod';
        timePeriodSelect.required = true;
        
        const periods = [
            { value: 'middle_ages', text: 'Средние века' },
            { value: 'renaissance', text: 'Эпоха Возрождения' },
            { value: 'industrial_revolution', text: 'Промышленная революция' },
            { value: '20th_century', text: 'XX век' }
        ];
        
        periods.forEach(period => {
            const option = document.createElement('option');
            option.value = period.value;
            option.textContent = period.text;
            timePeriodSelect.appendChild(option);
        });
        
        timePeriodGroup.appendChild(timePeriodLabel);
        timePeriodGroup.appendChild(timePeriodSelect);
        form.appendChild(timePeriodGroup);
        
        // Кнопка отправки
        const submitBtn = document.createElement('button');
        submitBtn.type = 'submit';
        submitBtn.textContent = 'Зарегистрироваться';
        form.appendChild(submitBtn);
        
        authForm.appendChild(authTitle);
        authForm.appendChild(form);
        authContainer.appendChild(authForm);
        
        document.body.appendChild(authContainer);
    }

    // Показать модальное окно авторизации
    function showAuthModal() {
        document.getElementById('authContainer').style.display = 'flex';
    }

    // Скрыть модальное окно авторизации
    function hideAuthModal() {
        document.getElementById('authContainer').style.display = 'none';
    }

    // Создание модального окна профиля
    function createProfileModal() {
        const profileContainer = document.createElement('div');
        profileContainer.className = 'auth-container';
        profileContainer.id = 'profileContainer';
        profileContainer.style.display = 'none';
        
        const profileForm = document.createElement('div');
        profileForm.className = 'auth-form';
        
        const profileTitle = document.createElement('h2');
        profileTitle.textContent = 'Профиль';
        
        const form = document.createElement('form');
        form.id = 'profileForm';
        
        // Поля формы
        const fields = [
            { id: 'profileFirstName', label: 'Имя:', type: 'text' },
            { id: 'profileLastName', label: 'Фамилия:', type: 'text' },
            { id: 'profileCity', label: 'Город:', type: 'text' }
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
        
        // Поле временного периода
        const timePeriodGroup = document.createElement('div');
        timePeriodGroup.className = 'form-group';
        
        const timePeriodLabel = document.createElement('label');
        timePeriodLabel.setAttribute('for', 'profileTimePeriod');
        timePeriodLabel.textContent = 'Интересующий временной период:';
        
        const timePeriodSelect = document.createElement('select');
        timePeriodSelect.id = 'profileTimePeriod';
        timePeriodSelect.required = true;
        
        const periods = [
            { value: 'middle_ages', text: 'Средние века' },
            { value: 'renaissance', text: 'Эпоха Возрождения' },
            { value: 'industrial_revolution', text: 'Промышленная революция' },
            { value: '20th_century', text: 'XX век' }
        ];
        
        periods.forEach(period => {
            const option = document.createElement('option');
            option.value = period.value;
            option.textContent = period.text;
            timePeriodSelect.appendChild(option);
        });
        
        timePeriodGroup.appendChild(timePeriodLabel);
        timePeriodGroup.appendChild(timePeriodSelect);
        form.appendChild(timePeriodGroup);
        
        // Кнопка отправки
        const submitBtn = document.createElement('button');
        submitBtn.type = 'submit';
        submitBtn.textContent = 'Сохранить изменения';
        form.appendChild(submitBtn);
        
        // Кнопки выхода и закрытия
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

    // Показать профиль
    function showProfile() {
        if (!APP.currentUser) return;
        
        document.getElementById('profileFirstName').value = APP.currentUser.firstName;
        document.getElementById('profileLastName').value = APP.currentUser.lastName;
        document.getElementById('profileCity').value = APP.currentUser.city;
        document.getElementById('profileTimePeriod').value = APP.currentUser.timePeriod;
        
        document.getElementById('profileContainer').style.display = 'flex';
    }

    // Выход из системы
    function logout() {
        APP.currentUser = null;
        APP.currentEvents = [];
        APP.cityWikidataId = null;
        localStorage.removeItem('currentUser');
        
        // Очищаем маркеры
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
                city: document.getElementById('city').value,
                timePeriod: document.getElementById('timePeriod').value
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
        
        // Обработчик профиля
        document.getElementById('profileLink')?.addEventListener('click', function(e) {
            e.preventDefault();
            showProfile();
        });
        
        // Обработчик обновления профиля
        document.getElementById('profileForm')?.addEventListener('submit', async function(e) {
            e.preventDefault();
            
            APP.currentUser.firstName = document.getElementById('profileFirstName').value;
            APP.currentUser.lastName = document.getElementById('profileLastName').value;
            APP.currentUser.city = document.getElementById('profileCity').value;
            APP.currentUser.timePeriod = document.getElementById('profileTimePeriod').value;
            
            try {
                showLoading(true);
                const cityFound = await findCityWikidataId(APP.currentUser.city);
                
                if (cityFound) {
                    localStorage.setItem('currentUser', JSON.stringify(APP.currentUser));
                    document.getElementById('profileContainer').style.display = 'none';
                    loadUserEvents();
                } else {
                    alert('Не удалось найти указанный город в Wikidata. Попробуйте другое название.');
                }
            } catch (error) {
                console.error('Profile update error:', error);
                alert('Ошибка обновления профиля: ' + error.message);
            } finally {
                showLoading(false);
            }
        });
        
        // Обработчики кнопок
        document.getElementById('logoutBtn')?.addEventListener('click', logout);
        document.getElementById('closeProfileBtn')?.addEventListener('click', function() {
            document.getElementById('profileContainer').style.display = 'none';
        });
        document.getElementById('refreshBtn')?.addEventListener('click', updateEvent);
    }

    // Показать/скрыть индикатор загрузки
    function showLoading(show) {
        const buttons = document.querySelectorAll('button');
        buttons.forEach(btn => {
            if (show) {
                btn.disabled = true;
                if (btn.id === 'refreshBtn') {
                    btn.innerHTML = '<span class="loading"></span>';
                }
            } else {
                btn.disabled = false;
                if (btn.id === 'refreshBtn') {
                    btn.textContent = 'Обновить событие';
                }
            }
        });
    }

    // Инициализация приложения
    init();
});