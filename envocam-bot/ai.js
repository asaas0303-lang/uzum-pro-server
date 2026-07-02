const { Anthropic } = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

/**
 * Perform OCR on images (instructions/screenshots)
 */
async function extractTextFromImage(base64Image, mimeType = 'image/jpeg') {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType,
                data: base64Image
              }
            },
            {
              type: 'text',
              text: 'Rasm ichidagi barcha matnlarni oʻzbek yoki rus tilida aniq oʻqib, qaytarib ber. Hech qanday ortiqcha izoh yoki soʻz yozma, faqat rasmdagi matnni oʻzini qaytar.'
            }
          ]
        }
      ]
    });
    return response.content[0].text.trim();
  } catch (error) {
    console.error('Claude OCR Error:', error);
    return '';
  }
}

/**
 * Match a user photo with existing database camera models
 */
async function matchPhotoToModel(base64Image, modelsList, mimeType = 'image/jpeg') {
  try {
    const prompt = `Mavjud modellar: ${JSON.stringify(modelsList)}.
Rasmga imkon qadar tirishib qara. Mos modelni topish SHART.
Faqat haqiqatan tushunarsiz bo'lsa "unclear" de.
Ro'yxatda yo'q model bo'lsa "no_match" de.

Faqat JSON formatda javob ber: {"status": "matched|unclear|no_match", "model": "nom yoki null"}`;

    const response = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 150,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType,
                data: base64Image
              }
            },
            {
              type: 'text',
              text: prompt
            }
          ]
        }
      ]
    });

    const rawText = response.content[0].text.trim();
    return JSON.parse(rawText);
  } catch (error) {
    console.error('Claude Photo Matching Error:', error);
    return { status: 'unclear', model: null };
  }
}

/**
 * Determine incoming customer query intent
 */
async function detectUserIntent(text) {
  try {
    const prompt = `Faqat JSON formatda javob ber: {"intent": "gratitude|question|cannot_send_photo"}
- gratitude: rahmat, xo'p, ok, yaxshi, bo'ldi kabi minnatdorchilik so'zlari
- cannot_send_photo: rasm yubora olmayotganini aytmoqda
- question: savol yoki muammo

Matn: "${text}"`;

    const response = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }]
    });

    const rawText = response.content[0].text.trim();
    return JSON.parse(rawText);
  } catch (error) {
    console.error('Claude Intent Detection Error:', error);
    return { intent: 'question' };
  }
}

/**
 * Formulate response for customer query
 */
async function generateCustomerResponse(queryText, contextData, language, includeGreeting) {
  try {
    const prompt = `Sen EnvoCam kamera do'konining yordamchisisan. Inson kabi, samimiy yoz.
HECH QACHON emoji ishlatma.
Har bir fikr 1-2 jumladan oshmasin.
Bir nechta fikr bo'lsa ### bilan ajrat (har biri alohida xabar bo'ladi).
Til: [${language}].
Salomlashish: ${includeGreeting ? "Salomlashish kerak" : "Salomlashish shart emas"}.
Mavjud ma'lumotlar (bilimlar bazasi): ${JSON.stringify(contextData)}.
Aniq javob ber. Bilmasang — ekran tasviri yoki batafsilroq tushuntirish so'ra.

Mijoz savoli: "${queryText}"`;

    const response = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }]
    });

    return response.content[0].text.trim();
  } catch (error) {
    console.error('Claude Q&A Generation Error:', error);
    return language === 'uz'
      ? 'Kechirasiz, tizimda muammo yuz berdi. Iltimos, keyinroq qayta urunib koʻring.'
      : 'Извините, произошла техническая ошибка. Пожалуйста, попробуйте позже.';
  }
}

module.exports = {
  extractTextFromImage,
  matchPhotoToModel,
  detectUserIntent,
  generateCustomerResponse
};
