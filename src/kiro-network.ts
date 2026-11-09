import { ProxyAgent, request } from 'undici';

const manifestUrl = 'https://prod.download.cli.kiro.dev/stable/latest/manifest.json';

export async function checkKiroConnection(proxySetting: string) {
    const proxy = parseProxyUrl(proxySetting.trim());
    const signal = AbortSignal.timeout(10_000);
    let dispatcher: ProxyAgent | undefined;
    let status: number;
    try {
        if (proxy) {
            dispatcher = new ProxyAgent(proxy.href);
            const response = await request(manifestUrl, { method: 'HEAD', dispatcher, signal });
            await response.body.dump();
            status = response.statusCode;
        } else {
            const response = await fetch(manifestUrl, { method: 'HEAD', redirect: 'manual', signal });
            status = response.status;
        }
    } catch (error) {
        if (signal.aborted) {
            throw new Error('The direct Kiro connection timed out.');
        }
        const proxyStatus = error instanceof Error
            ? /^Proxy response \((\d{3})\) !== 200 when HTTP Tunneling$/.exec(error.message)?.[1]
            : undefined;
        if (proxyStatus === '407') {
            throw new Error('The direct Kiro proxy requires authentication (HTTP 407). Check rpaKiro.directProxyUrl.');
        }
        if (proxyStatus) {
            throw new Error(`The direct Kiro proxy rejected the tunnel (HTTP ${proxyStatus}).`);
        }
        throw new Error(proxy
            ? 'Could not reach Kiro through the configured proxy. Check the proxy address and network access.'
            : 'Could not reach the public Kiro endpoint using VS Code networking.');
    } finally {
        await dispatcher?.destroy();
    }
    if (status < 200 || status >= 300) {
        throw new Error(`The public Kiro endpoint returned HTTP ${status}.`);
    }
    return { usedProxy: Boolean(proxy), status };
}

function parseProxyUrl(value: string) {
    if (!value) {
        return undefined;
    }
    const url = URL.canParse(value) ? new URL(value) : undefined;
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('Set rpaKiro.directProxyUrl to an HTTP or HTTPS proxy URL, such as http://proxy.example.com:8080.');
    }
    if (Boolean(url.username) !== Boolean(url.password)) {
        throw new Error('If the proxy URL includes credentials, provide both a username and password.');
    }
    return url;
}
