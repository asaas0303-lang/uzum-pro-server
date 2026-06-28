// queue.js — Xabarlarni "inson kabi" kechikish bilan, navbat orqali yuborish.

const queue = [];
let processing = false;

function randomDelay(minMs, maxMs) {
  return minMs + Math.random() * (maxMs - minMs);
}

function enqueue(task, { humanDelayMs } = {}) {
  return new Promise((resolve, reject) => {
    queue.push({ task, humanDelayMs, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (processing) return;
  processing = true;

  while (queue.length > 0) {
    const { task, humanDelayMs, resolve, reject } = queue.shift();
    try {
      if (humanDelayMs) {
        await new Promise(r => setTimeout(r, humanDelayMs));
      }
      const result = await task();
      resolve(result);
    } catch (err) {
      reject(err);
    }
    await new Promise(r => setTimeout(r, randomDelay(1500, 3000)));
  }

  processing = false;
}

module.exports = { enqueue, randomDelay };
