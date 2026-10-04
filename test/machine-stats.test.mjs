import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTemperature, sampleMachine, tempCelsius } from '../src/machine-stats.mjs';

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
