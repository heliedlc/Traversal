# Traversal

Jeu de stratégie 3D pour 2 joueurs : local, en ligne (classé Elo ou salon privé), contre un bot qui s'entraîne seul en continu.

| Fichier | Rôle |
|---|---|
| `index.html` | Interface 3D (Three.js), menus, jeu local et en ligne |
| `game.js` | Règles, génération des terrains, IA (partagé navigateur / serveur) |
| `server.js` | Serveur web + WebSocket, Elo, bot classé, auto-entraînement |
| `package.json` | Dépendance unique : `ws` |

Les données sont créées automatiquement dans `data/` : `players.json` (comptes + Elo), `games.jsonl` (toutes les parties), `brain.json` (cerveau du bot).

## Jouer sur ton PC

1. Installe Node.js LTS depuis https://nodejs.org
2. Dans le dossier du jeu : `npm install` puis `npm start`
3. Ouvre http://localhost:3000

## Comment le bot progresse

1. Il joue sans arrêt contre lui-même en arrière-plan (thread séparé).
2. Toutes les 24 parties, il ré-apprend les poids de son évaluation sur les 5 000 dernières parties en base (les parties humaines comptent triple), par régression logistique (« Texel tuning », méthode des moteurs d'échecs).
3. Le nouveau cerveau affronte l'ancien sur 20 parties ; il ne le remplace que s'il gagne au moins 55 %.
4. Pour jouer, il utilise une recherche alpha-bêta (approfondissement itératif, table de transposition, quiescence) guidée par ce cerveau.

Variables d'environnement utiles : `PORT` (3000), `BOT_MS` (temps de réflexion du bot classé, 1500), `TRAIN=0` (couper l'entraînement), `SELF_MS` (150), `DATA_DIR`.

## Héberger gratuitement, pour de bon : Oracle Cloud « Always Free »

Pourquoi Oracle : c'est la seule offre qui donne gratuitement et sans limite de durée une vraie machine allumée 24 h/24 avec un disque qui garde les données (indispensable pour l'Elo, les parties et le bot qui s'entraîne en continu). Les offres gratuites type Render s'endorment après 15 min et effacent le disque à chaque redémarrage.

Ce qu'il faut savoir avant :
- Oracle demande une carte bancaire **pour vérifier ton identité** (une pré-autorisation de quelques euros, annulée ensuite). Tant que tu ne cliques pas sur « Upgrade to Pay As You Go », le compte ne peut rien te facturer.
- Oracle récupère les machines gratuites **inutilisées** (CPU très bas pendant 7 jours). Ici le bot calcule en permanence, donc la machine reste active.
- La région d'origine choisie à l'inscription est définitive.

### Étape 1 — Mettre le code sur GitHub
1. Crée un compte sur https://github.com
2. « New repository », nom `traversal`, Public, « Create repository ».
3. « uploading an existing file » : glisse `index.html`, `game.js`, `server.js`, `package.json`, `README.md` (pas `node_modules`, pas `data`). « Commit changes ».

### Étape 2 — Créer le compte Oracle Cloud
1. https://www.oracle.com/cloud/free → « Start for free ».
2. Choisis une région proche (ex. France Central (Paris) ou Germany Central (Frankfurt)).
3. Valide l'e-mail, le téléphone et la carte.

### Étape 3 — Créer la machine virtuelle
1. Menu ☰ → Compute → Instances → « Create instance ».
2. Image : « Change image » → Canonical Ubuntu 24.04.
3. Shape : « Change shape » → Ampere → `VM.Standard.A1.Flex`, 2 OCPU, 12 Go de RAM (gratuit jusqu'à 4 OCPU / 24 Go).
   - Si « Out of capacity » : réessaie plus tard ou dans un autre « Availability domain », ou prends `VM.Standard.E2.1.Micro` (AMD, aussi gratuit, plus petit mais suffisant).
4. Networking : laisse « Create new virtual cloud network » et « Assign a public IPv4 address ».
5. SSH keys : « Generate a key pair for me » → **Save private key** (garde ce fichier `.key` précieusement).
6. « Create ». Quand l'état passe à RUNNING, note l'**adresse IP publique**.

### Étape 4 — Ouvrir les ports web (80 et 443)
1. Sur la page de l'instance, clique le lien du **Subnet** → « Security Lists » → « Default Security List ».
2. « Add Ingress Rules » : Source CIDR `0.0.0.0/0`, IP Protocol TCP, Destination Port Range `80,443` → « Add ».

### Étape 5 — Se connecter à la machine depuis Windows
Dans PowerShell :
```
icacls "C:\chemin\vers\ssh-key.key" /inheritance:r /grant:r "$($env:USERNAME):R"
ssh -i "C:\chemin\vers\ssh-key.key" ubuntu@TON_IP
```
Tape `yes` à la première connexion.

### Étape 6 — Installer Node.js et le jeu (sur la machine)
```
sudo apt update && sudo apt -y upgrade
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git
git clone https://github.com/TON_PSEUDO/traversal.git
cd traversal && npm install
```

### Étape 7 — Ouvrir le pare-feu interne d'Ubuntu (spécifique Oracle)
```
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

### Étape 8 — Lancer le jeu en permanence avec pm2
```
sudo npm install -g pm2
pm2 start server.js --name traversal
pm2 save
pm2 startup
```
`pm2 startup` affiche une commande `sudo env PATH=...` : copie-la et exécute-la. Le jeu redémarre seul après un plantage ou un redémarrage de la machine.

### Étape 9 — Un nom de domaine gratuit (DuckDNS)
1. https://www.duckdns.org → connexion avec GitHub.
2. Choisis un sous-domaine (ex. `traversal-olivier`) → « add domain ».
3. Dans « current ip », mets l'IP publique d'Oracle → « update ip ».
Ton adresse : `traversal-olivier.duckdns.org`.

### Étape 10 — HTTPS automatique avec Caddy
```
sudo apt install -y caddy
echo 'traversal-olivier.duckdns.org {
    reverse_proxy localhost:3000
}' | sudo tee /etc/caddy/Caddyfile
sudo systemctl restart caddy
```
Caddy obtient et renouvelle tout seul un certificat HTTPS gratuit (Let's Encrypt) et transmet les WebSockets. Ouvre `https://traversal-olivier.duckdns.org` : c'est en ligne.

### Mettre à jour le jeu plus tard
Modifie les fichiers sur GitHub, puis sur la machine :
```
cd ~/traversal && git pull && pm2 restart traversal
```

### Surveiller et sauvegarder
- Journal (dont les progrès du bot) : `pm2 logs traversal`
- Sauvegarde des données sur ton PC (PowerShell) : `scp -i "C:\chemin\ssh-key.key" -r ubuntu@TON_IP:~/traversal/data .`

### Plan B sans carte bancaire (avec limites)
Render.com (offre gratuite « Web Service », connecté à ton GitHub, Start command `node server.js`) fonctionne pour jouer, mais le serveur s'endort après 15 min sans visite (≈ 1 min de réveil), le bot ne s'entraîne pas pendant ce temps, et **le disque est effacé à chaque redémarrage** : Elo et parties perdus. Bien pour une démo, pas pour le « Stockfish de Traversal ».
