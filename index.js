// index.js
import makeWASocket, { useSingleFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@adiwajshing/baileys';
import { Boom } from '@hapi/boom';
import fs from 'fs';

const { state, saveState } = useSingleFileAuthState('./auth_info.json');

async function startBot() {
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveState);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if(connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log('Disconnected:', reason);
            if(reason !== DisconnectReason.loggedOut) {
                startBot();
            }
        } else if(connection === 'open') {
            console.log('Bot connected!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if(!msg.message || msg.key.fromMe) return;

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if(!text) return;

        console.log('Received:', text);

        // Example AI reply (simple echo)
        await sock.sendMessage(msg.key.remoteJid, { text: `You said: ${text}` });
    });
}

startBot();