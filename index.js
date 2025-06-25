// =================================================================
//        INDEX.JS COMPLET POUR LE PANEL WEB (RENDER.COM)
// =================================================================
// Version mise à jour pour corriger le problème de redirection
// en faisant confiance au proxy de Render.com.
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
app.use(express.static(path.join(__dirname, 'src', 'dashboard', 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: process.env.SESSION_SECRET || 'une-super-phrase-secrete-pour-nexoprotect',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: true, // Doit être 'true' car Render est en HTTPS
        httpOnly: true, // Empêche l'accès au cookie via JavaScript côté client
        maxAge: 1000 * 60 * 60 * 24 // 1 jour
    }
}));


// --- CONNEXION À LA BASE DE DONNÉES ---
// (Code inchangé)
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

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'src', 'dashboard', 'views', 'index.html'));
});

app.get('/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('Erreur: "code" manquant.');

    try {
        // ... (échange de code contre token)
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

        // On sauvegarde les infos dans la session
        req.session.accessToken = tokenData.access_token;
        req.session.user = userData;
        
        // Log pour vérifier que la session est bien sauvegardée AVANT la redirection
        console.log(`[CALLBACK] Session sauvegardée pour l'utilisateur: ${req.session.user.username}`);

        // On s'assure que la session est bien enregistrée avant de rediriger
        req.session.save(() => {
            res.redirect('/dashboard');
        });

    } catch (error) {
        console.error("Erreur critique dans /callback:", error);
        res.status(500).send('Une erreur interne est survenue.');
    }
});

app.get('/dashboard', (req, res) => {
    // Log pour vérifier l'état de la session quand on arrive sur le dashboard
    console.log(`[DASHBOARD] Tentative d'accès par:`, req.session.user ? req.session.user.username : 'Utilisateur non identifié');

    if (!req.session.user) {
        return res.redirect('/');
    }
    res.sendFile(path.join(__dirname, 'src', 'dashboard', 'views', 'dashboard.html'));
});

// (Les autres routes, comme /api/guilds, restent inchangées)
app.get('/api/guilds', async (req, res) => {
    if (!req.session.accessToken) {
        return res.status(401).json({ error: 'Non authentifié' });
    }
    try {
        const guildsResponse = await fetch('https://discord.com/api/users/@me/guilds', {
            headers: { authorization: `Bearer ${req.session.accessToken}` },
        });
        const guilds = await guildsResponse.json();
        const adminGuilds = guilds.filter(guild => (BigInt(guild.permissions) & 8n) === 8n);
        res.json(adminGuilds);
    } catch (error) {
        res.status(500).json({ error: 'Erreur interne du serveur' });
    }
});


// --- DÉMARRAGE DU SERVEUR ---
app.listen(PORT, () => {
    console.log(`✅ Serveur web du panel démarré et à l'écoute sur le port ${PORT}`);
});
