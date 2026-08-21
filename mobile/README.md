# Uzum Pro — Android ilova

Bu papka — telefonga o'rnatiladigan Android ilova (APK) uchun. Ilova o'zi
hech qanday sahifa saqlamaydi — u shunchaki jonli Railway saytini
(`uzum-pro-server-production.up.railway.app`) to'liq ekranda ochadigan
"o'rovchi" (wrapper). Shuning uchun saytga yangi funksiya qo'shilganda,
APK'ni qayta yig'ish shart EMAS — ilovani ochganda har doim eng yangi
sahifa yuklanadi.

Asosiy loyihaga (`index.js`, `dashboard.html`) bu papka HECH qanday
ta'sir qilmaydi — ular butunlay alohida ishlaydi.

## Bu yerda nima bor

- `capacitor.config.json` — ilovaning nomi va qaysi saytni ochishi
  yozilgan sozlama fayli
- `android/` — Android Studio/Gradle build qiladigan haqiqiy loyiha
  (Capacitor avtomatik yaratgan)
- `www/` — bo'sh, ishlatilmaydigan "old belgi" fayl (Capacitor talab
  qiladi, lekin haqiqiy sahifa har doim internetdan yuklanadi)

## APK qanday yig'iladi (build)

1. `mobile/` papkasi ichida: `npm install`
2. `npx cap sync android` — sozlamalarni Android loyihasiga yangilaydi
3. Android Studio'da `mobile/android` papkasini oching va "Build → Build
   APK" tugmasini bosing — YOKI GitHub Actions orqali avtomatik
   (keyingi bosqichda sozlanadi)
4. Tayyor APK faylni telefonga o'tkazib o'rnatasiz (sideload)
