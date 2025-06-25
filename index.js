// =================================================================
//        INDEX.JS COMPLET POUR LE PANEL WEB (RENDER.COM)
// =================================================================
// Ce fichier gère l'ensemble de votre panel.
// Version mise à jour pour inclure la gestion des sessions utilisateur
// et l'affichage du tableau de bord des serveurs.
// =================================================================

// --- IMPORTS ---
const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const { MongoClient } = require('mongodb');
const session = require('express-session'); // Ajout pour les sessions
require('dotenv').config();

// --- INITIALISATION ---
const app = express();
const PORT = process.env.PORT || 3000;

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
        secure: process.env.NODE_ENV === 'production', // Mettre 'true' en production si vous êtes en HTTPS
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
    if (!code) {
        return res.status(400).send('Erreur: "code" manquant.');
    }

    try {
        // Échange du code contre un access token
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

        // Récupération des infos de l'utilisateur
        const userResponse = await fetch('https://discord.com/api/users/@me', {
            headers: { authorization: `Bearer ${tokenData.access_token}` },
        });
        const userData = await userResponse.json();

        // Sauvegarde des informations dans la session
        req.session.accessToken = tokenData.access_token;
        req.session.user = userData;

        // Redirection vers le tableau de bord
        res.redirect('/dashboard');

    } catch (error) {
        console.error("Erreur critique dans /callback:", error);
        res.status(500).send('Une erreur interne est survenue.');
    }
});

// Route du Tableau de Bord
app.get('/dashboard', (req, res) => {
    // Si l'utilisateur n'est pas stocké dans la session, on le renvoie à l'accueil
    if (!req.session.user) {
        return res.redirect('/');
    }
    // Sinon, on lui envoie la page HTML du tableau de bord
    res.sendFile(path.join(__dirname, 'src', 'dashboard', 'views', 'dashboard.html'));
});

// API pour obtenir la liste des serveurs de l'utilisateur
app.get('/api/guilds', async (req, res) => {
    // Si pas de token d'accès, l'utilisateur n'est pas autorisé
    if (!req.session.accessToken) {
        return res.status(401).json({ error: 'Non authentifié' });
    }

    try {
        const guildsResponse = await fetch('https://discord.com/api/users/@me/guilds', {
            headers: { authorization: `Bearer ${req.session.accessToken}` },
        });
        const guilds = await guildsResponse.json();

        // Filtre pour ne garder que les serveurs où l'utilisateur a la permission "Administrator"
        const adminGuilds = guilds.filter(guild => {
            const permissions = BigInt(guild.permissions);
            const isAdmin = (permissions & 8n) === 8n; // La permission "Administrator" a la valeur 8
            return isAdmin;
        });

        res.json(adminGuilds);

    } catch (error) {
        console.error("Erreur en récupérant les serveurs:", error);
        res.status(500).json({ error: 'Erreur interne du serveur' });
    }
});

// Route pour enregistrer les paramètres (pour le futur)
app.post('/save-settings', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ message: 'Non authentifié' });
    }
    // ... le reste de votre logique de sauvegarde ...
    res.status(200).json({ message: 'Logique de sauvegarde à implémenter' });
});


// --- DÉMARRAGE DU SERVEUR ---
app.listen(PORT, () => {
    console.log(`✅ Serveur web du panel démarré et à l'écoute sur le port ${PORT}`);
});
