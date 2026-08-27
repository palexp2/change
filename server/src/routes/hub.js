import { Router } from 'express';
import net from 'node:net';
import os from 'node:os';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// Services hébergés sur ce serveur, testés par connexion TCP locale. La liste
// est volontairement statique : le hub (/hub) est une page nginx sans backend,
// c'est cet endpoint qui fait foi sur ce qui existe et tourne.
const SERVICES = [
  { id: 'erp',          name: 'ERP',                    port: 3004, url: '/erp/',         description: 'Gestion complète : ventes, compta, projets, RH' },
  { id: 'troubleshoot', name: 'Troubleshoot',           port: 3002, url: '/troubleshoot/',description: 'Diagnostic et dépannage' },
  { id: 'chatbot',      name: 'Chatbot support',        port: 3005, url: '/chatbot/',     description: 'RAG support serres (admin + widget client)' },
  { id: 'circle',       name: 'Circle Analytics',       port: 3006, url: '/circle/',      description: 'Statistiques de la communauté Circle : croissance, rétention, engagement' },
  { id: 'ftp',          name: 'FTP Cube ACR',           port: 2121, url: null,            description: 'Réception des enregistrements d’appels (port 2121)' },
  { id: 'billing',      name: 'Portail facturation',    port: 4003, url: null,            description: 'Portail Stripe (session créée à la demande)' },
];

function checkPort(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (up) => { socket.destroy(); resolve(up); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

// GET /api/hub/status — statut TCP de chaque service + infos serveur
router.get('/status', async (req, res) => {
  const results = await Promise.all(SERVICES.map(async (s) => ({
    ...s,
    // Sans port = page statique servie par nginx : si cette réponse part, nginx
    // est debout, donc le service l'est aussi. L'ERP répond lui-même : up.
    up: s.id === 'erp' || !s.port ? true : await checkPort(s.port),
  })));
  res.json({
    services: results,
    server: {
      uptime_s: Math.floor(os.uptime()),
      load: os.loadavg()[0],
      mem_used_pct: Math.round((1 - os.freemem() / os.totalmem()) * 100),
      checked_at: new Date().toISOString(),
    },
  });
});

export default router;
