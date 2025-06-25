// =================================================================
//        INDEX.JS COMPLET POUR LE PANEL WEB (AVEC EJS)
// =================================================================
// Version mise à jour pour utiliser EJS comme moteur de modèles.
// Le serveur prépare les données AVANT d'envoyer la page.
// =================================================================

// --- IMPORTS ---
const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const { MongoClient } = require('mongodb');
const session = require('express-session');
const ejs = require('ejs'); // On importe EJS
require('dotenv').config();

// --- INITIALISATION ---
const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);

// --- CONFIGURATION EJS ---
app.set('view engine', 'ejs');
// On indique à Express où trouver les fichiers de vue (.ejs)
app.set('views', path.join(__dirname, 'src', 'dashboard', 'views'));

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
// (Code inchangé)
let db;
const mongoClient = new MongoClient(process.env.DATABASE_URL);
mongoClient.connect()
    .then(() => {
        console.log('✅ Panel web connecté à la base de données MongoDB !');
        db = mongoClient.db('nexoprotect_db');
    })
    .catch(err => console.error("❌ Erreur de connexion à MongoDB:", err));


// --- ROUTES DE L'APPLICATION ---

// Page d'accueil
app.get('/', (req, res) => {
    // On utilise res.render() pour afficher la vue 'index.ejs'
    res.render('index');
});

// Callback Discord (code inchangé)
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

// Déconnexion (code inchangé)
app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

// Route du Tableau de Bord (LOGIQUE PRINCIPALE)
app.get('/dashboard', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/');
    }

    try {
        // --- On prépare TOUTES les données ici ---
        
        // 1. Récupérer les infos de l'utilisateur et son statut VIP
        const usersCollection = db.collection('users');
        const userDbInfo = await usersCollection.findOne({ userId: req.session.user.id });
        let grade = "Utilisateur";
        if (userDbInfo && userDbInfo.vipExpires && new Date(userDbInfo.vipExpires) > new Date()) {
            grade = "VIP";
        }
        const user = { ...req.session.user, grade };

        // 2. Récupérer les serveurs de l'utilisateur (comme avant)
        const guildsResponse = await fetch('https://discord.com/api/users/@me/guilds', {
            headers: { authorization: `Bearer ${req.session.accessToken}` },
        });
        const userGuilds = await guildsResponse.json();
        const adminGuilds = userGuilds.filter(g => (BigInt(g.permissions) & 8n) === 8n);

        // 3. Récupérer les serveurs du bot (comme avant)
        const botGuildsCollection = db.collection('botGuilds');
        const botGuilds = await botGuildsCollection.find({}, { projection: { guildId: 1 } }).toArray();
        const botGuildIds = new Set(botGuilds.map(g => g.guildId));

        // 4. Combiner les informations
        const guilds = adminGuilds.map(guild => ({...guild, botOnServer: botGuildIds.has(guild.id)}));

        // 5. Rendre la page EJS en lui passant toutes les données
        res.render('dashboard', {
            user: user,       // On passe les infos de l'utilisateur
            guilds: guilds    // On passe la liste des serveurs
        });

    } catch (error) {
        console.error("Erreur lors de la préparation du dashboard:", error);
        res.status(500).send("Erreur lors du chargement du tableau de bord.");
    }
});


// API pour réclamer le statut VIP (route POST, reste inchangée)
app.post('/api/claim-vip', async (req, res) => {
    // ... code de cette route inchangé ...
    if (!req.session.user) return res.status(401).json({ error: 'Non authentifié' });
    try {
        const usersCollection = db.collection('users');
        const userDbInfo = await usersCollection.findOne({ userId: req.session.user.id });
        if (userDbInfo && userDbInfo.vipExpires && new Date(userDbInfo.vipExpires) > new Date()) {
            return res.status(400).json({ message: 'Vous êtes déjà VIP.' });
        }
        const expirationDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await usersCollection.updateOne({ userId: req.session.user.id }, { $set: { vipExpires: expirationDate } }, { upsert: true });
        res.json({ success: true, vipExpires: expirationDate });
    } catch (error) {
        res.status(500).json({ error: 'Erreur serveur' });
    }
});


// --- DÉMARRAGE DU SERVEUR ---
app.listen(PORT, () => {
    console.log(`✅ Serveur web du panel démarré et à l'écoute sur le port ${PORT}`);
});
