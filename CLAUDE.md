# UZUM PRO — loyiha haqida

Telegram Mini App + bot, Uzum Market sotuvchisi (kamera + kichik elektronika) uchun sotuv/zaxira/moliya boshqaruvi.

- **Backend:** `index.js` — Express, bitta fayl.
- **Frontend:** `dashboard.html` — bitta fayl, vanilla JS + Tailwind CDN, Telegram Mini App sifatida ochiladi.
- **Deploy:** Railway, avtomatik (GitHub push → deploy). Production: `https://uzum-pro-server-production.up.railway.app`
- **Ma'lumot saqlash:** Railway Volume (`DATA_DIR`), `settings.json` + kunlik backup + `snapshots.json` + `invoice_state.json` + `problems.json`.

## Faol do'konlar

- `61122` — kamera
- `48589` — Jaydari Bozor

`63592` (Nurli) — foydalanuvchi tomonidan ataylab o'chirilgan. `syncedState.shops`dagi default massiv (kod ichida, faqat settings.json topilmagan holatdagi zaxira) hali Nurli'ni ham sanab o'tadi — bu ahamiyatsiz, chunki productionda haqiqiy holat diskdan (`loadSettings()`) yuklanadi va u faqat 2 do'konni o'z ichiga oladi. Nurli'ni tasodifan qayta qo'shib qo'ymang.

## MUHIM API saboqlari (bular xato qilmaslik uchun juda muhim)

- **`GET /v1/finance/orders`** — sana filtrlari (`dateFrom`/`dateTo`, qanday formatda bo'lmasin) ISHLAMAYDI, har doim bo'sh qaytaradi. `shopIds` majburiy (bo'lmasa 403). To'g'ri usul: sanasiz so'rov + **client-side filtrlash** (`date` maydoni, Tashkent kuni). Sotuv/daromad/sof foyda SHU YERDAN hisoblanadi — snapshot'dan emas (`computeSalesFromOrders`).
- **`GET /v1/invoice`** — `size>50` bo'lsa bo'sh massiv qaytaradi. Sahifalash shart: `page=0,1,2...&size=50`. Yo'qolgan tovar (kompensatsiya) SKU darajasida **BUTUN TARIX** bo'yicha hisoblanadi, bitta yuk xati emas — Uzum aralash qutini qayta saralab, YANGI yuk xatida qabul qilishi mumkin (`[X→0]` keyin `[X→X]`), bu YO'QOTISH EMAS. Moslashtirish oynasi (`RESORT_WINDOW_DAYS`, hozir 60 kun) **SIMMETRIK** bo'lishi shart (`|farq| <= oyna`, yo'nalishsiz) — Uzum bitta ombor seansida "qabul" hujjatini "rad" hujjatidan oldinroq qayd etishi mumkin.
- **Hujjat raqami/sanasi (kabinetga mos ko'rsatish uchun):** API `invoiceNumber`ning oxirgi raqami tekshiruv xonasi — kabinet raqami = `Math.floor(invoiceNumber / 10)`. Sana — `dateCreated` (hujjat yaratilgan, noaniq) emas, **`dateAccepted`** (real qabul vaqti, Tashkent +5h) ko'rsatilishi kerak — bular bir necha kun farq qilishi mumkin. Helper'lar: `invoiceDisplayNumber()`, `invoiceDisplayDate()`, `invoiceEventMs()`.
- **`quantityReturned`** maydoni ishonchsiz (kechikuvchi/umriy hisoblagich), **`quantityMissing`** doim 0 (Uzum to'ldirmaydi) — kompensatsiya buni emas, invoice tarixini ishlatadi.
- **Kompensatsiya formulasi:** sotuv narxi − komissiya (**tannarx EMAS** — rasmiy Uzum hujjatiga mos, `commissionPct()` orqali).
- **Logistika:** `min(50000, 5250 + 250×(ceil(litr)−1))`. **Saqlash:** `litr × 12 × kun` (default 30 kun).
- Ko'p endpoint bare massiv qaytaradi (obyekt emas) — proxy javoblarini shunga qarab ishlating.

## Ish qoidalari

- Ma'lumot yo'q yoki noaniq bo'lsa — aniq **"ma'lumot yo'q"** deb ayt. HECH QACHON soxta/taxminiy raqam ko'rsatma.
- Har push'dan oldin: `node --check index.js` + `dashboard.html`dagi asosiy `<script>` bloki, va 5 ta tab (**Dashboard / Kartochkalar / Uy Zaxirasi / Moliya / AI&Bot** — `switchTab('dashboard'|'products'|'inventory'|'finance'|'lounge')`) xatosiz ochilishi kerak.
- Foydalanuvchining qo'lda kiritgan qiymati (tannarx, hajm, komissiya, logistika) API ma'lumotidan **har doim ustuvor** (`resolveTannarx`/`resolveLogistics`/`resolveVolumeL`/`commissionPct` — barchasi shu ustuvorlik zanjiriga amal qiladi: SKU qo'lda → mahsulot qo'lda → API/tur → default).
- **Snapshot** (`captureSnapshot`, har kuni 04:50 Asia/Tashkent) — faqat zaxira kunlari / ABC / nolikvid / bashorat uchun. Sotuv/daromad hisobiga ARALASHTIRMA (u finance/orders'dan).
- Moliya ma'lumotlari (`withdrawals`/`userExpenses`/`credits`/`goals`) `/api/finance-data`ga POST qilinganda — mavjud (bo'sh bo'lmagan) massivni bo'sh bilan almashtirish faqat `_confirmClear` ro'yxatida aniq ko'rsatilgan kalitlar uchun ruxsat etiladi (409 aks holda). Diagnostika/test paytida BLIND bo'sh POST yubormang — bu bir marta haqiqiy foydalanuvchi ma'lumotini o'chirib yuborgan.
- Production'ga yozadigan (`POST`/o'zgartiruvchi) diagnostika buyrug'idan oldin joriy holatni o'qib solishtiring; testdan keyin darhol tozalang.
- Push'dan oldin foydalanuvchidan aniq tasdiq so'ralsin (bu loyihada standart ish tartibi).

## Foydalanuvchi

Abrorbek. O'zbek tilida yozadi. Texnik jihatdan tajribasiz, lekin sinchkov — raqamlarni Uzum kabineti bilan qo'lda solishtirib tekshiradi. Tushuntirishlar sodda va aniq raqamlar bilan bo'lsin.
