const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('node:http');
const { test } = require('node:test');
const { checkKiroConnection } = require('../dist/kiro-network');

test('rejects unsupported proxy schemes and URLs containing a path', async () => {
    await assert.rejects(checkKiroConnection('socks5://localhost:1080'), /HTTP or HTTPS proxy URL/);
    await assert.rejects(checkKiroConnection('http://localhost:8080/proxy'), /HTTP or HTTPS proxy URL/);
});

test('uses the configured proxy for the Kiro host and reports a rejected tunnel', { timeout: 5000 }, async t => {
    const proxy = createServer();
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    t.after(() => new Promise(resolve => proxy.close(resolve)));
    const connections = [];
    proxy.on('connect', (request, socket) => {
        connections.push({ target: request.url, authorization: request.headers['proxy-authorization'] });
        socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });

    await assert.rejects(
        checkKiroConnection(`http://user:p%40ss@127.0.0.1:${proxy.address().port}`),
        /requires authentication \(HTTP 407\)/,
    );
    assert.deepEqual(connections, [{
        target: 'prod.download.cli.kiro.dev:443',
        authorization: 'Basic ' + Buffer.from('user:p@ss').toString('base64'),
    }]);
});
