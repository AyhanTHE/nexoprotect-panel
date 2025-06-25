// =================================================================
//        INDEX.JS COMPLET POUR LE PANEL WEB (AVEC EJS)
// =================================================================
// Version fiabilisée pour garantir la récupération des rôles
// et le bon fonctionnement de la page de gestion.
// =================================================================

// --- IMPORTS ---
const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const { MongoClient } = require('mongodb');
const session = require('express-session');
require('dotenv').config();

// --- INITIALISATION & CONFIGURATION ---
const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src', 'dashboard', 'views'));

// --- MIDDLEWARES ---
app.use(express.static(path.join(__dirname, 'src', 'dashboard', 'public')));
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


// --- ROUTES DE L'APPLICATION ---

app.get('/', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.render('index');
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

app.get('/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('Erreur: "code" manquant.');
    try {
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            body: new URLSearchParams({
                client_id: process.env.CLIENT_ID, client_secret: process.env.CLIENT_SECRET,
                grant_type: 'authorization_code', code, redirect_uri: process.env.REDIRECT_URI,
            }),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        const tokenData = await tokenResponse.json();
        if (tokenData.error) throw new Error(tokenData.error_description);
        const userResponse = await fetch('https://discord.com/api/users/@me', { headers: { authorization: `Bearer ${tokenData.access_token}` } });
        const userData = await userResponse.json();
        req.session.accessToken = tokenData.access_token;
        req.session.user = userData;
        req.session.save(() => res.redirect('/dashboard'));
    } catch (error) {
        console.error("Erreur critique dans /callback:", error);
        res.status(500).send('Une erreur interne est survenue.');
    }
});

app.get('/dashboard', async (req, res) => {
    if (!req.session.user) return res.redirect('/');
    try {
        const usersCollection = db.collection('users');
        const userDbInfo = await usersCollection.findOne({ userId: req.session.user.id });
        const grade = (userDbInfo && userDbInfo.vipExpires && new Date(userDbInfo.vipExpires) > new Date()) ? "VIP" : "Utilisateur";
        const user = { ...req.session.user, grade };
        const guildsResponse = await fetch('https://discord.com/api/users/@me/guilds', { headers: { authorization: `Bearer ${req.session.accessToken}` } });
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

// ROUTE /manage/:guildId CORRIGÉE ET FIABILISÉE
app.get('/manage/:guildId', async (req, res) => {
    if (!req.session.user) return res.redirect('/');
    
    try {
        const discordApi = 'https://discord.com/api/v10';
        const botAuthHeader = { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` };

        // 1. Récupérer toutes les données de l'API Discord en parallèle
        const [guildResponse, channelsResponse, rolesResponse, botMemberResponse] = await Promise.all([
            fetch(`${discordApi}/guilds/${req.params.guildId}`, { headers: botAuthHeader }),
            fetch(`${discordApi}/guilds/${req.params.guildId}/channels`, { headers: botAuthHeader }),
            fetch(`${discordApi}/guilds/${req.params.guildId}/roles`, { headers: botAuthHeader }),
            fetch(`${discordApi}/guilds/${req.params.guildId}/members/${process.env.CLIENT_ID}`, { headers: botAuthHeader })
        ]);

        if (!guildResponse.ok) throw new Error('Impossible de récupérer les infos du serveur.');

        // 2. Traiter les réponses JSON
        const [guildData, channelsData, rolesData] = await Promise.all([
            guildResponse.json(), channelsResponse.json(), rolesResponse.json()
        ]);
        
        const botMember = botMemberResponse.ok ? await botMemberResponse.json() : null;
        
        // 3. Récupérer les données de notre base de données
        const [userDbInfo, guildSettings] = await Promise.all([
            db.collection('users').findOne({ userId: req.session.user.id }),
            db.collection('settings').findOne({ guildId: req.params.guildId })
        ]);
        
        // 4. Préparer les données pour la page EJS
        const grade = (userDbInfo && userDbInfo.vipExpires && new Date(userDbInfo.vipExpires) > new Date()) ? "VIP" : "Utilisateur";
        const user = { ...req.session.user, grade };
        const textChannels = Array.isArray(channelsData) ? channelsData.filter(c => c.type === 0) : [];
        
        const botHighestRolePosition = (botMember && Array.isArray(botMember.roles)) ? botMember.roles.reduce((maxPos, roleId) => {
            const role = rolesData.find(r => r.id === roleId);
            return role && role.position > maxPos ? role.position : maxPos;
        }, 0) : 0;
        
        const roles = Array.isArray(rolesData) ? rolesData
            .filter(role => role.name !== '@everyone' && !role.managed)
            .map(role => ({ ...role, canManage: role.position < botHighestRolePosition }))
            : [];
        
        // 5. Rendre la page avec toutes les données
        res.render('manage-server', {
            user, guild: guildData, channels: textChannels,
            roles, // LA VARIABLE EST MAINTENANT TOUJOURS PRÉSENTE
            settings: guildSettings || {}
        });

    } catch (error) {
        console.error("Erreur de chargement de la page de gestion:", error);
        res.status(500).send("Erreur lors du chargement de la page de gestion.");
    }
});


// --- ROUTES API (Logique de sauvegarde) ---
app.post('/api/settings/:guildId/welcome', async (req, res) => { /* ... */ });
app.post('/api/settings/:guildId/autorole', async (req, res) => { /* ... */ });
app.post('/api/claim-vip', async (req, res) => { /* ... */ });


// --- DÉMARRAGE DU SERVEUR ---
app.listen(PORT, () => console.log(`✅ Serveur web du panel démarré et à l'écoute sur le port ${PORT}`));
