import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gpuPercent, netMbps, parseNetDev, parseNetstatE, parseNetstatIb, parseSensors, parseTemperature, sampleMachine, tempCelsius } from '../src/machine-stats.mjs';

test('a temperature is read from what the probe tools print: a bare number, "61.8°C", or macmon\'s JSON (the hottest of cpu and gpu)', () => {
  assert.equal(parseTemperature('48.0\n'), 48);
  assert.equal(parseTemperature('61.8°C'), 61.8);
  assert.equal(parseTemperature('{"temp":{"cpu_temp_avg":54.2,"gpu_temp_avg":49.1},"mem":{"ram_total":17179869184}}'), 54.2);
  assert.equal(parseTemperature('{"temp":{"cpu_temp_avg":44,"gpu_temp_avg":58.5}}'), 58.5);
});

test('nonsense is not a reading: nothing, zero, or a number no sensor would give', () => {
  for (const t of ['', 'no sensor here', '0', '-5', '900', '{"mem":{"x":5}}']) assert.equal(parseTemperature(t), undefined, JSON.stringify(t));
});

test('your own probe command is used, and a failing one leaves the temperature out rather than faking it', async () => {
  assert.equal(tempCelsius({ command: 'echo 63.5' }), 63.5);
  assert.equal(tempCelsius({ command: 'exit 1' }), undefined);
  assert.equal((await sampleMachine({ tempCommand: 'echo 71' })).temp, 71);
  const s = await sampleMachine({ tempCommand: 'exit 1' });
  assert.ok(!('temp' in s) && s.cpu >= 0 && s.mem > 0, 'the other readings still come through');
});

test('several GPUs are one number: the average of them all (and a custom probe may print its own)', () => {
  assert.equal(gpuPercent({ command: 'echo 40' }), 40);
  assert.equal(gpuPercent({ command: 'exit 1' }), undefined);
  assert.equal(gpuPercent({ command: 'echo 140' }), undefined, 'not a percentage');
  assert.equal(gpuPercent({ macmon: { gpu_usage: [1296, 0.07] } }), 7, 'macmon on Apple Silicon: a fraction of one');
  assert.equal(gpuPercent({ macmon: { gpu_usage: [1296, 0.07] }, command: undefined }) !== undefined, true);
});

test('the machine reading includes the GPU when there is one, and nothing for it when there is not', async () => {
  const s = await sampleMachine({ gpuCommand: 'echo 62.5' });
  assert.equal(s.gpu, 62.5);
  assert.ok(s.cpu >= 0 && s.cpu <= 100, 'cpu is one average over every core');
});

test('more temperature probes: a Raspberry Pi\'s vcgencmd, and the hottest tempN_input of lm-sensors', () => {
  assert.equal(parseTemperature("temp=48.3'C"), 48.3);
  assert.equal(parseSensors('coretemp-isa-0000\nCore 0:\n  temp2_input: 51.000\n  temp2_max: 100.000\nCore 1:\n  temp3_input: 57.000\n'), 57);
  assert.equal(parseSensors('nothing here'), undefined);
});

test('network counters: Linux, macOS and Windows output are summed over real interfaces, never loopback', () => {
  const linux = 'Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0\n  eth0: 5000 50 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\n wlan0: 100 1 0 0 0 0 0 0 50 1 0 0 0 0 0 0\n';
  assert.deepEqual(parseNetDev(linux), { rx: 5100, tx: 2050 });
  const mac = 'Name  Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll\nlo0   16384 <Link#1>                        100     0      9000      100     0      9000     0\nen0   1500  <Link#6>    aa:bb:cc:dd:ee:ff   500     0      7000      400     0      3000     0\nen0   1500  192.168.0     192.168.0.5           500     -      7000      400     -      3000     -\n';
  assert.deepEqual(parseNetstatIb(mac), { rx: 7000, tx: 3000 });
  assert.deepEqual(parseNetstatE('Interface Statistics\n\n                           Received            Sent\n\nBytes                    123456789        98765432\n'), { rx: 123456789, tx: 98765432 });
  assert.equal(parseNetDev('nothing'), null);
});

test('network is Mbit/s of received + sent since the last reading; the first reading, or a counter reset, is left out', () => {
  let t = 0, bytes = 0;
  const opts = { totals: () => ({ rx: bytes, tx: bytes }), now: () => t };
  assert.equal(netMbps(opts), undefined, 'a rate needs two readings');
  t = 2000; bytes = 1_250_000; // 2.5 MB in 2 s, both ways = 10 Mbit / 2 s... (2 x 1.25 MB x 8 = 20 Mbit over 2 s)
  assert.equal(netMbps(opts), 10);
  t = 3000; bytes = 0;
  assert.equal(netMbps(opts), undefined, 'counters went backwards');
  assert.equal(netMbps({ command: 'echo 42.5' }), 42.5);
  assert.equal(netMbps({ command: 'exit 1' }), undefined);
});
