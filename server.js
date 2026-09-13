require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');

const CLIENT_ID = process.env.EXTENSION_CLIENT_ID;
const SECRET = Buffer.from(process.env.EXTENSION_SECRET, 'base64');
const PORT = process.env.PORT || 8081;

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
      poll: null,        // { question, options:[{label,votes}], voters:Set, durationSec, endsAt }
      giveaway: null,     // { entrants:Map(userId->name), winner, durationSec, endsAt }
      game: null          // { endsAt, finished, scores:Map(userId->{name,score}) }
    });
  }
  return channels.get(channelId);
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
    next();
  }catch(e){
    return res.status(401).send('Token invalide');
  }
}

function requireBroadcasterOrMod(req, res, next){
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
    winner: ch.giveaway.winner
  } : null;

  const game = ch.game ? {
    endsAt: ch.game.endsAt,
    finished: ch.game.finished,
    leaderboard: ch.game.finished ? buildLeaderboard(ch.game) : undefined
  } : null;

  res.json({ poll, giveaway, game });
});

/* =========================================================
   SONDAGE
   ========================================================= */
app.post('/api/poll/start', verifyTwitchJWT, requireBroadcasterOrMod, async (req, res) => {
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
});

app.post('/api/poll/vote', verifyTwitchJWT, async (req, res) => {
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
});

app.post('/api/poll/end', verifyTwitchJWT, requireBroadcasterOrMod, async (req, res) => {
  const ch = getChannel(req.twitch.channel_id);
  ch.poll = null;
  await sendBroadcast(req.twitch.channel_id, { type: 'poll_end' });
  res.json({ ok: true });
});

/* =========================================================
   GIVE AWAY
   ========================================================= */
app.post('/api/giveaway/start', verifyTwitchJWT, requireBroadcasterOrMod, async (req, res) => {
  const { durationSec } = req.body;
  const ch = getChannel(req.twitch.channel_id);
  ch.giveaway = {
    entrants: new Map(),
    winner: null,
    endsAt: durationSec ? Date.now() + durationSec*1000 : null
  };
  await sendBroadcast(req.twitch.channel_id, { type: 'giveaway_start' });
  res.json({ ok: true });
});

app.post('/api/giveaway/join', verifyTwitchJWT, async (req, res) => {
  const ch = getChannel(req.twitch.channel_id);
  if(!ch.giveaway || ch.giveaway.winner) return res.status(400).send('Aucune inscription ouverte');
  const userId = req.twitch.user_id;
  if(ch.giveaway.entrants.has(userId)) return res.status(409).send('Déjà inscrit·e');

  // Nom d'affichage optionnel, uniquement si le viewer a partagé son identité côté client
  const displayName = (typeof req.body.displayName === 'string') ? req.body.displayName.slice(0,40) : null;
  ch.giveaway.entrants.set(userId, displayName);

  await sendBroadcast(req.twitch.channel_id, {
    type: 'giveaway_update',
    entryCount: ch.giveaway.entrants.size
  });
  res.json({ ok: true, entryCount: ch.giveaway.entrants.size });
});

app.post('/api/giveaway/draw', verifyTwitchJWT, requireBroadcasterOrMod, async (req, res) => {
  const ch = getChannel(req.twitch.channel_id);
  if(!ch.giveaway || ch.giveaway.entrants.size === 0){
    return res.status(400).send('Aucun·e participant·e');
  }
  const ids = Array.from(ch.giveaway.entrants.keys());
  const winnerId = ids[Math.floor(Math.random()*ids.length)];
  const winnerName = ch.giveaway.entrants.get(winnerId) || 'un·e viewer mystère';
  ch.giveaway.winner = winnerName;

  await sendBroadcast(req.twitch.channel_id, {
    type: 'giveaway_winner',
    winnerName
  });
  res.json({ ok: true, winnerName });
});

/* =========================================================
   MINI-JEU — Chasse aux clics
   ========================================================= */
app.post('/api/game/start', verifyTwitchJWT, requireBroadcasterOrMod, async (req, res) => {
  const { durationSec } = req.body;
  const duration = Number(durationSec) || 15;
  const ch = getChannel(req.twitch.channel_id);
  ch.game = {
    endsAt: Date.now() + duration*1000,
    finished: false,
    scores: new Map()
  };
  await sendBroadcast(req.twitch.channel_id, {
    type: 'game_round_start',
    durationSec: duration
  });
  res.json({ ok: true });
});

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

app.post('/api/game/results', verifyTwitchJWT, requireBroadcasterOrMod, async (req, res) => {
  const ch = getChannel(req.twitch.channel_id);
  if(!ch.game) return res.status(400).send('Aucune manche à conclure');
  ch.game.finished = true;
  const leaderboard = buildLeaderboard(ch.game);

  await sendBroadcast(req.twitch.channel_id, {
    type: 'game_round_end',
    leaderboard
  });
  res.json({ ok: true, leaderboard });
});

/* =========================================================
   CÉLÉBRATION LIBRE (confettis à la demande)
   ========================================================= */
app.post('/api/celebrate', verifyTwitchJWT, requireBroadcasterOrMod, async (req, res) => {
  await sendBroadcast(req.twitch.channel_id, { type: 'celebrate' });
  res.json({ ok: true });
});

app.get('/', (req, res) => res.send('EBS extension Twitch — OK'));

app.listen(PORT, () => console.log(`EBS démarré sur le port ${PORT}`));
