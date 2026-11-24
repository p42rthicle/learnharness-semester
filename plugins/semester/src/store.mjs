// Chats, kept in the plugin's data folder (data/chats.json). A chat has a scope ("all" or one class), a title and turns.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function makeStore(dataDir) {
  const file = path.join(dataDir, 'chats.json');
  let chats = [];
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j.version !== 1) throw new Error(`chats.json has version ${j.version}; this plugin only understands version 1`);
    chats = j.chats;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const save = () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify({ version: 1, chats }, null, 1));
    fs.renameSync(file + '.tmp', file);
  };
  const id = () => crypto.randomUUID();
  return {
    list: () => chats.map(({ turns, ...c }) => ({ ...c, turns: turns.length, running: turns.some((t) => t.status === 'running') })),
    get(chatId) {
      const c = chats.find((x) => x.id === chatId);
      if (!c) throw new Error('No such chat');
      return c;
    },
    create(scope) {
      const now = new Date().toISOString();
      const c = { id: id(), scope, title: 'New chat', createdAt: now, updatedAt: now, agentId: null, agentModel: null, turns: [] };
      chats.push(c); save();
      return c;
    },
    rename(chatId, title) { const c = this.get(chatId); c.title = String(title).trim().slice(0, 80) || c.title; save(); return c; },
    remove(chatId) { chats = chats.filter((c) => c.id !== chatId); save(); },
    addTurn(chat, q) {
      const t = { id: id(), q, at: new Date().toISOString(), status: 'running', via: null, answer: '', citations: [], searches: [], cost: 0 };
      chat.turns.push(t);
      if (chat.title === 'New chat') chat.title = q.replace(/\s+/g, ' ').trim().slice(0, 60) + (q.length > 60 ? '…' : '');
      chat.updatedAt = t.at; save();
      return t;
    },
    save,
    /** After a restart nothing is running any more. */
    settleInterrupted() {
      let n = 0;
      for (const c of chats) for (const t of c.turns) if (t.status === 'running') { t.status = 'error'; t.error = 'Interrupted (LearnHarness was closed). Ask again.'; n++; }
      if (n) save();
    },
  };
}
