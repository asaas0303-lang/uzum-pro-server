// ai.js — Claude API bilan ishlash.
// Umumiy qoidalar (hamma funksiyalarga tegishli):
// - HECH QACHON emoji ishlatilmaydi
// - Javoblar QISQA, samimiy, "iltimos" kabi muloyim so'zlar bilan
// - Til mijozning tiliga mos (o'zbek yoki rus)
// - Salomlashish faqat suhbat boshida (hasGreeted=false bo'lganda)

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

const NO_EMOJI_RULE =
  'HECH QACHON emoji ishlatma (hech qanday holatda, hech qaysi belgi). ' +
  'Faqat oddiy matn yoz, xuddi yaqin inson xabar yozayotgandek — samimiy, iliq, "iltimos" kabi muloyim so\'zlar bilan, lekin rasmiy yoki sovuq emas.';

async function callClaude({ system, messages, maxTokens = 400 }) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages })
  });
  const data = await res.json();
  if (data.error) {
    throw new Error(`Claude API xatosi: ${data.error.message}`);
  }
  const textBlock = (data.content || []).find(b => b.type === 'text');
  return textBlock ? textBlock.text.trim() : '';
}

function langName(language) {
  return language === 'ru' ? 'rus' : 'o\'zbek';
}

// Rasm orqali qaysi kamera modeli ekanini aniqlaydi.
// status: 'matched' | 'no_match' (mavjud modellardan hech biriga o'xshamaydi,
//         ehtimol hali bazaga qo'shilmagan model) | 'unclear' (rasm xira/tushunarsiz)
async function identifyModelFromImage({ base64Image, mediaType, modelNames }) {
  const system =
    `Sen kamera modelini rasm orqali aniqlaydigan yordamchisan. ` +
    `Mavjud modellar ro'yxati: ${modelNames.join(', ')}. ` +
    `Rasmga ENG OXIRGI imkoniyatgacha tirishib qara — agar qutidagi yozuv, brend nomi yoki ` +
    `kamera shakli biror modelga o'xshasa, hatto rasm biroz noaniq bo'lsa ham, shu modelni tanla. ` +
    `Faqat rasm HAQIQATAN HAM tushunib bo'lmaydigan (juda xira, qora, hech narsa ko'rinmaydigan) bo'lsa "unclear" deb belgila. ` +
    `Agar rasm aniq ko'rinadi, lekin u kamera ro'yxatdagi modellarning hech biriga o'xshamasa — bu boshqa, hali ro'yxatga qo'shilmagan model degani, shunda "no_match" deb belgila. ` +
    `Javobni FAQAT shu JSON formatda qaytar, boshqa hech narsa yozma: ` +
    `{"status": "matched yoki unclear yoki no_match", "model": "model_nomi_yoki_null"}`;

  const result = await callClaude({
    system,
    maxTokens: 150,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
        { type: 'text', text: 'Bu rasmda qaysi kamera modeli ko\'rinmoqda?' }
      ]
    }]
  });

  try {
    const cleaned = result.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      status: parsed.status,
      modelName: parsed.status === 'matched' ? parsed.model : null
    };
  } catch (err) {
    return { status: 'unclear', modelName: null };
  }
}

// Rasmni (yo'riqnoma yoki ilova skrinshoti) bir martalik tahlil qilib,
// undagi matn/ko'rsatmalarni qisqa, izlash uchun qulay shaklda chiqaradi.
// Bu kanal postiga rasm tushgan zahoti ishlatiladi — har safar mijoz so'roviga emas.
async function extractTextFromImage({ base64Image, mediaType, hint }) {
  const system =
    `Sen rasmdagi matnni o'qib, uni qisqa va tushunarli qilib qayta yozadigan yordamchisan. ` +
    `Rasmda ko'rinadigan barcha muhim ma'lumotni (qadamlar, tugmalar, sozlamalar, ekran nomi) ` +
    `oddiy o'zbek tilida, ro'yxat ko'rinishida qisqa yoz. Faqat rasmda haqiqatan bor narsani yoz, hech narsa qo'shib chiqarma.`;

  const userText = hint
    ? `Bu rasm "${hint}" haqida. Undagi ma'lumotni qisqa yozib ber.`
    : 'Bu rasmdagi ma\'lumotni qisqa yozib ber.';

  return callClaude({
    system,
    maxTokens: 350,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
        { type: 'text', text: userText }
      ]
    }]
  });
}

function detectLanguage(text) {
  if (!text) return 'uz';
  // O'zbek kirilchasida bor, lekin rus alifbosida YO'Q harflar — agar shu
  // harflar uchrasa, bu aniq o'zbekcha matn (kiril yozuvida), rus emas.
  const uzbekOnlyCyrillic = /[қғўҳ]/i.test(text);
  if (uzbekOnlyCyrillic) return 'uz';

  // Lotin yozuvidagi o'zbekcha belgilar (o', g')
  const uzbekLatinSpecific = /o['ʻ`]|g['ʻ`]/i.test(text);
  if (uzbekLatinSpecific) return 'uz';

  const cyrillicCount = (text.match(/[а-яёА-ЯЁ]/g) || []).length;
  if (cyrillicCount > 3) return 'ru';

  return 'uz';
}

// Mijoz savoliga model bo'yicha mavjud barcha ma'lumotlar (matn qo'llanma,
// yo'riqnomadan olingan matn, ilova skrinshotlaridan olingan matn) asosida javob.
// Qaytaradi: matn massivi — har bir element alohida xabar sifatida yuboriladi.
async function answerCustomerQuestion({ question, model, language, hasGreeted }) {
  const guideTexts = (model.textGuides || []).map(g => g.text).join('\n---\n');
  const manualTexts = (model.manualImages || [])
    .map(m => m.extractedText).filter(Boolean).join('\n---\n');
  const appTexts = (model.appScreenshots || [])
    .map(a => `[${a.caption || 'ilova sahifasi'}]: ${a.extractedText}`).filter(Boolean).join('\n---\n');

  const greetInstruction = hasGreeted
    ? 'Suhbat allaqachon boshlangan, QAYTA SALOM BERMA, to\'g\'ridan-to\'g\'ri javobni yoz.'
    : 'Bu suhbatning birinchi xabari, javobni bitta marta samimiy salomlashish bilan boshla.';

  const system =
    `Sen EnvoCam kamera do'konining samimiy yordamchisisan. Bot emassan, yaqin inson, do'st kabi yozasan. ` +
    `${NO_EMOJI_RULE} ` +
    `Javoblaring QISQA bo'lishi kerak — har bir fikr 1-2 jumladan oshmasin. ` +
    `Agar javobda bir nechta alohida fikr/qadam bo'lsa, ularni "###" belgisi bilan ajratib yoz — ` +
    `har bir qism alohida xabar sifatida yuboriladi (xuddi odam ketma-ket bir nechta xabar yozgandek). ` +
    `Mijozning tili: ${langName(language)}. Shu tilda javob yoz. ${greetInstruction} ` +
    `"${model.name}" kamerasi haqida mavjud ma'lumotlar:\n\n` +
    `MATNLI QO'LLANMA:\n${guideTexts}\n\n` +
    `YO'RIQNOMADAN OLINGAN MA'LUMOT:\n${manualTexts}\n\n` +
    `ILOVA SAHIFALARI HAQIDA MA'LUMOT:\n${appTexts}\n\n` +
    `Shu ma'lumotlardan foydalanib javob ber. Agar savol bu ma'lumotlarda yo'q narsa haqida bo'lsa va aniq javob bera olmasang — ` +
    `mijozdan muammoni batafsilroq tushuntirishini va ekran tasvirini (screenshot) yuborishini iltimos qil. ` +
    `Hech qachon o'zingdan ma'lumot to'qib chiqarma.`;

  const result = await callClaude({
    system,
    maxTokens: 500,
    messages: [{ role: 'user', content: question }]
  });

  return result.split('###').map(s => s.trim()).filter(Boolean);
}

async function craftUnclearImageMessage({ language, hasGreeted }) {
  const greetInstruction = hasGreeted
    ? 'Qayta salom berma.'
    : 'Bitta marta samimiy salomlashish bilan boshla.';
  const system =
    `Sen EnvoCam kamera do'konining samimiy yordamchisisan, bot emas, inson kabi yozasan. ` +
    `${NO_EMOJI_RULE} ` +
    `Mijoz yuborgan kamera rasmi xira yoki hech narsa aniq ko'rinmayapti. ` +
    `Mijozdan iltimos bilan, yorug'roq joyda, kamera va uning qutisi/yozuvi aniq ko'rinadigan qilib qayta rasmga olib yuborishini so'ra. ` +
    `Juda qisqa (1-2 jumla), iliq ohangda yoz. ${greetInstruction} Til: ${langName(language)}.`;

  return callClaude({ system, maxTokens: 150, messages: [{ role: 'user', content: 'Xabar yoz' }] });
}

// Mijozning kamerasi bazada yo'q (boshqa, hali tayyorlanmagan model) bo'lganda
async function craftModelNotReadyMessage({ language, hasGreeted }) {
  const greetInstruction = hasGreeted ? 'Qayta salom berma.' : 'Bitta marta samimiy salomlashish bilan boshla.';
  const system =
    `Sen EnvoCam kamera do'konining samimiy yordamchisisan, bot emas, inson kabi yozasan. ` +
    `${NO_EMOJI_RULE} ` +
    `Mijozning kamerasi uchun hali video qo'llanma va to'liq ma'lumot tayyor emas. ` +
    `Mijozga muloyimlik bilan tushuntir: bu kamera uchun qo'llanma tez orada tayyorlanadi, biroz kutib turishini so'ra, ` +
    `va savol-muammosi bo'lsa hozir ham yordam berishga tayyor ekaningni ayt. Juda qisqa (2-3 jumla). ` +
    `${greetInstruction} Til: ${langName(language)}.`;

  return callClaude({ system, maxTokens: 200, messages: [{ role: 'user', content: 'Xabar yoz' }] });
}

// Video yuborilgandan keyin, mijoz ulay oldimi-yo'qmi so'rash uchun
async function craftConnectionFollowup({ language }) {
  const system =
    `Sen EnvoCam kamera do'konining samimiy yordamchisisan. ${NO_EMOJI_RULE} ` +
    `Mijozga, video qo'llanma yuborilgandan keyin, kamerani ulay olganini yoki olmaganini so'ra, ` +
    `muloyimlik bilan, juda qisqa (1 jumla). Til: ${langName(language)}.`;
  return callClaude({ system, maxTokens: 100, messages: [{ role: 'user', content: 'Xabar yoz' }] });
}

// Mijoz xabaridan "kamerani ulay oldim/hammasi yaxshi" kabi muvaffaqiyat
// signalini aniqlash (sharh so'rashni ishga tushirish uchun)
async function detectConnectionSuccess({ text, language }) {
  const system =
    `Mijoz xabaridan, u kamerani muvaffaqiyatli ulab olganini yoki mahsulotdan mamnun ekanini ` +
    `bildirib turganini aniqla. Faqat shu JSON formatda javob ber, boshqa hech narsa yozma: ` +
    `{"success": true yoki false}`;
  try {
    const result = await callClaude({ system, maxTokens: 50, messages: [{ role: 'user', content: text }] });
    const cleaned = result.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned).success === true;
  } catch (err) {
    return false;
  }
}

// Mijoz xabari turini aniqlaydi — bu orqali bot "rahmat" kabi xabarlarga
// qayta-qayta bir xil so'rov (masalan "rasm yuboring") yubormaydi.
// Natija: 'gratitude' (minnatdorchilik/xayrlashuv) | 'needs_camera_id' (kamera
// aniqlanishi kerak bo'lgan savol) | 'cannot_send_photo' (rasm yubora olmayapti,
// sababini aytmoqda) | 'general'
async function classifyCustomerIntent({ text }) {
  const system =
    `Mijoz xabarini quyidagi toifalardan biriga ajrat. Faqat shu JSON formatda javob ber: ` +
    `{"intent": "gratitude" yoki "cannot_send_photo" yoki "needs_camera_id" yoki "general"}\n\n` +
    `- gratitude: mijoz rahmat aytmoqda, xayrlashmoqda, yoki suhbatni yakunlamoqda (masalan "rahmat", "xo'p mayli", "ok rozi bo'ldim")\n` +
    `- cannot_send_photo: mijoz rasm yubora olmayotganini, kamerasi/telefoni biror sababdan rasmga ola olmayotganini aytmoqda\n` +
    `- needs_camera_id: mijoz kamerasi haqida savol so'rayapti, yordam so'rayapti, lekin hali qaysi model ekani noma'lum\n` +
    `- general: boshqa har qanday holat`;

  try {
    const result = await callClaude({ system, maxTokens: 60, messages: [{ role: 'user', content: text }] });
    const cleaned = result.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned).intent || 'general';
  } catch (err) {
    return 'general';
  }
}

module.exports = {
  identifyModelFromImage,
  extractTextFromImage,
  detectLanguage,
  answerCustomerQuestion,
  craftUnclearImageMessage,
  craftModelNotReadyMessage,
  craftConnectionFollowup,
  detectConnectionSuccess,
  classifyCustomerIntent
};
