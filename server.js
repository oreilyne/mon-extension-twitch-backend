require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const tmi = require('tmi.js');

const CLIENT_ID = (process.env.EXTENSION_CLIENT_ID || '').trim();
const SECRET = Buffer.from((process.env.EXTENSION_SECRET || '').trim(), 'base64');
const PORT = process.env.PORT || 8081;

const BOT_USERNAME = process.env.TWITCH_BOT_USERNAME;
const BOT_OAUTH_TOKEN = process.env.TWITCH_BOT_OAUTH_TOKEN; // format: oauth:xxxxxxxx
const CHANNEL_LOGIN = process.env.TWITCH_CHANNEL_LOGIN;     // ex: "oreilyne" (minuscules, sans #)

// TEMPORAIRE : pendant Local/Hosted Test, Twitch ne renvoie pas toujours le
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
    channels.set(channelId, {
      poll: null,          // { question, options:[{label,votes}], voters:Set, durationSec, endsAt }
      giveaway: null,       // { entrants:Map(userId->name), winner, command, reward, endsAt }
      giveawayTimers: [],   // setTimeout ids en cours (annonces + tirage auto)
      game: null,           // { endsAt, finished, scores:Map(userId->{name,score}) }
      gameTimers: [],        // setTimeout ids en cours pour le mini-jeu (fin auto)
      winners: [],          // historique des gagnants du live en cours : [{name, reward}]
      settings: {
        countdownSeconds: 5,        // durée du compte à rebours du give away (dernières secondes)
        giveawayResultDisplaySec: 8,// durée d'affichage du gagnant avant retour à l'écran d'accueil
        gameDefaultDuration: 15,    // durée par défaut proposée pour une manche de mini-jeu
        gameResultDisplaySec: 8,    // durée d'affichage du classement avant retour à l'écran d'accueil
        showLastWinnerBadge: true   // afficher une petite bulle "dernier gagnant" sur le stream
      }
    });
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
    if(text === '!gagnants' && mainChannelId){
      const ch = channels.get(mainChannelId);
      if(!ch || ch.winners.length === 0){
        tmiSay('👀 Aucun gagnant pour le moment sur ce live !');
      } else {
        const list = ch.winners.map(w => `🏆${w.name} > ${w.reward}`).join('  |  ');
        tmiSay(`Gagnants du live : ${list}`);
      }
      return;
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
  ch.poll = {
    question,
    options: options.map(label => ({ label, votes: 0 })),
    voters: new Map(),
    endsAt: durationSec ? Date.now() + durationSec*1000 : null
  };
  await sendBroadcast(req.twitch.channel_id, {
    type: 'poll_start',
    poll: { question, options: ch.poll.options }
  });
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

app.post('/api/poll/end', verifyTwitchJWT, requireBroadcasterOrMod, safeRoute(async (req, res) => {
  const ch = getChannel(req.twitch.channel_id);
  ch.poll = null;
  await sendBroadcast(req.twitch.channel_id, { type: 'poll_end' });
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

app.post('/api/game/start', verifyTwitchJWT, requireBroadcasterOrMod, safeRoute(async (req, res) => {
  const { durationSec } = req.body;
  const channelId = req.twitch.channel_id;
  const ch = getChannel(channelId);
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

  // Fin automatique : on laisse 1,5s de marge après le minuteur pour laisser
  // le temps aux derniers scores des viewers d'arriver au serveur.
  const t = setTimeout(() => runGameResults(channelId), (duration + 1.5) * 1000);
  ch.gameTimers.push(t);

  res.json({ ok: true });
}));

app.post('/api/game/score', verifyTwitchJWT, (req, res) => {
  const ch = getChannel(req.twitch.channel_id);
  if(!ch.game || ch.game.finished) return res.status(400).send('Aucune manche en cours');

  // Anti-triche basique : borne le nombre de clics à un maximum plausible
  const clicks = Math.min(Number(req.body.clicks) || 0, 500);
  const userId = req.twitch.user_id;
  const displayName = (typeof req.body.displayName === 'string') ? req.body.displayName.slice(0,40) : null;

  const prev = ch.game.scores.get(userId);
  if(!prev || clicks > prev.score){
    ch.game.scores.set(userId, { name: displayName, score: clicks });
  }
  res.json({ ok: true });
});

function buildLeaderboard(game){
  return Array.from(game.scores.values())
    .sort((a,b) => b.score - a.score)
    .slice(0,10);
}

async function runGameResults(channelId){
  const ch = getChannel(channelId);
  if(!ch.game || ch.game.finished) return; // déjà conclue (ex: bouton manuel entre-temps)
  clearGameTimers(ch);
  ch.game.finished = true;
  const leaderboard = buildLeaderboard(ch.game);

  await sendBroadcast(channelId, {
    type: 'game_round_end',
    leaderboard
  });
  setTimeout(() => sendBroadcast(channelId, { type: 'clear_display' }), ch.settings.gameResultDisplaySec * 1000);
  return leaderboard;
}

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
  await sendBroadcast(req.twitch.channel_id, { type: 'celebrate' });
  res.json({ ok: true });
}));

app.get('/', (req, res) => res.send('EBS extension Twitch — OK'));

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
        <li><strong>Scores du mini-jeu</strong> : le nombre de clics que tu réalises pendant une manche, pour établir un classement temporaire.</li>
      </ul>
      <p>Aucune donnée n'est vendue, partagée avec des tiers, ou conservée au-delà de la durée du live / de la fonctionnalité concernée. Les données sont stockées temporairement en mémoire sur le serveur de l'extension et supprimées au redémarrage du service.</p>
      <p>Pour toute question, contacte le développeur de cette extension via son profil Twitch.</p>
    </body>
    </html>
  `);
});

app.listen(PORT, () => console.log(`EBS démarré sur le port ${PORT}`));
