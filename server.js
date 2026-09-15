require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const tmi = require('tmi.js');
const fs = require('fs');

const DATA_FILE = __dirname + '/data.json';
// Persistance à deux niveaux :
// 1) Fichier local : rapide, survit à un simple redémarrage du service
// 2) Upstash Redis (si configuré) : survit AUSSI aux redéploiements complets
function loadPersistedSettings(){
  try{ return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch(e){ return {}; }
}
function persistSettingsLocal(channelId, settings){
  try{
    const all = loadPersistedSettings();
    all[channelId] = settings;
    fs.writeFileSync(DATA_FILE, JSON.stringify(all));
  }catch(e){ console.error('Erreur persistance locale :', e.message); }
}

const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();

async function kvGet(key){
  if(!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try{
    const res = await fetch(UPSTASH_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(['GET', key])
    });
    const data = await res.json();
    return data.result ? JSON.parse(data.result) : null;
  }catch(e){ console.error('Upstash GET erreur :', e.message); return null; }
}

async function kvSet(key, value){
  if(!UPSTASH_URL || !UPSTASH_TOKEN) return;
  try{
    const res = await fetch(UPSTASH_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SET', key, JSON.stringify(value)])
    });
    const data = await res.json();
    if(data.error) console.error('Upstash SET a répondu une erreur :', data.error);
  }catch(e){ console.error('Upstash SET erreur :', e.message); }
}

function persistSettings(channelId, settings){
  persistSettingsLocal(channelId, settings);       // sauvegarde immédiate locale
  kvSet('settings:' + channelId, settings).catch(() => {}); // sauvegarde durable externe (en tâche de fond)
}

const CLIENT_ID = (process.env.EXTENSION_CLIENT_ID || '').trim();
const CLIENT_SECRET = (process.env.EXTENSION_CLIENT_SECRET || '').trim(); // "Secret de l'API client Twitch" (différent du secret d'extension)
const SECRET = Buffer.from((process.env.EXTENSION_SECRET || '').trim(), 'base64');
const PORT = process.env.PORT || 8081;

const BOT_USERNAME = process.env.TWITCH_BOT_USERNAME;
const BOT_OAUTH_TOKEN = process.env.TWITCH_BOT_OAUTH_TOKEN; // format: oauth:xxxxxxxx
const CHANNEL_LOGIN = process.env.TWITCH_CHANNEL_LOGIN;     // ex: "oreilyne" (minuscules, sans #)

// TEMPORAIRE : durant Local/Hosted Test, Twitch ne renvoie pas toujours le
// vrai rôle "moderator" pour les comptes testeurs (bug connu côté Twitch,
// corrigé une fois l'extension publiée). Comme seuls les comptes que tu as
// explicitement autorisés peuvent voir l'extension à ce stade, on désactive
// la vérification stricte pour ne pas bloquer les tests.
// ⚠️ Remets ceci à false avant de publier l'extension pour de vrai !
const TESTING_MODE = process.env.TESTING_MODE !== 'false';

const app = express();
app.use(cors());
app.use(express.json());

/* =========================================================
   ÉTAT EN MÉMOIRE (à remplacer par Redis/DB si tu as besoin
   de plusieurs instances serveur ou de persistance au redémarrage)
   ========================================================= */
const channels = new Map();
function getChannel(channelId){
  if(!channels.has(channelId)){
    const defaultSettings = {
      countdownSeconds: 5,        // durée du compte à rebours du give away (dernières secondes)
      giveawayResultDisplaySec: 8,// durée d'affichage du gagnant avant retour à l'écran d'accueil
      gameDefaultDuration: 15,    // durée par défaut proposée pour une manche de mini-jeu
      gameResultDisplaySec: 8,    // durée d'affichage du classement avant retour à l'écran d'accueil
      showLastWinnerBadge: true,  // afficher une petite bulle "dernier gagnant" sur le stream
      gameTotalsAutoResetDays: 30,// reset auto du cumul mini-jeu (0 = jamais automatique)
      reactions: [                // liste illimitée de boutons de réaction (hors confettis et bonk, fixes)
        { glyph: '❤️', speed: 2.2 },
        { glyph: '😄', speed: 2.2 },
        { glyph: '🔥', speed: 2.2 }
      ],
      confettiSpeed: 2.2,          // vitesse propre aux confettis (autonome par rapport aux autres réactions)
      profileMessage: '',          // texte libre affiché dans le profil des viewers (accueil)
      bonkBaseXp: 15,               // xp nécessaire pour passer du niveau 1 au niveau 2
      bonkGrowth: 1.4,              // à quel point chaque niveau demande plus d'xp que le précédent (1 = plat, 2 = très raide)
      bonkMaxLevel: 15,            // niveau max du marteau (pour ne pas devenir énorme)
      bonkLegendMessage: '🏆 {name} est officiellement une LÉGENDE DU BONK ! 🏆', // {name} remplacé automatiquement
      rgbEvents: false,     // contour RGB animé sur les annonces (gagnant du give away, légende du bonk...)
      rgbMinigames: false,  // contour RGB animé sur les résultats du mini-jeu
      rgbAllPanels: false,  // contour RGB animé sur absolument tous les panneaux (sondage, profil, give away en cours...)
      donationUrl: '',            // lien vers la page de don, affiché dans le profil viewer
      donationLabel: '💜 Soutenir la chaîne', // texte affiché sur le bouton de don
      discordUrl: '',              // lien vers le Discord, affiché dans le profil viewer
      discordLabel: '💬 Rejoindre le Discord' // texte affiché sur le bouton Discord
    };
    const persisted = loadPersistedSettings()[channelId];

    channels.set(channelId, {
      poll: null,          // { question, options:[{label,votes}], voters:Set, durationSec, endsAt }
      pollTimer: null,     // setTimeout id de la fin automatique du sondage
      giveaway: null,       // { entrants:Map(userId->name), winner, command, reward, endsAt }
      giveawayTimers: [],   // setTimeout ids en cours (annonces + tirage auto)
      game: null,           // { endsAt, finished, scores:Map(userId->{name,score}) }
      gameTimers: [],        // setTimeout ids en cours pour le mini-jeu (fin auto)
      winners: [],          // historique des gagnants du live en cours : [{name, reward}]
      settings: persisted ? { ...defaultSettings, ...persisted } : defaultSettings,
      gameTotals: new Map(),     // cumul all-time par joueur : userId -> { name, total } (ne se reset PAS entre lives)
      gameTotalsResetAt: null,   // prochaine date de reset automatique (timestamp), calculée au premier score
      viewerStats: new Map(),    // stats perso : userId -> { name, bonkXp, phasmoPoints, clicks:{confetti,reactions,bonk} }
      phasmoGuesses: new Map()   // pronostics en cours : userId -> { name, ghost } (vidé à chaque révélation/nouvelle partie)
    });

    // Si le fichier local n'avait rien (ex: juste après un redéploiement),
    // on va chercher la sauvegarde durable sur Upstash en tâche de fond.
    if(!persisted){
      kvGet('settings:' + channelId).then(saved => {
        if(saved){
          const ch = channels.get(channelId);
          if(ch) Object.assign(ch.settings, saved);
        }
      }).catch(() => {});
    }
  }
  return channels.get(channelId);
}

// Comme le bot de tchat ne connaît que le NOM de la chaîne (pas son ID interne),
// on retient ici quel channelId correspond à cette chaîne pour faire le lien
// entre les messages du tchat (identifiés par nom) et notre état interne.
// Cette extension est conçue pour UN seul streamer par déploiement, donc ce
// channelId est capturé automatiquement dès la première requête reçue.
let mainChannelId = null;
let activeGiveawayChannelId = null;

/* =========================================================
   BOT DE TCHAT (tmi.js) — lecture + écriture dans le tchat
   ========================================================= */
let tmiClient = null;
if(BOT_USERNAME && BOT_OAUTH_TOKEN && CHANNEL_LOGIN){
  tmiClient = new tmi.Client({
    identity: { username: BOT_USERNAME, password: BOT_OAUTH_TOKEN },
    channels: [CHANNEL_LOGIN]
  });
  tmiClient.connect().catch(err => console.error('Erreur de connexion du bot Twitch :', err));

  tmiClient.on('message', (channel, tags, message, self) => {
    if(self) return; // ignore les messages envoyés par le bot lui-même
    const text = message.trim().toLowerCase();

    // Commande générale : liste des gagnants du live en cours (fonctionne
    // même si aucun give away n'est actif au moment où on la tape)
    if((text === '!gagnants' || text === '!gagnant') && mainChannelId){
      const ch = channels.get(mainChannelId);
      if(!ch || ch.winners.length === 0){
        tmiSay('👀 Aucun gagnant pour le moment sur ce live !');
      } else {
        const list = ch.winners.map(w => `🏆${w.name} > ${w.reward}`).join('  |  ');
        tmiSay(`Gagnants du live : ${list}`);
      }
      return;
    }

    // !guesslist (+ variantes) : pourcentages des pronostics en cours, ouvert à tout le monde
    if(['!guesslist','!prono','!pronostics','!pronostiques','!pronostique'].includes(text) && mainChannelId){
      const ch = channels.get(mainChannelId);
      const total = ch ? ch.phasmoGuesses.size : 0;
      if(!total){
        tmiSay('🔮 Personne n\'a encore pronostiqué de fantôme !');
      } else {
        const counts = {};
        ch.phasmoGuesses.forEach(g => { counts[g.ghost] = (counts[g.ghost] || 0) + 1; });
        const sorted = Object.entries(counts).sort((a,b) => b[1]-a[1]).slice(0,5);
        const txt = sorted.map(([ghost,c]) => `${PHASMO_NAME_FR[ghost] || ghost} ${Math.round(c/total*100)}%`).join(' · ');
        tmiSay(`🔮 Pronostics (${total}) : ${txt}`);
      }
      return;
    }

    // !<nomdufantome> : révèle la réponse et distribue les points — modo/streamer uniquement
    const isModOrBroadcaster = tags.mod || (tags.badges && tags.badges.broadcaster === '1');
    if(isModOrBroadcaster && mainChannelId && text.startsWith('!')){
      const alias = text.slice(1);
      if(PHASMO_ALIASES[alias]){
        revealPhasmoGhost(mainChannelId, PHASMO_ALIASES[alias]).catch(err => console.error('Erreur révélation Phasmo :', err));
        return;
      }
    }

    if(!activeGiveawayChannelId) return;

    const ch = channels.get(activeGiveawayChannelId);
    if(!ch || !ch.giveaway || ch.giveaway.winner) return;
    if(text !== ch.giveaway.command) return;

    const userId = tags['user-id'];
    if(!userId || ch.giveaway.entrants.has(userId)) return; // déjà inscrit ou message invalide

    const displayName = tags['display-name'] || tags['username'] || 'Viewer';
    ch.giveaway.entrants.set(userId, displayName);

    sendBroadcast(activeGiveawayChannelId, {
      type: 'giveaway_update',
      entryCount: ch.giveaway.entrants.size
    });
  });
} else {
  console.warn('Bot de tchat non configuré (variables TWITCH_BOT_USERNAME / TWITCH_BOT_OAUTH_TOKEN / TWITCH_CHANNEL_LOGIN manquantes) — les commandes de tchat pour le give away ne fonctionneront pas tant que ce n\'est pas fait.');
}

function tmiSay(message){
  if(!tmiClient || !CHANNEL_LOGIN) return;
  tmiClient.say('#' + CHANNEL_LOGIN, message).catch(err => console.error('Erreur envoi tchat :', err));
}

/* =========================================================
   PRONOSTICS PHASMOPHOBIA — !<nomdufantome> par un modo/streamer
   révèle la réponse, distribue les points, et vide la liste.
   ========================================================= */
// Nom français affiché pour chaque fantôme (doit rester synchronisé avec
// PHASMO_GHOSTS.nameFr côté frontend, dans app.js).
const PHASMO_NAME_FR = {
  Banshee:'Banshee', Demon:'Démon', Deogen:'Deogen', Goryo:'Goryo', Hantu:'Hantu',
  Jinn:'Djinn', Mare:'Cauchemar', Moroi:'Moroï', Myling:'Myling', Obake:'Obake', Oni:'Oni',
  Onryo:'Onryo', Phantom:'Fantôme', Poltergeist:'Poltergeist', Raiju:'Raiju',
  Revenant:'Revenant', Shade:'Ombre', Spirit:'Esprit', Thaye:'Thayé',
  'The Mimic':'Le Mimic', 'The Twins':'Les Jumeaux',
  Wraith:'Spectre', Yokai:'Yokai', Yurei:'Yurei', Dayan:'Dayan', Gallu:'Gallu',
  Obambo:'Obambo', Kormos:'Kormos', Aswang:'Aswang', Deildegast:'Deildegast'
};

function stripAccents(str){
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Construit toutes les variantes d'alias possibles pour une commande de tchat
// à partir du nom français : avec/sans accents, avec/sans article ("le"/"les"),
// espaces retirés — pour que la streameuse puisse taper la commande sans se
// soucier des accents ou de l'article.
const PHASMO_ALIASES = {};
Object.entries(PHASMO_NAME_FR).forEach(([englishKey, nameFr]) => {
  const noSpaces = nameFr.replace(/\s+/g, '').toLowerCase();
  const noArticle = nameFr.replace(/^(le|les)\s+/i, '').replace(/\s+/g, '').toLowerCase();
  const variants = new Set([
    noSpaces, stripAccents(noSpaces),
    noArticle, stripAccents(noArticle)
  ]);
  variants.forEach(v => { if(v) PHASMO_ALIASES[v] = englishKey; });
});


async function revealPhasmoGhost(channelId, ghostName){
  const ch = getChannel(channelId);
  const winners = [];
  ch.phasmoGuesses.forEach((g, userId) => {
    const stats = getViewerStats(ch, userId, g.name);
    if(g.ghost.toLowerCase() === ghostName.toLowerCase()){
      stats.phasmoPoints += 1;
      stats.phasmoGhostWins[ghostName] = (stats.phasmoGhostWins[ghostName] || 0) + 1;
      winners.push(g.name);
    } else {
      stats.phasmoLosses += 1;
    }
  });
  const total = ch.phasmoGuesses.size;
  ch.phasmoGuesses.clear(); // prête pour une nouvelle partie tout de suite

  await sendBroadcast(channelId, { type: 'phasmo_reveal', ghost: ghostName, winners, total });

  const ghostNameFr = PHASMO_NAME_FR[ghostName] || ghostName;
  if(winners.length === 0){
    tmiSay(`👻 C'était ${ghostNameFr} ! Personne n'avait trouvé sur ${total} pronostic${total>1?'s':''}.`);
  } else if(winners.length <= 8){
    tmiSay(`👻 C'était ${ghostNameFr} ! Bravo à ${winners.join(', ')} qui remportent un point ! 🎉`);
  } else {
    tmiSay(`👻 C'était ${ghostNameFr} ! Bravo aux ${winners.length} personnes qui avaient trouvé ! 🎉`);
  }
  return { winners, total };
}

function clearGiveawayTimers(ch){
  (ch.giveawayTimers || []).forEach(id => clearTimeout(id));
  ch.giveawayTimers = [];
}

// Capture toute erreur dans une route async et répond en 500 avec le détail,
// au lieu de laisser la requête sans réponse (ce qui donnait l'impression
// que "rien ne se passe" côté extension).
function safeRoute(fn){
  return async (req, res) => {
    try{
      await fn(req, res);
    }catch(err){
      console.error(`Erreur sur ${req.method} ${req.path} :`, err);
      if(!res.headersSent) res.status(500).send('Erreur serveur : ' + err.message);
    }
  };
}

/* =========================================================
   VÉRIFICATION DU JWT TWITCH
   ========================================================= */
function verifyTwitchJWT(req, res, next){
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if(!token) return res.status(401).send('Token manquant');
  try{
    const decoded = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
    req.twitch = decoded; // { user_id, channel_id, role, opaque_user_id, ... }
    if(!mainChannelId) mainChannelId = decoded.channel_id;
    next();
  }catch(e){
    console.error('JWT invalide (' + e.message + ') — longueur du secret décodé :', SECRET.length, 'octets');
    return res.status(401).send('Token invalide : ' + e.message);
  }
}

function requireBroadcasterOrMod(req, res, next){
  if(TESTING_MODE) return next(); // voir note TESTING_MODE plus haut
  if(req.twitch.role !== 'broadcaster' && req.twitch.role !== 'moderator'){
    return res.status(403).send('Réservé au streamer/modérateurs');
  }
  next();
}

/* =========================================================
   ENVOI D'UN BROADCAST TEMPS RÉEL À TOUS LES VIEWERS
   (Extension PubSub — cf. dev.twitch.tv/docs/api/reference#send-extension-pubsub-message)
   Limite Twitch : ~1 message/seconde par extension+chaîne, garde
   les envois espacés si tu boucles dessus (ex: mises à jour de score).
   ========================================================= */
async function sendBroadcast(channelId, payload){
  const pubsubToken = jwt.sign(
    {
      channel_id: channelId,
      user_id: channelId,
      role: 'external',
      pubsub_perms: { send: ['broadcast'] }
    },
    SECRET,
    { algorithm: 'HS256', expiresIn: '30s' }
  );

  const res = await fetch('https://api.twitch.tv/helix/extensions/pubsub', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + pubsubToken,
      'Client-Id': CLIENT_ID,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: JSON.stringify(payload),
      broadcaster_id: channelId,
      target: ['broadcast']
    })
  });

  if(!res.ok){
    console.error('Échec du broadcast Twitch PubSub', res.status, await res.text().catch(()=>''));
  }
}

/* =========================================================
   ÉTAT PUBLIC (pour un viewer qui rejoint en cours de route)
   ========================================================= */
app.get('/api/state', verifyTwitchJWT, (req, res) => {
  const ch = getChannel(req.twitch.channel_id);
  const userId = req.twitch.user_id;

  const poll = ch.poll ? {
    question: ch.poll.question,
    options: ch.poll.options,
    myVote: ch.poll.voters.has(userId) ? ch.poll.voters.get(userId) : null
  } : null;

  const giveaway = ch.giveaway ? {
    entryCount: ch.giveaway.entrants.size,
    joined: ch.giveaway.entrants.has(userId),
    winner: ch.giveaway.winner,
    command: ch.giveaway.command
  } : null;

  const game = ch.game ? {
    endsAt: ch.game.endsAt,
    finished: ch.game.finished,
    leaderboard: ch.game.finished ? buildLeaderboard(ch.game) : undefined
  } : null;

  res.json({ poll, giveaway, game, settings: ch.settings });
});

/* =========================================================
   RÉGLAGES (configurables depuis le panneau modération de l'overlay)
   ========================================================= */
app.get('/api/settings', verifyTwitchJWT, (req, res) => {
  const ch = getChannel(req.twitch.channel_id);
  res.json(ch.settings);
});

app.post('/api/settings', verifyTwitchJWT, requireBroadcasterOrMod, safeRoute(async (req, res) => {
  const ch = getChannel(req.twitch.channel_id);
  const s = req.body || {};
  if(s.countdownSeconds !== undefined) ch.settings.countdownSeconds = Math.max(0, Math.min(30, Number(s.countdownSeconds) || 0));
  if(s.giveawayResultDisplaySec !== undefined) ch.settings.giveawayResultDisplaySec = Math.max(2, Math.min(60, Number(s.giveawayResultDisplaySec) || 8));
  if(s.gameDefaultDuration !== undefined) ch.settings.gameDefaultDuration = Math.max(5, Math.min(300, Number(s.gameDefaultDuration) || 15));
  if(s.gameResultDisplaySec !== undefined) ch.settings.gameResultDisplaySec = Math.max(2, Math.min(60, Number(s.gameResultDisplaySec) || 8));
  if(s.showLastWinnerBadge !== undefined) ch.settings.showLastWinnerBadge = !!s.showLastWinnerBadge;
  if(s.gameTotalsAutoResetDays !== undefined) ch.settings.gameTotalsAutoResetDays = Math.max(0, Math.min(365, Number(s.gameTotalsAutoResetDays) || 0));
  if(Array.isArray(s.reactions)){
    ch.settings.reactions = s.reactions
      .slice(0, 10)
      .map(r => ({
        glyph: String((r && r.glyph) || '').slice(0, 300),
        speed: Math.max(0.3, Math.min(5, Number(r && r.speed) || 2.2))
      }))
      .filter(r => r.glyph);
  }
  if(s.confettiSpeed !== undefined) ch.settings.confettiSpeed = Math.max(0.3, Math.min(5, Number(s.confettiSpeed) || 2.2));
  if(s.profileMessage !== undefined) ch.settings.profileMessage = String(s.profileMessage).slice(0, 500);
  if(s.bonkBaseXp !== undefined) ch.settings.bonkBaseXp = Math.max(1, Math.min(1000, Number(s.bonkBaseXp) || 15));
  if(s.bonkGrowth !== undefined) ch.settings.bonkGrowth = Math.max(1, Math.min(3, Number(s.bonkGrowth) || 1.4));
  if(s.bonkMaxLevel !== undefined) ch.settings.bonkMaxLevel = Math.max(1, Math.min(50, Number(s.bonkMaxLevel) || 15));
  if(s.donationUrl !== undefined) ch.settings.donationUrl = String(s.donationUrl).slice(0, 200);
  if(s.donationLabel !== undefined) ch.settings.donationLabel = String(s.donationLabel).slice(0, 60) || '💜 Soutenir la chaîne';
  if(s.discordUrl !== undefined) ch.settings.discordUrl = String(s.discordUrl).slice(0, 200);
  if(s.discordLabel !== undefined) ch.settings.discordLabel = String(s.discordLabel).slice(0, 60) || '💬 Rejoindre le Discord';
  if(s.bonkLegendMessage !== undefined) ch.settings.bonkLegendMessage = String(s.bonkLegendMessage).slice(0, 200) || '🏆 {name} est officiellement une LÉGENDE DU BONK ! 🏆';
  if(s.rgbEvents !== undefined) ch.settings.rgbEvents = !!s.rgbEvents;
  if(s.rgbMinigames !== undefined) ch.settings.rgbMinigames = !!s.rgbMinigames;
  if(s.rgbAllPanels !== undefined) ch.settings.rgbAllPanels = !!s.rgbAllPanels;

  persistSettings(req.twitch.channel_id, ch.settings);
  await sendBroadcast(req.twitch.channel_id, { type: 'settings_update', settings: ch.settings });
  res.json({ ok: true, settings: ch.settings });
}));

/* =========================================================
   HISTORIQUE DES GAGNANTS (commande !gagnants + reset entre lives)
   ========================================================= */
app.post('/api/winners/reset', verifyTwitchJWT, requireBroadcasterOrMod, safeRoute(async (req, res) => {
  const ch = getChannel(req.twitch.channel_id);
  ch.winners = [];
  res.json({ ok: true });
}));

/* =========================================================
   SONDAGE
   ========================================================= */
app.post('/api/poll/start', verifyTwitchJWT, requireBroadcasterOrMod, safeRoute(async (req, res) => {
  const { question, options, durationSec } = req.body;
  if(!question || !Array.isArray(options) || options.length < 2 || options.length > 4){
    return res.status(400).send('Question + 2 à 4 options requises');
  }
  const ch = getChannel(req.twitch.channel_id);
  clearTimeout(ch.pollTimer);
  const endsAt = durationSec ? Date.now() + durationSec*1000 : null;
  ch.poll = {
    question,
    options: options.map(label => ({ label, votes: 0 })),
    voters: new Map(),
    endsAt
  };
  await sendBroadcast(req.twitch.channel_id, {
    type: 'poll_start',
    poll: { question, options: ch.poll.options, endsAt }
  });
  if(durationSec){
    ch.pollTimer = setTimeout(() => endPoll(req.twitch.channel_id), durationSec*1000);
  }
  res.json({ ok: true });
}));

async function endPoll(channelId){
  const ch = getChannel(channelId);
  if(!ch.poll) return;
  clearTimeout(ch.pollTimer);
  const question = ch.poll.question;
  const options = ch.poll.options;
  ch.poll = null;
  await sendBroadcast(channelId, { type: 'poll_end', question, options });
}

app.post('/api/poll/end', verifyTwitchJWT, requireBroadcasterOrMod, safeRoute(async (req, res) => {
  await endPoll(req.twitch.channel_id);
  res.json({ ok: true });
}));

app.post('/api/poll/vote', verifyTwitchJWT, safeRoute(async (req, res) => {
  const ch = getChannel(req.twitch.channel_id);
  if(!ch.poll) return res.status(400).send('Aucun sondage en cours');
  const userId = req.twitch.user_id;
  if(ch.poll.voters.has(userId)) return res.status(409).send('Déjà voté');

  const { optionIndex } = req.body;
  if(typeof optionIndex !== 'number' || !ch.poll.options[optionIndex]){
    return res.status(400).send('Option invalide');
  }
  ch.poll.voters.set(userId, optionIndex);
  ch.poll.options[optionIndex].votes += 1;

  await sendBroadcast(req.twitch.channel_id, {
    type: 'poll_update',
    options: ch.poll.options
  });
  res.json({ ok: true });
}));

/* =========================================================
   GIVE AWAY
   ========================================================= */
app.post('/api/giveaway/start', verifyTwitchJWT, requireBroadcasterOrMod, safeRoute(async (req, res) => {
  let { durationSec, command, reward } = req.body;
  durationSec = Number(durationSec) || 60;
  command = (typeof command === 'string' && command.trim()) ? command.trim().toLowerCase() : '!concours';
  if(!command.startsWith('!')) command = '!' + command;
  reward = (typeof reward === 'string' && reward.trim()) ? reward.trim().slice(0, 60) : 'un lot surprise';

  const channelId = req.twitch.channel_id;
  const ch = getChannel(channelId);
  clearGiveawayTimers(ch);

  ch.giveaway = {
    entrants: new Map(),
    winner: null,
    command,
    reward,
    endsAt: Date.now() + durationSec * 1000
  };
  activeGiveawayChannelId = channelId; // le bot de tchat sait maintenant où compter les entrées

  await sendBroadcast(channelId, { type: 'giveaway_start', command, reward });
  tmiSay(`🎉 GIVE AWAY LANCÉ ! Tapez ${command} dans le tchat (ou cliquez "Participer" dans l'extension) pour tenter de gagner : ${reward} ! Tirage dans ${durationSec}s ⏳`);

  // Rappel à mi-parcours si la durée le justifie
  if(durationSec > 20){
    const halfway = Math.round(durationSec / 2);
    const t1 = setTimeout(() => {
      tmiSay(`⏳ Encore ${halfway}s pour taper ${command} et tenter de gagner : ${reward} !`);
    }, halfway * 1000);
    ch.giveawayTimers.push(t1);
  }

  // Compte à rebours réglable (0 = désactivé) dans les dernières secondes
  const countdownSeconds = Math.min(ch.settings.countdownSeconds, durationSec);
  for(let s = countdownSeconds; s >= 1; s--){
    const delay = (durationSec - s) * 1000;
    const t = setTimeout(() => {
      tmiSay(`${s === 1 ? '🔥' : '⏱️'} ${s}...`);
    }, delay);
    ch.giveawayTimers.push(t);
  }

  // Tirage automatique à la fin du minuteur
  const drawTimer = setTimeout(() => runGiveawayDraw(channelId), durationSec * 1000);
  ch.giveawayTimers.push(drawTimer);

  res.json({ ok: true });
}));

app.post('/api/giveaway/join', verifyTwitchJWT, safeRoute(async (req, res) => {
  const ch = getChannel(req.twitch.channel_id);
  if(!ch.giveaway || ch.giveaway.winner) return res.status(400).send('Aucune inscription ouverte');
  const userId = req.twitch.user_id;
  if(ch.giveaway.entrants.has(userId)) return res.status(409).send('Déjà inscrit·e');

  // Le pseudo réel est requis ici (identité liée côté client) pour que la
  // déduplication avec les entrées via le tchat fonctionne correctement.
  const displayName = (typeof req.body.displayName === 'string' && req.body.displayName.trim())
    ? req.body.displayName.trim().slice(0,40)
    : 'un·e viewer mystère';
  ch.giveaway.entrants.set(userId, displayName);

  await sendBroadcast(req.twitch.channel_id, {
    type: 'giveaway_update',
    entryCount: ch.giveaway.entrants.size
  });
  res.json({ ok: true, entryCount: ch.giveaway.entrants.size });
}));

async function runGiveawayDraw(channelId){
  const ch = getChannel(channelId);
  if(!ch.giveaway || ch.giveaway.winner) return; // déjà tiré (ex: tirage manuel entre-temps)
  clearGiveawayTimers(ch);

  const displaySec = ch.settings.giveawayResultDisplaySec;

  if(ch.giveaway.entrants.size === 0){
    tmiSay('😢 Personne n\'a participé au give away... on retentera une prochaine fois !');
    ch.giveaway.winner = 'personne';
    await sendBroadcast(channelId, { type: 'giveaway_winner', winnerName: null });
    setTimeout(() => sendBroadcast(channelId, { type: 'clear_display' }), displaySec * 1000);
    return;
  }

  const ids = Array.from(ch.giveaway.entrants.keys());
  const winnerId = ids[Math.floor(Math.random() * ids.length)];
  const winnerName = ch.giveaway.entrants.get(winnerId) || 'un·e viewer mystère';
  ch.giveaway.winner = winnerName;
  ch.winners.push({ name: winnerName, reward: ch.giveaway.reward });

  await sendBroadcast(channelId, { type: 'giveaway_winner', winnerName, reward: ch.giveaway.reward });
  tmiSay(`🎉🥳🏆✨ ET LE/LA GRAND(E) GAGNANT(E) DE ${ch.giveaway.reward.toUpperCase()} EST... 🥁🥁🥁 ${winnerName} !!! 🎉🥳🏆✨ Félicitations !! 🎊🎊 (tape !gagnants pour revoir tous les gagnants du live)`);

  setTimeout(() => sendBroadcast(channelId, { type: 'clear_display' }), displaySec * 1000);
}

// Tirage manuel (le/la modérateur·rice peut forcer le tirage avant la fin du minuteur)
app.post('/api/giveaway/draw', verifyTwitchJWT, requireBroadcasterOrMod, safeRoute(async (req, res) => {
  const channelId = req.twitch.channel_id;
  const ch = getChannel(channelId);
  if(!ch.giveaway) return res.status(400).send('Aucun give away en cours');
  await runGiveawayDraw(channelId);
  res.json({ ok: true, winnerName: ch.giveaway.winner });
}));

/* =========================================================
   MINI-JEU — Chasse aux clics
   ========================================================= */
function clearGameTimers(ch){
  (ch.gameTimers || []).forEach(id => clearTimeout(id));
  ch.gameTimers = [];
}

app.post('/api/game/start', verifyTwitchJWT, safeRoute(async (req, res) => {
  const { durationSec } = req.body;
  const channelId = req.twitch.channel_id;
  const ch = getChannel(channelId);

  if(ch.game && !ch.game.finished){
    return res.status(409).send('Une manche est déjà en cours, rejoins celle-ci !');
  }
  if(ch.gameCooldownUntil && Date.now() < ch.gameCooldownUntil){
    return res.status(429).send('Une nouvelle manche pourra être relancée dans quelques secondes.');
  }

  const duration = Number(durationSec) || ch.settings.gameDefaultDuration;
  clearGameTimers(ch);

  ch.game = {
    endsAt: Date.now() + duration*1000,
    finished: false,
    scores: new Map()
  };
  await sendBroadcast(channelId, {
    type: 'game_round_start',
    durationSec: duration
  });

  // Fin automatique : on laisse une toute petite marge après le minuteur
  // pour laisser le temps aux derniers scores des viewers d'arriver au
  // serveur, sans pour autant créer un temps mort perceptible à 0 seconde.
  const t = setTimeout(() => runGameResults(channelId), (duration + 0.1) * 1000);
  ch.gameTimers.push(t);

  res.json({ ok: true });
}));

app.post('/api/game/score', verifyTwitchJWT, (req, res) => {
  const ch = getChannel(req.twitch.channel_id);
  if(!ch.game || ch.game.finished) return res.status(400).send('Aucune manche en cours');

  // Anti-triche basique : borne le nombre de clics à un maximum plausible
  const clicks = Math.min(Number(req.body.clicks) || 0, 500);
  const userId = req.twitch.user_id;
  const displayName = (typeof req.body.displayName === 'string' && req.body.displayName.trim())
    ? req.body.displayName.trim().slice(0,40)
    : 'Joueur·se mystère';

  const prev = ch.game.scores.get(userId);
  if(!prev || clicks > prev.score){
    ch.game.scores.set(userId, { name: displayName, score: clicks });
  }
  res.json({ ok: true });
});

function buildLeaderboard(game){
  return Array.from(game.scores.entries())
    .map(([userId, entry]) => ({ userId, name: entry.name, score: entry.score }))
    .sort((a,b) => b.score - a.score)
    .slice(0,10);
}

function maybeAutoResetGameTotals(ch){
  const days = ch.settings.gameTotalsAutoResetDays;
  if(!days) return; // reset automatique désactivé
  const now = Date.now();
  if(!ch.gameTotalsResetAt){
    ch.gameTotalsResetAt = now + days * 86400000;
    return;
  }
  if(now >= ch.gameTotalsResetAt){
    ch.gameTotals.clear();
    ch.gameTotalsResetAt = now + days * 86400000;
  }
}

async function runGameResults(channelId){
  const ch = getChannel(channelId);
  if(!ch.game || ch.game.finished) return; // déjà conclue (ex: bouton manuel entre-temps)
  clearGameTimers(ch);
  ch.game.finished = true;
  ch.gameCooldownUntil = Date.now() + 8000; // 8s avant qu'une nouvelle manche puisse démarrer

  maybeAutoResetGameTotals(ch);

  const roundScores = buildLeaderboard(ch.game); // classement de cette manche uniquement, trié par score

  // Fusionne dans le cumul all-time (ne se réinitialise jamais entre lives,
  // seulement via le reset auto mensuel ou le bouton manuel)
  const leaderboard = roundScores.map(entry => {
    const prevTotal = ch.gameTotals.get(entry.userId);
    const newTotal = (prevTotal ? prevTotal.total : 0) + entry.score;
    ch.gameTotals.set(entry.userId, { name: entry.name, total: newTotal });
    return { name: entry.name, score: entry.score, total: newTotal };
  });

  await sendBroadcast(channelId, {
    type: 'game_round_end',
    leaderboard
  });
  setTimeout(() => sendBroadcast(channelId, { type: 'clear_display' }), ch.settings.gameResultDisplaySec * 1000);
  return leaderboard;
}

// Reset manuel du cumul all-time (bouton dédié dans les réglages avancés)
app.post('/api/game/totals/reset', verifyTwitchJWT, requireBroadcasterOrMod, safeRoute(async (req, res) => {
  const ch = getChannel(req.twitch.channel_id);
  ch.gameTotals.clear();
  ch.gameTotalsResetAt = ch.settings.gameTotalsAutoResetDays
    ? Date.now() + ch.settings.gameTotalsAutoResetDays * 86400000
    : null;
  ch.game = null; // vide aussi le tableau de scores affiché (pas que le cumul)
  await sendBroadcast(req.twitch.channel_id, { type: 'clear_display' }); // prévient tout le monde immédiatement
  res.json({ ok: true });
}));

// Bouton manuel du panneau mod : force la fin de manche avant le minuteur
app.post('/api/game/results', verifyTwitchJWT, requireBroadcasterOrMod, safeRoute(async (req, res) => {
  const channelId = req.twitch.channel_id;
  const ch = getChannel(channelId);
  if(!ch.game) return res.status(400).send('Aucune manche à conclure');
  const leaderboard = await runGameResults(channelId);
  res.json({ ok: true, leaderboard });
}));

/* =========================================================
   CÉLÉBRATION LIBRE (confettis à la demande)
   ========================================================= */
app.post('/api/celebrate', verifyTwitchJWT, requireBroadcasterOrMod, safeRoute(async (req, res) => {
  // glyph absent/null → confettis carrés classiques ; sinon emoji ou URL d'image
  const glyph = (typeof req.body.glyph === 'string' && req.body.glyph.trim()) ? req.body.glyph.trim().slice(0, 300) : null;
  await sendBroadcast(req.twitch.channel_id, { type: 'celebrate', glyph });
  res.json({ ok: true });
}));

/* =========================================================
   RÉACTIONS PERSO (boutons cliqués librement par n'importe quel
   viewer : effet visuel local chez lui uniquement + stats perso
   suivies côté serveur — pas de broadcast, pas de spam pour les autres)
   ========================================================= */
function getViewerStats(ch, userId, displayName){
  let stats = ch.viewerStats.get(userId);
  if(!stats){
    stats = { name: displayName || 'Viewer', bonkXp: 0, phasmoPoints: 0, clicks: { confetti:0, reactions:0, bonk:0 } };
    ch.viewerStats.set(userId, stats);
  }
  if(stats.phasmoPoints === undefined) stats.phasmoPoints = 0; // pour les stats déjà créées avant cet ajout
  if(!stats.phasmoGhostWins) stats.phasmoGhostWins = {};       // ghost -> nombre de fois trouvé
  if(stats.phasmoJournalOpens === undefined) stats.phasmoJournalOpens = 0;
  if(stats.phasmoClicks === undefined) stats.phasmoClicks = 0;
  if(stats.phasmoLosses === undefined) stats.phasmoLosses = 0;
  if(displayName) stats.name = displayName;
  return stats;
}

// XP cumulatif nécessaire pour ATTEINDRE un niveau donné (courbe progressive :
// chaque niveau demande un peu plus d'XP que le précédent, comme un jeu vidéo)
function xpThresholdForLevel(level, baseXp, growth){
  if(level <= 1) return 0;
  return Math.round(baseXp * Math.pow(level - 1, growth));
}

function bonkLevel(xp, baseXp, growth, maxLevel){
  let level = 1;
  while(level < maxLevel && xp >= xpThresholdForLevel(level + 1, baseXp, growth)){
    level++;
  }
  return level;
}

app.post('/api/react', verifyTwitchJWT, safeRoute(async (req, res) => {
  const ch = getChannel(req.twitch.channel_id);
  const { kind, glyph, speed, displayName } = req.body; // kind: 'confetti' | 'reactions' | 'bonk'
  if(!['confetti','reactions','bonk'].includes(kind)) return res.status(400).send('Type de réaction invalide');

  const userId = req.twitch.user_id;
  const stats = getViewerStats(ch, userId, displayName);
  stats.clicks[kind] = (stats.clicks[kind] || 0) + 1;
  if(kind === 'bonk') stats.bonkXp += 1;

  const level = bonkLevel(stats.bonkXp, ch.settings.bonkBaseXp, ch.settings.bonkGrowth, ch.settings.bonkMaxLevel);
  res.json({ ok: true, stats: { ...stats, bonkLevel: level } });

  // Diffuse la réaction à tout le monde (y compris la personne qui vient de
  // cliquer) — c'est justement ce qui manquait : avant, seuls les points
  // étaient enregistrés, mais personne d'autre ne voyait jamais l'effet.
  sendBroadcast(req.twitch.channel_id, { type:'reaction', kind, glyph: glyph || null, speed: speed || null }).catch(err => console.error('Erreur diffusion réaction :', err));
}));

// Pousse immédiatement le vrai pseudo dès qu'un viewer partage son identité
// (au lieu d'attendre sa prochaine action pour que le nom se mette à jour)
app.post('/api/update-name', verifyTwitchJWT, safeRoute(async (req, res) => {
  const ch = getChannel(req.twitch.channel_id);
  const displayName = (typeof req.body.displayName === 'string' && req.body.displayName.trim()) ? req.body.displayName.trim().slice(0,40) : null;
  if(!displayName) return res.status(400).send('Pseudo manquant');
  getViewerStats(ch, req.twitch.user_id, displayName);
  res.json({ ok: true });
}));

// Contournement : durant Local/Hosted Test, Twitch confirme parfois le lien
// d'identité (isLinked=true) sans jamais transmettre le displayName au
// frontend. Comme l'ID du viewer devient son vrai ID Twitch numérique une
// fois lié, on peut aller chercher son pseudo nous-mêmes via l'API Twitch.
app.post('/api/resolve-name', verifyTwitchJWT, safeRoute(async (req, res) => {
  const userId = req.twitch.user_id;
  if(!/^\d+$/.test(userId)){
    return res.status(400).send("Identité pas encore liée (identifiant encore anonyme)");
  }
  const token = await getAppAccessToken();
  const helixRes = await fetch('https://api.twitch.tv/helix/users?id=' + encodeURIComponent(userId), {
    headers: { 'Authorization': 'Bearer ' + token, 'Client-Id': CLIENT_ID }
  });
  if(!helixRes.ok){
    return res.status(502).send('Erreur Twitch (' + helixRes.status + ') en récupérant le pseudo');
  }
  const data = await helixRes.json();
  const name = data.data && data.data[0] && data.data[0].display_name;
  if(!name) return res.status(404).send('Pseudo introuvable côté Twitch');

  const ch = getChannel(req.twitch.channel_id);
  getViewerStats(ch, userId, name);
  res.json({ ok: true, name });
}));

// Réinitialise le niveau de bonk de TOUS les viewers (bouton dans les réglages)
app.post('/api/bonk/reset', verifyTwitchJWT, requireBroadcasterOrMod, safeRoute(async (req, res) => {
  const ch = getChannel(req.twitch.channel_id);
  ch.viewerStats.forEach(v => { v.bonkXp = 0; });
  res.json({ ok: true });
}));

// Un viewer atteint 1000 de combo bonk : annonce spéciale pour tout le monde + le bot
app.post('/api/bonk/legend', verifyTwitchJWT, safeRoute(async (req, res) => {
  const channelId = req.twitch.channel_id;
  const ch = getChannel(channelId);
  const name = (typeof req.body.displayName === 'string' && req.body.displayName.trim()) ? req.body.displayName.trim().slice(0,40) : 'un·e viewer mystère';
  const message = (ch.settings.bonkLegendMessage || '🏆 {name} est officiellement une LÉGENDE DU BONK ! 🏆').replace(/\{name\}/g, name);

  await sendBroadcast(channelId, { type: 'bonk_legend', name, message });
  tmiSay('🔨👑 ' + message);
  res.json({ ok: true });
}));

/* =========================================================
   PRONOSTICS PHASMOPHOBIA — routes HTTP
   ========================================================= */
app.post('/api/phasmo/guess', verifyTwitchJWT, safeRoute(async (req, res) => {
  const ch = getChannel(req.twitch.channel_id);
  const ghost = (typeof req.body.ghost === 'string' && req.body.ghost.trim()) ? req.body.ghost.trim().slice(0, 40) : null;
  if(!ghost) return res.status(400).send('Fantôme manquant');
  const displayName = (typeof req.body.displayName === 'string' && req.body.displayName.trim()) ? req.body.displayName.trim().slice(0,40) : 'Joueur·se mystère';
  ch.phasmoGuesses.set(req.twitch.user_id, { name: displayName, ghost });
  res.json({ ok: true, ghost });
}));

app.post('/api/phasmo/percentages', verifyTwitchJWT, (req, res) => {
  const ch = getChannel(req.twitch.channel_id);
  const total = ch.phasmoGuesses.size;
  const myGuess = ch.phasmoGuesses.get(req.twitch.user_id) || null;
  const counts = {};
  ch.phasmoGuesses.forEach(g => { counts[g.ghost] = (counts[g.ghost] || 0) + 1; });
  const breakdown = Object.entries(counts)
    .map(([ghost, count]) => ({ ghost, count, pct: Math.round(count/total*100) }))
    .sort((a,b) => b.count - a.count);
  res.json({ total, breakdown, myGuess: myGuess ? myGuess.ghost : null });
});

app.post('/api/phasmo/newround', verifyTwitchJWT, requireBroadcasterOrMod, safeRoute(async (req, res) => {
  const ch = getChannel(req.twitch.channel_id);
  ch.phasmoGuesses.clear();
  await sendBroadcast(req.twitch.channel_id, { type: 'phasmo_newround' });
  res.json({ ok: true });
}));

app.post('/api/phasmo/track', verifyTwitchJWT, (req, res) => {
  const ch = getChannel(req.twitch.channel_id);
  const stats = getViewerStats(ch, req.twitch.user_id, req.body.displayName || null);
  if(req.body.event === 'open') stats.phasmoJournalOpens += 1;
  else if(req.body.event === 'click') stats.phasmoClicks += 1;
  res.json({ ok: true });
});

app.post('/api/phasmo/debrief', verifyTwitchJWT, (req, res) => {
  const ch = getChannel(req.twitch.channel_id);
  const stats = getViewerStats(ch, req.twitch.user_id, req.body.displayName || null);
  res.json({
    ghostWins: stats.phasmoGhostWins,
    journalOpens: stats.phasmoJournalOpens,
    clicks: stats.phasmoClicks,
    losses: stats.phasmoLosses,
    points: stats.phasmoPoints
  });
});

app.post('/api/phasmo/resetstats', verifyTwitchJWT, requireBroadcasterOrMod, safeRoute(async (req, res) => {
  const ch = getChannel(req.twitch.channel_id);
  ch.viewerStats.forEach(stats => {
    stats.phasmoGhostWins = {};
    stats.phasmoJournalOpens = 0;
    stats.phasmoClicks = 0;
    stats.phasmoLosses = 0;
    stats.phasmoPoints = 0;
  });
  await sendBroadcast(req.twitch.channel_id, { type: 'phasmo_stats_reset' });
  res.json({ ok: true });
}));

app.get('/api/mystats', verifyTwitchJWT, (req, res) => {
  const ch = getChannel(req.twitch.channel_id);
  const userId = req.twitch.user_id;
  const stats = getViewerStats(ch, userId, null);
  const { bonkBaseXp, bonkGrowth, bonkMaxLevel } = ch.settings;
  const level = bonkLevel(stats.bonkXp, bonkBaseXp, bonkGrowth, bonkMaxLevel);
  const currentThreshold = xpThresholdForLevel(level, bonkBaseXp, bonkGrowth);
  const nextThreshold = level < bonkMaxLevel ? xpThresholdForLevel(level + 1, bonkBaseXp, bonkGrowth) : currentThreshold;
  const totalGame = ch.gameTotals.get(userId);
  res.json({
    stats: { ...stats, bonkLevel: level, currentLevelXp: currentThreshold, xpForNextLevel: nextThreshold },
    gameTotal: totalGame ? totalGame.total : 0,
    donationUrl: ch.settings.donationUrl,
    donationLabel: ch.settings.donationLabel,
    discordUrl: ch.settings.discordUrl,
    discordLabel: ch.settings.discordLabel,
    profileMessage: ch.settings.profileMessage
  });
});

app.get('/', (req, res) => res.send('EBS extension Twitch — OK'));

/* =========================================================
   RECHERCHE D'EMOTES TWITCH (pour utiliser une vraie emote de
   ta chaîne dans les réactions, plutôt qu'un simple emoji)
   ========================================================= */
let appAccessToken = null;
let appAccessTokenExpiresAt = 0;

async function getAppAccessToken(){
  if(appAccessToken && Date.now() < appAccessTokenExpiresAt) return appAccessToken;
  if(!CLIENT_SECRET){
    throw new Error('EXTENSION_CLIENT_SECRET manquant côté serveur — nécessaire pour rechercher tes emotes.');
  }
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'client_credentials'
  });
  const res = await fetch('https://id.twitch.tv/oauth2/token?' + params.toString(), { method: 'POST' });
  if(!res.ok){
    throw new Error('Impossible de récupérer un token Twitch app (' + res.status + ')');
  }
  const data = await res.json();
  appAccessToken = data.access_token;
  appAccessTokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000; // marge de sécurité d'1 min
  return appAccessToken;
}

app.get('/api/emote-lookup', verifyTwitchJWT, requireBroadcasterOrMod, safeRoute(async (req, res) => {
  const name = (req.query.name || '').trim();
  if(!name) return res.status(400).send('Indique le nom exact de ton emote');

  const token = await getAppAccessToken();
  const helixRes = await fetch('https://api.twitch.tv/helix/chat/emotes?broadcaster_id=' + encodeURIComponent(req.twitch.channel_id), {
    headers: { 'Authorization': 'Bearer ' + token, 'Client-Id': CLIENT_ID }
  });
  if(!helixRes.ok){
    return res.status(502).send('Erreur Twitch (' + helixRes.status + ') en cherchant tes emotes');
  }
  const data = await helixRes.json();
  const found = (data.data || []).find(e => e.name.toLowerCase() === name.toLowerCase());
  if(!found){
    return res.status(404).send(`Emote "${name}" introuvable parmi les emotes de ta chaîne. Vérifie l'orthographe exacte (sensible à la casse habituellement pas, mais au nom complet oui).`);
  }
  res.json({ ok: true, url: found.images.url_4x || found.images.url_2x || found.images.url_1x, name: found.name });
}));

app.get('/privacy', (req, res) => {
  res.type('html').send(`
    <!DOCTYPE html>
    <html lang="fr">
    <head><meta charset="UTF-8"><title>Politique de confidentialité — Extension Twitch</title>
    <style>body{font-family:sans-serif;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.6;color:#222}</style>
    </head>
    <body>
      <h1>Politique de confidentialité</h1>
      <p>Cette extension Twitch collecte uniquement les informations nécessaires à son fonctionnement :</p>
      <ul>
        <li><strong>Identifiant anonyme Twitch (opaque_user_id)</strong> : utilisé pour empêcher de voter ou de participer plusieurs fois au même sondage/give away.</li>
        <li><strong>Pseudo Twitch (optionnel)</strong> : uniquement si tu choisis explicitement de le partager (bouton "Partager mon pseudo"), pour pouvoir t'annoncer publiquement en cas de victoire à un give away. Tu peux refuser ce partage et continuer à voter/jouer normalement dans les autres fonctionnalités.</li>
        <li><strong>Scores du mini-jeu</strong> : le nombre de clics que tu réalises durant une manche, pour établir un classement temporaire.</li>
      </ul>
      <p>Aucune donnée n'est vendue, partagée avec des tiers, ou conservée au-delà de la durée du live / de la fonctionnalité concernée. Les données sont stockées temporairement en mémoire sur le serveur de l'extension et supprimées au redémarrage du service.</p>
      <p>Pour toute question, contacte le développeur de cette extension via son profil Twitch.</p>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`EBS démarré sur le port ${PORT}`);
  console.log(UPSTASH_URL && UPSTASH_TOKEN
    ? '✅ Upstash configuré — les réglages survivront aux redéploiements.'
    : '⚠️ Upstash NON configuré — les réglages seront perdus à chaque redéploiement.');
});
