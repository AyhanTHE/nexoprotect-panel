// =================================================================
//        INDEX.JS COMPLET POUR LE PANEL WEB (AVEC EJS)
// =================================================================
// Version mise à jour pour augmenter la limite de taille des
// requêtes, corrigeant l'erreur 413 "Payload Too Large".
// =================================================================

// --- IMPORTS ---
const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const { MongoClient } = require('mongodb');
const session = require('express-session');
const ejs = require('ejs');
require('dotenv').config();

// --- INITIALISATION & CONFIGURATION ---
const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src', 'dashboard', 'views'));

// --- MIDDLEWARES ---
app.use(express.static(path.join(__dirname, 'src', 'dashboard', 'public')));

// *** CORRECTION IMPORTANTE ***
// On augmente la limite de taille pour accepter les images en Base64.
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use(session({
    secret: process.env.SESSION_SECRET || 'une-super-phrase-secrete-pour-nexoprotect',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: true, httpOnly: true, maxAge: 1000 * 60 * 60 * 24 }
}));

// --- CONNEXION À LA BASE DE DONNÉES ---
let db;
const mongoClient = new MongoClient(process.env.DATABASE_URL);
mongoClient.connect().then(() => {
    console.log('✅ Panel web connecté à la base de données MongoDB !');
    db = mongoClient.db('nexoprotect_db');
}).catch(err => console.error("❌ Erreur de connexion à MongoDB:", err));


// --- ROUTES DE L'APPLICATION (Le reste du code est inchangé) ---

// Page d'accueil
app.get('/', (req, res) => {
    res.render('index');
});

// Callback Discord
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

// Déconnexion
app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

// Route du Tableau de Bord
app.get('/dashboard', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/');
    }
    try {
        const usersCollection = db.collection('users');
        const userDbInfo = await usersCollection.findOne({ userId: req.session.user.id });
        let grade = (userDbInfo && userDbInfo.vipExpires && new Date(userDbInfo.vipExpires) > new Date()) ? "VIP" : "Utilisateur";
        const user = { ...req.session.user, grade };

        const guildsResponse = await fetch('https://discord.com/api/users/@me/guilds', {
            headers: { authorization: `Bearer ${req.session.accessToken}` },
        });
        const userGuilds = await guildsResponse.json();
        const adminGuilds = userGuilds.filter(g => (BigInt(g.permissions) & 8n) === 8n);
        
        const botGuildsCollection = db.collection('botGuilds');
        const botGuilds = await botGuildsCollection.find({}, { projection: { guildId: 1 } }).toArray();
        const botGuildIds = new Set(botGuilds.map(g => g.guildId));

        const guilds = adminGuilds.map(guild => ({...guild, botOnServer: botGuildIds.has(guild.id)}));

        res.render('dashboard', { user, guilds });

    } catch (error) {
        console.error("Erreur lors de la préparation du dashboard:", error);
        res.status(500).send("Erreur lors du chargement du tableau de bord.");
    }
});

// Page de gestion de serveur
app.get('/manage/:guildId', async (req, res) => {
    if (!req.session.user) return res.redirect('/');
    
    try {
        const discordApi = 'https://discord.com/api/v10';
        const botAuthHeader = { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` };

        const guildResponse = await fetch(`${discordApi}/guilds/${req.params.guildId}`, { headers: botAuthHeader });
        if (!guildResponse.ok) throw new Error('Impossible de récupérer les informations du serveur.');
        const guildData = await guildResponse.json();
        
        const channelsResponse = await fetch(`${discordApi}/guilds/${req.params.guildId}/channels`, { headers: botAuthHeader });
        const channelsData = await channelsResponse.json();
        const textChannels = channelsData.filter(c => c.type === 0);

        const usersCollection = db.collection('users');
        const userDbInfo = await usersCollection.findOne({ userId: req.session.user.id });
        let grade = (userDbInfo && userDbInfo.vipExpires && new Date(userDbInfo.vipExpires) > new Date()) ? "VIP" : "Utilisateur";
        const user = { ...req.session.user, grade };

        const settingsCollection = db.collection('settings');
        const guildSettings = await settingsCollection.findOne({ guildId: req.params.guildId });
        
        res.render('manage-server', {
            user: user,
            guild: guildData,
            channels: textChannels,
            settings: guildSettings || {}
        });

    } catch (error) {
        console.error("Erreur de chargement de la page de gestion:", error);
        res.status(500).send("Erreur lors du chargement de la page de gestion.");
    }
});

// --- ROUTES API ---

app.post('/api/settings/:guildId/welcome', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Non authentifié' });
    
    try {
        const settingsCollection = db.collection('settings');
        const { enabled, channelId, message, bannerUrl } = req.body;

        const usersCollection = db.collection('users');
        const userDbInfo = await usersCollection.findOne({ userId: req.session.user.id });
        const isVip = (userDbInfo && userDbInfo.vipExpires && new Date(userDbInfo.vipExpires) > new Date());
        
        const updateData = {
            'welcome.enabled': enabled,
            'welcome.channelId': channelId,
            'welcome.message': message,
        };
        if (isVip) {
            updateData['welcome.bannerUrl'] = bannerUrl;
        }

        await settingsCollection.updateOne(
            { guildId: req.params.guildId },
            { $set: updateData },
            { upsert: true }
        );

        res.json({ success: true, message: 'Paramètres de bienvenue enregistrés !' });

    } catch (error) {
        res.status(500).json({ error: 'Erreur serveur lors de la sauvegarde.' });
    }
});

app.post('/api/settings/:guildId/goodbye', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Non authentifié' });
    
    try {
        const settingsCollection = db.collection('settings');
        const { enabled, channelId, message } = req.body;
        
        const updateData = {
            'goodbye.enabled': enabled,
            'goodbye.channelId': channelId,
            'goodbye.message': message,
        };

        await settingsCollection.updateOne(
            { guildId: req.params.guildId },
            { $set: updateData },
            { upsert: true }
        );

        res.json({ success: true, message: 'Paramètres d\'au revoir enregistrés !' });

    } catch (error) {
        res.status(500).json({ error: 'Erreur serveur lors de la sauvegarde.' });
    }
});

app.post('/api/claim-vip', async (req, res) => {
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
