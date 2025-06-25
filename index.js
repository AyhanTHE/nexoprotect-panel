// =================================================================
//        INDEX.JS COMPLET POUR LE PANEL WEB (RENDER.COM)
// =================================================================
// Version mise à jour pour inclure la gestion du profil utilisateur
// et un système de statut VIP.
// =================================================================

// --- IMPORTS ---
const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const { MongoClient } = require('mongodb');
const session = require('express-session');
require('dotenv').config();

// --- INITIALISATION ---
const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);

// --- MIDDLEWARES ---
app.use(express.static(path.join(__dirname, 'src', 'dashboard', 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'une-super-phrase-secrete-pour-nexoprotect',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: true, httpOnly: true, maxAge: 1000 * 60 * 60 * 24 }
}));

// --- CONNEXION À LA BASE DE DONNÉES ---
const mongoClient = new MongoClient(process.env.DATABASE_URL);
let db;
mongoClient.connect()
    .then(() => {
        console.log('✅ Panel web connecté à la base de données MongoDB !');
        db = mongoClient.db('nexoprotect_db');
    })
    .catch(err => console.error("❌ Erreur de connexion à MongoDB:", err));

// --- ROUTES DE L'APPLICATION ---

// Page d'accueil
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'src', 'dashboard', 'views', 'index.html')));

// Callback Discord
app.get('/callback', async (req, res) => {
    // ... (code de la route callback inchangé)
    const code = req.query.code;
    if (!code) return res.status(400).send('Erreur: "code" manquant.');
    try {
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            body: new URLSearchParams({
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET,
                grant_type: 'authorization_code',
                code,
                redirect_uri: process.env.REDIRECT_URI,
            }),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        const tokenData = await tokenResponse.json();
        if (tokenData.error) throw new Error(tokenData.error_description);

        const userResponse = await fetch('https://discord.com/api/users/@me', {
            headers: { authorization: `Bearer ${tokenData.access_token}` },
        });
        const userData = await userResponse.json();

        req.session.accessToken = tokenData.access_token;
        req.session.user = userData;
        req.session.save(() => res.redirect('/dashboard'));
    } catch (error) {
        console.error("Erreur critique dans /callback:", error);
        res.status(500).send('Une erreur interne est survenue.');
    }
});

// Page du tableau de bord
app.get('/dashboard', (req, res) => {
    if (!req.session.user) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'src', 'dashboard', 'views', 'dashboard.html'));
});

// Déconnexion
app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});


// --- NOUVELLES ROUTES API ---

// API pour les informations de l'utilisateur (avec statut VIP)
app.get('/api/user', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Non authentifié' });
    }
    
    try {
        const usersCollection = db.collection('users');
        const userDbInfo = await usersCollection.findOne({ userId: req.session.user.id });

        let grade = "Utilisateur";
        if (userDbInfo && userDbInfo.vipExpires && new Date(userDbInfo.vipExpires) > new Date()) {
            grade = "VIP";
        }
        
        res.json({
            ...req.session.user,
            grade: grade,
            vipExpires: userDbInfo ? userDbInfo.vipExpires : null
        });

    } catch (error) {
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// API pour réclamer le statut VIP
app.post('/api/claim-vip', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Non authentifié' });
    }

    try {
        const usersCollection = db.collection('users');
        const userDbInfo = await usersCollection.findOne({ userId: req.session.user.id });

        // On vérifie si l'utilisateur n'est pas déjà VIP pour éviter les abus
        if (userDbInfo && userDbInfo.vipExpires && new Date(userDbInfo.vipExpires) > new Date()) {
            return res.status(400).json({ message: 'Vous êtes déjà VIP.' });
        }

        const expirationDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // VIP pour 24 heures

        await usersCollection.updateOne(
            { userId: req.session.user.id },
            { $set: { vipExpires: expirationDate } },
            { upsert: true } // Crée le document s'il n'existe pas
        );

        res.json({ success: true, vipExpires: expirationDate });

    } catch (error) {
        res.status(500).json({ error: 'Erreur serveur' });
    }
});


// API pour la liste des serveurs (code inchangé)
app.get('/api/guilds', async (req, res) => {
    // ... Le code de cette route reste le même
    if (!req.session.accessToken) return res.status(401).json({ error: 'Non authentifié' });
    if (!db) return res.status(503).json({ error: 'Service momentanément indisponible' });
    try {
        const guildsResponse = await fetch('https://discord.com/api/users/@me/guilds', {
            headers: { authorization: `Bearer ${req.session.accessToken}` },
        });
        const userGuilds = await guildsResponse.json();
        if (!Array.isArray(userGuilds)) throw new Error('Réponse invalide');
        const adminGuilds = userGuilds.filter(g => (BigInt(g.permissions) & 8n) === 8n);
        const botGuildsCollection = db.collection('botGuilds');
        const botGuilds = await botGuildsCollection.find({}, { projection: { guildId: 1 } }).toArray();
        const botGuildIds = new Set(botGuilds.map(g => g.guildId));
        const result = adminGuilds.map(guild => ({...guild, botOnServer: botGuildIds.has(guild.id)}));
        res.json(result);
    } catch (error) {
        console.error("Erreur dans /api/guilds:", error);
        res.status(500).json({ error: 'Erreur interne du serveur' });
    }
});


// --- DÉMARRAGE DU SERVEUR ---
app.listen(PORT, () => {
    console.log(`✅ Serveur web du panel démarré et à l'écoute sur le port ${PORT}`);
});
