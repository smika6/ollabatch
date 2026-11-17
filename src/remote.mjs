// Remote control of machines whose owner allows it ("Let the pool manage this
// PC"). The host keeps the settings the dashboard wants per machine, each field
// stamped with when it was set, and a queue of one-off commands. Agents pull
// both on their tick (they never accept connections), apply a field only if
// it's newer than their own change to it, and acknowledge commands.

export const FIELD = /^(policy|schedule|playground\.limitGB|playground\.downloads|locked|cards\.[\w-]+\.(paused|disabled|slots))$/;
export const COMMANDS = new Set(['restart-card', 'retune', 'pull', 'remove-model']);
const EXPIRE_MS = 10 * 60_000;

export class RemoteStore {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.machines = {};   // machine → { version, fields: { path: { value, at } }, commands: [] }
    this.nextId = 1;
  }

  #m(machine) { return (this.machines[machine] ??= { version: 0, fields: {}, commands: [] }); }

  setDesired(machine, patch) {
    const m = this.#m(machine);
    for (const [path, value] of Object.entries(patch)) {
      if (!FIELD.test(path)) throw new Error(`can't set ${path} remotely`);
      m.fields[path] = { value, at: this.now() };
    }
    m.version++;
    return this.desired(machine);
  }

  desired(machine) {
    const m = this.#m(machine);
    return { version: m.version, fields: m.fields };
  }

  queueCommand(machine, cmd) {
    if (!COMMANDS.has(cmd.type)) throw new Error(`unknown command ${cmd.type}`);
    const c = { id: `c${this.nextId++}`, type: cmd.type, card: cmd.card ?? null, model: cmd.model ?? null, at: this.now(), state: 'queued', error: null };
    this.#m(machine).commands.push(c);
    this.#m(machine).commands = this.#m(machine).commands.slice(-50);
    return c;
  }

  #expire(m) {
    for (const c of m.commands) if (c.state === 'queued' && this.now() - c.at > EXPIRE_MS) c.state = 'expired';
  }

  pending(machine) {
    const m = this.#m(machine);
    this.#expire(m);
    return m.commands.filter((c) => c.state === 'queued');
  }

  ack(machine, id, { ok, error = null }) {
    const c = this.#m(machine).commands.find((x) => x.id === id);
    if (!c || c.state !== 'queued') return false;
    c.state = ok ? 'done' : /^rejected/.test(error || '') ? 'rejected' : 'failed';
    c.error = error;
    return true;
  }

  commands(machine) {
    const m = this.#m(machine);
    this.#expire(m);
    return [...m.commands].reverse();
  }

  toJSON() { return { machines: this.machines, nextId: this.nextId }; }

  static fromJSON(obj, opts) {
    const r = new RemoteStore(opts);
    Object.assign(r, { machines: obj?.machines || {}, nextId: obj?.nextId || 1 });
    return r;
  }
}
