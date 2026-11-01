// Minimal stand-in for `SeaLite` (sea-lite 0.1.x src/store.ts) — only what
// scripts/task-mirror.mjs touches. Shapes copied from src/handlers/tickets.ts
// (CreateResult, GetResult, ListResult, TransitionResult) and claims.ts (ClaimResult).
import fs from 'node:fs';
import path from 'node:path';

export const TERMINAL_STATES = ['resolved', 'wont_fix', 'duplicate', 'dropped', 'merged'];

export class SeaLite {
  constructor({ dataDir, actor = 'fake' } = {}) {
    if (!dataDir) throw new Error('fake sea-lite needs dataDir');
    this.file = path.join(dataDir, 'fake-sea.json');
    this.actor = actor;
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { tickets: {}, idem: {}, links: [], seq: 0, calls: [] };
  }
  _save() { fs.writeFileSync(this.file, JSON.stringify(this.db, null, 2)); }
  _head() { return { seq: this.db.seq, hash: 'fake' }; }
  create(input) {
    this.db.calls.push(['create', input]);
    if (input.idempotency_key && this.db.idem[input.idempotency_key]) {
      const t = this.db.tickets[this.db.idem[input.idempotency_key]];
      this._save();
      return { ticket: t, claim_token: null, claim_expires_at: null, possible_duplicates: [], head: this._head(), replayed: true, dry_run: false };
    }
    const id = `tkt_${String(++this.db.seq).padStart(26, '0')}`;
    const t = { id, title: input.title, body: input.body || '', kind: input.kind || 'other', status: input.status || 'idea', tags: input.tags || [], claim: null };
    this.db.tickets[id] = t;
    if (input.idempotency_key) this.db.idem[input.idempotency_key] = id;
    this._save();
    return { ticket: t, claim_token: null, claim_expires_at: null, possible_duplicates: [], head: this._head(), replayed: false, dry_run: false };
  }
  get({ id }) {
    const t = this.db.tickets[id] || Object.values(this.db.tickets).find((x) => x.id.startsWith(id));
    if (!t) { const e = new Error('not_found'); e.code = 'not_found'; throw e; }
    const links = this.db.links.filter((l) => l.from_id === t.id || l.to_id === t.id).map((l) => {
      const peerId = l.from_id === t.id ? l.to_id : l.from_id;
      const p = this.db.tickets[peerId];
      return { link_type: l.link_type, direction: l.from_id === t.id ? 'out' : 'in', peer: { id: p.id, title: p.title, status: p.status } };
    });
    return { ticket: t, legal_next: [], links, notes: [], head: this._head() };
  }
  list({ tag, limit = 50 } = {}) {
    const tickets = Object.values(this.db.tickets).filter((t) => !tag || t.tags.includes(tag)).slice(0, limit);
    return { tickets, count: tickets.length, next_cursor: null, swept_expired: 0, head: this._head() };
  }
  link({ from_id, to_id, link_type }) { this.db.links.push({ from_id, to_id, link_type }); this._save(); }
  claim({ ticket_ids, lease_seconds = 300 }) {
    const claims = ticket_ids.map((id) => {
      const t = this.db.tickets[id];
      if (t.claim && t.claim.actor !== this.actor && t.claim.expires_at > new Date().toISOString()) { const e = new Error(`already_claimed by ${t.claim.actor}`); e.code = 'already_claimed'; throw e; }
      t.claim = { actor: this.actor, token: `clm_fake_${++this.db.seq}`, expires_at: new Date(Date.now() + lease_seconds * 1000).toISOString() };
      return { ticket_id: id, claim_token: t.claim.token, expires_at: t.claim.expires_at, rotated: false };
    });
    this._save();
    return { claims, lease_seconds, head: this._head() };
  }
  transition({ ticket_id, claim_token, to, idempotency_key }) {
    const t = this.db.tickets[ticket_id];
    if (!t.claim || t.claim.token !== claim_token) { const e = new Error('not_holder'); e.code = 'not_holder'; throw e; }
    const from = t.status; t.status = to;
    if (TERMINAL_STATES.includes(to)) t.claim = null;
    if (idempotency_key) this.db.idem[idempotency_key] = ticket_id;
    this.db.calls.push(['transition', { ticket_id, to }]);
    this._save();
    return { ticket: t, ticket_id, from, to, claim_released: TERMINAL_STATES.includes(to), duplicates_link_id: null, head: this._head() };
  }
  close() {}
}
