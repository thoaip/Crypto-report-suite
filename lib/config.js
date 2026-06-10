/**
 * Secret/config loader. Reads API keys from environment variables first
 * (CAS_SOSOVALUE_KEY, CAS_FREECRYPTOAPI_KEY), then falls back to secrets.json.
 * Never hardcode keys in source — secrets.json is gitignored.
 */

const fs = require("fs");
const path = require("path");

let cache = null;

function load() {
  if (cache) return cache;
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "secrets.json"), "utf8"));
  } catch {
    file = {};
  }
  cache = {
    sosovalue: process.env.CAS_SOSOVALUE_KEY || file.sosovalue || null,
    freecryptoapi: process.env.CAS_FREECRYPTOAPI_KEY || file.freecryptoapi || null,
    telegramToken: process.env.CAS_TELEGRAM_TOKEN || file.telegram_token || null,
    telegramChatId: process.env.CAS_TELEGRAM_CHAT_ID || file.telegram_chat_id || null,
  };
  return cache;
}

module.exports = { load };
