# VAX Messenger 🔥

Реальний чат для тебе і друзів. Розгортається безкоштовно на Railway.

## Що є
- 💬 Реальний чат в реальному часі (WebSocket)
- 🏠 Кімнати — Загальний, Ігри, Музика + можна створювати свої
- 👥 Список онлайн-користувачів
- ✏️ Індикатор "хтось друкує..."
- 🔗 Автоматичні посилання в чаті

---

## Деплой на Railway (безкоштовно, 5 хвилин)

### 1. Зареєструйся
Іди на [railway.app](https://railway.app) → Sign Up (через GitHub)

### 2. Завантаж код на GitHub
1. Зайди на [github.com](https://github.com) → New repository → назви `vax-messenger`
2. Завантаж всі ці файли туди (кнопка "uploading an existing file")

### 3. Деплой на Railway
1. На Railway натисни **New Project → Deploy from GitHub repo**
2. Вибери `vax-messenger`
3. Railway автоматично запустить сервер!

### 4. Отримай посилання
- Зайди в **Settings → Networking → Generate Domain**
- Отримаєш щось типу `vax-messenger-production.up.railway.app`
- **Надсилай це посилання друзям — і все!** ✅

---

## Як користуватись
1. Відкрий посилання → введи нікнейм
2. Вибери кімнату або введи назву нової
3. Пиши повідомлення!

Щоб створити нову кімнату — кнопка "＋ Нова кімната" в сайдбарі.

---

## Файли проєкту
```
vax-messenger/
├── server.js          ← сервер (Node.js + WebSocket)
├── package.json       ← залежності
├── railway.json       ← конфіг для Railway
└── public/
    └── index.html     ← весь інтерфейс
```
