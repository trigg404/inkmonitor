/**
 * Ink Network Transaction Monitor
 * Watches multiple addresses and sends Telegram alerts on new transactions
 */

require("dotenv").config();
const https = require("https");
const http = require("http");

// ─── Config ───────────────────────────────────────────────────────────────────
const CONFIG = {
  addresses: [
    "0x38Ec515FE36b359b9d54e94337497C2D982aA1B1",
    "0x0c2EC7F7DA019F0708B4556C2489892952461734",
  ],
  inkRpcUrl: process.env.INK_RPC_URL || "https://rpc-qnd.inkonchain.com",
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "15000"),
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },
};

// Lowercase set for fast lookup
const watchedAddrs = new Set(CONFIG.addresses.map(a => a.toLowerCase()));

// ─── State ────────────────────────────────────────────────────────────────────
let lastCheckedBlock = null;
const seenTxHashes = new Set();

// ─── RPC Helper ───────────────────────────────────────────────────────────────
function rpcCall(method, params = []) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const url = new URL(CONFIG.inkRpcUrl);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message));
          else resolve(parsed.result);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function explorerTxUrl(hash) {
  return `https://explorer.inkonchain.com/tx/${hash}`;
}

function formatEth(hexValue) {
  if (!hexValue || hexValue === "0x0") return "0 ETH";
  const eth = Number(BigInt(hexValue)) / 1e18;
  return `${eth.toFixed(6)} ETH`;
}

function shortAddr(addr) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// ─── Telegram Helper ──────────────────────────────────────────────────────────
function telegramPost(payload) {
  return new Promise((resolve, reject) => {
    const url = `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`;
    const body = JSON.stringify(payload);
    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Telegram Alert ───────────────────────────────────────────────────────────
async function sendTelegram(tx, blockNumber, matchedAddress) {
  if (!CONFIG.telegram.botToken || !CONFIG.telegram.chatId) {
    console.warn("⚠️  Telegram not configured — check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in your variables.");
    return;
  }

  const isOutgoing = tx.from?.toLowerCase() === matchedAddress.toLowerCase();
  const direction = isOutgoing ? "📤 OUTGOING" : "📥 INCOMING";

  // First message: loud alarm ping
  await telegramPost({
    chat_id: CONFIG.telegram.chatId,
    text: `🚨🚨🚨 INK TRANSACTION DETECTED\nAddress: ${shortAddr(matchedAddress)} 🚨🚨🚨`,
    disable_notification: false,
  });

  // Second message: full details
  const details =
    `🔔 *Ink Network Transaction Alert*\n\n` +
    `*Watched Address:* \`${matchedAddress}\`\n` +
    `${direction}\n\n` +
    `*Block:* \`${blockNumber}\`\n` +
    `*Hash:* \`${tx.hash}\`\n` +
    `*From:* \`${tx.from}\`\n` +
    `*To:* \`${tx.to || "Contract Creation"}\`\n` +
    `*Value:* ${formatEth(tx.value)}\n` +
    `*Gas Price:* ${tx.gasPrice ? Math.round(Number(BigInt(tx.gasPrice)) / 1e9) + " Gwei" : "N/A"}\n\n` +
    `[View on Explorer](${explorerTxUrl(tx.hash)})`;

  const result = await telegramPost({
    chat_id: CONFIG.telegram.chatId,
    text: details,
    parse_mode: "Markdown",
    disable_notification: false,
    disable_web_page_preview: false,
  });

  if (result.ok) {
    console.log("✅ Telegram alert sent");
  } else {
    console.error("❌ Telegram error:", result.description);
  }
}

// ─── Process a Block ──────────────────────────────────────────────────────────
async function processBlock(blockHex) {
  const blockNumber = parseInt(blockHex, 16);
  const block = await rpcCall("eth_getBlockByNumber", [blockHex, true]);

  if (!block || !block.transactions) return;

  for (const tx of block.transactions) {
    if (seenTxHashes.has(tx.hash)) continue;

    const fromMatch = watchedAddrs.has(tx.from?.toLowerCase());
    const toMatch = watchedAddrs.has(tx.to?.toLowerCase());

    if (fromMatch || toMatch) {
      seenTxHashes.add(tx.hash);

      // Find which watched address was involved
      const matchedAddress = CONFIG.addresses.find(a =>
        a.toLowerCase() === tx.from?.toLowerCase() ||
        a.toLowerCase() === tx.to?.toLowerCase()
      );

      console.log(
        `\n🚨 Transaction detected in block ${blockNumber}!\n` +
        `   Matched: ${matchedAddress}\n` +
        `   Hash: ${tx.hash}\n` +
        `   From: ${tx.from}\n` +
        `   To:   ${tx.to || "Contract Creation"}\n` +
        `   Value: ${formatEth(tx.value)}`
      );

      await sendTelegram(tx, blockNumber, matchedAddress);
    }
  }
}

// ─── Main Poll Loop ───────────────────────────────────────────────────────────
async function poll() {
  try {
    const latestHex = await rpcCall("eth_blockNumber");
    const latestBlock = parseInt(latestHex, 16);

    if (lastCheckedBlock === null) {
      lastCheckedBlock = latestBlock;
      console.log(`🟢 Starting monitor from block ${latestBlock}`);
      return;
    }

    for (let b = lastCheckedBlock + 1; b <= latestBlock; b++) {
      await processBlock("0x" + b.toString(16));
    }

    if (latestBlock > lastCheckedBlock) {
      console.log(`📦 Processed blocks ${lastCheckedBlock + 1}–${latestBlock} | ${new Date().toISOString()}`);
      lastCheckedBlock = latestBlock;
    }
  } catch (err) {
    console.error("❌ Poll error:", err.message);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
console.log("═══════════════════════════════════════════");
console.log("  Ink Network Transaction Monitor");
console.log(`  Watching ${CONFIG.addresses.length} addresses:`);
CONFIG.addresses.forEach(a => console.log(`  • ${a}`));
console.log(`  Poll interval: ${CONFIG.pollIntervalMs / 1000}s`);
console.log("═══════════════════════════════════════════");

poll();
setInterval(poll, CONFIG.pollIntervalMs);
