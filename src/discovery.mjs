// LAN discovery: the host broadcasts where it is; agents listen. The beacon
// carries only a name and a URL — never the pool password.
import dgram from 'node:dgram';

export const BEACON_PORT = 11501;

export function startBeacon({ port = BEACON_PORT, info, every = 5000, targets = ['255.255.255.255'] }) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const msg = Buffer.from(JSON.stringify({ rigpool: 1, name: String(info.name), url: String(info.url) }));
  let timer = null;
  const send = () => { for (const t of targets) sock.send(msg, port, t, () => {}); };
  sock.on('error', () => {});
  sock.bind(() => {
    try { sock.setBroadcast(true); } catch { /* not allowed here: unicast targets still work */ }
    send();
    timer = setInterval(send, every);
    timer.unref();
  });
  return { stop() { clearInterval(timer); try { sock.close(); } catch { /* closed */ } } };
}

export function listenBeacons({ port = BEACON_PORT, onHost = () => {}, reuseAddr = true }) {
  const hosts = new Map();
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr });
  sock.on('message', (buf, rinfo) => {
    let m;
    try { m = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (!m || m.rigpool !== 1 || typeof m.name !== 'string' || typeof m.url !== 'string') return;
    if (Object.keys(m).some((k) => !['rigpool', 'name', 'url'].includes(k))) return;   // e.g. a beacon leaking a password
    if (!/^http:\/\/[A-Za-z0-9.\-]+:\d+$/.test(m.url)) return;
    const h = { name: m.name.slice(0, 100), url: m.url, from: rinfo.address, seenAt: Date.now() };
    hosts.set(h.url, h);
    onHost(h);
  });
  return new Promise((resolve) => {
    const api = { error: null, hosts: () => hosts, stop() { try { sock.close(); } catch { /* closed */ } } };
    sock.once('error', (e) => { api.error = e.message; resolve(api); });
    sock.bind(port, '0.0.0.0', () => resolve(api));
  });
}
