# UZUM BILIMLAR BAZASI

> AI maslahatchi shu faktlarni bilishi shart. Bu — 13 ta Telegram kanaldan (Uzum rasmiy kanali, raqobatchilar, tajribali sellerlar) ajratib olingan amaliy qoidalar.
> **Yangilanish:** har oy tekshiring — Uzum qoidalari tez o'zgaradi.
> **Manba:** Uzum Sotuvchilari (rasmiy), Sellerman.uz, Uzum Ustoz, Dosjan, Ruzmatov, Umarbek Ibrohimov kanallari (2022-2026).

---

## 1. XARAJATLAR VA TARIFLAR

### 1.1 Logistika (2026-yil 4-maydan)
Hisob **hajm (litr)** bo'yicha, uzunlik yig'indisi bo'yicha EMAS.

| Qoida | Qiymat |
|---|---|
| 1 litrgacha | 5 250 so'm |
| Har qo'shimcha litr | +250 so'm |
| Maksimal | 50 000 so'm |
| Yaxlitlash | **Yuqoriga** (1.6 l → 2 l; 5.2 l → 6 l; 104.3 l → 105 l) |

**Formula:** `min(50000, 5250 + 250 × (ceil(litr) − 1))`

⚠️ Ikki tovarning uzunlik yig'indisi bir xil bo'lsa ham hajmi 5 barobar farq qilishi mumkin (120×20×10 = 24 l, lekin 50×50×50 = 125 l).

### 1.2 Saqlash
**1 litr = 12 so'm/kun.**

Misollar:
- 30×30×30 = 27 l → 324 so'm/kun → ~9 700 so'm/oy
- 50×50×50 = 125 l → 1 500 so'm/kun → ~45 000 so'm/oy

⚠️ Bu eski tarifdan ~5 barobar (kichik tovar) va ~25 barobar (katta tovar) qimmat. Katta hajmli tovarni omborda uzoq ushlash — foydani yeb ketadi.

### 1.3 Komissiya
Kategoriyaga qarab har xil (kuzatilgan: 15%, 18%, 20%, 25%). API'da `commissionDto {min, max}` va SKU'da `commission` maydonida keladi — **taxmin qilmang, API'dan oling**.

---

## 2. JAZOLAR VA BLOKLASHLAR ⚠️

### 2.1 FBS reytingi (avtomatik bloklash)
- Oxirgi **8 kunlik** buyurtmalar bo'yicha har kuni hisoblanadi
- Reyting = bajarilgan buyurtmalar ÷ jami (xaridor bekor qilganlari hisobga olinmaydi)
- **85% dan past** → ogohlantirish
- **70% dan past + 10 ta buyurtma** → qoldiqlar nolga tenglashtiriladi, FBS **3 kunga bloklanadi**
- Blokdan chiqqach reyting noldan qayta hisoblanadi
- **Bekor qilish 8 kunda 20% dan oshsa** → akkaunt avtomatik bloklanadi (ilgari 30% edi)

**Himoya:** tovar tugasa yoki yetkaza olmasangiz — qoldiqni **darhol 0 ga tenglang** (bekor qilishdan ko'ra yaxshi).

### 2.2 Ombor qabuli
- Yukxatidagi va haqiqiy hajm farqi **10-20%** → tovar qabul qilinmaydi
- Farq **20% dan ortiq** → shaxsiy kabinet bloklanishi mumkin
- Slot band qilib ishlatmaslik → **tiklab bo'lmas bloklash**

### 2.3 Markirovka
Raqamli markirovka qoidalarini buzish: **sof tushumning 2%**, bir yilda takrorlansa **20%** (Soliq kodeksi 227.1-modda).

### 2.4 Boshqa qat'iy taqiqlar
- Buyurtmani begona narsa (tosh, qog'oz) bilan almashtirish → **30 kun blok**, takroran → FBS butunlay yopiladi
- Faberlic brendi → sotish qat'iyan man etilgan
- Brend ko'rsatish uchun originallik hujjati shart, aks holda kartochka bloklanadi
- ETTN (yuk xati) — qonuniy majburiy, soliq yoki YHXB so'rashi mumkin

### 2.5 Bloklash tizimi (yangilangan)
Endi faqat **muammoli SKU** bloklanadi, qolganlari sotuvda qoladi (ilgari butun mahsulot bloklanardi).

---

## 3. QIDIRUV VA TOPGA CHIQISH

### 3.1 Asosiy qoida (eng muhim tushuncha)
**Tovar tugasa → TOPdagi o'rin tushadi → kartochka "o'ladi" → qayta TOPga chiqish uchun BUST kerak → bu zarar.**

Ya'ni: zaxira tugashi shunchaki sotuv yo'qotish emas, balki **kartochka pozitsiyasini yo'qotish** — buni tiklash pul talab qiladi. Zaxira nazorati = pozitsiya nazorati.

### 3.2 Ranking omillari
- Sotuv tarixi va konversiya
- Sharhlar soni va reyting
- Kartochka sifati (foto, tavsif, SEO)
- Narx va chegirmalar dolzarbligi
- Zaxira mavjudligi (tugagan tovar tushib ketadi)

### 3.3 SEO
- "Qisqacha ta'rif" bo'limi xaridorga ko'rinmaydi, lekin **qidiruvga ta'sir qiladi** — kalit so'zlar bilan to'ldiring
- Tavsifda barcha xususiyat, o'lcham, material bo'lsin

### 3.4 BUST (reklama)
- Kalit so'zlar bo'yicha targ'ib qilish va **minus-iboralar** qo'shish mumkin
- Tajribali seller amaliyoti: kunlik 100 000-150 000 so'm, har kuni statistikani tahlil qilib minus-so'zlarni yangilash
- Kartochka kuchsiz bo'lsa (yomon foto, zaif SEO, kam sharh, past konversiya) — **katta byudjet ham yordam bermaydi**, faqat qimmatga tushadi

---

## 4. KOMPENSATSIYA (YO'QOLGAN TOVAR)

- Uzum tovarni yo'qotsa — **inventarizatsiya tugagach** kompensatsiya arizasi qabul qilinadi
- Ko'rib chiqish muddati uzaygan (rasmiy tan olingan)
- Tajribali seller: 6.5 mln so'mlik tovar yo'qolgan, ariza berib **2 oyda** pulni qaytarib olgan
- Nuqsonli tovarni pullik utilizatsiya qilish alohida masala

**Amaliy:** yo'qolgan tovarni o'zingiz aniqlamasangiz, hech kim aytmaydi. Nomuvofiqlikni doimiy kuzatish kerak.

---

## 5. STRATEGIYA (tajribali sellerlardan)

### 5.1 Marja > Aylanma
Real misol (Sellerman, dekabr 2025):
- Aylanma tushdi: 303 mln → 260 mln so'm
- Buyurtmalar tushdi: 1275 → 980 dona
- **Lekin sof foyda deyarli saqlandi:** 91 mln → 83 mln
- Sabab: past marjali tovarlardan chiqish, yuqori marjaliga urg'u
- Natija: marja 32%

**Xulosa:** kam sotib ko'proq foyda qilish mumkin. Aylanma ortidan quvish — xato.

### 5.2 ABC-tahlil
- **A** — asosiy daromad manbai, qoldig'ini doim nazorat qilish shart
- **B** — o'sish imkoniyati
- **C** — minimal ulush, optimallashtirish yoki chiqarish kerak

Uzum API'da `rankInfo.rank` (A/B/C/N/D) allaqachon bor.

### 5.3 Nolikvid (muzlagan kapital)
Sotilmayotgan tovar — bu:
- Muzlab qolgan pul
- Har kuni ortib borayotgan saqlash xarajati
- Omborda band joy
- Aylanish tezligining pasayishi

Real misol: bitta sellerda **38.5 mln so'm** nolikvidda qotib qolgan.

### 5.4 Xitoy va yetkazib berish
- Yo'l: Xitoy → Fulfillment (saralash, qadoqlash, shtrix-kod) → Uzum ombori
- Yetib kelish: ~20 kun
- Yolkira: ~5$/kg (kuzatilgan)
- Yangi tovarni **oz miqdorda test qilish**, yaxshi ketsa zaxirani oshirish
- Xitoylik sotuvchilar demping qiladi — 10-15% marja bilan ham raqobat qilish qiyin bo'lishi mumkin

### 5.5 Xarajatni kamaytirish yo'llari
1. Yangi/kattaroq yetkazib beruvchi topish, ishlab chiqaruvchiga chiqish
2. Pullik ombordagi tovarning bir qismini qaytarib olish
3. Barcha logistika xarajatlarini yozib, qaysi jarayon arzonlashishi mumkinligini ko'rish
4. Marketing xarajatlarini natijasi bilan solishtirish, foyda bermaydigan kanallarni yopish

---

## 6. RAQOBATCHILAR (bizning bozorda)

| Xizmat | Bot | Asosiy taklif |
|---|---|---|
| **SellerMan** | @Sellermaniobot | Sof foyda/marja, ABC, nolikvid, **yo'qolgan tovar + kompensatsiya arizasi**, bot xabarnomalari. 13-iyul 2026 da ishga tushgan, bepul sinov. "17 ta bo'lim" |
| **Uzum Plus** | @uzumplusbot | Tezkor hisobot, savdo xabarnomalari, kompensatsiya yordami. **Tarif rejalari** (PREMIUM), xodim qo'shish |
| **MarketDB** | marketdb.org | Analitika servisi |

**Ularda bor, bizda yo'q:** yo'qolgan tovar aniqlash + kompensatsiya arizasi, ABC-tahlil, nolikvid hisobi, hodisa xabarnomalari.

**Bizda bor, ularda yo'q:** uy zaxirasi kuzatuvi, undan ta'minlash tavsiyasi, o'z ma'lumotimiz o'zimizda qolishi.

---

## 7. AI MASLAHATCHI UCHUN QARORLAR JADVALI

Bu — AI har kuni tekshirishi kerak bo'lgan holatlar va aniq harakatlar:

| Holat | Xavf | Harakat |
|---|---|---|
| A toifadagi tovar zaxirasi < 7 kunlik | TOP pozitsiya yo'qolishi | Zudlik bilan jo'natish, BUST'ni vaqtincha kamaytirish |
| Tovar tugadi (zaxira = 0) | Kartochka "o'lyapti" | Uy zaxirasidan darhol jo'natish; yo'q bo'lsa Xitoyga buyurtma |
| Marja < 15% | Demping xavfi, foyda yo'q | Narxni ko'tarish yoki tovardan chiqish |
| 60 kun sotilmagan + zaxira bor | Nolikvid, saqlash yeyapti | Chegirma, reklama, qayta narxlash yoki chiqarish |
| Jo'natilgan − sotilgan − qaytgan ≠ zaxira | Tovar yo'qolgan | Kompensatsiya arizasi tayyorlash |
| Reklama sarfi bor, sotuv yo'q | Pul behuda ketyapti | BUST'ni to'xtatish, kartochkani tekshirish (foto/SEO/sharh) |
| Katta hajmli tovar uzoq turibdi | Saqlash qimmat | Tezroq sotish yoki qaytarib olish |
| SKU bloklandi | Sotuv yo'q | Sababni ko'rish (`skuBlockReason`), tuzatish |
| Qaytarish foizi yuqori | Sifat yoki tavsif muammosi | Sharhlarni o'qish, tavsifni aniqlashtirish |
