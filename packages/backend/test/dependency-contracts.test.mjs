import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import nodemailer from 'nodemailer';
import puppeteer from 'puppeteer';

test('patched Fastify plugins serve files and OpenAPI through Fastify 5', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpro-static-contract-'));
  const app = Fastify();
  try {
    await writeFile(join(root, 'fixture.txt'), 'synthetic document');
    await app.register(staticFiles, { root, prefix: '/files/' });
    await app.register(swagger, { openapi: { info: { title: 'Fixture', version: '1' } } });
    await app.register(swaggerUi, { routePrefix: '/documentation' });
    assert.equal((await app.inject('/files/fixture.txt')).body, 'synthetic document');
    const response = await app.inject('/documentation/json');
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().info.title, 'Fixture');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('legacy trading SDK retains request and serialization contracts with patched dependencies', async () => {
  const require = createRequire(import.meta.url);
  const sdkRequire = createRequire(require.resolve('@alpacahq/alpaca-trade-api'));
  const Alpaca = require('@alpacahq/alpaca-trade-api');
  const axios = sdkRequire('axios');
  const codec = sdkRequire('msgpack5')();
  const adapter = axios.defaults.adapter;
  const requests = [];
  axios.defaults.adapter = async config => {
    requests.push(config);
    return { data: { id: 'synthetic-account', cash: '42.00' }, status: 200, statusText: 'OK', headers: {}, config };
  };
  try {
    const client = new Alpaca({ keyId: 'fixture-key', secretKey: 'fixture-secret', paper: true });
    assert.equal((await client.getAccount()).id, 'synthetic-account');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'get');
    assert.equal(new URL(requests[0].url).pathname, '/v2/account');
    assert.equal(requests[0].headers.get('APCA-API-KEY-ID'), 'fixture-key');
    assert.deepEqual(codec.decode(codec.encode({ symbol: 'FIXTURE', price: 42 })), { symbol: 'FIXTURE', price: 42 });
  } finally {
    axios.defaults.adapter = adapter;
  }
});

test('patched mailer generates MIME without sending mail', async () => {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  try {
    const result = await transport.sendMail({ from: 'sender@example.invalid', to: 'recipient@example.invalid', subject: 'Synthetic fixture', text: 'Contract check' });
    assert.match(result.message.toString(), /Subject: Synthetic fixture/);
    assert.match(result.message.toString(), /Contract check/);
  } finally {
    transport.close();
  }
});

test('patched browser driver accepts the supported headless option', async () => {
  assert.ok((await puppeteer.defaultArgs({ headless: true })).some(arg => arg.startsWith('--headless')));
  assert.ok(!(await puppeteer.defaultArgs({ headless: false })).some(arg => arg.startsWith('--headless')));
});
