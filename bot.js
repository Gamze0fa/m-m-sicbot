const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ═══════════════════════════════════════════
// 🔧 SELF-SETUP: yt-dlp otomatik kurulum
// ═══════════════════════════════════════════
const YTDLP_PATH = (() => {
  const candidates = [
    path.join(__dirname, 'yt-dlp.exe'),
    path.join(__dirname, 'yt-dlp'),
    path.join(__dirname, 'yt-dlp_linux')
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        if (!p.endsWith('.exe')) execSync('chmod +x "' + p + '"', { timeout: 5000, stdio: 'ignore' });
      } catch(e) {}
      try {
        const ver = execSync('"' + p + '" --version', { encoding: 'utf-8', timeout: 10000 }).trim();
        console.log('[Setup] yt-dlp hazir. Surum:', ver, '(', path.basename(p), ')');
        return p;
      } catch(e) {
        console.log('[Setup] ' + path.basename(p) + ' calismiyor:', e.message.substring(0, 100));
      }
    }
  }
  console.log('[Setup] yt-dlp bulunamadi! File Manager ile yukleyin.');
  return null;
})();
global.YTDLP_PATH = YTDLP_PATH;
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');
if (!fs.existsSync(COOKIES_PATH) || fs.readFileSync(COOKIES_PATH, 'utf8').split('\n').every(l => l.trim() === '' || l.startsWith('#'))) {
  console.log('[Setup] UYARI: cookies.txt bos/yok - YouTube 403 engeli gelebilir!');
} else {
  console.log('[Setup] cookies.txt aktif.');
}
global.COOKIES_PATH = COOKIES_PATH;

require('dotenv').config();
const { Highrise } = require('highrise-js-sdk');
const { spawn } = require('child_process');
const express = require('express');
const http = require('http');
const { searchItems, getItemById, getItemsByCategory, getCategories, formatItem, items, getRandomOutfit, getItemNameById, findItemByName, CLOTHING_CATEGORIES } = require('./items.js');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { searchYouTube, getAudioURL } = require('./youtube.js');

const ICECAST_URL = process.env.ICECAST_URL;
const FFMPEG_PATH = process.env.FFMPEG_PATH || (() => {
  try { return require('@ffmpeg-installer/ffmpeg').path; } catch(e) { return 'ffmpeg'; }
})();
const ADMINS = (process.env.ADMINS || '').split(',').map(s => s.trim());
const HIGHRISE_TOKEN = process.env.HIGHRISE_TOKEN;
const ROOM_ID = process.env.ROOM_ID;
const PORT = process.env.PORT || 3000;

let encoder = null;
let currentDecoder = null;
let currentSong = null;
let queue = [];
let isPlaying = false;
let volume = 50;
let loopMode = false;
let cooldowns = {};
let silenceInterval = null;
let pipelineGeneration = 0;
let voteskipState = { active: false, voters: [], required: 0, songTitle: '' };
let autoOutfitChange = false;
let autoOutfitInterval = null;
let randomOutfitActive = false;
let lastRandomOutfit = [];
let encoderRetryCount = 0;
let botDanceInterval = null;
const ENCODER_MAX_RETRIES = 10;

const DATA_FILE = __dirname + '/bot_data.json';
const SICIL_FILE = __dirname + '/sicil.json';
const GAME_FILE = __dirname + '/game_data.json';
const BLACKLIST_FILE = __dirname + '/blacklist.json';


function loadGameData() {
  try {
    if (fs.existsSync(GAME_FILE)) return JSON.parse(fs.readFileSync(GAME_FILE, 'utf8'));
  } catch(e) {}
  return {};
}

function saveGameData(data) {
  fs.writeFileSync(GAME_FILE, JSON.stringify(data, null, 2));
}

let gameData = loadGameData();

function loadBlacklist() {
  try {
    if (fs.existsSync(BLACKLIST_FILE)) return JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf8'));
  } catch(e) {}
  return { songs: [], addedBy: {} };
}

function saveBlacklist(data) {
  fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(data, null, 2));
}

let blacklist = loadBlacklist();

function isBlacklisted(title) {
  const lower = title.toLowerCase();
  return blacklist.songs.some(s => lower.includes(s.toLowerCase()));
}

function addToBlacklist(title, addedBy) {
  if (!blacklist.songs.includes(title)) {
    blacklist.songs.push(title);
    blacklist.addedBy[title] = addedBy;
    saveBlacklist(blacklist);
    return true;
  }
  return false;
}

function removeFromBlacklist(title) {
  const idx = blacklist.songs.indexOf(title);
  if (idx !== -1) {
    blacklist.songs.splice(idx, 1);
    delete blacklist.addedBy[title];
    saveBlacklist(blacklist);
    return true;
  }
  return false;
}

function getUserGameData(username) {
  if (!gameData[username]) {
    gameData[username] = {
      level: 1, xp: 0, rep: 0, title: '',
      mining: { level: 1, xp: 0, auto: false, pickaxe: 1 },
      fishing: { level: 1, xp: 0, auto: false, rod: 1 },
      inventory: { ores: {}, fish: {} },
      marriage: null, marriedTo: null,
      afk: false, afkReason: '',
      jail: false, jailTime: 0, jailReason: '',
      badges: [], perks: [],
      bomb: null,
      lastDaily: 0, lastWork: 0, lastCrime: 0,
      totalEarned: 0, totalSpent: 0,
      quests: {},
      wallet: 0,
      stats: {
        walk_score: 0,
        message_count: 0,
        tip_given: 0,
        tip_received: 0,
        music_count: 0,
        punch_count: 0,
        last_position: null,
        last_move_time: 0
      }
    };
    saveGameData(gameData);
  }
  if (!gameData[username].stats) {
    gameData[username].stats = {
      walk_score: 0, message_count: 0, tip_given: 0,
      tip_received: 0, music_count: 0, punch_count: 0,
      last_position: null, last_move_time: 0
    };
    saveGameData(gameData);
  }
  return gameData[username];
}

function addXP(username, amount) {
  const u = getUserGameData(username);
  u.xp += amount;
  const needed = u.level * 100;
  while (u.xp >= needed) {
    u.xp -= needed;
    u.level++;
    sendChat(`🎉 @${username} seviye atladı! Level ${u.level}!`);
  }
  saveGameData(gameData);
}

const ORE_TYPES = [
  { name: 'Taş', rarity: 0.5, value: 5, level: 1 },
  { name: 'Bakır', rarity: 0.3, value: 15, level: 1 },
  { name: 'Demir', rarity: 0.2, value: 25, level: 2 },
  { name: 'Altın', rarity: 0.1, value: 50, level: 3 },
  { name: 'Elmas', rarity: 0.05, value: 100, level: 4 },
  { name: 'Zümrüt', rarity: 0.03, value: 200, level: 5 },
  { name: 'Yakut', rarity: 0.02, value: 350, level: 6 },
  { name: 'Safir', rarity: 0.01, value: 500, level: 7 },
  { name: 'Amber', rarity: 0.008, value: 750, level: 7 },
  { name: 'Obsidyen', rarity: 0.005, value: 1000, level: 7 }
];

const FISH_TYPES = [
  { name: 'Hamsi', rarity: 0.4, value: 8, level: 1 },
  { name: 'Palamut', rarity: 0.25, value: 20, level: 1 },
  { name: 'Levrek', rarity: 0.15, value: 35, level: 2 },
  { name: 'Çipura', rarity: 0.1, value: 60, level: 3 },
  { name: 'Lüfer', rarity: 0.06, value: 100, level: 4 },
  { name: 'Pisi Balığı', rarity: 0.04, value: 150, level: 4 },
  { name: 'Orkinos', rarity: 0.025, value: 250, level: 5 },
  { name: 'Kılıç Balığı', rarity: 0.015, value: 400, level: 6 },
  { name: 'Marlin', rarity: 0.008, value: 600, level: 6 },
  { name: 'Balina Köpek Balığı', rarity: 0.003, value: 1000, level: 7 }
];

function pickRandom(items) {
  const total = items.reduce((s, i) => s + i.rarity, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.rarity;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e) {}
  return {};
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function loadSicil() {
  try {
    if (fs.existsSync(SICIL_FILE)) return JSON.parse(fs.readFileSync(SICIL_FILE, 'utf8'));
  } catch(e) {}
  return {};
}

function saveSicil(data) {
  fs.writeFileSync(SICIL_FILE, JSON.stringify(data, null, 2));
}

let botData = loadData();
let sicil = loadSicil();
let tipHistory = {};
let firstTippers = {};
let welcomeGiven = {};
let dailyCooldowns = {};

const CUSTOM_EMOTES_FILE = __dirname + '/custom_emotes.json';
let customEmotes = {};
try { customEmotes = JSON.parse(fs.readFileSync(CUSTOM_EMOTES_FILE, 'utf8')); } catch(e) {}
function saveCustomEmotes() { fs.writeFileSync(CUSTOM_EMOTES_FILE, JSON.stringify(customEmotes, null, 2)); }

const OUTFITS_FILE = __dirname + '/outfits.json';
let outfits = {};
try { outfits = JSON.parse(fs.readFileSync(OUTFITS_FILE, 'utf8')); } catch(e) {}
function saveOutfits() { fs.writeFileSync(OUTFITS_FILE, JSON.stringify(outfits, null, 2)); }

function startAutoOutfitChange() {
  if (autoOutfitInterval) clearInterval(autoOutfitInterval);
  autoOutfitInterval = setInterval(async () => {
    if (!autoOutfitChange) return;
    try {
      const categories = ['hair_front', 'hair_back', 'shirt', 'pants', 'shoes', 'glasses', 'necklace', 'hat', 'skirt', 'dress', 'earrings', 'gloves', 'handbag', 'bag'];
      const allItems = items || [];
      const randomItems = [
        { type: 'clothing', amount: 1, id: 'body-flesh', account_bound: false, active_palette: 27 },
        { type: 'clothing', amount: 1, id: 'eye-n_octhrsupport2024almond', account_bound: false, active_palette: 7 },
        { type: 'clothing', amount: 1, id: 'eyebrow-n_basic2018newbrows07', account_bound: false, active_palette: 0 },
        { type: 'clothing', amount: 1, id: 'nose-n_octhrsupport2024blushednose', account_bound: false, active_palette: 0 },
        { type: 'clothing', amount: 1, id: 'mouth-n_octhrsupport2024sweetlips', account_bound: false, active_palette: -1 }
      ];
      for (const cat of categories) {
        const catItems = allItems.filter(i => (i.id || '').toLowerCase().startsWith(cat));
        if (catItems.length > 0) {
          const randomItem = catItems[Math.floor(Math.random() * catItems.length)];
          randomItems.push({ type: 'clothing', amount: 1, id: randomItem.id, account_bound: false, active_palette: 0 });
        }
      }
      await setBotOutfit(randomItems);
      console.log('[Outfit] Otomatik kiyafet degistirildi:', randomItems.length, 'item');
    } catch(e) {
      console.log('[Outfit] Otomatik degisim hatasi:', e.message);
    }
  }, 300000);
  console.log('[Outfit] Otomatik kiyafet degisimi baslatildi (her 5 dakika)');
}

function stopAutoOutfitChange() {
  if (autoOutfitInterval) {
    clearInterval(autoOutfitInterval);
    autoOutfitInterval = null;
  }
}

function buyItem(itemId) {
  return new Promise((resolve, reject) => {
    if (!client.ws || client.ws.readyState !== 1) return reject('WebSocket bağlı değil');
    const payload = { _type: 'BuyItemRequest', item_id: itemId, rid: String(Date.now()) };
    console.log(`[Buy] Satin aliniyor: ${itemId}`);
    client.ws.send(JSON.stringify(payload), (err) => {
      if (err) { console.log(`[Buy] Hata: ${itemId}`, err.message); reject(err); }
      else { console.log(`[Buy] Gönderildi: ${itemId}`); resolve(); }
    });
  });
}

function setBotOutfit(items) {
  return new Promise((resolve, reject) => {
    if (!client.ws || client.ws.readyState !== 1) return reject('WebSocket bağlı değil');
    const outfitItems = items.map(id => {
      if (typeof id === 'object') return id;
      const palette = id.includes('eye') ? 1 : 0;
      return { type: 'clothing', amount: 1, id, account_bound: false, active_palette: palette };
    });
    const payload = {
      _type: 'SetOutfitRequest',
      outfit: outfitItems,
      rid: String(Date.now())
    };
    console.log('[Outfit] Gönderiliyor:', JSON.stringify(payload.outfit.map(i => i.id)));
    client.ws.send(JSON.stringify(payload), (err) => {
      if (err) { console.log('[Outfit] Hata:', err.message); reject(err); }
      else { console.log('[Outfit] Gönderildi!'); resolve(); }
    });
  });
}

let botPosition = { x: 0, y: 0, z: 0 };
const BOT_POSITION_FILE = __dirname + '/bot_position.json';
const TELEPORT_FILE = __dirname + '/teleports.json';

let savedBotPosition = null;
try { savedBotPosition = JSON.parse(fs.readFileSync(BOT_POSITION_FILE, 'utf8')); } catch(e) {}
function saveBotPosition(x, y, z) {
  savedBotPosition = { x, y, z, savedAt: Date.now() };
  fs.writeFileSync(BOT_POSITION_FILE, JSON.stringify(savedBotPosition, null, 2));
}
function getSavedBotPosition() { return savedBotPosition; }

let teleports = {};
try { teleports = JSON.parse(fs.readFileSync(TELEPORT_FILE, 'utf8')); } catch(e) { teleports = {}; }
function saveTeleports() { fs.writeFileSync(TELEPORT_FILE, JSON.stringify(teleports, null, 2)); }
function getTeleports() { return teleports; }
function addTeleport(name, x, y, z, facing) { teleports[name] = { x, y, z, facing: facing || 'FrontRight' }; saveTeleports(); }
function removeTeleport(name) { if (teleports[name]) { delete teleports[name]; saveTeleports(); return true; } return false; }
function getTeleport(name) { return teleports[name] || null; }

const GRADIENT_PALETTE = [
  [255,191,225],[255,208,226],[255,225,225],[252,241,225],[255,255,227],
  [212,241,255],[207,208,254],[207,191,254],[206,173,254],[254,175,255],
  [252,174,239],[255,173,223],[254,173,206]
];
function _lerpColor(c1,c2,t){return c1.map((v,i)=>Math.round(v+(c2[i]-v)*t));}
function _gradientAt(pos){
  const n=GRADIENT_PALETTE.length,span=(n-1)*2;
  let t=(pos%1)*span;if(t>n-1)t=span-t;
  const idx=Math.min(Math.floor(t),n-2),frac=t-idx;
  const[r,g,b]=_lerpColor(GRADIENT_PALETTE[idx],GRADIENT_PALETTE[idx+1],frac);
  return `<#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}>`;
}
function neonFormat(text){
  const lines=text.split('\n'),totalLen=text.trim().length;
  const step=totalLen<=70?3:totalLen<=220?12:10**6;
  return lines.map(line=>{
    if(!line.trim())return line;
    const len=Math.max(line.length-1,1),parts=[];
    for(let i=0;i<line.length;i+=step){
      parts.push(_gradientAt(i/len*0.7)+line.substring(i,i+step));
    }
    return parts.join('');
  }).join('\n');
}
function rainbow(text){return neonFormat(text);}
function gold(text){return neonFormat(text);}
function pink(text){return neonFormat(text);}
function cyan(text){return neonFormat(text);}
function red(text){return neonFormat(text);}
function green(text){return neonFormat(text);}
function purple(text){return neonFormat(text);}
function orange(text){return neonFormat(text);}
function white(text){return text;}
function blue(text){return neonFormat(text);}

// ═══════════════════════════════════════════
// 🎭 DANCE/EMOTE SYSTEM
// ═══════════════════════════════════════════
let dances = [];
try { dances = JSON.parse(fs.readFileSync(path.join(__dirname, 'dances.json'), 'utf8')); } catch(e) { console.log('[Dances] dances.json yuklenemedi'); }
const danceMap = {};
dances.forEach((d, i) => { danceMap[d.name.toLowerCase()] = { ...d, index: i + 1 }; });
const danceLoops = {};
const duoLoops = {};
const BOT_USER_ID = '6a4bb4dffce970fd78a729fe';

function getDanceByIndex(num) { return dances[num - 1] || null; }
function getDanceByName(name) { return danceMap[name.toLowerCase()] || null; }
function findDance(query) {
  const q = query.toLowerCase().trim();
  if (/^\d+$/.test(q)) return getDanceByIndex(parseInt(q));
  return getDanceByName(q);
}
async function playEmoteLoop(userId, emoteId, duration) {
  const loopKey = userId;
  if (danceLoops[loopKey]) clearTimeout(danceLoops[loopKey].timer);
  async function loop() {
    try {
      await client.user.emote(userId, emoteId);
    } catch(e) { console.log('[EmoteLoop] Hata:', e.message); }
    danceLoops[loopKey] = { timer: setTimeout(loop, (duration || 5) * 1000), emoteId, startTime: Date.now() };
  }
  await loop();
}
function stopEmoteLoop(userId) {
  if (danceLoops[userId]) { clearTimeout(danceLoops[userId].timer); delete danceLoops[userId]; }
}
function stopAllEmoteLoops() {
  for (const key of Object.keys(danceLoops)) { clearTimeout(danceLoops[key].timer); delete danceLoops[key]; }
}

// ═══════════════════════════════════════════
// 🤖 AI PERSONALITY SYSTEM
// ═══════════════════════════════════════════
let aiMode = 'normal';
const AI_PERSONALITIES = {
  normal: { name: 'Normal', prompt: 'Sen yardimsever bir asistansin.' },
  lafsokan: { name: 'Laf Sokan', prompt: 'Komik,espri yapan,az parameter konusan ama laf sokan bir karaktersin. Turkce konus.' },
  askdoktoru: { name: 'Ask Doktoru', prompt: 'Ask konusunda uzman,romantik ama komik bir danisansin. Turkce konus.' },
  cilveli: { name: 'Cilveli', prompt: 'Cilveli,sevimli,kizar gibi konusan bir karaktersin. Turkce konus.' },
  kabadayi: { name: 'Kabadayi', prompt: 'Kabadayi gibi konusan,sert ama komik bir karaktersin. Turkce konus.' },
  filozof: { name: 'Filozof', prompt: 'Derin dusuncelere dalan,felsefi konusan bir bilge sin. Turkce konus.' },
  dedektif: { name: 'Dedektif', prompt: 'Gizemleri cozmeyi seven,soru sorarak ilerleyen bir dedektif sin. Turkce konus.' }
};

// ═══════════════════════════════════════════
// 📢 AUTO-ANNOUNCEMENT SYSTEM
// ═══════════════════════════════════════════
let autoAnnounceInterval = null;
let autoAnnounceMessage = '';
let autoAnnounceIntervalMs = 300000;

// ═══════════════════════════════════════════
// 🎴 BLACKJACK GAME STATE
// ═══════════════════════════════════════════
const blackjackGames = {};
function createDeck() {
  const suits = ['♠','♥','♦','♣'];
  const values = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  const deck = [];
  for (const s of suits) for (const v of values) deck.push({ suit: s, value: v });
  for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  return deck;
}
function cardValue(card) {
  if (['J','Q','K'].includes(card.value)) return 10;
  if (card.value === 'A') return 11;
  return parseInt(card.value);
}
function handScore(hand) {
  let score = hand.reduce((s, c) => s + cardValue(c), 0);
  let aces = hand.filter(c => c.value === 'A').length;
  while (score > 21 && aces > 0) { score -= 10; aces--; }
  return score;
}
function formatCard(card) { return card.value + card.suit; }
function formatHand(hand) { return hand.map(formatCard).join(' '); }

// ═══════════════════════════════════════════
// 🪓 HANGMAN / ADAM ASMACA SYSTEM
// ═══════════════════════════════════════════
const HANGMAN_WORDS = [
  {word:'ISTANBUL',hint:'Sehir'}, {word:'ANKARA',hint:'Baskent'}, {word:'IZMIR',hint:'Sehir'},
  {word:'ANTALYA',hint:'Sehir'}, {word:'BURSA',hint:'Sehir'}, {word:'KONYA',hint:'Sehir'},
  {word:'LAHMACUN',hint:'Yemek'}, {word:'DONER',hint:'Yemek'}, {word:'BAKLAVA',hint:'Tatli'},
  {word:'KOFTE',hint:'Yemek'}, {word:'PIDE',hint:'Yemek'}, {word:'BÖREK',hint:'Yemek'},
  {word:'GÜNEŞ',hint:'Dogal'}, {word:'AY',hint:'Dogal'}, {word:'YILDIZ',hint:'Dogal'},
  {word:'DENIZ',hint:'Dogal'}, {word:'DAG',hint:'Dogal'}, {word:'NEHİR',hint:'Dogal'},
  {word:'KEDİ',hint:'Hayvan'}, {word:'KÖPEK',hint:'Hayvan'}, {word:'KUŞ',hint:'Hayvan'},
  {word:'BALIK',hint:'Hayvan'}, {word:'TAVŞAN',hint:'Hayvan'}, {word:'AYRI',hint:'Hayvan'},
  {word:'FUTBOL',hint:'Spor'}, {word:'BASKETBOL',hint:'Spor'}, {word:'YÜZME',hint:'Spor'},
  {word:'KITAP',hint:'Egitim'}, {word:'OKUL',hint:'Egitim'}, {word:'KALEM',hint:'Egitim'},
  {word:'MÜZİK',hint:'Sanat'}, {word:'RESİM',hint:'Sanat'}, {word:'DANS',hint:'Sanat'},
  {word:'SEVGİ',hint:'Duygu'}, {word:'MUTLULUK',hint:'Duygu'}, {word:'HÜZÜN',hint:'Duygu'},
  {word:'BILGISAYAR',hint:'Teknoloji'}, {word:'TELEFON',hint:'Teknoloji'}, {word:'INTERNET',hint:'Teknoloji'},
  {word:'YAZI',hint:'Dil'}, {word:'HARF',hint:'Dil'}, {word:'CÜMLE',hint:'Dil'},
  {word:'ANNE',hint:'Aile'}, {word:'BABA',hint:'Aile'}, {word:'KARDES',hint:'Aile'},
  {word:'ARKADAS',hint:'Insan'}, {word:'KOMSU',hint:'Insan'}, {word:'OGRETMEN',hint:'Insan'}
];
const hangmanStages = ['💀','🤕','🤒','😵','🥴','😪','😴',' '];
let hangmanGame = null;
let hangmanInterval = null;

function startHangman() {
  const entry = HANGMAN_WORDS[Math.floor(Math.random() * HANGMAN_WORDS.length)];
  hangmanGame = {
    word: entry.word.toUpperCase(),
    hint: entry.hint,
    guessed: new Set(),
    wrongGuesses: 0,
    maxWrong: 7,
    active: true,
    startTime: Date.now()
  };
}
function getHangmanDisplay() {
  if (!hangmanGame || !hangmanGame.active) return null;
  const display = hangmanGame.word.split('').map(c => hangmanGame.guessed.has(c) ? c : '_').join(' ');
  const stage = hangmanStages[hangmanGame.maxWrong - hangmanGame.wrongGuesses] || ' ';
  return `${stage} ${display} (İpucu: ${hangmanGame.hint}) | Yanlış: ${hangmanGame.wrongGuesses}/${hangmanGame.maxWrong}`;
}

// ═══════════════════════════════════════════
// 🎰 EXTENDED GAMES STATE
// ═══════════════════════════════════════════
let numberGame = null;
let wordGame = null;
const wordGameWords = [
  'ELMA','ARMUT','MUZ','UZUM','KARPUZ','KAVUN','PORTAKAL','LIMON',
  'DAMLA','BEYAZ','KIRMIZI','MAVI','YESIL','SIYAH','SARI','MOR',
  'GÜNEŞ','YAGMUR','KAR','RÜZGAR','BULUT','SELEN','DAG','TEPE',
  'KITAP','KALEM','DEFTER','SILGI','CANTA','MASA','OTURAK','PENCERE'
];

// ═══════════════════════════════════════════
// 🔒 ADMIN SYSTEM STATE
// ═══════════════════════════════════════════
const frozenUsers = {};
const jailedUsers = {};
let jailPosition = null;

// ═══════════════════════════════════════════
// 🔤 FONT STYLE SYSTEM
// ═══════════════════════════════════════════
const FONT_MAPS = [
  (() => {
    const from = 'ABCDEFGHIJKLMNOPQRSTUVWXYZÇĞİÖŞÜabcdefghijklmnopqrstuvwxyzçğıöşü';
    const to = '𝔄𝔅ℭ𝔇𝔈𝔉𝔊ℌℑ𝔍𝔎𝔏𝔐𝔑𝔒𝔓𝔔ℜ𝔖𝔗𝔘𝔙𝔚𝔛𝔜ℨÇĞİÖŞÜ𝔞𝔟𝔠𝔡𝔢𝔣𝔤𝔥𝔦𝔧𝔨𝔩𝔪𝔫𝔬𝔭𝔮𝔯𝔰𝔱𝔲𝔳𝔴𝔵𝔶𝔷çğıöşü';
    const map = {}; for (let i = 0; i < from.length; i++) map[from[i]] = to[i]; return map;
  })(),
  (() => {
    const from = 'ABCDEFGHIJKLMNOPQRSTUVWXYZÇĞİÖŞÜabcdefghijklmnopqrstuvwxyzçğıöşü';
    const to = '𝓐𝓑𝓒𝓓𝓔𝓕𝓖𝓗𝓘𝓙𝓚𝓛𝓜𝓝𝓞𝓟𝓠𝓡𝓢𝓣𝓤𝓥𝓦𝓧𝓨𝓩ÇĞİÖŞÜ𝓪𝓫𝓬𝓭𝓮𝓯𝓰𝓱𝓲𝓳𝓴𝓵𝓶𝓷𝓸𝓹𝓺𝓻𝓼𝓽𝓾𝓿𝔀𝔁𝔂𝔃çğıöşü';
    const map = {}; for (let i = 0; i < from.length; i++) map[from[i]] = to[i]; return map;
  })(),
  (() => {
    const from = 'ABCDEFGHIJKLMNOPQRSTUVWXYZÇĞİÖŞÜabcdefghijklmnopqrstuvwxyzçğıöşü';
    const to = '𝐴𝐵𝐶𝐷𝐸𝐹𝐺𝐻𝐼𝐽𝐾𝐿𝑀𝑁𝑂𝑃𝑄𝑅𝑆𝑇𝑈𝑉𝑊𝑋𝑌𝑍ÇĞİÖŞÜ𝑎𝑏𝑐𝑑𝑒𝑓𝑔ℎ𝑖𝑗𝑘𝑙𝑚𝑛𝑜𝑝𝑞𝑟𝑠𝑡𝑢𝑣𝑤𝑥𝑦𝑧çğıöşü';
    const map = {}; for (let i = 0; i < from.length; i++) map[from[i]] = to[i]; return map;
  })()
];
function applyFont(text) {
  const font = FONT_MAPS[Math.floor(Math.random() * FONT_MAPS.length)];
  return text.split('').map(c => font[c] || c).join('');
}

const app = express();
app.use(express.json());
app.listen(PORT, () => console.log(`[Server] http://localhost:${PORT}`));

const client = new Highrise({
  events: ['ready', 'messages', 'playerJoin', 'playerLeave', 'trackPlayerMovement']
}, 5);

function isAdmin(userIdOrName) { return ADMINS.includes(userIdOrName); }
function isAllowed(username) { return ADMINS.includes(username) || isVIP(username); }

async function getRoomUsersFormatted() {
  try {
    const raw = await client.room.players.fetch();
    if (!raw) return [];
    return raw.map(([user, position]) => ({
      id: user.id,
      username: user.username,
      position: position
    }));
  } catch(e) {
    try {
      const raw = client.room.players.cache.get();
      if (!raw) return [];
      return raw.map(([user, position]) => ({
        id: user.id,
        username: user.username,
        position: position
      }));
    } catch(e2) {
      return [];
    }
  }
}

function isVIP(username) {
  const u = botData[username];
  return u && u.vip === true;
}

function getCredits(username) {
  const u = botData[username];
  return u ? (u.credits || 0) : 0;
}

function addCredits(username, amount) {
  if (!botData[username]) botData[username] = { credits: 0, vip: false };
  botData[username].credits = (botData[username].credits || 0) + amount;
  saveData(botData);
}

function removeCredits(username, amount) {
  if (!botData[username]) botData[username] = { credits: 0, vip: false };
  botData[username].credits = Math.max(0, (botData[username].credits || 0) - amount);
  saveData(botData);
}

function getSicil(username) {
  if (sicil[username] === undefined) sicil[username] = 100;
  return sicil[username];
}

function addSicil(username, amount) {
  if (sicil[username] === undefined) sicil[username] = 100;
  sicil[username] = Math.max(0, Math.min(100, sicil[username] + amount));
  saveSicil(sicil);
}

function checkCooldown(userId) {
  const now = Date.now();
  if (cooldowns[userId] && now - cooldowns[userId] < 2000) return false;
  cooldowns[userId] = now;
  return true;
}

function generateSilencePCM(durationMs) {
  const sampleRate = 44100;
  const channels = 2;
  const bytesPerSample = 2;
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  return Buffer.alloc(numSamples * channels * bytesPerSample, 0);
}

function startEncoder() {
  if (!ICECAST_URL) {
    console.log('[Encoder] ICECAST_URL ayarlanmamis, encoder baslatilmiyor');
    return;
  }
  if (encoder && !encoder.killed) return;
  if (encoderRetryCount >= ENCODER_MAX_RETRIES) {
    console.log('[Encoder] Maksimum deneme sayisina ulasildi, encoder durduruldu.');
    return;
  }
  encoderRetryCount++;
  console.log(`[Encoder] Icecast'a baglaniyor... (Deneme ${encoderRetryCount}/${ENCODER_MAX_RETRIES})`);
  encoder = spawn(FFMPEG_PATH, [
    '-thread_queue_size', '2048',
    '-f', 's16le', '-ar', '44100', '-ac', '2',
    '-i', 'pipe:0',
    '-c:a', 'libmp3lame', '-b:a', '96k', '-threads', '1',
    '-content_type', 'audio/mpeg', '-f', 'mp3',
    '-flush_packets', '1',
    '-max_muxing_queue_size', '2048',
    ICECAST_URL
  ], { stdio: ['pipe', 'ignore', 'pipe'] });

  let connected = false;

  encoder.on('close', (code) => {
    const wasPlaying = currentSong && !!(currentDecoder && !currentDecoder.killed);
    encoder = null;
    connected = false;
    stopSilenceInterval();
    if (wasPlaying) {
      const songToRestart = { ...currentSong };
      stopDecoder();
      console.log(`[Encoder] Baglanti koptu (kod: ${code}). 3s sonra sarki yeniden baslatilacak.`);
      setTimeout(() => {
        startEncoder();
        setTimeout(() => playSong(songToRestart), 4000);
      }, 2000);
    } else {
      console.log(`[Encoder] Kapandi (kod: ${code}), 3s sonra tekrar baslatiliyor...`);
      setTimeout(startEncoder, 3000);
    }
  });
  encoder.on('error', (err) => {
    console.error('[Encoder] Hata:', err.message);
    encoder = null;
    connected = false;
    stopSilenceInterval();
    setTimeout(startEncoder, 3000);
  });
  encoder.stdin.on('error', (err) => {
    if (err.code !== 'EPIPE') console.error('[Encoder stdin] Hata:', err.message);
    encoder = null;
    connected = false;
    stopSilenceInterval();
    setTimeout(startEncoder, 3000);
  });
  encoder.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (line.includes('connected') || line.includes('Metadata')) {
      if (!connected) {
        connected = true;
        encoderRetryCount = 0;
        console.log('[Encoder] Icecast baglandi!');
      }
    }
    if (line.includes('error') || line.includes('Error') || line.includes('Invalid') || line.includes('denied') || line.includes('401')) {
      console.error('[Encoder stderr]', line.substring(0, 300));
    }
  });

  setTimeout(() => {
    if (encoder && !encoder.killed) {
      startSilenceInterval();
      console.log('[Encoder] Sessizlik besleniyor...');
    }
  }, 3000);
}

const silenceChunk = generateSilencePCM(100);
function feedSilence() {
  if (!encoder || encoder.killed) {
    if (!encoder) startEncoder();
    return;
  }
  try { encoder.stdin.write(silenceChunk); } catch(e) {
    console.error('[Encoder] Sessizlik gonderilemedi, yeniden baslatiliyor...');
    encoder = null;
    stopSilenceInterval();
    setTimeout(startEncoder, 2000);
  }
}
function startSilenceInterval() {
  stopSilenceInterval();
  feedSilence();
  silenceInterval = setInterval(() => { if (!isPlaying) feedSilence(); }, 100);
}
function stopSilenceInterval() {
  if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null; }
}
function stopDecoder() {
  pipelineGeneration++;
  if (currentDecoder && !currentDecoder.killed) {
    try { currentDecoder.kill('SIGTERM'); } catch(e) {}
  }
  currentDecoder = null;
  feedSilence();
}

function playSong(song) {
  stopDecoder();
  const myGeneration = pipelineGeneration;
  currentSong = { ...song, startTime: Date.now() };
  isPlaying = true;
  voteskipState = { active: false, voters: [], required: 0, songTitle: '' };
  console.log(`[Decoder] Baslatiliyor: ${song.title}`);
  const vol = volume / 100;
  const songStartTime = Date.now();

  const decoderProc = spawn(FFMPEG_PATH, [
    '-re',
    '-reconnect', '1', '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5', '-rw_timeout', '10000000',
    '-multiple_requests', '1',
    '-thread_queue_size', '2048',
    '-probesize', '32768',
    '-analyzeduration', '5000000',
    '-i', song.audio_url,
    '-af', `volume=${vol}`,
    '-vn',
    '-f', 's16le', '-ar', '44100', '-ac', '2',
    '-fflags', '+discardcorrupt+flush_packets',
    'pipe:1'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  currentDecoder = decoderProc;

  let dataSent = 0;
  let firstChunk = true;

  decoderProc.stdout.on('data', (chunk) => {
    if (myGeneration !== pipelineGeneration) return;
    dataSent += chunk.length;
    if (firstChunk) {
      firstChunk = false;
      console.log(`[Decoder] Ilk veri geldi: ${chunk.length} byte`);
    }
    if (encoder && !encoder.killed) {
      try { encoder.stdin.write(chunk); } catch(e) {}
    }
  });

  // stderr'i drain et - buffer dolmasin
  decoderProc.stderr.on('data', (data) => {
    if (myGeneration !== pipelineGeneration) return;
    const line = data.toString();
    if (line.includes('error') || line.includes('Error') || line.includes('Invalid') || line.includes('fail')) {
      console.error('[Decoder stderr]', line.trim().substring(0, 200));
    }
  });

  decoderProc.on('close', (code) => {
    if (myGeneration !== pipelineGeneration) return;
    const songDuration = ((Date.now() - songStartTime) / 1000).toFixed(1);
    console.log(`[Decoder] Kapandi: code=${code}, sure: ${songDuration}s, gonderilen: ${(dataSent / 1024 / 1024).toFixed(1)}MB`);
    currentDecoder = null;
    currentSong = null;
    isPlaying = false;
    if (loopMode && code === 0) {
      setTimeout(() => playSong(song), 500);
    } else if (queue.length > 0) {
      const next = queue.shift();
      setTimeout(() => playSong(next), 500);
    } else {
      startSilenceInterval();
      sendChat(purple('🎵 Şarkı bitti. Yeni şarkı eklemek için: ') + gold('-p <şarkı adı>'));
    }
  });

  decoderProc.on('error', (err) => {
    if (myGeneration !== pipelineGeneration) return;
    console.error('[Decoder] Process hatasi:', err.message);
    currentDecoder = null;
    currentSong = null;
    isPlaying = false;
    if (queue.length > 0) {
      const next = queue.shift();
      setTimeout(() => playSong(next), 1000);
    } else {
      startSilenceInterval();
    }
  });
}

function insertToQueue(songData, username) {
  const senderIsVIP = isVIP(username);
  const ownerUsername = ADMINS[0];

  if (username === ownerUsername) {
    queue.unshift(songData);
    return 1;
  }

  if (senderIsVIP) {
    let insertIndex = 0;
    for (let i = 0; i < queue.length; i++) {
      if (isVIP(queue[i].user)) {
        insertIndex = i + 1;
      } else {
        break;
      }
    }
    queue.splice(insertIndex, 0, songData);
    return insertIndex + 1;
  }

  queue.push(songData);
  return queue.length;
}

let lastCommandUserId = null;

async function findUserId(username) {
  try {
    const raw = await client.room.players.fetch();
    const found = raw.find(([u]) => u.username.toLowerCase() === username.toLowerCase());
    return found ? found[0].id : null;
  } catch(e) { return null; }
}

async function resolveBlackjack(userId, username) {
  const game = blackjackGames[userId];
  if (!game) return;
  while (handScore(game.dealerHand) < 17) { game.dealerHand.push(game.deck.pop()); }
  const pScore = handScore(game.playerHand);
  const dScore = handScore(game.dealerHand);
  const u = getUserGameData(username);
  delete blackjackGames[userId];
  let result;
  if (dScore > 21 || pScore > dScore) {
    const winnings = game.bet * 2;
    u.wallet = (u.wallet || 0) + winnings;
    result = `🏆 @${username} KAZANDI! Sen: ${pScore} | Dealer: ${dScore} | +${winnings} Puan`;
  } else if (pScore === dScore) {
    u.wallet = (u.wallet || 0) + game.bet;
    result = `🤝 BERABERE! Sen: ${pScore} | Dealer: ${dScore} | Bahsin iade edildi`;
  } else {
    result = `💸 @${username} KAYBETTİ! Sen: ${pScore} | Dealer: ${dScore} | -${game.bet} Puan`;
  }
  saveGameData(gameData);
  await sendChat(neonFormat(`🃏 ${result}`));
}

async function sendChat(text) {
  try {
    console.log(`[SendChat] Gönderiliyor (${text.length} karakter): ${text.substring(0, 80)}...`);
    await client.message.send(text);
    console.log(`[SendChat] ✓ Gönderildi`);
  } catch(e) { console.error('[SendChat] ✗ Hata:', e.message, 'Metin:', text.substring(0, 50)); }
}
async function sendWhisper(userId, text) {
  try {
    console.log(`[SendWhisper] → ${userId} (${text.length} karakter)`);
    await client.whisper.send(userId, text);
    console.log(`[SendWhisper] ✓ Gönderildi`);
  } catch(e) {
    console.error('[SendWhisper] ✗ Hata:', e.message);
    try { await client.message.send(text); } catch(e2) { console.error('[SendWhisper->SendChat] ✗ Hata:', e2.message); }
  }
}

const BANNED_WORDS = ['amk', 'aq', 'orospu', 'pic', 'piç', 'amq', 'sg', 'sik', 'yarrak', 'mal', 'gerizekali', 'salak', 'aptal'];

function checkBannedWords(text) {
  const lower = text.toLowerCase();
  return BANNED_WORDS.some(w => lower.includes(w));
}

async function getAIResponse(question) {
  const apiKey = process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    return 'AI servisi şu an aktif değil. -p ile müzik çalabilirsiniz!';
  }

  try {
    const personality = AI_PERSONALITIES[aiMode]?.prompt || 'Sen yardimsever bir asistansin.';
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: personality + ' Turkce konus. Kisa ve eglenceli cevaplar ver. Maksimum 2 cumle ile yanit ver.' },
          { role: 'user', content: question }
        ],
        max_tokens: 100,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      console.log(`[AI] API hatası: ${response.status}`);
      return 'AI\'da kısa bir sorun var, tekrar deneyin! 🎵';
    }

    const data = await response.json();
    return data.choices[0].message.content.trim();
  } catch (error) {
    console.log(`[AI] Hata: ${error.message}`);
    return 'AI bağlantı hatası! Müzik için -p kullanın. 🎶';
  }
}

client.on('ready', (session) => {
  console.log(`[Bot] Baglandi! Odasi: ${session.room_info?.room_name}`);
  startEncoder();
  const saved = getSavedBotPosition();
  if (saved && saved.x !== undefined) {
    setTimeout(() => {
      client.move.walk(saved.x, saved.y, saved.z);
      console.log(`[Bot] Kaydedilen pozisyona ışınlandı: (${saved.x.toFixed(1)}, ${saved.y.toFixed(1)}, ${saved.z.toFixed(1)})`);
    }, 3000);
  }
});

client.on('trackPlayerMovement', async (user, position) => {
  try {
    const username = user.username;
    const BOT_ID = '6a4bb4dffce970fd78a729fe';
    if (user.id === BOT_ID) {
      saveBotPosition(position.x, position.y, position.z);
    }
    if (frozenUsers[user.id]) {
      const stats = getUserGameData(username).stats;
      if (stats.last_position) {
        try { await client.user.setPosition(user.id, stats.last_position.x, stats.last_position.y, stats.last_position.z, 'FrontRight'); } catch(e) {}
      }
      return;
    }
    if (jailedUsers[user.id] && jailPosition) {
      try { await client.user.setPosition(user.id, jailPosition.x, jailPosition.y, jailPosition.z, 'FrontRight'); } catch(e) {}
      return;
    }
    const u = getUserGameData(username);
    const now = Date.now();
    const stats = u.stats;

    if (stats.last_position && (now - stats.last_move_time) < 1000) return;

    const oldPos = stats.last_position;
    if (oldPos) {
      const dx = position.x - oldPos.x;
      const dy = position.y - oldPos.y;
      const dz = position.z - oldPos.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance > 0.5) {
        stats.walk_score += Math.floor(distance);
      }
    }

    stats.last_position = { x: position.x, y: position.y, z: position.z };
    stats.last_move_time = now;
    saveGameData(gameData);
  } catch(e) {}
});

client.on('error', (error) => console.error('[Bot] Hata:', error));

client.on('close', (event) => {
  console.log(`[Bot] Bağlantı koptu (code: ${event.code}), yeniden bağlanılıyor...`);
  setTimeout(() => {
    client.reconnect(HIGHRISE_TOKEN, ROOM_ID);
  }, 3000);
});

client.on('chatMessageCreate', async (user, message) => {
  const msg = message.trim();
  const userId = user.id;
  const username = user.username;

  if (userId !== '6a4bb4dffce970fd78a729fe') {
    const u = getUserGameData(username);
    u.stats.message_count = (u.stats.message_count || 0) + 1;
    saveGameData(gameData);
  }

  if (!msg.startsWith('!') && !msg.startsWith('-') && !msg.startsWith('.')) {
    if (checkBannedWords(msg)) {
      addSicil(username, -10);
      const puan = getSicil(username);
      await sendChat(`⚠️ @${username} küfür/hakaret nedeniyle -10 sicil puanı! (Mevcut: ${puan})`);
      if (puan <= 0) {
        await sendChat(`🚫 @${username} sicil puanı 0'a düştü, odadan atılıyor!`);
        try { await client.moderation.kick(userId, 'Otomatik: Sicil puanı sıfırlandı'); } catch(e) {}
      }
    }
    return;
  }

  if (!checkCooldown(userId)) return;
  lastCommandUserId = userId;

  const args = msg.slice(1).split(' ');
  const cmd = args[0].toLowerCase();
  const params = args.slice(1);

  if (cmd === 'help' || cmd === 'h' || cmd === 'yardım') {
    await sendChat(neonFormat(cyan('🎵 MÜZİK: ') + gold('-p <şarkı>') + white(' | ') + gold('-s') + white(' | ') + gold('-stop') + white(' | ') + gold('-q') + white(' | ') + gold('-np') + white(' | ') + gold('-v <ses>') + white(' | ') + gold('-loop') + white(' | ') + gold('-voteskip')));
    await sendChat(neonFormat(cyan('🎭 DANS: ') + gold('-dans <isim>') + white(' | ') + gold('-dansliste') + white(' | ') + gold('-dur') + white(' | ') + gold('-duo <emote> @user') + white(' | ') + gold('-botdans')));
    await sendChat(neonFormat(cyan('🎰 OYUN: ') + gold('-slot <miktar>') + white(' | ') + gold('-bj <miktar>') + white(' | ') + gold('-bahis <miktar>') + white(' | ') + gold('-cark') + white(' | ') + gold('-sayi') + white(' | ') + gold('-kelime') + white(' | ') + gold('-adam')));
    await sendChat(neonFormat(cyan('⚔️ SAVAŞ: ') + gold('-sava @user') + white(' | ') + gold('-savun') + white(' | ') + gold('-ulti') + white(' | ') + gold('-bomba @user') + white(' | ') + gold('-soygun @user')));
    await sendChat(neonFormat(cyan('🤖 AI: ') + gold('-sor <soru>') + white(' | ') + gold('-aimod') + white(' | ') + gold('-font <metin>')));
    await sendChat(neonFormat(cyan('📊 PROFİL: ') + gold('-profil') + white(' | ') + gold('-seviye') + white(' | ') + gold('-rep @user') + white(' | ') + gold('-unvanlar') + white(' | ') + gold('-rozetler') + white(' | ') + gold('-sansum')));
    await sendChat(neonFormat(cyan('💕 SOSYAL: ') + gold('-evlen @user') + white(' | ') + gold('-bosan') + white(' | ') + gold('-afk') + white(' | ') + gold('-burc') + white(' | ') + gold('-fal') + white(' | ') + gold('-sevgi @user')));
    await sendChat(neonFormat(cyan('💎 MADEN: ') + gold('-maden') + white(' | ') + gold('-balik') + white(' | ') + gold('-hepsinisat') + white(' | ') + gold('-bakiye')));
    await sendChat(neonFormat(cyan('👗 KIYAFET: ') + gold('-rastgele') + white(' | ') + gold('-kaparastgele') + white(' | ') + gold('-kaydet') + white(' | ') + gold('-liste') + white(' | ') + gold('-giy <isim>') + white(' | ') + gold('-sil <isim>') + white(' | ') + gold('-silliste') + white(' | ') + gold('-çıkar <ürün>')));
    await sendChat(neonFormat(cyan('📌 KOMUTLAR: ') + gold('!ly1-!ly8') + white(' | ') + gold('!telemenu') + white(' | ') + gold('!top') + white(' | ') + gold('!gorevler') + white(' | ') + gold('!yardım')));
    return;
  }

  if (cmd === 'createtele') {
    if (!isAdmin(username)) { await sendChat('Yetkiniz yok!'); return; }
    if (!params[0]) { await sendChat('Kullanim: !createtele <isim>'); return; }
    const name = params[0].toLowerCase();
    try {
      const raw = await client.room.players.fetch();
      const me = raw.find(([u]) => u.id === '6a4bb4dffce970fd78a729fe');
      if (me) {
        const [, pos] = me;
        addTeleport(name, pos.x, pos.y, pos.z, pos.facing || 'FrontRight');
        await sendChat('Teleport kaydedildi: ' + name + ' -> (' + pos.x.toFixed(1) + ', ' + pos.y.toFixed(1) + ', ' + pos.z.toFixed(1) + ')');
      } else {
        await sendChat('Bot pozisyonu bulunamadi!');
      }
    } catch(e) {
      await sendChat('Hata: ' + e.message);
    }
    return;
  }

  if (cmd === 'deletetele') {
    if (!isAdmin(username)) { await sendChat('Yetkiniz yok!'); return; }
    if (!params[0]) { await sendChat('Kullanim: !deletetele <isim>'); return; }
    const name = params[0].toLowerCase();
    if (removeTeleport(name)) {
      await sendChat('Teleport silindi: ' + name);
    } else {
      await sendChat(name + ' bulunamadi!');
    }
    return;
  }

  if (cmd === 'telemenu' || cmd === 'telmenu') {
    const tps = getTeleports();
    const names = Object.keys(tps);
    if (names.length === 0) {
      await sendChat('Kayitli teleport noktasi yok.');
      return;
    }
    await sendChat('TELEPORT NOKTALARI:');
    for (const name of names) {
      const t = tps[name];
      await sendChat('  ' + name + ' -> (' + t.x.toFixed(1) + ', ' + t.y.toFixed(1) + ', ' + t.z.toFixed(1) + ')');
    }
    await sendChat('Kullanim: !tele <isim> | !tele @kullanici <isim>');
    return;
  }

  if (cmd === 'tele') {
    if (!params[0]) { await sendChat('Kullanim: !tele <isim> veya !tele @kullanici <isim>'); return; }
    let targetUserId = userId;
    let targetUsername = username;
    let teleName = params[0];
    if (params[0].startsWith('@') && params[1]) {
      const mentioned = params[0].replace('@', '');
      const roomUsers = await getRoomUsersFormatted();
      const found = roomUsers.find(u => u.username.toLowerCase() === mentioned.toLowerCase());
      if (!found) { await sendChat(mentioned + ' bulunamadi!'); return; }
      targetUserId = found.id;
      targetUsername = found.username;
      teleName = params[1];
    }
    const tp = getTeleport(teleName);
    if (!tp) { await sendChat(teleName + ' teleport noktasi bulunamadi!'); return; }
    try {
      await client.player.teleport(targetUserId, tp.x, tp.y, tp.z, tp.facing || 'FrontRight');
      await sendChat(targetUsername + ' isinlandi -> ' + teleName);
    } catch(e) {
      await sendChat('Teleport hatasi: ' + e.message);
    }
    return;
  }

  if (cmd === 'daily' || cmd === 'günlük') {
    const now = Date.now();
    if (dailyCooldowns[username] && now - dailyCooldowns[username] < 86400000) {
      const kalan = Math.ceil((86400000 - (now - dailyCooldowns[username])) / 3600000);
      await sendWhisper(userId, `⏰ Günlük kredini zaten aldın! ${kalan} saat kaldı.`);
      return;
    }
    dailyCooldowns[username] = now;
    addCredits(username, 100);
    await sendChat(`🎁 @${username} günlük 100 kredi aldı! (Toplam: ${getCredits(username)})`);
    return;
  }

  if (cmd === 'welcome' || cmd === 'hoşgeldin') {
    if (welcomeGiven[username]) {
      await sendWhisper(userId, '🎉 Hoşgeldin kredini zaten aldın!');
      return;
    }
    welcomeGiven[username] = true;
    addCredits(username, 100);
    await sendChat(`🎉 @${username} hoşgeldin! 100 kredi hediye! (Toplam: ${getCredits(username)})`);
    return;
  }

  if (cmd === 'bakiye' || cmd === 'kredi') {
    const credits = getCredits(username);
    const vip = isVIP(username) ? '👑 VIP' : '👤 Normal';
    await sendWhisper(userId, `${vip} | Kredi: ${credits} | Sicil: ${getSicil(username)}`);
    return;
  }

  if (cmd === 'bahsis' || cmd === 'bahşiş') {
    const miktar = parseInt(params[0]);
    if (!miktar || miktar < 1) {
      await sendWhisper(userId, 'Kullanım: -bahsis <miktar>');
      return;
    }
    const bakiye = getCredits(username);
    if (bakiye < miktar) {
      await sendWhisper(userId, `Yetersiz kredi! Bakiyen: ${bakiye}`);
      return;
    }
    removeCredits(username, miktar);
    const senderStats = getUserGameData(username).stats;
    senderStats.tip_given = (senderStats.tip_given || 0) + miktar;
    saveGameData(gameData);

    if (!firstTippers[username]) {
      firstTippers[username] = true;
      addCredits(username, 50);
      await sendChat(`💰 @${username} ilk bahşişini verdi! +50 kredi bonusu! (Toplam: ${getCredits(username)})`);
    } else {
      await sendChat(`💰 @${username} ${miktar} kredi bahşiş verdi!`);
    }

    if (miktar >= 500 && !isVIP(username)) {
      if (!botData[username]) botData[username] = { credits: 0, vip: false };
      botData[username].vip = true;
      saveData(botData);
      await sendChat(`👑 @${username} 500 gold bahşiş verdi ve VIP oldu! Artık sınırsız müzik çalabilir!`);
    }
    return;
  }

  if (cmd === 'vip') {
    if (isVIP(username)) {
      await sendWhisper(userId, '👑 VIP üyesisin! Sınırsız müzik çalabilirsin.');
    } else {
      const credits = getCredits(username);
      await sendWhisper(userId, `👤 Normal kullanıcı | Kredi: ${credits} | VIP olmak için 500 gold bahşiş ver.`);
    }
    return;
  }

  if (cmd === 'play' || cmd === 'p') {
    const query = params.join(' ');
    if (!query) {
      await sendWhisper(userId, 'Şarkı adı gerekli! Ornegin: -p despacito');
      return;
    }

    const sicilPuan = getSicil(username);
    if (sicilPuan <= 20) {
      await sendWhisper(userId, `⛔ Sicil puanın çok düşük (${sicilPuan})! Müzik açamazsın.`);
      return;
    }

    const isRoomOwner = isAdmin(username);
    const userVIP = isVIP(username);

    if (!isRoomOwner && !userVIP) {
      const hasInQueue = queue.some(s => s.user === username);
      const isCurrentlyPlaying = currentSong && currentSong.user === username;
      if (hasInQueue || isCurrentlyPlaying) {
        await sendWhisper(userId, '⛔ Zaten sırada bir şarkın var! Şarkı bitene kadar beklemen gerek.');
        return;
      }
    }

    if (!userVIP) {
      if (getCredits(username) < 1) {
        await sendWhisper(userId, '⛔ Yetersiz kredi! -daily ile günlük kredini al veya -bahsis ile kredi kazan.');
        return;
      }
      removeCredits(username, 1);
    }

    await sendChat(cyan('🔍 Aranıyor: ') + gold(query) + '...');
    const songs = await searchYouTube(query);
    if (songs.length === 0) {
      await sendChat(`'${query}' için sonuç bulunamadi.`);
      if (!userVIP) addCredits(username, 1);
      return;
    }

    const song = songs[Math.floor(Math.random() * songs.length)];

    const MAX_DURATION = 600;
    if (song.duration > MAX_DURATION && !isAdmin(username) && !isVIP(username)) {
      const dakika = Math.floor(song.duration / 60);
      await sendChat(`🚫 "${song.title}" çok uzun! (${dakika} dk) Maksimum süre 10 dakika.`);
      if (!userVIP) addCredits(username, 1);
      return;
    }

    if (isBlacklisted(song.title)) {
      await sendChat(`🚫 "${song.title}" kara listede! Bu şarkı çalınamaz.`);
      if (!userVIP) addCredits(username, 1);
      return;
    }

    const audioURL = await getAudioURL(song.id);
    if (!audioURL) {
      await sendChat(`'${song.title}' alinamadi.`);
      if (!userVIP) addCredits(username, 1);
      return;
    }

    const songData = { audio_url: audioURL, title: song.title, user: username };
    const musicStats = getUserGameData(username).stats;
    musicStats.music_count = (musicStats.music_count || 0) + 1;
    saveGameData(gameData);

    if (isPlaying) {
      const pos = insertToQueue(songData, username);
      const tag = isRoomOwner ? orange(' 👑Owner') : userVIP ? pink(' ⭐VIP') : '';
      await sendChat(pink('➕ SIRA #') + white(String(pos)) + pink(' → ') + gold(song.title) + green(` (@${username})`) + tag + cyan(' | -up ile öne al'));
    } else {
      currentSong = { ...songData, startTime: Date.now() };
      playSong(songData);
      const tag = isRoomOwner ? orange(' 👑Owner') : userVIP ? pink(' ⭐VIP') : '';
      await sendChat(rainbow('🎵 ÇALINIYOR → ') + gold(song.title) + green(` (@${username})`) + tag);
      try {
        const raw = await client.room.players.fetch();
        if (raw) {
          for (const [u] of raw) {
            if (u.id !== '6a4bb4dffce970fd78a729fe' && u.id !== userId) {
              sendWhisper(u.id, '🎵 Müzik başladı! Ses gelmiyorsa odadan çıkıp tekrar girin.');
            }
          }
        }
      } catch(e) {}
    }
    return;
  }

  if (cmd === 'up' || cmd === 'boost') {
    const isRoomOwner = isAdmin(username);
    const userVIP = isVIP(username);

    if (queue.length === 0) {
      await sendWhisper(userId, 'Sırada şarkı yok!');
      return;
    }
    let found = -1;
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].user === username) { found = i; break; }
    }
    if (found === -1) {
      await sendWhisper(userId, 'Sırada senin şarkın yok!');
      return;
    }

    if (!isRoomOwner && !userVIP) {
      const boostCost = 5;
      if (getCredits(username) < boostCost) {
        await sendWhisper(userId, `⛔ Boost için ${boostCost} kredi gerekli! Bakiyen: ${getCredits(username)}`);
        return;
      }
      removeCredits(username, boostCost);
    }

    const song = queue.splice(found, 1)[0];
    let insertIndex = 0;
    for (let i = 0; i < queue.length; i++) {
      if (isVIP(queue[i].user) || isAdmin(queue[i].user)) insertIndex = i + 1;
      else break;
    }
    queue.splice(insertIndex, 0, song);
    const costText = (!isRoomOwner && !userVIP) ? ' (-5 kredi)' : '';
    await sendChat(`⬆️ @${username} şarkısı öne alındı!${costText} (#${insertIndex + 1})`);
    return;
  }

  if (cmd === 'skip' || cmd === 's') {
    stopDecoder();
    if (queue.length > 0) {
      const next = queue.shift();
      setTimeout(() => playSong(next), 500);
      await sendChat(purple('⏭️ ATLANDI → ') + gold(next.title));
    } else {
      startSilenceInterval();
      await sendChat(red('⏭️ Sıra bitti.'));
    }
    return;
  }

  if (cmd === 'dur') {
    await sendWhisper(userId, 'Aktif dans döngüsü yok.');
    return;
  }

  if (cmd === 'queue' || cmd === 'q') {
    if (queue.length === 0 && !currentSong) {
      await sendChat(red('Sırada şarkı yok.'));
      return;
    }
    const ownerName = ADMINS[0];
    if (currentSong) {
      const isCurOwner = currentSong.user === ownerName;
      const isCurVip = isVIP(currentSong.user) && !isCurOwner;
      const tag = isCurOwner ? orange(' 👑Owner') : isCurVip ? pink(' ⭐VIP') : '';
      await sendChat(cyan('🎵 ŞİMDİ ÇALINIYOR: ') + gold(currentSong.title) + green(` (@${currentSong.user})`) + tag);
    }
    if (queue.length > 0) {
      await sendChat(purple(`🎶 SIRA (${queue.length} şarkı):`));
      for (let i = 0; i < Math.min(queue.length, 10); i++) {
        const s = queue[i];
        const isOwner = s.user === ownerName;
        const isVip = isVIP(s.user) && !isOwner;
        const tag = isOwner ? orange(' 👑') : isVip ? pink(' ⭐') : '';
        await sendChat(white(`  ${i+1}. `) + gold(s.title) + green(` (${s.user})`) + tag);
      }
      if (queue.length > 10) {
        await sendChat(purple(`  ... ve ${queue.length - 10} şarkı daha`));
      }
    } else {
      await sendChat(cyan('Sırada başka şarkı yok.'));
    }
    return;
  }

  if (cmd === 'nowplaying' || cmd === 'np') {
    if (currentSong) {
      const ownerName = ADMINS[0];
      const isOwner = currentSong.user === ownerName;
      const isVip = isVIP(currentSong.user) && !isOwner;
      const tag = isOwner ? orange(' 👑Owner') : isVip ? pink(' ⭐VIP') : '';
      await sendChat(cyan('🎵 ŞİMDİ ÇALINIYOR: ') + gold(currentSong.title) + green(` (@${currentSong.user})`) + tag);
    } else {
      await sendChat(red('Şu an hiçbir şarkı çalmıyor.'));
    }
    return;
  }

  // ═══════════════════════════════════════════
  // 🎵 MÜZİK PREMIUM ÖZELLİKLERİ
  // ═══════════════════════════════════════════

  if (cmd === 'fav' || cmd === 'favori') {
    const u = getUserGameData(username);
    if (!u.favorites) u.favorites = [];
    if (cmd === 'fav' && params[0] === 'ekle') {
      if (!currentSong) { await sendWhisper(userId, 'Şu an şarkı çalmıyor!'); return; }
      if (u.favorites.length >= 10) { await sendWhisper(userId, 'Maksimum 10 favori şarkı kaydedebilirsin!'); return; }
      if (u.favorites.find(f => f.title === currentSong.title)) { await sendWhisper(userId, 'Bu şarkı zaten favorilerinde!'); return; }
      u.favorites.push({ title: currentSong.title, url: currentSong.audio_url });
      saveGameData(gameData);
      await sendWhisper(userId, `⭐ "${currentSong.title}" favorilere eklendi!`);
      return;
    }
    if (cmd === 'fav' && params[0] === 'sil') {
      const idx = parseInt(params[1]) - 1;
      if (idx < 0 || idx >= u.favorites.length) { await sendWhisper(userId, 'Geçersiz numara!'); return; }
      const removed = u.favorites.splice(idx, 1)[0];
      saveGameData(gameData);
      await sendWhisper(userId, `🗑️ "${removed.title}" favorilerden silindi!`);
      return;
    }
    if (cmd === 'fav' && params[0] === 'oynat') {
      const idx = parseInt(params[1]) - 1;
      if (idx < 0 || idx >= u.favorites.length) { await sendWhisper(userId, 'Geçersiz numara!'); return; }
      const fav = u.favorites[idx];
      const songData = { audio_url: fav.url, title: fav.title, user: username };
      if (!isVIP(username) && !isAdmin(username)) {
        const hasInQueue = queue.some(s => s.user === username);
        const isCurrentlyPlaying = currentSong && currentSong.user === username;
        if (hasInQueue || isCurrentlyPlaying) {
          await sendWhisper(userId, '⛔ Zaten sırada bir şarkın var!');
          return;
        }
        if (getCredits(username) < 1) { await sendWhisper(userId, '⛔ Yetersiz kredi!'); return; }
        removeCredits(username, 1);
      }
      if (isPlaying) {
        const pos = insertToQueue(songData, username);
        await sendChat(`⭐ '${fav.title}' siraya eklendi! (#${pos})`);
      } else {
        currentSong = { ...songData, startTime: Date.now() };
        playSong(songData);
        await sendChat(`⭐ Şu an çalınıyor: ${fav.title}`);
      }
      return;
    }
    if (u.favorites.length === 0) {
      await sendWhisper(userId, '⭐ Favori şarkıın yok.\nEklemek için: -fav ekle\nListe için: -fav');
      return;
    }
    let text = '⭐ Favori Şarkıların:\n';
    u.favorites.forEach((f, i) => { text += `  ${i + 1}. ${f.title}\n`; });
    text += '\nOynat: -fav oynat <no> | Sil: -fav sil <no> | Ekle: -fav ekle';
    await sendWhisper(userId, text);
    return;
  }

  if (cmd === 'voteskip' || cmd === 'oyla') {
    if (!currentSong) { await sendWhisper(userId, 'Şu an şarkı çalmıyor!'); return; }
    if (!voteskipState.active) {
      voteskipState = { active: true, voters: [], required: 0, songTitle: currentSong.title };
    }
    if (voteskipState.voters.includes(username)) {
      await sendWhisper(userId, 'Zaten oy kullandın!');
      return;
    }
    voteskipState.voters.push(username);
    const roomUsers = await getRoomUsersFormatted();
    const required = Math.ceil(roomUsers.length * 0.5);
    voteskipState.required = required;
    const votes = voteskipState.voters.length;
    await sendChat(`🗳️ Oylama: "${currentSong.title}" atlatılsın mı? (${votes}/${required} oy)`);
    if (votes >= required) {
      stopDecoder();
      if (loopMode) {
        if (queue.length > 0) { const next = queue.shift(); setTimeout(() => playSong(next), 500); }
      } else if (queue.length > 0) {
        const next = queue.shift();
        setTimeout(() => playSong(next), 500);
      } else {
        startSilenceInterval();
      }
      voteskipState = { active: false, voters: [], required: 0, songTitle: '' };
      await sendChat(`🗳️ Şarkı oyla atlandı!`);
    }
    return;
  }

  if (cmd === 'dump') {
    if (!currentSong) { await sendWhisper(userId, 'Şu an şarkı çalmıyor!'); return; }
    const elapsed = Math.floor((Date.now() - currentSong.startTime) / 1000);
    const min = Math.floor(elapsed / 60);
    const sec = elapsed % 60;
    await sendWhisper(userId,
      `📋 Şarkı Bilgisi:\n` +
      `🎵 Başlık: ${currentSong.title}\n` +
      `👤 İsteyen: @${currentSong.user}\n` +
      `⏱️ Süre: ${min}:${sec.toString().padStart(2, '0')}\n` +
      `📊 Sıra: ${queue.length} şarkı bekliyor\n` +
      `🔊 Ses: %${volume}`
    );
    return;
  }

  if (cmd === 'volume' || cmd === 'v') {
    try {
      volume = Math.max(0, Math.min(100, parseInt(params[0])));
      await sendChat(`🔊 Ses: %${volume}`);
    } catch(e) { await sendChat('Geçerli sayı gir: -v 50'); }
    return;
  }

  if (cmd === 'loop') {
    loopMode = !loopMode;
    await sendChat(`🔁 Loop modu: ${loopMode ? 'AÇIK' : 'KAPALI'}`);
    return;
  }

  if (cmd === 'stop') {
    if (!isAdmin(username)) { await sendWhisper(userId, 'Yetkiniz yok!'); return; }
    stopDecoder();
    queue = [];
    loopMode = false;
    startSilenceInterval();
    await sendChat('⏹️ Müzik durduruldu!');
    return;
  }

  if (cmd === 'clear') {
    if (!isAdmin(username)) { await sendWhisper(userId, 'Yetkiniz yok!'); return; }
    queue = [];
    await sendChat('🗑️ Sıra temizlendi!');
    return;
  }

  if (cmd === 'remove') {
    if (!isAdmin(username)) { await sendWhisper(userId, 'Yetkiniz yok!'); return; }
    try {
      const idx = parseInt(params[0]) - 1;
      if (idx >= 0 && idx < queue.length) {
        const removed = queue.splice(idx, 1)[0];
        await sendChat(`🗑️ #${idx + 1} '${removed.title}' çıkarıldı!`);
      } else { await sendWhisper(userId, 'Geçersiz numara.'); }
    } catch(e) { await sendWhisper(userId, 'Sayı gir: -remove 1'); }
    return;
  }

  if (cmd === 'ceza') {
    if (!isAdmin(username)) {
      await sendWhisper(userId, '⛔ Bu komut sadece moderatörler/oda sahipleri için!');
      return;
    }
    const target = params[0] ? params[0].replace('@', '') : null;
    if (!target) {
      await sendWhisper(userId, 'Kullanım: -ceza @kullanıcı');
      return;
    }
    addSicil(target, -15);
    const puan = getSicil(target);
    await sendChat(`⚠️ @${username} tarafından @${target} cezalandırıldı! -15 sicil puanı (Mevcut: ${puan})`);
    if (puan <= 0) {
      await sendChat(`🚫 @${target} sicil puanı sıfırlandı, odadan atılıyor!`);
      try {
        const roomUsers = await getRoomUsersFormatted();
        const targetUser = roomUsers.find(u => u.username === target);
        if (targetUser) {
          await client.moderation.kick(targetUser.id, 'Otomatik: Sicil puanı sıfırlandı');
        }
      } catch(e) {}
    }
    return;
  }

  if (cmd === 'sicil') {
    const target = params[0] ? params[0].replace('@', '') : username;
    const puan = getSicil(target);
    await sendChat(`📋 @${target} sicil puanı: ${puan}/100`);
    return;
  }

  if (cmd === 'bonus') {
    if (!isAdmin(username)) { await sendWhisper(userId, 'Yetkiniz yok!'); return; }
    const target = params[0] ? params[0].replace('@', '') : null;
    const miktar = parseInt(params[1]) || 50;
    if (!target) {
      await sendWhisper(userId, 'Kullanım: -bonus @kullanıcı <miktar>');
      return;
    }
    addCredits(target, miktar);
    await sendChat(`🎁 @${target} Admin tarafından ${miktar} kredi hediye edildi! (Toplam: ${getCredits(target)})`);
    return;
  }

  if (cmd === 'ekle') {
    const emoteName = params[0];
    const emoteUrl = params[1];
    if (!emoteName || !emoteUrl) {
      await sendWhisper(userId, 'Kullanım: -ekle <isim> <emote_url>');
      return;
    }
    customEmotes[emoteName.toLowerCase()] = { url: emoteUrl, addedBy: username };
    saveCustomEmotes();
    await sendChat(`✅ Özel emote eklendi: ${emoteName}`);
    return;
  }

  if (cmd === 'sil') {
    if (!isAdmin(username)) { await sendWhisper(userId, 'Yetkiniz yok!'); return; }
    const emoteName = params[0];
    if (!emoteName) {
      await sendWhisper(userId, 'Kullanım: -sil <emote adı>');
      return;
    }
    if (customEmotes[emoteName.toLowerCase()]) {
      delete customEmotes[emoteName.toLowerCase()];
      saveCustomEmotes();
      await sendChat(`🗑️ Özel emote silindi: ${emoteName}`);
    } else {
      await sendWhisper(userId, `'${emoteName}' bulunamadı!`);
    }
    return;
  }

  if (cmd === 'emotlist' || cmd === 'emotlar') {
    const names = Object.keys(customEmotes);
    if (names.length === 0) {
      await sendChat('Özel emote yok. Eklemek için: -ekle <isim> <url>');
      return;
    }
    let text = '🎭 Özel Emotlar:\n';
    names.slice(0, 20).forEach((n, i) => {
      text += `  ${i + 1}. ${n} (${customEmotes[n].addedBy})\n`;
    });
    if (names.length > 20) text += `  ... ve ${names.length - 20} daha`;
    await sendWhisper(userId, text);
    return;
  }

  if (cmd === 'oynat') {
    const emoteName = params[0];
    if (!emoteName) {
      await sendWhisper(userId, 'Kullanım: -oynat <emote adı>');
      return;
    }
    const emote = customEmotes[emoteName.toLowerCase()];
    if (!emote) {
      await sendWhisper(userId, `'${emoteName}' bulunamadı!`);
      return;
    }
    await sendChat(`🎭 @${username} oynatıyor: ${emoteName}\n${emote.url}`);
    return;
  }

  // ═══════════════════════════════════════════
  // 👗 KIYAFET KOMUTLARI
  // ═══════════════════════════════════════════

  // OTOMATIK KIYAFET DEGISIM
  if (cmd === 'kıyafetotodeğiştir' || cmd === 'otooutfitac' || cmd === 'otokiyafetac') {
    if (!isAllowed(username)) {
      await sendWhisper(userId, '⛔ Bu komut için yetkiniz yok!');
      return;
    }
    autoOutfitChange = true;
    startAutoOutfitChange();
    await sendChat(`👗 @${username} Otomatik kiyafet degisimi aktif edildi! (her 5 dakika)`);
    return;
  }

  if (cmd === 'kıyafetotodeğiştirmeyidurdur' || cmd === 'otooutfitkapat' || cmd === 'otokiyafetkapat') {
    if (!isAllowed(username)) {
      await sendWhisper(userId, '⛔ Bu komut için yetkiniz yok!');
      return;
    }
    autoOutfitChange = false;
    stopAutoOutfitChange();
    await sendChat(`👗 @${username} Otomatik kiyafet degisimi durduruldu.`);
    return;
  }

  if (cmd === 'rastgele') {
    try {
      const BOT_ID = '6a4bb4dffce970fd78a729fe';
      const newOutfit = getRandomOutfit();
      randomOutfitActive = true;
      lastRandomOutfit = newOutfit;
      await setBotOutfit(newOutfit);
      await sendChat(`🎲 @${username} rastgele kıyafet giydi! (${newOutfit.length} item)`);
    } catch(e) {
      console.log('[Kıyafet] Hata:', e.message || e);
      await sendWhisper(userId, 'Kıyafet değiştirilemedi: ' + (e.message || e));
    }
    return;
  }

  if (cmd === 'kaparastgele' || cmd === 'kapatastgele') {
    randomOutfitActive = false;
    await sendChat(`🎲 @${username} rastgele kıyafet modu kapatıldı.`);
    return;
  }

  if (cmd === 'kıyafet' || cmd === 'kiyafet') {
    try {
      const BOT_ID = '6a4bb4dffce970fd78a729fe';
      
      const currentOutfit = await client.player.outfit.get(BOT_ID);
      
      const requiredCategories = ['body-flesh', 'eye', 'eyebrow', 'nose', 'mouth', 'freckle'];
      let newOutfit = [];
      
      if (currentOutfit && Array.isArray(currentOutfit)) {
        newOutfit = currentOutfit.filter(item => {
          const id = item.id || '';
          return requiredCategories.some(cat => id.startsWith(cat));
        });
      } else {
        newOutfit = [
          { type: 'clothing', amount: 1, id: 'body-flesh', account_bound: false, active_palette: 27 },
          { type: 'clothing', amount: 1, id: 'eye-n_octhrsupport2024almond', account_bound: false, active_palette: 7 },
          { type: 'clothing', amount: 1, id: 'eyebrow-n_basic2018newbrows07', account_bound: false, active_palette: 0 },
          { type: 'clothing', amount: 1, id: 'nose-n_octhrsupport2024blushednose', account_bound: false, active_palette: 0 },
          { type: 'clothing', amount: 1, id: 'mouth-n_octhrsupport2024sweetlips', account_bound: false, active_palette: -1 }
        ];
      }

      const legendaryHairBack = items.filter(i => (i.id || '').toLowerCase().startsWith('hair_back') && i.rarity === 'legendary' && !(i.id || '').includes('_m_'));
      console.log('[Kıyafet] Legendary arka saç sayısı:', legendaryHairBack.length);

      function pickRandomLegendaryHairBack() {
        return legendaryHairBack[Math.floor(Math.random() * legendaryHairBack.length)].id;
      }

      const combos = [
        { name: 'Sokak Stili', items: [
          { id: 'hair_front-n_octhrsupport2024halfgrabshort' },
          { id: 'shirt-n_bhm2021crop' },
          { id: 'pants-n_worstdayeverskypass2022acidwashjeans' },
          { id: 'shoes-n_2016newyearheels' }, { id: 'glasses-n_room22019aviators' },
          { id: 'necklace-n_dailyquestoutfitnov2024chainnecklace' }
        ]},
        { name: 'Goth Kız', items: [
          { id: 'hair_front-n_octhrsupport2024halfgrabshort' },
          { id: 'shirt-n_bhm2021offshouldersweater' },
          { id: 'pants-n_gothanchorstore2022cargopants' },
          { id: 'shoes-n_cancerdaily2019crabbyboots' }, { id: 'glasses-n_catcollection2018blackcatmask' },
          { id: 'necklace-n_periodromancegrab2021choker' }
        ]},
        { name: 'Yaz Rüzgarı', items: [
          { id: 'hair_front-n_octhrsupport2024halfgrabshort' },
          { id: 'shirt-n_octhrsupport2024pinkshirtnskirt' },
          { id: 'pants-n_gothatlantis2021beachshorts' },
          { id: 'shoes-n_gemini2019wingkicks' }, { id: 'glasses-n_2022newyearglasses' },
          { id: 'necklace-n_pastelmallcollection2022bluechoker' }
        ]},
        { name: 'Pembe Şık', items: [
          { id: 'hair_front-n_octhrsupport2024halfgrabshort' },
          { id: 'shirt-n_octhrsupport2024pinkshirtnskirt' },
          { id: 'pants-n_cutealien2017purplepants' },
          { id: 'shoes-n_2016newyearheels' }, { id: 'glasses-n_room12019circleframes' },
          { id: 'necklace-n_pastelmallcollection2022yellowchoker' }
        ]},
        { name: 'Kış Hatunu', items: [
          { id: 'hair_front-n_octhrsupport2024halfgrabshort' },
          { id: 'shirt-n_2016newyearcoat' },
          { id: 'pants-n_demonacademiaskypass2022academypants' },
          { id: 'shoes-n_2016newyearboots' }, { id: 'glasses-n_2016snowboardgogglesblack' },
          { id: 'hat-n_2016newyeartophat_1' }, { id: 'necklace-n_room22019scarfblack' }
        ]},
        { name: 'Retro Kız', items: [
          { id: 'hair_front-n_octhrsupport2024halfgrabshort' },
          { id: 'shirt-n_bhm2021crop' },
          { id: 'pants-n_4july2017pantswithsocks' },
          { id: 'shoes-n_balletcore2025set2snoopyballetshoes2' }, { id: 'glasses-n_room12019halfrimblack' },
          { id: 'necklace-n_capricorndailies2018necklace' }
        ]},
        { name: 'Balo Kraliçesi', items: [
          { id: 'hair_front-n_octhrsupport2024halfgrabshort' },
          { id: 'shirt-n_bhm2021offshouldersweater' },
          { id: 'pants-n_demonacademiaskypass2022academypants' },
          { id: 'shoes-n_2016newyearheels' }, { id: 'glasses-n_room22019aviators' },
          { id: 'hat-n_2016newyearcrown_1' }, { id: 'necklace-n_dailyquestoutfitnov2024chainnecklace' }
        ]},
        { name: 'Spor Kız', items: [
          { id: 'hair_front-n_octhrsupport2024halfgrabshort' },
          { id: 'shirt-n_bhm2021crop' },
          { id: 'pants-n_gothatlantis2021beachshorts' },
          { id: 'shoes-n_gemini2019wingkicks' }, { id: 'glasses-n_2022newyearglasses' }
        ]},
        { name: 'Gece Yıldızı', items: [
          { id: 'hair_front-n_octhrsupport2024halfgrabshort' },
          { id: 'shirt-n_vintagethriftjanuaryskypass2023varsityjacketdenim' },
          { id: 'pants-n_cutealien2017purplepants' },
          { id: 'shoes-n_2016newyearheels' }, { id: 'glasses-n_room22019aviators' },
          { id: 'necklace-n_dailyquestoutfitnov2024chainnecklace' }
        ]},
        { name: 'Çiçek Kızı', items: [
          { id: 'hair_front-n_octhrsupport2024halfgrabshort' },
          { id: 'shirt-n_octhrsupport2024pinkshirtnskirt' },
          { id: 'pants-n_4july2017pantswithsocks' },
          { id: 'shoes-n_balletcore2025set2snoopyballetshoes2' }, { id: 'glasses-n_room12019halfrimblack' },
          { id: 'necklace-n_scaremaze2022candynecklace' }
        ]}
      ];

      const chosenCombo = combos[Math.floor(Math.random() * combos.length)];
      
      const chosenHairBack = pickRandomLegendaryHairBack();
      newOutfit.push({ type: 'clothing', amount: 1, id: chosenHairBack, account_bound: false, active_palette: 0 });
      
      for (const item of chosenCombo.items) {
        newOutfit.push({
          type: 'clothing', amount: 1, id: item.id, account_bound: false, active_palette: 0
        });
      }

      console.log('[Kıyafet] Tema:', chosenCombo.name, '| Itemlar:', newOutfit.map(i => i.id));
      
      await setBotOutfit(newOutfit);
      
      let nextNum = 1;
      while (outfits[`kıyafet${nextNum}`]) nextNum++;
      const outfitKey = `kıyafet${nextNum}`;
      outfits[outfitKey] = { items: newOutfit, savedBy: username, date: new Date().toISOString() };
      saveOutfits();
      await sendChat(`👗 @${username} "${chosenCombo.name}" kombini giyildi! (${newOutfit.length} item)`);
    } catch(e) {
      console.log('[Kıyafet] Hata:', e.message || e);
      await sendWhisper(userId, 'Kıyafet değiştirilemedi: ' + (e.message || e));
    }
    return;
  }

  if (cmd === 'kaydet') {
    try {
      const BOT_ID = '6a4bb4dffce970fd78a729fe';
      const currentOutfit = await client.player.outfit.get(BOT_ID);
      if (!currentOutfit || !Array.isArray(currentOutfit) || currentOutfit.length === 0) {
        await sendWhisper(userId, 'Mevcut kıyafet alınamadı!');
        return;
      }
      let nextNum = 1;
      while (outfits[`kıyafet${nextNum}`]) nextNum++;
      const outfitKey = `kıyafet${nextNum}`;
      outfits[outfitKey] = {
        items: currentOutfit,
        savedBy: username,
        date: new Date().toISOString()
      };
      saveOutfits();
      await sendChat(`💾 @${username} kıyafet kaydedildi: ${outfitKey} (${currentOutfit.length} item)`);
    } catch(e) {
      await sendWhisper(userId, 'Kıyafet kaydedilemedi: ' + e.message);
    }
    return;
  }

  if (cmd === 'liste') {
    const outfitNames = Object.keys(outfits);
    if (outfitNames.length === 0) {
      await sendChat('👗 Kayıtlı kıyafet yok. Kaydetmek için: -kaydet');
      return;
    }
    let text = '👗 KAYITLI KIYAFETLER:\n';
    outfitNames.forEach((n, i) => {
      const outfit = outfits[n];
      const date = outfit.date ? new Date(outfit.date).toLocaleDateString('tr-TR') : '';
      text += `  ${i + 1}. ${n} (${outfit.items.length} item) ${date}\n`;
    });
    text += '\nGiymek için: -giy <isim> | Sil: -sil <isim>';
    await sendWhisper(userId, text);
    return;
  }

  if (cmd === 'kıyafet1giy' || cmd === 'kiyafet1giy') {
    const outfit = outfits['kıyafet1'];
    if (!outfit) { await sendWhisper(userId, 'kıyafet1 kayıtlı değil!'); return; }
    try {
      await setBotOutfit(outfit.items);
      await sendChat(`👗 @${username} kıyafet1 giyildi!`);
    } catch(e) { await sendWhisper(userId, 'Kıyafet giyilemedi!'); }
    return;
  }

  if (cmd === 'kıyafet2giy' || cmd === 'kiyafet2giy') {
    const outfit = outfits['kıyafet2'];
    if (!outfit) { await sendWhisper(userId, 'kıyafet2 kayıtlı değil!'); return; }
    try {
      await setBotOutfit(outfit.items);
      await sendChat(`👗 @${username} kıyafet2 giyildi!`);
    } catch(e) { await sendWhisper(userId, 'Kıyafet giyilemedi!'); }
    return;
  }

  if (cmd === 'kıyafet3giy' || cmd === 'kiyafet3giy') {
    const outfit = outfits['kıyafet3'];
    if (!outfit) { await sendWhisper(userId, 'kıyafet3 kayıtlı değil!'); return; }
    try {
      await setBotOutfit(outfit.items);
      await sendChat(`👗 @${username} kıyafet3 giyildi!`);
    } catch(e) { await sendWhisper(userId, 'Kıyafet giyilemedi!'); }
    return;
  }

  if (cmd === 'kıyafet4giy' || cmd === 'kiyafet4giy') {
    const outfit = outfits['kıyafet4'];
    if (!outfit) { await sendWhisper(userId, 'kıyafet4 kayıtlı değil!'); return; }
    try {
      await setBotOutfit(outfit.items);
      await sendChat(`👗 @${username} kıyafet4 giyildi!`);
    } catch(e) { await sendWhisper(userId, 'Kıyafet giyilemedi!'); }
    return;
  }

  if (cmd === 'kıyafet5giy' || cmd === 'kiyafet5giy') {
    const outfit = outfits['kıyafet5'];
    if (!outfit) { await sendWhisper(userId, 'kıyafet5 kayıtlı değil!'); return; }
    try {
      await setBotOutfit(outfit.items);
      await sendChat(`👗 @${username} kıyafet5 giyildi!`);
    } catch(e) { await sendWhisper(userId, 'Kıyafet giyilemedi!'); }
    return;
  }

  if (cmd === 'giy') {
    const outfitName = params[0];
    if (!outfitName) {
      await sendWhisper(userId, 'Kullanım: -giy <isim>\nÖrnek: -giy kıyafet1');
      return;
    }
    const outfit = outfits[outfitName.toLowerCase()];
    if (!outfit) {
      await sendWhisper(userId, `'${outfitName}' kayıtlı değil! Liste için: -liste`);
      return;
    }
    try {
      await setBotOutfit(outfit.items);
      await sendChat(`👗 @${username} "${outfitName}" giyildi!`);
    } catch(e) {
      await sendWhisper(userId, 'Kıyafet giyilemedi: ' + e.message);
    }
    return;
  }

  if (cmd === 'silliste') {
    if (!isAdmin(username)) { await sendWhisper(userId, '⛔ Yetkiniz yok!'); return; }
    outfits = {};
    saveOutfits();
    await sendChat(`🗑️ @${username} tüm kayıtlı kıyafetler silindi!`);
    return;
  }

  if (cmd === 'sil') {
    if (!isAdmin(username)) { await sendWhisper(userId, '⛔ Yetkiniz yok!'); return; }
    const outfitName = params[0];
    if (!outfitName) {
      await sendWhisper(userId, 'Kullanım: -sil <isim>\nÖrnek: -sil kıyafet1');
      return;
    }
    if (outfits[outfitName.toLowerCase()]) {
      delete outfits[outfitName.toLowerCase()];
      saveOutfits();
      await sendChat(`🗑️ @${username} "${outfitName}" silindi!`);
    } else {
      await sendWhisper(userId, `'${outfitName}' bulunamadı!`);
    }
    return;
  }

  if (cmd === 'çıkar' || cmd === 'cikar') {
    const itemName = params.join(' ');
    if (!itemName) {
      await sendWhisper(userId, 'Kullanım: -çıkar <ürün adı veya ID>\nÖrnek: -çıkar glasses\nÖrnek: -çıkar shirt-n_summer2024floral');
      return;
    }
    try {
      const BOT_ID = '6a4bb4dffce970fd78a729fe';
      const currentOutfit = await client.player.outfit.get(BOT_ID);
      if (!currentOutfit || !Array.isArray(currentOutfit) || currentOutfit.length === 0) {
        await sendWhisper(userId, 'Mevcut kıyafet alınamadı!');
        return;
      }
      const searchLower = itemName.toLowerCase();
      let removedItem = null;
      let removedIndex = -1;
      
      // 1. Tam ID eşleşmesi dene
      const exactIdIndex = currentOutfit.findIndex(item => (item.id || '').toLowerCase() === searchLower);
      if (exactIdIndex !== -1) {
        removedIndex = exactIdIndex;
        removedItem = { id: currentOutfit[exactIdIndex].id, name: getItemNameById(currentOutfit[exactIdIndex].id) || currentOutfit[exactIdIndex].id };
      }
      
      // 2. İsim ile ara (tam eşleşme)
      if (!removedItem) {
        const exactNameIndex = currentOutfit.findIndex(item => {
          const name = getItemNameById(item.id);
          return name && name.toLowerCase() === searchLower;
        });
        if (exactNameIndex !== -1) {
          removedIndex = exactNameIndex;
          removedItem = { id: currentOutfit[exactNameIndex].id, name: getItemNameById(currentOutfit[exactNameIndex].id) || currentOutfit[exactNameIndex].id };
        }
      }
      
      // 3. Kısmi eşleşme (ID veya isim)
      if (!removedItem) {
        const partialIndex = currentOutfit.findIndex(item => {
          const name = getItemNameById(item.id);
          const id = (item.id || '').toLowerCase();
          return (name && name.toLowerCase().includes(searchLower)) || id.includes(searchLower);
        });
        if (partialIndex !== -1) {
          removedIndex = partialIndex;
          removedItem = { id: currentOutfit[partialIndex].id, name: getItemNameById(currentOutfit[partialIndex].id) || currentOutfit[partialIndex].id };
        }
      }
      
      if (!removedItem) {
        // Bulunamadıysa, mevcut itemları listele
        const itemList = currentOutfit.map(item => {
          const name = getItemNameById(item.id);
          return `  • ${name || item.id} (${item.id})`;
        }).join('\n');
        await sendWhisper(userId, `"${itemName}" kıyafette bulunamadı!\n\nMevcut kıyafetler:\n${itemList}`);
        return;
      }
      
      const newOutfit = currentOutfit.filter((_, i) => i !== removedIndex);
      await setBotOutfit(newOutfit);
      let nextNum = 1;
      while (outfits[`kıyafet${nextNum}`]) nextNum++;
      const outfitKey = `kıyafet${nextNum}`;
      outfits[outfitKey] = { items: newOutfit, savedBy: username, date: new Date().toISOString() };
      saveOutfits();
      await sendChat(`🗑️ @${username} "${removedItem.name}" çıkarıldı ve yeni kıyafet kaydedildi: ${outfitKey}`);
    } catch(e) {
      await sendWhisper(userId, 'Ürün çıkarılamadı: ' + (e.message || e));
    }
    return;
  }

  if (cmd === 'cüzdan' || cmd === 'cuzdan' || cmd === 'wallet') {
    try {
      const sender = new (require('highrise-js-sdk').SendPayloadAndGetResponse)(client);
      const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Zaman aşımı')), 10000);
        const handler = (msg) => {
          try {
            const data = JSON.parse(msg);
            if (data._type === 'GetWalletResponse' && data.rid === requestId) {
              clearTimeout(timeout);
              client.ws.off('message', handler);
              resolve(data);
            }
          } catch(e) {}
        };
        client.ws.on('message', handler);
        client.ws.send(JSON.stringify({ _type: 'GetWalletRequest', rid: requestId }));
      });
      const gold = (result.items || []).find(i => i.type === 'gold');
      const gems = (result.items || []).find(i => i.type === 'diamonds');
      const goldAmt = gold ? gold.amount : 0;
      const gemsAmt = gems ? gems.amount : 0;
      await sendChat(`💰 @${username} Bot Cüzdanı:\n🪙 Altın: ${goldAmt}\n💎 Elmas: ${gemsAmt}`);
    } catch(e) {
      await sendWhisper(userId, 'Cüzdan bilgisi alınamadı: ' + e.message);
    }
    return;
  }

  if (cmd === 'satınal' || cmd === 'satinal' || cmd === 'buy') {
    const itemId = params[0];
    if (!itemId) {
      await sendWhisper(userId, 'Kullanım: -satınal <item_id>\nÖrnek: -satınal shirt-n_summer2024floral\n\nItem ID bulmak için: -kiyafet <arama>');
      return;
    }
    const itemInfo = getItemById(itemId);
    if (!itemInfo) {
      await sendWhisper(userId, `❌ "${itemId}" item listesinde bulunamadı! -kiyafet ile ara.`);
      return;
    }
    try {
      const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Zaman aşımı')), 10000);
        const handler = (msg) => {
          try {
            const data = JSON.parse(msg);
            if (data._type === 'BuyItemResponse' && data.rid === requestId) {
              clearTimeout(timeout);
              client.ws.off('message', handler);
              resolve(data);
            }
          } catch(e) {}
        };
        client.ws.on('message', handler);
        client.ws.send(JSON.stringify({ _type: 'BuyItemRequest', item_id: itemId, rid: requestId }));
      });
      if (result.result === 'success') {
        await sendChat(`✅ @${username} satın aldı: ${itemInfo.name} [${itemInfo.rarity}]`);
      } else if (result.result === 'already_owned') {
        await sendWhisper(userId, `ℹ️ "${itemInfo.name}" zaten envanterinde var!`);
      } else {
        await sendWhisper(userId, `❌ Satın alınamadı: ${result.result}`);
      }
    } catch(e) {
      await sendWhisper(userId, 'Satın alma hatası: ' + e.message);
    }
    return;
  }

  if (cmd === 'mağaza' || cmd === 'magaza' || cmd === 'store') {
    const catFilter = params[0];
    let pool = items;
    if (catFilter) {
      pool = items.filter(i => i.category === catFilter.toLowerCase());
      if (pool.length === 0) {
        await sendWhisper(userId, `"${catFilter}" kategorisinde item yok! -kategoriler ile listele.`);
        return;
      }
    }
    const random = [];
    const used = new Set();
    while (random.length < 8 && random.length < pool.length) {
      const idx = Math.floor(Math.random() * pool.length);
      if (!used.has(idx)) { used.add(idx); random.push(pool[idx]); }
    }
    let text = '🏪 MAĞAZA (rastgele items):\n';
    random.forEach((item, i) => {
      text += `${i + 1}. [${item.rarity}] ${item.name}\n   ID: ${item.id}\n`;
    });
    text += '\nSatın al: -satınal <item_id>';
    await sendWhisper(userId, text);
    return;
  }

  if (cmd === 'sor' || cmd === 'ai') {
    const question = params.join(' ');
    if (!question) {
      await sendWhisper(userId, 'Kullanım: -sor <soru>');
      return;
    }
    try {
      const response = await getAIResponse(question);
      await sendChat(`🤖 @${username}: ${response}`);
    } catch(e) {
      await sendWhisper(userId, 'AI yanıtı alınamadı!');
    }
    return;
  }

  // ═══════════════════════════════════════════
  // KATEGORI 1: MADEN & BALIKÇILIK RPG
  // ═══════════════════════════════════════════

  if (cmd === 'maden' || cmd === 'imine') {
    const u = getUserGameData(username);
    if (u.jail) { await sendWhisper(userId, '📍 Hapisanesin! Çıkış için: -jailkefaret'); return; }
    try { await client.player.sendEmote(null, 'mining-mine'); } catch(e) {}
    await new Promise(r => setTimeout(r, 2000 + Math.random() * 1000));
    const ore = pickRandom(ORE_TYPES.filter(o => o.level <= u.mining.level));
    if (!ore) {
      try { await client.player.sendEmote(null, 'mining-fail'); } catch(e) {}
      await sendChat(`⛏️ @${username} kazdı ama bir şey bulamadı!`);
      return;
    }
    try { await client.player.sendEmote(null, 'mining-success'); } catch(e) {}
    u.inventory.ores[ore.name] = (u.inventory.ores[ore.name] || 0) + 1;
    u.miningDone = (u.miningDone || 0) + 1;
    addXP(username, 10);
    saveGameData(gameData);
    await sendChat(`⛏️ @${username} kazdı: ${ore.name} (Değer: ${ore.value}💰)`);
    return;
  }

  if (cmd === 'kazmam') {
    const u = getUserGameData(username);
    await sendWhisper(userId, `⛏️ Maden Seviye: ${u.mining.level}/7 | XP: ${u.mining.xp}/${u.mining.level * 100}\nOtomatik: ${u.mining.auto ? 'AÇIK' : 'KAPALI'}`);
    return;
  }

  if (cmd === 'kazmayukselt') {
    const u = getUserGameData(username);
    const cost = u.mining.level * 200;
    if (u.mining.level >= 7) { await sendWhisper(userId, 'Maksimum maden seviyesine ulaştın!'); return; }
    if (getCredits(username) < cost) { await sendWhisper(userId, `Yetersiz kredi! Gereken: ${cost}💰`); return; }
    removeCredits(username, cost);
    u.mining.level++;
    saveGameData(gameData);
    await sendChat(`⛏️ @${username} kazma seviye ${u.mining.level}'e yükseltti!`);
    return;
  }

  if (cmd === 'otomatikmaden' || cmd === 'otmaden') {
    const u = getUserGameData(username);
    u.mining.auto = !u.mining.auto;
    saveGameData(gameData);
    await sendChat(`⛏️ @${username} otomatik maden: ${u.mining.auto ? 'AÇIK' : 'KAPALI'}`);
    return;
  }

  if (cmd === 'madenbilgi') {
    const u = getUserGameData(username);
    let text = `⛏️ Maden Çantası (${username}):\n`;
    const ores = Object.entries(u.inventory.ores);
    if (ores.length === 0) { text += '  Boş'; }
    else { ores.forEach(([name, count]) => { text += `  ${name}: ${count}\n`; }); }
    await sendWhisper(userId, text);
    return;
  }

  if (cmd === 'madensat') {
    const u = getUserGameData(username);
    let total = 0;
    Object.entries(u.inventory.ores).forEach(([name, count]) => {
      const ore = ORE_TYPES.find(o => o.name === name);
      if (ore) total += ore.value * count;
    });
    if (total === 0) { await sendWhisper(userId, 'Satacak maden yok!'); return; }
    u.inventory.ores = {};
    addCredits(username, total);
    saveGameData(gameData);
    await sendChat(`💰 @${username} madenlerini sattı: ${total}💰 kazandı!`);
    return;
  }

  if (cmd === 'balik' || cmd === 'fish') {
    const u = getUserGameData(username);
    if (u.jail) { await sendWhisper(userId, '📍 Hapisanesin! Çıkış için: -jailkefaret'); return; }
    try { await client.player.sendEmote(null, 'fishing-cast'); } catch(e) {}
    await new Promise(r => setTimeout(r, 1500));
    try { await client.player.sendEmote(null, 'fishing-idle'); } catch(e) {}
    await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
    const fish = pickRandom(FISH_TYPES.filter(f => f.level <= u.fishing.level));
    if (!fish) {
      try { await client.player.sendEmote(null, 'emote-sad'); } catch(e) {}
      await sendChat(`🎣 @${username} balık tutamadı! Şansını tekrar dene.`);
      return;
    }
    try { await client.player.sendEmote(null, 'fishing-pull'); } catch(e) {}
    await new Promise(r => setTimeout(r, 1000));
    u.inventory.fish[fish.name] = (u.inventory.fish[fish.name] || 0) + 1;
    u.fishingDone = (u.fishingDone || 0) + 1;
    addXP(username, 12);
    saveGameData(gameData);
    await sendChat(`🎣 @${username} balık tuttu: ${fish.name} (Değer: ${fish.value}💰)`);
    return;
  }

  if (cmd === 'olta') {
    const u = getUserGameData(username);
    await sendWhisper(userId, `🎣 Olta Seviye: ${u.fishing.level}/5 | XP: ${u.fishing.xp}/${u.fishing.level * 100}\nOtomatik: ${u.fishing.auto ? 'AÇIK' : 'KAPALI'}`);
    return;
  }

  if (cmd === 'oltayukselt') {
    const u = getUserGameData(username);
    const cost = u.fishing.level * 250;
    if (u.fishing.level >= 5) { await sendWhisper(userId, 'Maksimum olta seviyesine ulaştın!'); return; }
    if (getCredits(username) < cost) { await sendWhisper(userId, `Yetersiz kredi! Gereken: ${cost}💰`); return; }
    removeCredits(username, cost);
    u.fishing.level++;
    saveGameData(gameData);
    await sendChat(`🎣 @${username} olta seviye ${u.fishing.level}'e yükseltti!`);
    return;
  }

  if (cmd === 'otomatikbalik' || cmd === 'otbalik') {
    const u = getUserGameData(username);
    u.fishing.auto = !u.fishing.auto;
    saveGameData(gameData);
    await sendChat(`🎣 @${username} otomatik balık: ${u.fishing.auto ? 'AÇIK' : 'KAPALI'}`);
    return;
  }

  if (cmd === 'balikbilgi') {
    const u = getUserGameData(username);
    let text = `🎣 Balık Çantası (${username}):\n`;
    const fish = Object.entries(u.inventory.fish);
    if (fish.length === 0) { text += '  Boş'; }
    else { fish.forEach(([name, count]) => { text += `  ${name}: ${count}\n`; }); }
    await sendWhisper(userId, text);
    return;
  }

  if (cmd === 'baliksat') {
    const u = getUserGameData(username);
    let total = 0;
    Object.entries(u.inventory.fish).forEach(([name, count]) => {
      const fish = FISH_TYPES.find(f => f.name === name);
      if (fish) total += fish.value * count;
    });
    if (total === 0) { await sendWhisper(userId, 'Satacak balık yok!'); return; }
    u.inventory.fish = {};
    addCredits(username, total);
    saveGameData(gameData);
    await sendChat(`💰 @${username} balıklarını sattı: ${total}💰 kazandı!`);
    return;
  }

  if (cmd === 'hepsinisat') {
    const u = getUserGameData(username);
    let total = 0;
    Object.entries(u.inventory.ores).forEach(([name, count]) => {
      const ore = ORE_TYPES.find(o => o.name === name);
      if (ore) total += ore.value * count;
    });
    Object.entries(u.inventory.fish).forEach(([name, count]) => {
      const fish = FISH_TYPES.find(f => f.name === name);
      if (fish) total += fish.value * count;
    });
    if (total === 0) { await sendWhisper(userId, 'Satacak bir şey yok!'); return; }
    u.inventory.ores = {};
    u.inventory.fish = {};
    addCredits(username, total);
    saveGameData(gameData);
    await sendChat(`💰 @${username} her şeyini sattı: ${total}💰 kazandı!`);
    return;
  }

  // ═══════════════════════════════════════════
  // KATEGORI 2: CASINO & ŞANS OYUNLARI
  // ═══════════════════════════════════════════

  if (cmd === 'bj' || cmd === 'blackjack') {
    const bet = parseInt(params[0]) || 10;
    if (getCredits(username) < bet) { await sendWhisper(userId, `Yetersiz kredi! Bakiyen: ${getCredits(username)}`); return; }
    removeCredits(username, bet);
    const playerCards = [Math.floor(Math.random() * 10) + 2, Math.floor(Math.random() * 10) + 2];
    const dealerCard = Math.floor(Math.random() * 10) + 2;
    const playerTotal = playerCards[0] + playerCards[1];
    if (playerTotal === 21) {
      const win = Math.floor(bet * 2.5);
      addCredits(username, win);
      await sendChat(`🎰 @${username} BLACKJACK! ${playerCards.join('+')} = 21 | ${win}💰 kazandı!`);
    } else if (playerTotal > 21) {
      await sendChat(`🎰 @${username} BUST! ${playerCards.join('+')} = ${playerTotal} | ${bet}💰 kaybetti!`);
    } else {
      const win = playerTotal > dealerCard ? bet * 2 : 0;
      if (win > 0) { addCredits(username, win); await sendChat(`🎰 @${username} Kazandı! ${playerCards.join('+')} vs ${dealerCard} | ${win}💰!`); }
      else { await sendChat(`🎰 @${username} Kaybetti! ${playerCards.join('+')} vs ${dealerCard} | ${bet}💰 gitti!`); }
    }
    return;
  }

  if (cmd === 'slot') {
    const bet = parseInt(params[0]) || 10;
    if (getCredits(username) < bet) { await sendWhisper(userId, `Yetersiz kredi! Bakiyen: ${getCredits(username)}`); return; }
    removeCredits(username, bet);
    const symbols = ['🍒', '🍋', '🍊', '🍇', '💎', '7️⃣'];
    const s1 = symbols[Math.floor(Math.random() * symbols.length)];
    const s2 = symbols[Math.floor(Math.random() * symbols.length)];
    const s3 = symbols[Math.floor(Math.random() * symbols.length)];
    let multiplier = 0;
    if (s1 === s2 && s2 === s3) { multiplier = s1 === '💎' ? 10 : s1 === '7️⃣' ? 7 : 5; }
    else if (s1 === s2 || s2 === s3 || s1 === s3) { multiplier = 2; }
    const win = Math.floor(bet * multiplier);
    if (win > 0) { addCredits(username, win); await sendChat(`🎰 @${username} | ${s1} ${s2} ${s3} | ${win}💰 kazandı!`); }
    else { await sendChat(`🎰 @${username} | ${s1} ${s2} ${s3} | ${bet}💰 kaybetti!`); }
    return;
  }

  if (cmd === 'cark' || cmd === 'çark') {
    const u = getUserGameData(username);
    const now = Date.now();
    if (u.lastWork && now - u.lastWork < 86400000) {
      const kalan = Math.ceil((86400000 - (now - u.lastWork)) / 3600000);
      await sendWhisper(userId, `⏰ Çarkı tekrar çevirmek için ${kalan} saat kaldı!`);
      return;
    }
    u.lastWork = now;
    const prizes = [10, 25, 50, 100, 200, 500, 1000];
    const prize = prizes[Math.floor(Math.random() * prizes.length)];
    addCredits(username, prize);
    saveGameData(gameData);
    await sendChat(`🎡 @${username} çarkı çevirdi: ${prize}💰 kazandı!`);
    return;
  }

  if (cmd === 'bahis') {
    const bet = parseInt(params[0]) || 10;
    if (getCredits(username) < bet) { await sendWhisper(userId, `Yetersiz kredi! Bakiyen: ${getCredits(username)}`); return; }
    removeCredits(username, bet);
    const win = Math.random() < 0.45;
    if (win) { addCredits(username, bet * 2); await sendChat(`🎲 @${username} bahsi kazandı! ${bet * 2}💰!`); }
    else { await sendChat(`🎲 @${username} bahsi kaybetti! ${bet}💰 gitti!`); }
    return;
  }

  // ═══════════════════════════════════════════
  // KATEGORI 3: ARENA SAVAŞI & BOMBA
  // ═══════════════════════════════════════════

  if (cmd === 'sava' || cmd === 'savaş') {
    const target = params[0] ? params[0].replace('@', '') : null;
    if (!target) { await sendWhisper(userId, 'Kullanım: -sava @kullanıcı'); return; }
    const u = getUserGameData(username);
    const t = getUserGameData(target);
    if (u.jail || t.jail) { await sendWhisper(userId, 'Hapisanedeki kişilerle savaşamazsın!'); return; }
    const playerHP = 100 + (u.level * 5);
    const enemyHP = 100 + (t.level * 5);
    let pDmg = Math.floor(Math.random() * 20) + 10;
    let eDmg = Math.floor(Math.random() * 15) + 8;
    const crit = Math.random() < 0.25;
    if (crit) pDmg = Math.floor(pDmg * 1.5);
    const playerWins = playerHP - eDmg > 0;
    if (playerWins) {
      const prize = 50 + t.level * 10;
      addCredits(username, prize);
      addXP(username, 20);
      await sendChat(`⚔️ @${username} @${target} ile savaştı! ${crit ? 'KRİTİK! ' : ''}${pDmg} hasar verdi. Kazandı: ${prize}💰`);
    } else {
      const loss = 30 + u.level * 5;
      removeCredits(username, loss);
      await sendChat(`⚔️ @${username} @${target} ile savaştı! Kaybetti. ${loss}💰 gitti!`);
    }
    saveGameData(gameData);
    return;
  }

  if (cmd === 'savun') {
    const u = getUserGameData(username);
    if (getCredits(username) < 50) { await sendWhisper(userId, 'Çelik kalkan için 50💰 gerekli!'); return; }
    removeCredits(username, 50);
    await sendChat(`🛡️ @${username} çelik kalkan aktif! Bir sonraki saldırıda %35 hasar azaltır.`);
    return;
  }

  if (cmd === 'ulti') {
    const u = getUserGameData(username);
    if (u.xp < 50) { await sendWhisper(userId, `Ulti için yeterli enerji yok! XP: ${u.xp}/50`); return; }
    u.xp -= 50;
    const dmg = Math.floor(Math.random() * 25) + 50;
    addCredits(username, dmg);
    saveGameData(gameData);
    await sendChat(`💥 @${username} ULTİ KULLANDI! ${dmg} hasar verdi ve ${dmg}💰 kazandı!`);
    return;
  }

  if (cmd === 'savasiptal') {
    await sendChat(`🏳️ @${username} savaş teklifini geri çekti.`);
    return;
  }

  if (cmd === 'bomba') {
    const target = params[0] ? params[0].replace('@', '') : null;
    if (!target) { await sendWhisper(userId, 'Kullanım: -bomba @kullanıcı'); return; }
    const u = getUserGameData(username);
    const t = getUserGameData(target);
    if (u.bomb) { await sendWhisper(userId, 'Zaten aktif bir bomban var!'); return; }
    u.bomb = { target: target, time: Date.now() };
    saveGameData(gameData);
    await sendChat(`💣 @${username} @${target} üzerine bomba attı! Patlamak için: -patla @kullanıcı`);
    return;
  }

  if (cmd === 'patla') {
    const target = params[0] ? params[0].replace('@', '') : null;
    const u = getUserGameData(username);
    if (!u.bomb || u.bomb.target !== target) { await sendWhisper(userId, 'Bu kullanıcıya bomban yok!'); return; }
    const elapsed = Date.now() - u.bomb.time;
    if (elapsed > 120000) {
      await sendChat(`💣 @${username} bombayı imha etti! @${target} kurtuldu!`);
      u.bomb = null;
    } else {
      const dmg = 100;
      removeCredits(target, dmg);
      addCredits(username, Math.floor(dmg / 2));
      await sendChat(`💣💥 @${username} @${target}'i bombaladı! ${dmg}💰 hasar!`);
      u.bomb = null;
    }
    saveGameData(gameData);
    return;
  }

  if (cmd === 'bombadurum') {
    const u = getUserGameData(username);
    if (!u.bomb) { await sendWhisper(userId, 'Aktif bomban yok.'); return; }
    const elapsed = Date.now() - u.bomb.time;
    const kalan = Math.max(0, 120 - Math.floor(elapsed / 1000));
    await sendWhisper(userId, `💣 Bomba: @${u.bomb.target} | Kalan: ${kalan}s`);
    return;
  }

  if (cmd === 'bombaimha') {
    const u = getUserGameData(username);
    if (!u.bomb) { await sendWhisper(userId, 'Aktif bomban yok!'); return; }
    const cost = 75;
    if (getCredits(username) < cost) { await sendWhisper(userId, `İmha için ${cost}💰 gerekli!`); return; }
    removeCredits(username, cost);
    u.bomb = null;
    saveGameData(gameData);
    await sendChat(`💣 @${username} bombayı imha etti! ${cost}💰 harcadı.`);
    return;
  }

  // ═══════════════════════════════════════════
  // KATEGORI 4: YARIŞMALAR
  // ═══════════════════════════════════════════

  if (cmd === 'soygun') {
    const target = params[0] ? params[0].replace('@', '') : null;
    if (!target) { await sendWhisper(userId, 'Kullanım: -soygun @kullanıcı'); return; }
    const u = getUserGameData(username);
    if (u.jail) { await sendWhisper(userId, '📍 Hapisanesin!'); return; }
    const win = Math.random() < 0.5;
    if (win) {
      const amount = Math.floor(Math.random() * 100) + 20;
      addCredits(username, amount);
      await sendChat(`🏴‍☠️ @${username} @${target}'i soydu! ${amount}💰 kazandı!`);
    } else {
      const amount = Math.floor(Math.random() * 50) + 10;
      removeCredits(username, amount);
      u.jail = true;
      u.jailTime = Date.now() + 300000;
      u.jailReason = 'Soygun başarısız';
      await sendChat(`🚨 @${username} soygunda yakalandı! ${amount}💰 kaybetti ve hapse atıldı!`);
    }
    saveGameData(gameData);
    return;
  }

  if (cmd === 'sayi') {
    const guess = parseInt(params[0]);
    if (!guess || guess < 1 || guess > 10) { await sendWhisper(userId, 'Kullanım: -sayi 1-10 arası bir sayı gir'); return; }
    const secret = Math.floor(Math.random() * 10) + 1;
    if (guess === secret) {
      addCredits(username, 50);
      await sendChat(`🔢 @${username} doğru bildi! Sayı: ${secret} | 50💰 kazandı!`);
    } else {
      await sendChat(`🔢 @${username} yanlış! Sen: ${guess}, Doğru: ${secret}`);
    }
    return;
  }

  if (cmd === 'kelime') {
    const words = ['elma', 'kalem', 'kitap', 'deniz', 'güneş', 'yıldız', 'ağaç', 'kuş', 'balık', 'çicek'];
    const word = words[Math.floor(Math.random() * words.length)];
    const hint = word[0] + '_'.repeat(word.length - 1);
    await sendChat(`📝 Kelime oyunu! İpucu: ${hint} (${word.length} harf) Tahminin: -kelime <tahmin>`);
    if (params[0] && params[0].toLowerCase() === word) {
      addCredits(username, 30);
      await sendChat(`📝 @${username} doğru bildi! Kelime: ${word} | 30💰!`);
    }
    return;
  }

  if (cmd === 'soru') {
    const questions = [
      { q: 'Türkiye\'nin başkenti?', a: 'ankara' },
      { q: 'Güneş sistemindeki en büyük gezegen?', a: 'jüpiter' },
      { q: 'İnsan vücudunda kaç kemik var?', a: '206' },
      { q: 'Suyun kimyasal formülü?', a: 'h2o' },
      { q: 'Dünyanın en uzun nehri?', a: 'nil' }
    ];
    const q = questions[Math.floor(Math.random() * questions.length)];
    await sendChat(`🧠 Soru: ${q.q}`);
    if (params.join(' ').toLowerCase() === q.a) {
      addCredits(username, 40);
      await sendChat(`🧠 @${username} doğru cevap! ${q.a} | 40💰!`);
    }
    return;
  }

  // ═══════════════════════════════════════════
  // KATEGORI 5: EVLİLİK & SOSYAL
  // ═══════════════════════════════════════════

  if (cmd === 'evlen') {
    const target = params[0] ? params[0].replace('@', '') : null;
    if (!target) { await sendWhisper(userId, 'Kullanım: -evlen @kullanıcı'); return; }
    const u = getUserGameData(username);
    const t = getUserGameData(target);
    if (u.marriedTo) { await sendWhisper(userId, 'Zaten evlisin!'); return; }
    if (t.marriedTo) { await sendWhisper(userId, `${target} zaten evli!`); return; }
    if (username === target) { await sendWhisper(userId, 'Kendinle evlenemezsin!'); return; }
    t.marriage = { from: username, time: Date.now() };
    saveGameData(gameData);
    await sendChat(`💍 @${username} @${target}'e evlenme teklifi etti! Kabul için: -kabul | Red için: -red`);
    return;
  }

  if (cmd === 'kabul') {
    const u = getUserGameData(username);
    if (!u.marriage) { await sendWhisper(userId, 'Bekleyen teklif yok!'); return; }
    const from = u.marriage.from;
    const t = getUserGameData(from);
    u.marriedTo = from;
    u.marriage = null;
    t.marriedTo = username;
    t.marriage = null;
    saveGameData(gameData);
    await sendChat(`💒 @${username} @${from} ile evlendi! Tebrikler! 🎉`);
    return;
  }

  if (cmd === 'red') {
    const u = getUserGameData(username);
    if (!u.marriage) { await sendWhisper(userId, 'Bekleyen teklif yok!'); return; }
    const from = u.marriage.from;
    u.marriage = null;
    saveGameData(gameData);
    await sendChat(`💔 @${username} @${from}'ın teklifini reddetti!`);
    return;
  }

  if (cmd === 'bosan' || cmd === 'boşan') {
    const u = getUserGameData(username);
    if (!u.marriedTo) { await sendWhisper(userId, 'Evli değilsin!'); return; }
    const partner = getUserGameData(u.marriedTo);
    const cost = 200;
    if (getCredits(username) < cost) { await sendWhisper(userId, `Boşanma için ${cost}💰 gerekli!`); return; }
    removeCredits(username, cost);
    partner.marriedTo = null;
    u.marriedTo = null;
    saveGameData(gameData);
    await sendChat(`💔 @${username} boşandı! ${cost}💰 harcadı.`);
    return;
  }

  if (cmd === 'evlilikler') {
    const couples = Object.entries(gameData).filter(([_, u]) => u.marriedTo);
    if (couples.length === 0) { await sendChat('💒 Henüz evli çift yok.'); return; }
    let text = '💒 Evli Çiftler:\n';
    couples.slice(0, 10).forEach(([name, u]) => { text += `  💍 ${name} & ${u.marriedTo}\n`; });
    await sendChat(text);
    return;
  }

  if (cmd === 'afk') {
    const u = getUserGameData(username);
    u.afk = !u.afk;
    u.afkReason = params.join(' ') || '';
    saveGameData(gameData);
    if (u.afk) { await sendChat(`💤 @${username} AFK moduna geçti. ${u.afkReason ? '(' + u.afkReason + ')' : ''}`); }
    else { await sendChat(`✅ @${username} AFK'dan döndü!`); }
    return;
  }

  if (cmd === 'burc') {
    const burclar = ['Koç', 'Boğa', 'İkizler', 'Yengeç', 'Aslan', 'Başak', 'Terazi', 'Akrep', 'Yay', 'Oğlak', 'Kova', 'Balık'];
    const burc = burclar[Math.floor(Math.random() * burclar.length)];
    await sendChat(`🔮 @${username}'in burcu: ${burc}`);
    return;
  }

  if (cmd === 'fal') {
    const falar = [
      'Bugün şanslı bir günün! 🍀',
      'Bir sürpriz seni bekliyor! 🎁',
      'Aşk kapını çalacak! 💕',
      'Bir yolculuk planla! ✈️',
      'Yeni bir arkadaş edineceksin! 🤝',
      'Maddi açıdan güzel bir gün! 💰',
      'Bir mektup alacaksın! 💌',
      'Sağlığına dikkat et! 💪'
    ];
    const fal = falar[Math.floor(Math.random() * falar.length)];
    await sendChat(`☕ @${username}'in falı: ${fal}`);
    return;
  }

  if (cmd === 'sevgi') {
    const target = params[0] ? params[0].replace('@', '') : null;
    if (!target) { await sendWhisper(userId, 'Kullanım: -sevgi @kullanıcı'); return; }
    const hearts = ['❤️', '💕', '💖', '💗', '💓'];
    const heart = hearts[Math.floor(Math.random() * hearts.length)];
    await sendChat(`${heart} @${username} @${target} için kalp gönderdi! ${heart}`);
    return;
  }

  if (cmd === 'saril' || cmd === 'sarıl') {
    const target = params[0] ? params[0].replace('@', '') : null;
    if (!target) { await sendWhisper(userId, 'Kullanım: -saril @kullanıcı'); return; }
    await sendChat(`🤗 @${username} @${target}'i kucakladı!`);
    return;
  }

  if (cmd === 'op' || cmd === 'öp') {
    const target = params[0] ? params[0].replace('@', '') : null;
    if (!target) { await sendWhisper(userId, 'Kullanım: -op @kullanıcı'); return; }
    await sendChat(`💋 @${username} @${target}'i öptü!`);
    return;
  }

  // ═══════════════════════════════════════════
  // KATEGORI 6: HAPİSHANE & CEZA
  // ═══════════════════════════════════════════

  if (cmd === 'haps') {
    if (!isAdmin(username)) { await sendWhisper(userId, 'Yetkiniz yok!'); return; }
    const target = params[0] ? params[0].replace('@', '') : null;
    const dk = parseInt(params[1]) || 5;
    const reason = params.slice(2).join(' ') || 'Kural ihlali';
    if (!target) { await sendWhisper(userId, 'Kullanım: -haps @kullanıcı <dk> <neden>'); return; }
    const t = getUserGameData(target);
    t.jail = true;
    t.jailTime = Date.now() + (dk * 60000);
    t.jailReason = reason;
    saveGameData(gameData);
    await sendChat(`🔒 @${target} ${dk} dakika hapse atıldı! Neden: ${reason}`);
    return;
  }

  if (cmd === 'hapsicikar') {
    if (!isAdmin(username)) { await sendWhisper(userId, 'Yetkiniz yok!'); return; }
    const target = params[0] ? params[0].replace('@', '') : null;
    if (!target) { await sendWhisper(userId, 'Kullanım: -hapsicikar @kullanıcı'); return; }
    const t = getUserGameData(target);
    t.jail = false;
    t.jailTime = 0;
    t.jailReason = '';
    saveGameData(gameData);
    await sendChat(`🔓 @${target} serbest bırakıldı!`);
    return;
  }

  if (cmd === 'jailkefaret') {
    const u = getUserGameData(username);
    if (!u.jail) { await sendWhisper(userId, 'Hapiste değilsin!'); return; }
    const cost = 150;
    if (getCredits(username) < cost) { await sendWhisper(userId, `Kefaret için ${cost}💰 gerekli!`); return; }
    removeCredits(username, cost);
    u.jail = false;
    u.jailTime = 0;
    u.jailReason = '';
    saveGameData(gameData);
    await sendChat(`🔓 @${username} kefalet ödeyerek hapisten çıktı! ${cost}💰 harcadı.`);
    return;
  }

  if (cmd === 'jailset') {
    if (!isAdmin(username)) { await sendWhisper(userId, 'Yetkiniz yok!'); return; }
    await sendChat('🔒 Hapisanesi konumu ayarlandı (yerel).');
    return;
  }

  // ═══════════════════════════════════════════
  // KATEGORI 7: PROFİL, SEVİYE, UNVAN, ROZET
  // ═══════════════════════════════════════════

  if (cmd === 'profil') {
    const target = params[0] ? params[0].replace('@', '') : username;
    const u = getUserGameData(target);
    const married = u.marriedTo ? `💍 ${u.marriedTo}` : 'Bekar';
    const badges = u.badges.length > 0 ? u.badges.join(' ') : 'Yok';
    const stats = u.stats || {};
    const roleTag = isVIP(target) ? '👑VIP' : isAdmin(target) ? '🟣MOD' : '🔵USER';
    await sendWhisper(userId,
      `${roleTag} @${target} Profili:\n` +
      `📊 Seviye: ${u.level} | XP: ${u.xp}/${u.level * 100}\n` +
      `⭐ Rep: ${u.rep}\n` +
      `🏆 Unvan: ${u.title || 'Yok'}\n` +
      `${married}\n` +
      `🏅 Rozetler: ${badges}\n` +
      `⛏️ Maden: Lv.${u.mining.level} | 🎣 Olta: Lv.${u.fishing.level}\n` +
      `💰 Kredi: ${getCredits(target)}\n\n` +
      `📊 İSTATİSTİKLER:\n` +
      `🚶 Yürüme: ${(stats.walk_score || 0).toLocaleString()} adım\n` +
      `💬 Mesaj: ${(stats.message_count || 0).toLocaleString()}\n` +
      `💎 Tip Verilen: ${(stats.tip_given || 0).toLocaleString()} G\n` +
      `🎁 Tip Alınan: ${(stats.tip_received || 0).toLocaleString()} G\n` +
      `🎵 Müzik: ${(stats.music_count || 0).toLocaleString()} şarkı`
    );
    return;
  }

  if (cmd === 'seviye' || cmd === 'level' || cmd === 'lvl') {
    const u = getUserGameData(username);
    const bar = '█'.repeat(Math.floor(u.xp / (u.level * 100) * 10)) + '░'.repeat(10 - Math.floor(u.xp / (u.level * 100) * 10));
    await sendWhisper(userId, `📊 @${username} | Level ${u.level}\n[${bar}] ${u.xp}/${u.level * 100} XP`);
    return;
  }

  if (cmd === 'rep') {
    const target = params[0] ? params[0].replace('@', '') : null;
    if (!target) { await sendWhisper(userId, 'Kullanım: -rep @kullanıcı'); return; }
    const t = getUserGameData(target);
    t.rep++;
    saveGameData(gameData);
    await sendChat(`⭐ @${username} @${target}'e +1 Rep verdi! (Toplam: ${t.rep})`);
    return;
  }

  if (cmd === 'unvanlar') {
    const titles = [
      { name: 'Maden Ustası', cost: 500 },
      { name: 'Balıkçı Kralı', cost: 500 },
      { name: 'Savaşçı', cost: 300 },
      { name: 'Casino Kralı', cost: 750 },
      { name: 'Aşıkların Koruyucusu', cost: 400 },
      { name: 'Kaçak', cost: 200 },
      { name: 'Dedektif', cost: 350 },
      { name: 'Filozof', cost: 600 },
      { name: 'Laf Sokan', cost: 250 },
      { name: 'Cilveli', cost: 300 },
      { name: 'Askdoktoru', cost: 450 },
      { name: 'Serseri', cost: 150 }
    ];
    let text = '👑 Unvan Kataloğu:\n';
    titles.forEach((t, i) => { text += `  ${i + 1}. ${t.name} (${t.cost}💰)\n`; });
    text += '\nSatın al: -unvanal <isim>';
    await sendWhisper(userId, text);
    return;
  }

  if (cmd === 'unvanal') {
    const u = getUserGameData(username);
    const titleName = params.join(' ');
    if (!titleName) { await sendWhisper(userId, 'Kullanım: -unvanal <unvan adı>'); return; }
    const titles = [
      { name: 'Maden Ustası', cost: 500 },
      { name: 'Balıkçı Kralı', cost: 500 },
      { name: 'Savaşçı', cost: 300 },
      { name: 'Casino Kralı', cost: 750 },
      { name: 'Aşıkların Koruyucusu', cost: 400 },
      { name: 'Kaçak', cost: 200 },
      { name: 'Dedektif', cost: 350 },
      { name: 'Filozof', cost: 600 },
      { name: 'Laf Sokan', cost: 250 },
      { name: 'Cilveli', cost: 300 },
      { name: 'Askdoktoru', cost: 450 },
      { name: 'Serseri', cost: 150 }
    ];
    const title = titles.find(t => t.name.toLowerCase() === titleName.toLowerCase());
    if (!title) { await sendWhisper(userId, 'Unvan bulunamadı!'); return; }
    if (getCredits(username) < title.cost) { await sendWhisper(userId, `Yetersiz kredi! Gereken: ${title.cost}💰`); return; }
    removeCredits(username, title.cost);
    u.title = title.name;
    saveGameData(gameData);
    await sendChat(`👑 @${username} "${title.name}" unvanını satın aldı!`);
    return;
  }

  if (cmd === 'unvantak') {
    const u = getUserGameData(username);
    if (!u.title) { await sendWhisper(userId, 'Önce bir unvan satın al: -unvanlar'); return; }
    await sendChat(`👑 @${username} unvanı: ${u.title}`);
    return;
  }

  if (cmd === 'sansum' || cmd === 'sansperks') {
    const u = getUserGameData(username);
    const perks = u.perks.length > 0 ? u.perks.join(', ') : 'Yok';
    await sendWhisper(userId, `🍀 Şans Bonusları: ${perks}`);
    return;
  }

  if (cmd === 'rozetler') {
    const badges = [
      { name: '👑', desc: 'VIP', rarity: 'Efsane' },
      { name: '🔥', desc: 'Aktif', rarity: 'Yaygın' },
      { name: '💎', desc: 'Zengin', rarity: 'Nadir' },
      { name: '⚔️', desc: 'Savaşçı', rarity: 'Nadir' },
      { name: '⛏️', desc: 'Maden Ustası', rarity: 'Nadir' },
      { name: '🎣', desc: 'Balıkçı', rarity: 'Nadir' },
      { name: '🏆', desc: 'Şampiyon', rarity: 'Efsane' },
      { name: '💀', desc: 'Katil', rarity: 'Epic' },
      { name: '🛡️', desc: 'Koruyucu', rarity: 'Yaygın' },
      { name: '🎭', desc: 'Gizemli', rarity: 'Epic' },
      { name: '❤️', desc: 'Aşıkların Koruyucusu', rarity: 'Yaygın' },
      { name: '⚡', desc: 'Hızlı', rarity: 'Yaygın' }
    ];
    let text = '🏅 Rozet Kataloğu:\n';
    badges.forEach((b, i) => { text += `  ${b.name} ${b.desc} [${b.rarity}]\n`; });
    text += '\nSatın al: -rozetal <emoji>';
    await sendWhisper(userId, text);
    return;
  }

  if (cmd === 'rozetal') {
    const u = getUserGameData(username);
    const emoji = params[0];
    if (!emoji) { await sendWhisper(userId, 'Kullanım: -rozetal <emoji>'); return; }
    if (u.badges.includes(emoji)) { await sendWhisper(userId, 'Bu rozeti zaten var!'); return; }
    if (getCredits(username) < 100) { await sendWhisper(userId, 'Rozet için 100💰 gerekli!'); return; }
    removeCredits(username, 100);
    u.badges.push(emoji);
    saveGameData(gameData);
    await sendChat(`🏅 @${username} rozet satın aldı: ${emoji}`);
    return;
  }

  if (cmd === 'rozetak') {
    const u = getUserGameData(username);
    const emoji = params[0];
    if (!emoji || !u.badges.includes(emoji)) { await sendWhisper(userId, 'Bu rozete sahip değilsin!'); return; }
    await sendChat(`🏅 @${username} rozeti taktı: ${emoji}`);
    return;
  }

  if (cmd === 'gorevler') {
    const u = getUserGameData(username);
    const quests = [
      { name: '3 maden kaz', done: (u.miningDone || 0) >= 3 },
      { name: '3 balık tut', done: (u.fishingDone || 0) >= 3 },
      { name: '1 slot oyna', done: (u.slotDone || 0) >= 1 },
      { name: '1 sohbet yaz', done: true }
    ];
    let text = '📋 Günlük Görevler:\n';
    quests.forEach((q, i) => { text += `  ${q.done ? '✅' : '⬜'} ${q.name}\n`; });
    await sendWhisper(userId, text);
    return;
  }

  // ═══════════════════════════════════════════
  // KATEGORI 8: SOSYAL EĞLENCE
  // ═══════════════════════════════════════════

  if (cmd === 'cuzdan' || cmd === 'wallet' || cmd === 'kasa') {
    const u = getUserGameData(username);
    await sendWhisper(userId, `💰 @${username} Cüzdan:\nKredi: ${getCredits(username)}💰\nToplam Kazanılan: ${u.totalEarned || 0}💰`);
    return;
  }

  if (cmd === 'tip') {
    const target = params[0] ? params[0].replace('@', '') : null;
    const miktar = parseInt(params[1]) || 10;
    if (!target) { await sendWhisper(userId, 'Kullanım: -tip @kullanıcı <miktar>'); return; }
    if (getCredits(username) < miktar) { await sendWhisper(userId, 'Yetersiz kredi!'); return; }
    removeCredits(username, miktar);
    addCredits(target, miktar);
    await sendChat(`💰 @${username} @${target}'e ${miktar}💰 bahşiş verdi!`);
    return;
  }

  if (cmd === 'spam') {
    const count = Math.min(parseInt(params[0]) || 3, 10);
    const text = params.slice(1).join(' ') || 'selam';
    for (let i = 0; i < count; i++) {
      await sendChat(`📢 ${text}`);
    }
    return;
  }

  // ═══════════════════════════════════════════
  // YARDIM MENÜSÜ
  // ═══════════════════════════════════════════

  if (cmd === 'yardım' || cmd === 'yardim' || cmd === 'menu') {
    await sendChat(
      '🎮 HIGHRISE BOT 8 KATEGORİLİ YARDIM MENÜSÜ\n\n' +
      '💡 YAPAY ZEKA: . yazarak botla sohbet edin veya komut çalıştırın!\n\n' +
      'İstediğiniz kategori için komutunu doğrudan yazın:\n\n' +
      '1️⃣ !ly1 → Oyunlar & RPG (Maden & Balıkçılık)\n' +
      '2️⃣ !ly2 → Casino, Arena Savaşı, Bomba & Yarışmalar\n' +
      '3️⃣ !ly3 → Yapay Zeka, Profil & Seviye (XP & Rep)\n' +
      '4️⃣ !ly4 → Unvan Kataloğu ve Rozet Pazarı (Şans Perkleri)\n' +
      '5️⃣ !ly5 → Evlilik, AFK & Sosyal Komutlar\n' +
      '6️⃣ !ly6 → Hapisane (Jail) & Ceza Yönetimi\n' +
      '7️⃣ !ly8 → Admin & Duyuru Yönetimi\n\n' +
      '🎵 Müzik komutları için: -help\n' +
      'Örnek: Oyunları görmek için !ly1 yazabilirsiniz!'
    );
    return;
  }

  if (cmd === 'ly1' || cmd === 'l1') {
    await sendChat(
      '⛏️ KATEGORİ 1: OYUNLAR & RPG (MADEN & BALIKÇILIK)\n\n' +
      '🪨 MADENLİK RPG:\n' +
      '• !maden / !imine — Maden kaz (7 nadirlik seviyesinde 90+ cevher)\n' +
      '• !kazmam / !kazma — Kazma seviyeni ve özelliklerini gör\n' +
      '• !kazmayukselt — Puanla kazmani seviye 1-5e atlat\n' +
      '• !otomatikmaden — Otomatik maden kazma modunu aç/kapat\n' +
      '• !madenbilgi — Çanta özeti ve cevher listesi\n' +
      '• !madensat — Maden çantandaki cevherleri satıp puan kazan\n\n' +
      '🎣 BALIKÇILIK RPG:\n' +
      '• !balik / !fish — Suda balık tut\n' +
      '• !olta — Olta seviyeni ve özelliklerini gör\n' +
      '• !oltayukselt — Puanla oltanı seviye 1-5e atlat\n' +
      '• !otomatikbalik — Otomatik balık tutma modunu aç/kapat\n' +
      '• !balikbilgi — Balık çantası özeti\n' +
      '• !baliksat — Balık çantandaki balıkları satıp puan kazan\n' +
      '• !hepsinisat — Tüm balık ve maden çantalarını tek tıkla tüccara sat\n\n' +
      '👉 Ana menü için: !yardım'
    );
    return;
  }

  if (cmd === 'ly2' || cmd === 'l2') {
    await sendChat(
      '🎰 KATEGORİ 2: CASINO, ARENA SAVAŞI, BOMBA & YARIŞMALAR\n\n' +
      '💣 SAATLİ BOMBA OYUNU (PANİK & HEYECAN):\n' +
      '• !bomba @kullanıcı — Saatli bomba oyununu başlatır\n' +
      '• !patla @kullanıcı — Elindeki bombayı başkasına fırlat!\n' +
      '• !bombadurum — Bombanın kimde olduğunu ve durumunu gösterir\n' +
      '• !bombaimha — Aktif bombayı imha eder ve oyunu bitirir\n\n' +
      '⚔️ İNTERAKTİF CANLI ARENA DÜELLOSU:\n' +
      '• !sava @kullanıcı — Canlı sıralı arenaya savaş başlatır!\n' +
      '• !savun — Çelik kalkan açar (Kritik Şansı & %25 Ulti enerjisi)\n' +
      '• !ulti — %100 enerjide 50-75 ölümcüllü bitirici vuruş yapar!\n' +
      '• !savasiptal — Bekleyen savaş teklifini geri çeker\n\n' +
      '🎰 CASINO & ŞANS OYUNLARI:\n' +
      '• !bj / !blackjack — Çoklu katımlı Black jack 21 (İhiti, İstay, Double)\n' +
      '• !slot — Slot makinesi oyunu\n' +
      '• !cark / !çark — Günlük şans çarkı\n' +
      '• !bahis — Puan bahşi\n\n' +
      '🏆 YARIŞMALAR & ETKİNLİKLER:\n' +
      '• !vk / !vampirköylü — Vampir Köylü oyunu (3-15 kişi, fasilist rollü)\n' +
      '• !soygun @kullanıcı — Puan soyma denemesi (%50 şans)\n' +
      '• !sayi — Sayı tahmin oyunu\n' +
      '• !kelime — Karışık harf oyunu\n' +
      '• !soru — Bilgi yarışması (318+ Soru)\n\n' +
      '👉 Ana menü için: !yardım'
    );
    return;
  }

  if (cmd === 'ly3' || cmd === 'l3') {
    await sendChat(
      '🧠 KATEGORİ 3: YAPAY ZEKA, PROFİL & SEVİYE\n\n' +
      '🤖 YAPAY ZEKA & NİYET AŞİSTİ:\n' +
      '• ai veya . — Yapay Zeka ile sohbet et ve et (Örn: .merhaba, .havalar nasıl?)\n' +
      '• !aimood — AI ruh halini değiştir (normal, lascfsok, askdoktoru, cilveli, kabadayi, filozof, dedektif)\n\n' +
      '👤 PROFİL, SEVİYE & İTİBAR:\n' +
      '• !profil — Seviye, Rep, Unvan ve Rozetlerini gösteren kart\n' +
      '• !seviye / !level — XP barı ve seviye durumu\n' +
      '• !rep @kullanıcı / !ltoprep — Kullanıcıya +1 Rep ver / Sıralama\n' +
      '• !bilgi @kullanıcı — Oyuncu kartı ve katılım süresi\n\n' +
      '👉 Ana menü için: !yardım'
    );
    return;
  }

  if (cmd === 'ly4' || cmd === 'l4') {
    await sendChat(
      '👑 KATEGORİ 4: UNVAN KATALOĞU & ROZET PAZARI\n\n' +
      '👑 UNVAN & ŞANS PERKLERİ:\n' +
      '• !unvanlar — 15\'li Prestijli Unvan Kataloğu ve Şans Bonusları\n' +
      '• !unvanal — Puanınla unvan satını al (Örn: !unvanal 1 veya !unvanal 15)\n' +
      '• !unvantak — Kuşanılacak unvanı seç (!unvanlickar)\n' +
      '• !sansum / !perks — Aktif şans ve bonuslarını gör\n\n' +
      '🏅 EMOJİ ROZET PAZARI & MAĞAZA:\n' +
      '• !rozetler — Emoji rozet kataloğu (👑🔥💎⚔️)\n' +
      '• !rozetal & !rozetak — Rozet al / tak\n' +
      '• !gorevler — Günlük görev listesi ve ödüller\n\n' +
      '👉 Ana menü için: !yardım'
    );
    return;
  }

  if (cmd === 'ly5' || cmd === 'l5') {
    await sendChat(
      '💍 KATEGORİ 5: EVLİLİK, AFK & SOSYAL KOMUTLAR\n\n' +
      '💍 EVLİLİK SİSTEMİ:\n' +
      '• !evlen @kullanıcı — Evlilik teklifi et\n' +
      '• !kabul & !red — Evlilik teklifini kabul et / reddet\n' +
      '• !bosan — Evliliği sonlandırır\n' +
      '• !evlilikler — Odadaki evli çiftler listesi\n\n' +
      '💤 SOSYAL, EĞLENCE & AFK:\n' +
      '• !afk [sebep] — AFK moduna geç (Etiketlenenlere bildirim gider)\n' +
      '• !burc — Günlük burcun\n' +
      '• !fal — Kahve falı oku\n' +
      '• !sevgi @kullanıcı — Sevgi yumarı ölçer\n' +
      '• !saril @user & !op @user — Kucakla / Öp\n\n' +
      '👉 Ana menü için: !yardım'
    );
    return;
  }

  if (cmd === 'ly6' || cmd === 'l6') {
    await sendChat(
      '🔒 KATEGORİ 6: HAPİSHANE (JAIL) & CEZA SİSTEMİ\n\n' +
      '🔒 KEANUSHIELD HAPİSHANE SİSTEMİ:\n' +
      '• !haps @kullanıcı [dk] [neden] — Trolleri hapis alanına kilitler (Işınlanmayı engeller)\n' +
      '• !hapsicikar @kullanıcı — Mahkumu serbest bırakır\n' +
      '• !jailkefaret — Kefalet ödeyerek hapisten çık\n' +
      '• !jailset — Hapis alanını mevcut konum yap\n\n' +
      '⚖️ CEZA & MODERASYON:\n' +
      '• !ceza @kullanıcı & !af @kullanıcı — Ceza alanı ışınlama / affetme\n\n' +
      '👉 Ana menü için: !yardım'
    );
    return;
  }

  // ═══════════════════════════════════════════
  // 🏆 LİDERLİK TABLOSU - !top
  // ═══════════════════════════════════════════

  if (cmd === 'top' || cmd === 'sıralama' || cmd === 'leaderboard') {
    const category = (params[0] || 'all').toLowerCase();
    const allUsers = Object.entries(gameData).filter(([_, u]) => u.stats);

    function getTop(key, label, emoji, isCurrency = false) {
      const sorted = allUsers
        .map(([name, u]) => ({ name, value: u.stats[key] || 0 }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 5);
      if (sorted.length === 0) return `${emoji} ${label}: Henüz veri yok\n`;
      let text = `${emoji} ${label}:\n`;
      const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
      sorted.forEach((s, i) => {
        const display = isCurrency ? `${s.value.toLocaleString()} G` : s.value.toLocaleString();
        text += `${medals[i]} @${s.name} — ${display}\n`;
      });
      return text + '\n';
    }

    function getMedal(i) { return ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][i]; }

    if (category === 'walk' || category === 'yürüme' || category === 'adım') {
      const sorted = allUsers.map(([n, u]) => ({ n, v: u.stats.walk_score || 0 })).sort((a, b) => b.v - a.v).slice(0, 5);
      let text = '🚶 EN ÇOK YÜRÜYEN:\n';
      sorted.forEach((s, i) => text += `${getMedal(i)} @${s.n} — ${s.v.toLocaleString()} adım\n`);
      if (sorted.length === 0) text += '  Veri yok\n';
      await sendChat(text);
      return;
    }

    if (category === 'chat' || category === 'mesaj') {
      const sorted = allUsers.map(([n, u]) => ({ n, v: u.stats.message_count || 0 })).sort((a, b) => b.v - a.v).slice(0, 5);
      let text = '💬 EN ÇOK MESAJ YAZAN:\n';
      sorted.forEach((s, i) => text += `${getMedal(i)} @${s.n} — ${s.v.toLocaleString()} mesaj\n`);
      if (sorted.length === 0) text += '  Veri yok\n';
      await sendChat(text);
      return;
    }

    if (category === 'tip' || category === 'bahsis') {
      const sortedGiven = allUsers.map(([n, u]) => ({ n, v: u.stats.tip_given || 0 })).sort((a, b) => b.v - a.v).slice(0, 5);
      let text = '💎 EN ÇOK TIP VEREN:\n';
      sortedGiven.forEach((s, i) => text += `${getMedal(i)} @${s.n} — ${s.v.toLocaleString()} G\n`);
      if (sortedGiven.length === 0) text += '  Veri yok\n';
      text += '\n🎁 EN ÇOK TIP ALAN:\n';
      const sortedReceived = allUsers.map(([n, u]) => ({ n, v: u.stats.tip_received || 0 })).sort((a, b) => b.v - a.v).slice(0, 5);
      sortedReceived.forEach((s, i) => text += `${getMedal(i)} @${s.n} — ${s.v.toLocaleString()} G\n`);
      if (sortedReceived.length === 0) text += '  Veri yok\n';
      await sendChat(text);
      return;
    }

    if (category === 'music' || category === 'müzik') {
      const sorted = allUsers.map(([n, u]) => ({ n, v: u.stats.music_count || 0 })).sort((a, b) => b.v - a.v).slice(0, 5);
      let text = '🎵 EN ÇOK MÜZİK AÇAN:\n';
      sorted.forEach((s, i) => text += `${getMedal(i)} @${s.n} — ${s.v.toLocaleString()} şarkı\n`);
      if (sorted.length === 0) text += '  Veri yok\n';
      await sendChat(text);
      return;
    }

    if (category === 'punch' || category === 'yumruk') {
      const sorted = allUsers.map(([n, u]) => ({ n, v: u.stats.punch_count || 0 })).sort((a, b) => b.v - a.v).slice(0, 5);
      let text = '👊 EN ÇOK YUMRUK ATAN:\n';
      sorted.forEach((s, i) => text += `${getMedal(i)} @${s.n} — ${s.v.toLocaleString()} yumruk\n`);
      if (sorted.length === 0) text += '  Veri yok\n';
      await sendChat(text);
      return;
    }

    // Genel top - tüm kategoriler
    const sortedWalk = allUsers.map(([n, u]) => ({ n, v: u.stats.walk_score || 0 })).sort((a, b) => b.v - a.v).slice(0, 5);
    const sortedChat = allUsers.map(([n, u]) => ({ n, v: u.stats.message_count || 0 })).sort((a, b) => b.v - a.v).slice(0, 5);
    const sortedTipG = allUsers.map(([n, u]) => ({ n, v: u.stats.tip_given || 0 })).sort((a, b) => b.v - a.v).slice(0, 5);
    const sortedTipR = allUsers.map(([n, u]) => ({ n, v: u.stats.tip_received || 0 })).sort((a, b) => b.v - a.v).slice(0, 5);
    const sortedMusic = allUsers.map(([n, u]) => ({ n, v: u.stats.music_count || 0 })).sort((a, b) => b.v - a.v).slice(0, 5);

    let text = '🏆 ODA LİDERLERİ:\n\n';

    text += '🚶 En çok yürüyen:\n';
    sortedWalk.forEach((s, i) => text += `${getMedal(i)} @${s.n} — ${s.v.toLocaleString()} adım\n`);
    if (!sortedWalk.length) text += '  Veri yok\n';

    text += '\n💬 En çok mesaj:\n';
    sortedChat.forEach((s, i) => text += `${getMedal(i)} @${s.n} — ${s.v.toLocaleString()} mesaj\n`);
    if (!sortedChat.length) text += '  Veri yok\n';

    text += '\n💎 En çok tip veren:\n';
    sortedTipG.forEach((s, i) => text += `${getMedal(i)} @${s.n} — ${s.v.toLocaleString()} G\n`);
    if (!sortedTipG.length) text += '  Veri yok\n';

    text += '\n🎁 En çok tip alan:\n';
    sortedTipR.forEach((s, i) => text += `${getMedal(i)} @${s.n} — ${s.v.toLocaleString()} G\n`);
    if (!sortedTipR.length) text += '  Veri yok\n';

    text += '\n🎵 En çok müzik açan:\n';
    sortedMusic.forEach((s, i) => text += `${getMedal(i)} @${s.n} — ${s.v.toLocaleString()} şarkı\n`);
    if (!sortedMusic.length) text += '  Veri yok\n';

    text += '\n📊 Kategori bazlı: !top walk/chat/tip/music/punch';
    await sendChat(text);
    return;
  }

  // ═══════════════════════════════════════════
  // 🚫 KARA LİSTE YÖNETİMİ
  // ═══════════════════════════════════════════

  if (cmd === 'blacklist' || cmd === 'kara' || cmd === 'karaliste') {
    const action = params[0];

    if (action === 'ekle' || action === 'add') {
      if (!isVIP(username) && !isAdmin(username)) {
        await sendWhisper(userId, '⛔ Kara listeyi sadece VIP ve Oda Sahibi düzenleyebilir!');
        return;
      }
      const title = params.slice(1).join(' ');
      if (!title) {
        await sendWhisper(userId, 'Kullanım: -blacklist ekle <şarkı adı>');
        return;
      }
      if (addToBlacklist(title, username)) {
        await sendChat(`🚫 "${title}" kara listeye eklendi! (Ekleyen: @${username})`);
        if (currentSong && currentSong.title.toLowerCase().includes(title.toLowerCase())) {
          await sendChat(`🚫 Çalınan şarkı da kara listede! Atlanıyor...`);
          stopDecoder();
          if (queue.length > 0) {
            const next = queue.shift();
            setTimeout(() => playSong(next), 500);
            await sendChat(`🎵 Sıradaki: ${next.title}`);
          } else {
            startSilenceInterval();
          }
        }
      } else {
        await sendWhisper(userId, `"${title}" zaten kara listede!`);
      }
      return;
    }

    if (action === 'sil' || action === 'remove') {
      if (!isVIP(username) && !isAdmin(username)) {
        await sendWhisper(userId, '⛔ Kara listeyi sadece VIP ve Oda Sahibi düzenleyebilir!');
        return;
      }
      const title = params.slice(1).join(' ');
      if (!title) {
        await sendWhisper(userId, 'Kullanım: -blacklist sil <şarkı adı>');
        return;
      }
      if (removeFromBlacklist(title)) {
        await sendChat(`✅ "${title}" kara listeden çıkarıldı!`);
      } else {
        await sendWhisper(userId, `"${title}" kara listede bulunamadı!`);
      }
      return;
    }

    if (action === 'liste' || action === 'list') {
      if (blacklist.songs.length === 0) {
        await sendChat('🚫 Kara liste boş.');
        return;
      }
      let text = `🚫 KARA LİSTE (${blacklist.songs.length} şarkı):\n`;
      blacklist.songs.slice(0, 15).forEach((s, i) => {
        const added = blacklist.addedBy[s] ? ` (@${blacklist.addedBy[s]})` : '';
        text += `  ${i + 1}. ${s}${added}\n`;
      });
      if (blacklist.songs.length > 15) text += `  ... ve ${blacklist.songs.length - 15} daha`;
      await sendWhisper(userId, text);
      return;
    }

    if (action === 'temizle' || action === 'clear') {
      if (!isAdmin(username)) {
        await sendWhisper(userId, '⛔ Bu komut sadece Oda Sahibi için!');
        return;
      }
      blacklist = { songs: [], addedBy: {} };
      saveBlacklist(blacklist);
      await sendChat('🗑️ Kara liste tamamen temizlendi!');
      return;
    }

    await sendWhisper(userId,
      '🚫 KARA LİSTE YÖNETİMİ:\n' +
      '-blacklist ekle <şarkı> — Şarkı ekle\n' +
      '-blacklist sil <şarkı> — Şarkı çıkar\n' +
      '-blacklist liste — Kara listeyi göster\n' +
      '-blacklist temizle — Tümünü temizle (sadece owner)\n\n' +
      '⚠️ VIP ve Oda Sahibi düzenleyebilir.'
    );
    return;
  }

  if (cmd === 'ly8' || cmd === 'l8') {
    await sendChat(
      '⚙️ KATEGORİ 8: ADMIN & DUYURU YÖNETİMİ\n\n' +
      '📢 OTOMATİK DUYURU YÖNETİMİ:\n' +
      '• !duyuru <mesaj> — Anlık duyuru gönder\n' +
      '• !loop <saniye> <mesaj> — Otomatik tekrarla\n' +
      '• !stoploop — Otomatik tekrarı durdur\n\n' +
      '🔒 ADMIN ARAÇLARI:\n' +
      '• freeze/unfreeze @user — Kullanıcıyı dondur/serbest bırak\n' +
      '• pull/summ @user — Yanınıza çek\n' +
      '• pullall — Herkesi yanınıza çek\n' +
      '• clearall — Tüm dans döngülerini durdur\n' +
      '• add @user — Admin ata (sahip)\n\n' +
      '👉 Ana menü için: !yardım'
    );
    return;
  }

  // ═══════════════════════════════════════════
  // 🎭 DANCE / EMOTE COMMANDS
  // ═══════════════════════════════════════════
  if (cmd === 'dans' || cmd === 'dance' || cmd === 'emote') {
    if (frozenUsers[userId] || jailedUsers[userId]) { await sendWhisper(userId, '⚠️ Bu durumda dans yapamazsın!'); return; }
    if (!params[0]) { await sendWhisper(userId, 'Kullanım: -dans <isim/numara> | -dansliste | -dur'); return; }
    const query = params.join(' ');
    const dance = findDance(query);
    if (!dance) { await sendWhisper(userId, `"${query}" bulunamadı! -dansliste ile listele.`); return; }
    const targetUser = params.find(p => p.startsWith('@'));
    const targetId = targetUser ? (await findUserId(targetUser.slice(1))) : userId;
    if (!targetId) { await sendWhisper(userId, 'Kullanıcı bulunamadı!'); return; }
    await playEmoteLoop(targetId, dance.id, dance.duration);
    await sendChat(neonFormat(`🎭 @${targetUser ? targetUser.slice(1) : username} "${dance.name}" dansını yapıyor! (${dance.duration}s)`));
    return;
  }

  if (cmd === 'dansliste' || cmd === 'danslar' || cmd === 'list') {
    const chunks = [];
    for (let i = 0; i < dances.length; i += 25) chunks.push(dances.slice(i, i + 25));
    const page = parseInt(params[0]) || 0;
    if (page >= chunks.length) { await sendWhisper(userId, `Sayfa ${page + 1} yok! Toplam: ${chunks.length}`); return; }
    let text = `🎭 DANS LİSTESİ (${dances.length} emote) — Sayfa ${page + 1}/${chunks.length}:\n`;
    chunks[page].forEach((d, i) => {
      text += `${d.index}. ${d.name} (${d.duration}s)\n`;
    });
    await sendWhisper(userId, text);
    return;
  }

  if (cmd === 'dur' || cmd === 'stop') {
    const targetUser = params[0] && params[0].startsWith('@') ? params[0].slice(1) : null;
    if (targetUser && isAdmin(username)) {
      const targetId = await findUserId(targetUser);
      if (targetId) { stopEmoteLoop(targetId); await sendChat(`🎭 @${targetUser}'un dansı durduruldu!`); }
    } else {
      stopEmoteLoop(userId);
      try { await client.user.emote(userId, 'idle-lookup'); } catch(e) {}
      await sendWhisper(userId, '🎭 Dansın durduruldu!');
    }
    return;
  }

  if (cmd === 'duo') {
    if (!params[0] || !params.find(p => p.startsWith('@'))) {
      await sendWhisper(userId, 'Kullanım: -duo <emote> @kullanıcı');
      return;
    }
    const emoteQuery = params.filter(p => !p.startsWith('@')).join(' ');
    const targetMention = params.find(p => p.startsWith('@'));
    const targetName = targetMention.slice(1);
    const targetId = await findUserId(targetName);
    if (!targetId) { await sendWhisper(userId, 'Kullanıcı bulunamadı!'); return; }
    const dance = emoteQuery ? findDance(emoteQuery) : dances[Math.floor(Math.random() * dances.length)];
    if (!dance) { await sendWhisper(userId, `"${emoteQuery}" bulunamadı!`); return; }
    await playEmoteLoop(userId, dance.id, dance.duration);
    await playEmoteLoop(targetId, dance.id, dance.duration);
    await sendChat(neonFormat(`🎭 @${username} ve @${targetName} birlikte "${dance.name}" yapıyor! 💃🕺`));
    return;
  }

  if (cmd === 'duoversus' || cmd === 'duo-versus') {
    if (params.length < 3 || !params.find(p => p.startsWith('@'))) {
      await sendWhisper(userId, 'Kullanım: -duoversus <emote1> <emote2> @kullanıcı');
      return;
    }
    const emote1 = params[0];
    const emote2 = params.filter(p => !p.startsWith('@') && p !== emote1).slice(0, 1).join(' ') || params[1];
    const targetMention = params.find(p => p.startsWith('@'));
    const targetName = targetMention.slice(1);
    const targetId = await findUserId(targetName);
    if (!targetId) { await sendWhisper(userId, 'Kullanıcı bulunamadı!'); return; }
    const d1 = findDance(emote1);
    const d2 = findDance(emote2);
    if (!d1 || !d2) { await sendWhisper(userId, 'Emote bulunamadı!'); return; }
    await playEmoteLoop(userId, d1.id, d1.duration);
    await playEmoteLoop(targetId, d2.id, d2.duration);
    await sendChat(neonFormat(`🎭 VERSUS! @${username} "${d1.name}" vs @${targetName} "${d2.name}"! ⚡`));
    return;
  }

  if (cmd === 'botdans' || cmd === 'botdance') {
    if (!isAdmin(username)) { await sendWhisper(userId, 'Yetkiniz yok!'); return; }
    if (botDanceInterval) { clearInterval(botDanceInterval); botDanceInterval = null; }
    botDanceInterval = setInterval(async () => {
      const d = dances[Math.floor(Math.random() * dances.length)];
      try { await client.user.emote(BOT_USER_ID, d.id); } catch(e) {}
    }, 6000);
    await sendChat('🤖 Bot rastgele dans etmeye başladı!');
    return;
  }

  if (cmd === 'botdur' || cmd === 'botstop') {
    if (!isAdmin(username)) { await sendWhisper(userId, 'Yetkiniz yok!'); return; }
    if (botDanceInterval) { clearInterval(botDanceInterval); botDanceInterval = null; }
    try { await client.user.emote(BOT_USER_ID, 'idle-lookup'); } catch(e) {}
    await sendChat('🤖 Bot dansı durduruldu!');
    return;
  }

  // ═══════════════════════════════════════════
  // 🔒 ADMIN MODERATION COMMANDS
  // ═══════════════════════════════════════════
  if (cmd === 'freeze') {
    if (!isAdmin(username)) { await sendWhisper(userId, 'Yetkiniz yok!'); return; }
    const targetMention = params.find(p => p.startsWith('@'));
    if (!targetMention) { await sendWhisper(userId, 'Kullanım: freeze @kullanıcı'); return; }
    const targetName = targetMention.slice(1);
    const targetId = await findUserId(targetName);
    if (!targetId) { await sendWhisper(userId, 'Kullanıcı bulunamadı!'); return; }
    frozenUsers[targetId] = true;
    await sendChat(`🔒 @${targetName} donduruldu!`);
    return;
  }

  if (cmd === 'unfreeze') {
    if (!isAdmin(username)) { await sendWhisper(userId, 'Yetkiniz yok!'); return; }
    const targetMention = params.find(p => p.startsWith('@'));
    if (!targetMention) { await sendWhisper(userId, 'Kullanım: unfreeze @kullanıcı'); return; }
    const targetName = targetMention.slice(1);
    const targetId = await findUserId(targetName);
    if (targetId) delete frozenUsers[targetId];
    await sendChat(`🔓 @${targetName} serbest bırakıldı!`);
    return;
  }

  if (cmd === 'pull' || cmd === 'summ') {
    if (!isAdmin(username)) { await sendWhisper(userId, 'Yetkiniz yok!'); return; }
    const targetMention = params.find(p => p.startsWith('@'));
    if (!targetMention) { await sendWhisper(userId, 'Kullanım: pull @kullanıcı'); return; }
    const targetName = targetMention.slice(1);
    const targetId = await findUserId(targetName);
    if (!targetId) { await sendWhisper(userId, 'Kullanıcı bulunamadı!'); return; }
    try {
      const raw = await client.room.players.fetch();
      const me = raw.find(([u]) => u.id === BOT_USER_ID);
      if (me) {
        const [, pos] = me;
        await client.user.setPosition(targetId, pos.x, pos.y, pos.z, pos.facing || 'FrontRight');
        await sendChat(`📍 @${targetName} yanınıza çekildi!`);
      }
    } catch(e) { await sendWhisper(userId, 'Hata: ' + e.message); }
    return;
  }

  if (cmd === 'pullall') {
    if (!isAdmin(username)) { await sendWhisper(userId, 'Yetkiniz yok!'); return; }
    try {
      const raw = await client.room.players.fetch();
      const me = raw.find(([u]) => u.id === BOT_USER_ID);
      if (me) {
        const [, pos] = me;
        let count = 0;
        for (const [u, p] of raw) {
          if (u.id !== BOT_USER_ID && u.id !== userId) {
            try { await client.user.setPosition(u.id, pos.x + Math.random() * 2 - 1, pos.y, pos.z + Math.random() * 2 - 1, 'FrontRight'); count++; } catch(e) {}
          }
        }
        await sendChat(`📍 ${count} kullanıcı yanınıza çekildi!`);
      }
    } catch(e) { await sendWhisper(userId, 'Hata: ' + e.message); }
    return;
  }

  if (cmd === 'clearall') {
    if (!isAdmin(username)) { await sendWhisper(userId, 'Yetkiniz yok!'); return; }
    stopAllEmoteLoops();
    try {
      const raw = await client.room.players.fetch();
      for (const [u] of raw) {
        if (u.id !== BOT_USER_ID) {
          try { await client.user.emote(u.id, 'idle-lookup'); } catch(e) {}
        }
      }
    } catch(e) {}
    await sendChat('🧹 Tüm dans döngüleri durduruldu!');
    return;
  }

  if (cmd === 'add') {
    if (username !== ADMINS[0]) { await sendWhisper(userId, 'Sadece sahip admin atayabilir!'); return; }
    const targetMention = params.find(p => p.startsWith('@'));
    if (!targetMention) { await sendWhisper(userId, 'Kullanım: add @kullanıcı'); return; }
    const targetName = targetMention.slice(1);
    if (!ADMINS.includes(targetName)) {
      ADMINS.push(targetName);
      await sendChat(`⭐ @${targetName} admin olarak atandı!`);
    } else {
      await sendWhisper(userId, 'Bu kullanıcı zaten admin!');
    }
    return;
  }

  // ═══════════════════════════════════════════
  // 📢 ANNOUNCEMENT COMMANDS
  // ═══════════════════════════════════════════
  if (cmd === 'duyuru') {
    if (!isAdmin(username)) { await sendWhisper(userId, 'Yetkiniz yok!'); return; }
    const text = params.join(' ');
    if (!text) { await sendWhisper(userId, 'Kullanım: !duyuru <mesaj>'); return; }
    await sendChat(`📢 DUYURU: ${text}`);
    return;
  }

  if (cmd === 'loop') {
    if (!isAdmin(username)) { await sendWhisper(userId, 'Yetkiniz yok!'); return; }
    const interval = parseInt(params[0]);
    const text = params.slice(1).join(' ');
    if (!interval || !text || interval < 10) { await sendWhisper(userId, 'Kullanım: !loop <saniye (min 10)> <mesaj>'); return; }
    if (autoAnnounceInterval) clearInterval(autoAnnounceInterval);
    autoAnnounceMessage = text;
    autoAnnounceIntervalMs = interval * 1000;
    autoAnnounceInterval = setInterval(async () => { await sendChat(autoAnnounceMessage); }, autoAnnounceIntervalMs);
    await sendChat(`📢 Otomatik duyuru başlatıldı: her ${interval} saniyede "${text}"`);
    return;
  }

  if (cmd === 'stoploop') {
    if (!isAdmin(username)) { await sendWhisper(userId, 'Yetkiniz yok!'); return; }
    if (autoAnnounceInterval) { clearInterval(autoAnnounceInterval); autoAnnounceInterval = null; }
    await sendChat('📢 Otomatik duyuru durduruldu!');
    return;
  }

  // ═══════════════════════════════════════════
  // 🎴 BLACKJACK COMMANDS
  // ═══════════════════════════════════════════
  if (cmd === 'bj' || cmd === 'blackjack') {
    const bet = parseInt(params[0]) || 50;
    const u = getUserGameData(username);
    if (u.wallet < bet) { await sendWhisper(userId, `Yetersiz bakiye! Cüzdan: ${u.wallet} Puan`); return; }
    if (blackjackGames[userId]) { await sendWhisper(userId, 'Zaten bir blackjack oyunun var! -hit veya -stay yaz.'); return; }
    const deck = createDeck();
    const playerHand = [deck.pop(), deck.pop()];
    const dealerHand = [deck.pop(), deck.pop()];
    u.wallet -= bet;
    saveGameData(gameData);
    const pScore = handScore(playerHand);
    const dScore = handScore(dealerHand);
    if (pScore === 21) {
      const winnings = Math.floor(bet * 2.5);
      u.wallet += winnings;
      saveGameData(gameData);
      await sendChat(neonFormat(`🃏 BLACKJACK! @${username} 21'e ulaştı! +${winnings} Puan 💰`));
      return;
    }
    blackjackGames[userId] = { deck, playerHand, dealerHand, bet, doubled: false };
    await sendChat(neonFormat(`🃏 BLACKJACK — @${username} | Senin: ${formatHand(playerHand)} (${pScore}) | Dealer: ${formatCard(dealerHand[0])} ?`));
    await sendWhisper(userId, `-hit = kart çek | -stay = dur | -double = ikiye katla`);
    return;
  }

  if (cmd === 'hit') {
    const game = blackjackGames[userId];
    if (!game) { await sendWhisper(userId, 'Aktif blackjack oyunun yok! -bj ile başla.'); return; }
    game.playerHand.push(game.deck.pop());
    const score = handScore(game.playerHand);
    if (score > 21) {
      delete blackjackGames[userId];
      const u = getUserGameData(username);
      saveGameData(gameData);
      await sendChat(neonFormat(`🃏 @${username} BUST! ${formatHand(game.playerHand)} (${score}) — Kaybetti! 💸`));
    } else if (score === 21) {
      await resolveBlackjack(userId, username);
    } else {
      await sendWhisper(userId, `Senin: ${formatHand(game.playerHand)} (${score}) | -hit veya -stay`);
    }
    return;
  }

  if (cmd === 'stay') {
    const game = blackjackGames[userId];
    if (!game) { await sendWhisper(userId, 'Aktif blackjack oyunun yok!'); return; }
    await resolveBlackjack(userId, username);
    return;
  }

  if (cmd === 'double') {
    const game = blackjackGames[userId];
    if (!game) { await sendWhisper(userId, 'Aktif blackjack oyunun yok!'); return; }
    if (game.doubled || game.playerHand.length > 2) { await sendWhisper(userId, 'Sadece ilk turda ikiye katabilirsin!'); return; }
    const u = getUserGameData(username);
    if (u.wallet < game.bet) { await sendWhisper(userId, 'Yetersiz bakiye!'); return; }
    u.wallet -= game.bet;
    game.bet *= 2;
    game.doubled = true;
    game.playerHand.push(game.deck.pop());
    saveGameData(gameData);
    const score = handScore(game.playerHand);
    if (score > 21) {
      delete blackjackGames[userId];
      await sendChat(neonFormat(`🃏 @${username} DOUBLE BUST! ${formatHand(game.playerHand)} (${score}) — Kaybetti! 💸`));
    } else {
      await resolveBlackjack(userId, username);
    }
    return;
  }

  // ═══════════════════════════════════════════
  // 🪓 HANGMAN (ADAM ASMACA)
  // ═══════════════════════════════════════════
  if (cmd === 'adam' || cmd === 'asmaca') {
    if (hangmanGame && hangmanGame.active) {
      const display = getHangmanDisplay();
      await sendChat(`🪓 ADAM ASMACA: ${display}`);
      await sendWhisper(userId, 'Tek harf veya tam kelime yazarak tahmin et!');
      return;
    }
    startHangman();
    const display = getHangmanDisplay();
    await sendChat(neonFormat(`🪓 ADAM ASMACA BAŞLADI! ${display}`));
    await sendWhisper(userId, 'Tek harf veya tam kelime yazarak tahmin et!');
    return;
  }

  // ═══════════════════════════════════════════
  // 🎮 EXTENDED MINI GAMES
  // ═══════════════════════════════════════════
  if (cmd === 'sayi') {
    if (!params[0]) {
      numberGame = { target: Math.floor(Math.random() * 100) + 1, active: true };
      await sendChat(neonFormat(`🔢 SAYI TAHMİN OYUNU! 1-100 arası bir sayı tuttum! Tahminini yaz!`));
      return;
    }
    if (!numberGame || !numberGame.active) { await sendWhisper(userId, 'Önce !sayi ile oyunu başlat!'); return; }
    const guess = parseInt(params[0]);
    if (isNaN(guess) || guess < 1 || guess > 100) { await sendWhisper(userId, '1-100 arası bir sayı gir!'); return; }
    if (guess === numberGame.target) {
      const u = getUserGameData(username);
      u.wallet = (u.wallet || 0) + 50;
      saveGameData(gameData);
      await sendChat(neonFormat(`🎯 @${username} doğru bildi! Sayı: ${numberGame.target} | +50 Puan 💰`));
      numberGame = null;
    } else if (guess < numberGame.target) {
      await sendChat(`📈 Daha yüksek! (Tahmin: ${guess})`);
    } else {
      await sendChat(`📉 Daha düşük! (Tahmin: ${guess})`);
    }
    return;
  }

  if (cmd === 'kelime' || cmd === 'k') {
    if (!params[0]) {
      const w = wordGameWords[Math.floor(Math.random() * wordGameWords.length)];
      const hint = w[0] + '_ '.repeat(w.length - 1).trim();
      wordGame = { word: w, active: true };
      await sendChat(neonFormat(`📝 KELIME OYUNU! Tahmin: ${hint} (${w.length} harf)`));
      return;
    }
    if (!wordGame || !wordGame.active) { await sendWhisper(userId, 'Önce !kelime ile oyunu başlat!'); return; }
    const guess = params[0].toUpperCase();
    if (guess === wordGame.word) {
      const u = getUserGameData(username);
      u.wallet = (u.wallet || 0) + 40;
      saveGameData(gameData);
      await sendChat(neonFormat(`🎉 @${username} kelimeyi bildi: ${wordGame.word} | +40 Puan 💰`));
      wordGame = null;
    } else {
      let hint = '';
      for (const c of wordGame.word) {
        hint += guess.includes(c) ? c + ' ' : '_ ';
      }
      await sendWhisper(userId, `Yanlış! İpucu: ${hint.trim()}`);
    }
    return;
  }

  // ═══════════════════════════════════════════
  // 🤖 AI PERSONALITY COMMANDS
  // ═══════════════════════════════════════════
  if (cmd === 'aimod') {
    if (!params[0]) {
      let text = `🤖 AKTİF MOD: ${AI_PERSONALITIES[aiMode].name}\n\nMevcut modlar:\n`;
      for (const [key, val] of Object.entries(AI_PERSONALITIES)) {
        text += `  ${key === aiMode ? '👉 ' : '• '}${key} — ${val.name}\n`;
      }
      await sendWhisper(userId, text);
      return;
    }
    const mode = params[0].toLowerCase();
    if (!AI_PERSONALITIES[mode]) { await sendWhisper(userId, 'Geçersiz mod! aimod ile mevcut modları gör.'); return; }
    aiMode = mode;
    await sendChat(`🤖 AI modu "${AI_PERSONALITIES[mode].name}" olarak değiştirildi!`);
    return;
  }

  // ═══════════════════════════════════════════
  // 🔤 FONT STYLE COMMAND
  // ═══════════════════════════════════════════
  if (cmd === 'font') {
    if (!params[0]) { await sendWhisper(userId, 'Kullanım: -font <metin>'); return; }
    const styled = applyFont(params.join(' '));
    await sendChat(styled);
    return;
  }

  // ═══════════════════════════════════════════
  // 📋 EXTENDED HELP MENUS
  // ═══════════════════════════════════════════
  if (cmd === 'ly1' || cmd === 'l1') {
    await sendChat(neonFormat(
      '🎮 KATEGORİ 1: OYUNLAR & RPG\n\n' +
      '⛏️ MADEN: -maden | -kazmam | -kazmayukselt | -otomatikmaden | -madenbilgi | -madensat\n' +
      '🎣 BALIK: -balik | -olta | -oltayukselt | -otomatikbalik | -balikbilgi | -baliksat\n' +
      '💎 SATIŞ: -hepsinisat\n\n' +
      '👉 Sayfa 2: !ly2'
    ));
    return;
  }

  if (cmd === 'ly2' || cmd === 'l2') {
    await sendChat(neonFormat(
      '🎰 KATEGORİ 2: CASINO & ARENA\n\n' +
      '🎰 CASINO: -slot <miktar> | -bj <miktar> | -bahis <miktar> <yazi/tura> | -cark\n' +
      '⚔️ ARENA: -sava @user | -savun | -ulti | -savasiptal\n' +
      '💣 BOMBA: -bomba @user | -patla @user | -bombadurum | -bombaimha\n' +
      '🪓 OYUN: -adam | -sayi | -kelime\n\n' +
      '👉 Sayfa 3: !ly3'
    ));
    return;
  }

  if (cmd === 'ly3' || cmd === 'l3') {
    await sendChat(neonFormat(
      '🤖 KATEGORİ 3: AI & PROFİL\n\n' +
      '🤖 AI: -sor <soru> | -aimod | .roast @user | .diss @user\n' +
      '📊 PROFİL: -profil [@user] | -seviye | -rep @user\n' +
      '🎲 ŞANS: -sansum\n\n' +
      '👉 Sayfa 4: !ly4'
    ));
    return;
  }

  if (cmd === 'ly4' || cmd === 'l4') {
    await sendChat(neonFormat(
      '🏷️ KATEGORİ 4: UNVAN & ROZET\n\n' +
      '👑 UNVAN: -unvanlar | -unvanal <no> | -unvantak <no> | -unvancikar\n' +
      '🏅 ROZET: -rozetler | -rozetal <no> | -rozettak <no> | -rozetcikar <no>\n\n' +
      '👉 Sayfa 5: !ly5'
    ));
    return;
  }

  if (cmd === 'ly5' || cmd === 'l5') {
    await sendChat(neonFormat(
      '💕 KATEGORİ 5: EVLİLİK & SOSYAL\n\n' +
      '💍 EVLİLİK: -evlen @user | -kabul | -red | -bosan | -evlilikler\n' +
      'AFK: -afk [sebep]\n' +
      '💫 SOSYAL: -sevgi @user | -saril @user | -op @user | -burc | -fal\n\n' +
      '👉 Sayfa 6: !ly6'
    ));
    return;
  }

  if (cmd === 'ly6' || cmd === 'l6') {
    await sendChat(neonFormat(
      '🔒 KATEGORİ 6: HAPİSHANE & CEZA\n\n' +
      '⛓️ HAPİS: -haps @user [dk] [sebep] | -hapsicikar @user | -jailkefaret\n' +
      '📋 SİCİL: -sicil | -ceza @user\n\n' +
      '👉 Sayfa 7: !ly7'
    ));
    return;
  }

  if (cmd === 'ly7' || cmd === 'l7') {
    await sendChat(neonFormat(
      '🎭 KATEGORİ 7: DANS & EMOTE\n\n' +
      '🎭 DANS: -dans <isim/no> | -dansliste | -dur | -duo <emote> @user\n' +
      '🤖 BOT: -botdans | -botdur\n' +
      '🔤 FONT: -font <metin>\n\n' +
      '👉 Sayfa 8: !ly8'
    ));
    return;
  }

  // ═══════════════════════════════════════════
  // 🤖 AI ROAST / DISS COMMANDS
  // ═══════════════════════════════════════════
  if (cmd === 'roast') {
    const targetMention = params.find(p => p.startsWith('@'));
    if (!targetMention) { await sendWhisper(userId, 'Kullanım: .roast @kullanıcı'); return; }
    const targetName = targetMention.slice(1);
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) { await sendChat('AI servisi aktif değil!'); return; }
    try {
      const personality = AI_PERSONALITIES[aiMode]?.prompt || 'Sen komik birisin.';
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: `${personality} ${targetName} kullanıcısını komik bir şekilde roast et (alay et). Kırıcı olma, sadece eğlenceli ol. Türkçe. Maksimum 2 cümle.` },
            { role: 'user', content: `${targetName} kişisini roast et` }
          ],
          max_tokens: 80,
          temperature: 0.9
        })
      });
      const data = await response.json();
      const reply = data.choices?.[0]?.message?.content?.trim() || 'Roast hazır değil!';
      await sendChat(neonFormat(`🔥 @${username} @${targetName}'ı roast etti: ${reply}`));
    } catch(e) { await sendChat('AI bağlantı hatası!'); }
    return;
  }

  if (cmd === 'diss') {
    const targetMention = params.find(p => p.startsWith('@'));
    if (!targetMention) { await sendWhisper(userId, 'Kullanım: .diss @kullanıcı'); return; }
    const targetName = targetMention.slice(1);
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) { await sendChat('AI servisi aktif değil!'); return; }
    try {
      const personality = AI_PERSONALITIES[aiMode]?.prompt || 'Sen komik birisin.';
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: `${personality} ${targetName} kullanıcısını komik bir şekilde diss et. Kırıcı olma, sadece eğlenceli ve(iğneleyici ol. Türkçe. Maksimum 2 cümle.` },
            { role: 'user', content: `${targetName} kişisini diss et` }
          ],
          max_tokens: 80,
          temperature: 0.9
        })
      });
      const data = await response.json();
      const reply = data.choices?.[0]?.message?.content?.trim() || 'Diss hazır değil!';
      await sendChat(neonFormat(`💥 @${username} @${targetName}'ı diss etti: ${reply}`));
    } catch(e) { await sendChat('AI bağlantı hatası!'); }
    return;
  }

  // Handle hangman guesses (single letters or full words without prefix)
  if (hangmanGame && hangmanGame.active && !msg.startsWith('-') && !msg.startsWith('!') && !msg.startsWith('.')) {
    const guess = msg.toUpperCase().trim();
    if (guess.length === 1 && /[A-ZÇĞİÖŞÜ]/.test(guess)) {
      if (hangmanGame.guessed.has(guess)) {
        await sendWhisper(userId, `Bu harfi zaten denedin! (${[...hangmanGame.guessed].join(', ')})`);
      } else {
        hangmanGame.guessed.add(guess);
        if (hangmanGame.word.includes(guess)) {
          const display = getHangmanDisplay();
          if (!hangmanGame.word.split('').some(c => !hangmanGame.guessed.has(c))) {
            const u = getUserGameData(username);
            u.wallet = (u.wallet || 0) + 50;
            saveGameData(gameData);
            await sendChat(neonFormat(`🎉 @${username} kelimeyi tamamladı: ${hangmanGame.word} | +50 Puan 💰`));
            hangmanGame = null;
          } else {
            await sendChat(`🪓 ${display} — Doğru harf: ${guess}`);
          }
        } else {
          hangmanGame.wrongGuesses++;
          if (hangmanGame.wrongGuesses >= hangmanGame.maxWrong) {
            await sendChat(`💀 ADAM ASMACA BİTTİ! Cevap: ${hangmanGame.word}`);
            hangmanGame = null;
          } else {
            const display = getHangmanDisplay();
            await sendChat(`🪓 ${display} — Yanlış harf: ${guess}`);
          }
        }
      }
    } else if (guess.length > 1) {
      if (guess === hangmanGame.word) {
        const u = getUserGameData(username);
        u.wallet = (u.wallet || 0) + 50;
        saveGameData(gameData);
        await sendChat(neonFormat(`🎉 @${username} kelimeyi bildi: ${hangmanGame.word} | +50 Puan 💰`));
        hangmanGame = null;
      } else {
        hangmanGame.wrongGuesses++;
        if (hangmanGame.wrongGuesses >= hangmanGame.maxWrong) {
          await sendChat(`💀 ADAM ASMACA BİTTİ! Cevap: ${hangmanGame.word}`);
          hangmanGame = null;
        } else {
          const display = getHangmanDisplay();
          await sendChat(`🪓 ${display} — Yanlış tahmin!`);
        }
      }
    }
  }
});

client.on('playerJoin', async (user) => {
  const username = user.username;
  if (!welcomeGiven[username]) {
    welcomeGiven[username] = true;
    addCredits(username, 100);
  }

  if (encoder && !encoder.killed) {
    const sampleRate = 44100;
    const channels = 2;
    const durationMs = 80;
    const freq = 440;
    const numSamples = Math.floor((sampleRate * durationMs) / 1000);
    const buf = Buffer.alloc(numSamples * channels * 2);
    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const val = Math.sin(2 * Math.PI * freq * t) * 0.02 * 32767;
      const s = Math.max(-32768, Math.min(32767, Math.round(val)));
      buf.writeInt16LE(s, i * 4);
      buf.writeInt16LE(s, i * 4 + 2);
    }
    try { encoder.stdin.write(buf); } catch(e) {}
  }
});

client.on('whisperMessageCreate', async (user, message) => {
  const msg = message.trim();
  const userId = user.id;
  const username = user.username;

  if (!msg.startsWith('!') && !msg.startsWith('-') && !msg.startsWith('.')) return;
  if (!checkCooldown(userId)) return;
  lastCommandUserId = userId;

  const args = msg.slice(1).split(' ');
  const cmd = args[0].toLowerCase();
  const params = args.slice(1);

  if (cmd === 'pin') {
    try {
      const raw = await client.room.players.fetch();
      const me = raw.find(([u]) => u.id === '6a4bb4dffce970fd78a729fe');
      if (me) {
        const [, pos] = me;
        saveBotPosition(pos.x, pos.y, pos.z);
        await sendWhisper(userId, `📌 Pozisyon kaydedildi: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
      } else {
        await sendWhisper(userId, '⚠️ Bot pozisyonu bulunamadı!');
      }
    } catch(e) {
      await sendWhisper(userId, '⚠️ Hata: ' + e.message);
    }
    return;
  }

  if (cmd === 'q' || cmd === 'queue') {
    const ownerName = ADMINS[0];
    if (queue.length === 0 && !currentSong) {
      await sendWhisper(userId, 'Sırada şarkı yok.');
      return;
    }
    if (currentSong) {
      const isCurOwner = currentSong.user === ownerName;
      const isCurVip = isVIP(currentSong.user) && !isCurOwner;
      const tag = isCurOwner ? ' 👑Owner' : isCurVip ? ' ⭐VIP' : '';
      await sendWhisper(userId, `🎵 ŞİMDİ ÇALINIYOR: ${currentSong.title} (@${currentSong.user})${tag}`);
    }
    if (queue.length > 0) {
      await sendWhisper(userId, `🎶 SIRA (${queue.length} şarkı):`);
      for (let i = 0; i < Math.min(queue.length, 10); i++) {
        const s = queue[i];
        const isOwner = s.user === ownerName;
        const isVip = isVIP(s.user) && !isOwner;
        const tag = isOwner ? ' 👑' : isVip ? ' ⭐' : '';
        await sendWhisper(userId, `  ${i+1}. ${s.title} (${s.user})${tag}`);
      }
      if (queue.length > 10) {
        await sendWhisper(userId, `  ... ve ${queue.length - 10} şarkı daha`);
      }
    } else {
      await sendWhisper(userId, 'Sırada başka şarkı yok.');
    }
    return;
  }

  if (cmd === 'np' || cmd === 'nowplaying') {
    if (currentSong) {
      const ownerName = ADMINS[0];
      const isOwner = currentSong.user === ownerName;
      const isVip = isVIP(currentSong.user) && !isOwner;
      const tag = isOwner ? ' 👑Owner' : isVip ? ' ⭐VIP' : '';
      await sendWhisper(userId, `🎵 ÇALINIYOR: ${currentSong.title} (@${currentSong.user})${tag}`);
    } else {
      await sendWhisper(userId, 'Şu an hiçbir şarkı çalmıyor.');
    }
    return;
  }

  if (cmd === 'stop' || cmd === 'dur') {
    if (!isAdmin(username)) { await sendWhisper(userId, 'Yetkiniz yok!'); return; }
    stopDecoder();
    queue = [];
    loopMode = false;
    startSilenceInterval();
    await sendWhisper(userId, '⏹️ Müzik durduruldu!');
    return;
  }

  if (cmd === 'clear') {
    if (!isAdmin(username)) { await sendWhisper(userId, 'Yetkiniz yok!'); return; }
    queue = [];
    await sendWhisper(userId, '🗑️ Sıra temizlendi!');
    return;
  }

  if (cmd === 'skip' || cmd === 's') {
    stopDecoder();
    if (queue.length > 0) {
      const next = queue.shift();
      setTimeout(() => playSong(next), 500);
      await sendWhisper(userId, `⏭️ Atlandı! Sıradaki: ${next.title}`);
    } else {
      startSilenceInterval();
      await sendWhisper(userId, '⏭️ Şarkı atlandı. Sıra bitti.');
    }
    return;
  }

  if (cmd === 'help' || cmd === 'h') {
    await sendWhisper(userId,
      '🎵 MÜZİK: -p | -s | -q | -np | -stop\n' +
      '👗 KIYAFET: -kıyafet | -rastgele | -kaparastgele\n' +
      '👗 KAYIT: -kaydet | -liste | -giy | -sil | -silliste | -çıkar\n' +
      '🎭 DANS: -dans <isim> | -dansliste | -dur | -duo\n' +
      '🎰 OYUN: -bj | -slot | -bahis | -cark | -sayi | -kelime | -adam\n' +
      '🤖 AI: -sor | -aimod | -font\n' +
      '📊 PROFİL: -profil | -seviye | -rep | -unvanlar | -rozetler\n' +
      '💎 MADEN: -maden | -balik | -hepsinisat\n' +
      '💕 SOSYAL: -evlen | -afk | -burc | -fal\n' +
      '📌 TP: !telemenu | !tele | !createtele | !pin\n' +
      '🏆 SKOR: !top | !gorevler\n' +
      '📋 KOMUT: !ly1-!ly8 | !yardım'
    );
    return;
  }
});

process.on('uncaughtException', (err) => console.error('[Process] Hata:', err.message));
process.on('unhandledRejection', (err) => console.error('[Process] Red:', err?.message || err));

console.log('[Bot] Başlatılıyor...');
client.login(HIGHRISE_TOKEN, ROOM_ID);
