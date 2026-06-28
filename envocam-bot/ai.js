// ai.js — Claude API bilan ishlash: rasm orqali model aniqlash, savolga javob yozish,
// til aniqlash (o'zbek/rus), iliq va inson-ohangidagi qisqa javoblar.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

async function callClaude({ system, messages, maxTokens = 500 }) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages
    })
  });
  const data = await res.json();
  if (data.error) {
    throw new Error(`Claude API xatosi: ${data.error.message}`);
  }
  const textBlock = (data.content || []).find(b => b.type === 'text');
  return textBlock ? textBlock.text.trim() : '';
}

// Rasm orqali qaysi kamera modeli ekanini aniqlaydi.
// modelNames — bazadagi mavjud model nomlari ro'yxati.
// Qaytaradi: { modelName: string|null, isClear: boolean, reason: string }
async function identifyModelFromImage({ base64Image, mediaType, modelNames }) {
  const system =
    `Sen kamera modelini rasm orqali aniqlaydigan yordamchisan. ` +
    `Mavjud modellar ro'yxati: ${modelNames.join(', ')}. ` +
    `Faqat shu ro'yxatdagi nomlardan birini tanla, agar mos kelmasa yoki rasm xira/tushunarsiz bo'lsa "NOANIQ" deb yoz. ` +
    `Javobni FAQAT shu JSON formatda qaytar, boshqa hech narsa yozma: ` +
    `{"model": "model_nomi_yoki_NOANIQ", "sabab": "qisqa izoh"}`;

  const result = await callClaude({
    system,
    maxTokens: 200,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
          { type: 'text', text: 'Bu rasmda qaysi kamera modeli ko\'rinmoqda?' }
        ]
      }
    ]
  });

  try {
    const cleaned = result.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    const isClear = parsed.model && parsed.model !== 'NOANIQ' && modelNames.includes(parsed.model);
    return {
      modelName: isClear ? parsed.model : null,
      isClear,
      reason: parsed.sabab || ''
    };
  } catch (err) {
    return { modelName: null, isClear: false, reason: 'AI javobini o\'qib bo\'lmadi' };
  }
}

// Mijoz tilini aniqlash (oddiy, tezkor)
function detectLanguage(text) {
  if (!text) return 'uz';
  const cyrillicCount = (text.match(/[а-яёА-ЯЁ]/g) || []).length;
  const uzbekSpecific = /[oʻgʻшЧчЎ]|o'|g'/i.test(text);
  if (cyrillicCount > 3 && !uzbekSpecific) return 'ru';
  return 'uz';
}

// Mijoz savoliga, model bo'yicha mavjud ma'lumotlar (matn qo'llanmalar) asosida,
// iliq, qisqa, inson-ohangidagi javob yozadi.
async function answerCustomerQuestion({ question, model, language, customerName }) {
  const guideTexts = (model.textGuides || []).map(g => g.text).join('\n---\n');
  const langName = language === 'ru' ? 'rus' : 'o\'zbek';

  const system =
    `Sen EnvoCam kamera do'konining samimiy, mehribon yordamchisisan. ` +
    `Sen bot emassan, xuddi yaqin inson, do'st kabi gaplashasan — rasmiy, sovuq ohangda yozmaysan. ` +
    `Javoblaring QISQA va ANIQ bo'lishi kerak (2-4 jumladan oshmasin), chunki odamlar uzun matn o'qishni yomon ko'radi. ` +
    `Hech qachon "Mijoz:" yoki shunga o'xshash narsalarni qaytarib yozma, faqat to'g'ridan-to'g'ri javob yoz. ` +
    `Mijozning tili: ${langName}. Shu tilda javob yoz. ` +
    `Quyida "${model.name}" kamerasi haqidagi qo'llanma ma'lumotlari berilgan, shulardan foydalanib javob ber:\n\n${guideTexts}\n\n` +
    `Agar savol qo'llanmada yo'q narsa haqida bo'lsa va sen aniq javob bera olmasang — mijozdan muammoni BATAFSILROQ tushuntirishini va EKRAN TASVIRINI (screenshot) yuborishini iltimos qil, shunda muammo aniqroq tushuniladi deb tushuntir. ` +
    `Hech qachon o'zingdan ma'lumot to'qib chiqarma.`;

  return callClaude({
    system,
    maxTokens: 300,
    messages: [{ role: 'user', content: question }]
  });
}

// Rasm aniqlanmagan/xira bo'lganda mijozga yuboriladigan iliq xabar
async function craftUnclearImageMessage({ language }) {
  const langName = language === 'ru' ? 'rus' : 'o\'zbek';
  const system =
    `Sen EnvoCam kamera do'konining samimiy yordamchisisan, bot emas, inson kabi yozasan. ` +
    `Mijoz yuborgan kamera rasmi xira yoki model aniq ko'rinmayapti. ` +
    `Mijozdan iltimos bilan, yorug'roq joyda, kamera va uning qutisi/modeli yozuvi aniq ko'rinadigan qilib qayta rasmga olib yuborishini so'ra. ` +
    `Juda qisqa (1-2 jumla), iliq ohangda yoz. Tilni: ${langName}.`;

  return callClaude({
    system,
    maxTokens: 150,
    messages: [{ role: 'user', content: 'Xabar yoz' }]
  });
}

module.exports = {
  identifyModelFromImage,
  detectLanguage,
  answerCustomerQuestion,
  craftUnclearImageMessage
};
