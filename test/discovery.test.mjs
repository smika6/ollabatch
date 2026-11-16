import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { startBeacon, listenBeacons } from '../src/discovery.mjs';
import { waitFor } from '../testdata/helpers.mjs';

const port = () => 41000 + Math.floor(Math.random() * 20000);

test('a beacon is heard with the host\'s name and URL', async () => {
  const p = port();
  const heard = [];
  const l = await listenBeacons({ port: p, onHost: (h) => heard.push(h) });
  const b = startBeacon({ port: p, every: 100, info: { name: 'macbook', url: 'http://192.168.1.20:11500' }, targets: ['127.0.0.1'] });
  try {
    await waitFor(() => heard.length > 0, 3000, 'beacon');
    assert.equal(heard[0].name, 'macbook');
    assert.equal(heard[0].url, 'http://192.168.1.20:11500');
    assert.equal(l.hosts().size, 1);
  } finally { b.stop(); l.stop(); }
});

test('garbage and password-carrying datagrams are ignored', async () => {
  const p = port();
  const heard = [];
  const l = await listenBeacons({ port: p, onHost: (h) => heard.push(h) });
  const s = dgram.createSocket('udp4');
  const send = (msg) => new Promise((r) => s.send(Buffer.from(msg), p, '127.0.0.1', r));
  try {
    await send('not json');
    await send(JSON.stringify({ rigpool: 2, name: 'x', url: 'http://a:1' }));
    await send(JSON.stringify({ rigpool: 1, name: 'x', url: 'http://a:1', password: 'leak' }));
    await send(JSON.stringify({ rigpool: 1, name: 'x', url: 'javascript:alert(1)' }));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(heard.length, 0);
  } finally { s.close(); l.stop(); }
});

test('a listener on a taken port reports instead of throwing', async () => {
  const p = port();
  const blocker = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  await new Promise((r) => blocker.bind(p, '0.0.0.0', r));
  try {
    const l = await listenBeacons({ port: p, onHost: () => {}, reuseAddr: false });
    assert.equal(typeof l.error, 'string');
    l.stop();
  } finally { blocker.close(); }
});
