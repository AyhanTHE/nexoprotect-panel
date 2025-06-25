// =================================================================
//        INDEX.JS COMPLET POUR LE PANEL WEB (RENDER.COM)
// =================================================================
// Version mise à jour pour gérer l'affichage conditionnel des
// boutons "Inviter" / "Gérer" dans le tableau de bord.
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

// --- CONFIGURATION CRUCIALE POUR RENDER.COM ---
// Cette ligne est ESSENTIELLE pour que les sessions fonctionnent derrière un proxy.
app.set('trust proxy', 1);


// --- MIDDLEWARES ---
// Sert les fichiers statiques (CSS, JS client, images) depuis le dossier 'public'
app.use(express.static(path.join(__dirname, 'src', 'dashboard', 'public')));
// Permet à Express de comprendre les données envoyées en JSON
app.use(express.json());
// Permet à Express de comprendre les données des formulaires
app.use(express.urlencoded({ extended: true }));
// Middleware pour gérer les sessions utilisateur
app.use(session({
    // Ce secret sert à sécuriser les cookies de session.
    // Pour une meilleure sécurité, placez-le dans vos variables d'environnement.
    secret: process.env.SESSION_SECRET || 'une-super-phrase-secrete-pour-nexoprotect',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: true, // Doit être 'true' car Render est en HTTPS
        httpOnly: true, // Empêche l'accès au cookie via JavaScript côté client
        maxAge: 1000 * 60 * 60 * 24 // Durée de vie du cookie de session (ici, 1 jour)
    }
}));


// --- CONNEXION À LA BASE DE DONNÉES ---
const mongoClient = new MongoClient(process.env.DATABASE_URL);
let db;
mongoClient.connect()
    .then(() => {
        console.log('✅ Panel web connecté à la base de données MongoDB !');
        db = mongoClient.db('nexoprotect_db');
    })
    .catch(err => {
        console.error("❌ Erreur de connexion à MongoDB pour le panel:", err);
        process.exit(1);
    });


// --- ROUTES DE L'APPLICATION ---

// Route principale : affiche la page d'accueil
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'src', 'dashboard', 'views', 'index.html'));
});

// Route de Callback : gère le retour de l'authentification Discord
app.get('/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('Erreur: "code" manquant.');

    try {
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            body: new URLSearchParams({
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
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
        
        console.log(`[CALLBACK] Session sauvegardée pour: ${req.session.user.username}`);

        req.session.save(() => {
            res.redirect('/dashboard');
        });

    } catch (error) {
        console.error("Erreur critique dans /callback:", error);
        res.status(500).send('Une erreur interne est survenue.');
    }
});

// Route du Tableau de Bord (page)
app.get('/dashboard', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/');
    }
    res.sendFile(path.join(__dirname, 'src', 'dashboard', 'views', 'dashboard.html'));
});

// Route de Déconnexion
app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.redirect('/dashboard');
        }
        res.clearCookie('connect.sid');
        res.redirect('/');
    });
});


// API pour obtenir la liste des serveurs de l'utilisateur
app.get('/api/guilds', async (req, res) => {
    if (!req.session.accessToken) {
        return res.status(401).json({ error: 'Non authentifié' });
    }
    if (!db) {
        return res.status(503).json({ error: 'Service momentanément indisponible' });
    }

    try {
        // 1. Récupérer les serveurs où l'utilisateur est admin via l'API Discord
        const guildsResponse = await fetch('https://discord.com/api/users/@me/guilds', {
            headers: { authorization: `Bearer ${req.session.accessToken}` },
        });
        const userGuilds = await guildsResponse.json();
        if (!Array.isArray(userGuilds)) throw new Error('Réponse invalide de l\'API Discord');
        
        const adminGuilds = userGuilds.filter(guild => (BigInt(guild.permissions) & 8n) === 8n);

        // 2. Récupérer la liste des serveurs où le BOT est présent depuis la base de données
        // IMPORTANT : Votre bot doit écrire dans cette collection quand il rejoint/quitte un serveur !
        const botGuildsCollection = db.collection('botGuilds');
        const botGuildsCursor = botGuildsCollection.find({}, { projection: { guildId: 1 } });
        const botGuilds = await botGuildsCursor.toArray();
        const botGuildIds = new Set(botGuilds.map(g => g.guildId));

        // 3. Comparer les deux listes et ajouter un indicateur `botOnServer`
        const result = adminGuilds.map(guild => ({
            ...guild,
            botOnServer: botGuildIds.has(guild.id)
        }));

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
