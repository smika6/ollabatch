// Remote control of machines whose owner allows it ("Let the pool manage this
// PC"). The host keeps the settings the dashboard wants per machine, each field
// stamped with when it was set, and a queue of one-off commands. Agents pull
// both on their tick (they never accept connections), apply a field only if
// it's newer than their own change to it, and acknowledge commands.

export const COMMANDS = new Set(['restart-card', 'retune', 'pull', 'remove-model']);
const EXPIRE_MS = 10 * 60_000;
const POLICIES = ['when-free', 'always', 'schedule', 'never'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const CARD_ID = /^(?!__proto__$|constructor$|prototype$)[\w-]{1,64}$/;

export function validSchedule(v) {
  return Array.isArray(v) && v.length <= 14 && v.every((w) => w && typeof w === 'object'
    && Array.isArray(w.days) && w.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    && HHMM.test(w.from) && HHMM.test(w.to));
}
const slotsOk = (v) => v == null || v === 'auto' || (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 8);

// Each field the pool may set, and what a valid value looks like.
const CHECK = {
  policy: (v) => POLICIES.includes(v) || 'policy is when-free, always, schedule or never',
  schedule: (v) => validSchedule(v) || 'schedule is a list of { days: [0-6], from: "HH:MM", to: "HH:MM" }',
  'playground.limitGB': (v) => (Number.isFinite(Number(v)) && Number(v) >= 1 && Number(v) <= 100_000) || 'the model space is a number of GB',
  'playground.downloads': (v) => typeof v === 'boolean' || 'downloads is true or false',
  locked: (v) => (Array.isArray(v) && v.length <= 500 && v.every((m) => typeof m === 'string' && m.length <= 200)) || 'locked is a list of model names',
};
const CARD_CHECK = {
  paused: (v) => typeof v === 'boolean' || 'paused is true or false',
  disabled: (v) => typeof v === 'boolean' || 'disabled is true or false',
  slots: (v) => slotsOk(v) || 'slots is auto or a number from 1 to 8',
};

// The card id a field names, or null for a machine-wide field. Throws on anything else.
export function checkField(name, value) {
  const m = /^cards\.([^.]+)\.(\w+)$/.exec(name);
  const check = m ? CARD_ID.test(m[1]) && CARD_CHECK[m[2]] : CHECK[name];
  if (!check) throw new Error(`can't set ${name} remotely`);
  const ok = check(value);
  if (ok !== true) throw new Error(ok);
  return m ? m[1] : null;
}

export class RemoteStore {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.machines = Object.create(null);   // machine → { version, at, fields: { path: { value, at } }, commands: [] }
    this.nextId = 1;
  }

  #m(machine) { return (this.machines[machine] ??= { version: 0, at: 0, fields: {}, commands: [] }); }

  // All of a patch, or none of it. `cards` (optional) are the card ids the
  // machine reported; a field for any other card is refused.
  setDesired(machine, patch, { cards = null } = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) throw new Error('send an object of settings');
    for (const [name, value] of Object.entries(patch)) {
      const card = checkField(name, value);
      if (card && cards && !cards.includes(card)) throw new Error(`${machine} has no card ${card}`);
    }
    const m = this.#m(machine);
    // Strictly increasing stamps: agents tell remote changes apart by them.
    m.at = Math.max(this.now(), m.at + 1);
    for (const [name, value] of Object.entries(patch)) m.fields[name] = { value, at: m.at };
    m.version++;
    return this.desired(machine);
  }

  desired(machine) {
    const m = this.machines[machine];
    return { version: m?.version ?? 0, fields: m?.fields ?? {} };
  }

  queueCommand(machine, cmd) {
    if (!COMMANDS.has(cmd?.type)) throw new Error(`unknown command ${cmd?.type}`);
    const m = this.#m(machine);
    const c = { id: `c${this.nextId++}`, type: cmd.type, card: cmd.card ?? null, model: cmd.model ?? null, at: this.now(), state: 'queued', error: null };
    m.commands = [...m.commands, c].slice(-50);
    return c;
  }

  #expire(m) {
    for (const c of m.commands) if (c.state === 'queued' && this.now() - c.at > EXPIRE_MS) c.state = 'expired';
  }

  pending(machine) {
    const m = this.machines[machine];
    if (!m) return [];
    this.#expire(m);
    return m.commands.filter((c) => c.state === 'queued');
  }

  ack(machine, id, { ok, error = null }) {
    const c = this.machines[machine]?.commands.find((x) => x.id === id);
    if (!c || c.state !== 'queued') return false;
    c.state = ok ? 'done' : /^rejected/.test(error || '') ? 'rejected' : 'failed';
    c.error = error;
    return true;
  }

  commands(machine) {
    const m = this.machines[machine];
    if (!m) return [];
    this.#expire(m);
    return [...m.commands].reverse();
  }

  toJSON() { return { machines: this.machines, nextId: this.nextId }; }

  static fromJSON(obj, opts) {
    const r = new RemoteStore(opts);
    Object.assign(r.machines, obj?.machines || {});
    r.nextId = obj?.nextId || 1;
    return r;
  }
}
