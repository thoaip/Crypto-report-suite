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
  // Trim whitespace/newlines — GitHub Secrets pasted with a trailing newline
  // are a common silent cause of "chat not found" / auth failures.
  const t = (v) => (v == null ? null : String(v).trim() || null);
  cache = {
    sosovalue: t(process.env.CAS_SOSOVALUE_KEY || file.sosovalue),
    freecryptoapi: t(process.env.CAS_FREECRYPTOAPI_KEY || file.freecryptoapi),
    telegramToken: t(process.env.CAS_TELEGRAM_TOKEN || file.telegram_token),
    telegramChatId: t(process.env.CAS_TELEGRAM_CHAT_ID || file.telegram_chat_id),
  };
  return cache;
}

module.exports = { load };
